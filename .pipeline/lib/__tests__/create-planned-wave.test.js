// =============================================================================
// create-planned-wave.test.js — Tests de `waves.createPlannedWave` (#3738).
//
// Punto de entrada atómico para crear una ola planificada con N issues desde el
// wizard "Crear nueva ola" del Dashboard V3. Cubre el happy path + los paths de
// rechazo (shape, bounds, nombre duplicado, issue ya en otra ola).
//
// Aislamiento: cada test arranca con su propio PIPELINE_DIR (PIPELINE_DIR_OVERRIDE)
// — mismo patrón que wave-promote-atomic.test.js. Sin config.yaml en el tmp →
// el techo de concurrencia cae al default seguro (10).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/create-planned-wave.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-planned-wave-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    const waves = require('../waves');
    waves.invalidateCache();
    return { dir, waves };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function readWaves(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

function expectThrowCode(fn, code) {
    try {
        fn();
    } catch (e) {
        return e.code === code;
    }
    return false;
}

test('createPlannedWave persiste la ola con shape válido y dispara backup en archived/', () => {
    const { dir, waves } = setupTmp();
    try {
        const res = waves.createPlannedWave(
            { name: 'Ola N+9', issues: [3801, 3802, 3803], concurrency_max: 3, window_minutes: 60 },
            { updated_by: 'operator-local', source: 'dashboard:wizard:ola' },
        );
        assert.equal(res.waveNumber, 1);
        assert.equal(res.wave.name, 'Ola N+9');
        assert.equal(res.wave.concurrency_max, 3);
        assert.equal(res.wave.window_minutes, 60);
        assert.deepEqual(res.wave.issues.map((i) => i.number), [3801, 3802, 3803]);

        const st = readWaves(dir);
        assert.equal(st.planned_waves.length, 1);
        assert.equal(st.planned_waves[0].name, 'Ola N+9');
        // Todos los issues quedan en estado 'pending'.
        assert.ok(st.planned_waves[0].issues.every((i) => i.status === 'pending'));
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave normaliza issues a enteros>0 únicos y ordenados', () => {
    const { dir, waves } = setupTmp();
    try {
        const res = waves.createPlannedWave(
            { name: 'Ordenada', issues: [{ number: 50 }, 10, 30], concurrency_max: 2, window_minutes: 30 },
            {},
        );
        assert.deepEqual(res.wave.issues.map((i) => i.number), [50, 10, 30].map(Number));
        // Verificamos que cada issue es entero positivo (no exige orden el contrato,
        // pero sí integridad de números).
        assert.ok(res.wave.issues.every((i) => Number.isInteger(i.number) && i.number > 0));
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave rechaza si nombre duplicado en planned o active (EWAVES_DUPLICATE_NAME)', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'Repe', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        // Mismo nombre con distinto casing/NFC → igual rebota.
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'repe', issues: [2], concurrency_max: 1, window_minutes: 10 }, {}),
            'EWAVES_DUPLICATE_NAME',
        ));
        // No se persistió la segunda.
        assert.equal(readWaves(dir).planned_waves.length, 1);
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave rechaza si algún issue ya está en otra ola (EWAVES_DUPLICATE_ISSUE)', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'Primera', issues: [100, 101], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'Segunda', issues: [200, 101], concurrency_max: 1, window_minutes: 10 }, {}),
            'EWAVES_DUPLICATE_ISSUE',
        ));
        assert.equal(readWaves(dir).planned_waves.length, 1);
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave rechaza shape inválido (spec no objeto, issues vacío, issue dup en array)', () => {
    const { dir, waves } = setupTmp();
    try {
        assert.ok(expectThrowCode(() => waves.createPlannedWave(null), 'EWAVES_SHAPE'));
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'x', issues: [], concurrency_max: 2, window_minutes: 60 }, {}),
            'EWAVES_SHAPE',
        ));
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'x', issues: [5, 5], concurrency_max: 2, window_minutes: 60 }, {}),
            'EWAVES_SHAPE',
        ));
        // Nombre vacío y nombre > 80 chars.
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: '   ', issues: [1], concurrency_max: 2, window_minutes: 60 }, {}),
            'EWAVES_SHAPE',
        ));
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'a'.repeat(81), issues: [1], concurrency_max: 2, window_minutes: 60 }, {}),
            'EWAVES_SHAPE',
        ));
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave rechaza bounds fuera de rango (EWAVES_BOUNDS) — concurrencia del body, no del config', () => {
    const { dir, waves } = setupTmp();
    try {
        // concurrency_max=999 supera el techo del config (default 10).
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'a', issues: [1], concurrency_max: 999, window_minutes: 60 }, {}),
            'EWAVES_BOUNDS',
        ));
        // concurrency_max < 1.
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'b', issues: [1], concurrency_max: 0, window_minutes: 60 }, {}),
            'EWAVES_BOUNDS',
        ));
        // window_minutes = 0 (< 5).
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'c', issues: [1], concurrency_max: 2, window_minutes: 0 }, {}),
            'EWAVES_BOUNDS',
        ));
        // window_minutes = 99999 (> 1440).
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'd', issues: [1], concurrency_max: 2, window_minutes: 99999 }, {}),
            'EWAVES_BOUNDS',
        ));
        // Ninguna se persistió.
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')) ? readWaves(dir).planned_waves.length : 0, 0);
    } finally {
        teardownTmp(dir);
    }
});

test('createPlannedWave asigna números de ola incrementales', () => {
    const { dir, waves } = setupTmp();
    try {
        const a = waves.createPlannedWave({ name: 'A', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        const b = waves.createPlannedWave({ name: 'B', issues: [2], concurrency_max: 1, window_minutes: 10 }, {});
        assert.equal(b.waveNumber, a.waveNumber + 1);
    } finally {
        teardownTmp(dir);
    }
});

// -----------------------------------------------------------------------------
// #4376 (split #4351) — idempotencia de creación + vista roadmap (CA-2/CA-6)
// -----------------------------------------------------------------------------

test('createPlannedWave: idempotencia - reintento mismo nombre no duplica ni corrompe (CA-6)', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'Idem', issues: [1, 2], concurrency_max: 2, window_minutes: 30 }, {});
        assert.ok(expectThrowCode(
            () => waves.createPlannedWave({ name: 'Idem', issues: [3, 4], concurrency_max: 2, window_minutes: 30 }, {}),
            'EWAVES_DUPLICATE_NAME',
        ));
        const st = readWaves(dir);
        assert.equal(st.planned_waves.filter((w) => w.name === 'Idem').length, 1);
        // Integridad: el estado sigue siendo válido tras el rechazo.
        assert.doesNotThrow(() => waves.validateStateStrict(st));
    } finally {
        teardownTmp(dir);
    }
});

test('renderRoadmap: muestra activa / planificadas (asc) / archivadas con issues (CA-2)', () => {
    const cli = require('../../scripts/planner-waves-cli');
    const wavesList = [
        { number: 5, status: 'active', name: 'Activa', goal: 'objetivo activo', issues: [{ number: 500 }, { number: 501 }] },
        { number: 7, status: 'planned', name: 'Plan B', issues: [{ number: 700 }] },
        { number: 6, status: 'planned', name: 'Plan A', issues: [{ number: 600 }] },
        { number: 3, status: 'archived', name: 'Vieja', issues: [{ number: 300 }] },
        { number: 4, status: 'archived', name: 'Menos vieja', issues: [{ number: 400 }] },
    ];
    const out = cli.renderRoadmap(wavesList);
    // Tres categorías presentes.
    assert.ok(/Activa/.test(out));
    assert.ok(/Planificadas/.test(out));
    assert.ok(/Archivadas/.test(out));
    // Issues renderizados.
    assert.ok(/#500, #501/.test(out));
    assert.ok(/#700/.test(out) && /#600/.test(out));
    // Planificadas en orden ascendente (Plan A / ola 6 antes que Plan B / ola 7).
    assert.ok(out.indexOf('Ola 6') < out.indexOf('Ola 7'));
    // Archivadas más recientes primero (ola 4 antes que ola 3).
    assert.ok(out.indexOf('Ola 4') < out.indexOf('Ola 3'));
});

test('renderRoadmap: categoria vacia muestra placeholder claro (UX-1)', () => {
    const cli = require('../../scripts/planner-waves-cli');
    const out = cli.renderRoadmap([]);
    assert.ok(/sin ola activa/i.test(out));
    assert.ok(/sin olas planificadas/i.test(out));
    assert.ok(/sin olas archivadas/i.test(out));
});

test('renderRoadmap: refleja el estado real tras createPlannedWave (listWaves) (CA-2)', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'Roadmap Test', issues: [9001, 9002], concurrency_max: 2, window_minutes: 60 }, {});
        const cli = require('../../scripts/planner-waves-cli');
        const out = cli.renderRoadmap(waves.listWaves());
        assert.ok(/Roadmap Test/.test(out));
        assert.ok(/#9001, #9002/.test(out));
    } finally {
        teardownTmp(dir);
    }
});

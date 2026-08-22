// =============================================================================
// waves-reorder.test.js — Tests de `reorderPlannedWaves` (#4377 CA-3/7).
//
// Cubre:
//   (1) permutación válida OK y preserva `number` (identidad).
//   (2) rechazo de no-permutación (falta / duplicado / number inexistente).
//   (3) rechazo de tipo inválido (no-array, floats, negativos → REQ-SEC-2).
//   (4) fallo parcial (rename falla) deja estado consistente (CA-7).
//   (5) audit trail: meta.note describe orden previo→nuevo (REQ-SEC-6).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-reorder.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let waves;

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-reorder-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    waves = require('../waves');
    waves.invalidateCache();
    return dir;
}

function teardownTmp(dir) {
    if (waves) waves.invalidateCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function sampleState() {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-06-01T00:00:00.000Z',
            updated_at: '2026-06-01T00:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
            note: 'fixture',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa',
            goal: 'g',
            started_at: '2026-06-01T10:00:00.000Z',
            issues: [{ number: 3451 }],
        },
        planned_waves: [
            { number: 2, name: 'Ola A', goal: 'ga', issues: [{ number: 3460 }] },
            { number: 3, name: 'Ola B', issues: [{ number: 3470 }] },
            { number: 4, name: 'Ola C', issues: [{ number: 3480 }] },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

function writeFixture(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}
function readDisk(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

// ─── (1) permutación válida ───────────────────────────────────────────────

test('reorderPlannedWaves: permutación válida cambia orden y preserva number/identidad (CA-3)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.reorderPlannedWaves([4, 2, 3], { updated_by: 'Planner' });
        const fresh = readDisk(dir);
        // El array quedó en el nuevo orden…
        assert.deepEqual(fresh.planned_waves.map((w) => w.number), [4, 2, 3]);
        // …pero cada ola conserva su number + name + issues (identidad intacta).
        const wave4 = fresh.planned_waves[0];
        assert.equal(wave4.number, 4);
        assert.equal(wave4.name, 'Ola C');
        assert.deepEqual(wave4.issues.map((i) => i.number), [3480]);
        // La ola activa no se toca.
        assert.equal(fresh.active_wave.number, 1);
    } finally {
        teardownTmp(dir);
    }
});

test('reorderPlannedWaves: identidad — mismo orden es válido (no-op semántico persistente)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.reorderPlannedWaves([2, 3, 4]);
        assert.deepEqual(readDisk(dir).planned_waves.map((w) => w.number), [2, 3, 4]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (2) rechazo de no-permutación ────────────────────────────────────────

test('reorderPlannedWaves: rechaza si falta un number (no-permutación) (CA-3)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.throws(() => waves.reorderPlannedWaves([2, 3]), /no es permutación exacta/i);
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), before, 'no persiste ante rechazo');
    } finally {
        teardownTmp(dir);
    }
});

test('reorderPlannedWaves: rechaza si duplica un number', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(() => waves.reorderPlannedWaves([2, 2, 3]), /no es permutación exacta/i);
    } finally {
        teardownTmp(dir);
    }
});

test('reorderPlannedWaves: rechaza si inyecta un number inexistente', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(() => waves.reorderPlannedWaves([2, 3, 99]), /no es permutación exacta/i);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (3) rechazo de tipo inválido (REQ-SEC-2) ─────────────────────────────

test('reorderPlannedWaves: rechaza tipos inválidos (no-array, floats, negativos) (REQ-SEC-2)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(() => waves.reorderPlannedWaves('2,3,4'), /array de enteros/i);
        assert.throws(() => waves.reorderPlannedWaves(null), /array de enteros/i);
        assert.throws(() => waves.reorderPlannedWaves([2, 3.5, 4]), /array de enteros/i);
        assert.throws(() => waves.reorderPlannedWaves([2, -3, 4]), /array de enteros/i);
        assert.throws(() => waves.reorderPlannedWaves([2, '3', 4]), /array de enteros/i);
    } finally {
        teardownTmp(dir);
    }
});

test('reorderPlannedWaves: input con __proto__ no contamina (REQ-SEC-2)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        // Array con clave peligrosa adjunta: sigue siendo array de enteros en índices,
        // pero la validación de permutación exacta lo rechaza igual (largo 3 vs 3 ok,
        // pero .every corre sobre índices — la clave __proto__ no es índice).
        const evil = [2, 3, 4];
        evil.__proto__.polluted = 'x'; // eslint-disable-line no-proto
        try {
            waves.reorderPlannedWaves(evil);
            assert.equal(({}).polluted, undefined, 'Object.prototype no debe quedar contaminado');
        } finally {
            delete Object.prototype.polluted;
        }
    } finally {
        teardownTmp(dir);
    }
});

// ─── (4) fallo parcial → estado consistente (CA-7) ────────────────────────

test('reorderPlannedWaves: fallo de rename deja el estado original intacto (CA-7)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        const origRename = fs.renameSync;
        fs.renameSync = () => { const e = new Error('IO simulado'); e.code = 'EIO'; throw e; };
        try {
            assert.throws(() => waves.reorderPlannedWaves([4, 3, 2]), /EIO|IO simulado/i);
        } finally {
            fs.renameSync = origRename;
        }
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), before, 'estado original intacto');
        assert.ok(!fs.existsSync(path.join(dir, 'waves.json.tmp')), 'sin .tmp huérfano');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (5) audit trail ──────────────────────────────────────────────────────

test('reorderPlannedWaves: note por defecto describe orden previo→nuevo (REQ-SEC-6)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.reorderPlannedWaves([3, 2, 4]);
        const note = readDisk(dir).meta.note;
        assert.match(note, /reorder planned waves/i);
        assert.match(note, /\[2,3,4\]/);
        assert.match(note, /\[3,2,4\]/);
    } finally {
        teardownTmp(dir);
    }
});

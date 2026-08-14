// =============================================================================
// wave-add-rollback-5882.test.js — Escritura conjunta o rollback en `/wave add`
// (#5882 CA-1, CA-2, CA-7).
//
// El bug: `handleWaveAdd` escribía DOS fuentes de verdad en dos pasos
// independientes (waves.json y .partial-pause.json) y envolvía el segundo en un
// `catch {}` VACÍO. Si el segundo fallaba, quedaba un desync silencioso que el
// realign del Pulpo no reparaba con issues abiertos → pipeline frenado
// fail-closed (incidente 2026-08-13, ~40 min sin despacho).
//
// Cubre:
//   (1) rollbackIssueAdd sobre la ola ACTIVA no lanza EWAVES_ACTIVE_LOCKED.
//   (2) removeIssueFromWave sobre la ola activa SIGUE lanzando (no-regresión).
//   (3) expectedVersion obligatorio + authorizedBy obligatorio.
//   (4) version mismatch → aborta ruidoso, no revierte.
//   (5) el issue ya no está (estado cambió) → aborta ruidoso.
//   (6) el audit del rollback se emite con source 'wave-add-rollback' y NO
//       borra la entry del issue_added previo (cadena intacta).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-add-rollback-5882.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let waves;
let waveAudit;

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-rollback-5882-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../wave-audit')];
    waves = require('../waves');
    waveAudit = require('../wave-audit');
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
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-01T00:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
            note: 'fixture #5882',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa',
            goal: 'objetivo',
            started_at: '2026-08-01T10:00:00.000Z',
            issues: [{ number: 5001, status: 'in_progress' }],
        },
        planned_waves: [
            { number: 2, name: 'Planificada', goal: 'g', issues: [{ number: 5010 }] },
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
function activeIssues(dir) {
    return readDisk(dir).active_wave.issues.map((i) => i.number);
}

// ─── (1) el rollback SÍ puede operar sobre la ola activa ──────────────────

test('rollbackIssueAdd revierte una suma sobre la ola ACTIVA sin lanzar EWAVES_ACTIVE_LOCKED', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, {
            updated_by: 'Leo',
            source: 'telegram-commander/wave-add',
            note: 'promoción',
        });
        assert.equal(add.added, true);
        assert.deepEqual(activeIssues(dir), [5001, 9002], 'la suma entró');

        const r = waves.rollbackIssueAdd(1, 9002, {
            expectedVersion: add.version,
            authorizedBy: 'wave-add-rollback',
            rollbackToken: add.rollbackToken,
            updated_by: 'Leo',
            source: 'wave-add-rollback',
        });

        assert.equal(r.removed, true);
        assert.deepEqual(activeIssues(dir), [5001], 'el estado volvió al previo al comando');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (2) no-regresión: el guard general sigue vigente ─────────────────────

test('removeIssueFromWave sobre la ola activa SIGUE lanzando EWAVES_ACTIVE_LOCKED (no-regresión)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(
            () => waves.removeIssueFromWave(1, 5001, { updated_by: 'Leo' }),
            (e) => e && e.code === 'EWAVES_ACTIVE_LOCKED',
            'el guard A04 no debe relajarse para el caller genérico',
        );
        assert.deepEqual(activeIssues(dir), [5001], 'nada se removió');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (3) candados propios del rollback ────────────────────────────────────

test('rollbackIssueAdd exige expectedVersion (a diferencia de assertVersionMatch, que saltea null)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });
        assert.equal(add.added, true);

        assert.throws(
            () => waves.rollbackIssueAdd(1, 9002, { authorizedBy: 'wave-add-rollback' }),
            (e) => e && e.code === 'EWAVES_VERSION_REQUIRED',
        );
        assert.deepEqual(activeIssues(dir), [5001, 9002], 'sin CAS no se toca el estado');
    } finally {
        teardownTmp(dir);
    }
});

test('rollbackIssueAdd exige authorizedBy wave-add-rollback', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });

        assert.throws(
            () => waves.rollbackIssueAdd(1, 9002, { expectedVersion: add.version }),
            (e) => e && e.code === 'EWAVES_UNAUTHORIZED',
        );
        assert.throws(
            () => waves.rollbackIssueAdd(1, 9002, { expectedVersion: add.version, authorizedBy: 'wave-promote' }),
            (e) => e && e.code === 'EWAVES_UNAUTHORIZED',
            'un authorizedBy de otra operación no habilita el rollback',
        );
        assert.deepEqual(activeIssues(dir), [5001, 9002]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (3bis) candado 4 — evidencia de que la suma es de ESTE acto ──────────
//
// Regresión rev-1 (#5882): el CAS por sí solo NO alcanza. `versionToken` es
// `meta.updated_at` del propio waves.json, así que un add que fue NO-OP (issue
// ya presente) devuelve un `version` que también matchea: el compare-and-swap
// no distingue "revierto lo que acabo de escribir" de "remuevo algo que ya
// estaba". Sin el token, un `/wave add` sobre un issue PREEXISTENTE cuya sync
// de allowlist fallaba borraba de la ola un issue que nunca sumó — y como
// después ambos archivos coincidían, el detector de desync quedaba CIEGO.

test('un addIssueToWave no-op devuelve rollbackToken null (no acuña capacidad de revertir)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        // #5001 YA está en la ola del fixture → el add es idempotente.
        const add = waves.addIssueToWave(1, { number: 5001 }, { source: 'telegram-commander/wave-add' });

        assert.equal(add.added, false, 'el add sobre un issue preexistente es no-op');
        assert.equal(add.rollbackToken, null, 'un no-op no puede habilitar una reversión');
        assert.ok(add.version, 'el version SÍ viene (y por eso el CAS solo no alcanza)');
    } finally {
        teardownTmp(dir);
    }
});

test('rollbackIssueAdd rechaza el rollback de un add no-op aunque el CAS coincida', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 5001 }, { source: 'telegram-commander/wave-add' });
        assert.equal(add.added, false);

        assert.throws(
            () => waves.rollbackIssueAdd(1, 5001, {
                expectedVersion: add.version,          // el CAS coincide...
                authorizedBy: 'wave-add-rollback',
                rollbackToken: add.rollbackToken,      // ...pero no hay evidencia de suma.
            }),
            (e) => e && e.code === 'EWAVES_ROLLBACK_UNPROVEN',
            'sin evidencia de que la suma sea de este acto, no se revierte',
        );
        assert.deepEqual(activeIssues(dir), [5001],
            'el issue preexistente sigue en la ola: no se borra lo que no se agregó');
    } finally {
        teardownTmp(dir);
    }
});

test('rollbackIssueAdd exige rollbackToken (ausente o vacío no habilitan)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });
        assert.equal(add.added, true);

        for (const token of [undefined, null, '', '   ', 42]) {
            assert.throws(
                () => waves.rollbackIssueAdd(1, 9002, {
                    expectedVersion: add.version,
                    authorizedBy: 'wave-add-rollback',
                    rollbackToken: token,
                }),
                (e) => e && e.code === 'EWAVES_ROLLBACK_UNPROVEN',
                `un token ${JSON.stringify(token)} no debe habilitar el rollback`,
            );
        }
        assert.deepEqual(activeIssues(dir), [5001, 9002], 'el estado no se tocó');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (4) la ola cambió entre el add y el rollback ─────────────────────────

test('rollbackIssueAdd con version mismatch aborta ruidoso y NO revierte', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });

        // Otro actor muta el estado → cambia meta.updated_at.
        waves.addIssueToWave(1, { number: 9003 }, { source: 'otro-actor' });

        assert.throws(
            () => waves.rollbackIssueAdd(1, 9002, {
                expectedVersion: add.version,
                authorizedBy: 'wave-add-rollback',
                rollbackToken: add.rollbackToken,
            }),
            (e) => e && e.code === 'EWAVES_VERSION_CONFLICT',
        );
        assert.deepEqual(activeIssues(dir), [5001, 9002, 9003], 'no se revirtió a ciegas');
    } finally {
        teardownTmp(dir);
    }
});

test('rollbackIssueAdd aborta si el issue ya no está en la ola (complemento del CAS de ms)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });

        // Simula que otro actor ya lo sacó, SIN cambiar el token de versión
        // (el caso que el CAS con resolución de ms no puede detectar solo).
        const disk = readDisk(dir);
        disk.active_wave.issues = disk.active_wave.issues.filter((i) => i.number !== 9002);
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(disk, null, 2));
        waves.invalidateCache();

        assert.throws(
            () => waves.rollbackIssueAdd(1, 9002, {
                expectedVersion: add.version,
                authorizedBy: 'wave-add-rollback',
                rollbackToken: add.rollbackToken,
            }),
            (e) => e && e.code === 'EWAVES_ROLLBACK_STALE',
        );
        assert.deepEqual(activeIssues(dir), [5001], 'no se removió nada más');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (5) audit del rollback ───────────────────────────────────────────────

test('el rollback deja audit-entry encadenada propia sin borrar la del issue_added previo', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const add = waves.addIssueToWave(1, { number: 9002 }, {
            updated_by: 'Leo',
            source: 'telegram-commander/wave-add',
        });
        waves.rollbackIssueAdd(1, 9002, {
            expectedVersion: add.version,
            authorizedBy: 'wave-add-rollback',
            rollbackToken: add.rollbackToken,
            updated_by: 'Leo',
        });

        const eventos = waveAudit.readAllEvents();
        const added = eventos.filter((e) => e.event === 'issue_added' && e.issue === 9002);
        const removed = eventos.filter((e) => e.event === 'issue_removed' && e.issue === 9002);

        assert.equal(added.length, 1, 'la entry del add sigue ahí (cadena intacta)');
        assert.equal(added[0].source, 'telegram-commander/wave-add');
        assert.equal(removed.length, 1, 'se emitió la entry del rollback');
        assert.equal(removed[0].source, 'wave-add-rollback');

        const chain = waveAudit.verifyChain();
        assert.equal(chain.ok, true, `la cadena debe verificar: ${JSON.stringify(chain)}`);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (6) el source se persiste por entry (prerrequisito de CA-3) ──────────

test('wave-audit persiste `source` por entry y las entries legacy quedan en null', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.addIssueToWave(1, { number: 9002 }, { source: 'telegram-commander/wave-add' });
        // Caller que no pasa source → default 'manual' de waves.js.
        waves.addIssueToWave(2, { number: 9003 }, {});
        // Emisión directa sin source → null (entry legacy).
        waveAudit.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 9004 });

        const eventos = waveAudit.readAllEvents();
        const byIssue = (n) => eventos.find((e) => e.issue === n);

        assert.equal(byIssue(9002).source, 'telegram-commander/wave-add');
        assert.equal(byIssue(9003).source, 'manual');
        assert.equal(byIssue(9004).source, null, 'sin source explícito → null, nunca legitima');
        assert.equal(waveAudit.verifyChain().ok, true);
    } finally {
        teardownTmp(dir);
    }
});

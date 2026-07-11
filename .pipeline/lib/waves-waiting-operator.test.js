'use strict';

// =============================================================================
// waves-waiting-operator.test.js — Estado `waiting-operator` a nivel ola (#4578).
// Framework: node --test. Aísla el estado con PIPELINE_DIR_OVERRIDE a un tmp dir.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function seedWaves(activeWave) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-wo-'));
    const seed = {
        version: '1.0',
        meta: {
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            updated_by: 'System',
            source: 'test',
            next_wave_number: 3,
        },
        active_wave: activeWave,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(seed));
    return dir;
}

// Cada test carga waves.js FRESCO con su propio PIPELINE_DIR_OVERRIDE para no
// compartir cache de módulo entre tests.
function loadWavesInDir(dir) {
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('./waves')];
    const w = require('./waves');
    w.invalidateCache();
    return w;
}

test('setWaveWaitingOperator retiene la ola activa con shape estructurado', () => {
    const dir = seedWaves({ number: 2, name: 'Ola 2', issues: [{ number: 1, status: 'completed' }] });
    const w = loadWavesInDir(dir);
    assert.strictEqual(w.isWaveWaitingOperator(), false);
    const wo = w.setWaveWaitingOperator(2, {
        reason: 'incoherencia dashboard vs consola',
        evidenceRef: 'wave-evidence/x.md',
        conflictsCount: 2,
        updated_by: 'kernel',
    });
    assert.strictEqual(wo.reason, 'incoherencia dashboard vs consola');
    assert.strictEqual(wo.evidence_ref, 'wave-evidence/x.md');
    assert.strictEqual(wo.conflicts_count, 2);
    assert.ok(Number.isFinite(Date.parse(wo.since)));
    assert.strictEqual(w.isWaveWaitingOperator(), true);
    assert.deepStrictEqual(w.getWaveWaitingOperator(), wo);
});

test('el estado waiting_operator sobrevive una relectura desde disco', () => {
    const dir = seedWaves({ number: 5, issues: [] });
    const w = loadWavesInDir(dir);
    w.setWaveWaitingOperator(5, { reason: 'x', conflictsCount: 1 });
    // Releer fresco desde disco (nuevo require, mismo dir).
    const w2 = loadWavesInDir(dir);
    assert.strictEqual(w2.isWaveWaitingOperator(), true);
    assert.strictEqual(w2.getWaveWaitingOperator().conflicts_count, 1);
});

test('clearWaveWaitingOperator remueve la retención', () => {
    const dir = seedWaves({ number: 2, issues: [] });
    const w = loadWavesInDir(dir);
    w.setWaveWaitingOperator(2, { reason: 'x' });
    assert.strictEqual(w.clearWaveWaitingOperator(2, { updated_by: 'operator' }), true);
    assert.strictEqual(w.isWaveWaitingOperator(), false);
    // Segundo clear sin estado → false (idempotente).
    assert.strictEqual(w.clearWaveWaitingOperator(2), false);
});

test('setWaveWaitingOperator rechaza una ola que no es la activa', () => {
    const dir = seedWaves({ number: 2, issues: [] });
    const w = loadWavesInDir(dir);
    assert.throws(() => w.setWaveWaitingOperator(99, {}), /no es la activa/);
});

test('setWaveWaitingOperator sin ola activa lanza', () => {
    const dir = seedWaves(null);
    const w = loadWavesInDir(dir);
    assert.throws(() => w.setWaveWaitingOperator(2, {}), /no es la activa/);
    assert.strictEqual(w.isWaveWaitingOperator(), false);
});

test('validateStateStrict rechaza un waiting_operator con shape inválido', () => {
    const dir = seedWaves({ number: 2, issues: [] });
    const w = loadWavesInDir(dir);
    const bad = {
        version: '1.0',
        meta: { updated_at: '2026-01-01T00:00:00Z' },
        active_wave: { number: 2, waiting_operator: { since: 'no-es-fecha', conflicts_count: -1 } },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    const errors = w.validateStateStrict(bad, { source: 'test' });
    assert.ok(errors.some((e) => /waiting_operator.since/.test(e)));
    assert.ok(errors.some((e) => /waiting_operator.conflicts_count/.test(e)));
});

test('validateStateStrict acepta waiting_operator null/ausente', () => {
    const dir = seedWaves({ number: 2, issues: [] });
    const w = loadWavesInDir(dir);
    const ok = {
        version: '1.0',
        meta: { updated_at: '2026-01-01T00:00:00Z' },
        active_wave: { number: 2, waiting_operator: null },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    assert.deepStrictEqual(w.validateStateStrict(ok, { source: 'test' }), []);
});

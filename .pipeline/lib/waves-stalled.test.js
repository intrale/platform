'use strict';

// =============================================================================
// waves-stalled.test.js — Estado `stalled` / `needs_attention` a nivel ola (#4708).
// Framework: node --test. Aísla el estado con PIPELINE_DIR_OVERRIDE a un tmp dir.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function seedWaves(activeWave) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-st-'));
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

function loadWavesInDir(dir) {
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('./waves')];
    const w = require('./waves');
    w.invalidateCache();
    return w;
}

test('setWaveStalled marca la ola activa con shape estructurado + audit', () => {
    const dir = seedWaves({ number: 8, name: 'Ola Puente', issues: [{ number: 4708, status: 'in_progress' }] });
    const w = loadWavesInDir(dir);
    assert.strictEqual(w.isWaveStalled(), false);
    const st = w.setWaveStalled(8, { reason: 'unexplained-stall', updated_by: 'wave-stall-watchdog' });
    assert.strictEqual(st.reason, 'unexplained-stall');
    assert.ok(Number.isFinite(Date.parse(st.since)));
    assert.strictEqual(w.isWaveStalled(), true);
    assert.deepStrictEqual(w.getWaveStalled(), st);
    // El audit debió registrar el evento wave_stalled.
    const auditFile = path.join(dir, 'wave-audit.jsonl');
    if (fs.existsSync(auditFile)) {
        const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
        assert.ok(lines.some((l) => l.includes('wave_stalled')));
    }
});

test('setWaveStalled default reason cuando no se provee', () => {
    const dir = seedWaves({ number: 8, issues: [] });
    const w = loadWavesInDir(dir);
    const st = w.setWaveStalled(8, {});
    assert.strictEqual(st.reason, 'unexplained-stall');
});

test('el estado stalled sobrevive una relectura desde disco', () => {
    const dir = seedWaves({ number: 5, issues: [] });
    const w = loadWavesInDir(dir);
    w.setWaveStalled(5, { reason: 'unexplained-stall' });
    const w2 = loadWavesInDir(dir);
    assert.strictEqual(w2.isWaveStalled(), true);
    assert.strictEqual(w2.getWaveStalled().reason, 'unexplained-stall');
});

test('clearWaveStalled remueve la marca (idempotente)', () => {
    const dir = seedWaves({ number: 8, issues: [] });
    const w = loadWavesInDir(dir);
    w.setWaveStalled(8, { reason: 'x' });
    assert.strictEqual(w.clearWaveStalled(8, { updated_by: 'operator' }), true);
    assert.strictEqual(w.isWaveStalled(), false);
    assert.strictEqual(w.clearWaveStalled(8), false);
});

test('setWaveStalled rechaza una ola que no es la activa', () => {
    const dir = seedWaves({ number: 8, issues: [] });
    const w = loadWavesInDir(dir);
    assert.throws(() => w.setWaveStalled(99, {}), /no es la activa/);
});

test('setWaveStalled sin ola activa lanza', () => {
    const dir = seedWaves(null);
    const w = loadWavesInDir(dir);
    assert.throws(() => w.setWaveStalled(8, {}), /no es la activa/);
    assert.strictEqual(w.isWaveStalled(), false);
});

test('validateStateStrict rechaza un stalled con shape inválido', () => {
    const dir = seedWaves({ number: 8, issues: [] });
    const w = loadWavesInDir(dir);
    const bad = {
        version: '1.0',
        meta: { updated_at: '2026-01-01T00:00:00Z' },
        active_wave: { number: 8, stalled: { since: 'no-es-fecha', reason: 5 } },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    const errors = w.validateStateStrict(bad, { source: 'test' });
    assert.ok(errors.some((e) => /stalled.since/.test(e)));
    assert.ok(errors.some((e) => /stalled.reason/.test(e)));
});

test('validateStateStrict acepta stalled null/ausente', () => {
    const dir = seedWaves({ number: 8, issues: [] });
    const w = loadWavesInDir(dir);
    const ok = {
        version: '1.0',
        meta: { updated_at: '2026-01-01T00:00:00Z' },
        active_wave: { number: 8, stalled: null },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    assert.deepStrictEqual(w.validateStateStrict(ok, { source: 'test' }), []);
});

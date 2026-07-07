// =============================================================================
// wave-metrics-4532.test.js — #4532
//
// Cobertura de la corrección de métricas de la ola:
//   1. Bootstrap `ensureWavesFile()` desde el template versionado (root-cause).
//   2. Sombra de IDENTIDAD persistida (`meta.active_wave_identity`) que separa
//      identidad (número/título/goal/comienzo) del cálculo (avance/velocidad/ETA).
//   3. Re-seed que RECUPERA la identidad tras un wipe (no resetea número/comienzo).
//   4. ETA por VELOCIDAD HISTÓRICA cross-ola cuando la ola nueva no tiene ritmo
//      propio todavía (source 'historical'), derivando ETA de la velocidad.
//
// node --test .pipeline/lib/__tests__/wave-metrics-4532.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE_SRC = path.join(REPO, '.pipeline', 'waves.json.template');

function freshPipelineDir({ withTemplate = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm4532-'));
    if (withTemplate) {
        fs.copyFileSync(TEMPLATE_SRC, path.join(dir, 'waves.json.template'));
    }
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.PIPELINE_ROOT_OVERRIDE = dir;
    // Re-require fresco de waves para que tome el override e invalide su cache.
    delete require.cache[require.resolve('../waves')];
    const waves = require('../waves');
    waves.invalidateCache();
    return { dir, waves };
}

test('ensureWavesFile crea waves.json desde el template versionado (bootstrap fresh clone)', () => {
    const { dir, waves } = freshPipelineDir();
    const file = path.join(dir, 'waves.json');
    assert.equal(fs.existsSync(file), false);
    const r = waves.ensureWavesFile();
    assert.equal(r.created, true);
    assert.equal(r.reason, 'from-template');
    assert.equal(fs.existsSync(file), true);
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(st.active_wave, null);
    assert.equal(st.version, '1.0');
    // Idempotente: segunda llamada no re-crea.
    const r2 = waves.ensureWavesFile();
    assert.equal(r2.created, false);
    assert.equal(r2.reason, 'exists');
});

test('ensureWavesFile cae a estado vacío si el template no existe (best-effort)', () => {
    const { dir, waves } = freshPipelineDir({ withTemplate: false });
    const r = waves.ensureWavesFile();
    assert.equal(r.created, true);
    assert.equal(r.reason, 'from-empty-state');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    assert.equal(st.active_wave, null);
});

test('la identidad de la ola activa se persiste en meta.active_wave_identity en cada save', () => {
    const { waves } = freshPipelineDir();
    waves.ensureWavesFile();
    const cp = waves.createPlannedWave(
        { name: 'Ola Real', goal: 'objetivo real', issues: [100, 101], concurrency_max: 3, window_minutes: 60 },
        { updated_by: 'test' },
    );
    waves.promoteWaveToActive(cp.waveNumber, { updated_by: 'test' });
    const st = waves.loadWaves();
    const id = st.meta.active_wave_identity;
    assert.ok(id, 'debe existir meta.active_wave_identity');
    assert.equal(id.number, st.active_wave.number);
    assert.equal(id.name, 'Ola Real');
    assert.equal(id.goal, 'objetivo real');
    assert.equal(id.started_at, st.active_wave.started_at);
});

test('re-seed tras WIPE recupera identidad (número/nombre/comienzo) — NO resetea', () => {
    const { dir, waves } = freshPipelineDir();
    waves.ensureWavesFile();
    const cp = waves.createPlannedWave(
        { name: 'Ola Persistente', goal: 'meta', issues: [200, 201], concurrency_max: 3, window_minutes: 60 },
        { updated_by: 'test' },
    );
    waves.promoteWaveToActive(cp.waveNumber, { updated_by: 'test' });
    const before = waves.loadWaves();
    const origNumber = before.active_wave.number;
    const origStarted = before.active_wave.started_at;
    const origCounter = before.meta.next_wave_number;

    // WIPE: emular el checkout que dejaba active_wave en null.
    const file = path.join(dir, 'waves.json');
    const wiped = waves.loadWaves();
    wiped.active_wave = null;
    fs.writeFileSync(file, JSON.stringify(wiped, null, 2));
    waves.invalidateCache();

    // Allowlist operativa + re-seed.
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({ allowed_issues: [200, 201, 202] }));
    delete require.cache[require.resolve('../../scripts/init-waves-from-partial')];
    const { initWavesFromPartial } = require('../../scripts/init-waves-from-partial');
    const res = initWavesFromPartial({ skipAlert: true });

    assert.equal(res.action, 'seeded');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Identidad RECUPERADA: número y comienzo intactos (no `nowIso()`), nombre real.
    assert.equal(after.active_wave.number, origNumber, 'número preservado');
    assert.equal(after.active_wave.started_at, origStarted, 'comienzo (started_at) preservado');
    assert.equal(after.active_wave.name, 'Ola Persistente', 'nombre real preservado');
    // El contador NO se gasta por reconstruir la misma ola.
    assert.equal(after.meta.next_wave_number, origCounter, 'contador monotónico conservado');
    // El contenido (cálculo) SÍ toma la allowlist actual.
    assert.deepEqual(after.active_wave.issues.map((i) => i.number), [200, 201, 202]);
});

test('sin identidad previa, el seeder mintéa una ola nueva (comportamiento legacy intacto)', () => {
    const { dir, waves } = freshPipelineDir();
    waves.ensureWavesFile(); // active_wave null, sin identity
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({ allowed_issues: [300, 301] }));
    delete require.cache[require.resolve('../../scripts/init-waves-from-partial')];
    const { initWavesFromPartial } = require('../../scripts/init-waves-from-partial');
    const res = initWavesFromPartial({ skipAlert: true });
    assert.equal(res.action, 'seeded');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    assert.ok(after.active_wave.number >= 1);
    // Sin identidad previa → nombre genérico de seed.
    assert.match(after.active_wave.name, /Ola seed #\d+/);
});

test('calculateWaveVelocityETA deriva ETA de la velocidad HISTÓRICA cross-ola (ola nueva sin ritmo)', async () => {
    const { dir } = freshPipelineDir();
    // Sembrar histórico cross-ola: velocidad previa de la ola 1.
    delete require.cache[require.resolve('../wave-velocity-history')];
    const histLib = require('../wave-velocity-history');
    histLib.recordSample({ pipelineRoot: dir, waveKey: 1, velocityPctPerMin: 2.0, now: 1000 });

    delete require.cache[require.resolve('../eta-wave')];
    const etaWave = require('../eta-wave');
    // Ola 2 nueva: sin snapshots propios → fallback histórico, no 'fallback' mudo.
    const now = 10_000_000;
    const r = await etaWave.calculateWaveVelocityETA(2, 60, now);
    assert.equal(r.source, 'historical');
    assert.equal(r.velocityPctPerMin, 2.0);
    // remaining = 100 - 60 = 40 %; velocidad = 2 %/min → 20 min = 1_200_000 ms.
    assert.equal(Math.round(r.remainingMs), 1_200_000);
    assert.equal(r.absoluteMs, now + r.remainingMs);
});

test('calculateWaveVelocityETA cae a fallback DURO sólo si no hay ni ritmo ni histórico', async () => {
    freshPipelineDir(); // sin histórico
    delete require.cache[require.resolve('../wave-velocity-history')];
    delete require.cache[require.resolve('../eta-wave')];
    const etaWave = require('../eta-wave');
    const r = await etaWave.calculateWaveVelocityETA(5, 40, 10_000_000);
    assert.equal(r.source, 'fallback');
});

test.after(() => {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_ROOT_OVERRIDE;
});

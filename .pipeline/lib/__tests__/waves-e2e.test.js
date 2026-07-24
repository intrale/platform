// =============================================================================
// waves-e2e.test.js — Test E2E del flujo completo de olas (#3616 CA-7).
//
// Cubre:
//   1. init: waves.json vacío + .partial-pause.json con allowlist → siembra.
//   2. add: agregar una ola planificada con un issue.
//   3. promote: promover la planificada → waves.json activa cambia, allowlist
//      en .partial-pause.json refleja la nueva ola.
//   4. verify: desync-detector pasa sin alertas tras el ciclo.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/waves-e2e.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let init, waves, partialPause, desyncDetector;

function mkTmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'waves-e2e-'));
}

function setupTmp() {
    const dir = mkTmpPipeline();
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Reload de todos los módulos para que tomen el override.
    delete require.cache[require.resolve('../../scripts/init-waves-from-partial')];
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../desync-detector')];
    init = require('../../scripts/init-waves-from-partial');
    waves = require('../waves');
    partialPause = require('../partial-pause');
    desyncDetector = require('../desync-detector');
    waves.invalidateCache();
    init._internal._resetDedupeForTests();
    waves._internal._resetEmptyAllowlistDedupeForTests();
    return dir;
}

function teardownTmp(dir) {
    waves.invalidateCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─── E2E ────────────────────────────────────────────────────────────────────

test('#3616 CA-7: E2E init → add → promote → verify desync OK', () => {
    const dir = setupTmp();
    try {
        // ─── FASE 1: estado inicial = .partial-pause con issues, sin waves ────
        fs.writeFileSync(
            path.join(dir, '.partial-pause.json'),
            JSON.stringify({
                allowed_issues: [3559, 3616],
                created_at: '2026-05-29T00:00:00Z',
                source: 'manual',
            }, null, 2),
        );
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);

        // Init: siembra waves.json con ola seed #1.
        const r1 = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r1.action, 'seeded');
        assert.equal(r1.waveNumber, 1);

        const wavesState1 = readJson(path.join(dir, 'waves.json'));
        assert.equal(wavesState1.active_wave.number, 1);
        assert.deepEqual(
            wavesState1.active_wave.issues.map((i) => i.number).sort((a, b) => a - b),
            [3559, 3616],
        );

        // El partial-pause sigue igual (init no lo toca).
        const partial1 = readJson(path.join(dir, '.partial-pause.json'));
        assert.deepEqual(partial1.allowed_issues.sort((a, b) => a - b), [3559, 3616]);

        // Cache invalidation antes de leer con la API.
        waves.invalidateCache();

        // Desync-detector: debe pasar (allowlists coinciden).
        const desync1 = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(desync1.desync, false, `desync inesperado: ${JSON.stringify(desync1)}`);

        // ─── FASE 2: add ola planificada #2 con un issue nuevo ────────────────
        // Agregar la ola planificada manualmente al state (no hay API para
        // "crear ola planificada" — `addIssueToWave` requiere que exista).
        const state2 = readJson(path.join(dir, 'waves.json'));
        state2.planned_waves.push({
            number: 2,
            name: 'Ola N+2 — siguiente',
            goal: 'Continuación de la seed',
            issues: [],
        });
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state2, null, 2));
        waves.invalidateCache();

        // Agregar issue #9000 a la ola 2.
        waves.addIssueToWave(2, { number: 9000, status: 'pending' });
        waves.invalidateCache();
        const wavesState2 = readJson(path.join(dir, 'waves.json'));
        assert.equal(wavesState2.planned_waves.length, 1);
        assert.equal(wavesState2.planned_waves[0].issues.length, 1);
        assert.equal(wavesState2.planned_waves[0].issues[0].number, 9000);

        // Desync-detector sigue OK — .partial-pause.json todavía refleja
        // la ola activa #1 (no la planificada #2).
        waves.invalidateCache();
        const desync2 = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(desync2.desync, false, `desync tras add inesperado: ${JSON.stringify(desync2)}`);

        // ─── FASE 3: promote ola #2 → activa, partial-pause refleja [9000] ───
        const promoteResult = waves.promoteWaveAtomic(2, {
            updated_by: 'test-e2e',
            source: 'e2e-test',
            note: 'E2E promote',
        });
        assert.equal(promoteResult.newWaveNumber, 2);
        assert.equal(promoteResult.oldWaveNumber, 1);
        assert.deepEqual(promoteResult.newAllowlist.sort((a, b) => a - b), [9000]);

        const wavesState3 = readJson(path.join(dir, 'waves.json'));
        assert.equal(wavesState3.active_wave.number, 2);
        // La ola #1 fue archivada con métricas.
        assert.equal(wavesState3.archived_waves.length, 1);
        assert.equal(wavesState3.archived_waves[0].number, 1);
        assert.equal(typeof wavesState3.archived_waves[0].closed_at, 'string');

        // El partial-pause ahora refleja la ola #2.
        const partial3 = readJson(path.join(dir, '.partial-pause.json'));
        assert.deepEqual(partial3.allowed_issues, [9000]);

        // ─── FASE 4: verify desync OK ────────────────────────────────────────
        waves.invalidateCache();
        const desync3 = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(desync3.desync, false,
            `desync tras promote inesperado: ${JSON.stringify(desync3)}`);

        // Re-correr el init es un no-op (idempotencia post-promote).
        const r2 = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r2.action, 'noop_already_seeded');
        assert.equal(r2.waveNumber, 2);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-7: dashboard horizon refleja la ola activa post-init', () => {
    const dir = setupTmp();
    try {
        fs.writeFileSync(
            path.join(dir, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: [100, 200, 300] }, null, 2),
        );
        init.initWavesFromPartial({ skipAlert: true });
        waves.invalidateCache();

        const horizon = waves.getHorizon(5);
        assert.equal(horizon.length, 1, 'sin planificadas, sólo la activa');
        assert.equal(horizon[0].status, 'active');
        assert.equal(horizon[0].number, 1);
        assert.equal(horizon[0].issues.length, 3);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-7: getAllowlist() devuelve los issues de la ola activa post-init (sin fallback)', () => {
    const dir = setupTmp();
    try {
        fs.writeFileSync(
            path.join(dir, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: [555, 666] }, null, 2),
        );
        // Antes del init: getAllowlist() → [] (sin ola activa).
        waves._internal._resetEmptyAllowlistDedupeForTests();
        const empty = waves.getAllowlist();
        assert.deepEqual(empty, [], 'sin ola activa → [] (fallback eliminado)');

        // Después del init: getAllowlist() → issues de la ola sembrada.
        init.initWavesFromPartial({ skipAlert: true });
        waves.invalidateCache();
        const populated = waves.getAllowlist();
        assert.deepEqual(populated.sort((a, b) => a - b), [555, 666]);
    } finally { teardownTmp(dir); }
});

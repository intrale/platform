// =============================================================================
// dashboard-ola-eta-rc2-pipelineroot.test.js — #4320 (RC2)
//
// Regresión de la causa raíz 2 del issue #4320: `_scheduleOlaETARefresh`
// (`.pipeline/dashboard.js`) llamaba a `resolveActiveWave({})` y
// `getCachedWaveState({})` SIN `pipelineRoot`. El resolver hace early-return con
// `issues: []` cuando falta `pipelineRoot` (`wave-resolver.js`), lo que arrastra
// toda la cadena a `totalPct: 0` → `velocityETA: null` → `etaSource: 'fallback'`.
//
// Este test verifica empíricamente:
//   1. `resolveActiveWave({})` (regresión) → `issues: []`, source degradado.
//   2. `resolveActiveWave({ pipelineRoot })` → los issues reales de `waves.json`.
//   3. Efecto downstream en `buildWaveSnapshot`: con `wave.issues` vacío →
//      `totalPct: 0` (el bug); con issues + cerrados → `totalPct > 0` (el fix).
//   4. El source de dashboard.js pasa `{ pipelineRoot: PIPELINE }` a AMBOS libs.
//
// node --test .pipeline/tests/dashboard-ola-eta-rc2-pipelineroot.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.js');
const DASHBOARD_SRC = fs.readFileSync(DASHBOARD_PATH, 'utf8');

const waveResolver = require('../lib/wave-resolver');
const waveSnapshot = require('../lib/wave-snapshot');

// ─────────────────────── Congelar contrato del source (RC2) ───────────────────────

test('dashboard.js pasa { pipelineRoot: PIPELINE } a resolveActiveWave y getCachedWaveState (#4320 RC2)', () => {
    const slice = DASHBOARD_SRC.split('_scheduleOlaETARefresh')[1] || '';
    assert.match(
        slice,
        /resolveActiveWave\(\s*\{\s*pipelineRoot:\s*PIPELINE\s*\}\s*\)/,
        'resolveActiveWave debe recibir { pipelineRoot: PIPELINE }',
    );
    assert.match(
        slice,
        /getCachedWaveState\(\s*\{\s*pipelineRoot:\s*PIPELINE\s*\}\s*\)/,
        'getCachedWaveState debe recibir { pipelineRoot: PIPELINE }',
    );
    // Regresión: no debe quedar ninguna llamada con objeto vacío `{}`.
    assert.doesNotMatch(
        slice,
        /resolveActiveWave\(\s*\{\s*\}\s*\)/,
        'no debe quedar resolveActiveWave({}) sin pipelineRoot',
    );
    assert.doesNotMatch(
        slice,
        /getCachedWaveState\(\s*\{\s*\}\s*\)/,
        'no debe quedar getCachedWaveState({}) sin pipelineRoot',
    );
});

// ─────────────────────── Comportamiento del resolver (RC2) ───────────────────────

function withTmpWaves(activeWave, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ola-eta-rc2-'));
    fs.writeFileSync(
        path.join(tmp, 'waves.json'),
        JSON.stringify({ version: '1.0', active_wave: activeWave, planned_waves: [], archived_waves: [] }),
    );
    try {
        return fn(tmp);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
}

test('RC2 regresión: resolveActiveWave({}) devuelve issues:[] (sin pipelineRoot)', () => {
    const w = waveResolver.resolveActiveWave({});
    assert.deepEqual(w.issues, [], 'sin pipelineRoot el resolver hace early-return con issues vacíos');
    assert.equal(w.resolved, false);
});

test('RC2 fix: resolveActiveWave({ pipelineRoot }) devuelve los issues reales de la ola', () => {
    withTmpWaves(
        {
            number: 4,
            name: 'Ola 8.1',
            started_at: '2026-06-30T21:48:07.198Z',
            issues: [
                { number: 4308, status: 'in_progress' },
                { number: 4309, status: 'in_progress' },
                { number: 4313, status: 'in_progress' },
                { number: 4318, status: 'in_progress' },
                { number: 4320, status: 'in_progress' },
            ],
        },
        (tmp) => {
            const w = waveResolver.resolveActiveWave({ pipelineRoot: tmp });
            assert.deepEqual(w.issues, [4308, 4309, 4313, 4318, 4320], 'con pipelineRoot resuelve la ola activa');
            assert.equal(w.source, 'waves.json');
            assert.equal(w.resolved, true);
        },
    );
});

// ─────────────────────── Efecto downstream en buildWaveSnapshot ───────────────────────

test('RC2 downstream: wave.issues vacío → totalPct 0 (el bug que producía RC2)', () => {
    const snap = waveSnapshot.buildWaveSnapshot({
        state: { issueMatrix: {}, etaAverages: {} },
        wave: { label: 'Ola actual', issues: [], source: 'fs-fallback' },
        now: 1_000_000,
    });
    assert.equal(snap.totalPct, 0, 'sin issues el snapshot da totalPct 0 (velocityETA null → etaSource fallback)');
});

test('RC2 downstream: con issues de la ola y cerrados → totalPct > 0 (el fix)', () => {
    const snap = waveSnapshot.buildWaveSnapshot({
        state: { issueMatrix: {}, etaAverages: {} },
        wave: { label: 'Ola 8.1', issues: [4308, 4309, 4313, 4318], source: 'waves.json' },
        closedIssues: [4308, 4309], // 2 de 4 cerrados → 50%
        now: 1_000_000,
    });
    assert.ok(snap.totalPct > 0, `con issues cerrados el avance real es > 0 (fue ${snap.totalPct})`);
});

// Tests de calibración multi-semana de weekly-quota (#2854).
// Valida:
//   - Mediana ponderada por recencia (vs EMA legacy)
//   - Histórico cap a 50 (no 20)
//   - weekly_profiles[] se snapshotea al cruzar reset semanal
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-calib-'));
fs.mkdirSync(path.join(TMP_DIR, 'metrics'), { recursive: true });
const METRICS_DIR = path.join(TMP_DIR, 'metrics');

const wq = require('../weekly-quota');

const DAY_MS = 24 * 3600 * 1000;

function freshState() {
    const file = path.join(METRICS_DIR, 'weekly-quota.json');
    try { fs.unlinkSync(file); } catch { /* noop */ }
}

test('weightedRecencyMedian: muestra única devuelve ese valor', () => {
    const now = Date.now();
    const samples = [{ at: new Date(now).toISOString(), value: 5.2 }];
    assert.equal(wq.weightedRecencyMedian(samples, now), 5.2);
});

test('weightedRecencyMedian: dos muestras devuelve promedio simple', () => {
    const now = Date.now();
    const samples = [
        { at: new Date(now - DAY_MS).toISOString(), value: 4.0 },
        { at: new Date(now).toISOString(), value: 6.0 },
    ];
    assert.equal(wq.weightedRecencyMedian(samples, now), 5.0);
});

test('weightedRecencyMedian: con outlier extremo, mediana lo ignora', () => {
    const now = Date.now();
    const samples = [
        { at: new Date(now - 1 * DAY_MS).toISOString(), value: 5.0 },
        { at: new Date(now - 2 * DAY_MS).toISOString(), value: 5.5 },
        { at: new Date(now - 3 * DAY_MS).toISOString(), value: 6.0 },
        { at: new Date(now - 4 * DAY_MS).toISOString(), value: 5.2 },
        { at: new Date(now - 5 * DAY_MS).toISOString(), value: 50.0 }, // outlier
    ];
    const result = wq.weightedRecencyMedian(samples, now);
    // Una EMA o promedio se iría a ~14, la mediana ponderada se queda cerca de 5-6
    assert.ok(result >= 5.0 && result <= 6.5,
        `mediana ponderada debe ignorar outlier (resultado=${result})`);
});

test('weightedRecencyMedian: descarta muestras viejas (>28d)', () => {
    const now = Date.now();
    const samples = [
        { at: new Date(now - 60 * DAY_MS).toISOString(), value: 100.0 }, // vieja, descartar
        { at: new Date(now - 1 * DAY_MS).toISOString(), value: 5.0 },
    ];
    assert.equal(wq.weightedRecencyMedian(samples, now), 5.0);
});

test('weightedRecencyMedian: muestras frescas pesan más por half-life 14d', () => {
    const now = Date.now();
    // Dos grupos: 3 muestras viejas (~21d) en valor 10, 3 frescas (~1d) en valor 4
    // El factor 0.5^(21/14) ≈ 0.35, el factor 0.5^(1/14) ≈ 0.95
    // Pesos totales: viejas ~1.05, frescas ~2.85 → mediana ponderada cae sobre las frescas
    const samples = [
        { at: new Date(now - 21 * DAY_MS).toISOString(), value: 10.0 },
        { at: new Date(now - 20 * DAY_MS).toISOString(), value: 10.0 },
        { at: new Date(now - 19 * DAY_MS).toISOString(), value: 10.0 },
        { at: new Date(now - 1 * DAY_MS).toISOString(), value: 4.0 },
        { at: new Date(now - 1 * DAY_MS).toISOString(), value: 4.0 },
        { at: new Date(now - 2 * DAY_MS).toISOString(), value: 4.0 },
    ];
    const result = wq.weightedRecencyMedian(samples, now);
    assert.ok(result >= 4.0 && result <= 5.0,
        `recency bias debe favorecer las frescas (resultado=${result})`);
});

test('saveCalibration: histórico crece hasta CALIBRATION_HISTORY_MAX (50)', () => {
    freshState();
    for (let i = 0; i < 60; i++) {
        wq.saveCalibration(METRICS_DIR, {
            realWeeklyPct: 30,
            realSessionPct: 50,
            pipelineWeeklyPct: 10,
            pipelineSessionPct: 25,
        });
    }
    const state = wq.loadState(METRICS_DIR);
    assert.equal(state.calibrations.length, 50,
        `histórico debe estar capeado a 50, no a 20 (legacy)`);
    assert.ok(wq.CALIBRATION_HISTORY_MAX === 50);
});

test('saveCalibration: usa mediana ponderada (method registrado)', () => {
    freshState();
    wq.saveCalibration(METRICS_DIR, {
        realWeeklyPct: 30,
        realSessionPct: 50,
        pipelineWeeklyPct: 10,
        pipelineSessionPct: 25,
    });
    const state = wq.loadState(METRICS_DIR);
    assert.equal(state.calibration.method, 'weighted_recency_median_28d');
    assert.equal(state.calibration.half_life_days, 14);
    assert.ok(state.calibration.fresh_sample_count >= 1);
    // Sin método EMA legacy en el output
    assert.equal(state.calibration.ema_alpha, undefined);
});

test('saveCalibration: outlier fuerte no arrastra el factor (robustez)', () => {
    freshState();
    // Cargar 5 calibraciones razonables en factor ~5.0
    for (let i = 0; i < 5; i++) {
        wq.saveCalibration(METRICS_DIR, {
            realWeeklyPct: 50,
            realSessionPct: 50,
            pipelineWeeklyPct: 10,    // → factor 5.0
            pipelineSessionPct: 25,   // → factor 2.0
        });
    }
    const stateBeforeOutlier = wq.loadState(METRICS_DIR);
    const factorBefore = stateBeforeOutlier.calibration.weekly_factor;
    assert.ok(factorBefore >= 4.5 && factorBefore <= 5.5,
        `factor estable en ~5.0 antes del outlier (${factorBefore})`);

    // Cargar UN outlier extremo (factor 50)
    wq.saveCalibration(METRICS_DIR, {
        realWeeklyPct: 100,
        realSessionPct: 50,
        pipelineWeeklyPct: 2,   // → factor 50
        pipelineSessionPct: 25,
    });
    const stateAfter = wq.loadState(METRICS_DIR);
    const factorAfter = stateAfter.calibration.weekly_factor;
    // Mediana resiste el outlier; con EMA legacy hubiera saltado a >15.
    assert.ok(factorAfter < 10,
        `mediana resiste outlier — factor debe quedar <10 (resultado: ${factorAfter})`);
});

test('weekly_profiles: snapshot de semana anterior cuando se calibra en semana nueva', () => {
    freshState();
    const eightDaysAgo = Date.now() - 8 * DAY_MS;
    // Manualmente plantar un state con calibración de hace 8 días (semana anterior)
    const state = wq.loadState(METRICS_DIR);
    state.calibration = {
        at: new Date(eightDaysAgo).toISOString(),
        weekly_factor: 5.0,
        session_factor: 2.0,
    };
    state.calibrations = [{
        at: new Date(eightDaysAgo).toISOString(),
        real_weekly_pct: 40,
        real_session_pct: 50,
        pipeline_weekly_pct_at: 8,
        pipeline_session_pct_at: 25,
        weekly_factor_obs: 5.0,
        session_factor_obs: 2.0,
        session_resets_at: null,
        weekly_resets_at: null,
    }];
    wq.saveState(METRICS_DIR, state);

    // Calibrar HOY → debería snapshotear la semana anterior antes de actualizar
    wq.saveCalibration(METRICS_DIR, {
        realWeeklyPct: 20,
        realSessionPct: 30,
        pipelineWeeklyPct: 5,
        pipelineSessionPct: 15,
    });
    const finalState = wq.loadState(METRICS_DIR);
    assert.ok(Array.isArray(finalState.weekly_profiles));
    assert.ok(finalState.weekly_profiles.length >= 1,
        `debe haber al menos 1 perfil de semana cerrada`);
    const profile = finalState.weekly_profiles[0];
    assert.equal(profile.final_factor_weekly, 5.0,
        `el perfil debe preservar el factor de la semana cerrada`);
    assert.ok(profile.week_start_iso);
    assert.ok(profile.week_end_iso);
});

test('weekly_profiles: idempotencia — calibrar 2 veces en la misma semana no duplica perfil', () => {
    freshState();
    const eightDaysAgo = Date.now() - 8 * DAY_MS;
    const state = wq.loadState(METRICS_DIR);
    state.calibration = {
        at: new Date(eightDaysAgo).toISOString(),
        weekly_factor: 4.5,
        session_factor: 1.5,
    };
    state.calibrations = [{
        at: new Date(eightDaysAgo).toISOString(),
        real_weekly_pct: 30,
        real_session_pct: 40,
        pipeline_weekly_pct_at: 7,
        pipeline_session_pct_at: 27,
        weekly_factor_obs: 4.5,
        session_factor_obs: 1.5,
        session_resets_at: null,
        weekly_resets_at: null,
    }];
    wq.saveState(METRICS_DIR, state);

    // Dos calibraciones consecutivas en la misma semana actual
    wq.saveCalibration(METRICS_DIR, {
        realWeeklyPct: 20, realSessionPct: 30,
        pipelineWeeklyPct: 5, pipelineSessionPct: 15,
    });
    wq.saveCalibration(METRICS_DIR, {
        realWeeklyPct: 25, realSessionPct: 35,
        pipelineWeeklyPct: 5, pipelineSessionPct: 17,
    });

    const finalState = wq.loadState(METRICS_DIR);
    // Sólo debe haberse creado UN perfil para la semana anterior
    assert.equal(finalState.weekly_profiles.length, 1,
        `idempotente: solo 1 perfil aunque se calibre varias veces`);
});

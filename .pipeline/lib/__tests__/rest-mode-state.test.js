// =============================================================================
// Tests rest-mode-state.js — #2892 PR-C
//
// Cubre:
//   - CA-2.7 — auto-clear cuando vuelve a baseline 2 chequeos consecutivos
//   - CA-2.8 + CA-Sec-A04b — snooze cap MAX_SNOOZE_HOURS=24
//   - raiseAlert: shouldNotify=false en re-emisiones de la misma anomalía
//   - ackAlert: limpia el banner sin importar snooze
//   - shouldShowBanner: respeta snooze vigente
//   - Coexistencia con campos de PR-A en rest-mode.json (no los pisa)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const restModeState = require('../rest-mode-state');
const {
    MAX_SNOOZE_HOURS,
    CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR,
    emptyAlertState,
    getAlertState,
    raiseAlert,
    recordBaselineCheck,
    ackAlert,
    snoozeAlert,
    shouldShowBanner,
} = restModeState;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function newTmpStatePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-restmode-'));
    return path.join(dir, 'rest-mode.json');
}

function fakeEval(overrides) {
    return Object.assign({
        type: 'anomaly',
        ts: '2026-04-30T14:32:00.000Z',
        hour: '14',
        baseline_usd: 1.51,
        actual_usd: 4.72,
        ratio: 3.13,
        alerted: true,
    }, overrides || {});
}

function fakeSnapshot() {
    return {
        currentHour: {
            hour: '14',
            cost_usd: 4.72,
            bySkill: [
                { skill: 'android-dev', cost_usd: 2.10 },
                { skill: 'backend-dev', cost_usd: 1.34 },
                { skill: 'guru', cost_usd: 0.78 },
            ],
        },
    };
}

// -----------------------------------------------------------------------------
// raiseAlert — primera emisión vs re-emisión
// -----------------------------------------------------------------------------

test('raiseAlert · primera emisión: shouldNotify=true, persiste el estado', () => {
    const statePath = newTmpStatePath();
    const result = raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 });
    assert.equal(result.shouldNotify, true);
    assert.equal(result.state.active, true);
    assert.equal(result.state.hour, '14');
    assert.equal(result.state.actual_usd, 4.72);
    assert.equal(result.state.baseline_usd, 1.51);
    assert.equal(result.state.ratio, 3.13);
    assert.deepEqual(result.state.top_skills.map(s => s.skill), ['android-dev', 'backend-dev', 'guru']);
    assert.equal(result.state.consecutive_baseline_checks, 0);

    // Persistido en disco
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.alert.active, true);
});

test('raiseAlert · re-emisión consecutiva NO renotifica (anti-spam Telegram)', () => {
    const statePath = newTmpStatePath();
    const t1 = 1714502520000;
    const r1 = raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => t1 });
    assert.equal(r1.shouldNotify, true);
    // 10 minutos después, el cron tickea otra vez con la misma anomalía:
    const r2 = raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => t1 + 10 * 60 * 1000 });
    assert.equal(r2.shouldNotify, false, 'la segunda emisión dentro de la misma racha no debe notificar');
    assert.equal(r2.state.active, true);
    // raised_at NO se actualiza (mantenemos la primera vez)
    assert.equal(r1.state.raised_at, r2.state.raised_at);
});

test('raiseAlert · si está snoozed, NO renotifica aunque sea primera emisión post-ack', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 });
    const sn = snoozeAlert(1, { statePath, now: () => 1714502520000 });
    assert.equal(sn.ok, true);
    // Una nueva eval llega mientras estamos snoozed:
    const r = raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 + 30 * 60 * 1000 });
    assert.equal(r.shouldNotify, false, 'snooze vigente debe silenciar nueva notificación');
    // El snooze se preserva
    assert.ok(r.state.snoozed_until);
});

// -----------------------------------------------------------------------------
// CA-2.7 — auto-clear con CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR=2
// -----------------------------------------------------------------------------

test('CA-2.7 · auto-clear: 2 chequeos consecutivos en baseline limpian la alerta', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 });

    const r1 = recordBaselineCheck({ statePath });
    assert.equal(r1.cleared, false, 'primer baseline check NO debe limpiar todavía');
    assert.equal(r1.state.active, true);
    assert.equal(r1.state.consecutive_baseline_checks, 1);

    const r2 = recordBaselineCheck({ statePath });
    assert.equal(r2.cleared, true, 'segundo baseline check consecutivo debe limpiar');
    assert.equal(r2.state.active, false);
    assert.equal(r2.state.snoozed_until, null);
});

test('CA-2.7 · una nueva anomalía resetea el contador de auto-clear', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 });
    recordBaselineCheck({ statePath }); // contador=1
    // Sigue activa (no llegó a 2)

    // Una nueva eval anómala llega:
    const r = raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => 1714502520000 + 30 * 60 * 1000 });
    assert.equal(r.shouldNotify, false, 'misma alerta activa, no renotifica');
    assert.equal(r.state.consecutive_baseline_checks, 0, 'el contador se resetea con nueva anomalía');

    // Ahora hace falta DOS chequeos consecutivos OTRA vez para limpiar
    recordBaselineCheck({ statePath });
    const r2 = recordBaselineCheck({ statePath });
    assert.equal(r2.cleared, true);
});

test('CA-2.7 · CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR es exactamente 2', () => {
    assert.equal(CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR, 2);
});

test('recordBaselineCheck sin alerta activa es no-op', () => {
    const statePath = newTmpStatePath();
    const r = recordBaselineCheck({ statePath });
    assert.equal(r.cleared, false);
    assert.equal(r.state.active, false);
});

// -----------------------------------------------------------------------------
// CA-2.8 + CA-Sec-A04b — snooze cap
// -----------------------------------------------------------------------------

test('CA-Sec-A04b · MAX_SNOOZE_HOURS es 24 — el backend RECHAZA payloads con > 24h', () => {
    assert.equal(MAX_SNOOZE_HOURS, 24);
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath });

    const r = snoozeAlert(25, { statePath });
    assert.equal(r.ok, false, 'snooze > 24h debe ser rechazado');
    assert.equal(r.reason, 'exceeds_cap');
    assert.equal(r.cap_hours, 24);
});

test('CA-Sec-A04b · payload con snooze=999h es rechazado (no se clampea)', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath });

    const r = snoozeAlert(999, { statePath });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exceeds_cap');
    // Verificamos que en disco NO quedó snoozed_until con valor inflado
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.alert.snoozed_until, null, 'no se debe persistir un snooze inválido');
});

test('CA-2.8 · snooze 1h funciona y persiste snoozed_until', () => {
    const statePath = newTmpStatePath();
    const t = 1714502520000;
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => t });

    const r = snoozeAlert(1, { statePath, now: () => t });
    assert.equal(r.ok, true);
    const expected = new Date(t + 60 * 60 * 1000).toISOString();
    assert.equal(r.state.snoozed_until, expected);
});

test('CA-2.8 · snooze 4h y 24h funcionan (los tres botones del UI)', () => {
    for (const hours of [1, 4, 24]) {
        const statePath = newTmpStatePath();
        const t = 1714502520000;
        raiseAlert(fakeEval(), fakeSnapshot(), { statePath, now: () => t });
        const r = snoozeAlert(hours, { statePath, now: () => t });
        assert.equal(r.ok, true, `snooze ${hours}h debe funcionar`);
        const expected = new Date(t + hours * 60 * 60 * 1000).toISOString();
        assert.equal(r.state.snoozed_until, expected);
    }
});

test('snooze · sin alerta activa devuelve no_active_alert', () => {
    const statePath = newTmpStatePath();
    const r = snoozeAlert(1, { statePath });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_active_alert');
});

test('snooze · valores inválidos (NaN, 0, negativo) son rechazados', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath });
    for (const bad of [NaN, 0, -1, -24, 'abc', null, undefined]) {
        const r = snoozeAlert(bad, { statePath });
        assert.equal(r.ok, false, `valor ${String(bad)} debe ser rechazado`);
        assert.equal(r.reason, 'invalid_hours');
    }
});

// -----------------------------------------------------------------------------
// ackAlert
// -----------------------------------------------------------------------------

test('ackAlert · "Ya lo vi" limpia el banner aunque haya snooze vigente', () => {
    const statePath = newTmpStatePath();
    raiseAlert(fakeEval(), fakeSnapshot(), { statePath });
    snoozeAlert(24, { statePath });

    const r = ackAlert({ statePath });
    assert.equal(r.acked, true);
    assert.equal(r.state.active, false);
    assert.equal(r.state.snoozed_until, null);
    assert.ok(r.state.acked_at, 'acked_at debe registrarse');
});

test('ackAlert · idempotente: sin alerta activa devuelve acked=false sin error', () => {
    const statePath = newTmpStatePath();
    const r = ackAlert({ statePath });
    assert.equal(r.acked, false);
    assert.equal(r.state.active, false);
});

// -----------------------------------------------------------------------------
// shouldShowBanner — respeta snooze
// -----------------------------------------------------------------------------

test('shouldShowBanner · alerta activa sin snooze → true', () => {
    const state = { active: true, snoozed_until: null };
    assert.equal(shouldShowBanner(state, Date.now()), true);
});

test('shouldShowBanner · alerta activa con snooze vigente → false', () => {
    const now = 1714502520000;
    const state = { active: true, snoozed_until: new Date(now + 3600000).toISOString() };
    assert.equal(shouldShowBanner(state, now), false);
});

test('shouldShowBanner · alerta activa con snooze expirado → true', () => {
    const now = 1714502520000;
    const state = { active: true, snoozed_until: new Date(now - 3600000).toISOString() };
    assert.equal(shouldShowBanner(state, now), true);
});

test('shouldShowBanner · sin alerta activa → false', () => {
    assert.equal(shouldShowBanner({ active: false }, Date.now()), false);
    assert.equal(shouldShowBanner(null, Date.now()), false);
});

// -----------------------------------------------------------------------------
// Coexistencia con PR-A — no pisar campos de modo descanso
// -----------------------------------------------------------------------------

test('coexistencia PR-A · raiseAlert NO pisa campos no-alert del archivo', () => {
    const statePath = newTmpStatePath();
    // Simulamos que PR-A escribió primero su config de modo descanso:
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
        window_start: '21:00',
        window_end: '08:00',
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        max_concurrent_llm: 1,
    }));

    raiseAlert(fakeEval(), fakeSnapshot(), { statePath });

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // Los campos de PR-A siguen ahí
    assert.equal(onDisk.window_start, '21:00');
    assert.equal(onDisk.window_end, '08:00');
    assert.deepEqual(onDisk.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri']);
    assert.equal(onDisk.max_concurrent_llm, 1);
    // Y los de PR-C también
    assert.equal(onDisk.alert.active, true);
});

test('getAlertState · archivo inexistente → emptyAlertState (no tira)', () => {
    const statePath = path.join(os.tmpdir(), 'no-existe-jamas-2892.json');
    const state = getAlertState({ statePath });
    assert.equal(state.active, false);
    assert.deepEqual(state.top_skills, []);
});

test('getAlertState · archivo corrupto → emptyAlertState (no tira)', () => {
    const statePath = newTmpStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{{NOT VALID JSON');
    const state = getAlertState({ statePath });
    assert.equal(state.active, false);
});

// -----------------------------------------------------------------------------
// emptyAlertState
// -----------------------------------------------------------------------------

test('emptyAlertState · shape esperada y valores default', () => {
    const s = emptyAlertState();
    assert.equal(s.active, false);
    assert.equal(s.raised_at, null);
    assert.equal(s.hour, null);
    assert.equal(s.actual_usd, 0);
    assert.equal(s.baseline_usd, 0);
    assert.equal(s.ratio, null);
    assert.deepEqual(s.top_skills, []);
    assert.equal(s.acked_at, null);
    assert.equal(s.snoozed_until, null);
    assert.equal(s.consecutive_baseline_checks, 0);
});

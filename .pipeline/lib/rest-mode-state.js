// =============================================================================
// rest-mode-state.js — Estado del banner de alerta de consumo + snooze
// (#2892 PR-C, parte del épico #2882).
//
// Responsabilidades:
//   - Persistir el estado del banner activo en `.pipeline/rest-mode.json`
//   - Manejar acuse manual (raise → clear via "Ya lo vi")
//   - Manejar snooze configurable (cap 24h por CA-2.8/CA-Sec-A04b)
//   - Auto-clear cuando el consumo vuelve a baseline durante 2 chequeos
//     consecutivos (CA-2.7)
//
// Coordinación con PR-A:
//   PR-A (#2890) crea `rest-mode.json` para la ventana de modo descanso.
//   PR-C extiende ese mismo archivo con campos de alerta — schema:
//     {
//       // Campos de PR-A (modo descanso) — se respetan/preservan tal cual.
//       window_start, window_end, weekdays, ...
//
//       // Campos de PR-C (alerta de consumo anómalo).
//       alert: {
//         active: bool,
//         raised_at: ISO,
//         hour: "HH",
//         actual_usd: number,
//         baseline_usd: number,
//         ratio: number,
//         top_skills: [{ skill, cost_usd, share_pct }],
//         acked_at: ISO|null,
//         snoozed_until: ISO|null,
//         consecutive_baseline_checks: int,  // para auto-clear
//       },
//     }
//
// Si PR-A todavía no aterrizó cuando PR-C mergea, este módulo crea el
// archivo con `alert` solamente y deja que PR-A appendee sus campos
// cuando llegue. Ambos PRs leen/escriben atómicamente y preservan campos
// que no tocan.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PIPELINE_DIR = path.resolve(__dirname, '..');

// Cap absoluto de snooze. Cualquier request con un valor mayor que esto
// es rechazado por el endpoint del dashboard (CA-Sec-A04b). El UI tampoco
// lo permite, pero la verificación final vive acá.
const MAX_SNOOZE_HOURS = 24;
const MAX_SNOOZE_MS = MAX_SNOOZE_HOURS * 60 * 60 * 1000;

// Cantidad de chequeos consecutivos en baseline necesarios para auto-clear.
// CA-2.7 manda exactamente 2.
const CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR = 2;

function statePath(pipelineDir) {
    return path.join(pipelineDir || DEFAULT_PIPELINE_DIR, 'rest-mode.json');
}

function readStateRaw(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        // ENOENT, parse error, etc. — devolvemos vacío. El módulo es
        // tolerante: la falta del archivo no rompe nada.
        return {};
    }
}

function writeStateRaw(file, state) {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function emptyAlertState() {
    return {
        active: false,
        raised_at: null,
        hour: null,
        actual_usd: 0,
        baseline_usd: 0,
        ratio: null,
        top_skills: [],
        acked_at: null,
        snoozed_until: null,
        consecutive_baseline_checks: 0,
    };
}

/**
 * Devuelve el estado de alerta. Nunca tira: si el archivo no existe
 * o está corrupto, devuelve `emptyAlertState()`.
 */
function getAlertState(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);
    const alert = raw.alert && typeof raw.alert === 'object' ? raw.alert : emptyAlertState();
    // Defaults para campos faltantes (compat con archivos parcialmente
    // escritos por versiones viejas).
    return Object.assign(emptyAlertState(), alert);
}

/**
 * Devuelve el estado completo (modo descanso de PR-A + alerta de PR-C).
 * Útil para el dashboard que muestra ambas.
 */
function getFullState(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);
    return Object.assign({}, raw, {
        alert: Object.assign(emptyAlertState(), raw.alert || {}),
    });
}

/**
 * Marca una alerta activa con los datos de la evaluación. Idempotente:
 * si ya hay una alerta activa más reciente, no degrada los datos. Si
 * está snoozed, NO levanta la pill ni vuelve a notificar (pero sí
 * acumula consecutive_baseline_checks=0 — la "evidencia" sigue corriendo).
 *
 * @param {object} evaluation — record del anomaly-detector
 * @param {object} snapshot   — snapshot.json (para top_skills)
 * @param {object} [opts]
 * @returns {{state: object, shouldNotify: boolean}}
 */
function raiseAlert(evaluation, snapshot, opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const raw = readStateRaw(file);
    const prev = raw.alert && typeof raw.alert === 'object' ? raw.alert : emptyAlertState();

    const ev = evaluation || {};
    const snap = snapshot || {};
    const bySkill = (snap.currentHour && Array.isArray(snap.currentHour.bySkill))
        ? snap.currentHour.bySkill : [];
    const actual = Number(ev.actual_usd || 0);
    const topSkills = bySkill.slice(0, 3).map((s) => ({
        skill: String((s && s.skill) || 'unknown'),
        cost_usd: Number((s && s.cost_usd) || 0),
        share_pct: actual > 0 ? Math.round((Number((s && s.cost_usd) || 0) / actual) * 100) : 0,
    }));

    // Si la alerta ya está activa Y snoozed → solo refrescamos numéricos,
    // no notificamos.
    const isSnoozed = prev.active && prev.snoozed_until && Date.parse(prev.snoozed_until) > now;
    // Si la alerta ya está activa pero NO snoozed → es la misma anomalía
    // continua, no re-notificamos (evita spam de Telegram cada 10min).
    const wasAlreadyActive = !!prev.active;

    const next = {
        active: true,
        raised_at: prev.active && prev.raised_at ? prev.raised_at : new Date(now).toISOString(),
        hour: String(ev.hour || '').padStart(2, '0'),
        actual_usd: Math.round(actual * 10000) / 10000,
        baseline_usd: Math.round(Number(ev.baseline_usd || 0) * 10000) / 10000,
        ratio: Number.isFinite(ev.ratio) ? Math.round(Number(ev.ratio) * 1000) / 1000 : null,
        top_skills: topSkills,
        // Acks/snoozes vigentes se preservan: no queremos que un eval
        // posterior reabra una alerta que el operador ya aprobó silenciar.
        acked_at: prev.acked_at || null,
        snoozed_until: isSnoozed ? prev.snoozed_until : null,
        // Evidencia para auto-clear: una alerta nueva resetea el contador.
        consecutive_baseline_checks: 0,
    };

    raw.alert = next;
    writeStateRaw(file, raw);

    return {
        state: next,
        shouldNotify: !wasAlreadyActive && !isSnoozed,
    };
}

/**
 * Registra un chequeo dentro de baseline (no anómalo). Si la alerta está
 * activa, incrementa el contador. Cuando llega a CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR
 * → auto-clear (CA-2.7). Si no hay alerta activa, no-op.
 */
function recordBaselineCheck(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);
    const prev = raw.alert && typeof raw.alert === 'object' ? raw.alert : null;
    if (!prev || !prev.active) {
        return { state: prev || emptyAlertState(), cleared: false };
    }
    const next = Object.assign({}, prev, {
        consecutive_baseline_checks: Number(prev.consecutive_baseline_checks || 0) + 1,
    });
    let cleared = false;
    if (next.consecutive_baseline_checks >= CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR) {
        // Auto-clear: la alerta se resuelve sola. Limpiamos también el
        // snooze porque ya no aplica (no hay anomalía).
        Object.assign(next, emptyAlertState());
        cleared = true;
    }
    raw.alert = next;
    writeStateRaw(file, raw);
    return { state: next, cleared };
}

/**
 * Acuse manual del operador ("Ya lo vi"). Limpia la alerta sin importar
 * el snooze ni el contador de baseline. Idempotente: si no hay alerta
 * activa, no-op.
 */
function ackAlert(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const raw = readStateRaw(file);
    const prev = raw.alert && typeof raw.alert === 'object' ? raw.alert : null;
    if (!prev || !prev.active) {
        raw.alert = emptyAlertState();
        writeStateRaw(file, raw);
        return { state: raw.alert, acked: false };
    }
    raw.alert = Object.assign({}, emptyAlertState(), {
        acked_at: new Date(now).toISOString(),
    });
    writeStateRaw(file, raw);
    return { state: raw.alert, acked: true };
}

/**
 * Configura snooze. Valida cap MAX_SNOOZE_HOURS. Devuelve { ok, state, reason }.
 * Si la alerta no está activa, ok=false (no se puede snoozeear lo que no
 * está sonando).
 *
 * @param {number} hours — duración del snooze. Aceptamos solo 1, 4, 24
 *                          (tres botones del UI) — fuera de eso lo redondeamos
 *                          al cap. Valores <0 o NaN → reject.
 */
function snoozeAlert(hours, opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, reason: 'invalid_hours', state: getAlertState(_opts) };
    }
    if (n > MAX_SNOOZE_HOURS) {
        // CA-Sec-A04b: el backend RECHAZA explícitamente payloads con
        // snooze > 24h. No clampeamos silenciosamente — devolvemos error
        // para que un cliente roto se entere.
        return { ok: false, reason: 'exceeds_cap', cap_hours: MAX_SNOOZE_HOURS, state: getAlertState(_opts) };
    }
    const raw = readStateRaw(file);
    const prev = raw.alert && typeof raw.alert === 'object' ? raw.alert : null;
    if (!prev || !prev.active) {
        return { ok: false, reason: 'no_active_alert', state: emptyAlertState() };
    }
    const snoozedUntil = new Date(now + n * 60 * 60 * 1000).toISOString();
    raw.alert = Object.assign({}, prev, {
        snoozed_until: snoozedUntil,
        // Snooze NO limpia la alerta. Solo silencia notificaciones nuevas
        // y la pill activa hasta que expire o llegue el auto-clear.
    });
    writeStateRaw(file, raw);
    return { ok: true, state: raw.alert };
}

/**
 * Helper para el dashboard: ¿debe mostrarse el banner ahora? Tiene en
 * cuenta el snooze (si snooze vigente, no mostrar la pill).
 */
function shouldShowBanner(state, nowMs) {
    const _now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (!state || !state.active) return false;
    if (state.snoozed_until && Date.parse(state.snoozed_until) > _now) return false;
    return true;
}

module.exports = {
    MAX_SNOOZE_HOURS,
    MAX_SNOOZE_MS,
    CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR,
    emptyAlertState,
    getAlertState,
    getFullState,
    raiseAlert,
    recordBaselineCheck,
    ackAlert,
    snoozeAlert,
    shouldShowBanner,
    statePath,
    // Sólo para tests:
    __forTestsOnly__: { readStateRaw, writeStateRaw },
};

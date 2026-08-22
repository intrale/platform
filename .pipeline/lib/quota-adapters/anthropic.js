// =============================================================================
// quota-adapters/anthropic.js — Adapter Anthropic Plan Max (#3092, reescrito #4597).
//
// FUENTE DE VERDAD: el uso REAL que expone `claude -p "/usage"` (client-side,
// coincide con la app de Claude). Reemplaza por completo la cadena vieja:
//
//   * ❌ heurística de `duration_ms` de sesiones (`weekly-quota.js#computeQuota`)
//        — daba 2.6–4.9% cuando el real era ~62%.
//   * ❌ calibración manual (factor EMA `saveCalibration`) — drifteaba, quedó
//        en 20× absurdo.
//   * ❌ snapshot OCR del panel "Uso" de Claude Desktop.
//
// El número lo obtiene y cachea `lib/anthropic-usage.js` (spawn throttled +
// fallback stale, sin bloquear el pipeline). Este adapter sólo MAPEA ese cache
// al shape canónico QuotaResult.
//
// MAPEO (decisión #4597):
//   * `pct`          = semanal% (all models) — YA es el real, no hay `realPct`.
//   * `session.pct`  = sesión 5h%.
//   * `status`/`session.status` derivan del % con los cortes estándar
//     (ok<50, normal<75, warning<90, critical≥90).
//   * `nextResetAt`/`sessionResetsAt` = resets parseados de /usage (best-effort).
//
// ESTADOS (security CA-#3 / UX G1):
//   * dato fresco/tolerable   → adapterStatus 'ok', pct real.
//   * dato demasiado viejo    → adapterStatus 'unknown' PERO con el último número
//                               (degradado: el dashboard lo pinta stale, no lo
//                               presenta como fresco; pacing lo ignora).
//   * sin dato / CLI caído    → adapterStatus 'unknown', pct null (emptyResult).
//   Nunca pct:0 silencioso (eso daría "luz verde" a la degradación).
// =============================================================================
'use strict';

const { ADAPTER_STATUS, QUOTA_STATUS, SCHEMA_VERSION, emptyResult } = require('./_shape');

const round1 = (n) => Math.round(n * 10) / 10;

function statusFromPct(pct) {
    if (pct >= 90) return QUOTA_STATUS.CRITICAL;
    if (pct >= 75) return QUOTA_STATUS.WARNING;
    if (pct >= 50) return QUOTA_STATUS.NORMAL;
    return QUOTA_STATUS.OK;
}

/**
 * Construye el QuotaResult con los números reales de /usage. Cuando `ok` es
 * false (dato stale) mantiene los números pero marca adapterStatus 'unknown'
 * para que el consumidor NO los trate como frescos.
 */
function buildResult(d, ok, errorReason) {
    const weeklyPct = Number.isFinite(d.weeklyPct) ? round1(d.weeklyPct) : null;
    const sessPct = Number.isFinite(d.sessionPct) ? round1(d.sessionPct) : null;
    const weeklyStatus = weeklyPct != null ? statusFromPct(weeklyPct) : QUOTA_STATUS.UNKNOWN;
    const sessStatus = sessPct != null ? statusFromPct(sessPct) : QUOTA_STATUS.UNKNOWN;

    return {
        provider: 'anthropic',
        adapterStatus: ok ? ADAPTER_STATUS.OK : ADAPTER_STATUS.UNKNOWN,
        errorReason: ok ? null : (errorReason || null),
        schemaVersion: SCHEMA_VERSION,

        // Semanal — número REAL de /usage. Sin heurística de duración: los
        // campos de horas/límite/burn quedan null (ya no aplican).
        hoursUsed7d: null,
        sessionsCount7d: null,
        hoursLast24h: null,
        effectiveLimitHours: null,
        configLimitHours: null,
        pct: weeklyPct,
        // `realPct` era el pct calibrado; ya no calibramos: pct ES el real.
        realPct: null,
        realPctRaw: null,
        realPctCapped: false,
        realStatus: weeklyStatus,
        hoursRemaining: null,
        burnRatePerDay: null,
        daysToLimit: null,
        status: weeklyStatus,
        adjustmentsCount: 0,
        observedMaxHours: null,
        observedMaxAt: null,
        autoAdjusted: false,

        lastResetAt: null,
        nextResetAt: d.weeklyResetsAt || null,
        daysToReset: null,

        session: {
            hoursUsed: null,
            sessionsCount: null,
            limitHours: 5,
            pct: sessPct,
            realPct: null,
            realPctRaw: null,
            realPctCapped: false,
            realStatus: sessStatus,
            hoursRemaining: null,
            status: sessStatus,
        },

        // Calibración deprecada (#4597): ya no se usa ni se requiere.
        calibration: null,
        calibrations: [],
        weeklyResetDriftMin: 0,
        calibrationAgeDays: null,
        calibrationStale: false,
        sessionResetsAt: d.sessionResetsAt || null,
        weeklyResetsAtReported: d.weeklyResetsAt || null,

        // Metadata de frescura del snapshot de /usage (UX: affordance de stale).
        usageSource: {
            capturedAt: d.capturedAt || null,
            ageMs: Number.isFinite(d._ageMs) ? d._ageMs : null,
            stale: !ok,
        },
        sessionResetsRaw: d.sessionResetsRaw || null,
        weeklyResetsRaw: d.weeklyResetsRaw || null,

        breakdown: [],
    };
}

/**
 * Adapter Anthropic. Recibe sessionData y devuelve un QuotaResult.
 * Fail-secure: ante cualquier error devuelve emptyResult con motivo, no lanza.
 *
 * @param {Object} sessionData
 *   @property {string}   metricsDir     path a .pipeline/metrics (requerido)
 *   @property {number}   [now]          reloj override (tests)
 *   @property {Object}   [usageImpl]    inyección del módulo anthropic-usage (tests)
 *   @property {boolean}  [autoRefresh]  default true; false = no spawnear (tests)
 *   @property {function} [spawnImpl]    inyección de spawn (tests)
 *   @property {Object}   [launcher]     launcher override (tests)
 * @returns {QuotaResult}
 */
function anthropicAdapter(sessionData) {
    const metricsDir = sessionData && sessionData.metricsDir;
    if (typeof metricsDir !== 'string' || metricsDir.length === 0) {
        return emptyResult('anthropic', ADAPTER_STATUS.ERROR,
            'metricsDir requerido para adapter Anthropic');
    }

    const usageLib = (sessionData && sessionData.usageImpl) || require('../anthropic-usage');

    let u;
    try {
        u = usageLib.getUsage({
            metricsDir,
            now: Number.isFinite(sessionData.now) ? sessionData.now : undefined,
            autoRefresh: sessionData.autoRefresh,
            spawnImpl: sessionData.spawnImpl,
            launcher: sessionData.launcher,
        });
    } catch (err) {
        const reason = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
        return emptyResult('anthropic', ADAPTER_STATUS.UNKNOWN,
            `Cuota Anthropic: error leyendo /usage (${reason}) — fallback degradado`);
    }

    // Sin dato todavía (primer arranque) o CLI caído → degradar, NUNCA congelar.
    if (!u || !u.data) {
        const reason = (u && u.reason)
            ? `Cuota Anthropic: ${u.reason} (fallback degradado)`
            : 'Cuota Anthropic: sin dato de /usage (fallback degradado)';
        return emptyResult('anthropic', ADAPTER_STATUS.UNKNOWN, reason);
    }

    const d = { ...u.data, _ageMs: u.ageMs };
    if (u.stale) {
        const mins = Number.isFinite(u.ageMs) ? Math.round(u.ageMs / 60000) : '?';
        return buildResult(d, false,
            `Cuota Anthropic: dato de /usage stale (${mins} min) — refrescando en background`);
    }
    return buildResult(d, true, null);
}

module.exports = anthropicAdapter;

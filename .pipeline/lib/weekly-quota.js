// Weekly Quota — estimación del consumo del Plan Max de Anthropic.
//
// Anthropic NO expone API pública del uso del plan, así que aproximamos:
//
//  1. Sumamos `duration_ms` de eventos `session:end` del activity-log
//     (los emitidos por el pulpo desde el fix #2801) en una ventana
//     deslizante de 7 días → horas reales de uso.
//
//  2. Comparamos contra un límite estimado configurable
//     (default 40h/semana basado en consenso de comunidad de Claude Code).
//
//  3. **Auto-ajuste pasivo**: si en cualquier ventana de 7d acumulamos
//     más horas que `effective_limit` SIN observar un bloqueo, subimos
//     `effective_limit` al máximo observado + 5h de buffer. Así el
//     número va calibrándose con más data sin requerir intervención.
//
//  4. Estado persistido en `.pipeline/metrics/weekly-quota.json`:
//     {
//       config_limit_hours: 40,
//       effective_limit_hours: 47.3,    // ajustado
//       observed_max_hours: 42.3,       // máximo observado en 7d
//       observed_max_at: "2026-04-23T..." ,
//       adjustments: [
//         {at:"2026-04-23T", from:40, to:45, reason:"observed_max=42.3"}
//       ]
//     }
//
// Detección de bloqueo (TODO #2801-followup): cuando el pulpo identifique
// patrón "rate_limit_error" / "weekly limit" en stderr/stdout del agente,
// debería persistir el `hours_at_block` y bajar `effective_limit` a ese
// valor (con prioridad sobre observed_max). Por ahora solo subimos.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT_HOURS = 40;
const ADJUSTMENT_BUFFER_HOURS = 5;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function quotaFile(metricsDir) {
    return path.join(metricsDir, 'weekly-quota.json');
}

function loadState(metricsDir) {
    try {
        const raw = fs.readFileSync(quotaFile(metricsDir), 'utf8');
        return JSON.parse(raw);
    } catch {
        return {
            config_limit_hours: DEFAULT_LIMIT_HOURS,
            effective_limit_hours: DEFAULT_LIMIT_HOURS,
            observed_max_hours: 0,
            observed_max_at: null,
            adjustments: [],
        };
    }
}

function saveState(metricsDir, state) {
    try {
        fs.mkdirSync(metricsDir, { recursive: true });
        fs.writeFileSync(quotaFile(metricsDir), JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
}

/**
 * Suma duration_ms de session:end en una ventana temporal.
 * @param {string} activityLogPath
 * @param {number} windowMs
 * @returns {{hoursUsed: number, sessionsCount: number, hoursLast24h: number}}
 */
function computeUsage(activityLogPath, windowMs = WEEK_MS) {
    let raw;
    try { raw = fs.readFileSync(activityLogPath, 'utf8'); }
    catch { return { hoursUsed: 0, sessionsCount: 0, hoursLast24h: 0 }; }

    const now = Date.now();
    const windowStart = now - windowMs;
    const day24Start = now - DAY_MS;
    let totalMs = 0;
    let totalMs24h = 0;
    let count = 0;
    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event !== 'session:end') continue;
        if (!evt.ts || !evt.duration_ms) continue;
        const ts = new Date(evt.ts).getTime();
        if (Number.isNaN(ts) || ts < windowStart) continue;
        // Excluir determinísticos (model:'deterministic') porque no consumen
        // cuota del plan Max — solo los agentes Claude reales cuentan.
        if (evt.model === 'deterministic') continue;
        totalMs += evt.duration_ms;
        if (ts >= day24Start) totalMs24h += evt.duration_ms;
        count++;
    }
    return {
        hoursUsed: totalMs / 3600000,
        sessionsCount: count,
        hoursLast24h: totalMs24h / 3600000,
    };
}

/**
 * Calcula la cuota actual con auto-ajuste pasivo.
 * Si las horas usadas exceden el effective_limit (sin bloqueo observado),
 * subimos el límite al observado + buffer.
 */
function computeQuota(metricsDir, activityLogPath, opts = {}) {
    const state = loadState(metricsDir);
    if (opts.configLimitHours && opts.configLimitHours !== state.config_limit_hours) {
        // El config cambió; honrarlo como nuevo piso (pero respetar effective si era mayor)
        state.config_limit_hours = opts.configLimitHours;
        if (state.effective_limit_hours < opts.configLimitHours) {
            state.effective_limit_hours = opts.configLimitHours;
        }
    }
    const usage = computeUsage(activityLogPath);

    // Auto-ajuste UP: si el uso observado en 7d supera el effective_limit
    // sin bloqueo (asumimos que si Anthropic hubiera cortado, no estaríamos
    // ejecutando este snippet), entonces el límite real es mayor.
    let adjusted = false;
    if (usage.hoursUsed > state.effective_limit_hours) {
        const oldLimit = state.effective_limit_hours;
        state.effective_limit_hours = Math.ceil(usage.hoursUsed + ADJUSTMENT_BUFFER_HOURS);
        state.adjustments.push({
            at: new Date().toISOString(),
            from: oldLimit,
            to: state.effective_limit_hours,
            reason: `observed_max=${usage.hoursUsed.toFixed(1)}h > previous_limit=${oldLimit}h, no rate-limit observed`,
        });
        // Mantener solo las últimas 50 ajustes
        if (state.adjustments.length > 50) state.adjustments = state.adjustments.slice(-50);
        adjusted = true;
    }
    if (usage.hoursUsed > state.observed_max_hours) {
        state.observed_max_hours = usage.hoursUsed;
        state.observed_max_at = new Date().toISOString();
    }
    if (adjusted) saveState(metricsDir, state);

    const pct = state.effective_limit_hours > 0
        ? (usage.hoursUsed / state.effective_limit_hours) * 100
        : 0;
    const hoursRemaining = Math.max(0, state.effective_limit_hours - usage.hoursUsed);

    // Burn rate diario: extrapolar últimas 24h. Si no hay datos en 24h,
    // usar promedio de los 7d.
    const burnRatePerDay = usage.hoursLast24h > 0
        ? usage.hoursLast24h
        : (usage.hoursUsed / 7);
    const daysToLimit = burnRatePerDay > 0
        ? hoursRemaining / burnRatePerDay
        : Infinity;

    let status = 'ok';
    if (pct >= 90) status = 'critical';
    else if (pct >= 75) status = 'warning';
    else if (pct >= 50) status = 'normal';

    return {
        hoursUsed7d: Math.round(usage.hoursUsed * 10) / 10,
        sessionsCount7d: usage.sessionsCount,
        hoursLast24h: Math.round(usage.hoursLast24h * 10) / 10,
        effectiveLimitHours: state.effective_limit_hours,
        configLimitHours: state.config_limit_hours,
        pct: Math.round(pct * 10) / 10,
        hoursRemaining: Math.round(hoursRemaining * 10) / 10,
        burnRatePerDay: Math.round(burnRatePerDay * 10) / 10,
        daysToLimit: Number.isFinite(daysToLimit) ? Math.round(daysToLimit * 10) / 10 : null,
        status,
        adjustmentsCount: state.adjustments.length,
        observedMaxHours: Math.round(state.observed_max_hours * 10) / 10,
        observedMaxAt: state.observed_max_at,
        autoAdjusted: adjusted,
    };
}

module.exports = {
    computeQuota,
    computeUsage,
    loadState,
    saveState,
    DEFAULT_LIMIT_HOURS,
};

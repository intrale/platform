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
const DEFAULT_SESSION_LIMIT_HOURS = 5;       // Plan Max: sesión rolling de 5h
const ADJUSTMENT_BUFFER_HOURS = 5;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
// Anthropic resetea la cuota semanal **domingo 21:00 hora local del usuario**
// (constatado en claude.ai/settings/usage). En Argentina = UTC-3 fijo (sin DST).
// Configurable vía env por si el operador está en otra TZ.
const RESET_DAY_LOCAL = 0;  // 0 = Domingo
const RESET_HOUR_LOCAL = 21;
const TZ_OFFSET_MIN = Number(process.env.QUOTA_TZ_OFFSET_MIN) || -180; // ART por default

/**
 * Devuelve el timestamp del último reset semanal (último domingo 21:00 local)
 * para una marca temporal dada.
 */
function getLastWeeklyResetMs(now = Date.now()) {
    // Convertir now a "hora local" sumando offset (offset es diff de UTC, en min)
    const localNow = new Date(now + TZ_OFFSET_MIN * 60000);
    // Construir el "domingo 21:00" más reciente en hora local
    const localReset = new Date(localNow);
    localReset.setUTCHours(RESET_HOUR_LOCAL, 0, 0, 0);
    const dow = localNow.getUTCDay(); // 0=Sun
    let daysBack = (dow - RESET_DAY_LOCAL + 7) % 7;
    if (daysBack === 0 && localNow.getUTCHours() < RESET_HOUR_LOCAL) {
        // Es domingo antes de las 21:00 → el reset fue hace 7 días
        daysBack = 7;
    }
    localReset.setUTCDate(localReset.getUTCDate() - daysBack);
    // Volver de "hora local fingida" a UTC real
    return localReset.getTime() - TZ_OFFSET_MIN * 60000;
}

function getNextWeeklyResetMs(now = Date.now()) {
    return getLastWeeklyResetMs(now) + WEEK_MS;
}

function quotaFile(metricsDir) {
    return path.join(metricsDir, 'weekly-quota.json');
}

function loadState(metricsDir) {
    try {
        const raw = fs.readFileSync(quotaFile(metricsDir), 'utf8');
        const parsed = JSON.parse(raw);
        // Defaults para campos nuevos en estados viejos
        if (!parsed.calibration) parsed.calibration = null;
        return parsed;
    } catch {
        return {
            config_limit_hours: DEFAULT_LIMIT_HOURS,
            effective_limit_hours: DEFAULT_LIMIT_HOURS,
            observed_max_hours: 0,
            observed_max_at: null,
            adjustments: [],
            calibration: null,
        };
    }
}

/**
 * Persiste una calibración manual: el operador ingresa el % real que ve
 * en claude.ai/settings/usage; calculamos un factor que multiplica el %
 * del pipeline para estimar el % real (que incluye uso interactivo en
 * claude.ai aparte del pipeline).
 *
 * @param {string} metricsDir
 * @param {{realWeeklyPct: number, realSessionPct: number, pipelineWeeklyPct: number, pipelineSessionPct: number}} obs
 */
function saveCalibration(metricsDir, obs) {
    const state = loadState(metricsDir);
    const realWeekly = Number(obs.realWeeklyPct);
    const realSession = Number(obs.realSessionPct);
    const pipelineWeekly = Number(obs.pipelineWeeklyPct);
    const pipelineSession = Number(obs.pipelineSessionPct);
    const weeklyFactor = pipelineWeekly > 0 ? realWeekly / pipelineWeekly : 1;
    const sessionFactor = pipelineSession > 0 ? realSession / pipelineSession : 1;
    state.calibration = {
        at: new Date().toISOString(),
        real_weekly_pct: realWeekly,
        real_session_pct: realSession,
        pipeline_weekly_pct_at: pipelineWeekly,
        pipeline_session_pct_at: pipelineSession,
        weekly_factor: Math.round(weeklyFactor * 100) / 100,
        session_factor: Math.round(sessionFactor * 100) / 100,
    };
    saveState(metricsDir, state);
    return state.calibration;
}

function saveState(metricsDir, state) {
    try {
        fs.mkdirSync(metricsDir, { recursive: true });
        fs.writeFileSync(quotaFile(metricsDir), JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
}

/**
 * Suma duration_ms de session:end desde un timestamp de inicio hasta now.
 * @param {string} activityLogPath
 * @param {number} sinceMs - timestamp inicial (ej. último reset semanal)
 * @returns {{hoursUsed: number, sessionsCount: number, hoursLast24h: number}}
 */
function computeUsageSince(activityLogPath, sinceMs) {
    let raw;
    try { raw = fs.readFileSync(activityLogPath, 'utf8'); }
    catch { return { hoursUsed: 0, sessionsCount: 0, hoursLast24h: 0 }; }

    const now = Date.now();
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
        if (Number.isNaN(ts) || ts < sinceMs) continue;
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

// Wrapper de compat para callers viejos que pasaban windowMs deslizante.
function computeUsage(activityLogPath, windowMs = WEEK_MS) {
    return computeUsageSince(activityLogPath, Date.now() - windowMs);
}

/**
 * Calcula la cuota actual con auto-ajuste pasivo.
 * Ventana semanal = desde el último domingo 21:00 local (Argentina por default).
 * Sesión = rolling 5h.
 * Si las horas usadas en la semana exceden el effective_limit (sin bloqueo
 * observado), subimos el límite al observado + buffer.
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
    // Reset semanal del observed_max_hours: si pasamos por un reset desde la
    // última vez que actualizamos, el observado debe limpiarse para que
    // refleje la semana nueva (no acumular del histórico).
    const lastReset = getLastWeeklyResetMs();
    if (state.observed_max_at) {
        const observedTs = new Date(state.observed_max_at).getTime();
        if (observedTs < lastReset) {
            state.observed_max_hours = 0;
            state.observed_max_at = null;
        }
    }
    const usage = computeUsageSince(activityLogPath, lastReset);

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
    // usar promedio de la semana en curso.
    const daysSinceReset = Math.max(1, (Date.now() - lastReset) / DAY_MS);
    const burnRatePerDay = usage.hoursLast24h > 0
        ? usage.hoursLast24h
        : (usage.hoursUsed / daysSinceReset);
    const daysToLimit = burnRatePerDay > 0
        ? hoursRemaining / burnRatePerDay
        : Infinity;
    const nextReset = getNextWeeklyResetMs();
    const msToReset = nextReset - Date.now();
    const daysToReset = msToReset / DAY_MS;

    let status = 'ok';
    if (pct >= 90) status = 'critical';
    else if (pct >= 75) status = 'warning';
    else if (pct >= 50) status = 'normal';

    // Sesión rolling 5h — el plan Max define una sesión de 5h que empieza
    // con el primer mensaje y resetea 5h después. Aproximación pragmática:
    // sumar duration_ms en las últimas 5h. No es exactamente lo que muestra
    // claude.ai (que detecta el "primer mensaje" como pivote), pero da una
    // señal útil de saturación de la sesión actual.
    const sessionUsage = computeUsageSince(activityLogPath, Date.now() - DEFAULT_SESSION_LIMIT_HOURS * HOUR_MS);
    const sessionPct = (sessionUsage.hoursUsed / DEFAULT_SESSION_LIMIT_HOURS) * 100;
    let sessionStatus = 'ok';
    if (sessionPct >= 90) sessionStatus = 'critical';
    else if (sessionPct >= 75) sessionStatus = 'warning';
    else if (sessionPct >= 50) sessionStatus = 'normal';

    // Aplicar calibración manual (si existe). Multiplica el % del pipeline
    // por el factor observado contra el % real de claude.ai. El resultado es
    // un "estimado real" más cercano a la cuota verdadera de Anthropic
    // (que incluye uso interactivo del operador, no solo el pipeline).
    let realPct = null;
    let realSessionPct = null;
    let realStatus = status;
    let realSessionStatus = sessionStatus;
    if (state.calibration && state.calibration.weekly_factor) {
        realPct = Math.round(pct * state.calibration.weekly_factor * 10) / 10;
        if (realPct >= 90) realStatus = 'critical';
        else if (realPct >= 75) realStatus = 'warning';
        else if (realPct >= 50) realStatus = 'normal';
        else realStatus = 'ok';
    }
    if (state.calibration && state.calibration.session_factor) {
        realSessionPct = Math.round(sessionPct * state.calibration.session_factor * 10) / 10;
        if (realSessionPct >= 90) realSessionStatus = 'critical';
        else if (realSessionPct >= 75) realSessionStatus = 'warning';
        else if (realSessionPct >= 50) realSessionStatus = 'normal';
        else realSessionStatus = 'ok';
    }

    return {
        // Semanal (ventana real, reset domingo 21:00 local)
        hoursUsed7d: Math.round(usage.hoursUsed * 10) / 10,
        sessionsCount7d: usage.sessionsCount,
        hoursLast24h: Math.round(usage.hoursLast24h * 10) / 10,
        effectiveLimitHours: state.effective_limit_hours,
        configLimitHours: state.config_limit_hours,
        pct: Math.round(pct * 10) / 10,
        realPct,
        realStatus,
        hoursRemaining: Math.round(hoursRemaining * 10) / 10,
        burnRatePerDay: Math.round(burnRatePerDay * 10) / 10,
        daysToLimit: Number.isFinite(daysToLimit) ? Math.round(daysToLimit * 10) / 10 : null,
        status,
        adjustmentsCount: state.adjustments.length,
        observedMaxHours: Math.round(state.observed_max_hours * 10) / 10,
        observedMaxAt: state.observed_max_at,
        autoAdjusted: adjusted,
        // Reset semanal real
        lastResetAt: new Date(lastReset).toISOString(),
        nextResetAt: new Date(nextReset).toISOString(),
        daysToReset: Math.round(daysToReset * 10) / 10,
        // Sesión rolling 5h
        session: {
            hoursUsed: Math.round(sessionUsage.hoursUsed * 100) / 100,
            sessionsCount: sessionUsage.sessionsCount,
            limitHours: DEFAULT_SESSION_LIMIT_HOURS,
            pct: Math.round(sessionPct * 10) / 10,
            realPct: realSessionPct,
            realStatus: realSessionStatus,
            hoursRemaining: Math.round(Math.max(0, DEFAULT_SESSION_LIMIT_HOURS - sessionUsage.hoursUsed) * 100) / 100,
            status: sessionStatus,
        },
        // Calibración (si existe)
        calibration: state.calibration,
    };
}

module.exports = {
    computeQuota,
    computeUsage,
    computeUsageSince,
    getLastWeeklyResetMs,
    getNextWeeklyResetMs,
    loadState,
    saveState,
    saveCalibration,
    DEFAULT_LIMIT_HOURS,
    DEFAULT_SESSION_LIMIT_HOURS,
};

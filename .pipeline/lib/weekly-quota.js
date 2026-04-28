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
// #2854 — Aprendizaje multi-semana. Histórico extendido a 50 muestras
// (~4-8 semanas). El factor se refina con mediana ponderada por recencia
// sobre las últimas 28 días. Half-life del peso = 14 días.
const CALIBRATION_HISTORY_MAX = 50;
const CALIBRATION_FRESH_WINDOW_MS = 28 * DAY_MS;
const CALIBRATION_HALF_LIFE_DAYS = 14;
// `weekly_profiles[]` persiste el factor "estable" de cada semana cerrada
// para tener referencia comparativa semana a semana. Hasta 12 semanas
// (~3 meses) — útil para detectar tendencias estacionales.
const WEEKLY_PROFILES_MAX = 12;
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

function getNextWeeklyResetMs(now = Date.now(), driftMin = 0) {
    return getLastWeeklyResetMs(now) + WEEK_MS + (driftMin || 0) * 60000;
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
        if (!parsed.calibrations) parsed.calibrations = [];
        if (!parsed.weekly_profiles) parsed.weekly_profiles = [];
        return parsed;
    } catch {
        return {
            config_limit_hours: DEFAULT_LIMIT_HOURS,
            effective_limit_hours: DEFAULT_LIMIT_HOURS,
            observed_max_hours: 0,
            observed_max_at: null,
            adjustments: [],
            calibration: null,
            calibrations: [],
            weekly_profiles: [],
        };
    }
}

/**
 * Mediana ponderada por recencia. Cada observación tiene un peso
 * exponencialmente decreciente con la edad (half-life 14 días).
 *
 *   peso(age_days) = 0.5 ^ (age_days / 14)
 *
 * Ventajas vs EMA simple:
 *  - **Robusta a outliers**: la mediana ignora picos extremos. Cuando Leo
 *    carga varios % seguidos para experimentar, los outliers no arrastran
 *    el factor.
 *  - **Multi-semana**: usa hasta 28 días de historial en lugar de chatarse
 *    a una EMA con peso fijo.
 *  - **Tendencia**: muestras más recientes pesan más (recency bias suave).
 *
 * Si hay menos de 3 muestras frescas, fallback al promedio simple.
 *
 * @param {Array<{at:string, value:number}>} samples - observaciones con timestamp
 * @param {number} now - timestamp actual (ms)
 * @returns {number} factor calibrado
 */
function weightedRecencyMedian(samples, now) {
    const fresh = (samples || []).filter(s => {
        const age = now - new Date(s.at).getTime();
        return age >= 0 && age <= CALIBRATION_FRESH_WINDOW_MS && Number.isFinite(s.value) && s.value > 0;
    });
    if (fresh.length === 0) return null;
    if (fresh.length < 3) {
        // Promedio simple para n<3 — la mediana no es estable con pocas muestras
        const sum = fresh.reduce((s, x) => s + x.value, 0);
        return sum / fresh.length;
    }
    // Calcular peso por edad
    const weighted = fresh.map(s => {
        const ageDays = (now - new Date(s.at).getTime()) / DAY_MS;
        const w = Math.pow(0.5, ageDays / CALIBRATION_HALF_LIFE_DAYS);
        return { value: s.value, weight: w };
    });
    // Ordenar por valor y encontrar el punto donde la suma de pesos cruza el 50%
    weighted.sort((a, b) => a.value - b.value);
    const totalWeight = weighted.reduce((s, x) => s + x.weight, 0);
    let cumulative = 0;
    for (const item of weighted) {
        cumulative += item.weight;
        if (cumulative >= totalWeight / 2) return item.value;
    }
    return weighted[weighted.length - 1].value;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Persiste una calibración manual con APRENDIZAJE MULTI-SEMANA (#2854).
 *
 *   1. Histórico extendido a 50 calibraciones (~4-8 semanas).
 *   2. El factor se refina con **mediana ponderada por recencia** sobre las
 *      últimas 28 días (half-life 14d). Razón: la mediana es robusta a
 *      outliers (Leo a veces carga varios % seguidos para experimentar),
 *      y considerar 4 semanas permite que la calibración mejore con cada
 *      semana en lugar de chatarse a una EMA simple.
 *   3. Si la calibración cruza un reset semanal vs la calibración previa,
 *      snapshoteamos el factor "estable" de la semana cerrada en
 *      `weekly_profiles[]` (max 12 entradas). Esto preserva el factor
 *      característico de cada semana para análisis comparativo.
 *   4. Persiste `session_resets_at` / `weekly_resets_at` absolutos cuando
 *      el operador los reporta — el cliente muestra cuenta regresiva
 *      precisa y el server detecta drift de TZ del weekly reset.
 *
 * @param {string} metricsDir
 * @param {{realWeeklyPct, realSessionPct, pipelineWeeklyPct, pipelineSessionPct, sessionResetsInMinutes?, weeklyResetsInMinutes?}} obs
 */
function saveCalibration(metricsDir, obs) {
    const state = loadState(metricsDir);
    const realWeekly = Number(obs.realWeeklyPct);
    const realSession = Number(obs.realSessionPct);
    const pipelineWeekly = Number(obs.pipelineWeeklyPct);
    const pipelineSession = Number(obs.pipelineSessionPct);
    const newWeeklyFactor = pipelineWeekly > 0 ? realWeekly / pipelineWeekly : 1;
    const newSessionFactor = pipelineSession > 0 ? realSession / pipelineSession : 1;

    const now = Date.now();
    // Snapshot de la semana cerrada: si la calibración previa pertenecía a
    // una semana anterior, congelar el factor final como perfil de esa semana.
    maybeSnapshotPreviousWeek(state, now);
    // Aceptar tanto "minutos al reset" (legacy) como "timestamp ISO absoluto"
    // (preferido — más natural cuando el operador pega una hora del datetime
    // picker o de claude.ai). Si vienen ambos, gana el ISO absoluto.
    function parseResetAt(directIso, minutesField) {
        if (directIso) {
            const ts = new Date(directIso).getTime();
            if (Number.isFinite(ts) && ts > now) return new Date(ts).toISOString();
        }
        if (Number.isFinite(minutesField) && minutesField > 0) {
            return new Date(now + minutesField * 60000).toISOString();
        }
        return null;
    }
    const sessionResetsAt = parseResetAt(obs.sessionResetsAt, obs.sessionResetsInMinutes);
    const weeklyResetsAt = parseResetAt(obs.weeklyResetsAt, obs.weeklyResetsInMinutes);

    // Detectar drift del reset semanal: si nuestro cálculo predice X y user
    // reporta Y con > 30 min de diferencia, persistir el offset para corregir
    // próximas invocaciones de getNextWeeklyResetMs().
    let weeklyResetDriftMin = state.weekly_reset_drift_min || 0;
    if (weeklyResetsAt) {
        const ourPredicted = getNextWeeklyResetMs(now);
        const reportedMs = new Date(weeklyResetsAt).getTime();
        const driftMs = reportedMs - ourPredicted;
        if (Math.abs(driftMs) > 30 * 60000) {
            weeklyResetDriftMin = Math.round(driftMs / 60000);
        }
    }

    const entry = {
        at: new Date(now).toISOString(),
        real_weekly_pct: realWeekly,
        real_session_pct: realSession,
        pipeline_weekly_pct_at: pipelineWeekly,
        pipeline_session_pct_at: pipelineSession,
        weekly_factor_obs: round2(newWeeklyFactor),
        session_factor_obs: round2(newSessionFactor),
        session_resets_at: sessionResetsAt,
        weekly_resets_at: weeklyResetsAt,
    };
    state.calibrations.push(entry);
    if (state.calibrations.length > CALIBRATION_HISTORY_MAX) {
        state.calibrations = state.calibrations.slice(-CALIBRATION_HISTORY_MAX);
    }

    // Mediana ponderada por recencia sobre los obs frescos (≤28d).
    // Si hay muy pocas muestras (<3 frescas), `weightedRecencyMedian` cae
    // a promedio simple — y si tampoco hay frescas, usamos el obs actual.
    const weeklySamples = state.calibrations.map(c => ({ at: c.at, value: Number(c.weekly_factor_obs) }));
    const sessionSamples = state.calibrations.map(c => ({ at: c.at, value: Number(c.session_factor_obs) }));
    const refinedWeekly = weightedRecencyMedian(weeklySamples, now);
    const refinedSession = weightedRecencyMedian(sessionSamples, now);
    const finalWeekly = Number.isFinite(refinedWeekly) && refinedWeekly > 0 ? refinedWeekly : newWeeklyFactor;
    const finalSession = Number.isFinite(refinedSession) && refinedSession > 0 ? refinedSession : newSessionFactor;
    // Conteo de muestras frescas (las que efectivamente entraron al cálculo).
    const freshCount = state.calibrations.filter(c =>
        (now - new Date(c.at).getTime()) <= CALIBRATION_FRESH_WINDOW_MS
    ).length;

    state.calibration = {
        at: new Date(now).toISOString(),
        real_weekly_pct: realWeekly,
        real_session_pct: realSession,
        pipeline_weekly_pct_at: pipelineWeekly,
        pipeline_session_pct_at: pipelineSession,
        weekly_factor: round2(finalWeekly),
        session_factor: round2(finalSession),
        weekly_factor_obs: round2(newWeeklyFactor),
        session_factor_obs: round2(newSessionFactor),
        sample_count: state.calibrations.length,
        fresh_sample_count: freshCount,
        method: 'weighted_recency_median_28d',
        half_life_days: CALIBRATION_HALF_LIFE_DAYS,
        session_resets_at: sessionResetsAt,
        weekly_resets_at: weeklyResetsAt,
    };
    state.weekly_reset_drift_min = weeklyResetDriftMin;
    saveState(metricsDir, state);
    return state.calibration;
}

/**
 * Si la calibración previa (state.calibration) pertenece a una semana
 * anterior al `now`, snapshotea el perfil de esa semana en `weekly_profiles[]`.
 * Idempotente: si ya hay perfil para esa misma semana, no duplica.
 *
 * Estructura del perfil:
 *  - `week_start_iso`, `week_end_iso`: límites de la semana cerrada
 *  - `final_factor_weekly`, `final_factor_session`: último factor refinado
 *  - `samples_in_week`: cantidad de calibraciones cargadas en esa semana
 *  - `max_real_weekly_pct`: pico de %real reportado en la semana (para
 *    detectar semanas más intensas)
 */
function maybeSnapshotPreviousWeek(state, now) {
    if (!state.calibration || !state.calibration.at) return;
    const prevAt = new Date(state.calibration.at).getTime();
    const prevResetEnd = getNextWeeklyResetMs(prevAt);
    // Si el siguiente reset semanal de la calib previa ya pasó vs `now`,
    // entonces la calibración previa pertenece a una semana cerrada.
    if (prevResetEnd > now) return;
    const weekStart = getLastWeeklyResetMs(prevAt);
    const weekStartIso = new Date(weekStart).toISOString();
    if (!state.weekly_profiles) state.weekly_profiles = [];
    if (state.weekly_profiles.some(p => p.week_start_iso === weekStartIso)) return;
    // Filtrar calibraciones que cayeron dentro de esa semana
    const inWeek = (state.calibrations || []).filter(c => {
        const t = new Date(c.at).getTime();
        return t >= weekStart && t < prevResetEnd;
    });
    const maxRealWeekly = inWeek.reduce((m, c) => Math.max(m, Number(c.real_weekly_pct) || 0), 0);
    state.weekly_profiles.push({
        week_start_iso: weekStartIso,
        week_end_iso: new Date(prevResetEnd).toISOString(),
        final_factor_weekly: state.calibration.weekly_factor,
        final_factor_session: state.calibration.session_factor,
        samples_in_week: inWeek.length,
        max_real_weekly_pct: maxRealWeekly,
        snapshotted_at: new Date(now).toISOString(),
    });
    if (state.weekly_profiles.length > WEEKLY_PROFILES_MAX) {
        state.weekly_profiles = state.weekly_profiles.slice(-WEEKLY_PROFILES_MAX);
    }
}

function clearCalibration(metricsDir) {
    const state = loadState(metricsDir);
    state.calibration = null;
    state.weekly_reset_drift_min = 0;
    // calibrations[] (historial) se conserva para auditoría/debug.
    saveState(metricsDir, state);
    return { ok: true, msg: 'Calibración borrada — los KPIs vuelven a mostrar el pipeline raw.' };
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
    // Si el operador reportó el reset semanal exacto en una calibración
    // reciente, lo usamos por encima de nuestro cálculo (que corrige TZ
    // drift via weekly_reset_drift_min).
    let nextReset = getNextWeeklyResetMs(Date.now(), state.weekly_reset_drift_min || 0);
    if (state.calibration && state.calibration.weekly_resets_at) {
        const reportedReset = new Date(state.calibration.weekly_resets_at).getTime();
        // Solo respetar si está en el futuro (no expiró). Sino caer al cálculo.
        if (reportedReset > Date.now()) nextReset = reportedReset;
    }
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
    //
    // **Cap al 100%**: el factor es lineal y queda fijo desde la calibración,
    // pero el pipeline pct rolling 5h puede crecer (porque el pipeline procesa
    // más) sin que necesariamente la cuota real crezca proporcional. Resultado:
    // sin cap, se llegan a valores absurdos (211%, 300%). Capear refleja la
    // realidad (la cuota nunca puede pasar 100%) y exponer `*PctRaw` permite
    // detectar saturación: si pasa >120%, la calibración está obsoleta y
    // conviene recalibrar.
    let realPct = null;
    let realPctRaw = null;
    let realPctCapped = false;
    let realSessionPct = null;
    let realSessionPctRaw = null;
    let realSessionPctCapped = false;
    let realStatus = status;
    let realSessionStatus = sessionStatus;
    if (state.calibration && state.calibration.weekly_factor) {
        realPctRaw = Math.round(pct * state.calibration.weekly_factor * 10) / 10;
        realPct = Math.min(100, realPctRaw);
        realPctCapped = realPctRaw > 100;
        if (realPct >= 90) realStatus = 'critical';
        else if (realPct >= 75) realStatus = 'warning';
        else if (realPct >= 50) realStatus = 'normal';
        else realStatus = 'ok';
    }
    if (state.calibration && state.calibration.session_factor) {
        realSessionPctRaw = Math.round(sessionPct * state.calibration.session_factor * 10) / 10;
        realSessionPct = Math.min(100, realSessionPctRaw);
        realSessionPctCapped = realSessionPctRaw > 100;
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
        realPctRaw,
        realPctCapped,
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
            realPctRaw: realSessionPctRaw,
            realPctCapped: realSessionPctCapped,
            realStatus: realSessionStatus,
            hoursRemaining: Math.round(Math.max(0, DEFAULT_SESSION_LIMIT_HOURS - sessionUsage.hoursUsed) * 100) / 100,
            status: sessionStatus,
        },
        // Calibración (si existe) + historial reciente (últimas 50, multi-semana)
        calibration: state.calibration,
        calibrations: (state.calibrations || []).slice(-CALIBRATION_HISTORY_MAX),
        // Perfiles de semanas cerradas (factor estable de cada semana, hasta 12)
        // Permite a Leo / al dashboard comparar tendencia semana a semana.
        weeklyProfiles: state.weekly_profiles || [],
        weeklyResetDriftMin: state.weekly_reset_drift_min || 0,
        // Stale: la calibración pierde precisión con el tiempo. Marcamos
        // stale > 7d para sugerir recalibrar.
        calibrationAgeDays: state.calibration
            ? Math.round((Date.now() - new Date(state.calibration.at).getTime()) / DAY_MS * 10) / 10
            : null,
        calibrationStale: state.calibration
            ? (Date.now() - new Date(state.calibration.at).getTime()) > 7 * DAY_MS
            : false,
        // Reset times reportados por el operador (si los proveyó en última calib)
        sessionResetsAt: state.calibration ? state.calibration.session_resets_at : null,
        weeklyResetsAtReported: state.calibration ? state.calibration.weekly_resets_at : null,
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
    clearCalibration,
    weightedRecencyMedian,
    DEFAULT_LIMIT_HOURS,
    DEFAULT_SESSION_LIMIT_HOURS,
    CALIBRATION_HISTORY_MAX,
    CALIBRATION_FRESH_WINDOW_MS,
    CALIBRATION_HALF_LIFE_DAYS,
    WEEKLY_PROFILES_MAX,
};

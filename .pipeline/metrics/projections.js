// V3 Metrics — Proyecciones de consumo (tokens + TTS) (#2488)
// Calcula promedios diarios, proyecciones semanales/mensuales y detección de desvío vs cuota.
//
// Input: serie temporal diaria ordenada [{ day: 'YYYY-MM-DD', cost_usd, tts_cost_usd, sessions, tts_chars, tts_audio_seconds }]
// Output: objeto con proyecciones y alertas por dimensión (tokens/TTS).

'use strict';

// Cuotas por defecto — override con env vars si el usuario maneja plan Max/etc.
const DEFAULT_MONTHLY_TOKEN_USD = Number(process.env.METRICS_QUOTA_MONTHLY_USD || 100);
const DEFAULT_MONTHLY_TTS_USD   = Number(process.env.METRICS_QUOTA_TTS_MONTHLY_USD || 10);
// #2854 — Cuota semanal (USD). Permite proyectar agotamiento dentro de la
// semana corriente (Plan API o presupuesto operativo). Override con env.
const DEFAULT_WEEKLY_TOKEN_USD = Number(process.env.METRICS_QUOTA_WEEKLY_USD || 25);

// Cuántos días recientes se usan para el promedio (ignora días muy viejos para reflejar tendencia actual)
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_BURN_WINDOW_DAYS = 7;

function daysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysElapsedThisMonth(date) {
    return date.getDate();
}

function daysRemainingThisMonth(date) {
    return daysInMonth(date) - daysElapsedThisMonth(date);
}

function daysRemainingThisWeek(date) {
    // 0 = domingo, 6 = sábado. Queremos días restantes hasta fin de semana (lunes a domingo).
    const dow = date.getDay();
    return dow === 0 ? 0 : 7 - dow;
}

function round(n, d) {
    const mult = Math.pow(10, d || 4);
    return Math.round(n * mult) / mult;
}

// Promedio diario usando los últimos N días que efectivamente aparecen en la serie.
// Si la serie es más corta que windowDays, divide por los días que haya (no subestima).
function dailyAverage(series, field, windowDays) {
    if (!series || series.length === 0) return 0;
    const take = Math.min(windowDays, series.length);
    const recent = series.slice(-take);
    const sum = recent.reduce((s, d) => s + Number(d[field] || 0), 0);
    return sum / take;
}

// Suma del mes actual (para saber cuánto llevamos gastado)
function monthToDate(series, field, now) {
    if (!series || series.length === 0) return 0;
    const mStart = startOfMonth(now).toISOString().substring(0, 10);
    return series
        .filter(d => d.day >= mStart)
        .reduce((s, d) => s + Number(d[field] || 0), 0);
}

function buildDimension({ series, costField, quotaUsd, now, label, secondaryFields }) {
    const avgDaily = dailyAverage(series, costField, DEFAULT_WINDOW_DAYS);
    const weeklyProj = avgDaily * 7;
    const monthlyProj = avgDaily * daysInMonth(now);

    const monthToDateUsd = monthToDate(series, costField, now);
    const daysLeftMonth = daysRemainingThisMonth(now);
    // Proyección del cierre de mes = gastado hoy + (promedio_diario × días_que_quedan)
    const monthlyForecast = monthToDateUsd + (avgDaily * daysLeftMonth);

    const overQuota = monthlyForecast > quotaUsd;
    const quotaDeltaUsd = round(monthlyForecast - quotaUsd, 4);
    const quotaRatio = quotaUsd > 0 ? round(monthlyForecast / quotaUsd, 3) : null;

    const secondary = {};
    if (Array.isArray(secondaryFields)) {
        for (const f of secondaryFields) {
            secondary[f + '_daily_avg'] = round(dailyAverage(series, f, DEFAULT_WINDOW_DAYS), 2);
            secondary[f + '_weekly_projection'] = round(dailyAverage(series, f, DEFAULT_WINDOW_DAYS) * 7, 2);
            secondary[f + '_monthly_projection'] = round(dailyAverage(series, f, DEFAULT_WINDOW_DAYS) * daysInMonth(now), 2);
            secondary[f + '_month_to_date'] = round(monthToDate(series, f, now), 2);
        }
    }

    return Object.assign({
        dimension: label,
        window_days: DEFAULT_WINDOW_DAYS,
        samples: Math.min(series.length, DEFAULT_WINDOW_DAYS),
        daily_avg_usd: round(avgDaily, 4),
        weekly_projection_usd: round(weeklyProj, 4),
        monthly_projection_usd: round(monthlyProj, 4),
        month_to_date_usd: round(monthToDateUsd, 4),
        monthly_forecast_usd: round(monthlyForecast, 4),
        days_elapsed_this_month: daysElapsedThisMonth(now),
        days_remaining_this_month: daysLeftMonth,
        days_remaining_this_week: daysRemainingThisWeek(now),
        quota: {
            monthly_usd: quotaUsd,
            forecast_usd: round(monthlyForecast, 4),
            delta_usd: quotaDeltaUsd,
            ratio: quotaRatio,
            status: overQuota ? 'over' : (quotaRatio !== null && quotaRatio > 0.9 ? 'warning' : 'ok'),
            alert: overQuota
                ? `Proyección supera la cuota por $${Math.abs(quotaDeltaUsd).toFixed(2)} USD (${Math.round((quotaRatio || 0) * 100)}% de la cuota mensual)`
                : null,
        },
    }, secondary);
}

function computeProjections(opts) {
    opts = opts || {};
    const series = Array.isArray(opts.daily) ? opts.daily : [];
    const now = opts.now instanceof Date ? opts.now : new Date();
    const quotas = opts.quotas || {};
    const monthlyTokenQuota = Number(quotas.monthly_token_usd !== undefined ? quotas.monthly_token_usd : DEFAULT_MONTHLY_TOKEN_USD);
    const monthlyTtsQuota   = Number(quotas.monthly_tts_usd   !== undefined ? quotas.monthly_tts_usd   : DEFAULT_MONTHLY_TTS_USD);
    const weeklyTokenQuota  = Number(quotas.weekly_token_usd  !== undefined ? quotas.weekly_token_usd  : DEFAULT_WEEKLY_TOKEN_USD);

    return {
        generated_at: now.toISOString(),
        tokens: buildDimension({
            series,
            costField: 'cost_usd',
            quotaUsd: monthlyTokenQuota,
            now,
            label: 'tokens',
            secondaryFields: ['sessions'],
        }),
        tts: buildDimension({
            series,
            costField: 'tts_cost_usd',
            quotaUsd: monthlyTtsQuota,
            now,
            label: 'tts',
            secondaryFields: ['tts_chars', 'tts_audio_seconds'],
        }),
        // #2854 — Burn rate y budget gap por costo USD (semanal). Permite
        // contestar: "te quedás sin cuota el [día]" y "necesitás +US$ X
        // para llegar al domingo a este ritmo".
        burn: computeBurnAndGap({ series, weeklyTokenQuota, monthlyTokenQuota, now }),
    };
}

// Día de la semana en que reseta la cuota semanal (Anthropic Plan Max:
// domingo 21:00 hora local). Override por env si la cuenta es API/distinta.
const WEEK_RESET_DOW = Number(process.env.METRICS_WEEK_RESET_DOW); // 0=Dom, 6=Sáb
const WEEK_RESET_DEFAULT = 0; // Domingo

function nextWeeklyResetIso(now) {
    const targetDow = Number.isFinite(WEEK_RESET_DOW) ? WEEK_RESET_DOW : WEEK_RESET_DEFAULT;
    const d = new Date(now.getTime());
    const dow = d.getDay();
    let daysAhead = (targetDow - dow + 7) % 7;
    if (daysAhead === 0) daysAhead = 7; // si hoy es el día de reset, apuntar al próximo
    d.setDate(d.getDate() + daysAhead);
    d.setHours(21, 0, 0, 0); // 21:00 local
    return d;
}

function startOfCurrentWeek(now) {
    const targetDow = Number.isFinite(WEEK_RESET_DOW) ? WEEK_RESET_DOW : WEEK_RESET_DEFAULT;
    const next = nextWeeklyResetIso(now);
    const start = new Date(next.getTime());
    start.setDate(start.getDate() - 7);
    return start;
}

function sumSeriesSince(series, startIso, field) {
    return series
        .filter(d => d.day >= startIso)
        .reduce((s, d) => s + Number(d[field] || 0), 0);
}

function computeBurnAndGap({ series, weeklyTokenQuota, monthlyTokenQuota, now }) {
    if (!series || series.length === 0) {
        return {
            burn_rate_usd_per_day_24h: 0,
            burn_rate_usd_per_day_7d: 0,
            week_to_date_usd: 0,
            week_remaining_quota_usd: weeklyTokenQuota,
            weekly_quota_usd: weeklyTokenQuota,
            forecast_week_end_usd: 0,
            week_gap_usd: 0,
            days_to_quota_exhaustion: null,
            quota_exhaustion_at: null,
            week_resets_at: nextWeeklyResetIso(now).toISOString(),
            human_message: null,
            status: 'ok',
        };
    }
    // Burn rate 24h = costo del último día de la serie (proxy).
    const last = series[series.length - 1];
    const burn24h = Number(last && last.cost_usd || 0);
    // Burn rate 7d promedio.
    const burn7dAvg = dailyAverage(series, 'cost_usd', DEFAULT_BURN_WINDOW_DAYS);
    // Burn rate efectivo: máximo entre 24h reciente y promedio 7d para ser
    // conservador con picos. Si 24h > 7d → estamos acelerando.
    const burnEffective = Math.max(burn24h, burn7dAvg);

    const weekStartIso = startOfCurrentWeek(now).toISOString().substring(0, 10);
    const weekToDate = sumSeriesSince(series, weekStartIso, 'cost_usd');
    const weekRemainingQuota = Math.max(0, weeklyTokenQuota - weekToDate);
    const weekResetMs = nextWeeklyResetIso(now).getTime();
    const daysToWeekReset = Math.max(0, (weekResetMs - now.getTime()) / 86400000);

    const forecastWeekEnd = weekToDate + (burnEffective * daysToWeekReset);
    const weekGap = forecastWeekEnd - weeklyTokenQuota;

    let daysToExhaustion = null;
    let exhaustionAt = null;
    if (burnEffective > 0 && weekRemainingQuota > 0) {
        daysToExhaustion = weekRemainingQuota / burnEffective;
        exhaustionAt = new Date(now.getTime() + daysToExhaustion * 86400000).toISOString();
    } else if (weekRemainingQuota <= 0) {
        daysToExhaustion = 0;
        exhaustionAt = now.toISOString();
    }

    let status = 'ok';
    if (weekRemainingQuota <= 0) status = 'over';
    else if (forecastWeekEnd > weeklyTokenQuota) status = 'projected_over';
    else if (forecastWeekEnd > weeklyTokenQuota * 0.9) status = 'warning';

    let humanMessage = null;
    const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    if (status === 'over') {
        humanMessage = `Te quedaste sin cuota semanal. Llevás US$${weekToDate.toFixed(2)} de US$${weeklyTokenQuota.toFixed(2)}.`;
    } else if (daysToExhaustion !== null && Number.isFinite(daysToExhaustion) && daysToExhaustion < daysToWeekReset) {
        const exhaustDate = new Date(exhaustionAt);
        const dayName = dayNames[exhaustDate.getDay()];
        const hh = String(exhaustDate.getHours()).padStart(2, '0');
        const mm = String(exhaustDate.getMinutes()).padStart(2, '0');
        humanMessage = `A este ritmo te quedás sin cuota el ${dayName} a las ${hh}:${mm}. Necesitás +US$${weekGap.toFixed(2)} de presupuesto extra para llegar al fin de semana.`;
    } else if (status === 'warning') {
        humanMessage = `Atención: la proyección al fin de semana (US$${forecastWeekEnd.toFixed(2)}) está cerca del límite (US$${weeklyTokenQuota.toFixed(2)}).`;
    } else {
        humanMessage = `OK. Proyección al fin de semana: US$${forecastWeekEnd.toFixed(2)} de US$${weeklyTokenQuota.toFixed(2)}.`;
    }

    return {
        burn_rate_usd_per_day_24h: round(burn24h, 4),
        burn_rate_usd_per_day_7d: round(burn7dAvg, 4),
        burn_rate_usd_per_day_effective: round(burnEffective, 4),
        week_to_date_usd: round(weekToDate, 4),
        week_remaining_quota_usd: round(weekRemainingQuota, 4),
        weekly_quota_usd: weeklyTokenQuota,
        monthly_quota_usd: monthlyTokenQuota,
        forecast_week_end_usd: round(forecastWeekEnd, 4),
        week_gap_usd: round(weekGap, 4),
        days_to_quota_exhaustion: daysToExhaustion !== null && Number.isFinite(daysToExhaustion)
            ? round(daysToExhaustion, 2)
            : null,
        quota_exhaustion_at: exhaustionAt,
        week_resets_at: new Date(weekResetMs).toISOString(),
        days_to_week_reset: round(daysToWeekReset, 2),
        human_message: humanMessage,
        status,
    };
}

module.exports = {
    computeProjections,
    computeBurnAndGap,
    dailyAverage,
    daysInMonth,
    daysRemainingThisMonth,
    daysRemainingThisWeek,
    nextWeeklyResetIso,
    startOfCurrentWeek,
    DEFAULT_MONTHLY_TOKEN_USD,
    DEFAULT_MONTHLY_TTS_USD,
    DEFAULT_WEEKLY_TOKEN_USD,
    DEFAULT_WINDOW_DAYS,
    monthToDate,
};

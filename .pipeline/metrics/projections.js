// V3 Metrics — Proyecciones de consumo (tokens + TTS) (#2488)
// Calcula promedios diarios, proyecciones semanales/mensuales y detección de desvío vs cuota.
//
// Input: serie temporal diaria ordenada [{ day: 'YYYY-MM-DD', cost_usd, tts_cost_usd, sessions, tts_chars, tts_audio_seconds }]
// Output: objeto con proyecciones y alertas por dimensión (tokens/TTS).

'use strict';

// Cuotas por defecto — override con env vars si el usuario maneja plan Max/etc.
const DEFAULT_MONTHLY_TOKEN_USD = Number(process.env.METRICS_QUOTA_MONTHLY_USD || 100);
const DEFAULT_MONTHLY_TTS_USD   = Number(process.env.METRICS_QUOTA_TTS_MONTHLY_USD || 10);

// Cuántos días recientes se usan para el promedio (ignora días muy viejos para reflejar tendencia actual)
const DEFAULT_WINDOW_DAYS = 7;

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
    };
}

module.exports = {
    computeProjections,
    dailyAverage,
    daysInMonth,
    daysRemainingThisMonth,
    daysRemainingThisWeek,
    monthToDate,
    DEFAULT_MONTHLY_TOKEN_USD,
    DEFAULT_MONTHLY_TTS_USD,
    DEFAULT_WINDOW_DAYS,
};

// Tests de .pipeline/metrics/projections.js (#2488)
// Verifica promedios diarios, proyecciones mensuales/semanales y detección de desvío.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    computeProjections,
    dailyAverage,
    daysInMonth,
    daysRemainingThisMonth,
    daysRemainingThisWeek,
    monthToDate,
} = require('../projections');

function mkDay(day, cost, tts, sessions, chars, audio) {
    return {
        day,
        cost_usd: cost,
        tts_cost_usd: tts || 0,
        sessions: sessions || 0,
        tts_chars: chars || 0,
        tts_audio_seconds: audio || 0,
    };
}

test('dailyAverage respeta ventana de N días', () => {
    const series = [
        mkDay('2026-04-15', 1),
        mkDay('2026-04-16', 2),
        mkDay('2026-04-17', 3),
        mkDay('2026-04-18', 4),
        mkDay('2026-04-19', 5),
        mkDay('2026-04-20', 6),
        mkDay('2026-04-21', 7),
        mkDay('2026-04-22', 14), // solo este debería dominar si ventana=1
    ];
    // ventana 7 días → toma los últimos 7 = 2+3+4+5+6+7+14 = 41 / 7
    assert.equal(dailyAverage(series, 'cost_usd', 7), 41 / 7);
    // ventana 1 → último día
    assert.equal(dailyAverage(series, 'cost_usd', 1), 14);
});

test('dailyAverage con serie más corta que ventana divide por días disponibles', () => {
    const series = [mkDay('2026-04-21', 2), mkDay('2026-04-22', 4)];
    // No divide por 7 — divide por 2 (lo que hay)
    assert.equal(dailyAverage(series, 'cost_usd', 7), 3);
});

test('dailyAverage devuelve 0 con serie vacía', () => {
    assert.equal(dailyAverage([], 'cost_usd', 7), 0);
});

test('daysInMonth para abril 2026', () => {
    assert.equal(daysInMonth(new Date(2026, 3, 22)), 30); // mes 0-indexed → abril
});

test('daysInMonth para febrero 2024 (bisiesto)', () => {
    assert.equal(daysInMonth(new Date(2024, 1, 10)), 29);
});

test('daysRemainingThisMonth calcula lo que falta', () => {
    assert.equal(daysRemainingThisMonth(new Date(2026, 3, 22)), 8); // 30 - 22
    assert.equal(daysRemainingThisMonth(new Date(2026, 3, 30)), 0);
});

test('daysRemainingThisWeek 0 domingo, 6 lunes', () => {
    // 2026-04-19 = domingo (constructor local, no UTC)
    assert.equal(daysRemainingThisWeek(new Date(2026, 3, 19)), 0);
    // 2026-04-20 = lunes → 6 días hasta fin de semana
    assert.equal(daysRemainingThisWeek(new Date(2026, 3, 20)), 6);
});

test('monthToDate suma solo días del mes corriente', () => {
    const series = [
        mkDay('2026-03-30', 100),  // mes anterior
        mkDay('2026-04-01', 5),
        mkDay('2026-04-15', 10),
        mkDay('2026-04-22', 20),
    ];
    assert.equal(monthToDate(series, 'cost_usd', new Date('2026-04-22')), 35);
});

test('computeProjections devuelve tokens y tts', () => {
    const series = [
        mkDay('2026-04-20', 1.5, 0.1, 10, 1000, 70),
        mkDay('2026-04-21', 2.0, 0.2, 15, 2000, 140),
        mkDay('2026-04-22', 2.5, 0.15, 12, 1500, 100),
    ];
    const proj = computeProjections({ daily: series, now: new Date('2026-04-22T20:00:00Z') });
    assert.ok(proj.tokens);
    assert.ok(proj.tts);
    assert.equal(proj.tokens.dimension, 'tokens');
    assert.equal(proj.tts.dimension, 'tts');
    assert.ok(proj.tokens.daily_avg_usd > 0);
    assert.ok(proj.tts.daily_avg_usd > 0);
    // Proyección mensual = avg × daysInMonth
    const expectedTokensMonthly = ((1.5 + 2.0 + 2.5) / 3) * 30;
    // redondeo a 4 decimales
    assert.equal(proj.tokens.monthly_projection_usd, Math.round(expectedTokensMonthly * 10000) / 10000);
});

test('computeProjections detecta desvío cuando forecast > cuota', () => {
    const series = [
        mkDay('2026-04-22', 10), // $10/día → proyección mensual ~$300
    ];
    const proj = computeProjections({
        daily: series,
        now: new Date('2026-04-22T20:00:00Z'),
        quotas: { monthly_token_usd: 50, monthly_tts_usd: 5 },
    });
    assert.equal(proj.tokens.quota.status, 'over');
    assert.ok(proj.tokens.quota.alert);
    assert.ok(proj.tokens.quota.delta_usd > 0);
    assert.ok(proj.tokens.quota.ratio > 1);
});

test('computeProjections status ok cuando forecast < 90% cuota', () => {
    const series = [mkDay('2026-04-22', 1)]; // $1/día
    const proj = computeProjections({
        daily: series,
        now: new Date('2026-04-22T20:00:00Z'),
        quotas: { monthly_token_usd: 500, monthly_tts_usd: 100 },
    });
    assert.equal(proj.tokens.quota.status, 'ok');
    assert.equal(proj.tokens.quota.alert, null);
});

test('computeProjections status warning cuando forecast entre 90-100% cuota', () => {
    // 1 día con $1.5 → avg=1.5, forecast = mtd(1.5) + avg*daysLeft(8) = 1.5 + 12 = 13.5
    // cuota 14 → ratio = 0.964 → warning
    const series = [mkDay('2026-04-22', 1.5)];
    const proj = computeProjections({
        daily: series,
        now: new Date('2026-04-22T20:00:00Z'),
        quotas: { monthly_token_usd: 14, monthly_tts_usd: 100 },
    });
    assert.equal(proj.tokens.quota.status, 'warning');
    assert.equal(proj.tokens.quota.alert, null); // warning no dispara alert
});

test('computeProjections con serie vacía devuelve ceros', () => {
    const proj = computeProjections({ daily: [], now: new Date('2026-04-22T20:00:00Z') });
    assert.equal(proj.tokens.daily_avg_usd, 0);
    assert.equal(proj.tokens.monthly_projection_usd, 0);
    assert.equal(proj.tts.daily_avg_usd, 0);
});

test('computeProjections incluye campos secundarios (sessions, tts_chars)', () => {
    const series = [
        mkDay('2026-04-22', 5, 0.2, 10, 1400, 100),
    ];
    const proj = computeProjections({ daily: series, now: new Date('2026-04-22T20:00:00Z') });
    assert.equal(proj.tokens.sessions_daily_avg, 10);
    assert.equal(proj.tts.tts_chars_daily_avg, 1400);
    assert.equal(proj.tts.tts_audio_seconds_daily_avg, 100);
});

test('computeProjections forecast = mtd + avg × diasRestantes', () => {
    // Serie con 3 días del mes: 1, 2, 3 → mtd = 6, avg = 2
    // now = 2026-04-22 → daysLeft = 8
    // forecast esperado = 6 + 2*8 = 22
    const series = [
        mkDay('2026-04-20', 1),
        mkDay('2026-04-21', 2),
        mkDay('2026-04-22', 3),
    ];
    const proj = computeProjections({
        daily: series,
        now: new Date('2026-04-22T20:00:00Z'),
        quotas: { monthly_token_usd: 100, monthly_tts_usd: 100 },
    });
    assert.equal(proj.tokens.month_to_date_usd, 6);
    assert.equal(proj.tokens.monthly_forecast_usd, 22);
});

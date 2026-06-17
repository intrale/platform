// =============================================================================
// night-throughput.test.js — #4051 CA-5
// Verifica el cálculo de métricas nocturnas a partir de muestras sintéticas.
// node --test
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    computeNights, inWindow, nightKey, totalPending, hhmmToMinutes, partsInTz,
} = require('../night-throughput');

const TZ = 'America/Argentina/Buenos_Aires';

// Instante UTC para una hora local de Buenos Aires (UTC-3).
function baLocal(year, month, day, hh, mm) {
    return Date.UTC(year, month - 1, day, hh + 3, mm, 0);
}

function sample(ts, agents, level, pending) {
    return { ts, agents, level, byFase: { dev: { working: agents, pending } } };
}

const OPTS = {
    tz: TZ,
    startMin: hhmmToMinutes('22:00'),
    endMin: hhmmToMinutes('07:00'),
};

test('inWindow — cruce de medianoche', () => {
    const s = hhmmToMinutes('22:00'), e = hhmmToMinutes('07:00');
    assert.equal(inWindow(hhmmToMinutes('21:59'), s, e), false);
    assert.equal(inWindow(hhmmToMinutes('22:00'), s, e), true);
    assert.equal(inWindow(hhmmToMinutes('03:00'), s, e), true);
    assert.equal(inWindow(hhmmToMinutes('07:00'), s, e), false);
});

test('totalPending — suma el pending de todas las fases', () => {
    const s = { byFase: { dev: { pending: 5 }, build: { pending: 3 }, qa: { working: 2 } } };
    assert.equal(totalPending(s), 8);
    assert.equal(totalPending({}), 0);
    assert.equal(totalPending(null), 0);
});

test('computeNights — agrupa ambos lados del cruce de medianoche en una sola noche', () => {
    const samples = [
        sample(baLocal(2026, 6, 16, 23, 0), 2, 'orange', 50), // noche del 16
        sample(baLocal(2026, 6, 17, 3, 0), 1, 'orange', 45),  // madrugada → noche del 16
        sample(baLocal(2026, 6, 17, 6, 0), 0, 'orange', 40),  // madrugada → noche del 16
        sample(baLocal(2026, 6, 17, 12, 0), 3, 'green', 38),  // mediodía → FUERA
    ];
    const nights = computeNights(samples, OPTS);
    assert.equal(nights.length, 1);
    assert.equal(nights[0].night, '2026-06-16');
    assert.equal(nights[0].samples, 3);
    // promedio de agentes: (2+1+0)/3 = 1
    assert.equal(nights[0].avgAgents, 1);
    assert.equal(nights[0].peakAgents, 2);
});

test('computeNights — excluye muestras fuera de la franja nocturna', () => {
    const samples = [
        sample(baLocal(2026, 6, 16, 10, 0), 3, 'green', 50),
        sample(baLocal(2026, 6, 16, 15, 0), 2, 'yellow', 48),
    ];
    const nights = computeNights(samples, OPTS);
    assert.equal(nights.length, 0);
});

test('computeNights — proxy de throughput = drenaje neto de cola por hora', () => {
    const samples = [
        sample(baLocal(2026, 6, 16, 22, 0), 2, 'orange', 60),
        sample(baLocal(2026, 6, 17, 6, 0), 1, 'orange', 44), // 8h después, -16 cola
    ];
    const nights = computeNights(samples, OPTS);
    assert.equal(nights.length, 1);
    assert.equal(nights[0].hoursCovered, 8);
    assert.equal(nights[0].throughputPerHourEstimate, 2); // 16 / 8
});

test('computeNights — distribución de niveles en porcentaje', () => {
    const samples = [
        sample(baLocal(2026, 6, 16, 22, 0), 1, 'orange', 50),
        sample(baLocal(2026, 6, 16, 23, 0), 1, 'orange', 50),
        sample(baLocal(2026, 6, 17, 0, 0), 1, 'red', 50),
        sample(baLocal(2026, 6, 17, 1, 0), 1, 'yellow', 50),
    ];
    const nights = computeNights(samples, OPTS);
    assert.equal(nights[0].levelPct.orange, 50);
    assert.equal(nights[0].levelPct.red, 25);
    assert.equal(nights[0].levelPct.yellow, 25);
    assert.equal(nights[0].levelPct.green, 0);
});

test('partsInTz — extrae hora local y dateKey', () => {
    const p = partsInTz(baLocal(2026, 6, 16, 23, 30), TZ);
    assert.equal(p.hour, 23);
    assert.equal(p.minute, 30);
    assert.equal(p.dateKey, '2026-06-16');
});

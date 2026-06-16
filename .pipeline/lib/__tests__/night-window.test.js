// =============================================================================
// night-window.test.js — Tests del helper de ventana nocturna (#4051).
// node --test
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isNightWindow, __forTestsOnly__ } = require('../night-window');
const { hhmmToMinutes, nowHHMMInTz, timezoneIsSupported } = __forTestsOnly__;

const TZ = 'America/Argentina/Buenos_Aires';

// Buenos Aires es UTC-3 todo el año (sin DST). Construimos instantes UTC y
// confiamos en que Intl convierta a hora local correctamente.
// Para una hora local HH en BA, el instante UTC es HH+3 (mod 24) del mismo día.
function baLocal(year, month, day, hh, mm) {
    // hora UTC = hora local + 3
    const utcHour = hh + 3;
    return Date.UTC(year, month - 1, day, utcHour, mm, 0);
}

const CFG = {
    enabled: true,
    start: '22:00',
    end: '07:00',
    timezone: TZ,
};

test('isNightWindow — 21:59 está FUERA de la ventana (false)', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 21, 59), CFG), false);
});

test('isNightWindow — 22:00 está DENTRO (inicio inclusivo)', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 22, 0), CFG), true);
});

test('isNightWindow — 03:00 está DENTRO (madrugada, cruce de medianoche)', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 17, 3, 0), CFG), true);
});

test('isNightWindow — 06:59 está DENTRO (justo antes del fin)', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 17, 6, 59), CFG), true);
});

test('isNightWindow — 07:00 está FUERA (fin exclusivo)', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 17, 7, 0), CFG), false);
});

test('isNightWindow — mediodía (12:00) está FUERA', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 12, 0), CFG), false);
});

test('isNightWindow — medianoche (00:00) está DENTRO', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 17, 0, 0), CFG), true);
});

test('isNightWindow — enabled:false siempre devuelve false aunque sea de noche', () => {
    const cfg = Object.assign({}, CFG, { enabled: false });
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), cfg), false);
});

test('isNightWindow — enabled ausente (default) NO desactiva (true de noche)', () => {
    const cfg = { start: '22:00', end: '07:00', timezone: TZ };
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), cfg), true);
});

test('isNightWindow — timezone inválida → fail-open false', () => {
    const cfg = Object.assign({}, CFG, { timezone: 'Foo/Bar' });
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), cfg), false);
});

test('isNightWindow — cfg null/undefined → false', () => {
    assert.strictEqual(isNightWindow(Date.now(), null), false);
    assert.strictEqual(isNightWindow(Date.now(), undefined), false);
});

test('isNightWindow — start/end mal formados → false', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), { start: '25:00', end: '07:00', timezone: TZ }), false);
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), { start: '22:00', end: 'xx', timezone: TZ }), false);
});

test('isNightWindow — start === end (ventana degenerada) → false', () => {
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 22, 0), { start: '22:00', end: '22:00', timezone: TZ }), false);
});

test('isNightWindow — ventana intra-día (sin cruce de medianoche)', () => {
    const cfg = { enabled: true, start: '01:00', end: '05:00', timezone: TZ };
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 0, 59), cfg), false);
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 1, 0), cfg), true);
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 4, 59), cfg), true);
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 5, 0), cfg), false);
});

test('isNightWindow — timezone ausente usa default Buenos Aires', () => {
    const cfg = { enabled: true, start: '22:00', end: '07:00' };
    assert.strictEqual(isNightWindow(baLocal(2026, 6, 16, 23, 0), cfg), true);
});

// --- helpers internos ---

test('hhmmToMinutes — convierte y rechaza inválidos', () => {
    assert.strictEqual(hhmmToMinutes('00:00'), 0);
    assert.strictEqual(hhmmToMinutes('22:00'), 1320);
    assert.strictEqual(hhmmToMinutes('07:30'), 450);
    assert.ok(Number.isNaN(hhmmToMinutes('99:99')));
    assert.ok(Number.isNaN(hhmmToMinutes('nope')));
    assert.ok(Number.isNaN(hhmmToMinutes(null)));
});

test('timezoneIsSupported — válidas e inválidas', () => {
    assert.strictEqual(timezoneIsSupported(TZ), true);
    assert.strictEqual(timezoneIsSupported('UTC'), true);
    assert.strictEqual(timezoneIsSupported('Foo/Bar'), false);
    assert.strictEqual(timezoneIsSupported(''), false);
    assert.strictEqual(timezoneIsSupported(null), false);
});

test('nowHHMMInTz — formatea HH:MM en la tz dada', () => {
    const hhmm = nowHHMMInTz(baLocal(2026, 6, 16, 23, 14), TZ);
    assert.strictEqual(hhmm, '23:14');
    const hhmm2 = nowHHMMInTz(baLocal(2026, 6, 17, 6, 5), TZ);
    assert.strictEqual(hhmm2, '06:05');
});

// =============================================================================
// rest-mode-window-cap.test.js — Tests del cap CA-D2 (24h continuas/día) y de
// los helpers nuevos `totalContinuousMinutesPerDay` y `nextWindowTransition`
// agregados a rest-mode-window.js por #3739 (wizard de descanso).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rmw = require('../rest-mode-window');

// Lunes 2026-06-01 (verificado: 2026-01-01 = jueves; +151 días = lunes).
const MON_0800_UTC = Date.parse('2026-06-01T08:00:00Z');
const MON_1000_UTC = Date.parse('2026-06-01T10:00:00Z');

function weekdaySchedule(start, end) {
    return {
        monday: [{ start, end }],
        tuesday: [{ start, end }],
        wednesday: [{ start, end }],
        thursday: [{ start, end }],
        friday: [{ start, end }],
        saturday: [],
        sunday: [],
    };
}

test('validatePayload rechaza un día que excede el cap CA-D2 de 24h continuas', () => {
    const res = rmw.validatePayload({
        active: true,
        schedule: { monday: [{ start: '00:00', end: '23:59' }, { start: '12:00', end: '18:00' }] },
    });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /CA-D2/.test(e)), `esperaba un error CA-D2, obtuve: ${JSON.stringify(res.errors)}`);
});

test('validatePayload acepta una ventana nocturna cross-midnight dentro del cap', () => {
    const res = rmw.validatePayload({
        active: true,
        schedule: { monday: [{ start: '22:00', end: '06:00' }] },
    });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.deepEqual(res.normalized.schedule.monday, [{ start: '22:00', end: '06:00' }]);
});

test('setWindow NO persiste cuando el payload excede el cap (bypass server-side, R-5)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmw-cap-'));
    const statePath = path.join(dir, 'rest-mode.json');
    const res = rmw.setWindow(
        { active: true, schedule: { monday: [{ start: '00:00', end: '23:59' }, { start: '01:00', end: '20:00' }] } },
        { pipelineDir: dir },
    );
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /CA-D2/.test(e)));
    assert.equal(fs.existsSync(statePath), false, 'no debió escribir rest-mode.json');
});

test('totalContinuousMinutesPerDay suma cross-midnight al día de inicio', () => {
    const perDay = rmw.totalContinuousMinutesPerDay({ monday: [{ start: '22:00', end: '02:00' }] });
    assert.equal(perDay.monday, 240);
    assert.equal(perDay.tuesday, 0);
});

test('totalContinuousMinutesPerDay suma múltiples periodos del mismo día', () => {
    const perDay = rmw.totalContinuousMinutesPerDay({
        monday: [{ start: '00:00', end: '06:00' }, { start: '20:00', end: '23:00' }],
    });
    assert.equal(perDay.monday, 360 + 180);
});

test('nextWindowTransition devuelve enter cuando ahora está fuera y hay periodo hoy', () => {
    const window = { active: true, timezone: 'UTC', schedule: weekdaySchedule('09:00', '13:00') };
    const t = rmw.nextWindowTransition(window, MON_0800_UTC);
    assert.deepEqual(t, { kind: 'enter', when: 'today', atHHMM: '09:00', minutesFromNow: 60 });
});

test('nextWindowTransition devuelve exit cuando ahora está dentro de la ventana', () => {
    const window = { active: true, timezone: 'UTC', schedule: weekdaySchedule('09:00', '13:00') };
    const t = rmw.nextWindowTransition(window, MON_1000_UTC);
    assert.equal(t.kind, 'exit');
    assert.equal(t.atHHMM, '13:00');
    assert.equal(t.when, 'today');
    assert.equal(t.minutesFromNow, 180);
});

test('nextWindowTransition devuelve null si la ventana no está activa', () => {
    const window = { active: false, timezone: 'UTC', schedule: weekdaySchedule('09:00', '13:00') };
    assert.equal(rmw.nextWindowTransition(window, MON_1000_UTC), null);
});

test('la suite existente no se rompe: una ventana legal de un día sigue validando', () => {
    const res = rmw.validatePayload({ active: true, schedule: { monday: [{ start: '00:00', end: '23:59' }] } });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
});

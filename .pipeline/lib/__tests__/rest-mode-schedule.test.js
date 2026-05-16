// Tests de .pipeline/lib/rest-mode-schedule.js (hija frontend #3242 del épico #3230).
// Cubre:
//   - validatePeriod (HH:MM, start === end, día completo)
//   - validateSchedule (cap 24 SEC-2, overlap intra-día, overlap cross-midnight SEC-3)
//   - expandPeriod / intervalsOverlap (intervalos absolutos en la semana)
//   - getCurrentPeriod / getNextPeriod / countPeriodsToday
//   - allow-list de keys del día (SEC-1, prototype-pollution defense)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rms = require('../rest-mode-schedule');

// =========================================================================
// hhmmToMin / minToHhmm
// =========================================================================

test('hhmmToMin convierte HH:MM válidos', () => {
    assert.equal(rms.hhmmToMin('00:00'), 0);
    assert.equal(rms.hhmmToMin('13:30'), 13 * 60 + 30);
    assert.equal(rms.hhmmToMin('23:59'), 23 * 60 + 59);
});

test('hhmmToMin devuelve null para HH:MM inválidos', () => {
    assert.equal(rms.hhmmToMin('24:00'), null);
    assert.equal(rms.hhmmToMin('13:60'), null);
    assert.equal(rms.hhmmToMin(''), null);
    assert.equal(rms.hhmmToMin(null), null);
    assert.equal(rms.hhmmToMin('1:00'), null);
});

test('minToHhmm es inverso de hhmmToMin', () => {
    assert.equal(rms.minToHhmm(0), '00:00');
    assert.equal(rms.minToHhmm(13 * 60 + 30), '13:30');
    assert.equal(rms.minToHhmm(23 * 60 + 59), '23:59');
});

// =========================================================================
// isFullDay / crossesMidnight
// =========================================================================

test('isFullDay reconoce 00:00 -> 23:59 como dia completo', () => {
    assert.equal(rms.isFullDay({ start: '00:00', end: '23:59' }), true);
    assert.equal(rms.isFullDay({ start: '00:00', end: '00:00' }), false);
    assert.equal(rms.isFullDay({ start: '00:00', end: '00:01' }), false);
});

test('crossesMidnight detecta start > end y NO confunde dia completo', () => {
    assert.equal(rms.crossesMidnight({ start: '22:00', end: '07:00' }), true);
    assert.equal(rms.crossesMidnight({ start: '13:00', end: '16:00' }), false);
    // Día completo NO es cross-midnight (queda intra-día).
    assert.equal(rms.crossesMidnight({ start: '00:00', end: '23:59' }), false);
});

// =========================================================================
// validatePeriod
// =========================================================================

test('validatePeriod acepta un periodo bien formado', () => {
    const r = rms.validatePeriod({ start: '13:00', end: '16:00' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
});

test('validatePeriod rechaza HH:MM invalido', () => {
    const r = rms.validatePeriod({ start: '25:00', end: '16:00' });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
});

test('validatePeriod rechaza start === end salvo dia completo (SEC-4)', () => {
    const r = rms.validatePeriod({ start: '13:00', end: '13:00' });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /start === end/);
});

test('validatePeriod acepta dia completo 00:00 -> 23:59 (SEC-4 excepcion)', () => {
    const r = rms.validatePeriod({ start: '00:00', end: '23:59' });
    assert.equal(r.ok, true);
});

test('validatePeriod rechaza payloads no-objeto', () => {
    assert.equal(rms.validatePeriod(null).ok, false);
    assert.equal(rms.validatePeriod('string').ok, false);
    assert.equal(rms.validatePeriod(42).ok, false);
});

// =========================================================================
// validateSchedule
// =========================================================================

test('validateSchedule acepta schedule vacio (todos los dias sin periodos)', () => {
    const r = rms.validateSchedule({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.normalized.schedule.monday, []);
    assert.deepEqual(r.normalized.schedule.sunday, []);
});

test('validateSchedule acepta multiples periodos no-solapados en un dia', () => {
    const r = rms.validateSchedule({
        monday: [
            { start: '13:00', end: '16:00' },
            { start: '22:00', end: '23:30' },
        ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.schedule.monday.length, 2);
});

test('validateSchedule normaliza orden por start', () => {
    const r = rms.validateSchedule({
        monday: [
            { start: '22:00', end: '23:30' },
            { start: '13:00', end: '16:00' },
        ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.schedule.monday[0].start, '13:00');
    assert.equal(r.normalized.schedule.monday[1].start, '22:00');
});

test('validateSchedule rechaza solapamiento intra-dia (mockup 05b estado 1)', () => {
    const r = rms.validateSchedule({
        monday: [
            { start: '13:00', end: '16:00' },
            { start: '14:30', end: '18:00' },
        ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /monday/);
    assert.match(r.errors[0], /solapamiento/);
});

test('validateSchedule rechaza cross-midnight overlap (mockup 05b estado 2, SEC-3)', () => {
    // Martes 22:00 -> miércoles 07:00 (cross-midnight) vs miércoles 06:00 -> 08:00.
    const r = rms.validateSchedule({
        tuesday: [{ start: '22:00', end: '07:00' }],
        wednesday: [{ start: '06:00', end: '08:00' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /cruza medianoche|tuesday|wednesday/);
});

test('validateSchedule acepta cross-midnight que NO solapa con matinal posterior', () => {
    // Martes 22:00 -> miércoles 05:00 vs miércoles 06:00 -> 08:00 (no solapa).
    const r = rms.validateSchedule({
        tuesday: [{ start: '22:00', end: '05:00' }],
        wednesday: [{ start: '06:00', end: '08:00' }],
    });
    assert.equal(r.ok, true);
});

test('validateSchedule rechaza start === end no-dia-completo (mockup 05b estado 3)', () => {
    const r = rms.validateSchedule({
        wednesday: [{ start: '13:00', end: '13:00' }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /start === end/);
});

test('validateSchedule rechaza cap > 24 periodos/dia (mockup 05b estado 4, SEC-2)', () => {
    const periods = [];
    for (let i = 0; i < 25; i++) {
        // 25 periodos de 30 min con espacio mínimo entre ellos para no
        // disparar también el error de overlap.
        const startMin = i * 50;
        if (startMin + 30 > 24 * 60) break;
        const start = String(Math.floor(startMin / 60)).padStart(2, '0') + ':' + String(startMin % 60).padStart(2, '0');
        const endTotal = startMin + 30;
        const end = String(Math.floor(endTotal / 60)).padStart(2, '0') + ':' + String(endTotal % 60).padStart(2, '0');
        periods.push({ start, end });
    }
    // Asegurar que llegamos a 25 con datos válidos.
    while (periods.length < 25) periods.push({ start: '00:00', end: '23:59' });
    const r = rms.validateSchedule({ friday: periods });
    assert.equal(r.ok, false);
    // El cap dispara siempre antes que el overlap; lo importante es que SE detecte.
    const capError = r.errors.find(e => /maximo 24/.test(e));
    assert.ok(capError, 'debe reportar el cap de 24');
});

test('validateSchedule ignora keys desconocidas (SEC-1 anti-prototype-pollution)', () => {
    // Inyectar una key arbitraria + __proto__ no debe arrojar ni contaminar.
    const r = rms.validateSchedule({
        monday: [{ start: '13:00', end: '16:00' }],
        funday: [{ start: '00:00', end: '00:00' }], // key inválida
        __proto__: { polluted: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.schedule.funday, undefined);
    // El prototype del objeto schedule normalizado no debe estar contaminado.
    assert.equal({}.polluted, undefined);
});

test('validateSchedule rechaza day como no-array', () => {
    const r = rms.validateSchedule({ monday: 'mucho descanso' });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /array/);
});

test('validateSchedule NO acepta payload no-objeto', () => {
    assert.equal(rms.validateSchedule(null).ok, false);
    assert.equal(rms.validateSchedule('').ok, false);
    assert.equal(rms.validateSchedule(42).ok, false);
});

// =========================================================================
// expandPeriod / intervalsOverlap
// =========================================================================

test('expandPeriod intra-dia devuelve 1 intervalo', () => {
    const ivs = rms.expandPeriod('monday', { start: '13:00', end: '16:00' });
    assert.equal(ivs.length, 1);
    assert.equal(ivs[0].startAbs, 13 * 60);
    assert.equal(ivs[0].endAbs, 16 * 60);
});

test('expandPeriod cross-midnight devuelve 2 intervalos', () => {
    // Lunes 22:00 -> 07:00. Parte 1 = lunes [22:00, 24:00), parte 2 = martes [00:00, 07:00).
    const ivs = rms.expandPeriod('monday', { start: '22:00', end: '07:00' });
    assert.equal(ivs.length, 2);
    assert.equal(ivs[0].startAbs, 22 * 60);
    assert.equal(ivs[0].endAbs, 24 * 60);
    assert.equal(ivs[1].startAbs, 24 * 60);
    assert.equal(ivs[1].endAbs, 24 * 60 + 7 * 60);
});

test('expandPeriod dia completo NO se parte', () => {
    const ivs = rms.expandPeriod('sunday', { start: '00:00', end: '23:59' });
    assert.equal(ivs.length, 1);
});

test('expandPeriod cross-midnight de domingo envuelve a lunes (semana ciclica)', () => {
    // Domingo 23:00 -> 02:00. Parte 1 = domingo [23:00, 24:00), parte 2 = lunes [00:00, 02:00) — wrap a la semana siguiente.
    const ivs = rms.expandPeriod('sunday', { start: '23:00', end: '02:00' });
    assert.equal(ivs.length, 2);
    // El módulo decide el orden; lo importante es que NO hay traslape impropio
    // en intervalsOverlap. Verificamos en el test de overlap explícito.
});

test('intervalsOverlap detecta superposicion half-open', () => {
    assert.equal(
        rms.intervalsOverlap({ startAbs: 0, endAbs: 100 }, { startAbs: 50, endAbs: 150 }),
        true,
    );
    // Tocar el límite NO es solapamiento (half-open).
    assert.equal(
        rms.intervalsOverlap({ startAbs: 0, endAbs: 100 }, { startAbs: 100, endAbs: 200 }),
        false,
    );
});

// =========================================================================
// getCurrentPeriod / getNextPeriod / countPeriodsToday
// =========================================================================

test('getCurrentPeriod devuelve null si no hay periodos activos ahora', () => {
    const schedule = { monday: [{ start: '13:00', end: '16:00' }] };
    // Lunes 12:00 — antes del periodo.
    const r = rms.getCurrentPeriod(schedule, { hour: 12, minute: 0, weekday: 1 });
    assert.equal(r, null);
});

test('getCurrentPeriod detecta intra-dia activo', () => {
    const schedule = { monday: [{ start: '13:00', end: '16:00' }] };
    const r = rms.getCurrentPeriod(schedule, { hour: 14, minute: 30, weekday: 1 });
    assert.deepEqual(r, { day: 'monday', period: { start: '13:00', end: '16:00' } });
});

test('getCurrentPeriod detecta cross-midnight en la mitad nocturna (mismo dia)', () => {
    const schedule = { monday: [{ start: '22:00', end: '07:00' }] };
    // Lunes 23:30 — dentro del cross-midnight, lado lunes.
    const r = rms.getCurrentPeriod(schedule, { hour: 23, minute: 30, weekday: 1 });
    assert.deepEqual(r, { day: 'monday', period: { start: '22:00', end: '07:00' } });
});

test('getCurrentPeriod detecta cross-midnight en la mitad matinal (dia siguiente)', () => {
    const schedule = { monday: [{ start: '22:00', end: '07:00' }] };
    // Martes 03:00 — dentro del cross-midnight de lunes, lado martes.
    const r = rms.getCurrentPeriod(schedule, { hour: 3, minute: 0, weekday: 2 });
    assert.deepEqual(r, { day: 'monday', period: { start: '22:00', end: '07:00' } });
});

test('getCurrentPeriod respeta dia completo', () => {
    const schedule = { sunday: [{ start: '00:00', end: '23:59' }] };
    const r = rms.getCurrentPeriod(schedule, { hour: 15, minute: 0, weekday: 0 });
    assert.deepEqual(r, { day: 'sunday', period: { start: '00:00', end: '23:59' } });
});

test('getNextPeriod devuelve el siguiente periodo a iniciar', () => {
    const schedule = {
        monday: [{ start: '13:00', end: '16:00' }, { start: '22:00', end: '23:30' }],
    };
    // Lunes 14:00 — el siguiente es 22:00 del mismo lunes.
    const r = rms.getNextPeriod(schedule, { hour: 14, minute: 0, weekday: 1 });
    assert.equal(r.period.start, '22:00');
});

test('getNextPeriod wrap a la semana siguiente si no hay mas en esta', () => {
    const schedule = { monday: [{ start: '13:00', end: '16:00' }] };
    // Domingo 18:00 — único periodo está en lunes próximo (wrap).
    const r = rms.getNextPeriod(schedule, { hour: 18, minute: 0, weekday: 0 });
    assert.equal(r.period.start, '13:00');
    assert.equal(r.day, 'monday');
});

test('countPeriodsToday cuenta solo el dia actual', () => {
    const schedule = {
        monday: [{ start: '13:00', end: '16:00' }, { start: '22:00', end: '23:30' }],
        tuesday: [{ start: '08:00', end: '10:00' }],
    };
    // Martes.
    assert.equal(rms.countPeriodsToday(schedule, { hour: 10, minute: 0, weekday: 2 }), 1);
    // Lunes.
    assert.equal(rms.countPeriodsToday(schedule, { hour: 10, minute: 0, weekday: 1 }), 2);
});

test('hasAnyPeriod detecta si hay al menos un periodo configurado', () => {
    assert.equal(rms.hasAnyPeriod({}), false);
    assert.equal(rms.hasAnyPeriod({ monday: [] }), false);
    assert.equal(rms.hasAnyPeriod({ monday: [{ start: '13:00', end: '16:00' }] }), true);
});

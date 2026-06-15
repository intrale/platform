// =============================================================================
// Tests de lib/bloqueados-stats.js — agregados del header de Bloqueados (#3957,
// EP8-H4 / CA-4).
//
// Cubre:
//   - computeBloqueadosStats con fixture de activity-log: SLA promedio y
//     resueltos-hoy correctos.
//   - Sólo devuelve agregados numéricos/strings cortos (jamás líneas crudas).
//   - Respeta la ventana temporal (eventos viejos no cuentan para SLA).
//   - Log ausente / vacío → no crashea, devuelve neutros.
//   - fmtDuration formatea legible.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/bloqueados-stats.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBloqueadosStats, fmtDuration } = require('../../../lib/bloqueados-stats.js');

// "Ahora" fijo determinista: 2026-06-15T18:00:00Z.
const NOW = Date.parse('2026-06-15T18:00:00Z');

// fs falso en memoria: sirve un buffer fijo como si fuera el log.
function fakeFs(content) {
    const buf = Buffer.from(content, 'utf8');
    return {
        existsSync: () => true,
        statSync: () => ({ size: buf.length }),
        openSync: () => 1,
        closeSync: () => {},
        readSync: (fd, target, offset, length, position) => {
            buf.copy(target, offset, position, position + length);
            return length;
        },
    };
}

function line(obj) { return JSON.stringify(obj); }

test('fmtDuration formatea duraciones legibles', () => {
    assert.equal(fmtDuration(0), '<1m');
    assert.equal(fmtDuration(37 * 60000), '37m');
    assert.equal(fmtDuration((4 * 60 + 12) * 60000), '4h 12m');
    assert.equal(fmtDuration(2 * 60 * 60000), '2h');
    assert.equal(fmtDuration((26 * 60) * 60000), '1d 2h');
    assert.equal(fmtDuration(-5), null);
    assert.equal(fmtDuration(NaN), null);
});

test('computeBloqueadosStats computa SLA promedio y resueltos hoy', () => {
    const hoy = '2026-06-15T';
    const log = [
        // Issue 100: bloqueado 10:00, desbloqueado 14:00 → 4h.
        line({ event: 'human:blocked', issue: 100, ts: hoy + '10:00:00Z' }),
        line({ event: 'human:unblocked', issue: 100, ts: hoy + '14:00:00Z' }),
        // Issue 200: bloqueado 09:00, desbloqueado 15:00 → 6h.
        line({ event: 'human:blocked', issue: 200, ts: hoy + '09:00:00Z' }),
        line({ event: 'human:unblocked', issue: 200, ts: hoy + '15:00:00Z' }),
        // Issue 300: desestimado hoy (cuenta para resueltos, no para SLA).
        line({ event: 'human:blocked', issue: 300, ts: hoy + '11:00:00Z' }),
        line({ event: 'human:dismissed', issue: 300, ts: hoy + '16:00:00Z' }),
    ].join('\n') + '\n';

    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/fake/log', fsImpl: fakeFs(log) });
    // SLA promedio = (4h + 6h) / 2 = 5h.
    assert.equal(stats.avgSla, '5h');
    // Resueltos hoy = 2 unblocked + 1 dismissed = 3.
    assert.equal(stats.resolvedToday, 3);
    // Sólo agregados: claves esperadas, valores number/string.
    assert.deepEqual(Object.keys(stats).sort(), ['avgSla', 'resolvedToday']);
    assert.equal(typeof stats.resolvedToday, 'number');
});

test('computeBloqueadosStats: eventos fuera de la ventana temporal no cuentan', () => {
    const viejo = '2026-05-01T'; // > 7 días antes de NOW
    const log = [
        line({ event: 'human:blocked', issue: 1, ts: viejo + '10:00:00Z' }),
        line({ event: 'human:unblocked', issue: 1, ts: viejo + '14:00:00Z' }),
    ].join('\n') + '\n';
    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/fake/log', fsImpl: fakeFs(log) });
    assert.equal(stats.avgSla, null);
    assert.equal(stats.resolvedToday, 0);
});

test('computeBloqueadosStats: resueltos hoy sólo cuenta el día actual', () => {
    const log = [
        // Resuelto ayer → no cuenta para "hoy".
        line({ event: 'human:blocked', issue: 1, ts: '2026-06-14T10:00:00Z' }),
        line({ event: 'human:unblocked', issue: 1, ts: '2026-06-14T12:00:00Z' }),
        // Resuelto hoy → cuenta.
        line({ event: 'human:blocked', issue: 2, ts: '2026-06-15T10:00:00Z' }),
        line({ event: 'human:unblocked', issue: 2, ts: '2026-06-15T12:00:00Z' }),
    ].join('\n') + '\n';
    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/fake/log', fsImpl: fakeFs(log) });
    assert.equal(stats.resolvedToday, 1);
});

test('computeBloqueadosStats: unblocked sin blocked previo no rompe ni inventa SLA', () => {
    const log = line({ event: 'human:unblocked', issue: 9, ts: '2026-06-15T12:00:00Z' }) + '\n';
    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/fake/log', fsImpl: fakeFs(log) });
    assert.equal(stats.avgSla, null);
    assert.equal(stats.resolvedToday, 1);
});

test('computeBloqueadosStats: log ausente devuelve neutros sin crashear', () => {
    const missingFs = { existsSync: () => false };
    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/no/existe', fsImpl: missingFs });
    assert.deepEqual(stats, { avgSla: null, resolvedToday: 0 });
});

test('computeBloqueadosStats: líneas corruptas se ignoran, no rompen el cómputo', () => {
    const log = [
        '{ json roto',
        line({ event: 'human:blocked', issue: 1, ts: '2026-06-15T10:00:00Z' }),
        line({ event: 'human:unblocked', issue: 1, ts: '2026-06-15T13:00:00Z' }),
        'otra linea basura',
    ].join('\n') + '\n';
    const stats = computeBloqueadosStats({ nowMs: NOW, logFile: '/fake/log', fsImpl: fakeFs(log) });
    assert.equal(stats.avgSla, '3h');
    assert.equal(stats.resolvedToday, 1);
});

// =============================================================================
// pulpo-nonanthropic-early-detect.test.js — Detección in-stream temprana de la
// rama non-Anthropic de runNonAnthropic (#3571).
//
// La lógica inline de `runNonAnthropic` (pulpo.js) no es unit-testeable de forma
// aislada (pulpo.js no exporta `ejecutarClaude`), así que el ciclo de vida de los
// timers de detección temprana + el guard `settled` vive en el helper puro
// `lib/commander/nonanthropic-stall-detect.js`, que pulpo cablea inline. Estos
// tests ejercen ese helper con timers y reloj fakeados.
//
// Cubre los CA del PO (#3571):
//   CA-1 — cascada temprana por ausencia de first-byte (15s) → onFirstByte + kill.
//   CA-2 — cascada temprana por stream-gap (30s) tras un chunk parcial → onStreamGap.
//   CA-3 — idempotencia: close tras el kill temprano NO re-cascadea (markSettled).
//   CA-4 — thresholds reusados de inflightShadow (15s/30s), sin constantes nuevas.
//   CA-6 — cleanup completo de timers en todos los caminos de salida (SEC-4).
//   Negativos — first-byte no dispara si ya hubo chunk; stream-gap no dispara sin chunk.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stall = require('../lib/commander/nonanthropic-stall-detect');
const inflightShadow = require('../lib/commander/inflight-shadow-detectors');

// -----------------------------------------------------------------------------
// Harness de fake-timers: captura callbacks de setTimeout/setInterval y permite
// dispararlos manualmente + registra clears para verificar cleanup (SEC-4).
// -----------------------------------------------------------------------------
function makeFakeTimers() {
    let seq = 0;
    const timeouts = new Map();
    const intervals = new Map();
    const clears = { timeouts: [], intervals: [] };
    return {
        timeouts,
        intervals,
        clears,
        api: {
            setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { fn, ms, cleared: false }); return id; },
            setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms, cleared: false }); return id; },
            clearTimeout: (id) => { clears.timeouts.push(id); const t = timeouts.get(id); if (t) t.cleared = true; },
            clearInterval: (id) => { clears.intervals.push(id); const t = intervals.get(id); if (t) t.cleared = true; },
        },
        fireTimeout: (id) => { const t = timeouts.get(id); if (t && !t.cleared) t.fn(); },
        tickInterval: (id) => { const t = intervals.get(id); if (t && !t.cleared) t.fn(); },
    };
}

// El primer setTimeout registrado es el firstByteTimer; el primer setInterval es
// el streamGapTimer (orden de creación en el helper).
function firstTimeoutId(ft) { return [...ft.timeouts.keys()][0]; }
function firstIntervalId(ft) { return [...ft.intervals.keys()][0]; }

// -----------------------------------------------------------------------------
// CA-1 — first-byte: sin ningún chunk en 15s → cascada temprana.
// -----------------------------------------------------------------------------
test('runNonAnthropic cascadea al siguiente provider si no hay first-byte en 15s', () => {
    const ft = makeFakeTimers();
    const calls = [];
    const startTime = 1_000_000;
    stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => 0, // nunca llegó un chunk
        now: () => startTime + inflightShadow.FIRST_BYTE_THRESHOLD_MS, // 15s exactos
        killProc: () => calls.push(['kill']),
        onFirstByte: () => calls.push(['firstByte']),
        onStreamGap: () => calls.push(['streamGap']),
        timers: ft.api,
    });

    ft.fireTimeout(firstTimeoutId(ft));

    assert.deepEqual(calls, [['kill'], ['firstByte']]);
    // no debe haber disparado stream-gap
    assert.ok(!calls.some(c => c[0] === 'streamGap'));
});

// -----------------------------------------------------------------------------
// CA-2 — stream-gap: un chunk parcial y luego silencio >30s → cascada temprana.
// -----------------------------------------------------------------------------
test('runNonAnthropic cascadea si el stream stallea >30s tras un chunk parcial', () => {
    const ft = makeFakeTimers();
    const calls = [];
    const startTime = 2_000_000;
    const chunkAt = startTime + 1_000; // llegó un chunk al segundo
    stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => chunkAt,
        now: () => chunkAt + inflightShadow.STREAM_GAP_THRESHOLD_MS, // 30s tras el chunk
        killProc: () => calls.push(['kill']),
        onFirstByte: () => calls.push(['firstByte']),
        onStreamGap: () => calls.push(['streamGap']),
        timers: ft.api,
    });

    // el tick del interval evalúa el detector de stream-gap
    ft.tickInterval(firstIntervalId(ft));

    assert.deepEqual(calls, [['kill'], ['streamGap']]);
    // first-byte NO debe disparar: ya hubo chunk (lastChunkAt > 0)
    assert.ok(!calls.some(c => c[0] === 'firstByte'));
});

// -----------------------------------------------------------------------------
// CA-3 — idempotencia: close tras el kill temprano NO re-cascadea.
// -----------------------------------------------------------------------------
test('runNonAnthropic no cascadea dos veces cuando close llega tras el kill temprano', () => {
    const ft = makeFakeTimers();
    const calls = [];
    const startTime = 3_000_000;
    const det = stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => 0,
        now: () => startTime + inflightShadow.FIRST_BYTE_THRESHOLD_MS,
        killProc: () => calls.push(['kill']),
        onFirstByte: () => calls.push(['firstByte']),
        onStreamGap: () => calls.push(['streamGap']),
        timers: ft.api,
    });

    // el detector temprano dispara la cascada
    ft.fireTimeout(firstTimeoutId(ft));
    assert.equal(calls.filter(c => c[0] === 'firstByte').length, 1);

    // el proc muere por el SIGTERM → llega `close`. El caller consulta markSettled():
    const wasSettled = det.markSettled();
    assert.equal(wasSettled, true, 'markSettled debe indicar que el intento YA estaba resuelto');

    // el caller cortó (return) → onFirstByte no se invocó de nuevo
    assert.equal(calls.filter(c => c[0] === 'firstByte').length, 1);
});

// -----------------------------------------------------------------------------
// CA-4 — thresholds reusados de inflightShadow (sin constantes nuevas).
// -----------------------------------------------------------------------------
test('los thresholds provienen de inflightShadow (15s/30s), no se inventan valores', () => {
    assert.equal(inflightShadow.FIRST_BYTE_THRESHOLD_MS, 15 * 1000);
    assert.equal(inflightShadow.STREAM_GAP_THRESHOLD_MS, 30 * 1000);

    const ft = makeFakeTimers();
    stall.createStallDetectors({
        startTime: 0,
        getLastChunkAt: () => 0,
        killProc: () => {},
        onFirstByte: () => {},
        onStreamGap: () => {},
        timers: ft.api,
    });
    // el firstByteTimer se arma al threshold de inflightShadow
    assert.equal(ft.timeouts.get(firstTimeoutId(ft)).ms, inflightShadow.FIRST_BYTE_THRESHOLD_MS);
    // el stream-gap corre por interval a 5000ms (NO busy-wait; espeja la rama Anthropic)
    assert.equal(ft.intervals.get(firstIntervalId(ft)).ms, 5000);
});

// -----------------------------------------------------------------------------
// CA-6 (SEC-4) — cleanup completo de timers en todos los caminos de salida.
// -----------------------------------------------------------------------------
test('los timers de deteccion temprana se limpian por first-byte', () => {
    const ft = makeFakeTimers();
    const startTime = 4_000_000;
    stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => 0,
        now: () => startTime + inflightShadow.FIRST_BYTE_THRESHOLD_MS,
        killProc: () => {},
        onFirstByte: () => {},
        onStreamGap: () => {},
        timers: ft.api,
    });
    ft.fireTimeout(firstTimeoutId(ft));
    assert.equal(ft.clears.timeouts.length, 1, 'firstByteTimer limpiado');
    assert.equal(ft.clears.intervals.length, 1, 'streamGapTimer limpiado');
});

test('los timers de deteccion temprana se limpian por stream-gap', () => {
    const ft = makeFakeTimers();
    const startTime = 5_000_000;
    const chunkAt = startTime + 1_000;
    stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => chunkAt,
        now: () => chunkAt + inflightShadow.STREAM_GAP_THRESHOLD_MS,
        killProc: () => {},
        onFirstByte: () => {},
        onStreamGap: () => {},
        timers: ft.api,
    });
    ft.tickInterval(firstIntervalId(ft));
    assert.equal(ft.clears.timeouts.length, 1);
    assert.equal(ft.clears.intervals.length, 1);
});

test('los timers de deteccion temprana se limpian por close/error (markSettled)', () => {
    const ft = makeFakeTimers();
    const det = stall.createStallDetectors({
        startTime: 6_000_000,
        getLastChunkAt: () => 0,
        killProc: () => {},
        onFirstByte: () => {},
        onStreamGap: () => {},
        timers: ft.api,
    });
    // close/error del caller → markSettled() limpia ambos timers
    const was = det.markSettled();
    assert.equal(was, false, 'primer markSettled reporta que NO estaba resuelto');
    assert.equal(ft.clears.timeouts.length, 1);
    assert.equal(ft.clears.intervals.length, 1);
    assert.equal(det.isSettled(), true);
});

// -----------------------------------------------------------------------------
// Negativo — tras markSettled los detectores ya no cascadean (guard settled).
// -----------------------------------------------------------------------------
test('un detector que dispara tras markSettled NO cascadea (guard settled)', () => {
    const ft = makeFakeTimers();
    const calls = [];
    const startTime = 7_000_000;
    const det = stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => 0,
        now: () => startTime + inflightShadow.FIRST_BYTE_THRESHOLD_MS,
        killProc: () => calls.push(['kill']),
        onFirstByte: () => calls.push(['firstByte']),
        onStreamGap: () => calls.push(['streamGap']),
        timers: ft.api,
    });

    // el intento se resolvió por otro camino (p. ej. close-ok) antes del timer
    det.markSettled();
    // el timer intenta disparar después: el guard `settled` lo corta
    ft.fireTimeout(firstTimeoutId(ft));
    assert.equal(calls.length, 0, 'ningún callback tras settled');
});

// -----------------------------------------------------------------------------
// Negativo — first-byte no dispara si YA hubo un chunk (lastChunkAt > 0).
// -----------------------------------------------------------------------------
test('first-byte no dispara si ya llegó un chunk antes del threshold', () => {
    const ft = makeFakeTimers();
    const calls = [];
    const startTime = 8_000_000;
    stall.createStallDetectors({
        startTime,
        getLastChunkAt: () => startTime + 2_000, // ya hubo chunk
        now: () => startTime + inflightShadow.FIRST_BYTE_THRESHOLD_MS,
        killProc: () => calls.push(['kill']),
        onFirstByte: () => calls.push(['firstByte']),
        onStreamGap: () => calls.push(['streamGap']),
        timers: ft.api,
    });
    ft.fireTimeout(firstTimeoutId(ft));
    assert.ok(!calls.some(c => c[0] === 'firstByte'), 'no cascadea por first-byte si hubo chunk');
});

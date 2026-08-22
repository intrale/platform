'use strict';

// Tests del monitor de lag del event loop (#4131-followup).
// Cubren: conversión ns→ms, disparo del callback solo por encima del umbral,
// uso de timers/now inyectados (sin tiempo real), y que un callback que explota
// no tumbe al monitor. Aislados: no tocan el dashboard ni el FS.

const test = require('node:test');
const assert = require('node:assert');

const { startEventLoopMonitor, nsToMs, DEFAULT_THRESHOLD_MS } = require('./event-loop-monitor');

// Fake de setInterval: captura el callback y permite dispararlo a mano (tick),
// sin esperar tiempo real. Devuelve un objeto con `.unref()` no-op.
function fakeTimers() {
  let cb = null;
  const setIntervalFn = (fn) => { cb = fn; return { unref() {} }; };
  const clearIntervalFn = () => { cb = null; };
  return { setIntervalFn, clearIntervalFn, tick: () => { if (cb) cb(); } };
}

test('nsToMs convierte nanosegundos a ms con un decimal y tolera valores inválidos', () => {
  assert.strictEqual(nsToMs(1e6), 1);        // 1e6 ns = 1 ms
  assert.strictEqual(nsToMs(5e6), 5);        // 5e6 ns = 5 ms
  assert.strictEqual(nsToMs(15e5), 1.5);     // 1.5e6 ns = 1.5 ms (un decimal)
  assert.strictEqual(nsToMs(0), 0);
  assert.strictEqual(nsToMs(Infinity), 0);   // histograma sin muestras
  assert.strictEqual(nsToMs(NaN), 0);
  assert.strictEqual(nsToMs(-1), 0);
});

test('expone DEFAULT_THRESHOLD_MS y arranca/para sin tirar', () => {
  assert.strictEqual(typeof DEFAULT_THRESHOLD_MS, 'number');
  const t = fakeTimers();
  const mon = startEventLoopMonitor({ setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  assert.strictEqual(typeof mon.stop, 'function');
  assert.strictEqual(typeof mon.sample, 'function');
  mon.stop();
  mon.stop(); // idempotente
});

test('sample() devuelve métricas numéricas no negativas', () => {
  const t = fakeTimers();
  const mon = startEventLoopMonitor({ setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  const s = mon.sample();
  assert.ok(Number.isFinite(s.lagMs) && s.lagMs >= 0);
  assert.ok(Number.isFinite(s.meanMs) && s.meanMs >= 0);
  assert.ok(Number.isFinite(s.p99Ms) && s.p99Ms >= 0);
  mon.stop();
});

test('dispara onStall cuando el loop estuvo realmente clavado por encima del umbral', async () => {
  const t = fakeTimers();
  const stalls = [];
  const mon = startEventLoopMonitor({
    thresholdMs: 200,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
    now: () => 1700000000000,
    onStall: (info) => stalls.push(info),
  });

  // El histograma de perf_hooks solo mide bloqueos que ocurren mientras su timer
  // interno ya está armado: cedemos una vez tras enable() antes de bloquear.
  await new Promise((r) => setTimeout(r, 60));

  // Bloqueo sintético del loop: ocupar el thread > umbral para que el histograma
  // registre lag real (no inyectamos el histograma; medimos de verdad).
  const start = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - start) / 1e6 < 350) { /* spin ~350ms */ }

  // El histograma registra el retraso de su propio timer recién en el próximo
  // turno del loop: cedemos antes de evaluar la ventana.
  await new Promise((r) => setTimeout(r, 60));
  t.tick();

  assert.strictEqual(stalls.length, 1, 'debió reportar exactamente un stall');
  assert.ok(stalls[0].lagMs >= 200, `lag reportado ${stalls[0].lagMs}ms debe superar el umbral`);
  assert.strictEqual(stalls[0].at, 1700000000000, 'usa el now() inyectado');
  assert.strictEqual(stalls[0].sampleMs > 0, true);
  mon.stop();
});

test('NO dispara onStall cuando el loop estuvo sano (sin bloqueo) entre ticks', () => {
  const t = fakeTimers();
  const stalls = [];
  const mon = startEventLoopMonitor({
    thresholdMs: 1000,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
    onStall: (info) => stalls.push(info),
  });
  // Sin bloqueo: el tick inmediato no debería superar 1s de lag.
  t.tick();
  assert.strictEqual(stalls.length, 0, 'loop sano no debe reportar stall');
  mon.stop();
});

test('un onStall que explota no tumba el monitor', () => {
  const t = fakeTimers();
  const mon = startEventLoopMonitor({
    thresholdMs: 0, // cualquier lag >= 0 dispara
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
    onStall: () => { throw new Error('boom en el callback'); },
  });
  assert.doesNotThrow(() => t.tick(), 'el throw del callback debe quedar contenido');
  mon.stop();
});

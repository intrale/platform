'use strict';

// Watchdog EXTERNO de freeze del event loop del dashboard (#4131-followup-2).
//
// POR QUÉ existe (la lección cara de #4127→#4133):
// El monitor previo (`event-loop-monitor.js`) usa `monitorEventLoopDelay` + un
// `setInterval` que LEE el histograma. Ese timer vive DENTRO del mismo event
// loop que vigila: sirve para un lag intermitente (el loop se traba, se suelta,
// y al soltarse el timer dispara tarde y reporta el pico). Pero ante un FREEZE
// TOTAL —el loop se clava en código sync y no se suelta— el timer NUNCA corre y
// el monitor queda mudo. Medimos al enfermo con un termómetro adentro del
// enfermo congelado. Por eso el último /restart no dejó una sola línea de STALL.
//
// QUÉ hace distinto: pone el testigo AFUERA del event loop, en un Worker thread
// con su propio loop. La comunicación es un `SharedArrayBuffer` (memoria
// compartida, lectura sin pasar por el loop del main):
//   - El main "late": incrementa un contador cada `bumpMs` y escribe en la SAB
//     un bitmask de qué operación pesada tiene EN VUELO en ese instante.
//   - El Worker, desde su loop independiente, mira el contador cada `checkMs`.
//     Si el contador deja de avanzar por más de `thresholdMs`, el main está
//     CONGELADO: el Worker lo registra al instante (con timestamps duros y la
//     operación inflight leída de la SAB), aunque el main jamás vuelva.
//
// Es puramente observacional: el main solo incrementa un entero y escribe un
// bitmask en cada latido (costo despreciable, no toca el hot path de requests).
// El Worker hace su propio fs.appendFileSync a un log dedicado, sin depender en
// nada del main congelado.

const path = require('path');

// Layout de la SharedArrayBuffer (Int32Array):
//   [0] HEARTBEAT  — contador que el main incrementa en cada latido.
//   [1] INFLIGHT   — bitmask de operaciones pesadas en vuelo (ver INFLIGHT_BITS).
const IDX_HEARTBEAT = 0;
const IDX_INFLIGHT = 1;
const SAB_INTS = 2;

// Bits de operaciones pesadas rastreadas. Mantener en sync con el decode del
// worker (`freeze-watchdog-worker.js`). Si el freeze ocurre con bitmask 0
// ("ninguno-inflight"), el culpable es una operación sync NO rastreada y hay
// que sumarla acá.
const INFLIGHT_BITS = {
  stateSnapshot: 1,
  procStatus: 2,
  prInfo: 4,
  olaETA: 8,
  titleRefresh: 16,
};

const DEFAULT_BUMP_MS = 200;        // cada cuánto late el main
const DEFAULT_THRESHOLD_MS = 3000;  // sin latido por más de esto => freeze

// Arranca el watchdog. Devuelve un handle con `.stop()`.
//
// opts:
//   - logDir:        dir donde el worker escribe `freeze-watchdog.log` (oblig.)
//   - thresholdMs:   ventana sin latido que cuenta como freeze (default 3000)
//   - bumpMs:        período del latido del main (default 200)
//   - getInflight(): callback que devuelve un objeto { stateSnapshot, procStatus,
//                    prInfo, olaETA, titleRefresh } con booleanos. Se invoca en
//                    cada latido para refrescar el bitmask compartido.
//   - onLog(msg):    callback opcional para espejar eventos al log del dashboard.
function startFreezeWatchdog(opts = {}) {
  const logDir = opts.logDir;
  if (!logDir) throw new Error('freeze-watchdog: logDir es obligatorio');
  const thresholdMs = Number(opts.thresholdMs) > 0 ? Number(opts.thresholdMs) : DEFAULT_THRESHOLD_MS;
  const bumpMs = Number(opts.bumpMs) > 0 ? Number(opts.bumpMs) : DEFAULT_BUMP_MS;
  const getInflight = typeof opts.getInflight === 'function' ? opts.getInflight : () => ({});
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const { Worker } = require('worker_threads');

  const sab = new SharedArrayBuffer(SAB_INTS * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(sab);

  // Calcula el bitmask inflight a partir del callback del dashboard.
  function inflightMask() {
    let mask = 0;
    let f;
    try { f = getInflight() || {}; } catch { f = {}; }
    for (const [name, bit] of Object.entries(INFLIGHT_BITS)) {
      if (f[name]) mask |= bit;
    }
    return mask;
  }

  // El latido del main: incrementa el contador y publica el inflight actual.
  // `unref()` para que el timer no mantenga vivo el proceso por sí solo.
  const bumpTimer = setInterval(() => {
    Atomics.store(view, IDX_INFLIGHT, inflightMask());
    Atomics.add(view, IDX_HEARTBEAT, 1);
  }, bumpMs);
  if (bumpTimer && typeof bumpTimer.unref === 'function') bumpTimer.unref();

  // Primer latido inmediato para que el worker tenga un baseline al instante.
  Atomics.store(view, IDX_INFLIGHT, inflightMask());
  Atomics.add(view, IDX_HEARTBEAT, 1);

  const worker = new Worker(path.join(__dirname, 'freeze-watchdog-worker.js'), {
    workerData: { sab, thresholdMs, bumpMs, logDir },
  });
  worker.unref(); // el watchdog no debe impedir que el proceso cierre
  worker.on('message', (m) => {
    if (m && m.type === 'freeze' && m.line) onLog(m.line);
  });
  worker.on('error', (e) => { try { onLog(`freeze-watchdog worker error: ${e && e.message ? e.message : e}`); } catch {} });

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { clearInterval(bumpTimer); } catch {}
    try { worker.terminate(); } catch {}
  }

  return { stop };
}

module.exports = { startFreezeWatchdog, INFLIGHT_BITS, IDX_HEARTBEAT, IDX_INFLIGHT, SAB_INTS };

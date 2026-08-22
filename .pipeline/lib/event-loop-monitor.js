'use strict';

// Monitor de lag del event loop para el dashboard (#4131-followup).
//
// CONTEXTO — por qué existe:
// Durante todo el ciclo de fixes #4127→#4133 perseguimos a ciegas un cuelgue
// INTERMITENTE del dashboard: el proceso queda vivo pero mudo (ni /api/health
// ni la raíz responden) quemando CPU, el smoke del /restart lo lee como caída y
// dispara rollback. Migramos a async una operación sync por vez (títulos #4128,
// proc-status #4126, PR-info #4132) pero el cuelgue volvía: queda ≥1 operación
// sync que clava el event loop por ventanas largas y NO sabíamos cuál.
//
// Este monitor deja de adivinar: mide el lag real del loop con el histograma
// nativo `perf_hooks.monitorEventLoopDelay` (precisión ns, costo despreciable,
// NO bloquea) y, cuando el loop estuvo clavado por encima de un umbral, dispara
// un callback con el lag pico para que el dashboard loguee QUÉ operación estaba
// inflight en ese momento. Así el próximo cuelgue deja evidencia dura en el log
// en vez de una nueva ronda de teorías.
//
// Es puramente observacional: no cambia el comportamiento del dashboard, solo
// lo instrumenta.

const { monitorEventLoopDelay } = require('perf_hooks');

const DEFAULT_SAMPLE_MS = 2000;     // cada cuánto evaluamos el pico de lag
const DEFAULT_THRESHOLD_MS = 1000;  // lag pico por encima del cual reportamos un stall
const RESOLUTION_MS = 20;           // resolución del histograma (muestreo del loop)

// ns → ms con un decimal, tolerante a valores inválidos del histograma
// (`Infinity`/`NaN` aparecen si nunca hubo una muestra en la ventana).
function nsToMs(ns) {
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns < 0) return 0;
  return Math.round(ns / 1e5) / 10;
}

// Arranca el monitor. Devuelve un handle con `.stop()` y `.sample()` (snapshot
// manual, útil para tests y diagnóstico bajo demanda). El timer interno está
// `unref()`-eado: nunca mantiene vivo el proceso por sí solo.
//
// opts:
//   - sampleMs:    período de evaluación (default 2000)
//   - thresholdMs: umbral de stall en ms (default 1000)
//   - onStall(info): callback al detectar un stall. info = { lagMs, meanMs,
//                    p99Ms, sampleMs, at }. Errores del callback se tragan para
//                    que la instrumentación nunca tumbe al proceso que observa.
//   - setIntervalFn / now: inyectables para tests (default globales).
function startEventLoopMonitor(opts = {}) {
  const sampleMs = Number(opts.sampleMs) > 0 ? Number(opts.sampleMs) : DEFAULT_SAMPLE_MS;
  const thresholdMs = Number(opts.thresholdMs) >= 0 ? Number(opts.thresholdMs) : DEFAULT_THRESHOLD_MS;
  const onStall = typeof opts.onStall === 'function' ? opts.onStall : () => {};
  const setIntervalFn = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : setInterval;
  const clearIntervalFn = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : clearInterval;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();

  // Lee el pico/medias de la ventana actual y resetea para la próxima. El lag
  // "real" del loop es `max` menos la resolución del muestreo (el histograma
  // siempre incluye el período base entre muestras).
  function readAndReset() {
    const maxMs = Math.max(0, nsToMs(histogram.max) - RESOLUTION_MS);
    const meanMs = Math.max(0, nsToMs(histogram.mean) - RESOLUTION_MS);
    const p99Ms = Math.max(0, nsToMs(histogram.percentile(99)) - RESOLUTION_MS);
    histogram.reset();
    return { maxMs, meanMs, p99Ms };
  }

  // Snapshot manual sin resetear (para /api/health diagnostics o tests).
  function sample() {
    return {
      lagMs: Math.max(0, nsToMs(histogram.max) - RESOLUTION_MS),
      meanMs: Math.max(0, nsToMs(histogram.mean) - RESOLUTION_MS),
      p99Ms: Math.max(0, nsToMs(histogram.percentile(99)) - RESOLUTION_MS),
    };
  }

  const timer = setIntervalFn(() => {
    let r;
    try { r = readAndReset(); } catch { return; }
    if (r.maxMs >= thresholdMs) {
      try {
        onStall({
          lagMs: r.maxMs,
          meanMs: r.meanMs,
          p99Ms: r.p99Ms,
          sampleMs,
          at: now(),
        });
      } catch { /* la instrumentación nunca tumba al observado */ }
    }
  }, sampleMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { clearIntervalFn(timer); } catch {}
    try { histogram.disable(); } catch {}
  }

  return { stop, sample };
}

module.exports = { startEventLoopMonitor, nsToMs, DEFAULT_SAMPLE_MS, DEFAULT_THRESHOLD_MS };

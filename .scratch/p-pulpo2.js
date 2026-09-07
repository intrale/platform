'use strict';
const { patch } = require('./patch');
const B = '`';

patch('.pipeline/pulpo.js', [
  // ── 8 · gate + runner del barrido, a nivel de módulo ──────────────────────
  [
`let desyncEvalTick = 0;
const DESYNC_EVAL_EVERY_TICKS = 10;`,
`let desyncEvalTick = 0;
const DESYNC_EVAL_EVERY_TICKS = 10;

// #6459 CA-12 — Gateo del barrido de huérfanos. El punto de wiring del loop
// corre en CADA iteración (~30s) y el barrido se declaró a ~5 min: sin gateo
// correría ~10x más seguido de lo previsto y releería el historial entero cada
// vez. Mismo patrón y misma cadencia que ${B}desyncEvalTick${B}.
let orphanSweepTick = 0;
const ORPHAN_SWEEP_EVERY_TICKS = 10;   // ~5 min con poll_interval 30s

// Contador PURO del gateo, extraído a función para que el test pueda probar que
// M iteraciones del loop disparan exactamente floor(M/N) barridos sin levantar
// el loop. El loop usa ESTA función, así que el test ejercita el código real.
function orphanSweepGate(prevTick, everyTicks = ORPHAN_SWEEP_EVERY_TICKS) {
  const n = (Number.isFinite(everyTicks) && everyTicks > 0) ? Math.floor(everyTicks) : 1;
  const tick = ((Number.isFinite(prevTick) ? prevTick : 0) + 1) % n;
  return { tick, due: tick === 0 };
}

// #6459 — Ejecuta el barrido con las dependencias del proceso INYECTADAS. El
// módulo ${B}lib/commander/orphan-sweep.js${B} no requiere ${B}pulpo.js${B} (sería un ciclo y
// arrancaría el mundo dentro de un test), así que el cableado vive acá:
//   · ${B}commanderOutboundStatus${B} — ÚNICA fuente de verdad de entrega (CA-7).
//   · ${B}noteFallbackDeliveryResolved${B} — evento TERMINAL, jamás reescritura (A3).
//   · ${B}currentBootId${B} — guarda de vida por boot, no por PID ni por reloj (B1).
// ${B}runOrphanSweep${B} ya es best-effort adentro y el caller lo envuelve igual en
// try/catch (SEC-3). Un fallo deja rastro con la causa (CA-14).
function ejecutarBarridoHuerfanos(origen) {
  return commanderOrphanSweep.runOrphanSweep({
    logDir: LOG_DIR,
    pipelineDir: PIPELINE,
    currentBootId: PULPO_BOOT_ID,
    deps: {
      outboundStatus: commanderOutboundStatus,
      noteFallbackDeliveryResolved: inflightFallback.noteFallbackDeliveryResolved,
      log: (msg) => log('commander', msg + ' [' + origen + ']'),
    },
  });
}`],

  // ── 9 · exports para tests ────────────────────────────────────────────────
  [
`    checkDesyncFlag,
    _getDesyncBlocked: () => desyncBlocked,`,
`    checkDesyncFlag,
    _getDesyncBlocked: () => desyncBlocked,
    // #6459 — barrido de huérfanos: gateo puro + runner cableado, expuestos
    // para los tests de cadencia (CA-12) y de inyección de dependencias.
    orphanSweepGate,
    ORPHAN_SWEEP_EVERY_TICKS,
    ejecutarBarridoHuerfanos,`],
]);

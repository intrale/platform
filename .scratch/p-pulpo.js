'use strict';
const { patch } = require('./patch');
const B = '`'; // backtick, para no pelear con el escape dentro de templates

patch('.pipeline/pulpo.js', [
  // ── 1 · require del módulo ────────────────────────────────────────────────
  [
`const commanderRequestClassify = require('./lib/commander/request-classify'); // #3951 EP7-H4`,
`const commanderRequestClassify = require('./lib/commander/request-classify'); // #3951 EP7-H4
// #6459 — barrido de rescate de turnos huérfanos (núcleo puro + capa de I/O).
// El módulo NO requiere ${B}pulpo.js${B}: ${B}commanderOutboundStatus${B} y
// ${B}noteFallbackDeliveryResolved${B} entran por inyección (${B}deps${B}), para no crear un
// ciclo de requires ni arrancar el proceso entero dentro de un unit test.
const commanderOrphanSweep = require('./lib/commander/orphan-sweep');`],

  // ── 2 · camino rápido in-process: señales de entrega ──────────────────────
  [
`    let commanderTurnHadError = false;        // hubo excepción en el bloque
    let commanderResultPersisted = false;     // idempotencia: no clasificar 2 veces`,
`    let commanderTurnHadError = false;        // hubo excepción en el bloque
    let commanderResultPersisted = false;     // idempotencia: no clasificar 2 veces
    // #6459 — camino RÁPIDO in-process del huérfano (CA-1). Son dos señales
    // distintas y las dos hacen falta:
    //   ${B}commanderRespuestaProducida${B} — el turno generó una respuesta no vacía,
    //     o sea que HABÍA algo concreto para entregarle al operador.
    //   ${B}commanderSalienteRegistrado${B} — el saliente quedó efectivamente asentado
    //     (se alcanzó la etapa ${B}envío${B} del canal no falsificable).
    // ${B}huerfano${B} = hubo respuesta ∧ el saliente nunca se registró. Sin la primera
    // señal, CUALQUIER early-return (path gated, comando determinista, sin
    // mensaje) se marcaría huérfano — justo el falso positivo que CA-10 prohíbe.
    // Este camino COMPLEMENTA al barrido, no lo duplica: el barrido nunca toca
    // un turno que ya asentó ${B}resultado${B} (CA-6 / R-3).
    let commanderRespuestaProducida = false;
    let commanderSalienteRegistrado = false;`],

  // ── 3 · pasar el input nuevo al clasificador ──────────────────────────────
  [
`          sherlockDisclaimerType: commanderDisclaimerType,
          hadError: hadError === true || commanderTurnHadError === true,
        });`,
`          sherlockDisclaimerType: commanderDisclaimerType,
          hadError: hadError === true || commanderTurnHadError === true,
          // #6459 — CA-1. Dentro del clasificador ${B}error${B} tiene precedencia sobre
          // ${B}huerfano${B}, así que un turno que además falló sigue leyéndose ${B}error${B}.
          deliveryUnconfirmed: commanderRespuestaProducida === true
            && commanderSalienteRegistrado !== true,
        });`],

  // ── 4 · marcar que hubo respuesta para entregar ───────────────────────────
  [
`      if (respuesta) {
        let enviado = false;`,
`      if (respuesta) {
        let enviado = false;
        // #6459 — hubo algo concreto para entregarle al operador. Si el turno
        // cierra sin registrar el saliente, esa respuesta se perdió ⇒ huérfano.
        commanderRespuestaProducida = !!String(respuesta).trim();`],

  // ── 5 · marcar que el saliente quedó registrado ───────────────────────────
  [
`          voz_ok: !!enviado,
          chars: outboundText.length,
          disclaimer: sherlockDisclaimerType || 'ninguno',
        });`,
`          voz_ok: !!enviado,
          chars: outboundText.length,
          disclaimer: sherlockDisclaimerType || 'ninguno',
        });
        // #6459 — el saliente quedó asentado en el canal no falsificable. Va
        // DESPUÉS de stage('envío'): si algo tira en el medio, la marca no se
        // pone y el turno cierra como huérfano, que es la lectura honesta.
        commanderSalienteRegistrado = true;`],

  // ── 6 · boot hook del barrido ─────────────────────────────────────────────
  [
`  // #5821 CA-1 — Marca de arranque de la iteración anterior, para poder publicar
  // su duración REAL en el heartbeat. Es la magnitud contra la que el watchdog
  // dimensiona su umbral; sin ella sólo tendría la edad muestreada del
  // heartbeat, que subestima la duración y produce falsos positivos.
  let lastIterationStartMs = null;`,
`  // #6459 — Boot hook del barrido de rescate de turnos huérfanos. Corre UNA vez
  // al arranque para que el huérfano que dejó el proceso anterior se marque sin
  // esperar los ~5 min del tick. Best-effort (SEC-3): jamás tumba el boot, y un
  // fallo deja rastro con la causa (CA-14) en vez de degradar en silencio al
  // mismo estado que "no hay huérfanos".
  try {
    const rBarrido = ejecutarBarridoHuerfanos('boot');
    if (rBarrido && rBarrido.ok) {
      log('commander', '[orphan-sweep] boot: ' + rBarrido.resumen.evaluados + ' turno(s) en ventana, '
        + rBarrido.resumen.huerfanos + ' huérfano(s), ' + rBarrido.emitidos.length + ' evento(s) nuevo(s)');
    }
  } catch (e) {
    log('commander', '[orphan-sweep] boot error (best-effort): ' + e.message);
  }

  // #5821 CA-1 — Marca de arranque de la iteración anterior, para poder publicar
  // su duración REAL en el heartbeat. Es la magnitud contra la que el watchdog
  // dimensiona su umbral; sin ella sólo tendría la edad muestreada del
  // heartbeat, que subestima la duración y produce falsos positivos.
  let lastIterationStartMs = null;`],

  // ── 7 · tick gateado (CA-12) ──────────────────────────────────────────────
  [
`      try { reconcileTelegramReceipts(); } catch (e) { log('telegram', ${B}[reconcile] tick error: \${e.message}${B}); }`,
`      try { reconcileTelegramReceipts(); } catch (e) { log('telegram', ${B}[reconcile] tick error: \${e.message}${B}); }

      // #6459 CA-12 — Barrido de rescate de turnos huérfanos, GATEADO POR TICKS.
      // Este punto del loop corre en CADA iteración (~30s) y el barrido se
      // declaró a ~5 min, así que se gatea con el mismo patrón y la misma
      // cadencia que ${B}desyncEvalTick${B} (10 ticks). Sin el gateo correría ~10x más
      // seguido de lo previsto y releería el historial entero cada vez.
      // Best-effort: nunca rompe el loop, pero deja rastro si falla (CA-14).
      const orphanGate = orphanSweepGate(orphanSweepTick);
      orphanSweepTick = orphanGate.tick;
      if (orphanGate.due) {
        try { ejecutarBarridoHuerfanos('tick'); }
        catch (e) { log('commander', ${B}[orphan-sweep] tick error: \${e.message}${B}); }
      }`],
]);

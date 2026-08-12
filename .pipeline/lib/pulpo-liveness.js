// =============================================================================
// pulpo-liveness.js — Lógica de decisión de liveness del Pulpo (#4154)
//
// Por qué este módulo existe
// --------------------------
// El watchdog (`.pipeline/watchdog.ps1`) decide si el Pulpo está vivo mirando
// SÓLO si existe un proceso `node` corriendo `pulpo.js` en el SO. Eso da por
// sano a un Pulpo zombi: proceso vivo pero loop principal colgado (no vuelve a
// iterar). Incidente 2026-06-24: hubo que reiniciar a mano.
//
// La solución (espejo de `lib/watchdog-supervisor.js`, patrón de #4077, un
// nivel abajo): el Pulpo emite un heartbeat por iteración (`last-tick.json`) y
// el watchdog verifica que sea reciente. PowerShell no es testeable con
// `node --test`, así que TODA la decisión vive acá; PowerShell sólo recolecta
// hechos del SO y ejecuta `Stop-Process`/respawn.
//
// Defensas de seguridad (de la fase de criterios, #4154):
//   SEC-1  El watchdog mata por PID del scan del SO, nunca por el PID del JSON.
//          Acá ese PID sólo se usa como CROSS-CHECK: si el pid del heartbeat no
//          coincide con el pid del scan SO (o es inválido) => no confirmar kill.
//   SEC-2  `last-tick.json` es input no confiable: parseo defensivo, fail-closed.
//          Umbral inválido => default, NUNCA "nunca stale".
//   SEC-3  Umbral de kill holgado y desacoplado del display (<30s de /salud).
//
// Cero dependencias npm. Funciones puras.
// =============================================================================

'use strict';

// Umbral de kill por default: 270s. Desacoplado del "esperado < 30s" que /salud
// usa para *mostrar* salud (30s == 1 poll_interval del Pulpo).
//
// #5820 — Por qué 270 y no 90. El default original (90s = max(90,
// 3×poll_interval)) derivaba el umbral del POLL, no de la duración real de un
// ciclo del Pulpo. El incidente del 2026-08-11 midió esa diferencia: con 180s
// —el DOBLE del default— el watchdog mató al Pulpo 77 veces en ~3h sin que
// hubiera un cuelgue real, y el máximo hbAgeMs de un Pulpo sano medido después
// fue 244993 ms (245 s). Un default de 90s es, entonces, casi 3× más agresivo
// que un umbral que YA se demostró insuficiente.
//
// Esto importa porque el default NO es sólo un camino de emergencia: se aplica
// por vía normal cuando config.yaml no aporta el valor (bloque `watchdog:`
// ausente — ver pulpo-liveness-run.js, caso D-4 de #5172 — o clave ausente /
// inválida). Con 90s, perder el bloque de config dejaba el umbral MÁS agresivo
// que el vigente y reabría el bucle de muerte en silencio. El default se
// mantiene alineado con `watchdog.pulpo_liveness_kill_seconds` de config.yaml
// para que la degradación nunca sea en dirección destructiva (SEC-3).
//
// Si se sube el valor de config.yaml, subir también este default.
const DEFAULT_KILL_SECONDS = 270;

// #5821 CA-4 — Señal secundaria de progreso: distinguir "ciclo lento" de "cuelgue".
//
// El problema: mirando SÓLO la antigüedad del heartbeat, un Pulpo colgado y un
// Pulpo lento son indistinguibles. Subir el umbral (única defensa que había
// contra el falso positivo) significaba, inevitablemente, tolerar cuelgues
// reales por más tiempo. La señal secundaria rompe ese trade-off: el Pulpo toca
// `last-progress` DURANTE la iteración (no sólo al cerrarla), así que su mtime
// separa los dos casos aunque el heartbeat de fin de ciclo esté viejo.
//
// PROGRESS_STALE: cuánto puede hacer que el Pulpo no toca un hito del loop para
// que la señal deje de contar como "está trabajando".
//
// SE DIMENSIONA CONTRA UN *PASO* DEL LOOP, NO CONTRA EL CICLO ENTERO. El emisor
// (`touchProgress()` en pulpo.js) se llama en los hitos secuenciales del `while`
// —y deliberadamente NO desde `log()`, que también disparan los timers de fondo
// y las cadenas fire-and-forget aunque el loop esté colgado—. Así que la
// granularidad real de la señal es el paso más largo del ciclo, no 5 segundos.
// 300s deja lugar de sobra para el brazo más pesado (intake, que encadena varias
// llamadas a `gh`) sin volver a inventar el falso positivo que este issue mata.
const DEFAULT_PROGRESS_STALE_SECONDS = 300;

// Techo del "ciclo lento": por más progreso que reporte, pasado este punto el
// Pulpo no es lento, está colgado (p. ej. un retry loop que sigue tocando hitos
// para siempre). Sin este techo, la señal secundaria sería un cheque en blanco
// para no matar nunca.
//
// OJO AL ORDEN DE MAGNITUD: si este techo quedara <= al umbral efectivo, la rama
// de ciclo lento sería CÓDIGO MUERTO (matar exige age > umbral y tolerar exige
// age <= techo: con techo == umbral no hay ventana). Por eso el runner lo eleva
// a `max(configurado, 2 × umbral efectivo)`: la tolerancia siempre queda por
// encima del umbral, sea cual sea el valor al que llegó el dimensionamiento.
const DEFAULT_MAX_SLOW_CYCLE_SECONDS = 1800;

/**
 * Valida el umbral de kill en segundos (SEC-2).
 * Debe ser entero positivo. Un valor no numérico / 0 / negativo NO debe
 * degradar el chequeo a "nunca stale": cae al default.
 *
 * @param {*} raw            valor crudo (string de env o number de config)
 * @param {number} fallback  default si raw es inválido
 * @returns {number} entero positivo (segundos)
 */
function parseKillSeconds(raw, fallback = DEFAULT_KILL_SECONDS) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 ? fallback : DEFAULT_KILL_SECONDS;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 ? raw : safeFallback;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return safeFallback;
}

/**
 * Extrae el PID del contenido (no confiable) de `last-tick.json` (SEC-2).
 * Sólo se usa para el cross-check del watchdog, NUNCA para construir el kill.
 * JSON malformado / campos faltantes / pid no entero o ≤ 0 => null (fail-closed).
 *
 * @param {*} raw  string crudo del archivo, o un objeto ya parseado
 * @returns {number|null} pid entero positivo, o null si es ilegible/ inválido
 */
function parseHeartbeatPid(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return null; // JSON malformado => ilegible
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const pid = obj.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * #5821 CA-1/CA-2 — Extrae `iterationMs` (duración de la última iteración del
 * loop) del contenido no confiable de `last-tick.json` (SEC-2).
 *
 * POR QUÉ ESTE CAMPO Y NO `hbAgeMs`
 * ---------------------------------
 * `hbAgeMs` es la edad del heartbeat EN EL INSTANTE en que el watchdog muestrea,
 * y ese instante cae en un punto arbitrario dentro de la iteración. Es una
 * muestra SESGADA de la duración, no la duración: en la evidencia del incidente
 * el p50 (92s) daba justo la mitad del máximo (245s), la firma inconfundible de
 * una distribución de *edad muestreada*. Calibrar el umbral con eso lo
 * subestimaría sistemáticamente y reproduciría, en versión estadística, el mismo
 * falso positivo que este issue viene a matar. `iterationMs` es la magnitud que
 * el umbral realmente quiere acotar.
 *
 * SEGURIDAD: este valor SÓLO alimenta la serie de calibración; jamás inhibe un
 * kill por sí solo. Un payload falsificado puede empujar el umbral hacia arriba,
 * pero el techo (`max_effective_seconds`) y el clamp por muestra de
 * `pulpo-liveness-margin.appendSample` acotan el daño a "el umbral llega al
 * techo configurado" — nunca a "el watchdog queda deshabilitado".
 *
 * @param {*} raw  string crudo del archivo, o un objeto ya parseado
 * @returns {number|null} ms >= 0, o null si es ilegible/ausente/inválido
 */
function parseHeartbeatIterationMs(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const ms = obj.iterationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

/**
 * #5821 CA-1 — Extrae el `timestamp` (ISO8601) del heartbeat, como IDENTIDAD de
 * la iteración. Contenido no confiable => parseo defensivo (SEC-2).
 *
 * Para qué: el watchdog muestrea cada ~2 min y las iteraciones duran ~4 min, así
 * que sin una clave de identidad el MISMO ciclo se registraría 2-3 veces en la
 * serie mientras que los ciclos más cortos que la cadencia no se verían nunca.
 * El resultado sería un percentil sesgado hacia arriba: la serie sobre-pesa
 * justo los ciclos largos que quiere medir. Deduplicando por timestamp, cada
 * iteración aporta exactamente una muestra.
 *
 * Se devuelve como STRING opaco: sólo se compara por igualdad, nunca se
 * interpreta como fecha ni se hace aritmética con él (un timestamp falsificado
 * no puede así corromper ningún cálculo, apenas saltearse su propia muestra).
 *
 * @param {*} raw
 * @returns {string|null}
 */
function parseHeartbeatTickId(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const ts = obj.timestamp;
  if (typeof ts !== 'string' || ts.length === 0 || ts.length > 64) return null;
  return ts;
}

/**
 * Decide qué hacer con el Pulpo dado el estado del heartbeat y del SO.
 * Función PURA.
 *
 * IMPORTANTE: la edad del heartbeat (`hbAgeMs`) se calcula desde el mtime del
 * archivo (lo aporta el .ps1 vía env, como hace el supervisor con
 * `LastWriteTime`), NO desde el `timestamp` del contenido — el contenido es
 * input no confiable (SEC-2). El `hbPidFromContent` sólo cruza contra el SO.
 *
 * @param {object} facts
 * @param {boolean} facts.hbExists           ¿existe `last-tick.json`?
 * @param {number|null} facts.hbAgeMs        edad del heartbeat (mtime) en ms
 * @param {number|null} facts.hbPidFromContent  pid leído del contenido (cross-check)
 * @param {number|null} facts.soPid          pid del proceso pulpo.js del scan SO
 * @param {number} facts.killThresholdMs     umbral de kill en ms (el EFECTIVO, #5821)
 * @param {number|null} [facts.progressAgeMs]     #5821 CA-4: edad (mtime) de
 *        `last-progress`, la señal secundaria de trabajo intra-iteración.
 * @param {number} [facts.progressThresholdMs]    hasta cuándo esa señal cuenta.
 * @param {number} [facts.maxSlowCycleMs]         techo del "ciclo lento".
 * @returns {'skip'|'kill-respawn'|'skip-log-discrepancy'|'skip-slow-cycle'}
 *   - 'skip'                 : sano, o sin heartbeat (no inventar kill).
 *   - 'kill-respawn'         : zombi confirmado (lag vencido + PID cruzado OK).
 *   - 'skip-log-discrepancy' : lag vencido pero PID no cruza => no matar, loguear.
 *   - 'skip-slow-cycle'      : #5821 CA-4, lag vencido pero hay progreso reciente
 *                              => es un ciclo lento, no un cuelgue. No matar.
 */
function decide(facts) {
  const f = facts || {};

  // Sin heartbeat => no inventar kill. Un proceso recién arrancado todavía no
  // escribió `last-tick.json`; un proceso ausente lo cubre el path normal del
  // watchdog (spawn por proceso inexistente). Fail-closed seguro (CA-6).
  if (!f.hbExists) return 'skip';

  const age = f.hbAgeMs;
  if (age == null || !Number.isFinite(age) || age < 0) {
    // Heartbeat existe pero su edad es ilegible (mtime raro): no matar.
    return 'skip';
  }

  const threshold = f.killThresholdMs;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    // Umbral inválido => no matar (fail-closed, nunca kill por umbral degradado).
    return 'skip';
  }

  // Sano: el lag está dentro del umbral (CA-4, sin falso positivo).
  if (age <= threshold) return 'skip';

  // #5821 CA-4 — El lag venció, pero ¿es un cuelgue o sólo un ciclo lento?
  //
  // GUARDARRAÍL DE SEGURIDAD (SEC-2, extensión de la regla de #4154): esta señal
  // puede INHIBIR un kill, así que amplía la superficie de ataque — un
  // `last-progress` falsificado o "tocado" por otro proceso protegería a un
  // zombi real. Por eso:
  //   a) la señal es el MTIME de un archivo aparte, nunca contenido parseado:
  //      no hay payload que envenenar, sólo metadata del FS;
  //   b) señal ausente, ilegible o fuera de rango => se trata como AUSENTE =>
  //      se decide por umbral. NUNCA "no puedo leerla, entonces no mato";
  //   c) el techo `maxSlowCycleMs` acota cuánto puede tolerarse: pasado ese
  //      punto se mata aunque haya progreso (un retry loop que loguea eternamente
  //      reporta progreso y sigue estando colgado).
  const maxSlowMs =
    Number.isFinite(f.maxSlowCycleMs) && f.maxSlowCycleMs > 0
      ? f.maxSlowCycleMs
      : DEFAULT_MAX_SLOW_CYCLE_SECONDS * 1000;
  const progressAge = f.progressAgeMs;
  const progressThreshold =
    Number.isFinite(f.progressThresholdMs) && f.progressThresholdMs > 0
      ? f.progressThresholdMs
      : DEFAULT_PROGRESS_STALE_SECONDS * 1000;

  if (
    age <= maxSlowMs &&
    Number.isFinite(progressAge) &&
    progressAge >= 0 &&
    progressAge <= progressThreshold
  ) {
    return 'skip-slow-cycle';
  }

  // Zombi candidato: el proceso existe pero el lag superó el umbral.
  // SEC-1 / CA-3.1 — sólo confirmar si el pid del heartbeat coincide con el pid
  // del scan del SO. Cualquier discrepancia (pid inválido, ausente, distinto) =>
  // no matar + loguear (evita matar un proceso ajeno por PID reciclado o
  // heartbeat falsificado).
  const hbPid = f.hbPidFromContent;
  if (!Number.isInteger(hbPid) || hbPid <= 0) return 'skip-log-discrepancy';
  if (!Number.isInteger(f.soPid) || f.soPid <= 0) return 'skip-log-discrepancy';
  if (hbPid !== f.soPid) return 'skip-log-discrepancy';

  return 'kill-respawn';
}

module.exports = {
  decide,
  parseKillSeconds,
  parseHeartbeatPid,
  parseHeartbeatIterationMs,
  parseHeartbeatTickId,
  DEFAULT_KILL_SECONDS,
  DEFAULT_PROGRESS_STALE_SECONDS,
  DEFAULT_MAX_SLOW_CYCLE_SECONDS,
};

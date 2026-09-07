'use strict';

// =============================================================================
// kernel-durable-config-guard.js — Guard fail-closed de configuración durable (#5214)
//
// Completa el fail-closed que #5203 dejó a medias: con `kernel.durable: true` y
// un `kernel.tableName` ausente, vacío o compuesto SÓLO por whitespace, el
// arranque termina con código no-cero SIN fallback (ni filesystem, ni nombre por
// defecto, ni llamadas AWS, ni procesamiento parcial).
//
// POR QUÉ ES UN MÓDULO APARTE (y no una función más de `kernel-store.js`)
//   El CA exige que la validación corra ANTES de construir clientes AWS y de
//   resolver credenciales. `kernel-store.js` arrastra Ajv, el schema JSON y
//   `provisioner-infra` — precisamente por eso `pulpo.js` lo carga LAZY dentro
//   del bloque `durable === true`. Un guard que viva ahí adentro ya llegó tarde:
//   validaría después de haber cargado la maquinaria del driver.
//
//   Este módulo NO tiene dependencias: ni `fs`, ni AWS, ni el store. Es una
//   función pura sobre el objeto de config, así que se puede invocar como
//   PRIMERA sentencia del camino durable en cualquier entrypoint, y el test de
//   "cero llamadas AWS" es demostrable por construcción además de por spies.
//
// SEGURIDAD (auditoría de definición · OWASP)
//   A05  Security Misconfiguration — es la superficie principal: configuración
//        durable incompleta que hoy degrada en silencio.
//   A02  el diagnóstico es un TEXTO CONSTANTE. No interpola el valor recibido,
//        ni la config serializada, ni variables de entorno, ni región, ni ARNs.
//        La variante concreta (ausente / vacío / whitespace) viaja en el campo
//        estructurado `reason` del error, NUNCA en el texto al operador: las tres
//        comparten remedio, así que distinguirlas en el mensaje no ayuda a nadie
//        y sólo agranda lo que se imprime.
//
// FAIL-CLOSED, NO FAIL-SAFE
//   `kernel.durable: false` (el estado versionado hoy) NO ejecuta este guard:
//   con el flag apagado no hay modo durable que proteger. Y al revés: una config
//   durable inválida NUNCA se "recupera" apagando el flag sola — eso sería
//   exactamente el fallback silencioso que la historia viene a eliminar.
// =============================================================================

// EX_CONFIG de sysexits(3). Mismo código que usa el permission gate at-boot de
// `pulpo.js` para abortar por configuración inválida: un no-cero que además
// distingue "config rota" de un crash genérico en los logs del supervisor.
const DURABLE_CONFIG_EXIT_CODE = 78;

// Identificador estable del error (para el ruteo del caller, no para el humano).
const DURABLE_CONFIG_ERROR_CODE = 'KERNEL_DURABLE_CONFIG_INVALID';

// -----------------------------------------------------------------------------
// El diagnóstico (CA-3)
// -----------------------------------------------------------------------------
// Guidelines de UX de operador aplicadas (comentario de `ux` en la definición):
//   1. Ubicación antes que diagnóstico: archivo y clave exacta en la 1ra oración.
//   2. Una sola acción, sin menú: nada de "o bien apagá durable" — eso invita al
//      fallback que el CA-2 prohíbe.
//   3. Cierra con el runbook como destino único de profundización.
//   4. Sin códigos internos ocupando el lugar de la instrucción.
//   5. Sin volcar configuración ni entorno.
//
// CONSTANTE: se congela para que ningún caller la mute en runtime y para que el
// test de contenido tenga una única fuente de verdad.
const DURABLE_CONFIG_ABORT_MESSAGE = [
  "Arranque abortado: falta 'kernel.tableName' en .pipeline/config.yaml.",
  'El modo durable (kernel.durable: true) no arranca sin nombre de tabla y no cae a filesystem.',
  'Completá la clave con el nombre de la tabla y reintentá.',
  'Detalle: docs/pipeline/runbook-cutover-durable.md',
].join(' ');

/**
 * Error tipado del guard. El `message` es SIEMPRE la constante de arriba: no
 * acepta texto libre, justamente para que no exista una ruta por la que un
 * caller filtre el valor recibido o la config.
 */
class KernelDurableConfigError extends Error {
  /** @param {'missing'|'empty'|'whitespace'} reason variante estructurada (no va al mensaje). */
  constructor(reason) {
    super(DURABLE_CONFIG_ABORT_MESSAGE);
    this.name = 'KernelDurableConfigError';
    this.code = DURABLE_CONFIG_ERROR_CODE;
    this.reason = reason;
    this.exitCode = DURABLE_CONFIG_EXIT_CODE;
  }
}

// -----------------------------------------------------------------------------
// Clasificación del valor
// -----------------------------------------------------------------------------

/**
 * Clasifica `kernel.tableName` sin revelar su contenido.
 *
 * Las tres variantes inválidas del CA:
 *   - `missing`    : la propiedad no está, es null/undefined, o no es string
 *                    (un número o un objeto en YAML tampoco es un nombre de tabla).
 *   - `empty`      : string de longitud 0.
 *   - `whitespace` : string no vacío que al trimear queda vacío. ESTE es el caso
 *                    que el guard previo dejaba pasar: `"   "` es truthy, así que
 *                    `typeof x === 'string' && x` lo aceptaba y llegaba al driver
 *                    real como nombre de tabla.
 *
 * @param {*} value
 * @returns {{ status:'ok', value:string } | { status:'invalid', reason:'missing'|'empty'|'whitespace' }}
 */
function classifyTableName(value) {
  if (typeof value !== 'string') return { status: 'invalid', reason: 'missing' };
  if (value.length === 0) return { status: 'invalid', reason: 'empty' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { status: 'invalid', reason: 'whitespace' };
  // Se devuelve TRIMEADO: un `"tabla\n"` que se cuela por el YAML no debe viajar
  // al driver con el salto de línea adentro.
  return { status: 'ok', value: trimmed };
}

/** @returns {boolean} true sólo si el flag es EXACTAMENTE `true` (mismo criterio que #4822). */
function isDurableEnabled(config) {
  const c = config && typeof config === 'object' ? config : {};
  const kernel = c.kernel && typeof c.kernel === 'object' ? c.kernel : {};
  return kernel.durable === true;
}

/**
 * Inspecciona la config SIN lanzar. Útil para callers que necesitan decidir el
 * desenlace ellos mismos (el boot del pulpo aborta; `bootKernelDurable` devuelve).
 *
 * @param {object} config config del pipeline (`loadConfig()`).
 * @returns {{ ok:true, durable:boolean, tableName:(string|null) }
 *          |{ ok:false, durable:true, reason:'missing'|'empty'|'whitespace', message:string, exitCode:number }}
 */
function inspectDurableKernelConfig(config) {
  if (!isDurableEnabled(config)) {
    // Flag apagado ⇒ no hay modo durable que gatear. No se mira `tableName`
    // siquiera: en régimen normal el guard es un no-op de costo cero.
    return { ok: true, durable: false, tableName: null };
  }
  const kernel = config.kernel;
  const verdict = classifyTableName(kernel.tableName);
  if (verdict.status === 'invalid') {
    return {
      ok: false,
      durable: true,
      reason: verdict.reason,
      message: DURABLE_CONFIG_ABORT_MESSAGE,
      exitCode: DURABLE_CONFIG_EXIT_CODE,
    };
  }
  return { ok: true, durable: true, tableName: verdict.value };
}

/**
 * Variante que LANZA `KernelDurableConfigError` ante configuración durable
 * inválida. Pensada para invocarse como primera sentencia de un entrypoint
 * durable: si nadie la atrapa, el proceso muere con código no-cero por el
 * handler de excepción no capturada.
 *
 * @param {object} config
 * @returns {{ durable:boolean, tableName:(string|null) }}
 * @throws {KernelDurableConfigError}
 */
function assertDurableKernelConfig(config) {
  const res = inspectDurableKernelConfig(config);
  if (!res.ok) throw new KernelDurableConfigError(res.reason);
  return { durable: res.durable, tableName: res.tableName };
}

/**
 * Aborta el proceso ante configuración durable inválida.
 *
 * El desenlace es SIEMPRE terminación con código no-cero (CA-1) y sin fallback
 * (CA-2). Las dependencias se inyectan para que el test pueda observar el código
 * de salida sin matar al runner; en producción `exit` es `process.exit`.
 *
 * @param {object}    args
 * @param {'missing'|'empty'|'whitespace'} args.reason  variante estructurada.
 * @param {function} [args.log]     sink de log local (recibe el texto constante).
 * @param {function} [args.alert]   alerta al operador (recibe { message, reason }).
 * @param {function} [args.exit]    terminador (default: process.exit).
 * @returns {number} el código de salida usado (si `exit` no corta el flujo, en tests).
 */
function abortOnInvalidDurableConfig(args = {}) {
  const reason = args.reason || 'missing';
  // Log y alerta son BEST-EFFORT: si el canal falla, el aborto va igual. Nunca
  // al revés — una alerta rota no puede convertirse en "seguí arrancando".
  try { if (typeof args.log === 'function') args.log(DURABLE_CONFIG_ABORT_MESSAGE); } catch { /* el aborto va igual */ }
  try {
    if (typeof args.alert === 'function') {
      args.alert({ message: DURABLE_CONFIG_ABORT_MESSAGE, reason });
    }
  } catch { /* el aborto va igual */ }
  const exit = typeof args.exit === 'function' ? args.exit : process.exit;
  exit(DURABLE_CONFIG_EXIT_CODE);
  return DURABLE_CONFIG_EXIT_CODE;
}

module.exports = {
  DURABLE_CONFIG_ABORT_MESSAGE,
  DURABLE_CONFIG_EXIT_CODE,
  DURABLE_CONFIG_ERROR_CODE,
  KernelDurableConfigError,
  classifyTableName,
  isDurableEnabled,
  inspectDurableKernelConfig,
  assertDurableKernelConfig,
  abortOnInvalidDurableConfig,
};

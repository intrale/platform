// =============================================================================
// spawn-attempt-guard.js — Guard SÍNCRONO del intento de spawn de un provider
// no-Anthropic del Commander (#4318).
//
// Contexto del bug (#4318, follow-up de #4313):
//   El ejecutor pre-turno del fallback (`runNonAnthropic` en `pulpo.js`) corre
//   el setup del spawn de forma SÍNCRONA: data-residency → safeBuildSpawn →
//   `spawn(...)`. En Windows, un launcher mal cableado (ENOENT / cmd inválido)
//   hace que `spawn()` (o el resto del setup) LANCE de forma síncrona SIN emitir
//   el evento `proc.on('error')`. Ese throw escapaba del executor del `Promise`
//   de `ejecutarClaude` → lo RECHAZABA en ~ms (sin llegar a invocar Codex de
//   verdad) → se saltaba el override de atribución del turno y el resultado
//   quedaba como `error / provider:anthropic / cross_provider:false`.
//
// Este módulo aísla la ÚNICA decisión del fix en una unidad pura y testeable:
//   "si el cuerpo síncrono del intento lanza, NO propagar — degradar vía el
//    mismo camino que `proc.on('error')` (advanceOrGiveUp → resolve canned,
//    NUNCA reject)".
//
// El módulo es PURO: no importa `child_process` ni toca disco. Recibe el thunk
// del intento y el degradado por inyección, de modo que se testea sin levantar
// el pulpo (que no es unit-testeable). El caller real (`pulpo.js::runNonAnthropic`)
// lo usa como wrapper del cuerpo síncrono; ambos caminos (pre-turno #4313 e
// in-flight #4309) comparten el closure, así que el guard cubre a los dos.
//
// Seguridad (SR-A / SR-7, fase análisis #4318): el guard NO expone `stderr` ni
// el prompt crudo. La causa del throw se entrega como `Error` al `onSyncThrow`
// del caller, que decide qué loguear/auditar con redacción propia (prompt_hash,
// nunca literal). Acá no se serializa nada.
// =============================================================================
'use strict';

// Razón por defecto del degradado ante throw síncrono. Es un enum-string
// estático (no derivado de input) → apto para audit log / atribución sin riesgo
// de log-forging.
const DEFAULT_SYNC_THROW_REASON = 'spawn_throw';

/**
 * Ejecuta el cuerpo síncrono de un intento de spawn bajo un try/catch. Si el
 * intento lanza SÍNCRONAMENTE, enruta al degradado `onSyncThrow` en vez de
 * propagar la excepción (fail-soft: el turno NUNCA queda mudo por un throw del
 * launcher). Si el intento no lanza, devuelve tal cual su valor de retorno (la
 * resolución real del turno ocurre async vía los `proc.on(...)` que el intento
 * registró — fuera del alcance de este guard).
 *
 * @param {object} args
 * @param {string} args.provider        Provider efectivo del intento (atribución).
 * @param {function} args.attempt       Thunk con el cuerpo SÍNCRONO del intento
 *                                       (data-residency + safeBuildSpawn + spawn +
 *                                       wiring de eventos). Puede devolver cualquier
 *                                       cosa; su valor se propaga en el camino feliz.
 * @param {function} args.onSyncThrow   (provider, reason, err) => X — degradado
 *                                       invocado SÓLO si `attempt` lanza. Su valor
 *                                       de retorno se propaga.
 * @param {string} [args.reason]        Código de razón del degradado
 *                                       (default: 'spawn_throw').
 * @returns {*} el retorno de `attempt()` (feliz) o de `onSyncThrow()` (ante throw).
 * @throws {TypeError} si `attempt` u `onSyncThrow` no son funciones.
 */
function runGuardedSpawnAttempt(args) {
  const {
    provider,
    attempt,
    onSyncThrow,
    reason = DEFAULT_SYNC_THROW_REASON,
  } = (args && typeof args === 'object') ? args : {};

  if (typeof attempt !== 'function') {
    throw new TypeError('runGuardedSpawnAttempt: `attempt` debe ser una función');
  }
  if (typeof onSyncThrow !== 'function') {
    throw new TypeError('runGuardedSpawnAttempt: `onSyncThrow` debe ser una función');
  }

  try {
    return attempt();
  } catch (err) {
    // Throw síncrono del setup/spawn → degradar (NUNCA propagar). El caller
    // convierte esto en advanceOrGiveUp(provider, reason): re-resuelve la cadena
    // o resuelve canned. El forense (errorCode real, provider) queda en el audit
    // log del caller, no acá.
    return onSyncThrow(provider, reason, err);
  }
}

module.exports = {
  runGuardedSpawnAttempt,
  DEFAULT_SYNC_THROW_REASON,
};

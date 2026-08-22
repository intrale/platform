// =============================================================================
// agent-launcher/spawn-failure-classifier.js — Clasificador puro de
// "muerte al spawnear del provider" (issue #4052, CA-1 / CA-3 / SEC-3).
//
// CONTEXTO
// --------
// Durante la ventana de inactividad de Anthropic, el pipeline cae a Codex como
// provider de los skills de desarrollo. El proceso de Codex **se muere al
// spawnear** (binario ausente, shim .cmd que no resuelve, wrapper ESM que
// explota). Cada muerte temprana dispara un reintento; a los 3 reintentos el
// issue rebota entero, quemando el circuit breaker por un problema de infra del
// provider — NO por un fallo del issue.
//
// Este módulo es el **predicado puro** que distingue una muerte de spawn-failure
// (atribuible a la infra del provider) de cualquier otra muerte (que se trata
// como fallo-del-issue, consumiendo retry como hoy).
//
// POLÍTICA FAIL-CLOSED (SEC-3.1)
// ------------------------------
// Solo se clasifica como spawn-failure con **firma inequívoca**:
//   1. `errorCode` ∈ SPAWN_FAILURE_ERROR_CODES — `child.on('error')` con código
//      de spawn (ENOENT = binario no encontrado, EACCES/EPERM = permiso).
//   2. `exitCode === 127` — convención de shell "command not found" (tiers
//      cmd-shim / path-fallback con shell:true).
//   3. Exit ANTES del primer byte (`firstByteAt == null`) con duración muy
//      corta (≤ SPAWN_FAILURE_MAX_MS) y exit code distinto de 0 — el proceso
//      murió sin llegar a producir output.
//
// Cualquier otra muerte (output presente, duración larga, exit 0, señales
// ambiguas) → NO es spawn-failure → fail-closed = fallo-del-issue.
//
// IMPORTANTE: este predicado NO decide políticas (no apaga providers, no mueve
// archivos, no toca filesystem). Es Node puro sin side-effects para ser
// testeable y reutilizable desde onSpawnExit (dispatch) y la instrumentación
// del launcher.
// =============================================================================
'use strict';

// Códigos de error de Node que indican que el proceso NUNCA llegó a arrancar.
// Distintos de los INFRA_ERROR_CODES de circuit-breaker-infra.js (que son de
// RED: ENOTFOUND/ECONNREFUSED/...). Acá son códigos de SPAWN del SO.
const SPAWN_FAILURE_ERROR_CODES = Object.freeze(new Set([
    'ENOENT',   // binario/comando no existe en el path resuelto
    'EACCES',   // sin permiso de ejecución
    'EPERM',    // operación no permitida al spawnear
]));

// Exit codes de shell que significan "no se pudo ejecutar el comando".
//   127 = command not found (sh/cmd cuando el binario no está en PATH).
const SPAWN_FAILURE_EXIT_CODES = Object.freeze(new Set([127]));

// Umbral de duración para la firma "exit antes del primer byte". Una muerte de
// spawn ocurre en milisegundos; si el proceso vivió varios segundos y produjo
// algo, ya no es una muerte de spawn (fail-closed → fallo del issue).
const SPAWN_FAILURE_MAX_MS = 5000;

/**
 * classifySpawnFailure — predicado puro fail-closed.
 *
 * @param {object} ctx
 * @param {string|null} [ctx.errorCode]   código de `child.on('error')` (ej ENOENT)
 * @param {number|null} [ctx.exitCode]    exit code del proceso (null si murió por error)
 * @param {string|null} [ctx.signal]      señal de terminación (informativo)
 * @param {number|null} [ctx.firstByteAt] timestamp del primer byte de stdout/stderr
 *                                         (null/undefined ⇒ nunca produjo output)
 * @param {number|null} [ctx.durationMs]  ms desde el spawn hasta la muerte
 * @param {boolean} [ctx.spawnInstrumented] true SOLO cuando el caller rastreó
 *        realmente el primer byte (instrumentación CA-1 del launcher). La firma
 *        3 ("exit antes del primer byte") SOLO se evalúa con este opt-in, para
 *        no misclasificar a los callers post-exit que no pasan firstByteAt
 *        (ej. el path legacy del pulpo, donde firstByteAt siempre es null y un
 *        exit 1 normal NO es spawn-failure). Firmas 1 y 2 son inequívocas y
 *        aplican siempre.
 * @returns {{ isSpawnFailure: boolean, signature: string|null }}
 */
function classifySpawnFailure(ctx = {}) {
    const {
        errorCode = null,
        exitCode = null,
        firstByteAt = null,
        durationMs = null,
        spawnInstrumented = false,
    } = ctx;

    // Firma 1 — child.on('error') con código de spawn del SO. Inequívoca.
    if (errorCode && SPAWN_FAILURE_ERROR_CODES.has(String(errorCode).toUpperCase())) {
        return { isSpawnFailure: true, signature: `error_code:${String(errorCode).toUpperCase()}` };
    }

    // Firma 2 — exit code 127 (command not found vía shell). Inequívoca.
    if (Number.isInteger(exitCode) && SPAWN_FAILURE_EXIT_CODES.has(exitCode)) {
        return { isSpawnFailure: true, signature: `exit_code:${exitCode}` };
    }

    // Firma 3 — exit antes del primer byte, muy temprano, con exit no-cero.
    // SOLO con opt-in `spawnInstrumented`: requiere que el caller haya rastreado
    // de verdad el primer byte. Sin el opt-in, firstByteAt==null es ambiguo
    // (puede ser "no se rastreó") → fail-closed.
    if (spawnInstrumented === true) {
        const noFirstByte = firstByteAt == null;
        const earlyDeath = Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= SPAWN_FAILURE_MAX_MS;
        const nonZeroExit = Number.isInteger(exitCode) && exitCode !== 0;
        if (noFirstByte && earlyDeath && nonZeroExit) {
            return { isSpawnFailure: true, signature: `early_exit:${exitCode}@${Math.round(durationMs)}ms` };
        }
    }

    // Fail-closed: cualquier otra muerte se trata como fallo-del-issue.
    return { isSpawnFailure: false, signature: null };
}

module.exports = {
    classifySpawnFailure,
    SPAWN_FAILURE_ERROR_CODES,
    SPAWN_FAILURE_EXIT_CODES,
    SPAWN_FAILURE_MAX_MS,
};

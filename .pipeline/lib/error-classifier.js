// =============================================================================
// error-classifier.js — Clasificación pura de excepciones del pipeline (#3941)
// =============================================================================
//
// EP5-H4. Unidad PURA, sin side-effects (no toca FS, red ni `.paused`). Sólo
// mapea un `err` a una de tres categorías de política:
//
//   'transient'  → infra temporal (red caída, fs ocupado, gh CLI, timeout).
//                  Política: continuar + loguear. NUNCA pausar.
//   'corruption' → corrupción de estado (YAML existente que no parsea,
//                  schema-violation de config). Política: reacción según
//                  granularidad del caller (config = halt global vía .paused;
//                  work-file = cuarentena de ESE issue — SEC-3). El clasificador
//                  NO decide la granularidad, sólo reporta la categoría.
//   'unknown'    → cualquier otra cosa. FAIL-SAFE: continuar + loguear. Ante la
//                  duda NO se pausa (un transitorio mal clasificado como
//                  corrupción frenaría todo el pipeline — A04/DoS).
//
// Diseño conservador (guru/security, #3941): sólo `transient`/`corruption`
// EXPLÍCITOS cambian comportamiento; todo lo demás cae a `unknown` → continuar.
//
// El clasificador NO usa `instanceof` contra clases de otros módulos (js-yaml,
// config-schema) para no acoplarse a instancias concretas que pueden diferir
// entre copias del módulo en worktrees. Compara por `err.name`, que es estable.
// =============================================================================
'use strict';

// Códigos de error de Node/libuv considerados infra TRANSITORIA. Cubren red
// (DNS, conexión, ruta), fs temporal y el caso ENOENT (archivo que todavía/ya
// no está). Lista conservadora — sólo códigos cuya reacción correcta es
// reintentar/continuar, nunca pausar.
const TRANSIENT_CODES = Object.freeze([
    'ENOENT',      // archivo/dir inexistente (fs temporal / race de barrido)
    'ETIMEDOUT',   // timeout de socket/operación
    'ECONNRESET',  // conexión reseteada por el peer
    'ECONNREFUSED',// conexión rechazada (servicio caído transitorio)
    'ENETUNREACH', // red inalcanzable
    'EHOSTUNREACH',// host inalcanzable
    'EAI_AGAIN',   // DNS lookup temporal fallido (getaddrinfo)
    'EPIPE',       // pipe roto (proceso hijo/gh CLI cerró)
    'EBUSY',       // recurso ocupado (fs/lock temporal)
]);

const TRANSIENT_SET = new Set(TRANSIENT_CODES);

// Nombres de error que representan corrupción de estado confirmada.
const CORRUPTION_NAMES = Object.freeze([
    'YAMLException',          // parse-error de YAML existente (js-yaml v4)
    'ConfigSchemaViolation', // schema-violation de config.yaml (lib/config-schema)
    'WorkFileCorruptionError', // work-file de issue existente que no parsea (pulpo.readYaml)
]);

const CORRUPTION_SET = new Set(CORRUPTION_NAMES);

/**
 * Clasifica una excepción en `'transient' | 'corruption' | 'unknown'`.
 *
 * Reglas (en orden):
 *  1. `err` falsy o no-objeto (string suelto, número) → `'unknown'` (fail-safe).
 *  2. `err.code` ∈ TRANSIENT_CODES → `'transient'`.
 *  3. `err.name` ∈ CORRUPTION_NAMES → `'corruption'`.
 *  4. cualquier otra cosa → `'unknown'` (fail-safe → continuar + loguear).
 *
 * @param {*} err
 * @returns {'transient'|'corruption'|'unknown'}
 */
function classify(err) {
    if (!err || typeof err !== 'object') return 'unknown';
    // El código de infra tiene prioridad: un error con `code` transitorio es
    // transitorio aunque por casualidad arrastre un name conocido.
    if (typeof err.code === 'string' && TRANSIENT_SET.has(err.code)) return 'transient';
    if (typeof err.name === 'string' && CORRUPTION_SET.has(err.name)) return 'corruption';
    return 'unknown';
}

module.exports = {
    classify,
    TRANSIENT_CODES,
    CORRUPTION_NAMES,
};

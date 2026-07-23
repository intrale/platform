// =============================================================================
// capabilities.js — Catálogo canónico de permission capabilities cross-provider.
//
// Issue: #3082 (S4 multi-provider) — CA-5, CA-S1 del PO/security.
//
// Este archivo define la **fuente de verdad** de los nombres de capabilities
// que un skill puede declarar como `required_permissions` en su frontmatter.
//
// Por qué frozen Set y no enum string suelto:
//   - CA-S1 obliga a mapear *capabilities* (no flags) → necesitamos vocabulario
//     cerrado para que la matriz capability×(provider, mode) tenga celdas
//     enumerables sin ambigüedad.
//   - Cualquier capability declarada por un skill que NO esté en este Set
//     hace pre-commit (lint de SKILL.md) y boot del pulpo fail-fast (CA-9).
//   - Si más adelante un provider exige una capability nueva, el flujo es:
//       1. Agregar la entrada acá con su descripción.
//       2. Actualizar la matriz en `permission-validator.js` para cada
//          (provider, mode) que la conceda o no.
//       3. Updatear `docs/pipeline-multi-provider/permission-mapping.md`.
//       4. Cubrir con test de paridad (CA-18).
//     CODEOWNERS cubre todo el flujo — sin tres PRs no puede deslizar.
//
// IMPORTANTE: NO agregar capabilities de "conveniencia" tipo `tool_X`. Una
// capability es una *categoría de poder* observable a nivel de syscall o
// API de red, no un nombre de herramienta del harness.
// =============================================================================
'use strict';

// -----------------------------------------------------------------------------
// Diccionario de capabilities. Cada entrada incluye una descripción humana
// que el viewer del audit log y el mensaje de fail-CLOSED muestran al
// operador para que entienda qué se está pidiendo.
//
// Reglas que cumple cada nombre:
//  - snake_case sin números.
//  - Verbo o sustantivo concreto (`file_read`, no `permissive_read`).
//  - Si es un superset (`bash_elevated` incluye `bash`), el comentario lo
//    aclara para que la matriz no duplique semántica.
// -----------------------------------------------------------------------------
const CAPABILITY_CATALOG = Object.freeze({
    // Lectura de archivos dentro del repo y sus directorios "hermanos"
    // alcanzables desde el cwd del agente. Incluye Read/Grep/Glob.
    file_read: 'Leer archivos dentro del repo y rutas accesibles desde el cwd.',

    // Escritura de archivos *dentro* del repo (rutas relativas al ROOT del
    // proyecto). NO incluye escritura fuera del repo (eso es file_write_outside_repo).
    file_write_repo: 'Crear / modificar archivos dentro del repo del proyecto.',

    // Escritura fuera del repo (filesystem global, %APPDATA%, /etc, /tmp).
    // Capability separada porque varios providers la otorgan por defecto en
    // permission-modes laxos pero la deniegan en modes restrictivos.
    file_write_outside_repo: 'Crear / modificar archivos fuera del repo del proyecto.',

    // Ejecución de comandos de shell estándar (Bash, cmd.exe). No incluye
    // escalado de privilegios — eso es bash_elevated.
    bash: 'Ejecutar comandos shell estándar (sin escalada de privilegios).',

    // Ejecución de comandos con privilegios elevados (sudo, runas). Hoy
    // ningún provider la concede automáticamente — está en el catálogo
    // como vocabulario para que skills puedan declararla y los providers
    // las rechacen explícitamente.
    bash_elevated: 'Ejecutar comandos con privilegios elevados (sudo / runas). Supersedes bash.',

    // Tráfico de red hacia URLs públicas. WebFetch, WebSearch, curl outbound,
    // gh CLI contra api.github.com. Subset común concedido por casi todos
    // los providers en modes permisivos.
    network_out: 'Hacer requests HTTP/HTTPS salientes a la red pública.',

    // Tráfico de red entrante (escuchar puertos, recibir webhooks). Ningún
    // provider hoy lo concede al spawn del agente — está acá para que el
    // catálogo cubra el espacio completo y skills que lo necesiten fallen
    // fail-CLOSED si lo declaran.
    network_in: 'Escuchar puertos / aceptar conexiones entrantes.',

    // Spawn de procesos hijos. Bash con &, spawn de subprocesos vía Node,
    // arranque de daemons. Capability separada de `bash` porque un provider
    // puede permitir comandos shell pero sandboxear el spawn (codex
    // --no-confirm es ambiguo en este punto — ver CA-19).
    child_spawn: 'Spawnear procesos hijos (subshells, daemons, comandos en background).',

    // Procesos de larga duración sin output regular (watchers, listeners,
    // sleeps largos). Capability operativa, no de seguridad — discrimina
    // skills "interactivos" de "batch".
    long_running_watcher: 'Mantener procesos de larga duración (watchers, listeners).',

    // Uso de herramientas gated por el harness — Bash en modos plan, Task
    // tools, MCP servers que requieran handshake. Capability semánticamente
    // relevante para distinguir `bypassPermissions` (otorga tool_use_gated)
    // de modes restrictivos como `plan` que la bloquean.
    tool_use_gated: 'Usar herramientas que el harness gestiona detrás de un gate (Task tools, MCP, etc.).',
});

// Wrapper que actúa como Set inmutable. `Object.freeze` sobre un Set NO
// previene .add/.delete (sólo congela las propiedades del wrapper), así que
// envolvemos los métodos mutadores para que tiren TypeError.
function makeImmutableSet(values) {
    const s = new Set(values);
    s.add = () => { throw new TypeError('KNOWN_CAPABILITIES es inmutable — agregar capabilities requiere PR en lib/capabilities.js.'); };
    s.delete = () => { throw new TypeError('KNOWN_CAPABILITIES es inmutable — eliminar capabilities requiere PR en lib/capabilities.js.'); };
    s.clear = () => { throw new TypeError('KNOWN_CAPABILITIES es inmutable.'); };
    return Object.freeze(s);
}
const KNOWN_CAPABILITIES = makeImmutableSet(Object.keys(CAPABILITY_CATALOG));

/**
 * Verifica si un nombre es una capability conocida.
 * @param {string} name
 * @returns {boolean}
 */
function isKnownCapability(name) {
    return typeof name === 'string' && KNOWN_CAPABILITIES.has(name);
}

/**
 * Devuelve la descripción humana de una capability, o null si no existe.
 * @param {string} name
 * @returns {string|null}
 */
function describeCapability(name) {
    return Object.prototype.hasOwnProperty.call(CAPABILITY_CATALOG, name)
        ? CAPABILITY_CATALOG[name]
        : null;
}

/**
 * Valida que `requiredCapabilities` (array declarado por un skill) contenga
 * sólo nombres conocidos. Devuelve `{ ok, unknown[] }`.
 * Caller decide qué hacer con unknown (boot fail-fast, pre-commit reject).
 *
 * @param {string[]} requiredCapabilities
 * @returns {{ok: boolean, unknown: string[]}}
 */
function validateRequiredCapabilities(requiredCapabilities) {
    if (!Array.isArray(requiredCapabilities)) {
        return { ok: false, unknown: [], error: 'required_permissions must be an array' };
    }
    const unknown = requiredCapabilities.filter(c => !KNOWN_CAPABILITIES.has(c));
    return { ok: unknown.length === 0, unknown };
}

module.exports = {
    CAPABILITY_CATALOG,
    KNOWN_CAPABILITIES,
    isKnownCapability,
    describeCapability,
    validateRequiredCapabilities,
};

// =============================================================================
// execution-capabilities.js — Catálogo de CAPACIDAD TÉCNICA DEL MOTOR (#4839)
//
// Eje: ¿el *motor* del provider es capaz de sostener un loop agéntico de
// tool-use real (editar archivos, correr bash/git, iterar)? — NO el eje de
// autorización de permisos (lib/capabilities.js + lib/permission-validator.js).
//
// Son namespaces DISTINTOS y NO deben mezclarse:
//   - lib/capabilities.js         → eje AUTORIZACIÓN ("¿el permission-mode
//                                    autoriza X?"). Ahí vive `tool_use_gated`.
//   - execution-capabilities.js   → eje CAPACIDAD DEL MOTOR (este módulo).
//
// Mezclarlos es un fail-open (guru #1 / SEC-1 de #4839): `cerebras` tiene
// `tool_use_gated` en el eje autorización (no está restringido por modo) pero
// su motor NO sostiene tool-use agéntico (`supports_tool_use: false`). Reusar
// esa capability para el matching de fallback dejaría pasar cerebras en falso.
//
// El validador de fallbacks (lib/agent-models-validate.js) usa este catálogo
// como enum cerrado y aplica matching FAIL-CLOSED: un rol que exige una
// capability sólo acepta providers que la declaran explícitamente; la ausencia
// de declaración se trata como "no ofrece ninguna" (nunca "asumir capaz").
// =============================================================================
'use strict';

// Catálogo canónico frozen de capabilities de EJECUCIÓN. `agentic-tool-use` es
// la primera (y hoy única) entrada. El resto del vocabulario (bash-exec,
// file-edit, git, long-context) queda documentado como futuro: agregarlo acá
// lo habilita automáticamente en el enum del schema y en el matching, sin tocar
// más código. Cada capability nueva DEBE mantener default fail-closed.
const EXECUTION_CAPABILITY_CATALOG = Object.freeze({
  'agentic-tool-use':
    'El motor sostiene un loop agéntico real: editar archivos, correr bash/git e iterar en loop.',
  // Vocabulario futuro (declarar acá cuando se decida granularizar):
  // 'bash-exec':   'Ejecuta comandos de shell de forma confiable.',
  // 'file-edit':   'Edita archivos del repo de forma confiable.',
  // 'git':         'Opera git (branch/commit/push) de forma confiable.',
  // 'long-context':'Sostiene contextos largos sin degradar el loop.',
});

/**
 * Devuelve los nombres de capability del catálogo. Usado para inyectar el enum
 * cerrado en el schema (mismo mecanismo que ALLOWED_LAUNCHERS/OUTPUT_PARSERS),
 * evitando drift schema↔código.
 *
 * @returns {string[]} nombres de capability declarados en el catálogo.
 */
function capabilityNames() {
  return Object.keys(EXECUTION_CAPABILITY_CATALOG);
}

module.exports = {
  EXECUTION_CAPABILITY_CATALOG,
  capabilityNames,
};

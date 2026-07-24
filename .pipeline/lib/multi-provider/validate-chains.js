// =============================================================================
// validate-chains.js — Validación de cadenas multi-provider al boot (#4407 D1).
//
// Objetivo:
//   Detectar cadenas de resolución de modelos rotas (fallback → provider
//   inexistente, refs cruzadas rotas, provider primario ausente) ANTES de que
//   el pulpo arranque con una configuración de resolución inválida y silenciosa.
//   También corre standalone como CLI (`node validate-chains.js`) sin arrancar
//   el pulpo.
//
// Diseño:
//   - `validateChains(config)` es PURO: no hace I/O, recibe el config ya
//     parseado y devuelve `{ ok, errors, skillCount }`.
//   - NO reimplementa resolución de refs: reusa `resolveSkillChain` y
//     `validateCrossReferences` de `agent-models-validate.js`.
//   - `validateCrossReferences(config)` es la fuente AUTORITATIVA de refs rotas
//     (fallback→provider inexistente, default_provider inválido, etc.). El
//     largo de la cadena de `resolveSkillChain` sólo se usa como señal
//     complementaria de "provider primario no resolvió" (la función es
//     silenciosa: devuelve `[]` cuando el primario está roto o falta providers).
//
// Seguridad (CA-6, CRÍTICO):
//   Los providers en agent-models.json tienen `credentials_env` (NOMBRES de
//   env vars de credenciales). Los mensajes de error de este validador SÓLO
//   interpolan `skill / provider / path / message / fix`. NUNCA se hace
//   `JSON.stringify(provider)` ni se resuelve/loguea el VALOR de las env vars
//   de `credentials_env`. Mencionar el nombre de una env var es aceptable;
//   imprimir su contenido sería una fuga.
// =============================================================================
'use strict';

const fs = require('node:fs');
const amv = require('../agent-models-validate');

/**
 * Validador PURO de cadenas multi-provider. No hace I/O.
 *
 * @param {object} config - agent-models.json ya parseado.
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string,fix:string}>, skillCount: number }}
 */
function validateChains(config) {
  const errors = [];

  // 1) Fuente autoritativa de refs cruzadas rotas (fallback→provider
  //    inexistente, default_provider inválido, model fuera de allowlist, etc.).
  //    Estos ya vienen con shape { path, message, fix } accionable.
  errors.push(...amv.validateCrossReferences(config));

  // 2) Recorrer las skills.* y resolver primary + fallbacks. Si la cadena
  //    resuelve vacía, el provider primario está ausente o roto (señal
  //    complementaria — resolveSkillChain es silencioso con []).
  const skills = (config && config.skills && typeof config.skills === 'object')
    ? Object.keys(config.skills)
    : [];

  for (const skill of skills) {
    const chain = amv.resolveSkillChain(config, skill);
    if (!Array.isArray(chain) || chain.length === 0) {
      errors.push({
        path: `#/skills/${skill}/provider`,
        message: `skill "${skill}" no resolvió ninguna cadena (provider primario ausente o roto)`,
        fix: `declarar el provider primario de "${skill}" en la sección providers de agent-models.json`,
      });
    }
  }

  return { ok: errors.length === 0, errors, skillCount: skills.length };
}

/**
 * Wrapper CLI standalone. Carga el config canónico (JSONC-aware) y ejecuta la
 * validación pura. Exit 0 si OK; exit 2 si hay errores (coherente con
 * validateOrExit / EXIT_CODES.INVALID_CONFIG).
 *
 * Seguridad: el path del config es FIJO (`CANONICAL_JSON_PATH`), no se
 * construye desde input no confiable (evita path traversal — CA seguridad #2).
 */
function cliMain() {
  let config;
  try {
    const raw = fs.readFileSync(amv.CANONICAL_JSON_PATH, 'utf8');
    config = amv.parseJsonOrJsonc(raw, amv.CANONICAL_JSON_PATH);
  } catch (err) {
    process.stderr.write(`[validate-chains] FATAL no se pudo cargar ${amv.CANONICAL_JSON_PATH}: ${err.message}\n`);
    process.exit(1);
    return;
  }

  const result = validateChains(config);

  if (result.ok) {
    process.stdout.write(`[validate-chains] Cadenas validadas: ${result.skillCount} skills — ${new Date().toISOString()}\n`);
    process.exit(0);
    return;
  }

  for (const e of result.errors) {
    process.stderr.write(`[validate-chains] ${e.path}: ${e.message}\n  fix: ${e.fix}\n`);
  }
  process.exit(2);
}

module.exports = { validateChains };

if (require.main === module) cliMain();

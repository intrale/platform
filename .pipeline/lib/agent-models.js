// =============================================================================
// agent-models.js — Loader fino para `.pipeline/agent-models.json` (#3087 CA-A-3)
//
// Wrapper liviano sobre `agent-models-validate.js` que expone:
//   - loadAndValidate({jsonPath?})        → { ok, config, errors }
//   - resolveModel(skill, {config?})      → { provider, launcher, model, model_override }
//   - allowlistedFieldsForDiff(state)     → state normalizado a { provider, model,
//                                            model_override, launcher } por skill
//
// Por qué un loader propio en vez de hablar directo con `agent-models-validate.js`:
//   1. El loader devuelve datos "listos para consumo" (resolver el modelo del skill
//      requiere mergear `provider.model` + `skill.model_override`, lógica que no
//      pertenece al validador).
//   2. La allowlist de campos para diff (CA-S1 / CA-B-1) vive acá centralizada — los
//      callers (alert builder, futuros consumidores) no tienen que conocer la lista
//      a mano y arriesgar drift.
//   3. Centralizar el contrato de `loadAndValidate()` permite migrar el almacenamiento
//      del JSON sin tocar callers (si mañana viene .yaml, schema split, etc.).
//
// Tests: `lib/__tests__/agent-models.test.js` (creado en #3081/#3072) sigue cubriendo
// la validación; este loader se cubre con tests de borde en `agent-models-change-alert.test.js`.
// =============================================================================

'use strict';

const path = require('path');
const validator = require('./agent-models-validate');

// Allowlist canónica de campos del schema que se pueden mostrar en notificaciones
// post-hoc (Telegram, audio narrado). Cualquier campo NO listado acá se omite del
// diff por construcción para evitar filtración (CA-S1 / CA-B-1).
//
// Si en el futuro alguien agrega un campo nuevo al schema y quiere que aparezca
// en avisos, lo agrega acá explícitamente con análisis de seguridad, no por accidente.
const ALLOWLISTED_FIELDS_FOR_NOTIFICATION = Object.freeze([
    'provider',
    'model',
    'model_override',
    'launcher',
]);

// =============================================================================
// #3076 (H4) — getDeterministicSkills(): single-source-of-truth para la
// allowlist de skills determinísticos.
//
// Antes de #3076 la lista vivía duplicada en 4 archivos (`providers/
// deterministic.js`, `quota-exhausted.js`, `rest-mode-window.js`,
// `dashboard-slices.js`) y el test cross-source `deterministic-skills-
// coherence.test.js` impedía drift. Pero un skill nuevo seguía requiriendo
// tocar código en 4 lugares — el objetivo de H4 es que basta editar
// `agent-models.json`.
//
// Comportamiento:
//   - Lee `agent-models.json` vía `loadAndValidate()` (que reutiliza
//     `agent-models-validate.js` con Ajv 2020-12).
//   - Devuelve un `Set<string>` congelado con los skills cuyo `provider`
//     es `deterministic`.
//   - Cachea el resultado al primer require — config estática, cambios
//     requieren restart del pulpo (R5 aceptado en CA del PO).
//   - Si el JSON no valida o no existe (caso edge: tests con tmpdir,
//     checkout sin H1 mergeado), devuelve un Set vacío congelado. El boot
//     del pulpo ya hace fail-fast vía `agent-models-validate.js`, así que
//     en producción esto no se da. Tests que necesitan refrescar el cache
//     usan `_resetDeterministicSkillsCacheForTests()`.
//
// Defensa I4 (path-traversal): el resultado se usa para validar el nombre
// del skill ANTES de spawn (ver `providers/deterministic.js`). Como el JSON
// pasa por schema con `additionalProperties:false` y los nombres de skills
// están restringidos por patrón (`^[a-z0-9-]+$` en el schema), la allowlist
// resultante es segura para concatenar en `path.join`.
// =============================================================================
let _deterministicSkillsCache = null;

function _computeDeterministicSkills(options) {
    const result = loadAndValidate(options);
    const out = new Set();
    if (result && result.ok && result.config && result.config.skills) {
        for (const [name, def] of Object.entries(result.config.skills)) {
            if (def && def.provider === 'deterministic') out.add(name);
        }
    }
    return Object.freeze(out);
}

/**
 * Devuelve el set congelado de skills con `provider: deterministic` en
 * `agent-models.json`. Cacheado al primer require.
 *
 * @param {object} [options]
 * @param {string} [options.jsonPath] — override (tests). NO usa cache.
 * @param {string} [options.schemaPath] — override (tests). NO usa cache.
 * @param {boolean} [options.forceReload] — fuerza recálculo sin actualizar cache.
 * @returns {Set<string>} Set congelado de nombres de skill.
 */
function getDeterministicSkills(options) {
    const _opts = options || {};
    if (_opts.jsonPath || _opts.schemaPath || _opts.forceReload) {
        return _computeDeterministicSkills(_opts);
    }
    if (_deterministicSkillsCache) return _deterministicSkillsCache;
    _deterministicSkillsCache = _computeDeterministicSkills(_opts);
    return _deterministicSkillsCache;
}

/**
 * Reset del cache. Solo para tests — el pipeline en producción usa config
 * estática y no requiere invalidación.
 */
function _resetDeterministicSkillsCacheForTests() {
    _deterministicSkillsCache = null;
}

/**
 * Carga y valida `agent-models.json` reusando el validador canónico.
 * No lanza — devuelve `{ ok, config, errors }` para que el caller decida.
 *
 * @param {object} [options]
 * @param {string} [options.jsonPath] — override del path default
 * @param {string} [options.schemaPath] — override del schema default
 * @returns {{ok: boolean, config?: object, errors: object[], exitCode: number}}
 */
function loadAndValidate(options) {
    const _opts = options || {};
    const jsonPath = _opts.jsonPath || validator.CANONICAL_JSON_PATH;
    const schemaPath = _opts.schemaPath || validator.CANONICAL_SCHEMA_PATH;
    return validator.validate(jsonPath, { schemaPath });
}

/**
 * Devuelve la tupla efectiva (provider, launcher, model, model_override) para un skill.
 * Hace el merge entre el provider declarado por el skill y el modelo del provider.
 * El `model_override` del skill, si existe, gana sobre el modelo del provider.
 *
 * No lanza si el skill no existe — devuelve `null` para que el caller decida.
 *
 * @param {string} skill
 * @param {object} [options]
 * @param {object} [options.config] — config ya validado (si no se pasa, se carga)
 * @returns {{provider: string, launcher: string, model: string, model_override: string|null}|null}
 */
function resolveModel(skill, options) {
    const _opts = options || {};
    let config = _opts.config;
    if (!config) {
        const result = loadAndValidate(_opts);
        if (!result.ok) return null;
        config = result.config;
    }

    if (!config || !config.skills || !config.skills[skill]) return null;
    const skillDef = config.skills[skill] || {};
    const providerKey = skillDef.provider || config.default_provider;
    const providerDef = (config.providers && config.providers[providerKey]) || {};

    const launcher = providerDef.launcher || null;
    const baseModel = providerDef.model || null;
    const modelOverride = skillDef.model_override || null;

    return {
        provider: providerKey,
        launcher,
        model: modelOverride || baseModel,
        model_override: modelOverride,
    };
}

/**
 * Toma un config completo y devuelve una vista "diff-friendly":
 *   { skills: { <skillName>: { provider, model, model_override, launcher } } }
 *
 * Solo proyecta los campos en `ALLOWLISTED_FIELDS_FOR_NOTIFICATION` (CA-S1).
 * Campos como `credentials_env`, `spawn_args_template`, `permissions_mode` quedan
 * fuera por construcción — se cambian por commit pero NO viajan a Telegram.
 *
 * Si `config` es nullish o no tiene `skills`, devuelve `{ skills: {} }`.
 *
 * @param {object} config
 * @returns {{skills: Record<string, {provider:string, model:string|null, model_override:string|null, launcher:string|null}>}}
 */
function allowlistedFieldsForDiff(config) {
    const out = { skills: {} };
    if (!config || !config.skills || typeof config.skills !== 'object') return out;

    for (const skillName of Object.keys(config.skills)) {
        const resolved = resolveModel(skillName, { config });
        if (!resolved) continue;
        // Mantener exactamente las 4 claves de la allowlist, en orden estable.
        out.skills[skillName] = {
            provider: resolved.provider,
            model: resolved.model,
            model_override: resolved.model_override,
            launcher: resolved.launcher,
        };
    }
    return out;
}

module.exports = {
    ALLOWLISTED_FIELDS_FOR_NOTIFICATION,
    loadAndValidate,
    resolveModel,
    allowlistedFieldsForDiff,
    // #3076 (H4) — single-source-of-truth para skills determinísticos.
    getDeterministicSkills,
    _resetDeterministicSkillsCacheForTests,
    // Re-exports cómodos para callers que quieren validar sin pasar por el loader.
    CANONICAL_JSON_PATH: validator.CANONICAL_JSON_PATH,
    CANONICAL_SCHEMA_PATH: validator.CANONICAL_SCHEMA_PATH,
};

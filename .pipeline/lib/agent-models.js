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
    // Re-exports cómodos para callers que quieren validar sin pasar por el loader.
    CANONICAL_JSON_PATH: validator.CANONICAL_JSON_PATH,
    CANONICAL_SCHEMA_PATH: validator.CANONICAL_SCHEMA_PATH,
};

// =============================================================================
// config-schema.js — JSON Schema + validador de config.yaml (#3941)
// =============================================================================
//
// EP5-H4. `config.yaml` (~46KB, >30 módulos) se cargaba sin validar: un typo en
// una clave crítica parsea OK pero produce config errónea silenciosa (ej. un
// umbral de circuit breaker mal escrito → el CB nunca dispara). Este módulo
// valida el objeto ya parseado contra un JSON Schema con `ajv` y devuelve
// errores REDACTADOS (path + tipo esperado, NUNCA el valor crudo — SEC-2).
//
// Estrategia del schema (SEC-4):
//   - LENIENT global: `additionalProperties: true` en la raíz y en cada bloque,
//     para no frenar el boot ante evolución legítima del config (claves nuevas
//     no-críticas pasan sin tocar el schema).
//   - ESTRICTO en claves CRÍTICAS conocidas (control de flujo / seguridad):
//     circuit_breaker, resource_limits (umbrales + priority windows),
//     concurrencia, handoff, pipelines.*.skills_por_fase, multi_provider.order.
//     Un typo que tire una de estas claves la vuelve `required` faltante; un
//     valor del tipo equivocado lo caza la validación de tipo/enum.
//
// SEC-1: este módulo NO toca js-yaml ni su schema de deserialización. Sólo
// valida un objeto ya parseado. La carga segura (safe-by-default v4) es
// responsabilidad de `pulpo.loadConfig`.
//
// El módulo es PURO respecto del FS/red: compila el schema una vez al require y
// expone `validateConfig(obj)`. `ConfigSchemaViolation` se exporta para que el
// clasificador (`lib/error-classifier`) y `pulpo` reconozcan la corrupción.
// =============================================================================
'use strict';

const Ajv = require('ajv');

// -----------------------------------------------------------------------------
// Error tipado de schema-violation (clasificado como 'corruption')
// -----------------------------------------------------------------------------

class ConfigSchemaViolation extends Error {
    /**
     * @param {string} message - mensaje YA redactado (sin valores crudos).
     * @param {Array<object>} [errors] - errores redactados (path + detail).
     */
    constructor(message, errors) {
        super(message);
        this.name = 'ConfigSchemaViolation';
        this.errors = Array.isArray(errors) ? errors : [];
    }
}

// -----------------------------------------------------------------------------
// Providers válidos para multi_provider.order (calidad primero, costo después).
// Acepta tanto los ids cortos como los canónicos usados en agent-models.json.
// -----------------------------------------------------------------------------

const PROVIDER_ENUM = Object.freeze([
    'claude', 'anthropic',
    'codex', 'openai-codex',
    'groq',
    'gemini', 'gemini-google',
    'cerebras',
    'nvidia-nim',
]);

// -----------------------------------------------------------------------------
// JSON Schema (Draft-07 compatible, ajv v8)
// -----------------------------------------------------------------------------

const SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: {
        // --- circuit_breaker: umbrales del CB de infra (#2305/#3940) ---------
        circuit_breaker: {
            type: 'object',
            additionalProperties: true,
            required: ['infra_escalate_threshold', 'auto_resume_ok_threshold'],
            properties: {
                infra_escalate_threshold: { type: 'integer', minimum: 1 },
                auto_resume_ok_threshold: { type: 'integer', minimum: 1 },
            },
        },

        // --- resource_limits: umbrales de presión + priority windows ---------
        resource_limits: {
            type: 'object',
            additionalProperties: true,
            required: [
                'green_max_percent',
                'yellow_max_percent',
                'orange_max_percent',
                'red_max_percent',
                'priority_windows_activation_threshold',
                'max_concurrent_devs',
            ],
            properties: {
                green_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                yellow_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                orange_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                red_max_percent: { type: 'integer', minimum: 0, maximum: 100 },
                priority_windows_activation_threshold: { type: 'integer', minimum: 1 },
                priority_windows_safety_timeout_hours: { type: 'number', minimum: 0 },
                max_concurrent_devs: { type: 'integer', minimum: 0 },
            },
        },

        // --- concurrencia: instancias simultáneas por rol (enteros ≥ 0) ------
        concurrencia: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0 },
        },

        // --- handoff: cross-agente (#2993) -----------------------------------
        handoff: {
            type: 'object',
            additionalProperties: true,
            required: ['enabled', 'kill_switch'],
            properties: {
                enabled: { type: 'boolean' },
                kill_switch: { type: 'boolean' },
                max_section_kb: { type: 'integer', minimum: 1 },
                retention_days: { type: 'integer', minimum: 1 },
                inject_in_phases: { type: 'array', items: { type: 'string' } },
            },
        },

        // --- pipelines: cada pipeline DEBE declarar skills_por_fase ----------
        pipelines: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                additionalProperties: true,
                required: ['skills_por_fase'],
                properties: {
                    fases: { type: 'array', items: { type: 'string' } },
                    skills_por_fase: {
                        type: 'object',
                        additionalProperties: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },

        // --- multi_provider: orden de fallback (opcional en config.yaml; la
        //     fuente de verdad operativa es agent-models.json, pero si aparece
        //     acá se valida estrictamente el enum de providers — SEC-4) -------
        multi_provider: {
            type: 'object',
            additionalProperties: true,
            properties: {
                order: {
                    type: 'array',
                    items: { type: 'string', enum: PROVIDER_ENUM },
                },
            },
        },
    },
};

// -----------------------------------------------------------------------------
// Compilación (una sola vez al require)
// -----------------------------------------------------------------------------

// `verbose: false` (default) → los errores de ajv NO incluyen `error.data` (el
// valor crudo). Defensa SEC-2 en la fuente; igual redactamos al construir el
// mensaje. `allErrors: true` para reportar todos los typos de una.
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateFn = ajv.compile(SCHEMA);

// -----------------------------------------------------------------------------
// Redacción de errores (SEC-2): path + tipo esperado, NUNCA el valor crudo
// -----------------------------------------------------------------------------

/**
 * Transforma los errores crudos de ajv en objetos redactados seguros para
 * loguear o mandar por Telegram. Sólo expone:
 *   - `path`: ubicación de la clave (instancePath), NO el valor.
 *   - `keyword`: regla que falló.
 *   - `detail`: descripción del tipo/enum/clave esperado (sin valor crudo).
 *
 * NUNCA incluye el valor que falló. Los nombres de clave (missingProperty /
 * additionalProperty) y los enums permitidos provienen del SCHEMA, no del
 * input, por lo que son seguros de exponer.
 *
 * @param {Array<object>} ajvErrors
 * @returns {Array<{path: string, keyword: string, detail: string}>}
 */
function redactErrors(ajvErrors) {
    if (!Array.isArray(ajvErrors)) return [];
    return ajvErrors.map((e) => {
        const params = e.params || {};
        const path = e.instancePath && e.instancePath.length ? e.instancePath : '(root)';
        let detail;
        switch (e.keyword) {
            case 'type':
                detail = `tipo esperado: ${params.type}`;
                break;
            case 'enum':
                detail = `valor fuera del enum permitido: [${(params.allowedValues || []).join(', ')}]`;
                break;
            case 'required':
                detail = `falta clave requerida: '${params.missingProperty}'`;
                break;
            case 'additionalProperties':
                detail = `clave no permitida: '${params.additionalProperty}'`;
                break;
            case 'minimum':
                detail = `mínimo permitido: ${params.limit}`;
                break;
            case 'maximum':
                detail = `máximo permitido: ${params.limit}`;
                break;
            default:
                // `e.message` de ajv describe la regla (ej. "must be integer"),
                // NO incluye el valor crudo cuando verbose:false.
                detail = e.message || e.keyword;
        }
        return { path, keyword: e.keyword, detail };
    });
}

/**
 * Valida un objeto config ya parseado contra el schema.
 *
 * @param {*} obj
 * @returns {{valid: boolean, errors: Array<{path:string, keyword:string, detail:string}>}}
 */
function validateConfig(obj) {
    // Un config que no es objeto (null, array, string) es corrupción de raíz.
    const valid = validateFn(obj);
    return {
        valid: !!valid,
        errors: valid ? [] : redactErrors(validateFn.errors),
    };
}

/**
 * Formatea errores redactados en una línea legible (para log/Telegram).
 * @param {Array<{path:string, detail:string}>} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    return errors.map((e) => `${e.path}: ${e.detail}`).join('; ');
}

module.exports = {
    validateConfig,
    redactErrors,
    formatErrors,
    ConfigSchemaViolation,
    PROVIDER_ENUM,
    SCHEMA,
};

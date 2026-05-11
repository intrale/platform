// =============================================================================
// quota-adapters/index.js — Dispatch multi-provider para `quotaUsage` (#3092).
//
// Punto de entrada único para el resto del pipeline. Reemplaza el llamado
// directo a `computeQuota(metricsDir, activityLog)` (Anthropic-only legacy)
// por `quotaUsage(provider, sessionData)` (multi-provider).
//
// Defensa en profundidad (security CA-#1 + #6):
//
//   1. ALLOWED_PROVIDERS hardcoded — el `provider` se valida ANTES de
//      cualquier dispatch o lookup. Cualquier valor fuera de la allowlist
//      devuelve `adapterStatus: 'error'` con motivo. NO se construye path,
//      no se carga adapter dinámicamente, no se hace string concat.
//
//   2. Fail-secure — si el adapter tira excepción inesperada, devolvemos
//      `adapterStatus: 'error'` con `errorReason` no-null y `pct: null`.
//      Nunca `pct: 0` silencioso (eso daría luz verde a degradación).
//
//   3. Cálculo offline — los adapters NO hacen requests HTTP a APIs de
//      providers (security CA-#6). Todo se computa desde activity-log
//      + estado persistido en `.pipeline/metrics/`.
//
// Forward-compat (UX G2): el caller puede pedir un `breakdown[]` con
// múltiples providers en simultáneo. M2a deja la puerta abierta pero sólo
// implementa Anthropic real; el resto son stubs.
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

// Allowlist hardcoded de providers permitidos. Coincide con los providers
// declarados en `agent-models.schema.json` (refinamiento Guru #1 — fuente
// única de verdad replicada acá para defensa en profundidad).
//
// Si en el futuro se suma un provider nuevo, se agrega acá Y se crea su
// adapter en este directorio. Cualquier `provider` fuera de esta lista
// hace fail-fast con `adapterStatus: 'error'`.
const ALLOWED_PROVIDERS = Object.freeze([
    'anthropic',
    'openai-codex',
    'gemini',
    'ollama',
    'deterministic',
]);

/**
 * Lookup de adapter por provider. Carga lazy (require dentro del switch) para
 * evitar carga inicial pesada cuando solo se usa un provider.
 *
 * @param {string} provider
 * @returns {Function} adapter(sessionData) => QuotaResult
 */
function getAdapter(provider) {
    switch (provider) {
        case 'anthropic':       return require('./anthropic');
        case 'openai-codex':    return require('./openai-codex');
        case 'gemini':          return require('./gemini');
        case 'ollama':          return require('./ollama');
        case 'deterministic':   return require('./deterministic');
        default:                return null; // unreachable — la allowlist ya filtró.
    }
}

/**
 * API pública multi-provider. Devuelve un QuotaResult uniforme.
 *
 * @param {string} provider     Debe estar en ALLOWED_PROVIDERS.
 * @param {Object} sessionData  Contexto del adapter:
 *   {
 *     metricsDir:        string,    path absoluto a .pipeline/metrics
 *     activityLogPath:   string,    path absoluto a .claude/activity-log.jsonl
 *     configLimitHours?: number,    límite del config (override)
 *     budgetUsd?:        number,    budget mensual (OpenAI/Codex)
 *     now?:              number,    timestamp para tests determinísticos
 *   }
 * @returns {QuotaResult}
 */
function quotaUsage(provider, sessionData) {
    // 1. Validar tipo crudo.
    if (typeof provider !== 'string' || provider.length === 0) {
        return emptyResult('(invalid)', ADAPTER_STATUS.ERROR,
            'provider debe ser string no vacío');
    }

    // 2. Allowlist hardcoded — defensa contra path-traversal / poisoning.
    if (!ALLOWED_PROVIDERS.includes(provider)) {
        return emptyResult(provider, ADAPTER_STATUS.ERROR,
            `provider "${provider}" no está en allowlist [${ALLOWED_PROVIDERS.join(', ')}]`);
    }

    // 3. Validar sessionData mínimamente.
    if (!sessionData || typeof sessionData !== 'object') {
        return emptyResult(provider, ADAPTER_STATUS.ERROR,
            'sessionData debe ser objeto');
    }

    // 4. Dispatch al adapter. Cualquier excepción del adapter es
    //    fail-secure: NO propagamos, devolvemos status 'error'.
    const adapter = getAdapter(provider);
    if (typeof adapter !== 'function') {
        return emptyResult(provider, ADAPTER_STATUS.ERROR,
            `adapter para "${provider}" no encontrado`);
    }

    try {
        const result = adapter(sessionData);
        // Defensa: si el adapter devuelve algo que no es objeto, lo tomamos
        // como bug del adapter, no del caller — devolvemos 'error'.
        if (!result || typeof result !== 'object') {
            return emptyResult(provider, ADAPTER_STATUS.ERROR,
                `adapter "${provider}" devolvió shape inválido`);
        }
        return result;
    } catch (err) {
        // Sanitizar el mensaje — no propagamos stack traces ni paths absolutos.
        const reason = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
        return emptyResult(provider, ADAPTER_STATUS.ERROR,
            `adapter "${provider}" lanzó excepción: ${reason}`);
    }
}

module.exports = {
    quotaUsage,
    ALLOWED_PROVIDERS,
};

'use strict';

// =============================================================================
// glitch-retry.js — Política PURA de reintento del glitch del CLI de Anthropic
// "Usage credits required for 1M context" (#3950 / EP7-H3, sobre #3506/#3508).
//
// Sin side effects: no lee env (salvo el helper inyectable readConfiguredModel,
// que solo lee un path explícito), no escribe estado, no spawnea, no loggea.
// El Pulpo (`ejecutarClaude`) orquesta; este módulo solo decide. Mismo estilo
// que `anthropic-1m-workaround.js`: constantes arriba, funciones puras, exports
// explícitos al final.
//
// Diseño del retry (CA-1 / CA-2 / CA-3):
//   intento 1 (contexto heredado [1m])
//     └─ glitch → backoff 3s → intento 2 (mismo spawn)
//          └─ glitch → backoff 6s → intento 3 (mismo spawn)
//               └─ glitch → intento 4 con --model sin [1m] (contexto estándar)
//                    └─ glitch → recién acá el mensaje al usuario (give_up)
// =============================================================================

const fs = require('fs');

// SR-C.1 — límite duro de reintentos same-context como CONSTANTE (no env).
const MAX_SAME_CONTEXT_RETRIES = 2;

// SR-C.2 — backoff acotado y creciente. Tope implícito <= MAX_BACKOFF_MS.
// BACKOFF_MS[0] aplica tras el intento 1, BACKOFF_MS[1] tras el intento 2.
const BACKOFF_MS = [3000, 6000];
const MAX_BACKOFF_MS = 10000;

// errorClass que dispara el retry. Cualquier otro NO reintenta (CA-5).
const GLITCH_ERROR_CLASS = 'cli_1m_context_glitch';

// SR-A.1 — whitelist estricta del valor de --model ANTES de pasarlo a cmdArgs.
// El spawn Anthropic puede correr con shell:true (cmd-shim / path-fallback),
// así que metacaracteres en el modelo escalarían a cmd.exe. Solo alfanum,
// punto, guion, guion bajo y corchetes (para el sufijo [1m]); 1..64 chars.
const MODEL_WHITELIST = /^[A-Za-z0-9._\-\[\]]{1,64}$/;
const MODEL_MAX_LEN = 64;

// SR-A.3 — strip ANCLADO del sufijo de contexto 1M. NO regex genérico sobre
// brackets: solo `[1m]` al final del string.
const ONE_M_SUFFIX = /\[1m\]$/;

// -----------------------------------------------------------------------------
// decide({ attempt, errorClass }) → { action, backoffMs }
//
// `attempt` es el número del intento que ACABA de fallar (1-based). `errorClass`
// es la clasificación de ESE intento. Decide el próximo paso:
//   - errorClass !== GLITCH_ERROR_CLASS → give_up (CA-5: nunca reintenta otro error)
//   - attempt 1..MAX_SAME_CONTEXT_RETRIES con glitch → retry_same + BACKOFF_MS[attempt-1]
//   - attempt MAX_SAME_CONTEXT_RETRIES+1 con glitch → retry_standard (backoff 0)
//   - attempt posterior con glitch → give_up
//
// action ∈ { 'retry_same', 'retry_standard', 'give_up' }.
// -----------------------------------------------------------------------------
function decide(opts) {
    const o = opts || {};
    const attempt = Number.isInteger(o.attempt) && o.attempt >= 1 ? o.attempt : 1;
    const errorClass = o.errorClass;

    // CA-5 — el loop reintenta ÚNICAMENTE ante el glitch 1M; cualquier otro
    // error (o ninguno) termina el ciclo de retry.
    if (errorClass !== GLITCH_ERROR_CLASS) {
        return { action: 'give_up', backoffMs: 0 };
    }

    if (attempt <= MAX_SAME_CONTEXT_RETRIES) {
        const raw = BACKOFF_MS[attempt - 1];
        const backoffMs = Math.min(
            Number.isFinite(raw) && raw >= 0 ? raw : BACKOFF_MS[BACKOFF_MS.length - 1],
            MAX_BACKOFF_MS
        );
        return { action: 'retry_same', backoffMs };
    }

    if (attempt === MAX_SAME_CONTEXT_RETRIES + 1) {
        // Agotados los same-context: degradar a contexto estándar (CA-2).
        return { action: 'retry_standard', backoffMs: 0 };
    }

    // Intento estándar también falló → recién acá el usuario ve el error (CA-3).
    return { action: 'give_up', backoffMs: 0 };
}

// -----------------------------------------------------------------------------
// resolveStandardModel({ rawModel }) → { model, reason }
//
// Valida y deriva el valor de --model para el intento estándar (CA-2 / SR-A).
// Orden SR-A.2: typeof + cap de longitud + whitelist ANTES de strippear. Si
// algo no valida → model:null (el caller OMITE --model y mantiene herencia).
// El strip del sufijo [1m] es anclado (SR-A.3). NO hardcodea el nombre del
// modelo: parte del valor configurado.
// -----------------------------------------------------------------------------
function resolveStandardModel(opts) {
    const o = opts || {};
    const rawModel = o.rawModel;

    if (typeof rawModel !== 'string') {
        return { model: null, reason: 'not_a_string' };
    }
    if (rawModel.length === 0 || rawModel.length > MODEL_MAX_LEN) {
        return { model: null, reason: 'length_out_of_range' };
    }
    if (!MODEL_WHITELIST.test(rawModel)) {
        return { model: null, reason: 'failed_whitelist' };
    }

    const stripped = rawModel.replace(ONE_M_SUFFIX, '');
    if (stripped.length === 0) {
        return { model: null, reason: 'empty_after_strip' };
    }
    // Defensa extra: el resultado del strip también debe ser un modelo limpio.
    if (!MODEL_WHITELIST.test(stripped)) {
        return { model: null, reason: 'failed_whitelist_after_strip' };
    }
    return { model: stripped, reason: 'ok' };
}

// -----------------------------------------------------------------------------
// readConfiguredModel({ settingsPath, fs }) → { rawModel, reason }
//
// Lee defensivamente el modelo configurado del settings.json del usuario
// (SR-B). Inyectable (`fs` y `settingsPath`) para tests. Archivo ausente,
// corrupto, sin campo `model` o con valor no-string/desmedido → rawModel:null
// con reason; NUNCA tira. El caller pasa el rawModel a resolveStandardModel.
// -----------------------------------------------------------------------------
function readConfiguredModel(opts) {
    const o = opts || {};
    const settingsPath = o.settingsPath;
    const fsImpl = o.fs || fs;

    if (typeof settingsPath !== 'string' || settingsPath.length === 0) {
        return { rawModel: null, reason: 'no_path' };
    }
    let raw;
    try {
        raw = fsImpl.readFileSync(settingsPath, 'utf8');
    } catch (e) {
        return { rawModel: null, reason: 'read_error' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { rawModel: null, reason: 'parse_error' };
    }
    const model = parsed && typeof parsed === 'object' ? parsed.model : undefined;
    if (typeof model !== 'string') {
        return { rawModel: null, reason: 'no_model_field' };
    }
    if (model.length === 0 || model.length > MODEL_MAX_LEN) {
        return { rawModel: null, reason: 'length_out_of_range' };
    }
    return { rawModel: model, reason: 'ok' };
}

// -----------------------------------------------------------------------------
// formatAttemptLog({ attempt, context, model, backoffMs }) → string
//
// Línea canónica de log por intento (CA-2). El `model` debe venir YA validado
// (post resolveStandardModel); si es null/ausente se reporta `inherited`
// (intento que hereda el modelo del settings global). Sin contenido del prompt.
//   [anthropic-1m] attempt=N context=1m|standard model=<validado> backoff=<ms>
// -----------------------------------------------------------------------------
function formatAttemptLog(opts) {
    const o = opts || {};
    const attempt = Number.isInteger(o.attempt) && o.attempt >= 1 ? o.attempt : 1;
    const context = o.context === 'standard' ? 'standard' : '1m';
    const model = typeof o.model === 'string' && o.model.length > 0 ? o.model : 'inherited';
    const backoffMs = Number.isFinite(o.backoffMs) && o.backoffMs >= 0 ? o.backoffMs : 0;
    return `[anthropic-1m] attempt=${attempt} context=${context} model=${model} backoff=${backoffMs}`;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    decide,
    resolveStandardModel,
    readConfiguredModel,
    formatAttemptLog,

    // Constantes (consumidas por el orquestador y los tests).
    MAX_SAME_CONTEXT_RETRIES,
    BACKOFF_MS,
    MAX_BACKOFF_MS,
    GLITCH_ERROR_CLASS,
    MODEL_WHITELIST,
    MODEL_MAX_LEN,
    ONE_M_SUFFIX,
};

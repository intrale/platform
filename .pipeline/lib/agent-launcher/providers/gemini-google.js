// =============================================================================
// providers/gemini-google.js — Handler real del provider Google Gemini
//
// Implementa el contrato del wrapper de agent-launcher para Antigravity CLI
// (`agy --print`) usando OAuth. No existe fallback al cliente retirado.
//
// Wiring acá:
//   1) detectLauncher — binario nativo configurado, ubicación oficial Windows
//      o fallback al PATH.
//   2) buildSpawn — traduce los args legacy del pulpo (estilo Claude CLI:
//      `-p`, `--system-prompt-file`, `--output-format stream-json`) al shape
//      que entiende Antigravity (`--print --model <model>`).
//      Gemini NO tiene flag de system prompt, así que el contenido del
//      `--system-prompt-file` se foldea al inicio del prompt.
//   3) parseTokensFromLog — Gemini con `-o json` devuelve UN ÚNICO objeto JSON
//      (no JSONL streaming como Codex). Agregamos los tokens de TODOS los
//      modelos reportados en `stats.models.<model>.tokens` (router + main).
//   4) detectQuotaExhausted — inspecciona el objeto `error` del JSON y matchea
//      por shape estructural (status/code/reason normalizados a lowercase)
//      contra la allowlist canónica en `quota-exhausted.js`
//      (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['gemini-google']`).
//
// Auth: OAuth via `agy`; nunca API key. El health exige AGY_LICENSE_READY=1
// para no declarar disponible una instalación sin licencia/billing.
//
// Seguridad:
//  - Ruta oficial hardcoded y override AGY_BIN, sin require dinámico.
//  - Args como argv estricto y shell:false.
//  - Detección de cuota SOLO por shape estructural sobre campos dedicados de
//    error (status/code/reason). NUNCA substring sobre `response` (canal de
//    contenido controlado por el modelo).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
// #5795 — contrato compartido de la clase cerrada 'authentication_rejected'.
const authRejection = require('../auth-rejection');

// -----------------------------------------------------------------------------
// detectLauncher — AGY_BIN, ubicación oficial Windows o PATH.
// -----------------------------------------------------------------------------
function detectLauncher() {
    if (process.env.AGY_BIN) {
        return { kind: 'configured-native', cmd: process.env.AGY_BIN, prefixArgs: [], shell: false };
    }
    const windowsBin = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    if (process.platform === 'win32' && fs.existsSync(windowsBin)) {
        return { kind: 'native-exe', cmd: windowsBin, prefixArgs: [], shell: false };
    }
    return { kind: 'path-fallback', cmd: 'agy', prefixArgs: [], shell: false };
}

let cachedLauncher = null;
function getLauncher() {
    if (!cachedLauncher) cachedLauncher = detectLauncher();
    return cachedLauncher;
}
function _setLauncherForTesting(launcher) { cachedLauncher = launcher; }
function _resetLauncherCacheForTesting() { cachedLauncher = null; }

// -----------------------------------------------------------------------------
// translateClaudeArgsToGemini — extrae prompt y system file del args estilo
// Claude CLI y arma el argv de Gemini. Args desconocidos se descartan
// silenciosamente (el shape de stream-json/--verbose/--permission-mode no
// aplica a Gemini).
//
// Contrato de entrada (lo que el pulpo construye en pulpo.js:5846):
//   ['-p', userPrompt, '--system-prompt-file', systemFile, ...]
//
// Contrato de salida (agy 1.1.x / 1.2.x — ver #7290 por el shape de --print):
//   ['--print', '--dangerously-skip-permissions', '--print-timeout', timeout,
//    '--model', model?]
// El payload real se pipea por STDIN para evitar ENAMETOOLONG en Windows.
// -----------------------------------------------------------------------------
function foldGeminiPayload(args, env, fsImpl) {
    const _fs = fsImpl || fs;
    let userPrompt = null;
    let systemFile = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-p') { userPrompt = args[i + 1]; i++; }
        else if (a === '--system-prompt-file') { systemFile = args[i + 1]; i++; }
    }
    // Foldear el system file al prompt (Gemini no tiene --system).
    let prompt = typeof userPrompt === 'string' ? userPrompt : '';
    if (systemFile && typeof systemFile === 'string') {
        let systemText = null;
        try { systemText = _fs.readFileSync(systemFile, 'utf8'); } catch { systemText = null; }
        if (systemText && systemText.trim()) {
            prompt = `${systemText.trim()}\n\n${prompt}`;
        }
    }
    return prompt;
}

// -----------------------------------------------------------------------------
// MODEL_ENV_VAR / resolveModelFromEnv — precedencia EXPLÍCITA del modelo (#6334,
// cerrado en #6858).
//
// El modelo llega al handler por UNA sola variable: `GEMINI_MODEL`, que es la
// que declara `PROVIDER_MODEL_ENV['gemini-google']` en lib/build-child-env.js y
// la que inyecta agent-launcher.js cuando la propagación (#6272) aplica. Hasta
// #6858 el handler leía `env.AGY_MODEL || env.GEMINI_MODEL`: como el pulpo nunca
// propaga `AGY_MODEL`, un valor exportado en el entorno del operador (o heredado
// por un path sin aislar) PISABA al modelo propagado y la traza del launcher
// afirmaba un modelo que no corrió.
//
// Regla: `AGY_MODEL` se IGNORA siempre. Si está presente se reporta en
// `modelTrace.ignoredEnv` para que el launcher deje constancia en el log.
// Sin `GEMINI_MODEL` no se pasa `--model` y el CLI usa su propio default.
//
// Canal de esfuerzo: el sufijo `-high/-medium/-low` del id es el ÚNICO canal.
// Nunca se agrega `--effort` (agy lo expone como flag aparte): dos canales para
// lo mismo harían que la traza no pudiera afirmar qué esfuerzo corrió.
// -----------------------------------------------------------------------------
const MODEL_ENV_VAR = 'GEMINI_MODEL';
const IGNORED_MODEL_ENV_VARS = Object.freeze(['AGY_MODEL']);

function resolveModelFromEnv(env) {
    const e = env && typeof env === 'object' ? env : {};
    const raw = e[MODEL_ENV_VAR];
    const model = (typeof raw === 'string' && raw.length > 0) ? raw : null;
    const ignoredEnv = IGNORED_MODEL_ENV_VARS.filter((k) => typeof e[k] === 'string' && e[k].length > 0);
    return {
        model,
        source: model ? MODEL_ENV_VAR : 'cli-default',
        ignoredEnv,
    };
}

function translateClaudeArgsToGemini(args, env) {
    // Modelo: SÓLO `GEMINI_MODEL` (ver resolveModelFromEnv). Sin ella dejamos al
    // CLI elegir su default. El pulpo inyecta GEMINI_MODEL desde agent-launcher.js
    // (propagación #6272) con el id resuelto para el skill (#6271).
    const { model } = resolveModelFromEnv(env);
    const timeout = (env && env.AGY_PRINT_TIMEOUT) || '5m';
    const out = ['--print', '--dangerously-skip-permissions', '--print-timeout', timeout];
    if (model) out.push('--model', model);
    return out;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve { cmd, args, spawnOpts, modelTrace } compatible con
// child_process.spawn.
//
// `args` vienen en formato Claude (ver pulpo.js:5846); acá los traducimos al
// shape Gemini y prependemos el prefijo del launcher detectado.
//
// `modelTrace` (#6334/#6858) — misma forma que el handler de Anthropic para que
// agent-launcher.js lo audite sin casos especiales:
//   { applied: true,  model, source: 'GEMINI_MODEL', reason: 'ok', ignoredEnv }
//   { applied: false, model: null, source: 'cli-default',
//     reason: 'agy_model_env_ignored', ignoredEnv: ['AGY_MODEL'] }
//     → sólo cuando NO hay GEMINI_MODEL pero sí un AGY_MODEL que se ignoró; el
//       launcher loguea que el agente arranca con el default del CLI.
// Sin ninguna de las dos variables NO se agrega la clave (regresión cero).
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported }) {
    const launcher = getLauncher();
    const geminiArgs = translateClaudeArgsToGemini(args || [], env || {});
    // #4529 — payload (system foldeado + mensaje) por STDIN, nunca por argv.
    // stdin SIEMPRE 'pipe'; el caller escribe `stdinPayload` y cierra stdin.
    const stdinPayload = foldGeminiPayload(args || [], env || {});
    const resolved = resolveModelFromEnv(env || {});
    let modelTrace = null;
    if (resolved.model) {
        modelTrace = {
            applied: true, model: resolved.model, source: resolved.source,
            reason: 'ok', ignoredEnv: resolved.ignoredEnv,
        };
    } else if (resolved.ignoredEnv.length > 0) {
        modelTrace = {
            applied: false, model: null, source: resolved.source,
            reason: 'agy_model_env_ignored', ignoredEnv: resolved.ignoredEnv,
        };
    }
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...geminiArgs],
        kind: launcher.kind,
        // #4529 — payload grande por stdin (paridad con el path primario).
        stdinPayload,
        ...(modelTrace ? { modelTrace } : {}),
        spawnOpts: {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
            shell: launcher.shell,
            windowsHide: true,
            env,
        },
    };
}

// -----------------------------------------------------------------------------
// _parseGeminiJson — extrae el objeto JSON del log de gemini (-o json).
//
// Gemini escribe a stdout un único objeto JSON. El log puede tener prefijo o
// sufijo basura (warnings residuales si stderr se mezcló, o líneas parciales).
// Estrategia robusta:
//   1. Intentar JSON.parse del contenido completo trimmeado.
//   2. Si falla, recortar del primer `{` al último `}` y reintentar.
// Devuelve el objeto parseado o null.
// -----------------------------------------------------------------------------
function _parseGeminiJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    try { return JSON.parse(trimmed); } catch { /* sigue */ }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* nada */ }
    }
    return null;
}

// -----------------------------------------------------------------------------
// parseTokensFromLog — agrega los tokens de TODOS los modelos reportados.
//
// Shape capturado en smoke test real (2026-06-01):
//   { "session_id": "...", "response": "OK", "stats": { "models": {
//       "gemini-3.1-flash-lite": { "tokens": {
//           "input": 2837, "prompt": 2837, "candidates": 36,
//           "total": 2973, "cached": 0, "thoughts": 100, "tool": 0 } },
//       "gemini-3.8-flash-medium": { "tokens": { ... } }
//   } } }
//
// Mapeo al shape canónico del pulpo (agregando sobre todos los modelos):
//   tokens.input                   → input
//   tokens.candidates + thoughts   → output  (thoughts = reasoning, facturable)
//   tokens.cached                  → cache_read
//   tool_calls: no hay un conteo de llamadas en el shape (el campo `tool` es
//               cantidad de tokens de tooling, no número de calls) → 0.
//
// #6858 — Shape de agy 1.2.4 (medido en vivo el 2026-09-16 con
// `--output-format json --model gemini-3.8-flash-low`):
//   { "status": "SUCCESS", "response": "OK\n", "usage": {
//       "input_tokens": 13049, "output_tokens": 22, "thinking_tokens": 21,
//       "cache_read_tokens": 0, "total_tokens": 13071 } }
// `output_tokens` YA incluye `thinking_tokens` (22 = 1 candidato + 21 thinking),
// así que se mapea directo a `output` sin volver a sumar el thinking. Si el JSON
// trae `usage` se usa ese (shape vigente); si no, se cae al legacy `stats.models`.
// -----------------------------------------------------------------------------
function parseTokensFromLog(logPath, fsImpl) {
    const _fs = fsImpl || fs;
    const totals = { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return totals; }
    const obj = _parseGeminiJson(raw);
    if (!obj || typeof obj !== 'object') return totals;
    const usage = obj.usage;
    if (usage && typeof usage === 'object') {
        totals.input += Number(usage.input_tokens || 0) || 0;
        totals.output += Number(usage.output_tokens || 0) || 0;
        totals.cache_read += Number(usage.cache_read_tokens || 0) || 0;
        return totals;
    }
    if (!obj.stats || typeof obj.stats !== 'object') return totals;
    const models = obj.stats.models;
    if (!models || typeof models !== 'object') return totals;
    for (const key of Object.keys(models)) {
        const entry = models[key];
        const t = entry && typeof entry === 'object'
            ? (entry.tokens && typeof entry.tokens === 'object' ? entry.tokens : entry)
            : null;
        if (!t) continue;
        // `input` puede venir como `input` o `prompt` según versión del CLI.
        totals.input += Number(t.input != null ? t.input : (t.prompt || 0)) || 0;
        const cand = Number(t.candidates || 0) || 0;
        const thoughts = Number(t.thoughts || 0) || 0;
        totals.output += cand + thoughts;
        totals.cache_read += Number(t.cached || 0) || 0;
    }
    return totals;
}

// -----------------------------------------------------------------------------
// detectQuotaExhausted — inspecciona el objeto `error` del JSON de gemini y
// matchea por shape estructural contra la allowlist canónica del provider en
// `quota-exhausted.js` (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['gemini-google']`
// = ['quota_exceeded', 'resource_exhausted']).
//
// Google reporta cuota agotada con status `RESOURCE_EXHAUSTED` (enum) y/o
// code `429`. Normalizamos los campos dedicados de error a lowercase y los
// matcheamos contra la allowlist. SOLO campos estructurales de error
// (status / code / reason / type), NUNCA `response` ni `message` libre.
//
// Si el shape de error cambia en una versión futura del CLI, el detector
// devuelve { matched:false } sin falsos positivos y el supervisor reintenta.
// -----------------------------------------------------------------------------
function _extractErrorTokens(err) {
    // Devuelve los candidatos estructurales (lowercased) a matchear.
    if (!err || typeof err !== 'object') return [];
    const out = [];
    const push = (v) => {
        if (typeof v === 'string' && v) out.push(v.toLowerCase());
    };
    push(err.status);
    push(err.type);
    push(err.reason);
    // `code` puede ser numérico (429) o string ('RESOURCE_EXHAUSTED').
    if (typeof err.code === 'string') push(err.code);
    // details[].reason (shape de Google API errors anidados)
    if (Array.isArray(err.details)) {
        for (const d of err.details) {
            if (d && typeof d === 'object') push(d.reason);
        }
    }
    return out;
}

function detectQuotaExhausted(logPath, cfg, quotaExhaustedModule, fsImpl) {
    const _fs = fsImpl || fs;
    if (!quotaExhaustedModule) return { matched: false };
    const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['gemini-google']
        || (cfg && cfg.error_types)
        || [];
    if (!allowlist || allowlist.length === 0) return { matched: false };

    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    const obj = _parseGeminiJson(raw);
    if (!obj) return { matched: false };

    // El error puede venir como `error` directo o anidado en `error.error`.
    const errObj = (obj.error && typeof obj.error === 'object')
        ? (obj.error.error && typeof obj.error.error === 'object' ? obj.error.error : obj.error)
        : null;
    if (!errObj) return { matched: false };

    const candidates = _extractErrorTokens(errObj);
    for (const cand of candidates) {
        if (allowlist.includes(cand)) {
            return {
                matched: true,
                errorType: cand,
                resetsAt: errObj.resets_at || errObj.retry_after || null,
                rawLine: JSON.stringify(errObj).slice(0, 500),
                evt: obj,
            };
        }
    }
    return { matched: false };
}

// -----------------------------------------------------------------------------
// detectAuthenticationRejected (#5795) — clase cerrada `authentication_rejected`.
//
// Google usa el shape google.rpc.Status: `{error:{code:401, status:'UNAUTHENTICATED',
// details:[{'@type':'...ErrorInfo', reason:'API_KEY_INVALID'}]}}`. La señal
// inequívoca vive en `status` (enum, no prosa) y en `details[].reason`.
//
// POSITIVOS — credencial inválida o expirada:
//   unauthenticated       enum gRPC/HTTP de credencial ausente o inválida
//   api_key_invalid       ErrorInfo.reason: la clave no es válida
//   api_key_expired       ErrorInfo.reason: la clave venció
//   access_token_expired  ErrorInfo.reason: el token OAuth venció
//
// NEGATIVOS — Google los devuelve también con 401/403 pero NO son credencial
// inválida: son permisos, suspensión de cuenta o bloqueo del servicio. Meterlos
// en la misma clase haría que el coordinador re-resuelva una credencial sana.
//   permission_denied / api_key_service_blocked / api_key_http_referrer_blocked
//   consumer_suspended / billing_disabled / service_disabled
//   resource_exhausted / quota_exceeded / rate_limit_exceeded (cuota)
//   unavailable / internal / deadline_exceeded (transitorios)
//   invalid_argument / failed_precondition / not_found (permanentes)
// -----------------------------------------------------------------------------
const detectAuthenticationRejected = authRejection.makeDetector({
    adapter: 'gemini-google',
    positives: ['unauthenticated', 'api_key_invalid', 'api_key_expired', 'access_token_expired'],
    negatives: [
        'permission_denied', 'api_key_service_blocked', 'api_key_http_referrer_blocked',
        'consumer_suspended', 'billing_disabled', 'service_disabled', 'accounting_disabled',
        'resource_exhausted', 'quota_exceeded', 'rate_limit_exceeded',
        'unavailable', 'internal', 'deadline_exceeded',
        'invalid_argument', 'failed_precondition', 'not_found', 'aborted',
    ],
});

module.exports = {
    name: 'gemini-google',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    detectAuthenticationRejected,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _translateClaudeArgsToGemini: translateClaudeArgsToGemini,
    // #6334/#6858 — precedencia explícita del modelo.
    MODEL_ENV_VAR,
    IGNORED_MODEL_ENV_VARS,
    resolveModelFromEnv,
    _foldGeminiPayload: foldGeminiPayload,
    _parseGeminiJson,
    _extractErrorTokens,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

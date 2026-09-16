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
//      que entiende Antigravity. Desde agy 1.2.x (#6857) el prompt entra por
//      STDIN como NDJSON (`--input-format stream-json`, que a su vez exige
//      `--output-format stream-json`): `--print` ya NO admite ir sin valor y
//      un prompt en argv reventaría con ENAMETOOLONG en Windows (#4529).
//      Gemini NO tiene flag de system prompt, así que el contenido del
//      `--system-prompt-file` se foldea al inicio del prompt.
//   3) parseTokensFromLog — agrega los tokens reportados por el CLI. Con
//      `--output-format stream-json` el log es NDJSON y el objeto útil es el
//      `result` del evento `{"event":"result"}`; `_parseGeminiJson` lo
//      localiza. La adaptación del shape (`usage.*`, `error` string) es #7288.
//   4) detectQuotaExhausted — inspecciona el objeto `error` del JSON y matchea
//      por shape estructural (status/code/reason normalizados a lowercase)
//      contra la allowlist canónica en `quota-exhausted.js`
//      (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['gemini-google']`).
//
// Auth: OAuth via `agy`; nunca API key. El health (#6857) sale de un
// round-trip real al CLI (`agy models`, ver multi-provider/agy-catalog-probe.js),
// que spawnea EXACTAMENTE el `cmd` que devuelve `detectLauncher()`. Ya no
// existe el flag `AGY_LICENSE_READY`: un flag local no puede saber si la
// licencia está activa.
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
//
// #6857 — `env` / `fsImpl` / `platform` son inyectables para que el probe de
// salud (`agy-catalog-probe.js`) resuelva el binario con LA MISMA función que
// el launcher y ambos miren el mismo archivo. Sin argumentos se comporta igual
// que siempre (process.env / fs / process.platform).
//
// Orden: `AGY_BIN` explícito → `%LOCALAPPDATA%\agy\bin\agy.exe` (ubicación
// oficial; ese dir está sólo en el PATH de USUARIO, no en el de máquina, así
// que desde los servicios del pipeline el fallback al PATH no lo encuentra) →
// `agy` pelado en el PATH.
// -----------------------------------------------------------------------------
function detectLauncher(env, fsImpl, platform) {
    const _env = env || process.env;
    const _fs = fsImpl || fs;
    const _platform = platform || process.platform;
    if (_env.AGY_BIN) {
        return { kind: 'configured-native', cmd: _env.AGY_BIN, prefixArgs: [], shell: false };
    }
    const windowsBin = path.join(_env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    let officialExists = false;
    try { officialExists = _platform === 'win32' && !!_fs.existsSync(windowsBin); } catch { officialExists = false; }
    if (officialExists) {
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
// Contrato de salida (agy 1.2.x — #6857):
//   ['--input-format', 'stream-json', '--output-format', 'stream-json',
//    '--dangerously-skip-permissions', '--print-timeout', timeout,
//    '--model', model?]
// El payload real se pipea por STDIN como UNA línea NDJSON
// (`{"event":"user","message":{"role":"user","content":"<system+prompt>"}}`)
// para evitar ENAMETOOLONG en Windows. Verificado en vivo contra agy 1.2.4:
// `--print` sin valor es error (rc=2, "flag needs an argument"), `--print -`
// manda el literal "-" como prompt, y `--input-format stream-json` rechaza
// cualquier prompt en argv ("a prompt given on the command line would be
// ignored"). Esta es la única vía documentada para stdin.
// -----------------------------------------------------------------------------
const AGY_STREAM_INPUT_ARGS = Object.freeze(['--input-format', 'stream-json', '--output-format', 'stream-json']);

/**
 * Serializa el prompt (system foldeado + mensaje) como la línea NDJSON que
 * espera `--input-format stream-json`. Shape verificado en vivo (#6857):
 * `{"event":"user","message":{"role":"user","content":"..."}}`. Sin el campo
 * `event` el CLI corta con `stream input message is missing the "event" field`.
 */
function encodeStreamJsonPayload(prompt) {
    return JSON.stringify({ event: 'user', message: { role: 'user', content: String(prompt == null ? '' : prompt) } }) + '\n';
}
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

function translateClaudeArgsToGemini(args, env) {
    // Modelo: env GEMINI_MODEL si fue explicitado, sino dejamos al CLI elegir
    // su default (con OAuth gratuito el main es `gemini-3-flash-preview` y el
    // router `gemini-3.1-flash-lite`). El pulpo inyecta GEMINI_MODEL via
    // env-isolation cuando el skill resuelve un modelo específico.
    const model = env && (env.AGY_MODEL || env.GEMINI_MODEL);
    const timeout = (env && env.AGY_PRINT_TIMEOUT) || '5m';
    const out = [...AGY_STREAM_INPUT_ARGS, '--dangerously-skip-permissions', '--print-timeout', timeout];
    if (model) out.push('--model', model);
    return out;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve { cmd, args, spawnOpts } compatible con child_process.spawn
//
// `args` vienen en formato Claude (ver pulpo.js:5846); acá los traducimos al
// shape Gemini y prependemos el prefijo del launcher detectado.
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported }) {
    const launcher = getLauncher();
    const geminiArgs = translateClaudeArgsToGemini(args || [], env || {});
    // #4529 — payload (system foldeado + mensaje) por STDIN, nunca por argv.
    // stdin SIEMPRE 'pipe'; el caller escribe `stdinPayload` y cierra stdin.
    // #6857 — serializado como NDJSON para `--input-format stream-json`.
    const stdinPayload = encodeStreamJsonPayload(foldGeminiPayload(args || [], env || {}));
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...geminiArgs],
        kind: launcher.kind,
        // #4529 — payload grande por stdin (paridad con el path primario).
        stdinPayload,
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
//   0. #6857 — Si el log es NDJSON (`--output-format stream-json`), devolver
//      el objeto `result` del último evento `{"event":"result"}`: tiene el
//      mismo shape que el JSON único de `--output-format json`
//      (`conversation_id`, `status`, `response`, `error`, `usage`).
//   1. Intentar JSON.parse del contenido completo trimmeado.
//   2. Si falla, recortar del primer `{` al último `}` y reintentar.
// Devuelve el objeto parseado o null.
// -----------------------------------------------------------------------------
function _parseGeminiJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    // 0. NDJSON: buscar de atrás hacia adelante el evento `result`.
    if (trimmed.includes('"event"')) {
        const lines = trimmed.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line.startsWith('{') || !line.includes('"result"')) continue;
            try {
                const evt = JSON.parse(line);
                if (evt && evt.event === 'result' && evt.result && typeof evt.result === 'object') return evt.result;
            } catch { /* línea parcial: seguir buscando */ }
        }
    }
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
//       "gemini-3-flash-preview": { "tokens": { ... } }
//   } } }
//
// Mapeo al shape canónico del pulpo (agregando sobre todos los modelos):
//   tokens.input                   → input
//   tokens.candidates + thoughts   → output  (thoughts = reasoning, facturable)
//   tokens.cached                  → cache_read
//   tool_calls: no hay un conteo de llamadas en el shape (el campo `tool` es
//               cantidad de tokens de tooling, no número de calls) → 0.
// -----------------------------------------------------------------------------
function parseTokensFromLog(logPath, fsImpl) {
    const _fs = fsImpl || fs;
    const totals = { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return totals; }
    const obj = _parseGeminiJson(raw);
    if (!obj || !obj.stats || typeof obj.stats !== 'object') return totals;
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
    _foldGeminiPayload: foldGeminiPayload,
    _encodeStreamJsonPayload: encodeStreamJsonPayload,
    AGY_STREAM_INPUT_ARGS,
    _parseGeminiJson,
    _extractErrorTokens,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

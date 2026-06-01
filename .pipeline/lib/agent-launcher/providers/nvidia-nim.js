// =============================================================================
// providers/nvidia-nim.js — Handler real del provider NVIDIA NIM (#3791)
//
// NVIDIA NIM es una API REST drop-in OpenAI-compatible
// (`https://integrate.api.nvidia.com/v1`) con free tier real (API key
// `nvapi-...`). A diferencia de Codex y Gemini NO publica un CLI, así que el
// "binario" que spawneamos es un runner Node propio
// (`runners/nvidia-nim-runner.js`) que hace la llamada HTTP y emite UN único
// objeto JSON a stdout (mismo patrón de salida que Gemini con `-o json`).
//
// Wiring acá:
//   1) detectLauncher — siempre `node <runner.js>` (sin shell, sin binario
//      externo). El runner vive junto al adapter, ruta hardcoded (sin require
//      dinámico) para no abrir path-traversal.
//   2) buildSpawn — traduce los args legacy del pulpo (estilo Claude CLI:
//      `-p`, `--system-prompt-file`, `--output-format stream-json`) al contrato
//      del runner (`--model <id> --system-file <path> --prompt <text>`). El
//      modelo sale de env `NVIDIA_NIM_MODEL` (lo inyecta el pulpo por
//      env-isolation) o el default del runner.
//   3) parseTokensFromLog — el runner emite el shape OpenAI chat-completion;
//      mapeamos `usage.prompt_tokens → input`, `completion_tokens (+ reasoning)
//      → output`, `prompt_tokens_details.cached_tokens → cache_read`.
//   4) detectQuotaExhausted — inspecciona el objeto `error` del JSON y matchea
//      por shape estructural (status/code/type normalizados a lowercase) contra
//      la allowlist canónica `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['nvidia-nim']`.
//
// Auth: API key free-tier en env `NVIDIA_NIM_API_KEY` (la hidrata
// `lib/credentials.js`). No hay OAuth como Codex/Gemini — NVIDIA da créditos
// free directo con la key.
//
// Seguridad:
//  - Runner con ruta hardcoded (sin require dinámico de provider).
//  - Args como argv estricto (sin shell concat — shell:false siempre).
//  - Detección de cuota SOLO por shape estructural sobre campos dedicados de
//    error (status/code/type). NUNCA substring sobre el contenido del modelo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUNNER_PATH = path.join(__dirname, '..', 'runners', 'nvidia-nim-runner.js');

// -----------------------------------------------------------------------------
// detectLauncher — NVIDIA no tiene CLI; ejecutamos el runner Node propio.
// `node <runner.js>` sin shell (cmd = process.execPath, prefixArgs = [runner]).
// -----------------------------------------------------------------------------
function detectLauncher() {
    return {
        kind: 'node-runner',
        cmd: process.execPath,
        prefixArgs: [RUNNER_PATH],
        shell: false,
    };
}

let cachedLauncher = null;
function getLauncher() {
    if (!cachedLauncher) cachedLauncher = detectLauncher();
    return cachedLauncher;
}
function _setLauncherForTesting(launcher) { cachedLauncher = launcher; }
function _resetLauncherCacheForTesting() { cachedLauncher = null; }

// -----------------------------------------------------------------------------
// translateClaudeArgsToNvidia — extrae prompt y system file del args estilo
// Claude CLI y arma el argv del runner. Args desconocidos
// (`--output-format`, `--verbose`, `--permission-mode`, etc.) se descartan.
//
// Contrato de entrada (lo que el pulpo construye, estilo Claude CLI):
//   ['-p', userPrompt, '--system-prompt-file', systemFile, ...]
//
// Contrato de salida (lo que entiende el runner):
//   ['--model', model?, '--system-file', systemFile?, '--prompt', userPrompt]
// -----------------------------------------------------------------------------
function translateClaudeArgsToNvidia(args, env) {
    let userPrompt = null;
    let systemFile = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-p') { userPrompt = args[i + 1]; i++; }
        else if (a === '--system-prompt-file') { systemFile = args[i + 1]; i++; }
        // Otros flags no aplican al runner REST; los descartamos.
    }

    const model = env && env.NVIDIA_NIM_MODEL;
    const out = [];
    if (model) out.push('--model', model);
    if (systemFile && typeof systemFile === 'string') out.push('--system-file', systemFile);
    out.push('--prompt', typeof userPrompt === 'string' ? userPrompt : '');
    return out;
}

// -----------------------------------------------------------------------------
// buildSpawn — { cmd, args, spawnOpts } para child_process.spawn.
// `args` vienen en formato Claude; los traducimos y prependemos el prefijo del
// launcher (node + runner.js).
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported }) {
    const launcher = getLauncher();
    const nvidiaArgs = translateClaudeArgsToNvidia(args || [], env || {});
    const stdin = interactive_supported === true ? 'pipe' : 'ignore';
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...nvidiaArgs],
        spawnOpts: {
            cwd,
            stdio: [stdin, 'pipe', 'pipe'],
            detached: false,
            shell: launcher.shell,
            windowsHide: true,
            env,
        },
    };
}

// -----------------------------------------------------------------------------
// _parseNvidiaJson — extrae el objeto JSON del log del runner. Robusto frente a
// prefijo/sufijo basura (warnings residuales). Mismo enfoque que Gemini.
// -----------------------------------------------------------------------------
function _parseNvidiaJson(raw) {
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
// parseTokensFromLog — mapea el `usage` OpenAI al shape canónico del pulpo.
//
// Shape capturado en smoke real (2026-06-01, deepseek-v4-pro):
//   { "choices": [...], "usage": {
//       "prompt_tokens": 17, "completion_tokens": 2, "total_tokens": 19,
//       "prompt_tokens_details": { "cached_tokens": N } | null,
//       "reasoning_tokens": 0 } }
//
// Mapeo:
//   prompt_tokens                      → input
//   completion_tokens + reasoning      → output  (reasoning = thinking, facturable)
//   prompt_tokens_details.cached_tokens→ cache_read
//   tool_calls: sin conteo en usage    → 0
// -----------------------------------------------------------------------------
function parseTokensFromLog(logPath, fsImpl) {
    const _fs = fsImpl || fs;
    const totals = { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return totals; }
    const obj = _parseNvidiaJson(raw);
    if (!obj || !obj.usage || typeof obj.usage !== 'object') return totals;
    const u = obj.usage;
    totals.input = Number(u.prompt_tokens || 0) || 0;
    const completion = Number(u.completion_tokens || 0) || 0;
    const reasoning = Number(u.reasoning_tokens || 0) || 0;
    totals.output = completion + reasoning;
    const details = u.prompt_tokens_details;
    if (details && typeof details === 'object') {
        totals.cache_read = Number(details.cached_tokens || 0) || 0;
    }
    return totals;
}

// -----------------------------------------------------------------------------
// _extractErrorTokens — candidatos estructurales (lowercased) a matchear contra
// la allowlist. SOLO campos dedicados de error (status/code/type), nunca el
// contenido del modelo.
// -----------------------------------------------------------------------------
function _extractErrorTokens(err) {
    if (!err || typeof err !== 'object') return [];
    const out = [];
    const push = (v) => { if (typeof v === 'string' && v) out.push(v.toLowerCase()); };
    push(err.type);
    push(err.code);
    push(err.reason);
    if (typeof err.status === 'string') push(err.status);
    return out;
}

// -----------------------------------------------------------------------------
// detectQuotaExhausted — matchea el objeto `error` del JSON del runner contra la
// allowlist canónica `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['nvidia-nim']`
// (= ['rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota']).
// -----------------------------------------------------------------------------
function detectQuotaExhausted(logPath, cfg, quotaExhaustedModule, fsImpl) {
    const _fs = fsImpl || fs;
    if (!quotaExhaustedModule) return { matched: false };
    const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['nvidia-nim']
        || (cfg && cfg.error_types)
        || [];
    if (!allowlist || allowlist.length === 0) return { matched: false };

    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    const obj = _parseNvidiaJson(raw);
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

module.exports = {
    name: 'nvidia-nim',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _translateClaudeArgsToNvidia: translateClaudeArgsToNvidia,
    _parseNvidiaJson,
    _extractErrorTokens,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
    RUNNER_PATH,
};

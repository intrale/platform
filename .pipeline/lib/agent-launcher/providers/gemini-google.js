// =============================================================================
// providers/gemini-google.js — Handler real del provider Google Gemini
//
// Implementa el contrato del wrapper de agent-launcher para el CLI oficial
// `@google/gemini-cli` (`gemini --skip-trust -o json -p "..."`) usando OAuth
// gratuito (cuenta Google, free tier real). Reemplaza el stub previo
// (#3198 / #3220) que tiraba _notImplemented.
//
// Wiring acá:
//   1) detectLauncher — multi-tier detection (wrapper Node bundle / .cmd shim /
//      PATH fallback). El paquete es JS puro (no hay binario nativo como Codex),
//      así que la ruta preferida es ejecutar el bundle con `node` directo.
//   2) buildSpawn — traduce los args legacy del pulpo (estilo Claude CLI:
//      `-p`, `--system-prompt-file`, `--output-format stream-json`) al shape
//      que entiende Gemini (`--skip-trust -o json -m <model> -p <prompt>`).
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
// Auth: OAuth via `gemini` (login interactivo en el browser, cuenta Google).
// No necesita API key paga — el free tier real cubre el uso del pipeline.
//
// Seguridad:
//  - Tabla hardcoded de paths del bundle (sin require dinámico de provider).
//  - Args como argv estricto (sin shell concat — shell:true sólo para el
//    .cmd shim como con Anthropic/Codex).
//  - Detección de cuota SOLO por shape estructural sobre campos dedicados de
//    error (status/code/reason). NUNCA substring sobre `response` (canal de
//    contenido controlado por el modelo).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// detectLauncher — multi-tier (preservar precedencia I6 como en anthropic.js)
//
// Orden (más a menos preferida; todas evitan cmd.exe salvo el .cmd shim):
//   1. Bundle JS @google/gemini-cli/bundle/gemini.js → node directo (sin shell)
//   2. .cmd shim de npm → shell:true (último recurso por compat)
//   3. PATH fallback → process.env.GEMINI_BIN o 'gemini' (último recurso)
//
// El paquete de Gemini es JS puro (bundle único), no publica binario nativo
// platform-específico como Codex; por eso no hay tier `native-exe`.
// -----------------------------------------------------------------------------
function detectLauncher() {
    const pkgDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli');
    const bundleJs = path.join(pkgDir, 'bundle', 'gemini.js');
    const cmdShim = path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd');

    if (fs.existsSync(bundleJs)) {
        return { kind: 'node-bundle-js', cmd: process.execPath, prefixArgs: [bundleJs], shell: false };
    }
    if (fs.existsSync(cmdShim)) {
        return { kind: 'cmd-shim', cmd: cmdShim, prefixArgs: [], shell: true };
    }
    return { kind: 'path-fallback', cmd: process.env.GEMINI_BIN || 'gemini', prefixArgs: [], shell: true };
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
// Contrato de salida (lo que Gemini CLI acepta):
//   ['--skip-trust', '-o', 'json', '-m', model?, '-p', composedPrompt]
//
// Gemini NO tiene flag de system prompt (sólo context files GEMINI.md). El
// contenido del system file se foldea al inicio del prompt para preservar las
// instrucciones del sistema. Si el archivo no se puede leer, seguimos con el
// prompt del usuario solo (best-effort, no crasheamos el spawn).
// -----------------------------------------------------------------------------
function translateClaudeArgsToGemini(args, env, fsImpl) {
    const _fs = fsImpl || fs;
    let userPrompt = null;
    let systemFile = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-p') {
            userPrompt = args[i + 1];
            i++;
        } else if (a === '--system-prompt-file') {
            systemFile = args[i + 1];
            i++;
        }
        // Otros flags (--output-format, --verbose, --permission-mode,
        // --append-system-prompt, etc.) no tienen equivalente directo en
        // gemini headless; los descartamos.
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

    // Modelo: env GEMINI_MODEL si fue explicitado, sino dejamos al CLI elegir
    // su default (con OAuth gratuito el main es `gemini-3-flash-preview` y el
    // router `gemini-3.1-flash-lite`). El pulpo inyecta GEMINI_MODEL via
    // env-isolation cuando el skill resuelve un modelo específico.
    const model = env && env.GEMINI_MODEL;
    const out = ['--skip-trust', '-o', 'json'];
    if (model) out.push('-m', model);
    out.push('-p', prompt);
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
    const stdin = interactive_supported === true ? 'pipe' : 'ignore';
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...geminiArgs],
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

module.exports = {
    name: 'gemini-google',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _translateClaudeArgsToGemini: translateClaudeArgsToGemini,
    _parseGeminiJson,
    _extractErrorTokens,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

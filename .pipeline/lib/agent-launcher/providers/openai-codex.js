// =============================================================================
// providers/openai-codex.js — Handler real del provider OpenAI/Codex
//
// Implementa el contrato del wrapper de agent-launcher para Codex CLI
// (`codex exec --json ...`) usando OAuth via ChatGPT Plus. Reemplaza el stub
// previo (#3074 / #3076) que tiraba _notImplemented.
//
// Wiring acá:
//   1) detectLauncher — multi-tier detection (node wrapper / binario nativo /
//      .cmd shim / PATH fallback). Mismo patrón defensivo que Anthropic (I6).
//   2) buildSpawn — traduce los args legacy del pulpo (estilo Claude CLI:
//      `-p`, `--system-prompt-file`, `--output-format stream-json`) al shape
//      que entiende Codex (`exec --json --skip-git-repo-check
//      --dangerously-bypass-approvals-and-sandbox -m <model> <prompt>`). El
//      system prompt se foldea al inicio del prompt (codex no tiene flag
//      `--system`) y el bypass de sandbox da paridad de permisos con el
//      `--permission-mode bypassPermissions` de Claude.
//   3) parseTokensFromLog — agrega `usage` de eventos `turn.completed` en JSONL.
//      Codex usa `input_tokens / output_tokens / cached_input_tokens /
//      reasoning_output_tokens`; mapeamos al shape canónico del pulpo.
//   4) detectQuotaExhausted — barre el JSONL buscando eventos de error y
//      matchea contra la allowlist canónica de codex en `quota-exhausted.js`
//      (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['openai-codex']`).
//
// Auth: OAuth via `codex login` con ChatGPT Plus (no necesita API key paga).
//
// Seguridad:
//  - Tabla hardcoded de paths del binario (sin require dinámico de provider).
//  - Args como argv estricto (sin shell concat — el shell:true sólo se usa
//    para el shim .cmd como con Anthropic).
//  - Detección de cuota sólo por shape estructural (NO substring sobre canal
//    de contenido del modelo).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
// #5795 — contrato compartido de la clase cerrada 'authentication_rejected'.
const authRejection = require('../auth-rejection');

// -----------------------------------------------------------------------------
// detectLauncher — multi-tier (preservar precedencia I6 como en anthropic.js)
//
// Orden (más a menos preferida; todas evitan cmd.exe salvo el .cmd shim):
//   1. Binario nativo @openai/codex-win32-x64/.../codex.exe (sin shell)
//   2. Wrapper ESM bin/codex.js → node directo (sin shell)
//   3. .cmd shim de npm → shell:true (último recurso por compat)
//   4. PATH fallback → process.env.CODEX_BIN o 'codex' (último recurso)
// -----------------------------------------------------------------------------
function detectLauncher() {
    const pkgDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex');
    const wrapperJs = path.join(pkgDir, 'bin', 'codex.js');
    // Binario nativo Windows x64 (ruta canónica del paquete platform-específico).
    const nativeExeWin = path.join(
        pkgDir, 'node_modules', '@openai', 'codex-win32-x64',
        'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
    );
    const cmdShim = path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');

    if (fs.existsSync(nativeExeWin)) {
        return { kind: 'native-exe', cmd: nativeExeWin, prefixArgs: [], shell: false };
    }
    if (fs.existsSync(wrapperJs)) {
        return { kind: 'node-wrapper-js', cmd: process.execPath, prefixArgs: [wrapperJs], shell: false };
    }
    if (fs.existsSync(cmdShim)) {
        return { kind: 'cmd-shim', cmd: cmdShim, prefixArgs: [], shell: true };
    }
    return { kind: 'path-fallback', cmd: process.env.CODEX_BIN || 'codex', prefixArgs: [], shell: true };
}

let cachedLauncher = null;
function getLauncher() {
    if (!cachedLauncher) cachedLauncher = detectLauncher();
    return cachedLauncher;
}
function _setLauncherForTesting(launcher) { cachedLauncher = launcher; }
function _resetLauncherCacheForTesting() { cachedLauncher = null; }

// -----------------------------------------------------------------------------
// foldCodexPayload — lee el system file y lo foldea con el prompt del usuario.
//
// codex exec NO tiene flag de system prompt — `--system` no existe en el CLI
// (antes lo pasábamos y codex lo descartaba/erroraba, perdiendo la persona del
// Commander). Para que la persona/identidad tenga efecto, foldeamos el contenido
// del system file al INICIO del prompt. Este payload va SIEMPRE por stdin (ver
// #4529): pasarlo por argv reventaba el límite de `CreateProcess` de Windows
// (~32K) con `spawn ENAMETOOLONG` cuando el system prompt + historial crecía.
// -----------------------------------------------------------------------------
function foldCodexPayload(args, env, fsImpl) {
    const _fs = fsImpl || fs;
    let userPrompt = null;
    let systemFile = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-p') { userPrompt = args[i + 1]; i++; }
        else if (a === '--system-prompt-file') { systemFile = args[i + 1]; i++; }
    }
    let systemText = '';
    if (systemFile && typeof systemFile === 'string') {
        try { systemText = _fs.readFileSync(systemFile, 'utf8'); } catch { systemText = ''; }
    }
    const promptText = typeof userPrompt === 'string' ? userPrompt : '';
    return systemText.trim()
        ? `${systemText.trim()}\n\n---\n\n${promptText}`
        : promptText;
}

// -----------------------------------------------------------------------------
// translateClaudeArgsToCodex — extrae prompt y system file del args estilo
// Claude CLI y arma el argv de Codex. Args desconocidos se descartan
// silenciosamente (el shape de stream-json/--verbose/--permission-mode no
// aplica a Codex).
//
// Contrato de entrada (lo que el pulpo construye en pulpo.js:5846):
//   ['-p', userPrompt, '--system-prompt-file', systemFile, ...]
//
// Contrato de salida (lo que Codex CLI acepta):
//   ['exec', '--json', '--skip-git-repo-check', '-C', cwd,
//    '--dangerously-bypass-approvals-and-sandbox', '-m', model?, '-']
//
// #4529 — El prompt (system foldeado + mensaje) YA NO va como argumento
// posicional: se pasa `-` para que codex lea las instrucciones por STDIN
// (`codex exec --help`: "If not provided as an argument (or if `-` is used),
// instructions are read from stdin"). Esto evita `spawn ENAMETOOLONG` en Windows
// cuando el payload supera el límite de la línea de comando (~32K). El payload
// real lo devuelve `buildSpawn` en `stdinPayload`.
// -----------------------------------------------------------------------------
function translateClaudeArgsToCodex(args, env, cwd) {
    // Modelo: env CODEX_MODEL si fue explicitado, sino dejamos al CLI elegir
    // su default (varía según modo de auth: con OAuth ChatGPT Plus es `gpt-5`,
    // con API key paga acepta `gpt-5-codex`). El pulpo inyecta CODEX_MODEL via
    // env-isolation cuando el skill resuelve un modelo específico.
    const model = env && env.CODEX_MODEL;
    const out = ['exec', '--json', '--skip-git-repo-check', '-C', cwd];
    // Paridad de permisos con `--permission-mode bypassPermissions` de Claude.
    // `codex exec` corre por DEFAULT en sandbox `read-only` con aprobaciones,
    // así que el agente choca con "no tengo permisos" / "no está instalado" al
    // intentar escribir archivos, correr comandos o instalar dependencias —
    // limitaciones que Claude no tiene. El pipeline ya corre en un entorno
    // externo de confianza (la máquina de Leo), por lo que le damos a codex el
    // mismo acceso pleno: sin sandbox y sin aprobaciones interactivas. Sin esto
    // el fallback degrada por proveedor, que es justo lo que NO queremos.
    out.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) out.push('-m', model);
    // `-` = leer las instrucciones por stdin (ver comentario del header).
    out.push('-');
    return out;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve { cmd, args, spawnOpts } compatible con child_process.spawn
//
// `args` vienen en formato Claude (ver pulpo.js:5846); acá los traducimos al
// shape Codex y prependemos el prefijo del launcher detectado.
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported }) {
    const launcher = getLauncher();
    const codexArgs = translateClaudeArgsToCodex(args || [], env || {}, cwd || process.cwd());
    // #4529 — el prompt (system foldeado + mensaje) viaja por STDIN, nunca por
    // argv. stdin SIEMPRE 'pipe' para poder escribirlo; el caller (agent-launcher /
    // pulpo commander / sherlock) escribe `stdinPayload` y cierra stdin.
    const stdinPayload = foldCodexPayload(args || [], env || {});
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...codexArgs],
        // #4052 CA-1 — exponemos el tier del launcher resuelto por detectLauncher()
        // hacia el caller (agent-launcher.js) para loguearlo en el evento de
        // spawn-exit. Revela qué tier muere (native-exe / node-wrapper-js /
        // cmd-shim / path-fallback) — los shell:true son los más sospechosos.
        kind: launcher.kind,
        // #4529 — payload grande por stdin (paridad con el path primario de
        // Anthropic, que escribe el system prompt a archivo). El caller DEBE
        // hacer `child.stdin.write(stdinPayload); child.stdin.end();`.
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
// probeCodexHealth — pre-flight health-check de Codex (#4052 CA-2 / SEC-2).
//
// Ejecuta `codex --version` en forma ARGV (jamás string-concat al shell) con un
// timeout corto, para validar que el binario de Codex levanta sano ANTES de
// asignarle una fase. Si falla, marca el provider `openai-codex` como disabled
// con TTL para que la cadena de fallback elija otro provider, evitando los 3
// reintentos en seco que queman el circuit breaker.
//
// SEGURIDAD (SEC-2):
//  - Comando ESTÁTICO y benigno (`--version`). NUNCA recibe contenido del issue,
//    prompt del usuario, ni dato no controlado → cero superficie de inyección.
//  - Args en forma de array (argv). Preferimos los tiers shell:false
//    (native-exe / node-wrapper-js). El tier se hereda de detectLauncher().
//
// @param {object} [opts]
// @param {function} [opts.spawnSyncImpl]  override de child_process.spawnSync (tests)
// @param {object}   [opts.launcher]       override del launcher resuelto (tests)
// @param {object}   [opts.disabledModule] override de provider-disabled (tests)
// @param {number}   [opts.ttlMs]          TTL del disable al fallar
// @param {number}   [opts.timeoutMs]      timeout del probe (default 5000)
// @param {number}   [opts.now]
// @returns {{ ok:boolean, status:number|null, signal:string|null,
//             timedOut:boolean, launcherKind:string, disabled:boolean,
//             error:string|null }}
// -----------------------------------------------------------------------------
function probeCodexHealth(opts = {}) {
    const launcher = opts.launcher || getLauncher();
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    // Args 100% estáticos — sin contenido del issue (SEC-2).
    const probeArgs = [...(launcher.prefixArgs || []), '--version'];
    const result = {
        ok: false,
        status: null,
        signal: null,
        timedOut: false,
        launcherKind: launcher.kind || null,
        disabled: false,
        error: null,
    };
    try {
        const spawnSync = opts.spawnSyncImpl || require('node:child_process').spawnSync;
        const r = spawnSync(launcher.cmd, probeArgs, {
            // shell heredado del tier; preferimos shell:false (native/node-wrapper).
            // Aún con shell:true los args son constantes estáticas (sin injection).
            shell: launcher.shell === true,
            timeout: timeoutMs,
            windowsHide: true,
            encoding: 'utf8',
        });
        // spawnSync devuelve { status, signal, error }. error suele venir en
        // ENOENT/timeout; status null + signal en kill por timeout.
        result.status = (r && typeof r.status === 'number') ? r.status : null;
        result.signal = (r && r.signal) || null;
        result.timedOut = !!(r && r.error && r.error.code === 'ETIMEDOUT');
        if (r && r.error) {
            result.error = r.error.code || r.error.message || 'spawn_error';
        }
        result.ok = !!(r && !r.error && r.status === 0);
    } catch (e) {
        result.error = (e && (e.code || e.message)) || 'probe_exception';
        result.ok = false;
    }

    if (!result.ok) {
        // Marca el provider disabled con TTL → la cadena de fallback lo saltea.
        try {
            const disabled = opts.disabledModule || require('../../provider-disabled');
            const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : undefined;
            const setOpts = { source: 'health-probe' };
            if (ttlMs !== undefined) setOpts.ttlMs = ttlMs;
            if (Number.isFinite(opts.now)) setOpts.now = opts.now;
            const r = disabled.setProviderDisabled('openai-codex', setOpts);
            result.disabled = !!(r && r.ok);
        } catch {
            result.disabled = false;
        }
    }
    return result;
}

// -----------------------------------------------------------------------------
// parseTokensFromLog — agrega `usage` de cada evento `turn.completed` del
// JSONL de codex exec.
//
// Shape capturado en smoke test real (2026-06-01):
//   {"type":"turn.completed","usage":{
//      "input_tokens":11044,
//      "cached_input_tokens":4480,
//      "output_tokens":5,
//      "reasoning_output_tokens":0
//   }}
//
// Mapeo al shape canónico del pulpo:
//   input_tokens         → input
//   output_tokens        → output  (sumamos también reasoning_output_tokens
//                                   porque son tokens de salida facturables)
//   cached_input_tokens  → cache_read
//   tool_calls           → contamos eventos item.completed con item.type
//                          === 'tool_call' (best-effort; el shape exacto
//                          de tool calls puede variar entre versiones de
//                          codex-cli y se sumará 0 si no aparece)
// -----------------------------------------------------------------------------
function parseTokensFromLog(logPath, fsImpl) {
    const _fs = fsImpl || fs;
    const totals = { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return totals; }
    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'turn.completed' && obj.usage && typeof obj.usage === 'object') {
            const u = obj.usage;
            totals.input += Number(u.input_tokens || 0);
            const out = Number(u.output_tokens || 0);
            const reason = Number(u.reasoning_output_tokens || 0);
            totals.output += out + reason;
            totals.cache_read += Number(u.cached_input_tokens || 0);
        } else if (obj.type === 'item.completed' && obj.item && obj.item.type === 'tool_call') {
            totals.tool_calls += 1;
        }
    }
    return totals;
}

// -----------------------------------------------------------------------------
// detectQuotaExhausted — busca eventos de error en el JSONL de codex exec y
// matchea contra la allowlist canónica del provider en `quota-exhausted.js`.
//
// Codex exec emite errores en formas conocidas; las soportadas hoy:
//   1) {"type":"turn.failed","error":{"type":"insufficient_quota",...}}
//   2) {"type":"error","error":{"type":"insufficient_quota",...}}
//   3) {"type":"item.completed","item":{"type":"error","error":{...}}}
//
// SOLO matcheo estructural: nunca hago substring sobre canal de contenido.
// Si el shape cambia en una versión futura de codex-cli, el detector
// devuelve { matched:false } sin falsos positivos y el supervisor retrintenta.
// -----------------------------------------------------------------------------
function _extractErrorType(evt) {
    if (!evt || typeof evt !== 'object') return null;
    // Forma 1 / 2
    if (evt.error && typeof evt.error === 'object' && typeof evt.error.type === 'string') {
        return evt.error.type;
    }
    // Forma 3
    if (evt.item && typeof evt.item === 'object'
        && evt.item.type === 'error'
        && evt.item.error && typeof evt.item.error.type === 'string') {
        return evt.item.error.type;
    }
    return null;
}

function detectQuotaExhausted(logPath, cfg, quotaExhaustedModule, fsImpl) {
    const _fs = fsImpl || fs;
    if (!quotaExhaustedModule) return { matched: false };
    const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['openai-codex']
        || (cfg && cfg.error_types)
        || [];
    if (!allowlist || allowlist.length === 0) return { matched: false };

    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        const errType = _extractErrorType(evt);
        if (errType && allowlist.includes(errType)) {
            return {
                matched: true,
                errorType: errType,
                resetsAt: (evt.error && evt.error.resets_at) || null,
                rawLine: line,
                evt,
            };
        }
    }
    return { matched: false };
}

// -----------------------------------------------------------------------------
// detectAuthenticationRejected (#5795) — clase cerrada `authentication_rejected`.
//
// OpenAI documenta el error de clave inválida como
// `{error:{message:'Incorrect API key provided...', type:'invalid_request_error',
// code:'invalid_api_key'}}` con HTTP 401. El discriminante REAL es el `code`;
// el `type` es el genérico `invalid_request_error`.
//
// POSITIVOS: invalid_api_key, invalid_authentication
//
// NEGATIVOS — 401/403 de OpenAI que NO son credencial inválida:
//   insufficient_quota / billing_hard_limit_reached / rate_limit_exceeded → cuota
//   account_deactivated / permission_denied / unsupported_country_region_territory
//   context_length_exceeded / model_not_found → permanentes
//
// OJO: `invalid_request_error` NO puede ir en la tabla negativa. Es el `type`
// que ACOMPAÑA a `code: invalid_api_key` en el shape real de OpenAI; vetarlo
// haría que la guardia de ambigüedad mate todos los positivos legítimos.
// -----------------------------------------------------------------------------
const detectAuthenticationRejected = authRejection.makeDetector({
    adapter: 'openai-codex',
    positives: ['invalid_api_key', 'invalid_authentication'],
    negatives: [
        'insufficient_quota', 'billing_hard_limit_reached', 'rate_limit_exceeded',
        'tokens_exhausted', 'usage_limit_reached',
        'account_deactivated', 'permission_denied', 'permission_error', 'forbidden',
        'unsupported_country_region_territory',
        'context_length_exceeded', 'model_not_found', 'server_error',
        'service_unavailable', 'engine_overloaded',
    ],
});

module.exports = {
    name: 'openai-codex',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    detectAuthenticationRejected,
    // #4052 CA-2 — pre-flight health-check.
    probeCodexHealth,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _translateClaudeArgsToCodex: translateClaudeArgsToCodex,
    _foldCodexPayload: foldCodexPayload,
    _extractErrorType,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

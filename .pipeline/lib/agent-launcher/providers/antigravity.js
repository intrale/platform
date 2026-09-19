// =============================================================================
// providers/antigravity.js — Handler del provider `antigravity` (Antigravity CLI)
//
// Implementa el contrato del wrapper de agent-launcher para Antigravity CLI
// (binario `agy`, ex provider "Gemini (Google)" hasta #6861) usando OAuth de
// cuenta Google. No existe fallback al Gemini CLI gratuito (retirado) ni a
// ningún endpoint HTTP: es un provider de spawn puro.
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
//      agy NO tiene flag de system prompt, así que el contenido del
//      `--system-prompt-file` se foldea al inicio del prompt.
//      #6859 — el `cwd` se traduce ADEMÁS a `--add-dir <cwd>` (ver bloque
//      "Workspace" más abajo): agy ignora el cwd del proceso y sin ese flag
//      escribe en un scratch propio reportando SUCCESS.
//   3) parseTokensFromLog — agrega los tokens reportados por el CLI. Con
//      `--output-format stream-json` el log es NDJSON y el objeto útil es el
//      `result` del evento `{"event":"result"}`; `_parseAntigravityJson` lo
//      localiza. usage.* y error string respetan el contrato de agy 1.2.x (#7290).
//   4) detectQuotaExhausted — inspecciona el objeto `error` del JSON y matchea
//      por shape estructural (status/code/reason normalizados a lowercase)
//      contra la allowlist canónica en `quota-exhausted.js`
//      (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['antigravity']`).
//
// Auth: OAuth via `agy`; nunca API key. El health (#6857) sale de un
// round-trip real al CLI (`agy models`, ver multi-provider/agy-catalog-probe.js),
// que spawnea EXACTAMENTE el `cmd` que devuelve `detectLauncher()`. No hay
// flag local de "licencia lista": un flag local no puede saber si la licencia
// está activa.
//
// Env vars (#6861, prefijo único `ANTIGRAVITY_`): `ANTIGRAVITY_BIN` (override
// del binario, sólo del process.env del pulpo), `ANTIGRAVITY_MODEL` (modelo,
// la inyecta build-child-env.js) y `ANTIGRAVITY_PRINT_TIMEOUT`. Las constantes
// `AGY_*` de este archivo nombran el contrato del binario `agy`, no env vars.
//
// Seguridad:
//  - Ruta oficial hardcoded y override ANTIGRAVITY_BIN, sin require dinámico.
//  - Args como argv estricto y shell:false.
//  - Detección de cuota SOLO por shape estructural sobre campos dedicados de
//    error (status/code/reason). NUNCA substring sobre `response` (canal de
//    contenido controlado por el modelo).
//  - `--add-dir <cwd>` + `--dangerously-skip-permissions` = escritura sobre el
//    `cwd` que manda el caller. En fases no-dev el Pulpo pasa el repo
//    principal (ROOT), igual que con Claude hoy: mismo modelo de riesgo, no
//    una regresión. Nunca se agrega un dir que el caller no haya pedido.
//
// Workspace (#6859) — por qué `--add-dir` y no `--project`:
//   Antigravity NO trabaja sobre el cwd del proceso. Medido en vivo (3/9 con
//   agy 1.1.20, 16/9 con 1.2.4 y 17/9 con 1.2.5): sin `--add-dir` el CLI
//   responde `SUCCESS`, afirma haber creado el archivo pedido y lo deja en
//   `~/.gemini/antigravity-cli/scratch/`; el directorio pedido queda vacío.
//   Con `--add-dir <dir>` el archivo aparece en `<dir>`. El modo de falla es
//   silencioso: un agente despachado sin el flag "implementa" contra un
//   scratch fantasma y el issue rebota sin diff y sin causa visible.
//   - `--add-dir` es repetible y toma ruta absoluta (`/` o `\` sirven). Es el
//     ÚNICO flag que define el scope de filesystem → `buildSpawn` lo emite
//     SIEMPRE con el `cwd` recibido y acepta `extraDirs` para los adicionales.
//   - `--project` / `--new-project` son identidad de sesión/proyecto en el
//     estado local del CLI (`~/.gemini/antigravity-cli/`), no scope de FS. Un
//     `--new-project` por worktree acumularía un proyecto persistente por
//     issue sin aislamiento medible. Decisión: NO se usan; `--add-dir` alcanza.
//   - Sin `cwd` (o con uno relativo) `buildSpawn` LANZA (CA-4): un launcher
//     que no sabe dónde trabajar tiene que fallar fuerte y visible, nunca
//     caer al scratch. Los tres callers (pulpo, sherlock, commander) siempre
//     pasan un string absoluto y capturan el throw, así que ningún camino
//     vivo cambia de comportamiento.
//   Diagnóstico de un rebote "implementé" sin diff que haya caído a este
//   provider: mirar el scratch (`agyScratchDir()`) antes que el log.
// =============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// #5795 — contrato compartido de la clase cerrada 'authentication_rejected'.
const authRejection = require('../auth-rejection');

// -----------------------------------------------------------------------------
// detectLauncher — ANTIGRAVITY_BIN, ubicación oficial Windows o PATH.
//
// #6857 — `env` / `fsImpl` / `platform` son inyectables para que el probe de
// salud (`agy-catalog-probe.js`) resuelva el binario con LA MISMA función que
// el launcher y ambos miren el mismo archivo. Sin argumentos se comporta igual
// que siempre (process.env / fs / process.platform).
//
// Orden: `ANTIGRAVITY_BIN` explícito → `%LOCALAPPDATA%\agy\bin\agy.exe` (ubicación
// oficial; ese dir está sólo en el PATH de USUARIO, no en el de máquina, así
// que desde los servicios del pipeline el fallback al PATH no lo encuentra) →
// `agy` pelado en el PATH.
// -----------------------------------------------------------------------------
function detectLauncher(env, fsImpl, platform) {
    const _env = env || process.env;
    const _fs = fsImpl || fs;
    const _platform = platform || process.platform;
    if (_env.ANTIGRAVITY_BIN) {
        return { kind: 'configured-native', cmd: _env.ANTIGRAVITY_BIN, prefixArgs: [], shell: false };
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
// translateClaudeArgsToAntigravity — extrae prompt y system file del args estilo
// Claude CLI y arma el argv de agy. Args desconocidos se descartan
// silenciosamente (el shape de stream-json/--verbose/--permission-mode no
// aplica a agy).
//
// Contrato de entrada (lo que el pulpo construye en pulpo.js:5846):
//   ['-p', userPrompt, '--system-prompt-file', systemFile, ...]
//
// Contrato de salida (agy 1.2.x — #6857, #7322, #6859):
//   ['--input-format', 'stream-json', '--output-format', 'stream-json',
//    '--disable-slash-commands',
//    '--dangerously-skip-permissions', '--print-timeout', timeout,
//    '--add-dir', cwd, ('--add-dir', extraDir)*,
//    '--model', model?]
// `--disable-slash-commands` (#7322, AGY_HARDENING_ARGS) va pegado a los flags
// de stream-json: evita que un prompt que empiece con `/` se interprete como
// comando del CLI. `--model` va SIEMPRE al final (los tests lo fijan con
// `slice(-2)`); los `--add-dir` van antes, uno por directorio, sin deduplicar
// contra el cwd.
// El payload real se pipea por STDIN como UNA línea NDJSON
// (`{"event":"user","message":{"role":"user","content":"<system+prompt>"}}`)
// para evitar ENAMETOOLONG en Windows. Verificado en vivo contra agy 1.2.4:
// `--print` sin valor es error (rc=2, "flag needs an argument"), `--print -`
// manda el literal "-" como prompt, y `--input-format stream-json` rechaza
// cualquier prompt en argv ("a prompt given on the command line would be
// ignored"). Esta es la única vía documentada para stdin.
// -----------------------------------------------------------------------------
const AGY_HARDENING_ARGS = Object.freeze(['--disable-slash-commands']);
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
function foldAntigravityPayload(args, env, fsImpl) {
    const _fs = fsImpl || fs;
    let userPrompt = null;
    let systemFile = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-p') { userPrompt = args[i + 1]; i++; }
        else if (a === '--system-prompt-file') { systemFile = args[i + 1]; i++; }
    }
    // Foldear el system file al prompt (agy no tiene --system).
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
// cerrado en #6858, prefijo unificado en #6861).
//
// El modelo llega al handler por UNA sola variable: `ANTIGRAVITY_MODEL`, que es
// la que declara `PROVIDER_MODEL_ENV['antigravity']` en lib/build-child-env.js
// y la que inyecta agent-launcher.js cuando la propagación (#6272) aplica. El
// nombre es nuevo a propósito: ninguna variable exportada en el entorno del
// operador (los nombres viejos con prefijo del CLI retirado o del binario)
// llega al handler, porque sólo lo que propaga build-child-env.js entra al
// env del child.
// Sin `ANTIGRAVITY_MODEL` no se pasa `--model` y el CLI usa su propio default.
//
// Canal de esfuerzo: el sufijo `-high/-medium/-low` del id es el ÚNICO canal.
// Nunca se agrega `--effort` (agy lo expone como flag aparte): dos canales para
// lo mismo harían que la traza no pudiera afirmar qué esfuerzo corrió.
// -----------------------------------------------------------------------------
const MODEL_ENV_VAR = 'ANTIGRAVITY_MODEL';

function resolveModelFromEnv(env) {
    const e = env && typeof env === 'object' ? env : {};
    // Lectura literal (no por clave dinámica) a propósito: el guardrail CA-7 de
    // tests/model-propagation.test.js cruza `PROVIDER_MODEL_ENV` contra este
    // archivo buscando `env.ANTIGRAVITY_MODEL`.
    const raw = e.ANTIGRAVITY_MODEL; // === env.ANTIGRAVITY_MODEL (MODEL_ENV_VAR)
    const model = (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim() : null;
    return {
        model,
        source: model ? MODEL_ENV_VAR : 'cli-default',
    };
}

function translateClaudeArgsToAntigravity(args, env, workspace) {
    // Modelo: SÓLO `ANTIGRAVITY_MODEL` (ver resolveModelFromEnv). Sin ella dejamos
    // al CLI elegir su default. El pulpo inyecta ANTIGRAVITY_MODEL desde
    // agent-launcher.js (propagación #6272) con el id resuelto para el skill (#6271).
    const { model } = resolveModelFromEnv(env);
    const timeout = (env && env.ANTIGRAVITY_PRINT_TIMEOUT) || '5m';
    const out = [...AGY_STREAM_INPUT_ARGS, ...AGY_HARDENING_ARGS, '--dangerously-skip-permissions', '--print-timeout', timeout];
    // #6859 — workspace explícito: agy ignora el cwd del proceso.
    const ws = workspace && typeof workspace === 'object' ? workspace : {};
    if (typeof ws.cwd === 'string' && ws.cwd.length > 0) out.push('--add-dir', ws.cwd);
    for (const dir of (Array.isArray(ws.extraDirs) ? ws.extraDirs : [])) {
        if (typeof dir === 'string' && dir.length > 0) out.push('--add-dir', dir);
    }
    if (model) out.push('--model', model);
    return out;
}

// -----------------------------------------------------------------------------
// Workspace (#6859) — helpers de validación y diagnóstico.
//
// `agyScratchDir()` resuelve `~/.gemini/antigravity-cli/scratch` (el destino
// fantasma cuando falta `--add-dir`). Se usa en el mensaje de error de CA-4 y
// lo consumen los tests/smoke para asertar que quedó SIN cambios tras un spawn.
// `homedir` es inyectable para tests.
//
// `assertWorkspaceDir(value, label, env)` acepta SOLO strings no vacíos con
// ruta absoluta (`path.isAbsolute`). Todo lo demás lanza `Error` con
// `code = 'AGY_WORKSPACE_REQUIRED'` y un mensaje accionable que incluye
// `PIPELINE_ISSUE` / `PIPELINE_SKILL` si vienen en `env` (rastreo en logs sin
// abrir el código) y el path del scratch como pista de diagnóstico.
// -----------------------------------------------------------------------------
const AGY_SCRATCH_RELATIVE = Object.freeze(['.gemini', 'antigravity-cli', 'scratch']);
const AGY_WORKSPACE_ERROR_CODE = 'AGY_WORKSPACE_REQUIRED';

function agyScratchDir(homedir) {
    const home = (typeof homedir === 'string' && homedir) ? homedir : os.homedir();
    return path.join(home, ...AGY_SCRATCH_RELATIVE);
}

function _describeValue(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    return `${typeof v}:${String(v)}`;
}

function assertWorkspaceDir(value, label, env) {
    const ok = typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
    if (ok) return value;
    const e = env && typeof env === 'object' ? env : {};
    const ctx = [];
    if (typeof e.PIPELINE_ISSUE === 'string' && e.PIPELINE_ISSUE) ctx.push(`issue #${e.PIPELINE_ISSUE}`);
    if (typeof e.PIPELINE_SKILL === 'string' && e.PIPELINE_SKILL) ctx.push(`skill ${e.PIPELINE_SKILL}`);
    const ctxText = ctx.length ? ` [${ctx.join(', ')}]` : '';
    const err = new Error(
        `Antigravity: buildSpawn requiere un '${label}' absoluto para ubicar el workspace del agente`
        + `${ctxText} (recibió: ${_describeValue(value)}). Sin --add-dir el agente escribiría en el `
        + `scratch fantasma (${agyScratchDir()}) reportando SUCCESS y el issue rebotaría sin diff. `
        + `El caller tiene que pasar el worktree o el ROOT del repo como ruta absoluta.`,
    );
    err.code = AGY_WORKSPACE_ERROR_CODE;
    err.received = value;
    throw err;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve { cmd, args, spawnOpts, modelTrace } compatible con
// child_process.spawn.
//
// `args` vienen en formato Claude (ver pulpo.js:5846); acá los traducimos al
// shape de agy y prependemos el prefijo del launcher detectado.
//
// `cwd` (#6859) — OBLIGATORIO y absoluto: se traduce a `--add-dir <cwd>` y se
// mantiene en `spawnOpts.cwd`. `extraDirs` (opcional, string[]) agrega un
// `--add-dir` por cada directorio adicional que el agente necesite. Ausente,
// vacío o relativo → `Error` con `code='AGY_WORKSPACE_REQUIRED'` (ver
// `assertWorkspaceDir`); nunca se cae al scratch del CLI.
//
// `modelTrace` (#6334/#6858/#6861) — misma forma que el handler de Anthropic
// para que agent-launcher.js lo audite sin casos especiales:
//   { applied: true, model, source: 'ANTIGRAVITY_MODEL', reason: 'ok' }
// Sin `ANTIGRAVITY_MODEL` NO se agrega la clave (regresión cero): el agente
// arranca con el default del CLI y no hay nada que auditar.
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported, extraDirs }) {
    const launcher = getLauncher();
    // #6859 — fail-fast (CA-4): sin cwd absoluto no hay workspace y agy caería
    // al scratch en silencio. Los directorios adicionales se validan igual.
    const workspaceCwd = assertWorkspaceDir(cwd, 'cwd', env);
    const workspaceExtra = (Array.isArray(extraDirs) ? extraDirs : [])
        .map((d) => assertWorkspaceDir(d, 'extraDirs[]', env));
    const agyArgs = translateClaudeArgsToAntigravity(args || [], env || {}, { cwd: workspaceCwd, extraDirs: workspaceExtra });
    // #4529 — payload (system foldeado + mensaje) por STDIN, nunca por argv.
    // stdin SIEMPRE 'pipe'; el caller escribe `stdinPayload` y cierra stdin.
    // #6857 — serializado como NDJSON para `--input-format stream-json`.
    const stdinPayload = encodeStreamJsonPayload(foldAntigravityPayload(args || [], env || {}));
    // #6334/#6858 — traza del modelo que realmente viaja en `--model`.
    const resolved = resolveModelFromEnv(env || {});
    let modelTrace = null;
    if (resolved.model) {
        modelTrace = { applied: true, model: resolved.model, source: resolved.source, reason: 'ok' };
    }
    return {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...agyArgs],
        kind: launcher.kind,
        // #4529 — payload grande por stdin (paridad con el path primario).
        stdinPayload,
        ...(modelTrace ? { modelTrace } : {}),
        spawnOpts: {
            // #6859 — se mantiene en spawnOpts (paridad con los demás handlers)
            // aunque agy no lo use: el workspace real viaja en `--add-dir`.
            cwd: workspaceCwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
            shell: launcher.shell,
            windowsHide: true,
            env,
        },
    };
}

// -----------------------------------------------------------------------------
// _parseAntigravityJson — extrae el objeto JSON del log de agy (-o json).
//
// agy escribe a stdout un único objeto JSON. El log puede tener prefijo o
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
function _parseAntigravityJson(raw) {
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
// #6858 — Shape de agy 1.2.4 (medido en vivo el 2026-09-16 con `--output-format
// json` y re-medido con `--output-format stream-json` — #7298 — donde el mismo
// objeto viaja dentro del evento `{"event":"result","result":{...}}` que
// `_parseAntigravityJson` desenvuelve; fixture agy-stream-json-1.2.4.ndjson):
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
    const obj = _parseAntigravityJson(raw);
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
// detectQuotaExhausted — inspecciona el objeto `error` del JSON de agy y
// matchea por shape estructural contra la allowlist canónica del provider en
// `quota-exhausted.js` (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['antigravity']`
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
    const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['antigravity']
        || (cfg && cfg.error_types)
        || [];
    if (!allowlist || allowlist.length === 0) return { matched: false };

    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    const obj = _parseAntigravityJson(raw);
    if (!obj) return { matched: false };

    if (typeof obj.error === 'string') {
        return quotaExhaustedModule._detectAntigravity({ event: 'result', result: obj }, allowlist);
    }

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
    adapter: 'antigravity',
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
    name: 'antigravity',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    detectAuthenticationRejected,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _translateClaudeArgsToAntigravity: translateClaudeArgsToAntigravity,
    // #6334/#6858 — precedencia explícita del modelo.
    MODEL_ENV_VAR,
    resolveModelFromEnv,
    _foldAntigravityPayload: foldAntigravityPayload,
    _encodeStreamJsonPayload: encodeStreamJsonPayload,
    AGY_STREAM_INPUT_ARGS,
    AGY_HARDENING_ARGS,
    // #6859 — workspace explícito (`--add-dir`) y diagnóstico del scratch.
    AGY_WORKSPACE_ERROR_CODE,
    AGY_SCRATCH_RELATIVE,
    agyScratchDir,
    assertWorkspaceDir,
    _parseAntigravityJson,
    _extractErrorTokens,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

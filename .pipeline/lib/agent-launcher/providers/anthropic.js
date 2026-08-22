// =============================================================================
// providers/anthropic.js — Handler del provider Anthropic (Claude Code CLI)
//
// Encapsula:
//  - Detección multi-tier del launcher de Claude Code (`detectLauncher`).
//  - Construcción del comando spawn (`buildSpawn`).
//  - Parseo de tokens desde el log stream-json del agente (`parseTokensFromLog`).
//  - Detección de cuota agotada en el log (`detectQuotaExhausted`).
//
// Migrado desde `pulpo.js` (issue #3074 / H2 multi-provider) preservando
// invariantes de seguridad I1, I5, I6 y comportamiento byte-identical del
// objeto que recibe `child_process.spawn`.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
// #5795 — contrato compartido de la clase cerrada 'authentication_rejected'.
const authRejection = require('../auth-rejection');
// #6272 — whitelist estricta del id de modelo antes de tocar argv (SR-A.1).
const { sanitizeModelId } = require('../../model-propagation');

// -----------------------------------------------------------------------------
// detectLauncher — multi-tier detection (preservar orden de precedencia I6)
//
// La estructura del paquete @anthropic-ai/claude-code cambió entre versiones
// (2.1.114 eliminó cli.js y lo reemplazó con bin/claude.exe nativo +
// cli-wrapper.cjs fallback). Probamos opciones de más a menos preferida; todas
// evitan cmd.exe cuando es posible.
//
// Orden (NO REORDENAR — preservar invariante I6 de seguridad):
//   1. Legacy cli.js → node directo (compat con versiones viejas, shell:false)
//   2. Binario nativo bin/claude.exe (≥2.1.114, shell:false)
//   3. cli-wrapper.cjs → node directo (fallback JS, shell:false)
//   4. .cmd shim de npm → shell:true (los shims .cmd requieren cmd.exe)
//   5. PATH fallback → process.env.CLAUDE_BIN o 'claude' (último recurso)
// -----------------------------------------------------------------------------
function detectLauncher() {
    const pkgDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    const cliJsLegacy = path.join(pkgDir, 'cli.js');
    const binExe = path.join(pkgDir, 'bin', 'claude.exe');
    const wrapperCjs = path.join(pkgDir, 'cli-wrapper.cjs');
    const cmdShim = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');

    // 1. Legacy cli.js → node directo (compatibilidad con versiones viejas)
    if (fs.existsSync(cliJsLegacy)) {
        return { kind: 'node-cli-js', cmd: process.execPath, prefixArgs: [cliJsLegacy], shell: false };
    }
    // 2. Binario nativo (Claude Code ≥2.1.114) → ruta absoluta, sin shell
    if (fs.existsSync(binExe)) {
        return { kind: 'native-exe', cmd: binExe, prefixArgs: [], shell: false };
    }
    // 3. cli-wrapper.cjs → node directo (fallback JS del propio paquete)
    if (fs.existsSync(wrapperCjs)) {
        return { kind: 'node-wrapper-cjs', cmd: process.execPath, prefixArgs: [wrapperCjs], shell: false };
    }
    // 4. .cmd shim con ruta absoluta → shell:true (shims .cmd requieren shell en spawn)
    if (fs.existsSync(cmdShim)) {
        return { kind: 'cmd-shim', cmd: cmdShim, prefixArgs: [], shell: true };
    }
    // 5. Último recurso: 'claude' en PATH con shell
    return { kind: 'path-fallback', cmd: process.env.CLAUDE_BIN || 'claude', prefixArgs: [], shell: true };
}

// Cache del launcher detectado (boot-time). Reusable entre llamadas.
let cachedLauncher = null;
function getLauncher() {
    if (!cachedLauncher) cachedLauncher = detectLauncher();
    return cachedLauncher;
}
// Para tests: permite forzar un launcher específico sin tocar el filesystem.
function _setLauncherForTesting(launcher) {
    cachedLauncher = launcher;
}
function _resetLauncherCacheForTesting() {
    cachedLauncher = null;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve el objeto que el wrapper pasa a child_process.spawn.
//
// Contrato:
//   input:  { args, cwd, env, interactive_supported, model? }
//   output: { cmd, args, spawnOpts, modelTrace? }
//
// `args` ya viene completo con --system-prompt-file, --output-format, etc.
// Acá solo prependemos `prefixArgs` del launcher (ej. la ruta a cli.js cuando
// usamos node directo) y armamos `spawnOpts` con shell del launcher.
//
// #6272 — `model` (OPCIONAL). Cuando el launcher lo pasa, se agrega como
// `['--model', id]`: DOS ELEMENTOS SEPARADOS del array de args, nunca por
// interpolación de string. `detectLauncher` puede devolver `shell:true` (tiers 4
// y 5: cmd-shim / path-fallback), así que un id con metacaracteres se
// interpretaría en `cmd.exe` — por eso el valor pasa ANTES por la whitelist
// estricta (SR-A.1, `lib/model-propagation.js`). Si no valida, el flag se OMITE,
// el agente hereda el default del CLI y queda `modelTrace` para la traza del
// caller: nunca se aborta el spawn (CA-3).
//
// Defensa en profundidad a propósito: el launcher ya validó el id antes de
// llegar acá, pero `buildSpawn` es la ÚLTIMA frontera antes de argv y no confía
// en su caller. Un handler nuevo que reuse esta función (ej. kimi-moonshot)
// hereda la validación sin tener que acordarse de pedirla.
//
// Regresión cero (CA-4): con `model` undefined el objeto devuelto es idéntico al
// previo — mismos args, mismo `spawnOpts`, y sin la clave `modelTrace`.
//
// Posición del flag: inmediatamente después de `prefixArgs` y ANTES de `args`,
// para no quedar detrás de un eventual argumento posicional del CLI.
// -----------------------------------------------------------------------------
function buildSpawn({ args, cwd, env, interactive_supported, model }) {
    const launcher = getLauncher();
    // #3605 — Opt-in por skill+provider. Default 'ignore' preserva I3
    // (regresión cero CA-4); 'pipe' habilita stdin para chat operador→agente.
    const stdin = interactive_supported === true ? 'pipe' : 'ignore';

    // #6272 — el flag sólo entra en juego si el caller pidió propagar. `undefined`
    // = camino legacy intacto (no se evalúa la whitelist ni se agrega `modelTrace`).
    let modelArgs = [];
    let modelTrace = null;
    if (model !== undefined && model !== null) {
        const sane = sanitizeModelId(model);
        if (sane.model) {
            modelArgs = ['--model', sane.model];
            modelTrace = { applied: true, model: sane.model, reason: 'ok' };
        } else {
            modelTrace = { applied: false, model: null, reason: sane.reason };
        }
    }

    const out = {
        cmd: launcher.cmd,
        args: [...launcher.prefixArgs, ...modelArgs, ...args],
        spawnOpts: {
            cwd,
            stdio: [stdin, 'pipe', 'pipe'],
            detached: false,
            shell: launcher.shell,
            windowsHide: true,
            env,
        },
    };
    if (modelTrace) out.modelTrace = modelTrace;
    return out;
}

// -----------------------------------------------------------------------------
// parseTokensFromLog — agrega usage de cada turno `assistant` del stream-json.
//
// Stream JSON line-por-línea — algunas líneas son truncadas o quedan a mitad
// por timeouts; el try/catch las descarta sin afectar el resto (invariante I5
// de seguridad: try/catch POR LÍNEA, no por archivo).
// -----------------------------------------------------------------------------
function parseTokensFromLog(logPath, fsImpl) {
    const _fs = fsImpl || fs;
    const totals = { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
    try {
        const raw = _fs.readFileSync(logPath, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.startsWith('{')) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.type === 'assistant' && obj.message && obj.message.usage) {
                const u = obj.message.usage;
                totals.input += Number(u.input_tokens || 0);
                totals.output += Number(u.output_tokens || 0);
                totals.cache_read += Number(u.cache_read_input_tokens || 0);
                totals.cache_create += Number(u.cache_creation_input_tokens || 0);
                if (Array.isArray(obj.message.content)) {
                    totals.tool_calls += obj.message.content.filter((c) => c.type === 'tool_use').length;
                }
            }
        }
    } catch { /* log no existe o ilegible */ }
    return totals;
}

// -----------------------------------------------------------------------------
// detectQuotaExhausted — busca un result event con shape de cuota agotada
// (ej. error_type === 'rate_limit_error' || matches del patrón configurado).
//
// #3576 CA-4: refactoreado para consumir el parser generalizado
// (`lib/agent-launcher/provider-error-parser`). El parser ya delega a
// `quotaModule._detectAnthropic` con la allowlist por provider, lo que
// preserva la semántica original (mismo errorType, mismas líneas detectadas)
// sin duplicar la lógica de match estructural.
//
// Contrato preservado (no breaking para callers existentes ni tests):
//   {matched, errorType, resetsAt, rawLine, evt} | {matched: false}
//
// El segundo parámetro `cfg` se acepta pero ya no se usa para el dispatcher
// de matching (el parser interno tiene su propia allowlist via
// `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER`). Lo mantenemos en la firma por
// compatibilidad con callers existentes (anclados al shape del módulo
// `quota-exhausted.js`).
// -----------------------------------------------------------------------------
function detectQuotaExhausted(logPath, cfg, quotaExhaustedModule, fsImpl, parserModuleOverride) {
    const _fs = fsImpl || fs;
    if (!quotaExhaustedModule || typeof quotaExhaustedModule._detectAnthropic !== 'function') {
        return { matched: false };
    }
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    // Parser generalizado (#3576). Lo cargamos perezosamente para evitar
    // ciclos de require (parser ↔ providers ↔ launcher) y para permitir
    // inyectar fakes en tests.
    const parser = parserModuleOverride || require('../provider-error-parser');

    // El parser opera sobre el contenido como `transport: 'cli'`. Le pasamos
    // todo el log (truncado internamente a 64KB por SR-3) — el parser barre
    // línea por línea y detecta el primer match estructural.
    let verdict;
    try {
        verdict = parser.parseProviderError(raw, {
            provider: 'anthropic',
            transport: 'cli',
            _quotaModule: quotaExhaustedModule,
        });
    } catch {
        return { matched: false };
    }

    if (!verdict || verdict.errorClass !== 'quota_exhausted') {
        return { matched: false };
    }

    // El parser nos da la línea exacta (evidence) y el errorType detectado va
    // implícito (lo extraemos del evidence para preservar el contrato existente).
    // Iteramos las líneas que arrancan con `{` para recuperar el evt completo
    // (el contrato original expone `evt` y `resetsAt` que NO vienen del parser).
    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        // Re-evaluamos contra _detectAnthropic con la allowlist canónica para
        // que el errorType extraído mantenga byte-identidad con el detector
        // legacy (los tests existentes de anthropic.js dependen de esto).
        const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['anthropic']
            || (cfg && cfg.error_types)
            || [];
        const r = quotaExhaustedModule._detectAnthropic(evt, allowlist, {
            providerId: 'anthropic',
        });
        if (r && r.matched) {
            // #5455 — El canal de contenido devuelve un resultado DISCRIMINADO
            // con `resetsAt` ya parseado desde el texto del aviso (el frame no
            // trae `evt.resets_at`), más `source`/`rawExcerpt` redactado. Los
            // propagamos para que el caller pueda persistir vía `setFlag` sin
            // volver a parsear nada. Para los matches estructurales de siempre,
            // `r.resetsAt` es `undefined` y cae a `evt.resets_at` (contrato
            // previo intacto).
            return {
                matched: true,
                errorType: r.errorType,
                resetsAt: r.resetsAt != null ? r.resetsAt : evt.resets_at,
                ...(r.source ? { source: r.source } : {}),
                ...(r.rawExcerpt ? { rawExcerpt: r.rawExcerpt } : {}),
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
// Anthropic documenta una taxonomía de `error.type` acotada y explícita. El
// único tipo que significa "la credencial presentada no sirve" es
// `authentication_error` (HTTP 401, "There's an issue with your API key").
//
// POSITIVOS: authentication_error
//
// NEGATIVOS — el resto de la taxonomía documentada. `permission_error` es el
// que más se confunde: es HTTP 403 y significa que la clave ES VÁLIDA pero no
// tiene permiso sobre el recurso. Clasificarlo como credencial rechazada haría
// que el coordinador de #5794 re-resuelva una credencial sana y consuma su
// presupuesto al pedo.
//
// NO hay entrada para `invalid_api_key`: ese es el código de OpenAI y Anthropic
// no lo documenta. Si aparece en un log de un spawn Anthropic (frame ajeno
// embebido, tool_result, inyección), este detector devuelve "sin clasificación"
// — que es justo el aislamiento cross-provider que pide el issue.
// -----------------------------------------------------------------------------
const detectAuthenticationRejected = authRejection.makeDetector({
    adapter: 'anthropic',
    positives: ['authentication_error'],
    negatives: [
        'permission_error', 'billing_error',
        'rate_limit_error', 'usage_limit_error', 'weekly_quota_exhausted',
        'invalid_request_error', 'not_found_error', 'request_too_large',
        'api_error', 'overloaded_error', 'timeout_error',
    ],
});

module.exports = {
    name: 'anthropic',
    detectLauncher: getLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
    detectAuthenticationRejected,
    // exports internos para tests
    _detectLauncherFresh: detectLauncher,
    _setLauncherForTesting,
    _resetLauncherCacheForTesting,
};

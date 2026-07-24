// V3 Traceability helpers — emite eventos session:start / session:end al activity-log
// Contrato definido en issue #2477 y extendido en #3083 (S5 multi-provider).
// Los consumen skills LLM y skills determinísticos.
//
// Uso típico (skill determinístico):
//   const trace = require('./traceability');
//   const ctx = trace.emitSessionStart({ skill: 'builder', issue: 2476, phase: 'build', provider: 'deterministic' });
//   // ... trabajo ...
//   trace.emitSessionEnd(ctx, { tool_calls: 0 });
//
// Uso típico (skill LLM, instrumentación desde pulpo.js):
//   const ctx = trace.emitSessionStart({
//       skill: 'android-dev', issue: 2476, phase: 'dev',
//       // (#3083) provider+model resueltos por agent-models.json (#3072).
//       // Prohibido pasar literales hardcoded — el caller no debe inventar el modelo.
//       provider: launchResult.provider,
//       model: launchResult.model,
//       cli_version: trace.resolveCliVersion(launcherPath),         // spawneado al boot, cacheado
//       git_sha_provider_adapter: trace.resolveProviderAdapterSha(adapterPath),
//       prompt_hash: trace.hashPromptPair(systemContent, userContent), // SHA-256 hex lowercase
//   });
//   // al terminar, extraer tokens del stream-json:
//   trace.emitSessionEnd(ctx, { tokens_in, tokens_out, cache_read, cache_write, tool_calls });

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

function resolveRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || process.env.PIPELINE_REPO_ROOT || 'C:\\Workspaces\\Intrale\\platform';
    try {
        const gitCommon = execSync('git rev-parse --git-common-dir', { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, '/');
        if (gitCommon === '.git') return candidate;
        const gitIdx = gitCommon.indexOf('/.git');
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, '..');
    } catch (e) { return candidate; }
}

const REPO_ROOT = resolveRepoRoot();
const LOG_FILE = path.join(REPO_ROOT, '.claude', 'activity-log.jsonl');

// (#3083 / SEC-6) Piso hardcoded de retención forense. Cualquier configuración
// menor a este valor (por error humano o config maliciosa) se eleva al piso
// antes de aplicar. NO leer de config — el clamp tiene que vivir en código.
const AUDIT_RETENTION_FLOOR_DAYS = 30;
const AUDIT_RETENTION_DEFAULT_DAYS = 90;

/**
 * (#3083 / CA-7 / SEC-6) Eleva al piso de retención cualquier valor < 30 días.
 * Default 90. Acepta number/string/null. Si llega `undefined`/`null`/NaN → 90.
 * Si llega un número finito < 30 → 30. Si llega ≥ 30 → ese valor (sin tope superior).
 *
 * Justificación: una config maliciosa o un error humano (`retention_days: 1`)
 * borraría evidencia forense antes de un incidente. El clamp vive en código
 * para que no se pueda bypassear desde `config.yaml`.
 */
function clampRetentionDays(value) {
    if (value === undefined || value === null || value === '') return AUDIT_RETENTION_DEFAULT_DAYS;
    const n = Number(value);
    if (!Number.isFinite(n)) return AUDIT_RETENTION_DEFAULT_DAYS;
    if (n < AUDIT_RETENTION_FLOOR_DAYS) return AUDIT_RETENTION_FLOOR_DAYS;
    return Math.floor(n);
}

function appendEvent(evt) {
    try {
        // (#3083 / CA-5) JSON.stringify garantiza que newlines / quotes dentro
        // de strings (ej. `model: "fake\n{tampered}"`) queden escapados — no
        // pueden inyectar una línea adicional al log. Test SEC-5 lo verifica.
        const line = JSON.stringify(evt) + '\n';
        // (#3083 / CA-4 / SEC-4) Append-only enforced: SIEMPRE `appendFileSync`,
        // nunca `writeFileSync` ni flags `w`/`r+`/`a+`. Si en algún momento esto
        // cambia, el test SEC-4 falla (lint estático de no-regresión).
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (e) {
        // no throw — la traza nunca debe romper un skill
        try { process.stderr.write('[traceability] append failed: ' + e.message + '\n'); } catch(_) {}
    }
}

// =============================================================================
// (#3083 / CA-3 / SEC-1) Hash de prompts — NUNCA persistir contenido del prompt
// =============================================================================
//
// El módulo `traceability.js` NUNCA recibe el contenido del prompt como
// parámetro a `emitSessionStart` o `emitSessionEnd`. El caller (pulpo.js)
// hashea con este helper ANTES del spawn y pasa solo el digest.
//
// Algoritmo (documentado en docs/pipeline-multi-provider.md §6.8):
//   1. Inputs: `systemContent` y `userContent` (strings).
//   2. Normalización: UTF-8 NFC, sin trim, conservar bytes literales.
//   3. Concatenación: `system + SOH + user`, donde SOH es el byte ``
//      (Start Of Heading, no imprimible, jamás aparece en prompts en texto).
//   4. Hash: SHA-256 hex lowercase (64 chars).
//
// Si alguno de los inputs es nulo/undefined → `null` (sesiones sin prompt:
// skills determinísticos, sesiones de test).
const PROMPT_HASH_SEPARATOR = ''; // SOH — byte no imprimible, no aparece en texto.

function hashPromptPair(systemContent, userContent) {
    if (systemContent === undefined || systemContent === null) return null;
    if (userContent === undefined || userContent === null) return null;
    try {
        const sys = String(systemContent).normalize('NFC');
        const usr = String(userContent).normalize('NFC');
        const combined = sys + PROMPT_HASH_SEPARATOR + usr;
        return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
    } catch (e) {
        // Si la normalización o el hash fallan (memoria, encoding raro), no
        // queremos romper el spawn. `null` deja claro que no hay prompt
        // verificable — el aggregator lo trata como legacy.
        try { process.stderr.write('[traceability] hashPromptPair failed: ' + e.message + '\n'); } catch(_) {}
        return null;
    }
}

// =============================================================================
// (#3083 / CA-2 / SEC-3) Resolución de cli_version — al boot, cacheado
// =============================================================================
//
// El `cli_version` se resuelve via `<launcher> --version` UNA VEZ por launcher
// path y se cachea. Reglas:
//   - Si el launcher es deterministic / vacío → `'n/a'`.
//   - Si el spawn falla / timeout / exit != 0 → `'unknown'`.
//   - Caso éxito → la salida `trim()`-eada, recortada a 200 chars (defensa
//     contra launchers que devuelven kilobytes).
// Nunca `null` / `undefined` — el log siempre lleva string no-vacío.
//
// Cache: Map<launcherPath, version>. NO se invalida en runtime; reinicio del
// pulpo basta para refrescar (criterio operacional: si cambia el binario, hay
// `/restart` de por medio).
const _cliVersionCache = new Map();

function resolveCliVersion(launcherPath, opts) {
    opts = opts || {};
    if (!launcherPath || typeof launcherPath !== 'string') return 'n/a';
    const cached = _cliVersionCache.get(launcherPath);
    if (cached) return cached;
    const _spawnSync = opts.spawnSyncImpl || spawnSync;
    let result;
    try {
        result = _spawnSync(launcherPath, ['--version'], {
            timeout: 5000,
            encoding: 'utf8',
            windowsHide: true,
            shell: false,
        });
    } catch (e) {
        _cliVersionCache.set(launcherPath, 'unknown');
        return 'unknown';
    }
    if (!result || result.error || result.status !== 0) {
        _cliVersionCache.set(launcherPath, 'unknown');
        return 'unknown';
    }
    const raw = String(result.stdout || result.stderr || '').trim();
    if (!raw) {
        _cliVersionCache.set(launcherPath, 'unknown');
        return 'unknown';
    }
    const ver = raw.slice(0, 200);
    _cliVersionCache.set(launcherPath, ver);
    return ver;
}

function _resetCliVersionCacheForTesting() {
    _cliVersionCache.clear();
}

// =============================================================================
// (#3083 / CA-2 / SEC-2) Resolución del SHA del adaptador del provider
// =============================================================================
//
// El SHA del archivo del adaptador en uso (ej. `.pipeline/lib/agent-launcher/
// providers/anthropic.js`) se resuelve via `git hash-object <file>`. Esto da
// el hash del CONTENIDO del archivo, no de un commit — si alguien edita el
// adaptador y olvida commit, el SHA cambia (deseado para forensia).
//
// **SEC-2**: PROHIBIDO leerlo de env vars. Un atacante con control de spawn
// args puede setear `PROVIDER_ADAPTER_SHA=fake-sha` y mentir sobre qué
// adaptador estaba activo. La resolución es siempre filesystem-driven.
//
// Si falla (git no disponible, archivo no existe, repo corrupto) → `null`
// (señalable como "no resoluble" en el log).
function resolveProviderAdapterSha(adapterPath, opts) {
    opts = opts || {};
    if (!adapterPath || typeof adapterPath !== 'string') return null;
    const _execSync = opts.execSyncImpl || execSync;
    const _fs = opts.fsImpl || fs;
    try {
        if (!_fs.existsSync(adapterPath)) return null;
    } catch { return null; }
    try {
        // `git hash-object <file>` no requiere que el archivo esté commiteado.
        // Es un hash determinístico del contenido (SHA-1 hex 40 chars).
        const out = _execSync(`git hash-object "${adapterPath}"`, {
            cwd: REPO_ROOT,
            timeout: 5000,
            windowsHide: true,
            encoding: 'utf8',
        });
        const sha = String(out).trim();
        if (/^[a-f0-9]{40}$/.test(sha)) return sha;
        return null;
    } catch (e) {
        return null;
    }
}

function pick(obj, key, fallback) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    return fallback;
}

// =============================================================================
// (#3088 / CA-6) Lookup del contexto de sesión por (issue, skill)
// =============================================================================
//
// `getSessionContext` lee el último `session:start` registrado para una
// combinación (issue, skill) en el activity-log y devuelve la metadata
// multi-provider asociada. Es el **single source of truth** que consume
// `rejection-report.js` para inyectar provider/model/cli_version en el PDF
// y narración.
//
// Reglas de seguridad (#3088 SEC-3, alineado con #3083):
//   - Lee SIEMPRE del activity-log persistido. NO infiere provider por
//     substring del model name (envenena análisis "Codex rebota más en X").
//   - NO re-resuelve `cli_version` ejecutando `--version` (el binario puede
//     haber cambiado entre la sesión y el reporte).
//   - NUNCA throw. Sobre I/O o JSON parse errors devuelve `null`.
//
// Opciones:
//   - `issue` (number, obligatorio): número de issue a buscar.
//   - `skill` (string, obligatorio): nombre del skill.
//   - `recentWindow` (number, opcional): si > 0, se calcula `recent_switch`
//     (true si la ventana de N últimas sesiones del skill contiene >1
//     combinaciones (provider, model) distintas) y `first_with_combo`
//     (true si la combinación de la sesión matched no aparece en sesiones
//     anteriores del skill dentro del registro leído).
//   - `logFile` (string, opcional, testing): override del path del log.
//   - `fsImpl` (object, opcional, testing): override de fs.
//
// Devuelve `{ provider, model, cli_version, git_sha_provider_adapter,
//   ts_session_start [, recent_switch, first_with_combo] }` o `null`.
function getSessionContext(opts) {
    opts = opts || {};
    const targetIssue = opts.issue !== undefined && opts.issue !== null
        ? Number(opts.issue) : null;
    const targetSkill = opts.skill || null;
    const recentWindow = Math.max(0, Number(opts.recentWindow || 0));
    const logFile = opts.logFile || LOG_FILE;
    const _fs = opts.fsImpl || fs;

    if (!Number.isFinite(targetIssue) || !targetSkill) return null;

    let raw;
    try {
        if (!_fs.existsSync(logFile)) return null;
        // (#3088 / SEC-3) Lee cola del archivo (últimos ~2MB) para evitar
        // costo prohibitivo en archivos grandes. Esa ventana cubre miles de
        // sesiones — más que suficiente para el lookup y las reglas
        // determinísticas. Si la sesión es más vieja, fallback a `null` →
        // rejection-report cae a literal "unknown" (SEC-3 OK).
        const stat = _fs.statSync(logFile);
        const READ_BYTES = 2 * 1024 * 1024;
        const readSize = Math.min(stat.size, READ_BYTES);
        const fd = _fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(readSize);
        _fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
        _fs.closeSync(fd);
        raw = buf.toString('utf8');
    } catch (e) {
        return null;
    }

    const lines = raw.split('\n');
    // Si quedamos a mitad de una línea (truncamiento del tail), descartamos la
    // primera para que el JSON.parse no falle silenciosamente.
    if (lines.length > 0 && !lines[0].endsWith('}')) lines.shift();

    const skillSessions = []; // session:start ordenadas cronológicamente por skill
    let matched = null;
    let matchedIdx = -1;
    for (const line of lines) {
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (!evt || evt.event !== 'session:start') continue;
        if (evt.skill !== targetSkill) continue;
        skillSessions.push(evt);
        if (Number(evt.issue) === targetIssue) {
            matched = evt;
            matchedIdx = skillSessions.length - 1;
        }
    }
    if (!matched) return null;

    // (#3088 / SEC-3) Fallback literal "unknown" — NO inferir, NO undefined.
    const result = {
        provider: matched.provider || 'unknown',
        model: matched.model || 'unknown',
        cli_version: matched.cli_version || 'unknown',
        git_sha_provider_adapter: matched.git_sha_provider_adapter || null,
        ts_session_start: matched.ts || null,
    };

    if (recentWindow > 0) {
        // first_with_combo: ¿hay alguna sesión PREVIA del skill (cronológicamente)
        // con la misma (provider, model)? Si no → es la primera. Esto cubre la
        // regla 1 de CA-2 ("primera sesión con la combinación").
        let firstWithCombo = true;
        for (let i = 0; i < matchedIdx; i++) {
            const s = skillSessions[i];
            if (s.provider === matched.provider && s.model === matched.model) {
                firstWithCombo = false;
                break;
            }
        }
        // recent_switch: en las últimas `recentWindow` sesiones del skill hubo
        // >1 combinación (provider, model) distinta. Esto cubre la regla 2 de
        // CA-2 ("switch automático cross-provider/cross-model reciente").
        const recent = skillSessions.slice(-recentWindow);
        const combos = new Set();
        let recentSwitch = false;
        for (const s of recent) {
            combos.add(`${s.provider}|${s.model}`);
            if (combos.size > 1) { recentSwitch = true; break; }
        }
        result.first_with_combo = firstWithCombo;
        result.recent_switch = recentSwitch;
    }
    return result;
}

function envCtx() {
    return {
        skill: process.env.PIPELINE_SKILL || null,
        issue: process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null,
        phase: process.env.PIPELINE_FASE || process.env.PIPELINE_PHASE || null,
        // (#3078) `provider` también se propaga via env para skills determinísticos
        // y para callers que no lo pasan explícito — paralelo a PIPELINE_SKILL.
        provider: process.env.PIPELINE_PROVIDER || null,
    };
}

function emitSessionStart(opts) {
    opts = opts || {};
    const env = envCtx();
    const resolvedProvider = pick(opts, 'provider', env.provider);
    const isDeterministic = resolvedProvider === 'deterministic';
    // (#3083 / CA-8) Contrato explícito para skills determinísticos:
    //   provider: 'deterministic'
    //   cli_version: 'n/a'
    //   git_sha_provider_adapter: null
    //   prompt_hash: null   (en emitSessionEnd — start no lo persiste)
    // El default de cli_version cuando el caller no lo pasa:
    //   - deterministic → 'n/a' (no hay launcher LLM)
    //   - cualquier otro → 'unknown' (el caller olvidó resolverlo)
    // NUNCA `null`/`undefined` (SEC-3).
    const cliVersionDefault = isDeterministic ? 'n/a' : 'unknown';
    const ctx = {
        event: 'session:start',
        skill: pick(opts, 'skill', env.skill),
        issue: pick(opts, 'issue', env.issue),
        phase: pick(opts, 'phase', env.phase),
        model: pick(opts, 'model', 'deterministic'),
        // (#3078) `provider` agregado por simetría con emitSessionEnd y para que
        // el handle lo propague sin que el caller lo repita. NUNCA un objeto:
        // debe ser un enum string corto (security: no metadata sensible acá).
        provider: resolvedProvider,
        // (#3083 / CA-2) `cli_version` — string no-vacío. Resuelto al boot del
        // pulpo (helper `resolveCliVersion(launcherPath)`). Si el caller no lo
        // pasa: 'n/a' (deterministic) o 'unknown' (LLM sin resolución).
        cli_version: pick(opts, 'cli_version', cliVersionDefault),
        // (#3083 / CA-2 / SEC-2) `git_sha_provider_adapter` — SHA del archivo
        // del adaptador (`git hash-object`). `null` cuando deterministic.
        // SEC-2: PROHIBIDO inferir de env vars. El caller debe resolverlo via
        // `resolveProviderAdapterSha(adapterPath)` antes del spawn.
        git_sha_provider_adapter: pick(
            opts, 'git_sha_provider_adapter',
            isDeterministic ? null : null
        ),
        ts: new Date().toISOString(),
        pid: process.pid,
    };
    appendEvent(ctx);
    // handle que los callers pasan a emitSessionEnd para preservar start_ts y ctx
    return {
        skill: ctx.skill,
        issue: ctx.issue,
        phase: ctx.phase,
        model: ctx.model,
        provider: ctx.provider,
        cli_version: ctx.cli_version,
        git_sha_provider_adapter: ctx.git_sha_provider_adapter,
        // (#3083 / CA-3) `prompt_hash` viaja en el handle desde start hasta end
        // para que `emitSessionEnd` lo persista junto con tokens y costo.
        // No se persiste en `session:start` (sería redundante y aumenta superficie).
        prompt_hash: pick(opts, 'prompt_hash', null),
        start_ts: Date.now(),
        pid: ctx.pid,
    };
}

function emitSessionEnd(handle, metrics) {
    handle = handle || {};
    metrics = metrics || {};
    const env = envCtx();
    const startMs = handle.start_ts || Date.now();
    // #3091 + #3078 — `provider` propagado desde:
    //   1) `metrics.provider` (caller explícito en emitSessionEnd)
    //   2) `handle.provider` (resuelto en emitSessionStart)
    //   3) `process.env.PIPELINE_PROVIDER` (paralelo a PIPELINE_SKILL)
    //   4) null → aggregator clasifica como legacy_llm (back-compat eventos pre-#3078)
    const provider = pick(metrics, 'provider', pick(handle, 'provider', env.provider || null));
    const model = pick(handle, 'model', 'deterministic');
    const tokens_in = Number(metrics.tokens_in || 0);
    const tokens_out = Number(metrics.tokens_out || 0);
    const cache_read = Number(metrics.cache_read || 0);
    const cache_write = Number(metrics.cache_write || 0);
    // (#3083 / CA-3) `cost_usd_estimated`: provider + model + tokens.
    // `estimateCostUsd` ya valida allowlist y cae a 0 si algo no matchea
    // (sanitización defensiva — NUNCA throw, jamás rompe la sesión).
    // Para deterministic / unknown model → 0.
    let cost_usd_estimated = 0;
    try {
        cost_usd_estimated = estimateCostUsd(provider, model, {
            tokens_in, tokens_out, cache_read, cache_write,
        });
    } catch (_) { cost_usd_estimated = 0; }
    // (#3083 / CA-3) `prompt_hash`: viene del handle (resuelto en start) o
    // de `metrics` si el caller lo recalculó. NUNCA contenido — solo digest.
    const prompt_hash = pick(metrics, 'prompt_hash', pick(handle, 'prompt_hash', null));
    const evt = {
        event: 'session:end',
        skill: pick(handle, 'skill', env.skill),
        issue: pick(handle, 'issue', env.issue),
        phase: pick(handle, 'phase', env.phase),
        model: model,
        provider: provider,
        tokens_in: tokens_in,
        tokens_out: tokens_out,
        cache_read: cache_read,
        cache_write: cache_write,
        duration_ms: Number(metrics.duration_ms || (Date.now() - startMs)),
        tool_calls: Number(metrics.tool_calls || 0),
        exit_code: metrics.exit_code === undefined ? null : Number(metrics.exit_code),
        // (#3083 / CA-3) Nuevos campos S5:
        //   - prompt_hash: SHA-256 hex lowercase o null (deterministic / sin prompt).
        //   - cost_usd_estimated: USD calculado por `estimateCostUsd`.
        prompt_hash: prompt_hash,
        cost_usd_estimated: cost_usd_estimated,
        // #2993 — telemetría de handoff cross-agente. Solo contadores, NUNCA
        // contenido del handoff ni hashes que permitan reconstruirlo (CA-C1).
        // Ausentes (=0) cuando el feature está OFF o la fase no recibe inyección.
        handoff_in_tokens: Number(metrics.handoff_in_tokens || 0),
        handoff_out_bytes: Number(metrics.handoff_out_bytes || 0),
        handoff_sections_in: Number(metrics.handoff_sections_in || 0),
        ts: new Date().toISOString(),
        pid: handle.pid || process.pid,
    };
    appendEvent(evt);
    return evt;
}

// Helper pricing (input/output/cache read/cache write) — USD por 1M tokens
// Fuente real: `.pipeline/metrics/pricing.json` (multi-provider, externalizado #3091).
// Si el JSON falla, `lib/pricing.js` cae a tabla hardcoded de fallback.
//
// `MODEL_PRICING` se expone como **getter flat-merged** para back-compat con
// el dashboard #2891: `{ <model>: { in, out, cache_read, cache_write } }`.
const pricing = require('./pricing');

/**
 * Calcula el costo estimado en USD a partir del modelo y los tokens.
 *
 * Soporta dos firmas para back-compat (#3091):
 *   - estimateCostUsd(model, tokens)               (legacy — infiere provider por prefijo)
 *   - estimateCostUsd(provider, model, tokens)     (nuevo — provider explícito)
 *
 * Sanitización defensiva: si `provider` o `model` no matchean la allowlist /
 * regex, cae a deterministic (costo 0). NUNCA throw — la traza no debe romper
 * un skill (security #2 + #5).
 */
function estimateCostUsd(arg1, arg2, arg3) {
    let provider = null;
    let model = null;
    let tokens = null;
    if (arg3 !== undefined) {
        provider = arg1;
        model = arg2;
        tokens = arg3;
    } else {
        // legacy: estimateCostUsd(model, tokens). Provider se infiere por prefijo.
        model = arg1;
        tokens = arg2;
        provider = null;
    }
    const p = pricing.getPricing(provider, model);
    const ti = Number(tokens && tokens.tokens_in || 0);
    const to = Number(tokens && tokens.tokens_out || 0);
    const cr = Number(tokens && tokens.cache_read || 0);
    const cw = Number(tokens && tokens.cache_write || 0);
    const cost = (ti * p.in + to * p.out + cr * p.cache_read + cw * p.cache_write) / 1e6;
    return Math.round(cost * 10000) / 10000; // 4 decimales
}

// Proxy lazy: cada acceso a `MODEL_PRICING[<key>]` o `Object.keys(MODEL_PRICING)`
// dispara `flatMergedPricing()` con la tabla actual cargada por pricing.js. Eso
// preserva el contrato histórico para `aggregator.js` y para tests.
const MODEL_PRICING = new Proxy({}, {
    get(_target, key) {
        const flat = pricing.flatMergedPricing();
        return flat[key];
    },
    has(_target, key) {
        return Object.prototype.hasOwnProperty.call(pricing.flatMergedPricing(), key);
    },
    ownKeys() {
        return Reflect.ownKeys(pricing.flatMergedPricing());
    },
    getOwnPropertyDescriptor(_target, key) {
        const flat = pricing.flatMergedPricing();
        if (Object.prototype.hasOwnProperty.call(flat, key)) {
            return { enumerable: true, configurable: true, value: flat[key], writable: false };
        }
        return undefined;
    },
});

module.exports = {
    emitSessionStart,
    emitSessionEnd,
    appendEvent,           // expuesto para extensión (ej: tts-logger.js)
    estimateCostUsd,
    MODEL_PRICING,
    LOG_FILE,
    REPO_ROOT,
    // (#3083) Helpers S5 — audit trail dinámico
    hashPromptPair,
    resolveCliVersion,
    resolveProviderAdapterSha,
    clampRetentionDays,
    // (#3088) Lookup del contexto de sesión (single source of truth)
    getSessionContext,
    PROMPT_HASH_SEPARATOR,
    AUDIT_RETENTION_FLOOR_DAYS,
    AUDIT_RETENTION_DEFAULT_DAYS,
    // exports internos para tests
    _resetCliVersionCacheForTesting,
};

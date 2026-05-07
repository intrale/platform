// =============================================================================
// quota-exhausted.js — Detector de cuota Anthropic agotada (#2974, hija de #2955)
//
// Núcleo del modo fallback determinístico del pipeline V3. Cuando el CLI
// claude-code reporta cuota agotada (Plan Max), este módulo:
//
//   1. Persiste un flag JSON en `.pipeline/quota-exhausted.json` con
//      `{ exhausted, resets_at, detected_at, pattern_matched }`.
//   2. El pulpo consulta `isQuotaExhausted()` antes de cada spawn LLM.
//      Skills determinísticos (`builder/tester/linter/delivery`) NO se gatean.
//   3. Cuando `Date.now() > resets_at`, la lectura defensiva devuelve
//      `exhausted: false` y el módulo borra el flag (drenado natural).
//      No hay loop de retry: el filesystem-como-cola hace el resto.
//
// CRITERIOS DE ACEPTACIÓN (referencia: issue #2974):
//
//   CA-1 detectFromResultEvent SOLO matchea por shape estructurado del JSON
//        stream (`type:'result' && is_error:true && error_type ∈ allowlist`).
//        PROHIBIDO matching por substring sobre texto libre.
//   CA-4 readDefensive: si el archivo está corrupto o manipulado,
//        devuelve safe-default `{ exhausted: false }` y registra incidente.
//   CA-5 capResetsAt: `resets_at` se acota en [now+5min, now+7d]; fuera
//        de rango usa `getNextWeeklyResetMs()` como fallback.
//   CA-6 writeJsonAtomic: write-tmp + fsync + rename, mode 0o600.
//        ÚNICO ESCRITOR LEGÍTIMO: pulpo.js. Documentado como invariante.
//   CA-7 audit log con sanitización (`raw_excerpt` sin `\n\r\t`).
//   CA-11 KILL-SWITCH OPERACIONAL: si por bug el flag queda persistente,
//         `rm .pipeline/quota-exhausted.json` desbloquea el pipeline.
//
// INVARIANTE DE RACE (documentado por guru y security en el issue):
//   El flag previene FUTUROS spawns, NO mata los in-flight. Los procesos
//   claude.exe corriendo terminan naturalmente (con respuesta truncada o
//   error similar). Si el siguiente spawn también dispara el flag, set/set
//   son idempotentes. No hay corrupción posible.
//
// SCHEMA del archivo `.pipeline/quota-exhausted.json`:
//   {
//     exhausted: true,                              // siempre true cuando existe
//     resets_at: "2026-05-12T00:00:00.000Z",        // ISO8601, dentro de [now+5min, now+7d]
//     detected_at: "2026-05-05T03:14:22.123Z",      // ISO8601 del momento de detección
//     pattern_matched: "usage_limit_error"          // valor de error_type del CLI
//   }
//
// Sin nuevas dependencias externas (Node puro: fs, path).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Reutilizamos el helper canónico de getNextWeeklyResetMs (CA-5 fallback).
const { getNextWeeklyResetMs } = require('./weekly-quota');

// -----------------------------------------------------------------------------
// Paths y constantes
// -----------------------------------------------------------------------------

function pipelineDir() {
    // Permitir override en tests vía env var (mismo patrón que partial-pause).
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function flagFile() {
    return path.join(pipelineDir(), 'quota-exhausted.json');
}

function tmpDir() {
    return path.join(pipelineDir(), 'tmp');
}

function logsDir() {
    return path.join(pipelineDir(), 'logs');
}

function auditLogFile(now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(logsDir(), `quota-detector-${yyyy}-${mm}-${dd}.log`);
}

// CA-5: cap del `resets_at`. Mínimo 5 min para que un flag con drift de unos
// segundos no se borre instantáneamente; máximo configurable (default 7 días).
const MIN_RESETS_AT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RESETS_AT_DAYS = 7;

// CA-7: cap de raw_excerpt en log (defensa anti DoS de log size).
const RAW_EXCERPT_MAX_CHARS = 200;

// Allowlist por DEFAULT (CA-1, CA-8). Configurable vía config.yaml.
// IMPORTANTE: `rate_limit_error` (429 transitorio) NO entra acá — eso se
// maneja con backoff/retry, no con flag global del pipeline.
//
// `snapshot_threshold_90` (#3013, CA-12): trigger emitido por
// quota-snapshot-integration cuando el snapshot real reporta
// `weekly_all_models_pct >= 90`. Permite gatear el pipeline ANTES de que
// el CLI devuelva el 429. Documentado en docs/quota-tracking.md §3.
const DEFAULT_ERROR_TYPES = Object.freeze([
    'usage_limit_error',
    'weekly_quota_exhausted',
    'snapshot_threshold_90',
]);

// -----------------------------------------------------------------------------
// IO atómica (CA-6)
// -----------------------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * Escritura atómica replicada del patrón de connectivity-state.js (líneas
 * 154-173). writeFileSync en tmp + fsync + rename. Mode 0o600 para que el
 * flag y el audit log no sean world-readable (defensa en profundidad).
 *
 * Si el rename falla (FS lleno, permisos), limpia tmp y propaga el error.
 * El caller (typically pulpo.js) decide si ignorarlo (best-effort) o no.
 */
function writeJsonAtomic(filepath, data) {
    ensureDir(tmpDir());
    ensureDir(path.dirname(filepath));
    const tmp = path.join(
        tmpDir(),
        `${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`
    );
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, payload);
        try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
    try {
        fs.renameSync(tmp, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Sanitización (CA-7)
// -----------------------------------------------------------------------------

/**
 * Sanitiza el raw_excerpt antes de loguearlo (CWE-117 log injection).
 * Convierte CR/LF/TAB en espacio para que cada línea del audit log siga
 * siendo una entrada JSON válida e inyectable solo dentro de su propio
 * contexto.
 */
function sanitizeRawExcerpt(raw) {
    if (raw == null) return '';
    return String(raw)
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, RAW_EXCERPT_MAX_CHARS);
}

// -----------------------------------------------------------------------------
// Schema validation y cap (CA-5)
// -----------------------------------------------------------------------------

/**
 * Acota `resets_at` (en ms desde epoch o ISO8601) al rango [now+5min, now+maxDays].
 *
 * Si el valor es inválido (no parseable, NaN, negativo) o cae fuera del rango,
 * usa `getNextWeeklyResetMs()` como fallback siempre que ese fallback esté
 * dentro del rango. Si el fallback también está fuera (improbable, pero por
 * defensa) se acota al límite superior.
 *
 * @param {string|number|Date} input candidato del CLI o del archivo persistido
 * @param {object} opts
 * @param {number} opts.maxDays cap superior en días (default 7)
 * @param {number} opts.now Date.now() override (para tests)
 * @returns {{ ms: number, iso: string, source: 'input'|'fallback'|'cap_max' }}
 */
function capResetsAt(input, opts = {}) {
    const maxDays = Number.isFinite(opts.maxDays) && opts.maxDays > 0
        ? opts.maxDays
        : DEFAULT_MAX_RESETS_AT_DAYS;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const lower = now + MIN_RESETS_AT_MS;
    const upper = now + maxDays * 24 * 60 * 60 * 1000;

    // Parseo robusto del input
    let ms = NaN;
    if (typeof input === 'number' && Number.isFinite(input)) {
        ms = input;
    } else if (input instanceof Date) {
        ms = input.getTime();
    } else if (typeof input === 'string') {
        const parsed = Date.parse(input);
        if (Number.isFinite(parsed)) ms = parsed;
    }

    if (Number.isFinite(ms) && ms >= lower && ms <= upper) {
        return { ms, iso: new Date(ms).toISOString(), source: 'input' };
    }

    // Input fuera de rango → fallback al próximo reset semanal calculado.
    let fallback;
    try { fallback = getNextWeeklyResetMs(now); } catch { fallback = NaN; }
    if (Number.isFinite(fallback) && fallback >= lower && fallback <= upper) {
        return { ms: fallback, iso: new Date(fallback).toISOString(), source: 'fallback' };
    }

    // Defensa final: si ni el input ni el fallback son seguros, usar el cap superior.
    return { ms: upper, iso: new Date(upper).toISOString(), source: 'cap_max' };
}

/**
 * Valida el shape del flag persistido. Devuelve `null` si no es válido.
 * No matchea por substring — solo valida tipos y rangos.
 */
function validateFlagShape(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.exhausted !== true) return null;
    if (typeof parsed.resets_at !== 'string') return null;
    if (typeof parsed.detected_at !== 'string') return null;
    if (typeof parsed.pattern_matched !== 'string') return null;
    if (!Number.isFinite(Date.parse(parsed.resets_at))) return null;
    if (!Number.isFinite(Date.parse(parsed.detected_at))) return null;
    return parsed;
}

// -----------------------------------------------------------------------------
// Lectura defensiva (CA-4) y borrado del flag
// -----------------------------------------------------------------------------

/**
 * Lectura defensiva del flag.
 *   - Si no existe el archivo → `{ exhausted: false, reason: 'absent' }`.
 *   - Si está corrupto / shape inválido / fields faltantes → safe-default,
 *     registra incidente en audit log y deja el archivo intacto (operador
 *     puede inspeccionar manualmente). El operador desbloquea con `rm`.
 *   - Si `resets_at` ya pasó → `{ exhausted: false, reason: 'expired' }`,
 *     borra el archivo (drenado natural CA-7 del issue padre).
 *   - Si todo OK → `{ exhausted: true, ...payload }`.
 */
function readDefensive(opts = {}) {
    const file = flagFile();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const auditEnabled = opts.auditLogEnabled !== false;

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            return { exhausted: false, reason: 'absent' };
        }
        // Otro error de IO (permisos, etc) — degradar a safe-default.
        if (auditEnabled) {
            appendAudit({
                event: 'read_io_error',
                error_type: null,
                raw_excerpt: e.message,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'io_error' };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        if (auditEnabled) {
            appendAudit({
                event: 'parse_error',
                error_type: null,
                raw_excerpt: raw,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'parse_error' };
    }

    const valid = validateFlagShape(parsed);
    if (!valid) {
        if (auditEnabled) {
            appendAudit({
                event: 'schema_invalid',
                error_type: null,
                raw_excerpt: raw,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'schema_invalid' };
    }

    const resetsAtMs = Date.parse(valid.resets_at);
    if (now >= resetsAtMs) {
        // CA-7 del issue padre: drenado natural post-reset.
        try { fs.unlinkSync(file); } catch {}
        if (auditEnabled) {
            appendAudit({
                event: 'drained_post_reset',
                error_type: valid.pattern_matched,
                raw_excerpt: `resets_at=${valid.resets_at}`,
                flag_set: false,
            });
        }
        return { exhausted: false, reason: 'expired' };
    }

    return {
        exhausted: true,
        resets_at: valid.resets_at,
        detected_at: valid.detected_at,
        pattern_matched: valid.pattern_matched,
        resets_at_ms: resetsAtMs,
    };
}

/**
 * `isQuotaExhausted()` — variante simple para callers que solo quieren el bool.
 * Hace el mismo readDefensive() incluyendo drenado natural.
 */
function isQuotaExhausted(opts = {}) {
    return readDefensive(opts).exhausted === true;
}

/**
 * Borra el flag (idempotente). Útil en dos contextos:
 *   1. Drenado por `readDefensive` cuando `resets_at` ya pasó.
 *   2. Drenado proactivo cuando un spawn LLM termina exitoso (probó que
 *      la cuota volvió antes del `resets_at` calculado).
 */
function clearFlag(opts = {}) {
    const file = flagFile();
    const auditEnabled = opts.auditLogEnabled !== false;
    let existed = false;
    try {
        fs.unlinkSync(file);
        existed = true;
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            // No-op: best-effort
        }
    }
    if (existed && auditEnabled) {
        appendAudit({
            event: opts.event || 'cleared',
            error_type: null,
            raw_excerpt: opts.reason || 'manual_or_post_success',
            flag_set: false,
        });
    }
    return existed;
}

// -----------------------------------------------------------------------------
// Set del flag (escritor único: pulpo.js — CA-6)
// -----------------------------------------------------------------------------

/**
 * Persiste el flag de cuota agotada. Idempotente: escribir dos veces con el
 * mismo `pattern_matched` no rompe nada (CA-S4: race detector ↔ gate).
 *
 * @param {object} opts
 * @param {string} opts.errorType valor del error_type del CLI (debe estar en allowlist)
 * @param {string|number|Date} [opts.resetsAt] candidato; si falta o malformado, fallback
 * @param {number} [opts.maxDays] cap superior (default 7)
 * @param {number} [opts.now] Date.now() override (tests)
 * @param {boolean} [opts.auditLogEnabled] (default true)
 * @param {string} [opts.agent] skill del agente que disparó (para audit log)
 * @returns {{ flagPath: string, payload: object, source: 'input'|'fallback'|'cap_max' }}
 */
function setFlag(opts = {}) {
    const errorType = String(opts.errorType || '').slice(0, 64);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const cap = capResetsAt(opts.resetsAt, { maxDays: opts.maxDays, now });
    const payload = {
        exhausted: true,
        resets_at: cap.iso,
        detected_at: new Date(now).toISOString(),
        pattern_matched: errorType,
    };
    writeJsonAtomic(flagFile(), payload);
    if (opts.auditLogEnabled !== false) {
        appendAudit({
            event: 'flag_set',
            agent: opts.agent || null,
            error_type: errorType,
            raw_excerpt: opts.rawExcerpt || `resets_at_source=${cap.source}`,
            flag_set: true,
        });
    }
    return { flagPath: flagFile(), payload, source: cap.source };
}

// -----------------------------------------------------------------------------
// Audit log (CA-7 del issue, CA-11 del padre)
// -----------------------------------------------------------------------------

/**
 * Append una entrada al audit log diario. Cada línea es JSON con shape
 * sanitizado. Best-effort: errores de IO se silencian para no romper el
 * pipeline (el detector NUNCA debe ser el causante de un crash).
 */
function appendAudit(entry, opts = {}) {
    try {
        const ts = entry.timestamp || new Date().toISOString();
        const line = JSON.stringify({
            timestamp: ts,
            event: entry.event || null,
            agent: entry.agent || null,
            error_type: entry.error_type || null,
            raw_excerpt: sanitizeRawExcerpt(entry.raw_excerpt),
            flag_set: entry.flag_set === true,
        }) + '\n';
        ensureDir(logsDir());
        fs.appendFileSync(auditLogFile(opts.now ? new Date(opts.now) : undefined), line, {
            flag: 'a',
            mode: 0o600,
        });
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Detector estructurado (CA-1) — anti prompt-injection
// -----------------------------------------------------------------------------

/**
 * Detecta si un evento `result` del JSON stream del CLI claude-code indica
 * cuota agotada. SOLO matchea por shape estructurado. NUNCA matchea por
 * substring sobre texto libre.
 *
 *   Match: `evt.type === 'result' && evt.is_error === true && evt.error_type ∈ allowlist`
 *
 * @param {object} evt evento parseado del stream-json
 * @param {object} cfg config quota_detector (si null, usa defaults)
 * @returns {{ matched: boolean, errorType?: string }}
 */
function detectFromResultEvent(evt, cfg = null) {
    if (!evt || typeof evt !== 'object') return { matched: false };
    if (evt.type !== 'result') return { matched: false };
    if (evt.is_error !== true) return { matched: false };
    const errorType = typeof evt.error_type === 'string' ? evt.error_type : null;
    if (!errorType) return { matched: false };
    const allowlist = (cfg && Array.isArray(cfg.error_types) && cfg.error_types.length > 0)
        ? cfg.error_types
        : DEFAULT_ERROR_TYPES;
    if (!allowlist.includes(errorType)) return { matched: false };
    return { matched: true, errorType };
}

/**
 * Skills determinísticos (espejo de DETERMINISTIC_SKILLS en pulpo.js#L4782).
 * El gate pre-spawn deja pasar estos skills incluso con flag activo —
 * corren en Node puro sin tokens LLM.
 */
const DETERMINISTIC_SKILLS = Object.freeze(
    new Set(['builder', 'tester', 'delivery', 'linter'])
);

function isDeterministicSkill(skill) {
    return DETERMINISTIC_SKILLS.has(String(skill || '').trim().toLowerCase());
}

/**
 * Decide si el spawn de un skill se debe gatear (es decir, NO spawnear).
 * Uso típico en pulpo.js antes del `spawn(claude.exe, ...)`:
 *
 *     if (shouldGateSpawn(skill)) {
 *         // dejar archivo en pendiente/, no spawnear, opcional notificar.
 *         return;
 *     }
 *
 * @param {string} skill
 * @param {object} [opts] mismo shape que readDefensive
 * @returns {boolean}
 */
function shouldGateSpawn(skill, opts = {}) {
    if (isDeterministicSkill(skill)) return false;
    return isQuotaExhausted(opts);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // API pública
    isQuotaExhausted,
    readDefensive,
    setFlag,
    clearFlag,
    detectFromResultEvent,
    shouldGateSpawn,
    isDeterministicSkill,
    appendAudit,

    // Helpers expuestos para integración con pulpo.js
    capResetsAt,
    sanitizeRawExcerpt,
    validateFlagShape,

    // Constantes públicas
    DEFAULT_ERROR_TYPES,
    DEFAULT_MAX_RESETS_AT_DAYS,
    MIN_RESETS_AT_MS,
    RAW_EXCERPT_MAX_CHARS,
    DETERMINISTIC_SKILLS,

    // Paths (útiles para tests)
    flagFile,
    auditLogFile,
    pipelineDir,

    // Hooks internos para tests (prefijo _)
    _writeJsonAtomic: writeJsonAtomic,
};

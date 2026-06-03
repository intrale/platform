// =============================================================================
// provider-disabled.js — Kill-switch operacional por provider de IA (#3811)
//
// Módulo paralelo a `quota-exhausted.js`. Mientras el flag de cuota tiene
// semántica de "cuota agotada → esperar reset" (pausa el spawn dejándolo en
// `pendiente/` SIN cascadear al siguiente eslabón), este módulo provee un
// switch operacional explícito por provider que simula una **caída en runtime**:
// cuando un provider está "apagado", `dispatch-with-fallback` debe SALTAR al
// siguiente eslabón de la cadena del skill, igual que si estuviera gateado por
// cuota.
//
// MOTIVACIÓN (#3811):
//   En la prueba controlada del 2026-06-03, marcar Anthropic como agotado NO
//   hizo saltar los agentes a Codex: `shouldGateSpawn` es un gate (pausa), no
//   un dispatcher (salto). Este módulo da el primitivo determinístico para
//   apagar/encender providers y disparar fallbacks reales.
//
// PERSISTENCIA: `.pipeline/provider-disabled.json`
//   {
//     "disabled": [
//       { "name": "anthropic", "disabled_at": "2026-06-03T...", "ttl_expires_at": "2026-06-03T..." }
//     ]
//   }
//   - `ttl_expires_at` opcional: si está y ya pasó, la entrada se drena en lectura.
//   - Si `ttl_expires_at` es null/ausente, la entrada es permanente hasta clear.
//
// TTL: default 20 minutos (configurable por opts.ttlMs). Auto-restaurado:
//   `isProviderDisabled` / `listDisabledProviders` drenan entradas vencidas.
//
// SCOPE POR PROVIDER: granular — apagar `anthropic` no afecta a `openai-codex`.
//
// DETERMINÍSTICO: no usa LLM, no toca credenciales. Solo filesystem JSON +
//   comparación de strings. Controlable por terminal (manage-providers.sh) o
//   por el dashboard (POST /api/providers/:name/disable).
//
// KILL-SWITCH DEL KILL-SWITCH: si por bug el archivo queda corrupto o pegado,
//   `rm .pipeline/provider-disabled.json` restaura todos los providers.
//
// Sin dependencias externas (Node puro: fs, path).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Allowlist de providers (single source of truth replicada de
// resolve-provider.js :: PROVIDER_HANDLERS). `deterministic` se excluye a
// propósito — no es un provider de IA y nunca se "apaga".
// -----------------------------------------------------------------------------
const VALID_PROVIDERS = Object.freeze([
    'anthropic',
    'openai-codex',
    'gemini-google',
    'cerebras',
    'nvidia-nim',
]);

// TTL default 20 min (igual orden de magnitud que el reset de cuota corto).
const DEFAULT_TTL_MS = 20 * 60 * 1000;

// Cap defensivo del TTL: máximo 7 días. Un apagado "permanente" se hace con
// ttlMs: null explícito, no con un número gigante.
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

function pipelineDir() {
    // Override en tests (mismo patrón que quota-exhausted / partial-pause).
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function flagFile() {
    return path.join(pipelineDir(), 'provider-disabled.json');
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
    return path.join(logsDir(), `provider-disabled-${yyyy}-${mm}-${dd}.log`);
}

// -----------------------------------------------------------------------------
// IO atómica (espejo del patrón de quota-exhausted.js)
// -----------------------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

const RENAME_RETRY_MAX_ATTEMPTS = 3;
const RENAME_RETRY_MAX_TOTAL_MS = 50;
const RENAME_RETRY_INITIAL_MS = 5;
const RENAME_RETRYABLE_ERRORS = new Set(['EBUSY', 'EPERM', 'EEXIST']);

function sleepSyncMs(ms) {
    const end = Date.now() + ms;
    // eslint-disable-next-line no-empty
    while (Date.now() < end) {}
}

function renameWithRetry(tmp, filepath) {
    let lastErr = null;
    let delayMs = RENAME_RETRY_INITIAL_MS;
    const totalDeadline = Date.now() + RENAME_RETRY_MAX_TOTAL_MS;
    for (let attempt = 1; attempt <= RENAME_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            fs.renameSync(tmp, filepath);
            return;
        } catch (err) {
            lastErr = err;
            const code = err && err.code;
            const retriable = RENAME_RETRYABLE_ERRORS.has(code);
            const lastAttempt = attempt === RENAME_RETRY_MAX_ATTEMPTS;
            const overBudget = Date.now() + delayMs > totalDeadline;
            if (!retriable || lastAttempt || overBudget) throw err;
            sleepSyncMs(delayMs);
            delayMs = Math.min(delayMs * 2, totalDeadline - Date.now());
            if (delayMs <= 0) throw lastErr;
        }
    }
    throw lastErr || new Error('renameWithRetry: unexpected fallthrough');
}

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
        renameWithRetry(tmp, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Audit log (best-effort, una línea JSON por evento)
// -----------------------------------------------------------------------------

function appendAudit(entry, opts = {}) {
    try {
        const ts = entry.timestamp || new Date().toISOString();
        const line = JSON.stringify({
            timestamp: ts,
            event: entry.event || null,
            provider: entry.provider || null,
            ttl_expires_at: entry.ttl_expires_at || null,
            source: entry.source || null,
            detail: typeof entry.detail === 'string'
                ? entry.detail.replace(/[\r\n\t]/g, ' ').slice(0, 200)
                : null,
        }) + '\n';
        ensureDir(logsDir());
        fs.appendFileSync(auditLogFile(opts.now ? new Date(opts.now) : undefined), line, {
            flag: 'a',
            mode: 0o600,
        });
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Validación + parseo defensivo
// -----------------------------------------------------------------------------

function isValidProvider(name) {
    return typeof name === 'string' && VALID_PROVIDERS.includes(name);
}

/**
 * Lee y parsea el archivo de forma defensiva. Devuelve siempre un objeto con
 * `entries` (array, posiblemente vacío). Tolera:
 *   - Archivo ausente → entries: [].
 *   - JSON corrupto / shape inválido → entries: [] + audit.
 *   - Entradas con shape inválido se filtran silenciosamente.
 */
function readRaw(opts = {}) {
    const file = flagFile();
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { entries: [] };
        return { entries: [], ioError: true };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        if (opts.auditLogEnabled !== false) {
            appendAudit({ event: 'parse_error', detail: 'provider-disabled.json corrupto' }, opts);
        }
        return { entries: [], parseError: true };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.disabled)) {
        return { entries: [] };
    }
    const entries = parsed.disabled.filter((e) =>
        e && typeof e === 'object' && isValidProvider(e.name)
    );
    return { entries };
}

/**
 * Drena entradas con TTL vencido. Devuelve `{ active, expired }`. NO escribe;
 * el caller decide persistir si hubo cambios.
 */
function partitionByTtl(entries, now) {
    const active = [];
    const expired = [];
    for (const e of entries) {
        const exp = e.ttl_expires_at ? Date.parse(e.ttl_expires_at) : NaN;
        if (Number.isFinite(exp) && now >= exp) {
            expired.push(e);
        } else {
            active.push(e);
        }
    }
    return { active, expired };
}

/**
 * Persiste la lista de entradas activas. Si queda vacía, borra el archivo
 * (limpieza natural — el archivo ausente == ningún provider apagado).
 */
function persist(active) {
    const file = flagFile();
    if (!active || active.length === 0) {
        try { fs.unlinkSync(file); } catch (e) {
            if (e && e.code !== 'ENOENT') { /* best-effort */ }
        }
        return;
    }
    writeJsonAtomic(file, { disabled: active });
}

/**
 * Lee, drena vencidos y persiste el resultado si hubo drenado. Devuelve la
 * lista de entradas activas (post-drenado).
 */
function readAndDrain(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const { entries } = readRaw(opts);
    if (entries.length === 0) return [];
    const { active, expired } = partitionByTtl(entries, now);
    if (expired.length > 0) {
        try { persist(active); } catch { /* best-effort */ }
        if (opts.auditLogEnabled !== false) {
            for (const e of expired) {
                appendAudit({
                    event: 'drained_ttl_expired',
                    provider: e.name,
                    ttl_expires_at: e.ttl_expires_at || null,
                    detail: 'TTL vencido, provider re-habilitado',
                }, opts);
            }
        }
    }
    return active;
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * `isProviderDisabled(providerName, opts?)` → boolean.
 * Drena TTL vencido en lectura. Provider inválido → false (no apaga lo que no
 * existe). Lectura defensiva: cualquier error de IO → false (fail-open: el
 * kill-switch NUNCA debe bloquear el pipeline por un bug propio).
 *
 * @param {string} providerName
 * @param {object} [opts] { now, auditLogEnabled }
 * @returns {boolean}
 */
function isProviderDisabled(providerName, opts = {}) {
    if (!isValidProvider(providerName)) return false;
    try {
        const active = readAndDrain(opts);
        return active.some((e) => e.name === providerName);
    } catch {
        return false;
    }
}

/**
 * `setProviderDisabled(providerName, opts?)` → {ok:true, filePath, ttl_ms} | {ok:false, error}.
 * Idempotente: apagar dos veces el mismo provider refresca el TTL.
 *
 * @param {string} providerName
 * @param {object} [opts]
 * @param {number|null} [opts.ttlMs] TTL en ms. Default DEFAULT_TTL_MS. `null`
 *        explícito = apagado permanente (sin ttl_expires_at).
 * @param {string} [opts.source] origen del cambio (cli|dashboard|test) para audit.
 * @param {number} [opts.now] Date.now() override.
 * @returns {{ok:boolean, filePath?:string, ttl_ms?:number|null, error?:string}}
 */
function setProviderDisabled(providerName, opts = {}) {
    if (!isValidProvider(providerName)) {
        return {
            ok: false,
            error: `provider inválido: "${providerName}". Válidos: ${VALID_PROVIDERS.join(', ')}`,
        };
    }
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    // TTL: undefined → default; null → permanente; número → acotado a [0, MAX].
    let ttlMs;
    if (opts.ttlMs === null) {
        ttlMs = null;
    } else if (opts.ttlMs === undefined) {
        ttlMs = DEFAULT_TTL_MS;
    } else if (Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) {
        ttlMs = Math.min(opts.ttlMs, MAX_TTL_MS);
    } else {
        return { ok: false, error: `ttlMs inválido: ${opts.ttlMs}` };
    }

    const disabledAt = new Date(now).toISOString();
    const ttlExpiresAt = ttlMs == null ? null : new Date(now + ttlMs).toISOString();

    try {
        // Leer activos (drenando vencidos), reemplazar la entrada del provider.
        const active = readAndDrain({ ...opts, now });
        const next = active.filter((e) => e.name !== providerName);
        const entry = { name: providerName, disabled_at: disabledAt };
        if (ttlExpiresAt) entry.ttl_expires_at = ttlExpiresAt;
        next.push(entry);
        persist(next);
        if (opts.auditLogEnabled !== false) {
            appendAudit({
                event: 'provider_disabled',
                provider: providerName,
                ttl_expires_at: ttlExpiresAt,
                source: opts.source || 'unknown',
                detail: ttlMs == null ? 'apagado permanente' : `ttl=${ttlMs}ms`,
            }, { now });
        }
        return { ok: true, filePath: flagFile(), ttl_ms: ttlMs };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * `clearProviderDisabled(providerName, opts?)` → boolean.
 * Devuelve true si el provider estaba apagado y se re-habilitó; false si no
 * estaba apagado (o provider inválido).
 */
function clearProviderDisabled(providerName, opts = {}) {
    if (!isValidProvider(providerName)) return false;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const active = readAndDrain({ ...opts, now });
        const existed = active.some((e) => e.name === providerName);
        if (!existed) return false;
        const next = active.filter((e) => e.name !== providerName);
        persist(next);
        if (opts.auditLogEnabled !== false) {
            appendAudit({
                event: 'provider_enabled',
                provider: providerName,
                source: opts.source || 'unknown',
                detail: 'provider re-habilitado manualmente',
            }, { now });
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * `listDisabledProviders(opts?)` → {disabled:[{name, disabled_at, ttl_expires_at}]}.
 * Drena vencidos. `ttl_expires_at` es null para apagados permanentes. Agrega
 * `ttl_remaining_ms` (informativo) para callers/UI.
 */
function listDisabledProviders(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    let active = [];
    try {
        active = readAndDrain({ ...opts, now });
    } catch {
        active = [];
    }
    return {
        disabled: active.map((e) => {
            const exp = e.ttl_expires_at ? Date.parse(e.ttl_expires_at) : NaN;
            return {
                name: e.name,
                disabled_at: e.disabled_at || null,
                ttl_expires_at: e.ttl_expires_at || null,
                ttl_remaining_ms: Number.isFinite(exp) ? Math.max(0, exp - now) : null,
            };
        }),
    };
}

/**
 * `clearAll(opts?)` → boolean. Borra el archivo entero (escape manual). Útil
 * para el `manage-providers.sh clear-all`.
 */
function clearAll(opts = {}) {
    const file = flagFile();
    try {
        fs.unlinkSync(file);
        if (opts.auditLogEnabled !== false) {
            appendAudit({ event: 'cleared_all', detail: 'todos los providers re-habilitados' }, opts);
        }
        return true;
    } catch (e) {
        if (e && e.code === 'ENOENT') return false;
        return false;
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    isProviderDisabled,
    setProviderDisabled,
    clearProviderDisabled,
    listDisabledProviders,
    clearAll,
    isValidProvider,

    // Constantes públicas
    VALID_PROVIDERS,
    DEFAULT_TTL_MS,
    MAX_TTL_MS,

    // Paths (útiles para tests / CLI)
    flagFile,
    auditLogFile,
    pipelineDir,

    // Hooks internos para tests
    _writeJsonAtomic: writeJsonAtomic,
    _readRaw: readRaw,
    _readAndDrain: readAndDrain,
};

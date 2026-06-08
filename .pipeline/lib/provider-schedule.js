// =============================================================================
// provider-schedule.js — Horarios de actividad independientes por provider (#3871)
//
// Análogo a `provider-disabled.js` (kill-switch operacional) y a `rest-mode-*`
// (gating horario global), pero con alcance GRANULAR por provider de IA: cada
// provider puede tener su propia ventana de horarios "apagado" sin afectar a los
// demás. Caso de uso: apagar Anthropic/Codex (pagos) de noche y dejar el free
// tier (Gemini) activo 24/7 para ahorrar costo + balancear carga.
//
// SEMÁNTICA (espejo de rest-mode):
//   Los `periods` del schedule definen las ventanas en las que el provider está
//   INACTIVO (apagado). Fuera de esas ventanas, el provider está activo. Esto
//   reproduce el modelo del modo descanso, donde un periodo == "pipeline en
//   reposo". Por eso `isProviderActiveNow == !isWithinWindow(offWindow)`.
//
//   Gherkin #3871 — Anthropic con periodo {22:00 → 08:00}:
//     lunes 23:30  → dentro de la ventana off → inactivo → false
//     martes 08:30 → fuera de la ventana off → activo   → true
//
// PERSISTENCIA: `.pipeline/provider-schedule.json`
//   {
//     "providers": {
//       "anthropic": {
//         "active": true,                      // ¿el gating horario está habilitado?
//         "schedule": { "monday": [{start,end}], ... },  // ventanas OFF
//         "timezone": "America/Argentina/Buenos_Aires",
//         "updated_at": "2026-06-08T..."
//       }
//     }
//   }
//   - `active:false` (o ausencia de entrada) ⇒ provider activo 24/7 (no se gatea).
//   - Archivo ausente/corrupto ⇒ TODOS los providers activos 24/7 (fail-open).
//
// REUTILIZACIÓN (NO reimplementar validadores — receta del arquitecto #3871):
//   - `rest-mode-window.js`: validatePayload, validateSchedule, timezoneIsSupported,
//     isWithinWindow, nextWindowTransition, describeRestModeNow.
//   - `provider-disabled.js`: VALID_PROVIDERS / isValidProvider (single source of
//     truth de la allowlist — SEC #1, anti path-traversal en :name).
//   - I/O atómica (writeJsonAtomic + renameWithRetry) y audit append-only:
//     mismo patrón que provider-disabled.js.
//
// FAIL-OPEN ESTRICTO: cualquier error de IO / JSON corrupto ⇒ provider activo.
//   El scheduler NUNCA debe congelar el pipeline por un bug propio. Si el archivo
//   queda pegado: `rm .pipeline/provider-schedule.json` restaura todo.
//
// DETERMINÍSTICO: no usa LLM, no toca credenciales. Solo filesystem JSON +
//   comparación de horas en timezone IANA.
//
// Sin dependencias externas (Node puro: fs, path + libs internas del pipeline).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const rmw = require('./rest-mode-window');
const providerDisabled = require('./provider-disabled');

// -----------------------------------------------------------------------------
// Allowlist de providers — REUSADA de provider-disabled.js (SEC #1). No duplicar:
// el `:name` del endpoint se valida contra esta lista ANTES de construir cualquier
// path, evitando path-traversal (`name="../../etc"`).
// -----------------------------------------------------------------------------
const VALID_PROVIDERS = providerDisabled.VALID_PROVIDERS;

function isValidProvider(name) {
    return providerDisabled.isValidProvider(name);
}

const DEFAULT_TIMEZONE = rmw.DEFAULT_TIMEZONE;

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

function pipelineDir() {
    // Override en tests (mismo patrón que provider-disabled / quota-exhausted).
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function flagFile() {
    return path.join(pipelineDir(), 'provider-schedule.json');
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
    return path.join(logsDir(), `provider-schedule-${yyyy}-${mm}-${dd}.log`);
}

// -----------------------------------------------------------------------------
// IO atómica (espejo del patrón de provider-disabled.js)
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
// Audit log (best-effort, una línea JSON por evento).
// SEC #5: escapar newlines/tabs de campos controlados por usuario antes de
// appendear (anti log-injection).
// -----------------------------------------------------------------------------

function sanitizeField(v) {
    if (typeof v !== 'string') return v == null ? null : v;
    return v.replace(/[\r\n\t]/g, ' ').slice(0, 200);
}

function appendAudit(entry, opts = {}) {
    try {
        const ts = entry.timestamp || new Date().toISOString();
        const line = JSON.stringify({
            timestamp: ts,
            event: entry.event || null,
            provider: sanitizeField(entry.provider) || null,
            active: typeof entry.active === 'boolean' ? entry.active : null,
            timezone: sanitizeField(entry.timezone) || null,
            source: sanitizeField(entry.source) || null,
            detail: typeof entry.detail === 'string' ? sanitizeField(entry.detail) : null,
        }) + '\n';
        ensureDir(logsDir());
        fs.appendFileSync(auditLogFile(opts.now ? new Date(opts.now) : undefined), line, {
            flag: 'a',
            mode: 0o600,
        });
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Lectura defensiva
// -----------------------------------------------------------------------------

/**
 * Lee y parsea el archivo de forma defensiva. Devuelve siempre `{ providers }`
 * (objeto, posiblemente vacío). Tolera:
 *   - Archivo ausente → {}.
 *   - JSON corrupto / shape inválido → {} + audit.
 *   - Entradas con provider inválido se filtran silenciosamente.
 */
function readRaw(opts = {}) {
    const file = flagFile();
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { providers: {} };
        return { providers: {}, ioError: true };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        if (opts.auditLogEnabled !== false) {
            appendAudit({ event: 'parse_error', detail: 'provider-schedule.json corrupto' }, opts);
        }
        return { providers: {}, parseError: true };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.providers || typeof parsed.providers !== 'object') {
        return { providers: {} };
    }
    const providers = {};
    for (const name of VALID_PROVIDERS) {
        const e = parsed.providers[name];
        if (e && typeof e === 'object') providers[name] = e;
    }
    return { providers };
}

/**
 * Normaliza la entrada de un provider a un "window" consumible por
 * rest-mode-window.isWithinWindow / nextWindowTransition.
 * Sanitiza el schedule en lectura (descarta periodos mal formados sin tirar).
 */
function entryToWindow(entry) {
    const active = !!(entry && entry.active === true);
    const timezone = entry && typeof entry.timezone === 'string' && entry.timezone
        ? entry.timezone : DEFAULT_TIMEZONE;
    const schedule = rmw.__forTestsOnly__.sanitizeScheduleForRead(entry && entry.schedule);
    return { active, schedule, timezone };
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * `isProviderActiveNow(provider, now?, opts?)` → boolean.
 *
 * FAIL-OPEN: provider inválido, archivo ausente/corrupto, schedule inactivo o
 * cualquier error ⇒ `true` (activo 24/7). El provider se considera INACTIVO solo
 * cuando hay un schedule habilitado (`active:true`) y "ahora" cae dentro de una
 * de sus ventanas OFF.
 *
 * @param {string} provider
 * @param {Date|number} [now] Date o ms epoch. Default Date.now().
 * @param {object} [opts] { scheduleEntry } override para tests.
 * @returns {boolean}
 */
function isProviderActiveNow(provider, now = new Date(), opts = {}) {
    if (!isValidProvider(provider)) return true; // no apaga lo que no existe
    try {
        const nowMs = (now instanceof Date) ? now.getTime()
            : (typeof now === 'number' ? now : Date.now());
        const entry = (opts && opts.scheduleEntry !== undefined)
            ? opts.scheduleEntry
            : readRaw(opts).providers[provider];
        if (!entry) return true; // sin schedule → 24/7
        const window = entryToWindow(entry);
        // isWithinWindow == "dentro de la ventana OFF". Negado = activo.
        return !rmw.isWithinWindow(window, nowMs);
    } catch {
        return true; // fail-open estricto
    }
}

/**
 * `getProviderSchedule(provider, opts?)` → entry | default.
 * Provider inválido → null. Sin entrada configurada → default activo-24/7
 * (`{active:false, schedule:{}, timezone:DEFAULT}`).
 */
function getProviderSchedule(provider, opts = {}) {
    if (!isValidProvider(provider)) return null;
    let entry;
    try {
        entry = readRaw(opts).providers[provider];
    } catch {
        entry = null;
    }
    if (!entry) {
        return {
            provider,
            active: false,
            schedule: rmw.__forTestsOnly__.emptySchedule(),
            timezone: DEFAULT_TIMEZONE,
            updated_at: null,
        };
    }
    const window = entryToWindow(entry);
    return {
        provider,
        active: window.active,
        schedule: window.schedule,
        timezone: window.timezone,
        updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : null,
    };
}

/**
 * `listProviderSchedules(opts?)` → { [provider]: entry-resuelto }.
 * Incluye TODOS los providers válidos (configurados o no) para que la UI pueda
 * renderizar una fila por provider. Agrega `isActiveNow` y `nextTransition`.
 */
function listProviderSchedules(opts = {}) {
    const now = (opts && opts.now instanceof Date) ? opts.now
        : (opts && Number.isFinite(opts.now) ? new Date(opts.now) : new Date());
    const nowMs = now.getTime();
    const out = {};
    for (const name of VALID_PROVIDERS) {
        const resolved = getProviderSchedule(name, opts);
        const window = { active: resolved.active, schedule: resolved.schedule, timezone: resolved.timezone };
        let nextTransition = null;
        try { nextTransition = rmw.nextWindowTransition(window, nowMs); } catch { nextTransition = null; }
        out[name] = {
            ...resolved,
            isActiveNow: isProviderActiveNow(name, now, opts),
            nextTransition,
        };
    }
    return out;
}

/**
 * `setProviderSchedule(provider, payload, opts?)`
 *   → {ok:true, filePath, nextTransition} | {ok:false, error, errors?}.
 *
 * @param {string} provider — debe estar en VALID_PROVIDERS (SEC #1).
 * @param {object} payload — { active:boolean, schedule:{day:[periods]}, timezone:string }.
 *        Se valida con rest-mode-window.validatePayload (NO se reimplementa).
 *        `active` se evalúa con `=== true` estricto (SEC: typeof boolean estricto).
 * @param {object} [opts] { source, now, auditLogEnabled }.
 */
function setProviderSchedule(provider, payload, opts = {}) {
    if (!isValidProvider(provider)) {
        return {
            ok: false,
            error: `provider inválido: "${provider}". Válidos: ${VALID_PROVIDERS.join(', ')}`,
        };
    }
    if (payload == null || typeof payload !== 'object') {
        return { ok: false, error: 'payload inválido (se espera {active, schedule, timezone})' };
    }
    // Reusar el validador canónico de rest-mode-window (schedule + timezone + overlap).
    const validation = rmw.validatePayload({
        active: payload.active === true,
        schedule: payload.schedule,
        timezone: payload.timezone,
    });
    if (!validation.ok) {
        return { ok: false, error: 'payload inválido', errors: validation.errors };
    }

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const norm = validation.normalized;
    const entry = {
        active: norm.active === true,
        schedule: norm.schedule,
        timezone: norm.timezone,
        updated_at: new Date(now).toISOString(),
    };

    try {
        const { providers } = readRaw({ ...opts, now });
        const next = { providers: { ...providers, [provider]: entry } };
        writeJsonAtomic(flagFile(), next);
        if (opts.auditLogEnabled !== false) {
            appendAudit({
                event: 'provider_schedule_set',
                provider,
                active: entry.active,
                timezone: entry.timezone,
                source: opts.source || 'unknown',
                detail: `periods_dias=${countScheduledDays(entry.schedule)}`,
            }, { now });
        }
        let nextTransition = null;
        try {
            nextTransition = rmw.nextWindowTransition(
                { active: entry.active, schedule: entry.schedule, timezone: entry.timezone },
                now
            );
        } catch { nextTransition = null; }
        return { ok: true, filePath: flagFile(), nextTransition };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * `clearProviderSchedule(provider, opts?)` → boolean.
 * Elimina la entrada del provider (vuelve a activo 24/7). Devuelve true si había
 * algo que borrar; false si no existía (o provider inválido).
 */
function clearProviderSchedule(provider, opts = {}) {
    if (!isValidProvider(provider)) return false;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        const { providers } = readRaw({ ...opts, now });
        if (!Object.prototype.hasOwnProperty.call(providers, provider)) return false;
        const next = { providers: { ...providers } };
        delete next.providers[provider];
        if (Object.keys(next.providers).length === 0) {
            try { fs.unlinkSync(flagFile()); } catch (e) {
                if (e && e.code !== 'ENOENT') { /* best-effort */ }
            }
        } else {
            writeJsonAtomic(flagFile(), next);
        }
        if (opts.auditLogEnabled !== false) {
            appendAudit({
                event: 'provider_schedule_cleared',
                provider,
                source: opts.source || 'unknown',
                detail: 'schedule eliminado, provider activo 24/7',
            }, { now });
        }
        return true;
    } catch {
        return false;
    }
}

function countScheduledDays(schedule) {
    if (!schedule || typeof schedule !== 'object') return 0;
    let n = 0;
    for (const k of Object.keys(schedule)) {
        if (Array.isArray(schedule[k]) && schedule[k].length > 0) n++;
    }
    return n;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    isProviderActiveNow,
    setProviderSchedule,
    getProviderSchedule,
    listProviderSchedules,
    clearProviderSchedule,
    isValidProvider,

    // Constantes públicas
    VALID_PROVIDERS,
    DEFAULT_TIMEZONE,

    // Paths (tests / CLI)
    flagFile,
    auditLogFile,
    pipelineDir,

    // Hooks internos para tests
    _readRaw: readRaw,
    _entryToWindow: entryToWindow,
    _writeJsonAtomic: writeJsonAtomic,
};

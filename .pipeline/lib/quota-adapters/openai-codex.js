// =============================================================================
// quota-adapters/openai-codex.js — Adapter OpenAI/Codex.
//
// FUENTE DE VERDAD (#4868) + GATE DE CUOTA (#4865): un único adapter que lee el
// USO REAL que Codex reportaría en `/status`, SIN inferir ni hacer red.
//
// HISTORIA DEL FORMATO:
//
//   * AHORA (Codex >= 0.145.0 — #4885): Codex dejó de persistir `used_percent`
//     en el origen legacy (el evento `account/rateLimits/read` sólo lleva el span de
//     telemetría, sin porcentajes). El objeto con `used_percent` se MOVIÓ a los
//     ROLLOUTS de sesión: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Cada
//     línea es un evento JSON; los eventos `event_msg`/`token_count` incluyen un
//     objeto `payload.rate_limits`. Muestra real (v0.145.0):
//
//       {"timestamp":"2026-07-23T19:38:32.183Z","type":"event_msg",
//        "payload":{"type":"token_count","info":{...},
//          "rate_limits":{"limit_id":"codex","limit_name":null,
//            "primary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1785373521},
//            "secondary":null,"credits":{...},"plan_type":"plus", ...}}}
//
// CAMBIOS QUE ESTE ADAPTER MANEJA (respecto del formato legacy):
//
//   1. FUENTE: archivos JSONL de rollout leídos con `fs`, sin proceso externo.
//   2. RENAME DE CAMPO: `reset_at` (viejo) → `resets_at` (nuevo).
//   3. SEMÁNTICA DE VENTANAS: el mapeo bucket→ventana YA NO es posicional
//      (primary=5h, secondary=7d). Se clasifica por `window_minutes`:
//        - `window_minutes` < 1440 (< 1 día)  → bucket SESIÓN (5h ≈ 300).
//        - `window_minutes` >= 1440 (>= 1 día) → bucket SEMANAL (7d = 10080).
//      En v0.145.0 el uso semanal viene en `primary` con `secondary: null`, así
//      que la posición NO sirve: hay que mirar la ventana.
//   4. FRESCURA (CA-3): anclada al `timestamp` ISO del evento en el JSONL (no al
//      mtime del archivo). Si el evento es viejo (Codex inactivo), NO mostramos
//      el % stale como actual → estado degradado (`unknown`, pct null).
//
// MAPEO AL SHAPE CANÓNICO (igual que antes, preservando #4868):
//   * bucket SEMANAL → top-level `pct`/`status` (lo consume pacing
//     `pacing-bucket.js` vía `weekly.pct` y el gating
//     `provider-health.assessProviderQuota` vía `status`).
//   * bucket SESIÓN  → `session.pct`/`session.status`.
//
// CERO INFERENCIA / CERO RED (security CA-#6): sólo lectura local de archivos
// JSONL con `fs`. No HTTP a OpenAI, no proceso externo, no dependencia nativa.
//
// Estados degradados (security CA-#3 + UX G1: "sin dato" != "0% real"):
//
//   - No hay rollout legible con un objeto `rate_limits` → `no_usage_data`,
//     pct null (reprobe-elegible: Codex podría no haber corrido aún).
//   - Rollout presente pero shape inesperado / sin `used_percent` válido en
//     ninguna ventana → `error`, pct null.
//   - Evento presente pero STALE (Codex inactivo) → `unknown`, pct null.
//   - Evento fresco y válido → `ok`, semanal→top-level / sesión→session.
// =============================================================================
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { ADAPTER_STATUS, QUOTA_STATUS, emptyResult } = require('./_shape');

// Umbral de frescura por defecto (CA-3). Si el último evento `rate_limits` es
// más viejo que esto, el dato es stale (Codex inactivo) → degradado, NUNCA
// mostramos el porcentaje viejo como actual. Configurable vía env con piso
// conservador de 5 min anti-parpadeo. Default 1 hora.
const DEFAULT_STALENESS_MS = (() => {
    const raw = Number(process.env.CODEX_QUOTA_STALENESS_MS);
    if (Number.isFinite(raw) && raw >= 5 * 60 * 1000) return raw;
    return 60 * 60 * 1000; // 1 hora
})();

// Tolerancia de desfasaje de reloj hacia el futuro. Un evento fechado más
// adelante que esto no es confiable (clock skew, timestamp corrupto, rollout
// copiado de otra máquina) y NO debe pasar como "fresco": una edad negativa
// atraviesa el chequeo de staleness sin filtrarse.

// Frontera semana/sesión por `window_minutes`. La ventana de sesión de Codex es
// de 5h (300 min); la semanal es de 7d (10080 min). Cualquier ventana >= 1 día
// (1440 min) se considera semanal; el resto, sesión. Umbral robusto ante
// variaciones menores del proveedor.
const WEEKLY_WINDOW_MIN_THRESHOLD = 1440;

// Cantidad máxima de archivos de rollout a escanear (del más nuevo al más
// viejo) buscando un objeto `rate_limits`. Cota anti-cuelgue si hay muchas
// sesiones sin el dato. El activo, que se actualiza en cada llamada de Codex,
// es el más nuevo → normalmente se resuelve en el primer archivo.
const MAX_ROLLOUTS_TO_SCAN = 40;

// Cap de bytes a leer del final de cada rollout. Los eventos `rate_limits` se
// escriben continuamente, así que el último vive cerca del final del archivo.
// Leer sólo la cola evita cargar archivos gigantes en memoria (anti-OOM). Si el
// corte parte una línea, esa línea parcial falla el JSON.parse y se descarta:
// escaneamos desde el final y la última línea completa queda intacta.
const ROLLOUT_TAIL_BYTES = 512 * 1024; // 512 KB

/**
 * Path por defecto del directorio de sesiones/rollouts de Codex
 * (`~/.codex/sessions`).
 * @returns {string}
 */
function defaultCodexSessionsDir() {
    return path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * Mapea un porcentaje de cuota al enum `status` (mismos cortes que el resto del
 * pipeline: ok <50, normal <75, warning <90, critical >=90).
 * @param {number} pct
 * @returns {string}
 */
function statusFromPct(pct) {
    if (pct >= 90) return QUOTA_STATUS.CRITICAL;
    if (pct >= 75) return QUOTA_STATUS.WARNING;
    if (pct >= 50) return QUOTA_STATUS.NORMAL;
    return QUOTA_STATUS.OK;
}

/**
 * Convierte un epoch (segundos) a ISO-8601, o `null` si no es válido.
 * @param {number|null} epochSeconds
 * @returns {string|null}
 */
function isoFromEpochSeconds(epochSeconds) {
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
    try {
        return new Date(epochSeconds * 1000).toISOString();
    } catch {
        return null;
    }
}

/**
 * Lista los archivos de rollout más recientes bajo `sessionsDir`, ordenados del
 * MÁS NUEVO al más viejo, sin `stat` por archivo: la jerarquía es
 * `YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` y tanto los directorios de fecha
 * (zero-padded) como el nombre del rollout (prefijado por timestamp ISO) ordenan
 * cronológicamente por comparación lexicográfica. NO lanza: devuelve `[]` ante
 * cualquier error de FS.
 *
 * @param {string} sessionsDir
 * @param {number} max  Cota superior de archivos a devolver.
 * @returns {string[]}  Paths absolutos, más nuevo primero.
 */
function listRecentRolloutFiles(sessionsDir, max) {
    const out = [];
    if (typeof sessionsDir !== 'string' || sessionsDir.length === 0) return out;
    const descNum = (a, b) => Number(b) - Number(a);
    const descStr = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
    const readDirs = (dir, kind, filter, sorter) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
        return entries
            .filter((entry) => kind(entry) && filter(entry.name))
            .map((entry) => entry.name)
            .sort(sorter);
    };
    const directory = (entry) => entry.isDirectory() && !entry.isSymbolicLink();
    const regularFile = (entry) => entry.isFile() && !entry.isSymbolicLink();
    const years = readDirs(sessionsDir, directory, (name) => /^\d{4}$/.test(name), descNum);
    for (const y of years) {
        const yDir = path.join(sessionsDir, y);
        for (const m of readDirs(yDir, directory, (name) => /^(0[1-9]|1[0-2])$/.test(name), descNum)) {
            const mDir = path.join(yDir, m);
            for (const d of readDirs(mDir, directory, (name) => /^(0[1-9]|[12]\d|3[01])$/.test(name), descNum)) {
                const dDir = path.join(mDir, d);
                const files = readDirs(
                    dDir,
                    regularFile,
                    (name) => /^rollout-[^\\/]+\.jsonl$/.test(name),
                    descStr,
                );
                for (const f of files) {
                    out.push(path.join(dDir, f));
                    if (out.length >= max) return out;
                }
            }
        }
    }
    return out;
}

/**
 * Lee la cola (últimos `maxBytes`) de un archivo como texto UTF-8. Para archivos
 * chicos lee el archivo entero. NO lanza: devuelve `null` ante cualquier error.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string|null}
 */
function readFileTail(filePath, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const start = size > maxBytes ? size - maxBytes : 0;
        const len = size - start;
        if (len <= 0) return '';
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
    } catch {
        return null;
    } finally {
        try { fs.closeSync(fd); } catch { /* noop */ }
    }
}

/**
 * Extrae de un contenido JSONL el ÚLTIMO objeto `rate_limits` (el más reciente),
 * escaneando de la última línea hacia atrás. Cada evento del rollout es un JSON
 * por línea; los que traen cuota exponen `payload.rate_limits`. Devuelve el
 * objeto de cuota + el timestamp ISO del evento (en ms). NO lanza: `null` si no
 * hay ninguno legible.
 *
 * @param {string} content  Texto JSONL (puede ser una cola parcial del archivo).
 * @returns {{tsMs:(number|null), rateLimits:Object}|null}
 */
function extractLatestRateLimits(content) {
    if (typeof content !== 'string' || content.length === 0) return null;
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        // Fast-path: descartar líneas sin la clave antes de parsear JSON.
        if (line.length === 0 || line.indexOf('rate_limits') < 0) continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            // Línea parcial (corte de cola) o corrupta → seguir hacia atrás.
            continue;
        }
        const rl = obj && obj.payload && typeof obj.payload === 'object'
            ? obj.payload.rate_limits
            : null;
        if (!rl || typeof rl !== 'object') continue;
        const tsMs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
        return { tsMs: Number.isFinite(tsMs) ? tsMs : null, rateLimits: rl };
    }
    return null;
}

/**
 * Recorre los rollouts más recientes (nuevo→viejo) y devuelve el evento
 * `rate_limits` con el timestamp global más reciente. El nombre del rollout
 * indica cuándo empezó la sesión, no cuándo recibió su último evento: una
 * sesión anterior puede seguir activa o reanudarse y escribir después que una
 * sesión cuyo archivo ordena primero. NO lanza: `null` ante cualquier error o
 * ausencia de dato.
 *
 * @param {string} sessionsDir  Directorio de sesiones (`~/.codex/sessions`).
 * @returns {{tsMs:(number|null), rateLimits:Object}|null}
 */
function readLatestEvent(sessionsDir) {
    const files = listRecentRolloutFiles(sessionsDir, MAX_ROLLOUTS_TO_SCAN);
    let latest = null;
    for (const file of files) {
        const content = readFileTail(file, ROLLOUT_TAIL_BYTES);
        if (content == null) continue;
        const event = extractLatestRateLimits(content);
        if (!event) continue;
        // Conservar un evento sin timestamp sólo como fallback degradado. Un
        // evento fechado siempre es preferible y, entre fechados, gana el más
        // reciente sin importar el orden de inicio de las sesiones.
        if (!latest
            || (Number.isFinite(event.tsMs)
                && (!Number.isFinite(latest.tsMs) || event.tsMs > latest.tsMs))) {
            latest = event;
        }
    }
    return latest;
}

/**
 * Clasifica los buckets del objeto `rate_limits` en SESIÓN / SEMANAL según
 * `window_minutes` (NO por posición primary/secondary — ver header). Recorre
 * `primary` y `secondary`; para cada uno con `used_percent` numérico válido lo
 * ubica en su ventana. Si dos buckets caen en la misma ventana, gana el primero
 * (primary antes que secondary).
 *
 * @param {Object} rateLimits
 * @returns {{session:(Bucket|null), weekly:(Bucket|null)}}
 * @typedef {{usedPercent:number, resetAt:(number|null), windowMinutes:(number|null)}} Bucket
 */
function classifyBuckets(rateLimits) {
    const result = { session: null, weekly: null };
    if (!rateLimits || typeof rateLimits !== 'object') return result;
    for (const key of ['primary', 'secondary']) {
        const b = rateLimits[key];
        if (!b || typeof b !== 'object') continue;
        const usedPercent = b.used_percent;
        if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
        const resetRaw = b.resets_at;
        const resetAt = typeof resetRaw === 'number'
            && Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw : null;
        const wmRaw = b.window_minutes;
        const windowMinutes = typeof wmRaw === 'number'
            && Number.isFinite(wmRaw) && wmRaw > 0 ? wmRaw : null;
        if (windowMinutes == null) continue;
        const bucket = {
            usedPercent: Math.max(0, Math.min(100, usedPercent)),
            resetAt,
            windowMinutes,
        };
        // Sin window_minutes no podemos clasificar por ventana: lo tratamos como
        // SESIÓN (bucket rolling corto) para no fabricar un semanal falso que
        // alimente el gating/pacing con un número de ventana desconocida.
        const isWeekly = windowMinutes >= WEEKLY_WINDOW_MIN_THRESHOLD;
        if (isWeekly) {
            if (!result.weekly) result.weekly = bucket;
        } else if (!result.session) {
            result.session = bucket;
        }
    }
    return result;
}

/**
 * Adapter OpenAI/Codex. Lee el uso real desde el rollout JSONL más reciente de
 * Codex (>= v0.145.0), clasificando buckets por `window_minutes` (sesión 5h /
 * semanal 7d) y con detección de dato stale.
 *
 * @param {Object} sessionData
 *   @property {string}   [codexSessionsDir]  override del dir de rollouts.
 *   @property {number}   [stalenessMs]       override del umbral de frescura.
 *   @property {number}   [now]               epoch ms para tests / frescura.
 *   @property {Function} [readEventImpl]     inyección de `readLatestEvent` (tests).
 * @returns {QuotaResult}
 */
function openaiCodexAdapter(sessionData) {
    const sd = sessionData && typeof sessionData === 'object' ? sessionData : {};
    // Prioridad del dir de rollouts: override explícito → env
    // `CODEX_SESSIONS_DIR` → default `~/.codex/sessions`.
    const envDir = typeof process.env.CODEX_SESSIONS_DIR === 'string'
        && process.env.CODEX_SESSIONS_DIR.length > 0
        ? process.env.CODEX_SESSIONS_DIR
        : null;
    const sessionsDir = (typeof sd.codexSessionsDir === 'string' && sd.codexSessionsDir.length > 0)
        ? sd.codexSessionsDir
        : (envDir || defaultCodexSessionsDir());
    const stalenessMs = Number.isFinite(sd.stalenessMs) && sd.stalenessMs > 0
        ? sd.stalenessMs
        : DEFAULT_STALENESS_MS;
    const nowMs = Number.isFinite(sd.now) ? sd.now : Date.now();
    const readEvent = typeof sd.readEventImpl === 'function' ? sd.readEventImpl : readLatestEvent;

    // 1. Leer el último evento `rate_limits` del rollout más reciente.
    let event;
    try {
        event = readEvent(sessionsDir);
    } catch {
        event = null; // fail-secure: cualquier excepción del reader → degradado.
    }
    if (!event) {
        // No hay rollout legible con un objeto `rate_limits`. Puede ser: dir
        // ausente, Codex no corrió aún, o rollouts sin cuota todavía. Ausencia
        // de dato reprobe-elegible (Codex podría estar vivo sin haber escrito).
        return emptyResult('openai-codex', ADAPTER_STATUS.NO_USAGE_DATA,
            'Cuota Codex: no hay datos de uso legibles');
    }

    // 2. Frescura (CA-3): si el evento no trae timestamp, no podemos afirmar que
    //    sea actual → degradado. Si es viejo, Codex está inactivo → degradado.
    const eventMs = Number.isFinite(event.tsMs) ? event.tsMs : null;
    if (eventMs == null) {
        return emptyResult('openai-codex', ADAPTER_STATUS.UNKNOWN,
            'Cuota Codex: timestamp inválido');
    }
    const ageMs = nowMs - eventMs;
    // Evento en el FUTURO (edad negativa): clock skew, timestamp corrupto o
    // rollout de otra máquina. Una edad negativa pasaría el chequeo de staleness
    // de abajo y mostraría como "fresco" un dato NO confiable. Toleramos un
    // margen chico de desfasaje de reloj; más allá, degradamos.
    if (ageMs < 0) {
        return emptyResult('openai-codex', ADAPTER_STATUS.UNKNOWN,
            'Cuota Codex: timestamp futuro');
    }
    if (ageMs > stalenessMs) {
        return emptyResult('openai-codex', ADAPTER_STATUS.UNKNOWN,
            'Cuota Codex: dato stale');
    }

    // 3. Clasificar buckets por window_minutes.
    const { session, weekly } = classifyBuckets(event.rateLimits);
    if (!session && !weekly) {
        return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
            'Cuota Codex: ventanas inválidas');
    }

    // 4. Construir el shape. semanal (7d) → top-level (pacing + gating);
    //    sesión (5h) → session.
    const result = emptyResult('openai-codex', ADAPTER_STATUS.OK, null);

    if (weekly) {
        // Codex ya entrega el porcentaje real validado. Conservar su precisión
        // evita que quotaSlice publique un valor distinto al observado (#4899).
        const weeklyPct = weekly.usedPercent;
        result.pct = weeklyPct;
        result.realPct = null; // el pct YA es el dato real de Codex.
        result.realPctRaw = weeklyPct;
        result.realPctCapped = false;
        result.status = statusFromPct(weeklyPct);
        result.realStatus = result.status;
        result.nextResetAt = isoFromEpochSeconds(weekly.resetAt);
        result.weeklyResetsAtReported = isoFromEpochSeconds(weekly.resetAt);
    } else {
        // Sin bucket semanal legible pero sí sesión: top-level queda "sin dato"
        // (null) para no fabricar un % semanal. status 'unknown' (no verde).
        result.status = QUOTA_STATUS.UNKNOWN;
        result.realStatus = QUOTA_STATUS.UNKNOWN;
    }

    if (session) {
        const sessionPct = session.usedPercent;
        result.session.pct = sessionPct;
        result.session.realPct = null;
        result.session.realPctRaw = sessionPct;
        result.session.realPctCapped = false;
        result.session.status = statusFromPct(sessionPct);
        result.session.realStatus = result.session.status;
        result.sessionResetsAt = isoFromEpochSeconds(session.resetAt);
    }

    return result;
}

// Exponer helpers puros + constantes para tests y consumidores.
openaiCodexAdapter.classifyBuckets = classifyBuckets;
openaiCodexAdapter.extractLatestRateLimits = extractLatestRateLimits;
openaiCodexAdapter.listRecentRolloutFiles = listRecentRolloutFiles;
openaiCodexAdapter.readLatestEvent = readLatestEvent;
openaiCodexAdapter.readFileTail = readFileTail;
openaiCodexAdapter.statusFromPct = statusFromPct;
openaiCodexAdapter.defaultCodexSessionsDir = defaultCodexSessionsDir;
openaiCodexAdapter.DEFAULT_STALENESS_MS = DEFAULT_STALENESS_MS;
openaiCodexAdapter.WEEKLY_WINDOW_MIN_THRESHOLD = WEEKLY_WINDOW_MIN_THRESHOLD;
openaiCodexAdapter.MAX_ROLLOUTS_TO_SCAN = MAX_ROLLOUTS_TO_SCAN;
openaiCodexAdapter.ROLLOUT_TAIL_BYTES = ROLLOUT_TAIL_BYTES;

module.exports = openaiCodexAdapter;

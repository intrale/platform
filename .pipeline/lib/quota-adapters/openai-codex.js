// =============================================================================
// quota-adapters/openai-codex.js — Adapter OpenAI/Codex (#4598).
//
// Estrategia (OFFLINE — security CA-#6): leer el USO REAL que Codex muestra en
// `/status`, SIN inferir nada.
//
//   * `codex exec "/status"` NO ejecuta el slash command (corre el modelo),
//     pero Codex **persiste** el rate-limit que mostraría `/status` en su log
//     SQLite `~/.codex/logs_2.sqlite`, tabla `logs`, columna `feedback_log_body`,
//     como eventos `codex.rate_limits`. Cada llamada de Codex escribe uno nuevo.
//
//   * Mapeo verificado en vivo (#4598):
//       - `primary`   → ventana 5h  (`window_minutes: 300`)   → bucket SESIÓN.
//       - `secondary` → ventana 7d  (`window_minutes: 10080`) → bucket SEMANAL.
//     Cada uno trae `used_percent` (0..100) y `reset_at` (epoch s).
//
//   * El bucket SEMANAL (secondary) se mapea al top-level `pct`/`status`
//     (igual que Anthropic) para que pacing (`pacing-bucket.js` lee
//     `weekly.pct`) y el gating (`provider-health.assessProviderQuota` lee
//     `status`) consuman el número real. El bucket SESIÓN (primary 5h) va a
//     `session.pct`/`session.status`.
//
//   * FRESCURA (CA-3): el evento se escribe en cada llamada de Codex. Si el
//     último es viejo (Codex inactivo), NO mostramos el porcentaje stale como
//     actual: devolvemos estado degradado (`adapterStatus: 'unknown'`,
//     `pct: null`) con `errorReason` explicando la antigüedad. Umbral
//     configurable vía `CODEX_QUOTA_STALENESS_MS` (piso conservador).
//
//   * PARSE TOLERANTE: `feedback_log_body` viene prefijado como
//     `Received message {...}` (no JSON puro). Extraemos desde el primer `{`,
//     validamos `type === 'codex.rate_limits'` y navegamos defensivamente —
//     es un log interno de Codex y puede cambiar entre versiones.
//
//   * CERO INFERENCIA / CERO RED: leemos SQLite local con el binario `sqlite3`
//     (CLI, `-readonly`, timeout acotado). No agregamos dependencia nativa
//     (`better-sqlite3`) ni hacemos HTTP a OpenAI (evita SSRF/secrets en
//     runtime del dashboard — el check de "cero clientes HTTP" sigue en verde).
//
// Estados degradados (security CA-#3 + UX G1: "sin dato" != "0% real"):
//
//   - No se pudo leer el SQLite (archivo ausente, `sqlite3` no disponible,
//     query fallida) o DB sin eventos → `no_usage_data`, pct null (reprobe-elegible).
//   - Evento presente pero body ilegible / shape inesperado
//                             → `error`,          pct null.
//   - Evento presente pero STALE (Codex inactivo)
//                             → `unknown`,        pct null.
//   - Evento fresco y válido  → `ok`, primary→sesión / secondary→semanal.
// =============================================================================
'use strict';

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ADAPTER_STATUS, QUOTA_STATUS, emptyResult } = require('./_shape');

// Umbral de frescura por defecto (CA-3). Si el último evento `codex.rate_limits`
// es más viejo que esto, el dato es stale (Codex inactivo) → degradado, NUNCA
// mostramos el porcentaje viejo como actual. La ventana `primary` es de 5h y se
// recarga continuamente: pasada ~1h de inactividad el % ya no representa el uso
// real. Configurable vía env con piso conservador de 5 min anti-parpadeo.
const DEFAULT_STALENESS_MS = (() => {
    const raw = Number(process.env.CODEX_QUOTA_STALENESS_MS);
    if (Number.isFinite(raw) && raw >= 5 * 60 * 1000) return raw;
    return 60 * 60 * 1000; // 1 hora
})();

// Timeout del spawn de `sqlite3` (anti-cuelgue si la DB está bloqueada/inflada).
const SQLITE_TIMEOUT_MS = 5000;
// Cap de lectura del stdout de `sqlite3` (una fila JSON ~ pocos KB).
const SQLITE_MAX_BUFFER = 1 * 1024 * 1024;

// Separador de columnas: unit separator (0x1f). No aparece en JSON compacto,
// así evitamos colisión con `|` (default de sqlite3) que puede estar en el body.
const COL_SEP = '\x1f';

// Query: último evento `codex.rate_limits` por timestamp. Indexado por `ts DESC`.
const RATE_LIMITS_SQL =
    "SELECT ts, feedback_log_body FROM logs " +
    "WHERE feedback_log_body LIKE '%codex.rate_limits%' " +
    "ORDER BY ts DESC, id DESC LIMIT 1;";

/**
 * Path por defecto del log SQLite de Codex (`~/.codex/logs_2.sqlite`).
 * @returns {string}
 */
function defaultCodexLogPath() {
    return path.join(os.homedir(), '.codex', 'logs_2.sqlite');
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
 * Parse tolerante del `feedback_log_body`. El body viene prefijado (p.ej.
 * `Received message {...}`), así que extraemos desde el primer `{`, validamos
 * `type === 'codex.rate_limits'` y devolvemos el objeto `rate_limits`. NO lanza:
 * cualquier problema devuelve `null`.
 *
 * @param {string} bodyText
 * @returns {Object|null}  El objeto `rate_limits` ({primary, secondary, ...}).
 */
function parseRateLimits(bodyText) {
    if (typeof bodyText !== 'string' || bodyText.length === 0) return null;
    const start = bodyText.indexOf('{');
    if (start < 0) return null;
    let obj;
    try {
        obj = JSON.parse(bodyText.slice(start));
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object' || obj.type !== 'codex.rate_limits') return null;
    const rl = obj.rate_limits;
    if (!rl || typeof rl !== 'object') return null;
    return rl;
}

/**
 * Extrae `{ usedPercent, resetAt }` de un bucket (`primary`/`secondary`) del
 * objeto `rate_limits`, defensivamente. Devuelve `null` si falta el
 * `used_percent` numérico (dato mínimo requerido).
 *
 * @param {Object} rateLimits
 * @param {string} key  'primary' | 'secondary'
 * @returns {{usedPercent:number, resetAt:(number|null)}|null}
 */
function readBucket(rateLimits, key) {
    const b = rateLimits && typeof rateLimits === 'object' ? rateLimits[key] : null;
    if (!b || typeof b !== 'object') return null;
    const usedPercent = Number(b.used_percent);
    if (!Number.isFinite(usedPercent) || usedPercent < 0) return null;
    const resetRaw = Number(b.reset_at);
    const resetAt = Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw : null;
    return { usedPercent: Math.min(100, usedPercent), resetAt };
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
 * Lee el último evento `codex.rate_limits` del SQLite vía CLI `sqlite3`
 * (`-readonly`, timeout acotado). NO lanza: devuelve `null` ante cualquier
 * error (archivo ausente, binario no disponible, query fallida).
 *
 * @param {string} logPath      path al `logs_2.sqlite`.
 * @param {string} sqlite3Bin   binario a invocar (default `sqlite3` del PATH).
 * @returns {{ts:number, body:string}|null}
 */
function readLatestEvent(logPath, sqlite3Bin) {
    if (typeof logPath !== 'string' || logPath.length === 0) return null;
    // Prioridad: override explícito → env `CODEX_SQLITE3_BIN` → `sqlite3` (PATH).
    // El env permite apuntar al binario si no está en el PATH del runtime del
    // pipeline (p.ej. el `sqlite3` de Android SDK platform-tools).
    const envBin = typeof process.env.CODEX_SQLITE3_BIN === 'string'
        && process.env.CODEX_SQLITE3_BIN.length > 0
        ? process.env.CODEX_SQLITE3_BIN
        : null;
    const bin = (typeof sqlite3Bin === 'string' && sqlite3Bin.length > 0)
        ? sqlite3Bin
        : (envBin || 'sqlite3');
    let out;
    try {
        out = execFileSync(
            bin,
            ['-readonly', '-batch', '-noheader', '-separator', COL_SEP, logPath, RATE_LIMITS_SQL],
            { timeout: SQLITE_TIMEOUT_MS, maxBuffer: SQLITE_MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        );
    } catch {
        // Archivo ausente, `sqlite3` no instalado, DB corrupta, timeout, etc.
        return null;
    }
    if (typeof out !== 'string') return null;
    const line = out.replace(/\r/g, '').split('\n').find((l) => l.length > 0);
    if (!line) return null; // DB legible pero sin filas → sin eventos.
    const sepIdx = line.indexOf(COL_SEP);
    if (sepIdx < 0) return null;
    const ts = Number(line.slice(0, sepIdx));
    const body = line.slice(sepIdx + 1);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return { ts, body };
}

/**
 * Adapter OpenAI/Codex. Lee el uso real de `/status` desde el SQLite de Codex
 * (primary=5h → sesión, secondary=7d → semanal), con detección de dato stale.
 *
 * @param {Object} sessionData
 *   @property {string}  [codexLogPath]  override del path al `logs_2.sqlite`.
 *   @property {string}  [sqlite3Path]   override del binario `sqlite3`.
 *   @property {number}  [stalenessMs]   override del umbral de frescura.
 *   @property {number}  [now]           epoch ms para tests / frescura.
 *   @property {Function} [readEventImpl] inyección de `readLatestEvent` (tests).
 * @returns {QuotaResult}
 */
function openaiCodexAdapter(sessionData) {
    const sd = sessionData && typeof sessionData === 'object' ? sessionData : {};
    // Prioridad del path del SQLite: override explícito → env
    // `CODEX_QUOTA_LOG_PATH` → default `~/.codex/logs_2.sqlite`. El env permite
    // apuntar a otra ubicación (o a un path inexistente en tests) sin tocar el
    // caller, que invoca con sessionData fijo.
    const envLogPath = typeof process.env.CODEX_QUOTA_LOG_PATH === 'string'
        && process.env.CODEX_QUOTA_LOG_PATH.length > 0
        ? process.env.CODEX_QUOTA_LOG_PATH
        : null;
    const logPath = (typeof sd.codexLogPath === 'string' && sd.codexLogPath.length > 0)
        ? sd.codexLogPath
        : (envLogPath || defaultCodexLogPath());
    const stalenessMs = Number.isFinite(sd.stalenessMs) && sd.stalenessMs > 0
        ? sd.stalenessMs
        : DEFAULT_STALENESS_MS;
    const nowMs = Number.isFinite(sd.now) ? sd.now : Date.now();
    const readEvent = typeof sd.readEventImpl === 'function' ? sd.readEventImpl : readLatestEvent;

    // 1. Leer el último evento del SQLite.
    let event;
    try {
        event = readEvent(logPath, sd.sqlite3Path);
    } catch {
        event = null; // fail-secure: cualquier excepción del reader → degradado.
    }
    if (!event) {
        // No pudimos leer NINGÚN evento. Puede ser: DB ausente, `sqlite3` no
        // disponible, o DB legible pero sin eventos `codex.rate_limits` todavía.
        // No podemos discriminar con certeza desde el reader (devuelve null en
        // ambos casos), así que lo tratamos como AUSENCIA DE DATO reprobe-elegible
        // (Codex podría estar vivo pero sin haber escrito un rate_limits aún).
        return emptyResult('openai-codex', ADAPTER_STATUS.NO_USAGE_DATA,
            'Cuota Codex: sin evento codex.rate_limits legible en el log SQLite '
            + '(Codex no corrió aún o sqlite3 no disponible)');
    }

    // 2. Frescura (CA-3): el `ts` del log es epoch s. Si el evento es viejo,
    //    Codex está inactivo → degradado, NO mostramos el % stale como actual.
    const eventMs = event.ts * 1000;
    const ageMs = nowMs - eventMs;
    if (ageMs > stalenessMs) {
        const ageMin = Math.round(ageMs / 60000);
        return emptyResult('openai-codex', ADAPTER_STATUS.UNKNOWN,
            `Cuota Codex: dato stale (último /status hace ~${ageMin} min, umbral `
            + `${Math.round(stalenessMs / 60000)} min) — Codex inactivo, no se muestra el % viejo`);
    }

    // 3. Parse tolerante del body.
    const rateLimits = parseRateLimits(event.body);
    if (!rateLimits) {
        return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
            'Cuota Codex: no se pudo parsear el evento codex.rate_limits '
            + '(formato de log cambió o body corrupto)');
    }

    const primary = readBucket(rateLimits, 'primary');     // 5h → sesión
    const secondary = readBucket(rateLimits, 'secondary'); // 7d → semanal
    if (!primary && !secondary) {
        return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
            'Cuota Codex: evento codex.rate_limits sin used_percent válido en primary/secondary');
    }

    // 4. Construir el shape. secondary (7d) → top-level (pacing + gating);
    //    primary (5h) → session.
    const result = emptyResult('openai-codex', ADAPTER_STATUS.OK, null);

    if (secondary) {
        const weeklyPct = Math.round(secondary.usedPercent * 10) / 10;
        result.pct = weeklyPct;
        result.realPct = null; // el pct YA es el dato real de Codex.
        result.realPctRaw = weeklyPct;
        result.realPctCapped = false;
        result.status = statusFromPct(weeklyPct);
        result.realStatus = result.status;
        result.nextResetAt = isoFromEpochSeconds(secondary.resetAt);
        result.weeklyResetsAtReported = isoFromEpochSeconds(secondary.resetAt);
    } else {
        // Sin bucket semanal legible pero sí sesión: top-level queda "sin dato"
        // (null) para no fabricar un % semanal. status 'unknown' (no verde).
        result.status = QUOTA_STATUS.UNKNOWN;
        result.realStatus = QUOTA_STATUS.UNKNOWN;
    }

    if (primary) {
        const sessionPct = Math.round(primary.usedPercent * 10) / 10;
        result.session.pct = sessionPct;
        result.session.realPct = null;
        result.session.realPctRaw = sessionPct;
        result.session.realPctCapped = false;
        result.session.status = statusFromPct(sessionPct);
        result.session.realStatus = result.session.status;
        result.sessionResetsAt = isoFromEpochSeconds(primary.resetAt);
    }

    return result;
}

// Exponer helpers puros + constantes para tests y consumidores.
openaiCodexAdapter.parseRateLimits = parseRateLimits;
openaiCodexAdapter.readBucket = readBucket;
openaiCodexAdapter.statusFromPct = statusFromPct;
openaiCodexAdapter.readLatestEvent = readLatestEvent;
openaiCodexAdapter.defaultCodexLogPath = defaultCodexLogPath;
openaiCodexAdapter.DEFAULT_STALENESS_MS = DEFAULT_STALENESS_MS;

module.exports = openaiCodexAdapter;

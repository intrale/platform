// =============================================================================
// health-screen.js — Agregadores server-side para la pantalla EP8-H12
// "Salud Multi-Provider" del dashboard (#3965).
//
// Responsabilidad: leer datos YA persistidos por el pipeline (audit + logs) y
// proyectar SOLO METADATOS agregados sobre una ventana de 24h para alimentar la
// pantalla. NUNCA toca credenciales, NUNCA pingea (eso lo hace live-ping vía el
// endpoint POST existente).
//
// Fuentes de datos (todas verificadas en el codebase, #3965):
//   - Latencia / timeline gate-exhaustion-recovery:
//       .pipeline/audit/multi-provider-health.jsonl  (type=health_state_transition,
//       campos provider, from_state, to_state, reason_code, latency_ms, created_at)
//   - % same-provider de Sherlock (vigilancia EP2-H1):
//       .pipeline/audit/sherlock-*.jsonl  (campo same_provider, created_at/timestamp)
//   - Despachos por provider 24h:
//       .pipeline/logs/cross-provider-dispatch-YYYY-MM-DD.jsonl
//   - Errores por clase (incl. cli_1m_context_glitch):
//       .pipeline/logs/commander-dispatch-YYYY-MM-DD.jsonl  (campo error_class)
//
// SEGURIDAD (CA-6 / A02 — bloqueante en verificación):
//   - Este módulo SOLO devuelve contadores, percentiles, estados y reason_codes.
//   - NUNCA serializa el config crudo ni objetos de secrets. Whitelist explícita
//     en cada agregador.
//
// PERFORMANCE (CA-7 / riesgo JSONL crecientes):
//   - Lectura ACOTADA a ventana 24h: los logs diarios se filtran por fecha en el
//     nombre del archivo (solo hoy + ayer) antes de leer; el audit single-file se
//     lee línea por línea filtrando por created_at >= cutoff.
//   - Cache TTL ≥ 5min (piso reutilizado de provider-health.js) para no reparsear
//     en cada request del dashboard.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Cache TTL: piso 5 min (mismo criterio que provider-health.js / CA-5 del PO).
const CACHE_TTL_MS = 5 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

// Meta de vigilancia EP2-H1: el % same-provider de Sherlock debe ser < 10%.
const SHERLOCK_SAME_PROVIDER_META_PCT = 10;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Path helpers (inyectables para tests)
// -----------------------------------------------------------------------------

function pipelineDir(opts = {}) {
    if (opts.pipelineDir) return opts.pipelineDir;
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..', '..');
}

function auditDir(opts = {}) {
    return opts.auditDir || path.join(pipelineDir(opts), 'audit');
}

function logsDir(opts = {}) {
    return opts.logsDir || path.join(pipelineDir(opts), 'logs');
}

// -----------------------------------------------------------------------------
// Lectura acotada de JSONL
// -----------------------------------------------------------------------------

/**
 * Extrae el timestamp epoch-ms de una entrada de audit/log. Prioriza el campo
 * numérico `created_at` (epoch-ms) y cae al ISO `timestamp` si hace falta.
 *
 * @param {object} entry
 * @returns {number} epoch-ms, o NaN si no se pudo determinar.
 */
function entryTimestampMs(entry) {
    if (!entry || typeof entry !== 'object') return NaN;
    if (Number.isFinite(entry.created_at)) return entry.created_at;
    if (typeof entry.created_at === 'string') {
        const n = Number(entry.created_at);
        if (Number.isFinite(n)) return n;
    }
    if (typeof entry.timestamp === 'string') {
        const t = Date.parse(entry.timestamp);
        if (Number.isFinite(t)) return t;
    }
    if (typeof entry.ts === 'string') {
        const t = Date.parse(entry.ts);
        if (Number.isFinite(t)) return t;
    }
    return NaN;
}

/**
 * Lee un archivo JSONL línea por línea y devuelve SOLO las entradas dentro de la
 * ventana [cutoff, ∞). Resiliente a archivos ausentes y líneas corruptas.
 *
 * @param {string} file
 * @param {number} cutoffMs — descarta entradas con timestamp < cutoffMs.
 * @returns {object[]}
 */
function readJsonlWindow(file, cutoffMs) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const ts = entryTimestampMs(entry);
        if (!Number.isFinite(ts) || ts < cutoffMs) continue;
        out.push(entry);
    }
    return out;
}

/**
 * Lista los archivos diarios `<prefix>YYYY-MM-DD.jsonl` cuyo día solapa la
 * ventana [cutoffMs, nowMs]. Acota la lectura a 2-3 archivos en vez de globear
 * histórico completo.
 *
 * @param {string} dir
 * @param {string} prefix — ej. 'cross-provider-dispatch-'
 * @param {number} cutoffMs
 * @param {number} nowMs
 * @returns {string[]} paths absolutos existentes.
 */
function dailyFilesInWindow(dir, prefix, cutoffMs, nowMs) {
    const days = new Set();
    // Iteramos por día desde cutoff hasta now (máx ~2 días para ventana 24h).
    for (let t = cutoffMs; t <= nowMs + ONE_DAY_MS; t += ONE_DAY_MS) {
        days.add(isoDate(t));
    }
    days.add(isoDate(nowMs));
    const files = [];
    for (const day of days) {
        const f = path.join(dir, `${prefix}${day}.jsonl`);
        try {
            if (fs.existsSync(f)) files.push(f);
        } catch { /* ignore */ }
    }
    return files;
}

/**
 * Formatea un epoch-ms como YYYY-MM-DD en UTC. Determinístico (no usa locale).
 */
function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Glob simple de `sherlock-*.jsonl` en el directorio de audit.
 *
 * @param {object} opts
 * @returns {string[]}
 */
function sherlockFiles(opts = {}) {
    const dir = auditDir(opts);
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter(n => /^sherlock-.*\.jsonl$/.test(n))
        .map(n => path.join(dir, n));
}

// -----------------------------------------------------------------------------
// Agregadores
// -----------------------------------------------------------------------------

/**
 * Percentiles p50/p95 (nearest-rank) sobre un array de latencias. Ignora valores
 * no numéricos / no positivos. Devuelve null cuando no hay datos (la UI muestra
 * "sin datos 24h" en vez de 0 espurio).
 *
 * @param {number[]} latencies
 * @returns {{ p50: number|null, p95: number|null, count: number }}
 */
function percentiles(latencies) {
    const vals = (Array.isArray(latencies) ? latencies : [])
        // Descartar null/undefined/'' ANTES de coercionar (Number(null)===0 sería
        // un falso 0 que ensucia el percentil).
        .filter(v => v !== null && v !== undefined && v !== '')
        .map(Number)
        .filter(v => Number.isFinite(v) && v >= 0)
        .sort((a, b) => a - b);
    if (vals.length === 0) return { p50: null, p95: null, count: 0 };
    const at = (p) => {
        const rank = Math.ceil((p / 100) * vals.length);
        const idx = Math.min(vals.length - 1, Math.max(0, rank - 1));
        return vals[idx];
    };
    return { p50: at(50), p95: at(95), count: vals.length };
}

/**
 * % de evaluaciones same-provider de Sherlock agregadas en la ventana 24h.
 * Recorre TODOS los archivos `sherlock-*.jsonl` (uno por issue), filtra por
 * timestamp y cuenta entradas con el campo `same_provider` definido.
 *
 * @param {object} [opts]
 * @returns {{ pct: number|null, meta: number, alert: boolean, total: number, same: number }}
 */
function sherlockSameProviderPct(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_24H_MS;
    const cutoff = now - windowMs;

    let total = 0;
    let same = 0;
    for (const file of sherlockFiles(opts)) {
        for (const entry of readJsonlWindow(file, cutoff)) {
            if (typeof entry.same_provider !== 'boolean') continue;
            total += 1;
            if (entry.same_provider === true) same += 1;
        }
    }
    if (total === 0) {
        return { pct: null, meta: SHERLOCK_SAME_PROVIDER_META_PCT, alert: false, total: 0, same: 0 };
    }
    const pct = (same / total) * 100;
    return {
        pct: Math.round(pct * 10) / 10,
        meta: SHERLOCK_SAME_PROVIDER_META_PCT,
        alert: pct >= SHERLOCK_SAME_PROVIDER_META_PCT,
        total,
        same,
    };
}

/**
 * Conteo de despachos por provider en la ventana 24h, leyendo los logs diarios
 * de fallback (`cross-provider-dispatch-*.jsonl`). El provider efectivo de cada
 * evento se deriva con whitelist explícita de campos conocidos.
 *
 * @param {object} [opts]
 * @returns {{ totals: Object<string,number>, total: number }}
 */
function dispatchCounts24h(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_24H_MS;
    const cutoff = now - windowMs;

    const totals = Object.create(null);
    let total = 0;
    const dir = logsDir(opts);
    const files = dailyFilesInWindow(dir, 'cross-provider-dispatch-', cutoff, now);
    for (const file of files) {
        for (const entry of readJsonlWindow(file, cutoff)) {
            // Whitelist: provider efectivo del evento (fallback elegido o primario).
            const provider = entry.fallback_provider
                || entry.provider_effective
                || entry.primary_provider;
            if (typeof provider !== 'string' || !provider) continue;
            totals[provider] = (totals[provider] || 0) + 1;
            total += 1;
        }
    }
    return { totals, total };
}

/**
 * Conteo de errores por clase en la ventana 24h, leyendo `commander-dispatch-*.jsonl`
 * (campo `error_class`). Incluye explícitamente la clase `cli_1m_context_glitch`
 * (#3506) cuando aparece. Opcionalmente desagregado por provider.
 *
 * @param {object} [opts]
 * @returns {{ classes: Object<string,number>, byProvider: Object<string,Object<string,number>>, total: number }}
 */
function errorClassCounts24h(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_24H_MS;
    const cutoff = now - windowMs;

    const classes = Object.create(null);
    const byProvider = Object.create(null);
    let total = 0;
    const dir = logsDir(opts);
    const files = dailyFilesInWindow(dir, 'commander-dispatch-', cutoff, now);
    for (const file of files) {
        for (const entry of readJsonlWindow(file, cutoff)) {
            const klass = entry.error_class;
            if (typeof klass !== 'string' || !klass) continue;
            classes[klass] = (classes[klass] || 0) + 1;
            total += 1;
            const provider = entry.provider_effective || entry.primary_provider;
            if (typeof provider === 'string' && provider) {
                if (!byProvider[provider]) byProvider[provider] = Object.create(null);
                byProvider[provider][klass] = (byProvider[provider][klass] || 0) + 1;
            }
        }
    }
    return { classes, byProvider, total };
}

/**
 * Latencias por provider en la ventana 24h, leídas del audit de health
 * (`multi-provider-health.jsonl`, campo `latency_ms` de cada transición). Devuelve
 * un mapa provider → array de latencias (no-null) para alimentar `percentiles`.
 *
 * @param {object} [opts]
 * @returns {Object<string, number[]>}
 */
function latencyByProvider24h(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_24H_MS;
    const cutoff = now - windowMs;

    const out = Object.create(null);
    const file = path.join(auditDir(opts), 'multi-provider-health.jsonl');
    for (const entry of readJsonlWindow(file, cutoff)) {
        if (entry.type !== 'health_state_transition') continue;
        const provider = entry.provider;
        if (typeof provider !== 'string' || !provider) continue;
        const lat = Number(entry.latency_ms);
        if (!Number.isFinite(lat) || lat < 0) continue;
        if (!out[provider]) out[provider] = [];
        out[provider].push(lat);
    }
    return out;
}

/**
 * Timeline cronológico (ascendente) de transiciones gate/exhaustion/recovery en
 * la ventana 24h, desde `health_state_transition`. Whitelist de campos: NUNCA
 * incluye hashes de la cadena ni datos crudos del config. El texto (`reason_code`)
 * lo escapa la vista al renderizar (anti-XSS A03 / CA-5).
 *
 * @param {object} [opts]
 * @returns {Array<{ provider, from_state, to_state, reason_code, latency_ms, created_at }>}
 */
function timeline24h(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_24H_MS;
    const cutoff = now - windowMs;
    const limit = Number.isFinite(opts.limit) ? opts.limit : 200;

    const file = path.join(auditDir(opts), 'multi-provider-health.jsonl');
    const events = [];
    for (const entry of readJsonlWindow(file, cutoff)) {
        if (entry.type !== 'health_state_transition') continue;
        events.push({
            provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
            from_state: typeof entry.from_state === 'string' ? entry.from_state : null,
            to_state: typeof entry.to_state === 'string' ? entry.to_state : null,
            reason_code: typeof entry.reason_code === 'string' ? entry.reason_code : null,
            latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null,
            created_at: entryTimestampMs(entry),
        });
    }
    events.sort((a, b) => a.created_at - b.created_at);
    // Acotar al final (eventos más recientes) para no inflar el payload.
    return events.slice(-limit);
}

// -----------------------------------------------------------------------------
// Payload consolidado + cache
// -----------------------------------------------------------------------------

let _cache = null; // { ts, payload }

/**
 * Construye el payload completo de la pantalla. Combina health cards por provider
 * (p50/p95 + despachos + errores por clase), panel Sherlock, timeline. Cachea el
 * resultado con TTL ≥5min salvo que `opts.skipCache` o `opts.now` (tests).
 *
 * SOLO METADATOS. Whitelist explícita en cada sub-objeto. Nunca config crudo.
 *
 * @param {object} [opts]
 * @returns {object}
 */
function buildScreenPayload(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const useCache = !opts.skipCache && !Number.isFinite(opts.now)
        && !opts.auditDir && !opts.logsDir && !opts.pipelineDir;

    if (useCache && _cache && (now - _cache.ts) < CACHE_TTL_MS) {
        return { ..._cache.payload, cache_age_s: Math.floor((now - _cache.ts) / 1000) };
    }

    const dispatches = dispatchCounts24h({ ...opts, now });
    const errors = errorClassCounts24h({ ...opts, now });
    const latencies = latencyByProvider24h({ ...opts, now });

    // Providers presentes en cualquiera de las fuentes (unión).
    const providerSet = new Set([
        ...Object.keys(dispatches.totals),
        ...Object.keys(errors.byProvider),
        ...Object.keys(latencies),
    ]);

    const cards = [];
    for (const provider of providerSet) {
        const pct = percentiles(latencies[provider] || []);
        const errorClasses = errors.byProvider[provider]
            ? { ...errors.byProvider[provider] }
            : {};
        const dispatchCount = dispatches.totals[provider] || 0;
        const hasData = pct.count > 0 || dispatchCount > 0 || Object.keys(errorClasses).length > 0;
        cards.push({
            provider,                       // string id (no secret)
            p50_ms: pct.p50,
            p95_ms: pct.p95,
            latency_samples: pct.count,
            dispatches_24h: dispatchCount,
            error_classes: errorClasses,    // { className: count }
            has_data: hasData,
        });
    }
    cards.sort((a, b) => a.provider.localeCompare(b.provider));

    const payload = {
        ts: new Date(now).toISOString(),
        window_ms: WINDOW_24H_MS,
        cache_ttl_ms: CACHE_TTL_MS,
        cache_age_s: 0,
        cards,
        dispatches_total_24h: dispatches.total,
        error_classes_total_24h: errors.total,
        error_classes_24h: { ...errors.classes },
        sherlock: sherlockSameProviderPct({ ...opts, now }),
    };

    if (useCache) {
        _cache = { ts: now, payload };
    }
    return payload;
}

/** Limpia el cache (tests). */
function _resetCacheForTests() {
    _cache = null;
}

module.exports = {
    percentiles,
    sherlockSameProviderPct,
    dispatchCounts24h,
    errorClassCounts24h,
    latencyByProvider24h,
    timeline24h,
    buildScreenPayload,
    // helpers exportados para tests / reuso
    readJsonlWindow,
    entryTimestampMs,
    dailyFilesInWindow,
    sherlockFiles,
    _resetCacheForTests,
    CACHE_TTL_MS,
    WINDOW_24H_MS,
    SHERLOCK_SAME_PROVIDER_META_PCT,
};

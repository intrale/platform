// =============================================================================
// provider-health.js — Slice + cache para el endpoint GET /api/pulpo/provider-health
// (#3259 CA-5 + CA-6).
//
// Responsabilidad:
//   - Para cada provider declarado en `agent-models.json:providers`, devolver
//     `{ id, status, last_ping_ts, last_quota_flag_ts, resets_at, cache_age_s }`.
//   - `status` ∈ { 'ok', 'gated', 'unknown' }:
//       * 'gated'  → flag activo (quota-exhausted) coincide con este provider.
//       * 'ok'     → no hay flag y/o último ping respondió 2xx (live-ping).
//       * 'unknown' → no se pudo determinar (no key configurada, network err, etc).
//   - `cache_age_s` desde el último ping persistido en
//     `.pipeline/cache/provider-health.json`.
//
// SEGURIDAD (revisión security):
//   - SOLO providers en la allowlist `live-ping.PROVIDER_PING_ENDPOINTS`. Si el
//     caller pide uno arbitrario, se rechaza con `unknown_provider` (caller
//     dashboard NO debe aceptar provider en query string — el endpoint corre
//     por provider sin parámetros, fija la lista internamente).
//   - Cache mandatorio TTL ≥ 5 min para no martillar APIs ni gastar cuota.
//   - Las API keys NUNCA aparecen en la respuesta — sólo IDs, status y ts.
//
// REUTILIZA `live-ping.js` y `quota-exhausted.js`. Sin nuevas dependencias.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let livePing = null;
try { livePing = require('./multi-provider/live-ping'); } catch { /* opcional */ }

let quotaModule = null;
try { quotaModule = require('./quota-exhausted'); } catch { /* opcional */ }

let agentModelsLib = null;
try { agentModelsLib = require('./agent-models'); } catch { /* opcional */ }

// #4283 — tercer insumo de salud: cuota REAL disponible (#4202). Cómputo
// 100% offline (activity-log + .pipeline/metrics), sin HTTP ni credenciales.
let quotaAdaptersLib = null;
try { quotaAdaptersLib = require('./quota-adapters'); } catch { /* opcional */ }

// Cache TTL: piso 5 min (CA-5 del PO). Hardcoded para que config no pueda
// bajar y amplificar tráfico contra providers.
const CACHE_TTL_MS = 5 * 60 * 1000;

// #4283 — reason_code que viaja al router (DURABLE_RED_REASONS) y al dashboard
// cuando la cuota REAL está agotada aunque el login/OAuth sea válido. Debe estar
// también en `health-alerts.ALLOWED_REASON_CODES` (si no, se colapsa a 'unknown')
// y en `dispatch.DURABLE_RED_REASONS` (si no, el gate de fallback lo ignora).
const QUOTA_GATE_REASON = 'quota_exhausted_real';

// Normalización provider-id → id canónico de `quota-adapters` (allowlist). El
// health-cron nombra a Codex como 'openai', pero el adapter de cuota usa
// 'openai-codex'. Los providers fuera de la allowlist de quota-adapters
// (p.ej. nvidia-nim) caen a adapterStatus 'error' → fail-open (no degradan).
const QUOTA_PROVIDER_ALIAS = Object.freeze({ openai: 'openai-codex' });
const CACHE_FILE_SUBDIR = path.join('cache', 'provider-health.json');

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

function pipelineDir(opts = {}) {
    if (opts.pipelineDir) return opts.pipelineDir;
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function cacheFile(opts = {}) {
    return path.join(pipelineDir(opts), CACHE_FILE_SUBDIR);
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

// -----------------------------------------------------------------------------
// Cache I/O
// -----------------------------------------------------------------------------

function readCache(opts = {}) {
    try {
        const raw = fs.readFileSync(cacheFile(opts), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { providers: {} };
        if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {};
        return parsed;
    } catch { return { providers: {} }; }
}

function writeCache(state, opts = {}) {
    const file = cacheFile(opts);
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

// -----------------------------------------------------------------------------
// Provider list
// -----------------------------------------------------------------------------

/**
 * Carga defensiva del config — `agent-models.js` expone `loadAndValidate()`
 * (no hay un getter cacheado). Devolvemos null si falla para que el caller
 * caiga al fallback hardcoded.
 *
 * @returns {object|null}
 */
function loadAgentModelsConfig() {
    if (!agentModelsLib || typeof agentModelsLib.loadAndValidate !== 'function') return null;
    try {
        const result = agentModelsLib.loadAndValidate();
        if (result && result.ok && result.config) return result.config;
    } catch { /* best-effort */ }
    return null;
}

/**
 * Lista los providers declarados en `agent-models.json:providers`. Si el módulo
 * no cargó (test, edge), devuelve la lista hardcoded de live-ping.
 *
 * @returns {string[]} provider IDs (canonical) — incluye TODOS los providers
 *   declarados, sin filtrar por `display_in_health` (fuente de verdad única).
 */
function listConfiguredProviders() {
    const cfg = loadAgentModelsConfig();
    if (cfg && cfg.providers && typeof cfg.providers === 'object') {
        return Object.keys(cfg.providers);
    }
    if (livePing && livePing.PROVIDER_PING_ENDPOINTS) {
        return Object.keys(livePing.PROVIDER_PING_ENDPOINTS);
    }
    return ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];
}

/**
 * #3361 — Devuelve metadata declarativa de cada provider para que el frontend
 * decida cómo renderear sin hardcodear nombres (CA-7). Los flags vienen de
 * `agent-models.json` (`auth_mode`, `display_in_health`).
 *
 * @returns {Array<{ id, auth_mode, display_in_health }>}
 */
function listProvidersWithMetadata() {
    const providers = listConfiguredProviders();
    const cfg = loadAgentModelsConfig();
    return providers.map((id) => {
        const def = (cfg && cfg.providers && cfg.providers[id]) || {};
        const authMode = def.auth_mode === 'oauth' ? 'oauth' : 'api_key';
        const displayInHealth = def.display_in_health === 'not_applicable'
            ? 'not_applicable'
            : 'live';
        return { id, auth_mode: authMode, display_in_health: displayInHealth };
    });
}

/**
 * Mapea provider id de agent-models.json a id de live-ping. live-ping usa
 * `openai` para Codex (mismo endpoint OAuth) — mantenemos esa convención hasta
 * que el módulo agregue providers free. Para los providers que NO están en
 * la allowlist de live-ping devolvemos null → status `unknown` con
 * `reason: 'no_ping_endpoint'`.
 */
function pingableId(provider) {
    if (!livePing || !livePing.PROVIDER_PING_ENDPOINTS) return null;
    if (livePing.PROVIDER_PING_ENDPOINTS[provider]) return provider;
    // Alias: openai-codex → openai (mismo endpoint /v1/models).
    if (provider === 'openai-codex' && livePing.PROVIDER_PING_ENDPOINTS.openai) return 'openai';
    return null;
}

// -----------------------------------------------------------------------------
// #4283 — Señal de cuota real (helper compartido endpoint + cron)
// -----------------------------------------------------------------------------

/**
 * Resuelve el repo root para ubicar el activity-log (offline). Mismo criterio
 * que `getDispatchByProvider`.
 */
function repoRootDir(opts = {}) {
    return opts.repoRoot
        || process.env.CLAUDE_PROJECT_DIR
        || process.env.PIPELINE_REPO_ROOT
        || path.resolve(__dirname, '..', '..');
}

/**
 * Tercer insumo de salud (#4283): combina el estado de cuota REAL disponible
 * (#4202) con el login/OAuth. Helper ÚNICO consumido por `getProviderHealth`
 * (endpoint/slice + dashboard) y por `health-cron.js` (snapshot que lee el
 * router), para que dashboard y router NO diverjan (decisión #4 del PO).
 *
 * Regla de combinación (NO fail-closed — ver Riesgos del issue):
 *   - adapterStatus 'ok' + status 'critical' (uso ≥90%) → `gated:true`,
 *     reason_code 'quota_exhausted_real'.
 *   - adapterStatus 'unknown' | 'error' | 'no_quota' | 'not_implemented' →
 *     `gated:false` (fail-open): NO degradamos, se mantiene el estado
 *     login-based. Coherente con la política fail-open del router (MP-09).
 *
 * El umbral 'critical' (≥90%) lo decide el adapter desde `quota-thresholds.js`
 * (`DEFAULT_PCT_RED`). NO se hardcodea un 90 nuevo acá: una sola fuente de
 * verdad de umbrales (decisión #1 del PO).
 *
 * SEGURIDAD (req#1-3): devuelve SOLO `{ adapterStatus, status, pct, gated,
 * reason_code }`. Nunca API keys, tokens, headers ni el payload crudo del
 * proveedor. `quotaUsage` es offline (sin requests HTTP, no toca credenciales).
 *
 * @param {string} provider — id de provider (acepta alias 'openai').
 * @param {object} [opts]
 * @param {function} [opts.quotaUsageImpl] — inyectable para tests.
 * @param {number} [opts.now] — timestamp determinístico (tests).
 * @returns {{ adapterStatus:string, status:string, pct:(number|null), gated:boolean, reason_code:(string|null) }}
 */
function assessProviderQuota(provider, opts = {}) {
    const safe = { adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null };
    const quotaUsageFn = opts.quotaUsageImpl
        || (quotaAdaptersLib && typeof quotaAdaptersLib.quotaUsage === 'function' ? quotaAdaptersLib.quotaUsage : null);
    if (!quotaUsageFn) return safe;

    const canonical = QUOTA_PROVIDER_ALIAS[provider] || provider;
    const metricsDir = path.join(pipelineDir(opts), 'metrics');
    const activityLogPath = path.join(repoRootDir(opts), '.claude', 'activity-log.jsonl');

    let q;
    try {
        q = quotaUsageFn(canonical, {
            metricsDir,
            activityLogPath,
            configLimitHours: canonical === 'anthropic'
                ? (Number(process.env.ANTHROPIC_MAX_WEEKLY_HOURS) || undefined)
                : undefined,
            now: Number.isFinite(opts.now) ? opts.now : undefined,
        });
    } catch {
        return safe; // fail-open ante excepción inesperada del adapter.
    }
    if (!q || typeof q !== 'object') return safe;

    const adapterStatus = typeof q.adapterStatus === 'string' ? q.adapterStatus : 'unknown';
    const status = typeof q.status === 'string' ? q.status : 'unknown';
    const pct = Number.isFinite(q.pct) ? q.pct : null;

    // Gatear SOLO con señal fresca y durable: adapter OK + cuota crítica (≥90%).
    const gated = adapterStatus === 'ok' && status === 'critical';

    return {
        adapterStatus,
        status,
        pct,
        gated,
        reason_code: gated ? QUOTA_GATE_REASON : null,
    };
}

// -----------------------------------------------------------------------------
// Slice principal
// -----------------------------------------------------------------------------

/**
 * Resuelve el estado de salud por provider. NO pingea si el cache es fresh.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forcePing=false] — ignora cache (NO usar en endpoint
 *   público; sólo para debugging interno).
 * @param {number} [opts.now] — Date.now() override (tests).
 * @param {function} [opts.pingImpl] — inyectable para tests (default: livePing.ping).
 * @returns {Promise<{ ts, providers: Array, cache_ttl_ms }>}
 */
async function getProviderHealth(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const forcePing = !!opts.forcePing;
    const pingImpl = opts.pingImpl || (livePing ? livePing.ping : null);
    const cache = readCache(opts);

    // Lectura del flag de cuota (single read, compartido entre providers).
    let activeFlag = null;
    if (quotaModule && typeof quotaModule.readDefensive === 'function') {
        try {
            const flag = quotaModule.readDefensive({ auditLogEnabled: false, now });
            if (flag && flag.exhausted === true) activeFlag = flag;
        } catch { /* best-effort */ }
    }

    const providersMeta = listProvidersWithMetadata();
    const results = [];

    for (const meta of providersMeta) {
        const provider = meta.id;

        // #4283 — tercer insumo: cuota real (#4202). Offline, sin HTTP. Se
        // computa para TODOS los providers (incluido el primario/not_applicable)
        // porque el dashboard la muestra para todos (CA-5). Sólo degrada el
        // status cuando `gated` (adapter OK + cuota crítica).
        const quotaSignal = assessProviderQuota(provider, { ...opts, now });
        const quotaField = {
            adapterStatus: quotaSignal.adapterStatus,
            status: quotaSignal.status,
            pct: quotaSignal.pct,
        };

        const cached = cache.providers[provider] || {};
        const cachedTs = Number(cached.last_ping_ts_ms || 0);
        const cacheAgeMs = Number.isFinite(cachedTs) && cachedTs > 0 ? now - cachedTs : Infinity;
        const cacheFresh = !forcePing && cacheAgeMs < CACHE_TTL_MS;

        // Estado por flag activo: si el flag es de este provider, gated.
        let status = 'unknown';
        let reason = null;
        let lastQuotaFlagTs = null;
        let resetsAt = null;

        // #3361 CA-7 — providers con display_in_health='not_applicable' NO se
        // pingean (típicamente OAuth managed, Anthropic Max). Reportamos un
        // estado declarativo `not_applicable` para que el frontend pinte
        // "NO APLICA" sin semáforo amarillo confuso. Nunca tocan live-ping ni
        // cache, evitando "no_key_configured" espurio.
        if (meta.display_in_health === 'not_applicable') {
            // #4283 — el primario (Anthropic Max / OAuth managed) MUESTRA su
            // cuota como cualquier otro (CA-5), pero NO se degrada su badge por
            // cuota: el router nunca lo gatea (decisión #3 del PO) y un falso
            // CAÍDO del primario sería peor que el problema. Adjuntamos `quota`
            // informativa sin tocar `status`.
            results.push({
                id: provider,
                status: 'not_applicable',
                reason: meta.auth_mode === 'oauth' ? 'oauth_managed' : 'not_applicable',
                auth_mode: meta.auth_mode,
                display_in_health: meta.display_in_health,
                last_ping_ts: null,
                last_quota_flag_ts: null,
                resets_at: null,
                cache_age_s: 0,
                quota: quotaField,
            });
            continue;
        }

        if (activeFlag && activeFlag.provider === provider) {
            status = 'gated';
            reason = activeFlag.pattern_matched || 'quota_exhausted';
            lastQuotaFlagTs = activeFlag.detected_at || null;
            resetsAt = activeFlag.resets_at || null;
        } else if (cacheFresh && cached.status) {
            // Honrar el cache hit aún si el flag no es nuestro.
            status = cached.status;
            reason = cached.reason || null;
            lastQuotaFlagTs = cached.last_quota_flag_ts || null;
            resetsAt = cached.resets_at || null;
        } else {
            // Pingear si tenemos endpoint conocido. Si no, status='unknown'.
            const targetId = pingableId(provider);
            if (targetId && pingImpl) {
                try {
                    const pong = await pingImpl({ provider: targetId });
                    if (pong && pong.ok === true) {
                        status = 'ok';
                        reason = 'authenticated';
                    } else if (pong && pong.reason === 'quota_exhausted') {
                        status = 'gated';
                        reason = 'quota_exhausted';
                    } else if (pong && pong.reason === 'no_key_configured') {
                        status = 'unknown';
                        reason = 'no_key_configured';
                    } else {
                        status = 'unknown';
                        reason = (pong && pong.reason) || 'ping_failed';
                    }
                } catch (e) {
                    status = 'unknown';
                    reason = 'ping_error';
                }
            } else {
                reason = 'no_ping_endpoint';
            }
            // Persistir en cache.
            cache.providers[provider] = {
                status,
                reason,
                last_ping_ts: new Date(now).toISOString(),
                last_ping_ts_ms: now,
                last_quota_flag_ts: lastQuotaFlagTs,
                resets_at: resetsAt,
            };
        }

        // #4283 — degradación por cuota real: login OK (o cualquier estado no
        // ya-gated) pero cuota agotada → 'gated' con reason 'quota_exhausted_real'
        // (CA-1). Fail-open ante adapter degradado: si `gated` es false (incluye
        // adapterStatus unknown/error), NO se toca el status login-based (CA-2).
        // No se persiste esta degradación en el cache de login (la señal de
        // cuota se recomputa offline en cada llamada).
        if (quotaSignal.gated && status !== 'gated') {
            status = 'gated';
            reason = QUOTA_GATE_REASON;
        }

        const cachedEntry = cache.providers[provider] || {};
        results.push({
            id: provider,
            status,
            reason,
            auth_mode: meta.auth_mode,
            display_in_health: meta.display_in_health,
            last_ping_ts: cachedEntry.last_ping_ts || null,
            last_quota_flag_ts: lastQuotaFlagTs,
            resets_at: resetsAt,
            cache_age_s: cacheFresh
                ? Math.floor(cacheAgeMs / 1000)
                : 0,
            quota: quotaField,
        });
    }

    // Escribir cache (sólo si pingeamos al menos uno).
    if (!forcePing) {
        try { writeCache(cache, opts); } catch { /* best-effort */ }
    } else {
        // En force-ping reescribimos todo igual.
        try { writeCache(cache, opts); } catch { /* best-effort */ }
    }

    return {
        ts: new Date(now).toISOString(),
        providers: results,
        cache_ttl_ms: CACHE_TTL_MS,
    };
}

// -----------------------------------------------------------------------------
// CA-6: dispatch por provider (24h)
// -----------------------------------------------------------------------------

/**
 * Lee `metrics/aggregator.json` (o el activity-log si disponible) y devuelve
 * conteo de despachos por provider últimas 24h. Resiliente a archivos
 * ausentes: si no hay datos, devuelve totales en 0.
 *
 * @param {object} [opts]
 * @returns {{ ts, window_ms, totals: { provider: count }, total: number }}
 */
function getDispatchByProvider(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;
    const totals = Object.create(null);
    let total = 0;

    // Source primario: activity log (.claude/activity-log.jsonl).
    const repoRoot = opts.repoRoot
        || process.env.CLAUDE_PROJECT_DIR
        || process.env.PIPELINE_REPO_ROOT
        || path.resolve(__dirname, '..', '..');
    const logFile = path.join(repoRoot, '.claude', 'activity-log.jsonl');
    try {
        const raw = fs.readFileSync(logFile, 'utf8');
        const lines = raw.split('\n');
        for (const line of lines) {
            if (!line) continue;
            let evt;
            try { evt = JSON.parse(line); } catch { continue; }
            if (!evt || evt.event !== 'session:start') continue;
            const ts = evt.ts ? Date.parse(evt.ts) : NaN;
            if (!Number.isFinite(ts) || ts < cutoff) continue;
            const p = evt.provider || 'unknown';
            totals[p] = (totals[p] || 0) + 1;
            total++;
        }
    } catch { /* best-effort: si el log no existe, totals queda vacío */ }

    return {
        ts: new Date(now).toISOString(),
        window_ms: windowMs,
        totals,
        total,
    };
}

module.exports = {
    getProviderHealth,
    getDispatchByProvider,
    assessProviderQuota,
    listConfiguredProviders,
    listProvidersWithMetadata,
    pingableId,
    readCache,
    writeCache,
    cacheFile,
    CACHE_TTL_MS,
    CACHE_FILE_SUBDIR,
    QUOTA_GATE_REASON,
};

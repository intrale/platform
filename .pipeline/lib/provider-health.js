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

// Cache TTL: piso 5 min (CA-5 del PO). Hardcoded para que config no pueda
// bajar y amplificar tráfico contra providers.
const CACHE_TTL_MS = 5 * 60 * 1000;
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
 * Lista los providers declarados en `agent-models.json:providers`. Si el módulo
 * no cargó (test, edge), devuelve la lista hardcoded de live-ping.
 */
function listConfiguredProviders() {
    if (agentModelsLib && typeof agentModelsLib.getAgentModelsConfig === 'function') {
        try {
            const cfg = agentModelsLib.getAgentModelsConfig();
            if (cfg && cfg.providers && typeof cfg.providers === 'object') {
                return Object.keys(cfg.providers);
            }
        } catch { /* fallthrough */ }
    }
    if (livePing && livePing.PROVIDER_PING_ENDPOINTS) {
        return Object.keys(livePing.PROVIDER_PING_ENDPOINTS);
    }
    return ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];
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

    const providers = listConfiguredProviders();
    const results = [];

    for (const provider of providers) {
        const cached = cache.providers[provider] || {};
        const cachedTs = Number(cached.last_ping_ts_ms || 0);
        const cacheAgeMs = Number.isFinite(cachedTs) && cachedTs > 0 ? now - cachedTs : Infinity;
        const cacheFresh = !forcePing && cacheAgeMs < CACHE_TTL_MS;

        // Estado por flag activo: si el flag es de este provider, gated.
        let status = 'unknown';
        let reason = null;
        let lastQuotaFlagTs = null;
        let resetsAt = null;

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

        const cachedEntry = cache.providers[provider] || {};
        results.push({
            id: provider,
            status,
            reason,
            last_ping_ts: cachedEntry.last_ping_ts || null,
            last_quota_flag_ts: lastQuotaFlagTs,
            resets_at: resetsAt,
            cache_age_s: cacheFresh
                ? Math.floor(cacheAgeMs / 1000)
                : 0,
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
    listConfiguredProviders,
    pingableId,
    readCache,
    writeCache,
    cacheFile,
    CACHE_TTL_MS,
    CACHE_FILE_SUBDIR,
};

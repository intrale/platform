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

// #4365 — re-probe activo de Codex para des-atascar el estado `no_usage_data`/
// `no_quota`. REUSAMOS `probeCodexHealth` (spawn `codex --version`): OFFLINE,
// cero tokens, cero costo (security req#2). NUNCA dispara generación real ni
// HTTP. El re-probe es rate-limited (persistido en cache) para no martillar.
let codexLauncherLib = null;
try { codexLauncherLib = require('./agent-launcher/providers/openai-codex'); } catch { /* opcional */ }

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

// #4365 — reason_code no-durable que marca que un provider degradado por
// AUSENCIA DE DATO (`no_usage_data`/`no_quota`) fue re-verificado vivo por el
// probe offline. NO gatea (fail-open): sólo documenta la reincorporación.
const QUOTA_REPROBE_HEALTHY_REASON = 'quota_reprobe_healthy';

// Estados degradados por "sin dato de consumo" que habilitan el re-probe. NO
// incluye 'critical' real (ese jamás se re-incorpora — security req#5 / #4283).
const REPROBE_ELIGIBLE_STATUSES = Object.freeze(['no_usage_data', 'no_quota']);

// Intervalo mínimo entre re-probes (rate-limit anti-martilleo). Configurable por
// env con piso defensivo de 60s para que config no pueda spamear spawns.
const REPROBE_MIN_INTERVAL_MS = (() => {
    const raw = Number(process.env.CODEX_REPROBE_MIN_INTERVAL_MS);
    if (Number.isFinite(raw) && raw >= 60 * 1000) return raw;
    return 5 * 60 * 1000; // 5 min por defecto (mismo orden que el cache TTL).
})();

const REPROBE_STATE_SUBDIR = path.join('cache', 'codex-reprobe.json');
const REPROBE_AUDIT_SUBDIR = path.join('logs', 'provider-reprobe.jsonl');

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
 *   - adapterStatus 'unknown' | 'error' | 'no_quota' | 'no_usage_data' |
 *     'not_implemented' → `gated:false` (fail-open): NO degradamos, se mantiene
 *     el estado login-based. Coherente con la política fail-open del router
 *     (MP-09). #4365 — `no_usage_data` ("sin consumo medido") se trata igual que
 *     `no_quota`: fail-open + re-probe no-durable (ver `maybeReprobeCodex`).
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
// -----------------------------------------------------------------------------
// #4365 — Re-probe activo de Codex (offline, rate-limited)
// -----------------------------------------------------------------------------

function reprobeStateFile(opts = {}) {
    return path.join(pipelineDir(opts), REPROBE_STATE_SUBDIR);
}

/**
 * Lectura defensiva del estado persistido del re-probe. Nunca lanza.
 * @returns {{ ts:number, healthy:boolean }|null}
 */
function readReprobeState(opts = {}) {
    try {
        const raw = fs.readFileSync(reprobeStateFile(opts), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const ts = Number(parsed.ts);
        if (!Number.isFinite(ts)) return null;
        return { ts, healthy: parsed.healthy === true };
    } catch { return null; }
}

function writeReprobeState(state, opts = {}) {
    const file = reprobeStateFile(opts);
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${state.ts}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch { try { fs.unlinkSync(tmp); } catch {} }
}

/**
 * Deja traza de auditoría de la transición de salud del re-probe (OWASP A09 /
 * security req: "el re-probe debe dejar traza de por qué un provider volvió a
 * estar disponible"). Best-effort, nunca lanza, sin secrets.
 */
function auditReprobe(entry, opts = {}) {
    try {
        const file = path.join(pipelineDir(opts), REPROBE_AUDIT_SUBDIR);
        ensureDir(path.dirname(file));
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch { /* best-effort */ }
}

/**
 * Re-probe no-durable y rate-limited de Codex. REUSA `probeCodexHealth`
 * (spawn `codex --version`): OFFLINE, cero tokens, cero costo, cero HTTP.
 * Sólo aplica a providers degradados por AUSENCIA DE DATO — NUNCA a un
 * `critical` real (ese jamás se reincorpora, security req#5).
 *
 * @param {object} opts
 *   @property {function} [probeCodexImpl]      override del probe (tests).
 *   @property {function} [reprobeStateReadImpl] override lectura de estado (tests).
 *   @property {function} [reprobeStateWriteImpl] override escritura de estado (tests).
 *   @property {function} [auditImpl]           override de auditoría (tests).
 *   @property {number}   [reprobeMinIntervalMs] override del rate-limit (tests).
 * @param {number} now — epoch ms.
 * @returns {{ healthy:boolean, ts:number, cached:boolean }|null} null si el
 *   probe no está disponible (módulo ausente en tests/edge).
 */
function maybeReprobeCodex(opts = {}, now = Date.now()) {
    const probeFn = opts.probeCodexImpl
        || (codexLauncherLib && typeof codexLauncherLib.probeCodexHealth === 'function'
            ? codexLauncherLib.probeCodexHealth
            : null);
    if (typeof probeFn !== 'function') return null;

    const minInterval = Number.isFinite(opts.reprobeMinIntervalMs)
        ? opts.reprobeMinIntervalMs
        : REPROBE_MIN_INTERVAL_MS;

    const readState = opts.reprobeStateReadImpl || (() => readReprobeState(opts));
    const prev = readState();

    // Rate-limit: si el último probe es reciente, reusamos su resultado sin
    // spawnear de nuevo (anti-martilleo — security req#2).
    if (prev && Number.isFinite(prev.ts) && (now - prev.ts) < minInterval) {
        return { healthy: !!prev.healthy, ts: prev.ts, cached: true };
    }

    let probe;
    try {
        probe = probeFn({ now: Number.isFinite(opts.now) ? opts.now : undefined });
    } catch {
        // Fallo del probe: devolvemos el estado previo si existe (fail-open).
        return prev ? { healthy: !!prev.healthy, ts: prev.ts, cached: true } : null;
    }
    const healthy = !!(probe && probe.ok);
    const state = { ts: now, healthy };

    const writeState = opts.reprobeStateWriteImpl || ((s) => writeReprobeState(s, opts));
    writeState(state);

    // Traza sólo en transición (evita ruido en el log de auditoría).
    if (!prev || prev.healthy !== healthy) {
        const audit = opts.auditImpl || ((e) => auditReprobe(e, opts));
        audit({
            ts: new Date(now).toISOString(),
            provider: 'openai-codex',
            event: 'quota_reprobe',
            from: prev ? (prev.healthy ? 'healthy' : 'unhealthy') : 'unknown',
            to: healthy ? 'healthy' : 'unhealthy',
            source: 'probeCodexHealth(--version)',
        });
    }

    return { healthy, ts: now, cached: false };
}

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

    const out = {
        adapterStatus,
        status,
        pct,
        gated,
        reason_code: gated ? QUOTA_GATE_REASON : null,
    };

    // #4365 — Re-probe no-durable cuando el provider está degradado por AUSENCIA
    // DE DATO (`no_usage_data`/`no_quota`). El flujo ya es fail-open (gated=false
    // → el router NO lo descarta), pero un provider realmente vivo debe seguir
    // disponible sin intervención manual y dejar traza de por qué. Reusamos el
    // probe offline `probeCodexHealth` (spawn --version), rate-limited. SOLO
    // aplica a Codex y NUNCA sobreescribe un `critical` real (security req#5).
    if (canonical === 'openai-codex' && !gated
        && REPROBE_ELIGIBLE_STATUSES.includes(adapterStatus)
        && opts.reprobe !== false) {
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const rp = maybeReprobeCodex(opts, now);
        if (rp) {
            // Exponemos el resultado del re-probe SIN tocar `reason_code` (que es
            // exclusivo del gateo): el provider ya está disponible por fail-open.
            // La reincorporación queda documentada en `reprobe` + audit log.
            out.reprobe = {
                healthy: rp.healthy,
                ts: rp.ts,
                cached: rp.cached,
                reason: rp.healthy ? QUOTA_REPROBE_HEALTHY_REASON : 'quota_reprobe_unhealthy',
            };
        }
    }

    return out;
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
    // #4365 — re-probe activo (offline, rate-limited).
    maybeReprobeCodex,
    readReprobeState,
    writeReprobeState,
    QUOTA_REPROBE_HEALTHY_REASON,
    REPROBE_ELIGIBLE_STATUSES,
    REPROBE_MIN_INTERVAL_MS,
};

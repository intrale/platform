// =============================================================================
// health-cron.js — Cron de healthchecks por provider (#3260 CA-1 / CA-2).
//
// Responsabilidades:
//   - Cada ~N min (configurable vía `config.yaml` → `multi_provider.health.
//     interval_minutes`, default 5 min; con jitter aleatorio ±60s, SR-3 /
//     #4402 CA-3), pingear el endpoint
//     `/v1/models` (o equivalente) de cada provider gestionado de
//     `secrets-rw.js` que esté presente y tenga endpoint en `live-ping.js`.
//   - Persistir snapshot en `audit/multi-provider-health.jsonl` con hash-chain
//     (SR-10 / SR-6) y en `.pipeline/state/multi-provider-health.json` (que el
//     dashboard lee con cache_ttl).
//   - Una vez por semana (`weekly_check_at` >= 7d), correr el check de validez
//     de API keys (CA-2 — el endpoint ya es `/v1/models`, no consume cuota).
//   - Aplicar lock por archivo (`flock`-like via O_CREAT+O_EXCL) para evitar
//     thundering herd cuando dashboard y pulpo corren el cron en paralelo.
//   - Evaluar transiciones de estado y emitir alertas vía `health-alerts.js`
//     (dedupe + back-off + redact).
//
// SEGURIDAD:
//   - SOLO providers de `secrets-rw.MANAGED_KEYS` ∩ `live-ping.PROVIDER_PING_ENDPOINTS`.
//   - El snapshot en `state/` NO se escribe en directorio web-served — vive en
//     `.pipeline/state/` (igual que el resto del estado del pulpo).
//   - El audit log usa `appendChained` (hash-chain SHA-256).
//   - Nunca se llama a un completion — solo `/models` (no consume cuota).
//
// USO:
//   - `tickIfDue(opts)` — punto de entrada idempotente. Llamarlo cada minuto
//     desde el pulpo (o desde el dashboard); si toca correr, corre; si no,
//     no hace nada. Solo un proceso a la vez gana el lock.
//   - `runOnce(opts)` — fuerza una corrida (CLI / tests). NO respeta el lock.
//
// CLI:
//   `node .pipeline/lib/multi-provider/health-cron.js`
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const secretsRw = require('./secrets-rw');
const livePing = require('./live-ping');
const healthAlerts = require('./health-alerts');
const auditLog = require('../audit-log');
const redact = require('../redact');
// #4402 — fuente única de la lógica CLI-OAuth (extraída de acá a un módulo
// compartido para que `live-ping.js` la reutilice sin ciclo de require).
const cliOauthProbe = require('./cli-oauth-probe');

// #4283 — señal de cuota real (#4202) vía el helper compartido de
// provider-health, para que el snapshot del cron (que lee el router) y el
// endpoint/dashboard NO diverjan (decisión #4 del PO). Carga defensiva.
let providerHealth = null;
try { providerHealth = require('../provider-health'); } catch { /* opcional */ }

// default_provider (primario). Lectura defensiva: el primario NUNCA se gatea
// por cuota en el snapshot (decisión #3 del PO) — el router ya no gatea al
// primario, y un falso CAÍDO del primario en el dashboard sería peor.
function readDefaultProvider() {
    try {
        const am = require('./agent-models-rw');
        const cfg = am.readConfig();
        if (cfg && typeof cfg.default_provider === 'string' && cfg.default_provider) {
            return cfg.default_provider;
        }
    } catch { /* best-effort */ }
    return 'anthropic';
}

// #5888 — Config de agentes completa (providers + skills). Lectura defensiva:
// si `agent-models.json` no se puede leer, el cruce de catálogo queda sin
// modelos que verificar y la barrera no corre — nunca marca modelos como
// muertos por no poder leer su propia config (cond. 1/2, fail-open).
function readAgentModelsConfig() {
    try {
        // eslint-disable-next-line global-require
        const am = require('./agent-models-rw');
        const cfg = am.readConfig();
        return (cfg && typeof cfg === 'object') ? cfg : {};
    } catch { return {}; }
}

// Alias provider-key (cron) → default_provider key. El cron usa 'openai' para
// Codex; el default_provider de agent-models usa 'openai-codex'. Comparamos
// normalizando para no flipear a rojo al primario si fuera Codex.
const DEFAULT_PROVIDER_ALIAS = Object.freeze({ openai: 'openai-codex' });

// Resolver paths según el contexto. En tests/CLI se pueden inyectar.
function defaultStateDir() {
    return process.env.PIPELINE_STATE_DIR
        || path.resolve(__dirname, '..', '..', 'state');
}

function defaultAuditDir() {
    return process.env.PIPELINE_AUDIT_DIR
        || path.resolve(__dirname, '..', '..', 'audit');
}

// Constantes — el cron mismo expone para tests y para la doc operativa CA-5.
//
// #4402 CA-3 — La cadencia dejó de ser hardcode. `TICK_INTERVAL_MS` es sólo el
// DEFAULT de fallback (5 min); la fuente real es `config.yaml`
// (`multi_provider.health.interval_minutes`) vía `readTickIntervalMs()`.
const DEFAULT_INTERVAL_MINUTES = 5;                 // #4402 default (antes 15min hardcode)
const MIN_INTERVAL_MINUTES = 1;                     // clamp piso (=60s, RS-5.5 anti-DoS free tier)
const MAX_INTERVAL_MINUTES = 240;                   // clamp techo (mismo estilo que config.yaml)
const HARD_FLOOR_MS = 60 * 1000;                    // RS-5.5 — piso duro absoluto ≥60s
const TICK_INTERVAL_MS = DEFAULT_INTERVAL_MINUTES * 60 * 1000;  // 5min default-fallback
const JITTER_RANGE_MS = 60 * 1000;                  // ±60s alrededor del slot
const WEEKLY_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;                // si el lock tiene >5min, lo robamos
const SNAPSHOT_FILENAME = 'multi-provider-health.json';
// tracking interno: last_tick_at, last_weekly_check_at, last_catalog_check_at (#5888).
const STATE_FILENAME = 'multi-provider-health-state.json';
const LOCK_FILENAME = 'multi-provider-health.lock';
const AUDIT_FILENAME = 'multi-provider-health.jsonl';

// -----------------------------------------------------------------------------
// #5888 D-4 / CA-10 — Cadencia PROPIA de la verificación de catálogo.
//
// El health-ping sigue en 5 min (barato, `/models` no consume cuota). El cruce
// de catálogo baja hasta 1 MiB de body por provider: correrlo cada 5 min sería
// desproporcionado para una condición que cambia con frecuencia trimestral.
// TTL default 6h, con piso duro de 6h (`MIN`) para que un config equivocado no
// pueda convertirlo en un ping de catálogo cada minuto.
// -----------------------------------------------------------------------------
const CATALOG_CHECK_DEFAULT_HOURS = 6;
const CATALOG_CHECK_MIN_HOURS = 6;
const CATALOG_CHECK_MAX_HOURS = 168;   // 7 días

// Providers en alcance del cruce (cond. 9 + D-1). Escrito, no implícito (CA-13).
// `anthropic` / `openai` quedan fuera porque corren por CLI-OAuth y `ping()`
// hace short-circuit antes del HTTP; `kimi-moonshot` queda fuera por D-1 (no
// está en MANAGED_KEYS ni en PROVIDER_PING_ENDPOINTS — ref. #5892).
const CATALOG_CHECK_PROVIDERS = Object.freeze(['nvidia-nim', 'gemini-google', 'cerebras']);

// #5888 G-7/CA-13 — El cron nombra a Codex `openai`; `agent-models.json` lo
// nombra `openai-codex`. El mapeo queda EXPLÍCITO para que el día que Codex
// entre al alcance del cruce no se saltee en silencio por un nombre que no
// matchea.
const PING_TO_CONFIG_PROVIDER = Object.freeze({ openai: 'openai-codex' });

function jitterMs(rangeMs = JITTER_RANGE_MS, rng = Math.random) {
    return Math.floor((rng() * 2 - 1) * rangeMs);
}

// -----------------------------------------------------------------------------
// #4402 CA-3 — Cadencia configurable vía config.yaml
//
// Lee `multi_provider.health.interval_minutes` de `.pipeline/config.yaml`.
// Clamp `[1, 240]` min con piso duro ≥60s (RS-5.5, anti-DoS: Gemini RPM 15,
// Cerebras RPM 30).
//
// #5172 (D-D / CA-12) — DOS cambios acá:
//
//  1. Se ELIMINÓ `process.env.PIPELINE_CONFIG_PATH`. Aportaba por ENTORNO una
//     RUTA DE ARCHIVO, que es exactamente lo que CA-12 prohíbe: permitía apuntar
//     la configuración que enforza el pipeline a cualquier YAML del disco. La
//     variable queda DEPRECIADA (ningún archivo de producción la lee) y la raíz
//     la resuelve `config-resolver` con su regla única — el entorno aporta
//     DIRECTORIO, el nombre del archivo lo pone el resolver.
//
//  2. Se ELIMINÓ el `catch { /* → default 5 min */ }`. Un config ilegible,
//     un YAML roto o un `interval_minutes` que viola el schema ya no se
//     disfrazan de "cadencia default": el error tipado (`ConfigParseViolation` /
//     `ConfigSchemaViolation`, ya redactado) se PROPAGA al llamador.
//
// Lo que NO cambia: la inyección por firma `configPath` (es código, no entorno);
// y la AUSENCIA de `multi_provider.health.interval_minutes` — o de la sección
// entera — sigue cayendo al default de 5 min: sección opcional ausente no es
// corrupción, y el clamp `[1,240]` sigue siendo responsabilidad del cron.
//
// (`fsImpl` se sacó de la firma: la lectura del config la hace el resolver, así
// que un fs inyectado acá ya no tenía efecto. Los demás helpers del cron lo
// conservan.)
// -----------------------------------------------------------------------------

function readTickIntervalMs({ configPath } = {}) {
    let minutes = DEFAULT_INTERVAL_MINUTES;
    // eslint-disable-next-line global-require
    const configResolver = require('../config-resolver');
    const cfg = configResolver.resolve(configPath ? { configPath } : {});
    const v = cfg
        && cfg.multi_provider
        && cfg.multi_provider.health
        && cfg.multi_provider.health.interval_minutes;
    if (typeof v === 'number' && Number.isFinite(v)) minutes = v;
    if (!Number.isFinite(minutes)) minutes = DEFAULT_INTERVAL_MINUTES;
    // Clamp [1, 240] min. El piso de 1 min ya garantiza ≥60s; HARD_FLOOR_MS es
    // un segundo cinturón explícito (RS-5.5).
    minutes = Math.min(Math.max(minutes, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
    return Math.max(minutes * 60 * 1000, HARD_FLOOR_MS);
}

// -----------------------------------------------------------------------------
// #5888 CA-10 — TTL de la verificación de catálogo, leído por el MISMO resolver
// de config que `readTickIntervalMs()` (#5172: este módulo no decide qué archivo
// es la config; el entorno aporta DIRECTORIO, el nombre lo pone el resolver).
//
// A diferencia de `readTickIntervalMs`, acá el error de config NO se propaga:
// un config roto ya hace fallar el tick entero por `readTickIntervalMs` mucho
// antes de llegar acá. Lo que sí atajamos es el valor ausente/no numérico → 6h.
// -----------------------------------------------------------------------------
function readCatalogTtlMs({ configPath } = {}) {
    let hours = CATALOG_CHECK_DEFAULT_HOURS;
    // eslint-disable-next-line global-require
    const configResolver = require('../config-resolver');
    const cfg = configResolver.resolve(configPath ? { configPath } : {});
    const v = cfg
        && cfg.multi_provider
        && cfg.multi_provider.health
        && cfg.multi_provider.health.catalog_check_hours;
    if (typeof v === 'number' && Number.isFinite(v)) hours = v;
    if (!Number.isFinite(hours)) hours = CATALOG_CHECK_DEFAULT_HOURS;
    hours = Math.min(Math.max(hours, CATALOG_CHECK_MIN_HOURS), CATALOG_CHECK_MAX_HOURS);
    return hours * 60 * 60 * 1000;
}

// -----------------------------------------------------------------------------
// CLI-OAuth probe (#3802) — validar el camino que el pipeline realmente usa.
//
// Anthropic (Claude Code) y OpenAI/Codex NO se usan por API key: corren por la
// CLI con OAuth (`claude` MAX login / `codex login`). Pinear su API key da un
// falso ROJO (la key está ausente o devuelve 403) aunque la CLI funcione bien.
// Para esos providers validamos que el binario de la CLI esté disponible en el
// PATH — el camino real— en lugar de la key.
//
// Determinístico (scan de PATH, sin red, sin consumir cuota) e inyectable en
// tests vía `opts.cliProbe`.
// -----------------------------------------------------------------------------

// #4402 — `isBinaryOnPath` y `probeCliProvider` se movieron a `cli-oauth-probe.js`
// (fuente única compartida con `live-ping.js`). Se re-exportan más abajo en
// `module.exports` para no romper tests/consumers que referencian
// `healthCron.probeCliProvider` / `healthCron.isBinaryOnPath`.
const { isBinaryOnPath, probeCliProvider } = cliOauthProbe;

function readJson(file, fsImpl = fs) {
    if (!fsImpl.existsSync(file)) return null;
    try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
    catch { return null; }
}

function writeJsonAtomic(file, data, fsImpl = fs) {
    const dir = path.dirname(file);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
}

// -----------------------------------------------------------------------------
// Lock anti-thundering herd (SR-3)
// -----------------------------------------------------------------------------

/**
 * Intenta tomar un lock atómico via O_CREAT+O_EXCL. Devuelve `true` si lo tomó,
 * `false` si está ocupado y no está stale. Si está stale (> LOCK_STALE_MS), lo
 * roba (reemplaza el contenido).
 */
function tryAcquireLock({ lockFile, now = Date.now(), fsImpl = fs } = {}) {
    const dir = path.dirname(lockFile);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });

    const payload = JSON.stringify({ pid: process.pid, acquired_at: now }) + '\n';
    try {
        const fd = fsImpl.openSync(lockFile, 'wx', 0o600); // 'wx' = O_CREAT | O_EXCL
        try { fsImpl.writeSync(fd, payload); } finally { fsImpl.closeSync(fd); }
        return true;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }

    // Lock existe — chequear si está stale.
    const existing = readJson(lockFile, fsImpl);
    if (!existing || typeof existing.acquired_at !== 'number') {
        // Lock corrupto — robar.
        try { fsImpl.writeFileSync(lockFile, payload, { mode: 0o600 }); return true; }
        catch { return false; }
    }
    if (now - existing.acquired_at > LOCK_STALE_MS) {
        try { fsImpl.writeFileSync(lockFile, payload, { mode: 0o600 }); return true; }
        catch { return false; }
    }
    return false;
}

function releaseLock({ lockFile, fsImpl = fs } = {}) {
    try { fsImpl.unlinkSync(lockFile); } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Lógica de "está debido el tick?"
// -----------------------------------------------------------------------------

/**
 * Determina si toca correr según `last_tick_at` + intervalo + jitter.
 *
 * - Si nunca corrió → debido (true).
 * - Si `elapsed >= intervalMs + jitter`, debido.
 * - El jitter se aplica restando del intervalo (los procesos elegibles más
 *   "temprano" tienden a ganar el lock antes que los "tardíos", suavizando
 *   el thundering herd).
 *
 * #4402 CA-3 — `intervalMs` es configurable vía `config.yaml`; si no se inyecta,
 * se resuelve con `readTickIntervalMs()` (default 5 min, clamp piso ≥60s).
 */
function isTickDue({ stateFile, now = Date.now(), fsImpl = fs, jitter = jitterMs(), intervalMs } = {}) {
    const st = readJson(stateFile, fsImpl);
    if (!st || typeof st.last_tick_at !== 'number') return true;
    // #5172 — `readTickIntervalMs` ya no toma `fsImpl`: el config lo lee el
    // punto único (`config-resolver`), no un fs inyectado.
    const interval = Number.isFinite(intervalMs) ? intervalMs : readTickIntervalMs();
    const elapsed = now - st.last_tick_at;
    return elapsed >= (interval + jitter);
}

function isWeeklyDue({ stateFile, now = Date.now(), fsImpl = fs } = {}) {
    const st = readJson(stateFile, fsImpl);
    if (!st || typeof st.last_weekly_check_at !== 'number') return true;
    return (now - st.last_weekly_check_at) >= WEEKLY_CHECK_INTERVAL_MS;
}

// #5888 CA-10 — espejo exacto de `isWeeklyDue`, con su propia key de estado.
// Sin esto, los ticks de 5 min bajarían el catálogo 288 veces por día.
function isCatalogCheckDue({ stateFile, now = Date.now(), fsImpl = fs, ttlMs } = {}) {
    const st = readJson(stateFile, fsImpl);
    if (!st || typeof st.last_catalog_check_at !== 'number') return true;
    const ttl = Number.isFinite(ttlMs) ? ttlMs : readCatalogTtlMs();
    return (now - st.last_catalog_check_at) >= ttl;
}

// -----------------------------------------------------------------------------
// #5888 CA-1 — Los pares `(provider, model_id)` configurados, de las 4 fuentes.
//
// NO reimplementamos la resolución de la cadena: `agent-models-validate.
// resolveSkillChain(config, skill)` ya devuelve `{provider, model, source}`
// cubriendo `skills[].provider` + `model_override`, el default del provider y
// `fallbacks[].model_override`. Sólo falta `providers[].alternative_models[]`.
//
// La fuente de verdad es `agent-models.json`, NUNCA `model-catalog.js`: ese
// catálogo local devuelve `null` para los 3 providers en alcance (G-8), así que
// el cruce se auto-vaciaría y la barrera quedaría muda.
//
// El caso que motivó la historia es justamente el fallback: `deepseek-v4-pro`
// mató agentes estando configurado como fallback, no como primario.
// -----------------------------------------------------------------------------
function configuredModelsByProvider(config) {
    const out = new Map();  // provider (key de config) -> Set<model_id>
    const add = (prov, model) => {
        if (typeof prov !== 'string' || typeof model !== 'string' || !model) return;
        if (!out.has(prov)) out.set(prov, new Set());
        out.get(prov).add(model);
    };
    const providers = (config && config.providers && typeof config.providers === 'object')
        ? config.providers : {};
    for (const [prov, def] of Object.entries(providers)) {
        add(prov, def && def.model);                                       // fuente 1
        const alts = Array.isArray(def && def.alternative_models) ? def.alternative_models : [];
        for (const alt of alts) add(prov, alt);                            // fuente 2
    }
    const skills = (config && config.skills && typeof config.skills === 'object')
        ? config.skills : {};
    for (const skill of Object.keys(skills)) {
        let chain = [];
        // eslint-disable-next-line global-require
        try { chain = require('../agent-models-validate').resolveSkillChain(config, skill) || []; }
        catch { chain = []; }
        for (const link of chain) add(link && link.provider, link && link.model);  // fuentes 3 y 4
    }
    return out;
}

/**
 * Modelos a verificar por provider de PING (no de config). Devuelve un Map
 * `providerDePing -> string[]`, ya restringido a `CATALOG_CHECK_PROVIDERS`.
 */
function expectModelsForPing(config) {
    const byConfigKey = configuredModelsByProvider(config);
    const out = new Map();
    for (const pingProvider of CATALOG_CHECK_PROVIDERS) {
        const configKey = PING_TO_CONFIG_PROVIDER[pingProvider] || pingProvider;
        const set = byConfigKey.get(configKey);
        if (set && set.size > 0) out.set(pingProvider, Array.from(set).sort());
    }
    return out;
}

// #5888 (e) — Shape persistido en el snapshot. Sólo `{model_id, alive}` sale del
// pipeline de datos: el `detail` interno de `crossCheckCatalog` se descarta acá
// (es diagnóstico del módulo, no información para el snapshot ni el audit).
function buildCatalogCheck(catalogCheck, checkedAtIso) {
    const never = { state: 'never', checked_at: null, reason_code: null, models: [] };
    if (!catalogCheck || typeof catalogCheck !== 'object') {
        // Se pidió el cruce pero no hubo resultado (provider sin key, skipped,
        // OAuth): ausencia de señal, reportable — no "todo bien" (D-3/CA-3).
        return { state: 'unavailable', checked_at: checkedAtIso, reason_code: 'model_check_unavailable', models: [] };
    }
    if (catalogCheck.ok !== true) {
        return { state: 'unavailable', checked_at: checkedAtIso, reason_code: 'model_check_unavailable', models: [] };
    }
    const models = (Array.isArray(catalogCheck.models) ? catalogCheck.models : [])
        .filter((m) => m && typeof m.model_id === 'string')
        .map((m) => ({ model_id: m.model_id, alive: m.alive === true }));
    if (models.length === 0) return never;
    const dead = models.filter((m) => !m.alive);
    return {
        state: dead.length > 0 ? 'not_in_catalog' : 'verified',
        checked_at: checkedAtIso,
        reason_code: dead.length > 0 ? 'model_not_in_catalog' : null,
        models,
    };
}

// -----------------------------------------------------------------------------
// Cálculo de estado por provider
// -----------------------------------------------------------------------------

/**
 * Mapea un resultado de `live-ping.ping` + el estado previo cacheado al
 * 3-estados de UX:
 *   - green: ok=true y rate_limit_hit_24h === 0
 *   - yellow: ok=true pero rate_limit_hit_24h > 0
 *   - red: ok=false (cualquier reason)
 *
 * El rate_limit_hit_24h se cuenta en memoria del snapshot: cada tick que da
 * `rate_limited` incrementa el contador, el contador se decae en ticks
 * sucesivos (descuenta 1 si el tick es OK).
 */
function classifyState(pingResult, prevEntry) {
    if (!pingResult || typeof pingResult !== 'object') return 'red';
    const rateHits = prevEntry && typeof prevEntry.rate_limit_hit_24h === 'number'
        ? prevEntry.rate_limit_hit_24h
        : 0;
    if (pingResult.ok === true) {
        return rateHits > 0 ? 'yellow' : 'green';
    }
    return 'red';
}

function updateRateLimitCounter(pingResult, prevEntry) {
    const prev = (prevEntry && typeof prevEntry.rate_limit_hit_24h === 'number')
        ? prevEntry.rate_limit_hit_24h : 0;
    if (!pingResult) return prev;
    if (pingResult.reason === 'rate_limited' || pingResult.reason === 'quota_exhausted') {
        return Math.min(prev + 1, 9999);
    }
    if (pingResult.ok === true && prev > 0) {
        return Math.max(prev - 1, 0);
    }
    return prev;
}

// -----------------------------------------------------------------------------
// Provider list — intersección segura
// -----------------------------------------------------------------------------

/**
 * Lista de providers a chequear: aquellos que están en MANAGED_KEYS *y* tienen
 * endpoint conocido en PROVIDER_PING_ENDPOINTS. Si la key está absent /
 * placeholder, igual aparece en el snapshot (status=`absent`) pero no se pingea.
 */
function listManagedAndPingable() {
    const managed = secretsRw.MANAGED_KEYS;
    return managed.filter(spec => livePing.isAllowedProvider(spec.provider));
}

// -----------------------------------------------------------------------------
// Snapshot build + alerts
// -----------------------------------------------------------------------------

async function pingAllProviders({ providers, prevSnapshot, secretsPath, fsImpl = fs, httpImpl, pingImpl, cliProbe, quotaAssessImpl, defaultProvider, now, checkCatalog = false, expectModelsByProvider = null } = {}) {
    const prevByProvider = {};
    if (prevSnapshot && Array.isArray(prevSnapshot.providers)) {
        for (const p of prevSnapshot.providers) prevByProvider[p.provider] = p;
    }

    // #4283 — helper de cuota real (inyectable para tests) + primario a excluir
    // del gateo por cuota (decisión #3 del PO).
    const assessQuota = quotaAssessImpl
        || (providerHealth && typeof providerHealth.assessProviderQuota === 'function'
            ? providerHealth.assessProviderQuota
            : null);
    const primary = defaultProvider || readDefaultProvider();
    const nowMs = Number.isFinite(now) ? now : Date.now();

    const results = [];
    for (const spec of providers) {
        const keyInfo = secretsRw.listKeys({ secretsPath, fsImpl }).find(k => k.provider === spec.provider);
        const prev = prevByProvider[spec.provider] || {};
        // #5888 — ¿este provider está en alcance del cruce de catálogo, y toca?
        const inCatalogScope = CATALOG_CHECK_PROVIDERS.includes(spec.provider);
        const expectModels = (checkCatalog && inCatalogScope && expectModelsByProvider
            && Array.isArray(expectModelsByProvider.get(spec.provider)))
            ? expectModelsByProvider.get(spec.provider)
            : [];
        let pingResult = null;
        // #3802 — Providers CLI-OAuth (Claude Code / Codex): validar la CLI, no
        // la API key. Pinear la key da falso rojo porque el pipeline NO la usa.
        if (spec.auth_mode === 'oauth') {
            pingResult = probeCliProvider(spec, { fsImpl, cliProbe });
        } else if (keyInfo && keyInfo.status === 'present') {
            const _ping = pingImpl || livePing.ping;
            try {
                pingResult = await _ping({
                    provider: spec.provider,
                    secretsPath,
                    fsImpl,
                    httpImpl,
                    // #5888 — `expectModels` sólo para providers EN ALCANCE y sólo
                    // cuando venció el TTL de 6h. Sin él, `ping()` se comporta
                    // exactamente como en HEAD (no baja catálogo — R-J).
                    expectModels: expectModels.length > 0 ? expectModels : undefined,
                });
            } catch (e) {
                pingResult = { ok: false, reason: 'network_error', provider: spec.provider };
            }
        } else {
            pingResult = {
                ok: false,
                reason: keyInfo ? `no_key_configured` : 'unknown_provider',
                provider: spec.provider,
                skipped: true,
            };
        }

        let state = pingResult.skipped ? 'red' : classifyState(pingResult, prev);
        let reasonCode = healthAlerts.sanitizeReasonCode(pingResult.reason);
        const rate24 = updateRateLimitCounter(pingResult, prev);

        // #4283 — tercer insumo: cuota REAL (#4202). Si el adapter mide cuota
        // crítica (≥90%) con señal fresca y durable, el provider está logueado
        // pero SIN cuota usable → red + reason 'quota_exhausted_real' para que
        // el router lo descarte de la cascada de fallback (CA-1/CA-3). El
        // primario NUNCA se flipea por esta razón (decisión #3): el router no lo
        // gatea y se mostraría como falso CAÍDO. Fail-open ante adapter
        // degradado: `gated` es false → no se toca el estado login-based (CA-2).
        let quota = null;
        if (assessQuota) {
            try {
                const qa = assessQuota(spec.provider, { now: nowMs });
                quota = { adapterStatus: qa.adapterStatus, status: qa.status, pct: qa.pct };
                const normalized = DEFAULT_PROVIDER_ALIAS[spec.provider] || spec.provider;
                const isPrimary = normalized === primary || spec.provider === primary;
                if (qa.gated && !isPrimary) {
                    state = 'red';
                    reasonCode = healthAlerts.sanitizeReasonCode(qa.reason_code);
                }
            } catch { /* fail-open: mantenemos el estado login-based */ }
        }

        // #5888 R-E — CARRY-OVER obligatorio. El health-ping corre cada 5 min y
        // el cruce de catálogo cada 6h: sin esto, los ~71 ticks intermedios
        // resetearían la celda del panel a "nunca verificada" y el operador
        // dejaría de creerle. `catalog_check` se OMITE del snapshot para los
        // providers fuera de alcance (no existe el campo, no es "never").
        let catalogCheck;
        if (expectModels.length > 0) {
            catalogCheck = buildCatalogCheck(pingResult && pingResult.catalog_check, new Date(nowMs).toISOString());
        } else if (inCatalogScope) {
            const carried = (prev.catalog_check && typeof prev.catalog_check === 'object')
                ? prev.catalog_check : null;
            catalogCheck = carried || { state: 'never', checked_at: null, reason_code: null, models: [] };
        } else {
            catalogCheck = null;
        }

        results.push({
            provider: spec.provider,
            label: spec.label,
            state,
            // NUNCA persistir/exponer fingerprint, masked, raw key, body excerpt.
            reason_code: reasonCode,
            // #4283 — discriminante de cuota para el dashboard (CA-5). Solo
            // { adapterStatus, status, pct } — sin keys/tokens/payload (req#1).
            quota,
            status_code: typeof pingResult.statusCode === 'number' ? pingResult.statusCode : null,
            latency_ms: typeof pingResult.latency_ms === 'number' ? pingResult.latency_ms : null,
            rate_limit_hit_24h: rate24,
            last_checked_at: new Date(Date.now()).toISOString(),
            key_status: spec.auth_mode === 'oauth'
                ? 'not_applicable'
                : (keyInfo ? keyInfo.status : 'absent'),
            free_tier_notes: spec.free_tier_notes || null,
            // #3802 — el frontend usa esto para mostrar "CLI/OAuth" en vez de
            // sugerir que falta una API key cuando el provider corre por CLI.
            auth_mode: spec.auth_mode === 'oauth' ? 'oauth' : 'api_key',
            // #5888 CA-5/R-C — EJE SEPARADO. `state` y `reason_code` de arriba
            // son la salud del PROVIDER y no los toca nadie desde acá: un modelo
            // muerto no pone rojo a NVIDIA, que sigue sirviendo su catálogo.
            ...(catalogCheck ? { catalog_check: catalogCheck } : {}),
        });
    }
    return results;
}

function buildSnapshot({ providers, now = Date.now() } = {}) {
    return {
        ts: new Date(now).toISOString(),
        providers,
        green_count: providers.filter(p => p.state === 'green').length,
        yellow_count: providers.filter(p => p.state === 'yellow').length,
        red_count: providers.filter(p => p.state === 'red').length,
    };
}

function emitAlerts({ snapshot, prevSnapshot, telegramSender, dedupFile, fsImpl = fs, now = Date.now() } = {}) {
    const sent = [];
    const prevByProvider = {};
    if (prevSnapshot && Array.isArray(prevSnapshot.providers)) {
        for (const p of prevSnapshot.providers) prevByProvider[p.provider] = p;
    }

    for (const p of snapshot.providers) {
        const prev = prevByProvider[p.provider] || {};
        const transitioned = prev.state !== p.state;

        // Trigger 1: transición a `red`.
        if (p.state === 'red') {
            const decision = healthAlerts.decide({
                provider: p.provider,
                state: 'red',
                reasonCode: p.reason_code,
                now,
                dedupFile,
                fsImpl,
            });
            if (decision.shouldEmit) {
                const okSend = telegramSender ? !!telegramSender(decision.payload) : true;
                healthAlerts.record({
                    provider: p.provider,
                    state: 'red',
                    sent: okSend,
                    now,
                    dedupFile,
                    fsImpl,
                });
                if (okSend) sent.push({ kind: 'red', provider: p.provider, payload: decision.payload });
            }
        }

        // Trigger 3: API key inválida.
        if (p.reason_code === 'invalid_credentials' && transitioned) {
            const decision = healthAlerts.decide({
                provider: p.provider,
                state: 'red',
                reasonCode: 'invalid_credentials',
                now,
                dedupFile,
                fsImpl,
            });
            if (decision.shouldEmit) {
                const okSend = telegramSender ? !!telegramSender(decision.payload) : true;
                healthAlerts.record({
                    provider: p.provider,
                    state: 'red',
                    sent: okSend,
                    now,
                    dedupFile,
                    fsImpl,
                });
                if (okSend) sent.push({ kind: 'invalid_key', provider: p.provider, payload: decision.payload });
            }
        }

        // #5888 Trigger 4: modelo configurado fuera del catálogo del provider.
        //
        // SÓLO `model_not_in_catalog`. `model_check_unavailable` NO emite a
        // Telegram (D-3/UX-5/CA-17): es ausencia de señal, no un evento —
        // alertar por él entrenaría al operador a ignorar el canal, que es
        // exactamente cómo mueren las barreras. Su lugar es el panel.
        const cc = p.catalog_check;
        if (cc && cc.state === 'not_in_catalog') {
            const dead = (Array.isArray(cc.models) ? cc.models : []).filter(m => m && m.alive === false);
            for (const m of dead) {
                const decision = healthAlerts.decideModelEvent({
                    provider: p.provider,
                    modelId: m.model_id,
                    providerState: p.state,
                    now,
                    dedupFile,
                    fsImpl,
                });
                if (!decision.shouldEmit) continue;
                const okSend = telegramSender ? !!telegramSender(decision.payload) : true;
                healthAlerts.recordModelEvent({
                    provider: p.provider,
                    modelId: m.model_id,
                    sent: okSend,
                    now,
                    dedupFile,
                    fsImpl,
                });
                if (okSend) sent.push({ kind: 'model_not_in_catalog', provider: p.provider, payload: decision.payload });
            }
        }
    }

    // Trigger 2: multi-down (3+ free providers en rojo).
    const multi = healthAlerts.decideMultiDown({ snapshot, now, dedupFile, fsImpl });
    if (multi.shouldEmit) {
        const okSend = telegramSender ? !!telegramSender(multi.payload) : true;
        healthAlerts.recordMultiDown({ sent: okSend, now, dedupFile, fsImpl });
        if (okSend) sent.push({ kind: 'multi_down', payload: multi.payload });
    }

    return sent;
}

// -----------------------------------------------------------------------------
// Default Telegram sender (queue-based, fire-and-forget)
//
// Sigue el patrón de `permission-override-telegram.js`: escribe un JSON en
// `servicios/telegram/pendiente/` y devuelve true. El worker de telegram
// (separate process) drena la cola y postea. Si no hay worker, los mensajes
// quedan archivados en la cola hasta que alguien los procese.
//
// SR-4 / SR-5: el payload viene ya sanitizado por `health-alerts.decide()`
// (metadata-only + redact). Acá solo lo formateamos a texto amigable.
// -----------------------------------------------------------------------------

function formatAlertText(payload) {
    if (!payload || typeof payload !== 'object') return '🩺 multi-provider health: alerta';
    if (payload.event === 'multi_down') {
        const provs = Array.isArray(payload.providers_red) ? payload.providers_red.join(', ') : '?';
        return `🩺 *Multi-Down* — ${payload.red_count} free providers en rojo: \`${provs}\`. Pipeline opera con red de respaldo reducida.\nObservado: ${payload.observed_at}`;
    }
    // #5888 UX-5/CA-17 — Rama propia del eje de MODELO, ANTES de la genérica.
    //
    // La genérica elige el emoji por el estado del PROVIDER: con provider sano +
    // modelo muerto saldría `🩺 … 🟢 nvidia-nim → GREEN`, y en un canal que el
    // operador escanea por emoji 🟢 significa "ignorar". La única alerta que
    // produce esta barrera llegaría camuflada de buena noticia.
    //
    // Acá la severidad la fija el eje-modelo (⚠️ en la cabecera). El estado del
    // provider se conserva pero SUBORDINADO, dentro de la frase que aclara que
    // sigue sano — así el mensaje no miente en ninguna dirección (cond. 4). Y
    // nombra la CONSECUENCIA, no sólo el hecho: el operador no tiene por qué
    // deducir que un fallback roto no se nota hasta que cae el primario.
    if (payload.event === 'model_not_in_catalog') {
        const emoji = payload.provider_state === 'red' ? '🔴'
            : payload.provider_state === 'yellow' ? '🟡' : '🟢';
        const est = payload.provider_state === 'red' ? 'CAÍDO'
            : payload.provider_state === 'yellow' ? 'DEGRADADO' : 'SANO';
        if (!payload.model_id) {
            // S-A fail-closed: `sanitizeModelId` devolvió `null`. La alerta se
            // emite IGUAL — nunca el id crudo, nunca el silencio.
            return `⚠️ *Modelo fuera de catálogo* — \`${payload.provider}\` sigue ${emoji} ${est}, pero uno de sus `
                 + `modelos configurados ya no aparece en su catálogo (identificador no representable).\n`
                 + `Revisar el panel de providers.\nObservado: ${payload.observed_at}`;
        }
        return `⚠️ *Modelo fuera de catálogo* — \`${payload.provider}\` sigue ${emoji} ${est}, pero `
             + `\`${payload.model_id}\` ya no aparece en su catálogo. Los agentes que lo tengan configurado `
             + `—como primario o como fallback— van a fallar al despachar.\nObservado: ${payload.observed_at}`;
    }
    const stateEmoji = payload.state === 'red' ? '🔴' : payload.state === 'yellow' ? '🟡' : '🟢';
    const reason = payload.reason_code || 'unknown';
    // #4402 CA-4 — nombrar provider + status del enum cerrado + conteo de
    // fallos consecutivos (ej. "Anthropic: auth-error x3"). El `reason` ya viene
    // sanitizado (enum cerrado, RS-5.3): PROHIBIDO renderizar body crudo de 401/403.
    const count = (typeof payload.consecutive_count === 'number' && payload.consecutive_count > 0)
        ? ` x${payload.consecutive_count}`
        : '';
    return `🩺 *Multi-Provider Health* — ${stateEmoji} \`${payload.provider}\` → \`${payload.state.toUpperCase()}\` (\`${reason}\`${count}).\nObservado: ${payload.observed_at}`;
}

function defaultTelegramSender(payload, { pipelineDir, fsImpl = fs } = {}) {
    try {
        const root = pipelineDir || path.resolve(__dirname, '..', '..');
        const svcDir = path.join(root, 'servicios', 'telegram', 'pendiente');
        if (!fsImpl.existsSync(svcDir)) fsImpl.mkdirSync(svcDir, { recursive: true });
        const filename = `${Date.now()}-mp-health.json`;
        // El payload ya pasó por redact en health-alerts, pero re-aplicamos
        // por defense in depth (SR-4): si el formateador introduce campos
        // nuevos, se redactan antes de salir.
        const safePayload = redact.redactValue(payload);
        const msg = { text: formatAlertText(safePayload), parse_mode: 'Markdown' };
        fsImpl.writeFileSync(path.join(svcDir, filename), JSON.stringify(msg), 'utf8');
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// Punto de entrada — runOnce y tickIfDue
// -----------------------------------------------------------------------------

async function runOnce(opts = {}) {
    const stateDir = opts.stateDir || defaultStateDir();
    const auditDir = opts.auditDir || defaultAuditDir();
    const fsImpl = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const snapshotFile = path.join(stateDir, SNAPSHOT_FILENAME);
    const stateFile = path.join(stateDir, STATE_FILENAME);
    const auditFile = path.join(auditDir, AUDIT_FILENAME);

    const providers = listManagedAndPingable();
    const prevSnapshot = readJson(snapshotFile, fsImpl);

    // #5888 — El cruce de catálogo corre SÓLO cuando el llamador lo pide
    // (`tickIfDue` lo hace cuando venció el TTL de 6h). Default `false`: los
    // consumidores existentes de `runOnce` (CLI, tests, api.js) no cambian de
    // comportamiento ni bajan catálogo.
    const checkCatalog = opts.checkCatalog === true;
    let expectModelsByProvider = null;
    if (checkCatalog) {
        const cfg = opts.agentModelsConfig || readAgentModelsConfig();
        expectModelsByProvider = expectModelsForPing(cfg);
    }

    const providerResults = await pingAllProviders({
        providers,
        prevSnapshot,
        secretsPath: opts.secretsPath,
        fsImpl,
        httpImpl: opts.httpImpl,
        pingImpl: opts.pingImpl,
        cliProbe: opts.cliProbe,
        quotaAssessImpl: opts.quotaAssessImpl,
        defaultProvider: opts.defaultProvider,
        now,
        checkCatalog,
        expectModelsByProvider,
    });
    const snapshot = buildSnapshot({ providers: providerResults, now });

    // Persistir snapshot (state/) — no audit log todavía.
    writeJsonAtomic(snapshotFile, snapshot, fsImpl);

    // Emitir alertas (con dedupe + back-off). Si no inyectan sender, usar
    // el default que encola en `servicios/telegram/pendiente/`.
    const sender = opts.telegramSender || ((payload) => defaultTelegramSender(payload, { fsImpl }));
    const alerts = emitAlerts({
        snapshot,
        prevSnapshot,
        telegramSender: sender,
        dedupFile: opts.dedupFile,
        fsImpl,
        now,
    });

    // Audit log — entries por provider con cambio de estado, y entry resumen.
    if (!opts.skipAudit) {
        const prevByProvider = {};
        if (prevSnapshot && Array.isArray(prevSnapshot.providers)) {
            for (const p of prevSnapshot.providers) prevByProvider[p.provider] = p;
        }
        for (const p of snapshot.providers) {
            const prev = prevByProvider[p.provider];
            if (!prev || prev.state !== p.state) {
                try {
                    auditLog.appendChained({
                        file: auditFile,
                        entry: {
                            type: 'health_state_transition',
                            provider: p.provider,
                            from_state: prev ? prev.state : null,
                            to_state: p.state,
                            reason_code: p.reason_code,
                            status_code: p.status_code,
                            latency_ms: p.latency_ms,
                        },
                        fsImpl,
                    });
                } catch { /* audit es best-effort, no bloquea cron */ }
            }
        }
        // Si hubo alertas, persistirlas también.
        for (const a of alerts) {
            try {
                auditLog.appendChained({
                    file: auditFile,
                    entry: {
                        type: 'health_alert_emitted',
                        kind: a.kind,
                        provider: a.provider || null,
                        payload: a.payload,
                    },
                    fsImpl,
                });
            } catch { /* best-effort */ }
        }
    }

    // Actualizar state interno (last_tick_at, last_weekly_check_at).
    const prevState = readJson(stateFile, fsImpl) || {};
    const newState = {
        ...prevState,
        last_tick_at: now,
    };
    if (opts.markWeekly) newState.last_weekly_check_at = now;
    // #5888 CA-10 — TTL propio del cruce de catálogo (espeja `markWeekly`).
    if (opts.markCatalogCheck) newState.last_catalog_check_at = now;
    writeJsonAtomic(stateFile, newState, fsImpl);

    return { snapshot, alerts, providers_pinged: providerResults.length };
}

/**
 * Entry point idempotente. Llamarlo cada minuto desde el pulpo o desde el
 * dashboard — si toca correr, corre con lock; si no, no hace nada.
 */
async function tickIfDue(opts = {}) {
    const stateDir = opts.stateDir || defaultStateDir();
    const fsImpl = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const stateFile = path.join(stateDir, STATE_FILENAME);
    const lockFile = path.join(stateDir, LOCK_FILENAME);

    // #4402 CA-3 — resolver la cadencia (config.yaml → default 5 min). La
    // resolución vive acá; `pulpo.js` sigue llamando `tickIfDue({})` sin cambios.
    // #5172 — sin `fsImpl`: el config lo resuelve el punto único.
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : readTickIntervalMs();

    if (!isTickDue({ stateFile, now, fsImpl, jitter: opts.jitter !== undefined ? opts.jitter : jitterMs(), intervalMs })) {
        return { skipped: true, reason: 'not_due' };
    }
    if (!tryAcquireLock({ lockFile, now, fsImpl })) {
        return { skipped: true, reason: 'locked_by_other_process' };
    }
    try {
        const markWeekly = isWeeklyDue({ stateFile, now, fsImpl });
        // #5888 CA-10 — El health-ping sigue en 5 min sin tocar; el cruce de
        // catálogo tiene su propio TTL (6h). Se pasa como `checkCatalog` (¿bajo
        // el catálogo en esta corrida?) Y como `markCatalogCheck` (¿reseteo el
        // TTL?): si sólo se marcara, el próximo tick creería que ya verificó.
        const checkCatalog = opts.checkCatalog !== undefined
            ? opts.checkCatalog
            : isCatalogCheckDue({ stateFile, now, fsImpl, ttlMs: opts.catalogTtlMs });
        return await runOnce({ ...opts, now, markWeekly, stateDir, checkCatalog, markCatalogCheck: checkCatalog });
    } finally {
        releaseLock({ lockFile, fsImpl });
    }
}

module.exports = {
    TICK_INTERVAL_MS,
    DEFAULT_INTERVAL_MINUTES,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    HARD_FLOOR_MS,
    readTickIntervalMs,
    // #5172 — `defaultConfigPath` se eliminó junto con `PIPELINE_CONFIG_PATH`:
    // este módulo ya no decide QUÉ archivo es la config (lo hace el resolver).
    JITTER_RANGE_MS,
    WEEKLY_CHECK_INTERVAL_MS,
    LOCK_STALE_MS,
    SNAPSHOT_FILENAME,
    STATE_FILENAME,
    LOCK_FILENAME,
    AUDIT_FILENAME,
    runOnce,
    tickIfDue,
    isTickDue,
    isWeeklyDue,
    // #5888 — eje de vigencia de modelo (cadencia propia + cruce de config).
    CATALOG_CHECK_DEFAULT_HOURS,
    CATALOG_CHECK_MIN_HOURS,
    CATALOG_CHECK_MAX_HOURS,
    CATALOG_CHECK_PROVIDERS,
    PING_TO_CONFIG_PROVIDER,
    readCatalogTtlMs,
    isCatalogCheckDue,
    configuredModelsByProvider,
    expectModelsForPing,
    buildCatalogCheck,
    listManagedAndPingable,
    classifyState,
    updateRateLimitCounter,
    pingAllProviders,
    isBinaryOnPath,
    probeCliProvider,
    buildSnapshot,
    emitAlerts,
    tryAcquireLock,
    releaseLock,
    jitterMs,
    defaultStateDir,
    defaultAuditDir,
    formatAlertText,
    defaultTelegramSender,
};

// CLI: si se invoca directo, corre un tickIfDue y exit.
if (require.main === module) {
    (async () => {
        try {
            const result = await tickIfDue();
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[health-cron] error:', e.message);
            process.exit(1);
        }
    })();
}

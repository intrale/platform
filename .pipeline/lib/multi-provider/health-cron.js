// =============================================================================
// health-cron.js — Cron de healthchecks por provider (#3260 CA-1 / CA-2).
//
// Responsabilidades:
//   - Cada ~15min (con jitter aleatorio ±60s, SR-3), pingear el endpoint
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
const TICK_INTERVAL_MS = 15 * 60 * 1000;            // 15min base
const JITTER_RANGE_MS = 60 * 1000;                  // ±60s alrededor del slot
const WEEKLY_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;                // si el lock tiene >5min, lo robamos
const SNAPSHOT_FILENAME = 'multi-provider-health.json';
const STATE_FILENAME = 'multi-provider-health-state.json'; // tracking interno: last_tick, last_weekly_check
const LOCK_FILENAME = 'multi-provider-health.lock';
const AUDIT_FILENAME = 'multi-provider-health.jsonl';

function jitterMs(rangeMs = JITTER_RANGE_MS, rng = Math.random) {
    return Math.floor((rng() * 2 - 1) * rangeMs);
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

/**
 * Resuelve si un binario es invocable buscándolo en el PATH. Windows-aware
 * (respeta PATHEXT). No spawnea nada — sólo `fs.existsSync` sobre los candidatos.
 *
 * @returns {boolean}
 */
function isBinaryOnPath(binary, { env = process.env, fsImpl = fs } = {}) {
    if (!binary || typeof binary !== 'string') return false;
    const pathVar = env.PATH || env.Path || '';
    const dirs = pathVar.split(path.delimiter).filter(Boolean);
    const isWin = process.platform === 'win32';
    const exts = isWin
        ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
        : [''];
    for (const dir of dirs) {
        // Binario tal cual (sirve para *nix y para .exe ya con extensión en Win).
        const direct = path.join(dir, binary);
        try { if (fsImpl.existsSync(direct)) return true; } catch { /* ignore */ }
        if (isWin) {
            for (const ext of exts) {
                try { if (fsImpl.existsSync(direct + ext)) return true; } catch { /* ignore */ }
            }
        }
    }
    return false;
}

/**
 * Probe de salud para un provider CLI-OAuth. Devuelve un objeto con la misma
 * forma que `live-ping.ping` (`{ ok, reason, ... }`) para que `classifyState`
 * lo trate igual.
 */
function probeCliProvider(spec, { env = process.env, fsImpl = fs, cliProbe } = {}) {
    const binary = spec.cli_binary || null;
    if (!binary) {
        return { ok: false, reason: 'cli_binary_undeclared', provider: spec.provider, cli_oauth: true };
    }
    const available = typeof cliProbe === 'function'
        ? !!cliProbe(binary)
        : isBinaryOnPath(binary, { env, fsImpl });
    return available
        ? { ok: true, reason: 'cli_oauth_ok', provider: spec.provider, cli_oauth: true }
        : { ok: false, reason: 'cli_unavailable', provider: spec.provider, cli_oauth: true };
}

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
 * - Si `elapsed >= TICK_INTERVAL_MS + jitter`, debido.
 * - El jitter se aplica restando del intervalo (los procesos elegibles más
 *   "temprano" tienden a ganar el lock antes que los "tardíos", suavizando
 *   el thundering herd).
 */
function isTickDue({ stateFile, now = Date.now(), fsImpl = fs, jitter = jitterMs() } = {}) {
    const st = readJson(stateFile, fsImpl);
    if (!st || typeof st.last_tick_at !== 'number') return true;
    const elapsed = now - st.last_tick_at;
    return elapsed >= (TICK_INTERVAL_MS + jitter);
}

function isWeeklyDue({ stateFile, now = Date.now(), fsImpl = fs } = {}) {
    const st = readJson(stateFile, fsImpl);
    if (!st || typeof st.last_weekly_check_at !== 'number') return true;
    return (now - st.last_weekly_check_at) >= WEEKLY_CHECK_INTERVAL_MS;
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

async function pingAllProviders({ providers, prevSnapshot, secretsPath, fsImpl = fs, httpImpl, pingImpl, cliProbe, quotaAssessImpl, defaultProvider, now } = {}) {
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
            key_status: keyInfo ? keyInfo.status : 'absent',
            free_tier_notes: spec.free_tier_notes || null,
            // #3802 — el frontend usa esto para mostrar "CLI/OAuth" en vez de
            // sugerir que falta una API key cuando el provider corre por CLI.
            auth_mode: spec.auth_mode === 'oauth' ? 'oauth' : 'api_key',
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
    const stateEmoji = payload.state === 'red' ? '🔴' : payload.state === 'yellow' ? '🟡' : '🟢';
    const reason = payload.reason_code || 'unknown';
    return `🩺 *Multi-Provider Health* — ${stateEmoji} \`${payload.provider}\` → \`${payload.state.toUpperCase()}\` (\`${reason}\`).\nObservado: ${payload.observed_at}`;
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
    const providerResults = await pingAllProviders({
        providers,
        prevSnapshot,
        secretsPath: opts.secretsPath,
        fsImpl,
        httpImpl: opts.httpImpl,
        pingImpl: opts.pingImpl,
        cliProbe: opts.cliProbe,
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

    if (!isTickDue({ stateFile, now, fsImpl, jitter: opts.jitter !== undefined ? opts.jitter : jitterMs() })) {
        return { skipped: true, reason: 'not_due' };
    }
    if (!tryAcquireLock({ lockFile, now, fsImpl })) {
        return { skipped: true, reason: 'locked_by_other_process' };
    }
    try {
        const markWeekly = isWeeklyDue({ stateFile, now, fsImpl });
        return await runOnce({ ...opts, now, markWeekly, stateDir });
    } finally {
        releaseLock({ lockFile, fsImpl });
    }
}

module.exports = {
    TICK_INTERVAL_MS,
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

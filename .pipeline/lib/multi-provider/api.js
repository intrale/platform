// =============================================================================
// api.js — Handlers HTTP del panel Multi-Provider del dashboard (#3177).
//
// Mount points (registrados desde dashboard.js):
//   GET    /api/multi-provider/csrf-token        emite token + cookie
//   GET    /api/multi-provider/config            config actual (masked)
//   POST   /api/multi-provider/config/diff       preview diff sin escribir
//   PUT    /api/multi-provider/config            write atómico + backup
//   GET    /api/multi-provider/keys              listado masked
//   POST   /api/multi-provider/keys/:provider    rotación de key
//   POST   /api/multi-provider/ping/:provider    live ping (no devuelve key)
//   GET    /api/multi-provider/catalog           catálogo de modelos
//   GET    /api/multi-provider/skills            registry skills + capabilities
//   GET    /api/multi-provider/overrides         listado overrides (vigentes+historial)
//   POST   /api/multi-provider/overrides         crear override
//   POST   /api/multi-provider/overrides/revoke  revocar override
//   POST   /api/multi-provider/reload            "reload pipeline" (encola signal)
//
// Reglas universales:
//   - GET nunca expone keys raw (solo masking + fingerprint).
//   - PUT/POST exigen CSRF (csrf.requireCSRF).
//   - Autor de cualquier mutación se deriva server-side de `git config user.email`
//     (NO se lee del body). Si no se puede determinar → 403.
//   - Schema/cross validation se delegan a agent-models-validate.
//   - Validaciones de overrides (TTL ≤ 168h, justificación ≥ 30 chars,
//     NON_DEGRADABLE) se aplican server-side incluso si la UI las replica.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const csrf = require('./csrf');
const rw = require('./agent-models-rw');
const secrets = require('./secrets-rw');
const livePing = require('./live-ping');
const catalog = require('./model-catalog');
const validator = require('../agent-models-validate');
const permValidator = require('../permission-validator');
const auditLog = require('../audit-log');

// #3811 — kill-switch operacional por provider (misma fuente de verdad que la
// CLI manage-providers.sh y que dispatch-with-fallback).
const providerDisabled = require('../provider-disabled');

// #3871 — horarios de actividad por provider (misma fuente de verdad que
// dispatch-with-fallback). El endpoint reusa VALID_PROVIDERS/isValidProvider de
// provider-disabled (allowlist única, anti path-traversal en :name).
const providerSchedule = require('../provider-schedule');

// Health snapshot (#3260) — endpoint read-only que el panel "Health" consume.
// El cron de healthcheck es disparado por el pulpo (o el dashboard, si está
// solo activo) cada ~15min; este módulo SOLO lee el snapshot persistido. No
// dispara pings sintéticos al abrir el panel (SR-3 / CA-3).
let healthCron = null;
try { healthCron = require('./health-cron'); } catch { /* opcional */ }

let skillsMetadata = null;
try { skillsMetadata = require('../skills-metadata'); } catch { /* opcional */ }

let telegramHelper = null;
try { telegramHelper = require('../permission-override-telegram'); } catch { /* opcional */ }

const PIPELINE_ROOT = process.env.PIPELINE_STATE_DIR
    || path.resolve(__dirname, '..', '..');
const RELOAD_SIGNAL_PATH = path.join(PIPELINE_ROOT, '.agent-models-reload-requested');

function resolveAuthor({ envOverride } = {}) {
    if (envOverride && typeof envOverride === 'string' && envOverride.trim()) return envOverride.trim();
    try {
        const out = execSync('git config user.email', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const v = out.trim();
        if (v) return v;
    } catch { /* fall through */ }
    if (process.env.USER) return process.env.USER;
    if (process.env.USERNAME) return process.env.USERNAME;
    return null;
}

function readBody(req, { maxBytes = 256 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        req.on('data', c => {
            total += c.length;
            if (total > maxBytes) {
                req.destroy();
                reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw.length ? JSON.parse(raw) : {});
            } catch (e) {
                reject(Object.assign(new Error('invalid JSON: ' + e.message), { code: 'BAD_JSON' }));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendError(res, status, code, message, extra) {
    sendJson(res, { ok: false, code, message, ...(extra || {}) }, status);
}

async function handleCsrfToken(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    csrf.issueTokenResponse(req, res);
}

async function handleConfigGet(req, res) {
    try {
        const config = rw.readConfig();
        const keyMeta = secrets.listKeys();
        sendJson(res, { ok: true, config, keys: keyMeta });
    } catch (e) {
        sendError(res, 500, 'read_failed', e.message);
    }
}

async function handleConfigDiff(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }
    if (!body.config || typeof body.config !== 'object') {
        return sendError(res, 400, 'invalid_payload', '"config" requerido en el body.');
    }
    let current;
    try { current = rw.readConfig(); }
    catch (e) { return sendError(res, 500, 'read_failed', e.message); }
    const diff = rw.computeDiff(current, body.config);
    sendJson(res, { ok: true, diff, summary: rw.summarizeDiff(diff) });
}

async function handleConfigPut(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'no_author', 'No pude resolver autor (git config user.email). Configurá la identidad antes de mutar.');
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }
    if (!body.config || typeof body.config !== 'object') {
        return sendError(res, 400, 'invalid_payload', '"config" requerido en el body.');
    }
    try {
        const result = rw.writeConfig({ newConfig: body.config });
        sendJson(res, { ok: true, backupPath: result.backupPath, author });
    } catch (e) {
        if (e.errors) {
            return sendError(res, 422, 'validation_failed', e.message, { errors: e.errors });
        }
        if (e.code === 'ELOCKED') {
            return sendError(res, 409, 'locked', e.message, { holder: e.holder });
        }
        sendError(res, 500, 'write_failed', e.message);
    }
}

async function handleKeysGet(req, res) {
    sendJson(res, { ok: true, keys: secrets.listKeys() });
}

async function handleKeysPost(req, res, { provider }) {
    if (!csrf.requireCSRF(req, res)) return;
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'no_author', 'No pude resolver autor (git config user.email).');
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }
    if (!body.newValue || typeof body.newValue !== 'string') {
        return sendError(res, 400, 'invalid_payload', '"newValue" requerido en el body.');
    }
    try {
        const result = secrets.rotateKey({ provider, newValue: body.newValue });
        try {
            const file = path.join(PIPELINE_ROOT, 'audit', 'api-key-rotations.jsonl');
            auditLog.appendChained({ file, entry: {
                type: 'api_key_rotation',
                provider: result.provider,
                jsonField: result.jsonField,
                fingerprint: result.fingerprint,
                autor: author,
            }});
        } catch (e) { /* audit best-effort */ }
        sendJson(res, {
            ok: true,
            provider: result.provider,
            jsonField: result.jsonField,
            fingerprint: result.fingerprint,
            backupPath: result.backupPath,
            author,
        });
    } catch (e) {
        sendError(res, 422, 'rotate_failed', e.message);
    }
}

async function handlePing(req, res, { provider }) {
    if (!csrf.requireCSRF(req, res)) return;
    try {
        const result = await livePing.ping({ provider });
        sendJson(res, result);
    } catch (e) {
        sendError(res, 500, 'ping_failed', e.message);
    }
}

async function handleCatalog(req, res, _params, query) {
    const provider = query && query.get('provider');
    sendJson(res, { ok: true, ...catalog.listModels({ provider }) });
}

async function handleSkillsGet(req, res) {
    let registry = {};
    let failures = [];
    if (skillsMetadata) {
        try {
            const loaded = skillsMetadata.loadAllSkillsMetadata();
            registry = loaded.registry || {};
            failures = loaded.failures || [];
        } catch (e) {
            try {
                const cfg = rw.readConfig();
                registry = Object.fromEntries(Object.keys(cfg.skills || {}).map(s => [s, { required_permissions: [] }]));
            } catch {}
        }
    } else {
        try {
            const cfg = rw.readConfig();
            registry = Object.fromEntries(Object.keys(cfg.skills || {}).map(s => [s, { required_permissions: [] }]));
        } catch {}
    }
    const nonDegradable = Array.from(permValidator.NON_DEGRADABLE_SKILLS);
    const out = {};
    for (const [skill, meta] of Object.entries(registry)) {
        out[skill] = {
            required_permissions: meta.required_permissions || [],
            non_degradable: nonDegradable.includes(skill),
            missing_metadata: meta.__missing_permissions === true,
        };
    }
    sendJson(res, { ok: true, skills: out, failures, non_degradable: nonDegradable });
}

async function handleOverridesGet(req, res) {
    try {
        const all = auditLog.readAll(permValidator.DEFAULT_OVERRIDES_PATH);
        const now = Date.now();
        const revokedHashes = new Set();
        for (const e of all) {
            if (e.type === 'permission_override_revocation' && typeof e.target_hash === 'string') {
                revokedHashes.add(e.target_hash);
            }
        }
        const active = [];
        const history = [];
        for (const e of all) {
            if (e.type !== 'permission_override') continue;
            const ttlMs = (Number(e.ttl_horas) || 0) * 3600 * 1000;
            const expiresAt = (Number(e.created_at) || 0) + ttlMs;
            const isRevoked = revokedHashes.has(e.hash_self);
            const isExpired = expiresAt <= now;
            const entry = {
                hash_self: e.hash_self,
                skill: e.skill,
                provider: e.provider,
                mode_requerido: e.mode_requerido,
                mode_otorgado: e.mode_otorgado,
                capabilities_diff: e.capabilities_diff,
                justificacion: e.justificacion,
                autor: e.autor,
                ttl_horas: e.ttl_horas,
                created_at: e.created_at,
                expires_at: expiresAt,
            };
            if (!isRevoked && !isExpired) {
                active.push(entry);
            } else {
                history.push({ ...entry, end_reason: isRevoked ? 'revoked' : 'expired' });
            }
        }
        sendJson(res, { ok: true, active, history });
    } catch (e) {
        sendError(res, 500, 'read_failed', e.message);
    }
}

async function handleOverridesCreate(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'no_author', 'No pude resolver autor (git config user.email).');
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }

    const skill = typeof body.skill === 'string' ? body.skill.trim() : '';
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const mode_requerido = typeof body.mode_requerido === 'string' ? body.mode_requerido.trim() : null;
    const mode_otorgado = typeof body.mode_otorgado === 'string' ? body.mode_otorgado.trim() : null;
    const justificacion = typeof body.justificacion === 'string' ? body.justificacion.trim() : '';
    const ttl_horas = Number(body.ttl_horas);
    const capabilities_diff = Array.isArray(body.capabilities_diff) ? body.capabilities_diff : [];

    if (!skill || !provider) {
        return sendError(res, 400, 'invalid_payload', 'skill y provider requeridos.');
    }
    if (permValidator.NON_DEGRADABLE_SKILLS.has(skill)) {
        return sendError(res, 422, 'non_degradable', `Skill '${skill}' está marcado como NON_DEGRADABLE — no admite override (CA-12 de #3082).`);
    }
    if (!Number.isFinite(ttl_horas) || ttl_horas < 1 || ttl_horas > 168) {
        return sendError(res, 422, 'invalid_ttl', 'ttl_horas debe estar entre 1 y 168 (7d).');
    }
    if (justificacion.length < 30) {
        return sendError(res, 422, 'short_justification', 'justificacion requiere mínimo 30 chars.');
    }

    let entry;
    try {
        entry = permValidator.recordOverride({
            skill, provider, mode_requerido, mode_otorgado,
            capabilities_diff, justificacion, autor: author, ttl_horas,
        });
    } catch (e) {
        return sendError(res, 422, 'record_failed', e.message);
    }

    let telegramQueued = null;
    if (telegramHelper) {
        try { telegramQueued = telegramHelper.notifyOverrideCreated(entry); } catch {}
    }
    sendJson(res, {
        ok: true,
        hash_self: entry.hash_self,
        skill: entry.skill,
        provider: entry.provider,
        ttl_horas: entry.ttl_horas,
        expires_at: entry.created_at + entry.ttl_horas * 3600 * 1000,
        telegram_queued: telegramQueued,
        author,
    });
}

async function handleOverridesRevoke(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'no_author', 'No pude resolver autor (git config user.email).');
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }
    const targetHash = typeof body.target_hash === 'string' ? body.target_hash.trim() : '';
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
    if (!targetHash || targetHash.length < 16) {
        return sendError(res, 400, 'invalid_target_hash', 'target_hash requerido (mín 16 chars).');
    }
    if (motivo.length < 10) {
        return sendError(res, 422, 'short_motivo', 'motivo requiere mínimo 10 chars.');
    }
    let entry;
    try {
        entry = permValidator.revokeOverride({ targetHash, motivo, autor: author });
    } catch (e) {
        return sendError(res, 422, 'revoke_failed', e.message);
    }
    sendJson(res, {
        ok: true,
        revocation_hash: entry.hash_self,
        target_hash: entry.target_hash,
        author,
    });
}

/**
 * GET /api/multi-provider/health
 *
 * Devuelve el último snapshot persistido por `health-cron`. Read-only y SIN
 * CSRF (es lectura pública del estado interno del pipeline). NO dispara
 * pings sintéticos — la frescura está acotada por el intervalo del cron
 * (15min ± 60s) y por cuando el dashboard/pulpo lo ejecutó por última vez.
 *
 * El snapshot vive en `state/multi-provider-health.json` y NO se escribe en
 * directorio web-served. La API solo proyecta el JSON al cliente.
 *
 * Si el cron nunca corrió (snapshot ausente) devolvemos 200 con providers=[]
 * + `bootstrap=true` para que la UI muestre "esperando primer healthcheck"
 * sin disparar error.
 */
async function handleHealthGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    try {
        const stateDir = healthCron ? healthCron.defaultStateDir() : path.join(PIPELINE_ROOT, 'state');
        const file = path.join(stateDir, healthCron ? healthCron.SNAPSHOT_FILENAME : 'multi-provider-health.json');
        if (!fs.existsSync(file)) {
            return sendJson(res, {
                ok: true,
                bootstrap: true,
                providers: [],
                green_count: 0,
                yellow_count: 0,
                red_count: 0,
                ts: null,
                cron: {
                    tick_interval_ms: healthCron ? healthCron.TICK_INTERVAL_MS : null,
                    jitter_range_ms: healthCron ? healthCron.JITTER_RANGE_MS : null,
                },
                note: 'El healthcheck aún no corrió. Esperando primer tick del cron.',
            });
        }
        const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Reforzar shape antes de devolver al cliente: nunca exponer fingerprint
        // ni masked ni body excerpts aunque algo futuro intente meterlos.
        const safeProviders = (snapshot.providers || []).map(p => ({
            provider: p.provider,
            label: p.label,
            state: p.state,
            reason_code: p.reason_code,
            status_code: p.status_code,
            latency_ms: p.latency_ms,
            rate_limit_hit_24h: p.rate_limit_hit_24h,
            last_checked_at: p.last_checked_at,
            key_status: p.key_status,
            free_tier_notes: p.free_tier_notes || null,
        }));
        sendJson(res, {
            ok: true,
            bootstrap: false,
            ts: snapshot.ts,
            providers: safeProviders,
            green_count: snapshot.green_count || 0,
            yellow_count: snapshot.yellow_count || 0,
            red_count: snapshot.red_count || 0,
            cron: {
                tick_interval_ms: healthCron ? healthCron.TICK_INTERVAL_MS : null,
                jitter_range_ms: healthCron ? healthCron.JITTER_RANGE_MS : null,
            },
        });
    } catch (e) {
        sendError(res, 500, 'health_read_failed', e.message);
    }
}

/**
 * POST /api/multi-provider/health/run
 *
 * Fuerza una corrida del healthcheck (requiere CSRF). Útil para diagnóstico
 * manual desde el panel. NO bypassa el lock — si otro proceso está corriendo
 * el cron, devuelve `skipped: true`.
 */
async function handleHealthRun(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    if (!healthCron) {
        return sendError(res, 503, 'health_cron_unavailable', 'health-cron no está disponible en este build.');
    }
    try {
        const result = await healthCron.tickIfDue({});
        sendJson(res, { ok: true, ...result });
    } catch (e) {
        sendError(res, 500, 'health_run_failed', e.message);
    }
}

async function handleReload(req, res) {
    if (!csrf.requireCSRF(req, res)) return;
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'no_author', 'No pude resolver autor (git config user.email).');
    }
    try {
        fs.writeFileSync(RELOAD_SIGNAL_PATH, JSON.stringify({
            requested_at: new Date().toISOString(),
            author,
        }, null, 2));
        sendJson(res, {
            ok: true,
            signalPath: RELOAD_SIGNAL_PATH,
            note: 'Signal escrito. Si el pulpo no implementa hot-reload (#3188), corré `node .pipeline/restart.js` para aplicar.',
        });
    } catch (e) {
        sendError(res, 500, 'signal_failed', e.message);
    }
}

// #3258 — CA-6: distribución del Commander de Telegram por provider.
// Lee los audit logs `logs/commander-dispatch-YYYY-MM-DD.jsonl` y agrega por
// `provider_effective` para mostrar % de requests resueltos por cada provider
// en la ventana solicitada (24h, 7d, 30d).
async function handleCommanderDistribution(req, res, _params, query) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    try {
        const cmp = require('../commander/multi-provider');
        const window = String((query && query.get && query.get('window')) || '7d');
        const windowDays =
            window === '24h' || window === '1d' ? 1 :
            window === '30d' ? 30 :
            7;
        const stats = cmp.readCommanderStats({ pipelineDir: PIPELINE_ROOT, windowDays });
        sendJson(res, { ok: true, window, ...stats });
    } catch (e) {
        sendError(res, 500, 'read_failed', e.message);
    }
}

// =============================================================================
// #3811 — Kill-switch operacional por provider (perilla del dashboard).
//
// GET  /api/multi-provider/providers-disabled            estado de apagados
// POST /api/multi-provider/providers/:provider/disable   apaga (opc. ttl_ms)
// POST /api/multi-provider/providers/:provider/enable    enciende
//
// Reutiliza lib/provider-disabled.js (misma fuente de verdad que la CLI). El
// efecto es idéntico al switch por terminal: dispatch-with-fallback salta al
// siguiente eslabón de la cadena del skill cuando el provider está apagado.
// =============================================================================

async function handleProvidersDisabledGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    try {
        const list = providerDisabled.listDisabledProviders();
        const disabledSet = new Set(list.disabled.map((e) => e.name));
        // Proyectamos TODOS los providers válidos con su estado on/off para que
        // la UI pueda renderizar un toggle por provider sin asumir el catálogo.
        const providers = providerDisabled.VALID_PROVIDERS.map((name) => {
            const entry = list.disabled.find((e) => e.name === name) || null;
            return {
                name,
                disabled: disabledSet.has(name),
                disabled_at: entry ? entry.disabled_at : null,
                ttl_expires_at: entry ? entry.ttl_expires_at : null,
                ttl_remaining_ms: entry ? entry.ttl_remaining_ms : null,
            };
        });
        sendJson(res, { ok: true, providers });
    } catch (e) {
        sendError(res, 500, 'read_failed', e.message);
    }
}

async function handleProviderDisable(req, res, params) {
    if (!csrf.requireCSRF(req, res)) return;
    const provider = params && params.provider;
    if (!providerDisabled.isValidProvider(provider)) {
        return sendError(res, 400, 'invalid_provider',
            `provider inválido: "${provider}". Válidos: ${providerDisabled.VALID_PROVIDERS.join(', ')}`);
    }
    let body = {};
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }
    // ttl_ms opcional: undefined → default 20min; null → permanente; número → acotado.
    let ttlMs;
    if (Object.prototype.hasOwnProperty.call(body, 'ttl_ms')) {
        ttlMs = body.ttl_ms; // el módulo valida null / número / rechaza inválidos.
    }
    const author = resolveAuthor();
    const r = providerDisabled.setProviderDisabled(provider, {
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        source: `dashboard:${author || 'unknown'}`,
    });
    if (!r.ok) return sendError(res, 422, 'disable_failed', r.error);
    const list = providerDisabled.listDisabledProviders();
    const entry = list.disabled.find((e) => e.name === provider) || null;
    sendJson(res, {
        ok: true,
        provider,
        disabled: true,
        ttl_ms: r.ttl_ms,
        ttl_expires_at: entry ? entry.ttl_expires_at : null,
        ttl_remaining_ms: entry ? entry.ttl_remaining_ms : null,
        author,
    });
}

async function handleProviderEnable(req, res, params) {
    if (!csrf.requireCSRF(req, res)) return;
    const provider = params && params.provider;
    if (!providerDisabled.isValidProvider(provider)) {
        return sendError(res, 400, 'invalid_provider',
            `provider inválido: "${provider}". Válidos: ${providerDisabled.VALID_PROVIDERS.join(', ')}`);
    }
    const author = resolveAuthor();
    const changed = providerDisabled.clearProviderDisabled(provider, {
        source: `dashboard:${author || 'unknown'}`,
    });
    sendJson(res, { ok: true, provider, disabled: false, changed, author });
}

// =============================================================================
// #3871 — Horarios de actividad por provider.
//
// GET  /api/multi-provider/providers-schedule              estado + próxima transición
// POST /api/multi-provider/providers/:provider/schedule    set {active, schedule, timezone}
//
// Reutiliza lib/provider-schedule.js (misma fuente de verdad que dispatch). El
// gating por horario es independiente del kill-switch: un provider puede estar
// "activo por horario" pero "apagado por kill-switch" o viceversa.
// =============================================================================

async function handleProvidersScheduleGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    try {
        const schedules = providerSchedule.listProviderSchedules();
        const providers = providerSchedule.VALID_PROVIDERS.map((name) => {
            const s = schedules[name] || {};
            return {
                name,
                active: !!s.active,
                isActiveNow: s.isActiveNow !== false, // fail-open
                schedule: s.schedule || {},
                timezone: s.timezone || providerSchedule.DEFAULT_TIMEZONE,
                nextTransition: s.nextTransition || null,
                updated_at: s.updated_at || null,
            };
        });
        sendJson(res, { ok: true, providers });
    } catch (e) {
        sendError(res, 500, 'read_failed', e.message);
    }
}

async function handleProviderSchedule(req, res, params) {
    // SEC #2 — mutación protegida por CSRF.
    if (!csrf.requireCSRF(req, res)) return;
    // SEC #1 — allowlist ANTES de tocar cualquier path (anti path-traversal).
    const provider = params && params.provider;
    if (!providerSchedule.isValidProvider(provider)) {
        return sendError(res, 400, 'invalid_provider',
            `provider inválido: "${provider}". Válidos: ${providerSchedule.VALID_PROVIDERS.join(', ')}`);
    }
    let body = {};
    try { body = await readBody(req); }
    catch (e) { return sendError(res, 400, e.code || 'bad_request', e.message); }

    // SEC #3 — validación estricta del payload. `active` debe ser boolean estricto.
    if (typeof body.active !== 'boolean') {
        return sendError(res, 422, 'invalid_payload', 'campo "active" debe ser boolean');
    }
    // SEC #2 — autor derivado server-side (NO del body) → audit. Sin autor: 403.
    const author = resolveAuthor();
    if (!author) {
        return sendError(res, 403, 'author_unresolved', 'no se pudo determinar el autor (git config user.email)');
    }

    const r = providerSchedule.setProviderSchedule(provider, {
        active: body.active,
        schedule: body.schedule,
        timezone: body.timezone,
    }, { source: `dashboard:${author}` });

    if (!r.ok) {
        return sendError(res, 422, 'schedule_failed', r.error, r.errors ? { errors: r.errors } : undefined);
    }
    const resolved = providerSchedule.getProviderSchedule(provider);
    sendJson(res, {
        ok: true,
        provider,
        active: resolved.active,
        schedule: resolved.schedule,
        timezone: resolved.timezone,
        nextTransition: r.nextTransition || null,
        updated_at: resolved.updated_at,
        author,
    });
}

// =============================================================================
// EP8-H12 (#3965) — Pantalla "Salud Multi-Provider". Handlers GET de agregación
// read-only sobre datos ya persistidos. SIN CSRF (lectura pública del estado
// interno, igual que handleHealthGet). Whitelist estricta: el módulo
// health-screen ya devuelve SOLO metadatos; estos handlers nunca serializan el
// config/snapshot crudo (CA-6 / A02).
// =============================================================================
let healthScreen = null;
try { healthScreen = require('./health-screen'); } catch { /* opcional */ }

/**
 * GET /api/multi-provider/health-screen
 * Health cards por provider (p50/p95 + despachos 24h + errores por clase incl.
 * cli_1m_context_glitch) + resumen Sherlock. Solo metadatos agregados.
 */
async function handleHealthScreenGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    if (!healthScreen) {
        return sendError(res, 503, 'health_screen_unavailable', 'health-screen no está disponible en este build.');
    }
    try {
        const data = healthScreen.buildScreenPayload();
        // Whitelist: `data` ya es solo metadatos agregados (ver health-screen.js).
        // Nunca adjuntamos el config crudo ni material sensible.
        sendJson(res, { ok: true, ...data });
    } catch (e) {
        sendError(res, 500, 'health_screen_failed', e.message);
    }
}

/**
 * GET /api/multi-provider/sherlock-pct
 * % same-provider de Sherlock (ventana 24h) con meta <10% y flag de alerta.
 */
async function handleSherlockPctGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    if (!healthScreen) {
        return sendError(res, 503, 'health_screen_unavailable', 'health-screen no está disponible en este build.');
    }
    try {
        const s = healthScreen.sherlockSameProviderPct();
        sendJson(res, {
            ok: true,
            pct: s.pct,
            meta: s.meta,
            alert: s.alert,
            total: s.total,
            same: s.same,
        });
    } catch (e) {
        sendError(res, 500, 'sherlock_pct_failed', e.message);
    }
}

/**
 * GET /api/multi-provider/health-timeline
 * Timeline cronológico 24h de transiciones gate/exhaustion/recovery. Whitelist
 * explícita de campos (sin hashes de cadena). El texto se escapa en la vista.
 */
async function handleHealthTimelineGet(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only');
    if (!healthScreen) {
        return sendError(res, 503, 'health_screen_unavailable', 'health-screen no está disponible en este build.');
    }
    try {
        const events = healthScreen.timeline24h();
        // Whitelist explícita: re-proyectamos cada evento a SOLO los campos
        // permitidos, nunca el objeto crudo de audit (que trae hash_prev/self).
        const safe = (events || []).map(e => ({
            provider: e.provider,
            from_state: e.from_state,
            to_state: e.to_state,
            reason_code: e.reason_code,
            latency_ms: e.latency_ms,
            created_at: e.created_at,
        }));
        sendJson(res, { ok: true, events: safe, count: safe.length });
    } catch (e) {
        sendError(res, 500, 'health_timeline_failed', e.message);
    }
}

const ROUTES = [
    { method: 'GET',  pattern: /^\/api\/multi-provider\/csrf-token$/,            handler: handleCsrfToken },
    // #3811 — kill-switch por provider.
    { method: 'GET',  pattern: /^\/api\/multi-provider\/providers-disabled$/,    handler: handleProvidersDisabledGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/providers\/([a-z0-9-]+)\/disable$/, handler: handleProviderDisable, params: ['provider'] },
    { method: 'POST', pattern: /^\/api\/multi-provider\/providers\/([a-z0-9-]+)\/enable$/,  handler: handleProviderEnable, params: ['provider'] },
    // #3871 — horarios de actividad por provider.
    { method: 'GET',  pattern: /^\/api\/multi-provider\/providers-schedule$/,    handler: handleProvidersScheduleGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/providers\/([a-z0-9-]+)\/schedule$/, handler: handleProviderSchedule, params: ['provider'] },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/commander-distribution(\?.*)?$/, handler: handleCommanderDistribution },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/config$/,                handler: handleConfigGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/config\/diff$/,          handler: handleConfigDiff },
    { method: 'PUT',  pattern: /^\/api\/multi-provider\/config$/,                handler: handleConfigPut },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/keys$/,                  handler: handleKeysGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/keys\/([a-z0-9-]+)$/,    handler: handleKeysPost, params: ['provider'] },
    { method: 'POST', pattern: /^\/api\/multi-provider\/ping\/([a-z0-9-]+)$/,    handler: handlePing, params: ['provider'] },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/catalog(\?.*)?$/,        handler: handleCatalog },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/skills$/,                handler: handleSkillsGet },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/overrides$/,             handler: handleOverridesGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/overrides$/,             handler: handleOverridesCreate },
    { method: 'POST', pattern: /^\/api\/multi-provider\/overrides\/revoke$/,     handler: handleOverridesRevoke },
    { method: 'POST', pattern: /^\/api\/multi-provider\/reload$/,                handler: handleReload },
    // Health snapshot (#3260): read-only sin CSRF, mutación con CSRF.
    { method: 'GET',  pattern: /^\/api\/multi-provider\/health$/,                handler: handleHealthGet },
    { method: 'POST', pattern: /^\/api\/multi-provider\/health\/run$/,           handler: handleHealthRun },
    // EP8-H12 (#3965): agregadores read-only de la pantalla "Salud Multi-Provider".
    { method: 'GET',  pattern: /^\/api\/multi-provider\/health-screen$/,         handler: handleHealthScreenGet },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/sherlock-pct$/,          handler: handleSherlockPctGet },
    { method: 'GET',  pattern: /^\/api\/multi-provider\/health-timeline$/,       handler: handleHealthTimelineGet },
];

function route(req, res) {
    const url = req.url || '';
    if (!url.startsWith('/api/multi-provider/')) return false;
    const pathPart = url.split('?')[0];
    let query = new URLSearchParams();
    try { query = new URL(url, 'http://x').searchParams; } catch {}
    for (const r of ROUTES) {
        if (r.method !== req.method) continue;
        const m = pathPart.match(r.pattern);
        if (!m) continue;
        const params = {};
        if (r.params) {
            r.params.forEach((name, i) => { params[name] = m[i + 1]; });
        }
        Promise.resolve()
            .then(() => r.handler(req, res, params, query))
            .catch(e => {
                try { sendError(res, 500, 'unhandled', e.message || String(e)); }
                catch { /* response ya cerrada */ }
            });
        return true;
    }
    sendError(res, 404, 'not_found', `Ruta ${req.method} ${pathPart} no existe en multi-provider API.`);
    return true;
}

module.exports = {
    route,
    resolveAuthor,
    handleCsrfToken,
    handleConfigGet,
    handleConfigDiff,
    handleConfigPut,
    handleKeysGet,
    handleKeysPost,
    handlePing,
    handleCatalog,
    handleSkillsGet,
    handleOverridesGet,
    handleOverridesCreate,
    handleOverridesRevoke,
    handleReload,
    handleHealthGet,
    handleHealthRun,
    handleHealthScreenGet,
    handleSherlockPctGet,
    handleHealthTimelineGet,
    handleProvidersDisabledGet,
    handleProviderDisable,
    handleProviderEnable,
    handleProvidersScheduleGet,
    handleProviderSchedule,
    readBody,
    RELOAD_SIGNAL_PATH,
};

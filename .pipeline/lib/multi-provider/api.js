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

const ROUTES = [
    { method: 'GET',  pattern: /^\/api\/multi-provider\/csrf-token$/,            handler: handleCsrfToken },
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
    readBody,
    RELOAD_SIGNAL_PATH,
};

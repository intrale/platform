// =============================================================================
// wizard-session.js — Infra compartida de los 5 wizards del Dashboard V3.
//
// Issue #3724 (split de #3715 / paraguas #3669). Receta firmada por
// `/architect` en fase `criterios` (#3613) sobre el análisis OWASP de
// `/security` (A01–A10) y el contrato de endpoint de `/guru`.
//
// Endpoint genérico (mount-first en `dashboard.js`, ANTES del catch-all):
//   POST /dashboard/wizard/<flow>/step
//
// Garantías de seguridad:
//   - CSRF HttpOnly + HMAC (NO double-submit: resiste XSS de localStorage).
//   - Validación de Origin allowlist + `Sec-Fetch-Site`.
//   - Idempotencia por (`wizard_session_id`, `step`) con mutex anti-carrera.
//   - Timeout de sesión 15 min → `410 Gone` + remove del store.
//   - Audit log NDJSON hash-chained (`lib/audit-log.js`) con secrets redactados.
//   - Rate-limit por Origin (sliding window) + caps de memoria + sweeper.
//
// **Feature, no bug**: cada restart del dashboard rota `PROC_SECRET` y vacía el
// store in-memory → las sesiones in-flight reciben 403/410. QA manual debe
// asumir que cualquier restart reinicia los wizards.
//
// Esta sub-historia entrega SOLO la infra + el plug-in vacío (`registerFlow`).
// Las 5 hijas (#3738–#3742) registran sus flows al `require()` del módulo.
// Sin deps npm — solo `node:crypto`, `node:fs`, `node:path` + `./audit-log` +
// `./redact`.
// =============================================================================
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const audit = require('./audit-log');
const redact = require('./redact');

// --- Configuración -----------------------------------------------------------
const ALLOWED_FLOWS = Object.freeze(['ola', 'descanso', 'providers', 'pausa', 'allowlist']);
const SESSION_TTL_MS = 15 * 60 * 1000;        // 15 min (CA-D5).
const SESSION_CAP = 200;                       // LRU evict en exceso.
const RATE_LIMIT_PER_MIN = 30;                 // requests/min por Origin.
const RATE_WINDOW_MS = 60 * 1000;
const ORIGIN_CAP = 1000;                        // máximo de orígenes rastreados.
const ORIGIN_STALE_MS = 5 * 60 * 1000;          // evict de origin sin actividad.
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;                // 8 KB → 413.

const ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// --- Estado in-memory --------------------------------------------------------
const FLOWS = new Map();        // flow → { maxStep, validateStep, executeStep }
const SESSIONS = new Map();     // id → { flow, createdAt, lastAccessAt, steps:Map, mutex }
const RATE = new Map();         // origin → { hits:number[], lastSeen:number }

// Flows permitidos SOLO para tests (monkey-patch del allowlist de prod sin
// tocar la constante congelada). Vacío en runtime.
const _TEST_FLOWS = new Set();

// Directorio de audit. Override para tests vía `_setAuditDirForTests`.
let AUDIT_DIR = path.join(__dirname, '..', 'logs');

// HMAC secret rotado en boot (feature: restart invalida tokens viejos).
let PROC_SECRET = crypto.randomBytes(32);

// =============================================================================
// CSRF HttpOnly + HMAC
// =============================================================================

/**
 * Emite una cookie CSRF HttpOnly nueva. El `<meta name="csrf-token">` del SSR
 * (#3723) deriva el token con `deriveCsrfToken(raw)`.
 * @returns {{raw:string, setCookie:string}}
 */
function newCsrfCookie() {
    const raw = crypto.randomBytes(32).toString('base64url');
    // `Secure`: omitido mientras el host sea 127.0.0.1/localhost sobre HTTP.
    // Cualquier exposición vía túnel HTTPS exige flip a `Secure` (ver risk en #3724).
    const setCookie = `wizard_csrf=${raw}; HttpOnly; SameSite=Strict; Path=/dashboard`;
    return { raw, setCookie };
}

/**
 * Deriva el token CSRF (HMAC-SHA256 de la cookie raw bajo `PROC_SECRET`).
 * @param {string} cookieRaw
 * @returns {string}
 */
function deriveCsrfToken(cookieRaw) {
    return crypto.createHmac('sha256', PROC_SECRET).update(String(cookieRaw)).digest('base64url');
}

/**
 * Lee una cookie por nombre del header `Cookie` del request.
 * @param {object} req
 * @param {string} name
 * @returns {string|null}
 */
function readCookie(req, name) {
    const raw = (req.headers && req.headers.cookie) || '';
    const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        if (p.slice(0, eq) === name) return p.slice(eq + 1);
    }
    return null;
}

/**
 * Verifica CSRF: cookie HttpOnly + header `X-CSRF-Token` = HMAC(cookie).
 * Compara con `crypto.timingSafeEqual` y pre-check de longitud (evita el throw
 * de timingSafeEqual con buffers de distinto largo, que filtraría timing).
 * @param {object} req
 * @returns {boolean}
 */
function verifyCsrf(req) {
    const cookieRaw = readCookie(req, 'wizard_csrf');
    const header = req.headers && req.headers['x-csrf-token'];
    if (!cookieRaw || !header) return false;
    const expected = Buffer.from(deriveCsrfToken(cookieRaw));
    const got = Buffer.from(String(header));
    if (expected.length !== got.length) return false;
    return crypto.timingSafeEqual(expected, got);
}

// =============================================================================
// Plug-in de flows
// =============================================================================

/**
 * Registra un flow. Las 5 hijas (#3738–#3742) llaman esto al require.
 * @param {string} name — debe estar en ALLOWED_FLOWS (o ser un flow de test).
 * @param {{maxStep:number, validateStep:Function, executeStep:Function}} def
 */
function registerFlow(name, def) {
    if (!ALLOWED_FLOWS.includes(name) && !_TEST_FLOWS.has(name)) {
        throw new Error(`wizard-session: flow no permitido "${name}"`);
    }
    if (FLOWS.has(name)) {
        throw new Error(`wizard-session: flow "${name}" ya registrado`);
    }
    const { maxStep, validateStep, executeStep } = def || {};
    if (typeof maxStep !== 'number' || maxStep < 0) {
        throw new Error('wizard-session: maxStep inválido');
    }
    if (typeof validateStep !== 'function' || typeof executeStep !== 'function') {
        throw new Error('wizard-session: validateStep/executeStep requeridos');
    }
    FLOWS.set(name, { maxStep, validateStep, executeStep });
}

// =============================================================================
// Helpers de respuesta
// =============================================================================

const FIXED_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin',
});

function send(res, status, errorCode, payload) {
    const obj = payload != null ? payload : { error: errorCode };
    const body = JSON.stringify(obj);
    res.writeHead(status, { ...FIXED_HEADERS, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

// =============================================================================
// Validaciones de borde
// =============================================================================

function originHost(req) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return null; // ausente → no bloqueamos (Sec-Fetch + CSRF cubren).
    try {
        return new URL(origin).hostname;
    } catch {
        return '__invalid__';
    }
}

function originAllowed(req) {
    const host = originHost(req);
    if (host === null) return true;
    return ALLOWED_ORIGIN_HOSTS.has(host);
}

function secFetchOk(req) {
    const sfs = req.headers && req.headers['sec-fetch-site'];
    if (!sfs) return true; // header ausente (browsers viejos) → no bloqueamos.
    return sfs === 'same-origin' || sfs === 'none';
}

function contentTypeOk(req) {
    const ct = (req.headers && req.headers['content-type']) || '';
    return /^application\/json\b/i.test(ct);
}

function originKey(req) {
    return (req.headers && req.headers.origin) || '__no_origin__';
}

/**
 * Rate-limit sliding-window por Origin. Devuelve true si se DEBE rechazar.
 * @param {object} req
 * @returns {boolean}
 */
function rateLimited(req) {
    const key = originKey(req);
    const now = Date.now();
    let rec = RATE.get(key);
    if (!rec) {
        if (RATE.size >= ORIGIN_CAP) return true; // cap absoluto de orígenes.
        rec = { hits: [], lastSeen: now };
        RATE.set(key, rec);
    }
    rec.hits = rec.hits.filter((t) => t > now - RATE_WINDOW_MS);
    rec.lastSeen = now;
    if (rec.hits.length >= RATE_LIMIT_PER_MIN) return true;
    rec.hits.push(now);
    return false;
}

// =============================================================================
// Lectura de body con cap
// =============================================================================

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject({ tooLarge: true });
                try { req.destroy(); } catch { /* best-effort */ }
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', (e) => reject(e));
    });
}

// =============================================================================
// Audit
// =============================================================================

function auditEntry({ flow, sessionId, step, result, csrfOk, secFetchSite, params }) {
    const ymd = new Date().toISOString().slice(0, 10);
    const file = path.join(AUDIT_DIR, `wizard-audit-${ymd}.ndjson`);
    audit.appendChained({
        file,
        entry: {
            ts: Date.now(),
            actor: `operator-local:${process.pid}`,
            action: 'wizard.step',
            flow,
            wizard_session_id: sessionId,
            step,
            result,                 // 'ok' | 'failed' | 'idempotent_replay'
            csrf_ok: csrfOk,
            sec_fetch_site: secFetchSite,
            // Normalizamos a {} si no hay params: un `undefined` se omitiría al
            // serializar la línea pero NO al computar el hash → rompería la
            // cadena (verifyChain recalcularía sin la clave).
            params_redacted: redact.redactObject(params == null ? {} : params),
        },
    });
}

// =============================================================================
// Store de sesiones
// =============================================================================

function evictIfNeeded() {
    if (SESSIONS.size < SESSION_CAP) return;
    // LRU: evict la sesión con lastAccessAt más viejo.
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, s] of SESSIONS.entries()) {
        if (s.lastAccessAt < oldestAt) { oldestAt = s.lastAccessAt; oldestId = id; }
    }
    if (oldestId) SESSIONS.delete(oldestId);
}

function newSessionId() {
    return crypto.randomBytes(18).toString('base64url');
}

// =============================================================================
// Procesamiento del step (con mutex + idempotencia)
// =============================================================================

async function processStep(req, res, flowName, body) {
    const flowDef = FLOWS.get(flowName);
    const step = body.step;
    const params = body.params;
    const secFetchSite = (req.headers && req.headers['sec-fetch-site']) || null;

    if (!Number.isInteger(step)) {
        return send(res, 400, 'bad_request');
    }

    let session;
    let sessionId;

    if (step === 0) {
        // Anti-fixation: ignoramos cualquier wizard_session_id del cliente y
        // emitimos uno nuevo (CA-D2 / test 16).
        sessionId = newSessionId();
        const now = Date.now();
        session = { flow: flowName, createdAt: now, lastAccessAt: now, steps: new Map(), mutex: null };
        evictIfNeeded();
        SESSIONS.set(sessionId, session);
    } else {
        sessionId = body.wizard_session_id;
        if (!sessionId || typeof sessionId !== 'string') {
            return send(res, 404, 'not_found');
        }
        session = SESSIONS.get(sessionId);
        if (!session || session.flow !== flowName) {
            return send(res, 404, 'not_found');
        }
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
            SESSIONS.delete(sessionId);
            return send(res, 410, 'gone');
        }
    }

    if (step < 0 || step > flowDef.maxStep) {
        return send(res, 409, 'conflict');
    }

    // Mutex por sesión: serializa (session_id, step) concurrentes (CA-D5 / test 13).
    const prev = session.mutex || Promise.resolve();
    let release;
    session.mutex = new Promise((r) => { release = r; });
    await prev;
    try {
        const existing = session.steps.get(step);
        if (existing && existing.status === 'ok') {
            auditEntry({ flow: flowName, sessionId, step, result: 'idempotent_replay', csrfOk: true, secFetchSite, params });
            return send(res, 200, null, { wizard_session_id: sessionId, step, status: 'idempotent_replay', result: existing.result });
        }

        let valid = true;
        try {
            valid = flowDef.validateStep(step, params) !== false;
        } catch {
            valid = false;
        }
        if (!valid) {
            auditEntry({ flow: flowName, sessionId, step, result: 'failed', csrfOk: true, secFetchSite, params });
            return send(res, 409, 'conflict');
        }

        session.lastAccessAt = Date.now();
        const result = await flowDef.executeStep(session, step, params);
        session.steps.set(step, { status: 'ok', result });
        auditEntry({ flow: flowName, sessionId, step, result: 'ok', csrfOk: true, secFetchSite, params });
        return send(res, 200, null, { wizard_session_id: sessionId, step, status: 'ok', result });
    } finally {
        release();
    }
}

// =============================================================================
// Router HTTP
// =============================================================================

async function handle(req, res, flowName) {
    if (req.method !== 'POST') {
        return send(res, 405, 'method_not_allowed');
    }
    if (!FLOWS.has(flowName)) {
        return send(res, 404, 'not_found');
    }
    if (!originAllowed(req) || !secFetchOk(req) || !verifyCsrf(req)) {
        // 403 genérico: no distinguimos CSRF / Sec-Fetch / Origin (CA-D2).
        return send(res, 403, 'forbidden');
    }
    if (!contentTypeOk(req)) {
        return send(res, 415, 'unsupported_media_type');
    }
    if (rateLimited(req)) {
        return send(res, 429, 'rate_limited');
    }

    let raw;
    try {
        raw = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
        if (e && e.tooLarge) return send(res, 413, 'too_large');
        return send(res, 400, 'bad_request');
    }

    let body;
    try {
        body = raw ? JSON.parse(raw) : {};
    } catch {
        return send(res, 400, 'bad_request');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, 'bad_request');
    }

    return processStep(req, res, flowName, body);
}

/**
 * Punto de entrada del mount en `dashboard.js`. Devuelve `true` si tomó el
 * request (la URL matchea el endpoint de wizards), `false` si no es nuestro.
 * @param {object} req
 * @param {object} res
 * @returns {boolean}
 */
function route(req, res) {
    const urlPath = (req.url || '').split('?')[0];
    const m = urlPath.match(/^\/dashboard\/wizard\/([^/]+)\/step$/);
    if (!m) return false;
    let flowName;
    try {
        flowName = decodeURIComponent(m[1]);
    } catch {
        flowName = m[1];
    }
    handle(req, res, flowName).catch((err) => {
        try { send(res, 500, 'internal_error'); } catch { /* res ya cerrado */ }
        try { /* eslint-disable-next-line no-console */ console.error('[wizard-session] error no manejado:', err && err.message); } catch {}
    });
    return true;
}

// =============================================================================
// Sweeper — limpia sesiones expiradas y orígenes stale.
// `unref()` OBLIGATORIO: no debe bloquear el shutdown del dashboard.
// =============================================================================

function sweep() {
    const now = Date.now();
    for (const [id, s] of SESSIONS.entries()) {
        if (now - s.createdAt > SESSION_TTL_MS) SESSIONS.delete(id);
    }
    for (const [origin, rec] of RATE.entries()) {
        if (now - rec.lastSeen > ORIGIN_STALE_MS) RATE.delete(origin);
    }
}

const _sweeper = setInterval(sweep, SWEEP_INTERVAL_MS).unref();

// =============================================================================
// Helpers de test (NO usar en runtime)
// =============================================================================

function _resetForTests() {
    FLOWS.clear();
    SESSIONS.clear();
    RATE.clear();
    _TEST_FLOWS.clear();
}

function _allowTestFlow(name) {
    _TEST_FLOWS.add(name);
}

function _setAuditDirForTests(dir) {
    AUDIT_DIR = dir;
}

function _rotateSecretForTests() {
    PROC_SECRET = crypto.randomBytes(32);
}

module.exports = {
    route,
    registerFlow,
    ALLOWED_FLOWS,
    SESSION_TTL_MS,
    RATE_LIMIT_PER_MIN,
    MAX_BODY_BYTES,
    // CSRF exportado para el SSR de #3723 y para tests.
    _csrf: { newCsrfCookie, deriveCsrfToken, verifyCsrf, readCookie },
    // Helpers de test.
    _resetForTests,
    _allowTestFlow,
    _setAuditDirForTests,
    _rotateSecretForTests,
    _sweep: sweep,
};

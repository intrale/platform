// =============================================================================
// action-token.js — Tokens firmados HMAC para acciones rápidas de needs-human
// (issue #4068, split de #4050).
//
// Modelo de seguridad (CA-SEC-5, OWASP A04/A08 — anti-replay):
//   Un link de Telegram es una *capability portable y persistente*. Cada botón
//   de la alerta `needs-human` lleva un token firmado que autoriza UNA acción
//   sobre UN issue. El token:
//     - va firmado con HMAC-SHA256 (no falsificable sin el secreto),
//     - expira (`exp` corto, default 24h),
//     - es de UN SOLO USO (nonce persistido en `audit/human-block-tokens-used.jsonl`).
//   `verify()` rechaza: firma inválida/tampered, expirado, nonce ya consumido.
//
// El secreto NUNCA se hardcodea ni se loguea: se deriva del bot token de
// Telegram (fuente única `credentials.json` vía `lib/credentials.js`). Derivar
// con HMAC evita reusar el secreto crudo y desacopla el dominio del token.
//
// NOTA: este módulo corre en el proceso del dashboard (single-thread). `verify()`
// es 100% síncrono — el check de nonce y el append son atómicos dentro del event
// loop, sin `await` intermedio, así que un doble-click no puede gastar el token
// dos veces (no hay ventana de carrera dentro del proceso).
// =============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const trace = require('./traceability');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const DEFAULT_NONCE_FILE = path.join(PIPELINE_DIR, 'audit', 'human-block-tokens-used.jsonl');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h (SEC-5: exp corto)
const TOKEN_VERSION = 'v1';
const SECRET_INFO = 'human-block-action-token/v1';

// Allowlist cerrada de acciones (CA-SEC-3, OWASP A03). `pausar` queda FUERA por
// decisión de producto (PO #4068): no resuelve el bloqueo, solo lo congela.
const ACTION_ALLOWLIST = Object.freeze(['unblock', 'mas-contexto', 'devolver-definicion', 'priorizar']);

// --- base64url helpers (sin padding, URL-safe para query strings) -----------
function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function deriveKey(rawSecret) {
    // Deriva una clave dedicada para no reusar el secreto crudo (telegram bot
    // token). HMAC-SHA256 actúa como KDF determinística.
    return crypto.createHmac('sha256', String(rawSecret)).update(SECRET_INFO).digest();
}

/**
 * Resuelve el secreto crudo desde la fuente única de credenciales. Lazy: solo
 * se invoca cuando no se inyecta un secreto explícito (tests inyectan el suyo).
 * @returns {string}
 * @throws si no hay secreto disponible (el caller debe degradar con gracia).
 */
function resolveRawSecret() {
    if (process.env.TELEGRAM_BOT_TOKEN && String(process.env.TELEGRAM_BOT_TOKEN).length > 0) {
        return String(process.env.TELEGRAM_BOT_TOKEN);
    }
    // Intentar hidratar desde credentials.json (idempotente, respeta env existente).
    try {
        require('./credentials').loadIntoEnv({ logger: () => {} });
    } catch (_) { /* best-effort */ }
    if (process.env.TELEGRAM_BOT_TOKEN && String(process.env.TELEGRAM_BOT_TOKEN).length > 0) {
        return String(process.env.TELEGRAM_BOT_TOKEN);
    }
    throw new Error('action-token: sin secreto disponible (TELEGRAM_BOT_TOKEN ausente en credentials.json)');
}

function isValidAction(action) {
    return ACTION_ALLOWLIST.includes(action);
}
function isValidIssue(issue) {
    return Number.isInteger(issue) && issue > 0 && issue <= 999999;
}

/**
 * Crea un firmador/verificador de tokens con secreto y store de nonces
 * inyectables (para tests herméticos).
 *
 * @param {object} opts
 * @param {string}   [opts.secret]    - secreto crudo. Default: resuelto de credentials.
 * @param {string}   [opts.nonceFile] - path del store JSONL de nonces usados.
 * @param {number}   [opts.ttlMs]     - vida del token (default 24h).
 * @param {function} [opts.now]       - clock injectable (default Date.now).
 */
function createTokenSigner(opts = {}) {
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const nonceFile = opts.nonceFile || DEFAULT_NONCE_FILE;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const rawSecret = opts.secret !== undefined ? opts.secret : resolveRawSecret();
    const key = deriveKey(rawSecret);

    function signBody(body) {
        return b64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
    }

    // --- nonce store (un-solo-uso) ------------------------------------------
    function readUsedNonces() {
        const used = new Set();
        let raw;
        try { raw = fs.readFileSync(nonceFile, 'utf8'); } catch { return used; }
        for (const ln of raw.split('\n')) {
            if (!ln) continue;
            try {
                const o = JSON.parse(ln);
                if (o && o.n) used.add(String(o.n));
            } catch { /* línea corrupta — skip */ }
        }
        return used;
    }
    function markNonceUsed(nonce, meta) {
        try { fs.mkdirSync(path.dirname(nonceFile), { recursive: true }); } catch { /* idempotente */ }
        const line = JSON.stringify({
            n: nonce,
            issue: meta && meta.issue,
            action: meta && meta.action,
            ts: new Date(now()).toISOString(),
        }) + '\n';
        fs.appendFileSync(nonceFile, line);
    }

    /**
     * Firma un token para {issue, action}. `exp` opcional (epoch ms); default
     * now()+ttlMs.
     * @returns {string} token `v1.<body>.<sig>`
     */
    function sign({ issue, action, exp } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) throw new Error(`action-token.sign: issue inválido (${issue})`);
        if (!isValidAction(action)) throw new Error(`action-token.sign: action inválida (${action})`);
        const payload = {
            i,
            a: action,
            n: crypto.randomBytes(12).toString('hex'),
            e: Number.isFinite(exp) ? exp : now() + ttlMs,
        };
        const body = b64urlEncode(JSON.stringify(payload));
        return `${TOKEN_VERSION}.${body}.${signBody(body)}`;
    }

    /**
     * Verifica y CONSUME un token (un solo uso). Devuelve:
     *   { ok: true, issue, action } | { ok: false, reason: 'invalid'|'expired'|'replayed' }
     * El nonce se marca usado SOLO en el camino feliz.
     */
    function verify(token) {
        if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
            return { ok: false, reason: 'invalid' };
        }
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
            return { ok: false, reason: 'invalid' };
        }
        const [, body, sig] = parts;
        // 1. Firma (timing-safe). Buffers de distinta longitud → invalid sin comparar.
        const expectedSig = signBody(body);
        const a = Buffer.from(sig);
        const b = Buffer.from(expectedSig);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return { ok: false, reason: 'invalid' };
        }
        // 2. Payload.
        let payload;
        try { payload = JSON.parse(b64urlDecodeToString(body)); }
        catch { return { ok: false, reason: 'invalid' }; }
        if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid' };
        const issue = Number(payload.i);
        const action = payload.a;
        const exp = Number(payload.e);
        const nonce = payload.n;
        if (!isValidIssue(issue) || !isValidAction(action) || !nonce || !Number.isFinite(exp)) {
            return { ok: false, reason: 'invalid' };
        }
        // 3. Expiración (SEC-5).
        if (exp <= now()) return { ok: false, reason: 'expired' };
        // 4. Replay — nonce un solo uso (SEC-5).
        const used = readUsedNonces();
        if (used.has(String(nonce))) return { ok: false, reason: 'replayed' };
        markNonceUsed(String(nonce), { issue, action });
        return { ok: true, issue, action };
    }

    return { sign, verify, nonceFile, ttlMs };
}

// --- singleton perezoso (producción) ----------------------------------------
let _default = null;
function getDefault() {
    if (!_default) _default = createTokenSigner();
    return _default;
}

module.exports = {
    createTokenSigner,
    // API de conveniencia que usa el secreto/store de producción.
    sign: (args) => getDefault().sign(args),
    verify: (token) => getDefault().verify(token),
    deriveKey,
    isValidAction,
    isValidIssue,
    ACTION_ALLOWLIST,
    DEFAULT_TTL_MS,
    DEFAULT_NONCE_FILE,
    TOKEN_VERSION,
};

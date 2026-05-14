// =============================================================================
// csrf.js — Token CSRF para los endpoints mutating del panel multi-provider
// (#3177 + recomendación de #3191).
//
// Patrón "double-submit cookie":
//   1. El cliente hace `GET /api/multi-provider/csrf-token`.
//   2. El server devuelve `{ csrf_token: <random> }` y setea cookie
//      `mp_csrf=<random>; HttpOnly=false; SameSite=Strict; Path=/api/multi-provider`.
//   3. En cada PUT/POST/DELETE, el cliente manda el header
//      `X-CSRF-Token: <random>` (leído de la cookie).
//   4. El server compara header vs cookie. Si NO matchean → 403.
//
// Por qué mitiga DNS rebinding:
//   Un atacante que apunta DNS de `attacker.com` a `127.0.0.1` puede llamar
//   al dashboard desde el browser de la víctima, pero NO puede leer la
//   cookie de un origen distinto (Same-Origin Policy del browser). Sin la
//   cookie no puede mandar el header → 403.
//
// El token es per-process (vive en memoria). Rotación natural en cada restart.
// =============================================================================
'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 24;
const TOKEN_TTL_MS = 4 * 3600 * 1000; // 4h

const _tokens = new Map();

function generateToken({ now = Date.now() } = {}) {
    const tok = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    _tokens.set(tok, now + TOKEN_TTL_MS);
    purgeExpired(now);
    return tok;
}

function verifyToken(tok, { now = Date.now() } = {}) {
    if (!tok || typeof tok !== 'string') return false;
    purgeExpired(now);
    const expiresAt = _tokens.get(tok);
    if (!expiresAt) return false;
    if (expiresAt < now) {
        _tokens.delete(tok);
        return false;
    }
    return true;
}

function purgeExpired(now) {
    for (const [tok, expiresAt] of _tokens.entries()) {
        if (expiresAt < now) _tokens.delete(tok);
    }
}

function _resetForTests() {
    _tokens.clear();
}

function readCookie(req, name) {
    const raw = (req.headers && req.headers.cookie) || '';
    const parts = raw.split(';').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const k = p.slice(0, eq);
        const v = p.slice(eq + 1);
        if (k === name) return decodeURIComponent(v);
    }
    return null;
}

function readHeader(req, name) {
    const lower = name.toLowerCase();
    return (req.headers && req.headers[lower]) || null;
}

function requireCSRF(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    const headerTok = readHeader(req, 'x-csrf-token');
    const cookieTok = readCookie(req, 'mp_csrf');
    if (!headerTok || !cookieTok) {
        sendError(res, 403, 'missing_csrf_token', 'Falta header X-CSRF-Token o cookie mp_csrf.');
        return false;
    }
    if (headerTok !== cookieTok) {
        sendError(res, 403, 'csrf_mismatch', 'El header X-CSRF-Token no coincide con la cookie mp_csrf.');
        return false;
    }
    if (!verifyToken(headerTok)) {
        sendError(res, 403, 'csrf_expired', 'El token CSRF expiró o no fue emitido por este server. Pedí uno nuevo en /api/multi-provider/csrf-token.');
        return false;
    }
    return true;
}

function sendError(res, status, code, message) {
    const body = JSON.stringify({ ok: false, code, message });
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function issueTokenResponse(req, res) {
    const tok = generateToken();
    const body = JSON.stringify({ csrf_token: tok });
    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `mp_csrf=${encodeURIComponent(tok)}; Path=/api/multi-provider; SameSite=Strict; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

module.exports = {
    TOKEN_TTL_MS,
    generateToken,
    verifyToken,
    requireCSRF,
    issueTokenResponse,
    readCookie,
    readHeader,
    _resetForTests,
};

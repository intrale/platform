// =============================================================================
// kill-agent-csrf.js — Token CSRF para el endpoint destructivo /api/kill-agent
// (EP8-H2 · #3955, requisito SEC-2 del análisis de `security`).
//
// Patrón "double-submit cookie" (mismo esquema que multi-provider/csrf.js #3177):
//   1. El cliente hace `GET /api/kill-agent/csrf-token`.
//   2. El server devuelve `{ csrf_token: <random> }` y setea cookie
//      `ka_csrf=<random>; SameSite=Strict; Path=/`.
//   3. En el POST /api/kill-agent el cliente manda el header
//      `X-CSRF-Token: <random>` (leído de la respuesta JSON).
//   4. El server compara header vs cookie y valida contra el registro
//      in-memory. Si NO matchea o el token no fue emitido → 403.
//
// Por qué mitiga CSRF (`<img onerror=fetch('/api/kill-agent',{method:'POST'})>`):
//   Un atacante cross-origin puede disparar el POST (el browser adjunta la
//   cookie), pero NO puede leer la respuesta del GET del token (Same-Origin
//   Policy) ni la cookie de otro origen → no puede setear el header correcto.
//   Sin header válido → 403. El bind loopback (#3177/#3191) es la barrera dura;
//   esto cierra el gap de una pestaña maliciosa en el mismo browser.
//
// Cookie con Path=/ (NO /api/multi-provider) porque el POST destructivo y sus
// call sites viven en el árbol del dashboard (home, equipo, descanso, legacy),
// no bajo un prefijo único. El token es per-process (memoria) — rota en cada
// restart, que es exactamente cuando los call sites re-piden token.
// =============================================================================
'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 24;
const TOKEN_TTL_MS = 4 * 3600 * 1000; // 4h
const COOKIE_NAME = 'ka_csrf';

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
    const raw = (req && req.headers && req.headers.cookie) || '';
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
    return (req && req.headers && req.headers[lower]) || null;
}

/**
 * Verifica el CSRF de una request mutante. Devuelve true si pasa, o false y
 * responde 403 si falla. Métodos no-mutantes pasan siempre.
 */
function requireCSRF(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    const headerTok = readHeader(req, 'x-csrf-token');
    const cookieTok = readCookie(req, COOKIE_NAME);
    if (!headerTok || !cookieTok) {
        sendError(res, 403, 'missing_csrf_token', 'Falta header X-CSRF-Token o cookie ka_csrf. Pedí un token en /api/kill-agent/csrf-token.');
        return false;
    }
    if (headerTok !== cookieTok) {
        sendError(res, 403, 'csrf_mismatch', 'El header X-CSRF-Token no coincide con la cookie ka_csrf.');
        return false;
    }
    if (!verifyToken(headerTok)) {
        sendError(res, 403, 'csrf_expired', 'El token CSRF expiró o no fue emitido por este server. Pedí uno nuevo en /api/kill-agent/csrf-token.');
        return false;
    }
    return true;
}

function sendError(res, status, code, message) {
    const body = JSON.stringify({ ok: false, code, message });
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/** Emite un token nuevo + cookie y lo devuelve en el body (synchronizer + double-submit). */
function issueTokenResponse(req, res) {
    const tok = generateToken();
    const body = JSON.stringify({ csrf_token: tok });
    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(tok)}; Path=/; SameSite=Strict; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

module.exports = {
    TOKEN_TTL_MS,
    COOKIE_NAME,
    generateToken,
    verifyToken,
    requireCSRF,
    issueTokenResponse,
    readCookie,
    readHeader,
    _resetForTests,
};

'use strict';

// =============================================================================
// ops-restart-gate.js — Gate de defensa-en-profundidad para el disparo del
// restart del modelo operativo desde el dashboard (#4460, REQ-SEC-4460-1).
// -----------------------------------------------------------------------------
// El restart es una acción DESTRUCTIVA (corta el pipeline) expuesta detrás de
// un botón del dashboard. `/api/action` (restart existente) NO valida
// Origin/CSRF → es CSRF-eable desde una web maliciosa que el operador visite
// con el dashboard abierto (el browser igual emite el POST a localhost).
//
// Este módulo aísla la lógica de gate (loopback + Origin/Referer + Content-Type)
// en una función PURA sobre `req` para que sea unit-testeable sin levantar el
// server. El CSRF HMAC se valida aparte con `kill-agent-csrf.requireCSRF`
// (double-submit cookie) — este gate es la capa previa.
//
// Espeja el patrón inline de `/api/allowlist-candidates` y `/api/kill-agent`
// (dashboard.js), centralizándolo para no duplicarlo una tercera vez.
// =============================================================================

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3200', 'http://127.0.0.1:3200'];

function _isLoopback(remote) {
    const r = String(remote || '');
    return r === '127.0.0.1'
        || r === '::1'
        || r === '::ffff:127.0.0.1'
        || r.startsWith('127.');
}

/**
 * Valida el gate de una request mutante de restart. Función pura: no responde,
 * sólo decide. El caller aplica el status/body.
 *
 * @param {object} req — { method, headers, socket:{remoteAddress} }.
 * @param {object} [opts] — { allowedOrigins }.
 * @returns {{ ok: true } | { ok: false, status: number, code: string, msg: string }}
 */
function checkGate(req, opts) {
    const allowedOrigins = (opts && Array.isArray(opts.allowedOrigins) && opts.allowedOrigins.length)
        ? opts.allowedOrigins
        : DEFAULT_ALLOWED_ORIGINS;
    const headers = (req && req.headers) || {};
    const remote = (req && req.socket && req.socket.remoteAddress) || '';

    // 1. Loopback gate — sólo 127.0.0.1/::1 (CA-Sec-01).
    if (!_isLoopback(remote)) {
        return { ok: false, status: 403, code: 'not_loopback', msg: `loopback-only endpoint, got remote=${remote}` };
    }

    const method = (req && req.method) || 'GET';
    const isMutation = method === 'POST' || method === 'DELETE';
    if (!isMutation) {
        return { ok: true };
    }

    // 2. Origin/Referer gate (CA-Sec-02). Si el cliente NO manda Origin/Referer
    //    (curl/tests locales), se acepta; si los manda, deben estar en la
    //    allowlist. Un browser cross-origin SIEMPRE manda Origin en un POST.
    const origin = headers['origin'] || '';
    const referer = headers['referer'] || '';
    const originOk = !origin || allowedOrigins.includes(origin);
    const refererOk = !referer || allowedOrigins.some((o) => referer.startsWith(o + '/'));
    if (!originOk || !refererOk) {
        return { ok: false, status: 403, code: 'bad_origin', msg: 'Origin/Referer no permitido para la mutación' };
    }

    // 3. Content-Type estricto en POST (CA-Sec-03) — bloquea form/simple
    //    requests cross-origin que no pueden setear application/json sin
    //    preflight CORS.
    if (method === 'POST') {
        const ct = String(headers['content-type'] || '').toLowerCase();
        if (!ct.startsWith('application/json')) {
            return { ok: false, status: 415, code: 'bad_content_type', msg: 'Content-Type debe ser application/json' };
        }
    }

    return { ok: true };
}

module.exports = {
    checkGate,
    DEFAULT_ALLOWED_ORIGINS,
    _isLoopback,
};

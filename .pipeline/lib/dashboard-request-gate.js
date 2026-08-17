// =============================================================================
// dashboard-request-gate.js — Gate de request para mutaciones locales del
// dashboard (issue #5923).
//
// El dashboard escucha en loopback pero NO tiene sesión ni CSRF token, así que
// cualquier página que el operador tenga abierta en el browser podría postear a
// sus endpoints de mutación. El molde bueno vive en `/api/allowlist-candidates`
// (loopback + Origin/Referer + Content-Type estricto); acá está extraído como
// función PURA para poder testearlo y para que los endpoints nuevos no nazcan
// copiando el molde de `include-deps`, que no tiene ningún control de request
// (CSRF preexistente, fuera de alcance → issue #5929).
//
// Módulo PURO: sin I/O, sin red. Sólo mira lo que vino en el request.
// =============================================================================
'use strict';

const ALLOWED_ORIGINS = Object.freeze([
    'http://localhost:3200',
    'http://127.0.0.1:3200',
]);

/** ¿La conexión viene de la propia máquina? */
function isLoopbackAddress(remote) {
    const r = String(remote || '');
    return r === '127.0.0.1'
        || r === '::1'
        || r === '::ffff:127.0.0.1'
        || r.startsWith('127.');
}

/**
 * Evalúa si una mutación local puede proceder.
 *
 * @param {object} req
 * @param {string} req.remoteAddress
 * @param {string} [req.method]
 * @param {object} [req.headers]
 * @param {string[]} [allowedOrigins]
 * @returns {{ok:true} | {ok:false, status:number, msg:string}}
 */
function evaluateLocalMutationGate(req = {}, allowedOrigins = ALLOWED_ORIGINS) {
    const remote = req.remoteAddress;
    if (!isLoopbackAddress(remote)) {
        return { ok: false, status: 403, msg: `loopback-only endpoint, got remote=${remote || ''}` };
    }

    const headers = req.headers || {};
    const origin = headers['origin'] || '';
    const referer = headers['referer'] || '';
    // Sin Origin/Referer lo dejamos pasar: es el caso de curl / el propio
    // callback-handler, que no son browsers y por lo tanto no son vector CSRF.
    const originOk = !origin || allowedOrigins.includes(origin);
    const refererOk = !referer || allowedOrigins.some(o => referer.startsWith(o + '/'));
    if (!originOk || !refererOk) {
        return { ok: false, status: 403, msg: 'cross-origin request rejected' };
    }

    const ct = String(headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
        return { ok: false, status: 415, msg: 'Content-Type must be application/json' };
    }
    return { ok: true };
}

/**
 * Sanea el `authorizedBy` que viene en el body. NUNCA se hardcodea un literal:
 * el gate de auditoría de `partial-pause` necesita saber QUIÉN autorizó, y para
 * los botones de Telegram ese quién es el `from.id` que el listener ya validó
 * contra la allowlist de operadores.
 */
function sanitizeAuthorizedBy(raw, fallback = 'dashboard-local') {
    const s = String(raw == null ? '' : raw).trim().slice(0, 120);
    return /^[\w:.@-]+$/.test(s) ? s : fallback;
}

module.exports = {
    evaluateLocalMutationGate,
    isLoopbackAddress,
    sanitizeAuthorizedBy,
    ALLOWED_ORIGINS,
};

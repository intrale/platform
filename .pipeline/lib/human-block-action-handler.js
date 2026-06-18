// =============================================================================
// human-block-action-handler.js — Endpoint POST /api/human-block/action (#4068)
//
// Punto de mutación de las acciones rápidas de la alerta `needs-human`. El botón
// de Telegram es URL no-mutante (GET → pantalla de confirmación en el dashboard);
// la mutación REAL sólo ocurre acá, por POST, detrás del gate CA-Sec.
//
// Defensa en profundidad (CA-SEC-1 / OWASP A01,A03,A05):
//   1. loopback-only (127.0.0.1/::1) → 403
//   2. Origin/Referer contra localhost:3200 / 127.0.0.1:3200 → 403
//   3. Content-Type: application/json estricto → 415
//   4. body cap 16KB
//   5. issue validado `^\d+$` + cap 999999 → 400
//   6. action contra allowlist cerrada → 400
//   7. token HMAC verificado (firma + exp + nonce un-solo-uso) → 401  (CA-SEC-5)
//   8. binding token↔(issue,action): si no coinciden → 401
//   9. audit-log de TODA acción (autorizada y rechazada) → CA-SEC-2
//
// La identidad NUNCA viene del cliente: se deriva server-side (`dashboard-local`
// + remoteAddress). El extracto se delega en handlers testeables como
// `agent-chat-handler.js` porque `dashboard.js` no es require-safe (hace
// `startListen()` al cargar).
// =============================================================================

'use strict';

const BODY_MAX_BYTES = 16 * 1024;
const ALLOWED_ORIGINS = ['http://localhost:3200', 'http://127.0.0.1:3200'];

// Copy amable por estado de token (CA-5): nunca exponer el 401/400 crudo.
const TOKEN_REASON_COPY = {
    expired: '⏳ Este enlace expiró. Volvé a abrir la alerta más reciente del issue.',
    replayed: '✅ Esta acción ya fue resuelta. No hace falta hacer nada más.',
    invalid: '🔒 Enlace inválido. Por seguridad no se ejecutó ninguna acción.',
    mismatch: '🔒 Enlace inválido. Por seguridad no se ejecutó ninguna acción.',
};

function sendJson(res, code, payload) {
    try {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    } catch (_) { /* socket cerrado — best-effort */ }
}

function isLoopbackRemote(remote) {
    return remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
        || remote.startsWith('127.');
}

/**
 * Maneja POST /api/human-block/action.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} [deps]
 * @param {function} [deps.log]
 * @param {object}   [deps.actionToken] - módulo de token (inyectable en tests).
 * @param {object}   [deps.humanBlock]  - módulo human-block (inyectable en tests).
 * @param {object}   [deps.auditDeps]   - deps de auditQuickAction (tests).
 */
function handle(req, res, deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const actionToken = deps.actionToken || require('./action-token');
    const humanBlock = deps.humanBlock || require('./human-block');
    const auditDeps = deps.auditDeps;

    const remote = (req.socket && req.socket.remoteAddress) || '';

    // --- 1. loopback-only ---
    if (!isLoopbackRemote(remote)) {
        return sendJson(res, 403, { ok: false, msg: `loopback-only endpoint, got remote=${remote}` });
    }
    // --- método ---
    if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, msg: 'method not allowed (usar POST)' });
    }
    // --- 2. Origin/Referer ---
    const origin = req.headers['origin'] || '';
    const referer = req.headers['referer'] || '';
    const originOk = !origin || ALLOWED_ORIGINS.includes(origin);
    const refererOk = !referer || ALLOWED_ORIGINS.some((o) => referer.startsWith(o + '/'));
    if (!originOk || !refererOk) {
        return sendJson(res, 403, { ok: false, msg: 'cross-origin request rejected' });
    }
    // --- 3. Content-Type estricto ---
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
        return sendJson(res, 415, { ok: false, msg: 'Content-Type must be application/json' });
    }

    // --- 4. body con cap ---
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > BODY_MAX_BYTES) { aborted = true; req.destroy(); }
    });
    req.on('error', () => { /* socket roto — el cliente reintenta */ });
    req.on('end', () => {
        if (aborted) return;
        let data;
        try { data = body ? JSON.parse(body) : {}; }
        catch (e) { return sendJson(res, 400, { ok: false, msg: 'JSON inválido: ' + e.message }); }

        // --- 5. issue ^\d+$ + cap (CA-SEC-3, A03) ---
        const issueRaw = data.issue === undefined || data.issue === null ? '' : String(data.issue);
        if (!/^\d+$/.test(issueRaw)) {
            return sendJson(res, 400, { ok: false, msg: 'issue inválido (se espera entero positivo)' });
        }
        const issue = Number(issueRaw);
        if (!(issue > 0 && issue <= 999999)) {
            return sendJson(res, 400, { ok: false, msg: 'issue fuera de rango' });
        }

        // --- 6. action contra allowlist cerrada (CA-SEC-3) ---
        const action = data.action;
        if (!humanBlock.isQuickAction(action)) {
            return sendJson(res, 400, { ok: false, msg: 'action inválida' });
        }

        const audit = (result_status, extra) => {
            try {
                humanBlock.auditQuickAction({
                    issue, action, from: 'dashboard-local',
                    result_status, remote_address: remote,
                    deps: auditDeps, ...extra,
                });
            } catch (_) { /* audit nunca rompe la operación */ }
        };

        // --- 7. token HMAC (firma + exp + replay) — CA-SEC-5 ---
        const verdict = actionToken.verify(data.token);
        if (!verdict.ok) {
            audit('unauthorized', { token_reason: verdict.reason });
            return sendJson(res, 401, {
                ok: false, reason: verdict.reason,
                msg: TOKEN_REASON_COPY[verdict.reason] || TOKEN_REASON_COPY.invalid,
            });
        }
        // --- 8. binding token↔(issue,action) ---
        if (verdict.issue !== issue || verdict.action !== action) {
            audit('unauthorized', { token_reason: 'mismatch' });
            return sendJson(res, 401, { ok: false, reason: 'mismatch', msg: TOKEN_REASON_COPY.mismatch });
        }

        // --- 9. ejecutar ---
        let result;
        try { result = humanBlock.executeQuickAction({ issue, action }); }
        catch (e) {
            audit('error');
            return sendJson(res, 500, { ok: false, msg: 'Error ejecutando acción: ' + e.message });
        }
        if (!result || !result.ok) {
            audit('error');
            return sendJson(res, 500, { ok: false, msg: (result && result.error) || 'error ejecutando acción' });
        }
        audit('authorized');
        log(`human-block-action: ${action} #${issue} → ${result.msg}`);
        return sendJson(res, 200, { ok: true, action, issue, msg: result.msg });
    });
}

module.exports = { handle, TOKEN_REASON_COPY, BODY_MAX_BYTES, ALLOWED_ORIGINS };

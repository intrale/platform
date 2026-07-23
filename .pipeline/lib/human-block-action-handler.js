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
    // #4631 — copy seguro y GENÉRICO para el gate de identidad delegada. Deliberadamente
    // idéntico entre sí y al de `invalid/mismatch`: no revela si el ejecutor está o no
    // registrado como operador, ni expone IDs de Telegram, delegate/grantor, nonce ni
    // motivo técnico. Así un rechazo por identidad no permite ENUMERAR operadores válidos.
    identity: '🔒 Enlace inválido o sin autorización. Por seguridad no se ejecutó ninguna acción.',
    'delegate-mismatch': '🔒 Enlace inválido o sin autorización. Por seguridad no se ejecutó ninguna acción.',
};

// #4631 — clase de gate (delegation-grant) que un grant firmado debe incluir para
// habilitar la delegación de acciones rápidas del bloqueo humano. El scope se valida
// contra `grant.payload.gateClasses`. Un grant con otra clase → rechazo fail-closed.
const DELEGATED_ACTION_GATE_CLASS = 'human-block-action';

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
 * @param {function} [deps.identityProvider] - (#4631) deriva SERVER-SIDE la identidad
 *   del ejecutor de Telegram → `{ operatorId }` | id string | null. Su PRESENCIA activa
 *   el modo delegado (fail-closed). Ausente → modo directo `dashboard-local` (legacy).
 * @param {object}   [deps.grantAuthority]  - (#4631) autoridad de grants firmados
 *   (`validate`/`consume`), típicamente `createGrantAuthority(...)`. Requerida en modo
 *   delegado; ausente → rechazo cerrado.
 * @param {object}   [deps.operatorAllowlist] - (#4631) allowlist de operadores
 *   (default: módulo de producción).
 */
function handle(req, res, deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const actionToken = deps.actionToken || require('./action-token');
    const humanBlock = deps.humanBlock || require('./human-block');
    const auditDeps = deps.auditDeps;
    // #4631 — modo delegado: activo SÓLO si el servidor inyecta `identityProvider`.
    // La identidad jamás viene del cliente web; el modo lo decide el wiring, no el payload.
    const identityProvider = typeof deps.identityProvider === 'function' ? deps.identityProvider : null;
    const grantAuthority = deps.grantAuthority || null;
    const operatorAllowlist = deps.operatorAllowlist || require('./operator-allowlist');
    const delegatedMode = !!identityProvider;

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

        // --- 8.5. gate de identidad delegada (#4631, split de #4581) --------------
        // Activo SÓLO en modo delegado (identityProvider inyectado = flujo Telegram).
        // La identidad se deriva SERVER-SIDE del update de Telegram, NUNCA del payload
        // del cliente. Orden fail-closed: identidad verificable → operador registrado →
        // grant firmado válido → delegate == ejecutor → scope permitido → consumo único.
        // Cualquier fallo → 401 con copy genérico y la acción NO se ejecuta.
        let auditExtra = {};
        if (delegatedMode) {
            auditExtra = { from: 'telegram-delegate' };
            const rejectDelegated = (reason) => {
                audit('unauthorized', { token_reason: reason, delegated: true, ...auditExtra });
                return sendJson(res, 401, {
                    ok: false, reason,
                    msg: TOKEN_REASON_COPY[reason] || TOKEN_REASON_COPY.invalid,
                });
            };

            // 8.5.a — identidad server-side. Jamás se lee de `data` (cliente).
            let identity = null;
            try { identity = identityProvider(req, data); } catch (_) { identity = null; }
            const operatorId = identity && typeof identity === 'object'
                ? (identity.operatorId || identity.id)
                : (typeof identity === 'string' ? identity : null);
            if (!operatorId) return rejectDelegated('identity');

            // 8.5.b — operador registrado en la allowlist cerrada (fail-closed).
            const operator = operatorAllowlist.getOperator(operatorId);
            if (!operator) return rejectDelegated('identity');

            // 8.5.c — grant firmado válido. Consume la API de delegation-grant, sin
            // reimplementar HMAC/nonce/exp. Sin autoridad inyectada → rechazo cerrado.
            const grant = data.delegation;
            if (!grantAuthority || typeof grantAuthority.validate !== 'function') {
                return rejectDelegated('delegate-mismatch');
            }
            let v;
            try { v = grantAuthority.validate(grant); } catch (_) { v = { ok: false }; }
            if (!v || !v.ok) return rejectDelegated('delegate-mismatch');
            const payload = v.payload || {};
            // Contexto de audit: quién actuó / en nombre de quién / qué grant.
            auditExtra = {
                from: 'telegram-delegate',
                delegate: operator.id,
                grantor: payload.grantor || null,
                grant_nonce: payload.nonce || null,
            };

            // 8.5.d — el ejecutor debe ser EXACTAMENTE el delegate del grant.
            if (String(payload.delegate) !== String(operator.id)) return rejectDelegated('delegate-mismatch');

            // 8.5.e — scope: el grant debe cubrir la clase de la acción del bloqueo humano.
            const gc = Array.isArray(payload.gateClasses) ? payload.gateClasses : [];
            if (!gc.includes(DELEGATED_ACTION_GATE_CLASS)) return rejectDelegated('delegate-mismatch');

            // 8.5.f — consumir el grant (un solo uso, atómico; re-valida binding y
            // anti-replay bajo lock). Deja evidencia en el audit chain de delegación.
            let c;
            try { c = grantAuthority.consume(grant, { delegate: operator.id }); }
            catch (_) { c = { ok: false }; }
            if (!c || !c.ok) return rejectDelegated('delegate-mismatch');
        }

        // --- 9. ejecutar ---
        const authorizedExtra = delegatedMode ? { delegated: true, ...auditExtra } : {};
        let result;
        try { result = humanBlock.executeQuickAction({ issue, action }); }
        catch (e) {
            audit('error', authorizedExtra);
            return sendJson(res, 500, { ok: false, msg: 'Error ejecutando acción: ' + e.message });
        }
        if (!result || !result.ok) {
            audit('error', authorizedExtra);
            return sendJson(res, 500, { ok: false, msg: (result && result.error) || 'error ejecutando acción' });
        }
        audit('authorized', authorizedExtra);
        log(`human-block-action: ${action} #${issue} → ${result.msg}`);
        return sendJson(res, 200, { ok: true, action, issue, msg: result.msg });
    });
}

module.exports = { handle, TOKEN_REASON_COPY, BODY_MAX_BYTES, ALLOWED_ORIGINS, DELEGATED_ACTION_GATE_CLASS };

'use strict';

// =============================================================================
// api.js — Handlers HTTP del banner de consumo anómalo del dashboard.
//
// Extracción de los endpoints que vivían inline en `dashboard.js` (#2892 PR-C)
// al módulo `lib/cost-anomaly/api.js` como parte del split de la ventana Costos
// (#3735, padre #3715). Patrón base: `lib/multi-provider/api.js` — `route()`
// que devuelve boolean y se montea antes del catch-all GET-only del server.
//
// Mount points (registrados desde dashboard.js):
//   GET  /api/cost-anomaly/state   → estado actual + visible + cap
//   POST /api/cost-anomaly/ack     → "Ya lo vi" → limpia el banner (idempotente)
//   POST /api/cost-anomaly/snooze  → body { hours: 1|4|24 }, cap 24h
//
// Defensa en profundidad (R4 / CA-3.4 — requisito de /security). Aunque el
// dashboard es localhost-only, el épico #3715 exige el mismo criterio CSRF que
// los wizards de multi-provider:
//   - D1 (`Sec-Fetch-Site`): los POST exigen origen propio. Si el browser manda
//     el header con un valor de ataque (`cross-site` / `same-site` /
//     `cross-origin`) → 403. Se permite `same-origin` (dashboard legítimo),
//     `none` (navegación directa) y la ausencia del header (curl / clientes no
//     browser que no lo emiten).
//   - D2 (`Content-Type`): si el POST trae body con Content-Type, debe ser
//     `application/json`. Un `application/x-www-form-urlencoded` (vector de
//     simple-CORS POST sin preflight) → 415. La ausencia de Content-Type se
//     permite para el `ack` idempotente sin body (cliente actual).
//   - D3 (`hours`): el snooze valida server-side `hours ∈ {1, 4, 24}`. Cualquier
//     otro valor → 400 (más estricto que el cap 24h de rest-mode-state, que
//     igualmente queda como segunda barrera).
//
// La lógica de estado (ack/snooze/getAlertState/cap) NO se reimplementa: se
// delega a `lib/rest-mode-state.js`, fuente única de verdad del snooze.
// =============================================================================

const path = require('node:path');

let restModeState = null;
try { restModeState = require('../rest-mode-state'); } catch { /* opcional */ }

// Whitelist server-side del snooze (D3). Coincide con los tres botones del UI
// (1h / 4h / 24h). Cualquier otro valor se rechaza con 400 ANTES de tocar el
// estado — un cliente roto o adversarial no puede inyectar duraciones raras.
const ALLOWED_SNOOZE_HOURS = Object.freeze([1, 4, 24]);

// Máximo de body que aceptamos en el snooze (mismo límite histórico del
// handler inline: 4KB es de sobra para `{ "hours": 24 }`).
const MAX_BODY_BYTES = 4 * 1024;

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    if (process.env.PIPELINE_STATE_DIR) return process.env.PIPELINE_STATE_DIR;
    // __dirname = .pipeline/lib/cost-anomaly → '..','..' = .pipeline
    return path.resolve(__dirname, '..', '..');
}

function noop() {}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

// --- Defensas CSRF compartidas por los POST ---------------------------------

// D1 — Sec-Fetch-Site. Devuelve null si pasa, o un objeto {status, payload} si
// hay que rechazar. Browsers modernos siempre lo mandan; clientes no-browser
// (curl) no lo mandan → se permite (no son vector CSRF).
function checkSecFetchSite(req) {
    const raw = req.headers && req.headers['sec-fetch-site'];
    if (!raw) return null; // ausente → cliente no-browser, permitido
    const site = String(raw).toLowerCase();
    if (site === 'same-origin' || site === 'none') return null;
    return {
        status: 403,
        payload: {
            ok: false,
            reason: 'cross_site_blocked',
            msg: `Sec-Fetch-Site '${site}' rechazado: solo same-origin.`,
        },
    };
}

// D2 — Content-Type. Si hay Content-Type, debe ser application/json. La
// ausencia se permite (ack sin body). Devuelve null si pasa o {status,payload}.
function checkContentType(req) {
    const raw = req.headers && req.headers['content-type'];
    if (!raw) return null; // sin body declarado → permitido (ack idempotente)
    const ct = String(raw).split(';')[0].trim().toLowerCase();
    if (ct === 'application/json') return null;
    return {
        status: 415,
        payload: {
            ok: false,
            reason: 'unsupported_media_type',
            msg: `Content-Type '${ct}' no soportado: usá application/json.`,
        },
    };
}

// Corre D1 + D2 en orden. Devuelve true si ya respondió con un rechazo.
function rejectIfUnsafe(req, res) {
    const d1 = checkSecFetchSite(req);
    if (d1) { sendJson(res, d1.status, d1.payload); return true; }
    const d2 = checkContentType(req);
    if (d2) { sendJson(res, d2.status, d2.payload); return true; }
    return false;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let aborted = false;
        req.on('data', (c) => {
            body += c;
            if (body.length > MAX_BODY_BYTES) {
                aborted = true;
                reject(new Error('body_too_large'));
                req.destroy();
            }
        });
        req.on('end', () => { if (!aborted) resolve(body); });
        req.on('error', (e) => { if (!aborted) reject(e); });
    });
}

// --- Handlers ---------------------------------------------------------------

function handleStateGet(req, res, opts) {
    const log = (opts && opts.log) || noop;
    if (!restModeState) {
        return sendJson(res, 503, { ok: false, msg: 'rest-mode-state no disponible' });
    }
    try {
        const pipelineDir = resolvePipelineDir(opts);
        const state = restModeState.getAlertState({ pipelineDir });
        const visible = restModeState.shouldShowBanner(state);
        sendJson(res, 200, {
            ok: true,
            state,
            visible,
            max_snooze_hours: restModeState.MAX_SNOOZE_HOURS,
        });
    } catch (e) {
        log(`cost-anomaly state fail: ${e.message}`);
        sendJson(res, 500, { ok: false, msg: e.message });
    }
}

function handleAckPost(req, res, opts) {
    const log = (opts && opts.log) || noop;
    if (rejectIfUnsafe(req, res)) return;
    if (!restModeState) {
        return sendJson(res, 503, { ok: false, msg: 'rest-mode-state no disponible' });
    }
    // No necesitamos body — el ack es siempre el mismo gesto idempotente.
    try {
        const pipelineDir = resolvePipelineDir(opts);
        const result = restModeState.ackAlert({ pipelineDir });
        log(`Cost-anomaly ack desde dashboard (acked=${result.acked})`);
        sendJson(res, 200, { ok: true, acked: result.acked, state: result.state });
    } catch (e) {
        log(`cost-anomaly ack fail: ${e.message}`);
        sendJson(res, 500, { ok: false, msg: e.message });
    }
}

function handleSnoozePost(req, res, opts) {
    const log = (opts && opts.log) || noop;
    if (rejectIfUnsafe(req, res)) return;
    if (!restModeState) {
        return sendJson(res, 503, { ok: false, msg: 'rest-mode-state no disponible' });
    }
    readBody(req).then((body) => {
        let payload;
        try {
            payload = body ? JSON.parse(body) : {};
        } catch (e) {
            return sendJson(res, 400, { ok: false, reason: 'invalid_json', msg: e.message });
        }
        const hours = Number(payload.hours);
        // D3 — whitelist estricta {1, 4, 24}. Cualquier otro valor (incluido
        // 999, 0, NaN o negativos) → 400 antes de tocar el estado.
        if (!ALLOWED_SNOOZE_HOURS.includes(hours)) {
            return sendJson(res, 400, {
                ok: false,
                reason: 'invalid_hours',
                allowed: ALLOWED_SNOOZE_HOURS,
                msg: `hours=${payload.hours} inválido: permitidos ${ALLOWED_SNOOZE_HOURS.join(', ')}.`,
            });
        }
        try {
            const pipelineDir = resolvePipelineDir(opts);
            const result = restModeState.snoozeAlert(hours, { pipelineDir });
            if (!result.ok) {
                // 422 si el estado rechaza (alert no activa, cap — segunda
                // barrera además de D3). El frontend muestra un toast.
                return sendJson(res, 422, {
                    ok: false,
                    reason: result.reason,
                    cap_hours: result.cap_hours || restModeState.MAX_SNOOZE_HOURS,
                    state: result.state,
                });
            }
            log(`Cost-anomaly snooze desde dashboard (hours=${hours}, until=${result.state.snoozed_until})`);
            sendJson(res, 200, { ok: true, state: result.state });
        } catch (e) {
            log(`cost-anomaly snooze fail: ${e.message}`);
            sendJson(res, 500, { ok: false, msg: e.message });
        }
    }).catch((e) => {
        const reason = e && e.message === 'body_too_large' ? 'body_too_large' : 'read_error';
        sendJson(res, 400, { ok: false, reason, msg: (e && e.message) || String(e) });
    });
}

// --- Router -----------------------------------------------------------------

// route(req, res, opts) → boolean. true si manejó la request (se debe `return`
// en el server), false si la URL no es nuestra. `opts.pipelineDir` y `opts.log`
// son inyectables (dashboard.js los pasa; los tests los overridean).
function route(req, res, opts) {
    const url = (req && req.url) || '';
    const pathPart = url.split('?')[0];
    if (!pathPart.startsWith('/api/cost-anomaly/')) return false;

    if (pathPart === '/api/cost-anomaly/state' && req.method === 'GET') {
        handleStateGet(req, res, opts);
        return true;
    }
    if (pathPart === '/api/cost-anomaly/ack' && req.method === 'POST') {
        handleAckPost(req, res, opts);
        return true;
    }
    if (pathPart === '/api/cost-anomaly/snooze' && req.method === 'POST') {
        handleSnoozePost(req, res, opts);
        return true;
    }
    // Prefijo nuestro pero ruta/método desconocido → 404 explícito (cerramos la
    // request para que no caiga al catch-all GET-only que serviría HTML).
    sendJson(res, 404, {
        ok: false,
        reason: 'not_found',
        msg: `Ruta ${req.method} ${pathPart} no existe en cost-anomaly API.`,
    });
    return true;
}

module.exports = {
    route,
    handleStateGet,
    handleAckPost,
    handleSnoozePost,
    checkSecFetchSite,
    checkContentType,
    ALLOWED_SNOOZE_HOURS,
    MAX_BODY_BYTES,
};

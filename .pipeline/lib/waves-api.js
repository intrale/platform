// =============================================================================
// waves-api.js — Superficie HTTP `/api/waves/*` para la gestión de olas (#4372,
// Ola 8.3). Implementación de referencia del contrato agnóstico documentado en
// `docs/pipeline/waves-api.md`.
//
// DISEÑO (recomendación del arquitecto):
//   - Dominio primero, HTTP después. TODA la lógica transaccional vive en
//     `lib/waves.js` (lock + write atómico ya probados). Este módulo SÓLO valida
//     input, resuelve auth/CSRF/ETag/rate-limit y llama al dominio.
//   - Contrato agnóstico: expone recursos lógicos (`wave`, `issue-association`,
//     `priority/order`, `roadmap-status`). NUNCA traduce input del cliente a
//     rutas de `.pipeline/**` (A03 — anti path-traversal / IDOR).
//   - Concurrencia optimista (CA-4/UX-3): las lecturas exponen `version` (ETag);
//     las mutaciones exigen `If-Match: <version>`. Mismatch → 409 devolviendo la
//     versión vigente, sin escribir.
//   - Auth de referencia (CA-5/A01): el servidor Node no tiene Cognito hoy. La
//     credencial de operador se modela con el CSRF-token del dashboard
//     (double-submit header + cookie, reusando `kill-agent-csrf`). Ausencia total
//     de credencial → 401; credencial presente pero inválida → 403. El contrato
//     queda portable: una migración a Ktor usaría `SecuredFunction` + roles.
//   - Auditoría (CA-6/A09): cada mutación deja una entrada encadenada verificable
//     con `verifyChain` vía `lib/audit-log.appendChained`.
//   - Errores estructurados (UX-2): body `{ code, message, field? }` con `message`
//     en español. Nunca stack traces ni paths internos (A05).
//
// Ejecutar tests:  node --test .pipeline/lib/__tests__/waves-api-*.test.js
// =============================================================================
'use strict';

const path = require('path');

let waves = null;
try { waves = require('./waves'); } catch { /* opcional — degrada a 503 */ }
let auditLog = null;
try { auditLog = require('./audit-log'); } catch { /* opcional */ }
let csrf = null;
try { csrf = require('./kill-agent-csrf'); } catch { /* opcional */ }
let issueOrder = null;
try { issueOrder = require('./issue-order'); } catch { /* opcional */ }

// -----------------------------------------------------------------------------
// Constantes de política (server-side, jamás del request).
// -----------------------------------------------------------------------------
const WAVES_BODY_MAX_BYTES = 8192;          // create trae array de issues; modesto.
const WAVES_RATE_MAX = 30;                  // mutaciones por ventana…
const WAVES_RATE_WINDOW_MS = 60 * 1000;     // …de 60s (anti-abuso, CA-7).
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;  // reintentos con misma key dentro de 10min.
const IDEMPOTENCY_MAX = 500;                // cap del cache in-memory.
const FIXED_ACTOR = 'operador-local';       // actor grabado server-side (NUNCA del body).
const AUDIT_SOURCE = 'api:waves';

// -----------------------------------------------------------------------------
// Estado in-memory (rate-limit + idempotencia). Reseteable para tests.
// -----------------------------------------------------------------------------
const _rateHits = new Map();       // ip → number[] (timestamps dentro de la ventana)
const _idempotency = new Map();    // key → { status, body, expiresAt }

function _resetForTests() {
    _rateHits.clear();
    _idempotency.clear();
    if (csrf && typeof csrf._resetForTests === 'function') csrf._resetForTests();
}

// -----------------------------------------------------------------------------
// Helpers de red (replicados localmente para no acoplar con dashboard-routes).
// -----------------------------------------------------------------------------
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function auditFile() {
    return path.join(pipelineDir(), 'audit', 'waves-mutations.jsonl');
}

function isLoopbackReq(req) {
    const ra = (req && req.socket && req.socket.remoteAddress) || '';
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

// Sec-Fetch-Site: si está presente debe ser same-origin. Ausencia se acepta
// (curl / clientes no-browser) — la barrera dura es loopback. Mismo criterio que
// el resto de endpoints mutantes del dashboard.
function isSameOriginFetch(req) {
    const site = req && req.headers && req.headers['sec-fetch-site'];
    if (!site) return true;
    return site === 'same-origin';
}

function header(req, name) {
    const lower = name.toLowerCase();
    return (req && req.headers && req.headers[lower]) || null;
}

function send(res, status, payload) {
    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': Buffer.byteLength(body),
    };
    // ETag en respuestas con versión (lecturas + resultado de mutación).
    if (payload && typeof payload === 'object' && typeof payload.version === 'string') {
        headers.ETag = `"${payload.version}"`;
    }
    res.writeHead(status, headers);
    res.end(body);
}

function sendError(res, status, code, message, field) {
    const payload = { code, message };
    if (field) payload.field = field;
    send(res, status, payload);
}

function readBodyCapped(req, cap, onDone) {
    let size = 0;
    const chunks = [];
    let finished = false;
    const finish = (err, body) => { if (finished) return; finished = true; onDone(err, body); };
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > cap) {
            finish(new Error('body_too_large'));
            try { req.destroy(); } catch { /* noop */ }
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => finish(e));
}

// -----------------------------------------------------------------------------
// Rate limit — ventana deslizante por IP. now inyectable para tests.
// -----------------------------------------------------------------------------
function rateLimitAllow(ip, now = Date.now()) {
    const key = ip || 'unknown';
    const cutoff = now - WAVES_RATE_WINDOW_MS;
    const hits = (_rateHits.get(key) || []).filter((t) => t > cutoff);
    if (hits.length >= WAVES_RATE_MAX) {
        _rateHits.set(key, hits);
        return false;
    }
    hits.push(now);
    _rateHits.set(key, hits);
    return true;
}

// -----------------------------------------------------------------------------
// Idempotencia — cache in-memory con TTL. now inyectable para tests.
// -----------------------------------------------------------------------------
function idempotencyGet(key, now = Date.now()) {
    if (!key) return null;
    const hit = _idempotency.get(key);
    if (!hit) return null;
    if (hit.expiresAt < now) { _idempotency.delete(key); return null; }
    return hit;
}

function idempotencyPut(key, status, body, now = Date.now()) {
    if (!key) return;
    if (_idempotency.size >= IDEMPOTENCY_MAX) {
        // Evicción simple del más viejo (orden de inserción del Map).
        const oldest = _idempotency.keys().next().value;
        if (oldest !== undefined) _idempotency.delete(oldest);
    }
    _idempotency.set(key, { status, body, expiresAt: now + IDEMPOTENCY_TTL_MS });
}

// -----------------------------------------------------------------------------
// Auth de referencia (CSRF double-submit == credencial de operador).
//   - Sin header NI cookie → 401 (anónimo, sin credencial).
//   - Credencial presente pero inválida/mismatch/expirada → 403.
// -----------------------------------------------------------------------------
function checkAuth(req) {
    if (!csrf) {
        // Sin módulo CSRF no podemos verificar credencial → fail-closed.
        return { ok: false, status: 503, code: 'module_unavailable', message: 'El verificador de credenciales no está disponible.' };
    }
    const headerTok = csrf.readHeader(req, 'x-csrf-token');
    const cookieTok = csrf.readCookie(req, csrf.COOKIE_NAME);
    if (!headerTok && !cookieTok) {
        return { ok: false, status: 401, code: 'unauthorized', message: 'Falta credencial de operador (token CSRF). Pedí uno en /api/kill-agent/csrf-token.' };
    }
    if (!headerTok || !cookieTok || headerTok !== cookieTok || !csrf.verifyToken(headerTok)) {
        return { ok: false, status: 403, code: 'forbidden', message: 'Credencial inválida o sin rol operador.' };
    }
    return { ok: true };
}

// -----------------------------------------------------------------------------
// Normalización display-ready (UX-1). Whitelist explícita de campos: nada de
// paths, timestamps internos ni estructura de waves.json se filtra (A05).
// -----------------------------------------------------------------------------
function mapState(status) {
    if (status === 'active') return 'active';
    if (status === 'archived') return 'done';
    return 'planned';
}

function toDisplayIssues(issues) {
    return (Array.isArray(issues) ? issues : []).map((i) => ({
        number: Number(i && i.number),
        status: (i && typeof i.status === 'string') ? i.status : 'pending',
    })).filter((i) => Number.isInteger(i.number) && i.number > 0);
}

function toDisplayWave(w) {
    return {
        number: Number(w.number),
        name: (typeof w.name === 'string') ? w.name : null,
        goal: (typeof w.goal === 'string') ? w.goal : null,
        state: mapState(w.status),
        window_minutes: Number.isInteger(w.window_minutes) ? w.window_minutes : null,
        concurrency_max: Number.isInteger(w.concurrency_max) ? w.concurrency_max : null,
        issue_count: Array.isArray(w.issues) ? w.issues.length : 0,
        issues: toDisplayIssues(w.issues),
    };
}

// Allowlist vigente derivada de la ola activa SIN el efecto colateral de
// `waves.getAllowlist()` (que dispara alerta Telegram cuando está vacía).
function activeAllowlist() {
    const active = waves.getActiveWave();
    if (active && Array.isArray(active.issues)) {
        return active.issues
            .filter((i) => i.status !== 'completed')
            .map((i) => Number(i.number))
            .filter((n) => Number.isInteger(n) && n > 0);
    }
    return [];
}

// -----------------------------------------------------------------------------
// Mapeo de errores del dominio → respuesta HTTP estructurada.
// -----------------------------------------------------------------------------
function mapDomainError(res, e) {
    const code = e && e.code;
    switch (code) {
        case 'EWAVES_SHAPE':
            return sendError(res, 400, 'invalid_input', 'Datos inválidos para la operación.', fieldFromMessage(e.message));
        case 'EWAVES_BOUNDS':
            return sendError(res, 400, 'out_of_bounds', 'Un valor está fuera del rango permitido.', fieldFromMessage(e.message));
        case 'EWAVES_DUPLICATE_NAME':
            return sendError(res, 409, 'duplicate_name', 'Ya existe una ola con ese nombre.', 'name');
        case 'EWAVES_DUPLICATE_ISSUE':
            return sendError(res, 409, 'duplicate_issue', 'El issue ya está asociado a otra ola.', 'issue');
        case 'EWAVES_NOT_FOUND':
            return sendError(res, 404, 'not_found', 'La ola indicada no existe.', 'wave');
        case 'EWAVES_VERSION_CONFLICT': {
            const payload = {
                code: 'version_conflict',
                message: 'El estado cambió desde tu última lectura. Refrescá y reintentá.',
            };
            if (e.currentVersion) payload.version = e.currentVersion;
            return send(res, 409, payload);
        }
        default:
            return sendError(res, 500, 'internal_error', 'Error interno procesando la operación.');
    }
}

// Deriva el campo culpable del mensaje del dominio para que el UI resalte el
// input correcto (UX-2). Match literal, sin RegExp dinámico.
function fieldFromMessage(msg) {
    const m = String(msg || '').toLowerCase();
    if (m.includes('name')) return 'name';
    if (m.includes('window_minutes')) return 'window_minutes';
    if (m.includes('concurrency_max')) return 'concurrency_max';
    if (m.includes('issue')) return 'issues';
    if (m.includes('wavenumber')) return 'wave';
    return undefined;
}

// -----------------------------------------------------------------------------
// Auditoría — best-effort; un fallo de audit NO debe romper la mutación aplicada,
// pero sí quedar logueado.
// -----------------------------------------------------------------------------
function audit(entry) {
    if (!auditLog) return;
    try {
        auditLog.appendChained({ file: auditFile(), entry: { ...entry, actor: FIXED_ACTOR, source: AUDIT_SOURCE } });
    } catch (e) {
        try { console.error(JSON.stringify({ event: 'waves_audit_error', msg: e && e.message, ts: new Date().toISOString() })); } catch { /* noop */ }
    }
}

// -----------------------------------------------------------------------------
// Router.
// -----------------------------------------------------------------------------
const NUM_RE = /^\d+$/;

// Devuelve descriptor de ruta o null si el path no pertenece a nuestra superficie.
// { surface:true, kind:'read'|'mutation'|'unknown', action, wave?, issue?, method }
function matchRoute(method, pathnameOnly) {
    const segs = pathnameOnly.split('/').filter(Boolean); // ['api', ...]
    if (segs[0] !== 'api') return null;

    // /api/roadmap/status
    if (segs[1] === 'roadmap') {
        if (segs.length === 3 && segs[2] === 'status') {
            return { surface: true, kind: 'read', action: 'roadmap-status' };
        }
        return null;
    }
    if (segs[1] !== 'waves') return null;

    // /api/waves
    if (segs.length === 2) {
        if (method === 'GET') return { surface: true, kind: 'read', action: 'list' };
        if (method === 'POST') return { surface: true, kind: 'mutation', action: 'create', method: 'POST' };
        return { surface: true, kind: 'unknown', action: 'list-or-create' };
    }

    // /api/waves/active
    if (segs.length === 3 && segs[2] === 'active') {
        return { surface: true, kind: 'read', action: 'active' };
    }

    // A partir de acá el 3er segmento DEBE ser un número de ola (A03: sólo enteros).
    if (!NUM_RE.test(segs[2])) {
        return { surface: true, kind: 'bad-id', which: 'wave' };
    }
    const wave = Number(segs[2]);

    // /api/waves/{n}
    if (segs.length === 3) {
        if (method === 'GET') return { surface: true, kind: 'read', action: 'detail', wave };
        if (method === 'PATCH') return { surface: true, kind: 'mutation', action: 'edit', wave, method: 'PATCH' };
        return { surface: true, kind: 'unknown', action: 'detail-or-edit', wave };
    }

    // /api/waves/{n}/issues  |  /api/waves/{n}/order
    if (segs.length === 4) {
        if (segs[3] === 'issues') {
            if (method === 'POST') return { surface: true, kind: 'mutation', action: 'associate', wave, method: 'POST' };
            return { surface: true, kind: 'unknown', action: 'associate', wave };
        }
        if (segs[3] === 'order') {
            if (method === 'PUT') return { surface: true, kind: 'mutation', action: 'reorder', wave, method: 'PUT' };
            return { surface: true, kind: 'unknown', action: 'reorder', wave };
        }
        return null;
    }

    // /api/waves/{n}/issues/{issue}
    if (segs.length === 5 && segs[3] === 'issues') {
        if (!NUM_RE.test(segs[4])) {
            return { surface: true, kind: 'bad-id', which: 'issue' };
        }
        const issue = Number(segs[4]);
        if (method === 'DELETE') return { surface: true, kind: 'mutation', action: 'remove', wave, issue, method: 'DELETE' };
        return { surface: true, kind: 'unknown', action: 'remove', wave, issue };
    }

    return null;
}

// -----------------------------------------------------------------------------
// Handlers de lectura.
// -----------------------------------------------------------------------------
function handleRead(res, route) {
    if (!waves) {
        return sendError(res, 503, 'module_unavailable', 'La gestión de olas no está disponible.');
    }
    try {
        const version = waves.getVersion();
        if (route.action === 'list') {
            return send(res, 200, { version, waves: waves.listWaves().map(toDisplayWave) });
        }
        if (route.action === 'active') {
            const active = waves.getActiveWave();
            // UX-1: estado explícito, nunca ambiguo ni 500.
            return send(res, 200, { version, active: active ? toDisplayWave({ ...active, status: 'active' }) : null });
        }
        if (route.action === 'detail') {
            const found = waves.listWaves().find((w) => Number(w.number) === route.wave);
            if (!found) return sendError(res, 404, 'not_found', 'La ola indicada no existe.', 'wave');
            return send(res, 200, { version, wave: toDisplayWave(found) });
        }
        if (route.action === 'roadmap-status') {
            return send(res, 200, {
                version,
                horizon: waves.getHorizon(5).map(toDisplayWave),
                allowlist: activeAllowlist(),
            });
        }
        return sendError(res, 404, 'not_found', 'Recurso no encontrado.');
    } catch (e) {
        try { console.error(JSON.stringify({ event: 'waves_read_error', msg: e && e.message, ts: new Date().toISOString() })); } catch { /* noop */ }
        return sendError(res, 500, 'internal_error', 'Error interno leyendo el estado de olas.');
    }
}

// -----------------------------------------------------------------------------
// Dispatch de mutación al dominio (ya validado el cinturón de gates + body).
// -----------------------------------------------------------------------------
function dispatchMutation(res, route, parsed, ifMatch) {
    const meta = { updated_by: FIXED_ACTOR, source: AUDIT_SOURCE, expectedVersion: ifMatch };
    try {
        if (route.action === 'create') {
            const spec = {
                name: parsed.name,
                goal: parsed.goal,
                issues: parsed.issues,
                concurrency_max: parsed.concurrency_max,
                window_minutes: parsed.window_minutes,
            };
            const r = waves.createPlannedWave(spec, meta);
            const body = { version: r.version || waves.getVersion(), wave: toDisplayWave({ ...r.wave, status: 'planned' }) };
            audit({ action: 'create', wave: r.waveNumber, version: body.version });
            return { status: 201, body };
        }
        if (route.action === 'edit') {
            const patch = {};
            for (const k of ['name', 'goal', 'window_minutes', 'concurrency_max']) {
                if (parsed[k] !== undefined) patch[k] = parsed[k];
            }
            const r = waves.editWave(route.wave, patch, meta);
            const body = { version: r.version, wave: toDisplayWave({ ...r.wave, status: 'planned' }) };
            audit({ action: 'edit', wave: route.wave, version: body.version });
            return { status: 200, body };
        }
        if (route.action === 'associate') {
            const issueNum = parsed.issue != null ? parsed.issue : parsed.number;
            const r = waves.addIssueToWave(route.wave, { number: issueNum }, meta);
            const body = { version: r.version, wave: route.wave, issue: r.issue, added: r.added };
            audit({ action: 'associate', wave: route.wave, issue: r.issue, added: r.added, version: body.version });
            return { status: 200, body };
        }
        if (route.action === 'remove') {
            const r = waves.removeIssueFromWave(route.wave, route.issue, meta);
            const body = { version: r.version, wave: route.wave, issue: r.issue, removed: r.removed };
            audit({ action: 'remove', wave: route.wave, issue: r.issue, removed: r.removed, version: body.version });
            return { status: 200, body };
        }
        if (route.action === 'reorder') {
            return dispatchReorder(route, parsed, ifMatch);
        }
        return { errorStatus: 404, code: 'not_found', message: 'Recurso no encontrado.' };
    } catch (e) {
        return { domainError: e };
    }
}

// Reorden de prioridades dentro de la ola (CA-3/UX-4). Reusa `issue-order.js`
// (NO reimplementa): valida que cada id sea entero y pertenezca a la ola, luego
// aplica `setOrder` sobre el orden manual global y devuelve el orden resultante.
function dispatchReorder(route, parsed, ifMatch) {
    if (!issueOrder) {
        return { errorStatus: 503, code: 'module_unavailable', message: 'El módulo de orden no está disponible.' };
    }
    // If-Match contra la versión del estado de olas (concurrencia optimista).
    const current = waves.getVersion();
    if (ifMatch !== current) {
        return { errorStatus: 409, code: 'version_conflict', message: 'El estado cambió desde tu última lectura. Refrescá y reintentá.', version: current };
    }
    const wave = waves.listWaves().find((w) => Number(w.number) === route.wave);
    if (!wave) {
        return { errorStatus: 404, code: 'not_found', message: 'La ola indicada no existe.', field: 'wave' };
    }
    const requested = Array.isArray(parsed.order) ? parsed.order : null;
    if (!requested) {
        return { errorStatus: 400, code: 'invalid_input', message: 'Se requiere el arreglo "order" con los issues.', field: 'order' };
    }
    // A03: SOLO enteros positivos, y cada uno debe pertenecer a la ola.
    const waveIssues = new Set(toDisplayIssues(wave.issues).map((i) => i.number));
    const cleaned = [];
    for (const raw of requested) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0 || String(raw).trim() !== String(n)) {
            return { errorStatus: 400, code: 'invalid_input', message: 'El orden contiene un id no numérico.', field: 'order' };
        }
        if (!waveIssues.has(n)) {
            return { errorStatus: 400, code: 'invalid_input', message: `El issue #${n} no pertenece a la ola ${route.wave}.`, field: 'order' };
        }
        if (cleaned.includes(n)) {
            return { errorStatus: 400, code: 'invalid_input', message: `El issue #${n} está duplicado en el orden.`, field: 'order' };
        }
        cleaned.push(n);
    }
    // El archivo de orden respeta PIPELINE_DIR_OVERRIDE (aislamiento en tests y
    // coherencia con el resto de waves-api). En producción resuelve al mismo
    // archivo que usa el dashboard.
    const orderFile = path.join(pipelineDir(), 'issue-manual-order.json');
    const state = issueOrder.load(orderFile);
    issueOrder.setOrder(state, cleaned.map(String), orderFile);
    // UX-4: devolver el orden resultante de los issues de la ola.
    const fresh = issueOrder.load(orderFile);
    const resultOrder = fresh.order.map(Number).filter((n) => waveIssues.has(n));
    audit({ action: 'reorder', wave: route.wave, order: cleaned, version: current });
    return { status: 200, body: { version: current, wave: route.wave, order: resultOrder } };
}

// -----------------------------------------------------------------------------
// Handler de mutación (cinturón de gates, mismo orden que handleAlertMutation).
// -----------------------------------------------------------------------------
function handleMutation(req, res, route) {
    // Gate 0 — módulo de dominio disponible.
    if (!waves) {
        return sendError(res, 503, 'module_unavailable', 'La gestión de olas no está disponible.');
    }
    // Gate 1 — loopback (defense-in-depth, independiente del bind).
    if (!isLoopbackReq(req)) {
        return sendError(res, 403, 'forbidden', 'Acceso permitido sólo desde localhost.');
    }
    // Gate 2 — same-origin (anti-CSRF).
    if (!isSameOriginFetch(req)) {
        return sendError(res, 403, 'forbidden', 'Origen cruzado no permitido.');
    }
    // Gate 3 — auth por credencial de operador (401 sin credencial / 403 inválida).
    const auth = checkAuth(req);
    if (!auth.ok) {
        return sendError(res, auth.status, auth.code, auth.message);
    }
    // Gate 4 — rate limit (CA-7).
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!rateLimitAllow(ip)) {
        res.setHeader && res.setHeader('Retry-After', String(Math.ceil(WAVES_RATE_WINDOW_MS / 1000)));
        return sendError(res, 429, 'rate_limited', 'Demasiadas operaciones. Reintentá en un momento.');
    }
    // Gate 5 — If-Match obligatorio (CA-4) para mutaciones sobre recursos
    // EXISTENTES (edit/associate/remove/reorder). El create de colección NO lo
    // exige: es un recurso nuevo (no hay lost-update posible) y su
    // idempotencia se cubre con el nombre único + Idempotency-Key. Ausente en una
    // mutación que lo requiere → 428 Precondition Required.
    let ifMatchClean; // undefined → el dominio saltea la verificación de versión.
    if (route.action !== 'create') {
        const ifMatch = header(req, 'if-match');
        if (!ifMatch) {
            return sendError(res, 428, 'precondition_required', 'Falta el header If-Match con la versión actual del estado.');
        }
        ifMatchClean = String(ifMatch).replace(/^"|"$/g, '');
    }

    // Gate 6 — Idempotency-Key (si viene y ya la vimos, replay del resultado).
    const idemKey = header(req, 'idempotency-key');
    const cached = idempotencyGet(idemKey);
    if (cached) {
        return send(res, cached.status, cached.body);
    }

    // DELETE no lleva body: dispatch directo.
    if (req.method === 'DELETE') {
        const out = dispatchMutation(res, route, {}, ifMatchClean);
        return finishMutation(res, out, idemKey);
    }

    // Gate 7 — Content-Type JSON.
    const ct = header(req, 'content-type') || '';
    if (!/^application\/json\b/i.test(ct)) {
        return sendError(res, 415, 'unsupported_media_type', 'El Content-Type debe ser application/json.');
    }
    // Gate 8 — body con cap.
    readBodyCapped(req, WAVES_BODY_MAX_BYTES, (err, raw) => {
        if (err) {
            const tooLarge = err.message === 'body_too_large';
            return sendError(res, tooLarge ? 413 : 400, tooLarge ? 'payload_too_large' : 'bad_request',
                tooLarge ? 'El cuerpo del pedido es demasiado grande.' : 'No se pudo leer el cuerpo del pedido.');
        }
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return sendError(res, 400, 'invalid_input', 'El cuerpo debe ser un objeto JSON.');
        }
        const out = dispatchMutation(res, route, parsed, ifMatchClean);
        return finishMutation(res, out, idemKey);
    });
    return true;
}

function finishMutation(res, out, idemKey) {
    if (!out) return true; // ya respondió el dispatcher
    if (out.domainError) {
        mapDomainError(res, out.domainError);
        return true;
    }
    if (out.errorStatus) {
        const payload = { code: out.code, message: out.message };
        if (out.field) payload.field = out.field;
        if (out.version) payload.version = out.version;
        send(res, out.errorStatus, payload);
        return true;
    }
    idempotencyPut(idemKey, out.status, out.body);
    send(res, out.status, out.body);
    return true;
}

// -----------------------------------------------------------------------------
// Entry point público. Devuelve true si la request pertenece a la superficie
// `/api/waves/*` (o `/api/roadmap/status`) y fue manejada; false si no.
// -----------------------------------------------------------------------------
function handleWavesApi(req, res, ctx) { // eslint-disable-line no-unused-vars
    const pathnameOnly = (req.url || '').split('?')[0];
    const route = matchRoute(req.method, pathnameOnly);
    if (!route || !route.surface) return false;

    if (route.kind === 'bad-id') {
        sendError(res, 400, 'invalid_id', 'El identificador debe ser numérico.', route.which);
        return true;
    }
    if (route.kind === 'unknown') {
        sendError(res, 405, 'method_not_allowed', 'Método no permitido para este recurso.');
        return true;
    }
    if (route.kind === 'read') {
        // Lecturas: loopback defense-in-depth, sin credencial (rol lectura).
        if (!isLoopbackReq(req)) {
            sendError(res, 403, 'forbidden', 'Acceso permitido sólo desde localhost.');
            return true;
        }
        handleRead(res, route);
        return true;
    }
    if (route.kind === 'mutation') {
        handleMutation(req, res, route);
        return true;
    }
    return false;
}

module.exports = {
    handleWavesApi,
    // Exportados para tests.
    _internal: {
        matchRoute,
        toDisplayWave,
        mapState,
        rateLimitAllow,
        checkAuth,
        idempotencyGet,
        idempotencyPut,
        activeAllowlist,
        auditFile,
        WAVES_BODY_MAX_BYTES,
        WAVES_RATE_MAX,
        WAVES_RATE_WINDOW_MS,
        FIXED_ACTOR,
        _resetForTests,
    },
};

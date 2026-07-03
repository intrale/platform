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
// #4437 — editor de allowlist en la ventana Roadmap. Reutiliza el gate + audit
// de partial-pause y la resolución recursiva de deps ya probada. Todos opcionales
// (degradan a 503 si el checkout no los tiene).
let partialPause = null;
try { partialPause = require('./partial-pause'); } catch { /* opcional */ }
let ppDeps = null;
try { ppDeps = require('./partial-pause-deps'); } catch { /* opcional */ }

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

// #4437 — seam de inyección para tests del editor de allowlist. Permite mockear
// el runner de `gh` (spawnSync) y aislar el cache de deps en un tmp dir sin
// tocar red ni el filesystem del repo. En producción queda null → default.
let _depsOptsOverride = null;
function _setDepsOptsForTests(o) { _depsOptsOverride = o || null; }
function depsOpts() { return _depsOptsOverride || {}; }

const ALLOWLIST_SOURCE = 'dashboard:roadmap:allowlist';       // #4437 (KNOWN_SOURCES)
const ALLOWLIST_AUTHORIZED_BY = 'dashboard:roadmap:allowlist'; // #4437 (AUTHORIZED_BY enum)

function _resetForTests() {
    _rateHits.clear();
    _idempotency.clear();
    _depsOptsOverride = null;
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
        case 'EWAVES_ACTIVE_LOCKED':
            // Política A04 (#4383): no se desasocian issues de la ola activa.
            return sendError(res, 409, 'active_wave_locked', 'No se pueden desasociar issues de la ola activa; solo de olas planificadas.', 'wave');
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

    // /api/roadmap/status  |  /api/roadmap/allowlist[/preview|/add|/remove]  (#4437)
    if (segs[1] === 'roadmap') {
        if (segs.length === 3 && segs[2] === 'status') {
            return { surface: true, kind: 'read', action: 'roadmap-status' };
        }
        // #4437 — editor de allowlist de la ola desde la ventana Roadmap.
        if (segs[2] === 'allowlist') {
            // GET /api/roadmap/allowlist → lectura enriquecida (loopback, sin auth).
            if (segs.length === 3) {
                if (method === 'GET') return { surface: true, kind: 'read', action: 'allowlist-read' };
                return { surface: true, kind: 'unknown', action: 'allowlist-read' };
            }
            // POST /api/roadmap/allowlist/{preview|add|remove} → mutación (cinturón completo).
            // `preview` es dry-run (NO persiste) pero pasa por los mismos 3 gates
            // (loopback/same-origin/auth) para no filtrar el grafo de deps (A01).
            if (segs.length === 4) {
                const op = segs[3];
                if (op === 'preview' || op === 'add' || op === 'remove') {
                    if (method === 'POST') return { surface: true, kind: 'mutation', action: `allowlist-${op}`, method: 'POST' };
                    return { surface: true, kind: 'unknown', action: `allowlist-${op}` };
                }
            }
            return null;
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
// #4437 — Editor de allowlist de la ola (ventana Roadmap).
//
// Toda la lógica pesada se reutiliza de módulos ya mergeados:
//   - lectura/persistencia de la allowlist: lib/partial-pause (gate + audit).
//   - arrastre recursivo de deps abiertas: lib/partial-pause-deps (caps depth/
//     nodes/ciclo ya internos).
//   - warning padre-sin-hijos / desync waves↔partial: lib/desync-detector.
//
// Invariantes (CA-3/CA-6/A04):
//   - NUNCA se escribe `.partial-pause.json` con fs directo: SIEMPRE vía
//     partialPause.setPartialPause() con authorizedBy ∈ enum cerrado.
//   - NUNCA se escribe `waves.json` desde acá (separación intencional #3518/#4439).
//   - El preview es dry-run puro: no persiste ni dispara efectos colaterales.
// -----------------------------------------------------------------------------
const ALLOWLIST_ACTIONS = new Set(['allowlist-preview', 'allowlist-add', 'allowlist-remove']);

// Allowlist vigente exacta (raw) del marker, sin el mapeo a `running` de
// getPipelineMode(). Coacciona a enteros positivos (defensa en profundidad).
function currentAllowlist() {
    if (!partialPause) return [];
    try {
        return (partialPause.readPreviousAllowlist() || [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
    } catch { return []; }
}

// A03 — parseo/validación de los issues del body EN EL BORDE HTTP, antes de
// tocar `resolveOpenDeps`/`setPartialPause`. Rechaza NaN/negativos/no enteros.
// Devuelve { ids } o { error: {status, code, message, field} }.
function parseIssueIds(parsed) {
    let raw;
    if (Array.isArray(parsed.issues)) raw = parsed.issues;
    else if (parsed.issue != null) raw = [parsed.issue];
    else raw = [];
    const ids = [];
    for (const item of raw) {
        // Rechazo estricto: sólo enteros positivos. `Number('12abc')` → NaN;
        // floats y strings con basura también caen. No confiar en coerción downstream.
        const n = Number(item);
        if (!Number.isInteger(n) || n <= 0 || String(item).trim() !== String(n)) {
            return { error: { status: 400, code: 'bad-id', message: 'Cada issue debe ser un entero positivo.', field: 'issues' } };
        }
        ids.push(n);
    }
    if (ids.length === 0) {
        return { error: { status: 400, code: 'invalid_input', message: 'Se requiere al menos un issue en "issues".', field: 'issues' } };
    }
    return { ids: [...new Set(ids)] };
}

// Resolución recursiva del arrastre para un set candidato. Reutiliza
// resolveOpenDeps (que ya recurre con caps depth/nodes/ciclo). A diferencia de
// findMissingDeps, conserva `reason` para exponer "truncado" honesto (CA-2/A05).
// Devuelve { missing:{[issue]:deps[]}, truncado, reason }.
function computeDrag(candidate) {
    const allowed = new Set(candidate.map(Number));
    const missing = {};
    let truncado = false;
    let reason = null;
    for (const issue of allowed) {
        const r = ppDeps.resolveOpenDeps(issue, depsOpts());
        if (r.truncated) { truncado = true; if (!reason) reason = r.reason; }
        const miss = (r.openDeps || []).filter((d) => !allowed.has(Number(d)));
        if (miss.length) missing[String(issue)] = miss;
    }
    return { missing, truncado, reason };
}

// Enriquecimiento por issue SOLO desde el cache de deps (NO dispara `gh` en
// runtime → no bloquea el event loop del dashboard; "pipeline no puede morir").
// Whitelist estricta de campos (A05/CA-1): number, title, status, parent. Nunca
// paths ni timestamps. `parent` se deriva de las refs de procedencia (Split de /
// Tracked by), que son exactamente `deps \ forwardDeps`.
function enrichFromCache(n, cache) {
    const base = { number: n, title: null, status: null, parent: null };
    const e = cache && cache.issues ? cache.issues[String(n)] : null;
    if (e && typeof e === 'object') {
        base.title = (typeof e.title === 'string' && e.title) ? e.title : null;
        base.status = (typeof e.state === 'string' && e.state) ? e.state : null;
        const fwd = new Set((e.forwardDeps || []).map(Number));
        const prov = (e.deps || []).map(Number).filter((d) => !fwd.has(d));
        base.parent = prov.length ? prov[0] : null;
    }
    return base;
}

function handleAllowlistRead(res) {
    if (!partialPause) {
        return sendError(res, 503, 'module_unavailable', 'La edición de allowlist no está disponible.');
    }
    try {
        const list = currentAllowlist();
        const cache = ppDeps ? ppDeps.readCache(depsOpts().cacheFile) : { issues: {} };
        const allowlist = list.map((n) => enrichFromCache(n, cache));
        return send(res, 200, { allowlist, count: allowlist.length });
    } catch (e) {
        try { console.error(JSON.stringify({ event: 'allowlist_read_error', msg: e && e.message, ts: new Date().toISOString() })); } catch { /* noop */ }
        return sendError(res, 500, 'internal_error', 'Error interno leyendo la allowlist.');
    }
}

// Dispatch de las mutaciones de allowlist (ya pasado el cinturón de gates).
// Devuelve el shape { status, body } | { errorStatus, code, message, field }
// que consume finishMutation.
function dispatchAllowlistMutation(route, parsed) {
    if (!partialPause || !ppDeps) {
        return { errorStatus: 503, code: 'module_unavailable', message: 'La edición de allowlist no está disponible.' };
    }
    const parsedIds = parseIssueIds(parsed);
    if (parsedIds.error) {
        const e = parsedIds.error;
        return { errorStatus: e.status, code: e.code, message: e.message, field: e.field };
    }
    const ids = parsedIds.ids;

    if (route.action === 'allowlist-preview') return allowlistPreview(ids);
    if (route.action === 'allowlist-add') return allowlistAdd(ids);
    if (route.action === 'allowlist-remove') return allowlistRemove(ids, parsed);
    return { errorStatus: 404, code: 'not_found', message: 'Operación de allowlist desconocida.' };
}

// PREVIEW — dry-run. NO persiste, NO efectos colaterales. Muestra qué issues se
// arrastran recursivamente al sumar `ids` y qué inconsistencias quedarían (A05).
function allowlistPreview(ids) {
    const current = currentAllowlist();
    const candidate = [...new Set([...current, ...ids])].sort((a, b) => a - b);
    const { missing, truncado, reason } = computeDrag(candidate);
    const conDeps = ppDeps.allowlistWithDeps(candidate, missing);
    const aArrastrar = conDeps.filter((n) => !candidate.includes(n));
    return { status: 200, body: {
        ok: true,
        persisted: false,
        candidate,
        aArrastrar,
        inconsistencias: missing,
        truncado,
        reason: reason || null,
    } };
}

// ADD — expande recursivamente ANTES de persistir y escribe SÓLO vía el gate.
function allowlistAdd(ids) {
    const current = currentAllowlist();
    const candidate = [...new Set([...current, ...ids])].sort((a, b) => a - b);
    const { missing, truncado, reason } = computeDrag(candidate);
    const union = ppDeps.allowlistWithDeps(candidate, missing);
    const aArrastrar = union.filter((n) => !candidate.includes(n));

    const r = partialPause.setPartialPause(union, {
        source: ALLOWLIST_SOURCE,
        authorizedBy: ALLOWLIST_AUTHORIZED_BY,
        justification: `Editor Roadmap: agregar ${ids.map((n) => `#${n}`).join(', ')} (arrastre recursivo)`,
    });
    if (r.rejected) {
        return { errorStatus: 409, code: 'gate_rejected', message: r.msg || 'La mutación fue rechazada por el gate de allowlist.' };
    }
    return { status: 200, body: {
        ok: true,
        persisted: true,
        allowlist: r.allowedIssues || union,
        added: ids,
        aArrastrar,
        truncado,
        reason: reason || null,
    } };
}

// REMOVE — avisa (bloqueante) inconsistencias/desync ANTES de persistir. Sólo
// persiste con `confirm: true` explícito del operador (CA-4/CA-5).
function allowlistRemove(ids, parsed) {
    const current = currentAllowlist();
    const toRemove = new Set(ids);
    const remaining = current.filter((n) => !toRemove.has(n));

    // Inconsistencia interna de la allowlist tras la remoción (padre que queda
    // sin su hijo / dependencia faltante) — findMissingDeps sobre el remanente.
    const { missing, truncado, reason } = computeDrag(remaining);

    // Desync waves↔partial que introduciría la remoción (issue que sigue en la
    // ola activa pero saldría de la allowlist). Se PROYECTA sobre `remaining`
    // comparando contra la ola activa (waves.json, lectura pura). NO se usa
    // desync-detector.detectDesync() acá: ese lee el estado en disco (pre-
    // remoción, no el proyectado) y además crea el flag de bloqueo + alerta
    // Telegram — efectos colaterales inadmisibles en un chequeo previo (CA-6).
    const desync = projectedDesync(remaining);

    const hasInconsistencias = Object.keys(missing).length > 0;
    const hasDesync = !!desync;
    const bloqueado = hasInconsistencias || hasDesync;

    if (bloqueado && parsed.confirm !== true) {
        // 200 con ok:false: la operación NO falló, se frenó a la espera de
        // confirmación explícita. El cliente muestra el warning y re-postea con confirm.
        return { status: 200, body: {
            ok: false,
            blocked: true,
            persisted: false,
            requested: ids,
            inconsistencias: missing,
            desync,
            truncado,
            reason: reason || null,
            message: 'La remoción deja dependencias huérfanas o desincroniza la ola. Confirmá para persistir.',
        } };
    }

    const r = partialPause.setPartialPause(remaining, {
        source: ALLOWLIST_SOURCE,
        authorizedBy: ALLOWLIST_AUTHORIZED_BY,
        justification: `Editor Roadmap: quitar ${ids.map((n) => `#${n}`).join(', ')}${bloqueado ? ' (confirmado con inconsistencias)' : ''}`,
    });
    if (r.rejected) {
        return { errorStatus: 409, code: 'gate_rejected', message: r.msg || 'La mutación fue rechazada por el gate de allowlist.' };
    }
    return { status: 200, body: {
        ok: true,
        persisted: true,
        allowlist: r.allowedIssues || remaining,
        removed: ids,
        inconsistencias: missing,
        desync,
        truncado,
        reason: reason || null,
    } };
}

// Proyección PURA del desync waves↔partial que dejaría un `remaining` dado, SIN
// efectos colaterales. Compara el remanente proyectado contra la allowlist de la
// ola activa (waves.json, lectura pura vía activeAllowlist()). Devuelve null si
// no hay desync, o un resumen display-ready (whitelist de campos, A05).
//   - missingFromAllowlist: issues que la ola activa todavía tiene pero que la
//     remoción dejaría FUERA de la allowlist (padre/hijo huérfano de la ola).
//   - extraInAllowlist: issues en la allowlist que la ola activa no contiene.
function projectedDesync(remaining) {
    if (!waves) return null;
    let waveAllow;
    try { waveAllow = activeAllowlist(); } catch { return null; }
    if (!Array.isArray(waveAllow) || waveAllow.length === 0) return null;
    const rem = new Set(remaining.map(Number));
    const wave = new Set(waveAllow.map(Number));
    const missingFromAllowlist = waveAllow.map(Number).filter((n) => !rem.has(n));
    const extraInAllowlist = remaining.map(Number).filter((n) => !wave.has(n));
    if (missingFromAllowlist.length === 0 && extraInAllowlist.length === 0) return null;
    return { missingFromAllowlist, extraInAllowlist };
}

// -----------------------------------------------------------------------------
// Handlers de lectura.
// -----------------------------------------------------------------------------
function handleRead(res, route) {
    // #4437 — la lectura de allowlist no depende de `waves` (opera sobre
    // .partial-pause.json) → su propio guard de módulo.
    if (route.action === 'allowlist-read') {
        return handleAllowlistRead(res);
    }
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
    // #4437 — las mutaciones de allowlist operan sobre .partial-pause.json (no
    // sobre waves.json) y no usan el modelo de versión If-Match de olas.
    if (ALLOWLIST_ACTIONS.has(route.action)) {
        return dispatchAllowlistMutation(route, parsed);
    }
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
    // #4437 — las mutaciones de allowlist NO exigen If-Match: no hay recurso de
    // olas versionado (operan sobre .partial-pause.json). Igual que create, se
    // saltean el gate de precondición pero conservan el resto del cinturón.
    if (route.action !== 'create' && !ALLOWLIST_ACTIONS.has(route.action)) {
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
        // #4437 — editor de allowlist (ventana Roadmap).
        parseIssueIds,
        computeDrag,
        currentAllowlist,
        projectedDesync,
        enrichFromCache,
        ALLOWLIST_SOURCE,
        ALLOWLIST_AUTHORIZED_BY,
        _setDepsOptsForTests,
    },
};

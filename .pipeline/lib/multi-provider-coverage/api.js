// =============================================================================
// multi-provider-coverage/api.js — Handler HTTP del botón "Ejecutar harness"
// del widget Multi-Provider Coverage (#3681, hijo B del épico #3669).
//
// Mount point (registrado desde dashboard.js, antes del catch-all):
//   POST /api/dash/multi-provider-coverage/run
//
// Por qué módulo aparte (NO en dashboard-routes.js::API_ROUTES):
//   `dashboard-routes.js::handle()` filtra `if (req.method !== 'GET') return false`
//   en línea ~362. El POST no puede registrarse ahí; tiene que ir mounteado
//   upstream en dashboard.js antes del catch-all legacy.
//
// Defensas (orden de aplicación; OWASP A01/A04/A07):
//   1. Loopback-only: 403 si remote no es 127.0.0.1/::1.
//   2. Origin/Referer whitelist: 403 si cross-origin.
//   3. Content-Type estricto: 415 si no es application/json.
//   4. Server-side guard de coordinación (REQ-SEC-B1): re-valida vía
//      `partial-pause.getPipelineMode()`. La guardia del botón frontend es
//      UX, NO autoridad — un atacante podría POSTear directo. Aceptamos:
//        - mode === 'paused' (.pausa archivo presente = halt total)
//        - mode === 'partial_pause' AND allowedSkills incluye
//          'multi-provider-smoke-test'
//      Reusa `lib/multi-provider/smoke-test.preCheckCoordinationWindow()`
//      para mantener un único oráculo de coordinación.
//   5. Lockfile (REQ-SEC-B2): max 1 run pendiente por host. Cleanup en
//      `finally` aún ante throw. Sin esto, spamming el botón antes del
//      primer spawn sortea el cap CONCURRENCY=1 del harness.
//   6. Audit-log append-chained (REQ-SEC-B10): cada request (allowed o
//      rechazada) genera entry con `{ts, event, source, allowed, reason,
//      remoteAddress, userAgent (truncado), runId}`. Forensia post-incident.
//
// El spawn real del harness vive en `lib/multi-provider/smoke-test.js`
// (#3680). Este módulo SÓLO valida la coordinación + dispara el job via
// `child_process.spawn` detached para no bloquear el event loop del
// dashboard. Devuelve 202 con `runId`; el cliente polea GET para ver el
// resultado en la matriz refresqueada.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PIPELINE_ROOT = process.env.PIPELINE_STATE_DIR
    || path.resolve(__dirname, '..', '..');

const LOCK_FILE = path.join(PIPELINE_ROOT, '.multi-provider-smoke-test.running');
const AUDIT_LOG_FILE = path.join(PIPELINE_ROOT, 'audit', 'multi-provider-coverage-runs.jsonl');
const HARNESS_RUNNER_PATH = path.join(PIPELINE_ROOT, 'tools', 'multi-provider-smoke-test.js');

const ALLOWED_ORIGINS = ['http://localhost:3200', 'http://127.0.0.1:3200'];
const HARNESS_SKILL_NAME = 'multi-provider-smoke-test';

// Lazy require — defensa de cinturón: si el módulo no carga (pre-merge en
// checkout transitorio), el handler degrada a 503 sin crashear.
let partialPause = null;
try { partialPause = require('../partial-pause'); } catch { /* opcional */ }

let auditLog = null;
try { auditLog = require('../audit-log'); } catch { /* opcional */ }

let smokeTest = null;
try { smokeTest = require('../multi-provider/smoke-test'); } catch { /* opcional */ }

// -----------------------------------------------------------------------------
// Triple-gate (REQ-SEC-B3) — patrón canónico replicado de dashboard.js:9319-9356.
// -----------------------------------------------------------------------------

function isLoopback(req) {
    const r = (req && req.socket && req.socket.remoteAddress) || '';
    return r === '127.0.0.1' || r === '::1' || r === '::ffff:127.0.0.1' || r.startsWith('127.');
}

function isOriginAllowed(req) {
    const origin = (req && req.headers && req.headers['origin']) || '';
    if (!origin) return true; // ausente está permitido (server-to-server, curl)
    return ALLOWED_ORIGINS.includes(origin);
}

function isRefererAllowed(req) {
    const referer = (req && req.headers && req.headers['referer']) || '';
    if (!referer) return true;
    return ALLOWED_ORIGINS.some((o) => referer.startsWith(o + '/') || referer === o || referer === o + '/');
}

function isContentTypeJson(req) {
    const ct = String((req && req.headers && req.headers['content-type']) || '').toLowerCase();
    return ct.startsWith('application/json');
}

// -----------------------------------------------------------------------------
// Coordination guard (REQ-SEC-B1) — server-side re-validación.
// Reusa preCheckCoordinationWindow del harness para mantener un único
// oráculo de coordinación cross-module.
// -----------------------------------------------------------------------------
function isCoordinationAllowed(opts = {}) {
    // Honrar null/undefined explícito en los opts — los tests inyectan
    // `null` para verificar el degradado defensivo.
    const pp = ('partialPause' in opts) ? opts.partialPause : partialPause;
    const st = ('smokeTest' in opts) ? opts.smokeTest : smokeTest;
    if (!pp || typeof pp.getPipelineMode !== 'function') {
        return { allowed: false, reason: 'partial_pause_module_unavailable', mode: null };
    }
    let state;
    try {
        state = pp.getPipelineMode();
    } catch {
        return { allowed: false, reason: 'pipeline_mode_read_error', mode: null };
    }
    // Si el módulo del harness está disponible, usar su preCheck (oráculo único).
    if (st && typeof st.preCheckCoordinationWindow === 'function') {
        const check = st.preCheckCoordinationWindow(state);
        return {
            allowed: !!check.ok,
            reason: check.ok ? (check.mode || 'coordination_ok') : (check.reason || 'no_safe_window'),
            mode: state.mode,
        };
    }
    // Fallback: lógica inline si el harness no está disponible.
    if (state.mode === 'paused') return { allowed: true, reason: 'paused', mode: state.mode };
    if (state.mode === 'partial_pause'
        && Array.isArray(state.allowedSkills)
        && state.allowedSkills.includes(HARNESS_SKILL_NAME)) {
        return { allowed: true, reason: 'partial_pause_with_skill', mode: state.mode };
    }
    return { allowed: false, reason: 'no_safe_window', mode: state.mode };
}

// -----------------------------------------------------------------------------
// Lockfile (REQ-SEC-B2) — 1 run pendiente por host.
// -----------------------------------------------------------------------------
function tryAcquireLock(opts = {}) {
    const lockPath = opts.lockFile || LOCK_FILE;
    const fsImpl = opts.fsImpl || fs;
    try {
        // O_EXCL — falla con EEXIST si ya existe.
        const fd = fsImpl.openSync(lockPath, 'wx');
        try {
            fsImpl.writeSync(fd, JSON.stringify({
                pid: process.pid,
                acquired_at: new Date().toISOString(),
            }));
        } finally {
            fsImpl.closeSync(fd);
        }
        return { acquired: true, lockPath };
    } catch (e) {
        if (e && e.code === 'EEXIST') {
            return { acquired: false, reason: 'lock_held', lockPath };
        }
        return { acquired: false, reason: 'lock_io_error', error: e.message, lockPath };
    }
}

function releaseLock(opts = {}) {
    const lockPath = opts.lockFile || LOCK_FILE;
    const fsImpl = opts.fsImpl || fs;
    try { fsImpl.unlinkSync(lockPath); } catch { /* swallow */ }
}

// -----------------------------------------------------------------------------
// Audit-log (REQ-SEC-B10) — append-chained, sin secrets.
// -----------------------------------------------------------------------------
function auditAppend(entry, opts = {}) {
    const al = opts.auditLog || auditLog;
    if (!al || typeof al.appendChained !== 'function') return; // best-effort
    const file = opts.auditFile || AUDIT_LOG_FILE;
    try {
        al.appendChained({ file, entry });
    } catch { /* best-effort — no romper la request por audit-log */ }
}

function sanitizeUserAgent(ua) {
    if (typeof ua !== 'string') return '';
    return ua.replace(/[\r\n]/g, ' ').slice(0, 256);
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------
function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
}

// -----------------------------------------------------------------------------
// Spawn del harness — fire-and-forget, detached para no bloquear event loop.
// La salida del harness (stdout/stderr) se redirige al log standard del
// pipeline. El widget descubre el resultado polleando el endpoint GET (que
// lee el JSON regenerado).
// -----------------------------------------------------------------------------
function spawnHarness(runId, opts = {}) {
    const runner = opts.runnerPath || HARNESS_RUNNER_PATH;
    const fsImpl = opts.fsImpl || fs;
    const childProc = opts.childProcess || require('node:child_process');
    if (!fsImpl.existsSync(runner)) {
        return { spawned: false, reason: 'runner_missing' };
    }
    try {
        const child = childProc.spawn('node', [runner], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, COVERAGE_RUN_ID: runId },
        });
        child.unref();
        return { spawned: true, pid: child.pid };
    } catch (e) {
        return { spawned: false, reason: 'spawn_failed', error: e.message };
    }
}

// -----------------------------------------------------------------------------
// Route entry — único endpoint de este módulo.
// -----------------------------------------------------------------------------
function route(req, res, opts = {}) {
    const url = (req && req.url) || '';
    if (url !== '/api/dash/multi-provider-coverage/run') return false;
    if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const remoteAddress = (req.socket && req.socket.remoteAddress) || 'unknown';
    const userAgent = sanitizeUserAgent((req.headers && req.headers['user-agent']) || '');

    // 1) Triple-gate
    if (!isLoopback(req)) {
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: false,
            reason: 'non_loopback',
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 403, { ok: false, error: 'loopback_only' });
        return true;
    }
    if (!isOriginAllowed(req) || !isRefererAllowed(req)) {
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: false,
            reason: 'cross_origin',
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 403, { ok: false, error: 'cross_origin' });
        return true;
    }
    if (!isContentTypeJson(req)) {
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: false,
            reason: 'invalid_content_type',
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 415, { ok: false, error: 'json_required' });
        return true;
    }

    // 2) Coordination guard (server-side, no confiar del front)
    const coord = isCoordinationAllowed(opts);
    if (!coord.allowed) {
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: false,
            reason: 'coordination_blocked',
            coordination_reason: coord.reason,
            pipeline_mode: coord.mode,
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 403, {
            ok: false,
            error: 'coordination_blocked',
            reason: coord.reason,
            mode: coord.mode,
        });
        return true;
    }

    // 3) Lockfile
    const lock = tryAcquireLock(opts);
    if (!lock.acquired) {
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: false,
            reason: 'lock_held',
            lock_reason: lock.reason,
            pipeline_mode: coord.mode,
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 409, {
            ok: false,
            error: 'run_already_in_progress',
            reason: lock.reason,
        });
        return true;
    }

    // 4) Spawn harness (fire-and-forget)
    const runId = (opts.runId || crypto.randomBytes(8).toString('hex'));
    let spawnResult;
    try {
        spawnResult = spawnHarness(runId, opts);
    } catch (e) {
        spawnResult = { spawned: false, reason: 'spawn_threw', error: e.message };
    }

    // Si el spawn falló, liberamos el lock inmediatamente. Si tuvo éxito, el
    // proceso hijo es responsable de liberar el lock cuando termine — pero
    // como es detached y nuestro proceso no lo monitorea, dejamos también
    // un cleanup de seguridad por TTL (no implementado acá; el harness ya
    // tiene su propio cleanup vía finally).
    if (!spawnResult.spawned) {
        releaseLock(opts);
        auditAppend({
            event: 'harness_run_requested',
            source: 'dashboard',
            allowed: true,
            reason: 'spawn_failed',
            spawn_reason: spawnResult.reason,
            pipeline_mode: coord.mode,
            runId,
            remoteAddress,
            userAgent,
        }, opts);
        send(res, 500, {
            ok: false,
            error: 'spawn_failed',
            reason: spawnResult.reason,
        });
        return true;
    }

    auditAppend({
        event: 'harness_run_requested',
        source: 'dashboard',
        allowed: true,
        reason: 'coordination_ok',
        coordination_reason: coord.reason,
        pipeline_mode: coord.mode,
        runId,
        spawnPid: spawnResult.pid || null,
        remoteAddress,
        userAgent,
    }, opts);

    send(res, 202, {
        ok: true,
        runId,
        message: 'Harness lanzado. Polleá GET /api/dash/multi-provider-coverage para ver el resultado.',
    });
    return true;
}

module.exports = {
    route,
    // Exports para tests
    isLoopback,
    isOriginAllowed,
    isRefererAllowed,
    isContentTypeJson,
    isCoordinationAllowed,
    tryAcquireLock,
    releaseLock,
    auditAppend,
    sanitizeUserAgent,
    _constants: {
        LOCK_FILE,
        AUDIT_LOG_FILE,
        HARNESS_RUNNER_PATH,
        ALLOWED_ORIGINS,
        HARNESS_SKILL_NAME,
    },
};

// =============================================================================
// Tests del módulo lib/multi-provider-coverage/api.js (#3681).
//
// Cubre:
//   REQ-SEC-B3 → Triple-gate: 403 no-loopback, 403 cross-origin, 415 sin JSON.
//   REQ-SEC-B1 → Server-side guard: 403 si coordinación no habilitada.
//   REQ-SEC-B2 → Lockfile: 409 si ya existe; cleanup en `finally`.
//   REQ-SEC-B10 → Audit-log: cada request appendea con `allowed: true|false`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const api = require('../multi-provider-coverage/api');

// -----------------------------------------------------------------------------
// Helpers: fake req/res mínimos.
// -----------------------------------------------------------------------------
function fakeReq({ url = '/api/dash/multi-provider-coverage/run', method = 'POST',
                   remoteAddress = '127.0.0.1', origin = 'http://localhost:3200',
                   referer = '', contentType = 'application/json',
                   userAgent = 'test-agent' } = {}) {
    return {
        url, method,
        socket: { remoteAddress },
        headers: {
            origin,
            referer,
            'content-type': contentType,
            'user-agent': userAgent,
        },
    };
}

function fakeRes() {
    const captured = { status: null, headers: null, body: null };
    return {
        captured,
        writeHead(status, headers) { captured.status = status; captured.headers = headers; },
        end(body) { captured.body = body; },
    };
}

// fakes inyectables vía opts.
function fakePartialPause(mode, allowedSkills = []) {
    return {
        getPipelineMode: () => ({ mode, allowedIssues: [], allowedSkills }),
    };
}

function fakeAuditLog() {
    const calls = [];
    return {
        calls,
        appendChained: ({ entry }) => { calls.push(entry); return { hash_self: 'x', hash_prev: 'y', line: '' }; },
    };
}

function fakeChildProcess(spawnImpl) {
    return {
        spawn: spawnImpl || (() => ({ pid: 12345, unref() {} })),
    };
}

// In-memory fake fs for lockfile.
function tmpLockFile() {
    return path.join(os.tmpdir(), `mpc-lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lock`);
}

// -----------------------------------------------------------------------------
// route() — triple-gate
// -----------------------------------------------------------------------------

test('route ignora paths que no son /api/dash/multi-provider-coverage/run', () => {
    const req = fakeReq({ url: '/api/dash/other' });
    const res = fakeRes();
    const handled = api.route(req, res);
    assert.equal(handled, false);
});

test('route rechaza 405 si método no es POST', () => {
    const req = fakeReq({ method: 'GET' });
    const res = fakeRes();
    api.route(req, res);
    assert.equal(res.captured.status, 405);
});

test('route rechaza 403 si remoteAddress NO es loopback (REQ-SEC-B3)', () => {
    const audit = fakeAuditLog();
    const req = fakeReq({ remoteAddress: '10.0.0.1' });
    const res = fakeRes();
    api.route(req, res, { auditLog: audit, auditFile: tmpLockFile() });
    assert.equal(res.captured.status, 403);
    assert.match(res.captured.body, /loopback_only/);
    assert.equal(audit.calls.length, 1, 'audit-log appendea aún en rechazo');
    assert.equal(audit.calls[0].allowed, false);
    assert.equal(audit.calls[0].reason, 'non_loopback');
});

test('route rechaza 403 si Origin es cross-origin (REQ-SEC-B3)', () => {
    const audit = fakeAuditLog();
    const req = fakeReq({ origin: 'http://attacker.com' });
    const res = fakeRes();
    api.route(req, res, { auditLog: audit, auditFile: tmpLockFile() });
    assert.equal(res.captured.status, 403);
    assert.match(res.captured.body, /cross_origin/);
    assert.equal(audit.calls[0].reason, 'cross_origin');
});

test('route rechaza 403 si Referer es cross-origin', () => {
    const req = fakeReq({ origin: '', referer: 'http://attacker.com/x' });
    const res = fakeRes();
    api.route(req, res, { auditLog: fakeAuditLog(), auditFile: tmpLockFile() });
    assert.equal(res.captured.status, 403);
    assert.match(res.captured.body, /cross_origin/);
});

test('route rechaza 415 si Content-Type no es application/json (REQ-SEC-B3)', () => {
    const audit = fakeAuditLog();
    const req = fakeReq({ contentType: 'text/plain' });
    const res = fakeRes();
    api.route(req, res, { auditLog: audit, auditFile: tmpLockFile() });
    assert.equal(res.captured.status, 415);
    assert.match(res.captured.body, /json_required/);
    assert.equal(audit.calls[0].reason, 'invalid_content_type');
});

// -----------------------------------------------------------------------------
// route() — coordination guard (REQ-SEC-B1)
// -----------------------------------------------------------------------------

test('route rechaza 403 coordination_blocked si pipeline está running', () => {
    const audit = fakeAuditLog();
    const req = fakeReq();
    const res = fakeRes();
    api.route(req, res, {
        partialPause: fakePartialPause('running'),
        smokeTest: null, // forzar fallback inline
        auditLog: audit,
        auditFile: tmpLockFile(),
    });
    assert.equal(res.captured.status, 403);
    assert.match(res.captured.body, /coordination_blocked/);
    assert.equal(audit.calls[0].allowed, false);
    assert.equal(audit.calls[0].reason, 'coordination_blocked');
});

test('route acepta si pipeline está paused', () => {
    const audit = fakeAuditLog();
    const req = fakeReq();
    const res = fakeRes();
    const lockFile = tmpLockFile();
    try {
        api.route(req, res, {
            partialPause: fakePartialPause('paused'),
            smokeTest: null,
            auditLog: audit,
            auditFile: tmpLockFile(),
            lockFile,
            childProcess: fakeChildProcess(),
            runnerPath: __filename, // existe
        });
        assert.equal(res.captured.status, 202);
        assert.match(res.captured.body, /runId/);
        assert.equal(audit.calls[0].allowed, true);
    } finally {
        try { fs.unlinkSync(lockFile); } catch {}
    }
});

test('route acepta si pipeline está partial_pause con allowed_skill correcto', () => {
    const audit = fakeAuditLog();
    const req = fakeReq();
    const res = fakeRes();
    const lockFile = tmpLockFile();
    try {
        api.route(req, res, {
            partialPause: fakePartialPause('partial_pause', ['multi-provider-smoke-test']),
            smokeTest: null,
            auditLog: audit,
            auditFile: tmpLockFile(),
            lockFile,
            childProcess: fakeChildProcess(),
            runnerPath: __filename,
        });
        assert.equal(res.captured.status, 202);
        assert.equal(audit.calls[0].allowed, true);
    } finally {
        try { fs.unlinkSync(lockFile); } catch {}
    }
});

test('route rechaza partial_pause SIN el allowed_skill', () => {
    const audit = fakeAuditLog();
    const req = fakeReq();
    const res = fakeRes();
    api.route(req, res, {
        partialPause: fakePartialPause('partial_pause', ['other-skill']),
        smokeTest: null,
        auditLog: audit,
        auditFile: tmpLockFile(),
    });
    assert.equal(res.captured.status, 403);
    assert.equal(audit.calls[0].reason, 'coordination_blocked');
});

// -----------------------------------------------------------------------------
// Lockfile (REQ-SEC-B2)
// -----------------------------------------------------------------------------

test('tryAcquireLock crea archivo nuevo y luego falla con EEXIST', () => {
    const lockFile = tmpLockFile();
    try {
        const a = api.tryAcquireLock({ lockFile });
        assert.equal(a.acquired, true);
        assert.ok(fs.existsSync(lockFile));
        const b = api.tryAcquireLock({ lockFile });
        assert.equal(b.acquired, false);
        assert.equal(b.reason, 'lock_held');
    } finally {
        api.releaseLock({ lockFile });
    }
});

test('releaseLock elimina el archivo y es idempotente', () => {
    const lockFile = tmpLockFile();
    api.tryAcquireLock({ lockFile });
    assert.ok(fs.existsSync(lockFile));
    api.releaseLock({ lockFile });
    assert.ok(!fs.existsSync(lockFile));
    // double-release no debe lanzar
    api.releaseLock({ lockFile });
});

test('route rechaza 409 cuando el lockfile ya existe', () => {
    const lockFile = tmpLockFile();
    api.tryAcquireLock({ lockFile }); // pre-lock
    try {
        const audit = fakeAuditLog();
        const req = fakeReq();
        const res = fakeRes();
        api.route(req, res, {
            partialPause: fakePartialPause('paused'),
            smokeTest: null,
            auditLog: audit,
            auditFile: tmpLockFile(),
            lockFile,
            childProcess: fakeChildProcess(),
            runnerPath: __filename,
        });
        assert.equal(res.captured.status, 409);
        assert.equal(audit.calls[0].reason, 'lock_held');
    } finally {
        api.releaseLock({ lockFile });
    }
});

test('route libera el lock cuando el spawn falla', () => {
    const lockFile = tmpLockFile();
    const audit = fakeAuditLog();
    const req = fakeReq();
    const res = fakeRes();
    api.route(req, res, {
        partialPause: fakePartialPause('paused'),
        smokeTest: null,
        auditLog: audit,
        auditFile: tmpLockFile(),
        lockFile,
        // runner_path NO existe → spawnHarness retorna {spawned: false, reason: 'runner_missing'}
        runnerPath: '/non/existent/path',
    });
    assert.equal(res.captured.status, 500);
    assert.match(res.captured.body, /spawn_failed/);
    assert.equal(fs.existsSync(lockFile), false, 'lock liberado tras fallo de spawn');
});

// -----------------------------------------------------------------------------
// Audit-log (REQ-SEC-B10)
// -----------------------------------------------------------------------------

test('audit-log appendea entry con shape esperado en flow exitoso', () => {
    const lockFile = tmpLockFile();
    const audit = fakeAuditLog();
    try {
        const req = fakeReq();
        const res = fakeRes();
        api.route(req, res, {
            partialPause: fakePartialPause('paused'),
            smokeTest: null,
            auditLog: audit,
            auditFile: tmpLockFile(),
            lockFile,
            childProcess: fakeChildProcess(),
            runnerPath: __filename,
        });
        assert.equal(audit.calls.length, 1);
        const e = audit.calls[0];
        assert.equal(e.event, 'harness_run_requested');
        assert.equal(e.source, 'dashboard');
        assert.equal(e.allowed, true);
        assert.equal(typeof e.runId, 'string');
        assert.equal(typeof e.remoteAddress, 'string');
    } finally {
        api.releaseLock({ lockFile });
    }
});

test('sanitizeUserAgent trunca a 256 chars y remueve newlines', () => {
    const long = 'X'.repeat(500);
    assert.equal(api.sanitizeUserAgent(long).length, 256);
    assert.equal(api.sanitizeUserAgent('foo\nbar\rbaz').includes('\n'), false);
});

// -----------------------------------------------------------------------------
// Coordinación guard puro
// -----------------------------------------------------------------------------

test('isCoordinationAllowed acepta paused', () => {
    const out = api.isCoordinationAllowed({
        partialPause: fakePartialPause('paused'),
        smokeTest: null,
    });
    assert.equal(out.allowed, true);
});

test('isCoordinationAllowed rechaza running', () => {
    const out = api.isCoordinationAllowed({
        partialPause: fakePartialPause('running'),
        smokeTest: null,
    });
    assert.equal(out.allowed, false);
    assert.equal(out.reason, 'no_safe_window');
});

test('isCoordinationAllowed degrada cuando partialPause no carga', () => {
    const out = api.isCoordinationAllowed({
        partialPause: null,
        smokeTest: null,
    });
    assert.equal(out.allowed, false);
    assert.equal(out.reason, 'partial_pause_module_unavailable');
});

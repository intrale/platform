// =============================================================================
// partial-pause-resolution.test.js — Endpoints nuevos de "pausa parcial
// trabada" y su gate de request (issue #5923).
//
// Estos 2 endpoints (`keep-original`, `cancel-partial-pause`) NACEN con gate:
// se copia el molde de `/api/allowlist-candidates` (loopback + Origin/Referer +
// Content-Type estricto), NO el de `include-deps`, que no tiene ningún control
// de request (CSRF preexistente → issue #5929, fuera de alcance).
//
// Se testea la lógica pura: `dashboard.js` no exporta nada y requerirlo levanta
// el server real en el 3200, así que meterlo en un test tumbaría el dashboard
// de producción.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../dashboard-request-gate');
const { applyResolution, RESOLUTIONS } = require('../partial-pause-resolution');

const JSON_CT = { 'content-type': 'application/json' };

// ─── Gate de request ─────────────────────────────────────────────────────────

test('#5923 gate: request no-loopback ⇒ 403', () => {
    for (const remote of ['10.0.0.5', '192.168.1.20', '203.0.113.7', '::ffff:10.0.0.1', '']) {
        const r = gate.evaluateLocalMutationGate({ remoteAddress: remote, method: 'POST', headers: JSON_CT });
        assert.equal(r.ok, false, `${remote} debe rechazarse`);
        assert.equal(r.status, 403);
    }
});

test('#5923 gate: loopback en sus 4 formas pasa', () => {
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
        assert.equal(gate.isLoopbackAddress(remote), true, `${remote} es loopback`);
        assert.equal(gate.evaluateLocalMutationGate({ remoteAddress: remote, headers: JSON_CT }).ok, true);
    }
});

test('#5923 gate: Origin ajeno ⇒ 403 (anti-CSRF desde el browser del operador)', () => {
    for (const origin of ['http://evil.com', 'https://localhost:3200', 'http://localhost:8080', 'null']) {
        const r = gate.evaluateLocalMutationGate({
            remoteAddress: '127.0.0.1', method: 'POST', headers: { ...JSON_CT, origin },
        });
        assert.equal(r.ok, false, `Origin ${origin} debe rechazarse`);
        assert.equal(r.status, 403);
        assert.match(r.msg, /cross-origin/);
    }
});

test('#5923 gate: Referer ajeno ⇒ 403, y un prefijo tramposo no cuela', () => {
    const r = gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { ...JSON_CT, referer: 'http://localhost:3200.evil.com/x' },
    });
    assert.equal(r.status, 403, 'localhost:3200.evil.com no es localhost:3200');
    assert.equal(gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { ...JSON_CT, referer: 'http://localhost:3200/' },
    }).ok, true);
});

test('#5923 gate: sin Content-Type application/json ⇒ 415', () => {
    for (const ct of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
        const headers = ct === undefined ? {} : { 'content-type': ct };
        const r = gate.evaluateLocalMutationGate({ remoteAddress: '127.0.0.1', method: 'POST', headers });
        assert.equal(r.ok, false, `Content-Type "${ct}" debe rechazarse`);
        assert.equal(r.status, 415);
    }
    // El charset no invalida el tipo.
    assert.equal(gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json; charset=utf-8' },
    }).ok, true);
});

test('#5923 gate: sin Origin ni Referer pasa (curl / callback-handler no son vector CSRF)', () => {
    assert.equal(gate.evaluateLocalMutationGate({ remoteAddress: '127.0.0.1', headers: JSON_CT }).ok, true);
});

test('#5923 sanitizeAuthorizedBy conserva al operador real y descarta basura', () => {
    assert.equal(gate.sanitizeAuthorizedBy('telegram:111222333'), 'telegram:111222333');
    assert.equal(gate.sanitizeAuthorizedBy('commander:leo'), 'commander:leo');
    for (const basura of ['', null, undefined, 'con espacios', 'x\ninyectado', '../../etc', '<script>', {}]) {
        assert.equal(gate.sanitizeAuthorizedBy(basura), 'dashboard-local', `${JSON.stringify(basura)} → fallback`);
    }
    assert.equal(gate.sanitizeAuthorizedBy('a'.repeat(500)).length, 120, 'se acota');
});

// ─── Resolución ──────────────────────────────────────────────────────────────

function makeDeps(mode = 'partial_pause', overrides = {}) {
    const calls = { set: [], clear: [], depsState: 0 };
    return {
        calls,
        deps: {
            getPipelineMode: () => ({ mode, allowedIssues: [5923, 5924], depSources: { 5924: 'auto-deps' } }),
            setPartialPause: (issues, opts) => { calls.set.push({ issues, opts }); return { ok: true, allowedIssues: issues, msg: 'ok' }; },
            clearPartialPause: (opts) => { calls.clear.push(opts); return { ok: true, existed: true }; },
            clearDepsState: () => { calls.depsState++; },
            ...overrides,
        },
    };
}

test('#5923 con mode !== partial_pause ⇒ 409 y CERO mutación (anti-replay)', () => {
    // `null` explícito NO dispara el default del helper: cubre el modo ilegible.
    for (const mode of ['running', 'paused', 'rest', null]) {
        const h = makeDeps(mode);
        for (const action of RESOLUTIONS) {
            const out = applyResolution({ action, authorizedBy: 'telegram:1', deps: h.deps });
            assert.equal(out.status, 409, `${action} en modo ${mode} debe dar 409`);
            assert.match(out.body.msg, /no en partial_pause/);
        }
        assert.equal(h.calls.set.length, 0, 'no se toca el allowlist');
        assert.equal(h.calls.clear.length, 0, 'no se levanta la pausa');
    }
});

test('#5923 si el estado del pipeline no se puede leer ⇒ 409, nunca mutación a ciegas', () => {
    const deps = { getPipelineMode: () => undefined, setPartialPause: () => { throw new Error('no debe llamarse'); },
                   clearPartialPause: () => { throw new Error('no debe llamarse'); } };
    for (const action of RESOLUTIONS) {
        assert.equal(applyResolution({ action, authorizedBy: 'telegram:1', deps }).status, 409);
    }
});

test('#5923 keep-original deja el allowlist igual y marca el riesgo como asumido', () => {
    const h = makeDeps();
    const out = applyResolution({ action: 'keep-original', authorizedBy: 'telegram:111222333', deps: h.deps });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.allowedIssues, [5923, 5924], 'no suma ni saca nada');
    assert.equal(h.calls.set.length, 1);
    assert.equal(h.calls.set[0].opts.acceptedDepRisk, true);
    assert.equal(h.calls.set[0].opts.authorizedBy, 'telegram:111222333', 'el operador real, no un literal');
    assert.equal(h.calls.depsState, 1, 'limpia el state para que la alerta no reincida');
    assert.ok(out.body.msg.length > 0, 'mensaje concreto para el toast del operador');
});

test('#5923 cancel-partial-pause levanta la pausa pasando el operador real al gate', () => {
    const h = makeDeps();
    const out = applyResolution({ action: 'cancel-partial-pause', authorizedBy: 'telegram:111222333', deps: h.deps });
    assert.equal(out.status, 200);
    assert.equal(out.body.existed, true);
    assert.equal(h.calls.clear.length, 1);
    assert.equal(h.calls.clear[0].authorizedBy, 'telegram:111222333');
    assert.ok(h.calls.clear[0].justification.length > 0, 'el audit trail necesita justificación');
    assert.equal(h.calls.depsState, 1);
});

test('#5923 si el gate de autorización de partial-pause rechaza ⇒ 403, no 200 mentiroso', () => {
    const h = makeDeps('partial_pause', { clearPartialPause: () => ({ ok: false, rejected: true }) });
    const out = applyResolution({ action: 'cancel-partial-pause', authorizedBy: 'telegram:1', deps: h.deps });
    assert.equal(out.status, 403);
    assert.equal(out.body.ok, false);
    assert.equal(h.calls.depsState, 0, 'no limpia el state si no se aplicó nada');
});

test('#5923 una acción fuera del contrato ⇒ 404 sin consultar siquiera el modo', () => {
    let consultas = 0;
    const deps = { getPipelineMode: () => { consultas++; return { mode: 'partial_pause' }; } };
    for (const action of ['include-deps', '../kill-agent', '', null, 'KEEP-ORIGINAL']) {
        const out = applyResolution({ action, authorizedBy: 'telegram:1', deps });
        assert.equal(out.status, 404, `${action} no es resolución de este endpoint`);
    }
    assert.equal(consultas, 0);
});

test('#5923 RESOLUTIONS coincide con los paths que rutea el callback-handler', () => {
    const path = require('path');
    const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
    const handler = require(path.join(REPO_ROOT, '.claude', 'hooks', 'commander', 'callback-handler.js'));
    for (const action of RESOLUTIONS) {
        assert.equal(handler.PP_ROUTES[action], `/api/partial-pause/${action}`,
            `${action} tiene que estar ruteado o el botón queda muerto`);
    }
    // `include-deps` ya existía y sigue ruteado.
    assert.equal(handler.PP_ROUTES['include-deps'], '/api/partial-pause/include-deps');
});

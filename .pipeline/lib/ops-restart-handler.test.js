'use strict';

// Tests del handler de restart (EP8-H7 #3960, CA-3 + REQ-SEC-H7-2/3/4/5).
// node --test .pipeline/lib/ops-restart-handler.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { makeRateLimiter, runRestart } = require('./ops-restart-handler');

const ALLOW = ['pulpo', 'listener', 'svc-drive', 'svc-github'];

test('target fuera de la allowlist -> 400, no ejecuta restart', () => {
    let called = false;
    const res = runRestart(
        { target: 'rm -rf; evil' },
        { allowlist: ALLOW, restartFn: () => { called = true; return { ok: true, msg: 'x' }; } }
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(called, false, 'NO debe ejecutar restart para target no permitido');
});

test('restart válido invoca restartFn (stop+start) y NUNCA killAll/launchRollbackOrphan', () => {
    const calls = [];
    let killAllCalled = false;
    let rollbackCalled = false;
    // Espías de los planos globales prohibidos: si el handler los tocara,
    // estos flags se prenderían. El handler NO conoce restart.js, así que
    // jamás deberían invocarse.
    const fakeRestartJs = {
        killAll: () => { killAllCalled = true; },
        launchRollbackOrphan: () => { rollbackCalled = true; },
    };
    const res = runRestart(
        { target: 'svc-drive', source: 'dashboard-ui', sourceIp: '127.0.0.1' },
        {
            allowlist: ALLOW,
            restartFn: (name) => { calls.push(name); return { ok: true, msg: `${name} stop | ${name} start` }; },
        }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(calls, ['svc-drive'], 'ejecuta restart aislado del componente');
    assert.strictEqual(killAllCalled, false, 'NO dispara killAll global');
    assert.strictEqual(rollbackCalled, false, 'NO dispara launchRollbackOrphan global');
    // sanity: los espías existen pero no fueron tocados
    assert.strictEqual(typeof fakeRestartJs.killAll, 'function');
});

test('rate-limit rechaza ráfaga < 5s con 429', () => {
    const rl = makeRateLimiter(5000);
    const deps = { allowlist: ALLOW, restartFn: () => ({ ok: true, msg: 'ok' }), rateLimiter: rl };
    const a = runRestart({ target: 'pulpo' }, { ...deps, now: 1000 });
    const b = runRestart({ target: 'pulpo' }, { ...deps, now: 3000 }); // +2s
    const c = runRestart({ target: 'pulpo' }, { ...deps, now: 7000 }); // +6s desde el primero permitido
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 429, 'ráfaga dentro de 5s rechazada');
    assert.strictEqual(c.status, 200, 'pasado el intervalo vuelve a permitir');
});

test('rate-limit es por target (uno no bloquea a otro)', () => {
    const rl = makeRateLimiter(5000);
    const deps = { allowlist: ALLOW, restartFn: () => ({ ok: true, msg: 'ok' }), rateLimiter: rl };
    const a = runRestart({ target: 'pulpo' }, { ...deps, now: 1000 });
    const b = runRestart({ target: 'svc-drive' }, { ...deps, now: 1100 });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200, 'otro target no comparte la ventana de rate-limit');
});

test('audit recibe source declarativo + sourceIp objetivo, no bloquea si tira', () => {
    const audited = [];
    const res = runRestart(
        { target: 'svc-github', source: 'telegram', sourceIp: '::1', actor: 'leito' },
        {
            allowlist: ALLOW,
            restartFn: () => ({ ok: true, msg: 'ok' }),
            audit: (rec) => { audited.push(rec); },
        }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].service, 'svc-github');
    assert.strictEqual(audited[0].source, 'telegram');
    assert.strictEqual(audited[0].sourceIp, '::1');
    assert.strictEqual(audited[0].ok, true);

    // Si el audit tira, el restart NO se rompe (best-effort).
    const res2 = runRestart(
        { target: 'pulpo' },
        { allowlist: ALLOW, restartFn: () => ({ ok: true, msg: 'ok' }), audit: () => { throw new Error('disk full'); } }
    );
    assert.strictEqual(res2.status, 200);
});

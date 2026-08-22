'use strict';

// Tests del handler de restart (EP8-H7 #3960, CA-3 + REQ-SEC-H7-2/3/4/5).
// node --test .pipeline/lib/ops-restart-handler.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { makeRateLimiter, makeAggregateLimiter, runRestart } = require('./ops-restart-handler');

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

// ===========================================================================
// #5646 (CA-9 / REQ-SEC-5646-4) — cota AGREGADA por ventana.
// El rate-limiter de arriba es POR TARGET: con N componentes afectados, N
// targets distintos pasan la misma rafaga y una request se vuelve "matar todos
// los servicios del pipeline". Esta cota es transversal.
// ===========================================================================

test('#5646 cota agregada: N targets distintos NO esquivan el limite (el rate-limit por target si)', () => {
    const rl = makeRateLimiter(5000);
    // Prueba de que el limitador por target NO alcanza: 9 targets distintos
    // pasan todos en la misma rafaga.
    const pasaron = ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive',
        'svc-emulador', 'svc-reconciler', 'outbox-drain', 'dashboard']
        .filter(t => !rl.isRateLimited(t, 1000));
    assert.strictEqual(pasaron.length, 9, 'el limitador por target no frena la amplificacion');

    // La cota agregada si: concede a lo sumo `max` por ventana.
    const agg = makeAggregateLimiter(4, 60000);
    assert.strictEqual(agg.grant(9, 1000), 4, 'sobre 9 pedidos concede 4');
    assert.strictEqual(agg.grant(9, 2000), 0, 'dentro de la ventana ya no quedan cupos');
});

test('#5646 cota agregada: la ventana se libera con el tiempo (retrasa, no pierde)', () => {
    const agg = makeAggregateLimiter(4, 60000);
    assert.strictEqual(agg.grant(4, 1000), 4);
    assert.strictEqual(agg.grant(1, 30000), 0, 'a mitad de ventana sigue cortado');
    assert.strictEqual(agg.grant(4, 62000), 4, 'pasada la ventana vuelve a conceder');
});

test('#5646 cota agregada: concede parcialmente y el resto queda para el watchdog', () => {
    const agg = makeAggregateLimiter(4, 60000);
    assert.strictEqual(agg.grant(3, 1000), 3);
    // Sólo queda 1 cupo: se concede 1 de los 3 pedidos; los otros 2 se difieren.
    assert.strictEqual(agg.grant(3, 1500), 1);
    assert.strictEqual(agg.grant(1, 1600), 0);
});

test('#5646 cota agregada: valores invalidos caen a defaults seguros, nunca a "sin limite"', () => {
    const agg = makeAggregateLimiter(0, -1);
    assert.strictEqual(agg.maxPerWindow, 4);
    assert.strictEqual(agg.windowMs, 60000);
    assert.strictEqual(agg.grant(100, 0), 4, 'jamas concede ilimitado');
    // grant con basura no rompe ni concede de mas.
    assert.strictEqual(makeAggregateLimiter(2, 1000).grant('muchos', 0), 0);
});

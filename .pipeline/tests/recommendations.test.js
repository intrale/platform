'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const reco = require('../lib/recommendations');

function fakeRunner(scripted) {
    const calls = [];
    const queue = scripted.slice();
    const fn = (args) => {
        calls.push(args);
        const next = queue.shift();
        if (!next) return { ok: false, stdout: '', stderr: 'no more responses', status: 1 };
        return Object.assign({ ok: false, stdout: '', stderr: '', status: 0 }, next);
    };
    fn.calls = calls;
    return fn;
}

test('parseIssues filtra los que ya estan approved o rejected', () => {
    const raw = JSON.stringify([
        { number: 1, title: '[guru] mejora caching', url: 'u1', labels: [{ name: 'tipo:recomendacion' }, { name: 'needs-human' }], createdAt: '2026-04-26T08:00:00Z' },
        { number: 2, title: '[security] revisar JWT', url: 'u2', labels: [{ name: 'tipo:recomendacion' }, { name: 'recommendation:approved' }] },
        { number: 3, title: '[ux] modal accesible', url: 'u3', labels: [{ name: 'tipo:recomendacion' }, { name: 'recommendation:rejected' }] },
        { number: 4, title: 'No reco', url: 'u4', labels: [{ name: 'bug' }] },
    ]);
    const items = reco.parseIssues(raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 1);
    assert.equal(items[0].sourceAgent, 'guru');
});

test('parseIssues detecta sourceAgent por titulo y por label agent:*', () => {
    const raw = JSON.stringify([
        { number: 10, title: '[security] foo', labels: [{ name: 'tipo:recomendacion' }] },
        { number: 11, title: 'sin prefijo', labels: [{ name: 'tipo:recomendacion' }, { name: 'agent:review' }] },
        { number: 12, title: 'sin nada', labels: [{ name: 'tipo:recomendacion' }] },
    ]);
    const items = reco.parseIssues(raw);
    const map = Object.fromEntries(items.map(i => [i.number, i.sourceAgent]));
    assert.equal(map[10], 'security');
    assert.equal(map[11], 'review');
    assert.equal(map[12], 'unknown');
});

test('parseIssues detecta fromIssue desde label from-issue:N', () => {
    const raw = JSON.stringify([
        { number: 20, title: '[po] x', labels: [{ name: 'tipo:recomendacion' }, { name: 'from-issue:1234' }] },
        { number: 21, title: '[po] y', labels: [{ name: 'tipo:recomendacion' }] },
    ]);
    const items = reco.parseIssues(raw);
    const m = Object.fromEntries(items.map(i => [i.number, i.fromIssue]));
    assert.equal(m[20], 1234);
    assert.equal(m[21], null);
});

test('parseIssues devuelve [] cuando el JSON es invalido', () => {
    assert.deepEqual(reco.parseIssues('no es json'), []);
    assert.deepEqual(reco.parseIssues('null'), []);
    assert.deepEqual(reco.parseIssues('{}'), []);
});

test('refreshCache persiste cache exitoso', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-'));
    const cacheFile = path.join(tmp, 'cache.json');
    try {
        const ghRunner = fakeRunner([
            { ok: true, stdout: JSON.stringify([
                { number: 50, title: '[ux] x', url: 'u', labels: [{ name: 'tipo:recomendacion' }], createdAt: '2026-04-26T08:00:00Z' }
            ]) }
        ]);
        const cache = await reco.refreshCache({ ghRunner, repo: 'test/repo', cacheFile });
        assert.equal(cache.items.length, 1);
        assert.equal(cache.items[0].number, 50);
        assert.equal(cache.error, null);
        assert.ok(cache.updatedAt > 0);
        const persisted = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.equal(persisted.items[0].number, 50);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('refreshCache captura errores de gh sin tirar excepcion', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-'));
    try {
        const ghRunner = fakeRunner([
            { ok: false, stdout: '', stderr: 'gh: not authenticated\n', status: 4 }
        ]);
        const cache = await reco.refreshCache({ ghRunner, cacheFile: path.join(tmp, 'c.json') });
        assert.equal(cache.items.length, 0);
        assert.equal(cache.error, 'gh: not authenticated');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('approve agrega label approved y remueve needs-human', () => {
    const ghRunner = fakeRunner([
        { ok: true },
        { ok: true },
    ]);
    const r = reco.approve({ issue: 99, ghRunner, repo: 'test/repo' });
    assert.equal(r.ok, true);
    assert.equal(ghRunner.calls.length, 2);
    assert.deepEqual(ghRunner.calls[0], ['issue', 'edit', '99', '--repo', 'test/repo', '--add-label', 'recommendation:approved']);
    assert.deepEqual(ghRunner.calls[1], ['issue', 'edit', '99', '--repo', 'test/repo', '--remove-label', 'needs-human']);
});

test('approve falla limpio si no se puede agregar el label', () => {
    const ghRunner = fakeRunner([{ ok: false, stderr: 'forbidden', status: 1 }]);
    const r = reco.approve({ issue: 99, ghRunner, repo: 'test/repo' });
    assert.equal(r.ok, false);
    assert.match(r.msg, /No se pudo agregar label aprobado/);
    assert.equal(ghRunner.calls.length, 1);
});

test('approve reporta aprobacion parcial si remueve falla', () => {
    const ghRunner = fakeRunner([
        { ok: true },
        { ok: false, stderr: 'no permission', status: 1 },
    ]);
    const r = reco.approve({ issue: 99, ghRunner, repo: 'test/repo' });
    assert.equal(r.ok, false);
    assert.match(r.msg, /Aprobaci.n parcial/);
});

test('reject agrega label rejected y cierra issue (sin razon)', () => {
    const ghRunner = fakeRunner([
        { ok: true },
        { ok: true },
    ]);
    const r = reco.reject({ issue: 77, ghRunner, repo: 'test/repo' });
    assert.equal(r.ok, true);
    assert.equal(ghRunner.calls.length, 2);
    assert.deepEqual(ghRunner.calls[0], ['issue', 'edit', '77', '--repo', 'test/repo', '--add-label', 'recommendation:rejected']);
    assert.deepEqual(ghRunner.calls[1], ['issue', 'close', '77', '--repo', 'test/repo', '--reason', 'not planned']);
});

test('reject incluye comentario si se pasa razon', () => {
    const ghRunner = fakeRunner([
        { ok: true },
        { ok: true },
    ]);
    const r = reco.reject({ issue: 77, ghRunner, reason: '  no aplica al producto  ' });
    assert.equal(r.ok, true);
    const closeCall = ghRunner.calls[1];
    assert.equal(closeCall[closeCall.length - 2], '--comment');
    assert.match(closeCall[closeCall.length - 1], /no aplica al producto/);
});

test('reject falla si no se puede etiquetar', () => {
    const ghRunner = fakeRunner([{ ok: false, stderr: 'rate limit', status: 1 }]);
    const r = reco.reject({ issue: 77, ghRunner });
    assert.equal(r.ok, false);
    assert.match(r.msg, /No se pudo etiquetar rechazo/);
});

test('isFresh devuelve true solo dentro de la ventana TTL', () => {
    const now = 1_000_000_000_000;
    assert.equal(reco.isFresh({ updatedAt: now - 60_000 }, now), true);
    assert.equal(reco.isFresh({ updatedAt: now - 6 * 60_000 }, now), false);
    assert.equal(reco.isFresh({}, now), false);
    assert.equal(reco.isFresh(null, now), false);
});

test('readCache devuelve estructura vacia cuando el archivo no existe', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-'));
    try {
        const c = reco.readCache(path.join(tmp, 'no-existe.json'));
        assert.deepEqual(c.items, []);
        assert.equal(c.updatedAt, 0);
        assert.equal(c.error, null);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

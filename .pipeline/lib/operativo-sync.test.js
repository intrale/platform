'use strict';

// Tests de operativo-sync.js (#4460 fix rebote rev-1) — avance seguro del tree
// del modelo operativo a origin/main SIN killAll.
// node --test .pipeline/lib/operativo-sync.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sync = require('./operativo-sync');
const runtimeBoot = require('./runtime-boot');

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// Repo git hermético con un "remoto" local (otro repo bare) para poder fetchear.
// Simula: origin/main tiene un commit operativo que el tree local todavía no
// aplicó → syncOperativoTree debe avanzarlo y escribir el marker con el HEAD nuevo.
function buildRepoConRemoto() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'osync-'));
    const remote = path.join(base, 'remote.git');
    const local = path.join(base, 'local');

    // Remoto bare.
    fs.mkdirSync(remote, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main'], remote);

    // Local: commit base, push a main.
    git(['clone', '-q', remote, local], base);
    git(['config', 'user.email', 'test@intrale.com'], local);
    git(['config', 'user.name', 'Test'], local);
    git(['config', 'commit.gpgsign', 'false'], local);
    fs.mkdirSync(path.join(local, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(local, '.pipeline', 'boot.js'), 'v1\n');
    git(['add', '-A'], local);
    git(['commit', '-q', '-m', 'chore: base'], local);
    git(['push', '-q', 'origin', 'main'], local);
    const shaBase = git(['rev-parse', 'HEAD'], local);

    // Un SEGUNDO clon avanza main con un commit operativo nuevo y lo pushea.
    const other = path.join(base, 'other');
    git(['clone', '-q', remote, other], base);
    git(['config', 'user.email', 'test@intrale.com'], other);
    git(['config', 'user.name', 'Test'], other);
    git(['config', 'commit.gpgsign', 'false'], other);
    fs.writeFileSync(path.join(other, '.pipeline', 'boot.js'), 'v2 (Closes #4460)\n');
    git(['add', '-A'], other);
    git(['commit', '-q', '-m', 'feat: cambio operativo (Closes #4460)'], other);
    git(['push', '-q', 'origin', 'main'], other);
    const shaNuevo = git(['rev-parse', 'HEAD'], other);

    return { base, local, shaBase, shaNuevo };
}

test('syncOperativoTree: avanza el tree a origin/main y escribe el marker con el HEAD nuevo', () => {
    const { local, shaBase, shaNuevo } = buildRepoConRemoto();
    // Precondición: el tree local está en shaBase (viejo).
    assert.strictEqual(git(['rev-parse', 'HEAD'], local), shaBase);

    const res = sync.syncOperativoTree({ repoRoot: local, pipelineDir: local });
    assert.strictEqual(res.ok, true, res.msg);
    assert.strictEqual(res.synced, true);
    assert.strictEqual(res.wroteMarker, true);

    // El tree avanzó al commit nuevo.
    assert.strictEqual(git(['rev-parse', 'HEAD'], local), shaNuevo);
    // El marker refleja el HEAD nuevo → la señal de drift desaparece (CA-4).
    const marker = runtimeBoot.readBootMarker({ pipelineDir: local });
    assert.ok(marker, 'marker escrito');
    assert.strictEqual(marker.sha, shaNuevo);
});

test('syncOperativoTree: sin remoto/red → ok:false y NO toca el marker (no miente)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osync-noremote-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@intrale.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'base'], dir);

    const res = sync.syncOperativoTree({ repoRoot: dir, pipelineDir: dir });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.synced, false);
    // No se escribió marker: mejor un banner que persiste que un marker mentiroso.
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }), null);
});

test('syncOperativoTree: usa execFile con args-array (no shell) — exec inyectable recibe arrays', () => {
    const calls = [];
    const fakeExec = (args) => {
        assert.ok(Array.isArray(args), 'args siempre es array, nunca string de shell');
        calls.push(args);
        if (args[0] === 'rev-parse') return 'abc1234def5678\n';
        return '';
    };
    const written = [];
    const res = sync.syncOperativoTree({
        repoRoot: '/fake',
        pipelineDir: '/fake',
        exec: fakeExec,
        writeMarker: (shaArg, wo) => { written.push({ shaArg, wo }); return { ok: true }; },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sha, 'abc1234def5678');
    // Orden esperado: fetch, reset, rev-parse.
    assert.deepStrictEqual(calls[0], ['fetch', 'origin', 'main']);
    assert.deepStrictEqual(calls[1], ['reset', '--hard', 'FETCH_HEAD']);
    assert.deepStrictEqual(calls[2], ['rev-parse', 'HEAD']);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].shaArg, 'abc1234def5678');
});

test('syncOperativoTree: HEAD post-sync no-hex → ok:false, no escribe marker', () => {
    const written = [];
    const res = sync.syncOperativoTree({
        exec: (args) => (args[0] === 'rev-parse' ? 'HEAD; rm -rf .\n' : ''),
        writeMarker: (s, o) => { written.push(s); return { ok: true }; },
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(written.length, 0, 'marker NO se escribe con HEAD inválido');
});

test('syncOperativoTree: fetch falla → ok:false, no llega a reset ni rev-parse', () => {
    const calls = [];
    const res = sync.syncOperativoTree({
        exec: (args) => {
            calls.push(args[0]);
            if (args[0] === 'fetch') throw new Error('network down');
            return '';
        },
        writeMarker: () => ({ ok: true }),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.synced, false);
    assert.deepStrictEqual(calls, ['fetch'], 'aborta tras el fetch fallido');
});

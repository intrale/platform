// =============================================================================
// Tests prepareWorkspace (worktree-launcher.js) — extension point de #4694.
//
// Cubre:
//   - CA-B1: con manifiesto override, el prefijo del path y la base ref reflejan
//     el manifiesto (NO los literales 'platform.' / 'origin/main').
//   - CA-B4: con projectId=intrale-platform (default) el path es EXACTAMENTE
//     'platform.agent-<issue>-<skill>' y la base ref 'main'.
//   - CA-SEC-2: base ref con metacaracteres o leading '-' ⇒ rechaza, NO ejecuta git.
//   - CA-SEC-1: projectId con traversal ⇒ rechaza, NO ejecuta git.
//   - Migración a execFileSync (args como array, shell:false).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { prepareWorkspace, WorktreeLaunchError } = require('../worktree-launcher');

// fsImpl identidad: realpath devuelve el path tal cual (no toca disco).
const fsIdentity = { realpathSync: (p) => p, existsSync: () => false };

function capture() {
    const calls = [];
    return {
        calls,
        execFileImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return ''; },
    };
}

// ---- CA-B1 · Manifiesto override -------------------------------------------

test('CA-B1 · manifiesto override ⇒ prefijo y base ref del manifiesto (no platform./origin/main)', () => {
    const manifest = {
        projectId: 'acme-shop',
        repos: { primary: 'acme/shop', allowlist: ['acme/shop'], default_base_ref: 'develop' },
    };
    const { execFileImpl, calls } = capture();

    const res = prepareWorkspace({
        ROOT: '/srv/acme/main', issue: 42, skill: 'backend-dev',
        manifest, execFileImpl, fsImpl: fsIdentity,
    });

    assert.equal(path.basename(res.worktreePath), 'acme-shop.agent-42-backend-dev');
    assert.ok(!path.basename(res.worktreePath).startsWith('platform.'), 'no debe usar el literal platform.');
    assert.equal(res.worktreeBranch, 'agent/42-backend-dev');
    assert.equal(res.baseRef, 'develop');

    // git worktree add via execFileSync con args array + shell:false.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args,
        ['worktree', 'add', res.worktreePath, '-b', 'agent/42-backend-dev', 'develop']);
    assert.equal(calls[0].opts.shell, false);
});

// ---- CA-B4 · Paridad hacia atrás (default) ----------------------------------

test('CA-B4 · projectId=intrale-platform ⇒ path exactamente platform.agent-<issue>-<skill>', () => {
    const manifest = { projectId: 'intrale-platform', repos: { primary: 'intrale/platform', default_base_ref: 'main' } };
    const { execFileImpl, calls } = capture();

    const res = prepareWorkspace({
        ROOT: '/repo/main', issue: 4694, skill: 'pipeline-dev',
        manifest, execFileImpl, fsImpl: fsIdentity,
    });

    assert.equal(path.basename(res.worktreePath), 'platform.agent-4694-pipeline-dev');
    assert.equal(res.baseRef, 'main');
    assert.equal(calls[0].args[5], 'main');
});

// ---- CA-SEC-2 · base ref injection ⇒ NO ejecuta git -------------------------

test('CA-SEC-2 · base ref con metacaracteres/leading "-" ⇒ rechaza sin ejecutar git', () => {
    for (const badRef of [';id', '$(id)', '`id`', '--upload-pack=/x', 'a b']) {
        const manifest = { projectId: 'intrale-platform', repos: { primary: 'intrale/platform', default_base_ref: badRef } };
        const { execFileImpl, calls } = capture();
        assert.throws(
            () => prepareWorkspace({
                ROOT: '/repo/main', issue: 1, skill: 'pipeline-dev',
                manifest, execFileImpl, fsImpl: fsIdentity,
            }),
            /base ref inv.lido/,
            `debe rechazar base ref ${JSON.stringify(badRef)}`,
        );
        assert.equal(calls.length, 0, 'NO debe ejecutar git con base ref inv.lido');
    }
});

// ---- CA-SEC-1 · projectId traversal ⇒ NO ejecuta git ------------------------

test('CA-SEC-1 · projectId con traversal ⇒ rechaza sin ejecutar git', () => {
    for (const badId of ['../evil', 'a/b', '..']) {
        const manifest = { projectId: badId, repos: { primary: 'intrale/platform', default_base_ref: 'main' } };
        const { execFileImpl, calls } = capture();
        assert.throws(
            () => prepareWorkspace({
                ROOT: '/repo/main', issue: 1, skill: 'pipeline-dev',
                manifest, execFileImpl, fsImpl: fsIdentity,
            }),
            /base de repo inv.lida/,
            `debe rechazar projectId ${JSON.stringify(badId)}`,
        );
        assert.equal(calls.length, 0, 'NO debe ejecutar git con projectId traversal');
    }
});

// ---- Inputs base (issue/skill) siguen validándose --------------------------

test('prepareWorkspace rechaza issue no numérico y skill inseguro (defense-in-depth)', () => {
    const { execFileImpl, calls } = capture();
    assert.throws(() => prepareWorkspace({
        ROOT: '/repo/main', issue: '1; rm -rf /', skill: 'pipeline-dev',
        execFileImpl, fsImpl: fsIdentity,
    }), (e) => e instanceof WorktreeLaunchError && e.code === 'INVALID_ISSUE');
    assert.throws(() => prepareWorkspace({
        ROOT: '/repo/main', issue: 1, skill: 'BAD skill',
        execFileImpl, fsImpl: fsIdentity,
    }), (e) => e instanceof WorktreeLaunchError && e.code === 'INVALID_SKILL');
    assert.equal(calls.length, 0);
});

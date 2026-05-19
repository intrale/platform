// =============================================================================
// Tests worktree-resolver.js — issue #2591 (fast-fail + auto-recovery validado)
//
// Cobertura:
//   - Validación dura de inputs (issue/skill) → falla loud.
//   - Parser de `git worktree list --porcelain`.
//   - Path feliz: worktree existente del issue → found:true sin recovery.
//   - Worktree faltante + no remote → found:false con reason explícita.
//   - Worktree faltante + remote sin verificar → found:false + branchOriginVerified:false.
//   - Worktree faltante + remote verificado (author allowlisted) → recovered:true.
//   - Worktree faltante + remote verificado (marker en commit) → recovered:true.
//   - Adversariales: command injection en issue/skill → rechazo upfront, sin git calls.
//   - Worktree path existe pero git no lo conoce → NO auto-borra, abortamos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveExistingWorktree,
    findIssueWorktree,
    parseWorktreeList,
    remoteBranchExists,
    verifyRemoteBranchOrigin,
    attemptAutoRecovery,
    PIPELINE_COMMITTER_ALLOWLIST,
    PIPELINE_COMMIT_MARKER,
} = require('../worktree-resolver');

// ---- helpers de fake ---------------------------------------------------------

/**
 * Build a fake `spawnSync` que matchea por args.join(' ') contra una lista de
 * handlers ordenados. El primero que matchee se aplica. Si ninguno matchea,
 * la llamada falla loud — eso evita falsos positivos por handlers olvidados.
 */
function makeFakeSpawn(handlers) {
    return function fakeSpawn(cmd, args, _opts) {
        const joined = `${cmd} ${args.join(' ')}`;
        for (const h of handlers) {
            const match = h.match instanceof RegExp ? h.match.test(joined) : joined.includes(h.match);
            if (!match) continue;
            if (h.throw) {
                return { error: new Error(h.throw), status: null, stdout: '', stderr: '' };
            }
            return {
                error: null,
                status: h.status ?? 0,
                stdout: h.stdout ?? '',
                stderr: h.stderr ?? '',
            };
        }
        throw new Error(`fakeSpawn sin handler para: ${joined}`);
    };
}

function fakeFs(exists) {
    return { existsSync: (p) => (typeof exists === 'function' ? exists(p) : !!exists) };
}

// ---- parseWorktreeList -------------------------------------------------------

test('parseWorktreeList — parsea múltiples entradas con branch', () => {
    const input = [
        'worktree /c/Workspaces/Intrale/platform',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /c/Workspaces/Intrale/platform.agent-2505-delivery',
        'HEAD bbb',
        'branch refs/heads/agent/2505-delivery',
        '',
    ].join('\n');
    const parsed = parseWorktreeList(input);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].worktree, '/c/Workspaces/Intrale/platform.agent-2505-delivery');
    assert.equal(parsed[1].branch, 'refs/heads/agent/2505-delivery');
});

test('parseWorktreeList — tolera entrada sin trailing newline', () => {
    const parsed = parseWorktreeList('worktree /repo\nHEAD aaa\nbranch refs/heads/main');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].worktree, '/repo');
});

test('parseWorktreeList — input vacío devuelve []', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    assert.deepEqual(parseWorktreeList(null), []);
});

// ---- findIssueWorktree -------------------------------------------------------

test('findIssueWorktree — encuentra el worktree del issue', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /repo',
                'HEAD a',
                'branch refs/heads/main',
                '',
                'worktree /tmp/platform.agent-2505-delivery',
                'HEAD b',
                'branch refs/heads/agent/2505-delivery',
                '',
            ].join('\n'),
        },
    ]);
    const fsImpl = fakeFs(true);
    const result = findIssueWorktree('/repo', 2505, { spawnImpl, fsImpl });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-2505-delivery');
});

test('findIssueWorktree — null si el path no existe físicamente', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: 'worktree /tmp/platform.agent-2505-delivery\nHEAD x\nbranch refs/heads/agent/2505-delivery\n\n',
        },
    ]);
    const fsImpl = fakeFs((p) => p === '/repo'); // Solo ROOT existe
    const result = findIssueWorktree('/repo', 2505, { spawnImpl, fsImpl });
    assert.equal(result, null);
});

test('findIssueWorktree — null si ningún worktree matchea', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\n',
        },
    ]);
    const result = findIssueWorktree('/repo', 9999, { spawnImpl, fsImpl: fakeFs(true) });
    assert.equal(result, null);
});

// ---- remoteBranchExists ------------------------------------------------------

test('remoteBranchExists — true si ls-remote devuelve refs', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', stdout: 'abc123\trefs/heads/agent/2505-delivery\n' },
    ]);
    assert.equal(remoteBranchExists('/repo', 'agent/2505-delivery', { spawnImpl }), true);
});

test('remoteBranchExists — false si stdout vacío', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', stdout: '' },
    ]);
    assert.equal(remoteBranchExists('/repo', 'agent/9999-x', { spawnImpl }), false);
});

test('remoteBranchExists — false si git falla', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', status: 128, stderr: 'fatal: no upstream' },
    ]);
    assert.equal(remoteBranchExists('/repo', 'agent/9999-x', { spawnImpl }), false);
});

// ---- verifyRemoteBranchOrigin -----------------------------------------------

test('verifyRemoteBranchOrigin — acepta autor en allowlist', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-delivery', { spawnImpl });
    assert.equal(v.ok, true);
    assert.match(v.reason, /author-allowlisted/);
});

test('verifyRemoteBranchOrigin — acepta marker pipeline-v2 aunque autor no esté en allowlist', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B', stdout: 'fix: algo\n\nGenerated by pipeline-v2 hook\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-delivery', { spawnImpl });
    assert.equal(v.ok, true);
    assert.equal(v.reason, 'pipeline-marker-found');
});

test('verifyRemoteBranchOrigin — rechaza autor desconocido sin marker', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B', stdout: 'fix: algo random\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-malicious', { spawnImpl });
    assert.equal(v.ok, false);
    assert.match(v.reason, /author-not-allowlisted:attacker@evil\.com/);
});

test('verifyRemoteBranchOrigin — rechaza si fetch falla (conservador)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', status: 128, stderr: 'fatal: network' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-x', { spawnImpl });
    assert.equal(v.ok, false);
    assert.match(v.reason, /fetch-failed/);
});

// ---- attemptAutoRecovery -----------------------------------------------------

test('attemptAutoRecovery — branch verificada → worktree add OK', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-delivery\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
        { match: 'git worktree prune', stdout: '' },
        { match: 'git worktree add', stdout: '' },
    ]);
    const fsImpl = fakeFs(false); // path no existe
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, true);
    assert.equal(result.branchOriginVerified, true);
});

test('attemptAutoRecovery — sin remote → abort branchOriginVerified:null', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote', stdout: '' },
    ]);
    const fsImpl = fakeFs(false);
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, false);
    assert.equal(result.branchOriginVerified, null);
    assert.match(result.reason, /remote-branch-missing/);
});

test('attemptAutoRecovery — remote no verificado → abort branchOriginVerified:false', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-malicious\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B', stdout: 'malicious commit\n' },
    ]);
    const fsImpl = fakeFs(false);
    const logs = [];
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', {
        spawnImpl, fsImpl, log: (m) => logs.push(m),
    });
    assert.equal(result.ok, false);
    assert.equal(result.branchOriginVerified, false);
    assert.match(result.reason, /branch-origin-unverified/);
    assert.ok(logs.some(l => l.includes('auto-recovery rechazado')));
});

test('attemptAutoRecovery — path ya existe sin entry git → NO auto-borra', () => {
    const spawnImpl = makeFakeSpawn([
        // Importante: NO debe llamar ls-remote ni nada — chequea fs primero.
    ]);
    const fsImpl = fakeFs(true);
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /worktree-path-exists-without-git-entry/);
    assert.equal(result.branchOriginVerified, null);
});

// ---- resolveExistingWorktree -------------------------------------------------

test('resolveExistingWorktree — worktree encontrado → found:true sin recovery', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: 'worktree /tmp/platform.agent-2505-delivery\nHEAD x\nbranch refs/heads/agent/2505-delivery\n\n',
        },
    ]);
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 2505, skill: 'delivery',
        spawnImpl, fsImpl: fakeFs(true),
    });
    assert.equal(result.found, true);
    assert.equal(result.recovered, false);
    assert.equal(result.worktreePath, '/tmp/platform.agent-2505-delivery');
});

test('resolveExistingWorktree — sin worktree + sin recovery → found:false', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: 'worktree /repo\nbranch refs/heads/main\n\n' },
    ]);
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 2505, skill: 'delivery',
        spawnImpl, fsImpl: fakeFs((p) => p === '/repo'),
        allowAutoRecovery: false,
    });
    assert.equal(result.found, false);
    assert.equal(result.reason, 'no-worktree-and-recovery-disabled');
});

test('resolveExistingWorktree — auto-recovery exitoso → found:true recovered:true', () => {
    const calls = [];
    const spawnImpl = makeFakeSpawn([
        // 1. búsqueda inicial: NO encuentra
        { match: 'git worktree list --porcelain', stdout: 'worktree /repo\nbranch refs/heads/main\n\n' },
        // 2. auto-recovery: ls-remote + fetch + log + add
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-delivery\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
        { match: 'git worktree prune', stdout: '' },
        { match: 'git worktree add', stdout: '' },
    ]);
    const fsImpl = fakeFs((p) => p === '/repo'); // worktree NO existe pero ROOT sí
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 2505, skill: 'delivery',
        spawnImpl, fsImpl,
        log: (m) => calls.push(m),
    });
    assert.equal(result.found, true);
    assert.equal(result.recovered, true);
    assert.equal(result.branchOriginVerified, true);
});

test('resolveExistingWorktree — auto-recovery rechazado por procedencia → found:false branchOriginVerified:false', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: 'worktree /repo\nbranch refs/heads/main\n\n' },
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-malicious\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B', stdout: 'malicious payload\n' },
    ]);
    const fsImpl = fakeFs((p) => p === '/repo');
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 2505, skill: 'delivery',
        spawnImpl, fsImpl,
    });
    assert.equal(result.found, false);
    assert.equal(result.branchOriginVerified, false);
    assert.match(result.reason, /branch-origin-unverified/);
});

// ---- Adversariales: command injection ---------------------------------------

test('resolveExistingWorktree — issue con `;rm -rf /` es rechazado sin spawn', () => {
    let called = false;
    const spawnImpl = () => { called = true; return { status: 0, stdout: '', stderr: '', error: null }; };
    assert.throws(
        () => resolveExistingWorktree({
            ROOT: '/repo', issue: '2505;rm -rf /', skill: 'delivery',
            spawnImpl, fsImpl: fakeFs(false),
        }),
        (e) => e.code === 'INVALID_ISSUE',
    );
    assert.equal(called, false, 'No debe ejecutar git ante input adversarial');
});

test('resolveExistingWorktree — skill con backticks es rechazado sin spawn', () => {
    let called = false;
    const spawnImpl = () => { called = true; return { status: 0, stdout: '', stderr: '', error: null }; };
    assert.throws(
        () => resolveExistingWorktree({
            ROOT: '/repo', issue: 2505, skill: 'delivery`whoami`',
            spawnImpl, fsImpl: fakeFs(false),
        }),
        (e) => e.code === 'INVALID_SKILL',
    );
    assert.equal(called, false);
});

test('resolveExistingWorktree — skill con $() es rechazado sin spawn', () => {
    let called = false;
    const spawnImpl = () => { called = true; return { status: 0, stdout: '', stderr: '', error: null }; };
    assert.throws(
        () => resolveExistingWorktree({
            ROOT: '/repo', issue: 2505, skill: 'delivery$(curl evil)',
            spawnImpl, fsImpl: fakeFs(false),
        }),
        (e) => e.code === 'INVALID_SKILL',
    );
    assert.equal(called, false);
});

test('resolveExistingWorktree — issue como string no numérica rechazado', () => {
    assert.throws(
        () => resolveExistingWorktree({
            ROOT: '/repo', issue: 'abc', skill: 'delivery',
            spawnImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
            fsImpl: fakeFs(false),
        }),
        (e) => e.code === 'INVALID_ISSUE',
    );
});

// ---- Worktree con espacios y caracteres especiales --------------------------

test('parseWorktreeList — soporta paths con espacios', () => {
    const input = [
        'worktree /tmp/path with spaces/platform.agent-2505-delivery',
        'HEAD aaa',
        'branch refs/heads/agent/2505-delivery',
        '',
    ].join('\n');
    const parsed = parseWorktreeList(input);
    assert.equal(parsed[0].worktree, '/tmp/path with spaces/platform.agent-2505-delivery');
});

// ---- Sanity de allowlist ----------------------------------------------------

test('PIPELINE_COMMITTER_ALLOWLIST contiene noreply@anthropic.com', () => {
    assert.ok(PIPELINE_COMMITTER_ALLOWLIST.has('noreply@anthropic.com'));
});

test('PIPELINE_COMMIT_MARKER es string no vacío', () => {
    assert.equal(typeof PIPELINE_COMMIT_MARKER, 'string');
    assert.ok(PIPELINE_COMMIT_MARKER.length > 0);
});

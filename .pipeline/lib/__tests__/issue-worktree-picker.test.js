// =============================================================================
// Tests issue-worktree-picker.js — rebote #3409 rev-2
//
// Cobertura:
//   - listIssueWorktrees: filtra por basename, ignora paths que no existen,
//     respeta orden de git worktree list.
//   - commitsAheadOfMain: parsea numérico, tolera errores con -1.
//   - rankWorktreesByFreshness: orden por commits ahead (desc), tie-break
//     por HEAD mtime (desc), worktrees broken al final.
//   - pickIssueWorktree: integra todo + callback onPick + atajo single.
//   - Regresión específica del bug #3409: dos worktrees del mismo issue
//     (android-dev=1 ahead, pipeline-dev=2 ahead) → gana pipeline-dev.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const picker = require('../issue-worktree-picker');
const {
    listIssueWorktrees,
    commitsAheadOfMain,
    rankWorktreesByFreshness,
    pickIssueWorktree,
} = picker;

// ---- fakes -------------------------------------------------------------------

/**
 * Fake execSync: matchea por substring (orden importa). Si ningún handler
 * matchea, devuelve string vacío (simulando comando que no produjo output).
 * Para simular falla, usar { throw: '<msg>' }.
 */
function makeFakeExec(handlers) {
    return function fakeExec(cmd, _opts) {
        for (const h of handlers) {
            const isMatch = h.match instanceof RegExp ? h.match.test(cmd) : cmd.includes(h.match);
            if (!isMatch) continue;
            if (h.cwdMatch && _opts && _opts.cwd && !_opts.cwd.includes(h.cwdMatch)) continue;
            if (h.throw) {
                const err = new Error(h.throw);
                throw err;
            }
            return h.stdout || '';
        }
        return '';
    };
}

function makeFakeFs(existing = new Set(), statMap = new Map()) {
    return {
        existsSync(p) { return existing.has(p); },
        statSync(p) {
            if (!statMap.has(p)) {
                const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err;
            }
            return statMap.get(p);
        },
        readFileSync(_p, _enc) { return ''; },
    };
}

// ---- listIssueWorktrees ------------------------------------------------------

test('listIssueWorktrees: matchea por basename del issue (default sin filtro existsSync)', () => {
    const ROOT = 'C:/Workspaces/Intrale/platform';
    const stdout = [
        'worktree C:/Workspaces/Intrale/platform',
        'worktree C:/Workspaces/Intrale/platform.agent-3409-android-dev',
        'worktree C:/Workspaces/Intrale/platform.agent-3409-pipeline-dev',
        'worktree C:/Workspaces/Intrale/platform.agent-9999-other-skill',
        '',
    ].join('\n');
    const fakeExec = makeFakeExec([{ match: 'git worktree list --porcelain', stdout }]);
    const fakeFs = makeFakeFs();
    const result = listIssueWorktrees(ROOT, 3409, { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(result, [
        'C:/Workspaces/Intrale/platform.agent-3409-android-dev',
        'C:/Workspaces/Intrale/platform.agent-3409-pipeline-dev',
    ]);
});

test('listIssueWorktrees: con requireExists=true ignora entradas de git con path ya borrado', () => {
    const ROOT = '/repo';
    const stdout = 'worktree /repo/platform.agent-100-dev\nworktree /repo/platform.agent-100-other\n';
    const fakeExec = makeFakeExec([{ match: 'worktree list', stdout }]);
    // Solo el primero existe físicamente.
    const fakeFs = makeFakeFs(new Set(['/repo/platform.agent-100-dev']));
    const result = listIssueWorktrees(ROOT, 100, {
        execSyncImpl: fakeExec, fsImpl: fakeFs, requireExists: true,
    });
    assert.deepEqual(result, ['/repo/platform.agent-100-dev']);
});

test('listIssueWorktrees: sin requireExists devuelve ambos worktrees aunque uno no exista físicamente', () => {
    const ROOT = '/repo';
    const stdout = 'worktree /repo/platform.agent-100-dev\nworktree /repo/platform.agent-100-other\n';
    const fakeExec = makeFakeExec([{ match: 'worktree list', stdout }]);
    const fakeFs = makeFakeFs(new Set(['/repo/platform.agent-100-dev']));
    // Default (sin requireExists) NO filtra — preserva semántica original.
    const result = listIssueWorktrees(ROOT, 100, { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(result, [
        '/repo/platform.agent-100-dev',
        '/repo/platform.agent-100-other',
    ]);
});

test('listIssueWorktrees: devuelve [] si git falla', () => {
    const fakeExec = makeFakeExec([{ match: 'worktree list', throw: 'git crashed' }]);
    const fakeFs = makeFakeFs();
    const result = listIssueWorktrees('/repo', 42, { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(result, []);
});

test('listIssueWorktrees: devuelve [] si issue o ROOT faltan', () => {
    const fakeExec = makeFakeExec([]);
    const fakeFs = makeFakeFs();
    assert.deepEqual(listIssueWorktrees(null, 42, { execSyncImpl: fakeExec, fsImpl: fakeFs }), []);
    assert.deepEqual(listIssueWorktrees('/repo', null, { execSyncImpl: fakeExec, fsImpl: fakeFs }), []);
});

test('listIssueWorktrees: NO matchea por substring del path (issue-3409 dentro de 13409 no debe colar)', () => {
    // Caso adversarial: si un worktree se llama `platform.agent-13409-foo`,
    // listar issue=3409 NO debería matchearlo. El picker matchea por basename
    // que empieza con `platform.agent-3409-`, no por substring.
    const stdout = 'worktree /repo/platform.agent-13409-foo\n';
    const fakeExec = makeFakeExec([{ match: 'worktree list', stdout }]);
    const fakeFs = makeFakeFs(new Set(['/repo/platform.agent-13409-foo']));
    const result = listIssueWorktrees('/repo', 3409, { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(result, []);
});

// ---- commitsAheadOfMain ------------------------------------------------------

test('commitsAheadOfMain: parsea conteo numérico', () => {
    const fakeExec = makeFakeExec([{ match: 'rev-list --count origin/main..HEAD', stdout: '7\n' }]);
    assert.equal(commitsAheadOfMain('/wt', { execSyncImpl: fakeExec }), 7);
});

test('commitsAheadOfMain: devuelve -1 si git falla', () => {
    const fakeExec = makeFakeExec([{ match: 'rev-list', throw: 'fatal: bad revision' }]);
    assert.equal(commitsAheadOfMain('/wt', { execSyncImpl: fakeExec }), -1);
});

test('commitsAheadOfMain: devuelve -1 si output no es numérico', () => {
    const fakeExec = makeFakeExec([{ match: 'rev-list', stdout: 'nope\n' }]);
    assert.equal(commitsAheadOfMain('/wt', { execSyncImpl: fakeExec }), -1);
});

// ---- rankWorktreesByFreshness -----------------------------------------------

test('rankWorktreesByFreshness: ordena por commits ahead desc', () => {
    const a = '/repo/platform.agent-3409-android-dev';
    const p = '/repo/platform.agent-3409-pipeline-dev';
    const fakeExec = makeFakeExec([
        { match: 'rev-list', cwdMatch: 'android-dev', stdout: '1\n' },
        { match: 'rev-list', cwdMatch: 'pipeline-dev', stdout: '2\n' },
    ]);
    const fakeFs = makeFakeFs(); // sin mtime → todos 0
    const ranked = rankWorktreesByFreshness([a, p], { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(ranked, [p, a]);
});

test('rankWorktreesByFreshness: tie en commits ahead → ordena por HEAD mtime desc', () => {
    const a = '/repo/platform.agent-100-dev';
    const b = '/repo/platform.agent-100-other';
    const fakeExec = makeFakeExec([
        { match: 'rev-list', cwdMatch: 'platform.agent-100-dev', stdout: '3\n' },
        { match: 'rev-list', cwdMatch: 'platform.agent-100-other', stdout: '3\n' },
    ]);
    // El fake usa `endsWith` para distinguir `.git` (worktree raíz) del
    // `HEAD` (archivo bajo gitdir). Si usáramos `includes()` ambos paths
    // (`.git` y `.git/HEAD`) matchearían el mismo branch y devolveríamos
    // siempre `{ isDirectory: true }`, perdiendo el mtime.
    const fakeFs = {
        existsSync: () => true,
        statSync(p) {
            const norm = String(p).replace(/\\/g, '/');
            if (norm.endsWith('platform.agent-100-dev/.git')) {
                return { isDirectory: () => true };
            }
            if (norm.endsWith('platform.agent-100-dev/.git/HEAD')) {
                return { mtimeMs: 100, mtime: new Date(100) };
            }
            if (norm.endsWith('platform.agent-100-other/.git')) {
                return { isDirectory: () => true };
            }
            if (norm.endsWith('platform.agent-100-other/.git/HEAD')) {
                return { mtimeMs: 500, mtime: new Date(500) };
            }
            const err = new Error(`ENOENT ${norm}`); err.code = 'ENOENT'; throw err;
        },
        readFileSync: () => '',
    };
    const ranked = rankWorktreesByFreshness([a, b], { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.deepEqual(ranked, [b, a]); // b es más reciente
});

test('rankWorktreesByFreshness: worktrees con git roto van al final', () => {
    const ok = '/repo/platform.agent-5-ok';
    const broken = '/repo/platform.agent-5-broken';
    const fakeExec = makeFakeExec([
        { match: 'rev-list', cwdMatch: 'platform.agent-5-ok', stdout: '0\n' },
        { match: 'rev-list', cwdMatch: 'platform.agent-5-broken', throw: 'fatal: not a git repo' },
    ]);
    const fakeFs = makeFakeFs();
    const ranked = rankWorktreesByFreshness([broken, ok], { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.equal(ranked[0], ok);
    assert.equal(ranked[1], broken);
});

// ---- pickIssueWorktree -------------------------------------------------------

test('pickIssueWorktree: null si no hay worktrees', () => {
    const fakeExec = makeFakeExec([{ match: 'worktree list', stdout: 'worktree /repo\n' }]);
    const fakeFs = makeFakeFs(new Set(['/repo']));
    assert.equal(pickIssueWorktree('/repo', 999, { execSyncImpl: fakeExec, fsImpl: fakeFs }), null);
});

test('pickIssueWorktree: atajo single-candidate dispara onPick con reason="single-candidate"', () => {
    const wt = '/repo/platform.agent-3409-pipeline-dev';
    const fakeExec = makeFakeExec([
        { match: 'worktree list', stdout: `worktree ${wt}\n` },
    ]);
    const fakeFs = makeFakeFs(new Set([wt]));
    let captured = null;
    const result = pickIssueWorktree('/repo', 3409, {
        execSyncImpl: fakeExec, fsImpl: fakeFs,
        onPick: (info) => { captured = info; },
    });
    assert.equal(result, wt);
    assert.equal(captured.winner, wt);
    assert.equal(captured.reason, 'single-candidate');
    assert.deepEqual(captured.candidates, [wt]);
});

test('pickIssueWorktree (regresión #3409): elige pipeline-dev sobre android-dev cuando éste último tiene menos commits ahead', () => {
    const ROOT = 'C:/Workspaces/Intrale/platform';
    const a = 'C:/Workspaces/Intrale/platform.agent-3409-android-dev';
    const p = 'C:/Workspaces/Intrale/platform.agent-3409-pipeline-dev';
    const stdout = [
        `worktree ${ROOT}`,
        `worktree ${a}`,
        `worktree ${p}`,
        '',
    ].join('\n');
    const fakeExec = makeFakeExec([
        { match: 'worktree list', stdout },
        // android-dev: 1 commit ahead (sólo fd2ead13 — sin el fix tester)
        { match: 'rev-list', cwdMatch: 'android-dev', stdout: '1\n' },
        // pipeline-dev: 2 commits ahead (hook + fix tester)
        { match: 'rev-list', cwdMatch: 'pipeline-dev', stdout: '2\n' },
    ]);
    const fakeFs = makeFakeFs(new Set([a, p]));
    let info = null;
    const result = pickIssueWorktree(ROOT, 3409, {
        execSyncImpl: fakeExec, fsImpl: fakeFs,
        onPick: (i) => { info = i; },
    });
    assert.equal(result, p, 'el ganador debe ser pipeline-dev (2 commits ahead) y NO android-dev (1)');
    assert.equal(info.reason, 'most-ahead');
    assert.deepEqual(info.ranked, [p, a]);
});

test('pickIssueWorktree: NO altera el orden cuando hay un solo candidato, sin spawn de rev-list innecesario', () => {
    // Para validar performance: con un solo candidato no debería llamar
    // `git rev-list` (es caro). Verificamos contando invocaciones.
    let revListCalls = 0;
    const wt = '/repo/platform.agent-100-dev';
    const fakeExec = (cmd, _opts) => {
        if (cmd.includes('rev-list')) revListCalls += 1;
        if (cmd.includes('worktree list')) return `worktree ${wt}\n`;
        return '';
    };
    const fakeFs = makeFakeFs(new Set([wt]));
    const result = pickIssueWorktree('/repo', 100, { execSyncImpl: fakeExec, fsImpl: fakeFs });
    assert.equal(result, wt);
    assert.equal(revListCalls, 0, 'no debe invocar rev-list para un solo candidato');
});

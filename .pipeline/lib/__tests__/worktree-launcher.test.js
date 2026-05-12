// =============================================================================
// Tests worktree-launcher.js — #3155 fix de raíz para "branch already exists".
//
// Cubre:
//   - Idempotencia: si el worktree ya existe, no se toca nada.
//   - Validación de inputs (issue / skill).
//   - Detección de branch huérfana y recovery (backup tag + delete + recreate).
//   - Branch en uso por otro worktree → error BRANCH_IN_USE (no pisa trabajo vivo).
//   - Camino feliz: branch no existe → `git worktree add -b` directo.
//   - Test de integración con git repo real: reproduce el bug #3155 y valida
//     que el módulo lo resuelve end-to-end.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const {
    ensureLaunchWorktree,
    WorktreeLaunchError,
    localBranchExists,
    worktreeUsingBranch,
    validateInputs,
} = require('../worktree-launcher');

// ---- validateInputs ---------------------------------------------------------

test('validateInputs acepta issue numérico y skill válido', () => {
    assert.doesNotThrow(() => validateInputs(3155, 'pipeline-dev'));
    assert.doesNotThrow(() => validateInputs('123', 'a'));
});

test('validateInputs rechaza issue no numérico', () => {
    assert.throws(() => validateInputs('abc', 'pipeline-dev'),
        (e) => e.code === 'INVALID_ISSUE');
    assert.throws(() => validateInputs('1; rm -rf /', 'pipeline-dev'),
        (e) => e.code === 'INVALID_ISSUE');
});

test('validateInputs rechaza skill con caracteres inseguros', () => {
    assert.throws(() => validateInputs(1, 'pipeline-dev; whoami'),
        (e) => e.code === 'INVALID_SKILL');
    assert.throws(() => validateInputs(1, 'Pipeline-Dev'),
        (e) => e.code === 'INVALID_SKILL');
    assert.throws(() => validateInputs(1, ''),
        (e) => e.code === 'INVALID_SKILL');
});

// ---- ensureLaunchWorktree — mock-based ----------------------------------------

function makeMockExec(handlers) {
    return function execMock(cmd, _opts) {
        for (const { match, result, error } of handlers) {
            if (match instanceof RegExp ? match.test(cmd) : cmd.includes(match)) {
                if (error) {
                    const e = new Error(error);
                    e.stderr = error;
                    throw e;
                }
                return result ?? '';
            }
        }
        throw new Error(`Comando inesperado: ${cmd}`);
    };
}

test('idempotente: si worktreePath ya existe no toca git', () => {
    const calls = [];
    const execImpl = (cmd) => { calls.push(cmd); return ''; };
    const fsImpl = { existsSync: () => true };

    const result = ensureLaunchWorktree({
        ROOT: '/repo', issue: 3155, skill: 'pipeline-dev',
        execImpl, fsImpl,
    });

    assert.equal(result.created, false);
    assert.equal(result.recovered, false);
    assert.equal(result.worktreeBranch, 'agent/3155-pipeline-dev');
    assert.equal(calls.length, 0, 'No debería ejecutar comandos git');
});

test('camino feliz: branch no existe → worktree add -b directo', () => {
    const calls = [];
    const execImpl = makeMockExec([
        { match: 'git worktree prune', result: '' },
        { match: 'git show-ref', error: 'not a ref' },
        { match: 'git worktree add', result: '' },
    ]);
    const wrappedExec = (cmd, opts) => { calls.push(cmd); return execImpl(cmd, opts); };
    const fsImpl = { existsSync: () => false };

    const result = ensureLaunchWorktree({
        ROOT: '/repo', issue: 3155, skill: 'pipeline-dev',
        execImpl: wrappedExec, fsImpl,
    });

    assert.equal(result.created, true);
    assert.equal(result.recovered, false);
    assert.ok(calls.some(c => c.includes('worktree prune')));
    assert.ok(calls.some(c => c.includes('worktree add') && c.includes('-b "agent/3155-pipeline-dev"')));
    assert.ok(!calls.some(c => c.includes('branch -D')));
});

test('branch huérfana: crea backup tag + delete + add', () => {
    const calls = [];
    const wrappedExec = (cmd) => {
        calls.push(cmd);
        if (cmd.includes('show-ref')) return ''; // existe
        if (cmd.includes('worktree list --porcelain')) {
            return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n';
        }
        return '';
    };
    const fsImpl = { existsSync: () => false };

    const result = ensureLaunchWorktree({
        ROOT: '/repo', issue: 3073, skill: 'pipeline-dev',
        execImpl: wrappedExec, fsImpl,
    });

    assert.equal(result.created, true);
    assert.equal(result.recovered, true);
    assert.ok(calls.some(c => /git tag "backup\/orphan-agent-3073-pipeline-dev-\d+" "agent\/3073-pipeline-dev"/.test(c)),
        'Debe crear backup tag');
    assert.ok(calls.some(c => c === 'git branch -D "agent/3073-pipeline-dev"'),
        'Debe borrar la branch huérfana');
    assert.ok(calls.some(c => c.includes('worktree add')));
});

test('branch en uso por otro worktree → BRANCH_IN_USE sin tocar nada', () => {
    const calls = [];
    const wrappedExec = (cmd) => {
        calls.push(cmd);
        if (cmd.includes('show-ref')) return '';
        if (cmd.includes('worktree list --porcelain')) {
            return [
                'worktree /repo',
                'HEAD abc',
                'branch refs/heads/main',
                '',
                'worktree /repo.agent-3073-pipeline-dev',
                'HEAD def',
                'branch refs/heads/agent/3073-pipeline-dev',
                '',
            ].join('\n');
        }
        if (cmd.includes('worktree prune')) return '';
        throw new Error(`No debería ejecutar: ${cmd}`);
    };
    const fsImpl = { existsSync: () => false };

    assert.throws(
        () => ensureLaunchWorktree({
            ROOT: '/repo', issue: 3073, skill: 'pipeline-dev',
            execImpl: wrappedExec, fsImpl,
        }),
        (e) => e instanceof WorktreeLaunchError && e.code === 'BRANCH_IN_USE',
    );

    assert.ok(!calls.some(c => c.includes('branch -D')), 'NO debe borrar branch en uso');
    assert.ok(!calls.some(c => c.includes('worktree add')), 'NO debe re-crear worktree');
});

test('backup tag falla pero limpieza continúa (best-effort)', () => {
    const calls = [];
    const wrappedExec = (cmd) => {
        calls.push(cmd);
        if (cmd.includes('show-ref')) return '';
        if (cmd.includes('worktree list --porcelain')) {
            return 'worktree /repo\nbranch refs/heads/main\n\n';
        }
        if (cmd.includes('git tag')) throw new Error('tag failed');
        return '';
    };
    const fsImpl = { existsSync: () => false };

    const result = ensureLaunchWorktree({
        ROOT: '/repo', issue: 3073, skill: 'pipeline-dev',
        execImpl: wrappedExec, fsImpl,
    });

    assert.equal(result.recovered, true);
    assert.ok(calls.some(c => c.includes('branch -D')));
    assert.ok(calls.some(c => c.includes('worktree add')));
});

test('branch -D falla → BRANCH_DELETE_FAILED', () => {
    const wrappedExec = (cmd) => {
        if (cmd.includes('show-ref')) return '';
        if (cmd.includes('worktree list --porcelain')) {
            return 'worktree /repo\nbranch refs/heads/main\n\n';
        }
        if (cmd.includes('git tag')) return '';
        if (cmd.includes('branch -D')) throw new Error('delete failed');
        return '';
    };
    const fsImpl = { existsSync: () => false };

    assert.throws(
        () => ensureLaunchWorktree({
            ROOT: '/repo', issue: 3073, skill: 'pipeline-dev',
            execImpl: wrappedExec, fsImpl,
        }),
        (e) => e.code === 'BRANCH_DELETE_FAILED',
    );
});

// ---- worktreeUsingBranch — parser independiente -----------------------------

test('worktreeUsingBranch — detecta worktree que tiene checkout la branch', () => {
    const out = [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /repo.agent-1-x',
        'HEAD bbb',
        'branch refs/heads/agent/1-x',
        '',
    ].join('\n');
    const result = worktreeUsingBranch('/repo', 'agent/1-x',
        () => out);
    assert.equal(result, '/repo.agent-1-x');
});

test('worktreeUsingBranch — null si ningún worktree tiene la branch', () => {
    const out = 'worktree /repo\nbranch refs/heads/main\n\n';
    const result = worktreeUsingBranch('/repo', 'agent/1-x', () => out);
    assert.equal(result, null);
});

test('worktreeUsingBranch — null si git falla', () => {
    const result = worktreeUsingBranch('/repo', 'agent/1-x',
        () => { throw new Error('not a repo'); });
    assert.equal(result, null);
});

// ---- Integration test — repro del bug #3155 con git real --------------------

function gitIsAvailable() {
    try {
        execSync('git --version', { windowsHide: true, stdio: 'ignore' });
        return true;
    } catch { return false; }
}

test('integración: branch huérfana real → ensureLaunchWorktree la recupera (repro #3155)', { skip: !gitIsAvailable() }, () => {
    // Setup: repo "origin" + repo "local" que clona, branch huérfana sin worktree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-int-'));
    const originDir = path.join(tmp, 'origin');
    const repoDir = path.join(tmp, 'repo');

    try {
        // Origin bare-like (con working tree para simplicidad)
        fs.mkdirSync(originDir, { recursive: true });
        execSync('git init -q -b main', { cwd: originDir, windowsHide: true });
        execSync('git config user.email t@t', { cwd: originDir, windowsHide: true });
        execSync('git config user.name t', { cwd: originDir, windowsHide: true });
        fs.writeFileSync(path.join(originDir, 'README.md'), 'x');
        execSync('git add -A', { cwd: originDir, windowsHide: true });
        execSync('git commit -qm init', { cwd: originDir, windowsHide: true });

        // Clone como repoDir
        execSync(`git clone -q "${originDir}" "${repoDir}"`, { windowsHide: true });
        execSync('git config user.email t@t', { cwd: repoDir, windowsHide: true });
        execSync('git config user.name t', { cwd: repoDir, windowsHide: true });

        // Reproducir el bug: crear branch local sin worktree (huérfana).
        execSync('git branch agent/9999-pipeline-dev origin/main', { cwd: repoDir, windowsHide: true });

        // Pre-condición: la branch existe localmente.
        assert.equal(localBranchExists(repoDir, 'agent/9999-pipeline-dev'), true);

        // Sin el fix, esto fallaría con "branch already exists".
        // Con el fix, debería recuperarse automáticamente.
        const result = ensureLaunchWorktree({
            ROOT: repoDir, issue: 9999, skill: 'pipeline-dev',
        });

        assert.equal(result.created, true);
        assert.equal(result.recovered, true);
        assert.ok(fs.existsSync(result.worktreePath),
            'El worktree físico debería existir');

        // Validar que se creó un backup tag (best-effort, puede no estar si tag falló silencioso).
        const tags = execSync('git tag --list "backup/orphan-agent-9999-*"',
            { cwd: repoDir, encoding: 'utf8', windowsHide: true });
        assert.ok(tags.trim().length > 0,
            'Debe existir un backup tag de la branch huérfana');

        // Cleanup
        execSync(`git worktree remove --force "${result.worktreePath}"`,
            { cwd: repoDir, windowsHide: true });
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('integración: segunda invocación es idempotente si el worktree ya existe', { skip: !gitIsAvailable() }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-int-idem-'));
    const originDir = path.join(tmp, 'origin');
    const repoDir = path.join(tmp, 'repo');

    try {
        fs.mkdirSync(originDir, { recursive: true });
        execSync('git init -q -b main', { cwd: originDir, windowsHide: true });
        execSync('git config user.email t@t', { cwd: originDir, windowsHide: true });
        execSync('git config user.name t', { cwd: originDir, windowsHide: true });
        fs.writeFileSync(path.join(originDir, 'README.md'), 'x');
        execSync('git add -A && git commit -qm init', { cwd: originDir, shell: true, windowsHide: true });

        execSync(`git clone -q "${originDir}" "${repoDir}"`, { windowsHide: true });
        execSync('git config user.email t@t', { cwd: repoDir, windowsHide: true });
        execSync('git config user.name t', { cwd: repoDir, windowsHide: true });

        // Primera invocación: crea.
        const first = ensureLaunchWorktree({
            ROOT: repoDir, issue: 8888, skill: 'pipeline-dev',
        });
        assert.equal(first.created, true);

        // Segunda invocación: idempotente.
        const second = ensureLaunchWorktree({
            ROOT: repoDir, issue: 8888, skill: 'pipeline-dev',
        });
        assert.equal(second.created, false);
        assert.equal(second.recovered, false);
        assert.equal(second.worktreePath, first.worktreePath);

        execSync(`git worktree remove --force "${first.worktreePath}"`,
            { cwd: repoDir, windowsHide: true });
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

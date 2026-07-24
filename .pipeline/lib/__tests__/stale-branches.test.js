// =============================================================================
// Tests stale-branches.js — Issue #2398
//
// Cobertura mínima (5 casos del issue):
//   1. Branch sin worktree + tip en origin/main → marcado stale.
//   2. Branch sin worktree + tip con commits únicos → NO marcado (seguridad).
//   3. Branch con worktree → NO marcado aunque sea ancestor (seguridad).
//   4. Branch cuyo nombre no matchea agent/* → ignorado.
//   5. Dry-run no borra nada pero reporta.
//
// Cobertura adicional:
//   6. cleanStale crea backup tag por default y luego borra.
//   7. cleanStale en modo --no-backup-tag salta el tag.
//   8. cleanStale captura errores de git branch -D y reporta.
//   9. parseAgentBranchName valida formato.
//  10. detectStale enriquece con issueState cuando withIssueState=true.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sb = require('../stale-branches');

// -----------------------------------------------------------------------------
// fakeExec — simulador de git CLI configurable por cada test
// -----------------------------------------------------------------------------

function makeFakeExec({ branches = [], worktreeBranches = [], ancestorBranches = [], issueStates = {}, failures = [] } = {}) {
    const calls = [];
    function fakeExec(cmd /*, opts */) {
        calls.push(cmd);
        // Simulamos failures puntuales por subcadena
        for (const f of failures) {
            if (cmd.includes(f.match)) {
                const err = new Error(f.message || 'fake-failure');
                err.status = f.status || 1;
                throw err;
            }
        }
        if (cmd.startsWith('git for-each-ref')) {
            return branches.map((b) => `"${b}"`).join('\n') + '\n';
        }
        if (cmd.startsWith('git worktree list --porcelain')) {
            // Formato porcelain mínimo: cada worktree tres líneas
            const out = [];
            for (let i = 0; i < worktreeBranches.length; i++) {
                out.push(`worktree C:/Workspaces/Intrale/platform.fake-${i}`);
                out.push(`HEAD 0000000000000000000000000000000000000000`);
                out.push(`branch refs/heads/${worktreeBranches[i]}`);
                out.push('');
            }
            return out.join('\n');
        }
        if (cmd.startsWith('git merge-base --is-ancestor')) {
            // Extrae el branch del comando: git merge-base --is-ancestor "<branch>" origin/main
            const m = cmd.match(/--is-ancestor\s+"([^"]+)"/);
            const branch = m ? m[1] : '';
            if (ancestorBranches.includes(branch)) {
                return ''; // exit 0
            }
            const err = new Error('not ancestor');
            err.status = 1;
            throw err;
        }
        if (cmd.startsWith('git fetch origin main')) {
            return '';
        }
        if (cmd.includes('issue view')) {
            const m = cmd.match(/issue view (\d+)/);
            const issueNum = m ? parseInt(m[1], 10) : 0;
            if (issueStates[issueNum]) return issueStates[issueNum] + '\n';
            const err = new Error('gh failed');
            err.status = 1;
            throw err;
        }
        if (cmd.startsWith('git tag')) {
            return '';
        }
        if (cmd.startsWith('git branch -D')) {
            return '';
        }
        return '';
    }
    fakeExec.calls = calls;
    return fakeExec;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('caso 1: branch sin worktree + tip en origin/main → marcado stale', () => {
    const exec = makeFakeExec({
        branches: ['agent/1950-android-dev'],
        worktreeBranches: [],
        ancestorBranches: ['agent/1950-android-dev'],
    });
    const { candidates, skipped } = sb.detectStale({ exec, repoRoot: '/tmp/fake' });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'agent/1950-android-dev');
    assert.equal(candidates[0].issueNum, 1950);
    assert.equal(candidates[0].skill, 'android-dev');
    assert.match(candidates[0].reason, /tip en origin\/main/);
    assert.equal(skipped.length, 0);
});

test('caso 2: branch sin worktree + tip con commits únicos → NO marcado por seguridad', () => {
    const exec = makeFakeExec({
        branches: ['agent/1097-android-dev'],
        worktreeBranches: [],
        ancestorBranches: [], // ningún branch es ancestro
    });
    const { candidates, skipped } = sb.detectStale({ exec, repoRoot: '/tmp/fake' });
    assert.equal(candidates.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].name, 'agent/1097-android-dev');
    assert.match(skipped[0].skipReason, /no es ancestro/);
});

test('caso 3: branch con worktree → NO marcado aunque sea ancestor (seguridad)', () => {
    const exec = makeFakeExec({
        branches: ['agent/2398-pipeline-dev'],
        worktreeBranches: ['agent/2398-pipeline-dev'],
        ancestorBranches: ['agent/2398-pipeline-dev'],
    });
    const { candidates, skipped } = sb.detectStale({ exec, repoRoot: '/tmp/fake' });
    assert.equal(candidates.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].skipReason, /worktree/);
});

test('caso 4: branch que no matchea agent/<n>-<skill> es ignorado', () => {
    const exec = makeFakeExec({
        // listAgentBranches ya filtra por refs/heads/agent/, pero igual el regex
        // del módulo descarta variantes que no cumplan el formato esperado
        branches: ['agent/sin-numero', 'feature/manual', 'agent/123-valido'],
        ancestorBranches: ['agent/123-valido'],
    });
    const { candidates } = sb.detectStale({ exec, repoRoot: '/tmp/fake' });
    // Solo el valido debe llegar a candidates
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'agent/123-valido');
});

test('caso 5: dry-run no borra y reporta', () => {
    const exec = makeFakeExec({});
    const result = sb.cleanStale(
        [{ name: 'agent/1950-android-dev', issueNum: 1950 }],
        { exec, repoRoot: '/tmp/fake', dryRun: true }
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].removed, false);
    // No debe haber llamado a git tag ni git branch -D
    const calls = exec.calls.filter((c) => c.startsWith('git tag') || c.startsWith('git branch -D'));
    assert.equal(calls.length, 0);
});

test('cleanStale (run real) crea backup tag y borra la branch', () => {
    const exec = makeFakeExec({});
    const result = sb.cleanStale(
        [{ name: 'agent/1950-android-dev', issueNum: 1950 }],
        { exec, repoRoot: '/tmp/fake', dryRun: false }
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].removed, true);
    assert.match(result[0].backupTag, /^backup\/orphan-agent-1950-android-dev-\d+$/);
    const tagCalls = exec.calls.filter((c) => c.startsWith('git tag'));
    const deleteCalls = exec.calls.filter((c) => c.startsWith('git branch -D'));
    assert.equal(tagCalls.length, 1);
    assert.equal(deleteCalls.length, 1);
});

test('cleanStale con backupTag=false omite el tag y solo borra', () => {
    const exec = makeFakeExec({});
    const result = sb.cleanStale(
        [{ name: 'agent/1950-android-dev', issueNum: 1950 }],
        { exec, repoRoot: '/tmp/fake', dryRun: false, backupTag: false }
    );
    assert.equal(result[0].removed, true);
    assert.equal(result[0].backupTag, undefined);
    const tagCalls = exec.calls.filter((c) => c.startsWith('git tag'));
    assert.equal(tagCalls.length, 0);
});

test('cleanStale captura error de git branch -D y reporta', () => {
    const exec = makeFakeExec({
        failures: [{ match: 'git branch -D', message: 'branch is checked out at /path', status: 1 }],
    });
    const result = sb.cleanStale(
        [{ name: 'agent/1950-android-dev', issueNum: 1950 }],
        { exec, repoRoot: '/tmp/fake', dryRun: false, backupTag: false }
    );
    assert.equal(result[0].removed, false);
    assert.match(result[0].error, /checked out/);
});

test('parseAgentBranchName valida formato esperado', () => {
    assert.deepEqual(sb.parseAgentBranchName('agent/123-android-dev'), { issueNum: 123, skill: 'android-dev' });
    assert.deepEqual(sb.parseAgentBranchName('agent/2398-pipeline-dev'), { issueNum: 2398, skill: 'pipeline-dev' });
    assert.equal(sb.parseAgentBranchName('agent/sin-numero'), null);
    assert.equal(sb.parseAgentBranchName('feature/manual'), null);
    assert.equal(sb.parseAgentBranchName('main'), null);
});

test('detectStale con withIssueState=true enriquece cada candidato con estado', () => {
    const exec = makeFakeExec({
        branches: ['agent/1950-android-dev', 'agent/1955-android-dev'],
        ancestorBranches: ['agent/1950-android-dev', 'agent/1955-android-dev'],
        issueStates: {
            1950: 'OPEN:',
            1955: 'CLOSED:COMPLETED',
        },
    });
    const { candidates } = sb.detectStale({ exec, repoRoot: '/tmp/fake', withIssueState: true });
    assert.equal(candidates.length, 2);
    const byNum = Object.fromEntries(candidates.map((c) => [c.issueNum, c.issueState]));
    assert.equal(byNum[1950], 'OPEN');
    assert.equal(byNum[1955], 'MERGED'); // CLOSED+COMPLETED se mapea a MERGED
});

test('detectStale con withIssueState=true y gh failing reporta UNKNOWN', () => {
    const exec = makeFakeExec({
        branches: ['agent/9999-test'],
        ancestorBranches: ['agent/9999-test'],
        // sin issueStates → gh tira error
    });
    const { candidates } = sb.detectStale({ exec, repoRoot: '/tmp/fake', withIssueState: true });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].issueState, 'UNKNOWN');
});

test('detectStale con fetchOrigin=true ejecuta git fetch antes', () => {
    const exec = makeFakeExec({
        branches: [],
    });
    sb.detectStale({ exec, repoRoot: '/tmp/fake', fetchOrigin: true });
    const fetchCalls = exec.calls.filter((c) => c.startsWith('git fetch origin main'));
    assert.equal(fetchCalls.length, 1);
});

test('detectStale por default NO ejecuta git fetch (no efectos de red)', () => {
    const exec = makeFakeExec({ branches: [] });
    sb.detectStale({ exec, repoRoot: '/tmp/fake' });
    const fetchCalls = exec.calls.filter((c) => c.startsWith('git fetch'));
    assert.equal(fetchCalls.length, 0);
});

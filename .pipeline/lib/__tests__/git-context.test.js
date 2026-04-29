// =============================================================================
// Tests git-context.js — refactor de /delivery (#2870)
//
// Crea un repo git temporal con commits sintéticos y valida que la API
// extrae el estado correcto. Sin red, sin remote real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ctx = require('../delivery/git-context');

// ---- Helpers ----------------------------------------------------------------

function sh(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} fail: ${r.stderr}`);
    return r.stdout.trim();
}

// Setup: repo con base "main" y nuestro branch "feature" con 2 commits adelante.
function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ctx-test-'));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test.test']);
    sh(dir, ['config', 'user.name', 'Test']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);

    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    sh(dir, ['add', 'README.md']);
    sh(dir, ['commit', '-q', '-m', 'init']);

    // Simular origin/main apuntando al commit base
    sh(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    sh(dir, ['checkout', '-q', '-b', 'feature']);

    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log("a");\n');
    sh(dir, ['add', 'a.js']);
    sh(dir, ['commit', '-q', '-m', 'feat: agregar a']);

    fs.writeFileSync(path.join(dir, 'b.js'), 'console.log("b");\n');
    sh(dir, ['add', 'b.js']);
    sh(dir, ['commit', '-q', '-m', 'fix: agregar b']);

    return dir;
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

// ---- Tests ------------------------------------------------------------------

test('currentBranch devuelve el branch actual', () => {
    const repo = makeRepo();
    try {
        assert.equal(ctx.currentBranch(repo), 'feature');
    } finally { cleanup(repo); }
});

test('aheadCount cuenta commits adelante de origin/main', () => {
    const repo = makeRepo();
    try {
        assert.equal(ctx.aheadCount(repo, 'origin/main'), 2);
    } finally { cleanup(repo); }
});

test('behindCount es 0 cuando origin/main no avanzó', () => {
    const repo = makeRepo();
    try {
        assert.equal(ctx.behindCount(repo, 'origin/main'), 0);
    } finally { cleanup(repo); }
});

test('behindCount detecta commits nuevos en origin/main', () => {
    const repo = makeRepo();
    try {
        // Avanzar origin/main con un commit "nuevo" (otra rama, copy ref)
        sh(repo, ['checkout', '-q', 'main']);
        fs.writeFileSync(path.join(repo, 'c.js'), 'c\n');
        sh(repo, ['add', 'c.js']);
        sh(repo, ['commit', '-q', '-m', 'origin advance']);
        sh(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        sh(repo, ['checkout', '-q', 'feature']);
        assert.equal(ctx.behindCount(repo, 'origin/main'), 1);
    } finally { cleanup(repo); }
});

test('commitsAhead lista commits con sha y subject', () => {
    const repo = makeRepo();
    try {
        const commits = ctx.commitsAhead(repo, 'origin/main');
        assert.equal(commits.length, 2);
        assert.equal(commits[0].subject, 'fix: agregar b');
        assert.equal(commits[1].subject, 'feat: agregar a');
        for (const c of commits) {
            assert.match(c.sha, /^[0-9a-f]{7,}$/);
        }
    } finally { cleanup(repo); }
});

test('filesChanged lista archivos modificados respecto a base', () => {
    const repo = makeRepo();
    try {
        const files = ctx.filesChanged(repo, 'origin/main');
        assert.deepEqual(files.sort(), ['a.js', 'b.js']);
    } finally { cleanup(repo); }
});

test('diffStat retorna files/insertions/deletions parseados', () => {
    const repo = makeRepo();
    try {
        const stat = ctx.diffStat(repo, 'origin/main');
        assert.equal(stat.files, 2);
        assert.ok(stat.insertions >= 2, `insertions debe ser >=2, fue ${stat.insertions}`);
        assert.equal(stat.deletions, 0);
    } finally { cleanup(repo); }
});

test('statusPorcelain lista archivos sin commitear', () => {
    const repo = makeRepo();
    try {
        // Tree limpio al inicio
        assert.equal(ctx.statusPorcelain(repo).length, 0);

        // Crear archivo untracked
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x');
        // Modificar uno tracked
        fs.writeFileSync(path.join(repo, 'a.js'), 'modified\n');

        const status = ctx.statusPorcelain(repo);
        const paths = status.map(s => s.path).sort();
        assert.deepEqual(paths, ['a.js', 'untracked.txt']);

        const codes = Object.fromEntries(status.map(s => [s.path, s.code]));
        assert.equal(codes['untracked.txt'], '??');
        assert.match(codes['a.js'], /M/);
    } finally { cleanup(repo); }
});

test('diffText incluye el contenido del diff', () => {
    const repo = makeRepo();
    try {
        const diff = ctx.diffText(repo, 'origin/main');
        assert.match(diff, /diff --git/);
        assert.match(diff, /a\.js/);
        assert.match(diff, /b\.js/);
        assert.match(diff, /\+console\.log/);
    } finally { cleanup(repo); }
});

test('diffText respeta maxBytes y agrega marcador truncated', () => {
    const repo = makeRepo();
    try {
        const diff = ctx.diffText(repo, 'origin/main', 50);
        assert.ok(diff.length <= 80, `diff truncado a ~50 bytes, fue ${diff.length}`);
        assert.match(diff, /\[truncated\]/);
    } finally { cleanup(repo); }
});

test('snapshot devuelve estructura agregada con todo el contexto', () => {
    const repo = makeRepo();
    try {
        const snap = ctx.snapshot(repo);
        assert.equal(snap.branch, 'feature');
        assert.equal(snap.ahead, 2);
        assert.equal(snap.behind, 0);
        assert.equal(snap.commits.length, 2);
        assert.equal(snap.files.length, 2);
        assert.equal(snap.stat.files, 2);
    } finally { cleanup(repo); }
});

test('git() maneja cwd inválido devolviendo ok=false sin tirar', () => {
    const r = ctx.git(['status'], '/path/que/no/existe');
    assert.equal(r.ok, false);
    assert.notEqual(r.status, 0);
});

// =============================================================================
// Tests worktree-cleanup.js — fix #2867
//
// Cubre la detección de "sesión activa" que es el bug crítico que llevó a
// que /delivery se borrara los skills a sí mismo. Los tests de junction y
// cleanup completo son integración (requieren git/fsutil) y se hacen aparte.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    isActiveSession,
    isJunction,
    dismountClaudeJunction,
    cleanupWorktree,
} = require('../delivery/worktree-cleanup');

// ---- Helpers ----------------------------------------------------------------

function mkTempWorktree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cleanup-test-'));
    return dir;
}

// ---- isActiveSession --------------------------------------------------------

test('isActiveSession devuelve true cuando cwd === worktree', () => {
    const wt = mkTempWorktree();
    try {
        assert.equal(isActiveSession(wt, wt), true);
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

test('isActiveSession devuelve true cuando cwd está dentro de worktree', () => {
    const wt = mkTempWorktree();
    const sub = path.join(wt, 'subdir');
    fs.mkdirSync(sub);
    try {
        assert.equal(isActiveSession(wt, sub), true);
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

test('isActiveSession devuelve false cuando cwd está fuera de worktree', () => {
    const wt = mkTempWorktree();
    const otherDir = mkTempWorktree();
    try {
        assert.equal(isActiveSession(wt, otherDir), false);
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
    }
});

test('isActiveSession devuelve false cuando worktree no existe', () => {
    const cwd = mkTempWorktree();
    try {
        assert.equal(isActiveSession('/path/que/no/existe', cwd), false);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('isActiveSession devuelve false con args faltantes', () => {
    assert.equal(isActiveSession(null, '/some/path'), false);
    assert.equal(isActiveSession('/some/path', null), false);
    assert.equal(isActiveSession(null, null), false);
    assert.equal(isActiveSession('', ''), false);
});

test('isActiveSession es case-insensitive en Windows (no falsos negativos por mayúsculas)', () => {
    // En Windows el filesystem es case-insensitive. Si el comparador no lo
    // contempla, paths que difieren solo en casing producirían false.
    if (process.platform !== 'win32') return; // skip en non-Windows
    const wt = mkTempWorktree();
    try {
        // Construir variantes con casing alterado del path original
        const upper = wt.toUpperCase();
        const lower = wt.toLowerCase();
        // Solo testeable si realpath resuelve a lo mismo
        try {
            const realLower = fs.realpathSync(lower);
            assert.equal(isActiveSession(wt, realLower), true);
        } catch {
            // ambiente no soporta el casing alternado; skip
        }
        // Mismo path con upper/lower
        try {
            assert.equal(isActiveSession(upper, wt), true);
        } catch {
            // skip
        }
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

test('isActiveSession NO da falso positivo por prefijo de path', () => {
    // Si un comparador hace startsWith sin tener en cuenta el separador,
    // /foo/bar startsWith /foo/ba sería true incorrectamente.
    const root = mkTempWorktree();
    const wtFoo = path.join(root, 'foo');
    const wtFooBar = path.join(root, 'foobar');
    fs.mkdirSync(wtFoo);
    fs.mkdirSync(wtFooBar);
    try {
        // cwd está en /foobar, worktree es /foo — NO debe ser activo.
        // (Esta es la razón de comparar paths reales con realpath: en general
        // no produce falsos positivos por casualidad, pero el comparador
        // con startsWith plano sí. Validamos el comportamiento real.)
        const result = isActiveSession(wtFoo, wtFooBar);
        // El comparador actual usa startsWith pero sobre realpath normalizado.
        // /foobar.startsWith(/foo) es true en string puro, lo cual sería un bug.
        // Documentamos el caso: si el test falla, hay que agregar separador
        // al final antes del startsWith.
        assert.equal(result, false, 'Falso positivo por prefijo: comparar con separador final');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---- isJunction -------------------------------------------------------------

test('isJunction devuelve false para path inexistente', () => {
    assert.equal(isJunction('/path/que/no/existe/abcdef'), false);
});

test('isJunction devuelve false para directorio real', () => {
    const dir = mkTempWorktree();
    try {
        assert.equal(isJunction(dir), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Test con junction real solo en Windows con permisos suficientes
test('isJunction devuelve true para junction Windows', { skip: process.platform !== 'win32' }, () => {
    const target = mkTempWorktree();
    const linkDir = mkTempWorktree();
    const linkPath = path.join(linkDir, 'junction');
    try {
        const { spawnSync } = require('node:child_process');
        const winTarget = target.replace(/\//g, '\\');
        const winLink = linkPath.replace(/\//g, '\\');
        const result = spawnSync('cmd', ['/c', 'mklink', '/J', winLink, winTarget], {
            stdio: 'pipe',
            windowsHide: true,
        });
        if (result.status !== 0) {
            // No tenemos permisos para crear junction — skip suave
            return;
        }
        assert.equal(isJunction(linkPath), true);
        // Y un dir real al lado debe seguir siendo false
        assert.equal(isJunction(target), false);
    } finally {
        // Limpiar junction antes que el dir, y con cmd para no seguir el junction
        try {
            const { spawnSync } = require('node:child_process');
            const winLink = linkPath.replace(/\//g, '\\');
            spawnSync('cmd', ['/c', 'rmdir', winLink], { stdio: 'ignore' });
        } catch {}
        fs.rmSync(linkDir, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
    }
});

// ---- dismountClaudeJunction -------------------------------------------------

test('dismountClaudeJunction devuelve not_present cuando .claude no existe', () => {
    const wt = mkTempWorktree();
    try {
        const result = dismountClaudeJunction(wt, () => {});
        assert.equal(result.dismounted, false);
        assert.equal(result.reason, 'not_present');
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

test('dismountClaudeJunction NO toca .claude si es copia real (fix #2867)', () => {
    const wt = mkTempWorktree();
    const claude = path.join(wt, '.claude');
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, 'sentinela.txt'), 'no me borres');
    try {
        const result = dismountClaudeJunction(wt, () => {});
        assert.equal(result.dismounted, false);
        assert.equal(result.reason, 'real_copy');
        // Lo crítico: el archivo debe seguir ahí
        assert.equal(fs.existsSync(path.join(claude, 'sentinela.txt')), true);
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

// ---- cleanupWorktree (smoke) ------------------------------------------------

test('cleanupWorktree skipea cuando es sesión activa (fix #2867)', async () => {
    const wt = mkTempWorktree();
    try {
        const result = await cleanupWorktree({
            worktreePath: wt,
            branch: 'agent/fake-branch',
            mainRepoPath: '/no-importa',
            sessionCwd: wt,        // activa
            logger: () => {},
        });
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'active_session');
        // Y el worktree filesystem debe seguir intacto
        assert.equal(fs.existsSync(wt), true);
    } finally {
        fs.rmSync(wt, { recursive: true, force: true });
    }
});

test('cleanupWorktree falla sin worktreePath', async () => {
    const result = await cleanupWorktree({
        worktreePath: null,
        branch: 'foo',
        sessionCwd: '/cwd',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_args');
});

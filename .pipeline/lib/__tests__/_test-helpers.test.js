// =============================================================================
// _test-helpers.test.js — Smoke tests para el helper de PATH-de-git
//
// Cubre los happy paths del helper. La lógica defensiva (paths fallback en
// Windows, locateGitDir cuando `where` falla) no se mockea: confiamos en que
// el host donde corre el pipeline TIENE git instalado en alguna ubicación
// estándar, así que `ensureGitOnPath()` siempre debería poder devolver true.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureGitOnPath, locateGitDir, gitIsInvokable } = require('./_test-helpers');

test('ensureGitOnPath: deja `git --version` invocable', () => {
    const ok = ensureGitOnPath();
    assert.equal(ok, true, 'ensureGitOnPath debería devolver true en host con git instalado');
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0);
    assert.match(r.stdout || '', /^git version/);
});

test('locateGitDir: devuelve un directorio existente o null', () => {
    const dir = locateGitDir();
    if (dir !== null) {
        assert.equal(typeof dir, 'string');
        assert.ok(dir.length > 0);
        // El path devuelto debería ser un directorio (no un archivo).
        const fs = require('node:fs');
        const stat = fs.statSync(dir);
        assert.ok(stat.isDirectory(), `locateGitDir debe devolver un directorio: ${dir}`);
    }
});

test('gitIsInvokable: true cuando hay git en PATH', () => {
    // Llamar primero ensureGitOnPath para garantizar PATH listo.
    ensureGitOnPath();
    assert.equal(gitIsInvokable(), true);
});

test('ensureGitOnPath es idempotente (no rompe ni duplica)', () => {
    const before = process.env.PATH;
    const ok1 = ensureGitOnPath();
    const after1 = process.env.PATH;
    const ok2 = ensureGitOnPath();
    const after2 = process.env.PATH;
    assert.equal(ok1, ok2);
    assert.equal(after1, after2, 'segundo call no debería modificar PATH otra vez');
    // En modo cacheado, PATH puede haberse extendido en la primera llamada,
    // pero no debería seguir creciendo en llamadas subsiguientes.
    assert.ok(after2.length >= before.length || after2.length === before.length);
});

// Tests de rebaseOnto en skills-deterministicos/lib/git-ops.js
// (#2519 rev-2) — verifica que el rebase invoque --autostash, defensa
// imprescindible para que delivery no muera con "unstaged changes" cuando
// SAFE_IGNORE deja archivos tracked modificados (heartbeats, registry,
// activity-log, metrics-history) en el árbol de trabajo durante el pipeline.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.resolve(__dirname, '..', 'skills-deterministicos', 'lib', 'git-ops.js');

test('rebaseOnto incluye --autostash en los argumentos', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    // Buscamos la función rebaseOnto y verificamos que el array de args
    // que pasa a runGit incluye '--autostash'.
    const match = src.match(/function rebaseOnto[^{]*\{([\s\S]*?)\n\}/);
    assert.ok(match, 'rebaseOnto no encontrado en git-ops.js');
    const body = match[1];
    assert.match(
        body,
        /runGit\(\[\s*'rebase'\s*,\s*'--autostash'\s*,/,
        'rebaseOnto debe pasar --autostash como segundo argumento de git rebase'
    );
});

test('rebaseOnto no usa rebase plain (sin autostash)', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    const match = src.match(/function rebaseOnto[^{]*\{([\s\S]*?)\n\}/);
    const body = match[1];
    // Asegurarnos de que NO existe el patrón antiguo runGit(['rebase', base])
    // sin flags. Si alguien lo revierte por accidente, el test falla.
    assert.doesNotMatch(
        body,
        /runGit\(\[\s*'rebase'\s*,\s*base\s*\]/,
        'rebaseOnto NO debe llamar a git rebase sin --autostash (regresión #2519)'
    );
});

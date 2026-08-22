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

test('rebaseOnto incluye --autostash en los argumentos por default', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    // Buscamos la función rebaseOnto y verificamos que el array de args
    // contiene '--autostash' como segundo elemento.
    const match = src.match(/function rebaseOnto[^{]*\{([\s\S]*?)\n\}/);
    assert.ok(match, 'rebaseOnto no encontrado en git-ops.js');
    const body = match[1];
    // Aceptamos dos formas válidas para el array de args de git rebase:
    //   1) runGit(['rebase', '--autostash', base], ...) — call inline.
    //   2) const args = ... ['rebase', '--autostash', base] ... ; runGit(args, ...)
    //      (#2551: ternario `autostash ? [...,'--autostash',...] : [...,base]`
    //       para soportar autostash:false cuando delivery hace stash manual con
    //       --include-untracked.)
    // Lo crítico es que el literal ['rebase', '--autostash', ...] siga vivo en
    // el body — si desaparece, perdimos la defensa contra "unstaged changes".
    assert.match(
        body,
        /\[\s*'rebase'\s*,\s*'--autostash'\s*,/,
        'rebaseOnto debe construir un array con --autostash como segundo argumento de git rebase'
    );

    // El default del parámetro `autostash` debe seguir siendo true para no
    // romper a callers existentes que invocan rebaseOnto(cwd) sin options.
    const sig = src.match(/function rebaseOnto\(([\s\S]*?)\)\s*\{/);
    assert.ok(sig, 'no se puede leer la firma de rebaseOnto');
    assert.match(
        sig[1],
        /autostash\s*=\s*true/,
        'rebaseOnto debe tener autostash=true como default (compat con callers existentes)'
    );
});

test('rebaseOnto no usa rebase plain (sin autostash) en el call principal a runGit', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    const match = src.match(/function rebaseOnto[^{]*\{([\s\S]*?)\n\}/);
    const body = match[1];
    // Anti-regresión #2519: no debe existir un `runGit(['rebase', base])`
    // literal — si alguien colapsa el ternario y revierte el cambio, esto
    // detecta. (El array `['rebase', base]` puede aparecer en la rama
    // autostash:false del ternario, pero NO debe ser el único path a runGit.)
    assert.doesNotMatch(
        body,
        /runGit\(\[\s*'rebase'\s*,\s*base\s*\]/,
        'rebaseOnto NO debe llamar a git rebase sin --autostash (regresión #2519)'
    );
});

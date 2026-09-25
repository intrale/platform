// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de license-header-lint (#7591, CA-18). Cada caso arma un repo git
// temporal propio (mkdtemp + git init) que se borra al terminar: no quedan
// fixtures en %TEMP% (#7210) ni se toca el repo real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const lint = require('../license-header-lint');

const HOLDER = 'Leonel Larreta';
const SPDX = 'LicenseRef-Proprietary';
const JS_HEADER = `// Copyright (c) 2026 ${HOLDER}\n// SPDX-License-Identifier: ${SPDX}\n`;
const SH_HEADER = `# Copyright (c) 2026 ${HOLDER}\n# SPDX-License-Identifier: ${SPDX}\n`;
const MARKER = 'MARCADOR_UNICO_7591_no_debe_salir_en_el_log';

const repos = [];

test.after(() => {
    for (const dir of repos) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

function git(dir, args) {
    return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
}

/**
 * Repo temporal con config + allowlist + archivos. `files`: { rel: string|Buffer }.
 */
function makeRepo({ files = {}, exceptions = [], config = { holder: HOLDER, spdx: SPDX }, commit = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhl-7591-'));
    repos.push(dir);
    git(dir, ['init', '-q']);
    write(dir, lint.CONFIG_REL, JSON.stringify(config));
    write(dir, lint.ALLOWLIST_REL, JSON.stringify({ exceptions }));
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git(dir, ['add', '-A']);
    if (commit) git(dir, ['commit', '-q', '-m', 'base']);
    return dir;
}

function write(dir, rel, content) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

function run(dir, argv, env = {}) {
    const out = [];
    const err = [];
    const code = lint.main(argv, {
        repoRoot: dir,
        cwd: dir,
        env,
        year: 2026,
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
    });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// -----------------------------------------------------------------------------
// --check: estados básicos
// -----------------------------------------------------------------------------

test('archivo con encabezado pasa el check', () => {
    const dir = makeRepo({ files: { 'src/a.js': JS_HEADER + '\nmodule.exports = 1;\n' } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK — 1 revisados, 0 exceptuados/);
});

test('acepta cualquier año, incluido un rango', () => {
    const dir = makeRepo({ files: {
        'a.kt': `// Copyright (c) 2019 ${HOLDER}\n// SPDX-License-Identifier: ${SPDX}\n\npackage x\n`,
        'b.kt': `// Copyright (c) 2019-2031 ${HOLDER}\n// SPDX-License-Identifier: ${SPDX}\n\npackage x\n`,
    } });
    assert.equal(run(dir, ['--check']).code, 0);
});

test('archivo sin encabezado falla con exit 1, nombra el archivo y da el comando de fix', () => {
    const dir = makeRepo({ files: { '.pipeline/lib/nuevo.js': `'use strict';\n// ${MARKER}\n` } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /1 archivo sin encabezado de copyright válido/);
    assert.match(r.stdout, /✗ \.pipeline\/lib\/nuevo\.js\s+falta el encabezado/);
    assert.ok(r.stdout.includes('node .pipeline/lib/license-header-lint.js --fix .pipeline/lib/nuevo.js'));
    assert.ok(r.stdout.includes(`// Copyright (c) <año> ${HOLDER}`));
    assert.ok(r.stdout.includes(`// SPDX-License-Identifier: ${SPDX}`));
});

test('encabezado mal formado: falta SPDX, holder distinto o SPDX distinto → exit 1 con el detalle', () => {
    const dir = makeRepo({ files: {
        'sin-spdx.js': `// Copyright (c) 2026 ${HOLDER}\n\nx();\n`,
        'otro-holder.js': `// Copyright (c) 2026 Otra Persona\n// SPDX-License-Identifier: ${SPDX}\n\nx();\n`,
        'otro-spdx.js': `// Copyright (c) 2026 ${HOLDER}\n// SPDX-License-Identifier: MIT\n\nx();\n`,
        'sin-copyright.sh': `# SPDX-License-Identifier: ${SPDX}\n\necho hola\n`,
    } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /sin-spdx\.js\s+encabezado mal formado \(falta la línea SPDX-License-Identifier\)/);
    assert.match(r.stdout, /otro-holder\.js\s+encabezado mal formado \(línea Copyright distinta/);
    assert.match(r.stdout, /otro-spdx\.js\s+encabezado mal formado \(SPDX-License-Identifier distinto/);
    assert.match(r.stdout, /sin-copyright\.sh\s+encabezado mal formado \(falta la línea Copyright\)/);
    assert.match(r.stdout, /Encabezado esperado \(\.sh\):/);
    assert.match(r.stdout, /# Copyright \(c\) <año> Leonel Larreta/);
});

test('la salida nunca incluye contenido de los archivos', () => {
    const dir = makeRepo({ files: {
        'a.js': `const x = '${MARKER}';\n`,
        'b.js': `// Copyright (c) 2026 ${MARKER}\n// SPDX-License-Identifier: ${SPDX}\n`,
    } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 1);
    assert.ok(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'el marcador apareció en la salida');
});

test('archivos fuera de las extensiones en scope no se evalúan', () => {
    const dir = makeRepo({ files: { 'README.md': 'hola', 'data.json': '{}', 'x.ts': 'let a = 1;' } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0 revisados/);
});

// -----------------------------------------------------------------------------
// Excepciones (allowlist) y exclusiones fijas
// -----------------------------------------------------------------------------

test('archivo exceptuado por la allowlist pasa', () => {
    const dir = makeRepo({
        files: { 'tests/fixtures/data.js': 'module.exports = {};\n' },
        exceptions: [{ glob: 'tests/fixtures/*.js', motivo: 'datos de test' }],
    });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /0 revisados, 1 exceptuados/);
});

test('excepción sin motivo → exit 2', () => {
    const dir = makeRepo({ exceptions: [{ glob: 'tests/fixtures/*.js', motivo: '   ' }] });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /falta "motivo"/);
});

test('excepciones demasiado amplias → exit 2', () => {
    for (const glob of ['**', '*', '**/*', '*/**', 'app/**', '.pipeline/**', '.pipeline/lib/**/*', 'backend/**', 'users/**', '**/*.js', '*.kt']) {
        const dir = makeRepo({ exceptions: [{ glob, motivo: 'intento de apagar el gate' }] });
        const r = run(dir, ['--check']);
        assert.equal(r.code, 2, `el glob "${glob}" debería rechazarse`);
        assert.match(r.stderr, /glob (demasiado amplio|sin ningún directorio literal)/);
    }
});

test('glob con ".." o absoluto → exit 2', () => {
    for (const glob of ['../fuera/*.js', '/etc/*.js']) {
        const dir = makeRepo({ exceptions: [{ glob, motivo: 'x' }] });
        assert.equal(run(dir, ['--check']).code, 2, glob);
    }
});

test('exclusiones fijas: binario, .conf, .env*, *credentials* y *secret* se saltean aunque la extensión esté en scope', () => {
    const dir = makeRepo({ files: {
        'bin/tool.js': Buffer.from([0x63, 0x6f, 0x00, 0x6e, 0x73]),
        '.env.local.sh': 'X=1\n',
        'lib/credentials-loader.js': 'x();\n',
        'lib/aws-SECRET.kt': 'package x\n',
    } });
    const r = run(dir, ['--check']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /0 revisados, 4 exceptuados/);
    assert.ok(lint.fixedExclusion('users/src/main/resources/application.conf'), '*.conf tiene que ser exclusión fija');
    const fix = run(dir, ['--fix']);
    assert.equal(fix.code, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'lib/credentials-loader.js'), 'utf8'), 'x();\n');
});

test('un NUL después de los primeros 2 KB no vuelve binario al fuente: check y fix coinciden', () => {
    const body = '// ' + 'x'.repeat(3000) + '\nconst s = "a\u0000b";\n';
    const dir = makeRepo({ files: { 'nul-tardio.js': body } });
    assert.equal(run(dir, ['--check']).code, 1);
    const fix = run(dir, ['--fix']);
    assert.match(fix.stdout, /1 modificados/);
    assert.equal(run(dir, ['--check']).code, 0);
});

test('.ps1 firmado con Authenticode se excluye y no se toca', () => {
    const signed = 'Write-Host hola\r\n\r\n# SIG # Begin signature block\r\n# MIIabc\r\n# SIG # End signature block\r\n';
    const dir = makeRepo({ files: { 'scripts/firmado.ps1': signed } });
    assert.equal(run(dir, ['--check']).code, 0);
    run(dir, ['--fix']);
    assert.equal(fs.readFileSync(path.join(dir, 'scripts/firmado.ps1'), 'utf8'), signed);
});

test('config: holder con "@" → exit 2; spdx inválido → exit 2', () => {
    let dir = makeRepo({ config: { holder: 'leo@example.com', spdx: SPDX } });
    let r = run(dir, ['--check']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /holder/);
    dir = makeRepo({ config: { holder: HOLDER, spdx: 'MIT OR $(rm)' } });
    assert.equal(run(dir, ['--check']).code, 2);
});

test('opción desconocida → exit 2', () => {
    const dir = makeRepo();
    assert.equal(run(dir, ['--borrar-todo']).code, 2);
});

// -----------------------------------------------------------------------------
// --fix
// -----------------------------------------------------------------------------

test('--fix agrega el encabezado + una línea en blanco y el check queda verde', () => {
    const dir = makeRepo({ files: { 'a.js': "'use strict';\n" } });
    const r = run(dir, ['--fix']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 modificados · 0 ya estaban bien · 0 exceptuados/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), JS_HEADER + "\n'use strict';\n");
    assert.equal(run(dir, ['--check']).code, 0);
});

test('--fix dos veces no duplica: la segunda corrida informa 0 modificados y el contenido es byte-idéntico', () => {
    const dir = makeRepo({ files: {
        'a.js': 'x();\n',
        'b.sh': '#!/usr/bin/env bash\necho hola\n',
        'c.kt': '@file:JvmName("C")\npackage c\n',
        'd.py': '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint(1)\n',
        'e.ps1': '﻿param($x)\r\nWrite-Host $x\r\n',
        'f.js': '\nx();\n',
        'g.js': '',
    } });
    run(dir, ['--fix']);
    const snapshot = {};
    for (const f of ['a.js', 'b.sh', 'c.kt', 'd.py', 'e.ps1', 'f.js', 'g.js']) snapshot[f] = fs.readFileSync(path.join(dir, f));
    const r2 = run(dir, ['--fix']);
    assert.match(r2.stdout, /0 modificados · 7 ya estaban bien/);
    for (const [f, buf] of Object.entries(snapshot)) {
        assert.ok(buf.equals(fs.readFileSync(path.join(dir, f))), `${f} cambió en la segunda corrida`);
    }
    assert.equal(run(dir, ['--check']).code, 0);
});

test('shebang: el #! sigue en la línea 1 y el encabezado va a continuación', () => {
    const dir = makeRepo({ files: { 'scripts/x.sh': '#!/usr/bin/env bash\nset -e\n' } });
    run(dir, ['--fix', 'scripts/x.sh']);
    const lines = fs.readFileSync(path.join(dir, 'scripts/x.sh'), 'utf8').split('\n');
    assert.equal(lines[0], '#!/usr/bin/env bash');
    assert.equal(lines[1], `# Copyright (c) 2026 ${HOLDER}`);
    assert.equal(lines[2], `# SPDX-License-Identifier: ${SPDX}`);
    assert.equal(lines[3], '');
    assert.equal(lines[4], 'set -e');
});

test('Kotlin con @file: el encabezado va antes de la anotación', () => {
    const dir = makeRepo({ files: { 'Ext.kt': '@file:Suppress("unused")\n\npackage ar.com.intrale\n' } });
    run(dir, ['--fix']);
    const txt = fs.readFileSync(path.join(dir, 'Ext.kt'), 'utf8');
    assert.equal(txt, JS_HEADER + '\n@file:Suppress("unused")\n\npackage ar.com.intrale\n');
});

test('Python: el encabezado va después del shebang y de la línea de encoding', () => {
    const dir = makeRepo({ files: { 'x.py': '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint(1)\n' } });
    run(dir, ['--fix']);
    const lines = fs.readFileSync(path.join(dir, 'x.py'), 'utf8').split('\n');
    assert.deepEqual(lines.slice(0, 5), ['#!/usr/bin/env python3', '# -*- coding: utf-8 -*-', `# Copyright (c) 2026 ${HOLDER}`, `# SPDX-License-Identifier: ${SPDX}`, '']);
});

test('se conservan BOM y CRLF', () => {
    const dir = makeRepo({ files: { 'w.ps1': '﻿param($x)\r\nWrite-Host $x\r\n' } });
    run(dir, ['--fix']);
    const buf = fs.readFileSync(path.join(dir, 'w.ps1'));
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'se perdió el BOM');
    const txt = buf.toString('utf8', 3);
    assert.equal(txt, `# Copyright (c) 2026 ${HOLDER}\r\n# SPDX-License-Identifier: ${SPDX}\r\n\r\nparam($x)\r\nWrite-Host $x\r\n`);
    assert.ok(!/[^\r]\n/.test(txt), 'quedó un LF suelto en un archivo CRLF');
});

test('se conserva el modo del archivo (bit ejecutable)', () => {
    const dir = makeRepo({ files: { 'run.sh': '#!/bin/sh\necho hi\n' } });
    const abs = path.join(dir, 'run.sh');
    fs.chmodSync(abs, 0o755);
    const before = fs.statSync(abs).mode & 0o777;
    run(dir, ['--fix']);
    assert.equal(fs.statSync(abs).mode & 0o777, before);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.lhl-')), [], 'quedó un tmp de la escritura atómica');
});

test('--fix sobre un encabezado mal formado lo reemplaza en vez de agregar otro (migración de titular)', () => {
    const dir = makeRepo({ files: {
        'a.js': `// Copyright (c) 2024 Viejo Titular\n// SPDX-License-Identifier: MIT\n\nx();\n`,
        'b.js': `// Copyright (c) 2024 ${HOLDER}\n\nx();\n`,
    } });
    run(dir, ['--fix']);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), JS_HEADER + '\nx();\n');
    // Copyright válido: se conserva su año y sólo se agrega la línea SPDX.
    assert.equal(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), `// Copyright (c) 2024 ${HOLDER}\n// SPDX-License-Identifier: ${SPDX}\n\nx();\n`);
    assert.equal(run(dir, ['--check']).code, 0);
});

test('--fix con paths sólo toca esos archivos', () => {
    const dir = makeRepo({ files: { 'a.js': 'a();\n', 'b.js': 'b();\n' } });
    run(dir, ['--fix', 'a.js']);
    assert.ok(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').startsWith(JS_HEADER));
    assert.equal(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), 'b();\n');
});

test('path explícito fuera del repo → exit 2', () => {
    const dir = makeRepo();
    const r = run(dir, ['--check', '../otro.js']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /fuera del repo/);
});

// -----------------------------------------------------------------------------
// Seguridad: symlinks y nombres hostiles
// -----------------------------------------------------------------------------

test('symlink que apunta fuera del repo se ignora y el destino no se toca', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lhl-7591-out-'));
    repos.push(outside);
    const target = path.join(outside, 'victima.js');
    fs.writeFileSync(target, 'intacto();\n');
    const dir = makeRepo();
    try {
        fs.symlinkSync(target, path.join(dir, 'link.js'), 'file');
    } catch (err) {
        t.skip(`el FS no permite crear symlinks (${err.code})`);
        return;
    }
    git(dir, ['add', 'link.js']);
    const check = run(dir, ['--check']);
    assert.equal(check.code, 0, check.stdout + check.stderr);
    run(dir, ['--fix']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'intacto();\n');
});

test('nombres con espacios, ";" y "$(...)" se procesan sin ejecutar nada', () => {
    const hostile = 'a b;touch centinela$(touch centinela2).js';
    const dir = makeRepo({ files: { [hostile]: 'x();\n' } });
    const check = run(dir, ['--check']);
    assert.equal(check.code, 1);
    // El comando sugerido va entre comillas simples: se puede copiar sin que el shell lo interprete.
    assert.ok(check.stdout.includes(`--fix '${hostile}'`), check.stdout);
    const fix = run(dir, ['--fix']);
    assert.equal(fix.code, 0);
    assert.ok(fs.readFileSync(path.join(dir, hostile), 'utf8').startsWith(JS_HEADER));
    assert.ok(!fs.existsSync(path.join(dir, 'centinela')) && !fs.existsSync(path.join(dir, 'centinela2')), 'se ejecutó el nombre de archivo');
});

// -----------------------------------------------------------------------------
// Modo diff (CI) y staged (hook)
// -----------------------------------------------------------------------------

function headSha(dir) {
    return git(dir, ['rev-parse', 'HEAD']).trim();
}

test('modo diff: sólo evalúa los archivos cambiados contra la base', () => {
    const dir = makeRepo({ files: { 'viejo-sin-header.js': 'x();\n' }, commit: true });
    const base = headSha(dir);
    write(dir, 'nuevo.js', 'y();\n');
    write(dir, 'bien.js', JS_HEADER + '\nz();\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'pr']);
    const r = run(dir, ['--check', '--diff-env', 'LICENSE_LINT_BASE'], { LICENSE_LINT_BASE: base });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes('nuevo.js'));
    assert.ok(!r.stdout.includes('viejo-sin-header.js'), 'evaluó un archivo que el PR no tocó');
    assert.match(r.stdout, /2 revisados/);
});

test('modo diff: una base que no es SHA → exit 2', () => {
    const dir = makeRepo({ commit: true });
    for (const base of ['', 'main', 'HEAD~1', '$(whoami)', 'a'.repeat(39)]) {
        const r = run(dir, ['--check', '--diff-env', 'LICENSE_LINT_BASE'], { LICENSE_LINT_BASE: base });
        assert.equal(r.code, 2, `base "${base}"`);
    }
});

test('CA-11: si el diff agrega excepciones, la salida las lista (aunque se rechacen)', () => {
    const dir = makeRepo({ exceptions: [{ glob: 'tests/fixtures/*.js', motivo: 'datos' }], commit: true });
    const base = headSha(dir);
    write(dir, lint.ALLOWLIST_REL, JSON.stringify({ exceptions: [
        { glob: 'tests/fixtures/*.js', motivo: 'datos' },
        { glob: 'vendor/lib/*.js', motivo: 'código de terceros' },
        { glob: '**', motivo: 'apagar el gate' },
    ] }));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'pr']);
    const r = run(dir, ['--check', '--diff-env', 'LICENSE_LINT_BASE'], { LICENSE_LINT_BASE: base });
    assert.equal(r.code, 2, 'el "**" tiene que rechazarse');
    assert.match(r.stdout, /⚠ Este PR agrega 2 excepciones:/);
    assert.match(r.stdout, /\+ vendor\/lib\/\*\.js — código de terceros/);
    assert.match(r.stdout, /\+ \*\* — apagar el gate/);
    assert.ok(!r.stdout.includes('+ tests/fixtures'), 'listó una entrada que ya existía');
});

test('modo staged: sólo evalúa lo que está en el índice', () => {
    const dir = makeRepo({ files: { 'viejo.js': 'x();\n' }, commit: true });
    write(dir, 'staged.js', 'y();\n');
    write(dir, 'untracked.js', 'z();\n');
    git(dir, ['add', 'staged.js']);
    const r = run(dir, ['--check', '--staged']);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes('staged.js'));
    assert.ok(!r.stdout.includes('viejo.js') && !r.stdout.includes('untracked.js'));
});

test('sólo recorre archivos trackeados: un archivo sin agregar a git no se evalúa en el check completo', () => {
    const dir = makeRepo({ files: { 'a.js': JS_HEADER + '\na();\n' } });
    write(dir, 'untracked.js', 'z();\n');
    assert.equal(run(dir, ['--check']).code, 0);
});

test('en GitHub Actions emite anotaciones ::error con el path escapado', () => {
    // `:` no es válido en nombres de archivo de Windows: acá se prueban `,` y `%`
    // (el escape de `:` lo cubre el test de escapeWorkflowProperty).
    const dir = makeRepo({ files: { 'a,b%c.js': 'x();\n' } });
    const r = run(dir, ['--check'], { GITHUB_ACTIONS: 'true' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error file=a%2Cb%25c\.js,line=1::license-header-lint: falta el encabezado/);
});

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

test('escapeWorkflowProperty escapa %, CR, LF, ":" y ","', () => {
    assert.equal(lint.escapeWorkflowProperty('a%b\rc\nd:e,f'), 'a%25b%0Dc%0Ad%3Ae%2Cf');
    assert.equal(lint.escapeWorkflowProperty('x\n::error::fake'), 'x%0A%3A%3Aerror%3A%3Afake');
});

test('globToRegExp: ** cruza directorios, * y ? no', () => {
    const re = lint.globToRegExp('.pipeline/lib/__tests__/fixtures/*.js');
    assert.ok(re.test('.pipeline/lib/__tests__/fixtures/a.js'));
    assert.ok(!re.test('.pipeline/lib/__tests__/fixtures/sub/a.js'));
    const deep = lint.globToRegExp('a/**');
    assert.ok(deep.test('a/b/c/d.js'));
    const mid = lint.globToRegExp('**/fixtures/*.js');
    assert.ok(mid.test('fixtures/x.js') && mid.test('p/q/fixtures/x.js'));
    assert.ok(lint.globToRegExp('a?.js').test('ab.js'));
    assert.ok(!lint.globToRegExp('a.js').test('aXjs'), 'el punto tiene que ser literal');
});

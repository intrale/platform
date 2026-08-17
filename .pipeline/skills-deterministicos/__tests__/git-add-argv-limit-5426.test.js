// Regresión del rebote rev-1 de #5426 (fase `entrega`).
//
// Síntoma: «[delivery] git add falló: La línea de comandos es demasiado larga.»
//
// Causa raíz: `delivery.js` stageaba con `runGit(['add', '--', ...stagePaths])`,
// un path por argumento. `runCmd` usa `shell: true` en win32, así que el comando
// pasa por cmd.exe, cuyo límite duro es 8191 caracteres (no los 32767 de
// CreateProcess). El worktree del rebote tenía 406 archivos cambiados que
// sumaban ~16,9 KB de paths.
//
// Estos tests crean un repo git de verdad en un tmpdir y stagean una cantidad
// de archivos cuyos paths superan holgadamente el límite. Con el código viejo
// el `git add` explota en Windows; con `addPaths` (pathspecs por stdin) pasa.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ops = require('../lib/git-ops');

// Repo temporal aislado, sin tocar el repo real ni la config global del usuario.
function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-add-5426-'));
    const run = (args) => {
        const r = ops.runGit(args, { cwd: dir });
        assert.equal(r.exit_code, 0, `git ${args.join(' ')} falló: ${r.stderr || r.stdout}`);
        return r;
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'pipeline@intrale.test']);
    run(['config', 'user.name', 'pipeline-test']);
    run(['config', 'core.autocrlf', 'false']);
    return { dir, run };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Genera N archivos con nombres largos para inflar el largo total de la lista.
function seedFiles(dir, count, prefix = 'a') {
    const rel = [];
    const sub = path.join(dir, 'paquete-con-nombre-deliberadamente-largo');
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < count; i++) {
        const name = `${prefix}-archivo-de-prueba-con-nombre-largo-para-inflar-argv-${String(i).padStart(4, '0')}.txt`;
        fs.writeFileSync(path.join(sub, name), `contenido ${i}\n`);
        rel.push(`paquete-con-nombre-deliberadamente-largo/${name}`);
    }
    return rel;
}

test('addPaths — stagea 400+ archivos cuyos paths superan el límite de cmd.exe (8191)', () => {
    const { dir, run } = makeRepo();
    try {
        const rel = seedFiles(dir, 420);

        // El escenario tiene que reproducir de verdad la condición del rebote:
        // si la lista entrara en 8191 chars, el test pasaría incluso con el bug.
        const argvLen = rel.join(' ').length;
        assert.ok(
            argvLen > 8191,
            `el escenario no reproduce el rebote: la lista mide ${argvLen} chars, ` +
            'necesita superar el límite de cmd.exe (8191)'
        );

        const res = ops.addPaths(rel, { cwd: dir });
        assert.equal(res.exit_code, 0, `addPaths falló: ${res.stderr || res.stdout}`);

        const staged = run(['diff', '--cached', '--name-only']).stdout
            .split(/\r?\n/).filter(Boolean);
        assert.equal(staged.length, rel.length, 'deben quedar staged todos los archivos');
    } finally {
        cleanup(dir);
    }
});

test('addPaths — un path llamado "--" no se interpreta como separador de opciones', () => {
    // En el worktree del rebote había un archivo llamado literalmente `--`
    // (fixture de un test de inyección de otro issue). Con pathspecs por stdin
    // nada del contenido se interpreta como opción.
    const { dir, run } = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, '--'), 'fixture\n');
        const res = ops.addPaths(['--'], { cwd: dir });
        assert.equal(res.exit_code, 0, `addPaths falló: ${res.stderr || res.stdout}`);

        const staged = run(['diff', '--cached', '--name-only']).stdout.trim();
        assert.equal(staged, '--');
    } finally {
        cleanup(dir);
    }
});

test('addPaths — un path con espacios se stagea como UN solo pathspec', () => {
    // Con `shell: true` Node no escapa los argumentos, así que la variante por
    // argv partía "mi archivo.txt" en dos pathspecs inexistentes.
    const { dir, run } = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'mi archivo con espacios.txt'), 'x\n');
        const res = ops.addPaths(['mi archivo con espacios.txt'], { cwd: dir });
        assert.equal(res.exit_code, 0, `addPaths falló: ${res.stderr || res.stdout}`);

        const staged = run(['diff', '--cached', '--name-only']).stdout.trim();
        assert.equal(staged, 'mi archivo con espacios.txt');
    } finally {
        cleanup(dir);
    }
});

test('addPaths — lista vacía es un no-op exitoso, no invoca git', () => {
    const res = ops.addPaths([], { cwd: process.cwd() });
    assert.equal(res.exit_code, 0);
    assert.equal(res.stdout, '');
    // `git add` sin pathspecs devuelve "Nothing specified, nothing added"; el
    // no-op evita esa invocación inútil (y su advice ruidoso) por completo.
    assert.match(res.cmd, /sin paths/);
});

test('addPaths — descarta entradas vacías o no-string sin romper', () => {
    const { dir, run } = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'valido.txt'), 'x\n');
        const res = ops.addPaths(['valido.txt', '', null, undefined, 42], { cwd: dir });
        assert.equal(res.exit_code, 0, `addPaths falló: ${res.stderr || res.stdout}`);

        const staged = run(['diff', '--cached', '--name-only']).stdout.trim();
        assert.equal(staged, 'valido.txt');
    } finally {
        cleanup(dir);
    }
});

test('addPaths — propaga el fallo real de git (path inexistente) sin enmascararlo', () => {
    const { dir } = makeRepo();
    try {
        const res = ops.addPaths(['no-existe-este-archivo.txt'], { cwd: dir });
        assert.notEqual(res.exit_code, 0, 'un pathspec inexistente debe fallar');
    } finally {
        cleanup(dir);
    }
});

test('chunkPathsByBudget — ningún lote supera el presupuesto de argv', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `dir/archivo-largo-${i}.txt`);
    const chunks = ops.chunkPathsByBudget(paths, 1000);

    assert.ok(chunks.length > 1, 'con 500 paths y presupuesto 1000 debe haber varios lotes');
    for (const c of chunks) {
        const len = c.reduce((acc, p) => acc + Buffer.byteLength(p, 'utf8') + 3, 0);
        assert.ok(len <= 1000, `lote de ${len} bytes supera el presupuesto`);
    }
    assert.deepEqual(chunks.flat(), paths, 'no se pierde ni se duplica ningún path');
});

test('chunkPathsByBudget — un path más grande que el presupuesto sale solo, sin bucle infinito', () => {
    const gigante = 'x'.repeat(5000);
    const chunks = ops.chunkPathsByBudget([gigante, 'chico.txt'], 100);

    assert.deepEqual(chunks, [[gigante], ['chico.txt']]);
});

test('chunkPathsByBudget — lista vacía devuelve cero lotes', () => {
    assert.deepEqual(ops.chunkPathsByBudget([], 1000), []);
});

test('runCmd — opts.input alimenta el stdin del hijo', () => {
    // Garantía de la que depende addPaths: sin stdin, la lista vuelve a argv.
    const res = ops.runGit(['hash-object', '--stdin'], { input: 'hola\n' });
    assert.equal(res.exit_code, 0, `git hash-object falló: ${res.stderr}`);
    // SHA-1 estable de un blob con contenido "hola\n".
    assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/);
});

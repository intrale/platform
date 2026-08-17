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

// Regresión del rebote rev-2 de #5426 (fase `verificacion`, hallazgo
// [Alta][OWASP A03 - Injection]).
//
// El test de arriba probaba el fallback con UN SOLO path benigno, que nunca
// llega a cmd.exe con metacaracteres, así que afirmaba una garantía que el
// código no cumplía. El fallback por lotes corría bajo `shell: true` (default
// de `runCmd` en win32) y Node no escapa los argumentos: con un archivo
// llamado `a&ver` en el worktree, cmd.exe cortaba el nombre en el `&` y
// ejecutaba `ver` como comando propio. Peor: el exit code que volvía era el
// del comando inyectado (0), así que un `git add` fallido se reportaba como
// éxito y `delivery.js:1406` — que sólo lanza si `exit_code !== 0` — seguía de
// largo con la entrega incompleta.
//
// El escenario necesita las DOS piezas juntas: un path con metacaracter Y un
// path inexistente que fuerce el fallo del camino por stdin y active el
// fallback por argv.
test('addPaths — un path con "&" no ejecuta comandos por cmd.exe ni enmascara el fallo', () => {
    const { dir } = makeRepo();
    try {
        // `&` es un caracter VÁLIDO en nombres de archivo de Windows y un
        // separador de comandos en cmd.exe. `ver` imprime la versión del SO:
        // si aparece en stdout, hubo ejecución de un comando ajeno a git.
        fs.writeFileSync(path.join(dir, 'a&ver'), 'payload\n');
        fs.writeFileSync(path.join(dir, 'normal.txt'), 'x\n');

        const res = ops.addPaths(
            ['normal.txt', 'a&ver', 'NO-EXISTE-fuerza-el-fallback.txt'],
            { cwd: dir }
        );

        assert.notEqual(
            res.exit_code, 0,
            'el pathspec inexistente debe hacer fallar el lote; exit 0 significa ' +
            'que el exit code que volvió es el del comando inyectado, no el de git'
        );
        assert.ok(
            !/Microsoft Windows|Versi/i.test(res.stdout),
            `stdout contiene salida de un comando ajeno a git (inyección): ${JSON.stringify(res.stdout)}`
        );
    } finally {
        cleanup(dir);
    }
});

test('addPaths — metacaracteres de cmd.exe en nombres de archivo se stagean literales', () => {
    // La contracara del test anterior: además de no ejecutar nada, los nombres
    // con metacaracteres tienen que llegar a git tal cual. Todos estos son
    // caracteres válidos en nombres de archivo de Windows.
    const { dir, run } = makeRepo();
    try {
        const nombres = ['con&ampersand.txt', 'con^caret.txt', 'con%percent%.txt', 'con(parens).txt'];
        for (const n of nombres) fs.writeFileSync(path.join(dir, n), 'x\n');

        const res = ops.addPaths(nombres, { cwd: dir });
        assert.equal(res.exit_code, 0, `addPaths falló: ${res.stderr || res.stdout}`);

        const staged = run(['diff', '--cached', '--name-only']).stdout
            .split(/\r?\n/).filter(Boolean).sort();
        assert.deepEqual(staged, [...nombres].sort());
    } finally {
        cleanup(dir);
    }
});

test('addPaths — el fallback por lotes corre sin shell (argv sin cmd.exe)', () => {
    // Verificación directa de la propiedad, independiente del sistema de
    // archivos: `runGit` con `shell: false` no pasa por cmd.exe, así que un
    // `&` en un argumento es dato y no un separador de comandos.
    const { dir } = makeRepo();
    try {
        fs.writeFileSync(path.join(dir, 'normal.txt'), 'x\n');
        fs.writeFileSync(path.join(dir, 'a&ver'), 'y\n');

        const res = ops.runGit(
            ['add', '--', 'normal.txt', 'a&ver', 'NO-EXISTE.txt'],
            { cwd: dir, shell: false }
        );

        assert.notEqual(res.exit_code, 0, 'git debe reportar el pathspec inexistente');
        assert.match(res.stderr, /NO-EXISTE\.txt/, 'el error debe ser el de git, no el de otro comando');
        assert.ok(!/Microsoft Windows|Versi/i.test(res.stdout), 'no debe ejecutarse ningún comando ajeno');
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

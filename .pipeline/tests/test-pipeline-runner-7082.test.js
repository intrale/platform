// =============================================================================
// test-pipeline-runner-7082.test.js — #7082 CA-4 / CA-5 / SEC-2
//
// Tests del runner canonico `scripts/test-pipeline.js`. Todos corren sobre un
// FIXTURE en `mkdtemp` con `git init`: NUNCA se invoca `main()` sobre el repo
// real (seria la suite dentro de la suite) y `run()` de `node:test` no se toca
// desde aca (llamado dentro de un archivo de test saltea en silencio y reporta
// verde). `--list` se ejercita via `spawnSync` sobre una copia del runner en el
// fixture.
//
// node --test .pipeline/tests/test-pipeline-runner-7082.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('../lib/_test-helpers/ensure-git-on-path');

const runner = require('../../scripts/test-pipeline');
const { collectTestFiles, isExcludedRelPath, listUntracked, PATTERNS } = runner;

const RUNNER_SRC = path.resolve(__dirname, '..', '..', 'scripts', 'test-pipeline.js');
const SCRATCH_DIRS_SRC = path.resolve(__dirname, '..', 'lib', 'scratch-dirs.js');

function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ' fallo: ' + (r.stderr || ''));
    return r.stdout;
}

function escribir(root, rel, contenido = "'use strict';\n") {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenido);
    return abs;
}

/**
 * Repo de fixture: git init + los 4 origenes del runner con tests legitimos y
 * scratchpads poblados en TODOS los niveles. Devuelve `{ root, commit }`.
 */
function fixtureRepo(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp7082-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'pipeline@intrale.test');
    git(root, 'config', 'user.name', 'pipeline');
    // Mismo ignore que el repo real para los scratchpads.
    escribir(root, '.gitignore', '.pipeline/tmp/\n.pipeline/_tmp/\nnode_modules/\n');

    // Legitimos (uno por origen + varios niveles bajo .pipeline).
    escribir(root, '.pipeline/lib/__tests__/a.test.js');
    escribir(root, '.pipeline/tests/b.test.js');
    escribir(root, '.pipeline/views/dashboard/__tests__/c.test.js');
    escribir(root, 'qa/scripts/__tests__/d.test.js');
    escribir(root, 'scripts/e.test.js');
    escribir(root, '.claude/hooks/tests/test-p09-telegram-client.js');
    // Un ARCHIVO con nombre tmp-* dentro de un dir legitimo: entra (se poda por directorio).
    escribir(root, '.pipeline/tests/tmp-named.test.js');
    // Fuera del universo: no entra aunque sea *.test.js.
    escribir(root, 'app/x.test.js');
    escribir(root, '.claude/hooks/tests/test-otro.js');

    // Scratch en todos los niveles y variantes.
    escribir(root, '.pipeline/tmp/x/evil.test.js');
    escribir(root, '.pipeline/_tmp/evil2.test.js');
    escribir(root, '.pipeline/tmp-review-5245/deep/evil3.test.js');
    escribir(root, '.pipeline/lib/deep/tmpz/evil4.test.js');
    escribir(root, '.pipeline/node_modules/pkg/evil5.test.js');
    escribir(root, 'scripts/tmp/evil6.test.js');
    escribir(root, 'qa/scripts/__tests__/_tmp/evil7.test.js');

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    return { root, commit };
}

const ESPERADOS = [
    '.claude/hooks/tests/test-p09-telegram-client.js',
    '.pipeline/lib/__tests__/a.test.js',
    '.pipeline/tests/b.test.js',
    '.pipeline/tests/tmp-named.test.js',
    '.pipeline/views/dashboard/__tests__/c.test.js',
    'qa/scripts/__tests__/d.test.js',
    'scripts/e.test.js',
];

// ─── (1) exclusion por cualquier segmento ───────────────────────────────────

test('#7082 (1) · tmp/, _tmp/, tmp-review-x/ y node_modules/ se excluyen en CUALQUIER nivel', (t) => {
    const { root } = fixtureRepo(t);
    const files = collectTestFiles({ repoRoot: root });
    for (const f of files) {
        assert.doesNotMatch(f, /(^|\/)(tmp[^/]*|_tmp|node_modules)\//, 'entro un scratch: ' + f);
    }
    assert.ok(!files.some((f) => f.includes('evil')), 'entro un evil*.test.js: ' + JSON.stringify(files));
    // Y la lista es la misma con los scratchpads BORRADOS (reproducible).
    for (const d of ['.pipeline/tmp', '.pipeline/_tmp', '.pipeline/tmp-review-5245', '.pipeline/lib/deep/tmpz',
        '.pipeline/node_modules', 'scripts/tmp', 'qa/scripts/__tests__/_tmp']) {
        fs.rmSync(path.join(root, ...d.split('/')), { recursive: true, force: true });
    }
    assert.deepEqual(collectTestFiles({ repoRoot: root }), files, 'la lista cambio al vaciar los scratchpads');
});

test('#7082 (1b) · isExcludedRelPath decide por segmento de directorio, nunca por nombre de archivo', () => {
    assert.equal(isExcludedRelPath('.pipeline/tmp/x/evil.test.js'), true);
    assert.equal(isExcludedRelPath('.pipeline/_tmp/evil.test.js'), true);
    assert.equal(isExcludedRelPath('.pipeline/tmp-review-5245/p09.test.js'), true);
    assert.equal(isExcludedRelPath('.pipeline/lib/deep/tmpz/e.test.js'), true);
    assert.equal(isExcludedRelPath('.pipeline/node_modules/pkg/e.test.js'), true);
    assert.equal(isExcludedRelPath('.pipeline\\tmp\\x\\evil.test.js'), true, 'separador Windows');
    assert.equal(isExcludedRelPath('.pipeline/tests/tmp-named.test.js'), false, 'archivo tmp-* en dir legitimo entra');
    assert.equal(isExcludedRelPath('.pipeline/lib/__tests__/a.test.js'), false);
    assert.equal(isExcludedRelPath(''), true, 'vacio: fail-closed');
    assert.equal(isExcludedRelPath(undefined), true, 'no-string: fail-closed');
});

// ─── (2) los legitimos entran ───────────────────────────────────────────────

test('#7082 (2) · lib/__tests__/a.test.js, tests/b.test.js y el resto de los 4 origenes entran', (t) => {
    const { root } = fixtureRepo(t);
    const files = collectTestFiles({ repoRoot: root });
    assert.deepEqual(files, ESPERADOS);
    // El universo no se amplia: nada fuera de los 4 origenes.
    assert.ok(!files.includes('app/x.test.js'));
    assert.ok(!files.includes('.claude/hooks/tests/test-otro.js'));
    assert.deepEqual(PATTERNS, [
        '.pipeline/**/*.test.js',
        'qa/scripts/__tests__/**/*.test.js',
        'scripts/**/*.test.js',
        '.claude/hooks/tests/test-p09-telegram-client.js',
    ]);
});

// ─── (3) symlink / junction ─────────────────────────────────────────────────

test('#7082 (3) · un junction/symlink desde lib/__tests__/link hacia tmp/ NO cuela evil.test.js', (t) => {
    const { root } = fixtureRepo(t);
    const target = path.join(root, '.pipeline', 'tmp');
    const link = path.join(root, '.pipeline', 'lib', '__tests__', 'link');
    try {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
        t.skip('no se pudo crear el enlace en este host: ' + e.message);
        return;
    }
    assert.ok(fs.existsSync(path.join(link, 'x', 'evil.test.js')), 'el enlace no resuelve: fixture invalida');
    const files = collectTestFiles({ repoRoot: root });
    assert.ok(!files.some((f) => f.startsWith('.pipeline/lib/__tests__/link/')),
        'entro un archivo via enlace: ' + JSON.stringify(files));
    assert.ok(!files.some((f) => f.includes('evil')));
    assert.deepEqual(files, ESPERADOS);

    // Enlace a un archivo suelto dentro de un dir legitimo: tampoco entra.
    const fileLink = path.join(root, '.pipeline', 'tests', 'alias.test.js');
    try {
        fs.symlinkSync(path.join(root, '.pipeline', 'tmp', 'x', 'evil.test.js'), fileLink, 'file');
    } catch {
        return; // sin privilegio para symlink de archivo en Windows: la parte de junction ya se cubrio
    }
    assert.ok(!collectTestFiles({ repoRoot: root }).includes('.pipeline/tests/alias.test.js'),
        'entro un symlink de archivo');
});

// ─── (4) untracked visibles y --tracked-only ────────────────────────────────

test('#7082 (4) · listUntracked devuelve el archivo ?? y --tracked-only lo saca de la corrida', (t) => {
    const { root } = fixtureRepo(t);
    escribir(root, '.pipeline/lib/__tests__/nuevo-sin-commit.test.js');
    // Un untracked DENTRO de un scratchpad no se reporta: no entra a la corrida.
    escribir(root, '.pipeline/tmp-review-1/p09.test.js');
    // Ruido no-test untracked (como los assets/signoffs del checkout principal):
    // no puede reventar la consulta a git (ENOBUFS) ni aparecer en la lista.
    for (let i = 0; i < 300; i++) escribir(root, '.pipeline/assets/docs/ruido-' + i + '.md', 'x'.repeat(4096));

    const files = collectTestFiles({ repoRoot: root });
    assert.ok(files.includes('.pipeline/lib/__tests__/nuevo-sin-commit.test.js'));
    assert.ok(!files.includes('.pipeline/tmp-review-1/p09.test.js'));

    const untracked = listUntracked({ repoRoot: root, files });
    assert.deepEqual(untracked, ['.pipeline/lib/__tests__/nuevo-sin-commit.test.js']);

    // --list por default lo incluye y lo anuncia en stderr con `??`.
    const porDefault = correrList(root);
    assert.equal(porDefault.status, 0, porDefault.stderr);
    assert.ok(porDefault.stdout.split('\n').includes('.pipeline/lib/__tests__/nuevo-sin-commit.test.js'));
    assert.match(porDefault.stderr, /1 archivo\(s\) de test NO versionados \(se ejecutan\)/);
    assert.match(porDefault.stderr, /^ {2}\?\? \.pipeline\/lib\/__tests__\/nuevo-sin-commit\.test\.js$/m);
    assert.match(porDefault.stderr, /npm run test:pipeline:tracked/, 'el listado dice que hacer');

    // --tracked-only lo excluye.
    const soloTracked = correrList(root, '--tracked-only');
    assert.equal(soloTracked.status, 0, soloTracked.stderr);
    assert.ok(!soloTracked.stdout.split('\n').includes('.pipeline/lib/__tests__/nuevo-sin-commit.test.js'));
    assert.match(soloTracked.stderr, /excluidos por --tracked-only/);
    assert.deepEqual(soloTracked.stdout.trim().split('\n'), ESPERADOS);
});

test('#7082 (4b) · en un arbol limpio el runner es silencioso: --list no escribe nada en stderr', (t) => {
    const { root } = fixtureRepo(t);
    const r = correrList(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'cero untracked = silencio');
    assert.deepEqual(r.stdout.trim().split('\n'), ESPERADOS);
});

// ─── (5) SEC-2: un evil.test.js en tmp no se ejecuta ────────────────────────

test('#7082 (5) · SEC-2: tmp/evil.test.js que escribiria un centinela en os.tmpdir() no entra ni se ejecuta', (t) => {
    const { root } = fixtureRepo(t);
    const centinela = path.join(os.tmpdir(), 'tp7082-centinela-' + process.pid + '-' + Date.now() + '.txt');
    t.after(() => { try { fs.unlinkSync(centinela); } catch { /* no existe: es lo esperado */ } });
    escribir(root, '.pipeline/tmp/evil.test.js',
        "require('fs').writeFileSync(" + JSON.stringify(centinela) + ", 'pwned');\n");

    const files = collectTestFiles({ repoRoot: root });
    assert.ok(!files.includes('.pipeline/tmp/evil.test.js'));

    // Lo que si se ejecuta via el camino real del runner (copiado al fixture) es
    // `--list`, que NO carga ningun archivo de test: el centinela no puede aparecer.
    const r = correrList(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('evil'));
    assert.equal(fs.existsSync(centinela), false, 'el evil.test.js se ejecuto');
});

// ─── (6) rutas relativas con / ──────────────────────────────────────────────

test('#7082 (6) · las rutas devueltas usan / y son relativas al repo, ordenadas y sin duplicados', (t) => {
    const { root } = fixtureRepo(t);
    const files = collectTestFiles({ repoRoot: root });
    for (const f of files) {
        assert.ok(!f.includes('\\'), 'backslash en ' + f);
        assert.ok(!path.isAbsolute(f), 'absoluta: ' + f);
        assert.ok(!f.startsWith('./') && !f.startsWith('../'), 'relativa rara: ' + f);
        assert.ok(fs.statSync(path.join(root, f)).isFile());
    }
    assert.deepEqual(files, [...files].sort());
    assert.equal(new Set(files).size, files.length);
    // Mismo resultado con el root expresado con separador nativo o con `/`.
    assert.deepEqual(collectTestFiles({ repoRoot: root.split(path.sep).join('/') }), files);
});

// ─── exit codes honestos ────────────────────────────────────────────────────

test('#7082 · con 0 archivos de test el runner aborta con exit 1 en vez de un verde vacio', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp7082-vacio-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q');
    const r = correrRunner(root, []);
    assert.equal(r.status, 1, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
    assert.match(r.stderr, /0 archivos de test encontrados .* abortando \(exit 1\)/);
});

test('#7082 · un argumento desconocido o un reporter invalido cortan con exit 2', (t) => {
    const { root } = fixtureRepo(t);
    const a = correrRunner(root, ['--lista']);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /argumento desconocido: --lista/);
    const b = correrRunner(root, ['--list', '--reporter=json']);
    assert.equal(b.status, 2);
    assert.match(b.stderr, /--reporter admite/);
});

test('#7082 · el runner se niega a correr dentro de node --test (run() recursivo saltea en silencio)', (t) => {
    const { root } = fixtureRepo(t);
    const r = correrRunner(root, ['--list'], { NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no se puede correr dentro de node --test/);
    assert.equal(r.stdout, '');
});

test('#7082 · el runner no serializa process.env: solo lee flags puntuales', () => {
    // Solo codigo: las lineas de comentario del header mencionan `process.env` al
    // describir el contrato.
    const codigo = fs.readFileSync(RUNNER_SRC, 'utf8').split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const usos = codigo.match(/process\.env[^\n]*/g) || [];
    assert.deepEqual(usos.map((u) => u.split(/[\s)]/)[0]), ['process.env.NODE_TEST_CONTEXT'],
        'usos de process.env fuera de contrato: ' + JSON.stringify(usos));
    assert.doesNotMatch(codigo, /JSON\.stringify\(process\.env|env:\s*process\.env|env:\s*\{/);
});

// ─── helpers: copia del runner en el fixture ────────────────────────────────

/**
 * Copia el runner y su unica dependencia (`scratch-dirs.js`) al fixture para
 * que `main()` resuelva `repoRoot = <fixture>` desde su propio `__dirname`.
 * `main()` NUNCA se invoca sobre el repo real.
 */
function instalarRunner(root) {
    const dest = path.join(root, 'scripts', 'test-pipeline.js');
    if (fs.existsSync(dest)) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(RUNNER_SRC, dest);
    const scratch = path.join(root, '.pipeline', 'lib', 'scratch-dirs.js');
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.copyFileSync(SCRATCH_DIRS_SRC, scratch);
    return dest;
}

function correrRunner(root, args, envExtra = {}) {
    const script = instalarRunner(root);
    const env = { ...process.env, ...envExtra };
    delete env.NODE_OPTIONS;
    if (!('NODE_TEST_CONTEXT' in envExtra)) delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [script, ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, env, timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function correrList(root, ...extra) {
    return correrRunner(root, ['--list', ...extra]);
}

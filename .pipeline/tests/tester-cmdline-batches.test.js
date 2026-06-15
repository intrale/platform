// Tests de `buildNodeTestBatches` — regresión del rebote #3953
// (`spawn ENAMETOOLONG`): la línea de comandos de `node --test <files...>`
// superaba el límite de Windows (32767 chars) al volcar 307 rutas absolutas.
// El fix usa rutas relativas + batching cuando la porción de archivos excede
// un presupuesto seguro.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tester = require('../skills-deterministicos/tester.js');
const { buildNodeTestBatches } = tester;

const ROOT = process.platform === 'win32' ? 'C:\\repo\\worktree' : '/repo/worktree';

function makeFiles(n, root = ROOT) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(path.join(root, '.pipeline', 'tests', `archivo-numero-${i}.test.js`));
    }
    return out;
}

test('un solo batch cuando la porción de archivos entra en el presupuesto', () => {
    const files = makeFiles(5);
    const batches = buildNodeTestBatches(files, ROOT, 28000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 5);
});

test('convierte rutas absolutas en relativas al repoRoot (cwd del spawn)', () => {
    const files = makeFiles(3);
    const batches = buildNodeTestBatches(files, ROOT, 28000);
    for (const batch of batches) {
        for (const f of batch) {
            assert.ok(!path.isAbsolute(f), `esperaba ruta relativa, recibí: ${f}`);
            assert.ok(!f.startsWith('..'), `la relativa no debe salir del root: ${f}`);
        }
    }
});

test('parte en múltiples batches cuando se supera el presupuesto', () => {
    const files = makeFiles(50);
    // Presupuesto chico fuerza el split.
    const batches = buildNodeTestBatches(files, ROOT, 200);
    assert.ok(batches.length > 1, 'esperaba más de un batch con presupuesto chico');
    // Ningún batch (salvo singletons inevitables) excede el presupuesto.
    for (const batch of batches) {
        const len = batch.reduce((acc, f) => acc + f.length + 1, 0);
        const isSingleton = batch.length === 1;
        assert.ok(len <= 200 || isSingleton, `batch excede presupuesto sin ser singleton: ${len}`);
    }
});

test('no pierde ni duplica archivos al partir en batches', () => {
    const files = makeFiles(123);
    const batches = buildNodeTestBatches(files, ROOT, 300);
    const flat = batches.flat();
    assert.equal(flat.length, files.length, 'la cantidad total debe coincidir');
    // Reconstruir absolutas y comparar como set.
    const reconstructed = new Set(flat.map((rel) => path.resolve(ROOT, rel)));
    const original = new Set(files.map((f) => path.resolve(f)));
    assert.equal(reconstructed.size, original.size);
    for (const f of original) assert.ok(reconstructed.has(f), `falta archivo: ${f}`);
});

test('un archivo cuya ruta relativa excede el presupuesto se emite solo (no se descarta)', () => {
    const longName = 'x'.repeat(500);
    const files = [path.join(ROOT, '.pipeline', 'tests', `${longName}.test.js`)];
    const batches = buildNodeTestBatches(files, ROOT, 50);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 1);
});

test('regresión #3953: la línea de comandos real nunca excede el límite de Windows', () => {
    // 307 archivos (cantidad del fallo real) con rutas de worktree largas.
    const longRoot = process.platform === 'win32'
        ? 'C:\\Workspaces\\Intrale\\platform.agent-3953-pipeline-dev'
        : '/Workspaces/Intrale/platform.agent-3953-pipeline-dev';
    const files = makeFiles(307, longRoot);
    const batches = buildNodeTestBatches(files, longRoot);

    const WIN_LIMIT = 32767;
    const fixed = [
        '--test', '--test-timeout=120000', '--test-force-exit',
        '--test-reporter=junit',
        `--test-reporter-destination=${path.join(longRoot, '.pipeline', 'logs', 'node-tests-junit.xml')}`,
        '--test-reporter=spec', '--test-reporter-destination=stdout',
    ];
    for (const batch of batches) {
        const line = process.execPath + ' ' + [...fixed, ...batch].join(' ');
        assert.ok(line.length < WIN_LIMIT, `cmdline de ${line.length} chars excede ${WIN_LIMIT}`);
    }
});

test('lista vacía produce cero batches', () => {
    assert.deepEqual(buildNodeTestBatches([], ROOT, 28000), []);
});

'use strict';

// #7112 · CA-4 — tests del helper del dir efímero de pruebas (`lib/test-run-dir.js`).
// Siempre con `env` literal: nunca se muta `process.env`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRunDir = require('../test-run-dir');
const { ensureTestRunDir, esDirEfimero, ENV_DIR, PREFIJO_TMP } = testRunDir;

test('CA-4 · sin override: crea un mkdtemp bajo os.tmpdir() (nunca bajo .pipeline), lo deja en PIPELINE_DIR_OVERRIDE y avisa en una línea', () => {
    const env = {};
    const lineas = [];
    const r = ensureTestRunDir({ env, log: (l) => lineas.push(l), registrarLimpieza: false });
    assert.strictEqual(r.creado, true);
    assert.strictEqual(env[ENV_DIR], r.dir);
    assert.ok(esDirEfimero(r.dir), 'bajo os.tmpdir() con el prefijo del helper');
    assert.ok(!r.dir.includes(path.sep + '.pipeline' + path.sep), 'nunca dentro de un .pipeline (#7406)');
    assert.ok(fs.statSync(r.dir).isDirectory());
    assert.deepStrictEqual(lineas, [`dir de pruebas: ${r.dir} (efímero, se borra al terminar)`]);
    // Base mínima copiada (no enlazada) para que loadConfig no pause el Pulpo de prueba.
    assert.ok(fs.existsSync(path.join(r.dir, 'config.yaml')), 'config.yaml copiado');
    assert.ok(fs.existsSync(path.join(r.dir, 'pipeline.config.json')), 'pipeline.config.json copiado');
    assert.ok(!fs.lstatSync(path.join(r.dir, 'config.yaml')).isSymbolicLink());
    // Se borra al terminar y limpia la variable.
    assert.strictEqual(r.limpiar(), true);
    assert.ok(!fs.existsSync(r.dir), 'dir borrado');
    assert.strictEqual(env[ENV_DIR], undefined);
    assert.strictEqual(r.limpiar(), false, 'idempotente');
    assert.deepStrictEqual(lineas.slice(1), ['dir de pruebas borrado']);
});

test('CA-4 · con PIPELINE_DIR_OVERRIDE ya declarado: se respeta, no se crea nada y no se borra', () => {
    const propio = fs.mkdtempSync(path.join(os.tmpdir(), 'propio-7112-'));
    const env = { [ENV_DIR]: propio };
    const lineas = [];
    const r = ensureTestRunDir({ env, log: (l) => lineas.push(l), registrarLimpieza: false });
    assert.strictEqual(r.creado, false);
    assert.strictEqual(r.dir, path.resolve(propio));
    assert.strictEqual(env[ENV_DIR], propio);
    assert.deepStrictEqual(lineas, [`dir de pruebas: ${path.resolve(propio)} (declarado por el llamador, no se borra)`]);
    assert.strictEqual(r.limpiar(), false);
    assert.ok(fs.existsSync(propio), 'el dir del llamador no se toca');
    fs.rmSync(propio, { recursive: true, force: true });
});

test('CA-4 · un override vacío o de espacios cuenta como no declarado', () => {
    const env = { [ENV_DIR]: '   ' };
    const r = ensureTestRunDir({ env, registrarLimpieza: false });
    assert.strictEqual(r.creado, true);
    assert.ok(esDirEfimero(env[ENV_DIR]));
    r.limpiar();
});

test('CA-4 · un dir por corrida: dos llamadas sobre el MISMO env devuelven el mismo dir (la segunda lo ve declarado)', () => {
    const env = {};
    const a = ensureTestRunDir({ env, registrarLimpieza: false });
    const b = ensureTestRunDir({ env, registrarLimpieza: false });
    assert.strictEqual(b.creado, false);
    assert.strictEqual(b.dir, a.dir);
    a.limpiar();
});

test('CA-4 · el dir efímero resuelve a pruebas con dir válido en el resolvedor (el escritor no falla ruidoso)', () => {
    const env = { NODE_TEST_CONTEXT: '1' };
    const r = ensureTestRunDir({ env, registrarLimpieza: false });
    const amb = require('../pipeline-env').resolve(env);
    assert.strictEqual(amb.modo, 'pruebas');
    assert.strictEqual(amb.dir, r.dir);
    const writeTarget = require('../write-target');
    assert.strictEqual(writeTarget.writeDir(env, { canal: 'estado' }), r.dir);
    r.limpiar();
});

test('CA-4 · el borrado se cuelga del exit del proceso: tras salir, el dir no existe (proceso hijo real)', () => {
    const { spawnSync } = require('child_process');
    const script = `
        const { ensureTestRunDir } = require(${JSON.stringify(path.join(__dirname, '..', 'test-run-dir.js'))});
        const r = ensureTestRunDir({ env: process.env });
        process.stdout.write(r.dir);
        process.exitCode = 3; // termina con fallo: igual borra
    `;
    const env = { ...process.env };
    delete env[ENV_DIR];
    delete env.NODE_TEST_CONTEXT;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env, windowsHide: true });
    const dir = out.stdout.trim();
    assert.ok(esDirEfimero(dir), `dir efímero reportado: ${dir}`);
    assert.strictEqual(out.status, 3);
    assert.ok(!fs.existsSync(dir), 'el dir no existe tras salir el proceso');
});

test('esDirEfimero · sólo reconoce dirs bajo os.tmpdir() con el prefijo del helper', () => {
    assert.strictEqual(esDirEfimero(path.join(os.tmpdir(), PREFIJO_TMP + 'abc')), true);
    assert.strictEqual(esDirEfimero(path.join(os.tmpdir(), 'otro-abc')), false);
    assert.strictEqual(esDirEfimero(path.join(__dirname, '..', '..', 'tmp', PREFIJO_TMP + 'abc')), false);
    assert.strictEqual(esDirEfimero(''), false);
    assert.strictEqual(esDirEfimero(null), false);
});

// =============================================================================
// ensure-npm-in-path.test.js — cobertura del helper npm-en-PATH (rebote #4732)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    ensureNpmInEnv,
    ensureNpmInProcessPath,
    npmWorks,
} = require('../ensure-npm-in-path');

const NODE_BIN_DIR = path.dirname(process.execPath);

test('ensureNpmInEnv prepende el dir de node al PATH cuando npm no resuelve', () => {
    // PATH deliberadamente sin el dir de node → npm no resuelve.
    const env = { PATH: 'C:\\Windows\\system32' };
    const out = ensureNpmInEnv(env);
    assert.equal(out, env, 'debe mutar y devolver el mismo objeto');
    assert.ok(
        out.PATH.startsWith(`${NODE_BIN_DIR}${path.delimiter}`),
        `PATH debe arrancar con el dir de node; got: ${out.PATH}`
    );
    // El PATH previo se conserva a continuación (solo prepende).
    assert.ok(out.PATH.includes('C:\\Windows\\system32'));
});

test('ensureNpmInEnv es no-op si npm ya resuelve con el env actual', () => {
    // El env del proceso ya tiene npm accesible en este runner.
    if (!npmWorks(process.env)) {
        // Entorno sin npm en PATH: forzamos uno que sí resuelve.
        const seeded = { ...process.env, PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH || ''}` };
        const before = seeded.PATH;
        ensureNpmInEnv(seeded);
        assert.equal(seeded.PATH, before, 'no debe mutar si npm ya resuelve');
        return;
    }
    const env = { ...process.env };
    const before = env.PATH;
    ensureNpmInEnv(env);
    assert.equal(env.PATH, before, 'no debe mutar el PATH si npm ya resuelve');
});

test('ensureNpmInEnv tolera env nulo/indefinido sin lanzar', () => {
    assert.equal(ensureNpmInEnv(null), null);
    assert.equal(ensureNpmInEnv(undefined), undefined);
});

test('npmWorks devuelve booleano', () => {
    assert.equal(typeof npmWorks(process.env), 'boolean');
});

test('ensureNpmInProcessPath deja npm resoluble en process.env', () => {
    ensureNpmInProcessPath();
    assert.ok(npmWorks(process.env), 'npm debe resolver tras ensureNpmInProcessPath');
});

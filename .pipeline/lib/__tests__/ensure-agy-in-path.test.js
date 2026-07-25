'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ensureAgyInEnv } = require('../ensure-agy-in-path');

test('provisiona AGY_BIN y PATH en el mismo proceso cuando agy está instalado', () => {
    const localAppData = path.join('C:', 'Users', 'pipeline', 'AppData', 'Local');
    const expectedBin = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    const calls = [];
    const env = { LOCALAPPDATA: localAppData, PATH: 'C:\\Windows\\System32' };

    const result = ensureAgyInEnv(env, {
        platform: 'win32',
        fsImpl: { existsSync: (candidate) => candidate === expectedBin },
        spawnImpl: (command, args, options) => {
            calls.push({ command, args, env: options.env });
            return { status: command === expectedBin ? 0 : 1 };
        },
    });

    assert.deepEqual(result, { available: true, bin: expectedBin });
    assert.equal(env.AGY_BIN, expectedBin);
    assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(expectedBin));
    assert.equal(calls.at(-1).command, expectedBin);
    assert.equal(calls.at(-1).env, env);
});

test('no duplica el directorio de agy en llamadas repetidas', () => {
    const bin = path.resolve('C:\\agy\\bin\\agy.exe');
    const env = { AGY_BIN: bin, PATH: path.dirname(bin) };
    const options = {
        fsImpl: { existsSync: () => true },
        spawnImpl: () => ({ status: 0 }),
    };

    ensureAgyInEnv(env, options);
    ensureAgyInEnv(env, options);

    assert.equal(env.PATH.split(path.delimiter).filter(Boolean).length, 1);
});

test('conserva la clave Path original de Windows al refrescar el entorno', () => {
    const bin = path.join('C:', 'Users', 'pipeline', 'agy', 'bin', 'agy.exe');
    const env = { AGY_BIN: bin, Path: 'C:\\Windows\\System32' };
    let attempts = 0;

    const result = ensureAgyInEnv(env, {
        platform: 'win32',
        fsImpl: { existsSync: () => true },
        spawnImpl: () => ({ status: attempts++ === 0 ? 1 : 0 }),
    });

    assert.equal(result.available, true);
    assert.equal(env.Path.split(path.delimiter)[0], path.dirname(bin));
    assert.equal(Object.hasOwn(env, 'PATH'), false);
});

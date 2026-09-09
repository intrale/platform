// =============================================================================
// git-spawn-maxbuffer-5215.test.js — #5215
//
// `spawnSync` usa 1 MB de `maxBuffer` por default. `git ls-files` sobre este
// repo (>20.000 archivos) lo supera y aborta con ENOBUFS. El consumidor
// afectado era el censo de secretos (`secrets-census.js`), que degradaba a
// "-1" ("no medido") sin que nadie lo notara: un control que reporta verde
// sobre un estado que ni siquiera pudo medir suprime la atención.
//
// Estos casos fijan el contrato del wrapper compartido:
//   - `gitSpawn` pasa un `maxBuffer` explícito > 1 MB.
//   - Subirlo es estrictamente permisivo: ninguna otra opción de spawn cambia.
//   - Un ENOBUFS del spawn se sigue propagando como error (no se traga acá).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gitSpawn, MAX_GIT_BUFFER_BYTES } = require('../worktree-resolver');

/** Captura las opciones con las que `gitSpawn` invoca al spawn inyectado. */
function capturarOpciones(args, respuesta = { status: 0, stdout: '', stderr: '' }) {
    let recibidas = null;
    gitSpawn(args, {
        cwd: '/fake/repo',
        spawnImpl: (_cmd, _args, opts) => {
            recibidas = opts;
            return respuesta;
        },
    });
    return recibidas;
}

test('#5215 — gitSpawn pasa un maxBuffer explícito por encima del default de 1 MB', () => {
    const opts = capturarOpciones(['ls-files']);

    assert.ok(opts, 'el spawnImpl inyectado debe recibir el objeto de opciones');
    assert.equal(typeof opts.maxBuffer, 'number');
    assert.ok(
        opts.maxBuffer > 1024 * 1024,
        `maxBuffer debe superar el default de 1 MB, recibido ${opts.maxBuffer}`,
    );
    assert.equal(opts.maxBuffer, MAX_GIT_BUFFER_BYTES);
});

test('#5215 — subir maxBuffer no altera las otras opciones de spawn (cambio permisivo)', () => {
    const opts = capturarOpciones(['status', '--porcelain']);

    assert.equal(opts.shell, false, 'sin shell: defense-in-depth contra injection');
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.encoding, 'utf8');
    assert.equal(opts.cwd, '/fake/repo');
    assert.equal(typeof opts.timeout, 'number');
});

test('#5215 — un ENOBUFS del spawn se propaga como error, no se degrada en silencio', () => {
    assert.throws(
        () => gitSpawn(['ls-files'], {
            cwd: '/fake/repo',
            spawnImpl: () => {
                const err = new Error('spawnSync git ENOBUFS');
                err.code = 'ENOBUFS';
                return { error: err };
            },
        }),
        /ENOBUFS/,
    );
});

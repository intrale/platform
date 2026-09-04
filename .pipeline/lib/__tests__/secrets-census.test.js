// Tests de `.pipeline/lib/secrets-census.js` (#5245).
//
// Todo con `spawnImpl` / `fsImpl` inyectados: el censo NO depende del árbol real
// (si dependiera, el test cambiaría de resultado cada vez que alguien agrega un
// lector, que es justamente lo que el censo tiene que detectar en runtime).

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const census = require('../secrets-census');

const CWD = '/fake/repo';

function makeSpawn(files) {
    return () => ({ status: 0, stdout: files.join('\n'), stderr: '' });
}

function makeFs(sources) {
    const store = new Map(
        Object.entries(sources).map(([rel, src]) => [path.resolve(CWD, rel), src]),
    );
    return {
        readFileSync(p) {
            const key = path.resolve(p);
            if (!store.has(key)) {
                const err = new Error(`ENOENT: ${p}`);
                err.code = 'ENOENT';
                throw err;
            }
            return store.get(key);
        },
    };
}

const LECTOR_DIRECTO = 'const c = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json")));';
const INSTRUMENTADO = 'const { loadTelegramSecrets } = require("../../.pipeline/lib/telegram-secrets");\n'
    + 'const c = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json")));';
const VIA_CLIENTE = 'const tg = require("./telegram-client");\n'
    + 'const raw = fs.readFileSync("telegram-config.json");';
const NO_LEE = 'const p = path.join(HOOKS_DIR, "telegram-config.json"); // sólo arma el path';
const NADA_QUE_VER = 'console.log("hola");';

describe('countUninstrumentedReaders', () => {
    it('cuenta sólo los lectores directos no instrumentados', () => {
        const files = ['a.js', 'b.cjs', 'c.mjs', 'd.js', 'e.js', 'f.js'];
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(files),
            fsImpl: makeFs({
                'a.js': LECTOR_DIRECTO,   // cuenta
                'b.cjs': LECTOR_DIRECTO,  // cuenta
                'c.mjs': INSTRUMENTADO,   // no cuenta: pasa por el chokepoint
                'd.js': VIA_CLIENTE,      // no cuenta: pasa por telegram-client
                'e.js': NO_LEE,           // no cuenta: menciona pero no lee
                'f.js': NADA_QUE_VER,     // no cuenta
            }),
        });
        assert.equal(n, 2);
    });

    it('ignora archivos que no son código', () => {
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(['README.md', 'config.json', 'x.ps1', 'y.sh']),
            fsImpl: makeFs({}),
        });
        assert.equal(n, 0);
    });

    it('un archivo trackeado pero ausente del working tree no rompe el censo', () => {
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(['fantasma.js', 'a.js']),
            fsImpl: makeFs({ 'a.js': LECTOR_DIRECTO }),
        });
        assert.equal(n, 1);
    });

    it('devuelve un número, nunca paths (el resultado viaja al JSON de salud)', () => {
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(['a.js']),
            fsImpl: makeFs({ 'a.js': LECTOR_DIRECTO }),
        });
        assert.equal(typeof n, 'number');
    });

    it('si `git ls-files` falla devuelve -1 (no medido), nunca 0', () => {
        // Un 0 acá sería catastrófico: es el valor que autoriza a encender
        // strict. "No pude medir" no puede parecerse a "no queda nada".
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: () => { throw new Error('git no está en el PATH'); },
            fsImpl: makeFs({}),
        });
        assert.equal(n, -1);
    });
});

describe('listTrackedCodeFiles', () => {
    it('filtra por extensión de código y descarta líneas vacías', () => {
        const files = census.listTrackedCodeFiles({
            cwd: CWD,
            spawnImpl: makeSpawn(['a.js', '', 'b.md', 'c.mjs', 'd.cjs', 'e.kt']),
        });
        assert.deepEqual(files, ['a.js', 'c.mjs', 'd.cjs']);
    });
});

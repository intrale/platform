// =============================================================================
// secrets-census-medicion-5215.test.js — #5215
//
// El censo distingue tres estados que antes se confundían:
//   - medido en N       → `{ count: N, measured: true }`, exit 0
//   - medido en cero    → `{ count: 0, measured: true }`, exit 0  (autoriza el corte)
//   - NO medido         → `{ count: -1, measured: false, error }`, exit != 0
//
// Antes de #5215 el tercer caso salía por stdout como "-1" con exit code 0 y sin
// una sola línea de diagnóstico. Un script de rollout que sólo mira el exit code
// podía encender `PIPELINE_SECRETS_GUARD_STRICT` sobre una base sin medir.
// =============================================================================
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const census = require('../secrets-census');

const CLI_PATH = path.resolve(__dirname, '..', 'secrets-census.js');
const CWD = '/fake/repo';

function makeSpawn(files) {
    return () => ({ status: 0, stdout: files.join('\n'), stderr: '' });
}

function spawnEnobufs() {
    return () => {
        const err = new Error('spawnSync git ENOBUFS');
        err.code = 'ENOBUFS';
        return { error: err };
    };
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

const LECTOR_DIRECTO = 'const c = JSON.parse(fs.readFileSync(path.join(D, "telegram-config.json")));';
const INSTRUMENTADO = 'const { loadTelegramSecrets } = require("../../.pipeline/lib/telegram-secrets");\n'
    + 'const c = JSON.parse(fs.readFileSync(path.join(D, "telegram-config.json")));';
const NADA_QUE_VER = 'console.log("hola");';

describe('#5215 — un censo no medido dice por qué no midió', () => {
    it('un ENOBUFS de `git ls-files` deja el conteo en -1', () => {
        const n = census.countUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: spawnEnobufs(),
            fsImpl: makeFs({}),
            onError: () => {},
        });
        assert.equal(n, -1);
    });

    it('measureUninstrumentedReaders separa "no medido" de "medido en cero"', () => {
        const fallo = census.measureUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: spawnEnobufs(),
            fsImpl: makeFs({}),
            onError: () => {},
        });
        assert.equal(fallo.measured, false);
        assert.equal(fallo.count, -1);
        assert.match(fallo.error, /ENOBUFS/);

        const cero = census.measureUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(['a.js']),
            fsImpl: makeFs({ 'a.js': NADA_QUE_VER }),
        });
        assert.equal(cero.measured, true);
        assert.equal(cero.count, 0);
        assert.equal(cero.error, null);
    });

    it('la causa del fallo viaja al reporter en vez de degradarse en silencio', () => {
        const reportado = [];
        census.measureUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: spawnEnobufs(),
            fsImpl: makeFs({}),
            onError: (msg) => reportado.push(msg),
        });
        assert.equal(reportado.length, 1);
        assert.match(reportado[0], /NO MEDIDO/);
        assert.match(reportado[0], /ENOBUFS/);
    });

    it('con una lista de archivos el conteo sigue siendo el esperado', () => {
        const medicion = census.measureUninstrumentedReaders({
            cwd: CWD,
            spawnImpl: makeSpawn(['a.js', 'b.cjs', 'c.mjs', 'd.md']),
            fsImpl: makeFs({
                'a.js': LECTOR_DIRECTO,    // cuenta
                'b.cjs': LECTOR_DIRECTO,   // cuenta
                'c.mjs': INSTRUMENTADO,    // no cuenta: pasa por el chokepoint
            }),
        });
        assert.deepEqual(medicion, { count: 2, measured: true, error: null });
    });
});

describe('#5215 — exit code del CLI', () => {
    it('mide de verdad sobre el repo real y sale con código 0', () => {
        // Sin el `maxBuffer` explícito de `gitSpawn` este caso falla: `git
        // ls-files` sobre el repo real supera el default de 1 MB de spawnSync.
        const out = execFileSync(process.execPath, [CLI_PATH], { encoding: 'utf8' });
        const primeraLinea = out.trim().split(/\r?\n/)[0];
        const n = Number(primeraLinea);
        assert.ok(Number.isInteger(n), `el CLI debe imprimir un entero, imprimió "${primeraLinea}"`);
        assert.ok(n >= 0, `el censo quedó NO MEDIDO (${n}) sobre el repo real`);
    });

    it('un censo no medido sale con código != 0 y no puede autorizar el corte', () => {
        // Se fuerza el fallo con un `GIT_DIR` inexistente: `git ls-files` aborta
        // aunque el `cwd` del censo (siempre `REPO_ROOT`) sea un repo válido, y
        // el censo se queda sin denominador.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-5215-'));
        let status = 0;
        let stdout = '';
        let stderr = '';
        try {
            stdout = execFileSync(process.execPath, [CLI_PATH], {
                encoding: 'utf8',
                cwd: tmp,
                env: {
                    ...process.env,
                    GIT_CEILING_DIRECTORIES: tmp,
                    GIT_DIR: path.join(tmp, 'no-existe'),
                },
            });
        } catch (e) {
            status = e.status;
            stdout = String(e.stdout || '');
            stderr = String(e.stderr || '');
        }

        assert.notEqual(status, 0, 'un censo no medido nunca puede salir con código 0');
        assert.match(stdout.trim().split(/\r?\n/)[0], /^-1$/);
        assert.match(stderr, /NO MEDIDO|medicion fallo/);
    });
});

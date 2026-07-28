// =============================================================================
// operational-state-concurrency.test.js — Dos (y N) escritores concurrentes en
// PROCESOS REALES sobre la fachada de estado operativo (#5108).
//
// Escenario Gherkin del issue:
//   Dado que dos procesos actualizan el estado de issues distintos a la vez
//   Cuando ambos escriben mediante el envoltorio
//   Entonces el archivo resultante es válido
//   Y ninguna de las dos actualizaciones se pierde
//
// Por qué fork y no dos llamadas in-process
// -----------------------------------------
// `waves.js` cachea las lecturas 2s por proceso. Dos mutaciones dentro del mismo
// proceso comparten esa caché y el lock reentrante, así que pasarían en verde
// AUNQUE hubiera lost update: el test sería un falso positivo. Forkeando dos
// procesos reales con el mismo `PIPELINE_DIR_OVERRIDE` se ejercita el lock de
// archivo de verdad. El harness invalida la caché antes de asertar.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/operational-state-concurrency.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'operational-state-concurrency-worker.js');

function setupTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-conc-test-'));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeBaseState(dir) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: {
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by: 'test',
            source: 'fixture',
            next_wave_number: 2,
        },
        active_wave: {
            number: 1,
            name: 'Ola concurrente',
            started_at: '2026-07-01T00:00:00.000Z',
            issues: [],
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, null, 2));
}

function forkWorker({ dir, mode, issue, wave = 1, id }) {
    return new Promise((resolve) => {
        const child = fork(WORKER_SCRIPT, [], {
            env: {
                ...process.env,
                PIPELINE_DIR_OVERRIDE: dir,
                WORKER_MODE: mode,
                WORKER_ISSUE: String(issue),
                WORKER_WAVE: String(wave),
                WORKER_ID: id,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => resolve({ code, stderr, id, issue }));
    });
}

// Se re-requiere con el override puesto para leer el resultado por la fachada.
function loadFacade(dir) {
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    for (const m of ['../operational-state', '../waves', '../partial-pause']) {
        delete require.cache[require.resolve(m)];
    }
    const opState = require('../operational-state');
    opState._internal.invalidateCache();
    return opState;
}

// -----------------------------------------------------------------------------

test('Gherkin: dos escritores concurrentes en procesos reales no pierden actualizaciones', async () => {
    const dir = setupTmp();
    try {
        writeBaseState(dir);

        const [a, b] = await Promise.all([
            forkWorker({ dir, mode: 'wave', issue: 5108, id: 'w-a' }),
            forkWorker({ dir, mode: 'wave', issue: 5109, id: 'w-b' }),
        ]);

        assert.equal(a.code, 0, `worker A falló: ${a.stderr}`);
        assert.equal(b.code, 0, `worker B falló: ${b.stderr}`);

        // (1) El archivo resultante es válido — parseable y con shape correcto.
        const wavesFile = path.join(dir, 'waves.json');
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(fs.readFileSync(wavesFile, 'utf8')); },
            'el JSON final debe ser parseable');

        const opState = loadFacade(dir);
        assert.doesNotThrow(() => opState.getActiveWave(),
            'la lectura estricta por la fachada debe validar el estado final');

        // (2) Ninguna de las dos actualizaciones se perdió.
        const numeros = opState.getActiveWave().issues.map((i) => i.number).sort((x, y) => x - y);
        assert.deepEqual(numeros, [5108, 5109],
            'ambas actualizaciones deben estar presentes (lost update si falta alguna)');

        // (3) Sin artefactos residuales de la transacción.
        assert.equal(fs.existsSync(`${wavesFile}.tmp`), false, 'tmp residual');
        assert.equal(fs.existsSync(`${wavesFile}.lock`), false, 'lock residual');

        void parsed;
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        rmrf(dir);
    }
});

test('N=8 escritores concurrentes sobre el registro de olas: sin duplicados ni pérdidas', async () => {
    const dir = setupTmp();
    try {
        writeBaseState(dir);

        const N = 8;
        const esperados = Array.from({ length: N }, (_, i) => 6100 + i);
        const results = await Promise.all(
            esperados.map((issue, i) => forkWorker({ dir, mode: 'wave', issue, id: `w${i}` })),
        );

        const fallidos = results.filter((r) => r.code !== 0);
        assert.equal(fallidos.length, 0,
            `todos los workers deben cerrar OK: ${fallidos.map((f) => f.stderr).join(' | ')}`);

        const opState = loadFacade(dir);
        const numeros = opState.getActiveWave().issues.map((i) => i.number).sort((x, y) => x - y);

        assert.deepEqual(numeros, esperados, 'los N issues están, una sola vez cada uno');
        assert.equal(new Set(numeros).size, numeros.length, 'sin duplicados');
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        rmrf(dir);
    }
});

test('dos escritores concurrentes de la allowlist efectiva no se pisan entre sí', async () => {
    const dir = setupTmp();
    try {
        const [a, b] = await Promise.all([
            forkWorker({ dir, mode: 'allowlist', issue: 5108, id: 'al-a' }),
            forkWorker({ dir, mode: 'allowlist', issue: 5109, id: 'al-b' }),
        ]);

        assert.equal(a.code, 0, `worker A falló: ${a.stderr}`);
        assert.equal(b.code, 0, `worker B falló: ${b.stderr}`);

        const opState = loadFacade(dir);
        const state = opState.getDispatchState();

        assert.equal(state.mode, 'partial_pause');
        assert.deepEqual(state.allowedIssues, [5108, 5109],
            'el read-modify-write de addToAllowlist corre bajo el lock del marker: ' +
            'ninguno de los dos adds se pierde');

        const marker = opState._internal.paths().PARTIAL_FILE;
        assert.equal(fs.existsSync(`${marker}.tmp`), false, 'tmp residual');
        assert.equal(fs.existsSync(`${marker}.lock`), false, 'lock residual');
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        rmrf(dir);
    }
});

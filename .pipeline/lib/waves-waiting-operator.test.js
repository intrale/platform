'use strict';

// =============================================================================
// waves-waiting-operator.test.js — Estado `waiting-operator` a nivel ola (#4578).
// Framework: node --test.
//
// #6258 — hermeticidad. Antes este archivo seteaba `PIPELINE_DIR_OVERRIDE` de
// forma cruda y no lo restauraba nunca. Dos consecuencias:
//   * el entorno quedaba sucio para lo que corriera despues en el mismo proceso;
//   * el override se resolvia POR LLAMADA (`waves.js:pipelineDir()`), asi que
//     cualquier mutacion hecha fuera de la ventana del override iba a parar al
//     `.pipeline/` REAL (R-1: pisar el `waves.json` operativo con write atomico).
// Ahora el override cubre el CUERPO COMPLETO de cada test via `withWavesInDir`,
// y una guarda sobre `fs` aborta cualquier escritura fuera del tmpdir.
// =============================================================================

const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const { withEnv } = require('./test-helpers/with-env');

const WAVES_MODULE = require.resolve('./waves');
// CA-6258-15: se compara contra el estado INICIAL, no contra "ausente" a secas,
// para no dar un falso verde si el entorno ya traia la variable.
const OVERRIDE_INICIAL = process.env.PIPELINE_DIR_OVERRIDE;

// -----------------------------------------------------------------------------
// Guarda anti-escritura-en-produccion (CA-6258-17 · H-1 opcion A).
//
// El punto de estrangulamiento es `fs`, no la carga del modulo: la carga es
// inocua y las mutaciones (`setWaveWaitingOperator`, ...) ocurren DESPUES. Se
// parchean las syscalls del inventario real de una mutacion, con el indice del
// argumento que lleva el path de DESTINO en cada una.
//
// Nota de alcance: este bloque esta duplicado en `waves-stalled.test.js` a
// proposito — D-6258-1 congela el alcance de #6258 en 5 archivos y no admite un
// helper nuevo. La generalizacion a toda la suite es #6263.
// -----------------------------------------------------------------------------

const FS_WRITE_GUARD = {
    writeFileSync: [0],
    appendFileSync: [0],
    mkdirSync: [0],
    unlinkSync: [0],
    rmSync: [0],
    openSync: [0],
    copyFileSync: [1],   // el destino es el segundo argumento
    renameSync: [0, 1],  // origen Y destino
};

// Windows devuelve el short path (`C:\Users\ADMINI~1\...`) en `os.tmpdir()`;
// comparar sin normalizar da falsos negativos.
const REAL_TMPDIR = fs.realpathSync(os.tmpdir());

let fsOriginals = null;
let fsEscapes = [];

/** Resuelve un path a su forma real, subiendo hasta el ancestro que exista. */
function realResolve(p) {
    const abs = path.resolve(p);
    let probe = abs;
    const sufijo = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(probe), ...sufijo);
        } catch {
            const padre = path.dirname(probe);
            if (padre === probe) return abs;   // llegamos a la raiz sin encontrar nada
            sufijo.unshift(path.basename(probe));
            probe = padre;
        }
    }
}

function toPathString(p) {
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString();
    if (p instanceof URL) return fileURLToPath(p);
    return null;   // fd numerico u otro shape: no es un path que auditar
}

function estaDentroDelTmpdir(p) {
    const s = toPathString(p);
    if (s === null) return true;
    const rel = path.relative(REAL_TMPDIR, realResolve(s));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** V-2: `openSync` es tambien el camino de LECTURA; solo interesa la escritura. */
function esAperturaDeEscritura(flags) {
    if (flags === undefined || flags === null) return false;   // default 'r'
    if (typeof flags === 'number') {
        const W = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT;
        return (flags & W) !== 0;
    }
    return /[wa+]/.test(String(flags));
}

function installFsGuard() {
    fsOriginals = {};
    for (const [metodo, indices] of Object.entries(FS_WRITE_GUARD)) {
        const original = fs[metodo];
        fsOriginals[metodo] = original;
        fs[metodo] = function guarded(...args) {
            if (metodo !== 'openSync' || esAperturaDeEscritura(args[1])) {
                for (const i of indices) {
                    if (args.length <= i) continue;
                    if (estaDentroDelTmpdir(args[i])) continue;
                    const detalle = `fs.${metodo} escribio FUERA del tmpdir: ${toPathString(args[i])}`;
                    // Se registra ADEMAS de tirar, por si produccion se traga la excepcion.
                    fsEscapes.push(detalle);
                    throw new Error(`[guarda-fs #6258] ${detalle}`);
                }
            }
            return original.apply(this, args);
        };
    }
}

function restoreFsGuard() {
    if (!fsOriginals) return;
    for (const [metodo, original] of Object.entries(fsOriginals)) fs[metodo] = original;
    fsOriginals = null;
}

/** Devuelve y limpia los escapes registrados (lo usa la prueba activa). */
function drainFsEscapes() {
    const out = fsEscapes;
    fsEscapes = [];
    return out;
}

before(() => {
    // Precondicion de la guarda: si `os.tmpdir()` no fuese resoluble, todo path
    // quedaria "fuera" y la suite fallaria por el andamiaje, no por el codigo.
    assert.ok(path.isAbsolute(REAL_TMPDIR), 'REAL_TMPDIR debe ser un path absoluto');
});

beforeEach(() => {
    fsEscapes = [];
    installFsGuard();
});

afterEach(() => {
    restoreFsGuard();
    const escapes = drainFsEscapes();
    assert.deepStrictEqual(escapes, [], `escrituras fuera del tmpdir: ${escapes.join(' | ')}`);
});

after(() => {
    // CA-6258-15 — el archivo no deja el entorno modificado...
    assert.strictEqual(
        process.env.PIPELINE_DIR_OVERRIDE, OVERRIDE_INICIAL,
        'PIPELINE_DIR_OVERRIDE quedo modificado al terminar el archivo',
    );
    assert.strictEqual(
        'PIPELINE_DIR_OVERRIDE' in process.env, OVERRIDE_INICIAL !== undefined,
        'si no estaba seteada al arrancar debe quedar BORRADA, no como string vacio',
    );
    // ...ni el require.cache sucio apuntando a un tmpdir que ya no existe (H-6).
    assert.strictEqual(require.cache[WAVES_MODULE], undefined, 'require.cache de ./waves quedo sucio');
});

// -----------------------------------------------------------------------------
// Sandbox
// -----------------------------------------------------------------------------

function seedWaves(activeWave) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-wo-'));
    const seed = {
        version: '1.0',
        meta: {
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            updated_by: 'System',
            source: 'test',
            next_wave_number: 3,
        },
        active_wave: activeWave,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(seed));
    return dir;
}

/**
 * Corre `fn` con `PIPELINE_DIR_OVERRIDE` apuntando a `dir` durante TODO el
 * cuerpo del test (R-1: `waves.js:pipelineDir()` lo resuelve por llamada, y las
 * mutaciones ocurren despues de la carga).
 *
 * D-6258-3 / CA-6258-16: `fn` recibe `load`, no un modulo ya cargado. Asi los
 * tests de "sobrevive una relectura desde disco" pueden pedir N cargas FRESCAS,
 * todas bajo el mismo override, sin degradarse a una sola.
 */
function withWavesInDir(dir, fn) {
    return withEnv({ PIPELINE_DIR_OVERRIDE: dir }, () => {
        const load = () => {
            delete require.cache[WAVES_MODULE];
            const w = require('./waves');
            w.invalidateCache();
            return w;
        };
        try {
            return fn(load);
        } finally {
            delete require.cache[WAVES_MODULE];   // H-6: no dejar cache sucio
        }
    });
}

// -----------------------------------------------------------------------------
// Prueba ACTIVA de la guarda (CA-6258-17 / D-6258-9): una guarda que nunca se ve
// fallar no es evidencia de nada.
// -----------------------------------------------------------------------------

test('la guarda fs aborta una escritura fuera del tmpdir (prueba activa)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-wo-guard-'));
    const dentro = path.join(dir, 'ok.txt');
    const fuera = path.join(__dirname, '..', 'NO-DEBE-EXISTIR-6258-wo.tmp');
    const fueraDir = path.join(__dirname, '..', 'NO-DEBE-EXISTIR-6258-wo-dir');

    // Escribir DENTRO del tmpdir no dispara nada.
    assert.doesNotThrow(() => fs.writeFileSync(dentro, 'ok'));

    // ...fuera si, en las 8 syscalls del inventario y en el argumento correcto
    // de cada una. Se cubre `renameSync` por origen Y por destino.
    const intentos = [
        () => fs.writeFileSync(fuera, 'x'),
        () => fs.appendFileSync(fuera, 'x'),
        () => fs.mkdirSync(fueraDir),
        () => fs.unlinkSync(fuera),
        () => fs.rmSync(fuera, { force: true }),
        () => fs.openSync(fuera, 'w'),
        () => fs.copyFileSync(dentro, fuera),   // destino = arg 1
        () => fs.renameSync(dentro, fuera),     // destino = arg 1
        () => fs.renameSync(fuera, dentro),     // origen  = arg 0
    ];
    for (const intento of intentos) assert.throws(intento, /guarda-fs #6258/);

    // V-2: `openSync` en modo LECTURA fuera del tmpdir no es una escritura y no
    // debe reportarse como tal (si no, el mensaje se leeria al reves de lo que es).
    const fd = fs.openSync(__filename, 'r');
    fs.closeSync(fd);

    assert.strictEqual(fs.existsSync(fuera), false, 'la guarda debe abortar ANTES de escribir');
    assert.strictEqual(fs.existsSync(fueraDir), false, 'la guarda debe abortar ANTES de crear el dir');

    // Consumir los escapes registrados: son esperados en esta prueba. Se verifica
    // que las 8 syscalls guardadas quedaron efectivamente ejercitadas.
    const escapes = drainFsEscapes();
    assert.strictEqual(escapes.length, intentos.length, `escapes registrados: ${escapes.length}`);
    const metodosVistos = new Set(escapes.map((e) => e.match(/^fs\.(\w+)/)[1]));
    assert.deepStrictEqual(
        [...metodosVistos].sort(), Object.keys(FS_WRITE_GUARD).sort(),
        'la prueba activa debe ejercitar las 8 syscalls guardadas',
    );
});

// -----------------------------------------------------------------------------
// Tests de estado `waiting_operator`
// -----------------------------------------------------------------------------

test('setWaveWaitingOperator retiene la ola activa con shape estructurado', () => withWavesInDir(
    seedWaves({ number: 2, name: 'Ola 2', issues: [{ number: 1, status: 'completed' }] }),
    (load) => {
        const w = load();
        assert.strictEqual(w.isWaveWaitingOperator(), false);
        const wo = w.setWaveWaitingOperator(2, {
            reason: 'incoherencia dashboard vs consola',
            evidenceRef: 'wave-evidence/x.md',
            conflictsCount: 2,
            updated_by: 'kernel',
        });
        assert.strictEqual(wo.reason, 'incoherencia dashboard vs consola');
        assert.strictEqual(wo.evidence_ref, 'wave-evidence/x.md');
        assert.strictEqual(wo.conflicts_count, 2);
        assert.ok(Number.isFinite(Date.parse(wo.since)));
        assert.strictEqual(w.isWaveWaitingOperator(), true);
        assert.deepStrictEqual(w.getWaveWaitingOperator(), wo);
    },
));

test('el estado waiting_operator sobrevive una relectura desde disco', () => withWavesInDir(
    seedWaves({ number: 5, issues: [] }),
    (load) => {
        const w = load();
        w.setWaveWaitingOperator(5, { reason: 'x', conflictsCount: 1 });
        // CA-6258-16: SEGUNDA carga fresca desde disco, con el override vigente.
        // Es la carga la que constituye el aserto; no se degrada a reusar `w`.
        const w2 = load();
        assert.notStrictEqual(w2, w, 'debe ser una instancia NUEVA del modulo, no la cacheada');
        assert.strictEqual(w2.isWaveWaitingOperator(), true);
        assert.strictEqual(w2.getWaveWaitingOperator().conflicts_count, 1);
    },
));

test('clearWaveWaitingOperator remueve la retención', () => withWavesInDir(
    seedWaves({ number: 2, issues: [] }),
    (load) => {
        const w = load();
        w.setWaveWaitingOperator(2, { reason: 'x' });
        assert.strictEqual(w.clearWaveWaitingOperator(2, { updated_by: 'operator' }), true);
        assert.strictEqual(w.isWaveWaitingOperator(), false);
        // Segundo clear sin estado → false (idempotente).
        assert.strictEqual(w.clearWaveWaitingOperator(2), false);
    },
));

test('setWaveWaitingOperator rechaza una ola que no es la activa', () => withWavesInDir(
    seedWaves({ number: 2, issues: [] }),
    (load) => {
        const w = load();
        assert.throws(() => w.setWaveWaitingOperator(99, {}), /no es la activa/);
    },
));

test('setWaveWaitingOperator sin ola activa lanza', () => withWavesInDir(
    seedWaves(null),
    (load) => {
        const w = load();
        assert.throws(() => w.setWaveWaitingOperator(2, {}), /no es la activa/);
        assert.strictEqual(w.isWaveWaitingOperator(), false);
    },
));

test('validateStateStrict rechaza un waiting_operator con shape inválido', () => withWavesInDir(
    seedWaves({ number: 2, issues: [] }),
    (load) => {
        const w = load();
        const bad = {
            version: '1.0',
            meta: { updated_at: '2026-01-01T00:00:00Z' },
            active_wave: { number: 2, waiting_operator: { since: 'no-es-fecha', conflicts_count: -1 } },
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        };
        const errors = w.validateStateStrict(bad, { source: 'test' });
        assert.ok(errors.some((e) => /waiting_operator.since/.test(e)));
        assert.ok(errors.some((e) => /waiting_operator.conflicts_count/.test(e)));
    },
));

test('validateStateStrict acepta waiting_operator null/ausente', () => withWavesInDir(
    seedWaves({ number: 2, issues: [] }),
    (load) => {
        const w = load();
        const ok = {
            version: '1.0',
            meta: { updated_at: '2026-01-01T00:00:00Z' },
            active_wave: { number: 2, waiting_operator: null },
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        };
        assert.deepStrictEqual(w.validateStateStrict(ok, { source: 'test' }), []);
    },
));

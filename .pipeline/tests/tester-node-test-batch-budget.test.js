// =============================================================================
// El wall-clock de `node --test` es POR BATCH, no un total repartido (#5802)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Causa raíz del rebote #5802 (rev-1): la batería del pipeline llegó a 916
// archivos de test. Esa cantidad ya no entra en un solo `node --test <files...>`
// (límite de línea de comandos de Windows, #3953), así que `runNodeTests` la
// parte en 2 batches secuenciales. Medido en HEAD limpio, sin cambios propios:
//
//     BATCH 1  536 archivos  EXIT 0  553 s
//     BATCH 2  380 archivos  EXIT 0  255 s
//     TOTAL                          808 s   (0 fallos)
//
// El deadline era GLOBAL (`started + NODE_TEST_WALL_TIMEOUT_MS`, 720 s), así que
// el batch 2 arrancaba con ~160 s de presupuesto y moría a mitad. Resultado:
// `agg.valid = false`, `exit_code = 124` y el veredicto
// «node --test exit code 124 sin reporte JUnit parseable» con `tests = 0` —
// un rojo que no correspondía a un solo test roto.
//
// El batching es una consecuencia MECÁNICA del límite de cmdline, no una
// decisión de presupuesto: repartir un total fijo entre N batches hace que el
// timeout efectivo dependa del largo de los nombres de archivo. Por eso cada
// batch arranca con el presupuesto completo, y la protección anti-cuelgue de
// #3344 queda intacta (mismo kill por batch, mismo heartbeat).
//
// Estos tests ejercitan `runNodeTests` entero inyectando `files`, `spawnBatch` y
// `now`: cero spawns, cero esperas reales.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const tester = require('../skills-deterministicos/tester');
const {
  runNodeTests,
  buildNodeTestBatches,
  NODE_TEST_WALL_TIMEOUT_MS,
} = tester;

const REPO = os.tmpdir();

/** Summary JUnit válido, con la forma que devuelve `parseNodeTestJunit`. */
function summaryOk(tests) {
  return {
    valid: true, tests, failures: 0, errors: 0, skipped: 0,
    time_seconds: 1, suites: 1, failed_tests: [],
  };
}

/**
 * Genera N rutas relativas con el largo típico de las del pipeline, para que el
 * batching real (28000 chars de presupuesto de cmdline) se active como en
 * producción en vez de con un límite de juguete.
 */
function archivosSinteticos(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(path.join(REPO, '.pipeline', 'lib', '__tests__', `modulo-sintetico-numero-${String(i).padStart(4, '0')}.test.js`));
  }
  return out;
}

/**
 * Doble de `spawnNodeTestBatch`: consume `duracionesMs[i]` del reloj falso y
 * declara timeout si el presupuesto recibido no le alcanza — exactamente el
 * criterio del spawn real, que mata el child cuando se le agota `remainingMs`.
 */
function spawnBatchFalso({ duracionesMs, reloj }) {
  const vistos = [];
  const spawnBatch = async ({ batchFiles, remainingMs, batchLabel, reportFile }) => {
    const i = vistos.length;
    const duracion = duracionesMs[i];
    vistos.push({ batchLabel, remainingMs, archivos: batchFiles.length, reportFile });
    if (remainingMs <= 0 || duracion > remainingMs) {
      reloj.avanzar(Math.max(remainingMs, 0));
      return {
        exit_code: 124, timed_out: true, stdout: '', stderr: '',
        last_progress_line: `colgado en el batch ${batchLabel}`,
        summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0, time_seconds: 0, suites: 0, failed_tests: [] },
      };
    }
    reloj.avanzar(duracion);
    return {
      exit_code: 0, timed_out: false, stdout: `spec del batch ${batchLabel}\n`, stderr: '',
      last_progress_line: `ok ${batchLabel}`,
      summary: summaryOk(batchFiles.length),
    };
  };
  return { spawnBatch, vistos };
}

function relojFalso(inicio = 1_700_000_000_000) {
  let t = inicio;
  return { now: () => t, avanzar: (ms) => { t += ms; } };
}

// -----------------------------------------------------------------------------

test('#5802 · la bateria real del pipeline se parte en mas de un batch (la premisa del rebote)', () => {
  const archivos = archivosSinteticos(916);
  const batches = buildNodeTestBatches(archivos, REPO);
  assert.ok(batches.length >= 2,
    'con ~900 archivos el batching se activa: el escenario del rebote no es hipotetico');
  assert.equal(batches.reduce((acc, b) => acc + b.length, 0), 916, 'no se pierde ni se duplica ningun archivo');
});

test('#5802 · cada batch arranca con el presupuesto COMPLETO, no con el resto de un total global', async () => {
  const reloj = relojFalso();
  const archivos = archivosSinteticos(1400);
  const MAX_CMDLINE = 12_000;
  const totalBatches = buildNodeTestBatches(archivos, REPO, MAX_CMDLINE).length;
  assert.ok(totalBatches >= 3, 'el escenario necesita varios batches para tener sentido');

  // Cada batch tarda casi todo su presupuesto: juntos superan de sobra el
  // wall-clock, pero ninguno lo agota por sí solo. Es exactamente el caso que
  // el deadline global mataba.
  const duraciones = Array.from({ length: totalBatches }, () => NODE_TEST_WALL_TIMEOUT_MS - 60_000);
  const { spawnBatch, vistos } = spawnBatchFalso({ duracionesMs: duraciones, reloj });

  const res = await runNodeTests(REPO, {}, {
    files: archivos,
    spawnBatch,
    now: reloj.now,
    maxCmdline: MAX_CMDLINE,
  });

  assert.equal(vistos.length, totalBatches, 'corrieron TODOS los batches');
  for (const v of vistos) {
    assert.equal(v.remainingMs, NODE_TEST_WALL_TIMEOUT_MS,
      `el batch ${v.batchLabel} recibio el presupuesto completo`);
  }
  assert.equal(res.timed_out, false, 'ninguno se corto por tiempo');
  assert.equal(res.exit_code, 0);
  assert.equal(res.summary.valid, true, 'el JUnit agregado es parseable');
  assert.equal(res.summary.tests, 1400, 'el summary agrega TODOS los archivos de TODOS los batches');
  assert.ok(res.wall_ms > NODE_TEST_WALL_TIMEOUT_MS,
    'el total supera el presupuesto de un batch — que es justamente lo que antes lo mataba');
});

test('#5802 · el escenario medido del rebote (553 s + 255 s) ahora termina verde', async () => {
  const reloj = relojFalso();
  const { spawnBatch, vistos } = spawnBatchFalso({ duracionesMs: [553_000, 255_000], reloj });

  const res = await runNodeTests(REPO, {}, {
    files: archivosSinteticos(916),
    spawnBatch,
    now: reloj.now,
  });

  assert.equal(vistos.length, 2, 'los dos batches del escenario real');
  assert.equal(res.exit_code, 0, 'exit 0: ya no hay falso 124');
  assert.equal(res.timed_out, false);
  assert.equal(res.summary.valid, true, 'hay reporte JUnit parseable');
  assert.equal(res.summary.tests, 916);
  assert.equal(res.wall_ms, 808_000, 'el wall total sigue siendo el real (808 s), sin recortes');
});

test('#5802 · la proteccion anti-cuelgue de #3344 sigue viva: un batch colgado corta la secuencia y falla cerrado', async () => {
  const reloj = relojFalso();
  const archivos = archivosSinteticos(1400);
  const MAX_CMDLINE = 12_000;
  const totalBatches = buildNodeTestBatches(archivos, REPO, MAX_CMDLINE).length;

  // El segundo batch se cuelga por encima de SU propio presupuesto.
  const duraciones = Array.from({ length: totalBatches }, () => 10_000);
  duraciones[1] = NODE_TEST_WALL_TIMEOUT_MS + 1;
  const { spawnBatch, vistos } = spawnBatchFalso({ duracionesMs: duraciones, reloj });

  const res = await runNodeTests(REPO, {}, {
    files: archivos,
    spawnBatch,
    now: reloj.now,
    maxCmdline: MAX_CMDLINE,
  });

  assert.equal(res.timed_out, true, 'el cuelgue se detecta igual que antes');
  assert.equal(res.exit_code, 124, 'convencion POSIX de timeout');
  assert.equal(res.summary.valid, false, 'el agregado NO se declara valido: fail-closed');
  assert.equal(vistos.length, 2, 'la secuencia se corta en el batch colgado; no sigue con los que faltan');
  assert.equal(res.last_progress_line, `colgado en el batch 2/${totalBatches}`,
    'el heartbeat nombra el batch donde estaba el cuelgue');
});

test('#5802 · un batch que falla (tests en rojo) preserva el exit code y NO se confunde con un timeout', async () => {
  const reloj = relojFalso();
  const spawnBatch = async ({ batchFiles, batchLabel }) => {
    reloj.avanzar(1_000);
    if (batchLabel.startsWith('1/')) {
      return {
        exit_code: 1, timed_out: false, stdout: '', stderr: '',
        last_progress_line: 'not ok 1',
        summary: {
          valid: true, tests: batchFiles.length, failures: 1, errors: 0, skipped: 0,
          time_seconds: 1, suites: 1,
          failed_tests: [{ classname: 'x.test.js', name: 'un test rojo', time: 0, type: 'failure', message: '', stack_snippet: '' }],
        },
      };
    }
    return { exit_code: 0, timed_out: false, stdout: '', stderr: '', last_progress_line: 'ok', summary: summaryOk(batchFiles.length) };
  };

  const res = await runNodeTests(REPO, {}, {
    files: archivosSinteticos(1400),
    spawnBatch,
    now: reloj.now,
    maxCmdline: 12_000,
  });

  assert.equal(res.timed_out, false, 'un rojo no es un cuelgue');
  assert.equal(res.exit_code, 1, 'el primer exit code no-cero gana');
  assert.equal(res.summary.valid, true, 'el reporte es parseable: el veredicto sale de los tests, no del runner');
  assert.equal(res.summary.failures, 1);
  assert.equal(res.summary.failed_tests.length, 1);
});

test('#5802 · sin archivos de test el resultado es explicito y no inventa un timeout', async () => {
  const reloj = relojFalso();
  const res = await runNodeTests(REPO, {}, { files: [], now: reloj.now, spawnBatch: async () => { throw new Error('no deberia spawnear'); } });
  assert.equal(res.no_tests, true);
  assert.equal(res.exit_code, 0);
  assert.deepEqual(res.files, []);
  assert.equal(res.summary.valid, false, 'sin tests no hay reporte valido que reportar');
});

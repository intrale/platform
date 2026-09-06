// Tests del presupuesto de wall-clock de `node --test` y del motivo de rebote
// que emite el tester determinístico cuando la batería no termina.
//
// Regresión del rebote #5901 rev-1: la suite del pipeline cruzó el techo de
// 12 min y el tester rebotó dos issues sanos el mismo día (#5802 y #5901) con
// el motivo `node --test exit code 124 sin reporte JUnit parseable` — que era
// falso: el batch 1/2 SÍ había producido un JUnit parseable con 9376 tests en
// verde. El dev salió a buscar un test roto que no existía.
//
// Lo que se fija acá:
//   1) el techo tiene headroom sobre el peor caso medido y es override-able;
//   2) el motivo distingue TIMEOUT de "el runner murió por su cuenta";
//   3) el motivo trae el parcial (batches, tests corridos, última línea);
//   4) el timeout sigue siendo RECHAZO — el fix es de diagnóstico, no un
//      aflojamiento del gate.

const { test } = require('node:test');
const assert = require('node:assert');

const tester = require('../skills-deterministicos/tester.js');
const {
    buildNodeTestFailureMotivo,
    NODE_TEST_WALL_TIMEOUT_MS,
    NODE_TEST_WALL_TIMEOUT_DEFAULT_MS,
} = tester;

// ── 1. Presupuesto de wall-clock ────────────────────────────────────

test('el techo por defecto deja headroom sobre el peor wall-clock medido (850s)', () => {
    // Peor caso observado en máquina cargada: 850s. El techo viejo (720s) lo
    // cruzaba. Se exige al menos 1,5x de margen para que la contención normal
    // del pipeline (dev + build vivos) no rechace código sano.
    const PEOR_CASO_MEDIDO_MS = 850 * 1000;
    assert.ok(
        NODE_TEST_WALL_TIMEOUT_DEFAULT_MS >= PEOR_CASO_MEDIDO_MS * 1.5,
        `techo ${NODE_TEST_WALL_TIMEOUT_DEFAULT_MS}ms sin headroom sobre ${PEOR_CASO_MEDIDO_MS}ms`,
    );
});

test('el techo sigue por debajo del watchdog del Pulpo (45 min)', () => {
    // Si el techo superara al watchdog, el corte lo haría el watchdog: mataría
    // al tester sin JUnit ni motivo, que es exactamente el modo de falla que
    // el wall-clock existe para evitar (#3344).
    const WATCHDOG_PULPO_MS = 45 * 60 * 1000;
    assert.ok(
        NODE_TEST_WALL_TIMEOUT_DEFAULT_MS < WATCHDOG_PULPO_MS,
        'el techo debe cortar ANTES que el watchdog para poder reportar el motivo',
    );
});

test('el techo efectivo es el default cuando no hay override', () => {
    // El módulo se carga sin la env var en el entorno de este test.
    if (!process.env.PIPELINE_TESTER_NODE_WALL_TIMEOUT_MS) {
        assert.equal(NODE_TEST_WALL_TIMEOUT_MS, NODE_TEST_WALL_TIMEOUT_DEFAULT_MS);
    }
});

// ── 2. El motivo distingue timeout de muerte del runner ─────────────

test('timeout: el motivo nombra el wall-clock y NO dice "sin reporte JUnit parseable"', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true,
        exit_code: 124,
        wall_ms: 720527,
        batches_total: 2,
        batches_completed: 1,
        last_progress_line: '✔ algo pasó (0.17ms)',
        summary: { valid: false, tests: 9376, failures: 0, errors: 0, skipped: 3 },
    });
    assert.match(motivo, /wall-clock/i, 'el motivo debe nombrar la causa real');
    assert.match(motivo, /INCOMPLETA/, 'debe decir que la batería no terminó');
    assert.doesNotMatch(
        motivo, /sin reporte JUnit parseable/,
        'ese texto mandó al dev a buscar un test roto inexistente (#5901 rev-1)',
    );
});

test('runner muerto por su cuenta: el motivo lo separa del timeout', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: false,
        exit_code: 7,
        wall_ms: 3200,
        batches_total: 1,
        batches_completed: 0,
        summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0 },
    });
    assert.match(motivo, /exit code 7/);
    assert.match(motivo, /sin reporte JUnit parseable/, 'acá el texto SÍ corresponde');
    assert.match(motivo, /no por timeout/, 'debe descartar explícitamente el timeout');
});

// ── 3. El motivo trae el parcial para diagnosticar ──────────────────

test('timeout: reporta batches completados y tests corridos antes del corte', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 720000,
        batches_total: 2, batches_completed: 1,
        summary: { valid: false, tests: 9376, failures: 0, errors: 0, skipped: 3 },
    });
    assert.match(motivo, /batches completados: 1\/2/);
    assert.match(motivo, /9376/, 'el parcial ubica el problema fuera del diff');
    assert.match(motivo, /0 fallas/);
});

test('timeout: suma failures y errors del parcial en un solo número de fallas', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 100000,
        batches_total: 2, batches_completed: 1,
        summary: { valid: false, tests: 500, failures: 2, errors: 3, skipped: 0 },
    });
    assert.match(motivo, /500 con 5 fallas/);
});

test('timeout sin ningún test reportado: lo dice en vez de mostrar "0 tests"', () => {
    // Caso real de #5802: el batch 1/2 murió a los 641s sin escribir XML.
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 732925,
        batches_total: 2, batches_completed: 0,
        summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0 },
    });
    assert.match(motivo, /ningún test alcanzó a reportarse/);
});

test('timeout: incluye la última línea de progreso, truncada', () => {
    const larga = 'x'.repeat(500);
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 1000,
        batches_total: 1, batches_completed: 0,
        last_progress_line: larga,
        summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0 },
    });
    assert.match(motivo, /última línea de progreso/);
    assert.ok(motivo.length < 900, `motivo desbordado (${motivo.length} chars)`);
});

test('timeout: el motivo apunta al log y a la palanca de ajuste', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 1000,
        batches_total: 1, batches_completed: 0,
        summary: { valid: false, tests: 10, failures: 0, errors: 0, skipped: 0 },
    });
    assert.match(motivo, /tester\.log/, 'el dev tiene que saber dónde mirar');
    assert.match(motivo, /PIPELINE_TESTER_NODE_WALL_TIMEOUT_MS/, 'y qué palanca tocar');
});

test('un solo batch no imprime "batches completados" (ruido inútil)', () => {
    const motivo = buildNodeTestFailureMotivo({
        timed_out: true, exit_code: 124, wall_ms: 1000,
        batches_total: 1, batches_completed: 0,
        summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0 },
    });
    assert.doesNotMatch(motivo, /batches completados/);
});

// ── 4. Robustez: entrada incompleta no rompe el reporte ─────────────

test('no explota con un resultado sin summary ni contadores', () => {
    // El motivo se construye en el camino de FALLA: si tira, el tester se cae
    // sin reportar nada y el issue queda sin veredicto.
    assert.doesNotThrow(() => buildNodeTestFailureMotivo({ timed_out: true }));
    assert.doesNotThrow(() => buildNodeTestFailureMotivo({}));
    assert.doesNotThrow(() => buildNodeTestFailureMotivo(null));
});

test('wall_ms ausente se reporta como 0s en vez de NaN', () => {
    const motivo = buildNodeTestFailureMotivo({ timed_out: true });
    assert.doesNotMatch(motivo, /NaN/);
});

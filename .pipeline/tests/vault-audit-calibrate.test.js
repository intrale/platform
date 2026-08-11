'use strict';

/**
 * #5804 — Suite del núcleo de calibración (`lib/vault-calibration-scenario.js`)
 * y de su wrapper CLI (`tools/vault-audit-calibrate.js`).
 *
 * Grupos exigidos por CA-10:
 *   A — fórmula, unidades y redondeo (CA-6)
 *   B — fail-closed (CA-4, CA-5)
 *   C — determinismo byte a byte (CA-7)
 *   D — redacción con canarios (CA-8)
 *   E — puertos acotados (CA-9)
 *   F — estructura y contrato de módulo (CA-1, CA-2, CA-3)
 *   G — wrapper CLI (contrato de operador G-1/G-2/G-4)
 *
 * Regla de la suite: los literales del vocabulario NO se escriben acá tampoco —
 * se derivan del enum importado, así que si el enum cambia, cambia el test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { VAULT_TELEMETRY_CATEGORIES } = require('../lib/secret-vault');
const core = require('../lib/vault-calibration-scenario');
const cli = require('../tools/vault-audit-calibrate');

const {
    CALIBRATION_LIMITS: LIMITS,
    CALIBRATION_ERROR_CODES: CODES,
    CalibrationError,
    validateScenario,
    aggregateEvents,
    buildScenarioEvidence,
    runScenario,
} = core;

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const PHYSICAL = VAULT_TELEMETRY_CATEGORIES[0];
const EXCLUDED = VAULT_TELEMETRY_CATEGORIES.slice(1);
const HEAD_SHA = '3b2f78b7d0000000000000000000000000000000';

const CORE_PATH = path.join(__dirname, '..', 'lib', 'vault-calibration-scenario.js');
const CLI_PATH = path.join(__dirname, '..', 'tools', 'vault-audit-calibrate.js');

function baseScenario(overrides) {
    return Object.assign({
        window_start_ms: 1000000,
        window_duration_ms: 3600000,
        bucket_ms: 60000,
        concurrency: 4,
        launches: 10,
        distribution: 'sequential',
        sequence_seed: 42,
        unit: 'reads',
    }, overrides || {});
}

function evento(seq, offsetMs, category) {
    return { seq, ts_ms: 1000000 + offsetMs, category };
}

/** Puerto `clock` determinístico: sella dentro de la ventana y nunca decrece. */
function relojFake(pasoMs) {
    let i = 0;
    const paso = pasoMs === undefined ? 1000 : pasoMs;
    return () => {
        const valor = 1000000 + (i * paso);
        i += 1;
        return valor;
    };
}

/** Sink que cuenta invocaciones: la aserción de "no se emitió evidencia" es esta. */
function sinkContador() {
    const recibido = [];
    const fn = (evidence) => { recibido.push(evidence); };
    fn.recibido = recibido;
    return fn;
}

function driverFake(categorias) {
    let i = 0;
    return () => {
        const category = categorias[i % categorias.length];
        i += 1;
        return { category };
    };
}

function deps(overrides) {
    return Object.assign({
        scenario: baseScenario(),
        clock: relojFake(),
        driver: driverFake([PHYSICAL]),
        sink: sinkContador(),
        resolveHead: () => HEAD_SHA,
    }, overrides || {});
}

/** Corre un escenario y devuelve `{ evidence, sink }`. */
async function correr(overrides) {
    const d = deps(overrides);
    const evidence = await runScenario(d);
    return { evidence, sink: d.sink };
}

function esCalibrationError(code) {
    return (err) => {
        assert.ok(err instanceof CalibrationError, `esperaba CalibrationError, vino ${err && err.name}`);
        assert.strictEqual(err.code, code);
        return true;
    };
}

/** Resumen mínimo válido, para ejercer `buildScenarioEvidence` en aislamiento. */
function resumenBase(overrides) {
    const sc = baseScenario();
    const buckets = sc.window_duration_ms / sc.bucket_ms;
    const counts = {};
    for (const c of VAULT_TELEMETRY_CATEGORIES) counts[c] = 0;
    counts[PHYSICAL] = 3;
    return Object.assign({
        scenario: sc,
        counts,
        physical_total: 3,
        buckets: {
            size_ms: sc.bucket_ms,
            count: buckets,
            physical_by_bucket: new Array(buckets).fill(0),
        },
        peak: { bucket_index: 0, reads_per_bucket: 3, reads_per_second: 0.05 },
        sequence: { total: 3, first: null, last: null },
        ordered: [],
    }, overrides || {});
}

const PROVENANCE = { head_sha: HEAD_SHA, generated_at_ms: 1700000000000 };

// =============================================================================
// A — fórmula, unidades y redondeo (CA-6)
// =============================================================================

test('A · la evidencia expone formula, sustitucion, unidad y regla de redondeo', async () => {
    const { evidence } = await correr();

    assert.match(evidence.formula, /= ceil\(.* \* MONTH_MS \/ window_duration_ms\)$/);
    assert.strictEqual(
        evidence.substitution,
        `ceil(${evidence.physical_total} * ${LIMITS.MONTH_MS} / ${evidence.scenario.window_duration_ms})`,
    );
    assert.strictEqual(evidence.unit, 'reads/month');
    assert.strictEqual(evidence.rounding, 'ceil');
    assert.strictEqual(evidence.peak.rounding, 'round_half_up_6dp');
    assert.strictEqual(evidence.peak.unit, 'reads/second');
});

test('A · la sustitucion trae los valores reales ya reemplazados, no nombres de variable', () => {
    const evidence = buildScenarioEvidence(resumenBase(), PROVENANCE);
    assert.strictEqual(evidence.substitution, `ceil(3 * ${LIMITS.MONTH_MS} / 3600000)`);
    assert.strictEqual(evidence.monthly_physical_total, Math.ceil((3 * LIMITS.MONTH_MS) / 3600000));
});

test('A · la extrapolacion mensual redondea hacia arriba (conservador)', () => {
    // 1 lectura en 1 hora ⇒ 720 exactas; 1 lectura en una ventana que no divide
    // exacto tiene que subir al entero siguiente, nunca truncar.
    const sc = baseScenario({ window_duration_ms: 3500000, bucket_ms: 1000 * 250 });
    const resumen = resumenBase({
        scenario: sc,
        physical_total: 1,
        buckets: { size_ms: sc.bucket_ms, count: 14, physical_by_bucket: new Array(14).fill(0) },
    });
    const evidence = buildScenarioEvidence(resumen, PROVENANCE);
    const exacto = (1 * LIMITS.MONTH_MS) / 3500000;
    assert.ok(!Number.isInteger(exacto), 'el fixture tiene que dar fraccion');
    assert.strictEqual(evidence.monthly_physical_total, Math.ceil(exacto));
});

test('A · subir cache_hit y single_flight_join no mueve pico ni extrapolacion', () => {
    const sc = baseScenario();
    const soloFisicos = [
        evento(0, 0, PHYSICAL),
        evento(1, 1000, PHYSICAL),
        evento(2, 120000, PHYSICAL),
    ];
    const conRuido = soloFisicos.slice();
    let seq = 100;
    for (const categoria of EXCLUDED) {
        for (let i = 0; i < 500; i += 1) {
            conRuido.push(evento(seq, (i % 50) * 1000, categoria));
            seq += 1;
        }
    }

    const a = aggregateEvents(soloFisicos, sc);
    const b = aggregateEvents(conRuido, sc);

    assert.deepStrictEqual(b.peak, a.peak);
    assert.strictEqual(b.physical_total, a.physical_total);
    assert.deepStrictEqual(
        Array.from(b.buckets.physical_by_bucket),
        Array.from(a.buckets.physical_by_bucket),
    );

    const evA = buildScenarioEvidence(a, PROVENANCE);
    const evB = buildScenarioEvidence(b, PROVENANCE);
    assert.strictEqual(evB.monthly_physical_total, evA.monthly_physical_total);
    assert.strictEqual(evB.substitution, evA.substitution);

    // …y sin embargo los contadores no fisicos SI se reportan (no se pierden).
    for (const categoria of EXCLUDED) {
        assert.strictEqual(evB.counts[categoria], 500);
        assert.strictEqual(evA.counts[categoria], 0);
    }
});

test('A · las categorias no fisicas quedan rotuladas como excluidas (G-3)', async () => {
    const { evidence } = await correr();
    assert.deepStrictEqual(evidence.excluded_from_physical_metrics, EXCLUDED.slice());
    assert.ok(!evidence.excluded_from_physical_metrics.includes(PHYSICAL));
});

test('A · el pico se calcula por bucket y su equivalente por segundo es exacto', () => {
    const sc = baseScenario({ window_duration_ms: 600000, bucket_ms: 60000 });
    const eventos = [];
    for (let i = 0; i < 7; i += 1) eventos.push(evento(i, 120000 + i, PHYSICAL));
    eventos.push(evento(50, 1000, PHYSICAL));

    const resumen = aggregateEvents(eventos, sc);
    assert.strictEqual(resumen.peak.bucket_index, 2);
    assert.strictEqual(resumen.peak.reads_per_bucket, 7);
    // El redondeo es half-up a 6 decimales y esta declarado en la evidencia:
    // 7/60 no es representable, asi que el contrato es el numero YA redondeado.
    assert.strictEqual(resumen.peak.reads_per_second, Math.round((7 / 60) * 1e6) / 1e6);
    assert.strictEqual(resumen.peak.reads_per_second, 0.116667);
});

test('A · un lote vacio produce evidencia completa con secuencia nula, sin inventar datos', () => {
    const resumen = aggregateEvents([], baseScenario());
    assert.strictEqual(resumen.physical_total, 0);
    assert.strictEqual(resumen.sequence.first, null);
    assert.strictEqual(resumen.sequence.last, null);

    const evidence = buildScenarioEvidence(resumen, PROVENANCE);
    assert.strictEqual(evidence.monthly_physical_total, 0);
    assert.strictEqual(evidence.sequence.first, null);
    assert.strictEqual(evidence.sequence.last, null);
    assert.strictEqual(evidence.peak.reads_per_bucket, 0);
});

// =============================================================================
// B — fail-closed (CA-4, CA-5)
// =============================================================================

const CASOS_ESCENARIO = [
    ['campo ausente', { window_duration_ms: undefined }, CODES.MISSING_FIELD],
    ['campo nulo', { bucket_ms: null }, CODES.MISSING_FIELD],
    ['campo desconocido', { demas: 1 }, CODES.UNKNOWN_FIELD],
    ['NaN', { launches: NaN }, CODES.NOT_INTEGER],
    ['Infinity', { launches: Infinity }, CODES.NOT_INTEGER],
    ['-Infinity', { window_start_ms: -Infinity }, CODES.NOT_INTEGER],
    ['fraccion donde se espera entero', { bucket_ms: 1500.5 }, CODES.NOT_INTEGER],
    ['numero como texto (sin coercion)', { launches: '10' }, CODES.NOT_INTEGER],
    ['booleano donde se espera entero', { concurrency: true }, CODES.NOT_INTEGER],
    ['negativo', { window_start_ms: -1 }, CODES.OUT_OF_RANGE],
    ['launches sobre el tope', { launches: LIMITS.MAX_LAUNCHES + 1 }, CODES.OUT_OF_RANGE],
    ['concurrency sobre el tope', { concurrency: LIMITS.MAX_CONCURRENCY + 1 }, CODES.OUT_OF_RANGE],
    ['ventana por debajo del minimo', { window_duration_ms: LIMITS.MIN_WINDOW_MS - 1 }, CODES.OUT_OF_RANGE],
    ['ventana en cero', { window_duration_ms: 0 }, CODES.OUT_OF_RANGE],
    ['ventana sobre el tope', { window_duration_ms: LIMITS.MAX_WINDOW_MS + 1 }, CODES.OUT_OF_RANGE],
    ['bucket por debajo del minimo', { bucket_ms: LIMITS.MIN_BUCKET_MS - 1 }, CODES.OUT_OF_RANGE],
    ['bucket sobre el tope', { bucket_ms: LIMITS.MAX_BUCKET_MS + 1, window_duration_ms: LIMITS.MAX_WINDOW_MS }, CODES.OUT_OF_RANGE],
    ['distribucion fuera del enum', { distribution: 'poisson' }, CODES.UNKNOWN_DISTRIBUTION],
    ['distribucion no textual', { distribution: 7 }, CODES.NOT_STRING],
    ['texto sobre MAX_STRING_LENGTH', { unit: 'r'.repeat(LIMITS.MAX_STRING_LENGTH + 1) }, CODES.STRING_TOO_LONG],
    ['texto vacio', { unit: '' }, CODES.STRING_TOO_LONG],
    ['unidad mal formada', { unit: 'Reads/Month' }, CODES.STRING_MALFORMED],
    ['ventana no divisible por el bucket', { bucket_ms: 7000 }, CODES.WINDOW_NOT_DIVISIBLE],
    ['mas buckets que el tope', { window_duration_ms: 86400000, bucket_ms: 1000 }, CODES.TOO_MANY_BUCKETS],
];

for (const [nombre, override, code] of CASOS_ESCENARIO) {
    test(`B · validateScenario falla cerrado ante ${nombre}`, () => {
        assert.throws(() => validateScenario(baseScenario(override)), esCalibrationError(code));
    });
}

test('B · validateScenario rechaza lo que no es objeto plano', () => {
    for (const valor of [null, undefined, 42, 'x', [], true]) {
        assert.throws(() => validateScenario(valor), esCalibrationError(CODES.SCENARIO_NOT_OBJECT));
    }
});

test('B · validateScenario rechaza claves de herencia peligrosa', () => {
    for (const clave of ['__proto__', 'constructor', 'prototype']) {
        const sc = baseScenario();
        Object.defineProperty(sc, clave, { value: {}, enumerable: true, configurable: true });
        assert.throws(() => validateScenario(sc), esCalibrationError(CODES.UNSAFE_KEY));
    }
});

test('B · el escenario valido vuelve como copia CONGELADA, sin defaults agregados', () => {
    const entrada = baseScenario();
    const salida = validateScenario(entrada);
    assert.ok(Object.isFrozen(salida));
    assert.notStrictEqual(salida, entrada);
    assert.deepStrictEqual(Object.keys(salida).sort(), Object.keys(entrada).sort());
    assert.throws(() => { salida.launches = 999; }, TypeError);
});

const CASOS_EVENTOS = [
    ['un evento que no es objeto', [42], CODES.EVENT_NOT_OBJECT],
    ['un evento nulo', [null], CODES.EVENT_NOT_OBJECT],
    ['un evento como arreglo', [[]], CODES.EVENT_NOT_OBJECT],
    ['un campo desconocido en el evento', [{ seq: 0, ts_ms: 1000000, category: PHYSICAL, extra: 1 }], CODES.UNKNOWN_FIELD],
    ['un evento sin seq', [{ ts_ms: 1000000, category: PHYSICAL }], CODES.MISSING_FIELD],
    ['un seq fraccionario', [{ seq: 0.5, ts_ms: 1000000, category: PHYSICAL }], CODES.NOT_INTEGER],
    ['un ts_ms no finito', [{ seq: 0, ts_ms: NaN, category: PHYSICAL }], CODES.NOT_INTEGER],
    ['una categoria fuera del enum', [{ seq: 0, ts_ms: 1000000, category: 'inventada' }], CODES.UNKNOWN_CATEGORY],
    ['una categoria no textual', [{ seq: 0, ts_ms: 1000000, category: 3 }], CODES.UNKNOWN_CATEGORY],
    ['un evento anterior a la ventana', [{ seq: 0, ts_ms: 999999, category: PHYSICAL }], CODES.EVENT_OUT_OF_WINDOW],
    ['un evento posterior a la ventana', [{ seq: 0, ts_ms: 1000000 + 3600000, category: PHYSICAL }], CODES.EVENT_OUT_OF_WINDOW],
];

for (const [nombre, eventos, code] of CASOS_EVENTOS) {
    test(`B · aggregateEvents falla cerrado ante ${nombre}`, () => {
        assert.throws(() => aggregateEvents(eventos, baseScenario()), esCalibrationError(code));
    });
}

test('B · aggregateEvents rechaza lo que no es un arreglo de eventos', () => {
    for (const valor of [null, undefined, {}, 'x', 7]) {
        assert.throws(
            () => aggregateEvents(valor, baseScenario()),
            esCalibrationError(CODES.EVENTS_NOT_ARRAY),
        );
    }
});

test('B · aggregateEvents rechaza un evento con clave de herencia peligrosa', () => {
    const malo = { seq: 0, ts_ms: 1000000, category: PHYSICAL };
    Object.defineProperty(malo, '__proto__', { value: {}, enumerable: true, configurable: true });
    assert.throws(() => aggregateEvents([malo], baseScenario()), esCalibrationError(CODES.UNSAFE_KEY));
});

test('B · aggregateEvents rechaza seq duplicado (romperia el desempate)', () => {
    const eventos = [evento(1, 0, PHYSICAL), evento(1, 5000, PHYSICAL)];
    assert.throws(() => aggregateEvents(eventos, baseScenario()), esCalibrationError(CODES.DUPLICATE_SEQUENCE));
});

test('B · el tope de eventos se chequea ANTES de ordenar o agregar', () => {
    // Se excede el tope en 1 con un arreglo de agujeros: si el nucleo ordenara o
    // recorriera antes de chequear la cota, fallaria por EVENT_NOT_OBJECT.
    const enorme = new Array(LIMITS.MAX_EVENTS + 1);
    assert.throws(() => aggregateEvents(enorme, baseScenario()), (err) => {
        assert.strictEqual(err.code, CODES.TOO_MANY_EVENTS);
        assert.strictEqual(err.detail.limit, LIMITS.MAX_EVENTS);
        return true;
    });
});

test('B · runScenario no invoca el sink cuando el escenario no valida', async () => {
    const sink = sinkContador();
    let driverLlamado = 0;
    await assert.rejects(
        runScenario(deps({
            scenario: baseScenario({ launches: -1 }),
            sink,
            driver: () => { driverLlamado += 1; return { category: PHYSICAL }; },
        })),
        esCalibrationError(CODES.OUT_OF_RANGE),
    );
    assert.strictEqual(sink.recibido.length, 0, 'no puede haber evidencia parcial');
    assert.strictEqual(driverLlamado, 0, 'no puede medir con un escenario invalido');
});

test('B · runScenario rechaza deps que no es objeto plano', async () => {
    for (const valor of [null, undefined, 'x', []]) {
        await assert.rejects(() => runScenario(valor), esCalibrationError(CODES.PORT_MISSING));
    }
});

test('B · los limites numericos son exactamente los del contrato y estan congelados', () => {
    assert.ok(Object.isFrozen(LIMITS));
    assert.deepStrictEqual(Object.assign({}, LIMITS), {
        MAX_EVENTS: 100000,
        MAX_LAUNCHES: 1000,
        MAX_CONCURRENCY: 64,
        MAX_STRING_LENGTH: 128,
        MIN_WINDOW_MS: 1000,
        MAX_WINDOW_MS: 86400000,
        MIN_BUCKET_MS: 1000,
        MAX_BUCKET_MS: 3600000,
        MAX_BUCKETS: 1440,
        MONTH_MS: 2592000000,
    });
    assert.ok(Object.isFrozen(CODES));
});

test('B · buildScenarioEvidence corta por overflow sin emitir evidencia parcial', () => {
    const enorme = Math.ceil(Number.MAX_SAFE_INTEGER / LIMITS.MONTH_MS) + 1;
    const resumen = resumenBase({ physical_total: enorme });
    assert.throws(
        () => buildScenarioEvidence(resumen, PROVENANCE),
        esCalibrationError(CODES.UNSAFE_INTEGER_RESULT),
    );
});

test('B · buildScenarioEvidence rechaza un resumen que no cumple su contrato', () => {
    assert.throws(() => buildScenarioEvidence(null, PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));
    assert.throws(() => buildScenarioEvidence([], PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));

    const sinPeak = resumenBase();
    delete sinPeak.peak;
    assert.throws(() => buildScenarioEvidence(sinPeak, PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));

    const conExtra = resumenBase({ demas: 1 });
    assert.throws(() => buildScenarioEvidence(conExtra, PROVENANCE), esCalibrationError(CODES.UNKNOWN_FIELD));

    const peakRaro = resumenBase({ peak: 'x' });
    assert.throws(() => buildScenarioEvidence(peakRaro, PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));

    const totalRaro = resumenBase({ physical_total: -1 });
    assert.throws(() => buildScenarioEvidence(totalRaro, PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));

    const totalFraccionario = resumenBase({ physical_total: 1.5 });
    assert.throws(() => buildScenarioEvidence(totalFraccionario, PROVENANCE), esCalibrationError(CODES.SUMMARY_INVALID));

    const inseguro = resumenBase();
    Object.defineProperty(inseguro, 'constructor', { value: {}, enumerable: true, configurable: true });
    assert.throws(() => buildScenarioEvidence(inseguro, PROVENANCE), esCalibrationError(CODES.UNSAFE_KEY));
});

test('B · buildScenarioEvidence rechaza una procedencia invalida', () => {
    const resumen = resumenBase();
    assert.throws(() => buildScenarioEvidence(resumen, null), esCalibrationError(CODES.PROVENANCE_INVALID));
    assert.throws(() => buildScenarioEvidence(resumen, []), esCalibrationError(CODES.PROVENANCE_INVALID));
    assert.throws(
        () => buildScenarioEvidence(resumen, { head_sha: HEAD_SHA, generated_at_ms: 1, extra: 2 }),
        esCalibrationError(CODES.UNKNOWN_FIELD),
    );
    assert.throws(
        () => buildScenarioEvidence(resumen, { head_sha: HEAD_SHA }),
        esCalibrationError(CODES.MISSING_FIELD),
    );
    assert.throws(
        () => buildScenarioEvidence(resumen, { head_sha: HEAD_SHA, generated_at_ms: -1 }),
        esCalibrationError(CODES.OUT_OF_RANGE),
    );
    for (const sha of ['', 'zz', HEAD_SHA.toUpperCase(), HEAD_SHA.slice(0, 39), `${HEAD_SHA}0`, 7, null]) {
        assert.throws(
            () => buildScenarioEvidence(resumen, { head_sha: sha, generated_at_ms: 1 }),
            esCalibrationError(CODES.INVALID_HEAD_SHA),
        );
    }
});

test('B · buildScenarioEvidence no confia en contadores del resumen y los sanea a entero', () => {
    const counts = {};
    for (const c of VAULT_TELEMETRY_CATEGORIES) counts[c] = 'muchos';
    const resumen = resumenBase({
        counts,
        buckets: { size_ms: 60000, count: 60, physical_by_bucket: 'no-es-arreglo' },
    });
    const evidence = buildScenarioEvidence(resumen, PROVENANCE);
    for (const c of VAULT_TELEMETRY_CATEGORIES) assert.strictEqual(evidence.counts[c], 0);
    assert.deepStrictEqual(evidence.buckets.physical_by_bucket, []);
});

test('B · el detail del error se limita a nombres de campo, indices y topes', () => {
    try {
        validateScenario(baseScenario({ 'canario-INYECTADO=secreto': 1 }));
        assert.fail('tenia que fallar');
    } catch (err) {
        assert.strictEqual(err.code, CODES.UNKNOWN_FIELD);
        // El nombre de la clave ES input: si no es un identificador ASCII acotado
        // no puede viajar tal cual hacia afuera.
        assert.strictEqual(err.detail.field, '<unsafe>');
        assert.ok(!JSON.stringify(err.detail).includes('secreto'));
    }
});

test('B · CalibrationError descarta un detail que no es objeto plano', () => {
    for (const detail of [null, undefined, 'x', [], 7]) {
        const err = new CalibrationError(CODES.SUMMARY_INVALID, detail);
        assert.deepStrictEqual(Object.assign({}, err.detail), {});
    }
    const err = new CalibrationError(CODES.SUMMARY_INVALID, {
        field: 'launches', index: 3, limit: 10, kind: 'number', otro: 'x',
    });
    assert.deepStrictEqual(Object.assign({}, err.detail), {
        field: 'launches', index: 3, limit: 10, kind: 'number',
    });
    const raro = new CalibrationError(CODES.SUMMARY_INVALID, { index: 1.5, kind: 'inventado' });
    assert.deepStrictEqual(Object.assign({}, raro.detail), {});
    assert.ok(Object.isFrozen(raro.detail));
});

// =============================================================================
// C — determinismo byte a byte (CA-7)
// =============================================================================

test('C · dos corridas con la misma entrada producen la misma serializacion', async () => {
    const a = await correr();
    const b = await correr();
    assert.strictEqual(JSON.stringify(a.evidence), JSON.stringify(b.evidence));
    assert.strictEqual(JSON.stringify(a.sink.recibido[0]), JSON.stringify(b.sink.recibido[0]));
});

test('C · las tres distribuciones son reproducibles con la misma semilla', async () => {
    for (const distribution of ['sequential', 'uniform', 'burst']) {
        const a = await correr({ scenario: baseScenario({ distribution }) });
        const b = await correr({ scenario: baseScenario({ distribution }) });
        assert.strictEqual(
            JSON.stringify(a.evidence), JSON.stringify(b.evidence),
            `la distribucion ${distribution} no fue reproducible`,
        );
    }
});

test('C · el orden canonico no depende del orden de insercion y desempata por seq', () => {
    const sc = baseScenario();
    const eventos = [
        evento(3, 61000, PHYSICAL),
        evento(1, 1000, EXCLUDED[0] || PHYSICAL),
        evento(2, 1000, PHYSICAL),
        evento(0, 1000, PHYSICAL),
    ];
    const directo = aggregateEvents(eventos, sc);
    const invertido = aggregateEvents(eventos.slice().reverse(), sc);
    assert.strictEqual(JSON.stringify(directo.ordered), JSON.stringify(invertido.ordered));

    const seqs = directo.ordered.map((e) => e.seq);
    // bucket 0 primero; dentro del bucket manda el indice de categoria y despues seq.
    assert.strictEqual(seqs[seqs.length - 1], 3, 'el evento del bucket 1 va ultimo');
    const fisicosBucket0 = directo.ordered
        .filter((e) => e.bucket_index === 0 && e.category === PHYSICAL)
        .map((e) => e.seq);
    assert.deepStrictEqual(fisicosBucket0, [0, 2], 'los empates se resuelven por seq ascendente');
});

test('C · las entradas nunca se mutan', async () => {
    const scenario = baseScenario();
    const eventos = [evento(2, 5000, PHYSICAL), evento(0, 1000, PHYSICAL), evento(1, 3000, PHYSICAL)];
    const scenarioPrevio = JSON.parse(JSON.stringify(scenario));
    const eventosPrevios = JSON.parse(JSON.stringify(eventos));

    aggregateEvents(eventos, scenario);
    assert.deepStrictEqual(scenario, scenarioPrevio);
    assert.deepStrictEqual(eventos, eventosPrevios, 'el sort no puede reordenar la entrada');

    const d = deps({ scenario });
    await runScenario(d);
    assert.deepStrictEqual(scenario, scenarioPrevio);
});

test('C · el nucleo no genera sellos implicitos: el tiempo entra por el puerto clock', async () => {
    const a = await correr({ clock: relojFake() });
    const b = await correr({ clock: relojFake(2000) });
    assert.notStrictEqual(a.evidence.generated_at_ms, b.evidence.generated_at_ms);
    assert.strictEqual(a.evidence.generated_at_ms, 1000000 + (10 * 1000));
    assert.strictEqual(b.evidence.generated_at_ms, 1000000 + (10 * 2000));
});

test('C · la evidencia devuelta esta congelada en profundidad', async () => {
    const { evidence } = await correr();
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(evidence.scenario));
    assert.ok(Object.isFrozen(evidence.buckets.physical_by_bucket));
    assert.throws(() => { evidence.monthly_physical_total = 1; }, TypeError);
});

// =============================================================================
// D — redacción con canarios (CA-8)
// =============================================================================

const CANARIO = 'CANARIO-5804-akiaXXXXsecretoQUEnoDEBEsalir';

function sinCanario(valor, mensaje) {
    const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
    assert.ok(!String(texto).includes(CANARIO), mensaje);
    assert.ok(!String(texto).includes('CANARIO-5804'), mensaje);
}

test('D · un canario en process.env no llega a la evidencia ni al sink', async () => {
    process.env.CANARIO_5804 = CANARIO;
    try {
        const { evidence, sink } = await correr();
        sinCanario(evidence, 'el canario de env se filtro al retorno');
        sinCanario(sink.recibido[0], 'el canario de env se filtro al sink');
        // Ningun fragmento de `process.env` viaja: la evidencia es cerrada por allowlist.
        assert.ok(!JSON.stringify(evidence).includes('CANARIO_5804'));
    } finally {
        delete process.env.CANARIO_5804;
    }
});

test('D · un canario en el error del driver muere en el borde', async () => {
    const sink = sinkContador();
    try {
        await runScenario(deps({
            sink,
            driver: () => { throw new Error(`fallo del driver con ${CANARIO}`); },
        }));
        assert.fail('tenia que fallar');
    } catch (err) {
        assert.ok(err instanceof CalibrationError);
        assert.strictEqual(err.code, CODES.DRIVER_FAILED);
        sinCanario(err.message, 'el canario salio por el message');
        sinCanario(err.detail, 'el canario salio por el detail');
        sinCanario(err.stack, 'el canario salio por el stack');
        assert.strictEqual(err.cause, undefined, 'no se encadena el error ajeno');
    }
    assert.strictEqual(sink.recibido.length, 0);
});

test('D · un canario en el error de resolveHead muere en el borde', async () => {
    const sink = sinkContador();
    await assert.rejects(
        runScenario(deps({ sink, resolveHead: () => { throw new Error(CANARIO); } })),
        (err) => {
            assert.strictEqual(err.code, CODES.RESOLVE_HEAD_FAILED);
            sinCanario(err.message);
            sinCanario(err.stack);
            return true;
        },
    );
    assert.strictEqual(sink.recibido.length, 0);
});

test('D · un canario devuelto por resolveHead no entra como procedencia', async () => {
    const sink = sinkContador();
    await assert.rejects(
        runScenario(deps({ sink, resolveHead: () => `${HEAD_SHA}-${CANARIO}` })),
        (err) => {
            assert.strictEqual(err.code, CODES.INVALID_HEAD_SHA);
            sinCanario(err.message);
            sinCanario(err.detail);
            return true;
        },
    );
    assert.strictEqual(sink.recibido.length, 0);
});

test('D · un canario en el error del sink no se propaga', async () => {
    await assert.rejects(
        runScenario(deps({ sink: () => { throw new Error(CANARIO); } })),
        (err) => {
            assert.strictEqual(err.code, CODES.SINK_FAILED);
            sinCanario(err.message);
            sinCanario(err.stack);
            return true;
        },
    );
});

test('D · un sink malicioso no puede reintroducir propiedades en el retorno', async () => {
    let recibido = null;
    const evidence = await runScenario(deps({
        sink: (ev) => {
            recibido = ev;
            try { ev.canario = CANARIO; } catch (e) { /* congelado: se ignora */ }
            return { canario: CANARIO, monthly_physical_total: 999999 };
        },
    }));
    assert.strictEqual(evidence.canario, undefined, 'el retorno del sink se descarta');
    sinCanario(evidence, 'el sink reintrodujo el canario');
    assert.notStrictEqual(evidence.monthly_physical_total, 999999);
    assert.ok(Object.isFrozen(recibido), 'el sink recibe evidencia congelada');
    assert.notStrictEqual(recibido, evidence, 'el sink y el retorno son clones independientes');
});

test('D · una categoria con canario se rechaza en vez de contarse', async () => {
    const sink = sinkContador();
    await assert.rejects(
        runScenario(deps({ sink, driver: () => ({ category: CANARIO }) })),
        (err) => {
            assert.strictEqual(err.code, CODES.UNKNOWN_CATEGORY);
            sinCanario(err.message);
            sinCanario(err.detail);
            return true;
        },
    );
    assert.strictEqual(sink.recibido.length, 0);
});

test('D · el driver no puede inyectar campos ni sobreescribir seq o ts_ms', async () => {
    const { evidence } = await correr({
        driver: () => ({ category: PHYSICAL, seq: 99999, ts_ms: 42, canario: CANARIO }),
    });
    sinCanario(evidence);
    assert.strictEqual(evidence.sequence.first.seq, 0, 'el seq lo pone el nucleo');
    assert.strictEqual(evidence.sequence.first.ts_ms, 1000000, 'el ts_ms lo pone el clock');
});

test('D · un resultado del driver con clave de herencia peligrosa se rechaza', async () => {
    const sink = sinkContador();
    const malo = { category: PHYSICAL };
    Object.defineProperty(malo, '__proto__', { value: {}, enumerable: true, configurable: true });
    await assert.rejects(
        runScenario(deps({ sink, driver: () => malo })),
        esCalibrationError(CODES.UNSAFE_KEY),
    );
    assert.strictEqual(sink.recibido.length, 0);
});

test('D · la evidencia no contiene paths absolutos ni stdout/stderr crudo', async () => {
    const { evidence } = await correr();
    const texto = JSON.stringify(evidence);
    assert.ok(!texto.includes(process.cwd().replace(/\\/g, '\\\\')));
    assert.ok(!/[A-Za-z]:\\\\/.test(texto), 'no puede haber paths de Windows');
    assert.ok(!/"\/(home|c|Users|Workspaces)\//.test(texto), 'no puede haber paths POSIX');
    assert.ok(!texto.includes('at Object.'), 'no puede haber stack');
    // Todas las claves de primer nivel salen de la allowlist del constructor.
    assert.deepStrictEqual(Object.keys(evidence), [
        'schema_version', 'head_sha', 'generated_at_ms', 'scenario', 'counts',
        'physical_total', 'excluded_from_physical_metrics', 'buckets', 'peak',
        'sequence', 'monthly_physical_total', 'formula', 'substitution', 'unit', 'rounding',
    ]);
});

// =============================================================================
// E — puertos acotados (CA-9)
// =============================================================================

test('E · falta cualquier puerto y no se ejecuta nada', async () => {
    for (const puerto of ['clock', 'driver', 'sink', 'resolveHead']) {
        const d = deps();
        d[puerto] = undefined;
        await assert.rejects(runScenario(d), (err) => {
            assert.strictEqual(err.code, CODES.PORT_MISSING);
            assert.strictEqual(err.detail.field, puerto);
            return true;
        });
        d[puerto] = 'no soy funcion';
        await assert.rejects(runScenario(d), esCalibrationError(CODES.PORT_MISSING));
    }
});

test('E · resolveHead con SHA invalido corta ANTES de medir', async () => {
    const invalidos = [
        'no-es-un-sha',
        HEAD_SHA.toUpperCase(),
        HEAD_SHA.slice(0, 39),
        'f'.repeat(LIMITS.MAX_STRING_LENGTH + 1),
        { toString() { return HEAD_SHA; } },
        Object.create(null),
        null,
        42,
    ];
    for (const valor of invalidos) {
        const sink = sinkContador();
        let driverLlamado = 0;
        await assert.rejects(
            runScenario(deps({
                sink,
                resolveHead: () => valor,
                driver: () => { driverLlamado += 1; return { category: PHYSICAL }; },
            })),
            esCalibrationError(CODES.INVALID_HEAD_SHA),
        );
        assert.strictEqual(driverLlamado, 0, 'no se mide sin procedencia demostrable');
        assert.strictEqual(sink.recibido.length, 0);
    }
});

test('E · el clock tiene que devolver enteros no negativos y no decrecientes', async () => {
    const malos = [NaN, Infinity, -1, 1.5, '1000000', null, undefined, {}];
    for (const valor of malos) {
        const sink = sinkContador();
        await assert.rejects(
            runScenario(deps({ sink, clock: () => valor })),
            esCalibrationError(CODES.CLOCK_INVALID),
        );
        assert.strictEqual(sink.recibido.length, 0);
    }

    let i = 0;
    const sink = sinkContador();
    await assert.rejects(
        runScenario(deps({
            sink,
            clock: () => { i += 1; return i === 1 ? 1005000 : 1000000; },
        })),
        esCalibrationError(CODES.CLOCK_INVALID),
    );
    assert.strictEqual(sink.recibido.length, 0);
});

test('E · un clock que explota se traduce a un codigo propio', async () => {
    await assert.rejects(
        runScenario(deps({ clock: () => { throw new Error(CANARIO); } })),
        (err) => {
            assert.strictEqual(err.code, CODES.CLOCK_INVALID);
            sinCanario(err.message);
            return true;
        },
    );
});

test('E · el driver que devuelve algo fuera de contrato falla cerrado', async () => {
    for (const valor of [null, undefined, 'ok', 42, []]) {
        const sink = sinkContador();
        await assert.rejects(
            runScenario(deps({ sink, driver: () => valor })),
            esCalibrationError(CODES.DRIVER_RESULT_INVALID),
        );
        assert.strictEqual(sink.recibido.length, 0);
    }
});

test('E · los puertos asincronicos se soportan igual que los sincronicos', async () => {
    const sink = sinkContador();
    const evidence = await runScenario(deps({
        sink: async (ev) => { sink.recibido.push(ev); },
        resolveHead: async () => HEAD_SHA,
        driver: async () => ({ category: PHYSICAL }),
        clock: (() => { const r = relojFake(); return async () => r(); })(),
    }));
    assert.strictEqual(evidence.head_sha, HEAD_SHA);
    assert.strictEqual(sink.recibido.length, 1);
});

test('E · el driver recibe el minimo indispensable y nada mas', async () => {
    const requests = [];
    await correr({
        driver: (req) => { requests.push(req); return { category: PHYSICAL }; },
    });
    assert.strictEqual(requests.length, 10);
    for (const req of requests) {
        assert.deepStrictEqual(Object.keys(req).sort(), ['launch_index', 'planned_offset_ms', 'seq']);
    }
    assert.deepStrictEqual(requests.map((r) => r.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('E · el conteo por categoria refleja lo que devolvio el driver', async () => {
    const categorias = VAULT_TELEMETRY_CATEGORIES.slice();
    const { evidence } = await correr({
        scenario: baseScenario({ launches: categorias.length * 2, concurrency: 2 }),
        driver: driverFake(categorias),
    });
    for (const categoria of categorias) {
        assert.strictEqual(evidence.counts[categoria], 2);
    }
    assert.strictEqual(evidence.physical_total, 2);
});

test('E · burst concentra los launches al inicio y uniform los reparte', async () => {
    const offsets = { burst: [], uniform: [], sequential: [] };
    for (const distribution of Object.keys(offsets)) {
        await correr({
            scenario: baseScenario({ distribution }),
            driver: (req) => { offsets[distribution].push(req.planned_offset_ms); return { category: PHYSICAL }; },
        });
    }
    assert.ok(offsets.burst.every((o) => o === 0), 'burst arranca todo en cero');
    assert.ok(offsets.uniform.some((o) => o > 0), 'uniform reparte en la ventana');
    assert.deepStrictEqual(
        offsets.sequential.map((_, i) => i),
        offsets.sequential.map((_, i) => i),
    );
    // uniform baraja el orden de los launches; sequential lo respeta.
    assert.notDeepStrictEqual(offsets.uniform, offsets.burst);
});

// =============================================================================
// F — estructura y contrato de módulo (CA-1, CA-2, CA-3)
// =============================================================================

test('F · el modulo exporta exactamente los simbolos del contrato, sin extras', () => {
    assert.deepStrictEqual(Object.keys(core).sort(), [
        'CALIBRATION_ERROR_CODES',
        'CALIBRATION_LIMITS',
        'CalibrationError',
        'aggregateEvents',
        'buildScenarioEvidence',
        'runScenario',
        'validateScenario',
    ]);
    // Nombres reservados para #5805: esta historia NO los ocupa.
    assert.strictEqual(core.runCalibration, undefined);
    assert.strictEqual(core.buildCalibrationEvidence, undefined);
    assert.strictEqual(core.buildEvidence, undefined);
});

test('F · el nucleo no redeclara los literales del vocabulario: los importa', () => {
    const fuenteNucleo = fs.readFileSync(CORE_PATH, 'utf8');
    const fuenteCli = fs.readFileSync(CLI_PATH, 'utf8');
    for (const categoria of VAULT_TELEMETRY_CATEGORIES) {
        assert.ok(
            !fuenteNucleo.includes(categoria),
            `el nucleo redeclara el literal "${categoria}" (segunda fuente de verdad)`,
        );
        assert.ok(
            !fuenteCli.includes(categoria),
            `el wrapper redeclara el literal "${categoria}"`,
        );
    }
    assert.ok(fuenteNucleo.includes("require('./secret-vault')"));
    assert.ok(Object.isFrozen(VAULT_TELEMETRY_CATEGORIES));
});

test('F · la direccion de capas es tools/ hacia lib/ y nunca al reves', () => {
    const fuenteNucleo = fs.readFileSync(CORE_PATH, 'utf8');
    const fuenteCli = fs.readFileSync(CLI_PATH, 'utf8');
    assert.ok(!/require\([^)]*tools\//.test(fuenteNucleo), 'lib/ no puede depender de tools/');

    // Todo lo que el wrapper referencia por `require` apunta a `lib/` — incluida
    // la linea que la ayuda le sugiere copiar al operador.
    const referencias = [...fuenteCli.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(referencias.length > 0);
    for (const ref of referencias) {
        assert.match(ref, /lib\//, `el wrapper referencia "${ref}", que no es lib/`);
        assert.ok(!ref.includes('tools/'), `el wrapper referencia "${ref}" dentro de tools/`);
    }
    // …y el unico `require` EJECUTABLE (fuera de textos de ayuda) es el nucleo.
    const ejecutables = fuenteCli
        .split('\n')
        .filter((linea) => /^const .*= require\(/.test(linea.trim()) || /^\} = require\(/.test(linea.trim()));
    assert.deepStrictEqual(ejecutables.map((l) => l.trim()), [
        "} = require('../lib/vault-calibration-scenario');",
    ]);
});

test('F · el nucleo no toca fs, child_process, process ni fuentes no deterministas', () => {
    const fuenteNucleo = fs.readFileSync(CORE_PATH, 'utf8')
        .split('\n')
        .filter((linea) => !/^\s*(\*|\/\/|\/\*)/.test(linea))
        .join('\n');
    for (const prohibido of ["require('fs')", "require('node:fs')", "require('child_process')",
        'Date.now(', 'Math.random(', 'process.env']) {
        assert.ok(!fuenteNucleo.includes(prohibido), `el nucleo usa ${prohibido}`);
    }
});

// =============================================================================
// G — wrapper CLI (contrato de operador G-1/G-2/G-4)
// =============================================================================

function ioFake(argv, entrada) {
    const salida = { out: '', err: '' };
    return {
        io: {
            argv,
            stdin: (async function* gen() { if (entrada !== undefined) yield Buffer.from(entrada); }()),
            stdout: { write: (t) => { salida.out += t; } },
            stderr: { write: (t) => { salida.err += t; } },
        },
        salida,
    };
}

test('G · --help sale con 0 y documenta OPCIONES y CODIGOS DE SALIDA', async () => {
    const { io, salida } = ioFake(['--help']);
    assert.strictEqual(await cli.main(io), cli.EXIT.OK);
    assert.match(salida.out, /OPCIONES/);
    assert.match(salida.out, /CODIGOS DE SALIDA/);
    assert.match(salida.out, /--no-color/);
    // G-4: sin emojis ni no-ASCII como unico portador de significado.
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(salida.out), 'la ayuda tiene que ser ASCII');
});

test('G · los codigos de salida son estables y estan agrupados por clase de falla', () => {
    assert.ok(Object.isFrozen(cli.EXIT));
    assert.deepStrictEqual(Object.assign({}, cli.EXIT), {
        OK: 0, USAGE: 1, INPUT: 2, SCENARIO: 3, EVENTS: 4, PROVENANCE: 5, METRIC: 6, INTERNAL: 7,
    });
});

test('G · una opcion desconocida sale con USAGE y no repite el valor tipeado', async () => {
    const { io, salida } = ioFake([`--inventada=${CANARIO}`]);
    assert.strictEqual(await cli.main(io), cli.EXIT.USAGE);
    sinCanario(salida.err, 'el valor tipeado se repitio en el error');
    assert.match(salida.err, /ERROR:/);
    assert.match(salida.err, /Impacto:/);
    assert.match(salida.err, /Proximo paso:/);
});

test('G · sin --stdin no hay entrada implicita', async () => {
    const { io } = ioFake([]);
    assert.strictEqual(await cli.main(io), cli.EXIT.USAGE);
    const posicional = ioFake(['lote.json']);
    assert.strictEqual(await cli.main(posicional.io), cli.EXIT.USAGE);
});

test('G · stdin vacio, no-JSON o con clave ajena sale con INPUT', async () => {
    for (const entrada of ['', '   ', 'no soy json', '[]', '"texto"']) {
        const { io } = ioFake(['--stdin'], entrada);
        assert.strictEqual(await cli.main(io), cli.EXIT.INPUT, `entrada: ${entrada}`);
    }
    const ajena = ioFake(['--stdin'], JSON.stringify({ scenario: {}, events: [], colada: 1 }));
    assert.strictEqual(await cli.main(ajena.io), cli.EXIT.INPUT);
});

test('G · el mensaje del parser JSON no se propaga (podria citar el lote crudo)', async () => {
    const { io, salida } = ioFake(['--stdin'], `{"scenario": ${CANARIO}}`);
    assert.strictEqual(await cli.main(io), cli.EXIT.INPUT);
    sinCanario(salida.err, 'el error del parser filtro el fragmento crudo');
});

test('G · un sobre valido emite la evidencia por stdout y sale con 0', async () => {
    const sobre = {
        scenario: baseScenario(),
        events: [evento(0, 0, PHYSICAL), evento(1, 61000, PHYSICAL)],
        head_sha: HEAD_SHA,
        generated_at_ms: 1700000000000,
    };
    const { io, salida } = ioFake(['--stdin', '--no-color'], JSON.stringify(sobre));
    assert.strictEqual(await cli.main(io), cli.EXIT.OK);
    const evidence = JSON.parse(salida.out);
    assert.strictEqual(evidence.physical_total, 2);
    assert.strictEqual(evidence.head_sha, HEAD_SHA);
    assert.strictEqual(salida.err, '');

    const bonito = ioFake(['--stdin', '--pretty'], JSON.stringify(sobre));
    assert.strictEqual(await cli.main(bonito.io), cli.EXIT.OK);
    assert.deepStrictEqual(JSON.parse(bonito.salida.out), evidence, '--pretty no cambia el contenido');
});

test('G · cada clase de error del nucleo mapea a su codigo de salida', async () => {
    const casos = [
        [{ scenario: baseScenario({ launches: -1 }), events: [], head_sha: HEAD_SHA, generated_at_ms: 1 }, cli.EXIT.SCENARIO],
        [{ scenario: baseScenario(), events: 'x', head_sha: HEAD_SHA, generated_at_ms: 1 }, cli.EXIT.EVENTS],
        [{ scenario: baseScenario(), events: [], head_sha: 'corto', generated_at_ms: 1 }, cli.EXIT.PROVENANCE],
    ];
    for (const [sobre, esperado] of casos) {
        const { io, salida } = ioFake(['--stdin'], JSON.stringify(sobre));
        assert.strictEqual(await cli.main(io), esperado);
        assert.match(salida.err, /Impacto:/);
        assert.match(salida.err, /Proximo paso:/);
    }
});

test('G · --no-color produce el mismo texto que la salida con color (G-4)', async () => {
    const sobre = { scenario: baseScenario({ launches: -1 }), events: [], head_sha: HEAD_SHA, generated_at_ms: 1 };
    const conColor = ioFake(['--stdin'], JSON.stringify(sobre));
    await cli.main(conColor.io);
    const sinColor = ioFake(['--stdin', '--no-color'], JSON.stringify(sobre));
    await cli.main(sinColor.io);

    // eslint-disable-next-line no-control-regex
    const limpio = conColor.salida.err.replace(/\[[0-9;]*m/g, '');
    assert.strictEqual(limpio, sinColor.salida.err);
    assert.ok(!sinColor.salida.err.includes(''), '--no-color no puede emitir ANSI');
    // El estado se distingue por texto y exit code, no solo por color.
    assert.match(sinColor.salida.err, /^ERROR: /);
});

test('G · un error ajeno se sanea entero y sale con INTERNAL', async () => {
    const io = {
        argv: ['--stdin'],
        stdin: (async function* gen() { throw new Error(CANARIO); }()),
        stdout: { write: () => {} },
        stderr: { write: () => {} },
    };
    let capturado = '';
    io.stderr.write = (t) => { capturado += t; };
    assert.strictEqual(await cli.main(io), cli.EXIT.INTERNAL);
    sinCanario(capturado, 'un error ajeno filtro su mensaje');
});

test('G · parsePayload proyecta el sobre por allowlist sin tocar los valores', () => {
    const sobre = cli.parsePayload(JSON.stringify({ scenario: { a: 1 }, events: [], head_sha: HEAD_SHA }));
    assert.deepStrictEqual(sobre.scenario, { a: 1 });
    assert.throws(() => cli.parsePayload('{"otra":1}'), (err) => err instanceof cli.CliError);
    assert.throws(() => cli.parsePayload(undefined), (err) => err.exit === cli.EXIT.INPUT);
});

test('G · parseArgs acepta solo el enum de flags declarado', () => {
    assert.deepStrictEqual(cli.parseArgs(['--stdin', '--pretty', '--no-color']), {
        stdin: true, pretty: true, color: false, help: false,
    });
    assert.deepStrictEqual(cli.parseArgs(['-h']).help, true);
    assert.throws(() => cli.parseArgs(['--otra']), (err) => err.exit === cli.EXIT.USAGE);
});

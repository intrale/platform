// Piso mensual de lecturas físicas del vault (#5793).
// node --test
//
// #5793 es el paraguas del split: su trabajo sustantivo lo entregaron #5800,
// #5801 y #5802. Lo que quedaba descubierto era el CA-2 — «la evidencia
// documenta el piso de lecturas físicas/mes y lo distingue de cache hits»: el
// núcleo YA calculaba `monthly_extrapolation`, pero la transcripción de la
// corrida en `docs/pipeline/vault-rotacion-auditoria.md` publicaba sólo el pico.
//
// Como el artefacto real (`.pipeline/audit/vault-load-calibration.json`) no se
// versiona, esa doc ES la evidencia. Un número transcripto a mano se
// desincroniza en silencio, así que este archivo ata los tres lados:
//
//   1. la doc publica un piso mensual con su unidad,
//   2. ese número es exactamente el que devuelve `buildCalibrationEvidence`
//      para el escenario que la MISMA doc transcribe, y
//   3. el contraste con los cache hits que la doc usa para explicar la
//      exclusión también sale de la fórmula, no del teclado.
//
// Vive aparte de `vault-load-calibration.test.js` (que cubre la mecánica del
// núcleo con fixtures propios) porque afirma sobre otra cosa: la fidelidad
// entre la evidencia publicada y el cálculo.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCalibrationEvidence } = require('../vault-load-calibration');
const { CALIBRATION_LIMITS } = require('../vault-calibration-scenario');
const { VAULT_TELEMETRY_CATEGORIES } = require('../secret-vault');

const DOC = path.join(
    __dirname, '..', '..', '..', 'docs', 'pipeline', 'vault-rotacion-auditoria.md',
);

/**
 * SHA de relleno con la FORMA que exige el validador del preflight. El
 * preflight real corre contra el repo; acá lo único bajo prueba es la
 * aritmética de la extrapolación, que no mira los commits.
 */
const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * El escenario de la corrida productiva de #5800, tal como la doc lo transcribe
 * en «Escenario de la corrida (reproducible)» y «Resultado de la corrida».
 */
const CORRIDA = Object.freeze({
    physical_read: 1,
    cache_hit: 96,
    single_flight_join: 31,
    total_resolutions: 128,
    window_duration_ms: 60000,
    bucket_ms: 10000,
    concurrency: 32,
    launches: 128,
});

function evidenciaDeLaCorrida(overrides = {}) {
    const counters = {
        physical_read: CORRIDA.physical_read,
        cache_hit: CORRIDA.cache_hit,
        single_flight_join: CORRIDA.single_flight_join,
        ...overrides,
    };
    return buildCalibrationEvidence({
        preflight: {
            head: SHA,
            integrated: [
                { issue: 5339, commit: SHA },
                { issue: 5340, commit: SHA },
                { issue: 5791, commit: SHA },
                { issue: 5792, commit: SHA },
            ],
        },
        window: {
            started_at: '2026-09-09T22:00:00.000Z',
            duration_ms: CORRIDA.window_duration_ms,
            bucket_ms: CORRIDA.bucket_ms,
            concurrency: CORRIDA.concurrency,
            launches: CORRIDA.launches,
            distribution: 'sequential',
            peak_physical_reads_per_bucket: 1,
            scope_logico: 'providers',
        },
        counters,
        formula: { kind: 'ceil_rate_extrapolation', horizon: 'month' },
    });
}

function leerDoc() {
    return fs.readFileSync(DOC, 'utf8');
}

// =============================================================================
// CA-2 · el piso mensual está publicado y coincide con el núcleo
// =============================================================================

test('CA-2 · la doc publica un piso mensual de lecturas fisicas con su unidad', () => {
    const doc = leerDoc();
    assert.match(
        doc, /Piso mensual de lecturas f[ií]sicas/,
        'la evidencia no publica el piso mensual que pide el CA-2 de #5793',
    );
    assert.match(
        doc, /physical_read\/month/,
        'el piso mensual se publica sin unidad: un numero pelado no es evidencia comparable',
    );
});

test('CA-2 · el piso publicado es el que devuelve el nucleo para la corrida transcripta', () => {
    const evidencia = evidenciaDeLaCorrida();

    // El número no se afirma a mano: se deriva de la misma fórmula que publica
    // el artefacto, con los valores que la doc declara para la corrida.
    const esperado = Math.ceil(
        (CORRIDA.physical_read * CALIBRATION_LIMITS.MONTH_MS) / CORRIDA.window_duration_ms,
    );
    assert.equal(evidencia.monthly_extrapolation, esperado);
    assert.equal(evidencia.formula.unit, 'physical_read/month');
    assert.equal(evidencia.formula.rounding, 'ceil');

    const doc = leerDoc();
    assert.ok(
        doc.includes(`${esperado} physical_read/month`),
        `la doc no transcribe el piso mensual calculado (${esperado} physical_read/month): `
        + 'quedo desincronizada respecto de la formula del nucleo',
    );
    // La sustitución numérica publicada tiene que ser la que devuelve el
    // núcleo, no una reconstrucción aproximada: es lo que permite a un tercero
    // rehacer la cuenta sin correr nada.
    assert.ok(
        doc.includes(evidencia.formula.substitution),
        `la doc no publica la sustitucion numerica del nucleo (${evidencia.formula.substitution})`,
    );
});

test('CA-2 · el horizonte del piso es el mes del nucleo, no un mes escrito a mano', () => {
    const evidencia = evidenciaDeLaCorrida();
    assert.equal(evidencia.formula.params.horizon_ms, CALIBRATION_LIMITS.MONTH_MS);
    assert.ok(
        leerDoc().includes(String(CALIBRATION_LIMITS.MONTH_MS)),
        'la doc no declara el horizonte en ms: sin el, el lector no puede rehacer la cuenta',
    );
});

// =============================================================================
// CA-2 · la distinción contra los cache hits
// =============================================================================

test('CA-2 · el piso mensual NO se mueve cuando cambian cache_hit ni single_flight_join', () => {
    const base = evidenciaDeLaCorrida();
    const conMuchosHits = evidenciaDeLaCorrida({ cache_hit: 99999, single_flight_join: 4242 });

    assert.equal(base.monthly_extrapolation, conMuchosHits.monthly_extrapolation);
    // Y el artefacto ROTULA cuáles quedaron afuera: un cero sin rótulo no se
    // distingue de "se perdió el dato".
    assert.deepEqual(
        base.excluded_from_physical_metrics,
        VAULT_TELEMETRY_CATEGORIES.filter((c) => c !== 'physical_read'),
    );
});

test('CA-2 · el contraste que publica la doc contra el total es el real', () => {
    // La doc explica la exclusión mostrando qué habría dado extrapolar las 128
    // resoluciones. Ese número también tiene que salir de la fórmula.
    const siSeContaraTodo = Math.ceil(
        (CORRIDA.total_resolutions * CALIBRATION_LIMITS.MONTH_MS) / CORRIDA.window_duration_ms,
    );
    const piso = evidenciaDeLaCorrida().monthly_extrapolation;

    assert.ok(siSeContaraTodo > piso, 'el contraste perdio sentido: el total no supera al piso');
    assert.equal(siSeContaraTodo / piso, CORRIDA.total_resolutions / CORRIDA.physical_read);

    const doc = leerDoc();
    assert.ok(
        doc.includes(String(siSeContaraTodo)),
        `la doc no publica el contraste calculado (${siSeContaraTodo}) contra el total de resoluciones`,
    );
});

test('CA-2 · las tres categorias de la corrida transcripta suman el total declarado', () => {
    const evidencia = evidenciaDeLaCorrida();
    // Exclusividad: cada resolución cae en exactamente una categoría. Si la doc
    // transcribiera contadores que no cierran, la evidencia seria inconsistente.
    assert.equal(evidencia.counts.total_resolutions, CORRIDA.total_resolutions);
    assert.equal(
        evidencia.counts.physical_read
        + evidencia.counts.cache_hit
        + evidencia.counts.single_flight_join,
        CORRIDA.total_resolutions,
    );
});

// =============================================================================
// La evidencia publicada no filtra material
// =============================================================================

test('la seccion del piso mensual no publica valores, paths ni identidades', () => {
    const doc = leerDoc();
    const desde = doc.indexOf('##### Piso mensual de lecturas');
    assert.ok(desde >= 0, 'no se encontro la seccion del piso mensual');
    const hasta = doc.indexOf('#####', desde + 10);
    const seccion = doc.slice(desde, hasta > 0 ? hasta : undefined);

    const PROHIBIDOS = [
        /arn:aws:/i,
        /\baws_secret_access_key\b/i,
        /\baws_access_key_id\b/i,
        /\b\d{12}\b/,                 // account id
        /\/intrale\/[a-z]/i,          // path real del vault
        /\beyJ[A-Za-z0-9_-]{6,}/,     // JWT
    ];
    for (const prohibido of PROHIBIDOS) {
        assert.ok(
            !prohibido.test(seccion),
            `la seccion del piso mensual matchea un patron prohibido: ${prohibido}`,
        );
    }
});

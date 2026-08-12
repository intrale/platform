'use strict';

/**
 * #5804 — Núcleo puro + runner reproducible de calibración del vault.
 *
 * Qué ES este módulo:
 *   - validación fail-closed por allowlist de un escenario de calibración,
 *   - agregación determinística de eventos de telemetría del vault,
 *   - construcción de evidencia campo a campo (nunca por spread),
 *   - un runner cuyos CUATRO bordes (`clock`, `driver`, `sink`, `resolveHead`)
 *     entran por inyección.
 *
 * Qué NO es:
 *   - no ejecuta ni publica la medición productiva (eso es #5805, que IMPORTA
 *     este núcleo y expone `runCalibration()` / `buildCalibrationEvidence()`;
 *     acá los nombres son deliberadamente disjuntos: `runScenario()` /
 *     `buildScenarioEvidence()`),
 *   - no instrumenta el vault (eso es #5803),
 *   - no toca `fs`, `child_process`, `process.env`, `Date.now()` ni
 *     `Math.random()`. Todo valor temporal entra por el puerto `clock` y toda
 *     aleatoriedad sale de `sequence_seed` (LCG determinístico).
 *
 * Regla de propiedad del enum (CA-2): el vocabulario de categorías vive en
 * `secret-vault.js` y acá se IMPORTA. Este archivo no puede contener los
 * literales del enum — hay un test que lo afirma leyendo el fuente.
 */

const { VAULT_TELEMETRY_CATEGORIES } = require('./secret-vault');
const { redactDeep } = require('./kernel-table-verify');

// -----------------------------------------------------------------------------
// Vocabulario importado (CA-2)
// -----------------------------------------------------------------------------

const CATEGORIES = VAULT_TELEMETRY_CATEGORIES;

if (!Array.isArray(CATEGORIES) || CATEGORIES.length === 0
    || !CATEGORIES.every((c) => typeof c === 'string' && c.length > 0)) {
    // Fail-closed en tiempo de carga: sin vocabulario no hay métrica posible y
    // seguir adelante produciría una calibración silenciosamente vacía.
    throw new Error('CALIBRATION_TELEMETRY_VOCABULARY_INVALID');
}

/** Categoría de lectura física: por contrato del enum, el primer elemento. */
const PHYSICAL_CATEGORY = CATEGORIES[0];

/** Categorías que se cuentan y se reportan pero NO mueven ninguna métrica física. */
const EXCLUDED_CATEGORIES = Object.freeze(CATEGORIES.slice(1));

// -----------------------------------------------------------------------------
// Contrato numérico (CA-5) — estos valores SON el contrato; el reviewer los
// contrasta contra la tabla del issue. No se agregan claves de conveniencia.
// -----------------------------------------------------------------------------

const CALIBRATION_LIMITS = Object.freeze({
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

const CALIBRATION_ERROR_CODES = Object.freeze({
    SCENARIO_NOT_OBJECT: 'CALIBRATION_SCENARIO_NOT_OBJECT',
    UNKNOWN_FIELD: 'CALIBRATION_UNKNOWN_FIELD',
    MISSING_FIELD: 'CALIBRATION_MISSING_FIELD',
    UNSAFE_KEY: 'CALIBRATION_UNSAFE_KEY',
    NOT_INTEGER: 'CALIBRATION_NOT_INTEGER',
    OUT_OF_RANGE: 'CALIBRATION_OUT_OF_RANGE',
    NOT_STRING: 'CALIBRATION_NOT_STRING',
    STRING_TOO_LONG: 'CALIBRATION_STRING_TOO_LONG',
    STRING_MALFORMED: 'CALIBRATION_STRING_MALFORMED',
    UNKNOWN_DISTRIBUTION: 'CALIBRATION_UNKNOWN_DISTRIBUTION',
    WINDOW_NOT_DIVISIBLE: 'CALIBRATION_WINDOW_NOT_DIVISIBLE',
    TOO_MANY_BUCKETS: 'CALIBRATION_TOO_MANY_BUCKETS',
    EVENTS_NOT_ARRAY: 'CALIBRATION_EVENTS_NOT_ARRAY',
    TOO_MANY_EVENTS: 'CALIBRATION_TOO_MANY_EVENTS',
    EVENT_NOT_OBJECT: 'CALIBRATION_EVENT_NOT_OBJECT',
    UNKNOWN_CATEGORY: 'CALIBRATION_UNKNOWN_CATEGORY',
    EVENT_OUT_OF_WINDOW: 'CALIBRATION_EVENT_OUT_OF_WINDOW',
    DUPLICATE_SEQUENCE: 'CALIBRATION_DUPLICATE_SEQUENCE',
    SUMMARY_INVALID: 'CALIBRATION_SUMMARY_INVALID',
    PROVENANCE_INVALID: 'CALIBRATION_PROVENANCE_INVALID',
    INVALID_HEAD_SHA: 'CALIBRATION_INVALID_HEAD_SHA',
    NON_FINITE_RESULT: 'CALIBRATION_NON_FINITE_RESULT',
    UNSAFE_INTEGER_RESULT: 'CALIBRATION_UNSAFE_INTEGER_RESULT',
    PORT_MISSING: 'CALIBRATION_PORT_MISSING',
    CLOCK_INVALID: 'CALIBRATION_CLOCK_INVALID',
    RESOLVE_HEAD_FAILED: 'CALIBRATION_RESOLVE_HEAD_FAILED',
    DRIVER_FAILED: 'CALIBRATION_DRIVER_FAILED',
    DRIVER_RESULT_INVALID: 'CALIBRATION_DRIVER_RESULT_INVALID',
    SINK_FAILED: 'CALIBRATION_SINK_FAILED',
});

/** Campos del escenario. Cualquier otra clave es rechazo, no se ignora. */
const SCENARIO_KEYS = Object.freeze([
    'window_start_ms',
    'window_duration_ms',
    'bucket_ms',
    'concurrency',
    'launches',
    'distribution',
    'sequence_seed',
    'unit',
]);

/** Campos de un evento de telemetría. */
const EVENT_KEYS = Object.freeze(['seq', 'ts_ms', 'category']);

/** Claves de procedencia aceptadas por `buildScenarioEvidence`. */
const PROVENANCE_KEYS = Object.freeze(['head_sha', 'generated_at_ms']);

/** Claves esperadas del summary de `aggregateEvents`. */
const SUMMARY_KEYS = Object.freeze([
    'scenario', 'counts', 'physical_total', 'buckets', 'peak', 'sequence', 'ordered',
]);

/** Herencia peligrosa. Se chequea con `hasOwnProperty`, no con `in`. */
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Distribuciones soportadas. Enum CERRADO: un valor fuera de esta lista falla,
 * nunca cae a un default.
 *   - `sequential`: los launches se ejecutan en orden 0..n-1.
 *   - `uniform`:    orden barajado por `sequence_seed`, offsets repartidos.
 *   - `burst`:      orden barajado por `sequence_seed`, todos al inicio.
 */
const DISTRIBUTIONS = Object.freeze(['sequential', 'uniform', 'burst']);

const MIN_LAUNCHES = 1;
const MIN_CONCURRENCY = 1;
const EVIDENCE_SCHEMA_VERSION = 1;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const UNIT_RE = /^[a-z][a-z0-9_-]*$/;
/** Nombre de campo publicable en `detail`: identificador ASCII acotado. */
const FIELD_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const UNSAFE_FIELD_NAME = '<unsafe>';
/** Claves admitidas en `detail`. Sólo nombres de campo, índices y topes. */
const DETAIL_KEYS = Object.freeze(['field', 'index', 'limit', 'kind']);
/** Valores admitidos en `detail.kind`: resultado de `typeof`, nunca el valor. */
const DETAIL_KINDS = Object.freeze([
    'undefined', 'object', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function',
]);

// -----------------------------------------------------------------------------
// Error (CA-8) — `detail` se limita a nombres de campo e índices. Nunca lleva
// el error ajeno, su `stack`, argumentos, paths ni `process.env`.
// -----------------------------------------------------------------------------

class CalibrationError extends Error {
    /**
     * @param {string} code código de `CALIBRATION_ERROR_CODES`
     * @param {{field?:string,index?:number,limit?:number,kind?:string}} [detail]
     */
    constructor(code, detail) {
        super(typeof code === 'string' ? code : CALIBRATION_ERROR_CODES.SUMMARY_INVALID);
        this.name = 'CalibrationError';
        this.code = typeof code === 'string' ? code : CALIBRATION_ERROR_CODES.SUMMARY_INVALID;
        this.detail = sanitizeDetail(detail);
    }
}

/**
 * Proyecta `detail` por allowlist. Un nombre de campo viene del input (una clave
 * desconocida ES input), así que se sanitiza: si no es un identificador ASCII
 * acotado se reemplaza por un marcador. Un canario en el NOMBRE de una clave no
 * puede viajar hacia afuera.
 */
function sanitizeDetail(detail) {
    const out = {};
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
        return Object.freeze(out);
    }
    for (const key of DETAIL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(detail, key)) continue;
        const value = detail[key];
        if (key === 'field') {
            out.field = typeof value === 'string' && FIELD_NAME_RE.test(value)
                ? value
                : UNSAFE_FIELD_NAME;
        } else if (key === 'kind') {
            if (typeof value === 'string' && DETAIL_KINDS.includes(value)) out.kind = value;
        } else if (Number.isSafeInteger(value)) {
            out[key] = value;
        }
    }
    return Object.freeze(out);
}

/** Falla con un error propio, descartando por completo el error ajeno. */
function fail(code, detail) {
    throw new CalibrationError(code, detail);
}

// -----------------------------------------------------------------------------
// Primitivas de validación (CA-4). Nunca coercionan, nunca redondean, nunca
// completan defaults y nunca omiten silenciosamente.
// -----------------------------------------------------------------------------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnsafeKeys(input, prefix) {
    for (const key of PROTO_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
            fail(CALIBRATION_ERROR_CODES.UNSAFE_KEY, { field: prefix });
        }
    }
}

function assertOnlyKnownKeys(input, known) {
    for (const key of Object.keys(input)) {
        if (!known.includes(key)) {
            fail(CALIBRATION_ERROR_CODES.UNKNOWN_FIELD, { field: key });
        }
    }
}

function requireInteger(value, field) {
    if (value === undefined || value === null) {
        fail(CALIBRATION_ERROR_CODES.MISSING_FIELD, { field });
    }
    if (typeof value !== 'number') {
        fail(CALIBRATION_ERROR_CODES.NOT_INTEGER, { field, kind: typeof value });
    }
    // `Number.isSafeInteger` cubre de una NaN, ±Infinity y fracciones. Una
    // fracción es ERROR, jamás un redondeo silencioso.
    if (!Number.isSafeInteger(value)) {
        fail(CALIBRATION_ERROR_CODES.NOT_INTEGER, { field, kind: 'number' });
    }
    return value;
}

function requireIntegerInRange(value, min, max, field) {
    const n = requireInteger(value, field);
    if (n < min || n > max) {
        fail(CALIBRATION_ERROR_CODES.OUT_OF_RANGE, { field, limit: max });
    }
    return n;
}

function requireBoundedString(value, field) {
    if (value === undefined || value === null) {
        fail(CALIBRATION_ERROR_CODES.MISSING_FIELD, { field });
    }
    if (typeof value !== 'string') {
        fail(CALIBRATION_ERROR_CODES.NOT_STRING, { field, kind: typeof value });
    }
    if (value.length === 0 || value.length > CALIBRATION_LIMITS.MAX_STRING_LENGTH) {
        fail(CALIBRATION_ERROR_CODES.STRING_TOO_LONG, {
            field, limit: CALIBRATION_LIMITS.MAX_STRING_LENGTH,
        });
    }
    return value;
}

/** Redondeo half-up determinístico a 6 decimales. */
function round6(x, field) {
    if (!Number.isFinite(x)) {
        fail(CALIBRATION_ERROR_CODES.NON_FINITE_RESULT, { field });
    }
    return Math.round(x * 1e6) / 1e6;
}

// -----------------------------------------------------------------------------
// CA-4 · validateScenario
// -----------------------------------------------------------------------------

/**
 * Valida un escenario y devuelve una COPIA CONGELADA normalizada.
 * No muta la entrada, no corrige, no completa defaults.
 *
 * @param {object} scenario
 * @returns {Readonly<object>}
 * @throws {CalibrationError}
 */
function validateScenario(scenario) {
    if (!isPlainObject(scenario)) {
        fail(CALIBRATION_ERROR_CODES.SCENARIO_NOT_OBJECT, { kind: typeof scenario });
    }
    assertNoUnsafeKeys(scenario, 'scenario');
    assertOnlyKnownKeys(scenario, SCENARIO_KEYS);

    const out = {};

    out.window_start_ms = requireIntegerInRange(
        scenario.window_start_ms,
        0,
        Number.MAX_SAFE_INTEGER - CALIBRATION_LIMITS.MAX_WINDOW_MS,
        'window_start_ms',
    );
    out.window_duration_ms = requireIntegerInRange(
        scenario.window_duration_ms,
        CALIBRATION_LIMITS.MIN_WINDOW_MS,
        CALIBRATION_LIMITS.MAX_WINDOW_MS,
        'window_duration_ms',
    );
    out.bucket_ms = requireIntegerInRange(
        scenario.bucket_ms,
        CALIBRATION_LIMITS.MIN_BUCKET_MS,
        CALIBRATION_LIMITS.MAX_BUCKET_MS,
        'bucket_ms',
    );
    out.concurrency = requireIntegerInRange(
        scenario.concurrency,
        MIN_CONCURRENCY,
        CALIBRATION_LIMITS.MAX_CONCURRENCY,
        'concurrency',
    );
    out.launches = requireIntegerInRange(
        scenario.launches,
        MIN_LAUNCHES,
        CALIBRATION_LIMITS.MAX_LAUNCHES,
        'launches',
    );

    const distribution = requireBoundedString(scenario.distribution, 'distribution');
    if (!DISTRIBUTIONS.includes(distribution)) {
        fail(CALIBRATION_ERROR_CODES.UNKNOWN_DISTRIBUTION, { field: 'distribution' });
    }
    out.distribution = distribution;

    out.sequence_seed = requireIntegerInRange(
        scenario.sequence_seed, 0, 4294967295, 'sequence_seed',
    );

    const unit = requireBoundedString(scenario.unit, 'unit');
    if (!UNIT_RE.test(unit)) {
        fail(CALIBRATION_ERROR_CODES.STRING_MALFORMED, { field: 'unit' });
    }
    out.unit = unit;

    // La ventana tiene que partirse en buckets EXACTOS: un resto convertiría el
    // último bucket en uno más corto y el pico dejaría de ser comparable.
    if (out.window_duration_ms % out.bucket_ms !== 0) {
        fail(CALIBRATION_ERROR_CODES.WINDOW_NOT_DIVISIBLE, { field: 'bucket_ms' });
    }
    if (out.window_duration_ms / out.bucket_ms > CALIBRATION_LIMITS.MAX_BUCKETS) {
        fail(CALIBRATION_ERROR_CODES.TOO_MANY_BUCKETS, {
            field: 'bucket_ms', limit: CALIBRATION_LIMITS.MAX_BUCKETS,
        });
    }

    return Object.freeze(out);
}

// -----------------------------------------------------------------------------
// CA-6/CA-7 · aggregateEvents
// -----------------------------------------------------------------------------

/**
 * Única puerta de entrada de las métricas físicas. Todo lo que no sea la
 * categoría física queda AFUERA de pico y extrapolación por construcción.
 */
function physicalOnly(events) {
    return events.filter((event) => event.category === PHYSICAL_CATEGORY);
}

function validateEvent(raw, index, scenario) {
    if (!isPlainObject(raw)) {
        fail(CALIBRATION_ERROR_CODES.EVENT_NOT_OBJECT, { index, kind: typeof raw });
    }
    assertNoUnsafeKeys(raw, 'event');
    assertOnlyKnownKeys(raw, EVENT_KEYS);

    const seq = requireIntegerInRange(raw.seq, 0, Number.MAX_SAFE_INTEGER, 'seq');
    const ts_ms = requireInteger(raw.ts_ms, 'ts_ms');

    if (typeof raw.category !== 'string') {
        fail(CALIBRATION_ERROR_CODES.UNKNOWN_CATEGORY, { index, kind: typeof raw.category });
    }
    const categoryIndex = CATEGORIES.indexOf(raw.category);
    if (categoryIndex < 0) {
        fail(CALIBRATION_ERROR_CODES.UNKNOWN_CATEGORY, { index });
    }

    const offset = ts_ms - scenario.window_start_ms;
    if (offset < 0 || offset >= scenario.window_duration_ms) {
        fail(CALIBRATION_ERROR_CODES.EVENT_OUT_OF_WINDOW, { index });
    }

    return {
        seq,
        ts_ms,
        category: CATEGORIES[categoryIndex],
        category_index: categoryIndex,
        bucket_index: Math.floor(offset / scenario.bucket_ms),
    };
}

/**
 * Comparador TOTAL y explícito sobre claves allowlisted. El `seq` entero resuelve
 * todo empate, así que el resultado no depende del orden de inserción.
 */
function compareEvents(a, b) {
    if (a.bucket_index !== b.bucket_index) return a.bucket_index - b.bucket_index;
    if (a.category_index !== b.category_index) return a.category_index - b.category_index;
    return a.seq - b.seq;
}

/**
 * Agrega eventos de telemetría contra un escenario. Puro: no muta las entradas.
 *
 * @param {Array<object>} events
 * @param {object} scenario
 * @returns {Readonly<object>} summary
 */
function aggregateEvents(events, scenario) {
    const sc = validateScenario(scenario);

    if (!Array.isArray(events)) {
        fail(CALIBRATION_ERROR_CODES.EVENTS_NOT_ARRAY, { kind: typeof events });
    }
    // La cota se chequea ANTES de ordenar o reducir: es una defensa de memoria y
    // CPU, y llegar al `sort` con 10M de eventos ya sería el problema.
    if (events.length > CALIBRATION_LIMITS.MAX_EVENTS) {
        fail(CALIBRATION_ERROR_CODES.TOO_MANY_EVENTS, {
            limit: CALIBRATION_LIMITS.MAX_EVENTS,
        });
    }

    const normalized = [];
    const seenSeq = new Set();
    for (let i = 0; i < events.length; i += 1) {
        const event = validateEvent(events[i], i, sc);
        if (seenSeq.has(event.seq)) {
            fail(CALIBRATION_ERROR_CODES.DUPLICATE_SEQUENCE, { index: i });
        }
        seenSeq.add(event.seq);
        normalized.push(event);
    }

    // `sort` sobre la copia normalizada: la entrada original nunca se reordena.
    normalized.sort(compareEvents);

    const counts = {};
    for (const category of CATEGORIES) counts[category] = 0;
    for (const event of normalized) counts[event.category] += 1;

    const physical = physicalOnly(normalized);
    const bucketCount = sc.window_duration_ms / sc.bucket_ms;
    const physicalByBucket = new Array(bucketCount).fill(0);
    for (const event of physical) physicalByBucket[event.bucket_index] += 1;

    let peakBucketIndex = 0;
    let peakReadsPerBucket = physicalByBucket[0];
    for (let i = 1; i < physicalByBucket.length; i += 1) {
        // `>` estricto: ante empate gana el bucket de índice MENOR. Determinístico.
        if (physicalByBucket[i] > peakReadsPerBucket) {
            peakReadsPerBucket = physicalByBucket[i];
            peakBucketIndex = i;
        }
    }

    const ordered = Object.freeze(normalized.map((event) => Object.freeze({
        seq: event.seq,
        ts_ms: event.ts_ms,
        category: event.category,
        bucket_index: event.bucket_index,
    })));

    return Object.freeze({
        scenario: sc,
        counts: Object.freeze(counts),
        physical_total: physical.length,
        buckets: Object.freeze({
            size_ms: sc.bucket_ms,
            count: bucketCount,
            physical_by_bucket: Object.freeze(physicalByBucket),
        }),
        peak: Object.freeze({
            bucket_index: peakBucketIndex,
            reads_per_bucket: peakReadsPerBucket,
            reads_per_second: round6(
                peakReadsPerBucket / (sc.bucket_ms / 1000), 'peak_reads_per_second',
            ),
        }),
        sequence: Object.freeze({
            total: ordered.length,
            first: ordered.length > 0 ? ordered[0] : null,
            last: ordered.length > 0 ? ordered[ordered.length - 1] : null,
        }),
        ordered,
    });
}

// -----------------------------------------------------------------------------
// CA-6/CA-8 · buildScenarioEvidence
// -----------------------------------------------------------------------------

function validateSummary(summary) {
    if (!isPlainObject(summary)) {
        fail(CALIBRATION_ERROR_CODES.SUMMARY_INVALID, { kind: typeof summary });
    }
    assertNoUnsafeKeys(summary, 'summary');
    assertOnlyKnownKeys(summary, SUMMARY_KEYS);
    for (const key of SUMMARY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(summary, key)) {
            fail(CALIBRATION_ERROR_CODES.SUMMARY_INVALID, { field: key });
        }
    }
    if (!isPlainObject(summary.counts) || !isPlainObject(summary.buckets)
        || !isPlainObject(summary.peak) || !isPlainObject(summary.sequence)) {
        fail(CALIBRATION_ERROR_CODES.SUMMARY_INVALID, { field: 'counts' });
    }
    if (!Number.isSafeInteger(summary.physical_total) || summary.physical_total < 0) {
        fail(CALIBRATION_ERROR_CODES.SUMMARY_INVALID, { field: 'physical_total' });
    }
    return {
        scenario: validateScenario(summary.scenario),
        counts: summary.counts,
        physical_total: summary.physical_total,
        buckets: summary.buckets,
        peak: summary.peak,
        sequence: summary.sequence,
    };
}

function validateHeadSha(value) {
    if (typeof value !== 'string') {
        fail(CALIBRATION_ERROR_CODES.INVALID_HEAD_SHA, {
            field: 'head_sha', kind: typeof value,
        });
    }
    if (value.length > CALIBRATION_LIMITS.MAX_STRING_LENGTH || !HEAD_SHA_RE.test(value)) {
        fail(CALIBRATION_ERROR_CODES.INVALID_HEAD_SHA, { field: 'head_sha' });
    }
    return value;
}

function validateProvenance(provenance) {
    if (!isPlainObject(provenance)) {
        fail(CALIBRATION_ERROR_CODES.PROVENANCE_INVALID, { kind: typeof provenance });
    }
    assertNoUnsafeKeys(provenance, 'provenance');
    assertOnlyKnownKeys(provenance, PROVENANCE_KEYS);
    return {
        head_sha: validateHeadSha(provenance.head_sha),
        generated_at_ms: requireIntegerInRange(
            provenance.generated_at_ms, 0, Number.MAX_SAFE_INTEGER, 'generated_at_ms',
        ),
    };
}

/**
 * Construye la evidencia CAMPO A CAMPO. Prohibido `spread` / `Object.assign`
 * sobre el input: la garantía primaria del CA-8 es esta proyección por
 * allowlist, no la redacción por patrón (que es la capa de atrás).
 *
 * Las claves se emiten en orden fijo, así que la serialización es estable.
 *
 * @param {object} summary salida de `aggregateEvents`
 * @param {{head_sha:string,generated_at_ms:number}} provenance
 * @returns {Readonly<object>}
 */
function buildScenarioEvidence(summary, provenance) {
    const s = validateSummary(summary);
    const p = validateProvenance(provenance);
    const sc = s.scenario;

    if (sc.window_duration_ms === 0) {
        fail(CALIBRATION_ERROR_CODES.NON_FINITE_RESULT, { field: 'window_duration_ms' });
    }

    // Extrapolación mensual: SOLO tráfico físico, redondeo hacia arriba
    // (conservador: no se subdimensiona la cuota). El numerador se chequea antes
    // de dividir porque un overflow silencioso sería una calibración engañosa.
    const numerator = s.physical_total * CALIBRATION_LIMITS.MONTH_MS;
    if (!Number.isSafeInteger(numerator)) {
        fail(CALIBRATION_ERROR_CODES.UNSAFE_INTEGER_RESULT, { field: 'physical_total' });
    }
    const raw = numerator / sc.window_duration_ms;
    if (!Number.isFinite(raw)) {
        fail(CALIBRATION_ERROR_CODES.NON_FINITE_RESULT, { field: 'physical_total' });
    }
    const monthly = Math.ceil(raw);
    if (!Number.isSafeInteger(monthly)) {
        fail(CALIBRATION_ERROR_CODES.UNSAFE_INTEGER_RESULT, { field: 'physical_total' });
    }

    // La fórmula se ARMA desde el enum importado: escribir el literal acá sería
    // la segunda fuente de verdad que el CA-2 prohíbe.
    const totalName = `${PHYSICAL_CATEGORY}_total`;
    const monthlyName = `monthly_${PHYSICAL_CATEGORY}s`;

    const counts = {};
    for (const category of CATEGORIES) {
        counts[category] = Number.isSafeInteger(s.counts[category]) ? s.counts[category] : 0;
    }

    const physicalByBucket = Array.isArray(s.buckets.physical_by_bucket)
        ? s.buckets.physical_by_bucket.map((n) => (Number.isSafeInteger(n) ? n : 0))
        : [];

    return deepFreeze({
        schema_version: EVIDENCE_SCHEMA_VERSION,
        head_sha: p.head_sha,
        generated_at_ms: p.generated_at_ms,
        scenario: {
            window_start_ms: sc.window_start_ms,
            window_duration_ms: sc.window_duration_ms,
            bucket_ms: sc.bucket_ms,
            concurrency: sc.concurrency,
            launches: sc.launches,
            distribution: sc.distribution,
            sequence_seed: sc.sequence_seed,
            unit: sc.unit,
        },
        counts,
        physical_total: s.physical_total,
        // G-3: el cero de una categoría excluida se distingue de "se perdió el
        // dato". Sin este rótulo, quien lee la evidencia no puede saber si las
        // categorías no físicas se excluyeron a propósito o por un bug.
        excluded_from_physical_metrics: EXCLUDED_CATEGORIES.slice(),
        buckets: {
            size_ms: s.buckets.size_ms,
            count: s.buckets.count,
            physical_by_bucket: physicalByBucket,
        },
        peak: {
            bucket_index: s.peak.bucket_index,
            reads_per_bucket: s.peak.reads_per_bucket,
            reads_per_second: s.peak.reads_per_second,
            unit: `${sc.unit}/second`,
            rounding: 'round_half_up_6dp',
        },
        sequence: {
            total: s.sequence.total,
            first: s.sequence.first === null ? null : {
                seq: s.sequence.first.seq,
                ts_ms: s.sequence.first.ts_ms,
                category: s.sequence.first.category,
                bucket_index: s.sequence.first.bucket_index,
            },
            last: s.sequence.last === null ? null : {
                seq: s.sequence.last.seq,
                ts_ms: s.sequence.last.ts_ms,
                category: s.sequence.last.category,
                bucket_index: s.sequence.last.bucket_index,
            },
        },
        monthly_physical_total: monthly,
        formula: `${monthlyName} = ceil(${totalName} * MONTH_MS / window_duration_ms)`,
        substitution: `ceil(${s.physical_total} * ${CALIBRATION_LIMITS.MONTH_MS} / ${sc.window_duration_ms})`,
        unit: `${sc.unit}/month`,
        rounding: 'ceil',
    });
}

// -----------------------------------------------------------------------------
// CA-7/CA-9 · runScenario
// -----------------------------------------------------------------------------

/** Clon estructural puro. La evidencia es JSON por construcción. */
function cloneEvidence(value) {
    return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
    if (Array.isArray(value)) {
        for (const item of value) deepFreeze(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        return Object.freeze(value);
    }
    return value;
}

function requirePort(port, field) {
    if (typeof port !== 'function') {
        fail(CALIBRATION_ERROR_CODES.PORT_MISSING, { field, kind: typeof port });
    }
    return port;
}

/**
 * Plan de ejecución determinístico. Sin `Math.random()`: la única fuente de
 * "azar" es `sequence_seed`, así que la misma semilla produce el mismo plan.
 */
function buildLaunchPlan(sc) {
    const order = new Array(sc.launches);
    for (let i = 0; i < sc.launches; i += 1) order[i] = i;

    if (sc.distribution !== 'sequential') {
        // Fisher-Yates con LCG (Numerical Recipes). Entero de 32 bits sin signo:
        // reproducible byte a byte en cualquier host.
        let state = sc.sequence_seed >>> 0;
        for (let i = order.length - 1; i > 0; i -= 1) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            const j = state % (i + 1);
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }
    }

    return order.map((launchIndex, position) => Object.freeze({
        launch_index: launchIndex,
        planned_offset_ms: sc.distribution === 'burst'
            ? 0
            : Math.floor((position * sc.window_duration_ms) / sc.launches),
    }));
}

async function readClock(clock, field) {
    let value;
    try {
        value = await clock();
    } catch (err) {
        // El error del puerto se DESCARTA entero: su `message` puede arrastrar
        // payload del vault. Sólo sobrevive un código propio.
        fail(CALIBRATION_ERROR_CODES.CLOCK_INVALID, { field });
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(CALIBRATION_ERROR_CODES.CLOCK_INVALID, { field, kind: typeof value });
    }
    return value;
}

/**
 * Ejecuta un escenario de calibración contra puertos inyectables y devuelve la
 * evidencia ya proyectada y redactada.
 *
 * Contrato de los puertos (mínimo privilegio, SEC-4):
 *   - `clock()`            → ms enteros no negativos, no decrecientes.
 *   - `resolveHead()`      → SHA de 40 hex. Nunca se interpola en un comando.
 *   - `driver(request)`    → `{ category }`. `request` sólo lleva
 *                            `{ launch_index, planned_offset_ms, seq }`.
 *   - `sink(evidence)`     → recibe la evidencia congelada y redactada. Su
 *                            retorno se DESCARTA.
 *
 * @param {{scenario:object,clock:Function,driver:Function,sink:Function,resolveHead:Function}} deps
 * @returns {Promise<Readonly<object>>}
 */
async function runScenario(deps) {
    if (!isPlainObject(deps)) {
        fail(CALIBRATION_ERROR_CODES.PORT_MISSING, { field: 'deps', kind: typeof deps });
    }
    const clock = requirePort(deps.clock, 'clock');
    const driver = requirePort(deps.driver, 'driver');
    const sink = requirePort(deps.sink, 'sink');
    const resolveHead = requirePort(deps.resolveHead, 'resolveHead');

    // 1. Fail-closed primero: un escenario inválido no llega a tocar ningún puerto.
    const sc = validateScenario(deps.scenario);

    // 2. Procedencia ANTES de medir: sin HEAD demostrable no se mide ni se emite.
    let headRaw;
    try {
        headRaw = await resolveHead();
    } catch (err) {
        fail(CALIBRATION_ERROR_CODES.RESOLVE_HEAD_FAILED, { field: 'resolveHead' });
    }
    const headSha = validateHeadSha(headRaw);

    // 3. Ejecución de launches. El reloj se lee en orden canónico ANTES de
    //    despachar el lote, así que el sello temporal no depende de cómo
    //    resuelvan las promesas del driver.
    const plan = buildLaunchPlan(sc);
    const events = [];
    let lastTs = -1;

    for (let start = 0; start < plan.length; start += sc.concurrency) {
        const batch = plan.slice(start, start + sc.concurrency);
        const stamps = [];
        for (let i = 0; i < batch.length; i += 1) {
            const ts = await readClock(clock, 'clock');
            if (ts < lastTs) {
                fail(CALIBRATION_ERROR_CODES.CLOCK_INVALID, { field: 'clock', index: start + i });
            }
            lastTs = ts;
            stamps.push(ts);
        }

        const results = await Promise.all(batch.map(async (item, i) => {
            try {
                return await driver({
                    launch_index: item.launch_index,
                    planned_offset_ms: item.planned_offset_ms,
                    seq: start + i,
                });
            } catch (err) {
                // Un canario en `err.message` del driver muere acá.
                fail(CALIBRATION_ERROR_CODES.DRIVER_FAILED, { field: 'driver', index: start + i });
            }
            return undefined;
        }));

        for (let i = 0; i < batch.length; i += 1) {
            const result = results[i];
            if (!isPlainObject(result)) {
                fail(CALIBRATION_ERROR_CODES.DRIVER_RESULT_INVALID, {
                    field: 'driver', index: start + i, kind: typeof result,
                });
            }
            assertNoUnsafeKeys(result, 'driver');
            if (typeof result.category !== 'string' || !CATEGORIES.includes(result.category)) {
                fail(CALIBRATION_ERROR_CODES.UNKNOWN_CATEGORY, {
                    field: 'driver', index: start + i,
                });
            }
            // Se proyecta SOLO la categoría: `seq` y `ts_ms` los pone el núcleo,
            // así que un driver no puede inyectar campos ni corromper el orden.
            events.push({ seq: start + i, ts_ms: stamps[i], category: result.category });
        }
    }

    // 4. Agregación y evidencia.
    const summary = aggregateEvents(events, sc);
    const generatedAt = await readClock(clock, 'generated_at_ms');
    const evidence = buildScenarioEvidence(summary, {
        head_sha: headSha,
        generated_at_ms: generatedAt,
    });

    // 5. Redacción por patrón como defensa EN PROFUNDIDAD (la garantía primaria
    //    ya la dio la proyección por allowlist de `buildScenarioEvidence`).
    const redacted = redactDeep(evidence);

    // Dos clones independientes: lo que reciba el sink no puede afectar lo que
    // se devuelve, ni siquiera si el sink muta su argumento.
    const forSink = deepFreeze(cloneEvidence(redacted));
    const forReturn = deepFreeze(cloneEvidence(redacted));

    try {
        await sink(forSink);
    } catch (err) {
        fail(CALIBRATION_ERROR_CODES.SINK_FAILED, { field: 'sink' });
    }

    return forReturn;
}

module.exports = {
    CALIBRATION_LIMITS,
    CALIBRATION_ERROR_CODES,
    CalibrationError,
    validateScenario,
    aggregateEvents,
    buildScenarioEvidence,
    runScenario,
};

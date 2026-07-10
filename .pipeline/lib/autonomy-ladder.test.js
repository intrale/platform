// .pipeline/lib/autonomy-ladder.test.js
// Tests node --test de la escalera de autonomía (#4576, CA-4/6/7/8/9).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('./audit-log');
const {
    bucketKey,
    recordHumanDecision,
    assertHumanSource,
    computeBucketStats,
    resolveBucket,
    revoke,
    ENTRY_TYPE,
    FUENTE_HUMANA,
    DAY_MS,
} = require('./autonomy-ladder');

// Crea un archivo de chain temporal único por test (sin Date.now/random en
// runtime del módulo: el nombre lo generamos acá, en el test, con contador).
let _seq = 0;
function tmpChain() {
    _seq += 1;
    const p = path.join(os.tmpdir(), `autonomy-ladder-test-${process.pid}-${_seq}.jsonl`);
    if (fs.existsSync(p)) fs.rmSync(p);
    return p;
}

const CFG = { umbral_acuerdo_pct: 90, muestras_minimas: 3, decay_dias: 30 };
const BUCKET = { fase: 'aprobacion', tipoIssue: 'area:pipeline' };
const T0 = 1_700_000_000_000; // timestamp base fijo para los tests.

// ----------------------------------------------------------------------------
// bucketKey determinístico
// ----------------------------------------------------------------------------

test('bucketKey es determinístico y estable', () => {
    assert.strictEqual(bucketKey(BUCKET), 'aprobacion::area:pipeline');
    assert.strictEqual(bucketKey({}), 'desconocida::desconocido');
});

// ----------------------------------------------------------------------------
// CA-6 · bucket bajo umbral NO auto-aprueba
// ----------------------------------------------------------------------------

test('CA-6 · bucket con menos de N muestras no está calibrado', () => {
    const chain = tmpChain();
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 1, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 2, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    const res = resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(res.calibrado, false);
    assert.match(res.razon, /sub-muestreo/);
});

test('CA-6 · bucket con N muestras y acuerdo ≥ X está calibrado', () => {
    const chain = tmpChain();
    for (let i = 0; i < 3; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    }
    const res = resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(res.calibrado, true);
    assert.strictEqual(res.acuerdo_pct, 100);
    assert.strictEqual(res.muestras, 3);
});

test('CA-6 · acuerdo por debajo del umbral no calibra aunque haya N muestras', () => {
    const chain = tmpChain();
    // 3 muestras: 2 acuerdo, 1 desacuerdo ⇒ 66.7% < 90%.
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 1, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 2, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 3, sugerencia: 'aprobar', decision: 'rechazar', operador: 'leitolarreta', nowMs: T0 });
    const res = resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(res.calibrado, false);
    assert.match(res.razon, /acuerdo insuficiente/);
});

// ----------------------------------------------------------------------------
// CA-9 · caída de acuerdo ⇒ auto-revoca a firma humana
// ----------------------------------------------------------------------------

test('CA-9 · un bucket calibrado se auto-revoca cuando cae el acuerdo', () => {
    const chain = tmpChain();
    // Arranca calibrado: 3/3 acuerdo.
    for (let i = 0; i < 3; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    }
    assert.strictEqual(resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 }).calibrado, true);

    // Llegan desacuerdos: 3/6 = 50% < 90% ⇒ recomputo auto-revoca.
    for (let i = 3; i < 6; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'rechazar', operador: 'leitolarreta', nowMs: T0 });
    }
    const res = resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(res.calibrado, false, 'debe auto-revocarse por caída de acuerdo');
});

// ----------------------------------------------------------------------------
// CA-8 · muestras fuera de la ventana de decay no cuentan
// ----------------------------------------------------------------------------

test('CA-8 · muestras fuera de la ventana de decay se descartan', () => {
    const chain = tmpChain();
    const viejo = T0 - 40 * DAY_MS; // 40 días atrás, fuera de decay_dias=30.
    // 3 muestras viejas (deberían descartarse) + 2 recientes.
    for (let i = 0; i < 3; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: viejo });
    }
    for (let i = 3; i < 5; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    }
    const stats = computeBucketStats({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(stats.muestras, 2, 'solo cuentan las 2 recientes');
    assert.strictEqual(stats.descartadas_decay, 3);
    // Con solo 2 muestras < N=3 ⇒ no calibra (las viejas no perpetúan autonomía).
    assert.strictEqual(resolveBucket({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 }).calibrado, false);
});

// ----------------------------------------------------------------------------
// CA-4 / CA-7 · acuerdo derivado SOLO de decisiones humanas registradas
// ----------------------------------------------------------------------------

test('CA-7 · una entry con fuente distinta a decision_humana no cuenta', () => {
    const chain = tmpChain();
    // Un agente intenta inyectar directamente una muestra con su propia fuente.
    audit.appendChained({
        file: chain,
        entry: {
            type: ENTRY_TYPE.MUESTRA,
            fuente: 'sugerencia_agente', // NO es decision_humana.
            bucket: bucketKey(BUCKET),
            sugerencia: 'aprobar',
            decision: 'aprobar',
            acuerdo: true,
            created_at: T0,
        },
    });
    const stats = computeBucketStats({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(stats.muestras, 0, 'la muestra del agente no cuenta (CA-7)');
});

test('CA-7 · recordHumanDecision exige operador humano (rechaza sin identidad)', () => {
    const chain = tmpChain();
    assert.throws(
        () => recordHumanDecision({ chainFile: chain, bucket: BUCKET, sugerencia: 'aprobar', decision: 'aprobar', nowMs: T0 }),
        /operador \(identidad humana\) requerido/
    );
});

test('CA-7 · assertHumanSource rechaza fuente de agente', () => {
    assert.throws(() => assertHumanSource({ fuente: 'sugerencia_agente' }), /solo decisiones humanas/);
    assert.doesNotThrow(() => assertHumanSource({ fuente: FUENTE_HUMANA }));
});

test('CA-7 · recordHumanDecision estampa fuente decision_humana no-overrideable', () => {
    const chain = tmpChain();
    // Aunque el caller intente pasar otra fuente, se ignora (no está en la firma).
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 1, sugerencia: 'aprobar', decision: 'rechazar', operador: 'leitolarreta', nowMs: T0, fuente: 'hackeada' });
    const entries = audit.readAll(chain);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].fuente, FUENTE_HUMANA);
    assert.strictEqual(entries[0].acuerdo, false, 'aprobar != rechazar ⇒ desacuerdo');
});

test('CA-4 · acuerdo_pct se computa solo de decisiones humanas del bucket', () => {
    const chain = tmpChain();
    // Bucket target: 2 acuerdo de 2.
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 1, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 2, sugerencia: 'rechazar', decision: 'rechazar', operador: 'leitolarreta', nowMs: T0 });
    // Otro bucket distinto (no debe contaminar).
    recordHumanDecision({ chainFile: chain, bucket: { fase: 'criterios', tipoIssue: 'app:client' }, issue: 3, sugerencia: 'aprobar', decision: 'rechazar', operador: 'leitolarreta', nowMs: T0 });
    const stats = computeBucketStats({ chainFile: chain, bucket: BUCKET, config: CFG, nowMs: T0 });
    assert.strictEqual(stats.muestras, 2);
    assert.strictEqual(stats.acuerdos, 2);
    assert.strictEqual(stats.acuerdo_pct, 100);
});

// ----------------------------------------------------------------------------
// CA-12 · revocación deja traza en el chain
// ----------------------------------------------------------------------------

test('CA-12 · revoke deja una entrada de revocación en el audit-log', () => {
    const chain = tmpChain();
    revoke({ chainFile: chain, bucket: BUCKET, operador: 'leitolarreta', motivo: 'sospecha de drift', nowMs: T0 });
    const entries = audit.readAll(chain);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].type, ENTRY_TYPE.REVOCACION);
    assert.strictEqual(entries[0].operador, 'leitolarreta');
    // La cadena sigue íntegra tras la revocación.
    assert.strictEqual(audit.verifyChain(chain).ok, true);
});

test('revoke exige operador humano', () => {
    const chain = tmpChain();
    assert.throws(() => revoke({ chainFile: chain, bucket: BUCKET, motivo: 'x', nowMs: T0 }), /operador/);
});

// ----------------------------------------------------------------------------
// Integridad de la chain tras muchas muestras
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Guardas de parámetros (ramas de error)
// ----------------------------------------------------------------------------

test('recordHumanDecision exige chainFile', () => {
    assert.throws(() => recordHumanDecision({ bucket: BUCKET, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta' }), /chainFile requerido/);
});

test('recordHumanDecision rechaza decisión inválida', () => {
    const chain = tmpChain();
    assert.throws(
        () => recordHumanDecision({ chainFile: chain, bucket: BUCKET, sugerencia: 'aprobar', decision: 'quiensabe', operador: 'leitolarreta', nowMs: T0 }),
        /decisión inválida/
    );
});

test('computeBucketStats tolera un chainFile ilegible (0 muestras)', () => {
    const fakeAudit = { readAll() { throw new Error('EIO'); } };
    const stats = computeBucketStats({ chainFile: 'x.jsonl', bucket: BUCKET, config: CFG, nowMs: T0, auditImpl: fakeAudit });
    assert.strictEqual(stats.muestras, 0);
    assert.strictEqual(stats.acuerdo_pct, 0);
});

test('resolveBucket sin config de umbral/N nunca calibra', () => {
    const chain = tmpChain();
    for (let i = 0; i < 5; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 });
    }
    const res = resolveBucket({ chainFile: chain, bucket: BUCKET, config: {}, nowMs: T0 });
    assert.strictEqual(res.calibrado, false);
});

test('revoke exige chainFile', () => {
    assert.throws(() => revoke({ bucket: BUCKET, operador: 'leitolarreta' }), /chainFile requerido/);
});

test('computeBucketStats sin decay configurado cuenta muestras viejas', () => {
    const chain = tmpChain();
    const viejo = T0 - 100 * DAY_MS;
    recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: 1, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: viejo });
    const stats = computeBucketStats({ chainFile: chain, bucket: BUCKET, config: {}, nowMs: T0 });
    assert.strictEqual(stats.muestras, 1, 'sin decay_dias, no se descarta por antigüedad');
    assert.strictEqual(stats.descartadas_decay, 0);
});

test('las muestras registradas mantienen la chain íntegra (tamper-evident)', () => {
    const chain = tmpChain();
    for (let i = 0; i < 5; i++) {
        recordHumanDecision({ chainFile: chain, bucket: BUCKET, issue: i, sugerencia: 'aprobar', decision: 'aprobar', operador: 'leitolarreta', nowMs: T0 + i });
    }
    assert.strictEqual(audit.verifyChain(chain).ok, true);
});

'use strict';

// =============================================================================
// task-contract.test.js — Wiring de fases para consumir el contrato (H3 · #4719)
//
// Cobertura mapeada a criterios de aceptación (#4719):
//   - CA-2: la fase `dev` deriva al ejecutor correcto según el contrato
//           (código vs provisioner) — deriveDevWiring/devNeedsWorktree.
//   - CA-3: una tarea de código existente mantiene el flujo actual sin cambios
//           (contrato ausente / `codigo` ⇒ modo código, worktree, no interceptado).
//   - CA-4: el caso "crear una base de datos" recorre las fases usando el
//           ejecutor de #4718 (dev→build→verificacion→linteo→aprobacion→entrega
//           determinísticos, con evidencia describe_table_round_trip).
//   - Robustez: lectura de contrato desde inline/archivo, contrato corrupto,
//               evidencia ausente en verificacion.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tc = require('../task-contract');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function codeContract(overrides = {}) {
    return {
        version: '0.1.0',
        tipo_entregable: 'codigo',
        definicion_de_listo: ['CA cumplidos', 'tests verdes'],
        evidencia_requerida: { tipo: 'pr_mas_build' },
        ejecutor: { tipo: 'dev_codigo', skill: 'backend-dev' },
        ...overrides,
    };
}

function dbContract(overrides = {}) {
    return {
        version: '0.1.0',
        tipo_entregable: 'recurso_provisionado',
        definicion_de_listo: ['La tabla existe y responde'],
        evidencia_requerida: { tipo: 'describe_table_round_trip' },
        ejecutor: { tipo: 'provisioner_infra' },
        recurso: {
            tipo: 'dynamodb_table',
            nombre: 'ordenes-demo',
            schema: {
                hashKey: { nombre: 'pk', tipo: 'S' },
                rangeKey: { nombre: 'sk', tipo: 'S' },
            },
        },
        ...overrides,
    };
}

// Directorio temporal aislado por test (sin Date.now/Math.random en el módulo).
let tmpCounter = 0;
function makeTmpPipeline() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
    const PIPELINE = path.join(base, '.pipeline');
    fs.mkdirSync(PIPELINE, { recursive: true });
    return { base, PIPELINE };
}

// -----------------------------------------------------------------------------
// readTaskContract — fuentes y retrocompat
// -----------------------------------------------------------------------------

test('readTaskContract: contrato ausente ⇒ null (retrocompat código)', () => {
    assert.equal(tc.readTaskContract({ issue: 123 }), null);
    assert.equal(tc.readTaskContract({ issue: 123, workData: {} }), null);
});

test('readTaskContract: prioriza el contrato inline del work-file', () => {
    const workData = { contrato_tarea: dbContract() };
    const c = tc.readTaskContract({ issue: 4719, workData });
    assert.equal(c.tipo_entregable, 'recurso_provisionado');
});

test('readTaskContract: lee archivo .pipeline/contracts/<issue>.yaml', () => {
    const { PIPELINE } = makeTmpPipeline();
    const dir = path.join(PIPELINE, 'contracts');
    fs.mkdirSync(dir, { recursive: true });
    const yamlDoc = 'tipo_entregable: recurso_provisionado\nejecutor:\n  tipo: provisioner_infra\n';
    fs.writeFileSync(path.join(dir, '999.yaml'), yamlDoc);
    const c = tc.readTaskContract({ PIPELINE, issue: 999 });
    assert.equal(c.tipo_entregable, 'recurso_provisionado');
});

test('readTaskContract: acepta wrapper contrato_tarea en el archivo', () => {
    const { PIPELINE } = makeTmpPipeline();
    const dir = path.join(PIPELINE, 'contracts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1000.json'), JSON.stringify({ contrato_tarea: dbContract() }));
    const c = tc.readTaskContract({ PIPELINE, issue: 1000 });
    assert.equal(c.ejecutor.tipo, 'provisioner_infra');
});

test('readTaskContractDetailed: contrato corrupto reporta error, NO asume código a ciegas', () => {
    const { PIPELINE } = makeTmpPipeline();
    const dir = path.join(PIPELINE, 'contracts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1001.json'), '{ esto no es json valido');
    const res = tc.readTaskContractDetailed({ PIPELINE, issue: 1001 });
    assert.equal(res.contract, null);
    assert.ok(res.error, 'debe reportar el error de parseo');
    assert.match(res.source, /file:/);
});

test('readTaskContract: issue no numérico no intenta leer archivo', () => {
    assert.equal(tc.readTaskContract({ PIPELINE: '/no/existe', issue: '../etc' }), null);
});

// -----------------------------------------------------------------------------
// deriveDevWiring / devNeedsWorktree — CA-2 + CA-3
// -----------------------------------------------------------------------------

test('CA-3: contrato ausente ⇒ modo código, crea worktree (idéntico a hoy)', () => {
    const w = tc.deriveDevWiring(null);
    assert.equal(w.mode, 'code');
    assert.equal(w.executorType, 'dev_codigo');
    assert.equal(w.needsWorktree, true);
    assert.equal(tc.devNeedsWorktree(null), true);
});

test('CA-3: contrato tipo_entregable codigo ⇒ modo código, worktree', () => {
    const w = tc.deriveDevWiring(codeContract());
    assert.equal(w.mode, 'code');
    assert.equal(w.needsWorktree, true);
    assert.equal(tc.isCodeContract(codeContract()), true);
});

test('CA-2: contrato provisioner ⇒ modo executor, NO crea worktree', () => {
    const w = tc.deriveDevWiring(dbContract());
    assert.equal(w.mode, 'executor');
    assert.equal(w.executorType, 'provisioner_infra');
    assert.equal(w.needsWorktree, false);
    assert.equal(tc.devNeedsWorktree(dbContract()), false);
    assert.equal(tc.isCodeContract(dbContract()), false);
});

test('phaseHandledByContract: sólo intercepta fases de código para contratos no-código', () => {
    // Código: nunca interceptado.
    for (const f of ['dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega']) {
        assert.equal(tc.phaseHandledByContract(f, codeContract()), false, `código no debe interceptar ${f}`);
        assert.equal(tc.phaseHandledByContract(f, null), false, `ausente no debe interceptar ${f}`);
    }
    // No-código: intercepta dev..entrega, NO validacion.
    for (const f of ['dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega']) {
        assert.equal(tc.phaseHandledByContract(f, dbContract()), true, `db debe interceptar ${f}`);
    }
    assert.equal(tc.phaseHandledByContract('validacion', dbContract()), false, 'validacion corre normal');
});

// -----------------------------------------------------------------------------
// runContractPhase — CA-4 (recorrido completo del caso base de datos)
// -----------------------------------------------------------------------------

test('CA-4: dev provisiona el recurso y produce evidencia describe_table_round_trip', async () => {
    const { PIPELINE } = makeTmpPipeline();
    const res = await tc.runContractPhase({
        fase: 'dev', contract: dbContract(), issue: 4719, PIPELINE,
        executorDeps: { now: () => 111 }, // driver in-memory por default
    });
    assert.equal(res.resultado, 'aprobado');
    assert.equal(res.contrato_ejecutor, 'provisioner_infra');
    assert.equal(res.contrato_evidencia_tipo, 'describe_table_round_trip');
    assert.equal(res.contrato_status, 'ok');
    // La evidencia quedó persistida.
    const ev = tc.readEvidence({ PIPELINE, issue: 4719 });
    assert.ok(ev, 'la evidencia debe persistirse a disco');
    assert.equal(ev.roundTrip.create, true);
    assert.equal(ev.roundTrip.confirmedGone, true);
});

test('CA-4: dev rechaza contrato de recurso inválido (errores como datos, no lanza)', async () => {
    const { PIPELINE } = makeTmpPipeline();
    const bad = dbContract({ recurso: { tipo: 'dynamodb_table', nombre: 'x' } }); // nombre corto + sin schema
    const res = await tc.runContractPhase({ fase: 'dev', contract: bad, issue: 5000, PIPELINE });
    assert.equal(res.resultado, 'rechazado');
    assert.match(res.motivo, /no completó/);
});

test('CA-4: build y linteo son no-op declaradas (aprobado + fase_noop)', async () => {
    for (const fase of ['build', 'linteo']) {
        const res = await tc.runContractPhase({ fase, contract: dbContract(), issue: 4719 });
        assert.equal(res.resultado, 'aprobado');
        assert.equal(res.fase_noop, true);
        assert.match(res.motivo, /no-op declarada/);
    }
});

test('CA-4: verificacion aprueba cuando la evidencia prueba el listo', async () => {
    const { PIPELINE } = makeTmpPipeline();
    // Primero dev genera y persiste evidencia.
    await tc.runContractPhase({ fase: 'dev', contract: dbContract(), issue: 4719, PIPELINE, executorDeps: { now: () => 1 } });
    const res = await tc.runContractPhase({ fase: 'verificacion', contract: dbContract(), issue: 4719, PIPELINE });
    assert.equal(res.resultado, 'aprobado');
    assert.equal(res.contrato_evidencia_tipo, 'describe_table_round_trip');
});

test('CA-4: verificacion rechaza cuando falta evidencia', async () => {
    const { PIPELINE } = makeTmpPipeline();
    const res = await tc.runContractPhase({ fase: 'verificacion', contract: dbContract(), issue: 4719, PIPELINE });
    assert.equal(res.resultado, 'rechazado');
    assert.match(res.motivo, /no se encontró evidencia/);
});

test('CA-4: aprobacion verifica definicion_de_listo contra la evidencia', async () => {
    const { PIPELINE } = makeTmpPipeline();
    await tc.runContractPhase({ fase: 'dev', contract: dbContract(), issue: 4719, PIPELINE, executorDeps: { now: () => 2 } });
    const res = await tc.runContractPhase({ fase: 'aprobacion', contract: dbContract(), issue: 4719, PIPELINE });
    assert.equal(res.resultado, 'aprobado');
});

test('CA-4: entrega cierra el entregable sin PR', async () => {
    const { PIPELINE } = makeTmpPipeline();
    await tc.runContractPhase({ fase: 'dev', contract: dbContract(), issue: 4719, PIPELINE, executorDeps: { now: () => 3 } });
    const res = await tc.runContractPhase({ fase: 'entrega', contract: dbContract(), issue: 4719, PIPELINE });
    assert.equal(res.resultado, 'aprobado');
    assert.equal(res.entregable_cerrado, true);
    assert.match(res.motivo, /sin PR/);
});

test('runContractPhase: guard rechaza contrato de código (debe ir por flujo cableado)', async () => {
    const res = await tc.runContractPhase({ fase: 'dev', contract: codeContract(), issue: 4719 });
    assert.equal(res.resultado, 'rechazado');
    assert.match(res.motivo, /flujo cableado/);
});

// -----------------------------------------------------------------------------
// evidenceProvesReady — unidad
// -----------------------------------------------------------------------------

test('evidenceProvesReady: round-trip completo prueba, incompleto no', () => {
    assert.equal(tc.evidenceProvesReady({ roundTrip: { create: true, read: true, delete: true, confirmedGone: true } }), true);
    assert.equal(tc.evidenceProvesReady({ roundTrip: { create: true, read: false, delete: true, confirmedGone: true } }), false);
    assert.equal(tc.evidenceProvesReady(null), false);
    assert.equal(tc.evidenceProvesReady({ status: 'ok' }), true);
    assert.equal(tc.evidenceProvesReady({ status: 'failed' }), false);
});

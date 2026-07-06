'use strict';

// Tests del gate de entregable obligatorio del PO al cerrar Definición (#4502).
// Cubren: retención en enforce sin entregable ni excepción, promoción con
// entregable presente, registro autoritativo de excepción desde el input del
// YAML, fail-abierto en dry-run, kill switch, y determinismo del clock.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('./deliverable-gate');
const idx = require('./deliverable-index');

// Root temporal aislado por corrida — el store cae en <root>/deliverables/.
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dg-test-'));
}

const TS = '2026-07-06T10:00:00.000Z';
const ENFORCE = { deliverable_gate: { enabled: true, gate_mode: 'enforce' } };
const DRYRUN = { deliverable_gate: { enabled: true, gate_mode: 'dry-run' } };

// -----------------------------------------------------------------------------
// retiene cuando no hay entregable del po ni excepción (enforce)
// -----------------------------------------------------------------------------

test('retiene cuando no hay entregable del po ni excepción (enforce)', () => {
    const root = tmpRoot();
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: null, config: ENFORCE, pipelineRoot: root,
    });
    assert.equal(res.decision, 'retain');
    assert.equal(res.effective_decision, 'retain');
    assert.equal(res.gate_mode, 'enforce');
    assert.equal(res.hasDeliverable, false);
    assert.equal(res.hasException, false);
});

// -----------------------------------------------------------------------------
// promueve cuando existe entregable del po
// -----------------------------------------------------------------------------

test('promueve cuando existe entregable del po', () => {
    const root = tmpRoot();
    idx.upsertDeliverableIndex({
        issue: '4502', fase: 'criterios', agente: 'po', tipo: 'document',
        path: '.pipeline/assets/docs/4502/po-criterios-4502.md', bytes: 100,
        timestamp: TS, pipelineRoot: root,
    });
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: null, config: ENFORCE, pipelineRoot: root,
    });
    assert.equal(res.decision, 'promote');
    assert.equal(res.effective_decision, 'promote');
    assert.equal(res.hasDeliverable, true);
    assert.equal(res.reason, 'deliverable-present');
});

// -----------------------------------------------------------------------------
// promueve registrando excepción autoritativa desde el input del YAML
// -----------------------------------------------------------------------------

test('promueve registrando excepción autoritativa cuando el YAML trae entregable_no_aplica + motivo legible', () => {
    const root = tmpRoot();
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: {
            entregable_no_aplica: true,
            motivo_no_aplica: 'El issue es un chore de infra sin criterios de negocio para documentar.',
        },
        config: ENFORCE, pipelineRoot: root, clock: () => TS,
    });
    assert.equal(res.decision, 'promote');
    assert.equal(res.effective_decision, 'promote');
    assert.equal(res.reason, 'exception-registered');
    assert.equal(res.hasException, true);

    // La entry tipo:'exception' quedó persistida en el store, sin path, con motivo.
    const entries = idx.queryByPhase('4502', 'criterios', { pipelineRoot: root });
    const ex = entries.find((e) => e.agente === 'po' && e.tipo === 'exception');
    assert.ok(ex, 'debe existir la entry de excepción');
    assert.equal(ex.path, null);
    assert.ok(ex.motivo.includes('chore de infra'), `motivo persistido: ${ex.motivo}`);
    assert.equal(ex.timestamp, TS, 'timestamp determinístico desde clock inyectable');
});

test('motivo vacío o demasiado corto NO habilita la excepción (retiene en enforce)', () => {
    const root = tmpRoot();
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: { entregable_no_aplica: true, motivo_no_aplica: 'n/a' },
        config: ENFORCE, pipelineRoot: root, clock: () => TS,
    });
    assert.equal(res.decision, 'retain');
    assert.equal(res.effective_decision, 'retain');
    // No se escribió ninguna excepción.
    const entries = idx.queryByPhase('4502', 'criterios', { pipelineRoot: root });
    assert.equal(entries.filter((e) => e.tipo === 'exception').length, 0);
});

// -----------------------------------------------------------------------------
// dry-run nunca bloquea (fail-abierto)
// -----------------------------------------------------------------------------

test('dry-run nunca bloquea: decision retain pero effective_decision promote', () => {
    const root = tmpRoot();
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: null, config: DRYRUN, pipelineRoot: root,
    });
    assert.equal(res.decision, 'retain');
    assert.equal(res.effective_decision, 'promote');
    assert.equal(res.gate_mode, 'dry-run');
});

// -----------------------------------------------------------------------------
// kill switch / enabled:false → promote sin tocar el store
// -----------------------------------------------------------------------------

test('kill switch / enabled:false → promote sin tocar el store', () => {
    const root = tmpRoot();
    for (const cfg of [
        { deliverable_gate: { enabled: false, gate_mode: 'enforce' } },
        { deliverable_gate: { enabled: true, kill_switch: true, gate_mode: 'enforce' } },
        {},
    ]) {
        const res = gate.evaluateDeliverableGate({
            issue: '4502', fase: 'criterios', agente: 'po',
            poResult: { entregable_no_aplica: true, motivo_no_aplica: 'motivo suficientemente largo para pasar el umbral' },
            config: cfg, pipelineRoot: root, clock: () => TS,
        });
        assert.equal(res.decision, 'promote');
        assert.equal(res.effective_decision, 'promote');
        assert.equal(res.gate_mode, 'disabled');
    }
    // El store nunca fue tocado (ni siquiera con el input de excepción presente).
    const file = idx.indexPathFor('4502', { pipelineRoot: root });
    assert.equal(fs.existsSync(file), false, 'el kill switch no debe escribir el store');
});

// -----------------------------------------------------------------------------
// una excepción ya registrada promueve sin re-escribir
// -----------------------------------------------------------------------------

test('si ya hay excepción registrada, promueve por hasException', () => {
    const root = tmpRoot();
    idx.upsertException({
        issue: '4502', fase: 'criterios', agente: 'po',
        motivo: 'excepción previamente registrada por el pulpo', timestamp: TS, pipelineRoot: root,
    });
    const res = gate.evaluateDeliverableGate({
        issue: '4502', fase: 'criterios', agente: 'po',
        poResult: null, config: ENFORCE, pipelineRoot: root,
    });
    assert.equal(res.decision, 'promote');
    assert.equal(res.hasException, true);
});

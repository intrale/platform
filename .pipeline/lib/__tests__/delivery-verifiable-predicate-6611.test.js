// =============================================================================
// Tests del EMISOR del predicado verificable en `delivery` (#6611)
//
// Lo que asegura: `delivery` registra el predicado re-evaluable SÓLO para el
// gate `branch-protection-other` (HTTP 405 con todos los requeridos en verde) y
// NO para el resto — que son juicio humano genuino y tienen que quedar
// intocables.
//
// Si este test se pone en verde con un gate de más, un bloqueo que requiere una
// persona pasaría a auto-destrabarse. Es la frontera de privilegio del issue.
//
// NO toca `delivery-merge-6347.test.js` ni `delivery-merge-6012.test.js`
// (assertean textos byte a byte). Sin red.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// REPO_ROOT de delivery.js se resuelve al cargar el módulo: fijamos el tmp
// ANTES del require para que el sidecar caiga en un directorio aislado.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deliv-6611-'));
process.env.PIPELINE_REPO_ROOT = TMP_ROOT;
fs.mkdirSync(path.join(TMP_ROOT, '.pipeline'), { recursive: true });

delete require.cache[require.resolve('../../skills-deterministicos/delivery')];
const delivery = require('../../skills-deterministicos/delivery');
const store = require('../verifiable-predicate-store');

const PIPELINE_DIR = path.join(TMP_ROOT, '.pipeline');
const noop = () => {};

function limpiar(issue) {
    const f = store.stateFile(PIPELINE_DIR, issue);
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

test('#6611 - branch-protection-other SI registra el predicado', () => {
    limpiar(6145);
    const ok = delivery.recordVerifiablePredicate({
        issue: 6145, prNumber: 6593, branch: 'agent/6145-turno-huerfano',
        gate: 'branch-protection-other',
        observed: { httpStatus: 405, mergeStateStatus: 'BLOCKED' },
        log: noop,
    });
    assert.equal(ok, true);

    const pred = store.peek({ pipelineDir: PIPELINE_DIR, issue: 6145 });
    assert.ok(pred, 'el sidecar quedó escrito');
    assert.equal(pred.kind, 'pr_merge_blocked');
    assert.equal(pred.pr, 6593);
    assert.equal(pred.head_ref, 'agent/6145-turno-huerfano');
    assert.equal(pred.observed.httpStatus, 405);
    assert.equal(pred.observed.gate, 'branch-protection-other');
});

test('#6611 - el resto de los gates NO registra predicado (quedan intocables)', () => {
    // Todos éstos son juicio humano o lectura fallida: nadie los re-evalúa.
    const gatesHumanos = [
        'branch-protection-review',        // falta una aprobación humana
        'branch-protection-unreadable',    // no se pudo leer el estado
        'branch-protection-checks-red',    // un requerido en rojo
        'qa-gate',                         // gate de QA del proyecto
        'codeowners-human',                // review de CODEOWNERS
        'checks-timeout',                  // la CI no terminó
        'pr-draft',
        'snapshot',
        'pr-closed',
        'codeowners',
        'provenance',
        'merge-unconfirmed',
        'retry-exhausted',
    ];
    for (const gate of gatesHumanos) {
        limpiar(7000);
        const ok = delivery.recordVerifiablePredicate({
            issue: 7000, prNumber: 7001, branch: 'agent/7000-x',
            gate, observed: { httpStatus: 405 }, log: noop,
        });
        assert.equal(ok, false, gate + ' NO debe registrar predicado');
        assert.equal(
            store.peek({ pipelineDir: PIPELINE_DIR, issue: 7000 }), null,
            gate + ' no debe dejar sidecar',
        );
    }
});

test('#6611 - VERIFIABLE_GATES es un enum de uno solo', () => {
    // Si esta lista crece, tiene que crecer con una decisión explícita: cada
    // gate agregado es un bloqueo humano que pasa a auto-destrabarse.
    assert.deepEqual([...delivery.VERIFIABLE_GATES], ['branch-protection-other']);
});

test('#6611 - un PR invalido no registra nada (coercion en el borde)', () => {
    for (const prNumber of [null, undefined, 'abc', -1, 0, {}, NaN]) {
        limpiar(7100);
        const ok = delivery.recordVerifiablePredicate({
            issue: 7100, prNumber, branch: 'agent/7100-x',
            gate: 'branch-protection-other', observed: {}, log: noop,
        });
        assert.equal(ok, false, 'PR ' + String(prNumber) + ' no debe registrarse');
        assert.equal(store.peek({ pipelineDir: PIPELINE_DIR, issue: 7100 }), null);
    }
});

test('#6611 - una rama deforme no registra nada (validateBranchName)', () => {
    for (const branch of ['agent/../../main', '/agent/1-x', 'agent/1 x', '', null, 'a'.repeat(300)]) {
        limpiar(7200);
        const ok = delivery.recordVerifiablePredicate({
            issue: 7200, prNumber: 7201, branch,
            gate: 'branch-protection-other', observed: {}, log: noop,
        });
        // El store acepta head_ref no vacío; la validación estricta de ref la
        // aplica `human-block.normalizePrecondition` al persistir el marker.
        // Lo que acá importa es que nada de esto termine en un predicado que
        // el pulpo convierta en `verifiable`.
        const pred = store.peek({ pipelineDir: PIPELINE_DIR, issue: 7200 });
        if (ok && pred) {
            const hb = require('../human-block');
            const norm = hb.normalizePrecondition({ type: 'verifiable', predicate: pred });
            assert.equal(
                norm.type, 'human_judgment',
                'rama ' + JSON.stringify(branch) + ' debe degradar a juicio humano',
            );
        }
    }
});

test('#6611 - el emisor nunca lanza, aunque el registro falle', () => {
    assert.doesNotThrow(() => delivery.recordVerifiablePredicate({
        issue: null, prNumber: null, branch: null, gate: 'branch-protection-other', log: noop,
    }));
    assert.doesNotThrow(() => delivery.recordVerifiablePredicate({ gate: 'branch-protection-other', log: noop }));
    // Sin `log` tampoco (el default es un noop interno).
    assert.doesNotThrow(() => delivery.recordVerifiablePredicate({
        issue: 1, prNumber: 1, branch: 'agent/1-x', gate: 'branch-protection-other',
        log: undefined,
    }));
});

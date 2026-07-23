'use strict';

// =============================================================================
// parallel-lane-classifier.test.js — Carril paralelo a nivel dispatch (#4767).
//   node --test .pipeline/test/parallel-lane-classifier.test.js
//
// Cubre las CA de la parte (c):
//   - CA-1: un bloqueo mecánico NO congela (queda en `resueltos`, excluible del
//     freeze).
//   - CA-2: un bloqueo de decisión NO se auto-resuelve (fail-closed).
//   - CA-3 / SR-7: audit-before-mutate; si el audit falla → NO se auto-resuelve.
//   - CA-6 / SR-sec-5: `source:'security'` fuerza decisión aun si el clasificador
//     base devolviera mecánico.
//   - gate-reject por defecto (clasificador real de #4765) → decisión.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const lane = require('../lib/parallel-lane-classifier');

// Fakes inyectables.
function fakeClassify(category, reason = 'fake', extra = {}) {
    return () => ({ category, reason, delegateTo: extra.delegateTo || null, evidence: null });
}
function fakeAuditOk() {
    const calls = [];
    return { fn: (p) => { calls.push(p); return { ok: true, hash_self: 'abc' }; }, calls };
}
function fakeAuditFail() {
    const calls = [];
    return { fn: (p) => { calls.push(p); return { ok: false, error: 'O_EXCL' }; }, calls };
}
function fakeAuditThrow() {
    const calls = [];
    return { fn: (p) => { calls.push(p); throw new Error('hash-chain roto'); }, calls };
}
function fakeNotify() {
    const calls = [];
    return { fn: (action, opts) => { calls.push({ action, opts }); return { proceed: true }; }, calls };
}

// -----------------------------------------------------------------------------
// isSecuritySource / toBlock (unidad)
// -----------------------------------------------------------------------------

test('isSecuritySource detecta source y skill de seguridad', () => {
    assert.equal(lane.isSecuritySource({ source: 'security' }), true);
    assert.equal(lane.isSecuritySource({ source: 'SECURITY ' }), true);
    assert.equal(lane.isSecuritySource({ skill: 'security' }), true);
    assert.equal(lane.isSecuritySource({ skill: 'dev', source: 'gate' }), false);
    assert.equal(lane.isSecuritySource(null), false);
});

test('toBlock deriva kind de rebote_categoria; default gate-reject', () => {
    assert.equal(lane.toBlock({ rebote_categoria: 'merge-conflict', paths: ['a.js'] }).kind, 'merge-conflict');
    assert.equal(lane.toBlock({ rebote_categoria: 'desync' }).kind, 'desync');
    assert.equal(lane.toBlock({ rebote_categoria: 'human_block' }).kind, 'gate-reject');
    assert.equal(lane.toBlock({}).kind, 'gate-reject');
    // security propaga source al gate-reject.
    assert.equal(lane.toBlock({ skill: 'security' }).source, 'security');
});

// -----------------------------------------------------------------------------
// classifyMotivos
// -----------------------------------------------------------------------------

test('classifyMotivos: mecánico va a mecanicos, decisión a decisiones', () => {
    const motivos = [{ motivo: 'x', rebote_categoria: 'merge-conflict', paths: ['a.js'] }];
    const r = lane.classifyMotivos(motivos, { classifyBlock: fakeClassify('mecanico') });
    assert.equal(r.mecanicos.length, 1);
    assert.equal(r.decisiones.length, 0);
});

test('classifyMotivos: SR-sec-5 — security fuerza decisión aun si el clasificador dice mecánico', () => {
    const motivos = [{ motivo: 'reject de seguridad', skill: 'security', rebote_categoria: 'merge-conflict' }];
    // El fake clasificaría mecánico, pero el guard de seguridad gana.
    const r = lane.classifyMotivos(motivos, { classifyBlock: fakeClassify('mecanico') });
    assert.equal(r.mecanicos.length, 0);
    assert.equal(r.decisiones.length, 1);
    assert.match(r.decisiones[0].cls.reason, /SR-sec-5/);
});

test('classifyMotivos: excepción del clasificador → decisión (fail-closed SR-8)', () => {
    const motivos = [{ motivo: 'x', rebote_categoria: 'desync' }];
    const boom = () => { throw new Error('kaboom'); };
    const r = lane.classifyMotivos(motivos, { classifyBlock: boom });
    assert.equal(r.mecanicos.length, 0);
    assert.equal(r.decisiones.length, 1);
    assert.match(r.decisiones[0].cls.reason, /excepcion/);
});

test('classifyMotivos: gate-reject con clasificador REAL de #4765 → decisión', () => {
    // Sin fake: usa el block-classifier real. Un gate-reject por defecto es decisión.
    const r = lane.classifyMotivos([{ motivo: 'gate rechazó', rebote_categoria: null }]);
    assert.equal(r.mecanicos.length, 0);
    assert.equal(r.decisiones.length, 1);
});

// -----------------------------------------------------------------------------
// runParallelLane — audit-before-mutate + resueltos
// -----------------------------------------------------------------------------

test('CA-1: mecánico auditado OK → queda en resueltos (excluible del freeze)', () => {
    const audit = fakeAuditOk();
    const notify = fakeNotify();
    const m = { motivo: 'conflicto en allowlist', rebote_categoria: 'merge-conflict', paths: ['.pipeline/x.js'] };
    const r = lane.runParallelLane([m], { issue: 4767, headOid: 'deadbeef' }, {
        classifyBlock: fakeClassify('mecanico', 'todo en allowlist', { delegateTo: 'delivery.classifyConflictFiles' }),
        safeAppendAction: audit.fn,
        enforceActionPolicy: notify.fn,
    });
    assert.equal(r.resueltos.has(m), true);
    // Audit ANTES de notificar, con valores reales resueltos (SR-7).
    assert.equal(audit.calls.length, 1);
    const entry = audit.calls[0];
    assert.equal(entry.action, 'block-autoresolve');
    assert.equal(entry.authorizedBy, 'kernel:auto');
    assert.equal(entry.extra.commit, 'deadbeef');
    assert.equal(entry.extra.strategy, 'delivery.classifyConflictFiles');
    assert.deepEqual(entry.extra.paths, ['.pipeline/x.js']);
    assert.equal(entry.extra.issue, 4767);
    // Notificación una sola vez.
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].action, 'block-autoresolve');
});

test('CA-3 / SR-7: audit ok:false → NO se auto-resuelve (fail-closed, no muta)', () => {
    const audit = fakeAuditFail();
    const notify = fakeNotify();
    const m = { motivo: 'conflicto', rebote_categoria: 'merge-conflict', paths: ['x.js'] };
    const r = lane.runParallelLane([m], { issue: 1 }, {
        classifyBlock: fakeClassify('mecanico'),
        safeAppendAction: audit.fn,
        enforceActionPolicy: notify.fn,
    });
    assert.equal(r.resueltos.has(m), false);        // no auto-resuelto
    assert.equal(audit.calls.length, 1);            // se intentó auditar
    assert.equal(notify.calls.length, 0);           // no se notifica lo no resuelto
    // Cae a decisión → el caller lo escala fail-closed.
    assert.ok(r.decisiones.some(d => d.motivo === m && /audit-before-mutate/.test(d.cls.reason)));
});

test('SR-7: audit que LANZA → NO se auto-resuelve (defensa, fail-closed)', () => {
    const audit = fakeAuditThrow();
    const m = { motivo: 'conflicto', rebote_categoria: 'merge-conflict' };
    const r = lane.runParallelLane([m], { issue: 1 }, {
        classifyBlock: fakeClassify('mecanico'),
        safeAppendAction: audit.fn,
        enforceActionPolicy: fakeNotify().fn,
    });
    assert.equal(r.resueltos.has(m), false);
});

test('CA-2: bloqueo de decisión NO se auto-resuelve (no audita, no notifica)', () => {
    const audit = fakeAuditOk();
    const notify = fakeNotify();
    const m = { motivo: 'necesita criterio humano' };
    const r = lane.runParallelLane([m], { issue: 1 }, {
        classifyBlock: fakeClassify('decision'),
        safeAppendAction: audit.fn,
        enforceActionPolicy: notify.fn,
    });
    assert.equal(r.resueltos.size, 0);
    assert.equal(audit.calls.length, 0);
    assert.equal(notify.calls.length, 0);
});

test('CA-6 / SR-sec-5: security NUNCA entra al carril mecánico aunque el clasificador diga mecánico', () => {
    const audit = fakeAuditOk();
    const m = { motivo: 'reject seguridad', source: 'security', rebote_categoria: 'merge-conflict' };
    const r = lane.runParallelLane([m], { issue: 1 }, {
        classifyBlock: fakeClassify('mecanico'),
        safeAppendAction: audit.fn,
        enforceActionPolicy: fakeNotify().fn,
    });
    assert.equal(r.resueltos.has(m), false);
    assert.equal(audit.calls.length, 0);            // nunca se auditó una auto-resolución de seguridad
});

test('mixto: mecánico se resuelve, decisión queda para el freeze (carril parcial)', () => {
    const audit = fakeAuditOk();
    const notify = fakeNotify();
    const mMec = { motivo: 'conflicto allowlist', rebote_categoria: 'merge-conflict', paths: ['a'] };
    const mDec = { motivo: 'necesita humano', skill: 'security' };
    let n = 0;
    const r = lane.runParallelLane([mMec, mDec], { issue: 9 }, {
        // El primero mecánico, el segundo es security → forzado a decisión antes de clasificar.
        classifyBlock: () => (++n, { category: 'mecanico', reason: 'ok' }),
        safeAppendAction: audit.fn,
        enforceActionPolicy: notify.fn,
    });
    assert.equal(r.resueltos.has(mMec), true);
    assert.equal(r.resueltos.has(mDec), false);
    // Notificación agregada una sola vez pese a múltiples motivos.
    assert.equal(notify.calls.length, 1);
});

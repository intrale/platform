'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runStuckPhaseReconciler, buildIssuesContext } = require('./stuck-phase-reconciler-runner');

const NOW = 1_800_000_000_000;
const OLD = NOW - 30 * 60 * 1000;
const APROB = { resultado: 'aprobado' };
const CANCEL = { cancelado_por: 'fast-fail-rebote' };

// FS mock: fs[pipeline][fase][state] = { 'issue.skill': {yaml, mtimeMs} }
function makeDeps(fs, over = {}) {
    const calls = { requeue: [], escalate: [], notify: [], audit: [] };
    const retryState = over.retryState || {};
    const deps = {
        calls,
        nowMs: NOW,
        parallelPhases: over.parallelPhases || [
            { pipeline: 'desarrollo', fase: 'validacion' },
            { pipeline: 'desarrollo', fase: 'aprobacion' },
        ],
        requiredSkillsFor: over.requiredSkillsFor || ((p, f) => ({
            validacion: ['po', 'ux', 'guru'],
            aprobacion: ['review', 'po', 'ux', 'architect'],
        }[f] || [])),
        listPhaseFiles: (p, f, state) => {
            const d = (((fs[p] || {})[f] || {})[state]) || {};
            return Object.keys(d).map((name) => ({ name, mtimeMs: d[name].mtimeMs }));
        },
        readYaml: (p, f, state, name) => (((fs[p] || {})[f] || {})[state] || {})[name].yaml,
        issueLiveElsewhere: over.issueLiveElsewhere || (() => false),
        hasNeedsHuman: over.hasNeedsHuman || (() => false),
        isAllowed: over.isAllowed || (() => true),
        isIssueOpen: over.isIssueOpen || (() => true),
        isPaused: over.isPaused || (() => false),
        livenessOk: over.livenessOk || (() => true), // por default trabajando cuenta vivo
        loadRetryState: () => retryState,
        saveRetryState: (s) => { deps._savedRetry = s; },
        requeueWorkItem: (p, f, s, i) => calls.requeue.push(`${i}.${s}@${f}`),
        escalate: (i, r) => calls.escalate.push({ i, r }),
        workItemExists: over.workItemExists || (() => false),
        notify: (m) => calls.notify.push(m),
        audit: (rec) => calls.audit.push(rec),
    };
    return deps;
}

test('E2E #4507: ux faltante en aprobacion → requeue ux', () => {
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: OLD } },
        archivado: {
            '4507.po': { yaml: APROB, mtimeMs: OLD },
            '4507.architect': { yaml: APROB, mtimeMs: OLD },
        },
    } } };
    const deps = makeDeps(fs);
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 1);
    assert.deepEqual(deps.calls.requeue, ['4507.ux@aprobacion']);
    assert.equal(deps.calls.escalate.length, 0);
    assert.equal(deps._savedRetry['4507|aprobacion'].ux, 1, 'contador de reintento persistido');
});

test('E2E #4534: po/ux cancelados en validacion → escalate (no requeue)', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '4534.guru': { yaml: APROB, mtimeMs: OLD } },
        procesado: {
            '4534.po': { yaml: CANCEL, mtimeMs: OLD },
            '4534.ux': { yaml: CANCEL, mtimeMs: OLD },
        },
    } } };
    const deps = makeDeps(fs);
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.escalated, 1);
    assert.equal(res.requeued, 0);
    assert.equal(deps.calls.escalate[0].i, '4534');
    assert.equal(deps.calls.requeue.length, 0);
});

test('E2E cross-phase: issue vivo en otra fase → none (no doble-track)', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '4534.guru': { yaml: APROB, mtimeMs: OLD } },
        procesado: { '4534.po': { yaml: CANCEL, mtimeMs: OLD }, '4534.ux': { yaml: CANCEL, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs, { issueLiveElsewhere: (i) => String(i) === '4534' });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0);
    assert.equal(res.escalated, 0);
});

test('E2E orphan trabajando: marker de agente muerto NO cuenta vivo → cura el faltante', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '200.po': { yaml: APROB, mtimeMs: OLD }, '200.guru': { yaml: APROB, mtimeMs: OLD } },
        trabajando: { '200.ux': { yaml: {}, mtimeMs: OLD } }, // ux "trabajando" pero huérfano
    } } };
    // livenessOk=false → el trabajando huérfano no cuenta → ux queda missing → requeue
    const deps = makeDeps(fs, { livenessOk: () => false });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 1);
    assert.deepEqual(deps.calls.requeue, ['200.ux@validacion']);
});

test('E2E orphan trabajando VIVO: si el agente está vivo → none (no interferir)', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '200.po': { yaml: APROB, mtimeMs: OLD }, '200.guru': { yaml: APROB, mtimeMs: OLD } },
        trabajando: { '200.ux': { yaml: {}, mtimeMs: NOW - 1000 } },
    } } };
    const deps = makeDeps(fs, { livenessOk: () => true }); // agente vivo
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0);
    assert.equal(res.skipped >= 1, true);
});

test('E2E cap reintentos persistido: ux ya en 2 → escalate en vez de requeue', () => {
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: OLD } },
        archivado: { '4507.po': { yaml: APROB, mtimeMs: OLD }, '4507.architect': { yaml: APROB, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs, { retryState: { '4507|aprobacion': { ux: 2 } } });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.escalated, 1);
    assert.equal(res.requeued, 0);
    assert.match(deps.calls.escalate[0].r, /tope de reintentos/);
});

test('E2E pausa: no re-encola', () => {
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: OLD } },
        archivado: { '4507.po': { yaml: APROB, mtimeMs: OLD }, '4507.architect': { yaml: APROB, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs, { isPaused: () => true });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0);
});

test('E2E idempotente: si el work-item ya existe, no re-escribe', () => {
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: OLD } },
        archivado: { '4507.po': { yaml: APROB, mtimeMs: OLD }, '4507.architect': { yaml: APROB, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs, { workItemExists: () => true });
    runStuckPhaseReconciler(deps, {});
    assert.equal(deps.calls.requeue.length, 0);
});

test('E2E issue CERRADO con residuo → none (no escala issues cerrados)', () => {
    const fs = { desarrollo: { validacion: {
        archivado: { '4510.po': { yaml: {}, mtimeMs: OLD }, '4510.ux': { yaml: {}, mtimeMs: OLD }, '4510.guru': { yaml: {}, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs, { isIssueOpen: () => false }); // cerrado
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.escalated, 0);
    assert.equal(res.requeued, 0);
});
test('E2E completo: nada varado → sin acciones', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '300.po': { yaml: APROB, mtimeMs: OLD }, '300.ux': { yaml: APROB, mtimeMs: OLD }, '300.guru': { yaml: APROB, mtimeMs: OLD } },
    } } };
    const deps = makeDeps(fs);
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0);
    assert.equal(res.escalated, 0);
});

test('buildIssuesContext: no incluye issues sin deliverables (solo pendiente)', () => {
    const fs = { desarrollo: { validacion: {
        pendiente: { '400.po': { yaml: {}, mtimeMs: NOW } },
    } } };
    const deps = makeDeps(fs);
    const ctx = buildIssuesContext(deps);
    assert.equal(ctx.length, 0, 'un issue solo-pendiente lo maneja el flujo normal');
});

test('E2E deliverable reciente → none (ventana de gracia)', () => {
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: NOW - 60 * 1000 } }, // 1 min
        archivado: { '4507.po': { yaml: APROB, mtimeMs: NOW - 60 * 1000 }, '4507.architect': { yaml: APROB, mtimeMs: NOW - 60 * 1000 } },
    } } };
    const deps = makeDeps(fs);
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0, 'muy reciente, darle tiempo');
});

// -----------------------------------------------------------------------------
// #6150 CA-3 — antigüedad de la tarea frenada
//
// "Hace cuánto está así" era el único de los cinco elementos del aviso nuevo que
// no llegaba al emisor: el runner tenía el `mtimeMs` de cada entregable pero lo
// descartaba al armar el contexto.
// -----------------------------------------------------------------------------

test('buildIssuesContext: stuckSinceMs es el entregable MÁS VIEJO del issue', () => {
    const VIEJO = NOW - 5 * 60 * 60 * 1000;
    const MEDIO = NOW - 2 * 60 * 60 * 1000;
    const fs = { desarrollo: { validacion: {
        listo: { '700.po': { yaml: APROB, mtimeMs: MEDIO } },
        archivado: {
            '700.ux': { yaml: APROB, mtimeMs: VIEJO },
            '700.guru': { yaml: APROB, mtimeMs: NOW - 60 * 1000 },
        },
    } } };
    const ctx = buildIssuesContext(makeDeps(fs));
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].stuckSinceMs, VIEJO, 'marca desde cuándo la fase dejó de avanzar');
});

test('buildIssuesContext: sin mtimeMs finito, stuckSinceMs queda en null', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '701.po': { yaml: APROB, mtimeMs: undefined } },
    } } };
    const ctx = buildIssuesContext(makeDeps(fs));
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].stuckSinceMs, null, 'null explícito: el copy omite la antigüedad en vez de imprimir NaN');
});

test('las decisiones arrastran la antigüedad del entregable más viejo', () => {
    const VIEJO = NOW - 8 * 60 * 60 * 1000;
    const fs = { desarrollo: { aprobacion: {
        listo: { '4507.review': { yaml: APROB, mtimeMs: OLD } },
        archivado: {
            '4507.po': { yaml: APROB, mtimeMs: VIEJO },
            '4507.architect': { yaml: APROB, mtimeMs: OLD },
        },
    } } };
    const res = runStuckPhaseReconciler(makeDeps(fs), {});
    const d = (res.decisions || []).find((x) => Number(x.issue) === 4507);
    assert.ok(d, 'la decisión existe');
    assert.equal(d.stuckSinceMs, VIEJO, 'viaja hasta el emisor, que es quien arma el texto');
});

test('rebote rev-2 · un mtimeMs en 0 no se toma como antigüedad', () => {
    // `deps.buildIssuesContext` deja `mtimeMs = 0` cuando el statSync falla (carrera
    // con un rename). `Number.isFinite(0)` es true, así que el filtro ingenuo lo
    // tomaba como el entregable más viejo y el copy imprimía "hace 20324 d" (epoch).
    const VIEJO = NOW - 3 * 60 * 60 * 1000;
    const fs = { desarrollo: { validacion: {
        listo: {
            '702.po': { yaml: APROB, mtimeMs: 0 },
            '702.ux': { yaml: APROB, mtimeMs: VIEJO },
        },
    } } };
    const ctx = buildIssuesContext(makeDeps(fs));
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].stuckSinceMs, VIEJO, 'el 0 se descarta, gana el mtime real más viejo');
});

test('rebote rev-2 · si TODOS los mtimeMs son 0, stuckSinceMs queda en null', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '703.po': { yaml: APROB, mtimeMs: 0 } },
    } } };
    const ctx = buildIssuesContext(makeDeps(fs));
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].stuckSinceMs, null, 'sin dato confiable el copy omite la antigüedad');
});

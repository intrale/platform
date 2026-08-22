// =============================================================================
// stuck-phase-reconciler-liveness-4622.test.js — Gherkin C (#4622): una fase con
// un skill en `trabajando/` cuyo heartbeat apunta a un pid MUERTO NO cuenta como
// trabajo vivo → el reconciler la trata como varada y decide requeue/escalate.
//
// Reproduce el cableado real de `pulpo.js:livenessOk`, que ahora cruza el pid del
// heartbeat vía `process-liveness.isAgentAlive` en vez de confiar sólo en el mtime.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runStuckPhaseReconciler } = require('./stuck-phase-reconciler-runner');
const liveness = require('./process-liveness');

const NOW = 1_800_000_000_000;
const OLD = NOW - 30 * 60 * 1000;
const APROB = { resultado: 'aprobado' };

// livenessOk que replica la lógica de pulpo: reciente Y heartbeat con pid vivo+identidad.
function makeLivenessOk(heartbeats, processCheck, startTimeProbe) {
    return (name, mtimeMs) => {
        const recent = (NOW - mtimeMs) < 15 * 60 * 1000;
        if (!recent) return false;
        const issue = String(name).split('.')[0];
        const hb = heartbeats[issue];
        if (!hb) return recent; // sin latido → mtime manda (compat)
        return liveness.isAgentAlive(hb.pid, {
            startedAt: hb.pid_started_at, branch: hb.branch,
        }, { processCheck, startTimeProbe });
    };
}

function makeDeps(fs, over = {}) {
    const calls = { requeue: [], escalate: [], notify: [] };
    const retryState = over.retryState || {};
    return {
        calls,
        nowMs: NOW,
        parallelPhases: [{ pipeline: 'desarrollo', fase: 'validacion' }],
        requiredSkillsFor: () => ['po', 'ux', 'guru'],
        listPhaseFiles: (p, f, state) => {
            const d = (((fs[p] || {})[f] || {})[state]) || {};
            return Object.keys(d).map((name) => ({ name, mtimeMs: d[name].mtimeMs }));
        },
        readYaml: (p, f, state, name) => (((fs[p] || {})[f] || {})[state] || {})[name].yaml,
        issueLiveElsewhere: () => false,
        hasNeedsHuman: () => false,
        isAllowed: () => true,
        isIssueOpen: () => true,
        isPaused: () => false,
        livenessOk: over.livenessOk,
        loadRetryState: () => retryState,
        saveRetryState: (s) => { calls._savedRetry = s; },
        requeueWorkItem: (p, f, s, i) => calls.requeue.push(`${i}.${s}@${f}`),
        escalate: (i, r) => calls.escalate.push({ i, r }),
        workItemExists: () => false,
        notify: (m) => calls.notify.push(m),
        audit: () => {},
    };
}

test('Gherkin C · trabajando/ con heartbeat de pid MUERTO → requeue (auto-destrabe)', () => {
    // ux está "trabajando" pero su agente murió; guru+po ya aprobados (deliverables viejos).
    const fs = { desarrollo: { validacion: {
        listo: { '4534.guru': { yaml: APROB, mtimeMs: OLD } },
        procesado: { '4534.po': { yaml: APROB, mtimeMs: OLD } },
        trabajando: { '4534.ux': { yaml: {}, mtimeMs: NOW - 60_000 } }, // marker reciente pero...
    } } };
    const heartbeats = { '4534': { pid: 8292, pid_started_at: 'DEAD' } };
    const livenessOk = makeLivenessOk(heartbeats, () => false /* pid muerto */, () => null);
    const deps = makeDeps(fs, { livenessOk });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 1, 'debe re-encolar ux (agente muerto)');
    assert.deepEqual(deps.calls.requeue, ['4534.ux@validacion']);
});

test('SEC-1 · trabajando/ con pid vivo RECICLADO (identidad no matchea) → requeue', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '4507.guru': { yaml: APROB, mtimeMs: OLD } },
        procesado: { '4507.po': { yaml: APROB, mtimeMs: OLD } },
        trabajando: { '4507.ux': { yaml: {}, mtimeMs: NOW - 60_000 } },
    } } };
    const heartbeats = { '4507': { pid: 8292, pid_started_at: 'ORIG' } };
    // pid vivo pero es otro proceso (start-time distinto) → no es el agente.
    const livenessOk = makeLivenessOk(heartbeats, () => true, () => 'REUSED');
    const deps = makeDeps(fs, { livenessOk });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 1, 'reuso de pid no cuenta como vivo → re-encola ux');
    assert.deepEqual(deps.calls.requeue, ['4507.ux@validacion']);
});

test('No regresión · trabajando/ con agente VIVO (pid + identidad ok) → NO toca la fase', () => {
    const fs = { desarrollo: { validacion: {
        listo: { '4509.guru': { yaml: APROB, mtimeMs: OLD } },
        procesado: { '4509.po': { yaml: APROB, mtimeMs: OLD } },
        trabajando: { '4509.ux': { yaml: {}, mtimeMs: NOW - 60_000 } },
    } } };
    const heartbeats = { '4509': { pid: 1234, pid_started_at: 'MATCH' } };
    const livenessOk = makeLivenessOk(heartbeats, () => true, () => 'MATCH');
    const deps = makeDeps(fs, { livenessOk });
    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.requeued, 0, 'ux vivo → no re-encolar');
    assert.equal(res.escalated, 0);
});

// =============================================================================
// wave-coherence-transition.test.js — Integración del gate de coherencia (#4578)
// con el paso `wave-close` de la transición automática de ola.
//
// Verifica que, con `wave_coherence_gate.enabled`, la transición:
//   - RETIENE la ola en `waiting-operator` cuando el gate NO da `pass`
//     (requires-operator/fail) — NO notifica cierre ni promueve.
//   - PROCEDE con el flujo normal cuando el gate da `pass`.
//   - Es INERTE cuando el flag está OFF (comportamiento legacy).
//
// Ejecutar: node --test .pipeline/lib/__tests__/wave-coherence-transition.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-coherence-tx-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.WAVE_PROMOTE_RECOVERY_TTL_MS = '50';
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../wave-auto-transition')];
    const waves = require('../waves');
    const wat = require('../wave-auto-transition');
    waves.invalidateCache();
    return { dir, waves, wat };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.WAVE_PROMOTE_RECOVERY_TTL_MS;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedWaves(dir) {
    const state = {
        version: '1.0',
        meta: { created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-01T10:00:00.000Z', updated_by: 'System', source: 'manual' },
        active_wave: {
            number: 7,
            name: 'Ola N+7',
            started_at: '2026-06-01T10:00:00.000Z',
            issues: [{ number: 3451, status: 'in_progress' }, { number: 3452, status: 'in_progress' }],
        },
        planned_waves: [{ number: 8, name: 'Ola N+8', issues: [{ number: 3520 }] }],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

function seedPartial(dir) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: [3451, 3452], created_at: '2026-06-01T00:00:00.000Z', source: 'test-seed',
    }));
}

// gh mock: ambos issues CLOSED ⇒ ola completa.
function mkGhCallAllClosed() {
    return async (args) => ({ stdout: JSON.stringify({ state: 'CLOSED' }) });
}

const CFG_NOTIFY_COHERENCE_ON = {
    wave_auto_transition: { enabled: true, kill_switch: false, mode: 'notify', gh_timeout_ms: 5000 },
    wave_coherence_gate: { enabled: true, kill_switch: false },
};
const CFG_NOTIFY_COHERENCE_OFF = {
    wave_auto_transition: { enabled: true, kill_switch: false, mode: 'notify', gh_timeout_ms: 5000 },
    wave_coherence_gate: { enabled: false },
};

// Colectores inyectados (evitan tocar el índice real de entregables).
const collectAllPresent = () => ([
    { issue: 3451, evidence: { present: true, ref: 'deliverables/3451.json' }, claims: [{ dimension: 'd', key: 'k', value: 'A' }] },
    { issue: 3452, evidence: { present: true, ref: 'deliverables/3452.json' }, claims: [{ dimension: 'd', key: 'k', value: 'A' }] },
]);
const collectConflict = () => ([
    { issue: 3451, evidence: { present: true, ref: 'deliverables/3451.json' }, claims: [{ dimension: 'ui', key: 'saldo', value: 'X' }] },
    { issue: 3452, evidence: { present: true, ref: 'deliverables/3452.json' }, claims: [{ dimension: 'ui', key: 'saldo', value: 'Y' }] },
]);
const collectMissingEvidence = () => ([
    { issue: 3451, evidence: { present: true, ref: 'deliverables/3451.json' }, claims: [] },
    { issue: 3452, evidence: { present: false }, claims: [] },
]);

test('flag OFF: la transición NO corre el gate (comportamiento legacy)', async () => {
    const { dir, wat } = setupTmp();
    try {
        seedWaves(dir); seedPartial(dir);
        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_OFF, {
            ghCall: mkGhCallAllClosed(),
            collectDeliverables: collectMissingEvidence, // ignorado con flag OFF
        });
        assert.equal(res.action, 'detected_complete');
    } finally { teardownTmp(dir); }
});

test('flag ON + conflicto cross-issue: RETIENE en waiting-operator, no cierra', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir); seedPartial(dir);
        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_ON, {
            ghCall: mkGhCallAllClosed(),
            collectDeliverables: collectConflict,
        });
        assert.equal(res.action, 'coherence_hold');
        assert.equal(res.verdict, 'requires-operator');
        // La ola quedó retenida.
        waves.invalidateCache();
        assert.equal(waves.isWaveWaitingOperator(), true);
        const wo = waves.getWaveWaitingOperator();
        assert.equal(wo.conflicts_count, 1);
        assert.ok(wo.evidence_ref, 'evidencia agregada referenciada');
    } finally { teardownTmp(dir); }
});

test('flag ON + evidencia ausente: fail-closed, RETIENE en waiting-operator', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir); seedPartial(dir);
        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_ON, {
            ghCall: mkGhCallAllClosed(),
            collectDeliverables: collectMissingEvidence,
        });
        assert.equal(res.action, 'coherence_hold');
        assert.equal(res.verdict, 'fail');
        waves.invalidateCache();
        assert.equal(waves.isWaveWaitingOperator(), true);
    } finally { teardownTmp(dir); }
});

test('flag ON + coherente: PROCEDE al flujo normal (detected_complete)', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir); seedPartial(dir);
        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_ON, {
            ghCall: mkGhCallAllClosed(),
            collectDeliverables: collectAllPresent,
        });
        assert.equal(res.action, 'detected_complete');
        waves.invalidateCache();
        assert.equal(waves.isWaveWaitingOperator(), false);
    } finally { teardownTmp(dir); }
});

test('flag ON + ola ya retenida: idempotente, held_waiting_operator', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir); seedPartial(dir);
        // Primera pasada: conflicto → retiene.
        await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_ON, {
            ghCall: mkGhCallAllClosed(), collectDeliverables: collectConflict,
        });
        waves.invalidateCache();
        // Segunda pasada: ya está en waiting-operator → no re-evalúa.
        const res2 = await wat.autoTransitionIfComplete(CFG_NOTIFY_COHERENCE_ON, {
            ghCall: mkGhCallAllClosed(), collectDeliverables: collectAllPresent,
        });
        assert.equal(res2.action, 'held_waiting_operator');
    } finally { teardownTmp(dir); }
});

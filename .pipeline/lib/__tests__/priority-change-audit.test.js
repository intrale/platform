// =============================================================================
// priority-change-audit.test.js — Mutar el label priority:* vía el punto único
// `setPriorityLabel` (y a través de human-block `priorizar`) emite el evento
// priority_changed con prioridad previa/nueva (#4371 CA-3).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/priority-change-audit.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let priorityLabel;
let waveAudit;

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priority-audit-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../priority-label')];
    delete require.cache[require.resolve('../wave-audit')];
    delete require.cache[require.resolve('../audit-log')];
    priorityLabel = require('../priority-label');
    waveAudit = require('../wave-audit');
    return dir;
}

function teardown(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

// ─── setPriorityLabel emite priority_changed ────────────────────────────────

test('setPriorityLabel encola el label nuevo y emite priority_changed (CA-3)', () => {
    const dir = setup();
    try {
        const calls = [];
        const enqueue = (action, payload) => calls.push({ action, payload });
        priorityLabel.setPriorityLabel({
            issue: 4371,
            priority: 'priority:high',
            previousPriority: 'priority:medium',
            actor: 'Leo',
            enqueue,
            note: 'urgente',
        });
        // 1. mutación del label: add nuevo + remove previo.
        assert.deepEqual(calls[0], { action: 'label', payload: { issue: 4371, label: 'priority:high' } });
        assert.deepEqual(calls[1], { action: 'remove-label', payload: { issue: 4371, label: 'priority:medium' } });
        // 2. audit emitido.
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, 'priority_changed');
        assert.equal(ev[0].issue, 4371);
        assert.equal(ev[0].actor, 'Leo');
        assert.equal(ev[0].prioridad_previa, 'priority:medium');
        assert.equal(ev[0].prioridad_nueva, 'priority:high');
    } finally {
        teardown(dir);
    }
});

test('setPriorityLabel sin previa conocida deja prioridad_previa null y no encola remove', () => {
    const dir = setup();
    try {
        const calls = [];
        const enqueue = (action, payload) => calls.push({ action, payload });
        priorityLabel.setPriorityLabel({ issue: 10, priority: 'priority:low', actor: 'Leo', enqueue });
        assert.equal(calls.length, 1, 'solo el add del label nuevo');
        const ev = waveAudit.readAllEvents();
        assert.equal(ev[0].prioridad_previa, null);
        assert.equal(ev[0].prioridad_nueva, 'priority:low');
    } finally {
        teardown(dir);
    }
});

test('setPriorityLabel valida priority y enqueue', () => {
    const dir = setup();
    try {
        assert.throws(() => priorityLabel.setPriorityLabel({ issue: 1, priority: 'urgent', enqueue: () => {} }), /priority inválido/);
        assert.throws(() => priorityLabel.setPriorityLabel({ issue: 1, priority: 'priority:high' }), /enqueue/);
        assert.throws(() => priorityLabel.setPriorityLabel({ issue: 0, priority: 'priority:high', enqueue: () => {} }), /issue inválido/);
    } finally {
        teardown(dir);
    }
});

// ─── human-block priorizar usa setPriorityLabel y emite audit ───────────────

test('human-block priorizar emite priority_changed a priority:high (CA-3)', () => {
    const dir = setup();
    try {
        delete require.cache[require.resolve('../human-block')];
        const hb = require('../human-block');
        const enqueued = [];
        const res = hb.executeQuickAction({
            issue: 4371,
            action: 'priorizar',
            deps: {
                enqueueGithub: (action, payload) => enqueued.push({ action, payload }),
                // Evitar tocar markers reales de bloqueo.
                findBlockedMarker: () => null,
                reactivateAllBlocked: () => [],
            },
        });
        assert.equal(res.ok, true);
        // Se encoló el label priority:high.
        assert.ok(enqueued.some((c) => c.action === 'label' && c.payload.label === 'priority:high'), 'encola priority:high');
        // Audit emitido con el evento correcto.
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, 'priority_changed');
        assert.equal(ev[0].issue, 4371);
        assert.equal(ev[0].prioridad_nueva, 'priority:high');
        assert.equal(ev[0].actor, 'human-block:priorizar');
    } finally {
        teardown(dir);
    }
});

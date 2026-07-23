// =============================================================================
// Tests worktree-audit.js — append-only JSONL del audit trail (#2591 CA-8).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendWorktreeAudit, readWorktreeAuditTail } = require('../worktree-audit');

function tmpAuditPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-audit-'));
    return { dir, file: path.join(dir, 'aborts.jsonl') };
}

test('appendWorktreeAudit — escribe entrada JSON válida y la lee de vuelta', () => {
    const { dir, file } = tmpAuditPath();
    try {
        const ok = appendWorktreeAudit({
            event: 'abort',
            issue: 2505,
            fase: 'entrega',
            skill: 'delivery',
            motivo: 'remote-branch-missing:agent/2505-delivery',
            recovery_attempted: true,
            recovery_succeeded: false,
            branch_origin_verified: null,
        }, file);
        assert.equal(ok, true);

        const tail = readWorktreeAuditTail(10, file);
        assert.equal(tail.length, 1);
        const entry = tail[0];
        assert.equal(entry.event, 'abort');
        assert.equal(entry.issue, 2505);
        assert.equal(entry.fase, 'entrega');
        assert.equal(entry.skill, 'delivery');
        assert.equal(entry.recovery_attempted, true);
        assert.equal(entry.recovery_succeeded, false);
        assert.equal(entry.branch_origin_verified, null);
        assert.ok(entry.ts && Date.parse(entry.ts));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

test('appendWorktreeAudit — múltiples appends → tail devuelve las últimas N', () => {
    const { dir, file } = tmpAuditPath();
    try {
        for (let i = 0; i < 5; i++) {
            appendWorktreeAudit({
                event: 'abort',
                issue: 1000 + i,
                fase: 'entrega',
                skill: 'delivery',
                motivo: `test-${i}`,
            }, file);
        }
        const tail = readWorktreeAuditTail(3, file);
        assert.equal(tail.length, 3);
        assert.equal(tail[0].issue, 1002);
        assert.equal(tail[2].issue, 1004);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

test('appendWorktreeAudit — sanitiza motivo (trunca a 500 chars)', () => {
    const { dir, file } = tmpAuditPath();
    try {
        const longMotivo = 'x'.repeat(1500);
        appendWorktreeAudit({
            event: 'abort',
            issue: 1, fase: 'entrega', skill: 'delivery',
            motivo: longMotivo,
        }, file);
        const [entry] = readWorktreeAuditTail(1, file);
        assert.ok(entry.motivo.length <= 500);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

test('appendWorktreeAudit — branch_origin_verified normaliza valores no-bool a null', () => {
    const { dir, file } = tmpAuditPath();
    try {
        appendWorktreeAudit({
            event: 'abort', issue: 1, fase: 'entrega', skill: 'delivery',
            motivo: 'test', branch_origin_verified: 'yes', // string inválido
        }, file);
        const [entry] = readWorktreeAuditTail(1, file);
        assert.equal(entry.branch_origin_verified, null);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

test('appendWorktreeAudit — best-effort: no lanza si el path no se puede escribir', () => {
    // Path a un directorio inválido (carácter null no permitido en filenames).
    const ok = appendWorktreeAudit({
        event: 'abort', issue: 1, fase: 'entrega', skill: 'delivery', motivo: 'x',
    }, '/dev/null/inexistente/\0xx.jsonl');
    assert.equal(ok, false); // No lanzó, devolvió false.
});

test('readWorktreeAuditTail — devuelve [] si el archivo no existe', () => {
    const tail = readWorktreeAuditTail(10, '/tmp/no-existe-jamas-' + Date.now() + '.jsonl');
    assert.deepEqual(tail, []);
});

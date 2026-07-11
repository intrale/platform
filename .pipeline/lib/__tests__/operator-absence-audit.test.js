// =============================================================================
// Tests operator-absence-audit.js — #4632 (audit tamper-evident de decisiones).
//
// Cubre:
//   - evento de auto-proceder valida con verifyChain tras agregar entries
//   - reason con CRLF/secret queda sanitizado antes de persistir
//   - romper la cadena manualmente => verifyChain lo detecta (tamper-evident)
//   - actor/decision fuera de enum se marcan sin romper el registro
//
// Aísla el audit real usando PIPELINE_DIR_OVERRIDE en un tmpdir.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-absence-audit-'));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// El módulo lee PIPELINE_DIR_OVERRIDE en cada llamada, así que basta setearlo
// antes de invocar. Se re-require dentro de cada test tras fijar el override.
function loadAudit(dir) {
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // El resolver de paths lee el env en runtime; no hace falta limpiar cache.
    return require('../operator-absence-audit');
}

test('evento de auto-proceder valida con verifyChain tras agregar entries', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        const r1 = audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'kernel:absence-policy', scope: 'low-risk-doc',
            confidenceBase: 'indice #4576 vigente', decision: 'auto-proceed',
            reason: 'allowlist+indice_vigente', timestamp: '2026-07-11T00:00:00.000Z',
        });
        assert.equal(r1.ok, true);
        assert.equal(r1.entry.decision, 'auto-proceed');
        assert.equal(r1.entry.issue, '4632');
        assert.ok(r1.hash_self);

        const r2 = audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'operator:confirm', decision: 'auto-proceed',
            reason: 'segunda decisión', timestamp: '2026-07-11T00:01:00.000Z',
        });
        assert.equal(r2.ok, true);

        const v = audit.verifyChain();
        assert.equal(v.ok, true);
        assert.equal(v.entriesChecked, 2);

        assert.equal(audit.tail(1).length, 1);
        assert.equal(audit.tail(5).length, 2);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

test('reason con CRLF/secret queda sanitizado antes de persistir', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        const r = audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'kernel:absence-policy', decision: 'auto-proceed',
            reason: 'linea1\r\nlinea2 token=AKIAIOSFODNN7EXAMPLE fin',
            timestamp: '2026-07-11T00:00:00.000Z',
        });
        assert.equal(r.ok, true);
        // No hay CRLF crudo en la entry persistida.
        assert.doesNotMatch(r.entry.reason, /\r|\n/);
        assert.equal(r.entry.reason_crlf_escaped, true);
        // El AWS key fue redactado.
        assert.doesNotMatch(r.entry.reason, /AKIAIOSFODNN7EXAMPLE/);
        assert.equal(r.entry.reason_redacted, true);

        // El archivo en disco tampoco tiene el secreto ni CRLF forjado.
        const file = audit._paths().OPERATOR_ABSENCE_FILE;
        const raw = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(raw, /AKIAIOSFODNN7EXAMPLE/);
        // Una sola línea JSONL (el \r\n no forjó una segunda).
        assert.equal(raw.split('\n').filter(l => l.trim()).length, 1);

        assert.equal(audit.verifyChain().ok, true);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

test('extra con secreto queda sanitizado antes de persistir', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        const secret = 'AKIAIOSFODNN7EXAMPLE';
        const r = audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'kernel:absence-policy', decision: 'auto-proceed',
            reason: 'ok', timestamp: '2026-07-11T00:00:00.000Z',
            extra: {
                operator_note: `linea1\r\nlinea2 ${secret}`,
                nested: { payload: `token=${secret}` },
                list: ['visible', secret],
            },
        });
        assert.equal(r.ok, true);
        assert.equal(r.entry.reason_redacted, true);
        assert.equal(r.entry.reason_crlf_escaped, true);
        assert.doesNotMatch(r.entry.operator_note, /\r|\n/);
        assert.doesNotMatch(r.entry.operator_note, /AKIAIOSFODNN7EXAMPLE/);
        assert.doesNotMatch(r.entry.nested.payload, /AKIAIOSFODNN7EXAMPLE/);
        assert.doesNotMatch(r.entry.list[1], /AKIAIOSFODNN7EXAMPLE/);

        const file = audit._paths().OPERATOR_ABSENCE_FILE;
        const raw = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(raw, /AKIAIOSFODNN7EXAMPLE/);
        assert.equal(raw.split('\n').filter(l => l.trim()).length, 1);
        assert.equal(audit.verifyChain().ok, true);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

test('romper la cadena manualmente => verifyChain lo detecta', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'kernel:absence-policy', decision: 'auto-proceed',
            reason: 'primera', timestamp: '2026-07-11T00:00:00.000Z',
        });
        audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'kernel:absence-policy', decision: 'auto-proceed',
            reason: 'segunda', timestamp: '2026-07-11T00:01:00.000Z',
        });
        assert.equal(audit.verifyChain().ok, true);

        // Tamper: alterar el reason de la primera entry sin recomputar el hash.
        const file = audit._paths().OPERATOR_ABSENCE_FILE;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
        const first = JSON.parse(lines[0]);
        first.reason = 'MANIPULADO';
        lines[0] = JSON.stringify(first);
        fs.writeFileSync(file, lines.join('\n') + '\n');

        const v = audit.verifyChain();
        assert.equal(v.ok, false);
        assert.equal(v.brokenAt, 0);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

test('actor/decision fuera de enum se marcan sin romper el registro', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        const r = audit.appendDecision({
            issue: 4632, gate: 'gate3', clase: 'low-risk-doc',
            actor: 'atacante:desconocido', decision: 'sarasa',
            reason: 'intento', timestamp: '2026-07-11T00:00:00.000Z',
        });
        assert.equal(r.ok, true);
        assert.equal(r.entry.actor, null);
        assert.equal(r.entry.actor_rejected_value, 'atacante:desconocido');
        assert.equal(r.entry.decision, 'unknown');
        assert.equal(r.entry.decision_rejected_value, 'sarasa');
        assert.equal(audit.verifyChain().ok, true);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

test('safeAppendDecision nunca lanza', () => {
    const { dir, cleanup } = mkTmp();
    try {
        const audit = loadAudit(dir);
        const r = audit.safeAppendDecision({
            issue: 4632, gate: 'gate3', clase: 'x',
            actor: 'kernel:absence-policy', decision: 'fail-closed',
            reason: 'ok', timestamp: '2026-07-11T00:00:00.000Z',
        });
        assert.equal(r.ok, true);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        cleanup();
    }
});

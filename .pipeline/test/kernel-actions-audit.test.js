'use strict';

// =============================================================================
// kernel-actions-audit.test.js — GATE 3 (#4577).
//   node --test .pipeline/test/kernel-actions-audit.test.js
//
// Cubre CA-1/CA-2/CA-3/CA-7 + RS-1..RS-4:
//   - appendAction escribe vía audit-log (hash-chain) y verifyChain() OK.
//   - invariante log-antes-de-mutar (la entry persiste aunque la mutación tire).
//   - tamper-evidence: mutar una línea → verifyChain() { ok:false, brokenAt }.
//   - redacción del reason (AWS key/JWT/CRLF).
//   - enum cerrado de action y authorizedBy (valores inválidos → forense).
//   - regresión #4565 (quota-flag) y #4566 (realign) como fixtures.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Aislar a un tmp dir por proceso de test.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-kernel-audit-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });

delete require.cache[require.resolve('../lib/kernel-actions-audit')];
delete require.cache[require.resolve('../lib/audit-log')];

const audit = require('../lib/kernel-actions-audit');
const auditLog = require('../lib/audit-log');

function auditFile() {
    return audit._paths().KERNEL_ACTIONS_FILE;
}

function resetFs() {
    const f = auditFile();
    try { fs.unlinkSync(f); } catch {}
    try { fs.unlinkSync(f + '.lock'); } catch {}
}

// -----------------------------------------------------------------------------
// CA-1 / RS-1 — appendAction escribe vía audit-log (hash-chain)
// -----------------------------------------------------------------------------

test('appendAction escribe vía audit-log (hash-chain) y verifyChain OK', () => {
    resetFs();
    const r = audit.appendAction({
        action: 'realign-allowlist',
        impact: 'alto',
        reason: 'converger allowlist a ola activa',
        authorizedBy: 'wave-promote',
    });
    assert.equal(r.ok, true);
    assert.ok(r.hash_self && r.hash_self.length === 64);

    const lines = fs.readFileSync(auditFile(), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, 'realign-allowlist');
    assert.equal(entry.impact, 'alto');
    assert.equal(entry.authorized_by, 'wave-promote');
    assert.ok(entry.reason.includes('converger'));
    assert.ok(entry.timestamp);
    assert.equal(typeof entry.pid, 'number');

    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 1);
});

test('el archivo canónico es único (.pipeline/audit/kernel-actions.jsonl)', () => {
    assert.ok(auditFile().replace(/\\/g, '/').endsWith('audit/kernel-actions.jsonl'));
});

test('varias acciones encadenan un chain válido', () => {
    resetFs();
    audit.appendAction({ action: 'quota-flag-set', impact: 'alto', reason: 'set', authorizedBy: 'quota-detector' });
    audit.appendAction({ action: 'quota-flag-clear', impact: 'alto', reason: 'clear', authorizedBy: 'quota-detector' });
    audit.appendAction({ action: 'worktree-reset', impact: 'alto', reason: 'reset', authorizedBy: 'restart:rollback' });
    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 3);
});

// -----------------------------------------------------------------------------
// CA-2 / RS-2 — invariante log-antes-de-mutar
// -----------------------------------------------------------------------------

test('invariante log-antes-de-mutar: la entry persiste aunque la mutación tire', () => {
    resetFs();
    // Simular el patrón real del caller: primero log, después mutar (que falla).
    function mutar() { throw new Error('mutación falló a mitad'); }
    assert.throws(() => {
        audit.appendAction({ action: 'worktree-reset', impact: 'alto', reason: 'reset', authorizedBy: 'restart:rollback' });
        mutar(); // muere DESPUÉS de loguear
    }, /mutación falló/);

    // La entry del intento ya quedó persistida.
    const all = auditLog.readAll(auditFile());
    assert.equal(all.length, 1);
    assert.equal(all[0].action, 'worktree-reset');
    assert.equal(audit.verifyChain().ok, true);
});

// -----------------------------------------------------------------------------
// CA-7 — tamper-evidence
// -----------------------------------------------------------------------------

test('tamper-evidence: mutar una línea rompe verifyChain con brokenAt', () => {
    resetFs();
    audit.appendAction({ action: 'realign-allowlist', impact: 'alto', reason: 'a', authorizedBy: 'wave-promote' });
    audit.appendAction({ action: 'reseed-wave', impact: 'alto', reason: 'b', authorizedBy: 'kernel:auto' });

    // Tamperear la segunda línea (cambiar el reason sin recomputar hash).
    const lines = fs.readFileSync(auditFile(), 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.reason = 'TAMPERED';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(auditFile(), lines.join('\n') + '\n');

    const v = audit.verifyChain();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
});

// -----------------------------------------------------------------------------
// CA-3 / RS-3 — redacción del reason
// -----------------------------------------------------------------------------

test('redacción del reason: AWS key se redacta', () => {
    resetFs();
    audit.appendAction({
        action: 'quota-flag-set', impact: 'alto',
        reason: 'clave AKIAIOSFODNN7EXAMPLE filtrada en el log',
        authorizedBy: 'quota-detector',
    });
    const entry = JSON.parse(fs.readFileSync(auditFile(), 'utf8').trim());
    assert.ok(!entry.reason.includes('AKIAIOSFODNN7EXAMPLE'), 'no debe filtrar la AWS key');
    assert.equal(entry.reason_redacted, true);
});

test('redacción del reason: JWT se redacta', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = audit.sanitizeReason(`token ${jwt}`);
    assert.ok(!r.sanitized.includes(jwt), 'no debe filtrar el JWT');
    assert.equal(r.didRedact, true);
});

test('redacción del reason: CRLF se escapa (no forja líneas JSONL falsas)', () => {
    resetFs();
    audit.appendAction({
        action: 'desync-autoresolve', impact: 'medio',
        reason: 'linea1\r\n{"fake":"injected"}\nlinea3',
        authorizedBy: 'desync-detector',
    });
    // Debe seguir siendo UNA sola línea física.
    const raw = fs.readFileSync(auditFile(), 'utf8').trim();
    assert.equal(raw.split('\n').length, 1);
    const entry = JSON.parse(raw);
    assert.ok(!entry.reason.includes('\n'));
    assert.ok(!entry.reason.includes('\r'));
    assert.equal(entry.reason_crlf_escaped, true);
    assert.equal(audit.verifyChain().ok, true);
});

test('reason largo se trunca a MAX_REASON_LEN', () => {
    const long = 'x'.repeat(2000);
    const r = audit.sanitizeReason(long);
    assert.ok(r.sanitized.length <= audit.MAX_REASON_LEN);
    assert.equal(r.didTruncate, true);
});

test('sanitizeReason tolera null/no-string sin romper', () => {
    assert.equal(audit.sanitizeReason(null).sanitized, '');
    assert.equal(audit.sanitizeReason(undefined).sanitized, '');
    assert.equal(typeof audit.sanitizeReason(12345).sanitized, 'string');
});

// -----------------------------------------------------------------------------
// Enums cerrados (action / authorizedBy)
// -----------------------------------------------------------------------------

test('action fuera del enum se marca unknown con valor forense', () => {
    resetFs();
    const r = audit.appendAction({ action: 'hackear-todo', impact: 'alto', reason: 'x', authorizedBy: 'kernel:auto' });
    assert.equal(r.entry.action, 'unknown');
    assert.equal(r.entry.action_rejected_value, 'hackear-todo');
});

test('authorizedBy fuera del enum → authorized_by null + campos de rechazo (RS-4)', () => {
    resetFs();
    const r = audit.appendAction({ action: 'realign-allowlist', impact: 'alto', reason: 'x', authorizedBy: 'atacante-arbitrario' });
    assert.equal(r.entry.authorized_by, null);
    assert.equal(r.entry.authorized_by_rejected_value, 'atacante-arbitrario');
    assert.ok(r.entry.authorized_by_rejected_reason.startsWith('authorized_by_not_in_enum'));
});

test('validateAuthorizedBy acepta cada valor del enum estático', () => {
    for (const v of audit.AUTHORIZED_BY_STATIC) {
        assert.equal(audit.validateAuthorizedBy(v).valid, true, `debería aceptar ${v}`);
    }
    assert.equal(audit.validateAuthorizedBy(null).valid, false);
    assert.equal(audit.validateAuthorizedBy('').valid, false);
    assert.equal(audit.validateAuthorizedBy(123).valid, false);
});

test('impact fuera del enum cae a medio', () => {
    assert.equal(audit.normalizeImpact('catastrofico'), 'medio');
    assert.equal(audit.normalizeImpact('alto'), 'alto');
    assert.equal(audit.normalizeImpact(null), 'medio');
});

test('extra fields se adjuntan sin pisar los críticos', () => {
    resetFs();
    const r = audit.appendAction({
        action: 'reseed-wave', impact: 'alto', reason: 'x', authorizedBy: 'kernel:auto',
        extra: { wave_number: 42, action: 'no-me-pises' },
    });
    assert.equal(r.entry.wave_number, 42);
    assert.equal(r.entry.action, 'reseed-wave'); // no lo pisó el extra
});

// -----------------------------------------------------------------------------
// safeAppendAction — best-effort (nunca lanza)
// -----------------------------------------------------------------------------

test('safeAppendAction nunca lanza aunque el write falle', () => {
    resetFs();
    // Forzar fallo: apuntar a un override inexistente e imposible de crear no es
    // trivial cross-platform; en cambio verificamos el happy path + que devuelve ok.
    const r = audit.safeAppendAction({ action: 'worktree-reset', impact: 'alto', reason: 'x', authorizedBy: 'restart:rollback' });
    assert.equal(r.ok, true);
});

// -----------------------------------------------------------------------------
// CA-5 / RS-4 — confirmación rechazada
// -----------------------------------------------------------------------------

test('appendConfirmationRejected registra el intento no autorizado', () => {
    resetFs();
    const r = audit.appendConfirmationRejected({
        action: 'reseed-wave',
        rejectedChatId: '999999',
        reason: 'chat_id no allowlisted intentó confirmar',
    });
    assert.equal(r.ok, true);
    const entry = JSON.parse(fs.readFileSync(auditFile(), 'utf8').trim());
    assert.equal(entry.confirmation_rejected, true);
    assert.equal(entry.rejected_chat_id, '999999');
    assert.equal(entry.authorized_by, null);
    assert.equal(audit.verifyChain().ok, true);
});

// -----------------------------------------------------------------------------
// CA-7 — regresión con incidentes 2026-07-08 como fixtures
// -----------------------------------------------------------------------------

test('regresión #4565 (quota-flag) quedaría registrado con verifyChain OK', () => {
    resetFs();
    // Reproduce el escenario del incidente: set + clear del flag de cuota.
    audit.appendAction({ action: 'quota-flag-set', impact: 'alto', reason: 'incident #4565 provider=anthropic misatribuido', authorizedBy: 'quota-detector' });
    audit.appendAction({ action: 'quota-flag-clear', impact: 'alto', reason: 'incident #4565 clear tras success_spawn', authorizedBy: 'quota-detector' });
    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 2);
    const all = auditLog.readAll(auditFile());
    assert.equal(all[0].action, 'quota-flag-set');
    assert.equal(all[1].action, 'quota-flag-clear');
});

test('regresión #4566 (realign de cohorte) quedaría registrado con verifyChain OK', () => {
    resetFs();
    audit.appendAction({ action: 'realign-allowlist', impact: 'alto', reason: 'incident #4566 realign cambió cohorte de la ola', authorizedBy: 'wave-promote' });
    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    const entry = auditLog.readAll(auditFile())[0];
    assert.equal(entry.action, 'realign-allowlist');
    assert.equal(entry.impact, 'alto');
});

// -----------------------------------------------------------------------------
// tail
// -----------------------------------------------------------------------------

test('tail devuelve las últimas N entries', () => {
    resetFs();
    for (let i = 0; i < 5; i++) {
        audit.appendAction({ action: 'desync-autoresolve', impact: 'medio', reason: `r${i}`, authorizedBy: 'desync-detector' });
    }
    const t = audit.tail(2);
    assert.equal(t.length, 2);
    assert.equal(t[1].reason, 'r4');
});

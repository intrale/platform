// =============================================================================
// worktree-audit.js — Audit trail persistente de abortos / auto-recovery del
// resolver de worktree para fases `useExistingWorktree` (build/linteo/
// aprobacion/entrega).
//
// **Por qué un audit log dedicado** (issue #2591 CA-8 / security CA-6):
//   Sin esto, no hay forma de detectar patrones de abuso (ej. cleanup que
//   elimina worktrees activos masivamente) ni de reconstruir post-mortem
//   cuándo y por qué un issue rebotó por falta de worktree.
//
// **Formato** (JSONL, una entrada por línea):
//   {
//     "ts": "2026-05-18T10:23:45.123Z",
//     "event": "abort" | "recovery_ok" | "recovery_failed",
//     "issue": 2505,
//     "fase": "entrega",
//     "skill": "delivery",
//     "motivo": "remote-branch-missing:agent/2505-delivery",
//     "recovery_attempted": true,
//     "recovery_succeeded": false,
//     "branch_origin_verified": null    // bool si auto-recovery se intentó
//   }
//
// **Atomicidad**:
//   `fs.appendFileSync` con flag `a` es atómico para writes < 4096 bytes en
//   linux/macOS y suficientemente seguro en Windows para nuestros tamaños
//   (~200B por entrada). No usamos locks adicionales — el costo no se
//   justifica para append-only de pocas centenas de bytes.
//
// **Sanitización**:
//   Pasamos `motivo` por `lib/redact.js` antes de persistir. Cualquier path
//   absoluto o token que un error de git haya filtrado queda escrubado.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Importamos redact de forma lazy para evitar ciclos si el módulo se carga
// muy temprano en el bootstrap del pulpo. redact.js es puro y barato.
let _redact = null;
function getRedact() {
    if (_redact) return _redact;
    try {
        // El `redact()` canónico del pipeline vive en .pipeline/redact.js (no en
        // .pipeline/lib/redact.js que expone otros helpers). Es el mismo que
        // usa pulpo.js para todos los outputs sensibles.
        _redact = require('../redact').redact;
        if (typeof _redact !== 'function') throw new Error('not-fn');
    } catch {
        _redact = (s) => String(s ?? '');
    }
    return _redact;
}

const DEFAULT_AUDIT_PATH = path.join(
    __dirname, '..', 'pipe', 'audit', 'worktree-aborts.jsonl',
);

/**
 * Garantiza que el directorio del audit log existe.
 */
function ensureAuditDir(auditPath) {
    try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); } catch {}
}

/**
 * Appendea una entrada al audit log. Nunca lanza — el audit es best-effort
 * y NO debe bloquear el flow operativo del pulpo.
 *
 * @param {object} entry
 * @param {string} entry.event               'abort' | 'recovery_ok' | 'recovery_failed'
 * @param {number|string} entry.issue
 * @param {string} entry.fase
 * @param {string} entry.skill
 * @param {string} entry.motivo
 * @param {boolean} [entry.recovery_attempted]
 * @param {boolean} [entry.recovery_succeeded]
 * @param {boolean|null} [entry.branch_origin_verified]
 * @param {string} [auditPath]               Override para tests.
 */
function appendWorktreeAudit(entry, auditPath = DEFAULT_AUDIT_PATH) {
    try {
        ensureAuditDir(auditPath);
        const redact = getRedact();
        const safe = {
            ts: entry.ts || new Date().toISOString(),
            event: String(entry.event || 'abort'),
            issue: parseInt(entry.issue, 10) || null,
            fase: String(entry.fase || ''),
            skill: String(entry.skill || ''),
            motivo: redact(String(entry.motivo || '')).slice(0, 500),
            recovery_attempted: !!entry.recovery_attempted,
            recovery_succeeded: !!entry.recovery_succeeded,
            branch_origin_verified: (
                entry.branch_origin_verified === true
                || entry.branch_origin_verified === false
            ) ? !!entry.branch_origin_verified : null,
        };
        fs.appendFileSync(auditPath, JSON.stringify(safe) + '\n', { encoding: 'utf8' });
        return true;
    } catch {
        // Audit best-effort — nunca explota.
        return false;
    }
}

/**
 * Lee las últimas N entradas del audit log. Util para diagnóstico CLI / tests.
 */
function readWorktreeAuditTail(n = 10, auditPath = DEFAULT_AUDIT_PATH) {
    try {
        const raw = fs.readFileSync(auditPath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        return lines.slice(-n).map(l => {
            try { return JSON.parse(l); } catch { return { malformed: true, raw: l }; }
        });
    } catch {
        return [];
    }
}

module.exports = {
    appendWorktreeAudit,
    readWorktreeAuditTail,
    DEFAULT_AUDIT_PATH,
};

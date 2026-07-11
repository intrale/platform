// =============================================================================
// operator-absence-audit.js — Registro tamper-evident de las decisiones de la
// política de operador ausente (issue #4632 · split de #4581 · GATE 3 extendido).
//
// Cada decisión de AUTO-PROCEDER por ausencia del operador es una mutación del
// estado operativo sin firma humana en el momento: DEBE quedar en un audit
// append-only/tamper-evident, verificable a posteriori (OWASP A09 Security
// Logging Failures). Un `fs.appendFile` plano NO alcanza: cualquier proceso
// podría reescribir el JSONL y borrar la evidencia.
//
// Este módulo clona la semántica probada de `lib/kernel-actions-audit.js`:
//
//   - Persiste en el archivo canónico ÚNICO `.pipeline/audit/operator-absence.jsonl`
//     vía `lib/audit-log.appendChained` (hash-chain SHA-256 + file-lock O_EXCL).
//     Verificable con `verifyChain()`.
//
//   - `sanitizeReason` (redact secrets + escape CRLF + truncado) sobre todo
//     campo de texto libre antes de persistir (OWASP A03 log-forging / leak).
//     Se REUSA la implementación de `kernel-actions-audit.js` (no se duplica).
//
//   - `decision` y `actor` validados contra **enums cerrados**. Un valor fuera
//     de rango no rompe el registro: se marca (`unknown` / campo de rechazo
//     forense) para no perder la traza.
//
//   - Timestamp INYECTADO por el caller (determinismo en tests). `appendChained`
//     agrega igual su propio `created_at` para la cadena.
//
// Este módulo NO decide ni ejecuta la delegación: sólo persiste el evento. La
// decisión vive en `lib/operator-absence-policy.js`.
// =============================================================================
'use strict';

const path = require('node:path');

const auditLog = require('./audit-log');
const { sanitizeReason } = require('./kernel-actions-audit');

// -----------------------------------------------------------------------------
// Enums cerrados. Valor fuera de rango → se marca, no se descarta.
// -----------------------------------------------------------------------------
const DECISIONS = Object.freeze(['auto-proceed', 'fail-closed']);

const ACTORS = Object.freeze([
    'kernel:absence-policy', // el propio kernel ejerció la delegación por ausencia
    'operator:confirm',      // operador primario confirmó/revisó vía Telegram (CA-5)
    'commander:leo',         // operador humano
]);

function normalizeDecision(value) {
    return (typeof value === 'string' && DECISIONS.includes(value)) ? value : 'unknown';
}

function validateActor(value) {
    if (value == null || value === '') {
        return { valid: false, normalized: null, reason: 'missing_actor' };
    }
    if (typeof value !== 'string') {
        return { valid: false, normalized: null, reason: 'actor_not_string' };
    }
    const trimmed = value.trim();
    if (ACTORS.includes(trimmed)) return { valid: true, normalized: trimmed };
    return { valid: false, normalized: null, reason: `actor_not_in_enum:${trimmed}` };
}

// -----------------------------------------------------------------------------
// Resolución de paths. `PIPELINE_DIR_OVERRIDE` aísla tests.
// -----------------------------------------------------------------------------
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function operatorAbsenceFile() {
    return path.join(pipelineDir(), 'audit', 'operator-absence.jsonl');
}

// -----------------------------------------------------------------------------
// API pública.
// -----------------------------------------------------------------------------

/**
 * Persiste una decisión de la política de operador ausente en el audit canónico.
 *
 * Pensado sobre todo para eventos `auto-proceed` (mutación sin firma en el
 * momento), pero acepta también `fail-closed` para dejar traza de decisiones
 * relevantes. Campos de texto libre sanitizados; enums validados.
 *
 * @param {object} params
 * @param {string|number} params.issue — issue afectado.
 * @param {string} params.gate — gate afectado ('gate3', clase custom…). NUNCA gate1/gate2 en auto-proceed.
 * @param {string} params.clase — clase de la acción.
 * @param {string} params.actor — quién ejecutó (enum cerrado).
 * @param {string} [params.scope] — scope acotado de la delegación.
 * @param {string} [params.confidenceBase] — índice/base de confianza usada (#4576).
 * @param {string} params.decision — 'auto-proceed' | 'fail-closed'.
 * @param {string} [params.reason] — motivo (sanitizado: redact + CRLF + trunc).
 * @param {string} [params.timestamp] — ISO string inyectado por el caller.
 * @param {object} [params.extra] — campos adicionales (no pisan los críticos).
 * @returns {{ ok: boolean, hash_self?: string, entry?: object, validation?: object, sanitization?: object, error?: string }}
 */
function appendDecision({ issue, gate, clase, actor, scope, confidenceBase, decision, reason, timestamp, extra } = {}) {
    const validation = validateActor(actor);
    const reasonSan = sanitizeReason(reason);
    const scopeSan = sanitizeReason(scope);
    const confBaseSan = sanitizeReason(confidenceBase);

    const entry = {
        timestamp: typeof timestamp === 'string' && timestamp.length > 0
            ? timestamp
            : new Date().toISOString(),
        pid: process.pid,
        issue: issue != null ? String(issue).slice(0, 64) : null,
        gate: typeof gate === 'string' ? gate.slice(0, 64) : null,
        clase: typeof clase === 'string' ? clase.slice(0, 128) : null,
        actor: validation.valid ? validation.normalized : null,
        scope: scopeSan.sanitized || null,
        confidence_base: confBaseSan.sanitized || null,
        decision: normalizeDecision(decision),
        reason: reasonSan.sanitized,
    };
    if (!validation.valid && actor != null) {
        entry.actor_rejected_value = String(actor).slice(0, 100);
        entry.actor_rejected_reason = validation.reason;
    }
    if (normalizeDecision(decision) === 'unknown' && decision != null) {
        entry.decision_rejected_value = String(decision).slice(0, 100);
    }
    if (reasonSan.didRedact || scopeSan.didRedact || confBaseSan.didRedact) entry.reason_redacted = true;
    if (reasonSan.didTruncate) entry.reason_truncated = true;
    if (reasonSan.didEscapeCrlf || scopeSan.didEscapeCrlf || confBaseSan.didEscapeCrlf) entry.reason_crlf_escaped = true;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const k of Object.keys(extra)) {
            if (!(k in entry)) entry[k] = extra[k];
        }
    }

    const result = auditLog.appendChained({ file: operatorAbsenceFile(), entry });
    return { ok: true, hash_self: result.hash_self, entry, validation, sanitization: reasonSan };
}

/**
 * Variante best-effort para sitios en caliente. NUNCA lanza (regla #1: el
 * pipeline no puede morir por un fallo de audit).
 * @param {object} params — mismos que `appendDecision`.
 * @returns {{ ok: boolean, error?: string }}
 */
function safeAppendDecision(params) {
    try {
        return appendDecision(params);
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

/**
 * Wrapper de `audit-log.verifyChain` sobre el archivo canónico.
 * @returns {{ ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string }}
 */
function verifyChain() {
    return auditLog.verifyChain(operatorAbsenceFile());
}

/**
 * Lee las últimas N entries (tail) para el dashboard/CLI.
 * @param {number} [n=5]
 * @returns {object[]}
 */
function tail(n = 5) {
    const all = auditLog.readAll(operatorAbsenceFile());
    if (!Array.isArray(all)) return [];
    const N = Math.max(0, Math.min(Number(n) || 0, all.length));
    return all.slice(all.length - N);
}

module.exports = {
    appendDecision,
    safeAppendDecision,
    verifyChain,
    tail,
    // Helpers/constantes exportados para tests.
    normalizeDecision,
    validateActor,
    DECISIONS,
    ACTORS,
    _paths: () => ({ OPERATOR_ABSENCE_FILE: operatorAbsenceFile() }),
};

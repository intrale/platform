// =============================================================================
// gate-signature-request.js — Delegación de la firma del operador desde el
// dashboard hacia el kernel (épico #4570 · issue #4580).
//
// QUÉ RESUELVE
// ------------
// La bandeja "Esperando tu firma" (#4580) ofrece Aprobar/Rechazar desde el
// dashboard. Por el invariante "el adaptador pide, el kernel ejecuta" (#4571
// §5.1), el dashboard NO puede mover work-files de `waiting-operator/` /
// `esperando-firma/` por su cuenta (CA-2): eso lo hace el kernel (`pulpo.js`),
// que ya es el único dueño del lifecycle y garantiza idempotencia frente a la
// vía Telegram (#4579).
//
// Este módulo es esa capa de "pedir": encola una decisión de firma en una cola
// que el kernel drena, y deja constancia en un audit-log tamper-evident
// (hash-chained) — non-repudio de quién/cuándo/decisión/issue (REQ-SEC-4580-4 /
// CA-6). NO toca el estado `waiting-operator/` ni `esperando-firma/`.
//
// SEGURIDAD
// ---------
// [REQ-SEC-4580-3 · A01] El id de issue se valida como entero (`^\d+$`) ANTES de
//   construir cualquier path (anti path-traversal).
// [A03] La decisión se valida contra una allowlist cerrada (`aprobar`/`rechazar`).
// [A09] Audit hash-chained (audit-log.appendChained), con `redactObject` sobre el
//   registro para no filtrar secrets embebidos.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const trace = require('./traceability');
const auditLog = require('./audit-log');
const redact = require('./redact');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Cola que drena el kernel (pulpo). El dashboard sólo escribe pedidos acá; NUNCA
// toca `waiting-operator/` / `esperando-firma/`.
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'gate-signature', 'pendiente');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'gate-signature-requests.jsonl');

// A03 — allowlist cerrada de decisiones (subconjunto humano-firmable). Congelado.
const DECISIONS = Object.freeze(['aprobar', 'rechazar']);

// REQ-SEC-4580-3 — allowlist estricta del id de issue.
const ISSUE_ID_RE = /^\d+$/;

/**
 * ¿`raw` es un id de issue válido (entero positivo)? Acepta number o string.
 * @param {number|string} raw
 * @returns {boolean}
 */
function isValidIssueId(raw) {
    const s = String(raw);
    return ISSUE_ID_RE.test(s) && Number(s) > 0;
}

/**
 * Encola una decisión de firma del operador para que el kernel la ejecute.
 * Idempotencia y transición REALES son responsabilidad del kernel (drena la cola
 * y aplica vía `operator-gate`); este módulo sólo "pide" + audita.
 *
 * @param {object} args
 * @param {number|string} args.issue    — id del issue (validado `^\d+$`).
 * @param {string}        args.decision — 'aprobar' | 'rechazar'.
 * @param {string}        [args.actor]  — identidad del que firma (para el audit).
 * @param {string}        [args.origen] — origen de la bandeja (metadata).
 * @param {string}        [args.remoteAddress] — ip de origen (audit).
 * @param {object}        [deps]        — { queueDir, auditFile, fsImpl, now, auditImpl }
 * @returns {{ok:boolean, status:number, issue?:number, decision?:string, request_path?:string, msg?:string}}
 */
function enqueueDecision(args = {}, deps = {}) {
    const { issue, decision } = args;

    // REQ-SEC-4580-3 — validar el id ANTES de tocar el filesystem.
    if (!isValidIssueId(issue)) {
        return { ok: false, status: 400, msg: 'issue inválido (debe ser entero positivo)' };
    }
    // A03 — decisión contra allowlist cerrada.
    if (!DECISIONS.includes(decision)) {
        return { ok: false, status: 400, msg: `decisión inválida (esperado: ${DECISIONS.join(' | ')})` };
    }

    const _fs = deps.fsImpl || fs;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const auditImpl = deps.auditImpl || auditLog;
    const queueDir = deps.queueDir || DEFAULT_QUEUE_DIR;
    const auditFile = deps.auditFile || DEFAULT_AUDIT_FILE;

    const issueNum = Number(issue);
    const ts = now();
    const record = {
        type: 'gate_signature_request',
        issue: issueNum,
        decision,
        origen: args.origen ? String(args.origen) : null,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    // A09 / CA-6 — audit hash-chained ANTES de encolar (constancia del pedido
    // aunque el enqueue fallara). Redactado para no filtrar secrets embebidos.
    let auditRes = { persisted: false };
    try {
        const redacted = redact.redactObject(record);
        const r = auditImpl.appendChained({ file: auditFile, entry: redacted, fsImpl: _fs });
        auditRes = { persisted: true, hash_self: r.hash_self };
    } catch (e) {
        auditRes = { persisted: false, error: e.message };
    }

    // Encolar el pedido para el kernel. `issueNum` es entero validado ⇒ el nombre
    // de archivo no se construye de string crudo (anti path-traversal).
    try {
        _fs.mkdirSync(queueDir, { recursive: true });
    } catch { /* idempotente */ }
    const fileName = `${issueNum}-${decision}-${ts}.json`;
    const requestPath = path.join(queueDir, fileName);
    // Defensa redundante: el path DEBE quedar dentro de queueDir.
    if (!path.resolve(requestPath).startsWith(path.resolve(queueDir) + path.sep)) {
        return { ok: false, status: 400, msg: 'path-escape' };
    }
    try {
        _fs.writeFileSync(requestPath, JSON.stringify(record), 'utf8');
    } catch (e) {
        return { ok: false, status: 500, msg: `no se pudo encolar el pedido: ${e.message}`, audit_persisted: auditRes.persisted };
    }

    return {
        ok: true,
        status: 202, // Accepted: el kernel ejecuta la transición asíncronamente.
        issue: issueNum,
        decision,
        request_path: requestPath,
        audit_persisted: auditRes.persisted,
        msg: `firma ${decision} de #${issueNum} encolada; el kernel aplicará la transición`,
    };
}

module.exports = {
    enqueueDecision,
    isValidIssueId,
    DECISIONS,
    ISSUE_ID_RE,
    DEFAULT_QUEUE_DIR,
    DEFAULT_AUDIT_FILE,
};

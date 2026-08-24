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
// [A03] La decisión se valida contra el enum del gate (`spec.verdicts`), no
//   contra una lista local — un enum duplicado es un enum que diverge.
// [A09] Audit hash-chained (audit-log.appendChained), con `redactObject` sobre el
//   registro para no filtrar secrets embebidos.
//
// #6208 · MULTI-GATE (CA-13 / CA-14 / REQ-SEC-6208-3)
// ---------------------------------------------------
// El pedido ahora declara CONTRA QUÉ GATE se firma. `gate` es el primer
// componente del nombre de archivo que viene de texto del cliente, así que se
// resuelve con `approval-channel.resolveGate()` —fail-closed ANTES de tocar el
// filesystem— y lo que se escribe es `spec.gate` (la constante del enum
// congelado), nunca el string recibido. Lo mismo con el veredicto: sale de
// `spec.verdicts`, con un shim de compatibilidad `aprobar→signed` /
// `rechazar→rejected` para los clientes viejos.
//
// El contrato de la API NO cambia de ruta (H-3 / CA-13): se extiende
// `/api/gate-signature/*`; no se crean rutas `/api/aprobaciones/*`.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
// #6226 - escritura fail-closed de dropfiles.
const dropfileWriter = require('./dropfile-writer');

const trace = require('./traceability');
const auditLog = require('./audit-log');
const redact = require('./redact');
// #6208 · CA-14 — el gate y sus veredictos salen del enum CONGELADO del kernel,
// nunca de una copia local. `resolveGate` es fail-closed antes del filesystem.
const approvalChannel = require('./approval-channel');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Cola que drena el kernel (pulpo). El dashboard sólo escribe pedidos acá; NUNCA
// toca `waiting-operator/` / `esperando-firma/`.
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'gate-signature', 'pendiente');
// #6208 — hermanos de la cola de PEDIDOS. `despachado/` usa nombre SIN timestamp
// (`<issue>-<gate>.json`): esa es la clave de idempotencia natural del drenador.
// OJO: estas tres carpetas son la cola de PEDIDOS del adaptador. NO confundir con
// `approval-channel/pendiente/`, que es el DEPÓSITO del kernel y no se drena (R2).
const DEFAULT_DISPATCHED_DIR = path.join(PIPELINE_DIR, 'gate-signature', 'despachado');
const DEFAULT_PROCESSED_DIR = path.join(PIPELINE_DIR, 'gate-signature', 'procesado');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'gate-signature-requests.jsonl');

// Compat con los clientes previos a #6208, que sólo conocían dos decisiones y
// ningún gate. Se MAPEA al vocabulario del kernel; no se persiste el string viejo.
const LEGACY_DECISION_ALIAS = Object.freeze({ aprobar: 'signed', rechazar: 'rejected' });

// Retro-compat de superficie: quien importaba `DECISIONS` sigue viendo los dos
// nombres legacy. La allowlist REAL es `resolveGate(gate).spec.verdicts`.
const DECISIONS = Object.freeze(Object.keys(LEGACY_DECISION_ALIAS));

// REQ-SEC-4580-3 — allowlist estricta del id de issue.
const ISSUE_ID_RE = /^\d+$/;

// #4778 · CA-2.2 — patrón seguro del productId para atar la firma al producto
// (no repudio). Mismo patrón que project-descriptor.isSafeId.
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** productId seguro (o null). Fail-closed: un id inseguro NO se propaga al audit. */
function safeProductId(raw) {
    const s = String(raw == null ? '' : raw);
    return PRODUCT_ID_RE.test(s) ? s : null;
}

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
 * Traduce la decisión recibida al vocabulario del gate. Acepta los veredictos
 * del kernel (`signed` / `re-definition` / `rejected`) y los nombres legacy
 * (`aprobar` / `rechazar`). Devuelve `null` si no cae en `spec.verdicts`.
 *
 * REQ-SEC-6208-3 — lo que devuelve SIEMPRE es un elemento del enum congelado,
 * así que el caller nunca construye un path con el string del cliente.
 *
 * @param {object} spec — `resolveGate(gate).spec`
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeVerdict(spec, raw) {
    const s = String(raw == null ? '' : raw);
    const mapped = Object.prototype.hasOwnProperty.call(LEGACY_DECISION_ALIAS, s)
        ? LEGACY_DECISION_ALIAS[s]
        : s;
    const idx = spec.verdicts.indexOf(mapped);
    return idx === -1 ? null : spec.verdicts[idx];
}

/**
 * Encola una decisión de firma del operador para que el kernel la ejecute.
 * Idempotencia y transición REALES son responsabilidad del kernel (drena la cola
 * y aplica vía el canal de aprobación); este módulo sólo "pide" + audita.
 *
 * #6208 · CA-12 — el dashboard ENCOLA, no firma. Ningún campo de `args` puede
 * derivar autoridad: `actor` / `origen` / `productId` viajan SÓLO al audit.
 *
 * @param {object} args
 * @param {number|string} args.issue    — id del issue (validado `^\d+$`).
 * @param {string}        args.gate     — gate del enum congelado del kernel
 *                                  (`definicion` | `aceptacion`). OBLIGATORIO
 *                                  desde #6208: se resuelve con `resolveGate`.
 * @param {string}        args.decision — veredicto (`signed` | `re-definition` |
 *                                  `rejected`) o alias legacy (`aprobar` |
 *                                  `rechazar`). Validado contra `spec.verdicts`.
 * @param {string}        [args.actor]  — identidad DECLARADA por el cliente. Va al
 *                                  audit y a NINGÚN lado más (REQ-SEC-6208-2).
 * @param {string}        [args.origen] — origen de la bandeja (metadata).
 * @param {string}        [args.productId] — #4778 · CA-2.2: producto al que se ata
 *                                  la firma (no repudio). Validado fail-closed; un
 *                                  id inseguro se descarta (queda null). Ausente ⇒
 *                                  producto único (retro-compat).
 * @param {string}        [args.remoteAddress] — ip de origen (audit).
 * @param {object}        [deps]        — { queueDir, auditFile, fsImpl, now, auditImpl }
 * @returns {{ok:boolean, status:number, issue?:number, gate?:string, verdict?:string, decision?:string, request_path?:string, msg?:string}}
 */
function enqueueDecision(args = {}, deps = {}) {
    const { issue, decision } = args;

    // REQ-SEC-4580-3 — validar el id ANTES de tocar el filesystem.
    if (!isValidIssueId(issue)) {
        return { ok: false, status: 400, msg: 'issue inválido (debe ser entero positivo)' };
    }
    // CA-14 / REQ-SEC-6208-3 — el gate se resuelve con el kernel, fail-closed y
    // ANTES de construir cualquier path. Un gate desconocido (o de
    // path-traversal) muere acá, sin tocar el filesystem.
    const g = approvalChannel.resolveGate(args.gate);
    if (!g.ok) {
        return {
            ok: false,
            status: 400,
            msg: `gate inválido (esperado: ${Object.keys(approvalChannel.GATES).join(' | ')})`,
        };
    }
    const spec = g.spec;
    // A03 — veredicto contra el enum del gate (no una lista local que diverja).
    const verdict = normalizeVerdict(spec, decision);
    if (verdict === null) {
        return {
            ok: false,
            status: 400,
            msg: `decisión inválida para el gate ${spec.gate} (esperado: ${spec.verdicts.join(' | ')})`,
        };
    }

    const _fs = deps.fsImpl || fs;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const auditImpl = deps.auditImpl || auditLog;
    const queueDir = deps.queueDir || DEFAULT_QUEUE_DIR;
    const auditFile = deps.auditFile || DEFAULT_AUDIT_FILE;

    const issueNum = Number(issue);
    const ts = now();
    // #4778 · CA-2.2 — productId seguro (o null) atado a la firma para no repudio.
    const productId = safeProductId(args.productId);
    const record = {
        type: 'gate_signature_request',
        issue: issueNum,
        // #6208 — `gate` y `verdict` salen del enum congelado, NUNCA del string
        // del cliente (REQ-SEC-6208-3). `decision` queda como espejo del
        // veredicto para los lectores viejos; no es el texto recibido.
        gate: spec.gate,
        verdict,
        decision: verdict,
        productId,
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
    // REQ-SEC-6208-3 — los cuatro componentes son seguros por construcción:
    // `issueNum` es Number() de un string `^\d+$`, `spec.gate` y `verdict` salen
    // del enum congelado del kernel y `ts` es numérico.
    const fileName = `${issueNum}-${spec.gate}-${verdict}-${ts}.json`;
    const requestPath = path.join(queueDir, fileName);
    // Defensa redundante: el path DEBE quedar dentro de queueDir.
    if (!path.resolve(requestPath).startsWith(path.resolve(queueDir) + path.sep)) {
        return { ok: false, status: 400, msg: 'path-escape' };
    }
    // #6226 - escritura fail-closed. El nombre lleva `<issue>-<gate>-<verdict>-<ts>`:
    // dos pedidos del mismo issue con la misma decision en el mismo milisegundo
    // resolvian al mismo path y el segundo pisaba al primero. Se conserva el
    // nombre; solo ante colision real se desambigua con `-<n>`.
    try {
        dropfileWriter.writeUniqueFileSync({
            dir: queueDir,
            filename: fileName,
            data: JSON.stringify(record),
            fsImpl: _fs,
            onCollision: (name, attempt) => console.warn(
                `[gate-signature-request] colision de nombre de pedido (${name}, intento ${attempt + 1}) - se reintenta, no se sobreescribe`
            ),
        });
    } catch (e) {
        return { ok: false, status: 500, msg: `no se pudo encolar el pedido: ${e.message}`, audit_persisted: auditRes.persisted };
    }

    return {
        ok: true,
        status: 202, // Accepted: el kernel ejecuta la transición asíncronamente.
        issue: issueNum,
        gate: spec.gate,
        verdict,
        decision: verdict,
        productId,
        request_path: requestPath,
        audit_persisted: auditRes.persisted,
        // D-4 (#6208) — el mensaje nombra el ESTADO REAL, no un medio que
        // todavía no está conectado. Nada acá promete una entrega.
        msg: `decisión ${verdict} de #${issueNum} (gate ${spec.gate}) anotada; falta confirmarla por el canal con identidad`,
    };
}

module.exports = {
    enqueueDecision,
    isValidIssueId,
    safeProductId,
    normalizeVerdict,
    DECISIONS,
    LEGACY_DECISION_ALIAS,
    ISSUE_ID_RE,
    DEFAULT_QUEUE_DIR,
    DEFAULT_DISPATCHED_DIR,
    DEFAULT_PROCESSED_DIR,
    DEFAULT_AUDIT_FILE,
};

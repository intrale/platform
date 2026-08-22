// =============================================================================
// operator-signature-gate.js — Gate de auto-aprobación de firma del operador.
//
// Issue: #4576 (épico #4570 — gates de firma del operador).
// Diseño: docs/pipeline/gates-firma-operador.md §4.4 / §12.
// Patrón: sigue `architect-signoff-gate.js` (kill switch, modos, fail-closed).
//
// Decide si un pedido de firma puede AUTO-APROBARSE (autonomía ganada
// empíricamente) o si DEBE ir a firma humana. Regla rectora: fail-closed
// (§12) — ante cualquier duda, corrupción o falta de datos ⇒ firma humana.
// NUNCA auto-aprueba por silencio, timeout, ni por un blend de confianza.
//
// Cadena de decisión (orden ESTRICTO):
//   CA-10 · Kill switch / disabled ⇒ firma_humana (cortocircuito, sin leer nada).
//   (grandfathering opcional por go_live_date, como el architect gate).
//   CA-5  · verifyChain(chainFile) ANTES de leer cualquier bucket. Chain roto
//           ⇒ firma_humana (fail-closed). Nunca fail-open.
//   CA-2  · Si algún criterio es solo-humano (confidence-index) ⇒ firma_humana
//           (coherente con GATE 0 → requires-operator).
//   CA-6  · resolveBucket. Bucket no calibrado ⇒ firma_humana.
//   →      · Todo OK ⇒ auto_aprobado, con muestra de auditoría aleatoria
//           (CA-11, crypto.randomBytes, NO Math.random ni seed del sujeto) y
//           traza en el audit-log (CA-11/CA-12).
//
// Modos (como architect gate): 'disabled' | 'dry-run' | 'enforce'.
//   - dry-run: computa la decisión lógica pero el `effective_decision` es
//     SIEMPRE `firma_humana` (nunca auto-aprueba de verdad — sirve para medir
//     acuerdo antes de activar). El `decision` lógico se persiste para calibrar.
//   - enforce: `effective_decision === decision`.
//
// El módulo es el ÚNICO que decide auto-aprobación. NO escribe muestras de
// calibración (eso solo lo hace `autonomy-ladder.recordHumanDecision` con una
// decisión humana real — CA-7). Sí registra la traza de cada auto-aprobación.
// =============================================================================
'use strict';

const crypto = require('crypto');
const path = require('path');

const audit = require('./audit-log');
const { decomposeConfidence, esTotalmenteMaquinaVerificable, contarSoloHumanos } = require('./confidence-index');
const ladder = require('./autonomy-ladder');
const { resolveSignerAuthority } = require('./project-descriptor');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const DECISION = Object.freeze({
    FIRMA_HUMANA: 'firma_humana',
    AUTO_APROBADO: 'auto_aprobado',
});

const MODE = Object.freeze({
    DISABLED: 'disabled',
    DRY_RUN: 'dry-run',
    ENFORCE: 'enforce',
});

// Archivos en `<pipelineDir>/audit/`.
const CALIBRATION_CHAIN_FILE = 'operator-calibration.jsonl'; // muestras + revocaciones.
const AUTOAPPROVAL_AUDIT_FILE = 'operator-autoapprovals.jsonl'; // traza de auto-aprobaciones.

// -----------------------------------------------------------------------------
// Path resolution (inyectable por tests, igual que architect-signoff-gate)
// -----------------------------------------------------------------------------

function resolvePipelineDir(options) {
    if (options && options.pipelineDir) return options.pipelineDir;
    return path.resolve(__dirname, '..');
}

function auditPath(pipelineDir, file) {
    return path.join(pipelineDir, 'audit', file);
}

// -----------------------------------------------------------------------------
// CA-11 · Muestreo de auditoría NO sembrable por el sujeto
// -----------------------------------------------------------------------------

/**
 * Decide si una auto-aprobación cae en la muestra de auditoría humana. Usa
 * `crypto.randomBytes` (CSPRNG) — NUNCA `Math.random()` ni un seed derivado del
 * issue/criterios (CA-11). El sujeto auditado no puede predecir ni reproducir
 * la selección desde su input.
 *
 * `rngFloat` es inyectable SOLO para tests deterministas; en runtime queda el
 * CSPRNG. No se acepta seed del caller de producción.
 *
 * @param {number} auditoriaPct — porcentaje [0,100].
 * @param {function} [rngFloat] — devuelve un float en [0,1). Solo para tests.
 * @returns {boolean}
 */
function seleccionarAuditoria(auditoriaPct, rngFloat) {
    const pct = Number(auditoriaPct);
    if (!Number.isFinite(pct) || pct <= 0) return false;
    if (pct >= 100) return true;
    const r = typeof rngFloat === 'function'
        ? rngFloat()
        : crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
    return r < (pct / 100);
}

// -----------------------------------------------------------------------------
// Traza de auto-aprobación (CA-11/CA-12) en audit-log tamper-evident
// -----------------------------------------------------------------------------

/**
 * Persiste la traza de una auto-aprobación en el audit-log tamper-evident.
 * Registra bucket, versión de calibración y flag `en_muestra_auditoria`
 * (CA-11) + trazabilidad general (CA-12). Best-effort: un fallo de FS no debe
 * abortar la decisión ya tomada (pero el fallo se refleja en el retorno).
 *
 * @returns {{ persistido: boolean, hash_self?: string, error?: string }}
 */
function _persistAutoApproval(pipelineDir, record, auditImpl) {
    const _audit = auditImpl || audit;
    try {
        const file = auditPath(pipelineDir, AUTOAPPROVAL_AUDIT_FILE);
        const res = _audit.appendChained({ file, entry: record });
        return { persistido: true, hash_self: res.hash_self };
    } catch (e) {
        return { persistido: false, error: e.message };
    }
}

// -----------------------------------------------------------------------------
// Evaluación principal
// -----------------------------------------------------------------------------

/**
 * Evalúa el gate de auto-aprobación de firma. API pura respecto de la decisión
 * (el único side-effect es la traza append-only de una auto-aprobación).
 *
 * @param {object} args
 * @param {object} args.issue — `{ number, tipoIssue, createdAt }`.
 * @param {string} args.fase — fase del gate ('criterios'|'aprobacion').
 * @param {Array<string|object>} args.criterios — criterios de aceptación.
 * @param {object} [args.gateResults] — mapa `{ criterioKey: 'pass'|'fail' }`.
 * @param {object} args.config — `config.firma_operador` (ver config.yaml).
 * @param {object} [args.descriptor] — descriptor del producto en curso (Ola Puente
 *   P7 #4692). La autoridad de firma (quién puede firmar / backup) se resuelve
 *   SIEMPRE desde `descriptor.authority` — NUNCA un global implícito ni un
 *   `leitolarreta` hardcodeado. FAIL-CLOSED: ausente/ inválido ⇒ firma humana.
 * @param {object} [args.options] — `{ pipelineDir, nowMs, rngFloat, auditImpl }`.
 * @returns {object} `{ decision, effective_decision, gate_mode, authorized_signers, ... }`.
 */
function evaluateSignatureGate({ issue = {}, fase, criterios = [], gateResults = {}, config = {}, descriptor, options = {} } = {}) {
    const pipelineDir = resolvePipelineDir(options);
    const auditImpl = options.auditImpl || audit;
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

    // CA-10 · Kill switch / disabled ⇒ cortocircuito completo. Default seguro.
    if (config.enabled !== true || config.kill_switch === true) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: MODE.DISABLED,
            skipped: true,
            reason: config.kill_switch === true ? 'kill_switch activo' : 'gate disabled (enabled !== true)',
            invoked: false,
        };
    }

    const gateMode = config.modo === MODE.ENFORCE ? MODE.ENFORCE : MODE.DRY_RUN;

    // CA-1 (P7 #4692) · Autoridad de firma POR PRODUCTO, fail-closed. Se resuelve
    // desde el descriptor del producto en curso, delegando en la ÚNICA fuente de
    // verdad (`resolveSignerAuthority` en project-descriptor.js). Sin descriptor,
    // o con `authority.signers` vacío/inválido, NO se puede saber quién firma ⇒
    // firma humana (jamás auto-aprobación ni global implícito). Antes de cualquier
    // lectura de calibración: si no sabemos quién puede firmar, no hay nada que
    // auto-aprobar.
    const authority = resolveSignerAuthority(descriptor || {});
    if (!descriptor || authority.blocked) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: gateMode,
            fail_closed: true,
            reason: !descriptor
                ? 'sin descriptor de producto ⇒ firma humana (fail-closed, sin global implícito)'
                : `autoridad de firma inválida: ${authority.reason}`,
            project_id: authority.projectId,
            authorized_signers: [],
            backup_approver: authority.backup || null,
            invoked: true,
        };
    }

    // Autoridad válida resuelta desde el descriptor. Se adjunta a TODA resolución
    // (incluidas las de firma humana) para que la superficie humana sepa quién
    // puede firmar este producto — extiende `project_id` hasta la capa de decisión.
    const authFields = {
        project_id: authority.projectId,
        authorized_signers: authority.signers,
        backup_approver: authority.backup || null,
    };

    // Grandfathering opcional (como architect gate): issues previos a go_live_date
    // NO se auto-aprueban — al contrario, van a firma humana (fail-closed). Se
    // registra la razón. (No relajamos el default seguro por antigüedad.)
    const goLiveDate = config.go_live_date || null;
    if (goLiveDate && typeof issue.createdAt === 'string' && issue.createdAt < goLiveDate) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: gateMode,
            reason: 'issue previo a go_live_date ⇒ firma humana (sin auto-aprobación retroactiva)',
            ...authFields,
            invoked: true,
        };
    }

    const chainFile = auditPath(pipelineDir, CALIBRATION_CHAIN_FILE);

    // CA-5 · verifyChain ANTES de leer cualquier bucket. Fail-closed.
    let chainRes;
    try {
        chainRes = auditImpl.verifyChain(chainFile);
    } catch (e) {
        chainRes = { ok: false, reason: `verifyChain lanzó: ${e.message}` };
    }
    if (!chainRes || chainRes.ok !== true) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: gateMode,
            fail_closed: true,
            reason: `chain_roto: ${(chainRes && chainRes.reason) || 'verifyChain no ok'}`,
            ...authFields,
            invoked: true,
        };
    }

    // CA-1/CA-2 · Descomposición de confianza (sin blend). Si hay algún criterio
    // solo-humano ⇒ firma humana (coherente con GATE 0 → requires-operator).
    const index = decomposeConfidence({ criterios, gateResults });
    const soloHumanos = contarSoloHumanos(index);
    if (!esTotalmenteMaquinaVerificable(index)) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: gateMode,
            reason: soloHumanos > 0
                ? `${soloHumanos} criterio(s) solo-humano ⇒ firma humana (GATE 0)`
                : 'sin criterios máquina-verificables ⇒ firma humana',
            confidence_index: index,
            ...authFields,
            invoked: true,
        };
    }

    // CA-6 · Bucket calibrado. Se recomputa desde muestras inmutables (CA-9).
    const bucket = ladder.resolveBucket({
        chainFile,
        bucket: { fase, tipoIssue: issue.tipoIssue },
        config,
        nowMs,
        auditImpl,
    });
    if (!bucket.calibrado) {
        return {
            decision: DECISION.FIRMA_HUMANA,
            effective_decision: DECISION.FIRMA_HUMANA,
            gate_mode: gateMode,
            reason: `bucket no calibrado: ${bucket.razon}`,
            bucket: bucket.id,
            confidence_index: index,
            ...authFields,
            invoked: true,
        };
    }

    // Todas las condiciones OK ⇒ auto_aprobado (lógico).
    // CA-11 · muestra de auditoría aleatoria no sembrable por el sujeto.
    const enAuditoria = seleccionarAuditoria(config.auditoria_pct, options.rngFloat);
    const decision = DECISION.AUTO_APROBADO;

    // R3 (patrón architect): dry-run nunca auto-aprueba efectivamente.
    const effectiveDecision = gateMode === MODE.ENFORCE ? decision : DECISION.FIRMA_HUMANA;

    // Traza append-only (CA-11/CA-12): bucket, versión, flag auditoría.
    const traza = _persistAutoApproval(pipelineDir, {
        type: 'auto_aprobacion',
        issue: issue.number != null ? String(issue.number) : null,
        // CA-1/seguridad #2 · projectId en la traza: la auditoría no confunde
        // productos cuando la autoridad de firma es por producto (cross-tenant).
        project_id: authority.projectId,
        fase: fase != null ? String(fase) : null,
        bucket: bucket.id,
        version_calibracion: bucket.version,
        acuerdo_pct: bucket.acuerdo_pct,
        muestras: bucket.muestras,
        decision,
        effective_decision: effectiveDecision,
        gate_mode: gateMode,
        en_muestra_auditoria: enAuditoria,
        created_at: nowMs,
    }, auditImpl);

    return {
        decision,
        effective_decision: effectiveDecision,
        gate_mode: gateMode,
        reason: gateMode === MODE.ENFORCE
            ? `auto-aprobado por bucket calibrado (${bucket.razon})`
            : `dry-run: lógica auto_aprobado pero effective firma_humana (${bucket.razon})`,
        bucket: bucket.id,
        version_calibracion: bucket.version,
        en_muestra_auditoria: enAuditoria,
        confidence_index: index,
        traza_persistida: traza.persistido,
        ...authFields,
        invoked: true,
    };
}

/**
 * Autoriza (o niega, fail-closed) que una `identity` firme GATE 2 del producto
 * en curso (Ola Puente P7 #4692 · cross-tenant authz). Delega en la única fuente
 * de verdad del descriptor (`authorizeSigner` en project-descriptor.js) — un
 * firmante autorizado en A NO puede firmar en B. Reexportado acá porque el gate
 * operativo es el punto de entrada natural de la capa de firma.
 *
 * @param {object} descriptor  descriptor del producto en curso.
 * @param {string} identity    identidad que intenta firmar.
 * @returns {{ authorized:boolean, role:('signer'|'backup'|null), reason:string, projectId:string|null }}
 */
function authorizeProductSigner(descriptor, identity) {
    return require('./project-descriptor').authorizeSigner(descriptor, identity);
}

module.exports = {
    evaluateSignatureGate,
    authorizeProductSigner,
    seleccionarAuditoria,
    // Constantes / helpers exportados para tests y callers.
    DECISION,
    MODE,
    CALIBRATION_CHAIN_FILE,
    AUTOAPPROVAL_AUDIT_FILE,
    auditPath,
    resolvePipelineDir,
};

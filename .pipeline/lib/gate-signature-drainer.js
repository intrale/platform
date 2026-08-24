'use strict';

// =============================================================================
// gate-signature-drainer.js — Drenador de `gate-signature/pendiente/` (#6208 ·
// A-2 / CA-6 · parte 3 del split de #6199).
//
// QUÉ RESUELVE
// ------------
// `gate-signature-request.enqueueDecision` encola un `gate_signature_request`
// desde la bandeja del dashboard, pero hasta este módulo NADIE drenaba esa cola:
// el endpoint devolvía `202 Accepted`, la UI recargaba y no pasaba nada. Un
// falso éxito silencioso, que es exactamente el defecto que la historia mata.
//
// EL DRENADOR NO FIRMA — DESPACHA (D-1 · cierra la tensión CA-12 ↔ CA-10)
// ----------------------------------------------------------------------
// `approval-channel.submitSignature` exige un token con binding `(g,h)`
// (`approval-channel.js:1205-1216`) que `requestSignature` DELIBERADAMENTE no
// persiste en el depósito — es una capability bearer, y el propio kernel lo
// anota: "OJO: `token` NO va acá". Un drenador que llamara `submitSignature`
// con el pedido del dashboard se rechazaría SIEMPRE. No es un bug a esquivar:
// es el diseño. El dashboard corre en loopback sin identidad de persona;
// `dashboard-local` no es un firmante y no puede serlo.
//
// Entonces este módulo VALIDA la intención del operador y la entrega al medio
// que sí porta identidad, por una costura inyectada (`deps.dispatchToCarrier`,
// la costura de #6207). **Nunca invoca `submitSignature` ni ningún writer de
// gate.** Sin carrier conectado el pedido queda en `pendiente/` y la fila
// muestra el estado real; jamás "firmado".
//
// ESTADOS COMO CARPETAS (idioma del pipeline), clave `(issue, gate)`
// ------------------------------------------------------------------
//   gate-signature/pendiente/                    el dashboard encoló
//   gate-signature/despachado/<issue>-<gate>.json  validado + carrier aceptó
//   gate-signature/procesado/                    terminal (rechazado/superseded)
//
// `despachado/` va SIN timestamp a propósito: ese nombre es la idempotencia
// natural (CA-7). Un segundo pedido vivo del mismo `(issue,gate)` es
// `superseded` → `procesado/`, nunca un segundo despacho.
//
// SEGURIDAD / INTEGRIDAD
// ----------------------
// [CA-9 / REQ-SEC-6208-5 · R2] Hay DOS colas homónimas con semántica opuesta:
//   `gate-signature/pendiente` (PEDIDOS, se drenan) y
//   `approval-channel/pendiente` (DEPÓSITO del kernel, NO se drena). Drenar la
//   segunda borraría los pendientes de firma reales y `listPending` no lo
//   distinguiría de "está todo firmado". Por eso hay una guarda ESTRUCTURAL
//   antes de leer nada, y este módulo NO tiene ningún `unlinkSync` cuyo path
//   derive de `DEFAULT_DEPOSIT_DIR`: limpiar el depósito es potestad exclusiva
//   de `resolvePending`, que ya corre dentro de `submitSignature`.
// [CA-12 / REQ-SEC-6208-2 · A01] Autoridad FUERA DE BANDA. Del pedido se toman
//   exactamente tres campos: `issue` (`^\d+$`), `gate` (`resolveGate`) y el
//   veredicto (∈ `spec.verdicts`). `actor`, `origen` y `productId` viajan SÓLO
//   al audit y NO pueden tocar `signersFor` / `authorizedSigners` ni la
//   identidad del carrier. Molde: `product-control-drainer.js:265-268`.
// [CA-14 / REQ-SEC-6208-3] `gate` se resuelve contra el enum congelado ANTES de
//   construir ningún path, y el path se arma con `spec.gate` (la constante),
//   nunca con el string recibido.
// [CA-8] Un archivo corrupto se aísla y el resto de la pasada sigue. El audit
//   nunca tumba el drenaje. El drenador nunca lanza al bucle de servicios.
// =============================================================================

const fsDefault = require('fs');
const path = require('path');

const trace = require('./traceability');
const auditLogDefault = require('./audit-log');
const redact = require('./redact');

const approvalChannel = require('./approval-channel');
const gateSignatureRequest = require('./gate-signature-request');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

const DEFAULT_QUEUE_DIR = gateSignatureRequest.DEFAULT_QUEUE_DIR;
const DEFAULT_DISPATCHED_DIR = gateSignatureRequest.DEFAULT_DISPATCHED_DIR;
const DEFAULT_PROCESSED_DIR = gateSignatureRequest.DEFAULT_PROCESSED_DIR;
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'gate-signature-drainer.jsonl');

/** Único `type` que este drenador toca. Otro tipo se ignora sin moverlo. */
const REQUEST_TYPE = 'gate_signature_request';

/**
 * Nombre del marker de despacho de `(issue, gate)`. SIN timestamp: es la clave
 * de idempotencia (CA-7). Ambos componentes ya vienen validados.
 */
function dispatchKey(issue, gate) {
    return `${Number(issue)}-${gate}`;
}

/**
 * Path del marker de despacho, con contención redundante (molde de
 * `approval-channel.depositPathFor`). `null` si escaparía del directorio.
 */
function dispatchPathFor(dispatchedDir, issue, gate) {
    const file = path.join(dispatchedDir, `${dispatchKey(issue, gate)}.json`);
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(dispatchedDir) + path.sep)) return null;
    return resolved;
}

/**
 * Mueve un pedido de `pendiente/` a `procesado/` (terminal). Si falla, el caller
 * lo trata como error recuperable (el pedido queda en `pendiente/`).
 */
function moveToProcessed(fileName, queueDir, processedDir, _fs) {
    try { _fs.mkdirSync(processedDir, { recursive: true }); } catch { /* idempotente */ }
    const from = path.join(queueDir, fileName);
    const to = path.join(processedDir, fileName);
    _fs.renameSync(from, to);
    return to;
}

/**
 * CA-9 / REQ-SEC-6208-5 — guarda ESTRUCTURAL. El `queueDir` jamás puede caer
 * dentro del depósito del kernel: drenar el depósito borra los pendientes de
 * firma reales y eso es indistinguible de "está todo firmado".
 *
 * Se evalúa ANTES de leer nada. Lanza a propósito: es un error de programación
 * del call-site, no una condición de runtime que se pueda degradar.
 */
function assertNotKernelDeposit(queueDir, depositDir) {
    const deposito = path.resolve(depositDir);
    const cola = path.resolve(queueDir);
    if (cola === deposito || cola.startsWith(deposito + path.sep)) {
        throw new Error('gate-signature-drainer: queueDir apunta al depósito del kernel — abortado');
    }
}

/**
 * Drena la cola de pedidos de firma del dashboard.
 *
 * Orden fail-closed dentro del loop (CA-8 / CA-14): `readdir` → filtrar `.json`
 * → `JSON.parse` en `try` (corrupto ⇒ terminal) → `type` correcto (otro tipo ⇒
 * se ignora, no se toca) → `issue` válido → `resolveGate` → veredicto ∈
 * `spec.verdicts` → existe pendiente `(issue,gate)` en el depósito → no
 * despachado todavía → `dispatchToCarrier`. **Todo antes de construir un path
 * con `gate`.**
 *
 * @param {object} [opts]  { queueDir, dispatchedDir, processedDir, auditFile }
 * @param {object} [deps]
 *   @param {function} [deps.dispatchToCarrier] — costura de #6207. Recibe la
 *     intención `{issue, gate, verdict, pending}` y devuelve
 *     `{ok:true, carrier:'telegram', dispatched_at}`. **Default `null`**: sin
 *     medio con identidad el pedido queda en `pendiente/` y la fila muestra
 *     "anotada, falta confirmarla" — nunca "firmado".
 *   @param {object} [deps.fsImpl] @param {object} [deps.auditImpl]
 *   @param {function} [deps.now] @param {object} [deps.approvalImpl]
 * @returns {{dispatched:Array, superseded:Array, rejected:Array, waiting:Array, errors:Array}}
 */
function drainGateSignatureQueue(opts = {}, deps = {}) {
    const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
    const dispatchedDir = opts.dispatchedDir || DEFAULT_DISPATCHED_DIR;
    const processedDir = opts.processedDir || DEFAULT_PROCESSED_DIR;
    const auditFile = opts.auditFile || DEFAULT_AUDIT_FILE;
    const _fs = deps.fsImpl || fsDefault;
    const auditImpl = deps.auditImpl || auditLogDefault;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const approval = deps.approvalImpl || approvalChannel;
    // D-1 — sin carrier NO se despacha nada. El default es `null` a propósito:
    // #6207 (el medio con identidad) está fuera del alcance de esta parte.
    const dispatchToCarrier = typeof deps.dispatchToCarrier === 'function'
        ? deps.dispatchToCarrier
        : null;

    const summary = { dispatched: [], superseded: [], rejected: [], waiting: [], errors: [] };

    // CA-9 — la guarda va PRIMERO, antes de cualquier lectura.
    const depositDir = (deps.approvalDeps && deps.approvalDeps.depositDir)
        || opts.depositDir
        || approval.DEFAULT_DEPOSIT_DIR;
    assertNotKernelDeposit(queueDir, depositDir);

    const audit = (entry) => {
        try {
            auditImpl.appendChained({ file: auditFile, entry: redact.redactObject(entry), fsImpl: _fs });
        } catch { /* el audit no puede tumbar el drenaje (CA-8) */ }
    };

    let entries;
    try {
        entries = _fs.readdirSync(queueDir);
    } catch {
        return summary; // cola inexistente/ilegible ⇒ nada que drenar (fail-open).
    }

    // Sin pedidos no hay nada que hacer: se sale ANTES de leer el depósito. Esto
    // corre en el bucle de servicios del Pulpo cada tick, y el caso normal es la
    // cola vacía — no vale gastar un `listPending` (que lee `config.yaml`) por
    // tick para descubrir que no había nada.
    const pedidos = (Array.isArray(entries) ? entries : []).filter(f => /\.json$/i.test(f));
    if (pedidos.length === 0) return summary;

    // Índice de pendientes REALES del kernel, leído UNA vez por pasada. Es
    // read-only: este módulo no borra ni escribe nada dentro del depósito.
    let pendingIndex = new Map();
    let depositReadable = true;
    try {
        const listed = approval.listPending({}, deps.approvalDeps || { fsImpl: _fs, depositDir });
        depositReadable = !!(listed && listed.ok);
        for (const p of (listed && listed.pending) || []) {
            pendingIndex.set(dispatchKey(p.issue, p.gate), p);
        }
    } catch (e) {
        depositReadable = false;
        audit({ type: 'gate_signature_drain_result', outcome: 'error', reason: `deposit-unreadable: ${e.message}`, at: now() });
    }

    // Fail-closed: si no pudimos leer el depósito, NO despachamos nada. Un
    // pedido sin pendiente legible no es "ya no hace falta"; es que no sabemos.
    // Los pedidos quedan en `pendiente/` para el próximo ciclo.
    if (!depositReadable) {
        summary.errors.push({ file: null, reason: 'deposito-ilegible: se retiene la cola para el próximo ciclo' });
        return summary;
    }

    // Claves ya despachadas en ESTA pasada (además del marker en disco), para
    // que dos pedidos del mismo `(issue,gate)` en el mismo barrido no despachen
    // dos veces (CA-7).
    const dispatchedThisPass = new Set();

    const terminal = (fileName, outcome, reason, extra = {}) => {
        summary[outcome === 'superseded' ? 'superseded' : 'rejected'].push({ file: fileName, reason, ...extra });
        audit({ type: 'gate_signature_drain_result', outcome, reason, file: fileName, at: now(), ...extra });
        try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
        catch (me) { summary.errors.push({ file: fileName, reason: `move-failed: ${me.message}` }); }
    };

    for (const fileName of pedidos) {
        const full = path.join(queueDir, fileName);

        let record;
        try {
            record = JSON.parse(_fs.readFileSync(full, 'utf8'));
        } catch (e) {
            // CA-8 — corrupto/truncado/vacío ⇒ terminal, aislado, y la pasada sigue.
            terminal(fileName, 'rejected', 'unparseable');
            continue;
        }

        // Sólo se drenan pedidos de firma; otro tipo NO se toca (no es nuestro).
        if (!record || record.type !== REQUEST_TYPE) continue;

        // CA-14 — issue válido ANTES de nada.
        if (!approval.isValidIssueId(record.issue)) {
            terminal(fileName, 'rejected', 'issue-invalido');
            continue;
        }
        const issue = Number(record.issue);

        // CA-14 / REQ-SEC-6208-3 — gate contra el enum congelado, ANTES de
        // construir cualquier path. Un `gate` de path-traversal muere acá.
        const g = approval.resolveGate(record.gate);
        if (!g.ok) {
            terminal(fileName, 'rejected', 'gate-fuera-del-enum', { issue });
            continue;
        }
        const spec = g.spec;

        // Veredicto ∈ `spec.verdicts` (con shim legacy). Nunca el string crudo.
        const verdict = gateSignatureRequest.normalizeVerdict(spec, record.verdict != null ? record.verdict : record.decision);
        if (verdict === null) {
            terminal(fileName, 'rejected', 'veredicto-fuera-del-enum', { issue, gate: spec.gate });
            continue;
        }

        const key = dispatchKey(issue, spec.gate);

        // CA-11 — ¿sigue habiendo un pendiente real en el depósito del kernel?
        // Si no, el pedido es de un botón viejo: terminal, sin efecto y sin
        // revertir nada. La firma vive en el audit chain del gate, no acá.
        const pending = pendingIndex.get(key);
        if (!pending) {
            terminal(fileName, 'rejected', 'no-pending', { issue, gate: spec.gate, verdict });
            continue;
        }

        // CA-7 — idempotencia por `(issue, gate)`: marker sin timestamp.
        const marker = dispatchPathFor(dispatchedDir, issue, spec.gate);
        if (marker === null) {
            terminal(fileName, 'rejected', 'path-escape', { issue, gate: spec.gate });
            continue;
        }
        let yaDespachado = dispatchedThisPass.has(key);
        if (!yaDespachado) {
            try { yaDespachado = _fs.existsSync(marker); } catch { yaDespachado = false; }
        }
        if (yaDespachado) {
            terminal(fileName, 'superseded', 'ya-despachado', { issue, gate: spec.gate, verdict });
            continue;
        }

        // D-1 — sin medio con identidad conectado NO se despacha: el pedido
        // queda en `pendiente/` y la bandeja muestra "anotada, falta
        // confirmarla". Esto NO es un error: es el estado real del rollout
        // mientras #6207 siga abierta.
        if (!dispatchToCarrier) {
            summary.waiting.push({ file: fileName, issue, gate: spec.gate, verdict });
            continue;
        }

        // REQ-SEC-6208-2 — la intención lleva SÓLO los tres campos validados.
        // `actor` / `origen` / `productId` NO viajan al carrier: la identidad la
        // resuelve el medio que la porta, nunca un dato en banda.
        let res;
        try {
            res = dispatchToCarrier({ issue, gate: spec.gate, verdict, pending });
        } catch (e) {
            // Recuperable ≠ terminal: queda en `pendiente/` para el próximo ciclo.
            summary.errors.push({ file: fileName, reason: `carrier-failed: ${e.message}` });
            audit({ type: 'gate_signature_drain_result', outcome: 'error', reason: `carrier-failed: ${e.message}`, issue, gate: spec.gate, file: fileName, at: now() });
            continue;
        }
        if (!res || res.ok !== true) {
            const reason = (res && res.reason) || 'carrier-rechazo';
            summary.errors.push({ file: fileName, reason: `carrier-no-ok: ${reason}` });
            audit({ type: 'gate_signature_drain_result', outcome: 'error', reason: `carrier-no-ok: ${reason}`, issue, gate: spec.gate, file: fileName, at: now() });
            continue;
        }

        const carrier = typeof res.carrier === 'string' && res.carrier.trim() !== ''
            ? res.carrier.trim().slice(0, 32)
            : 'desconocido';
        const dispatchedAt = Number.isFinite(Number(res.dispatched_at)) ? Number(res.dispatched_at) : now();

        // Marker de despacho ANTES de mover el pedido: si el move falla, el
        // próximo ciclo ve el marker y aparta el pedido como `superseded` —
        // idempotente, sin estado a medias ni segundo despacho.
        try {
            _fs.mkdirSync(dispatchedDir, { recursive: true });
            _fs.writeFileSync(marker, JSON.stringify({
                type: 'gate_signature_dispatch',
                issue,
                gate: spec.gate,
                verdict,
                carrier,
                dispatched_at: dispatchedAt,
                source_file: fileName,
            }), 'utf8');
        } catch (e) {
            summary.errors.push({ file: fileName, reason: `marker-write-failed: ${e.message}` });
            audit({ type: 'gate_signature_drain_result', outcome: 'error', reason: `marker-write-failed: ${e.message}`, issue, gate: spec.gate, file: fileName, at: now() });
            continue;
        }
        dispatchedThisPass.add(key);

        summary.dispatched.push({ file: fileName, issue, gate: spec.gate, verdict, carrier, dispatched_at: dispatchedAt });
        // REQ-SEC-6208-2 — `actor`/`origen` van al AUDIT y a ningún otro lado.
        audit({
            type: 'gate_signature_drain_result',
            outcome: 'dispatched',
            issue,
            gate: spec.gate,
            verdict,
            carrier,
            declared_actor: record.actor == null ? null : String(record.actor),
            declared_origen: record.origen == null ? null : String(record.origen),
            file: fileName,
            at: now(),
        });

        try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
        catch (me) { summary.errors.push({ file: fileName, reason: `dispatched-but-move-failed: ${me.message}` }); }
    }

    return summary;
}

module.exports = {
    drainGateSignatureQueue,
    // Helpers exportados para tests.
    dispatchKey,
    dispatchPathFor,
    assertNotKernelDeposit,
    moveToProcessed,
    REQUEST_TYPE,
    DEFAULT_QUEUE_DIR,
    DEFAULT_DISPATCHED_DIR,
    DEFAULT_PROCESSED_DIR,
    DEFAULT_AUDIT_FILE,
};

'use strict';

// =============================================================================
// product-control-request.js — Delegación del control multi-producto desde el
// dashboard hacia el kernel (Ola Puente P6 · #4778 · split A de #4691).
//
// QUÉ RESUELVE
// ------------
// El dashboard product-aware ofrece onboarding (wizard del descriptor), arranque
// y pausa por producto. Por el invariante "el adaptador pide, el kernel ejecuta"
// (#4571 §5.1, igual que gate-signature-request.js), el dashboard NO registra ni
// arranca/pausa productos por su cuenta: encola un pedido en una cola que el
// kernel (`pulpo.js` / supervisor) drena y ejecuta con AUTORIZACIÓN out-of-band
// contra el contexto de la instancia — nunca desde el `projectId` en banda.
//
// La VALIDACIÓN fail-closed del descriptor de onboarding (schema + prompt-injection
// + path-traversal + SSRF allowlist + gate de firma) se DELEGA en
// `project-bootstrap.runBootstrap({ mode:'dry-run' })`, que ya implementa toda esa
// cadena side-effect-free (CA-1.1 · SEC-6). No se reimplementa validación laxa acá.
//
// SEGURIDAD
// ---------
// [SEC-1b · A01] `isSafeId(projectId)` fail-closed ANTES de construir cualquier
//   path/nombre de archivo (anti path-traversal / IDOR). El kernel es quien decide
//   si el contexto está autorizado para ese producto al drenar la cola.
// [SEC-6 · A10] SSRF de `repositories[].url`/`board.ref` la impone runBootstrap
//   (allowlist de host, rechazo de IP interna/loopback/link-local/metadata).
// [SEC-7a · A08] Acciones mutantes = POST + CSRF (lo aplica el endpoint del
//   dashboard). Este módulo nunca expone un disparador GET con efecto de estado.
// [SEC-7b · A09] Audit hash-chained (audit-log.appendChained) redactado
//   (redact.redactObject) por pedido — non-repudio de quién/qué/cuándo/productId.
// [SEC-4 · A02] El descriptor referencia secretos sólo por `ref#scope`; el audit
//   se redacta igual como defensa en profundidad. Nunca se resuelve un secreto acá.
// =============================================================================

const fs = require('fs');
const path = require('path');

const trace = require('./traceability');
const auditLog = require('./audit-log');
const redact = require('./redact');
const { isSafeId } = require('./project-descriptor');
const bootstrap = require('./project-bootstrap');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Cola que drena el kernel (pulpo/supervisor). El dashboard sólo escribe pedidos
// acá; NUNCA muta `descriptors/registry.json` ni el estado de instancias.
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'product-control', 'pendiente');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'product-control-requests.jsonl');

// A03 — allowlist cerrada de acciones de control de ciclo de vida. Congelada.
const CONTROL_ACTIONS = Object.freeze(['start', 'pause']);

// CA-5.1 — default retro-compatible: sin productId explícito, el kernel mapea al
// producto único (Intrale). Se materializa como constante para el audit/pedido,
// pero la AUTORIZACIÓN sigue siendo out-of-band del kernel (no bypass · SEC-9).
const DEFAULT_PRODUCT_ID = 'intrale';

// -----------------------------------------------------------------------------
// Audit + enqueue común. `fileBase` ya viene construido con ids validados
// (isSafeId) — nunca de string crudo. Deja constancia en el audit ANTES de
// encolar (aunque el enqueue fallara) y valida que el path quede dentro de la cola.
// -----------------------------------------------------------------------------
function auditAndEnqueue(record, fileBase, deps) {
    const _fs = deps.fsImpl || fs;
    const auditImpl = deps.auditImpl || auditLog;
    const queueDir = deps.queueDir || DEFAULT_QUEUE_DIR;
    const auditFile = deps.auditFile || DEFAULT_AUDIT_FILE;

    // SEC-7b / A09 — audit hash-chained redactado (defensa contra secrets embebidos).
    let auditRes = { persisted: false };
    try {
        const redacted = redact.redactObject(record);
        const r = auditImpl.appendChained({ file: auditFile, entry: redacted, fsImpl: _fs });
        auditRes = { persisted: true, hash_self: r && r.hash_self };
    } catch (e) {
        auditRes = { persisted: false, error: e.message };
    }

    try {
        _fs.mkdirSync(queueDir, { recursive: true });
    } catch { /* idempotente */ }

    const fileName = `${fileBase}.json`;
    const requestPath = path.join(queueDir, fileName);
    // Defensa redundante: el path DEBE quedar dentro de queueDir (anti path-escape).
    if (!path.resolve(requestPath).startsWith(path.resolve(queueDir) + path.sep)) {
        return { ok: false, status: 400, msg: 'path-escape', audit_persisted: auditRes.persisted };
    }
    try {
        _fs.writeFileSync(requestPath, JSON.stringify(record), 'utf8');
    } catch (e) {
        return { ok: false, status: 500, msg: `no se pudo encolar el pedido: ${e.message}`, audit_persisted: auditRes.persisted };
    }
    return { ok: true, status: 202, request_path: requestPath, audit_persisted: auditRes.persisted };
}

/**
 * Encola el ALTA de un producto (onboarding por wizard). Valida el descriptor
 * fail-closed vía `project-bootstrap.runBootstrap` en modo dry-run (schema +
 * prompt-injection + path-traversal + SSRF + gate de firma), SIN efectos de lado;
 * sólo si pasa, encola el pedido para que el kernel registre el producto como
 * `onboarding` (INACTIVO) hasta OK humano.
 *
 * @param {object} args
 * @param {object} args.descriptor      — descriptor del producto (parseado).
 * @param {string} [args.actor]         — identidad del operador (audit).
 * @param {string} [args.remoteAddress] — ip de origen (audit).
 * @param {object} [deps]               — { queueDir, auditFile, fsImpl, now, auditImpl, runBootstrap, bootstrapDeps }
 * @returns {{ok:boolean, status:number, projectId?:string, stage?:string, errors?:Array, request_path?:string, msg?:string}}
 */
function enqueueOnboard(args = {}, deps = {}) {
    const descriptor = args.descriptor;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        return { ok: false, status: 400, msg: 'descriptor ausente o inválido (se esperaba un objeto)' };
    }

    // CA-1.1 / SEC-6 — validación fail-closed + SSRF DELEGADA en el bootstrap
    // (side-effect-free en dry-run). kernelFloor='enforce': los gates no se relajan.
    const runBootstrap = typeof deps.runBootstrap === 'function' ? deps.runBootstrap : bootstrap.runBootstrap;
    let boot;
    try {
        boot = runBootstrap({
            descriptor,
            mode: 'dry-run',
            deps: Object.assign({ kernelGateFloor: 'enforce' }, deps.bootstrapDeps || {}),
        });
    } catch (e) {
        return { ok: false, status: 500, msg: `validación de bootstrap falló: ${e.message}` };
    }
    if (!boot || !boot.ok) {
        // Fail-closed: descriptor inválido / SSRF / gate de firma ⇒ 400, sin encolar.
        return {
            ok: false,
            status: 400,
            stage: boot ? boot.stage : 'bootstrap',
            errors: (boot && boot.errors) || [{ path: '(root)', detail: 'bootstrap rechazó el descriptor' }],
            msg: 'descriptor rechazado (fail-closed)',
        };
    }

    // Defensa en profundidad: el projectId ya lo validó el bootstrap; re-asertar
    // antes de usarlo en el nombre de archivo (SEC-1b / anti path-traversal).
    const projectId = descriptor.identity && descriptor.identity.projectId;
    if (!isSafeId(projectId)) {
        return { ok: false, status: 400, msg: 'projectId inseguro para namespacing' };
    }

    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_onboard_request',
        projectId,
        descriptor,                         // sólo refs de secreto (no valores) — se redacta igual
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `onboard-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `alta de "${projectId}" encolada; el kernel registrará el producto en estado onboarding (inactivo) hasta OK humano`,
    };
}

/**
 * Encola una acción de ciclo de vida (start/pause) de un producto. El dashboard
 * NO arranca/pausa por su cuenta: delega en el kernel (`createKernelSupervisor.
 * restartInstance/stopInstance`), que autoriza el `projectId` contra el contexto
 * de la instancia (out-of-band) al drenar la cola — nunca desde el id en banda.
 *
 * @param {object} args
 * @param {string} args.action          — 'start' | 'pause'.
 * @param {string} [args.projectId]     — id del producto (validado isSafeId). Sin
 *                                         valor ⇒ producto único (Intrale · CA-5.1).
 * @param {string} [args.actor]         — identidad del operador (audit).
 * @param {string} [args.remoteAddress] — ip de origen (audit).
 * @param {object} [deps]               — { queueDir, auditFile, fsImpl, now, auditImpl }
 * @returns {{ok:boolean, status:number, action?:string, projectId?:string, request_path?:string, msg?:string}}
 */
function enqueueControl(args = {}, deps = {}) {
    const { action } = args;
    if (!CONTROL_ACTIONS.includes(action)) {
        return { ok: false, status: 400, msg: `acción inválida (esperado: ${CONTROL_ACTIONS.join(' | ')})` };
    }

    // CA-5.1 — sin productId ⇒ producto único; con productId ⇒ debe ser seguro.
    const rawId = (args.projectId == null || args.projectId === '') ? DEFAULT_PRODUCT_ID : args.projectId;
    if (!isSafeId(rawId)) {
        // SEC-1b — id inseguro/inexistente ⇒ fail-closed, sin encolar ni enumerar.
        return { ok: false, status: 400, msg: 'projectId inseguro o inexistente' };
    }
    const projectId = rawId;

    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_control_request',
        action,
        projectId,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `${action}-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        action,
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `${action} de "${projectId}" encolado; el kernel ejecutará la transición (autorización contra el contexto de la instancia)`,
    };
}

/**
 * Encola la ACTIVACIÓN de un producto (onboarding→active · #4805 · CA-1). A
 * diferencia de `start`/`pause` (control efímero de instancia), `activate` cambia
 * el `status` DURABLE del descriptor, por eso es una acción dedicada: el kernel,
 * al drenar el pedido, invoca `project-descriptor.transitionStatus` (writer
 * atómico dueño del estado, anti-TOCTOU) para persistir el flip. El dashboard NO
 * muta el descriptor por su cuenta (invariante "el adaptador pide, el kernel
 * ejecuta"); acá sólo se valida el id fail-closed, se audita y se encola.
 *
 * Seguridad:
 *   - SEC-1b/A01: `isSafeId(projectId)` fail-closed ANTES de construir el path del
 *     pedido (anti path-traversal/IDOR). La autorización real la impone el kernel
 *     contra el contexto de la instancia al drenar — nunca desde el id en banda.
 *   - SEC-7b/A09: audit hash-chained redactado (`auditAndEnqueue`) con
 *     `action=activate` — non-repudio de quién/qué/cuándo/productId.
 *   - SR-A04 (anti-replay): la idempotencia dura la impone la máquina de estados
 *     del descriptor (`onboarding→active` rechaza `active→active` server-side); el
 *     endpoint suma el nonce single-use del CSRF/action-token del dashboard.
 *
 * @param {object} args
 * @param {string} [args.projectId]     — id del producto (validado isSafeId). Sin
 *                                         valor ⇒ producto único (Intrale · CA-5.1).
 * @param {string} [args.actor]         — identidad del operador (audit).
 * @param {string} [args.remoteAddress] — ip de origen (audit).
 * @param {object} [deps]               — { queueDir, auditFile, fsImpl, now, auditImpl }
 * @returns {{ok:boolean, status:number, action?:string, projectId?:string, request_path?:string, msg?:string}}
 */
function enqueueActivate(args = {}, deps = {}) {
    // CA-5.1 — sin productId ⇒ producto único; con productId ⇒ debe ser seguro.
    const rawId = (args.projectId == null || args.projectId === '') ? DEFAULT_PRODUCT_ID : args.projectId;
    if (!isSafeId(rawId)) {
        // SEC-1b — id inseguro/inexistente ⇒ fail-closed, sin encolar ni enumerar.
        return { ok: false, status: 400, msg: 'projectId inseguro o inexistente' };
    }
    const projectId = rawId;

    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_control_request',
        action: 'activate',
        projectId,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `activate-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        action: 'activate',
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `activación de "${projectId}" encolada; el kernel persistirá la transición onboarding→active (validación de descriptor fail-closed) y lo sumará al supervisor`,
    };
}

module.exports = {
    enqueueOnboard,
    enqueueControl,
    enqueueActivate,
    CONTROL_ACTIONS,
    DEFAULT_PRODUCT_ID,
    DEFAULT_QUEUE_DIR,
    DEFAULT_AUDIT_FILE,
};

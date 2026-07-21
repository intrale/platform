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
const repoProbe = require('./repo-probe');
const productCatalog = require('./product-catalog');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Cola que drena el kernel (pulpo/supervisor). El dashboard sólo escribe pedidos
// acá; NUNCA muta `descriptors/registry.json` ni el estado de instancias.
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'product-control', 'pendiente');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'product-control-requests.jsonl');
// Fuente del catálogo para la unicidad UX (no-autoritativa). Misma que lee
// `product-catalog.listProducts` y la pestaña Productos (#4801 · CA-1).
const DEFAULT_DESCRIPTORS_DIR = path.join(PIPELINE_DIR, 'descriptors');

// A03 — allowlist cerrada de acciones de control de ciclo de vida. Congelada.
// `create-wave` (#4809) es una acción durable dedicada (como `activate`): NO es
// control efímero de instancia, pero se lista acá para que la allowlist siga
// siendo la fuente única cerrada de acciones reconocidas (A03).
const CONTROL_ACTIONS = Object.freeze(['start', 'pause', 'create-wave']);

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
            // CA-2 · `probeAccess` cableado (least-privilege) para la prueba de
            // alcance real de repos allowlisted; overridable por tests vía
            // `deps.bootstrapDeps.probeAccess`.
            deps: Object.assign(
                { kernelGateFloor: 'enforce', probeAccess: repoProbe.probeAccess },
                deps.bootstrapDeps || {},
            ),
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

    // CA-1 · Unicidad UX NO-autoritativa: mejora el mensaje antes de encolar.
    // Fail-open si el catálogo no lee (ventana TOCTOU conocida — la unicidad
    // autoritativa la impone el drenador del kernel al registrar el descriptor).
    try {
        const descriptorsDir = deps.descriptorsDir || DEFAULT_DESCRIPTORS_DIR;
        const listProducts = typeof deps.listProducts === 'function' ? deps.listProducts : productCatalog.listProducts;
        const existing = listProducts(descriptorsDir);
        if (Array.isArray(existing) && existing.some(p => p && p.projectId === projectId)) {
            return { ok: false, status: 409, projectId, msg: `ya existe un producto con el identificador "${projectId}"; elegí otro` };
        }
    } catch { /* fail-open: la unicidad autoritativa la impone el kernel */ }

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

/**
 * Encola la CREACIÓN/ASOCIACIÓN de la PRIMERA ola de un producto (#4809 · CA-1).
 * Igual que `activate`, es una acción durable dedicada: el dashboard NO crea la
 * ola por su cuenta (invariante "el adaptador pide, el kernel ejecuta"). Acá sólo
 * se valida el id fail-closed, se transporta el payload de la ola, se audita y se
 * encola en `product-control/pendiente`. El kernel (supervisor/drainer) drena el
 * pedido y ejecuta con AUTORIZACIÓN out-of-band contra el contexto de la instancia
 * (CA-5), gate fail-closed del descriptor (CA-2) y `associateFirstWave` create-once
 * (CA-3) — nunca desde el `projectId` en banda.
 *
 * Seguridad:
 *   - SEC-1b/A01: `isSafeId(projectId)` fail-closed ANTES de construir el path del
 *     pedido (anti path-traversal/IDOR). La autorización real la impone el kernel.
 *   - SEC-7b/A09: audit hash-chained redactado (`auditAndEnqueue`) con
 *     `action=create-wave` — non-repudio de quién/qué/cuándo/productId (CA-6).
 *   - A03: `create-wave` pertenece a la allowlist cerrada `CONTROL_ACTIONS`.
 *
 * @param {object} args
 * @param {string} [args.projectId]     — id del producto (validado isSafeId). Sin
 *                                         valor ⇒ producto único (Intrale · CA-5.1).
 * @param {object} [args.wave]          — payload de la ola (objeto; ej. { label }).
 *                                         Se transporta tal cual; el kernel valida.
 * @param {string} [args.actor]         — identidad del operador (audit).
 * @param {string} [args.remoteAddress] — ip de origen (audit).
 * @param {object} [deps]               — { queueDir, auditFile, fsImpl, now, auditImpl }
 * @returns {{ok:boolean, status:number, action?:string, projectId?:string, request_path?:string, msg?:string}}
 */
function enqueueCreateWave(args = {}, deps = {}) {
    // CA-5.1 — sin productId ⇒ producto único; con productId ⇒ debe ser seguro.
    const rawId = (args.projectId == null || args.projectId === '') ? DEFAULT_PRODUCT_ID : args.projectId;
    if (!isSafeId(rawId)) {
        // SEC-1b — id inseguro/inexistente ⇒ fail-closed, sin encolar ni enumerar.
        return { ok: false, status: 400, msg: 'projectId inseguro o inexistente' };
    }
    const projectId = rawId;

    // El payload de la ola es opcional en el pedido (el kernel puede sembrar una
    // ola inicial mínima); si viene, debe ser un objeto (no array/escalar).
    let wave = args.wave;
    if (wave === undefined || wave === null) {
        wave = {};
    } else if (typeof wave !== 'object' || Array.isArray(wave)) {
        return { ok: false, status: 400, msg: 'wave inválida (se esperaba un objeto)' };
    }

    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_control_request',
        action: 'create-wave',
        projectId,
        wave,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `create-wave-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        action: 'create-wave',
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `creación de la primera ola de "${projectId}" encolada; el kernel la asociará create-once (gate de descriptor fail-closed, autorización contra el contexto de la instancia)`,
    };
}

function enqueueEdit(args = {}, deps = {}) {
    const descriptor = args.descriptor;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        return { ok: false, status: 400, msg: 'descriptor ausente o invÃ¡lido (se esperaba un objeto)' };
    }

    const rawId = args.projectId || (descriptor.identity && descriptor.identity.projectId);
    if (!isSafeId(rawId)) {
        return { ok: false, status: 400, msg: 'projectId inseguro o inexistente' };
    }
    const projectId = rawId;
    const descId = descriptor.identity && descriptor.identity.projectId;
    if (!isSafeId(descId) || descId !== projectId) {
        return { ok: false, status: 400, msg: 'descriptor no coincide con el producto objetivo' };
    }

    const runBootstrap = typeof deps.runBootstrap === 'function' ? deps.runBootstrap : bootstrap.runBootstrap;
    let boot;
    try {
        boot = runBootstrap({
            descriptor,
            mode: 'dry-run',
            deps: Object.assign(
                { kernelGateFloor: 'enforce', probeAccess: repoProbe.probeAccess },
                deps.bootstrapDeps || {},
            ),
        });
    } catch (e) {
        return { ok: false, status: 500, msg: `validaciÃ³n de bootstrap fallÃ³: ${e.message}` };
    }
    if (!boot || !boot.ok) {
        return {
            ok: false,
            status: 400,
            stage: boot ? boot.stage : 'bootstrap',
            errors: (boot && boot.errors) || [{ path: '(root)', detail: 'bootstrap rechazÃ³ el descriptor' }],
            msg: 'descriptor rechazado (fail-closed)',
        };
    }

    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_control_request',
        action: 'edit',
        projectId,
        descriptor,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `edit-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        action: 'edit',
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `ediciÃ³n de "${projectId}" encolada; el kernel persistirÃ¡ el descriptor validado`,
    };
}

function enqueueDeactivate(args = {}, deps = {}) {
    const rawId = (args.projectId == null || args.projectId === '') ? DEFAULT_PRODUCT_ID : args.projectId;
    if (!isSafeId(rawId)) {
        return { ok: false, status: 400, msg: 'projectId inseguro o inexistente' };
    }
    if (typeof args.nonce !== 'string' || args.nonce.trim() === '') {
        return { ok: false, status: 400, msg: 'nonce de confirmaciÃ³n requerido' };
    }
    const projectId = rawId;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const ts = now();
    const record = {
        type: 'product_control_request',
        action: 'deactivate',
        projectId,
        nonce: args.nonce,
        actor: args.actor ? String(args.actor) : 'dashboard-operator',
        remote_address: args.remoteAddress ? String(args.remoteAddress) : null,
        source: 'dashboard',
        created_at: ts,
    };

    const res = auditAndEnqueue(record, `deactivate-${projectId}-${ts}`, deps);
    if (!res.ok) return res;
    return {
        ok: true,
        status: 202,
        action: 'deactivate',
        projectId,
        request_path: res.request_path,
        audit_persisted: res.audit_persisted,
        msg: `baja de "${projectId}" encolada; el kernel persistirÃ¡ status archived (soft-delete)`,
    };
}

module.exports = {
    enqueueOnboard,
    enqueueControl,
    enqueueActivate,
    enqueueCreateWave,
    enqueueEdit,
    enqueueDeactivate,
    CONTROL_ACTIONS,
    DEFAULT_PRODUCT_ID,
    DEFAULT_QUEUE_DIR,
    DEFAULT_AUDIT_FILE,
    DEFAULT_DESCRIPTORS_DIR,
};

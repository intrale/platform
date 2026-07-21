'use strict';

// =============================================================================
// product-control-drainer.js — Consumidor de `product-control/pendiente/` (CA-3 ·
// corazón de #4801).
//
// QUÉ RESUELVE
// ------------
// `product-control-request.enqueueOnboard` encola un `product_onboard_request` en
// `.pipeline/product-control/pendiente/`, pero hasta #4801 NADIE drenaba la cola:
// el producto nunca se registraba ni aparecía en la pestaña Productos. Este módulo
// es ese drenador. Por cada pedido de onboarding:
//   (a) re-valida `isSafeId(projectId)` fail-closed (A03 · anti path-traversal);
//   (b) impone UNICIDAD AUTORITATIVA contra el catálogo (existencia del descriptor)
//       — resuelve la carrera TOCTOU que el chequeo cosmético del wizard no cubre;
//   (c) registra el producto en `status:onboarding` de forma ATÓMICA/IDEMPOTENTE
//       (write-temp + rename) como `descriptors/<projectId>.json` — misma fuente
//       que `product-catalog.listProducts`, así el producto aparece en Productos;
//   (d) mueve el pedido a `procesado/`.
//
// El invariante "el adaptador pide, el kernel ejecuta" (#4571 §5.1) se mantiene:
// el dashboard sólo encola; SÓLO este drenador (lado kernel) escribe descriptores.
// `bootProducts` sigue salteando `onboarding` (no lo activa hasta OK humano).
//
// SEGURIDAD / INTEGRIDAD
// ----------------------
//   - Fail-closed en id inseguro y en duplicado: NO registra, mueve el pedido a
//     `procesado/` como rechazado (terminal — reintentar no ayuda) + audita.
//   - "Nunca estado a medias": el descriptor se escribe atómico (tmp + rename); el
//     pedido se mueve a `procesado/` DESPUÉS del registro. Si el registro falla por
//     infra, el pedido queda en `pendiente/` y se reintenta el próximo ciclo.
//   - Audit hash-chained redactado por cada resultado (non-repudio).
// =============================================================================

const fsDefault = require('fs');
const path = require('path');

const trace = require('./traceability');
const auditLogDefault = require('./audit-log');
const redact = require('./redact');
const { isSafeId } = require('./project-descriptor');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'product-control', 'pendiente');
const DEFAULT_PROCESSED_DIR = path.join(PIPELINE_DIR, 'product-control', 'procesado');
const DEFAULT_DESCRIPTORS_DIR = path.join(PIPELINE_DIR, 'descriptors');
const DEFAULT_AUDIT_FILE = path.join(PIPELINE_DIR, 'audit', 'product-control-drainer.jsonl');

const ONBOARD_TYPE = 'product_onboard_request';
const CONTROL_TYPE = 'product_control_request';
const CREATE_WAVE_ACTION = 'create-wave';

/**
 * Registra un producto como `status:onboarding` escribiendo su descriptor de
 * forma atómica. Unicidad autoritativa: si el descriptor ya existe, rechaza
 * (no sobreescribe). El write es tmp + rename (nunca deja un descriptor a medias).
 *
 * @returns {{ok:true, descriptorPath:string} | {ok:false, reason:string}}
 */
function registerOnboarding(descriptor, projectId, descriptorsDir, _fs) {
    const descriptorPath = path.join(descriptorsDir, `${projectId}.json`);
    // Defensa redundante: el path DEBE quedar dentro de descriptorsDir.
    if (!path.resolve(descriptorPath).startsWith(path.resolve(descriptorsDir) + path.sep)) {
        return { ok: false, reason: 'path-escape' };
    }
    // Unicidad autoritativa (resuelve TOCTOU): ya registrado ⇒ rechazo fail-closed.
    if (_fs.existsSync(descriptorPath)) {
        return { ok: false, reason: 'duplicate' };
    }
    try { _fs.mkdirSync(descriptorsDir, { recursive: true }); } catch { /* idempotente */ }

    // El descriptor persistido es el del pedido, forzando `status:onboarding`
    // (INACTIVO). Sólo transporta refs de secreto (SEC-4), nunca valores.
    const toWrite = Object.assign({}, descriptor, { status: 'onboarding' });
    const tmpPath = `${descriptorPath}.tmp`;
    try {
        _fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
        _fs.renameSync(tmpPath, descriptorPath);
    } catch (e) {
        try { if (_fs.existsSync(tmpPath)) _fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
        return { ok: false, reason: `write-failed: ${e.message}` };
    }
    return { ok: true, descriptorPath };
}

// Mueve un pedido de `pendiente/` a `procesado/`. Best-effort atómico (rename);
// si falla, el caller lo trata como error recuperable (queda en pendiente).
function moveToProcessed(fileName, queueDir, processedDir, _fs) {
    try { _fs.mkdirSync(processedDir, { recursive: true }); } catch { /* idempotente */ }
    const from = path.join(queueDir, fileName);
    const to = path.join(processedDir, fileName);
    _fs.renameSync(from, to);
    return to;
}

/**
 * Drena la cola de pedidos de onboarding. Fail-open ante ausencia de la cola.
 *
 * @param {object} [opts]  { queueDir, processedDir, descriptorsDir, auditFile }
 * @param {object} [deps]  { fsImpl, auditImpl, now, log }
 * @returns {{registered:string[], rejected:Array<{projectId:?string,reason:string}>, errors:Array<{file:string,reason:string}>}}
 */
function drainOnboardQueue(opts = {}, deps = {}) {
    const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
    const processedDir = opts.processedDir || DEFAULT_PROCESSED_DIR;
    const descriptorsDir = opts.descriptorsDir || DEFAULT_DESCRIPTORS_DIR;
    const auditFile = opts.auditFile || DEFAULT_AUDIT_FILE;
    const _fs = deps.fsImpl || fsDefault;
    const auditImpl = deps.auditImpl || auditLogDefault;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    const summary = { registered: [], rejected: [], errors: [] };

    let entries;
    try {
        entries = _fs.readdirSync(queueDir);
    } catch {
        return summary; // cola inexistente/ilegible ⇒ nada que drenar (fail-open).
    }

    const audit = (entry) => {
        try {
            auditImpl.appendChained({ file: auditFile, entry: redact.redactObject(entry), fsImpl: _fs });
        } catch { /* el audit no puede tumbar el drenaje */ }
    };

    for (const fileName of Array.isArray(entries) ? entries : []) {
        if (!/\.json$/i.test(fileName)) continue;
        const full = path.join(queueDir, fileName);

        let record;
        try {
            record = JSON.parse(_fs.readFileSync(full, 'utf8'));
        } catch (e) {
            // Pedido ilegible/corrupto ⇒ terminal: se aparta a procesado (no reintenta).
            summary.rejected.push({ projectId: null, reason: 'unparseable' });
            audit({ type: 'onboard_drain_result', outcome: 'rejected', reason: 'unparseable', file: fileName, at: now() });
            try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
            catch (me) { summary.errors.push({ file: fileName, reason: `move-failed: ${me.message}` }); }
            continue;
        }

        // Sólo se drenan pedidos de onboarding; otros tipos se ignoran (no se tocan).
        if (!record || record.type !== ONBOARD_TYPE) continue;

        const projectId = record.projectId;
        const descriptor = record.descriptor;

        // (a) Re-validación fail-closed del id (anti path-traversal / IDOR).
        // El projectId autoritativo sale del descriptor (out-of-band), no del campo
        // suelto del pedido: se cruzan y ambos deben ser seguros y coincidir.
        const descId = descriptor && descriptor.identity && descriptor.identity.projectId;
        if (!isSafeId(projectId) || !isSafeId(descId) || projectId !== descId) {
            summary.rejected.push({ projectId: isSafeId(projectId) ? projectId : null, reason: 'unsafe-id' });
            audit({ type: 'onboard_drain_result', outcome: 'rejected', reason: 'unsafe-id', projectId: isSafeId(projectId) ? projectId : null, file: fileName, at: now() });
            try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
            catch (me) { summary.errors.push({ file: fileName, reason: `move-failed: ${me.message}` }); }
            continue;
        }

        // (b)+(c) Unicidad autoritativa + registro atómico onboarding.
        const reg = registerOnboarding(descriptor, projectId, descriptorsDir, _fs);
        if (!reg.ok) {
            if (reg.reason === 'duplicate' || reg.reason === 'path-escape') {
                // Terminal: reintentar no ayuda ⇒ se aparta a procesado como rechazado.
                summary.rejected.push({ projectId, reason: reg.reason });
                audit({ type: 'onboard_drain_result', outcome: 'rejected', reason: reg.reason, projectId, file: fileName, at: now() });
                try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
                catch (me) { summary.errors.push({ file: fileName, reason: `move-failed: ${me.message}` }); }
            } else {
                // Fallo de infra (write): NO se marca procesado ⇒ se reintenta luego.
                // Nunca queda estado a medias (el rename atómico no llegó a ocurrir).
                summary.errors.push({ file: fileName, reason: reg.reason });
                audit({ type: 'onboard_drain_result', outcome: 'error', reason: reg.reason, projectId, file: fileName, at: now() });
            }
            continue;
        }

        // (d) Registro OK ⇒ mover el pedido a procesado. Si el move falla, el
        // descriptor ya quedó bien; el próximo ciclo verá "duplicate" e igualmente
        // apartará el pedido (idempotente, sin estado a medias).
        try {
            moveToProcessed(fileName, queueDir, processedDir, _fs);
        } catch (me) {
            summary.errors.push({ file: fileName, reason: `registered-but-move-failed: ${me.message}` });
        }
        summary.registered.push(projectId);
        audit({ type: 'onboard_drain_result', outcome: 'registered', projectId, file: fileName, at: now() });
    }

    return summary;
}

/**
 * Drena la cola de pedidos `create-wave` (#4809 · "el kernel ejecuta"). Por cada
 * pedido de creación de la primera ola:
 *   (a) re-valida `isSafeId(projectId)` fail-closed (A03 · anti path-traversal);
 *   (b) AUTORIZA out-of-band (CA-5 · A01/IDOR): `deps.isAuthorized(projectId)` se
 *       resuelve contra el CONTEXTO de la instancia (catálogo/credencial), NUNCA
 *       contra el `projectId` en banda. Rechazo ⇒ 403-lógico + audit, sin efecto;
 *   (c) GATE fail-closed del descriptor (CA-2): `deps.loadDescriptor(projectId)`
 *       devuelve `{ valid, errors }`; descriptor incompleto/ inválido ⇒ NO se crea
 *       ninguna ola (rechazo terminal + audit);
 *   (d) ejecuta `deps.associateWave(projectId, wave)` (create-once del coordination
 *       store): creada ⇒ registrada; ya existía ⇒ idempotente (nunca duplica, CA-3);
 *   (e) mueve el pedido a `procesado/` (terminal salvo error de infra, que se
 *       reintenta dejándolo en `pendiente/`).
 *
 * Todos los deps de decisión (autz/gate/ejecución) se INYECTAN: el drenador no
 * deriva autoridad de datos en banda. Fail-open ante ausencia de la cola.
 *
 * @param {object} [opts]  { queueDir, processedDir, auditFile }
 * @param {object}  deps   { isAuthorized, loadDescriptor, associateWave, fsImpl?, auditImpl?, now? }
 * @returns {{created:string[], idempotent:string[], rejected:Array<{projectId:?string,reason:string}>, errors:Array<{file:string,reason:string}>}}
 */
async function drainCreateWaveQueue(opts = {}, deps = {}) {
    const queueDir = opts.queueDir || DEFAULT_QUEUE_DIR;
    const processedDir = opts.processedDir || DEFAULT_PROCESSED_DIR;
    const auditFile = opts.auditFile || DEFAULT_AUDIT_FILE;
    const _fs = deps.fsImpl || fsDefault;
    const auditImpl = deps.auditImpl || auditLogDefault;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    // Deps de decisión obligatorios: sin ellos NO se drena (fail-closed — jamás se
    // crea una ola sin autorización/gate).
    const isAuthorized = typeof deps.isAuthorized === 'function' ? deps.isAuthorized : null;
    const loadDescriptor = typeof deps.loadDescriptor === 'function' ? deps.loadDescriptor : null;
    const associateWave = typeof deps.associateWave === 'function' ? deps.associateWave : null;

    const summary = { created: [], idempotent: [], rejected: [], errors: [] };

    if (!isAuthorized || !loadDescriptor || !associateWave) {
        throw new Error('drainCreateWaveQueue requiere isAuthorized, loadDescriptor y associateWave (deps de decisión)');
    }

    let entries;
    try {
        entries = _fs.readdirSync(queueDir);
    } catch {
        return summary; // cola inexistente/ilegible ⇒ nada que drenar (fail-open).
    }

    const audit = (entry) => {
        try {
            auditImpl.appendChained({ file: auditFile, entry: redact.redactObject(entry), fsImpl: _fs });
        } catch { /* el audit no puede tumbar el drenaje */ }
    };
    const moveOrError = (fileName) => {
        try { moveToProcessed(fileName, queueDir, processedDir, _fs); }
        catch (me) { summary.errors.push({ file: fileName, reason: `move-failed: ${me.message}` }); }
    };

    for (const fileName of Array.isArray(entries) ? entries : []) {
        if (!/\.json$/i.test(fileName)) continue;
        const full = path.join(queueDir, fileName);

        let record;
        try {
            record = JSON.parse(_fs.readFileSync(full, 'utf8'));
        } catch {
            // Ilegible/corrupto ⇒ terminal: apartar sin reintentar. (No sabemos si es
            // create-wave; se aparta igual que el drenador de onboarding.)
            summary.rejected.push({ projectId: null, reason: 'unparseable' });
            audit({ type: 'create_wave_drain_result', outcome: 'rejected', reason: 'unparseable', file: fileName, at: now() });
            moveOrError(fileName);
            continue;
        }

        // Sólo se drenan pedidos create-wave; otros tipos/acciones NO se tocan.
        if (!record || record.type !== CONTROL_TYPE || record.action !== CREATE_WAVE_ACTION) continue;

        const projectId = record.projectId;

        // (a) Re-validación fail-closed del id (anti path-traversal / IDOR).
        if (!isSafeId(projectId)) {
            summary.rejected.push({ projectId: null, reason: 'unsafe-id' });
            audit({ type: 'create_wave_drain_result', outcome: 'rejected', reason: 'unsafe-id', projectId: null, file: fileName, at: now() });
            moveOrError(fileName);
            continue;
        }

        // (b) Autorización OUT-OF-BAND (CA-5 · A01/IDOR). El projectId debe pertenecer
        // al contexto de la instancia; nunca se confía en el id en banda.
        let authorized = false;
        try { authorized = isAuthorized(projectId) === true; }
        catch (e) { authorized = false; }
        if (!authorized) {
            summary.rejected.push({ projectId, reason: 'forbidden' });
            audit({ type: 'create_wave_drain_result', outcome: 'rejected', reason: 'forbidden', projectId, file: fileName, at: now() });
            moveOrError(fileName);   // terminal: reintentar no cambia la autoridad.
            continue;
        }

        // (c) GATE fail-closed del descriptor (CA-2). Descriptor incompleto ⇒ NO se
        // crea ninguna ola parcial. Terminal (el operador debe completar el wizard).
        let gate;
        try { gate = await loadDescriptor(projectId); }
        catch (e) { gate = { valid: false, errors: [{ detail: e && e.message ? e.message : String(e) }] }; }
        if (!gate || gate.valid !== true) {
            summary.rejected.push({ projectId, reason: 'descriptor-incomplete' });
            audit({ type: 'create_wave_drain_result', outcome: 'rejected', reason: 'descriptor-incomplete', projectId, file: fileName, at: now() });
            moveOrError(fileName);
            continue;
        }

        // (d) Ejecutar create-once en el coordination store del producto.
        let res;
        try {
            res = await associateWave(projectId, record.wave && typeof record.wave === 'object' ? record.wave : {});
        } catch (e) {
            // Fallo de infra (store): NO se marca procesado ⇒ se reintenta luego.
            summary.errors.push({ file: fileName, reason: e && e.message ? e.message : String(e) });
            audit({ type: 'create_wave_drain_result', outcome: 'error', reason: e && e.message ? e.message : String(e), projectId, file: fileName, at: now() });
            continue;
        }

        if (res && res.ok) {
            summary.created.push(projectId);
            audit({ type: 'create_wave_drain_result', outcome: 'created', projectId, file: fileName, at: now() });
            moveOrError(fileName);
        } else if (res && res.exists) {
            // CA-3 — segunda "primera ola": idempotente, nunca duplica. Terminal.
            summary.idempotent.push(projectId);
            audit({ type: 'create_wave_drain_result', outcome: 'already-exists', projectId, file: fileName, at: now() });
            moveOrError(fileName);
        } else {
            // Resultado inesperado del store ⇒ tratar como error recuperable.
            summary.errors.push({ file: fileName, reason: 'associate-failed' });
            audit({ type: 'create_wave_drain_result', outcome: 'error', reason: 'associate-failed', projectId, file: fileName, at: now() });
        }
    }

    return summary;
}

module.exports = {
    drainOnboardQueue,
    drainCreateWaveQueue,
    registerOnboarding,
    DEFAULT_QUEUE_DIR,
    DEFAULT_PROCESSED_DIR,
    DEFAULT_DESCRIPTORS_DIR,
    DEFAULT_AUDIT_FILE,
    ONBOARD_TYPE,
    CONTROL_TYPE,
    CREATE_WAVE_ACTION,
};

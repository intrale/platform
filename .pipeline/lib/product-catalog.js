'use strict';

// =============================================================================
// product-catalog.js — Enumeración read-only del catálogo de productos
// (Ola Puente P6 · #4778 · split A de #4691).
//
// Lee los descriptores del kernel (`.pipeline/descriptors/*.json`) y proyecta la
// vista MÍNIMA que el dashboard product-aware necesita para el selector (pieza 1)
// y el grid "estado por producto" (pieza 2): `{ projectId, name, status, role }`.
//
// Reglas:
//   - READ-ONLY y fail-open: si el directorio o un archivo no se puede leer,
//     el producto se omite (no rompe el render). Con 0 productos legibles el
//     caller degrada al producto único (retro-compat · CA-5.1).
//   - `projectId` se valida fail-closed con `isSafeProjectId` ANTES de usarse
//     como clave/índice (A03 · espeja project-descriptor.isSafeId). Un descriptor
//     con id inseguro NO entra al catálogo.
//   - Whitelist de campos: sólo se exponen projectId/name/status/role. Nunca se
//     hace passthrough del descriptor crudo (evita filtrar credenciales/authority).
//   - Sin dependencias pesadas (ni Ajv ni el kernel) para cargarse barato desde
//     el generador de snapshot del dashboard.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Espeja `project-descriptor.isSafeId` / `product-state-segment.isSafeProjectId`
// (mantenido dependency-free a propósito; la coincidencia se cubre por test).
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isSafeProjectId(id) {
    if (typeof id !== 'string') return false;
    if (!SAFE_ID_RE.test(id)) return false;
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
    return true;
}

// Proyección pública de UN descriptor. Whitelist explícita. Devuelve null si el
// descriptor no tiene un projectId seguro (fail-closed).
function projectDescriptor(raw) {
    const identity = (raw && typeof raw.identity === 'object') ? raw.identity : {};
    const projectId = identity.projectId;
    if (!isSafeProjectId(projectId)) return null;
    // `role` primario: el descriptor cuyo repo primario existe. Se deriva de la
    // primera entrada de repositories con role 'primary' (metadato de orden, no
    // de autorización).
    let role = 'secondary';
    if (Array.isArray(raw.repositories) && raw.repositories.some(r => r && r.role === 'primary')) {
        role = 'primary';
    }
    return {
        projectId,
        name: (typeof identity.name === 'string' && identity.name) ? identity.name : projectId,
        status: (typeof raw.status === 'string' && raw.status) ? raw.status : 'active',
        role,
    };
}

/**
 * Enumera los productos del catálogo del kernel. Fail-open: cualquier error de
 * FS o de parseo omite ese producto sin romper el barrido.
 *
 * @param {string} descriptorsDir  ruta al dir de descriptores (`.pipeline/descriptors`).
 * @returns {Array<{projectId:string,name:string,status:string,role:string}>}
 *          productos legibles y con id seguro, deduplicados por projectId.
 */
function listProducts(descriptorsDir) {
    if (typeof descriptorsDir !== 'string' || !descriptorsDir) return [];
    let entries;
    try {
        entries = fs.readdirSync(descriptorsDir);
    } catch {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
        if (!/\.json$/i.test(entry)) continue;
        const full = path.join(descriptorsDir, entry);
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            continue; // descriptor ilegible/inválido → se omite (fail-open)
        }
        const proj = projectDescriptor(raw);
        if (!proj || seen.has(proj.projectId)) continue;
        seen.add(proj.projectId);
        out.push(proj);
    }
    // Orden estable: primario primero, luego alfabético por projectId (determinista
    // para el render SSR y los tests).
    out.sort(sortCatalog);
    return out;
}

// Comparador de orden estable compartido por el barrido FS y la proyección durable.
function sortCatalog(a, b) {
    if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
    return a.projectId < b.projectId ? -1 : (a.projectId > b.projectId ? 1 : 0);
}

// -----------------------------------------------------------------------------
// #4821 — Lectura del catálogo desde el store durable (read path del cutover).
//
// Proyección pública de UN body de producto tal como lo devuelve
// `kernel-store.listProducts()` (`{ productId, name, status, descriptorRef? }`).
// Whitelist explícita a la MISMA forma que `projectDescriptor` para que el
// dashboard consuma indistinto de la fuente. Fail-closed en `projectId`.
// -----------------------------------------------------------------------------
function projectStoreProduct(body) {
    const b = (body && typeof body === 'object') ? body : {};
    const projectId = b.productId;
    if (!isSafeProjectId(projectId)) return null;
    return {
        projectId,
        name: (typeof b.name === 'string' && b.name) ? b.name : projectId,
        status: (typeof b.status === 'string' && b.status) ? b.status : 'active',
        // El body del store no transporta `role` (metadato de repos); el catálogo
        // durable lista productos del contexto de la instancia como 'secondary'
        // salvo que el body lo declare explícitamente.
        role: (b.role === 'primary') ? 'primary' : 'secondary',
    };
}

/**
 * Enumera el catálogo resolviendo la fuente según el flag de cutover `kernel.durable`
 * (#4821 · CA-6). Async porque el store durable lo es.
 *
 *   - `durable:false` (default) → barrido FS de `descriptorsDir` (comportamiento
 *     ACTUAL, sin cambios · CA-6).
 *   - `durable:true`  → proyecta desde `store.listProducts()`.
 *
 * Fallback SELECTIVO durante la coexistencia (security#2): sólo se cae a FS cuando
 * el store NO está disponible (fallo de INFRA), loggeando el modo degradado. Ante
 * `KernelStoreValidationError` (catálogo corrupto/inyectado) NO se cae a FS: se
 * propaga para que escale (nunca enmascarar tampering con el barrido FS).
 *
 * @param {object} opts
 * @param {string}  opts.descriptorsDir  dir de descriptores (fuente FS / fallback).
 * @param {boolean} [opts.durable=false] flag de cutover, leído UNA vez por el caller.
 * @param {object}  [opts.store]         instancia de kernel-store (o pasar createStore).
 * @param {function}[opts.createStore]   factory lazy del store (evita instanciar en modo FS).
 * @param {function}[opts.onDegraded]    callback(reason) al caer a FS por infra.
 * @returns {Promise<Array<{projectId:string,name:string,status:string,role:string}>>}
 */
async function listProductsResolved(opts = {}) {
    const descriptorsDir = opts.descriptorsDir;
    if (opts.durable !== true) {
        // Modo FS (default): comportamiento actual intacto.
        return listProducts(descriptorsDir);
    }

    // Modo durable — resolver el store (inyectado o vía factory lazy).
    let store = (opts.store && typeof opts.store.listProducts === 'function') ? opts.store : null;
    if (!store && typeof opts.createStore === 'function') {
        try {
            const s = opts.createStore();
            if (s && typeof s.listProducts === 'function') store = s;
        } catch (err) {
            // Falla al construir el store = infra no disponible → fallback FS.
            logDegraded(opts, `no se pudo instanciar el store: ${err && err.message ? err.message : err}`);
            return listProducts(descriptorsDir);
        }
    }
    if (!store) {
        logDegraded(opts, 'store durable no disponible');
        return listProducts(descriptorsDir);
    }

    let raw;
    try {
        raw = await store.listProducts();
    } catch (err) {
        // security#2: catálogo corrupto/inyectado NO cae a FS — propaga/escala.
        if (err && err.name === 'KernelStoreValidationError') throw err;
        // Fallo de infra (store no disponible) → fallback FS loggeado (degradado).
        logDegraded(opts, err && err.message ? err.message : String(err));
        return listProducts(descriptorsDir);
    }

    const seen = new Set();
    const out = [];
    for (const body of Array.isArray(raw) ? raw : []) {
        const proj = projectStoreProduct(body);
        if (!proj || seen.has(proj.projectId)) continue;
        seen.add(proj.projectId);
        out.push(proj);
    }
    out.sort(sortCatalog);
    return out;
}

function logDegraded(opts, reason) {
    if (typeof opts.onDegraded === 'function') {
        try { opts.onDegraded(reason); } catch { /* logging best-effort */ }
        return;
    }
    // Traza mínima (sin credenciales/ARN) del modo degradado FS. Silenciable con
    // `onDegraded` (los tests inyectan su propio sink para no ensuciar la salida).
    try { console.warn(`[product-catalog] modo durable degradó a FS: ${reason}`); } catch { /* noop */ }
}

module.exports = {
    listProducts,
    listProductsResolved,
    projectDescriptor,
    projectStoreProduct,
    isSafeProjectId,
    SAFE_ID_RE,
};

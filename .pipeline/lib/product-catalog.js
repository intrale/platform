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
    out.sort((a, b) => {
        if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
        return a.projectId < b.projectId ? -1 : (a.projectId > b.projectId ? 1 : 0);
    });
    return out;
}

// =============================================================================
// Rama DURABLE (#4821 · split 2/3 de #4804) — lectura del catálogo desde el store.
//
// Con `kernel.durable:true` el catálogo se proyecta desde `store.listProducts()`
// en vez de barrer `.pipeline/descriptors/*.json`. El store es fail-closed: lanza
// `KernelStoreValidationError` (o de aislamiento) + `onAlert` ante catálogo
// corrupto / ítem de otra partición.
//
// FALLBACK SELECTIVO (security#2 / CA-4):
//   - `store no disponible (infra)` (red / driver / tabla ausente) ⇒ PUEDE caer a
//     FS fallback durante la coexistencia, loggeando el modo degradado.
//   - error de VALIDACIÓN / alerta de integridad (`KernelStoreValidationError` /
//     `KernelStoreIsolationError`) ⇒ NO cae a FS: propaga/escala. Un fallback
//     ciego ante tampering convertiría un ataque en "todo verde con datos viejos".
//
// Se detecta el tipo de error por `err.name` (sin `require('./kernel-store')`,
// para mantener este módulo liviano y dependency-free como el barrido FS).
// =============================================================================

// Errores del store que representan integridad comprometida (NO permiten fallback).
const INTEGRITY_ERROR_NAMES = Object.freeze(new Set([
    'KernelStoreValidationError',
    'KernelStoreIsolationError',
]));

function isIntegrityError(err) {
    return !!(err && err.name && INTEGRITY_ERROR_NAMES.has(String(err.name)));
}

// Proyección pública de UN producto durable (body de `store.listProducts()`).
// Whitelist explícita, espeja `projectDescriptor` (no passthrough del ítem crudo).
function projectStoreProduct(body) {
    const b = (body && typeof body === 'object') ? body : {};
    const projectId = b.productId;
    if (!isSafeProjectId(projectId)) return null;
    return {
        projectId,
        name: (typeof b.name === 'string' && b.name) ? b.name : projectId,
        status: (typeof b.status === 'string' && b.status) ? b.status : 'active',
        // El store no persiste `role` (metadato de orden FS); en durable el rol se
        // deriva del descriptor, no del catálogo. Se marca 'primary' por defecto
        // para no romper el orden estable del render (un solo producto por partición).
        role: 'primary',
    };
}

function sortCatalog(out) {
    out.sort((a, b) => {
        if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
        return a.projectId < b.projectId ? -1 : (a.projectId > b.projectId ? 1 : 0);
    });
    return out;
}

/**
 * Enumera el catálogo desde el store durable del kernel. Fail-closed ante
 * integridad; fallback selectivo a FS SÓLO ante store no disponible (infra).
 *
 * @param {object} deps
 * @param {object}  deps.store              store del kernel (con `listProducts()` async).
 * @param {string} [deps.fsFallbackDir]     dir de descriptores para el fallback FS (coexistencia).
 * @param {function} [deps.onDegraded]      callback ({reason}) cuando cae a FS por infra.
 * @returns {Promise<Array<{projectId,name,status,role}>>}
 */
async function listProductsDurable(deps = {}) {
    const store = deps.store;
    if (!store || typeof store.listProducts !== 'function') {
        throw new Error('listProductsDurable requiere un store con listProducts()');
    }
    let raw;
    try {
        raw = await store.listProducts();
    } catch (err) {
        // Integridad / tampering ⇒ NO fallback (security#2). Propaga.
        if (isIntegrityError(err)) throw err;
        // Infra (store no disponible) ⇒ fallback selectivo a FS si hay dir.
        if (typeof deps.fsFallbackDir === 'string' && deps.fsFallbackDir) {
            if (typeof deps.onDegraded === 'function') {
                // Sin exponer internals del store al consumidor (CA-14/15): sólo el motivo.
                deps.onDegraded({ reason: 'store no disponible — catálogo desde respaldo local (FS)' });
            }
            return listProducts(deps.fsFallbackDir);
        }
        // Sin dir de fallback configurado: propaga el error de infra.
        throw err;
    }
    const seen = new Set();
    const out = [];
    for (const body of Array.isArray(raw) ? raw : []) {
        const proj = projectStoreProduct(body);
        if (!proj || seen.has(proj.projectId)) continue;
        seen.add(proj.projectId);
        out.push(proj);
    }
    return sortCatalog(out);
}

/**
 * Resolver de catálogo gobernado por el flag `kernel.durable` (CA-6). Punto de
 * entrada único para callers que quieran soportar el cutover:
 *   - `durable:false` (default) ⇒ barrido FS SÍNCRONO actual (envuelto en Promise).
 *   - `durable:true`            ⇒ proyección durable con fallback selectivo.
 *
 * @param {object} opts
 * @param {boolean} opts.durable            flag leído UNA vez por el caller.
 * @param {string} [opts.descriptorsDir]    dir de descriptores (FS y fallback).
 * @param {object} [opts.store]             store del kernel (requerido si durable).
 * @param {function} [opts.onDegraded]      callback de modo degradado.
 * @returns {Promise<Array<{projectId,name,status,role}>>}
 */
async function listProductsResolved(opts = {}) {
    if (!opts.durable) {
        // Coexistencia (CA-6): FS intacto.
        return listProducts(opts.descriptorsDir);
    }
    return listProductsDurable({
        store: opts.store,
        fsFallbackDir: opts.descriptorsDir,
        onDegraded: opts.onDegraded,
    });
}

module.exports = {
    listProducts,
    listProductsDurable,
    listProductsResolved,
    projectDescriptor,
    projectStoreProduct,
    isSafeProjectId,
    isIntegrityError,
    SAFE_ID_RE,
};

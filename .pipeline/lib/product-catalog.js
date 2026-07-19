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

module.exports = {
    listProducts,
    projectDescriptor,
    isSafeProjectId,
    SAFE_ID_RE,
};

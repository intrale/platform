'use strict';

// =============================================================================
// safe-project-id.js — Punto ÚNICO de identidad de proyecto (#5901 · GURU-4).
//
// **Problema que resuelve**: el slug `projectId` se usa como clave de índice
// (estado de rotación, namespaces de estado operativo, directorios por
// producto) en al menos seis módulos, cada uno con su propia copia del regex
// (`product-catalog.js`, `project-descriptor.js`, `product-state-segment.js`,
// `credentials.js`, `kernel-supervisor.js`, `config-resolver.js`). Una copia
// que se endurece y las otras no es exactamente el agujero que una validación
// fail-closed viene a tapar.
//
// **Qué agrega sobre el regex vigente** (REQ-SEC-2): denylist explícita de
// `__proto__` / `constructor` / `prototype`. Verificado: `constructor` y
// `prototype` MATCHEAN `^[a-z0-9][a-z0-9-]{1,63}$` y hoy pasarían la
// validación. Usados como clave de un objeto literal (`state[projectId]`)
// abren prototype pollution. El regex solo NO cubre REQ-SEC-2.
//
// **Dependency-free a propósito**: sin `fs`, sin `path`, sin `require` de
// otros módulos del pipeline. Se carga barato desde cualquier punto de
// entrada (incluido el generador de snapshot del dashboard y el arranque del
// pulpo) y no puede fallar por IO.
//
// Invariantes:
//   I-1: `isSafeProjectId` es una restricción del regex vigente — todo id que
//        el módulo acepta lo aceptaban también las copias previas. El cambio
//        es monótonamente restrictivo (nada que hoy funcione deja de funcionar
//        salvo los tres nombres reservados de prototipo, que nunca fueron ids
//        legítimos).
//   I-2: `projectLabel` NUNCA devuelve un nombre de cliente ni razón social
//        (UX-3 + UX-5): sólo el slug validado, o la etiqueta fija del kernel.
//   I-3: sin estado de módulo — todas las funciones son puras.
// =============================================================================

// Espeja `project-descriptor.isSafeId` / `product-state-segment.isSafeProjectId`
// / `product-catalog.SAFE_ID_RE`. La coincidencia se cubre por test.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// Nombres que matchean el regex pero jamás pueden ser clave de un objeto:
// `state[projectId] = {...}` con `constructor` o `__proto__` es prototype
// pollution. `__proto__` no matchea el regex (tiene `_`), pero se lista igual:
// la denylist es la defensa que sobrevive si alguien relaja el regex.
const PROTOTYPE_DENYLIST = Object.freeze(['__proto__', 'constructor', 'prototype']);

// Slug reservado de la plataforma (GURU-3). Es el namespace del kernel y del
// commander: NO es elegible como namespace de un tenant (converge con #5898).
const KERNEL_PROJECT_ID = 'kernel';

const RESERVED_PROJECT_IDS = Object.freeze([KERNEL_PROJECT_ID]);

/**
 * Valida un slug de proyecto para uso como clave de índice o segmento de path.
 * Fail-closed: cualquier duda devuelve `false`.
 *
 * @param {*} id candidato
 * @returns {boolean}
 */
function isSafeProjectId(id) {
    if (typeof id !== 'string') return false;
    if (PROTOTYPE_DENYLIST.includes(id)) return false;
    if (!SAFE_ID_RE.test(id)) return false;
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
    return true;
}

/**
 * `true` si el slug está reservado por la plataforma y no puede usarse como
 * namespace de un tenant.
 */
function isReservedProjectId(id) {
    return typeof id === 'string' && RESERVED_PROJECT_IDS.includes(id);
}

/**
 * Etiqueta legible por humanos para un `projectId` (UX-3 + UX-5).
 *
 * - `kernel` → `Kernel (plataforma)`, para que el operador no lea un slug
 *   técnico donde en realidad se le habla de la plataforma entera.
 * - Cualquier otro slug VALIDADO → el slug tal cual.
 * - Un id inválido NO se refleja al mensaje: se devuelve `(proyecto inválido)`.
 *   Nunca se interpola input sin validar en un mensaje de Telegram.
 */
function projectLabel(id) {
    if (id === KERNEL_PROJECT_ID) return 'Kernel (plataforma)';
    if (!isSafeProjectId(id)) return '(proyecto inválido)';
    return id;
}

module.exports = {
    SAFE_ID_RE,
    PROTOTYPE_DENYLIST,
    KERNEL_PROJECT_ID,
    RESERVED_PROJECT_IDS,
    isSafeProjectId,
    isReservedProjectId,
    projectLabel,
};

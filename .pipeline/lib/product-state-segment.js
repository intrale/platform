'use strict';

// =============================================================================
// product-state-segment.js — Vista de estado segmentada por producto
// (Ola Puente P4 · #4764 · split 3/3 de #4689)
//
// Núcleo PURO y fail-closed de la exposición de estado segmentado por `projectId`
// (CA-4 · A01). Se comparte entre:
//   - `kernel-supervisor.js` (`getSegmentedState`) — estado in-process del supervisor.
//   - `dashboard-routes.js`  (endpoint `/api/dash/product-state`) — vista del kiosk.
//
// Reglas de seguridad (mapa OWASP del análisis de definición · #4764):
//   A01  Broken Access Control (cross-tenant / IDOR):
//        - La autorización se valida contra `authorizedProjectIds` (derivado del
//          contexto/allowlist, OUT-OF-BAND), NUNCA contra el id crudo del request.
//        - Consultar `projectId=B` desde un contexto autorizado sólo para A ⇒
//          fail-closed (403), nunca datos de B.
//   A01/CA-4.3  Sin agregado global por defecto ni por fallback:
//        - Sin `projectId` (o inválido/inexistente) ⇒ 403, NUNCA el agregado.
//        - El único camino de éxito devuelve el estado de UN `projectId` autorizado.
//   A03  Path traversal / injection:
//        - `isSafeProjectId` fail-closed sobre el id ANTES de indexar cualquier
//          estado/clave (rechaza `..`, `/`, `\`, control chars, patrón inválido).
//   A09  Whitelist explícita de campos expuestos (métricas/tokens/tiempos/estado/
//        `audit#`): jamás se hace passthrough del objeto crudo del namespace.
//
// El módulo NO tiene dependencias pesadas (ni Ajv ni FS) para poder cargarse
// barato desde el dispatcher del dashboard.
// =============================================================================

// Espeja `project-descriptor.isSafeId` (mantenido dependency-free a propósito).
// La coincidencia con el original se verifica por test (anti-drift) en
// `kernel-supervisor.test.js`.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Valida un `projectId` fail-closed antes de usarlo como clave/índice de estado.
 * Rechaza tipos no-string, patrón inválido y separadores/traversal (`..`/`/`/`\`).
 */
function isSafeProjectId(id) {
  if (typeof id !== 'string') return false;
  if (!SAFE_ID_RE.test(id)) return false;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  return true;
}

// Campos públicos que expone la vista segmentada. Whitelist explícita (A09): sólo
// estos se copian del estado del namespace; cualquier otro campo se OMITE para no
// filtrar estructura interna ni datos de otro tenant por accidente.
const PUBLIC_FIELDS = Object.freeze(['metrics', 'tokens', 'times', 'state', 'phase']);

/**
 * Proyecta el estado de UN producto a su forma pública (whitelist + `audit#`
 * namespaceado). Nunca hace passthrough del objeto crudo.
 */
function projectPublicState(projectId, raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { projectId };
  for (const f of PUBLIC_FIELDS) {
    if (src[f] !== undefined) out[f] = src[f];
  }
  // Audit trail namespaceado (CA-4.4): sólo las entradas del propio `projectId`.
  out.audit = Array.isArray(src.audit) ? src.audit.slice() : [];
  return out;
}

/**
 * CA-4 · Resuelve la vista de estado segmentada de un producto, fail-closed.
 *
 * @param {object} params
 * @param {*}        params.requestedProjectId   `projectId` pedido (input no confiable).
 * @param {string[]} [params.authorizedProjectIds] ids autorizados por el contexto
 *                     (out-of-band). Si se omite, la autorización se deriva de las
 *                     claves de `stateByProjectId` (todos los productos conocidos son
 *                     visibles de a uno — nunca el agregado). Si se pasa `[]`,
 *                     NADIE está autorizado (fail-closed total).
 * @param {object}  params.stateByProjectId       mapa `projectId → estado crudo`.
 * @returns {{status:number, payload:object}}  200 con el estado de UN producto, o
 *          403 con `{ error:'forbidden' }` (jamás el agregado global).
 */
function segmentProductState(params = {}) {
  const requestedProjectId = params.requestedProjectId;
  const stateByProjectId = (params.stateByProjectId && typeof params.stateByProjectId === 'object')
    ? params.stateByProjectId
    : {};

  // A03: validar el id ANTES de tocar el mapa/clave. Fail-closed sin reflejar el id.
  if (!isSafeProjectId(requestedProjectId)) {
    return forbidden('projectId ausente, inválido o inseguro');
  }

  // A01: autorización OUT-OF-BAND. Sin lista explícita ⇒ conocidos = claves del
  // store (el operador ve de a un producto, nunca el agregado). Con lista explícita
  // ⇒ sólo esos ids (contexto autorizado para A no ve B).
  const authorized = Array.isArray(params.authorizedProjectIds)
    ? params.authorizedProjectIds
    : Object.keys(stateByProjectId);

  if (!authorized.includes(requestedProjectId)) {
    return forbidden('projectId no autorizado en este contexto');
  }

  // El producto debe existir en el store. Ausente ⇒ fail-closed (nunca fallback).
  if (!Object.prototype.hasOwnProperty.call(stateByProjectId, requestedProjectId)) {
    return forbidden('projectId sin estado disponible');
  }

  return {
    status: 200,
    payload: projectPublicState(requestedProjectId, stateByProjectId[requestedProjectId]),
  };
}

// Respuesta fail-closed uniforme. `reason` es interno para logging/tests; nunca
// se refleja el `projectId` crudo del request (anti log/echo injection).
function forbidden(reason) {
  return { status: 403, payload: { error: 'forbidden', reason } };
}

module.exports = {
  isSafeProjectId,
  segmentProductState,
  projectPublicState,
  PUBLIC_FIELDS,
  SAFE_ID_RE,
};

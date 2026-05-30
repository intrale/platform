// #3642 — Resolver puro del estado del rol architect para el widget del dashboard V3.
//
// El rol architect corre en dos fases distintas del pipeline:
//   - definicion/criterios (Fase 1): firma técnica antes de Ready.
//   - desarrollo/aprobacion (Fase 2): firma final pre-merge.
//
// El widget del dashboard muestra UN solo badge por issue. Cuando hay entries
// en ambas fases, aplicamos la siguiente regla de prioridad (decisiones
// cerradas por PO en sign-off de criterios — R1 de guru):
//
//   1) Si hay algun entry `trabajando` (en cualquiera de las dos fases) →
//      state='running', startedAt = entry.startedAt (el del entry trabajando).
//      Razon: "trabajando ahora" gana sobre cualquier estado historico.
//   2) Si no hay trabajando pero hay `pendiente` → state='pending',
//      startedAt=null. El operador sabe que esta encolado.
//   3) Si no hay trabajando ni pendiente, miramos los terminales (`listo` o
//      `procesado`) y tomamos el mas reciente por updatedAt. Si su
//      `resultado === 'aprobado'` → state='approved', sino → state='rejected'.
//   4) Si no hay ningun entry del skill `architect` → return null (el badge
//      NO se renderiza). Esto cumple CA-PO-WIDGET-DISCOVERABLE: el badge
//      aparece automaticamente cuando el rol toca el issue y desaparece al
//      cerrar el ciclo (todos los archivos limpiados).
//
// Modulo separado de dashboard-slices.js para facilitar test unitario aislado
// y mantener el slice consumiendo logica pura sin acoplarse al scanner del
// dashboard.

'use strict';

const ARCHITECT_SKILL = 'architect';

/**
 * Devuelve el estado consolidado del rol architect para un issue dado.
 *
 * @param {Object<string, Array<Object>>} fasesByKey
 *   Mapa `${pipeline}/${fase}` → array de entries (la estructura que el
 *   dashboard guarda en `state.issueMatrix[issue].fases`). Cada entry tiene
 *   al menos: { skill, estado, startedAt, updatedAt, resultado }.
 * @returns {{ state: 'pending'|'running'|'approved'|'rejected', startedAt: number|null }|null}
 *   Estado resuelto, o `null` si no hay entries del skill architect.
 */
function resolveArchitectState(fasesByKey) {
  if (!fasesByKey || typeof fasesByKey !== 'object') return null;

  // Recolectar todos los entries de architect a traves de ambas fases.
  const architectEntries = [];
  for (const entries of Object.values(fasesByKey)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.skill !== ARCHITECT_SKILL) continue;
      architectEntries.push(entry);
    }
  }

  if (architectEntries.length === 0) return null;

  // 1) trabajando gana siempre. Si hay varios trabajando (caso patológico),
  //    tomamos el de startedAt mas reciente para que el HH:MM coincida con
  //    la ejecucion activa mas nueva.
  const trabajando = architectEntries.filter(e => e.estado === 'trabajando');
  if (trabajando.length > 0) {
    const latest = trabajando.reduce((a, b) =>
      (b.startedAt || 0) > (a.startedAt || 0) ? b : a);
    const startedAt = (typeof latest.startedAt === 'number' && !isNaN(latest.startedAt))
      ? latest.startedAt
      : null;
    return { state: 'running', startedAt };
  }

  // 2) pendiente sin trabajando → encolado.
  const pendiente = architectEntries.filter(e => e.estado === 'pendiente');
  if (pendiente.length > 0) {
    return { state: 'pending', startedAt: null };
  }

  // 3) Terminales: listo + procesado. El mas reciente por updatedAt define
  //    aprobado/rechazado.
  const terminales = architectEntries.filter(e =>
    e.estado === 'listo' || e.estado === 'procesado');
  if (terminales.length > 0) {
    const latest = terminales.reduce((a, b) =>
      (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
    const state = latest.resultado === 'aprobado' ? 'approved' : 'rejected';
    return { state, startedAt: null };
  }

  // 4) Defensa: hay entries de architect pero ninguno cae en estados conocidos.
  //    Devolver null para no renderizar un badge con estado indefinido.
  return null;
}

module.exports = {
  resolveArchitectState,
  ARCHITECT_SKILL,
};

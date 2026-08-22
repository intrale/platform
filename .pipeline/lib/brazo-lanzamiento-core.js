// =============================================================================
// brazo-lanzamiento-core.js — Selección/orden puro de candidatos (EP5-H1, #3938)
//
// CONTEXTO
// --------
// `brazoLanzamiento` (pulpo.js:~4952) recolecta los work-files de `pendiente/`
// de TODAS las fases, los filtra por las ventanas de prioridad activas
// (autoexcluyentes QA > Build > Dev) y los ordena por:
//   1. prioridad de feature (menor = más prioritario)
//   2. fase inversa (fases más avanzadas primero, desempate)
// luego intenta lanzarlos respetando concurrencia/presión.
//
// Este módulo extrae SOLO el filtrado + ordenamiento PURO. El cálculo de la
// presión, `concurrencyMultiplier`, la lectura de FS y el lanzamiento real
// quedan en el adaptador del brazo (frontera I/O). La prioridad de cada
// candidato (`calcularPrioridad`) se calcula en la frontera y se pasa ya
// resuelta — la función pura no accede a `gh`/labels/config.
//
// Molde `rebote-classifier.js`: funciones puras sobre datos ya leídos.
// =============================================================================

'use strict';

// Fases bloqueadas por cada ventana de prioridad (autoexcluyentes).
// Espejo exacto de las constantes en brazoLanzamiento (pulpo.js).
const DEV_PHASES = ['dev', 'validacion'];
const QA_BLOCKED_PHASES = ['dev', 'validacion', 'build']; // QA bloquea también build

/**
 * ¿La fase está bloqueada por la ventana de prioridad activa?
 *
 * Reglas (espejo de pulpo.js:4991-4992):
 *   - QA priority activa → bloquea dev + validacion + build.
 *   - Build priority activa (y NO QA) → bloquea dev + validacion.
 *   - Sin ventana → nada bloqueado.
 *
 * @param {string} fase
 * @param {{qaPriority?:boolean, buildPriority?:boolean}} windows
 * @returns {boolean}
 */
function isPhaseBlockedByWindow(fase, { qaPriority = false, buildPriority = false } = {}) {
  if (qaPriority && QA_BLOCKED_PHASES.includes(fase)) return true;
  if (buildPriority && !qaPriority && DEV_PHASES.includes(fase)) return true;
  return false;
}

/**
 * Comparador puro de candidatos: prioridad ascendente (menor = primero),
 * desempate por fase inversa (faseIdx mayor = más avanzada = primero).
 * Espejo de pulpo.js:5010-5022.
 *
 * @param {{priority:number, faseIdx:number}} a
 * @param {{priority:number, faseIdx:number}} b
 * @returns {number}
 */
function compareCandidates(a, b) {
  const pa = Number.isFinite(a.priority) ? a.priority : Infinity;
  const pb = Number.isFinite(b.priority) ? b.priority : Infinity;
  if (pa !== pb) return pa - pb; // prioridad de feature: menor primero
  return b.faseIdx - a.faseIdx;  // desempate: fase más avanzada primero
}

/**
 * Filtrar candidatos por ventana de prioridad y ordenarlos.
 *
 * NO muta el array de entrada (devuelve uno nuevo ordenado). Cada candidato
 * debe traer `priority` (ya calculada en la frontera vía `calcularPrioridad`)
 * y `faseIdx` (índice de su fase en el pipeline).
 *
 * @param {object} p
 * @param {Array<{fase:string, priority:number, faseIdx:number}>} p.candidates
 * @param {{qaPriority?:boolean, buildPriority?:boolean}} [p.windows]
 * @returns {Array} candidatos elegibles, ordenados por prioridad > fase inversa
 */
function rankLaunchCandidates({ candidates, windows = {} } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .filter((c) => c && !isPhaseBlockedByWindow(c.fase, windows))
    .slice() // copia defensiva antes de ordenar
    .sort(compareCandidates);
}

/**
 * #4709 — Deriva las señales de dispatch-cause dependientes de la ventana
 * horaria a partir del inventario de pendientes por fase (ya leído de FS en la
 * frontera) y del estado de ventanas activas. Puro y determinístico: no toca FS.
 *
 * Cierra el gap CA-1/CA-2 del rebote: los pendientes de fases bloqueadas por
 * ventana se saltan con `continue` ANTES de entrar a `candidates`, así que
 * `candidates.length` NO puede usarse como proxy de "hay pendientes" (si toda la
 * cola vive en fases window-blocked, `candidates` queda vacío pero la cola SÍ
 * está ociosa con causa). Este helper:
 *   - `hayPendientes`: true si CUALQUIER fase (bloqueada o no) tiene pendientes.
 *   - `windowBlockedHasPending`: true SOLO si alguna fase window-blocked tiene
 *     pendientes reales → habilita marcar VENTANA_HORARIA sin falso positivo
 *     (una fase vacía bloqueada por ventana no explica ninguna ociosidad).
 *   - `blockedPhases`: fases window-blocked con pendientes (para el detalle).
 *   - `launchablePending`: total de pendientes en fases NO bloqueadas.
 *
 * @param {Array<{fase:string, pendingCount:number}>} inventory
 * @param {{qaPriority?:boolean, buildPriority?:boolean}} [windows]
 * @returns {{hayPendientes:boolean, windowBlockedHasPending:boolean, blockedPhases:string[], launchablePending:number}}
 */
function resolveWindowPendingSignals(inventory, windows = {}) {
  let hayPendientes = false;
  let launchablePending = 0;
  const blockedPhases = [];
  for (const item of (Array.isArray(inventory) ? inventory : [])) {
    const n = item && Number.isFinite(item.pendingCount) ? item.pendingCount : 0;
    if (n <= 0) continue;
    hayPendientes = true;
    if (isPhaseBlockedByWindow(item.fase, windows)) {
      if (!blockedPhases.includes(item.fase)) blockedPhases.push(item.fase);
    } else {
      launchablePending += n;
    }
  }
  return {
    hayPendientes,
    windowBlockedHasPending: blockedPhases.length > 0,
    blockedPhases,
    launchablePending,
  };
}

module.exports = {
  rankLaunchCandidates,
  isPhaseBlockedByWindow,
  compareCandidates,
  resolveWindowPendingSignals,
  DEV_PHASES,
  QA_BLOCKED_PHASES,
};

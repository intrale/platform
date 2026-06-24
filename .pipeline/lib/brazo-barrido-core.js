// =============================================================================
// brazo-barrido-core.js — Lógica pura de decisión de cierre de fase (EP5-H1, #3938)
//
// CONTEXTO
// --------
// `brazoBarrido` (pulpo.js:~3028) escanea `listo/` de cada fase, agrupa por
// issue y decide si la fase cerró OK (promover a la siguiente fase), si algún
// skill rechazó (rebote a `fase_rechazo`), o si todavía faltan skills (esperar).
//
// Toda esa decisión vive entrelazada con I/O de FS, `gh` CLI, gates visuales y
// de arquitecto, fast-fail y cross-phase. Este módulo extrae la DECISIÓN PURA
// —promote / rebote / wait— a partir de los `resultado` YA parseados, siguiendo
// el molde de `rebote-classifier.js`: sin acceso a `fs`/`gh`/estado global.
//
// El brazo en `pulpo.js` sigue siendo el adaptador que lee FS, llama a la
// función pura, y aplica los efectos (mover archivos, encolar labels, correr
// gates). Los gates de visual/arquitecto y el flujo de fast-fail/cross-phase
// quedan en el adaptador como pasos POSTERIORES a la decisión.
// =============================================================================

'use strict';

/**
 * Calcular la fase destino de una promoción.
 * @param {string[]} fases - lista ordenada de fases del pipeline
 * @param {number} faseIdx - índice de la fase actual
 * @returns {string|null} la siguiente fase, o `null` si la actual es la última
 */
function nextFase(fases, faseIdx) {
  if (!Array.isArray(fases)) return null;
  return faseIdx >= 0 && faseIdx < fases.length - 1 ? fases[faseIdx + 1] : null;
}

/**
 * Decide el resultado de una fase a partir de los estados ya parseados.
 *
 * Semántica (espejo de brazoBarrido, sin fast-fail/cross-phase/gates):
 *   - `wait`    → faltan skills requeridos Y ninguno de los presentes rechazó.
 *   - `rebote`  → al menos un skill presente rechazó (fast-fail: no espera al
 *                 resto). `rejectedSkills` lista los que rechazaron.
 *   - `promote` → todos los skills requeridos están presentes y aprobados.
 *                 `toFase` es la siguiente fase (o `null` si es la última, en
 *                 cuyo caso el issue completó el pipeline).
 *
 * @param {object} p
 * @param {string[]} p.skillsRequeridos - skills que la fase necesita cerrados
 * @param {Record<string,{resultado:string}>} p.estadosPorSkill - estado por
 *        skill, leído por el caller desde `listo/` (+ `procesado/`).
 * @param {string[]} p.fases - fases del pipeline (orden)
 * @param {number} p.faseIdx - índice de la fase actual
 * @returns {{action:'promote'|'rebote'|'wait', toFase:string|null, rejectedSkills:string[]}}
 */
function decidePhaseOutcome({ skillsRequeridos, estadosPorSkill, fases, faseIdx }) {
  const requeridos = Array.isArray(skillsRequeridos) ? skillsRequeridos : [];
  const estados = estadosPorSkill && typeof estadosPorSkill === 'object' ? estadosPorSkill : {};

  // Fast-fail: si CUALQUIER skill presente rechazó, rebote inmediato sin
  // esperar a los pendientes (espejo de `hayRechazoConfirmado` en barrido).
  const rejectedSkills = Object.keys(estados).filter(
    (s) => estados[s] && estados[s].resultado === 'rechazado',
  );
  if (rejectedSkills.length > 0) {
    return { action: 'rebote', toFase: null, rejectedSkills };
  }

  // Sin rechazos: ¿están todos los requeridos presentes?
  const presentes = requeridos.filter((s) => estados[s]);
  if (presentes.length < requeridos.length) {
    return { action: 'wait', toFase: null, rejectedSkills: [] };
  }

  // Todos presentes y aprobados → promover.
  return { action: 'promote', toFase: nextFase(fases, faseIdx), rejectedSkills: [] };
}

module.exports = {
  decidePhaseOutcome,
  nextFase,
};

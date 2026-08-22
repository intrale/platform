// .pipeline/lib/phase-completion.js
//
// Evaluación de completitud de fases paralelas (analisis / criterios / validacion).
//
// PROBLEMA QUE RESUELVE (#3481):
// Cuando una fase paralela requiere N skills y uno cierra OK en un ciclo
// anterior, su artefacto queda en `procesado/`. Si los otros skills son
// rebloqueados por dependencias y vuelven a entrar al ciclo, terminan en
// `listo/` mientras el primero sigue en `procesado/`. El barrido original
// solo contaba lo que había en `listo/` y nunca llegaba a N — el issue queda
// trabado indefinidamente (casos reproducidos: #3409, #3384).
//
// SOLUCIÓN:
// `evaluateParallelPhaseCompletion` considera `listo/` Y `procesado/` para
// decidir si la fase está completa, pero filtra con whitelist estricta
// (`resultado === 'aprobado'` SIN `cancelado_por`) y respeta concurrencia
// (un skill con artefacto vivo en `pendiente/` o `trabajando/` se considera
// incompleto aunque tenga una versión aprobada en `procesado/`).
//
// El módulo es PURO: recibe arrays de YAMLs ya leídos y NO toca filesystem.
// Esto permite tests deterministas y mantiene el orquestador (pulpo.js) como
// el único responsable del I/O.

'use strict';

/**
 * Whitelist estricta: un YAML cuenta como completo SOLO si:
 *   - tiene `resultado === 'aprobado'`
 *   - NO tiene el campo `cancelado_por` con un valor no vacío
 *     (cualquier valor: 'fast-fail-rebote', 'cross-phase-rebote', etc.)
 *
 * Esto evita falsos positivos por residuos de rebotes o rechazos previos
 * archivados en `procesado/`.
 *
 * @param {object|null|undefined} yamlData
 * @returns {boolean}
 */
function isApprovedArtifact(yamlData) {
  if (!yamlData || typeof yamlData !== 'object') return false;
  if (yamlData.resultado !== 'aprobado') return false;
  if (Object.prototype.hasOwnProperty.call(yamlData, 'cancelado_por')) {
    const val = yamlData.cancelado_por;
    if (val !== null && val !== undefined && val !== '') return false;
  }
  return true;
}

/**
 * Evaluar si una fase paralela está completa.
 *
 * @param {object} params
 * @param {string[]} params.skillsRequeridos        - skills que la fase requiere
 * @param {Array<{skill:string, yaml:object}>} params.listo       - artefactos vivos en listo/
 * @param {Array<{skill:string, yaml:object}>} [params.procesado] - artefactos en procesado/ (ciclos previos)
 * @param {string[]} [params.pendienteSkills]       - skills del issue vivos en pendiente/
 * @param {string[]} [params.trabajandoSkills]      - skills del issue vivos en trabajando/
 * @returns {{
 *   todosCompletos: boolean,
 *   origenPorSkill: Record<string, 'listo'|'procesado'>,
 *   skillsCompletados: string[],
 *   skillsFaltantes: string[]
 * }}
 */
function evaluateParallelPhaseCompletion(params) {
  const {
    skillsRequeridos = [],
    listo = [],
    procesado = [],
    pendienteSkills = [],
    trabajandoSkills = [],
  } = params || {};

  const liveSkills = new Set([...pendienteSkills, ...trabajandoSkills]);
  const listoBySkill = new Map();
  for (const a of listo) {
    if (a && a.skill && !listoBySkill.has(a.skill)) listoBySkill.set(a.skill, a.yaml);
  }
  const procesadoBySkill = new Map();
  for (const a of procesado) {
    if (a && a.skill && !procesadoBySkill.has(a.skill)) procesadoBySkill.set(a.skill, a.yaml);
  }

  const origenPorSkill = {};
  const skillsCompletados = [];
  const skillsFaltantes = [];

  for (const skill of skillsRequeridos) {
    // Anti-race: si hay artefacto vivo del mismo skill en pendiente/trabajando,
    // está siendo reprocesado — no contarlo como completo aunque exista una
    // versión aprobada en procesado/ (es estado obsoleto).
    if (liveSkills.has(skill)) {
      skillsFaltantes.push(skill);
      continue;
    }

    // Prioridad: listo/ pisa procesado/ (mismo ciclo gana sobre histórico).
    if (listoBySkill.has(skill) && isApprovedArtifact(listoBySkill.get(skill))) {
      origenPorSkill[skill] = 'listo';
      skillsCompletados.push(skill);
      continue;
    }

    // Fallback histórico: procesado/ con whitelist estricta.
    if (procesadoBySkill.has(skill) && isApprovedArtifact(procesadoBySkill.get(skill))) {
      origenPorSkill[skill] = 'procesado';
      skillsCompletados.push(skill);
      continue;
    }

    // En listo pero rechazado, o sin artefacto en ningún lado: incompleto.
    skillsFaltantes.push(skill);
  }

  return {
    todosCompletos: skillsFaltantes.length === 0,
    origenPorSkill,
    skillsCompletados,
    skillsFaltantes,
  };
}

/**
 * Helper de logging: formato compacto del origen por skill para la línea de
 * promoción del barrido. Devuelve string vacío si todo vino de listo/ (caso
 * clásico — no aporta info).
 *
 * @param {Record<string,'listo'|'procesado'>} origenPorSkill
 * @returns {string} ej: "ux←procesado/, po←listo/, guru←listo/" (o "" si todo listo)
 */
function formatOrigenLog(origenPorSkill) {
  const entries = Object.entries(origenPorSkill || {});
  if (entries.length === 0) return '';
  const hayProcesado = entries.some(([, origen]) => origen === 'procesado');
  if (!hayProcesado) return '';
  return entries.map(([skill, origen]) => `${skill}←${origen}/`).join(', ');
}

module.exports = {
  evaluateParallelPhaseCompletion,
  isApprovedArtifact,
  formatOrigenLog,
};

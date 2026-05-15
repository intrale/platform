// .pipeline/lib/rebote-destino.js
// =============================================================================
// Resolución del destino de un rebote — fase + skills a re-encolar.
//
// Issue #2374: diferenciar rebote infra vs código.
//
// Contrato (puro, sin side-effects):
//   resolveReboteDestino({
//     esReboteDeInfra,   // boolean — true si la clasificación dio infra
//     fase,              // string — fase actual donde ocurrió el rechazo
//     faseRechazo,       // string|null — fase configurada para rebote código (ej. 'dev')
//     skillsPorFase,     // object — pipelineConfig.skills_por_fase
//     determinarDevSkill,// function(issue, config) → skill (sólo se usa para dev/codigo)
//     rechazados,        // array de { file: {name}, motivo? } — para fallback defensivo
//     issue,             // string|number — id del issue
//     config,            // object — config completo (sólo se pasa a determinarDevSkill)
//     skillFromFile,     // function(filename) → skill — para fallback defensivo
//   }) → { faseDestino, skillsDestino }
//
// Reglas:
//   - rebote código → faseDestino = faseRechazo, skillsDestino = [determinarDevSkill(issue, config)]
//     Razón: el dev tiene que corregir el código. El skill se elige por labels
//     del issue (mismo criterio que el promotor a dev).
//
//   - rebote infra → faseDestino = fase (misma), skillsDestino dependen del shape de la fase:
//       * fases mono-skill (dev/build/entrega): re-encolar el único skill.
//         Para `dev`, determinarDevSkill resuelve por labels.
//       * fases paralelas (validación/verificación/aprobación): re-encolar TODOS
//         los skills_por_fase. No basta con re-encolar sólo el skill que falló,
//         porque los archivos en listo/ de skills que aprobaron se mueven a
//         procesado/ al final del barrido y la próxima evaluación quedaría
//         incompleta para siempre (faltan resultados de los demás).
//
//   - Fallback defensivo: si por config rota o fase desconocida no resolvimos
//     skills, caemos a los skills de los archivos rechazados — para no perder
//     el rebote silenciosamente.
//
// El módulo es puro: NO toca filesystem. El caller (pulpo.js) lee el resultado
// y escribe los YAMLs en `<faseDestino>/pendiente/`.
// =============================================================================

'use strict';

// Fases de "un solo skill" — el resto se asume paralelo multi-skill.
// Sincronizado con pulpo.js:3463-3473 (lógica de promoción entre fases).
const FASES_MONO_SKILL = new Set(['dev', 'build', 'entrega']);

function resolveReboteDestino(opts) {
  const {
    esReboteDeInfra,
    fase,
    faseRechazo,
    skillsPorFase = {},
    determinarDevSkill,
    rechazados = [],
    issue,
    config = {},
    skillFromFile,
  } = opts;

  // Rebote código → comportamiento histórico (a faseRechazo, dev).
  if (!esReboteDeInfra) {
    const devSkill = typeof determinarDevSkill === 'function'
      ? determinarDevSkill(issue, config)
      : null;
    return {
      faseDestino: faseRechazo,
      skillsDestino: devSkill ? [devSkill] : [],
    };
  }

  // Rebote infra → misma fase. Skills dependen del shape de la fase.
  let skillsDestino;
  if (FASES_MONO_SKILL.has(fase)) {
    if (fase === 'dev') {
      const devSkill = typeof determinarDevSkill === 'function'
        ? determinarDevSkill(issue, config)
        : null;
      skillsDestino = devSkill ? [devSkill] : [];
    } else {
      const skillsArr = skillsPorFase[fase] || [];
      skillsDestino = skillsArr.length > 0 ? [skillsArr[0]] : [];
    }
  } else {
    // Fase paralela: re-encolar TODOS los skills declarados.
    skillsDestino = (skillsPorFase[fase] || []).slice();
  }

  // Fallback defensivo: si no resolvimos nada, usar los skills de los archivos
  // rechazados. Esto evita que un rebote infra se pierda silenciosamente si la
  // config tiene una fase no declarada o `skills_por_fase` está corrupto.
  if (skillsDestino.length === 0 && typeof skillFromFile === 'function') {
    const fallback = [...new Set(
      rechazados
        .map(r => skillFromFile((r.file && r.file.name) || ''))
        .filter(Boolean)
    )];
    skillsDestino = fallback;
  }

  return {
    faseDestino: fase,
    skillsDestino,
  };
}

module.exports = {
  resolveReboteDestino,
  FASES_MONO_SKILL,
};

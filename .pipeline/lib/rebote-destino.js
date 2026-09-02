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
//     accionRequerida,   // 'codigo'|null — #6745 CA-3: qué acción pide el motivo
//   }) → { faseDestino, skillsDestino, degradadoACodigo }
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

// -----------------------------------------------------------------------------
// #6745 CA-3 — REGLA DE CAPACIDAD DE FASE (degradado infra → código)
//
// Un rebote `infra` reencola en la MISMA fase. Eso es correcto cuando el fallo
// fue transitorio (timeout/crash) y algún skill de esa fase puede reintentar.
// Pero si el motivo pide una acción que en esta config SÓLO puede ejecutar un
// skill que escribe código, reencolar en la misma fase es un bucle sin salida:
// el skill que vuelve a correr no tiene forma de hacer lo que se le pide
// (casos reales #6179 y #3741, este último anotado en pulpo.js con su costo:
// ~$80–100/h).
//
// La capacidad se deriva de los parámetros que YA entran, sin agregar un set
// nuevo de nombres de fase: la única fase cuyos skills escriben código es
// `faseRechazo` (config.yaml → `fase_rechazo: dev`; `skills_por_fase.dev` =
// backend-dev / android-dev / web-dev / pipeline-dev / dev). Todas las demás
// son de validación / verificación / linteo / aprobación / entrega.
//
// SEC-F — `faseDestino` termina formando un path
// (`path.join(fasePath(...), 'pendiente')` en pulpo.js). Por eso la señal
// derivada del motivo SÓLO puede ELEGIR entre dos valores que ya venían en los
// parámetros (`fase` o `faseRechazo`) y NUNCA nombrar una fase nueva — el
// riesgo de path traversal está documentado en workfile-name.js:12-16.
// Por la misma razón `accionRequerida` entra tipada ('codigo' | null): está
// PROHIBIDO releer o parsear el motivo acá dentro (rompería la pureza).
// -----------------------------------------------------------------------------

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
    // #6745 CA-3 — 'codigo' si el motivo pide una acción que sólo un skill que
    // escribe código puede ejecutar. Tipado, derivado por el clasificador.
    accionRequerida = null,
  } = opts;

  // Rebote código → comportamiento histórico (a faseRechazo, dev).
  if (!esReboteDeInfra) {
    const devSkill = typeof determinarDevSkill === 'function'
      ? determinarDevSkill(issue, config)
      : null;
    return {
      faseDestino: faseRechazo,
      skillsDestino: devSkill ? [devSkill] : [],
      degradadoACodigo: false,
    };
  }

  // #6745 CA-3 — degradado por capacidad de fase. Va ANTES de resolver skills
  // de la misma fase: si la acción pedida es de código y estamos fuera de
  // `faseRechazo`, reencolar acá no puede converger nunca.
  if (accionRequerida === 'codigo' && faseRechazo && fase !== faseRechazo) {
    const devSkill = typeof determinarDevSkill === 'function'
      ? determinarDevSkill(issue, config)
      : null;
    return {
      faseDestino: faseRechazo,
      skillsDestino: devSkill ? [devSkill] : [],
      degradadoACodigo: true,
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
    degradadoACodigo: false,
  };
}

module.exports = {
  resolveReboteDestino,
  FASES_MONO_SKILL,
};

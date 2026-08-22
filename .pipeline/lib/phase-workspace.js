'use strict';

/**
 * phase-workspace — clasificación pura de en qué workspace corre cada fase.
 *
 * El pulpo lanza agentes por fase y decide el `cwd` del spawn según la fase:
 *   - `dev` crea un worktree nuevo para el issue (needsWorktree).
 *   - Las fases post-dev que LEEN o tocan el código del issue reutilizan el
 *     worktree ya creado por `dev` (useExistingWorktree). Si corrieran en ROOT
 *     leerían la rama arbitraria del repo principal (checkout de OTRO agente) y
 *     producirían veredictos incorrectos.
 *   - El resto (p.ej. `validacion`, que precede a `dev`) corre en ROOT.
 *
 * Esta clasificación estaba inline en pulpo.js y era propensa a olvidar fases
 * (incidentes #2526 linteo, #2519 entrega, #4532 verificacion). Extraerla a una
 * función pura la hace testeable y documenta el contrato en un solo lugar.
 *
 * Orden de fases del pipeline `desarrollo` (config.yaml):
 *   validacion → dev → build → verificacion → linteo → aprobacion → entrega
 *
 * Todas las fases entre `dev` (inclusive) y `entrega` (inclusive) disponen del
 * worktree del issue: `dev` lo crea y `entrega` lo limpia al final.
 */

// Fase que CREA el worktree del issue.
const WORKTREE_CREATING_PHASE = 'dev';

// Fases post-dev que reutilizan el worktree del issue (lectura o mutación de
// código del issue, nunca ROOT). Mantener sincronizado con el orden de fases.
const EXISTING_WORKTREE_PHASES = Object.freeze([
  'build',        // gradlew check sobre el código del issue
  'verificacion', // tester/security/qa estructural: inspeccionan el código del issue (#4532)
  'linteo',       // chequeos mecánicos sobre el diff del issue (#2526)
  'aprobacion',   // review/po/ux/architect leen el código del issue
  'entrega',      // delivery hace git add/commit/rebase/push local (#2519)
]);

/**
 * ¿La fase debe CREAR un worktree nuevo para el issue?
 * @param {string} fase
 * @returns {boolean}
 */
function phaseNeedsWorktree(fase) {
  return fase === WORKTREE_CREATING_PHASE;
}

/**
 * ¿La fase debe REUTILIZAR el worktree ya creado por `dev`?
 * @param {string} fase
 * @returns {boolean}
 */
function phaseUsesExistingWorktree(fase) {
  return EXISTING_WORKTREE_PHASES.includes(fase);
}

/**
 * ¿La fase corre dentro del worktree del issue (creándolo o reutilizándolo)?
 * Equivale al predicado que el pulpo usa para elegir spawnCwd = worktreePath.
 * @param {string} fase
 * @returns {boolean}
 */
function phaseRunsInIssueWorktree(fase) {
  return phaseNeedsWorktree(fase) || phaseUsesExistingWorktree(fase);
}

module.exports = {
  WORKTREE_CREATING_PHASE,
  EXISTING_WORKTREE_PHASES,
  phaseNeedsWorktree,
  phaseUsesExistingWorktree,
  phaseRunsInIssueWorktree,
};

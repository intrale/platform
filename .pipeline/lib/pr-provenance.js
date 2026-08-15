// =============================================================================
// pr-provenance.js — #5864 · SEC-2. Procedencia del PR sobre el que se escribe
// un label de gate.
//
// POR QUÉ EXISTE
// --------------
// `intrale/platform` es un repositorio PÚBLICO y el patrón de rama del pipeline
// es público y predecible (`agent/<issue>-<skill>`, documentado en CLAUDE.md).
// Cualquiera puede forkearlo, crear en su fork esa misma rama y abrir un PR
// contra `main`.
//
// `gh pr list --head <branch>` NO filtra por owner: devuelve también los PRs
// cuyo head vive en un fork. Verificado empíricamente contra un repo público
// con forks:
//
//   $ gh pr list --repo cli/cli --head "ssh-key-delete-signing" --state all \
//       --json number,headRefName,isCrossRepository,headRepositoryOwner
//   [{"headRefName":"ssh-key-delete-signing","isCrossRepository":true,
//     "headRepositoryOwner":{"login":"zhaoxinyi02"},"number":14117}]
//
// Si un PR de fork se adoptara como "el PR del issue", delivery le propagaría
// automáticamente el `qa:passed` del issue y con eso le abriría el gate de
// merge: el gate de procedencia del merge (`verifyRemoteBranchOrigin`) audita
// `origin/main..origin/<branch>`, es decir la rama LEGÍTIMA de origin — que el
// pipeline sí pushea — y no el head del fork; y el merge se hace contra
// `snapshot.headRefOid`, que es el SHA DEL FORK. El label de QA es la última
// barrera efectiva contra ese vector, así que escribirlo exige verificar antes
// que el PR sea del mismo repositorio.
//
// FAIL-CLOSED
// -----------
// La ausencia de dato NUNCA es permiso. `isCrossRepository` debe venir
// explícitamente en `false`: `undefined` (campo no pedido, respuesta recortada,
// versión de `gh` que no lo emite) se trata como fork.
// =============================================================================
'use strict';

// Campos mínimos que hay que pedirle a `gh` para poder decidir. Quien consulte
// PRs para escribir labels de gate DEBE pedir estos campos: sin ellos
// `checkPrProvenance` rechaza por `procedencia_desconocida`.
const PR_PROVENANCE_FIELDS = ['number', 'url', 'labels', 'headRefName', 'isCrossRepository', 'headRepositoryOwner'];

const DEFAULT_REPO = 'intrale/platform';

/** Owner esperado del head del PR, derivado de `owner/repo`. */
function expectedHeadOwner(repo) {
  const r = (typeof repo === 'string' && repo.trim()) ? repo.trim() : DEFAULT_REPO;
  return r.split('/')[0].toLowerCase();
}

/**
 * ¿El PR es del mismo repositorio y de la rama que esperamos?
 *
 * Función PURA — no invoca `gh` ni toca el filesystem, para que el caso de
 * fork sea testeable sin red.
 *
 * @param {object} pr Objeto de `gh pr view/list` con `PR_PROVENANCE_FIELDS`.
 * @param {object} [opts]
 * @param {string} [opts.branch] Si se pasa, se exige `headRefName === branch`.
 * @param {string} [opts.repo] `owner/repo` esperado. Default `intrale/platform`.
 * @returns {{ok:true}|{ok:false, reason:string, detail?:string}}
 *   reasons: `procedencia_desconocida` | `pr_de_fork` | `pr_rama_distinta`
 */
function checkPrProvenance(pr, opts) {
  const { branch, repo } = opts || {};
  if (!pr || typeof pr !== 'object') return { ok: false, reason: 'procedencia_desconocida' };

  // Sin rama declarada no hay nada que anclar: no se puede afirmar que este PR
  // sea el del issue.
  if (typeof pr.headRefName !== 'string' || !pr.headRefName) {
    return { ok: false, reason: 'procedencia_desconocida', detail: 'headRefName ausente' };
  }

  // Ausencia de dato ≠ permiso: sólo un `false` explícito habilita.
  if (pr.isCrossRepository !== false) {
    return {
      ok: false,
      reason: pr.isCrossRepository === true ? 'pr_de_fork' : 'procedencia_desconocida',
      detail: `isCrossRepository=${String(pr.isCrossRepository)}`,
    };
  }

  const owner = pr.headRepositoryOwner && String(pr.headRepositoryOwner.login || '').toLowerCase();
  if (!owner) {
    return { ok: false, reason: 'procedencia_desconocida', detail: 'headRepositoryOwner ausente' };
  }
  const expected = expectedHeadOwner(repo);
  if (owner !== expected) {
    return { ok: false, reason: 'pr_de_fork', detail: `owner=${owner} esperado=${expected}` };
  }

  // El head debe ser EXACTAMENTE la rama que empujó el pipeline. Un PR abierto
  // desde otra rama no es el PR de este issue aunque viva en el mismo repo.
  if (typeof branch === 'string' && branch && pr.headRefName !== branch) {
    return { ok: false, reason: 'pr_rama_distinta', detail: `head=${pr.headRefName} esperado=${branch}` };
  }

  return { ok: true };
}

module.exports = {
  PR_PROVENANCE_FIELDS,
  DEFAULT_REPO,
  expectedHeadOwner,
  checkPrProvenance,
};

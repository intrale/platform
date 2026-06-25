// .pipeline/lib/convergence-detector.js
// =============================================================================
// Detección de convergencia para auto-promoción de rebotes "en falso" (#4160).
//
// Problema: la fase `verificacion` a veces rebota un issue a `dev` sin una
// observación accionable real. El dev no encuentra nada que corregir, no cambia
// el diff, y el ciclo se repite hasta agotar el circuit breaker y caer a
// intervención humana. Este módulo detecta ese patrón de convergencia (diff
// idéntico entre rebotes + sin observación nueva + build verde) para que el
// Pulpo auto-promueva en lugar de seguir rebotando.
//
// Contrato (puro — el único side-effect es `git diff` vía execSync inyectable,
// igual que getChangedFilesForIssue en pulpo.js):
//
//   computeDiffHash(issue, { execSyncImpl, root }) → { hash, known }
//   isConvergent({ prevHash, currentHash, hasNewObservation, buildGreen }) → boolean
//   isEligibleForAutoPromote({ rechazos, excludeSkills }) → { eligible, razon }
//
// INVARIANTES DE SEGURIDAD (NO NEGOCIABLES — RIESGO-1 del análisis security):
//   - Un rechazo originado por el skill `security` NUNCA es elegible para
//     auto-promoción por convergencia (sigue el circuit breaker hacia humano).
//   - Un rechazo con observación clasificada como accionable (claim verificable)
//     NUNCA es elegible.
//   - Todo es fail-closed: cualquier dato faltante (`null`/falsy) ⇒ NO converge,
//     NO elegible. Ante la duda, NO auto-promover.
// =============================================================================

'use strict';

const crypto = require('crypto');

// Skills cuyo rechazo nunca habilita auto-promoción por convergencia.
// Espejo de `circuit_breaker.convergence_excludes_skills` en config.yaml.
// El default es defensa-en-profundidad: aunque config se rompa, `security`
// queda excluido por código.
const DEFAULT_EXCLUDE_SKILLS = ['security'];

/**
 * Calcula el sha256 del diff `origin/main...HEAD` del worktree del issue.
 *
 * Normaliza whitespace (`--ignore-all-space`, RIESGO-5) para que cambios
 * estéticos no rompan la convergencia (un diff-hash inestable equivale a
 * saltear el gate). Fail-closed: si no se resuelve el worktree o el comando
 * falla, devuelve `{ hash: null, known: false }` — el caller interpreta eso
 * como "no puedo afirmar convergencia" y NO auto-promueve.
 *
 * @param {string|number} issue        Número de issue (validado numérico, RIESGO-3).
 * @param {object}        [opts]
 * @param {function}      [opts.execSyncImpl]  Inyección para tests (no toca git real).
 * @param {string}        [opts.root]          CWD para `git worktree list`.
 * @returns {{ hash: string|null, known: boolean }}
 */
function computeDiffHash(issue, { execSyncImpl, root } = {}) {
  // RIESGO-3 — inyección de comando: el issue se interpola en el needle del
  // worktree; validar que es estrictamente numérico ANTES de cualquier uso.
  if (!/^\d+$/.test(String(issue))) {
    throw new Error('convergence-detector: issue debe ser numérico');
  }
  const _execSync = execSyncImpl || require('child_process').execSync;
  const cwd = root || process.cwd();
  try {
    // Localizar el worktree del issue — mismo needle que getChangedFilesForIssue.
    const needle = `platform.agent-${issue}-`;
    let issueWorktree = null;
    const worktrees = _execSync('git worktree list --porcelain', {
      cwd, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    for (const line of String(worktrees).split('\n')) {
      if (line.startsWith('worktree ') && line.includes(needle)) {
        issueWorktree = line.replace('worktree ', '').trim();
        break;
      }
    }
    if (!issueWorktree) {
      return { hash: null, known: false };
    }
    // Comando git FIJO (sin interpolar branch/paths — RIESGO-3). El three-dot
    // limita el diff a lo introducido por la rama. `--ignore-all-space`
    // normaliza whitespace (RIESGO-5).
    const raw = _execSync('git diff --ignore-all-space origin/main...HEAD', {
      cwd: issueWorktree, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
    return { hash, known: true };
  } catch (_e) {
    // Fail-closed: cualquier fallo ⇒ desconocido ⇒ no converge.
    return { hash: null, known: false };
  }
}

/**
 * Determina si el ciclo convergió: el dev produjo el MISMO diff que en el
 * rebote anterior, no apareció una observación nueva, y el build está verde.
 *
 * Fail-closed por diseño: devuelve `true` SOLO si los cuatro factores están
 * presentes y son consistentes. Cualquier `null`/falsy ⇒ `false`.
 *
 * @param {object}  args
 * @param {string|null} args.prevHash          Hash del diff en el rebote anterior.
 * @param {string|null} args.currentHash       Hash del diff actual.
 * @param {boolean}     args.hasNewObservation `true` si apareció una observación nueva.
 * @param {boolean}     args.buildGreen        `true` si el build del issue está verde.
 * @returns {boolean}
 */
function isConvergent({ prevHash, currentHash, hasNewObservation, buildGreen }) {
  return Boolean(
    prevHash
    && currentHash
    && prevHash === currentHash
    && !hasNewObservation
    && buildGreen === true,
  );
}

/**
 * Decide si el conjunto de rechazos es elegible para auto-promoción por
 * convergencia. NO mira el diff — sólo el origen y la clasificación de cada
 * rechazo. La convergencia (isConvergent) es una condición ADICIONAL: el gate
 * del Pulpo exige AMBAS.
 *
 * Reglas (fail-closed):
 *   - Sin rechazos ⇒ no elegible (no hay nada que auto-promover acá).
 *   - Algún rechazo de un skill excluido (`security` por default) ⇒ NO elegible.
 *   - Algún rechazo con observación accionable (claim verificable) ⇒ NO elegible.
 *   - Sólo si TODOS los rechazos son ruido/no-accionable y ninguno es de skill
 *     excluido ⇒ elegible.
 *
 * @param {object}   args
 * @param {Array<{skill:string, accionable:boolean}>} args.rechazos
 * @param {string[]} [args.excludeSkills]  Skills excluidos (default: ['security']).
 * @returns {{ eligible: boolean, razon: string }}
 */
function isEligibleForAutoPromote({ rechazos, excludeSkills } = {}) {
  const lista = Array.isArray(rechazos) ? rechazos : [];
  if (lista.length === 0) {
    return { eligible: false, razon: 'sin rechazos' };
  }
  const excluded = new Set(
    (Array.isArray(excludeSkills) && excludeSkills.length > 0
      ? excludeSkills
      : DEFAULT_EXCLUDE_SKILLS
    ).map(s => String(s).toLowerCase()),
  );
  for (const r of lista) {
    const skill = String((r && r.skill) || '').toLowerCase();
    if (excluded.has(skill)) {
      return { eligible: false, razon: `rechazo de skill excluido: ${skill}` };
    }
    if (r && r.accionable === true) {
      return { eligible: false, razon: `rechazo accionable (skill: ${skill || 'desconocido'})` };
    }
  }
  return { eligible: true, razon: 'todos los rechazos son ruido/no-accionable' };
}

/** Normaliza un motivo para comparar igualdad textual (whitespace/case). */
function _normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Decisión completa del gate de auto-promoción por convergencia. Compone
 * elegibilidad + convergencia en una sola función pura, para que el gate del
 * Pulpo sea directamente testeable (CA-4) sin re-implementar la lógica.
 *
 * @param {object}   args
 * @param {Array<{skill:string, accionable:boolean, motivo:string}>} args.rechazos
 * @param {string[]} [args.prevMotivos]     Motivos de ciclos previos.
 * @param {string|null} args.diffHashPrevio Hash del diff en el rebote anterior.
 * @param {string|null} args.currentHash    Hash del diff actual.
 * @param {boolean}  args.buildGreen        Build del issue verde.
 * @param {string[]} [args.excludeSkills]   Skills excluidos (default ['security']).
 * @returns {{ promote: boolean, razon: string, hasNewObservation: boolean|null }}
 */
function decideAutoPromote({
  rechazos, prevMotivos, diffHashPrevio, currentHash, buildGreen, excludeSkills,
} = {}) {
  const elig = isEligibleForAutoPromote({ rechazos, excludeSkills });
  if (!elig.eligible) {
    return { promote: false, razon: elig.razon, hasNewObservation: null };
  }
  const prevNorm = new Set((Array.isArray(prevMotivos) ? prevMotivos : []).map(_normalizeForCompare));
  const lista = Array.isArray(rechazos) ? rechazos : [];
  const hasNewObservation = lista.some(r => !prevNorm.has(_normalizeForCompare(r && r.motivo)));
  const convergio = isConvergent({
    prevHash: diffHashPrevio, currentHash, hasNewObservation, buildGreen,
  });
  return {
    promote: convergio,
    razon: convergio ? 'convergencia detectada' : 'no converge (diff cambió, observación nueva o build no verde)',
    hasNewObservation,
  };
}

module.exports = {
  computeDiffHash,
  isConvergent,
  isEligibleForAutoPromote,
  decideAutoPromote,
  DEFAULT_EXCLUDE_SKILLS,
};

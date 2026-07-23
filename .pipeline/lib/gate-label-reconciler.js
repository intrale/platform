// .pipeline/lib/gate-label-reconciler.js
// =============================================================================
// GATE 0 — Dueño único determinístico de los labels de gate QA (#4572, SEC-R4).
//
// "Imposible `qa:passed` + `qa:failed` a la vez" exige un ÚNICO punto autorizado
// a emitir/quitar los labels de gate, con semántica *remove-then-add* atómica y
// un validador que RECHACE la combinación ilegal. Este módulo es ese dueño: el
// resto del Pulpo delega acá en vez de encolar labels de gate a mano. Elimina
// el race entre los ≤3 agentes concurrentes que antes escribían labels sueltos.
//
// Lib pura (sin `fs`/`net`): recibe el estado actual de labels + el veredicto de
// `gate-verdict.js` y devuelve las acciones a encolar, en el formato de queue
// existente del servicio-github (`{ action:'label'|'remove-label', issue, label }`,
// ver `pulpo.js:4834-4839`).
//
// Contrato:
//   reconcileGateLabels({ currentLabels, verdict }) → { toAdd[], toRemove[], target }
//   buildLabelActions({ issue, reconciliation })     → [{ action, issue, label }]
// =============================================================================

'use strict';

// Los tres labels de gate QA bajo dominio exclusivo de este reconciliador.
const GATE_LABELS = ['qa:passed', 'qa:failed', 'qa:pending'];
const GATE_LABEL_SET = new Set(GATE_LABELS);

/**
 * Mapea un veredicto de GATE 0 al label de gate objetivo.
 *   pass               → qa:passed
 *   fail               → qa:failed
 *   requires-operator  → qa:pending  (NO es passed: espera firma humana)
 *   (cualquier otro)   → qa:pending  (fail-closed)
 *
 * @param {string} verdict
 * @returns {'qa:passed'|'qa:failed'|'qa:pending'}
 */
function targetLabelFor(verdict) {
  if (verdict === 'pass') return 'qa:passed';
  if (verdict === 'fail') return 'qa:failed';
  // requires-operator y cualquier veredicto desconocido → pending (fail-closed).
  return 'qa:pending';
}

function isGateLabel(label) {
  return GATE_LABEL_SET.has(String(label || ''));
}

function verdictForGateLabel(label) {
  const normalized = String(label || '');
  if (normalized === 'qa:passed') return 'pass';
  if (normalized === 'qa:failed') return 'fail';
  if (normalized === 'qa:pending') return 'requires-operator';
  throw new Error(`[gate-label-reconciler] label fuera de dominio QA gate: ${normalized}`);
}

/**
 * Validador de exclusión mutua (SEC-R4 / CA-3): rechaza (throw) cualquier
 * conjunto de labels que deje `qa:passed` y `qa:failed` coexistiendo. Es el
 * guard de defensa-en-profundidad que garantiza la invariante "imposible
 * qa:passed + qa:failed a la vez", independientemente de cómo se haya llegado
 * a ese estado (bug futuro en la lógica de remove-then-add, race de agentes,
 * label manual mal aplicado).
 *
 * @param {Iterable<string>} labels Labels resultantes proyectados.
 * @param {object} [ctx] Contexto para el mensaje de error.
 * @throws {Error} si `qa:passed` y `qa:failed` coexisten.
 */
function assertMutualExclusion(labels, ctx = {}) {
  const set = labels instanceof Set ? labels : new Set(labels || []);
  if (set.has('qa:passed') && set.has('qa:failed')) {
    throw new Error(
      '[gate-label-reconciler] combinación ilegal: qa:passed y qa:failed no pueden coexistir ' +
      `(target=${ctx.target}, toAdd=${JSON.stringify(ctx.toAdd)}, toRemove=${JSON.stringify(ctx.toRemove)})`,
    );
  }
}

/**
 * Reconcilia los labels de gate: dado el set actual y el veredicto, calcula qué
 * agregar y qué quitar con semántica *remove-then-add*. El único label de gate
 * que debe quedar es el `target`; los otros dos se remueven si están presentes.
 * Al final valida la exclusión mutua vía `assertMutualExclusion` (SEC-R4).
 *
 * Idempotente y convergente: aplicar dos reconciliaciones seguidas desde el
 * mismo veredicto converge al mismo estado (test de race ≤3 agentes).
 *
 * @param {object} args
 * @param {string[]} [args.currentLabels] Labels actuales del issue.
 * @param {string}   args.verdict         Veredicto de `gate-verdict.js`.
 * @returns {{ toAdd:string[], toRemove:string[], target:string }}
 */
function reconcileGateLabels({ currentLabels = [], verdict } = {}) {
  const current = Array.isArray(currentLabels) ? currentLabels.map(String) : [];
  const target = targetLabelFor(verdict);

  // remove-then-add: quitar todos los labels de gate distintos al target que
  // estén presentes; agregar el target si aún no está.
  const toRemove = GATE_LABELS.filter((l) => l !== target && current.includes(l));
  const toAdd = current.includes(target) ? [] : [target];

  // Estado resultante proyectado tras aplicar remove-then-add.
  const projected = new Set(current);
  for (const l of toRemove) projected.delete(l);
  for (const l of toAdd) projected.add(l);

  // Validador de exclusión mutua (SEC-R4): jamás qa:passed + qa:failed juntos.
  assertMutualExclusion(projected, { target, toAdd, toRemove });

  return { toAdd, toRemove, target };
}

/**
 * Traduce una reconciliación al formato de acciones de la queue del
 * servicio-github. `remove-label` primero (remove-then-add), luego `label`.
 *
 * @param {object} args
 * @param {number|string} args.issue
 * @param {{toAdd:string[], toRemove:string[]}} args.reconciliation
 * @returns {Array<{action:'label'|'remove-label', issue:number, label:string}>}
 */
function buildLabelActions({ issue, reconciliation } = {}) {
  const rec = reconciliation || {};
  const issueNum = parseInt(issue, 10);
  const actions = [];
  for (const label of (rec.toRemove || [])) {
    actions.push({ action: 'remove-label', issue: issueNum, label, gate_reconciler: true });
  }
  for (const label of (rec.toAdd || [])) {
    actions.push({ action: 'label', issue: issueNum, label, gate_reconciler: true });
  }
  return actions;
}

module.exports = {
  GATE_LABELS,
  targetLabelFor,
  isGateLabel,
  verdictForGateLabel,
  assertMutualExclusion,
  reconcileGateLabels,
  buildLabelActions,
};

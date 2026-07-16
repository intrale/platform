'use strict';

// #4732 — `blocked:dependencies` pasa a ser reconciliable SÓLO para el oráculo
// "issue CLOSED ⇒ nunca bloqueado": un issue cerrado que arrastra el label
// residual envenenaba el render del dashboard (badge 🛑 / fase "definición").
// La reconciliación de este label queda acotada al caso CLOSED (ver
// `reconcileStateLabels`); en cualquier otro contexto sigue siendo dominio
// delegado y NO se toca.
const RECONCILABLE_STATE_LABELS = ['needs-human', 'blocked:dependencies'];
const RECONCILABLE_STATE_LABEL_SET = new Set(RECONCILABLE_STATE_LABELS);

function normalizeLabels(labels) {
  return Array.isArray(labels) ? labels.map(String) : [];
}

function isReconciliableStateLabel(label) {
  return RECONCILABLE_STATE_LABEL_SET.has(String(label || ''));
}

function reconcileStateLabels({ issue, currentLabels = [], sources = {} } = {}) {
  const labels = normalizeLabels(currentLabels);
  const toAdd = [];
  const toRemove = [];
  const audit = [];

  if (labels.includes('needs-human') && sources && sources.isEpic === true) {
    if (sources.epicChildrenAllDone === true && sources.hasActiveHumanMarker !== true) {
      toRemove.push('needs-human');
      audit.push({
        issue: Number(issue),
        label: 'needs-human',
        action: 'remove',
        oracle: 'epic-children-all-done',
        reason: 'todos los hijos verificables estan CLOSED/Done y no hay marker humano activo',
      });
    }
  }

  // #4732 (CA-3) — Limpieza del label residual `blocked:dependencies` cuando el
  // issue ya está CLOSED. El estado autoritativo (CLOSED) gana siempre sobre el
  // label: un issue cerrado nunca debe re-introducir un bloqueo. Fuente de la
  // señal de cierre: `sources.state === 'CLOSED'` (case-insensitive) o
  // `sources.isClosed === true`. Fail-closed: sin señal explícita de cierre NO
  // se remueve (el label sigue siendo dominio delegado en issues abiertos).
  const closedState = typeof (sources && sources.state) === 'string'
    && sources.state.toUpperCase() === 'CLOSED';
  const isClosed = closedState || (sources && sources.isClosed === true);
  if (labels.includes('blocked:dependencies') && isClosed) {
    toRemove.push('blocked:dependencies');
    audit.push({
      issue: Number(issue),
      label: 'blocked:dependencies',
      action: 'remove',
      oracle: 'issue-closed',
      reason: 'issue CLOSED: label de bloqueo residual no debe envenenar el render',
    });
  }

  return { toAdd, toRemove, audit };
}

module.exports = {
  RECONCILABLE_STATE_LABELS,
  isReconciliableStateLabel,
  reconcileStateLabels,
};

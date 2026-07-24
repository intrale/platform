'use strict';

// #4732 — CA-3 se cumple por el belt-and-suspenders del lado render: la lectura
// del caché (`wave-snapshot.js`, invariante `isBlocked = !isClosed && (...)`,
// #4099) ya ignora `blocked:dependencies` cuando el issue está CLOSED, así que
// un issue cerrado nunca se pinta 🛑 ni en fase "definición" aunque arrastre el
// label residual. La remoción del label vía este reconciler resultaba código
// muerto: el único caller (`servicio-reconciler.reconcileStateLabelsStep`) sólo
// recibe issues `--state open`, y `resolveEpicStateSources` nunca setea señal de
// cierre. Por eso `blocked:dependencies` NO es reconciliable acá.
const RECONCILABLE_STATE_LABELS = ['needs-human'];
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

  return { toAdd, toRemove, audit };
}

module.exports = {
  RECONCILABLE_STATE_LABELS,
  isReconciliableStateLabel,
  reconcileStateLabels,
};

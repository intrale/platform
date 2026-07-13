'use strict';

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

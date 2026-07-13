'use strict';

const CLOSED_STATES = new Set(['CLOSED', 'DONE']);

function childKey(issue) {
  const n = Number(issue);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

function stateValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.toUpperCase();
  if (typeof raw === 'object') {
    if (typeof raw.state === 'string') return raw.state.toUpperCase();
    if (typeof raw.status === 'string') return raw.status.toUpperCase();
    if (Array.isArray(raw.labels) && raw.labels.map(String).includes('status:done')) return 'DONE';
  }
  return null;
}

function allChildrenDone({ children, issueStates } = {}) {
  if (!Array.isArray(children) || children.length === 0) return false;
  const states = issueStates && typeof issueStates === 'object' ? issueStates : {};
  for (const child of children) {
    const key = childKey(child);
    if (!key) return false;
    const st = stateValue(states[key]);
    if (!CLOSED_STATES.has(st)) return false;
  }
  return true;
}

module.exports = {
  allChildrenDone,
  CLOSED_STATES,
};

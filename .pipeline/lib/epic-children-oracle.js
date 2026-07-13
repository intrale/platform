'use strict';

const CLOSED_STATES = new Set(['CLOSED', 'DONE']);

// #4672 (security · OWASP A01) — Fail-closed por frescura del estado de hijos.
//
// La remoción de `needs-human` de un épico-paraguas NO puede confiar en estados
// de hijos leídos de un cache sin verificar su frescura: un cache stale podría
// afirmar "todos los hijos Done" y ABRIR el gate humano indebidamente (el issue
// #4661 quedó marcado como bloqueo cuando sus hijos ya estaban en main, pero el
// riesgo inverso —abrir el gate sobre datos viejos— es una vulnerabilidad).
//
// Por eso el oráculo exige que CADA entrada de estado de hijo sea:
//   1. un objeto con `fetchedAt` numérico y RECIENTE (<= maxAgeMs), y
//   2. un estado CLOSED/DONE verificable sobre esa entrada fresca.
//
// Si la frescura no es verificable (entrada que no es objeto, sin `fetchedAt`,
// o `fetchedAt` viejo) → FAIL-CLOSED: `allChildrenDone` devuelve false y el gate
// humano permanece cerrado. La frescura autoritativa la garantiza el llamador
// resolviendo estados live contra GitHub en la frontera del ciclo (reconcileOnce).
const DEFAULT_FRESHNESS_MS = 3600000; // 1h — alineado con el TTL del title-cache (#4099)

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

// Frescura verificable: la entrada debe ser un objeto con `fetchedAt` numérico
// positivo dentro de la ventana `maxAgeMs`. Strings crudas o entradas sin
// `fetchedAt` reciente NO son verificables → fail-closed.
function isFreshEntry(raw, now, maxAgeMs) {
  if (!raw || typeof raw !== 'object') return false;
  const fetchedAt = Number(raw.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const windowMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_FRESHNESS_MS;
  return (nowMs - fetchedAt) <= windowMs;
}

function allChildrenDone({ children, issueStates, now, maxAgeMs } = {}) {
  if (!Array.isArray(children) || children.length === 0) return false;
  const states = issueStates && typeof issueStates === 'object' ? issueStates : {};
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const windowMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_FRESHNESS_MS;
  for (const child of children) {
    const key = childKey(child);
    if (!key) return false;
    const entry = states[key];
    // Fail-closed (#4672): sin frescura verificable no afirmamos "Done".
    if (!isFreshEntry(entry, nowMs, windowMs)) return false;
    const st = stateValue(entry);
    if (!CLOSED_STATES.has(st)) return false;
  }
  return true;
}

module.exports = {
  allChildrenDone,
  isFreshEntry,
  CLOSED_STATES,
  DEFAULT_FRESHNESS_MS,
};

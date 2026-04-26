// Orden manual de issues en el Issue Tracker del dashboard.
//
// Sustituye al sistema de labels priority:critical/high/medium/low + feature_priority
// como fuente única de orden. El usuario mueve issues vía drag-drop o botones ▲/▼ en
// el dashboard; el orden se persiste acá y lo respetan tanto el render del dashboard
// como el sortByPriority del pulpo.
//
// Modelo: array ordenado de issue numbers (como strings). El index = position.
//   { "version": 1, "order": ["1952", "2510", "2521", ...] }
//
// Reglas:
//   - position 0 = más prioritario
//   - issue desconocido (no en el array) cuando se consulta orderOf → null
//     (consumidores deben tratarlo como "agregalo al final" o llamar insertNew)
//   - insertNew agrega al tope (position 0) — issues nuevos van arriba para que el
//     usuario los vea y decida qué hacer con ellos.
//
// Operaciones soportadas: load, save, orderOf, moveUp, moveDown, setOrder,
// insertNew, removeIssue.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const ORDER_FILE = path.join(PIPELINE_DIR, 'issue-manual-order.json');

const CURRENT_VERSION = 1;

function emptyState() {
    return { version: CURRENT_VERSION, order: [] };
}

function load(orderFile = ORDER_FILE) {
    try {
        const raw = fs.readFileSync(orderFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyState();
        const order = Array.isArray(parsed.order) ? parsed.order.map(String) : [];
        return { version: CURRENT_VERSION, order };
    } catch {
        return emptyState();
    }
}

function save(state, orderFile = ORDER_FILE) {
    try {
        const safe = {
            version: CURRENT_VERSION,
            order: Array.isArray(state.order) ? state.order.map(String) : [],
        };
        fs.writeFileSync(orderFile, JSON.stringify(safe, null, 2), 'utf8');
        return true;
    } catch { return false; }
}

function orderOf(state, issue) {
    const idx = state.order.indexOf(String(issue));
    return idx === -1 ? null : idx;
}

// Mueve un issue una posición hacia arriba (más prioritario). Si ya está en el tope
// o no existe, no-op.
function moveUp(state, issue, orderFile = ORDER_FILE) {
    const num = String(issue);
    const idx = state.order.indexOf(num);
    if (idx <= 0) return { ok: false, reason: idx === -1 ? 'not-found' : 'already-top' };
    [state.order[idx - 1], state.order[idx]] = [state.order[idx], state.order[idx - 1]];
    save(state, orderFile);
    return { ok: true, from: idx, to: idx - 1 };
}

// Mueve un issue una posición hacia abajo (menos prioritario). Si ya está en el fondo
// o no existe, no-op.
function moveDown(state, issue, orderFile = ORDER_FILE) {
    const num = String(issue);
    const idx = state.order.indexOf(num);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    if (idx >= state.order.length - 1) return { ok: false, reason: 'already-bottom' };
    [state.order[idx], state.order[idx + 1]] = [state.order[idx + 1], state.order[idx]];
    save(state, orderFile);
    return { ok: true, from: idx, to: idx + 1 };
}

// Intercambia las posiciones de dos issues en el array global. Útil cuando los
// botones ▲/▼ del dashboard operan a nivel de lane: el frontend determina el
// vecino visible en la columna (que puede no ser el vecino directo en el array
// global) y manda ambos issues acá.
function swap(state, issueA, issueB, orderFile = ORDER_FILE) {
    const a = String(issueA);
    const b = String(issueB);
    const ia = state.order.indexOf(a);
    const ib = state.order.indexOf(b);
    if (ia === -1 || ib === -1) return { ok: false, reason: 'not-found' };
    if (ia === ib) return { ok: false, reason: 'same-issue' };
    [state.order[ia], state.order[ib]] = [state.order[ib], state.order[ia]];
    save(state, orderFile);
    return { ok: true, from: ia, to: ib };
}

// Reemplaza la lista entera respetando el array recibido. Cualquier issue conocido
// que no aparezca en `newOrder` se preserva al final (no se pierden referencias).
function setOrder(state, newOrder, orderFile = ORDER_FILE) {
    const cleaned = (Array.isArray(newOrder) ? newOrder : []).map(String);
    const seen = new Set(cleaned);
    const tail = state.order.filter(n => !seen.has(n));
    state.order = cleaned.concat(tail);
    save(state, orderFile);
    return { ok: true };
}

// Inserta un issue nuevo al tope (position 0). Si ya existe, no-op.
function insertNew(state, issue, orderFile = ORDER_FILE) {
    const num = String(issue);
    if (state.order.includes(num)) return { ok: false, reason: 'already-exists' };
    state.order.unshift(num);
    save(state, orderFile);
    return { ok: true };
}

// Quita un issue del orden (típicamente cuando se cierra). Idempotente.
function removeIssue(state, issue, orderFile = ORDER_FILE) {
    const num = String(issue);
    const idx = state.order.indexOf(num);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    state.order.splice(idx, 1);
    save(state, orderFile);
    return { ok: true };
}

// Sincroniza el orden con la lista de issues conocidos:
//   - issues nuevos (en `currentIssues` pero no en state.order) → insertados al tope
//   - issues huérfanos (en state.order pero no en `currentIssues`) → preservados
//     (no se borran porque podrían volver a abrirse o ser de otra fase no visible)
// Devuelve la lista de issues recién insertados.
function syncWith(state, currentIssues, orderFile = ORDER_FILE) {
    const known = new Set(state.order);
    const incoming = (currentIssues || []).map(String);
    const newOnes = incoming.filter(n => !known.has(n));
    if (newOnes.length === 0) return { ok: true, added: [] };
    state.order = newOnes.concat(state.order);
    save(state, orderFile);
    return { ok: true, added: newOnes };
}

module.exports = {
    ORDER_FILE,
    CURRENT_VERSION,
    load,
    save,
    orderOf,
    moveUp,
    moveDown,
    swap,
    setOrder,
    insertNew,
    removeIssue,
    syncWith,
    _emptyState: emptyState,
};

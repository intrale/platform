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

// Reintentos de rename para Windows (EPERM/EBUSY cuando otro proceso —el Pulpo
// vía syncWith()— tiene el archivo abierto). Alineado con waves.js:49-50.
const RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_BACKOFF_MS = 50;

function emptyState() {
    return { version: CURRENT_VERSION, order: [] };
}

/**
 * Write atómico con fsync y reintentos en Windows (SEC-3 / CA-8, #4369).
 * Copia el patrón de waves.js::atomicWriteFile() para que el dashboard (reorder)
 * y el Pulpo (syncWith) no dejen `issue-manual-order.json` parcial/corrupto ante
 * escritura concurrente (TOCTOU). Escribe a tmp, fsync, y renombra atómicamente.
 */
function atomicWriteFile(targetPath, data) {
    const tmp = targetPath + '.tmp';
    let wroteTmp = false;
    try {
        fs.writeFileSync(tmp, data);
        wroteTmp = true;
        const fd = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

        let attempt = 0;
        let lastErr = null;
        while (attempt < RENAME_MAX_RETRIES) {
            try {
                fs.renameSync(tmp, targetPath);
                wroteTmp = false;
                return;
            } catch (err) {
                lastErr = err;
                const code = err && err.code;
                if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                    attempt++;
                    const deadline = Date.now() + RENAME_RETRY_BACKOFF_MS;
                    while (Date.now() < deadline) { /* spin defensivo */ }
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('rename agotó reintentos sin error específico');
    } finally {
        if (wroteTmp) {
            try { fs.unlinkSync(tmp); } catch {}
        }
    }
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
        // SEC-3/CA-8 (#4369): escritura atómica tmp+rename en vez de writeFileSync
        // plano, para no corromper el archivo ante escritura concurrente
        // dashboard↔Pulpo.
        atomicWriteFile(orderFile, JSON.stringify(safe, null, 2));
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

// Mueve un issue justo antes del anchor (splice sin swap). El resto del array
// preserva su orden relativo. Útil para "tope de columna" desde el dashboard:
// pasar como anchor el primer issue de la columna.
function moveBefore(state, issue, anchor, orderFile = ORDER_FILE) {
    const num = String(issue);
    const anc = String(anchor);
    if (num === anc) return { ok: false, reason: 'same-issue' };
    const fromIdx = state.order.indexOf(num);
    if (fromIdx === -1) return { ok: false, reason: 'not-found' };
    state.order.splice(fromIdx, 1);
    const ancIdx = state.order.indexOf(anc);
    if (ancIdx === -1) {
        state.order.splice(fromIdx, 0, num);
        return { ok: false, reason: 'anchor-not-found' };
    }
    state.order.splice(ancIdx, 0, num);
    save(state, orderFile);
    return { ok: true, from: fromIdx, to: ancIdx };
}

// Mueve un issue justo después del anchor (splice sin swap). Útil para "fondo
// de columna": pasar como anchor el último issue de la columna.
function moveAfter(state, issue, anchor, orderFile = ORDER_FILE) {
    const num = String(issue);
    const anc = String(anchor);
    if (num === anc) return { ok: false, reason: 'same-issue' };
    const fromIdx = state.order.indexOf(num);
    if (fromIdx === -1) return { ok: false, reason: 'not-found' };
    state.order.splice(fromIdx, 1);
    const ancIdx = state.order.indexOf(anc);
    if (ancIdx === -1) {
        state.order.splice(fromIdx, 0, num);
        return { ok: false, reason: 'anchor-not-found' };
    }
    state.order.splice(ancIdx + 1, 0, num);
    save(state, orderFile);
    return { ok: true, from: fromIdx, to: ancIdx + 1 };
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

// Reordena SOLO los issues del `subset` (típicamente los miembros de una ola)
// preservando la posición relativa del resto del `order[]` global (#4369, CA-4).
//
// A diferencia de setOrder() —que mueve el newOrder al frente y manda el resto al
// tail, alterando el orden relativo entre miembros y no-miembros— este helper
// reemplaza IN-PLACE únicamente las posiciones que hoy ocupan los miembros del
// subset, respetando el orden dado por `newOrder`. Los no-miembros no se mueven.
//
// Ejemplo:
//   order   = ["10", "20", "30", "40"]   (20 y 40 son de la ola)
//   subset  = ["20", "40"]
//   newOrder= ["40", "20"]
//   result  = ["10", "40", "30", "20"]   (10 y 30 quedan donde estaban)
//
// Miembros del subset presentes en newOrder pero aún no en order[] se agregan al
// final en su orden relativo (caso borde: issue de la ola sin entrada manual).
function reorderWithinSubset(state, subset, newOrder, orderFile = ORDER_FILE) {
    const sub = new Set((Array.isArray(subset) ? subset : []).map(String));
    const queue = (Array.isArray(newOrder) ? newOrder : [])
        .map(String)
        .filter(n => sub.has(n));
    let qi = 0;
    state.order = state.order.map(n => (sub.has(String(n)) ? queue[qi++] : n));
    // Miembros de la ola aún no presentes en order[] → append en su orden.
    for (; qi < queue.length; qi++) {
        if (!state.order.includes(queue[qi])) state.order.push(queue[qi]);
    }
    save(state, orderFile);
    return { ok: true };
}

// Valida que `order` sea una permutación EXACTA de la membresía de la ola
// (#4369, SEC-1/CA-5): todos numéricos, sin duplicados, todos ∈ membership, y el
// conjunto completo (no se agregan ni se pierden issues). Función pura (no toca
// el FS) para ser testeable y reusable por el handler del dashboard.
// Devuelve { ok: true } o { ok: false, reason }.
function validateWaveReorder(membership, order) {
    const mem = (Array.isArray(membership) ? membership : []).map(String);
    const memSet = new Set(mem);
    if (!Array.isArray(order)) return { ok: false, reason: 'order-not-array' };
    const ord = order.map(String);
    if (!ord.every(x => /^[0-9]+$/.test(x))) return { ok: false, reason: 'non-numeric' };
    if (new Set(ord).size !== ord.length) return { ok: false, reason: 'duplicates' };
    if (!ord.every(x => memSet.has(x))) return { ok: false, reason: 'not-in-wave' };
    if (ord.length !== mem.length) return { ok: false, reason: 'incomplete-set' };
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
    atomicWriteFile,
    orderOf,
    moveUp,
    moveDown,
    swap,
    moveBefore,
    moveAfter,
    setOrder,
    reorderWithinSubset,
    validateWaveReorder,
    insertNew,
    removeIssue,
    syncWith,
    _emptyState: emptyState,
};

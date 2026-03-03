// approval-history.js — Tracking de aprobaciones por patrón
// Cuenta cuántas veces se aprobó cada patrón de permiso.
// Después de N aprobaciones, el approver sugiere persistir la regla.

const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "approval-history.json");
const SUGGEST_THRESHOLD = 3; // sugerir persistencia después de N aprobaciones

function loadHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    } catch (e) {
        return { patterns: {} };
    }
}

function saveHistory(data) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
}

/**
 * Incrementar contador de aprobaciones para un patrón.
 * @param {string} pattern - Ej: "Bash(echo:*)", "Edit(/tmp/*.txt)"
 * @returns {{ count: number, shouldSuggest: boolean }} estado actual
 */
function incrementApproval(pattern) {
    if (!pattern) return { count: 0, shouldSuggest: false };
    const data = loadHistory();
    if (!data.patterns[pattern]) {
        data.patterns[pattern] = { count: 0, first: new Date().toISOString() };
    }
    data.patterns[pattern].count++;
    data.patterns[pattern].last = new Date().toISOString();
    const count = data.patterns[pattern].count;
    saveHistory(data);
    return {
        count,
        shouldSuggest: count === SUGGEST_THRESHOLD // solo en el umbral exacto
    };
}

/**
 * Obtener contador de aprobaciones de un patrón.
 * @param {string} pattern
 * @returns {number}
 */
function getApprovalCount(pattern) {
    if (!pattern) return 0;
    const data = loadHistory();
    return (data.patterns[pattern] && data.patterns[pattern].count) || 0;
}

/**
 * Marcar un patrón como persistido (ya no sugerir).
 * @param {string} pattern
 */
function markPersisted(pattern) {
    if (!pattern) return;
    const data = loadHistory();
    if (data.patterns[pattern]) {
        data.patterns[pattern].persisted = true;
        data.patterns[pattern].persisted_at = new Date().toISOString();
        saveHistory(data);
    }
}

/**
 * Verificar si un patrón ya fue persistido.
 * @param {string} pattern
 * @returns {boolean}
 */
function isPatternPersisted(pattern) {
    if (!pattern) return false;
    const data = loadHistory();
    return !!(data.patterns[pattern] && data.patterns[pattern].persisted);
}

module.exports = {
    incrementApproval,
    getApprovalCount,
    markPersisted,
    isPatternPersisted,
    SUGGEST_THRESHOLD
};

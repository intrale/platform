// commander/session-manager.js — Gestión de sesiones conversacionales
// Responsabilidad: crear, persistir, limpiar y verificar sesiones de Claude
"use strict";

const fs = require("fs");

// ─── Constantes ──────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos de inactividad

// ─── Estado ──────────────────────────────────────────────────────────────────
let _sessionStoreFile = null;
let _log = console.log;

function init(sessionStoreFile, logFn) {
    _sessionStoreFile = sessionStoreFile;
    if (logFn) _log = logFn;
}

// ─── Funciones de sesión ─────────────────────────────────────────────────────

function loadSession() {
    try {
        const data = JSON.parse(fs.readFileSync(_sessionStoreFile, "utf8"));
        if (!data.active_session) return null;
        return data.active_session;
    } catch (e) {
        return null;
    }
}

function saveSession(sessionId, skill) {
    const now = new Date().toISOString();
    const session = loadSession();
    const data = {
        active_session: {
            session_id: sessionId,
            last_used: now,
            skill: skill || (session && session.skill) || null,
            created_at: (session && session.session_id === sessionId && session.created_at) || now,
            source: "commander"
        }
    };
    try {
        fs.writeFileSync(_sessionStoreFile, JSON.stringify(data, null, 2), "utf8");
        _log("Sesión guardada: " + sessionId + " (skill: " + (data.active_session.skill || "none") + ")");
    } catch (e) {
        _log("Error guardando sesión: " + e.message);
    }
}

function clearSessionStore() {
    try {
        fs.writeFileSync(_sessionStoreFile, JSON.stringify({ active_session: null }, null, 2), "utf8");
        _log("Sesión limpiada");
    } catch (e) {
        _log("Error limpiando sesión: " + e.message);
    }
}

function isSessionExpired(session) {
    if (!session || !session.last_used) return true;
    const elapsed = Date.now() - new Date(session.last_used).getTime();
    return elapsed > SESSION_TTL_MS;
}

function getActiveSessionId() {
    const session = loadSession();
    if (!session || isSessionExpired(session)) return null;
    if (session.source !== "commander") {
        _log("Sesión " + session.session_id + " ignorada (source: " + (session.source || "unknown") + ", no es del commander)");
        clearSessionStore();
        return null;
    }
    return session.session_id;
}

module.exports = {
    init,
    SESSION_TTL_MS,
    loadSession,
    saveSession,
    clearSessionStore,
    isSessionExpired,
    getActiveSessionId,
};

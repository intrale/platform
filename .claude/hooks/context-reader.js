// context-reader.js — Módulo compartido para leer contexto de sesión
// Exporta: readSessionContext(sessionId, repoRoot)
// Pure Node.js — sin dependencia de bash

const fs = require("fs");
const path = require("path");

/**
 * Lee el contexto completo de la sesión activa.
 *
 * @param {string} sessionId  UUID completo o short-id (8 chars) de la sesión
 * @param {string} repoRoot   Ruta raíz del repositorio (MAIN_REPO_ROOT)
 * @returns {{ task: string|null, skill: string|null, branch: string|null, agentName: string|null, skillsInvoked: string[] }}
 *          Retorna {} si falla la lectura (sesión no creada aún, etc.)
 */
function readSessionContext(sessionId, repoRoot) {
    const result = {
        task: null,
        skill: null,
        branch: null,
        agentName: null,
        skillsInvoked: []
    };

    // 1. Leer archivo de sesión
    if (sessionId) {
        try {
            const shortId = sessionId.substring(0, 8);
            const sessionsDir = path.join(repoRoot, ".claude", "sessions");
            const sessionFile = path.join(sessionsDir, shortId + ".json");
            const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));

            // Branch del worktree donde corre el agente
            if (session.branch) result.branch = session.branch;

            // Nombre del agente
            if (session.agent_name) result.agentName = session.agent_name;

            // Skills invocados
            if (Array.isArray(session.skills_invoked)) result.skillsInvoked = session.skills_invoked;

            // Tarea activa: preferir current_task (activeForm) si existe
            if (session.current_task) {
                result.task = session.current_task;
            } else if (Array.isArray(session.current_tasks) && session.current_tasks.length > 0) {
                // Buscar primera tarea in_progress
                const inProgress = session.current_tasks.find(t => t.status === "in_progress");
                if (inProgress) {
                    result.task = inProgress.subject;
                } else {
                    // Última tarea como fallback
                    const last = session.current_tasks[session.current_tasks.length - 1];
                    if (last && last.subject) result.task = last.subject;
                }
            }
        } catch(e) {
            // Sesión nueva o no encontrada — continuar sin datos de sesión
        }
    }

    // 2. Leer skill activo desde tg-session-store.json
    try {
        const storeFile = path.join(repoRoot, ".claude", "hooks", "tg-session-store.json");
        const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
        const activeSession = data.active_session;
        if (activeSession && activeSession.skill) {
            // Verificar que la sesión no esté expirada (30 min)
            const elapsed = Date.now() - new Date(activeSession.last_used).getTime();
            if (elapsed <= 30 * 60 * 1000) {
                result.skill = activeSession.skill;
            }
        }
    } catch(e) {
        // Sin store activo
    }

    return result;
}

module.exports = { readSessionContext };

// validation-utils.js — Validación centralizada de completación de agentes (#1458)
// Módulo compartido que centraliza buildCompletedEntry y la lógica de validación
// antes de marcar un agente como completado (evita falsos positivos en cascada).
"use strict";

const { execSync } = require("child_process");

// ─── Constante compartida ─────────────────────────────────────────────────────

/** Duración mínima en minutos que debe haber trabajado un agente para ser válido */
const MIN_DURATION_MINUTES = 2;

// ─── Helpers internos ─────────────────────────────────────────────────────────

const GH_CLI_CANDIDATES = [
    "C:\\Workspaces\\gh-cli\\bin\\gh.exe",
    "/c/Workspaces/gh-cli/bin/gh.exe",
    "gh"
];

function findGhCli() {
    for (const candidate of GH_CLI_CANDIDATES) {
        try {
            execSync('"' + candidate + '" --version', { encoding: "utf8", timeout: 3000, windowsHide: true });
            return candidate;
        } catch (e) {}
    }
    return null;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Verifica si una rama tiene commits propios (no presentes en origin/main).
 * @returns {boolean|null} true = tiene commits, false = no tiene, null = no determinable
 */
function checkBranchHasOwnCommits(branch, repoRoot) {
    const cwd = repoRoot || process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    for (const ref of ["origin/" + branch, branch]) {
        try {
            const out = execSync(
                "git log origin/main.." + ref + " --oneline",
                { encoding: "utf8", timeout: 10000, windowsHide: true, cwd, stdio: ["pipe", "pipe", "ignore"] }
            );
            return out.trim().length > 0;
        } catch (e) {}
    }
    return null; // no se pudo determinar
}

/**
 * Verifica el estado de la PR para una rama usando gh CLI.
 * @returns {{ status: "merged"|"open"|"closed_no_merge"|"none"|"unknown", prs?: any[] }}
 */
function checkPRStatusViaGh(branch) {
    const ghCmd = findGhCli();
    if (!ghCmd) return { status: "unknown" };
    try {
        const cmd = '"' + ghCmd + '" pr list --repo intrale/platform --head "' + branch + '" --state all --json number,state';
        const output = execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true });
        const prs = JSON.parse(output || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return { status: "none", prs: [] };
        if (prs.find(pr => pr.state === "MERGED")) return { status: "merged", prs };
        if (prs.find(pr => pr.state === "OPEN"))   return { status: "open", prs };
        return { status: "closed_no_merge", prs };
    } catch (e) {
        return { status: "unknown" };
    }
}

/**
 * Construye el objeto de entrada para _completed o _incomplete.
 * Calcula duracion_min a partir de:
 *   1. session.started_ts + session.last_activity_ts (si session disponible)
 *   2. agente.started_at + now (fallback si el agente tiene timestamp de inicio)
 *   3. 0 (si no hay información)
 */
function buildCompletedEntry(agente, session, resultado) {
    let duracion_min = 0;
    if (!resultado) resultado = session ? "ok" : "not_planned";

    if (session) {
        const started = session.started_ts || 0;
        const last = session.last_activity_ts || 0;
        if (started && last && last > started) {
            duracion_min = Math.round((last - started) / 60000);
        }
    } else if (agente && agente.started_at) {
        const started = new Date(agente.started_at).getTime();
        const now = Date.now();
        if (started && now > started) {
            duracion_min = Math.round((now - started) / 60000);
        }
    }

    return {
        issue: agente.issue,
        slug: agente.slug,
        titulo: agente.titulo || "",
        numero: agente.numero,
        stream: agente.stream || "",
        size: agente.size || "",
        resultado: resultado,
        duracion_min: duracion_min,
        issue_reabierto: null,
        completado_at: new Date().toISOString()
    };
}

/**
 * Valida los criterios de completación antes de mover un agente a _completed.
 * Verifica al menos 2 de 3 criterios:
 *   1. Duración mínima (>= MIN_DURATION_MINUTES)
 *   2. PR mergeada
 *   3. Rama con commits propios (no solo merge de main)
 *
 * @param {number} duracion_min - Duración calculada en minutos
 * @param {object} prStatus - { status: "merged" | "open" | "none" | ... }
 * @param {string} [branch] - Nombre de la rama (para verificar commits)
 * @param {string} [repoRoot] - Directorio raíz del repo
 * @returns {{ valid: boolean, suspicious: boolean, reason: string, criteria: string[], failedCriteria: string[] }}
 */
function validateCompletionCriteria(duracion_min, prStatus, branch, repoRoot) {
    const criteria = [];
    const failedCriteria = [];

    // Criterio 1: Duración mínima
    if (duracion_min >= MIN_DURATION_MINUTES) {
        criteria.push("duration");
    } else {
        failedCriteria.push("duración insuficiente (" + duracion_min + " min < " + MIN_DURATION_MINUTES + " min)");
    }

    // Criterio 2: PR mergeada
    if (prStatus && prStatus.status === "merged") {
        criteria.push("pr_merged");
    } else {
        const prDesc = prStatus ? prStatus.status : "unknown";
        failedCriteria.push("PR no mergeada (status=" + prDesc + ")");
    }

    // Criterio 3: Rama con commits propios (solo si tenemos branch)
    if (branch) {
        const hasCommits = checkBranchHasOwnCommits(branch, repoRoot);
        if (hasCommits === true) {
            criteria.push("own_commits");
        } else if (hasCommits === false) {
            failedCriteria.push("rama sin commits propios");
        }
        // null = no determinable → no suma ni resta
    }

    const valid = criteria.length >= 2;
    return {
        valid,
        suspicious: !valid,
        reason: failedCriteria.length > 0 ? failedCriteria.join("; ") : "OK",
        criteria,
        failedCriteria
    };
}

module.exports = {
    MIN_DURATION_MINUTES,
    buildCompletedEntry,
    validateCompletionCriteria,
    checkPRStatusViaGh,
    checkBranchHasOwnCommits
};

#!/usr/bin/env node
// execution-report.js — Módulo reutilizable para resúmenes de sesión
// Exporta buildExecutionSummary(sessionId, repoRoot) → objeto con datos del mini-reporte
// Usado desde stop-notify.js (individual) y sprint-report.js (por agente)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const GH_PATH = "/c/Workspaces/gh-cli/bin/gh.exe";

/**
 * Ejecuta un comando shell y retorna stdout (trimmed). Retorna null si falla.
 */
function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 15000, ...opts }).trim();
    } catch (e) {
        return null;
    }
}

/**
 * Lee un JSON file de forma segura.
 */
function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        return null;
    }
}

/**
 * Extrae el issue number desde un nombre de rama.
 * "agent/1177-ops-skill" → 1177
 */
function extractIssueFromBranch(branch) {
    if (!branch) return null;
    const m = branch.match(/(?:agent|feature|bugfix)\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Cuenta herramientas usadas en activity-log.jsonl filtrando por sessionId.
 * Retorna { total, byTool: { Bash: N, Edit: N, ... }, topTools: "Bash(5), Edit(3)" }
 */
function countToolsFromActivityLog(activityLogPath, sessionId) {
    const result = { total: 0, byTool: {}, topTools: "" };
    try {
        if (!fs.existsSync(activityLogPath)) return result;
        const lines = fs.readFileSync(activityLogPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (sessionId && entry.session !== sessionId) continue;
                const tool = entry.tool || "unknown";
                result.byTool[tool] = (result.byTool[tool] || 0) + 1;
                result.total++;
            } catch (e) { /* skip malformed lines */ }
        }
        // Top tools (top 3)
        const sorted = Object.entries(result.byTool).sort((a, b) => b[1] - a[1]).slice(0, 3);
        result.topTools = sorted.map(([t, n]) => `${t}(${n})`).join(", ");
    } catch (e) { /* ignore */ }
    return result;
}

/**
 * Busca el PR asociado a una rama via gh CLI.
 * Retorna { number, title, state, url } o null.
 */
function findPRForBranch(branch, repoRoot) {
    if (!branch) return null;
    const raw = execSafe(
        `"${GH_PATH}" pr list --head "${branch}" --json number,title,state,url --limit 1 --repo intrale/platform`,
        { cwd: repoRoot }
    );
    if (!raw) return null;
    try {
        const prs = JSON.parse(raw);
        return prs.length > 0 ? prs[0] : null;
    } catch (e) { return null; }
}

/**
 * Obtiene título de un issue via gh CLI.
 */
function getIssueTitle(issueNumber, repoRoot) {
    if (!issueNumber) return null;
    const raw = execSafe(
        `"${GH_PATH}" issue view ${issueNumber} --json title --jq .title --repo intrale/platform`,
        { cwd: repoRoot }
    );
    return raw || null;
}

/**
 * Calcula la duración en minutos entre dos timestamps ISO.
 */
function durationMinutes(startTs, endTs) {
    try {
        const start = new Date(startTs).getTime();
        const end = endTs ? new Date(endTs).getTime() : Date.now();
        return Math.round((end - start) / 60000);
    } catch (e) { return 0; }
}

/**
 * Construye el resumen de ejecución para una sesión.
 * @param {string} sessionId - ID corto de la sesión (8 chars)
 * @param {string} repoRoot - Ruta raíz del repo
 * @returns {object} Resumen con todos los datos del mini-reporte
 */
function buildExecutionSummary(sessionId, repoRoot) {
    repoRoot = repoRoot || process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";

    const sessionsDir = path.join(repoRoot, ".claude", "sessions");
    const activityLog = path.join(repoRoot, ".claude", "activity-log.jsonl");

    // Leer session file
    const sessionFile = path.join(sessionsDir, sessionId + ".json");
    const session = readJsonSafe(sessionFile);

    if (!session) {
        return {
            sessionId,
            found: false,
            agentName: "Desconocido",
            branch: null,
            issueNumber: null,
            issueTitle: null,
            tasksCompleted: 0,
            tasksTotal: 0,
            actionCount: 0,
            toolsSummary: "",
            topTools: "",
            pr: null,
            durationMin: 0,
            startedTs: null,
            endedTs: null,
            skillsInvoked: [],
            status: "unknown"
        };
    }

    const branch = session.branch || null;
    const issueNumber = extractIssueFromBranch(branch);
    const issueTitle = getIssueTitle(issueNumber, repoRoot);

    // Tareas
    const tasks = session.current_tasks || [];
    const tasksCompleted = tasks.filter(t => t.status === "completed").length;
    const tasksTotal = tasks.length;

    // Herramientas desde activity log
    const tools = countToolsFromActivityLog(activityLog, sessionId);

    // PR asociado
    const pr = findPRForBranch(branch, repoRoot);

    // Duración
    const durationMin = durationMinutes(session.started_ts, session.last_activity_ts);

    // Nombre del agente
    const agentName = session.agent_name
        || (session.skills_invoked && session.skills_invoked.length > 0
            ? session.skills_invoked.join(", ")
            : "Ad-hoc");

    return {
        sessionId,
        found: true,
        agentName,
        branch,
        issueNumber,
        issueTitle,
        tasksCompleted,
        tasksTotal,
        actionCount: session.action_count || tools.total,
        toolsSummary: tools.topTools,
        topTools: tools.topTools,
        byTool: tools.byTool,
        pr,
        durationMin,
        startedTs: session.started_ts,
        endedTs: session.last_activity_ts,
        skillsInvoked: session.skills_invoked || [],
        status: session.status || "unknown"
    };
}

/**
 * Formatea el resumen como mensaje HTML para Telegram.
 */
function formatTelegramHtml(summary) {
    const lines = [];
    lines.push("🤖 <b>Ejecución finalizada</b>");
    lines.push("");
    lines.push(`🎯 <b>Agente:</b> ${escapeHtml(summary.agentName)}`);

    if (summary.issueNumber) {
        const title = summary.issueTitle ? ` — ${escapeHtml(summary.issueTitle)}` : "";
        lines.push(`🔖 <b>Issue:</b> #${summary.issueNumber}${title}`);
    }

    if (summary.tasksTotal > 0) {
        lines.push(`✅ <b>Tareas:</b> ${summary.tasksCompleted}/${summary.tasksTotal}`);
    }

    lines.push(`🛠 <b>Herramientas:</b> ${summary.actionCount} acciones${summary.topTools ? ` (${escapeHtml(summary.topTools)})` : ""}`);

    if (summary.branch) {
        lines.push(`🌿 <b>Rama:</b> ${escapeHtml(summary.branch)}`);
    }

    if (summary.pr) {
        const stateEmoji = summary.pr.state === "MERGED" ? "🟣" : summary.pr.state === "OPEN" ? "🟢" : "🔴";
        lines.push(`🔗 <b>PR:</b> #${summary.pr.number} ${escapeHtml(summary.pr.title)} [${stateEmoji} ${summary.pr.state}]`);
    }

    lines.push(`⏱ <b>Duración:</b> ${summary.durationMin} min`);

    return lines.join("\n");
}

function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
    buildExecutionSummary,
    formatTelegramHtml,
    extractIssueFromBranch,
    countToolsFromActivityLog,
    findPRForBranch,
    getIssueTitle,
    durationMinutes,
    escapeHtml
};

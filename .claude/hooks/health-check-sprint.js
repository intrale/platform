// health-check-sprint.js — Auditoría de salud del sprint actual
// Lee sprint-plan.json, verifica estado de issues en GitHub y detecta inconsistencias:
//   - PR mergeado pero issue abierto
//   - Historias en "In Progress" > 6h sin actividad (estancadas)
//   - Sprint pasada fechaFin sin cerrar
//   - PRs abiertos hace más de 24h sin merge
// Salida: JSON con diagnóstico detallado

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const ACTIVITY_LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const PROCESS_REGISTRY_FILE = path.join(HOOKS_DIR, "process-registry.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";

// Umbrales de detección
const STALE_IN_PROGRESS_HOURS = 6;   // Historias "In Progress" sin actividad > 6h → estancada
const STALE_PR_HOURS = 24;           // PRs abiertos sin merge > 24h → alertar
const SPRINT_OVERDUE_DAYS = 2;       // Sprint pasada fechaFin por > 2 días → cerrar

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] SprintHealthCheck: " + msg + "\n");
    } catch (e) {}
}

function readSprintPlan() {
    try {
        if (!fs.existsSync(SPRINT_PLAN_FILE)) return null;
        return JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
    } catch (e) {
        log("Error leyendo sprint-plan.json: " + e.message);
        return null;
    }
}

function getGitHubToken() {
    try {
        const token = execSync(GH_CLI + " auth token", {
            encoding: "utf8",
            cwd: REPO_ROOT,
            timeout: 5000,
            windowsHide: true
        }).trim();
        if (token) return token;
    } catch (e) {}
    const credInput = "protocol=https\nhost=github.com\n\n";
    const result = execSync("git credential fill", {
        input: credInput,
        encoding: "utf8",
        cwd: REPO_ROOT,
        timeout: 5000,
        windowsHide: true
    });
    const match = result.match(/password=(.+)/);
    if (!match) throw new Error("No se encontro token GitHub");
    return match[1].trim();
}

function graphqlRequest(token, query, variables) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ query, variables: variables || {} });
        const req = https.request({
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Authorization": "bearer " + token,
                "User-Agent": "intrale-sprint-health"
            },
            timeout: 10000
        }, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.errors && parsed.errors.length > 0) {
                        reject(new Error(parsed.errors[0].message));
                    } else {
                        resolve(parsed.data);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout graphql")); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// Obtener detalles de un issue: estado, PR asociado, estado en Project V2
async function getIssueDetails(token, issueNumber) {
    const query = `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
            issue(number:$number){
                number
                title
                state
                closedAt
                updatedAt
                labels(first:20){ nodes{ name } }
                assignees(first:5){ nodes{ login } }
                projectItems(first:5){
                    nodes{
                        id
                        project{ id }
                        fieldValues(first:10){
                            nodes{
                                ... on ProjectV2ItemFieldSingleSelectValue{
                                    name
                                    field{ ... on ProjectV2SingleSelectField{ name } }
                                }
                            }
                        }
                    }
                }
                timelineItems(first:20 itemTypes:[CONNECTED_EVENT,CROSS_REFERENCED_EVENT]){
                    nodes{
                        ... on ConnectedEvent{
                            subject{
                                ... on PullRequest{
                                    number
                                    state
                                    mergedAt
                                    createdAt
                                    title
                                    headRefName
                                }
                            }
                        }
                    }
                }
            }
        }
    }`;

    try {
        const data = await graphqlRequest(token, query, {
            owner: "intrale",
            repo: "platform",
            number: issueNumber
        });
        return data && data.repository && data.repository.issue;
    } catch (e) {
        log("Error obteniendo issue #" + issueNumber + ": " + e.message);
        return null;
    }
}

// Buscar PRs que referencian un issue por su número en el título o cuerpo
async function findPRsForIssue(token, issueNumber) {
    // Usar la búsqueda de GitHub para encontrar PRs que cierran este issue
    const query = `query($searchQuery:String!){
        search(query:$searchQuery type:ISSUE first:10){
            nodes{
                ... on PullRequest{
                    number
                    title
                    state
                    mergedAt
                    createdAt
                    headRefName
                    body
                }
            }
        }
    }`;

    try {
        const searchQuery = `repo:intrale/platform is:pr ${issueNumber} in:body`;
        const data = await graphqlRequest(token, query, { searchQuery });
        const nodes = data && data.search && data.search.nodes || [];
        // Filtrar PRs que mencionan closes/fixes/resolves #N o en el nombre de rama agent/N-
        return nodes.filter(pr => {
            if (!pr || !pr.number) return false;
            const body = (pr.body || "").toLowerCase();
            const branchName = (pr.headRefName || "").toLowerCase();
            const issueRef = "#" + issueNumber;
            return body.includes("closes " + issueRef) ||
                   body.includes("fixes " + issueRef) ||
                   body.includes("resolves " + issueRef) ||
                   body.includes("close " + issueRef) ||
                   branchName.includes("agent/" + issueNumber + "-") ||
                   branchName.includes("agent/" + issueNumber + "_");
        });
    } catch (e) {
        log("Error buscando PRs para issue #" + issueNumber + ": " + e.message);
        return [];
    }
}

// Extraer estado del Project V2 del item
function extractProjectStatus(issue) {
    const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
    if (!issue || !issue.projectItems || !issue.projectItems.nodes) return null;
    const item = issue.projectItems.nodes.find(n => n.project && n.project.id === PROJECT_ID);
    if (!item || !item.fieldValues || !item.fieldValues.nodes) return null;
    const statusField = item.fieldValues.nodes.find(fv =>
        fv && fv.field && fv.field.name === "Status"
    );
    return statusField ? statusField.name : null;
}

// Verificar actividad reciente de un issue en activity-log.jsonl
function getLastActivityForIssue(issueNumber) {
    try {
        if (!fs.existsSync(ACTIVITY_LOG_FILE)) return null;
        const lines = fs.readFileSync(ACTIVITY_LOG_FILE, "utf8").split("\n").filter(Boolean);
        // Buscar en las últimas 500 líneas
        const recentLines = lines.slice(-500);
        let lastActivity = null;
        for (const line of recentLines) {
            try {
                const entry = JSON.parse(line);
                const branch = entry.branch || "";
                // Rama agent/<number>- o agent/<number>_
                if (branch.match(new RegExp("agent/" + issueNumber + "[_-]"))) {
                    const ts = entry.timestamp || entry.ts;
                    if (ts && (!lastActivity || ts > lastActivity)) {
                        lastActivity = ts;
                    }
                }
            } catch (e) {}
        }
        return lastActivity;
    } catch (e) {
        return null;
    }
}

// Verificar si hay un agente activo para un issue
function hasActiveAgent(issueNumber) {
    try {
        if (!fs.existsSync(PROCESS_REGISTRY_FILE)) return false;
        const registry = JSON.parse(fs.readFileSync(PROCESS_REGISTRY_FILE, "utf8"));
        for (const [pid, entry] of Object.entries(registry)) {
            const role = entry.role || "";
            const cwd = entry.cwd || "";
            if (role === "commander") continue; // no es un agente de issue
            // Buscar por CWD que contenga el número del issue
            if (cwd.includes("agent-" + issueNumber + "-") || cwd.includes("agent-" + issueNumber + "_")) {
                // Verificar que el proceso esté vivo
                try {
                    process.kill(parseInt(pid), 0);
                    return true;
                } catch (e) {}
            }
        }
        // Verificar worktrees activos
        const parentDir = path.resolve(REPO_ROOT, "..");
        const repoName = path.basename(REPO_ROOT);
        if (fs.existsSync(parentDir)) {
            const entries = fs.readdirSync(parentDir);
            for (const entry of entries) {
                if (entry.startsWith(repoName + ".agent-" + issueNumber + "-") ||
                    entry.startsWith(repoName + ".agent-" + issueNumber + "_")) {
                    return true;
                }
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Diagnóstico principal
async function runHealthCheck() {
    const sprintPlan = readSprintPlan();
    if (!sprintPlan) {
        return {
            ok: false,
            error: "No se encontró sprint-plan.json",
            timestamp: new Date().toISOString(),
            issues: [],
            inconsistencias: [],
            sprint_status: "unknown"
        };
    }

    log("Iniciando health check del sprint " + sprintPlan.sprint_id);

    const now = new Date();
    const inconsistencias = [];
    const issuesDiagnosis = [];

    // Obtener todos los issues del sprint (agentes activos + completados + cola)
    const allIssues = [
        ...(sprintPlan.agentes || []),
        ...(sprintPlan._queue || []),
        ...(sprintPlan._completed || [])
    ].filter(a => a.issue);

    let token;
    try {
        token = getGitHubToken();
    } catch (e) {
        return {
            ok: false,
            error: "No se pudo obtener token GitHub: " + e.message,
            timestamp: new Date().toISOString(),
            issues: [],
            inconsistencias: [],
            sprint_status: "unknown"
        };
    }

    // Procesar cada issue del sprint
    for (const agentEntry of allIssues) {
        const issueNumber = agentEntry.issue;
        const isCompleted = !!agentEntry.merged_at;

        const issueDetails = await getIssueDetails(token, issueNumber);
        if (!issueDetails) {
            log("No se pudieron obtener detalles del issue #" + issueNumber);
            continue;
        }

        const projectStatus = extractProjectStatus(issueDetails);
        const issueState = issueDetails.state; // OPEN / CLOSED
        const labels = (issueDetails.labels && issueDetails.labels.nodes || []).map(l => l.name);
        const lastActivity = getLastActivityForIssue(issueNumber);
        const hasAgent = hasActiveAgent(issueNumber);

        // Buscar PRs asociados
        const prs = await findPRsForIssue(token, issueNumber);
        const mergedPR = prs.find(pr => pr.state === "MERGED" || pr.mergedAt);
        const openPR = prs.find(pr => pr.state === "OPEN" && !pr.mergedAt);

        const issueDiag = {
            issue: issueNumber,
            title: issueDetails.title,
            github_state: issueState,
            project_status: projectStatus,
            labels,
            has_active_agent: hasAgent,
            last_activity: lastActivity,
            merged_pr: mergedPR ? { number: mergedPR.number, mergedAt: mergedPR.mergedAt } : null,
            open_pr: openPR ? { number: openPR.number, createdAt: openPR.createdAt } : null,
            inconsistencias: []
        };

        // ─── Detección 1: PR mergeado pero issue abierto ───────────────────────
        if (mergedPR && issueState === "OPEN") {
            const inc = {
                type: "pr_merged_issue_open",
                severity: "high",
                issue: issueNumber,
                pr: mergedPR.number,
                merged_at: mergedPR.mergedAt,
                message: `PR #${mergedPR.number} mergeado (${mergedPR.mergedAt}) pero issue #${issueNumber} sigue abierto`,
                action: "close_issue_and_move_to_done"
            };
            inconsistencias.push(inc);
            issueDiag.inconsistencias.push(inc);
            log("Inconsistencia: " + inc.message);
        }

        // ─── Detección 2: Historia en "In Progress" > 6h sin actividad ────────
        if (projectStatus === "In Progress" && issueState === "OPEN") {
            const activityTs = lastActivity ? new Date(lastActivity) : null;
            const updatedAt = issueDetails.updatedAt ? new Date(issueDetails.updatedAt) : null;
            const referenceTime = activityTs || updatedAt;

            if (referenceTime) {
                const hoursSinceActivity = (now - referenceTime) / (1000 * 60 * 60);
                if (!hasAgent && hoursSinceActivity > STALE_IN_PROGRESS_HOURS) {
                    const severity = hoursSinceActivity > 24 ? "critical" : "medium";
                    const action = hoursSinceActivity > 24 ? "move_to_ready" : "move_to_blocked";
                    const inc = {
                        type: "stale_in_progress",
                        severity,
                        issue: issueNumber,
                        hours_stale: Math.round(hoursSinceActivity),
                        last_activity: referenceTime.toISOString(),
                        has_active_agent: hasAgent,
                        message: `Issue #${issueNumber} en "In Progress" hace ${Math.round(hoursSinceActivity)}h sin agente activo`,
                        action
                    };
                    inconsistencias.push(inc);
                    issueDiag.inconsistencias.push(inc);
                    log("Inconsistencia: " + inc.message);
                }
            }
        }

        // ─── Detección 3: PR abierto > 24h sin merge ──────────────────────────
        if (openPR) {
            const prAge = (now - new Date(openPR.createdAt)) / (1000 * 60 * 60);
            if (prAge > STALE_PR_HOURS) {
                const inc = {
                    type: "pr_open_stale",
                    severity: "medium",
                    issue: issueNumber,
                    pr: openPR.number,
                    hours_open: Math.round(prAge),
                    created_at: openPR.createdAt,
                    message: `PR #${openPR.number} del issue #${issueNumber} lleva ${Math.round(prAge)}h abierto sin merge`,
                    action: "notify_review_pending"
                };
                inconsistencias.push(inc);
                issueDiag.inconsistencias.push(inc);
                log("Inconsistencia: " + inc.message);
            }
        }

        // ─── Detección 4: Issue Done/cerrado pero status no es Done en Project ─
        if (issueState === "CLOSED" && projectStatus && projectStatus !== "Done" && projectStatus !== "QA Pending") {
            const inc = {
                type: "closed_issue_wrong_status",
                severity: "high",
                issue: issueNumber,
                current_status: projectStatus,
                message: `Issue #${issueNumber} cerrado en GitHub pero en Project V2 está "${projectStatus}"`,
                action: "move_to_done"
            };
            inconsistencias.push(inc);
            issueDiag.inconsistencias.push(inc);
            log("Inconsistencia: " + inc.message);
        }

        issuesDiagnosis.push(issueDiag);
    }

    // ─── Detección 5: Sprint pasada fechaFin sin cerrar ───────────────────────
    let sprintStatus = "active";
    let sprintOverdue = null;
    if (sprintPlan.fechaFin && !sprintPlan.sprint_cerrado) {
        const fechaFin = new Date(sprintPlan.fechaFin + "T23:59:59Z");
        const daysOverdue = (now - fechaFin) / (1000 * 60 * 60 * 24);
        if (daysOverdue > 0) {
            sprintStatus = daysOverdue > SPRINT_OVERDUE_DAYS ? "overdue_critical" : "overdue";
            sprintOverdue = {
                type: "sprint_overdue",
                severity: daysOverdue > SPRINT_OVERDUE_DAYS ? "critical" : "medium",
                days_overdue: Math.round(daysOverdue),
                fecha_fin: sprintPlan.fechaFin,
                message: `Sprint ${sprintPlan.sprint_id} venció hace ${Math.round(daysOverdue)} día(s) sin cerrar`,
                action: daysOverdue > SPRINT_OVERDUE_DAYS ? "close_sprint" : "alert_sprint_overdue"
            };
            inconsistencias.push(sprintOverdue);
            log("Inconsistencia: " + sprintOverdue.message);
        }
    } else if (sprintPlan.sprint_cerrado) {
        sprintStatus = "closed";
    }

    // ─── Calcular métricas de progreso ────────────────────────────────────────
    const totalIssues = allIssues.length;
    const completedIssues = issuesDiagnosis.filter(d => d.github_state === "CLOSED").length;
    const inProgressIssues = issuesDiagnosis.filter(d => d.project_status === "In Progress").length;
    const blockedIssues = issuesDiagnosis.filter(d => d.project_status === "Blocked").length;
    const criticalInconsistencias = inconsistencias.filter(i => i.severity === "critical" || i.severity === "high").length;

    const healthLevel =
        criticalInconsistencias > 3 ? "critical" :
        criticalInconsistencias > 0 || inconsistencias.length > 3 ? "warning" :
        "healthy";

    const result = {
        ok: inconsistencias.length === 0,
        timestamp: now.toISOString(),
        sprint_id: sprintPlan.sprint_id,
        sprint_status: sprintStatus,
        sprint_overdue: sprintOverdue,
        health_level: healthLevel,
        metrics: {
            total_issues: totalIssues,
            completed: completedIssues,
            in_progress: inProgressIssues,
            blocked: blockedIssues,
            inconsistencias_total: inconsistencias.length,
            inconsistencias_critical: criticalInconsistencias
        },
        issues: issuesDiagnosis,
        inconsistencias
    };

    log("Health check completado: " + inconsistencias.length + " inconsistencia(s), nivel: " + healthLevel);
    return result;
}

// CLI: ejecutar y mostrar resultado si se llama directamente
if (require.main === module) {
    runHealthCheck().then(result => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    }).catch(e => {
        console.error(JSON.stringify({ ok: false, error: e.message }));
        process.exit(1);
    });
}

module.exports = { runHealthCheck };

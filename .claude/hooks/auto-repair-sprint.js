// auto-repair-sprint.js — Auto-reparación de inconsistencias del sprint
// Dado un diagnóstico de health-check-sprint.js, ejecuta reparaciones automáticas:
//   - PR mergeado + issue abierto → cerrar issue + mover a Done
//   - Historia "In Progress" > 6h sin agente → Blocked
//   - Historia "In Progress" > 24h sin agente → Ready
//   - Sprint vencida > 2 días → cerrar sprint
// Registra cada acción en sprint-audit.jsonl

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const AUDIT_FILE = path.join(HOOKS_DIR, "sprint-audit.jsonl");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
// Intentar paths en orden: Windows nativo → MSYS2 → gh en PATH
const GH_CLI_CANDIDATES = [
    "C:/Workspaces/gh-cli/bin/gh.exe",
    "/c/Workspaces/gh-cli/bin/gh.exe",
    "gh"
];
// Path resuelto en runtime para uso directo en exec
let GH_CLI = "gh"; // default, se sobreescribe en getGitHubToken()

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";
const STATUS_OPTIONS = {
    "Done": "b30e67ed",
    "In Progress": "29e2553a",
    "Ready": "6bec465d",
    "Blocked": "487cf163",
    "QA Pending": "dcd0a053",
    "Todo": "ec963918"
};

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] AutoRepairSprint: " + msg + "\n");
    } catch (e) {}
}

function appendAudit(entry) {
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify({
            timestamp: new Date().toISOString(),
            ...entry
        }) + "\n");
    } catch (e) {
        log("Error escribiendo audit log: " + e.message);
    }
}

function getGitHubToken() {
    // Probar cada path de gh CLI — el primero que devuelva un token gana
    for (const ghPath of GH_CLI_CANDIDATES) {
        try {
            const token = execSync(ghPath + " auth token", {
                encoding: "utf8",
                cwd: REPO_ROOT,
                timeout: 5000,
                windowsHide: true
            }).trim();
            if (token) {
                GH_CLI = ghPath; // persistir el path que funcionó
                log("Token obtenido via " + ghPath);
                return token;
            }
        } catch (e) {
            log("gh auth token falló con " + ghPath + ": " + e.message.split("\n")[0]);
        }
    }
    // Fallback: git credential fill (puede no tener scope read:project)
    log("Usando git credential fill como fallback (scope limitado)");
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
                "User-Agent": "intrale-auto-repair"
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

async function getProjectItemId(token, issueNumber) {
    const query = `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
            issue(number:$number){
                projectItems(first:10){
                    nodes{ id project{ id } }
                }
            }
        }
    }`;
    const data = await graphqlRequest(token, query, {
        owner: "intrale",
        repo: "platform",
        number: issueNumber
    });
    const nodes = data && data.repository && data.repository.issue &&
                  data.repository.issue.projectItems &&
                  data.repository.issue.projectItems.nodes;
    if (!nodes || nodes.length === 0) return null;
    const item = nodes.find(n => n.project && n.project.id === PROJECT_ID);
    return item ? item.id : null;
}

async function moveIssueInProject(token, issueNumber, statusOptionId, statusName) {
    const itemId = await getProjectItemId(token, issueNumber);
    if (!itemId) {
        log("Issue #" + issueNumber + " no está en el proyecto, no se puede mover");
        return false;
    }

    const mutation = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
        updateProjectV2ItemFieldValue(input:{
            projectId:$projectId
            itemId:$itemId
            fieldId:$fieldId
            value:{singleSelectOptionId:$optionId}
        }){
            projectV2Item{ id }
        }
    }`;

    await graphqlRequest(token, mutation, {
        projectId: PROJECT_ID,
        itemId: itemId,
        fieldId: FIELD_ID,
        optionId: statusOptionId
    });

    log("Issue #" + issueNumber + " movido a " + statusName);
    return true;
}

async function closeIssue(token, issueNumber, reason) {
    // Usar archivo temporal para evitar shell injection en el comentario
    const tmpFile = path.join(HOOKS_DIR, "tmp-close-comment-" + issueNumber + ".txt");
    try {
        const comment = "🔧 Auto-reparación Scrum Master: " + reason;
        fs.writeFileSync(tmpFile, comment, "utf8");
        execSync(
            GH_CLI + " issue close " + issueNumber + " --repo intrale/platform" +
            " --comment-file \"" + tmpFile.replace(/\\/g, "/") + "\"",
            { encoding: "utf8", cwd: REPO_ROOT, timeout: 15000, windowsHide: true }
        );
        log("Issue #" + issueNumber + " cerrado: " + reason);
        return true;
    } catch (e) {
        // Fallback: cerrar sin comentario si falla el comment-file
        try {
            execSync(
                GH_CLI + " issue close " + issueNumber + " --repo intrale/platform",
                { encoding: "utf8", cwd: REPO_ROOT, timeout: 10000, windowsHide: true }
            );
            log("Issue #" + issueNumber + " cerrado (sin comentario): " + reason);
            return true;
        } catch (e2) {
            log("Error cerrando issue #" + issueNumber + ": " + e2.message);
            return false;
        }
    } finally {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
    }
}

async function commentOnIssue(issueNumber, comment) {
    // Usar archivo temporal para evitar shell injection en el cuerpo del comentario
    const tmpFile = path.join(HOOKS_DIR, "tmp-comment-" + issueNumber + ".txt");
    try {
        fs.writeFileSync(tmpFile, comment, "utf8");
        execSync(
            GH_CLI + " issue comment " + issueNumber + " --repo intrale/platform" +
            " --body-file \"" + tmpFile.replace(/\\/g, "/") + "\"",
            { encoding: "utf8", cwd: REPO_ROOT, timeout: 10000, windowsHide: true }
        );
        return true;
    } catch (e) {
        log("Error comentando issue #" + issueNumber + ": " + e.message);
        return false;
    } finally {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
    }
}

function updateSprintPlan(issueNumber, newStatus) {
    try {
        if (!fs.existsSync(SPRINT_PLAN_FILE)) return false;
        const plan = JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));

        // Actualizar estado en agentes si existe
        let updated = false;
        for (const lista of [plan.agentes, plan._queue, plan._completed]) {
            if (!Array.isArray(lista)) continue;
            for (const entry of lista) {
                if (entry.issue === issueNumber) {
                    entry.status = newStatus;
                    entry.status_updated_at = new Date().toISOString();
                    updated = true;
                }
            }
        }

        // Si el issue se cierra y está en agentes activos, moverlo a _completed
        if (newStatus === "done" && Array.isArray(plan.agentes)) {
            const idx = plan.agentes.findIndex(a => a.issue === issueNumber);
            if (idx !== -1) {
                const agent = plan.agentes.splice(idx, 1)[0];
                agent.status = "done";
                agent.completed_at = new Date().toISOString();
                if (!Array.isArray(plan._completed)) plan._completed = [];
                plan._completed.push(agent);
                updated = true;
            }
        }

        if (updated) {
            fs.writeFileSync(SPRINT_PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
            log("sprint-plan.json actualizado para issue #" + issueNumber + " → " + newStatus);
        }
        return updated;
    } catch (e) {
        log("Error actualizando sprint-plan.json: " + e.message);
        return false;
    }
}

function closeSprintInPlan() {
    try {
        if (!fs.existsSync(SPRINT_PLAN_FILE)) return false;
        const plan = JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
        plan.sprint_cerrado = true;
        plan.sprint_cerrado_at = new Date().toISOString();
        plan.sprint_cerrado_by = "auto-repair-sprint.js";
        fs.writeFileSync(SPRINT_PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
        log("Sprint " + plan.sprint_id + " marcado como cerrado en sprint-plan.json");
        return true;
    } catch (e) {
        log("Error cerrando sprint en plan: " + e.message);
        return false;
    }
}

// ─── Ejecutar reparaciones ────────────────────────────────────────────────────

async function repairInconsistencia(token, inconsistencia, dryRun) {
    const { type, issue, pr, action, severity } = inconsistencia;
    const result = {
        inconsistencia: type,
        issue,
        action: action || "none",
        status: "skipped",
        dry_run: dryRun,
        timestamp: new Date().toISOString()
    };

    switch (type) {

        case "pr_merged_issue_open": {
            if (!dryRun) {
                // 1. Cerrar issue
                const closed = await closeIssue(token, issue,
                    `PR #${pr} fue mergeado. Cerrando issue automáticamente.`
                );
                // 2. Mover a Done en Project V2
                const moved = await moveIssueInProject(token, issue, STATUS_OPTIONS.Done, "Done");
                // 3. Actualizar sprint-plan.json
                updateSprintPlan(issue, "done");

                result.status = (closed && moved) ? "ok" : "partial";
                result.details = { closed, moved_to_done: moved };
            } else {
                result.status = "dry_run";
                result.details = { would_close: true, would_move_to_done: true };
            }
            break;
        }

        case "stale_in_progress": {
            const newStatus = action === "move_to_ready" ? "Ready" : "Blocked";
            const optionId = STATUS_OPTIONS[newStatus];
            if (!dryRun) {
                const moved = await moveIssueInProject(token, issue, optionId, newStatus);
                await commentOnIssue(issue,
                    `🔧 Auto-reparación Scrum Master: Historia detectada como estancada (${inconsistencia.hours_stale}h sin agente activo). ` +
                    `Movida de "In Progress" → "${newStatus}".`
                );
                updateSprintPlan(issue, newStatus.toLowerCase().replace(" ", "_"));
                result.status = moved ? "ok" : "error";
                result.details = { new_status: newStatus };
            } else {
                result.status = "dry_run";
                result.details = { would_move_to: newStatus };
            }
            break;
        }

        case "closed_issue_wrong_status": {
            if (!dryRun) {
                const moved = await moveIssueInProject(token, issue, STATUS_OPTIONS.Done, "Done");
                updateSprintPlan(issue, "done");
                result.status = moved ? "ok" : "error";
                result.details = { moved_to_done: moved };
            } else {
                result.status = "dry_run";
                result.details = { would_move_to_done: true };
            }
            break;
        }

        case "pr_open_stale": {
            if (!dryRun) {
                // Solo notificar — no se puede hacer merge automático
                await commentOnIssue(issue,
                    `⚠️ Scrum Master: PR #${pr} lleva ${inconsistencia.hours_open}h abierto sin merge. Se requiere revisión.`
                );
                result.status = "ok";
                result.details = { notified: true };
            } else {
                result.status = "dry_run";
                result.details = { would_notify: true };
            }
            break;
        }

        case "sprint_overdue": {
            if (inconsistencia.action === "close_sprint") {
                if (!dryRun) {
                    const closed = closeSprintInPlan();
                    result.status = closed ? "ok" : "error";
                    result.details = { sprint_closed: closed };
                } else {
                    result.status = "dry_run";
                    result.details = { would_close_sprint: true };
                }
            } else {
                result.status = "notified";
                result.details = { alert_sent: true };
            }
            break;
        }

        default:
            result.status = "unknown_type";
            break;
    }

    appendAudit({
        action: action || type,
        issue: issue || null,
        pr: pr || null,
        type,
        severity,
        reason: inconsistencia.message,
        status: result.status,
        details: result.details,
        dry_run: dryRun
    });

    return result;
}

// ─── API pública ─────────────────────────────────────────────────────────────

async function runAutoRepair(diagnosis, options = {}) {
    const dryRun = options.dryRun !== false; // por defecto dry_run = true (safe)
    const onlyTypes = options.onlyTypes || null; // filtrar por tipos específicos

    if (!diagnosis || !diagnosis.inconsistencias) {
        return {
            ok: false,
            error: "Diagnóstico inválido",
            repairs: []
        };
    }

    const inconsistencias = diagnosis.inconsistencias.filter(inc => {
        if (onlyTypes && !onlyTypes.includes(inc.type)) return false;
        return true;
    });

    if (inconsistencias.length === 0) {
        return {
            ok: true,
            message: "No hay inconsistencias para reparar",
            repairs: []
        };
    }

    log("Iniciando auto-reparación: " + inconsistencias.length + " inconsistencia(s), dry_run=" + dryRun);

    let token;
    try {
        token = getGitHubToken();
    } catch (e) {
        return {
            ok: false,
            error: "No se pudo obtener token GitHub: " + e.message,
            repairs: []
        };
    }

    const repairs = [];
    for (const inc of inconsistencias) {
        try {
            const repair = await repairInconsistencia(token, inc, dryRun);
            repairs.push(repair);
            log("Reparación " + inc.type + " para issue #" + (inc.issue || "N/A") + ": " + repair.status);
        } catch (e) {
            log("Error reparando " + inc.type + ": " + e.message);
            repairs.push({
                inconsistencia: inc.type,
                issue: inc.issue,
                status: "error",
                error: e.message,
                dry_run: dryRun
            });
            appendAudit({
                action: inc.action || inc.type,
                issue: inc.issue || null,
                type: inc.type,
                reason: inc.message,
                status: "error",
                error: e.message,
                dry_run: dryRun
            });
        }
    }

    const okCount = repairs.filter(r => r.status === "ok" || r.status === "dry_run").length;
    const errorCount = repairs.filter(r => r.status === "error").length;

    return {
        ok: errorCount === 0,
        dry_run: dryRun,
        total: repairs.length,
        ok_count: okCount,
        error_count: errorCount,
        repairs,
        timestamp: new Date().toISOString()
    };
}

// Leer historial de auditoría
function readAuditHistory(limit = 50) {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return [];
        const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
        return lines.slice(-limit).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

// CLI
if (require.main === module) {
    const { runHealthCheck } = require("./health-check-sprint");
    const args = process.argv.slice(2);
    const autoMode = args.includes("--auto");
    const dryRunMode = !autoMode; // sin --auto → dry-run por defecto

    runHealthCheck().then(diagnosis => {
        return runAutoRepair(diagnosis, { dryRun: dryRunMode });
    }).then(result => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    }).catch(e => {
        console.error(JSON.stringify({ ok: false, error: e.message }));
        process.exit(1);
    });
}

module.exports = { runAutoRepair, readAuditHistory };

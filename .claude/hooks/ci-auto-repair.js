// ci-auto-repair.js -- Auto-reparacion de CI failures en PRs de agentes
// Lanzado por ci-monitor-bg.js cuando un PR de rama agent/* falla en CI.
// - Rastrear intentos de reparacion por rama (max 2)
// - Relanzar agente con prompt de reparacion via Start-Agente.ps1
// - Actualizar sprint-plan.json con estado ci-failed/ci-repair
// - Notificar via Telegram con escalacion si se superan reintentos

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, '..', '..');
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const REPAIR_STATE_FILE = path.join(HOOKS_DIR, "ci-repair-state.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const START_AGENTE_SCRIPT = path.join(REPO_ROOT, "scripts", "Start-Agente.ps1");
const MAX_REPAIR_ATTEMPTS = 2;

let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }
function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] CIAutoRepair: " + msg + "\n"); } catch (e) {}
}

async function sendTelegram(text) {
    try { if (tgClient) await tgClient.sendMessage(text); } catch (e) { log("sendTelegram: " + e.message); }
}

function loadRepairState() {
    try { if (fs.existsSync(REPAIR_STATE_FILE)) return JSON.parse(fs.readFileSync(REPAIR_STATE_FILE, "utf8")); }
    catch (e) { log("Error leyendo ci-repair-state.json: " + e.message); }
    return { repairs: {} };
}

function saveRepairState(state) {
    try { state.updated_at = new Date().toISOString(); fs.writeFileSync(REPAIR_STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }
    catch (e) { log("Error guardando ci-repair-state.json: " + e.message); }
}

function readSprintPlan() {
    try { if (fs.existsSync(SPRINT_PLAN_FILE)) return JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8")); }
    catch (e) { log("Error leyendo sprint-plan.json: " + e.message); }
    return null;
}

function writeSprintPlan(plan) {
    // #1736: escribir al roadmap (fuente de verdad), regenera cache automáticamente
    try { require("./sprint-data.js").saveRoadmapFromPlan(plan, "ci-auto-repair"); }
    catch (e) { log("Error escribiendo al roadmap: " + e.message); }
}

function findAgentByBranch(plan, branch) {
    if (!plan) return null;
    const lists = [plan.agentes, plan._queue].filter(Array.isArray);
    for (const list of lists) {
        for (const agent of list) {
            if (("agent/" + agent.issue + "-" + agent.slug) === branch) return agent;
        }
    }
    return null;
}

function buildRepairPrompt(opts) {
    const { branch, issueNumber, prNumber, runUrl, analysis, attempt } = opts;
    const { kotlinErrors, gradleErrors, suggestions, diagnosis } = analysis || {};
    const errorLines = [];
    if (gradleErrors && gradleErrors.length > 0) errorLines.push("Errores Gradle: " + gradleErrors.slice(0, 2).join(" | "));
    if (kotlinErrors && kotlinErrors.length > 0) errorLines.push("Errores Kotlin: " + kotlinErrors.slice(0, 2).join(" | "));
    if (suggestions && suggestions.length > 0) errorLines.push("Sugerencia: " + suggestions[0]);
    if (errorLines.length === 0) errorLines.push("Diagnostico: " + (diagnosis || "CI failure sin patron conocido"));
    return [
        "Auto-reparacion CI (intento " + attempt + "/" + MAX_REPAIR_ATTEMPTS + ")",
        "",
        "El CI del PR #" + (prNumber || "?") + " fallo en la rama " + branch + ".",
        "Issue: #" + issueNumber,
        "Log CI: " + (runUrl || "N/A"),
        "",
        "Error detectado:",
        errorLines.join("\n"),
        "",
        "INSTRUCCIONES (NO reimplementar el issue completo):",
        "1. Leer el error exacto en el log: " + (runUrl || "N/A"),
        "2. Identificar el archivo/linea que falla",
        "3. Aplicar el fix minimo necesario",
        "4. Ejecutar ./gradlew check localmente para verificar",
        "5. Si pasa: commit + push al branch existente",
        "6. NO invocar /delivery - solo push para que CI re-corra",
        "",
        "Closes #" + issueNumber
    ].join("\n");
}

function getWorktreePath(agent) {
    return path.join(path.resolve(REPO_ROOT, ".."), "platform.agent-" + agent.issue + "-" + agent.slug);
}

function writeRepairErrorFile(worktreePath, content) {
    try {
        const tmpDir = path.join(worktreePath, ".claude", "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, "ci-repair-error.txt"), content, "utf8");
        log("ci-repair-error.txt escrito en worktree");
    } catch (e) { log("Error escribiendo ci-repair-error.txt: " + e.message); }
}

function spawnRepairAgent(agentNumero) {
    return new Promise(function(resolve) {
        if (!fs.existsSync(START_AGENTE_SCRIPT)) {
            log("Start-Agente.ps1 no encontrado");
            resolve({ ok: false, error: "Start-Agente.ps1 no encontrado" });
            return;
        }
        log("Lanzando Start-Agente.ps1 " + agentNumero + " para reparacion CI...");
        const scriptPath = START_AGENTE_SCRIPT.replace(/\//g, "\\");
        const child = spawn("powershell.exe", ["-NonInteractive", "-File", scriptPath, String(agentNumero)], {
            detached: true, stdio: "ignore", cwd: REPO_ROOT, windowsHide: false
        });
        child.unref();
        log("Start-Agente.ps1 lanzado PID=" + child.pid);
        resolve({ ok: true, pid: child.pid });
    });
}

// Retorna false si el CI tiene errores pendientes (bloquea _completed en sprint-plan)
function isCIClean(agent) {
    const ciStatus = agent && agent.ci_status;
    if (!ciStatus) return true;
    if (ciStatus === "ci-failed") return false;
    if (ciStatus === "ci-repair") return false;
    return true;
}

async function triggerRepair(opts) {
    const { branch, sha, prNumber, runId, runUrl, analysis } = opts;
    if (!branch || !branch.startsWith("agent/")) return { skipped: true, reason: "not_agent_branch" };
    log("CI failure en " + branch + " - evaluando auto-reparacion");
    const state = loadRepairState();
    const branchState = state.repairs[branch] || { attempts: 0 };

    if (branchState.attempts >= MAX_REPAIR_ATTEMPTS) {
        log("Limite alcanzado para " + branch + " - escalando");
        const plan2 = readSprintPlan();
        const agent2 = plan2 ? findAgentByBranch(plan2, branch) : null;
        if (agent2) {
            agent2.ci_status = "ci-failed";
            agent2.ci_updated_at = new Date().toISOString();
            agent2.ci_run_url = runUrl || null;
            agent2.ci_pr_number = prNumber || null;
            agent2.ci_repair_attempts = branchState.attempts;
            writeSprintPlan(plan2);
        }
        await sendTelegram(
            "\u{1F6A8} <b>CI Auto-repair: limite alcanzado</b>\n\n" +
            "Rama: <code>" + branch + "</code>\n" +
            "PR: " + (prNumber ? "#" + prNumber : "sin PR") + "\n" +
            "Intentos: " + branchState.attempts + "/" + MAX_REPAIR_ATTEMPTS + "\n" +
            "\n\u26A0\uFE0F Requiere intervencion manual."
        );
        return { escalated: true, attempts: branchState.attempts, branch };
    }

    const plan = readSprintPlan();
    const agent = findAgentByBranch(plan, branch);
    if (!agent) {
        log("No se encontro agente para " + branch);
        await sendTelegram("\u26A0\uFE0F <b>CI failure</b> en <code>" + branch + "</code>\nSin agente en sprint-plan.json.");
        return { skipped: true, reason: "agent_not_in_sprint_plan" };
    }

    branchState.attempts += 1;
    branchState.last_attempt_at = new Date().toISOString();
    branchState.pr_number = prNumber || null;
    branchState.last_error = (analysis && analysis.diagnosis) || "CI failure";
    branchState.issue = agent.issue;
    state.repairs[branch] = branchState;
    saveRepairState(state);
    log("Intento " + branchState.attempts + "/" + MAX_REPAIR_ATTEMPTS + " para " + branch);

    const repairPrompt = buildRepairPrompt({ branch, issueNumber: agent.issue, prNumber, runUrl, analysis, attempt: branchState.attempts });
    const worktreePath = getWorktreePath(agent);
    if (fs.existsSync(worktreePath)) writeRepairErrorFile(worktreePath, repairPrompt);

    const originalPrompt = agent.prompt;
    agent.prompt = repairPrompt;
    agent.ci_status = "ci-repair";
    agent.ci_updated_at = new Date().toISOString();
    agent.ci_run_url = runUrl || null;
    agent.ci_pr_number = prNumber || null;
    agent.ci_repair_attempt = branchState.attempts;
    writeSprintPlan(plan);

    const diagText = (analysis && analysis.diagnosis) || "CI failure";
    await sendTelegram(
        "\u{1F527} <b>CI Auto-repair iniciado</b>\n\n" +
        "Rama: <code>" + branch + "</code>\n" +
        "Issue: #" + agent.issue + "\n" +
        "Diagnostico: " + diagText + "\n" +
        "Intento: " + branchState.attempts + "/" + MAX_REPAIR_ATTEMPTS
    );

    const launchResult = await spawnRepairAgent(agent.numero);
    if (!launchResult.ok) {
        agent.prompt = originalPrompt;
        agent.ci_status = "ci-repair-failed";
        writeSprintPlan(plan);
        return { ok: false, error: launchResult.error, attempts: branchState.attempts };
    }

    // Restaurar prompt original 15s despues (Start-Agente ya lo leyo del sprint-plan)
    setTimeout(function() {
        try {
            const p = readSprintPlan();
            const a = p ? findAgentByBranch(p, branch) : null;
            if (a && a.prompt === repairPrompt) { a.prompt = originalPrompt; writeSprintPlan(p); log("Prompt restaurado para " + branch); }
        } catch (e) { log("Error restaurando prompt: " + e.message); }
    }, 15000);

    log("Agente reparacion lanzado para " + branch + " (intento " + branchState.attempts + ")");
    return { ok: true, launched: true, attempts: branchState.attempts, branch, issue: agent.issue, agentNumero: agent.numero, pid: launchResult.pid };
}

function getRepairStatus(branch) { return loadRepairState().repairs[branch] || null; }

function clearRepairState(branch) {
    const state = loadRepairState();
    if (state.repairs[branch]) { delete state.repairs[branch]; saveRepairState(state); log("Estado limpiado para " + branch); return true; }
    return false;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const branch = args[0];
    if (!branch) { console.error(JSON.stringify({ ok: false, error: "Uso: node ci-auto-repair.js <branch> [sha] [prNumber] [runUrl]" })); process.exit(1); }
    const mock = { diagnosis: "CI failure (CLI)", errors: [], kotlinErrors: [], gradleErrors: [], suggestions: [] };
    triggerRepair({ branch, sha: args[1], prNumber: args[2] ? parseInt(args[2]) : null, runUrl: args[3] || null, analysis: mock, logs: "" })
        .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit((r.ok || r.skipped) ? 0 : 1); })
        .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}

module.exports = { triggerRepair, getRepairStatus, clearRepairState, isCIClean };

// ci-monitor-bg.js — Monitoreo CI en background (Pure Node.js)
// Lanzado por post-git-push.js tras detectar un git push exitoso.
// Polling: consulta GitHub Actions cada 30s hasta que el run concluya.
// Al finalizar: notifica resultado via Telegram.
//
// Uso: node ci-monitor-bg.js <sha> <branch> <project-dir>

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let registerMessage;
try {
    registerMessage = require("./telegram-message-registry").registerMessage;
} catch (e) {
    registerMessage = () => {}; // Fallback si el registry no existe
}

// P-09: Usar telegram-client.js compartido
let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

// P-15: Ops learnings
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

const SHA = process.argv[2];
const BRANCH = process.argv[3];
const PROJECT_DIR = process.argv[4] || process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
// Arg 5 opcional: session file path para actualizar waiting_state
const SESSION_FILE = process.argv[5] || null;

const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");
const MAX_POLLS = 40;            // ~20 minutos maximo
const GH_REPO = "intrale/platform";

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] CI-Monitor: " + msg + "\n"); } catch(e) {}
}

function getGitHubToken() {
    // Intentar gh auth token primero
    try {
        const ghPath = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
        if (fs.existsSync(ghPath)) {
            return execSync(ghPath + " auth token", { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
        }
    } catch(e) {}
    // Fallback: git credential fill
    try {
        const credInput = "protocol=https\nhost=github.com\n\n";
        const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true });
        const match = result.match(/password=(.+)/);
        if (match) return match[1].trim();
    } catch(e) {}
    return "";
}

function ghApiGet(apiPath, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "api.github.com",
            path: apiPath,
            method: "GET",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-ci-monitor",
                "Accept": "application/vnd.github+json"
            },
            timeout: 10000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// P-09: Envío via telegram-client.js con fallback inline
async function sendTelegram(text) {
    try {
        if (tgClient) {
            const result = await tgClient.sendMessage(text);
            if (result && result.message_id) registerMessage(result.message_id, "ci");
            return result;
        }
    } catch (e) { log("sendTelegram via client error: " + e.message); }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Actualizar waiting_state en el session file del agente
function updateSessionWaitingState(patch) {
    // Intentar desde SESSION_FILE (arg directo) o buscar en sessions/ del worktree
    const candidates = [];
    if (SESSION_FILE) candidates.push(SESSION_FILE);

    // Buscar en el worktree que coincide con la rama
    try {
        const branchSlug = BRANCH.replace(/\//g, "-");
        const parentDir = path.resolve(PROJECT_DIR, "..");
        const dirEntries = fs.readdirSync(parentDir);
        for (const d of dirEntries) {
            if (d.includes(branchSlug) || d.startsWith("platform.agent-")) {
                const sessDir = path.join(parentDir, d, ".claude", "sessions");
                if (fs.existsSync(sessDir)) {
                    const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".json"));
                    for (const f of files) {
                        candidates.push(path.join(sessDir, f));
                    }
                }
            }
        }
    } catch (e) { /* no bloquear */ }

    // También buscar en el repo principal
    try {
        const mainSessDir = path.join(PROJECT_DIR, ".claude", "sessions");
        if (fs.existsSync(mainSessDir)) {
            const files = fs.readdirSync(mainSessDir).filter(f => f.endsWith(".json"));
            for (const f of files) {
                candidates.push(path.join(mainSessDir, f));
            }
        }
    } catch (e) {}

    // Actualizar sesiones cuya rama coincide con BRANCH
    let updated = 0;
    for (const filePath of candidates) {
        try {
            const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if ((session.branch || "") !== BRANCH) continue;
            if (!session.waiting_state) session.waiting_state = {};
            Object.assign(session.waiting_state, patch);
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
            updated++;
        } catch (e) {}
    }

    if (updated > 0) {
        log("waiting_state actualizado en " + updated + " session(s): " + JSON.stringify(patch));
    }
}

// P-11: Backoff progresivo según tiempo transcurrido
function getPollInterval(elapsedMs) {
    if (elapsedMs < 120000) return 60000;   // 0-2min: 60s (workflow registrándose)
    if (elapsedMs < 480000) return 30000;   // 2-8min: 30s (fase activa)
    return 60000;                            // >8min: 60s (anormal, reducir carga)
}

async function main() {
    if (!SHA || !BRANCH) {
        log("Faltan argumentos: sha=" + SHA + " branch=" + BRANCH);
        process.exit(1);
    }

    log("Iniciando monitoreo CI para " + SHA.substring(0, 7) + " en " + BRANCH);

    const token = getGitHubToken();
    if (!token) {
        log("No se pudo obtener GitHub token, abortando");
        process.exit(1);
    }

    // Esperar un poco para que GitHub registre el workflow run
    await sleep(10000);

    const startMs = Date.now();
    let lastRunId = null;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        const elapsedMs = Date.now() - startMs;
        const interval = getPollInterval(elapsedMs);

        try {
            // Buscar workflow runs para este SHA
            const data = await ghApiGet(
                "/repos/" + GH_REPO + "/actions/runs?head_sha=" + SHA + "&per_page=5",
                token
            );

            const runs = data.workflow_runs || [];
            if (runs.length === 0) {
                log("Poll " + (poll + 1) + ": sin runs para " + SHA.substring(0, 7) + " (interval=" + (interval/1000) + "s)");
                if (poll > 5) {
                    log("Sin runs despues de " + (poll + 1) + " intentos, abortando");
                    // Limpiar waiting_state si no hay runs
                    updateSessionWaitingState({ status: "no_runs", detail: "Sin workflow runs en GitHub Actions" });
                    break;
                }
                await sleep(interval);
                continue;
            }

            const run = runs[0];
            const status = run.status;
            const conclusion = run.conclusion;
            const runUrl = run.html_url || "";
            const runId = run.id;
            const runName = run.name || "CI";

            log("Poll " + (poll + 1) + ": status=" + status + " conclusion=" + (conclusion || "pending") + " (interval=" + (interval/1000) + "s)");

            // Actualizar session con estado de CI en progreso
            if (status !== "completed") {
                const detail = runName + " (" + status + ")";
                updateSessionWaitingState({
                    reason: "ci",
                    detail: "GitHub Actions: " + detail,
                    status: "in_progress",
                    run_id: runId,
                    run_url: runUrl,
                    run_name: runName
                });
                lastRunId = runId;
            }

            if (status === "completed") {
                const emoji = conclusion === "success" ? "\u2705" : "\u274C";
                const label = conclusion === "success" ? "exitoso" : "fallido (" + conclusion + ")";
                const url = runUrl;

                const msg = emoji + " <b>CI " + label + "</b>\n\n"
                    + "Branch: <code>" + BRANCH + "</code>\n"
                    + "Commit: <code>" + SHA.substring(0, 7) + "</code>\n"
                    + (url ? '<a href="' + url + '">Ver en GitHub</a>' : "");

                // Actualizar session con resultado final
                updateSessionWaitingState({
                    reason: "ci",
                    detail: "GitHub Actions: " + runName + " (" + (conclusion || "completed") + ")",
                    status: conclusion === "success" ? "success" : "failure",
                    run_id: runId,
                    run_url: runUrl,
                    run_name: runName,
                    finished_at: new Date().toISOString()
                });

                log("CI completado: " + conclusion + " — notificando");
                // P-15: Registrar CI fallido en ops-learnings
                if (conclusion !== "success" && opsLearnings) {
                    try {
                        opsLearnings.recordLearning({
                            source: "ci-monitor",
                            category: "ci_failure",
                            severity: "high",
                            symptom: "CI fallido: " + conclusion + " en " + BRANCH,
                            root_cause: "Workflow conclusion: " + conclusion,
                            affected: ["ci-monitor-bg.js"],
                            auto_detected: true
                        });
                    } catch (e) {}
                }
                await sendTelegram(msg);
                process.exit(0);
            }

            // Aun corriendo, esperar
            await sleep(interval);
        } catch(e) {
            log("Error en poll " + (poll + 1) + ": " + e.message);
            await sleep(interval);
        }
    }

    log("Timeout: CI no completo despues de " + MAX_POLLS + " polls");
    updateSessionWaitingState({ status: "timeout", detail: "CI timeout: workflow no completó en tiempo esperado", finished_at: new Date().toISOString() });
    // P-15: Registrar timeout en ops-learnings
    if (opsLearnings) {
        try {
            opsLearnings.recordLearning({
                source: "ci-monitor",
                category: "ci_timeout",
                severity: "high",
                symptom: "CI timeout: workflow no completó en tiempo esperado",
                root_cause: "Workflow para " + BRANCH + " (" + SHA.substring(0, 7) + ") excedió " + MAX_POLLS + " polls",
                affected: ["ci-monitor-bg.js"],
                auto_detected: true
            });
        } catch (e) {}
    }
    await sendTelegram("\u23F1 <b>CI timeout</b>\n\nEl workflow para <code>" + SHA.substring(0, 7) + "</code> en <code>" + BRANCH + "</code> no completo en el tiempo esperado.");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(1);
});

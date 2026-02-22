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

const SHA = process.argv[2];
const BRANCH = process.argv[3];
const PROJECT_DIR = process.argv[4] || process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";

const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");
const POLL_INTERVAL_MS = 30000;  // 30 segundos
const MAX_POLLS = 40;            // ~20 minutos maximo
const GH_REPO = "intrale/platform";

let tgConfig;
try {
    tgConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, ".claude", "hooks", "telegram-config.json"), "utf8"));
} catch(e) {
    tgConfig = { bot_token: "", chat_id: "" };
}

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] CI-Monitor: " + msg + "\n"); } catch(e) {}
}

function getGitHubToken() {
    // Intentar gh auth token primero
    try {
        const ghPath = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
        if (fs.existsSync(ghPath)) {
            return execSync(ghPath + " auth token", { encoding: "utf8", timeout: 5000 }).trim();
        }
    } catch(e) {}
    // Fallback: git credential fill
    try {
        const credInput = "protocol=https\nhost=github.com\n\n";
        const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000 });
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

function sendTelegram(text) {
    if (!tgConfig.bot_token || !tgConfig.chat_id) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ chat_id: tgConfig.chat_id, text: text, parse_mode: "HTML" });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + tgConfig.bot_token + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve(d));
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    for (let poll = 0; poll < MAX_POLLS; poll++) {
        try {
            // Buscar workflow runs para este SHA
            const data = await ghApiGet(
                "/repos/" + GH_REPO + "/actions/runs?head_sha=" + SHA + "&per_page=5",
                token
            );

            const runs = data.workflow_runs || [];
            if (runs.length === 0) {
                log("Poll " + (poll + 1) + ": sin runs para " + SHA.substring(0, 7));
                if (poll > 5) {
                    log("Sin runs despues de " + (poll + 1) + " intentos, abortando");
                    break;
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            const run = runs[0];
            const status = run.status;
            const conclusion = run.conclusion;

            log("Poll " + (poll + 1) + ": status=" + status + " conclusion=" + (conclusion || "pending"));

            if (status === "completed") {
                const emoji = conclusion === "success" ? "\u2705" : "\u274C";
                const label = conclusion === "success" ? "exitoso" : "fallido (" + conclusion + ")";
                const url = run.html_url || "";

                const msg = emoji + " <b>CI " + label + "</b>\n\n"
                    + "Branch: <code>" + BRANCH + "</code>\n"
                    + "Commit: <code>" + SHA.substring(0, 7) + "</code>\n"
                    + (url ? '<a href="' + url + '">Ver en GitHub</a>' : "");

                log("CI completado: " + conclusion + " — notificando");
                await sendTelegram(msg);
                process.exit(0);
            }

            // Aun corriendo, esperar
            await sleep(POLL_INTERVAL_MS);
        } catch(e) {
            log("Error en poll " + (poll + 1) + ": " + e.message);
            await sleep(POLL_INTERVAL_MS);
        }
    }

    log("Timeout: CI no completo despues de " + MAX_POLLS + " polls");
    await sendTelegram("\u23F1 <b>CI timeout</b>\n\nEl workflow para <code>" + SHA.substring(0, 7) + "</code> en <code>" + BRANCH + "</code> no completo en el tiempo esperado.");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(1);
});

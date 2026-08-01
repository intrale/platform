// Hook PostToolUse[Bash]: detecta merge exitoso de PR a main y verifica cobertura QA E2E
// Si el issue asociado no tiene labels qa:passed ni qa:skipped → agrega qa:pending y notifica por Telegram
// Tolerante a fallos — nunca bloquea el merge ni el cierre del issue
// Idempotente — si qa:pending ya existe, no duplica la notificacion
const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] post-merge-qa: " + msg + "\n"); } catch(e) {}
}

// Leer stdin con timeout
const MAX_READ = 4096;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); handleInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 2000);

function getGitHubToken() {
    try {
        const token = execSync("gh auth token", { encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true }).trim();
        if (token) return token;
    } catch(e) {}
    const credInput = "protocol=https\nhost=github.com\n\n";
    const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true });
    const match = result.match(/password=(.+)/);
    if (!match) throw new Error("No se encontro token de GitHub");
    return match[1].trim();
}

function ghGet(token, endpoint) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "api.github.com",
            path: "/repos/intrale/platform" + endpoint,
            method: "GET",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-hook",
                "Accept": "application/vnd.github.v3+json"
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { resolve(JSON.parse(d)); } catch(e) { reject(new Error("JSON parse: " + d.substring(0, 200))); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout GET " + endpoint)); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

function ghPost(token, endpoint, body) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const req = https.request({
            hostname: "api.github.com",
            path: "/repos/intrale/platform" + endpoint,
            method: "POST",
            headers: {
                "Authorization": "token " + token,
                "User-Agent": "intrale-hook",
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve({ status: res.statusCode, body: d }));
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout POST " + endpoint)); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function sendTelegram(token, chatId, text) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
            disable_web_page_preview: true
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + token + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => { log("Telegram: " + res.statusCode); resolve(); });
        });
        req.on("timeout", () => { req.destroy(); resolve(); });
        req.on("error", () => resolve());
        req.write(postData);
        req.end();
    });
}

/**
 * Parsea el body del PR buscando referencias a issues cerrados.
 * Busca patrones: Closes #N, Fixes #N, Resolves #N (case-insensitive)
 * Retorna array de números de issue encontrados.
 */
function extractIssueNumbers(prBody) {
    if (!prBody) return [];
    const pattern = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
    const issues = [];
    let match;
    while ((match = pattern.exec(prBody)) !== null) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && !issues.includes(num)) {
            issues.push(num);
        }
    }
    return issues;
}

/**
 * Detecta si el comando bash es un merge de PR exitoso.
 * Soporta: gh pr merge <N>, gh pr merge --squash, --merge, --rebase
 */
function extractPrNumber(command) {
    // gh pr merge <N> [opciones]
    const match = command.match(/gh\s+pr\s+merge\s+(\d+)/);
    if (match) return parseInt(match[1], 10);
    // gh pr merge [opciones] sin número explícito (usa PR del branch actual)
    if (/gh\s+pr\s+merge/.test(command)) return 0; // 0 = detectar desde contexto
    return null;
}

async function processQaCheck(prNumber, token, tgToken, tgChatId) {
    // Obtener datos del PR
    let prData;
    try {
        if (prNumber > 0) {
            prData = await ghGet(token, "/pulls/" + prNumber);
        } else {
            // Intentar detectar el PR mergeado más reciente al branch base main
            const prs = await ghGet(token, "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=5");
            if (!Array.isArray(prs) || prs.length === 0) {
                log("No se encontraron PRs cerrados recientes en main");
                return;
            }
            prData = prs.find(pr => pr.merged_at) || prs[0];
        }
    } catch(e) {
        log("Error obteniendo datos del PR: " + e.message);
        return;
    }

    if (!prData || !prData.merged_at) {
        log("PR #" + prNumber + " no fue mergeado (merged_at es null), ignorando");
        return;
    }

    // Verificar que el merge fue a main
    const baseBranch = prData.base && prData.base.ref;
    if (baseBranch !== "main") {
        log("PR #" + (prData.number || prNumber) + " no fue a main (base=" + baseBranch + "), ignorando");
        return;
    }

    const resolvedPrNumber = prData.number || prNumber;
    const prBody = prData.body || "";
    const prTitle = prData.title || "";

    log("PR #" + resolvedPrNumber + " mergeado a main: '" + prTitle + "'");

    // Extraer issues asociados
    const issueNumbers = extractIssueNumbers(prBody);
    if (issueNumbers.length === 0) {
        log("PR #" + resolvedPrNumber + " sin issues asociados (sin 'Closes #N'), ignorando");
        return;
    }

    log("Issues asociados: " + issueNumbers.join(", "));

    for (const issueNum of issueNumbers) {
        try {
            await checkAndTagIssue(issueNum, resolvedPrNumber, token, tgToken, tgChatId);
        } catch(e) {
            log("Error procesando issue #" + issueNum + ": " + e.message);
        }
    }
}

async function checkAndTagIssue(issueNum, prNumber, token, tgToken, tgChatId) {
    // Obtener labels del issue
    const issueData = await ghGet(token, "/issues/" + issueNum);
    if (!issueData || issueData.message) {
        log("Issue #" + issueNum + " no encontrado o error: " + (issueData && issueData.message));
        return;
    }

    const labels = (issueData.labels || []).map(l => l.name);
    log("Issue #" + issueNum + " labels: " + labels.join(", "));

    const hasQaEvidence = labels.includes("qa:passed") || labels.includes("qa:skipped");
    const hasQaPending = labels.includes("qa:pending");

    if (hasQaEvidence) {
        log("Issue #" + issueNum + " ya tiene evidencia QA (" + labels.filter(l => l.startsWith("qa:")).join(", ") + "), ok");
        return;
    }

    if (hasQaPending) {
        log("Issue #" + issueNum + " ya tiene qa:pending, no duplicar notificacion");
        return;
    }

    // Agregar label qa:pending
    log("Issue #" + issueNum + " sin evidencia QA — agregando qa:pending");
    try {
        await ghPost(token, "/issues/" + issueNum + "/labels", ["qa:pending"]);
        log("Label qa:pending agregado a issue #" + issueNum);
    } catch(e) {
        log("Error agregando label qa:pending a issue #" + issueNum + ": " + e.message);
        // Continuar para notificar igual
    }

    // Notificar por Telegram
    if (tgToken && tgChatId) {
        const issueTitle = issueData.title || "";
        const issueUrl = "https://github.com/intrale/platform/issues/" + issueNum;
        const prUrl = "https://github.com/intrale/platform/pull/" + prNumber;
        const msg = "\u26a0\ufe0f <b>Merge sin QA E2E detectado</b>\n" +
            "PR <a href=\"" + prUrl + "\">#" + prNumber + "</a> mergeado a main sin evidencia de QA.\n" +
            "Issue <a href=\"" + issueUrl + "\">#" + issueNum + "</a>: " + issueTitle + "\n" +
            "Label <code>qa:pending</code> agregado — requiere ejecuci\u00f3n de QA retroactivo.";
        await sendTelegram(tgToken, tgChatId, msg);
        log("Notificacion Telegram enviada para issue #" + issueNum);
    }
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";

        const prNumber = extractPrNumber(command);
        if (prNumber === null) return; // No es un merge de PR

        // Verificar que no hubo error en stderr
        const stderr = (data.tool_result && data.tool_result.stderr) || "";
        const stdout = (data.tool_result && data.tool_result.stdout) || "";
        if (/error|rejected|denied|failed/i.test(stderr)) {
            log("gh pr merge tuvo error, ignorando");
            return;
        }

        // Verificar que el merge fue exitoso (stdout menciona merge o no hay error)
        // gh pr merge exitoso imprime algo como "✓ Merged pull request #N"
        const mergeSuccess = /merged|squashed|rebased/i.test(stdout) || stdout.trim().length > 0;
        if (!mergeSuccess && stderr.length > 0) {
            log("Merge no exitoso, ignorando");
            return;
        }

        log("Merge detectado: PR #" + prNumber + " — iniciando verificacion QA");

        // Cargar config de Telegram
        let tgToken = "", tgChatId = "";
        try {
            const tgCfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, ".claude", "hooks", "telegram-config.json"), "utf8"));
            tgToken = tgCfg.bot_token || "";
            tgChatId = tgCfg.chat_id || "";
        } catch(e) {
            log("No se pudo cargar telegram-config.json: " + e.message);
        }

        // Obtener token de GitHub
        let ghToken;
        try {
            ghToken = getGitHubToken();
        } catch(e) {
            log("No se pudo obtener token de GitHub: " + e.message);
            return;
        }

        processQaCheck(prNumber, ghToken, tgToken, tgChatId).catch(e => {
            log("Error en processQaCheck: " + e.message);
        });

    } catch(e) {
        log("Error parseando input: " + e.message);
    }
}

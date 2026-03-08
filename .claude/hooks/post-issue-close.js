// Hook PostToolUse[Bash]: detecta gh issue close y mueve el issue a "Done" o "QA Pending" en Project V2
// Gate de calidad: si el issue no tiene qa:passed ni qa:skipped → va a "QA Pending"
// Pure Node.js — sin dependencias externas
const { execSync } = require("child_process");
const https = require("https");
const querystring = require("querystring");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");
const AUDIT_LOG = path.join(PROJECT_DIR, ".claude", "hooks", "delivery-gate-audit.jsonl");

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";
const DONE_OPTION_ID = "98236657";
const QA_PENDING_OPTION_ID = "dcd0a053";

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] post-issue-close: " + msg + "\n"); } catch(e) {}
}

function writeAuditLog(entry) {
    try {
        fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
    } catch(e) {
        log("Error escribiendo audit log: " + e.message);
    }
}

// Leer stdin
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
    // Priorizar gh auth token (tiene scope project)
    try {
        const token = execSync("gh auth token", { encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true }).trim();
        if (token) return token;
    } catch(e) {}
    // Fallback: git credential fill
    const credInput = "protocol=https\nhost=github.com\n\n";
    const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000, windowsHide: true });
    const match = result.match(/password=(.+)/);
    if (!match) throw new Error("No se encontro password en git credential fill");
    return match[1].trim();
}

function graphqlRequest(token, query, variables) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ query: query, variables: variables || {} });
        const req = https.request({
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Authorization": "bearer " + token,
                "User-Agent": "intrale-hook"
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.errors && r.errors.length > 0) {
                        reject(new Error(r.errors[0].message));
                    } else {
                        resolve(r.data);
                    }
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout graphql")); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function sendTelegram(text) {
    return new Promise((resolve) => {
        try {
            const cfgPath = path.join(PROJECT_DIR, ".claude", "hooks", "telegram-config.json");
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            const postData = querystring.stringify({ chat_id: cfg.chat_id, text: text, parse_mode: "HTML", disable_notification: "false" });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + cfg.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 5000
            }, (res) => {
                let d = "";
                res.on("data", (c) => d += c);
                res.on("end", () => { log("Telegram enviado: " + d.substring(0, 100)); resolve(); });
            });
            req.on("error", (e) => { log("Error Telegram: " + e.message); resolve(); });
            req.on("timeout", () => { req.destroy(); resolve(); });
            req.write(postData);
            req.end();
        } catch(e) {
            log("Error leyendo config Telegram: " + e.message);
            resolve();
        }
    });
}

async function getIssueLabels(token, issueNumber) {
    const queryStr = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){labels(first:20){nodes{name}}}}}";
    const data = await graphqlRequest(token, queryStr, { owner: "intrale", repo: "platform", number: issueNumber });
    const nodes = data && data.repository && data.repository.issue && data.repository.issue.labels && data.repository.issue.labels.nodes;
    return (nodes || []).map(function(n) { return n.name; });
}

async function addLabelToIssue(token, issueNumber, labelName) {
    // Usar REST API para agregar label
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ labels: [labelName] });
        const req = https.request({
            hostname: "api.github.com",
            path: "/repos/intrale/platform/issues/" + issueNumber + "/labels",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Authorization": "bearer " + token,
                "User-Agent": "intrale-hook"
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => { log("Label agregado: " + d.substring(0, 80)); resolve(); });
        });
        req.on("error", (e) => { log("Error agregando label: " + e.message); resolve(); });
        req.on("timeout", () => { req.destroy(); resolve(); });
        req.write(postData);
        req.end();
    });
}

async function processIssueClose(issueNumber) {
    log("Procesando cierre de issue #" + issueNumber);

    const token = getGitHubToken();

    // Obtener labels del issue
    const labels = await getIssueLabels(token, issueNumber);
    log("Labels del issue #" + issueNumber + ": " + labels.join(", "));

    const hasQaPassed = labels.indexOf("qa:passed") !== -1;
    const hasQaSkipped = labels.indexOf("qa:skipped") !== -1;
    const qaOk = hasQaPassed || hasQaSkipped;

    // Obtener projectItemId del issue en el Project V2
    const queryStr = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){projectItems(first:10){nodes{id project{id}}}}}}";
    const data = await graphqlRequest(token, queryStr, { owner: "intrale", repo: "platform", number: issueNumber });

    const nodes = data && data.repository && data.repository.issue && data.repository.issue.projectItems && data.repository.issue.projectItems.nodes;
    if (!nodes || nodes.length === 0) {
        log("Issue #" + issueNumber + " no esta en ningun proyecto, ignorando");
        return;
    }

    // Filtrar por el project id correcto
    const item = nodes.find(function(n) { return n.project && n.project.id === PROJECT_ID; });
    if (!item) {
        log("Issue #" + issueNumber + " no esta en el proyecto Intrale, ignorando");
        return;
    }

    const targetOptionId = qaOk ? DONE_OPTION_ID : QA_PENDING_OPTION_ID;
    const targetName = qaOk ? "Done" : "QA Pending";
    const qaStatus = hasQaPassed ? "passed" : (hasQaSkipped ? "skipped" : "pending");

    // Actualizar campo Status en Project V2
    const mutationStr = "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}";
    await graphqlRequest(token, mutationStr, {
        projectId: PROJECT_ID,
        itemId: item.id,
        fieldId: FIELD_ID,
        optionId: targetOptionId
    });
    log("Issue #" + issueNumber + " movido a " + targetName);

    // Registrar en audit log
    writeAuditLog({
        ts: new Date().toISOString(),
        issue: issueNumber,
        qa_status: qaStatus,
        action: qaOk ? "moved_to_done" : "moved_to_qa_pending",
        labels: labels
    });

    // Si no pasó QA: agregar label qa:pending y notificar por Telegram
    if (!qaOk) {
        // Agregar label qa:pending si no lo tiene
        if (labels.indexOf("qa:pending") === -1) {
            await addLabelToIssue(token, issueNumber, "qa:pending");
        }

        // Notificar por Telegram
        const msg = "⚙️ Issue <b>#" + issueNumber + "</b> cerrado sin QA E2E\n"
            + "→ Movido a <b>QA Pending</b> en lugar de Done\n"
            + "🏷 Label <code>qa:pending</code> agregado\n"
            + "🔗 <a href=\"https://github.com/intrale/platform/issues/" + issueNumber + "\">#" + issueNumber + "</a>";
        await sendTelegram(msg);
    }
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";

        // Detectar gh issue close <N>
        const match = command.match(/gh\s+issue\s+close\s+(\d+)/);
        if (!match) return;

        // Verificar que no hubo error en stderr
        const stderr = (data.tool_result && data.tool_result.stderr) || "";
        if (/error|rejected|denied|failed/i.test(stderr)) {
            log("gh issue close tuvo error en stderr, ignorando");
            return;
        }

        const issueNumber = parseInt(match[1], 10);
        processIssueClose(issueNumber).catch(function(e) {
            log("Error procesando cierre de issue #" + issueNumber + ": " + e.message);
        });
    } catch(e) {
        log("Error parseando input: " + e.message);
    }
}

// Hook PostToolUse[Bash]: detecta gh issue close y aplica gate de QA
// Gate de calidad: verifica labels qa:passed/qa:skipped antes de mover a Done
// Si el issue no tiene label de QA → mueve a "QA Pending" y notifica por Telegram
// Pure Node.js — sin dependencias externas
const { execSync } = require("child_process");
const https = require("https");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");
const AUDIT_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "delivery-gate-audit.jsonl");

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";
const DONE_OPTION_ID = "b30e67ed";
const QA_PENDING_OPTION_ID = "dcd0a053";

// Labels de QA que permiten pasar directamente a Done
const QA_PASS_LABELS = ["qa:passed", "qa:skipped"];

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] post-issue-close: " + msg + "\n"); } catch(e) {}
}

function appendAudit(entry) {
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
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

function sendTelegram(message) {
    try {
        const cfgPath = path.join(PROJECT_DIR, ".claude", "hooks", "telegram-config.json");
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const postData = JSON.stringify({
            chat_id: cfg.chat_id,
            text: message,
            parse_mode: "HTML",
            disable_notification: false
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + cfg.bot_token + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => log("Telegram response: " + d.substring(0, 100)));
        });
        req.on("error", (e) => log("Telegram error: " + e.message));
        req.write(postData);
        req.end();
    } catch(e) {
        log("Error enviando Telegram: " + e.message);
    }
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
                "User-Agent": "intrale-hook",
                "Accept": "application/vnd.github.v3+json"
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve(d));
        });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

async function ensureLabelExists(token, labelName) {
    // Verificar si el label existe, si no crearlo
    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.github.com",
            path: "/repos/intrale/platform/labels/" + encodeURIComponent(labelName),
            method: "GET",
            headers: {
                "Authorization": "bearer " + token,
                "User-Agent": "intrale-hook",
                "Accept": "application/vnd.github.v3+json"
            },
            timeout: 5000
        }, (res) => {
            // Consumir el body para evitar socket hang
            res.resume();
            if (res.statusCode === 200) {
                resolve(true);
                return;
            }
            // Solo crear label si es 404 (no existe); otros errores resuelven false
            if (res.statusCode !== 404) {
                log("ensureLabelExists: status inesperado " + res.statusCode + " para label " + labelName);
                resolve(false);
                return;
            }
            // Label no existe, crearlo
            const postData = JSON.stringify({ name: labelName, color: "e4e669", description: "Issue cerrado, pendiente de verificacion QA E2E" });
            const createReq = https.request({
                hostname: "api.github.com",
                path: "/repos/intrale/platform/labels",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData),
                    "Authorization": "bearer " + token,
                    "User-Agent": "intrale-hook",
                    "Accept": "application/vnd.github.v3+json"
                },
                timeout: 5000
            }, () => resolve(true));
            createReq.on("error", () => resolve(false));
            createReq.write(postData);
            createReq.end();
        });
        req.on("error", () => resolve(false));
        req.end();
    });
}

async function moveIssueInProject(token, issueNumber, optionId) {
    // Obtener projectItemId del issue en el Project V2
    const queryStr = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){projectItems(first:10){nodes{id project{id}}}}}}";
    const data = await graphqlRequest(token, queryStr, { owner: "intrale", repo: "platform", number: issueNumber });

    const nodes = data && data.repository && data.repository.issue && data.repository.issue.projectItems && data.repository.issue.projectItems.nodes;
    if (!nodes || nodes.length === 0) {
        log("Issue #" + issueNumber + " no esta en ningun proyecto, ignorando");
        return null;
    }

    // Filtrar por el project id correcto
    const item = nodes.find(function(n) { return n.project && n.project.id === PROJECT_ID; });
    if (!item) {
        log("Issue #" + issueNumber + " no esta en el proyecto Intrale, ignorando");
        return null;
    }

    // Actualizar campo Status
    const mutationStr = "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}";
    await graphqlRequest(token, mutationStr, {
        projectId: PROJECT_ID,
        itemId: item.id,
        fieldId: FIELD_ID,
        optionId: optionId
    });

    return item.id;
}

async function processIssueClose(issueNumber, prNumber) {
    log("Procesando cierre de issue #" + issueNumber);

    const token = getGitHubToken();

    // Obtener labels del issue
    const labels = await getIssueLabels(token, issueNumber);
    log("Labels del issue #" + issueNumber + ": " + labels.join(", "));

    // Verificar si tiene label de QA que permite pasar a Done
    const hasQaPass = labels.some(function(l) { return QA_PASS_LABELS.indexOf(l) !== -1; });

    if (hasQaPass) {
        // Mover a Done normalmente
        await moveIssueInProject(token, issueNumber, DONE_OPTION_ID);
        log("Issue #" + issueNumber + " movido a Done (QA: " + labels.filter(function(l) { return QA_PASS_LABELS.indexOf(l) !== -1; }).join(",") + ")");

        appendAudit({
            ts: new Date().toISOString(),
            issue: issueNumber,
            qa_status: labels.indexOf("qa:passed") !== -1 ? "passed" : "skipped",
            pr: prNumber || null,
            action: "moved_to_done"
        });
    } else {
        // No tiene label QA — mover a QA Pending
        await moveIssueInProject(token, issueNumber, QA_PENDING_OPTION_ID);

        // Agregar label qa:pending
        await ensureLabelExists(token, "qa:pending");
        await addLabelToIssue(token, issueNumber, "qa:pending");

        log("Issue #" + issueNumber + " movido a QA Pending (sin label QA E2E)");

        appendAudit({
            ts: new Date().toISOString(),
            issue: issueNumber,
            qa_status: "pending",
            pr: prNumber || null,
            action: "moved_to_qa_pending"
        });

        // Notificar por Telegram
        sendTelegram("⚙️ Issue #" + issueNumber + " cerrado sin QA E2E — movido a <b>\"QA Pending\"</b> en lugar de Done");
    }
}

// ─── Bug 1 fix: detectar cierre de issues vía PR merge (#1266) ─────────────

/**
 * Extrae el número de PR del comando gh pr merge.
 * Retorna el número (int) si el comando es gh pr merge <N>
 * Retorna 0 si es gh pr merge sin número explícito
 * Retorna null si el comando no es gh pr merge
 */
function extractPrNumber(command) {
    if (!command || typeof command !== "string") return null;
    if (!/gh\s+pr\s+merge/.test(command)) return null;
    const match = command.match(/gh\s+pr\s+merge\s+(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extrae números de issues cerrados del body de un PR.
 * Detecta patrones: closes #N, fixes #N, resolves #N (case-insensitive)
 */
function extractIssueNumbers(prBody) {
    if (!prBody) return [];
    const issues = [];
    const pattern = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;
    let m;
    while ((m = pattern.exec(prBody)) !== null) {
        issues.push(parseInt(m[1], 10));
    }
    return issues;
}

/**
 * Obtiene datos del PR vía GraphQL.
 */
async function ghGetPr(token, prNumber) {
    const queryStr = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number,merged,merged_at,baseRefName,body}}}";
    const data = await graphqlRequest(token, queryStr, { owner: "intrale", repo: "platform", number: prNumber });
    return data && data.repository && data.repository.pullRequest;
}

/**
 * Procesa un PR mergeado: extrae issues referenciados y los mueve a Done.
 */
async function handlePrMerge(prNumber) {
    log("Procesando PR merge #" + prNumber);
    try {
        const token = getGitHubToken();
        const pr = await ghGetPr(token, prNumber);

        if (!pr) {
            log("PR #" + prNumber + " no encontrado");
            return;
        }

        // Verificar que fue mergeado (tiene merged_at)
        if (!pr.merged_at) {
            log("PR #" + prNumber + " no fue mergeado (merged_at ausente), ignorando");
            return;
        }

        // Verificar que el PR fue a main
        if (pr.baseRefName !== "main") {
            log("PR #" + prNumber + " no fue a main (base: " + pr.baseRefName + "), ignorando");
            return;
        }

        const issueNumbers = extractIssueNumbers(pr.body);
        if (issueNumbers.length === 0) {
            log("PR #" + prNumber + " no referencia issues (Closes/Fixes/Resolves), ignorando");
            return;
        }

        log("PR #" + prNumber + " cierra issues: " + issueNumbers.join(", "));

        for (let i = 0; i < issueNumbers.length; i++) {
            try {
                await processIssueClose(issueNumbers[i], prNumber);
            } catch (e) {
                log("Error procesando issue #" + issueNumbers[i] + " del PR #" + prNumber + ": " + e.message);
            }
        }
    } catch (e) {
        log("handlePrMerge error: " + e.message);
    }
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";
        const stderr = (data.tool_result && data.tool_result.stderr) || "";

        // Caso 1: gh issue close <N> — cierre explícito
        const issueMatch = command.match(/gh\s+issue\s+close\s+(\d+)/);
        if (issueMatch) {
            if (/error|rejected|denied|failed/i.test(stderr)) {
                log("gh issue close tuvo error en stderr, ignorando");
                return;
            }
            const issueNumber = parseInt(issueMatch[1], 10);
            const prMatch = command.match(/--comment.*?#(\d+)/);
            const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
            processIssueClose(issueNumber, prNumber).catch(function(e) {
                log("Error procesando cierre de issue #" + issueNumber + ": " + e.message);
            });
            return;
        }

        // Caso 2: gh pr merge <N> — issues cerrados vía Closes #N en el PR body
        const prMergeNumber = extractPrNumber(command);
        if (prMergeNumber !== null) {
            if (/error|rejected|denied|failed/i.test(stderr)) {
                log("gh pr merge tuvo error en stderr, ignorando");
                return;
            }
            if (prMergeNumber === 0) {
                log("gh pr merge sin número explícito — no se puede detectar PR, ignorando");
                return;
            }
            handlePrMerge(prMergeNumber).catch(function(e) {
                log("Error en handlePrMerge #" + prMergeNumber + ": " + e.message);
            });
        }
    } catch(e) {
        log("Error parseando input: " + e.message);
    }
}

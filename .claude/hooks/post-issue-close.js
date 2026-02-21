// Hook PostToolUse[Bash]: detecta gh issue close y mueve el issue a "Done" en Project V2
// Pure Node.js — sin dependencias externas
const { execSync } = require("child_process");
const https = require("https");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "hook-debug.log");

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";
const DONE_OPTION_ID = "98236657";

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] post-issue-close: " + msg + "\n"); } catch(e) {}
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
        const token = execSync("gh auth token", { encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000 }).trim();
        if (token) return token;
    } catch(e) {}
    // Fallback: git credential fill
    const credInput = "protocol=https\nhost=github.com\n\n";
    const result = execSync("git credential fill", { input: credInput, encoding: "utf8", cwd: PROJECT_DIR, timeout: 5000 });
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

async function moveIssueToDone(issueNumber) {
    log("Moviendo issue #" + issueNumber + " a Done");

    const token = getGitHubToken();

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

    // Actualizar campo Status a "Done"
    const mutationStr = "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}";
    await graphqlRequest(token, mutationStr, {
        projectId: PROJECT_ID,
        itemId: item.id,
        fieldId: FIELD_ID,
        optionId: DONE_OPTION_ID
    });

    log("Issue #" + issueNumber + " movido a Done exitosamente");
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
        moveIssueToDone(issueNumber).catch(function(e) {
            log("Error moviendo issue #" + issueNumber + " a Done: " + e.message);
        });
    } catch(e) {
        log("Error parseando input: " + e.message);
    }
}

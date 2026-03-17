#!/usr/bin/env node
// sprint-tagger.js — Crea tag Git anotado al cerrar un sprint
// Uso: node scripts/sprint-tagger.js [path-to-sprint-plan.json]
// Comportamiento: SIEMPRE crea el tag sprint/YYYY-MM-DD — sin condiciones.
// Fail-open: errores no fatales quedan en logs sin interrumpir el flujo.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "sprint-tagger.log");

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch (e) { /* ignore */ }
    console.log(`[sprint-tagger] ${msg}`);
}

function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 30000, ...opts }).trim();
    } catch (e) {
        log(`execSafe failed: ${cmd.substring(0, 120)} → ${e.message}`);
        return null;
    }
}

// --- Telegram ---
function sendTelegram(message) {
    try {
        const cfgPath = path.join(REPO_ROOT, ".claude", "hooks", "telegram-config.json");
        if (!fs.existsSync(cfgPath)) { log("telegram-config.json no encontrado — skip notificación"); return; }
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
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 10000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => log("Telegram response: " + d.substring(0, 100)));
        });
        req.on("error", (e) => log("Telegram error: " + e.message));
        req.write(postData);
        req.end();
    } catch (e) {
        log("Error enviando Telegram: " + e.message);
    }
}

// --- GitHub: obtener info de issues ---
function getIssueDetails(issueNumber) {
    const raw = execSafe(
        `"${GH_PATH}" issue view ${issueNumber} --repo intrale/platform --json title,labels,state`
    );
    if (!raw) return { title: `Issue #${issueNumber}`, labels: [], state: "UNKNOWN" };
    try { return JSON.parse(raw); } catch (e) { return { title: `Issue #${issueNumber}`, labels: [], state: "UNKNOWN" }; }
}

// --- Categorizar issues por labels ---
function categorizeIssue(labels) {
    const names = (labels || []).map(l => (l.name || "").toLowerCase());
    if (names.some(n => n.includes("bug") || n.includes("fix"))) return "fix";
    if (names.some(n => n.includes("feat") || n.includes("feature") || n.includes("enhancement"))) return "feature";
    if (names.some(n => n.includes("infra") || n.includes("tipo:infra") || n.includes("area:infra"))) return "infra";
    if (names.some(n => n.includes("doc"))) return "docs";
    if (names.some(n => n.includes("refactor"))) return "refactor";
    return "other";
}

function categoryLabel(cat) {
    const map = {
        feature: "Features",
        fix: "Fixes",
        infra: "Infrastructure",
        docs: "Documentation",
        refactor: "Refactoring",
        other: "Otros"
    };
    return map[cat] || cat;
}

// --- Construir mensaje del tag ---
function buildTagMessage(sprintDate, issues) {
    const grouped = {};
    for (const iss of issues) {
        const cat = categorizeIssue(iss.labels);
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(iss);
    }

    const ORDER = ["feature", "fix", "infra", "docs", "refactor", "other"];
    const lines = [];
    lines.push(`Sprint ${sprintDate} — cierre`);
    lines.push("");

    const issueNums = issues.map(i => `#${i.number}`).join(", ");
    lines.push(`Issues cerrados: ${issueNums || "ninguno"}`);
    lines.push("");

    for (const cat of ORDER) {
        if (!grouped[cat] || grouped[cat].length === 0) continue;
        lines.push(`## ${categoryLabel(cat)} (${grouped[cat].length})`);
        for (const iss of grouped[cat]) {
            lines.push(`- #${iss.number}: ${iss.title}`);
        }
        lines.push("");
    }

    return lines.join("\n").trim();
}

// --- Verificar si el tag ya existe ---
function tagExists(tagName) {
    const result = execSafe(`git tag -l "${tagName}"`, { cwd: REPO_ROOT });
    return result !== null && result.trim() === tagName;
}

// --- Main ---
async function main() {
    log("=== sprint-tagger.js iniciado ===");

    // SEGURIDAD: Solo ejecutar desde main branch (tags de sprint se crean solo en main)
    const currentBranch = execSafe(`git branch --show-current`, { cwd: REPO_ROOT });
    if (currentBranch !== "main") {
        log(`SEGURIDAD: Ejecutado desde rama '${currentBranch}' — abortando. Tags de sprint solo se crean desde 'main'.`);
        console.log(`Sprint tags can only be created from 'main' branch, not '${currentBranch}'.`);
        process.exit(0);
    }

    // Leer sprint plan
    const planPath = process.argv[2] || path.join(__dirname, "sprint-plan.json");
    let plan;
    try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    } catch (e) {
        log(`Error leyendo sprint plan: ${e.message} — abortando`);
        process.exit(0); // fail-open
    }

    if (!plan) {
        log("Plan nulo — abortando");
        process.exit(0);
    }

    // Fecha de cierre del sprint (derivada de closed_at o started_at)
    const sprintDate = (plan.closed_at || plan.started_at || "").split("T")[0] || new Date().toISOString().split("T")[0];
    const sprintId = plan.sprint_id || null;
    const tagName = sprintId ? `sprint/${sprintId}` : `sprint/${sprintDate}`;

    log(`Sprint: ${sprintId || "sin ID"}, fecha cierre: ${sprintDate}, tag: ${tagName}`);

    // Verificar si el tag ya existe
    if (tagExists(tagName)) {
        log(`Tag ${tagName} ya existe — saltando creación`);
        console.log(`Tag ${tagName} ya existe.`);
        return;
    }

    // Obtener issues cerrados (agentes + _completed del sprint actual, no sprint_prev)
    const allAgentes = [
        ...(plan.agentes || []),
        ...((plan._completed || []).filter(a => !a.sprint_prev))
    ];

    log(`Recopilando info de ${allAgentes.length} issues...`);

    const issues = [];
    for (const ag of allAgentes) {
        const info = getIssueDetails(ag.issue);
        issues.push({
            number: ag.issue,
            title: info.title || ag.titulo || `Issue #${ag.issue}`,
            labels: info.labels || [],
            state: info.state
        });
    }

    // Construir mensaje del tag
    const tagMessage = buildTagMessage(sprintDate, issues);
    log(`Mensaje del tag:\n${tagMessage}`);

    // Crear tag anotado
    const tagMsgFile = path.join(LOG_DIR, `tag-msg-${sprintDate}.txt`);
    ensureDir(LOG_DIR);
    fs.writeFileSync(tagMsgFile, tagMessage, "utf8");

    const tagResult = execSafe(
        `git tag -a "${tagName}" -F "${tagMsgFile}"`,
        { cwd: REPO_ROOT }
    );

    if (tagResult === null) {
        log(`Error creando tag ${tagName}`);
        // No hacer exit 1 — fail-open para no interrumpir sprint-report
        return;
    }

    log(`Tag ${tagName} creado exitosamente`);

    // Push del tag a origin
    const pushResult = execSafe(`git push origin "${tagName}"`, { cwd: REPO_ROOT });
    if (pushResult === null) {
        log(`Error pusheando tag ${tagName} — tag existe localmente`);
    } else {
        log(`Tag ${tagName} pusheado a origin`);
    }

    // Limpiar archivo temporal
    try { fs.unlinkSync(tagMsgFile); } catch (e) { /* ignore */ }

    // Notificación Telegram — informativa, no consultiva
    const closedCount = issues.filter(i => i.state === "CLOSED").length;
    const sprintLabel = sprintId ? `${sprintId} — ` : "";
    const telegram = [
        `🏷️ <b>Sprint tag creado: <code>${tagName}</code></b>`,
        "",
        `📋 <b>${sprintLabel}Sprint ${sprintDate}</b>`,
        `✅ Issues cerrados: ${closedCount}/${issues.length}`,
        "",
        issues.length > 0
            ? `<b>Issues:</b> ${issues.slice(0, 8).map(i => `#${i.number}`).join(", ")}${issues.length > 8 ? ` y ${issues.length - 8} más` : ""}`
            : "Sin issues registrados",
        "",
        `<code>git tag -l 'sprint/*' --sort=-v:refname</code> para consultar historial`
    ].join("\n");

    sendTelegram(telegram);
    log("Notificación Telegram enviada");
    log("=== sprint-tagger.js completado ===");
}

main().catch(e => {
    log("ERROR FATAL: " + e.message + "\n" + e.stack);
    process.exit(0); // fail-open
});

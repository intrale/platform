#!/usr/bin/env node
// evaluate-and-release.js — Evalúa autónomamente si corresponde crear una release
// El agente decide y ejecuta sin pedir aprobación.
// Uso: node scripts/evaluate-and-release.js [path-to-sprint-plan.json]
// Fail-open: errores no fatales quedan en logs sin interrumpir el flujo.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "evaluate-release.log");
const RELEASE_HISTORY_FILE = path.join(REPO_ROOT, ".release-history.json");

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch (e) { /* ignore */ }
    console.log(`[evaluate-release] ${msg}`);
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
        if (!fs.existsSync(cfgPath)) { log("telegram-config.json no encontrado — skip"); return; }
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

// --- Semver ---
function parseVersion(tag) {
    const match = (tag || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]), raw: tag };
}

function bumpVersion(current, type) {
    if (!current) {
        // Sin releases previas: versión inicial
        return type === "major" ? "v1.0.0" : type === "minor" ? "v0.1.0" : "v0.0.1";
    }
    const { major, minor, patch } = current;
    if (type === "major") return `v${major + 1}.0.0`;
    if (type === "minor") return `v${major}.${minor + 1}.0`;
    return `v${major}.${minor}.${patch + 1}`;
}

// --- Obtener última release ---
function getLastRelease() {
    const raw = execSafe(`git tag -l 'v*' --sort=-v:refname`, { cwd: REPO_ROOT });
    if (!raw) return null;
    const tags = raw.split("\n").filter(t => t.trim() && /^v\d+\.\d+\.\d+/.test(t.trim()));
    return tags.length > 0 ? parseVersion(tags[0]) : null;
}

// --- Obtener commits desde la última release ---
function getCommitsSinceRelease(lastRelease) {
    let rangeCmd;
    if (!lastRelease) {
        rangeCmd = `git log --oneline --no-decorate --max-count=200`;
    } else {
        rangeCmd = `git log ${lastRelease.raw}..HEAD --oneline --no-decorate --max-count=200`;
    }
    const raw = execSafe(rangeCmd, { cwd: REPO_ROOT });
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => {
        const [hash, ...rest] = line.split(" ");
        return { hash: hash.trim(), message: rest.join(" ").trim() };
    });
}

// --- Obtener sprint tags desde la última release ---
function getSprintTagsSinceRelease(lastRelease) {
    let rangeCmd;
    if (!lastRelease) {
        rangeCmd = `git tag -l 'sprint/*' --sort=-v:refname`;
    } else {
        rangeCmd = `git log ${lastRelease.raw}..HEAD --decorate --simplify-by-decoration --oneline --no-walk=sorted`;
    }
    const tagsRaw = execSafe(`git tag -l 'sprint/*' --sort=v:refname`, { cwd: REPO_ROOT }) || "";
    return tagsRaw.split("\n").filter(Boolean);
}

// --- Categorizar commit por mensaje convencional ---
function categorizeCommit(message) {
    const lower = message.toLowerCase();
    if (/^feat(\(.+?\))?!?:/.test(lower) || /breaking change/i.test(lower)) return "breaking";
    if (/^feat(\(.+?\))?:/.test(lower)) return "feature";
    if (/^fix(\(.+?\))?:/.test(lower)) return "fix";
    if (/^docs?(\(.+?\))?:/.test(lower)) return "docs";
    if (/^refactor(\(.+?\))?:/.test(lower)) return "refactor";
    if (/^(chore|infra|ci|build|style|test)(\(.+?\))?:/.test(lower)) return "infra";
    if (/^perf(\(.+?\))?:/.test(lower)) return "perf";
    return "other";
}

// --- Heurística de decisión de release ---
/**
 * Evalúa si corresponde crear una release y qué tipo.
 * Retorna: { shouldRelease: bool, type: 'major'|'minor'|'patch'|null, reason: string }
 */
function evaluateRelease(commits) {
    const categories = { breaking: [], feature: [], fix: [], perf: [], docs: [], refactor: [], infra: [], other: [] };

    for (const c of commits) {
        const cat = categorizeCommit(c.message);
        categories[cat].push(c);
    }

    log(`Categorías de commits: ${JSON.stringify(Object.fromEntries(
        Object.entries(categories).map(([k, v]) => [k, v.length])
    ))}`);

    // Breaking changes → release major
    if (categories.breaking.length > 0) {
        return {
            shouldRelease: true,
            type: "major",
            reason: `${categories.breaking.length} breaking change(s) detectados`,
            categories
        };
    }

    // 3+ features de producto → release minor
    const productFeatures = categories.feature.length + categories.perf.length;
    if (productFeatures >= 3) {
        return {
            shouldRelease: true,
            type: "minor",
            reason: `${productFeatures} features de producto (mínimo 3 para release minor)`,
            categories
        };
    }

    // 5+ fixes acumulados → release patch
    if (categories.fix.length >= 5) {
        return {
            shouldRelease: true,
            type: "patch",
            reason: `${categories.fix.length} fixes acumulados (mínimo 5 para release patch)`,
            categories
        };
    }

    // Solo infra/docs/refactor → no release
    const nonReleaseOnly = categories.infra.length + categories.docs.length + categories.refactor.length + categories.other.length;
    const releaseRelevant = productFeatures + categories.fix.length;
    if (nonReleaseOnly > 0 && releaseRelevant === 0) {
        return {
            shouldRelease: false,
            type: null,
            reason: `Solo cambios de infra/docs/refactor (${nonReleaseOnly} commits) — sin impacto en producto`,
            categories
        };
    }

    // Insuficiente masa crítica
    return {
        shouldRelease: false,
        type: null,
        reason: `Masa insuficiente: ${categories.feature.length} features (necesita 3+), ${categories.fix.length} fixes (necesita 5+)`,
        categories
    };
}

// --- Construir changelog ---
function buildChangelog(commits, lastRelease, categories) {
    const lines = [];
    const currentDate = new Date().toISOString().split("T")[0];
    lines.push(`Changelog — generado automáticamente el ${currentDate}`);
    lines.push("");
    if (lastRelease) {
        lines.push(`Cambios desde ${lastRelease.raw}:`);
    } else {
        lines.push("Cambios iniciales del proyecto:");
    }
    lines.push("");

    const ORDER = [
        ["breaking", "Breaking Changes"],
        ["feature", "Features"],
        ["fix", "Fixes"],
        ["perf", "Mejoras de rendimiento"],
        ["docs", "Documentación"],
        ["refactor", "Refactoring"],
        ["infra", "Infraestructura"],
    ];

    for (const [cat, label] of ORDER) {
        const items = (categories[cat] || []).filter(c => c.message);
        if (items.length === 0) continue;
        lines.push(`## ${label} (${items.length})`);
        for (const c of items.slice(0, 30)) {
            lines.push(`- ${c.message.substring(0, 120)}`);
        }
        if (items.length > 30) lines.push(`- ... y ${items.length - 30} más`);
        lines.push("");
    }

    lines.push(`Total commits: ${commits.length}`);

    return lines.join("\n").trim();
}

// --- Leer/escribir release history ---
function loadReleaseHistory() {
    try {
        if (fs.existsSync(RELEASE_HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(RELEASE_HISTORY_FILE, "utf8"));
        }
    } catch (e) { /* ignore */ }
    return { releases: [] };
}

function saveReleaseHistory(history) {
    try {
        fs.writeFileSync(RELEASE_HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
    } catch (e) { log("Error guardando release-history: " + e.message); }
}

// --- Main ---
async function main() {
    log("=== evaluate-and-release.js iniciado ===");

    // SEGURIDAD: Solo ejecutar desde main branch
    const currentBranch = execSafe(`git branch --show-current`, { cwd: REPO_ROOT });
    if (currentBranch !== "main") {
        log(`SEGURIDAD: Ejecutado desde rama '${currentBranch}' — abortando. Las releases solo se crean desde 'main'.`);
        console.log(`Releases can only be created from 'main' branch, not '${currentBranch}'.`);
        process.exit(0);
    }

    // Leer sprint plan (para contexto)
    const planPath = process.argv[2] || path.join(__dirname, "sprint-plan.json");
    let plan = null;
    try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    } catch (e) {
        log(`Sprint plan no disponible: ${e.message} — continuando sin él`);
    }

    const sprintDate = plan?.fechaFin || plan?.fecha || new Date().toISOString().split("T")[0];
    const sprintId = plan?.sprint_id || null;
    const sprintTag = `sprint/${sprintDate}`;

    // Obtener última release
    const lastRelease = getLastRelease();
    log(`Última release: ${lastRelease ? lastRelease.raw : "ninguna (primera release)"}`);

    // Obtener commits desde la última release
    const commits = getCommitsSinceRelease(lastRelease);
    log(`Commits desde última release: ${commits.length}`);

    if (commits.length === 0) {
        log("Sin commits nuevos desde la última release — no se crea release");
        const msg = [
            `ℹ️ <b>${sprintId || "Sprint"} ${sprintDate} cerrado</b>`,
            `Sin release — 0 commits desde ${lastRelease ? lastRelease.raw : "el inicio"}.`
        ].join("\n");
        sendTelegram(msg);
        return;
    }

    // Evaluar si corresponde release
    const decision = evaluateRelease(commits);
    log(`Decisión: shouldRelease=${decision.shouldRelease}, type=${decision.type}, reason=${decision.reason}`);

    if (!decision.shouldRelease) {
        log(`Sin release — ${decision.reason}`);
        const msg = [
            `ℹ️ <b>${sprintId || "Sprint"} ${sprintDate} cerrado.</b>`,
            `Sin release — ${decision.reason}.`,
            "",
            `Sprint tag: <code>${sprintTag}</code>`,
            lastRelease ? `Última release: <code>${lastRelease.raw}</code>` : "Sin releases previas."
        ].join("\n");
        sendTelegram(msg);
        return;
    }

    // Determinar nueva versión
    const newVersion = bumpVersion(lastRelease, decision.type);
    log(`Nueva versión: ${newVersion} (tipo: ${decision.type})`);

    // Verificar que el tag no exista
    const tagExists = execSafe(`git tag -l "${newVersion}"`, { cwd: REPO_ROOT });
    if (tagExists === newVersion) {
        log(`Tag ${newVersion} ya existe — saltando`);
        return;
    }

    // Construir changelog
    const changelog = buildChangelog(commits, lastRelease, decision.categories);
    log(`Changelog generado (${changelog.length} chars)`);

    // Crear tag anotado
    const tagMsgFile = path.join(LOG_DIR, `release-msg-${newVersion}.txt`);
    ensureDir(LOG_DIR);
    fs.writeFileSync(tagMsgFile, changelog, "utf8");

    const tagResult = execSafe(
        `git tag -a "${newVersion}" -F "${tagMsgFile}"`,
        { cwd: REPO_ROOT }
    );

    if (tagResult === null) {
        log(`Error creando tag ${newVersion} — abortando release`);
        try { fs.unlinkSync(tagMsgFile); } catch (e) { /* ignore */ }
        return;
    }

    log(`Tag ${newVersion} creado`);

    // Push del tag
    const pushResult = execSafe(`git push origin "${newVersion}"`, { cwd: REPO_ROOT });
    if (pushResult === null) {
        log(`Error pusheando ${newVersion} — tag existe localmente solamente`);
    } else {
        log(`Tag ${newVersion} pusheado a origin`);
    }

    // Limpiar archivo temporal
    try { fs.unlinkSync(tagMsgFile); } catch (e) { /* ignore */ }

    // Guardar en release history
    const history = loadReleaseHistory();
    history.releases.push({
        version: newVersion,
        date: sprintDate,
        sprint: sprintId,
        sprintTag,
        type: decision.type,
        reason: decision.reason,
        commitsCount: commits.length,
        lastRelease: lastRelease ? lastRelease.raw : null,
        createdAt: new Date().toISOString()
    });
    saveReleaseHistory(history);

    // Notificación Telegram — informativa, no consultiva
    const sprintTags = getSprintTagsSinceRelease(lastRelease);
    const msg = [
        `🏷️ <b>Release ${newVersion} creada automáticamente</b>`,
        "",
        `📋 Razón: ${decision.reason}`,
        `📊 Commits: ${commits.length} | Tipo: ${decision.type.toUpperCase()}`,
        "",
        lastRelease ? `Cambios desde: <code>${lastRelease.raw}</code>` : "Primera release del proyecto",
        sprintTags.length > 0 ? `Sprint tags incluidos: ${sprintTags.slice(-3).join(", ")}` : "",
        "",
        `<b>Categorías:</b>`,
        decision.categories.breaking.length > 0 ? `  ⚠️ Breaking: ${decision.categories.breaking.length}` : null,
        decision.categories.feature.length > 0 ? `  ✨ Features: ${decision.categories.feature.length}` : null,
        decision.categories.fix.length > 0 ? `  🐛 Fixes: ${decision.categories.fix.length}` : null,
        decision.categories.infra.length > 0 ? `  🔧 Infra: ${decision.categories.infra.length}` : null,
        "",
        `<code>git tag -l 'v*' --sort=-v:refname</code>`
    ].filter(l => l !== null).join("\n");

    sendTelegram(msg);
    log(`Notificación Telegram enviada — release ${newVersion}`);
    log("=== evaluate-and-release.js completado ===");
}

main().catch(e => {
    log("ERROR FATAL: " + e.message + "\n" + e.stack);
    process.exit(0); // fail-open
});

// auto-review-bg.js — Auto-review de PRs abiertos >24h sin review (#1516)
// Detecta PRs sin review comments y ejecuta análisis estático automático.
// Postea findings como comentario en el PR y notifica por Telegram.
// Se ejecuta como hook Stop con cooldown de 60 minutos.
//
// Checks automatizados (basados en CLAUDE.md + /review SKILL.md):
//   - Patrones de strings prohibidos (stringResource, Res.string, etc.)
//   - Logger faltante en clases nuevas
//   - Ausencia de archivos de test (TDD)
//   - PR sin descripción
//   - Estado CI
//
// Pure Node.js — sin dependencias externas (gh CLI via spawnSync)

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const STATE_FILE = path.join(HOOKS_DIR, "auto-review-state.json");

const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const GH_REPO = "intrale/platform";

// Cooldown: verificar como máximo cada 60 minutos
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Umbral de antigüedad: PRs abiertos más de 24 horas
const MIN_AGE_HOURS = 24;

// Máximo de PRs a revisar por ejecución (evitar timeouts)
const MAX_PER_RUN = 3;

// Marker para identificar comentarios de auto-review ya posteados
const REVIEW_MARKER = "Revisado por Review Bot (Claude Code)";

// Patrones prohibidos según CLAUDE.md — solo en líneas añadidas (+)
const FORBIDDEN_PATTERNS = [
    {
        pattern: /stringResource\s*\(/,
        description: "Uso directo de stringResource() fuera de ui/util/ResStrings",
        severity: "BLOQUEANTE",
        onlyIn: /\/ui\//
    },
    {
        pattern: /Res\.string\./,
        description: "Uso directo de Res.string.* (usar resString() wrapper)",
        severity: "BLOQUEANTE",
        onlyIn: null // cualquier archivo Kotlin
    },
    {
        pattern: /R\.string\./,
        description: "Uso directo de R.string.* (usar resString() wrapper)",
        severity: "BLOQUEANTE",
        onlyIn: null
    },
    {
        pattern: /\bgetString\s*\(/,
        description: "Uso directo de getString() (usar resString() wrapper)",
        severity: "BLOQUEANTE",
        onlyIn: /\/ui\//
    },
    {
        pattern: /import kotlin\.io\.encoding\.Base64/,
        description: "Import prohibido de kotlin.io.encoding.Base64 en capa UI",
        severity: "BLOQUEANTE",
        onlyIn: /\/ui\//
    }
];

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] AutoReview: " + msg + "\n");
    } catch (e) {}
}

// ─── Estado persistente ───────────────────────────────────────────────────────

function readState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        }
    } catch (e) {}
    return { reviewed_prs: {}, last_check: 0 };
}

function writeState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {}
}

// ─── gh CLI helpers ───────────────────────────────────────────────────────────

function getGhBin() {
    return fs.existsSync(GH_PATH) ? GH_PATH : "gh";
}

function ghExec(args, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    try {
        const result = spawnSync(getGhBin(), args, {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            env: Object.assign({}, process.env)
        });
        if (result.status !== 0) {
            const stderr = (result.stderr || "").trim().substring(0, 300);
            log("gh error (args=" + args.slice(0, 3).join(" ") + "): " + stderr);
            return null;
        }
        return result.stdout || "";
    } catch (e) {
        log("ghExec exception: " + e.message);
        return null;
    }
}

function ghJson(args, timeoutMs) {
    const raw = ghExec(args, timeoutMs);
    if (raw === null) return null;
    try {
        return JSON.parse(raw.trim());
    } catch (e) {
        log("ghJson parse error: " + e.message);
        return null;
    }
}

// ─── Telegram ────────────────────────────────────────────────────────────────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) {}

async function notify(text) {
    if (tgClient) {
        try { await tgClient.sendMessage(text); return; } catch (e) { log("tgClient error: " + e.message); }
    }
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json"), "utf8"));
        const https = require("https");
        const postData = JSON.stringify({ chat_id: cfg.chat_id, text: text, parse_mode: "HTML" });
        await new Promise((resolve) => {
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + cfg.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                timeout: 8000
            }, (res) => { res.resume(); resolve(); });
            req.on("error", resolve);
            req.on("timeout", () => { req.destroy(); resolve(); });
            req.write(postData);
            req.end();
        });
    } catch (e) { log("notify fallback error: " + e.message); }
}

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Helpers de tiempo ────────────────────────────────────────────────────────

function isOlderThan(createdAt, hours) {
    if (!createdAt) return false;
    const diffHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
    return diffHours >= hours;
}

function hoursAgo(createdAt) {
    if (!createdAt) return "?";
    return Math.round((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60));
}

// ─── Verificar si PR ya fue revisado ─────────────────────────────────────────

function prAlreadyReviewed(state, prNumber) {
    return Boolean(state.reviewed_prs[String(prNumber)]);
}

/**
 * Verifica si el PR ya tiene un comentario de auto-review via API.
 * Evita duplicar comentarios ante reinicios de estado.
 */
function hasExistingReviewComment(prNumber) {
    const data = ghJson([
        "pr", "view", String(prNumber),
        "--repo", GH_REPO,
        "--json", "comments"
    ], 15000);
    if (!data || !Array.isArray(data.comments)) return false;
    return data.comments.some(c => (c.body || "").includes(REVIEW_MARKER));
}

// ─── Análisis del diff ────────────────────────────────────────────────────────

function analyzeDiff(diff) {
    const findings = { blockers: [], warnings: [], info: [] };

    if (!diff || diff.trim().length === 0) {
        findings.warnings.push("No se pudo obtener el diff del PR o el diff está vacío");
        return findings;
    }

    const lines = diff.split("\n");
    let currentFile = "";
    let lineNumber = 0;
    let addedLinesCount = 0;
    let hasTestFiles = false;
    let hasKotlinFiles = false;
    let newClassesWithoutLogger = [];
    let currentFileAddedLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detectar archivo actual
        if (line.startsWith("+++ b/")) {
            // Verificar logger en archivo anterior si era Kotlin
            if (currentFile.endsWith(".kt") && currentFileAddedLines.length > 0) {
                checkLoggerInFile(currentFile, currentFileAddedLines, newClassesWithoutLogger);
            }
            currentFile = line.substring(6);
            currentFileAddedLines = [];
            lineNumber = 0;

            if (currentFile.endsWith("Test.kt") || currentFile.endsWith("Tests.kt") ||
                currentFile.includes("/test/")) {
                hasTestFiles = true;
            }
            if (currentFile.endsWith(".kt")) {
                hasKotlinFiles = true;
            }
            continue;
        }

        // Actualizar número de línea desde hunk header
        if (line.startsWith("@@")) {
            const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
            if (match) lineNumber = parseInt(match[1]) - 1;
            continue;
        }

        if (line.startsWith("+") && !line.startsWith("+++")) {
            lineNumber++;
            addedLinesCount++;
            const content = line.substring(1);
            currentFileAddedLines.push({ lineNum: lineNumber, content });

            // Verificar patrones prohibidos en líneas añadidas
            if (currentFile.endsWith(".kt")) {
                for (const fp of FORBIDDEN_PATTERNS) {
                    if (fp.onlyIn && !fp.onlyIn.test(currentFile)) continue;
                    if (fp.pattern.test(content)) {
                        findings.blockers.push({
                            file: currentFile,
                            line: lineNumber,
                            description: fp.description,
                            severity: fp.severity,
                            code: content.trim().substring(0, 120)
                        });
                    }
                }
            }
        } else if (!line.startsWith("-")) {
            lineNumber++;
        }
    }

    // Verificar logger en el último archivo
    if (currentFile.endsWith(".kt") && currentFileAddedLines.length > 0) {
        checkLoggerInFile(currentFile, currentFileAddedLines, newClassesWithoutLogger);
    }

    // Warning: sin archivos de test (solo si hay código Kotlin de producción)
    if (hasKotlinFiles && !hasTestFiles) {
        findings.warnings.push(
            "Sin archivos de test en el diff — verificar cobertura (TDD: los tests deben ir primero)"
        );
    }

    // Warning: clases sin logger
    for (const cls of newClassesWithoutLogger) {
        findings.warnings.push(
            "Clase nueva `" + cls + "` sin logger — agregar LoggerFactory según CLAUDE.md"
        );
    }

    // Info: diff grande
    if (addedLinesCount > 500) {
        findings.info.push(
            "Diff grande: +" + addedLinesCount + " líneas — considerar dividir en PRs más pequeños"
        );
    }

    return findings;
}

/**
 * Verifica si un archivo Kotlin nuevo que define clases tiene logger.
 * Detecta `class Foo` / `object Foo` sin `LoggerFactory` en las líneas añadidas.
 */
function checkLoggerInFile(filePath, addedLines, missingList) {
    // Solo archivos de producción (no test, no buildSrc, no hooks)
    if (filePath.includes("/test/") || filePath.endsWith("Test.kt") ||
        filePath.includes("buildSrc") || filePath.includes(".claude")) {
        return;
    }

    const allContent = addedLines.map(l => l.content).join("\n");

    // Buscar definiciones de clases/objects
    const classMatches = allContent.match(/^(?:class|object|abstract class|open class|data class|sealed class)\s+(\w+)/m);
    if (!classMatches) return;

    const className = classMatches[1];

    // Verificar si hay LoggerFactory en el diff de este archivo
    const hasLogger = /LoggerFactory/i.test(allContent);
    if (!hasLogger) {
        missingList.push(className);
    }
}

// ─── Obtener estado CI legible ────────────────────────────────────────────────

function getCiStatusText(prDetail) {
    if (!prDetail) return "❓ No disponible";
    const mss = (prDetail.mergeStateStatus || "").toUpperCase();
    if (mss === "CLEAN") return "✅ Verde";
    if (mss === "DIRTY") return "⚠️ Conflictos de merge";
    if (mss === "BLOCKED") return "🔴 Bloqueado";
    if (mss === "UNSTABLE") return "🟡 Inestable";
    return "❓ " + (prDetail.mergeStateStatus || "Desconocido");
}

// ─── Construir comentario de review ──────────────────────────────────────────

function buildReviewComment(prNumber, prTitle, findings, ciStatusText, ageHours) {
    const hasBlockers = findings.blockers.length > 0;
    const verdict = hasBlockers ? "RECHAZADO" : "APROBADO";
    const icon = hasBlockers ? "❌" : "✅";

    let comment = `## Code Review Automático — ${icon} ${verdict}\n\n`;
    comment += `### Resumen\n`;
    comment += `- **PR:** #${prNumber} — ${prTitle}\n`;
    comment += `- **CI:** ${ciStatusText}\n`;
    comment += `- **Antigüedad:** ~${ageHours}h sin review\n`;
    comment += `- **Análisis:** estático automático (PR abierto >${MIN_AGE_HOURS}h)\n\n`;

    if (findings.blockers.length > 0) {
        comment += `### ❌ BLOQUEANTES (${findings.blockers.length})\n\n`;
        for (const b of findings.blockers) {
            comment += `- **${b.severity}** \`${b.file}:${b.line}\` — ${b.description}\n`;
            if (b.code) {
                comment += `  \`\`\`kotlin\n  ${b.code}\n  \`\`\`\n`;
            }
        }
        comment += "\n";
    }

    if (findings.warnings.length > 0) {
        comment += `### ⚠️ WARNINGS (${findings.warnings.length})\n\n`;
        for (const w of findings.warnings) {
            comment += `- ${w}\n`;
        }
        comment += "\n";
    }

    if (findings.info.length > 0) {
        comment += `### ℹ️ INFO\n\n`;
        for (const item of findings.info) {
            comment += `- ${item}\n`;
        }
        comment += "\n";
    }

    if (findings.blockers.length === 0 && findings.warnings.length === 0 && findings.info.length === 0) {
        comment += `> ✅ Sin hallazgos en análisis estático. Verificar manualmente la lógica de negocio.\n\n`;
    } else if (!hasBlockers) {
        comment += `> PR sin bloqueantes críticos. Revisar warnings antes del merge.\n\n`;
    } else {
        comment += `> **${findings.blockers.length} bloqueante(s) a corregir antes del merge.** Ver detalle arriba.\n\n`;
    }

    comment += `---\n*${REVIEW_MARKER} · ${new Date().toISOString()}*`;
    return comment;
}

// ─── Revisar un PR individual ────────────────────────────────────────────────

async function reviewPR(pr, state) {
    const prNum = pr.number;
    const prTitle = (pr.title || "").substring(0, 100);
    const ageHours = hoursAgo(pr.createdAt);

    log("Revisando PR #" + prNum + " (" + ageHours + "h) · " + prTitle);

    // Obtener detalles: CI + body
    const prDetail = ghJson([
        "pr", "view", String(prNum),
        "--repo", GH_REPO,
        "--json", "mergeStateStatus,statusCheckRollup,body,mergeable"
    ], 15000);

    const ciStatusText = getCiStatusText(prDetail);

    // Obtener diff
    const diff = ghExec([
        "pr", "diff", String(prNum),
        "--repo", GH_REPO
    ], 30000);

    // Analizar diff
    const findings = analyzeDiff(diff);

    // Warning adicional: PR sin descripción
    if (prDetail && !(prDetail.body || "").trim()) {
        findings.warnings.push("PR sin descripción — agregar contexto del cambio en el body");
    }

    // Construir comentario
    const comment = buildReviewComment(prNum, prTitle, findings, ciStatusText, ageHours);

    // Postear comentario en el PR
    const result = ghExec([
        "pr", "comment", String(prNum),
        "--repo", GH_REPO,
        "--body", comment
    ], 20000);

    if (result !== null) {
        log("Review posteado en PR #" + prNum + ": " + findings.blockers.length + " bloqueantes, " + findings.warnings.length + " warnings");

        // Persistir en estado
        state.reviewed_prs[String(prNum)] = {
            reviewed_at: new Date().toISOString(),
            verdict: findings.blockers.length > 0 ? "RECHAZADO" : "APROBADO",
            blockers: findings.blockers.length,
            warnings: findings.warnings.length,
            title: prTitle
        };

        return {
            number: prNum,
            title: prTitle,
            verdict: findings.blockers.length > 0 ? "RECHAZADO" : "APROBADO",
            blockers: findings.blockers.length,
            warnings: findings.warnings.length,
            ageHours
        };
    } else {
        log("Error al postear review en PR #" + prNum);
        return null;
    }
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function runAutoReview() {
    const state = readState();
    const now = Date.now();

    // Verificar cooldown
    if (state.last_check && (now - state.last_check) < CHECK_INTERVAL_MS) {
        const remaining = Math.round((CHECK_INTERVAL_MS - (now - state.last_check)) / 60000);
        log("Cooldown activo — próximo check en " + remaining + " min");
        return;
    }

    log("Iniciando auto-review (PRs abiertos >" + MIN_AGE_HOURS + "h)...");

    // Listar PRs abiertos
    const prs = ghJson([
        "pr", "list",
        "--state", "open",
        "--repo", GH_REPO,
        "--json", "number,title,headRefName,createdAt,labels",
        "--limit", "50"
    ], 20000);

    if (!prs) {
        log("No se pudo obtener PRs — abortando");
        state.last_check = now;
        writeState(state);
        return;
    }

    if (prs.length === 0) {
        log("Sin PRs abiertos");
        state.last_check = now;
        writeState(state);
        return;
    }

    // Filtrar por antigüedad >24h
    const oldPrs = prs.filter(pr => isOlderThan(pr.createdAt, MIN_AGE_HOURS));
    log("PRs totales: " + prs.length + " · >" + MIN_AGE_HOURS + "h: " + oldPrs.length);

    if (oldPrs.length === 0) {
        log("Sin PRs con >" + MIN_AGE_HOURS + "h de antigüedad");
        state.last_check = now;
        writeState(state);
        return;
    }

    // Filtrar los que ya tienen review (en estado o en GitHub)
    const pending = [];
    for (const pr of oldPrs) {
        if (prAlreadyReviewed(state, pr.number)) {
            log("PR #" + pr.number + " ya revisado — skip");
            continue;
        }
        if (hasExistingReviewComment(pr.number)) {
            log("PR #" + pr.number + " ya tiene comentario de auto-review — marcando");
            state.reviewed_prs[String(pr.number)] = {
                reviewed_at: new Date().toISOString(),
                verdict: "external",
                note: "Comentario de review existente"
            };
            continue;
        }
        pending.push(pr);
    }

    log("Pendientes de review: " + pending.length);

    if (pending.length === 0) {
        state.last_check = now;
        writeState(state);
        return;
    }

    // Revisar hasta MAX_PER_RUN PRs
    const results = [];
    const toProcess = pending.slice(0, MAX_PER_RUN);

    for (const pr of toProcess) {
        const result = await reviewPR(pr, state);
        if (result) results.push(result);
    }

    // Actualizar estado
    state.last_check = now;
    writeState(state);

    if (pending.length > MAX_PER_RUN) {
        log("Pendientes restantes para próximo ciclo: " + (pending.length - MAX_PER_RUN));
    }

    // Notificar Telegram
    if (results.length > 0) {
        const approved = results.filter(r => r.verdict === "APROBADO").length;
        const rejected = results.filter(r => r.verdict === "RECHAZADO").length;

        let msg = "🔍 <b>Auto-Review — " + results.length + " PR(s)</b>\n";
        msg += "<i>PRs abiertos >" + MIN_AGE_HOURS + "h sin review</i>\n\n";

        for (const r of results) {
            const icon = r.verdict === "APROBADO" ? "✅" : "❌";
            msg += icon + " <b>#" + r.number + "</b> (~" + r.ageHours + "h) " + escHtml(r.title) + "\n";
            if (r.blockers > 0) msg += "   🔴 " + r.blockers + " bloqueante(s)\n";
            if (r.warnings > 0) msg += "   🟡 " + r.warnings + " warning(s)\n";
        }

        if (pending.length > MAX_PER_RUN) {
            msg += "\n<i>" + (pending.length - MAX_PER_RUN) + " PR(s) pendiente(s) para próximo ciclo</i>";
        }

        await notify(msg);
        log("Telegram enviado: " + results.length + " revisados (" + approved + " OK / " + rejected + " rechazados)");
    }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────
// Soporta modo hook Stop (stdin JSON) y modo standalone (directo).

let stdinData = "";
let stdinDone = false;

function start() {
    if (stdinDone) return;
    stdinDone = true;

    if (stdinData.length > 0) {
        try {
            const hookInput = JSON.parse(stdinData);
            if (hookInput.stop_hook_active) {
                log("stop_hook_active=true — omitiendo para evitar recursión");
                return;
            }
        } catch (e) { /* JSON inválido — continuar normalmente */ }
    }

    runAutoReview().catch(e => log("Error fatal: " + e.message));
}

if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { stdinData += chunk; });
    process.stdin.on("end", start);
    process.stdin.on("error", start);
    setTimeout(start, 3000);
} else {
    runAutoReview().catch(e => {
        log("Error fatal: " + e.message);
        process.exit(1);
    });
}

module.exports = { runAutoReview, analyzeDiff };

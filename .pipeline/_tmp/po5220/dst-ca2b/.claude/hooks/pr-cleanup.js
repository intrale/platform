// pr-cleanup.js — Auto-merge de PRs pendientes con CI verde (#1351)
// Trigger: hook Stop de Claude o ejecución directa (node pr-cleanup.js)
// Detecta PRs agent/* con más de N horas, verifica CI, conflictos y labels.
// Si todo pasa → merge squash automático. Notifica por Telegram con resumen.
//
// Filtros de seguridad (NUNCA omitir):
//   - NO mergear PRs con label do-not-merge, wip o blocked
//   - NO mergear PRs con review changes-requested
//   - NO mergear PRs sin CI completamente verde
//   - NO mergear PRs con conflictos de merge
//
// Configuración:
//   - PR_CLEANUP_MIN_AGE_HOURS  — Horas mínimas de antigüedad (default: 4)
//   - PR_CLEANUP_DRY_RUN        — Si es "1", solo loga sin mergear
//
// Pure Node.js — sin dependencias externas (gh CLI via spawnSync)
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const GH_REPO = "intrale/platform";

const MIN_AGE_HOURS = parseFloat(process.env.PR_CLEANUP_MIN_AGE_HOURS || "4");
const DRY_RUN = process.env.PR_CLEANUP_DRY_RUN === "1";

// Labels que bloquean el merge automático
const BLOCKED_LABELS = ["do-not-merge", "wip", "blocked", "changes-requested", "hold"];

// Prefijo de ramas candidatas
const AGENT_BRANCH_PREFIX = "agent/";

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] PRCleanup: " + msg + "\n");
    } catch (e) {}
}

// ─── Telegram ────────────────────────────────────────────────────────────────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

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
                timeout: 6000
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

// ─── gh CLI helpers ───────────────────────────────────────────────────────────

function getGhBin() {
    return fs.existsSync(GH_PATH) ? GH_PATH : "gh";
}

function ghExec(args, timeoutMs) {
    if (timeoutMs === undefined) timeoutMs = 30000;
    try {
        const result = spawnSync(getGhBin(), args, {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            env: Object.assign({}, process.env, { PATH: process.env.PATH || "" })
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
        log("ghJson parse error: " + e.message + " · raw=" + (raw || "").substring(0, 100));
        return null;
    }
}

// ─── Helpers de evaluación de PRs ────────────────────────────────────────────

function isOlderThanNHours(createdAt, hours) {
    if (!createdAt) return false;
    const created = new Date(createdAt);
    const diffHours = (Date.now() - created.getTime()) / (1000 * 60 * 60);
    return diffHours >= hours;
}

function hasBlockedLabel(pr) {
    const labels = (pr.labels || []).map(function(l) {
        return (l.name || l || "").toLowerCase();
    });
    return BLOCKED_LABELS.some(function(bl) { return labels.includes(bl); });
}

function hasChangesRequested(pr) {
    return (pr.reviewDecision || "") === "CHANGES_REQUESTED";
}

/**
 * Devuelve true si el CI es verde (todos los checks pasados o skipped).
 * mergeStateStatus CLEAN es la señal más confiable.
 */
function isCIGreen(pr) {
    const mss = (pr.mergeStateStatus || "").toUpperCase();

    if (mss === "CLEAN") return true;
    if (mss === "DIRTY" || mss === "BLOCKED" || mss === "UNSTABLE") return false;
    if (mss === "UNKNOWN" || mss === "") return false;

    // Fallback: revisar statusCheckRollup directamente
    const checks = pr.statusCheckRollup || [];
    if (checks.length === 0) {
        // Sin checks definidos — asumir que no hay CI configurado → no mergear
        log("PR #" + pr.number + " sin checks definidos (statusCheckRollup vacío) — CI no verificable");
        return false;
    }

    return checks.every(function(c) {
        const state = (c.state || c.status || "").toUpperCase();
        const conclusion = (c.conclusion || "").toUpperCase();
        const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"];
        return ok.includes(state) || ok.includes(conclusion);
    });
}

function hasMergeConflicts(pr) {
    const mss = (pr.mergeStateStatus || "").toUpperCase();
    const mergeable = (pr.mergeable || "").toUpperCase();
    return mss === "DIRTY" || mergeable === "CONFLICTING";
}

/** Extrae los check runs fallidos para incluirlos en la notificación. */
function getFailedChecks(pr) {
    return (pr.statusCheckRollup || [])
        .filter(function(c) {
            const state = (c.state || c.status || "").toUpperCase();
            const conclusion = (c.conclusion || "").toUpperCase();
            return state === "FAILURE" || conclusion === "FAILURE";
        })
        .map(function(c) { return c.name || c.context || "unknown"; });
}

// ─── Acciones correctivas ─────────────────────────────────────────────────────

function extractIssueFromBranch(branch) {
    const match = (branch || "").match(/(?:agent|feature|bugfix)\/(\d+)-/);
    return match ? match[1] : null;
}

function attemptRebase(branch) {
    // Intentar rebase de la rama sobre origin/main
    try {
        ghExec(["api", "repos/" + GH_REPO + "/merges", "-f", "base=" + branch, "-f", "head=main"], 30000);
        log("attemptRebase: merge de main en " + branch + " exitoso");
        return true;
    } catch (e) {
        log("attemptRebase: falló para " + branch + ": " + (e.message || ""));
        return false;
    }
}

function attemptCIRerun(prNum, branch) {
    // Intentar re-run del último workflow fallido
    try {
        const runs = ghJson(["run", "list", "--branch", branch, "--limit", "1", "--repo", GH_REPO,
            "--json", "databaseId,status,conclusion"], 15000);
        if (!runs || runs.length === 0) return false;
        const lastRun = runs[0];
        if (lastRun.conclusion === "failure") {
            ghExec(["run", "rerun", String(lastRun.databaseId), "--repo", GH_REPO, "--failed"], 30000);
            log("attemptCIRerun: re-run disparado para run " + lastRun.databaseId + " en PR #" + prNum);
            return true;
        }
        return false;
    } catch (e) {
        log("attemptCIRerun: falló para PR #" + prNum + ": " + (e.message || ""));
        return false;
    }
}

function closePrAndReopenIssue(prNum, branch, reason) {
    const issueNum = extractIssueFromBranch(branch);

    // Cerrar PR con comentario
    ghExec(["pr", "close", String(prNum), "--repo", GH_REPO,
        "--comment", "Cerrado automáticamente por PR Cleanup: " + reason + ". Issue reabierto para reimplementar."], 15000);

    if (issueNum) {
        // Reabrir issue
        ghExec(["issue", "reopen", issueNum, "--repo", GH_REPO], 10000);
        // Agregar label backlog-tecnico
        ghExec(["issue", "edit", issueNum, "--repo", GH_REPO, "--add-label", "backlog-tecnico"], 10000);
        // Comentario explicativo
        ghExec(["issue", "comment", issueNum, "--repo", GH_REPO,
            "--body", "PR #" + prNum + " cerrado por PR Cleanup: " + reason + ".\nReimplementar desde main limpio."], 15000);
        log("closePrAndReopenIssue: PR #" + prNum + " cerrado, issue #" + issueNum + " reabierto con label backlog-tecnico");
    } else {
        log("closePrAndReopenIssue: PR #" + prNum + " cerrado, pero no se pudo extraer issue number de branch " + branch);
    }
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function runCleanup() {
    log("Iniciando PR cleanup (min_age=" + MIN_AGE_HOURS + "h" + (DRY_RUN ? " DRY_RUN" : "") + ")");

    // 1. Listar PRs abiertos
    const prs = ghJson([
        "pr", "list",
        "--state", "open",
        "--repo", GH_REPO,
        "--json", "number,title,headRefName,labels,createdAt,reviewDecision",
        "--limit", "100"
    ]);

    if (!prs) {
        log("No se pudo obtener lista de PRs — abortando");
        return;
    }

    if (prs.length === 0) {
        log("No hay PRs abiertos");
        return;
    }

    log("PRs abiertos totales: " + prs.length);

    // 2. Filtrar ramas agent/*
    const agentPrs = prs.filter(function(pr) {
        return (pr.headRefName || "").startsWith(AGENT_BRANCH_PREFIX);
    });

    log("PRs agent/*: " + agentPrs.length);

    if (agentPrs.length === 0) {
        log("Sin PRs agent/* — nada que hacer");
        return;
    }

    // 3. Filtrar por antigüedad
    const candidatePrs = agentPrs.filter(function(pr) {
        return isOlderThanNHours(pr.createdAt, MIN_AGE_HOURS);
    });

    log("Candidatos (> " + MIN_AGE_HOURS + "h): " + candidatePrs.length);

    if (candidatePrs.length === 0) {
        log("Sin PRs que superen el umbral de antigüedad — nada que hacer");
        return;
    }

    // 4. Evaluar y mergear
    const results = {
        merged: [],
        conflicts: [],
        ciFailure: [],
        skipped: []
    };

    for (const pr of candidatePrs) {
        const prNum = pr.number;
        const prTitle = (pr.title || "").substring(0, 80);
        const branch = pr.headRefName || "";

        log("Analizando PR #" + prNum + " · " + branch);

        // Verificar labels bloqueantes (rápido, ya tenemos los datos)
        if (hasBlockedLabel(pr)) {
            const badLabels = (pr.labels || [])
                .map(function(l) { return l.name || l; })
                .filter(function(l) { return BLOCKED_LABELS.includes(l.toLowerCase()); });
            log("PR #" + prNum + " bloqueado por labels: " + badLabels.join(", "));
            results.skipped.push({ number: prNum, title: prTitle, reason: "label: " + badLabels.join(", ") });
            continue;
        }

        // Verificar changes-requested (rápido, ya tenemos reviewDecision)
        if (hasChangesRequested(pr)) {
            log("PR #" + prNum + " bloqueado por changes-requested");
            results.skipped.push({ number: prNum, title: prTitle, reason: "changes-requested" });
            continue;
        }

        // Obtener detalles completos (CI, conflictos)
        const detail = ghJson([
            "pr", "view", String(prNum),
            "--repo", GH_REPO,
            "--json", "mergeable,mergeStateStatus,statusCheckRollup,reviewDecision"
        ], 15000);

        if (!detail) {
            log("PR #" + prNum + " no se pudo obtener detalle — saltando");
            results.skipped.push({ number: prNum, title: prTitle, reason: "error al obtener estado" });
            continue;
        }

        // Combinar datos del listado con detalles
        const fullPr = Object.assign({}, pr, detail, { number: prNum });

        // Verificar conflictos — intentar resolver
        if (hasMergeConflicts(fullPr)) {
            log("PR #" + prNum + " conflictos — intentando rebase automático");
            const rebaseOk = attemptRebase(branch);
            if (rebaseOk) {
                log("PR #" + prNum + " rebase exitoso — re-evaluando CI");
                // Esperar 10s para que GitHub actualice el estado
                spawnSync("timeout", ["/t", "10", "/nobreak"], { windowsHide: true, stdio: "ignore" });
                // Re-obtener detalle después del rebase
                const detail2 = ghJson(["pr", "view", String(prNum), "--repo", GH_REPO,
                    "--json", "mergeable,mergeStateStatus,statusCheckRollup"], 15000);
                if (detail2 && !hasMergeConflicts(Object.assign({}, pr, detail2))) {
                    log("PR #" + prNum + " conflictos resueltos tras rebase");
                    // Continuar al check de CI abajo (no saltar)
                    Object.assign(fullPr, detail2);
                } else {
                    log("PR #" + prNum + " conflictos persisten tras rebase — cerrando PR y reabriendo issue");
                    closePrAndReopenIssue(prNum, branch, "conflictos irreconciliables tras rebase automático");
                    results.conflicts.push({ number: prNum, title: prTitle, branch: branch, action: "cerrado+issue_reabierto" });
                    continue;
                }
            } else {
                log("PR #" + prNum + " rebase falló — cerrando PR y reabriendo issue");
                closePrAndReopenIssue(prNum, branch, "rebase automático falló, conflictos requieren intervención manual");
                results.conflicts.push({ number: prNum, title: prTitle, branch: branch, action: "cerrado+issue_reabierto" });
                continue;
            }
        }

        // Verificar CI — intentar re-run si falló
        if (!isCIGreen(fullPr)) {
            const failed = getFailedChecks(fullPr);
            log("PR #" + prNum + " CI no verde — intentando re-run (failedChecks=" + failed.join(",") + ")");
            const rerunOk = attemptCIRerun(prNum, branch);
            if (rerunOk) {
                log("PR #" + prNum + " CI re-run disparado — se evaluará en el próximo ciclo");
                results.ciFailure.push({ number: prNum, title: prTitle, branch: branch, failedChecks: failed, action: "rerun_disparado" });
            } else {
                log("PR #" + prNum + " CI re-run falló — cerrando PR y reabriendo issue");
                closePrAndReopenIssue(prNum, branch, "CI fallido: " + failed.slice(0, 3).join(", "));
                results.ciFailure.push({ number: prNum, title: prTitle, branch: branch, failedChecks: failed, action: "cerrado+issue_reabierto" });
            }
            continue;
        }

        // CI verde y sin conflictos → merge squash
        log("PR #" + prNum + " listo para merge squash" + (DRY_RUN ? " [DRY_RUN]" : ""));

        if (DRY_RUN) {
            log("DRY_RUN activo — no se mergea PR #" + prNum);
            results.merged.push({ number: prNum, title: prTitle, branch: branch, dryRun: true });
            continue;
        }

        const mergeOut = ghExec([
            "pr", "merge", String(prNum),
            "--squash",
            "--delete-branch",
            "--repo", GH_REPO
        ], 45000);

        if (mergeOut !== null) {
            log("PR #" + prNum + " mergeado exitosamente");
            results.merged.push({ number: prNum, title: prTitle, branch: branch });
        } else {
            log("PR #" + prNum + " falló al mergear — marcando como error");
            results.skipped.push({ number: prNum, title: prTitle, reason: "error en gh pr merge" });
        }
    }

    // 5. Notificación Telegram
    const mergedCount = results.merged.length;
    const conflictsCount = results.conflicts.length;
    const ciFailCount = results.ciFailure.length;
    const skippedCount = results.skipped.length;
    const total = candidatePrs.length;

    log("Resumen: total=" + total + " merged=" + mergedCount + " conflicts=" + conflictsCount + " ciFailure=" + ciFailCount + " skipped=" + skippedCount);

    // Solo notificar si hay algo relevante (merge, conflicto o CI fallido)
    if (mergedCount === 0 && conflictsCount === 0 && ciFailCount === 0) {
        log("Sin eventos relevantes — no se notifica por Telegram");
        return;
    }

    let msg = (DRY_RUN ? "🔍 <b>PR Cleanup [DRY RUN]</b>" : "🔄 <b>PR Cleanup</b>") + "\n";
    msg += "<i>" + total + " PRs revisados · " +
        mergedCount + " mergeados · " +
        conflictsCount + " con conflictos · " +
        ciFailCount + " con CI fallido</i>";

    if (mergedCount > 0) {
        msg += "\n\n✅ <b>Mergeados</b>\n";
        for (const pr of results.merged) {
            msg += "  • #" + pr.number + " " + escHtml(pr.title) + (pr.dryRun ? " <i>[dry]</i>" : "") + "\n";
        }
    }

    if (conflictsCount > 0) {
        msg += "\n⚠️ <b>Conflictos</b>\n";
        for (const pr of results.conflicts) {
            const action = pr.action ? " → " + pr.action : "";
            msg += "  • #" + pr.number + " " + escHtml(pr.title) + action + "\n";
        }
    }

    if (ciFailCount > 0) {
        msg += "\n❌ <b>CI fallido</b>\n";
        for (const pr of results.ciFailure) {
            const checksStr = pr.failedChecks && pr.failedChecks.length > 0
                ? " <code>" + escHtml(pr.failedChecks.slice(0, 2).join(", ")) + "</code>"
                : "";
            const action = pr.action ? " → " + pr.action : "";
            msg += "  • #" + pr.number + " " + escHtml(pr.title) + checksStr + action + "\n";
        }
    }

    if (skippedCount > 0) {
        msg += "\n⏭️ <b>Omitidos</b> (" + skippedCount + "): labels/reviews bloqueantes o error";
    }

    await notify(msg);
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────
// Soporta dos modos:
//   1. Hook Stop de Claude: recibe JSON por stdin con { stop_hook_active, session_id }
//   2. Standalone: sin stdin, ejecuta directamente

let stdinData = "";
let stdinDone = false;

function start() {
    if (stdinDone) return;
    stdinDone = true;

    // Si hay datos en stdin, verificar stop_hook_active para evitar recursión
    if (stdinData.length > 0) {
        try {
            const hookInput = JSON.parse(stdinData);
            if (hookInput.stop_hook_active) {
                log("stop_hook_active=true — omitiendo para evitar recursión");
                return;
            }
        } catch (e) {
            // JSON inválido o vacío — continuar normalmente
        }
    }

    runCleanup().catch(function(e) {
        log("Error fatal: " + e.message);
    });
}

// Detectar si hay stdin disponible (hook) o no (standalone)
if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function(chunk) { stdinData += chunk; });
    process.stdin.on("end", start);
    process.stdin.on("error", start);
    // Safety timeout para evitar que el hook cuelgue
    setTimeout(start, 3000);
} else {
    // Modo standalone
    runCleanup().catch(function(e) {
        log("Error fatal: " + e.message);
        process.exit(1);
    });
}

#!/usr/bin/env node
// cleanup-worktrees.js — Limpieza completa de worktrees muertos/huérfanos
// Uso standalone: node cleanup-worktrees.js [--dry-run] [path1 path2 ...]
// Uso stdin:      git worktree list --porcelain | node cleanup-worktrees.js
//
// Secuencia de limpieza por worktree:
//   1. Verificar si tiene PR mergeado/cerrado
//   2. cmd /c rmdir para junctions NTFS (.claude/)
//   3. git worktree remove --force
//   4. git branch -D (local)
//   5. git push origin --delete (remota, si existe)
//   6. git worktree prune
//
// CRÍTICO: NUNCA usa rm -rf — protección contra junctions NTFS

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const DRY_RUN = process.argv.includes("--dry-run");

function log(msg) {
    const line = "[" + new Date().toISOString() + "] cleanup-worktrees: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    console.log(msg);
}

function sendAlert(text) {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const postData = JSON.stringify({
                chat_id: config.chat_id, text: text, parse_mode: "HTML"
            });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + config.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                timeout: 8000
            }, (res) => {
                let d = "";
                res.on("data", c => d += c);
                res.on("end", () => resolve(true));
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.write(postData);
            req.end();
        } catch (e) { resolve(false); }
    });
}

function parseGitWorktreeList() {
    try {
        const output = execSync("git worktree list --porcelain", {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 10000, windowsHide: true
        });
        const worktrees = [];
        let current = {};
        for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
                if (current.path) worktrees.push(current);
                current = { path: line.substring(9).trim() };
            } else if (line.startsWith("branch ")) {
                current.branch = line.substring(7).trim();
            } else if (line.trim() === "bare") {
                current.bare = true;
            } else if (line.trim() === "") {
                if (current.path) worktrees.push(current);
                current = {};
            }
        }
        if (current.path) worktrees.push(current);
        return worktrees;
    } catch (e) {
        log("Error parseando git worktree list: " + e.message);
        return [];
    }
}

function getBranchName(wt) {
    if (wt.branch) {
        // "refs/heads/agent/1224-slug" → "agent/1224-slug"
        return wt.branch.replace(/^refs\/heads\//, "");
    }
    return null;
}

function checkPRStatus(branchName) {
    if (!branchName) return { merged: false, closed: false };
    try {
        const output = execSync(
            GH_CLI + ' pr list --repo intrale/platform --head "' + branchName + '" --state all --json state,mergedAt --limit 1',
            { encoding: "utf8", timeout: 15000, windowsHide: true }
        );
        const prs = JSON.parse(output);
        if (prs.length > 0) {
            return {
                merged: prs[0].state === "MERGED" || !!prs[0].mergedAt,
                closed: prs[0].state === "CLOSED"
            };
        }
    } catch (e) {
        log("Error verificando PR para " + branchName + ": " + e.message);
    }
    return { merged: false, closed: false };
}

function cleanupWorktree(wtPath, branchName) {
    const entry = path.basename(wtPath);
    const results = { entry, steps: [], success: false };

    // PROTECCIÓN: nunca borrar el worktree ops
    if (entry.endsWith(".ops")) {
        log("PROTEGIDO: " + entry + " es el worktree operativo");
        results.steps.push("protegido: worktree ops");
        return results;
    }

    if (DRY_RUN) {
        log("[DRY-RUN] Limpiaría: " + entry + " (branch: " + (branchName || "desconocida") + ")");
        results.steps.push("dry-run: sin cambios");
        return results;
    }

    // Paso 1: Desmontar junction NTFS .claude/ (si existe)
    const claudeJunction = path.join(wtPath, ".claude");
    if (fs.existsSync(claudeJunction)) {
        try {
            execSync('cmd /c rmdir "' + claudeJunction.replace(/\//g, "\\") + '"', {
                timeout: 5000, windowsHide: true
            });
            results.steps.push("junction .claude/ desmontada");
            log("Junction .claude/ desmontada: " + entry);
        } catch (e) {
            results.steps.push("junction .claude/ falló: " + e.message);
            log("No se pudo desmontar junction .claude/: " + entry + " — " + e.message);
        }
    }

    // Paso 2: git worktree remove --force
    try {
        execSync('git worktree remove "' + wtPath + '" --force', {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true
        });
        results.steps.push("git worktree remove --force OK");
        log("git worktree remove --force: " + entry);
    } catch (e) {
        results.steps.push("git worktree remove falló: " + e.message);
        log("git worktree remove falló: " + entry + " — " + e.message);
    }

    // Paso 3: git branch -D (local)
    if (branchName) {
        try {
            execSync('git branch -D "' + branchName + '"', {
                cwd: REPO_ROOT, encoding: "utf8", timeout: 5000, windowsHide: true
            });
            results.steps.push("branch local eliminada: " + branchName);
            log("Branch local eliminada: " + branchName);
        } catch (e) {
            results.steps.push("branch local no eliminada: " + e.message);
        }
    }

    // Paso 4: git push origin --delete (remota, si existe)
    if (branchName) {
        try {
            execSync('git push origin --delete "' + branchName + '"', {
                cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true
            });
            results.steps.push("branch remota eliminada: " + branchName);
            log("Branch remota eliminada: " + branchName);
        } catch (e) {
            // No es error si la rama remota no existe
            results.steps.push("branch remota no eliminada (puede no existir)");
        }
    }

    // Paso 5: git worktree prune
    try {
        execSync("git worktree prune", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true });
        results.steps.push("git worktree prune OK");
    } catch (e) {
        results.steps.push("git worktree prune falló");
    }

    // Verificar que el directorio ya no existe
    results.success = !fs.existsSync(wtPath);
    if (!results.success) {
        results.steps.push("ADVERTENCIA: directorio aún existe tras limpieza");
    }

    return results;
}

function getTargetWorktrees(args) {
    const mainPath = REPO_ROOT.replace(/\\/g, "/");
    const repoName = path.basename(REPO_ROOT);

    // Si se pasan paths como argumentos
    const pathArgs = args.filter(a => !a.startsWith("--"));
    if (pathArgs.length > 0) {
        return pathArgs.map(p => {
            const fullPath = path.resolve(p);
            return { path: fullPath, branch: null };
        });
    }

    // Stdin disponible? (piped)
    if (!process.stdin.isTTY) {
        const input = fs.readFileSync(0, "utf8");
        const worktrees = [];
        let current = {};
        for (const line of input.split("\n")) {
            if (line.startsWith("worktree ")) {
                if (current.path) worktrees.push(current);
                current = { path: line.substring(9).trim() };
            } else if (line.startsWith("branch ")) {
                current.branch = line.substring(7).trim().replace(/^refs\/heads\//, "");
            } else if (line.trim() === "") {
                if (current.path) worktrees.push(current);
                current = {};
            }
        }
        if (current.path) worktrees.push(current);
        return worktrees.filter(w => w.path.replace(/\\/g, "/") !== mainPath);
    }

    // Auto-detectar: worktrees registrados en git que estén muertos
    const allWt = parseGitWorktreeList();
    const dead = [];
    for (const wt of allWt) {
        const wtNorm = (wt.path || "").replace(/\\/g, "/");
        if (wtNorm === mainPath || wt.bare) continue;
        // NUNCA tocar el worktree ops
        if (path.basename(wt.path || "").endsWith(".ops")) continue;

        let isDead = false;
        if (!fs.existsSync(wt.path)) {
            isDead = true;
        } else {
            try {
                const contents = fs.readdirSync(wt.path);
                if (contents.length <= 1) isDead = true;
            } catch (e) {
                isDead = true;
            }
        }

        if (isDead) {
            dead.push({ path: wt.path, branch: getBranchName(wt) });
        }
    }

    // También buscar en filesystem
    const parentDir = path.resolve(REPO_ROOT, "..");
    try {
        const entries = fs.readdirSync(parentDir);
        for (const entry of entries) {
            if (!entry.startsWith(repoName + ".agent-")) continue;
            const fullPath = path.join(parentDir, entry);
            const fullPathNorm = fullPath.replace(/\\/g, "/");
            if (dead.some(d => d.path.replace(/\\/g, "/") === fullPathNorm)) continue;
            try {
                const contents = fs.readdirSync(fullPath);
                if (contents.length <= 1) {
                    dead.push({ path: fullPath, branch: null });
                }
            } catch (e) {}
        }
    } catch (e) {}

    return dead;
}

async function main() {
    log("Iniciando limpieza de worktrees...");
    const targets = getTargetWorktrees(process.argv.slice(2));

    if (targets.length === 0) {
        log("No hay worktrees muertos para limpiar.");
        console.log("No hay worktrees muertos para limpiar.");
        return;
    }

    log("Worktrees a limpiar: " + targets.length);
    const results = [];

    for (const wt of targets) {
        const branchName = wt.branch || getBranchName(wt);
        log("Procesando: " + path.basename(wt.path) + " (branch: " + (branchName || "desconocida") + ")");

        // Verificar estado de PR antes de limpiar
        if (branchName) {
            const prStatus = checkPRStatus(branchName);
            if (prStatus.merged) {
                log("PR mergeado para " + branchName + " — limpieza segura");
            } else if (prStatus.closed) {
                log("PR cerrado (no mergeado) para " + branchName + " — limpieza segura");
            } else {
                log("Sin PR mergeado/cerrado para " + branchName + " — limpiando solo worktree (conservando branch)");
            }
        }

        const result = cleanupWorktree(wt.path, branchName);
        results.push(result);
    }

    // Resumen
    const cleaned = results.filter(r => r.success);
    const failed = results.filter(r => !r.success && !DRY_RUN);

    let summary = "🧹 <b>Limpieza de worktrees</b>\n\n";
    if (cleaned.length > 0) {
        summary += "✅ <b>Limpiados:</b> " + cleaned.map(r => r.entry).join(", ") + "\n";
    }
    if (failed.length > 0) {
        summary += "❌ <b>Fallaron:</b> " + failed.map(r => r.entry + " (" + r.steps[r.steps.length - 1] + ")").join(", ") + "\n";
    }
    if (DRY_RUN) {
        summary += "\n<i>Modo dry-run: no se realizaron cambios.</i>";
    }

    console.log("\n=== Resumen ===");
    console.log("Limpiados: " + cleaned.length);
    console.log("Fallaron: " + failed.length);
    for (const r of results) {
        console.log("  " + r.entry + ": " + (r.success ? "OK" : "FALLÓ") + " — " + r.steps.join(" → "));
    }

    // Notificar a Telegram si hubo limpieza
    if (!DRY_RUN && (cleaned.length > 0 || failed.length > 0)) {
        await sendAlert(summary);
    }
}

main().catch(e => {
    log("Error fatal: " + e.message);
    console.error("Error: " + e.message);
    process.exit(1);
});

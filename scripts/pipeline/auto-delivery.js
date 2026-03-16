#!/usr/bin/env node
// auto-delivery.js — Commit + push + PR + merge automatico (reemplaza parte mecanica de /delivery)
// Lee agent-done.json escrito por Claude, ejecuta el flujo git completo.
// Exit 0 = delivery exitoso, Exit 1 = fallo

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitTransition, emitSkillInvoked, emitGateResult, REPO_ROOT } = require("./emit-transition");

const LOGS_DIR = path.join(REPO_ROOT, "scripts", "logs");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh";

function exec(cmd, opts) {
    const defaults = { encoding: "utf8", timeout: 60000, windowsHide: true };
    return execSync(cmd, { ...defaults, ...opts }).trim();
}

function safeExec(cmd, opts) {
    try { return exec(cmd, opts); } catch (e) { return null; }
}

function setupGhAuth() {
    try {
        const token = exec('printf "protocol=https\\nhost=github.com\\n" | git credential fill 2>/dev/null | sed -n "s/^password=//p"');
        process.env.GH_TOKEN = token;
        process.env.PATH = "/c/Workspaces/gh-cli/bin:" + process.env.PATH;
    } catch (e) {
        console.error("[auto-delivery] No se pudo obtener GH token");
    }
}

function getAgentDone(workDir) {
    // Buscar agent-done.json en multiples ubicaciones
    const candidates = [
        path.join(workDir, "agent-done.json"),
        "/tmp/agent-done.json",
        path.join(LOGS_DIR, "agent-done.json"),
    ];
    for (const fp of candidates) {
        if (fs.existsSync(fp)) {
            try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch (e) { }
        }
    }
    return null;
}

function detectChangeType(files) {
    const hasTest = files.some(f => /test/i.test(f));
    const hasSrc = files.some(f => /\.kt$|\.java$|\.js$/.test(f));
    const hasDocs = files.some(f => /\.md$|\.html$|docs\//.test(f));
    const hasConfig = files.some(f => /\.json$|\.toml$|\.yaml$|\.yml$|\.conf$/.test(f));

    if (!hasSrc && hasDocs) return "docs";
    if (!hasSrc && hasConfig) return "chore";
    if (hasTest && !hasSrc) return "test";
    return "feat"; // default
}

function stageAndCommit(workDir, agentDone) {
    // Stage archivos (excluir sensibles)
    const status = exec("git status --porcelain", { cwd: workDir });
    const files = status.split("\n").filter(l => l.trim());
    const toStage = [];

    for (const line of files) {
        const file = line.substring(3).trim();
        // Excluir archivos sensibles
        if (/\.env|credentials|\.key$|\.pem$|application\.conf/.test(file)) {
            console.log("[auto-delivery] Excluido (sensible): " + file);
            continue;
        }
        // Excluir archivos de .claude/ (junction/metadata)
        if (file.startsWith(".claude/")) continue;
        toStage.push(file);
    }

    if (toStage.length === 0) {
        console.log("[auto-delivery] Sin archivos para commitear");
        return false;
    }

    // Stage
    for (const f of toStage) {
        safeExec('git add "' + f + '"', { cwd: workDir });
    }

    // Commit
    const type = agentDone ? (agentDone.commit_type || detectChangeType(toStage)) : detectChangeType(toStage);
    const summary = agentDone ? agentDone.summary : "cambios del agente";
    const message = type + ": " + summary + "\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>";

    exec('git commit -m "' + message.replace(/"/g, '\\"') + '"', { cwd: workDir });
    console.log("[auto-delivery] Commit: " + type + ": " + summary + " (" + toStage.length + " archivos)");
    return true;
}

function rebaseOnMain(workDir) {
    exec("git fetch origin main", { cwd: workDir });
    const behind = parseInt(safeExec("git rev-list --count HEAD..origin/main", { cwd: workDir }) || "0");
    if (behind === 0) return true;

    console.log("[auto-delivery] Rebase: " + behind + " commits atras de main");
    try {
        exec("git rebase origin/main", { cwd: workDir, timeout: 120000 });
        return true;
    } catch (e) {
        // Verificar conflictos en codigo fuente
        const conflicted = safeExec("git diff --name-only --diff-filter=U", { cwd: workDir }) || "";
        const codeConflicts = conflicted.split("\n").filter(f =>
            /\.kt$|\.kts$|\.gradle$|\.xml$|\.java$/.test(f));
        if (codeConflicts.length > 0) {
            console.error("[auto-delivery] Conflictos en codigo fuente — abortando rebase");
            safeExec("git rebase --abort", { cwd: workDir });
            return false;
        }
        // Resolver config conflicts con --ours
        const configConflicts = conflicted.split("\n").filter(f => f.trim());
        for (const f of configConflicts) {
            safeExec('git checkout --ours "' + f + '"', { cwd: workDir });
            safeExec('git add "' + f + '"', { cwd: workDir });
        }
        safeExec("git rebase --continue", { cwd: workDir });
        return true;
    }
}

function pushBranch(workDir, branch) {
    try {
        exec('git push -u origin "' + branch + '"', { cwd: workDir, timeout: 120000 });
        return true;
    } catch (e) {
        console.error("[auto-delivery] Push fallo:", e.message);
        return false;
    }
}

function createPR(branch, agentDone, issue) {
    // Verificar si ya existe PR
    const existing = safeExec('gh pr list --repo intrale/platform --head "' + branch + '" --state open --json number,url');
    if (existing) {
        try {
            const prs = JSON.parse(existing);
            if (prs.length > 0) {
                console.log("[auto-delivery] PR existente: " + prs[0].url);
                return prs[0];
            }
        } catch (e) { }
    }

    const title = agentDone ? (agentDone.pr_title || agentDone.summary) : "Agent delivery";
    const body = (agentDone ? (agentDone.pr_body || agentDone.summary) : "Delivery automatico") +
        (issue ? "\n\nCloses #" + issue : "") +
        "\n\n---\nGenerated with [Claude Code](https://claude.ai/claude-code)";

    try {
        const result = exec(
            'gh pr create --repo intrale/platform --title "' + title.replace(/"/g, '\\"') +
            '" --body "' + body.replace(/"/g, '\\"') +
            '" --base main --head "' + branch + '" --assignee leitolarreta',
            { timeout: 30000 }
        );
        const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
        const numMatch = result.match(/\/pull\/(\d+)/);
        console.log("[auto-delivery] PR creada: " + (urlMatch ? urlMatch[0] : result));
        return { url: urlMatch ? urlMatch[0] : "", number: numMatch ? parseInt(numMatch[1]) : 0 };
    } catch (e) {
        console.error("[auto-delivery] Error creando PR:", e.message);
        return null;
    }
}

function mergePR(prNumber) {
    try {
        exec('gh pr merge ' + prNumber + ' --repo intrale/platform --squash --delete-branch', { timeout: 60000 });
        console.log("[auto-delivery] PR #" + prNumber + " merged (squash + delete-branch)");
        return true;
    } catch (e) {
        // Reintentar una vez si checks estan corriendo
        console.log("[auto-delivery] Merge fallo, esperando 30s para reintentar...");
        try {
            execSync("sleep 30", { windowsHide: true });
            exec('gh pr merge ' + prNumber + ' --repo intrale/platform --squash --delete-branch', { timeout: 60000 });
            console.log("[auto-delivery] PR #" + prNumber + " merged en segundo intento");
            return true;
        } catch (e2) {
            console.error("[auto-delivery] Merge fallo definitivamente:", e2.message);
            return false;
        }
    }
}

function cleanupWorktree(workDir, branch) {
    if (path.resolve(workDir) === path.resolve(REPO_ROOT)) return;

    try {
        // Volver al repo principal
        process.chdir(REPO_ROOT);
        // Desmontar junction .claude
        const winPath = workDir.replace(/\//g, "\\");
        safeExec('cmd /c rmdir "' + winPath + '\\.claude"');
        // Eliminar worktree
        safeExec('git worktree remove "' + workDir + '" --force');
        // Eliminar branch local
        safeExec('git branch -D "' + branch + '"');
        // Prune
        safeExec("git worktree prune");
        console.log("[auto-delivery] Worktree limpiado: " + path.basename(workDir));
    } catch (e) {
        console.error("[auto-delivery] Error limpiando worktree:", e.message);
    }
}

function sendTelegramReport(branch, prUrl, prNumber, state, changes) {
    const reportScript = path.join(REPO_ROOT, ".claude", "hooks", "delivery-report.js");
    if (!fs.existsSync(reportScript)) return;
    try {
        safeExec('node "' + reportScript + '" --branch "' + branch +
            '" --pr "' + (prUrl || "") +
            '" --pr-number "' + (prNumber || 0) +
            '" --state "' + state +
            '" --changes "' + (changes || "Delivery automatico").replace(/"/g, '\\"') + '"');
    } catch (e) { /* best-effort */ }
}

function main() {
    const prevRole = process.argv[2] || "Security";
    const workDir = process.argv[3] || process.cwd();

    emitTransition(prevRole, "DeliveryManager");
    emitSkillInvoked("delivery");

    console.log("[auto-delivery] Iniciando delivery...");

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    setupGhAuth();

    const branch = safeExec("git branch --show-current", { cwd: workDir });
    if (!branch) {
        console.error("[auto-delivery] No se pudo determinar branch");
        process.exit(1);
    }

    const issueMatch = branch.match(/^(?:agent|codex)\/(\d+)/);
    const issue = issueMatch ? parseInt(issueMatch[1]) : null;

    const agentDone = getAgentDone(workDir);

    // Step 1: Stage y commit
    const hasCommit = stageAndCommit(workDir, agentDone);
    if (!hasCommit) {
        // Verificar si ya hay commits pendientes
        const ahead = parseInt(safeExec("git rev-list --count origin/main..HEAD", { cwd: workDir }) || "0");
        if (ahead === 0) {
            console.log("[auto-delivery] Sin cambios para entregar");
            emitGateResult("delivery", "skip", { reason: "no changes" });
            process.exit(0);
        }
    }

    // Step 2: Rebase
    if (!rebaseOnMain(workDir)) {
        emitGateResult("delivery", "fail", { reason: "rebase conflict in source code" });
        sendTelegramReport(branch, null, null, "ERROR", "Conflictos de rebase irreconciliables");
        process.exit(1);
    }

    // Step 3: Push
    if (!pushBranch(workDir, branch)) {
        emitGateResult("delivery", "fail", { reason: "push failed" });
        process.exit(1);
    }

    // Step 4: Create PR
    const pr = createPR(branch, agentDone, issue);
    if (!pr) {
        emitGateResult("delivery", "fail", { reason: "PR creation failed" });
        process.exit(1);
    }

    // Step 5: Merge
    const prNumber = pr.number;
    const merged = mergePR(prNumber);
    const state = merged ? "MERGED" : "ERROR";

    // Step 6: Sync roadmap (best-effort)
    if (merged) {
        safeExec('node "' + path.join(REPO_ROOT, ".claude", "hooks", "sprint-manager.js") + '" sync --force');
    }

    // Step 7: Telegram report
    sendTelegramReport(branch, pr.url, prNumber, state, agentDone ? agentDone.summary : "Delivery automatico");

    // Step 8: Cleanup worktree (si merge exitoso)
    if (merged) {
        cleanupWorktree(workDir, branch);
    }

    // Resultado
    emitGateResult("delivery", merged ? "pass" : "fail", {
        branch, prNumber, prUrl: pr.url, state,
    });

    console.log("[auto-delivery] " + state + " — PR #" + prNumber);
    process.exit(merged ? 0 : 1);
}

main();

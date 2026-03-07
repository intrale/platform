// Hook PreToolUse[Bash]: gate pre-delivery — bloquea gh pr create si los gates de Fase 3 no pasaron
// Pipeline de Agentes — Issue #1237
// Verifica evidencia de invocación de /tester, /po y /security antes de permitir crear el PR.
//
// Estrategia:
//   1. Detectar comandos que comiencen con "gh pr create"
//   2. Resolver el repo principal (puede ejecutarse desde un worktree)
//   3. Leer activity-log.jsonl y buscar invocaciones recientes de los skills de gate
//      en la sesión actual o en las últimas GATE_WINDOW_HOURS horas, en el branch actual
//   4. Verificar delivery-gate-state.json para overrides explícitos (gate bypass autorizado)
//   5. Si falta algún gate: bloquear con mensaje instructivo
//   6. Si todos los gates tienen evidencia: permitir

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Ventana de tiempo para considerar un gate como "reciente" (en horas)
const GATE_WINDOW_HOURS = 8;

// Gates obligatorios para que el PR se pueda crear
const REQUIRED_GATES = ["tester", "po", "security"];

// Leer stdin con timeout
const MAX_READ = 8192;
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
setTimeout(() => {
    if (!done) { done = true; try { process.stdin.destroy(); } catch (e) {} handleInput(); }
}, 3000);

function resolveMainRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const gitCommon = execSync("git rev-parse --git-common-dir", {
            cwd: candidate, timeout: 3000, windowsHide: true
        }).toString().trim().replace(/\\/g, "/");
        if (gitCommon === ".git") return candidate;
        const gitIdx = gitCommon.indexOf("/.git");
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, "..");
    } catch (e) {
        return candidate;
    }
}

function getCurrentBranch(projectDir) {
    try {
        return execSync("git branch --show-current", {
            cwd: projectDir, timeout: 3000, encoding: "utf8", windowsHide: true
        }).trim();
    } catch (e) {
        return "";
    }
}

function getIssueFromBranch(branch) {
    // Formato esperado: agent/1237-slug o feature/1237-slug
    const match = branch.match(/(?:agent|feature|bugfix)\/(\d+)-/);
    return match ? match[1] : null;
}

function parseActivityLog(logFile) {
    try {
        const content = fs.readFileSync(logFile, "utf8");
        return content.split("\n")
            .filter(line => line.trim())
            .map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            })
            .filter(Boolean);
    } catch (e) {
        return [];
    }
}

function checkGateEvidence(logEntries, gates, windowHours) {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const found = {};

    for (const entry of logEntries) {
        if (entry.tool !== "Skill") continue;
        if (!entry.ts) continue;

        try {
            const ts = new Date(entry.ts);
            if (ts < cutoff) continue;
        } catch (e) {
            continue;
        }

        const skillName = (entry.target || "").toLowerCase().trim();
        for (const gate of gates) {
            if (skillName === gate) {
                if (!found[gate]) {
                    found[gate] = { ts: entry.ts, session: entry.session };
                }
            }
        }
    }

    return found;
}

function readGateStateOverride(repoRoot, branch) {
    try {
        const stateFile = path.join(repoRoot, ".claude", "hooks", "delivery-gate-state.json");
        if (!fs.existsSync(stateFile)) return null;
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (state.branch !== branch) return null;
        // Verificar que el override no sea demasiado antiguo (máx 24h)
        const createdAt = new Date(state.created_at || 0);
        const maxAge = 24 * 60 * 60 * 1000;
        if (Date.now() - createdAt.getTime() > maxAge) return null;
        return state;
    } catch (e) {
        return null;
    }
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";
        const command = (data.tool_input && data.tool_input.command) || "";

        // Solo interceptar herramienta Bash
        if (toolName !== "Bash") {
            process.exit(0);
            return;
        }

        const trimmedCmd = command.trim();

        // Solo interceptar comandos que comiencen con "gh pr create"
        if (!trimmedCmd.match(/^(?:export\s+[A-Z_]+=\S+\s+&&\s+)*gh\s+pr\s+create\b/) &&
            !trimmedCmd.match(/^gh\s+pr\s+create\b/)) {
            process.exit(0);
            return;
        }

        // Resolver paths
        const projectDir = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
        const repoRoot = resolveMainRepoRoot();
        const branch = getCurrentBranch(projectDir);

        // Verificar que el branch es una rama de agente válida (no main ni develop)
        if (!branch || branch === "main" || branch === "develop") {
            const msg = JSON.stringify({
                decision: "block",
                reason: `GATE DELIVERY: No se puede crear PR desde la rama '${branch || "(sin rama)"}'. Debe estar en una rama agent/NNNN-slug.`
            });
            process.stdout.write(msg);
            process.exit(0);
            return;
        }

        const issueNumber = getIssueFromBranch(branch);

        // Verificar override explícito (bypass autorizado)
        const override = readGateStateOverride(repoRoot, branch);
        if (override && override.bypass === true) {
            // Bypass autorizado — permitir con log
            writeAuditLog(repoRoot, branch, issueNumber, "bypass", "Bypass autorizado en delivery-gate-state.json", override);
            process.exit(0);
            return;
        }

        // Leer activity-log.jsonl del repo principal
        const logFile = path.join(repoRoot, ".claude", "activity-log.jsonl");
        const logEntries = parseActivityLog(logFile);

        // Verificar evidencia de gates en las últimas GATE_WINDOW_HOURS horas
        const evidence = checkGateEvidence(logEntries, REQUIRED_GATES, GATE_WINDOW_HOURS);

        const missingGates = REQUIRED_GATES.filter(gate => !evidence[gate]);

        if (missingGates.length === 0) {
            // Todos los gates tienen evidencia — permitir PR
            writeAuditLog(repoRoot, branch, issueNumber, "pass", "Todos los gates pasaron", evidence);
            process.exit(0);
            return;
        }

        // Faltan gates — bloquear con mensaje instructivo
        const gateInstructions = {
            tester: "Invocar /tester para verificar que los tests pasan y revisar cobertura.",
            po: "Invocar /po acceptance #" + (issueNumber || "N") + " para verificar criterios de aceptación.",
            security: "Invocar /security scan para escanear el diff contra OWASP Top 10."
        };

        const missingList = missingGates.map(g => `  • /${g}: ${gateInstructions[g]}`).join("\n");
        const evidenceList = REQUIRED_GATES
            .filter(g => evidence[g])
            .map(g => `  ✓ /${g}: ejecutado a las ${evidence[g].ts}`)
            .join("\n");

        let reason = `GATE DELIVERY BLOQUEADO — Fase 3 no completada para #${issueNumber || branch}\n\n`;
        reason += `Gates pendientes:\n${missingList}\n`;
        if (evidenceList) {
            reason += `\nGates completados:\n${evidenceList}\n`;
        }
        reason += `\nUna vez ejecutados, volver a invocar /delivery.\n`;
        reason += `(Ventana de verificación: últimas ${GATE_WINDOW_HOURS}h)`;

        writeAuditLog(repoRoot, branch, issueNumber, "blocked", `Gates faltantes: ${missingGates.join(", ")}`, { missingGates, evidence });

        const msg = JSON.stringify({ decision: "block", reason });
        process.stdout.write(msg);
        process.exit(0);

    } catch (e) {
        // Error inesperado — fail-open para no bloquear el flujo normal
        // En producción considerar fail-closed aquí
        process.exit(0);
    }
}

function writeAuditLog(repoRoot, branch, issueNumber, result, summary, details) {
    try {
        const auditFile = path.join(repoRoot, ".claude", "hooks", "delivery-gate-audit.jsonl");
        const entry = JSON.stringify({
            ts: new Date().toISOString(),
            branch,
            issue: issueNumber,
            result, // "pass", "blocked", "bypass"
            summary,
            details
        });
        fs.appendFileSync(auditFile, entry + "\n", "utf8");
    } catch (e) {
        // Silenciar errores de escritura de audit — no bloquear el flujo
    }
}

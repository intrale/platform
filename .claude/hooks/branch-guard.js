// Hook PreToolUse[Bash]: bloquea git push cuando estamos en main
// Previene pushes directos a main — toda modificación debe ir por rama
const { execSync } = require("child_process");

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
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 3000);

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";

        // Solo interceptar comandos git push
        if (!command.match(/git\s+push/)) {
            process.exit(0);
            return;
        }

        // Caso 1: push explícito a main/master
        if (command.match(/git\s+push\s+(origin\s+)?(main|master)\b/)) {
            const msg = JSON.stringify({
                decision: "block",
                reason: "BLOQUEADO: push directo a main. Creá una rama con `/branch <issue> [slug]` antes de hacer cambios. Convención: agent/<issue>-<slug>"
            });
            process.stdout.write(msg);
            process.exit(0);
            return;
        }

        // Caso 2: push implícito (sin branch explícito) — verificar rama actual
        // Matches: "git push", "git push origin", "git push -u origin"
        // No matches: "git push origin agent/123-foo" (tiene rama explícita no-main)
        const pushWithExplicitBranch = command.match(/git\s+push\s+(?:-[a-zA-Z]+\s+)*\S+\s+(\S+)/);
        if (pushWithExplicitBranch) {
            const targetBranch = pushWithExplicitBranch[1];
            // Si la rama explícita no es main/master, permitir
            if (targetBranch !== "main" && targetBranch !== "master" && !targetBranch.startsWith('"main') && !targetBranch.startsWith("$")) {
                process.exit(0);
                return;
            }
        }

        // Para pushes sin rama explícita o con variable, verificar rama actual
        if (!pushWithExplicitBranch || pushWithExplicitBranch[1].startsWith("$")) {
            try {
                const currentBranch = execSync("git branch --show-current", {
                    encoding: "utf8",
                    timeout: 5000,
                    cwd: process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform"
                }).trim();

                if (currentBranch === "main" || currentBranch === "master") {
                    const msg = JSON.stringify({
                        decision: "block",
                        reason: `BLOQUEADO: estás en '${currentBranch}' e intentás hacer push. Creá una rama con \`/branch <issue> [slug]\` antes de hacer cambios. Convención: agent/<issue>-<slug>`
                    });
                    process.stdout.write(msg);
                    process.exit(0);
                    return;
                }
            } catch (e) {
                // Si no podemos determinar la rama, permitir (fail-open para no bloquear)
            }
        }

        // Permitir el push
        process.exit(0);
    } catch (e) {
        // Error parseando input — no bloquear
        process.exit(0);
    }
}

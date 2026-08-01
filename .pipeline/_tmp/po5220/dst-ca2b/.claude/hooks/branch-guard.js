// Hook PreToolUse[Bash]: bloquea git push cuando estamos en main
// Previene pushes directos a main — toda modificación debe ir por rama
// IMPORTANTE: Solo intercepta comandos "git push" reales, NO "gh" o pipes
const { execSync } = require("child_process");

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
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 3000);

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";
        const command = (data.tool_input && data.tool_input.command) || "";

        // Solo interceptar Bash
        if (toolName !== "Bash") {
            process.exit(0);
            return;
        }

        // IMPORTANTE: El comando debe COMENZAR con "git push"
        // NO ejecutar para comandos que contengan "git push" dentro de un string
        const trimmedCmd = command.trim();

        // No matches "gh" o comandos que no sean git
        if (!trimmedCmd.match(/^git\s+push\b/)) {
            process.exit(0);
            return;
        }

        // Ahora sabemos que es un comando "git push"
        // Bloquear si va explícitamente a main o master
        if (trimmedCmd.match(/^git\s+push\s+(?:-[a-z]+\s+)*(?:origin\s+)?(main|master)\b/)) {
            const msg = JSON.stringify({
                decision: "block",
                reason: "BLOQUEADO: push directo a main. Creá una rama con `/branch <issue> [slug]` antes de hacer cambios. Convención: agent/<issue>-<slug>"
            });
            process.stdout.write(msg);
            process.exit(0);
            return;
        }

        // Si el comando es "git push" sin especificar rama explícitamente,
        // verificar la rama actual
        const hasExplicitBranch = trimmedCmd.match(/^git\s+push\s+(?:-[a-z]+\s+)*(?:origin|\S+)\s+(\S+)/);

        if (!hasExplicitBranch) {
            // "git push" implícito — verificar rama actual
            try {
                const currentBranch = execSync("git branch --show-current", {
                    encoding: "utf8",
                    timeout: 5000,
                    cwd: process.env.CLAUDE_PROJECT_DIR || "C:\Workspaces\Intrale\platform",
                    stdio: ["pipe", "pipe", "pipe"]
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
                // Si no podemos determinar rama, permitir (fail-open)
            }
        }

        // Si tiene rama explícita que NO es main/master, permitir
        if (hasExplicitBranch && hasExplicitBranch[1] !== "main" && hasExplicitBranch[1] !== "master") {
            process.exit(0);
            return;
        }

        // Permitir por defecto
        process.exit(0);
    } catch (e) {
        // Error parseando — permitir sin bloquear
        process.exit(0);
    }
}

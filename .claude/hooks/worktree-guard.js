// Hook PreToolUse[Edit|Write]: bloquea ediciones de código fuera de un worktree dedicado
// Garantiza que toda implementación se realice en un worktree (platform.agent-<issue>-<slug>)
// Fail-open: ante cualquier error interno, permite la operación sin bloquear
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "hook-debug.log");

function log(msg) {
    try {
        const ts = new Date().toISOString();
        fs.appendFileSync(LOG_FILE, `[${ts}] WorktreeGuard: ${msg}\n`);
    } catch (_) { /* ignore logging errors */ }
}

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
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch (_) {} handleInput(); } }, 3000);

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";

        // Solo interceptar Edit y Write
        if (toolName !== "Edit" && toolName !== "Write") {
            log(`skip: tool=${toolName} (no es Edit ni Write)`);
            process.exit(0);
            return;
        }

        // Obtener el archivo que se intenta editar/escribir
        const filePath = (data.tool_input && (data.tool_input.file_path || "")) || "";

        // Detectar si estamos en un worktree
        const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const dirName = path.basename(projectDir);
        const isWorktree = dirName.includes("platform.agent-");

        log(`tool=${toolName} file=${filePath} projectDir=${projectDir} dirName=${dirName} isWorktree=${isWorktree}`);

        // Si estamos en un worktree, permitir todo
        if (isWorktree) {
            log("allow: estamos en worktree");
            process.exit(0);
            return;
        }

        // Verificar excepciones: archivos que siempre se pueden editar desde el repo principal
        if (filePath) {
            // Normalizar separadores a forward slash para comparación consistente
            const normalized = filePath.replace(/\\/g, "/");

            // Excepción: archivos dentro de .claude/
            if (normalized.includes("/.claude/") || normalized.includes("\\.claude\\")) {
                log(`allow: excepción .claude/ → ${filePath}`);
                process.exit(0);
                return;
            }

            // Excepción: archivos dentro de docs/
            if (normalized.includes("/docs/") || normalized.includes("\\docs\\")) {
                log(`allow: excepción docs/ → ${filePath}`);
                process.exit(0);
                return;
            }

            // Excepción: archivos dentro de scripts/
            if (normalized.includes("/scripts/") || normalized.includes("\\scripts\\")) {
                log(`allow: excepción scripts/ → ${filePath}`);
                process.exit(0);
                return;
            }

            // Excepción: CLAUDE.md en cualquier ubicación
            const baseName = path.basename(normalized);
            if (baseName === "CLAUDE.md") {
                log(`allow: excepción CLAUDE.md → ${filePath}`);
                process.exit(0);
                return;
            }
        }

        // NO estamos en worktree y NO es excepción → BLOQUEAR
        log(`BLOCK: edición de código fuera de worktree → ${filePath}`);
        const msg = JSON.stringify({
            decision: "block",
            reason: "BLOQUEADO: intentás editar código fuera de un worktree dedicado.\n\nPara crear un worktree:\n  dev <issue> <slug>       (desde terminal bash)\n  /branch <issue> [slug]   (desde Claude Code)\n\nConvención: platform.agent-<issue>-<slug>"
        });
        process.stdout.write(msg);
        process.exit(0);
    } catch (e) {
        // Fail-open: ante cualquier error, permitir
        log(`error (fail-open): ${e.message}`);
        process.exit(0);
    }
}

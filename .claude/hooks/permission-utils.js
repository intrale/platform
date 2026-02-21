// permission-utils.js — Utilidades compartidas para hooks de permisos
// Usado por: permission-approver.js, permission-tracker.js
// Issue #891: unificar generación de patrones y resolución de paths

const fs = require("fs");
const path = require("path");

// ─── Resolución de repo root (worktree-aware) ───────────────────────────────

/**
 * Detecta si currentRoot es un worktree leyendo .git (file, no dir).
 * Si es worktree, resuelve el path del repo principal.
 * Retorna null si es el repo principal o no se pudo resolver.
 */
function resolveMainRepoRoot(currentRoot) {
    try {
        const gitPath = path.join(currentRoot, ".git");
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
            // Worktree: .git es un archivo con "gitdir: <path>"
            const content = fs.readFileSync(gitPath, "utf8").trim();
            const match = content.match(/^gitdir:\s+(.+)$/);
            if (match) {
                // gitdir: /main-repo/.git/worktrees/<name>
                // Navegar: worktrees/<name> → .git → repo root
                const worktreeGitDir = match[1].replace(/\\/g, "/");
                const mainGitDir = path.resolve(worktreeGitDir, "..", "..");
                return path.dirname(mainGitDir);
            }
        }
        // .git es directorio — este es el repo principal
    } catch(e) { /* no es repo git o error de FS */ }
    return null;
}

/**
 * Devuelve lista de paths a settings.local.json donde escribir.
 * Si estamos en worktree, incluye tanto el worktree como el repo principal.
 * El primer path es siempre el del REPO_ROOT actual (para efecto inmediato).
 */
function getSettingsPaths(currentRoot) {
    const paths = [path.join(currentRoot, ".claude", "settings.local.json")];
    const mainRoot = resolveMainRepoRoot(currentRoot);
    if (mainRoot) {
        const mainPath = path.join(mainRoot, ".claude", "settings.local.json");
        // Evitar duplicados (si currentRoot ya es el main repo)
        if (mainPath !== paths[0]) {
            paths.push(mainPath);
        }
    }
    return paths;
}

// ─── Extracción de primer comando en comandos compuestos ─────────────────────

/**
 * Extrae el primer comando de un comando compuesto.
 * Maneja: "export FOO=bar && ./gradlew build" → "export FOO=bar"
 *         "cd /path ; make" → "cd /path"
 * Respeta comillas y paréntesis.
 */
function extractFirstCommand(cmd) {
    let quote = null;
    let depth = 0;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            if (c === quote && (i === 0 || cmd[i - 1] !== "\\")) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === "(") { depth++; continue; }
        if (c === ")") { depth--; continue; }
        if (depth > 0) continue;

        if (c === "&" && cmd[i + 1] === "&") return cmd.substring(0, i).trim();
        if (c === ";") return cmd.substring(0, i).trim();
        if (c === "|" && cmd[i + 1] !== "|") return cmd.substring(0, i).trim();
    }
    return cmd;
}

// ─── Generación de patrones ──────────────────────────────────────────────────

function generateBashPattern(command) {
    const raw = command.trim();
    if (!raw) return null;

    // Para comandos compuestos, generar patrón para el primer comando
    const cmd = extractFirstCommand(raw);
    if (!cmd) return null;

    // Comandos quoted (e.g., "C:/Program Files/Git/usr/bin/bash.exe" ...)
    if (cmd.startsWith('"')) {
        const end = cmd.indexOf('"', 1);
        if (end > 0) {
            const quoted = cmd.substring(1, end);
            return 'Bash("' + quoted + '":*)';
        }
    }

    const parts = cmd.split(/\s+/);
    const first = parts[0];

    // Comando simple (sin argumentos)
    if (parts.length === 1) return "Bash(" + first + ":*)";

    // git subcomandos
    if (first === "git") {
        const sub = parts[1];
        if (sub === "credential" && parts.length > 2) return "Bash(git credential " + parts[2] + ":*)";
        if (sub === "-C") return "Bash(git -C:*)";
        return "Bash(git " + sub + ":*)";
    }

    // export VAR=value
    if (first === "export") {
        const rest = parts.slice(1).join(" ");
        const eqIdx = rest.indexOf("=");
        if (eqIdx > 0) {
            const varname = rest.substring(0, eqIdx);
            return "Bash(export " + varname + "=*)";
        }
        return "Bash(export " + parts[1] + ":*)";
    }

    // Paths absolutos o relativos
    if (first.startsWith("./") || first.startsWith("/")) return "Bash(" + first + ":*)";

    // VAR=value command (e.g., JAVA_HOME=/path ./gradlew)
    if (first.includes("=")) {
        const varname = first.substring(0, first.indexOf("="));
        return "Bash(" + varname + "=*)";
    }

    return "Bash(" + first + ":*)";
}

function generateWebFetchPattern(toolInput) {
    const fetchUrl = toolInput.url || "";
    if (!fetchUrl) return null;
    try {
        const parsed = new URL(fetchUrl);
        return parsed.hostname ? "WebFetch(domain:" + parsed.hostname + ")" : null;
    } catch(e) {
        return null;
    }
}

function generateSkillPattern(toolInput) {
    const skill = toolInput.skill || "";
    return skill ? "Skill(" + skill + ")" : null;
}

/**
 * Genera un patrón de permiso para el tool dado.
 * Retorna null si no se puede generar patrón (tool no soportado o input vacío).
 */
function generatePattern(toolName, toolInput) {
    switch (toolName) {
        case "Bash":
            return generateBashPattern((toolInput && toolInput.command) || "");
        case "WebFetch":
            return generateWebFetchPattern(toolInput || {});
        case "WebSearch":
            return "WebSearch";
        case "Skill":
            return generateSkillPattern(toolInput || {});
        default:
            return null;
    }
}

// ─── Verificación de cobertura ───────────────────────────────────────────────

/**
 * Verifica si un patrón ya está cubierto por la allow list.
 */
function isAlreadyCovered(pattern, allowList) {
    // Exacto
    if (allowList.includes(pattern)) return true;

    // Bare tool name cubre patrones específicos
    if (pattern.startsWith("WebFetch(") && allowList.includes("WebFetch")) return true;
    if (pattern.startsWith("WebSearch(") && allowList.includes("WebSearch")) return true;

    // Bash: patrones más amplios cubren los más específicos
    const m = pattern.match(/^Bash\((.+?):\*\)$/);
    if (m) {
        const cmd = m[1];
        for (const p of allowList) {
            const pm = p.match(/^Bash\((.+?):\*\)$/);
            if (pm && cmd.startsWith(pm[1])) return true;
        }
    }

    return false;
}

/**
 * Verifica si un patrón colisiona con la deny list.
 */
function collidesWithDeny(pattern, denyList) {
    const m = pattern.match(/^Bash\((.+?):\*\)$/);
    if (!m) return false;
    const cmd = m[1];
    for (const d of denyList) {
        const dm = d.match(/^Bash\((.+?):\*\)$/);
        if (!dm) continue;
        const denyCmd = dm[1];
        if (denyCmd.startsWith(cmd) || cmd.startsWith(denyCmd)) return true;
    }
    return false;
}

// ─── Persistencia de patrón en settings ──────────────────────────────────────

/**
 * Persiste un patrón en uno o más archivos settings.local.json.
 * Retorna true si se persistió en al menos un archivo.
 */
function persistPattern(pattern, settingsPaths, logFn) {
    if (!pattern) return false;
    let persisted = false;

    for (const settingsPath of settingsPaths) {
        try {
            let settings = {};
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
            } else {
                // Crear el archivo con estructura base
                const dir = path.dirname(settingsPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                settings = { permissions: { allow: [], deny: [] } };
            }

            const allow = (settings.permissions && settings.permissions.allow) || [];

            if (isAlreadyCovered(pattern, allow)) {
                if (logFn) logFn("Pattern ya cubierto en " + path.basename(path.dirname(path.dirname(settingsPath))) + ": " + pattern);
                continue;
            }

            // Verificar deny list
            const deny = (settings.permissions && settings.permissions.deny) || [];
            if (collidesWithDeny(pattern, deny)) {
                if (logFn) logFn("Pattern colisiona con deny en " + path.basename(path.dirname(path.dirname(settingsPath))) + ": " + pattern);
                continue;
            }

            allow.push(pattern);
            settings.permissions = settings.permissions || {};
            settings.permissions.allow = allow;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
            if (logFn) logFn("Persistido en " + settingsPath + ": " + pattern);
            persisted = true;
        } catch(e) {
            if (logFn) logFn("Error persistiendo en " + settingsPath + ": " + e.message);
        }
    }

    return persisted;
}

module.exports = {
    resolveMainRepoRoot,
    getSettingsPaths,
    extractFirstCommand,
    generateBashPattern,
    generatePattern,
    isAlreadyCovered,
    collidesWithDeny,
    persistPattern
};

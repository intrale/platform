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

// ─── Parser robusto de comandos compuestos ──────────────────────────────────

/**
 * Divide un comando compuesto en sus comandos atómicos, respetando:
 * - Comillas simples y dobles (con escape)
 * - Subshells: $(...), <(...), >(...), (( ))
 * - Redirecciones: 2>&1, >/dev/null, >>file
 * - Pipes | vs OR ||
 * - Separadores ; y &&
 * - Bloques multilinea: if/fi, for/done, while/done
 */
function splitCompoundCommand(cmd) {
    if (!cmd || typeof cmd !== "string") return [];
    const trimmed = cmd.trim();
    if (!trimmed) return [];

    const commands = [];
    let current = "";
    let quote = null;   // null | '"' | "'"
    let depth = 0;      // parenthesis depth
    let i = 0;

    while (i < trimmed.length) {
        const c = trimmed[i];

        // ── Dentro de comillas ──
        if (quote) {
            current += c;
            if (c === quote && (i === 0 || trimmed[i - 1] !== "\\")) {
                quote = null;
            }
            i++;
            continue;
        }

        // ── Abrir comilla ──
        if (c === '"' || c === "'") {
            quote = c;
            current += c;
            i++;
            continue;
        }

        // ── Subshells y agrupaciones ──
        if (c === "(") {
            depth++;
            current += c;
            i++;
            continue;
        }
        if (c === ")") {
            depth = Math.max(0, depth - 1);
            current += c;
            i++;
            continue;
        }

        // ── Dentro de subshell: no separar ──
        if (depth > 0) {
            current += c;
            i++;
            continue;
        }

        // ── Redirecciones: 2>&1, >&2, >file, >>file, <file, 2>/dev/null ──
        // Tratar como parte del comando actual, no como separador
        if (c === ">" || c === "<") {
            // Absorber la redirección completa
            current += c;
            i++;
            // >> (append)
            if (i < trimmed.length && trimmed[i] === ">") {
                current += trimmed[i];
                i++;
            }
            // &1, &2 (fd redirect)
            if (i < trimmed.length && trimmed[i] === "&") {
                current += trimmed[i];
                i++;
                if (i < trimmed.length && /\d/.test(trimmed[i])) {
                    current += trimmed[i];
                    i++;
                }
            }
            // Skip spaces and absorb target filename
            while (i < trimmed.length && trimmed[i] === " ") {
                current += trimmed[i];
                i++;
            }
            // Absorb the target (until space or separator)
            while (i < trimmed.length && !/[;&|<>]/.test(trimmed[i]) && trimmed[i] !== " ") {
                current += trimmed[i];
                i++;
            }
            continue;
        }

        // ── fd number antes de redirección: 2>, 1> ──
        if (/\d/.test(c) && i + 1 < trimmed.length && (trimmed[i + 1] === ">" || (trimmed[i + 1] === ">" && trimmed[i + 2] === "&"))) {
            current += c;
            i++;
            continue;
        }

        // ── && (AND) ──
        if (c === "&" && i + 1 < trimmed.length && trimmed[i + 1] === "&") {
            const cmd_trimmed = current.trim();
            if (cmd_trimmed) commands.push(cmd_trimmed);
            current = "";
            i += 2;
            continue;
        }

        // ── & (background) — tratar como parte del comando ──
        if (c === "&" && (i + 1 >= trimmed.length || trimmed[i + 1] !== "&")) {
            current += c;
            i++;
            continue;
        }

        // ── || (OR) ──
        if (c === "|" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
            const cmd_trimmed = current.trim();
            if (cmd_trimmed) commands.push(cmd_trimmed);
            current = "";
            i += 2;
            continue;
        }

        // ── | (pipe) ──
        if (c === "|") {
            const cmd_trimmed = current.trim();
            if (cmd_trimmed) commands.push(cmd_trimmed);
            current = "";
            i++;
            continue;
        }

        // ── ; (secuencia) ──
        if (c === ";") {
            const cmd_trimmed = current.trim();
            if (cmd_trimmed) commands.push(cmd_trimmed);
            current = "";
            i++;
            continue;
        }

        current += c;
        i++;
    }

    const last = current.trim();
    if (last) commands.push(last);

    return commands;
}

// ─── Directorios seguros ────────────────────────────────────────────────────

const DEFAULT_SAFE_DIRECTORIES = [
    ".claude/",
    "qa/",
    "docs/"
];

/**
 * Carga safe_directories desde telegram-config.json o usa defaults.
 */
function loadSafeDirectories() {
    try {
        const cfgPath = path.join(__dirname, "telegram-config.json");
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (Array.isArray(cfg.safe_directories) && cfg.safe_directories.length > 0) {
            return cfg.safe_directories;
        }
    } catch (e) {}
    return DEFAULT_SAFE_DIRECTORIES;
}

/**
 * Determina si un path de archivo está en un directorio seguro.
 * Los paths se normalizan y se comparan relativos al repo root.
 * @param {string} filePath - Path absoluto o relativo del archivo
 * @param {string} [repoRoot] - Root del repo (default: CLAUDE_PROJECT_DIR o cwd)
 * @returns {boolean}
 */
function isSafeDirectory(filePath, repoRoot) {
    if (!filePath) return false;
    const root = (repoRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, "/");
    const normalized = filePath.replace(/\\/g, "/");

    // Obtener path relativo al repo
    let relative = normalized;
    if (normalized.startsWith(root)) {
        relative = normalized.substring(root.length);
    }
    // Quitar leading slash
    relative = relative.replace(/^\/+/, "");

    const safeDirs = loadSafeDirectories();
    return safeDirs.some(dir => {
        const normalizedDir = dir.replace(/\\/g, "/").replace(/^\/+/, "");
        return relative.startsWith(normalizedDir);
    });
}

// ─── Detección de comandos destructivos ─────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)/,   // rm -r, rm -rf, rm -fr
    /\brm\s+-[a-zA-Z]*f/,                                   // rm -f (force)
    /\bgit\s+push\s+--force/,
    /\bgit\s+push\s+-f\b/,
    /\bgit\s+reset\s+--hard/,
    /\bgit\s+clean\s+-f/,
    /\bDROP\s+(TABLE|DATABASE|INDEX)/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\s/i,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\bformat\s+[a-zA-Z]:/i,
];

/**
 * Determina si una acción es reversible (recuperable con git checkout o borrando).
 * @param {string} toolName - Nombre del tool (Edit, Write, Bash, etc.)
 * @param {object} toolInput - Input del tool
 * @param {string} [repoRoot] - Root del repo
 * @returns {boolean}
 */
function isReversibleAction(toolName, toolInput, repoRoot) {
    if (!toolName) return false;

    // Edit/Write sobre directorio seguro → reversible
    if (toolName === "Edit" || toolName === "Write") {
        const fp = toolInput && (toolInput.file_path || toolInput.filePath || "");
        return isSafeDirectory(fp, repoRoot);
    }

    // Bash: verificar que NO sea destructivo
    if (toolName === "Bash") {
        const cmd = (toolInput && toolInput.command) || "";
        if (!cmd) return false;
        // Si contiene algún patrón destructivo → NO reversible
        const atoms = splitCompoundCommand(cmd);
        return !atoms.some(atom => DESTRUCTIVE_PATTERNS.some(pat => pat.test(atom)));
    }

    // WebFetch, WebSearch, Skill, etc. → generalmente reversible (lectura)
    if (["WebFetch", "WebSearch", "Skill", "NotebookEdit"].includes(toolName)) {
        return true;
    }

    return false;
}

// ─── Clasificación de severidad ─────────────────────────────────────────────

/**
 * Enum de severidad:
 *   AUTO_ALLOW — acción reversible en directorio seguro → auto-aprobar sin Telegram
 *   LOW        — acción nueva pero recuperable → auto-aprobar inmediatamente
 *   MEDIUM     — impacto externo pero reversible → auto-aprobar inmediatamente (desde #1302)
 *                Incluye: git push (a ramas no-main), curl POST, Task/Agent, npm publish
 *                Protección: branch-guard.js bloquea git push a main independientemente
 *   HIGH       — destructiva o irreversible → requiere aprobación manual via Telegram
 */
const Severity = {
    AUTO_ALLOW: "AUTO_ALLOW",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH"
};

/**
 * Carga auto_allow_tools desde telegram-config.json o usa defaults.
 */
function loadAutoAllowTools() {
    try {
        const cfgPath = path.join(__dirname, "telegram-config.json");
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (Array.isArray(cfg.auto_allow_tools) && cfg.auto_allow_tools.length > 0) {
            return cfg.auto_allow_tools;
        }
    } catch (e) {}
    return [
        "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
        "ToolSearch", "EnterWorktree", "EnterPlanMode", "ExitPlanMode"
    ];
}

/**
 * Carga severity_timeouts desde telegram-config.json o usa defaults.
 * @returns {{ low: number, medium: number, high: number }} tiempos en minutos
 */
function loadSeverityTimeouts() {
    try {
        const cfgPath = path.join(__dirname, "telegram-config.json");
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg.severity_timeouts && typeof cfg.severity_timeouts === "object") {
            return {
                low: cfg.severity_timeouts.low || 2,
                medium: cfg.severity_timeouts.medium || 15,
                high: cfg.severity_timeouts.high || 30
            };
        }
    } catch (e) {}
    return { low: 2, medium: 15, high: 30 };
}

/**
 * Clasifica la severidad de una acción.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} [repoRoot]
 * @returns {string} Severity level
 */
function classifySeverity(toolName, toolInput, repoRoot) {
    // 1. Tools que siempre se auto-aprueban
    const autoAllowTools = loadAutoAllowTools();
    if (autoAllowTools.includes(toolName)) {
        return Severity.AUTO_ALLOW;
    }

    // 2. Edit/Write sobre directorio seguro → AUTO_ALLOW
    if (toolName === "Edit" || toolName === "Write") {
        const fp = toolInput && (toolInput.file_path || toolInput.filePath || "");
        if (isSafeDirectory(fp, repoRoot)) {
            return Severity.AUTO_ALLOW;
        }
        // Edit/Write fuera de safe dir → LOW (recuperable con git)
        return Severity.LOW;
    }

    // 3. Bash: analizar contenido
    if (toolName === "Bash") {
        const cmd = (toolInput && toolInput.command) || "";
        const atoms = splitCompoundCommand(cmd);

        // Si contiene patrones destructivos → HIGH
        const hasDestructive = atoms.some(atom =>
            DESTRUCTIVE_PATTERNS.some(pat => pat.test(atom))
        );
        if (hasDestructive) return Severity.HIGH;

        // Comandos con efecto externo → MEDIUM
        const externalPatterns = [
            /\bgit\s+push\b/,
            /\bcurl\s.*-X\s*(POST|PUT|DELETE|PATCH)/i,
            /\bnpm\s+publish\b/,
            /\bdocker\s+push\b/,
        ];
        const hasExternal = atoms.some(atom =>
            externalPatterns.some(pat => pat.test(atom))
        );
        if (hasExternal) return Severity.MEDIUM;

        // Bash en directorio seguro (todos los paths son safe) → AUTO_ALLOW
        // Solo para comandos simples que operan sobre archivos
        return Severity.LOW;
    }

    // 4. WebFetch, WebSearch → LOW
    if (toolName === "WebFetch" || toolName === "WebSearch") {
        return Severity.LOW;
    }

    // 5. Skill → LOW
    if (toolName === "Skill") {
        return Severity.LOW;
    }

    // 6. NotebookEdit → LOW
    if (toolName === "NotebookEdit") {
        return Severity.LOW;
    }

    // 7. Task/Agent → MEDIUM (subagente puede hacer cosas)
    if (toolName === "Task" || toolName === "Agent") {
        return Severity.MEDIUM;
    }

    // Default → MEDIUM
    return Severity.MEDIUM;
}

/**
 * Severidades que califican para auto-aprobación cuando el último reintento expira
 * sin rechazo explícito del usuario. HIGH y CRITICAL siguen requiriendo respuesta.
 * Centraliza la decisión para facilitar configuración futura.
 */
const AUTO_APPROVE_ON_TIMEOUT = [Severity.LOW, Severity.MEDIUM];

module.exports = {
    resolveMainRepoRoot,
    getSettingsPaths,
    extractFirstCommand,
    splitCompoundCommand,
    generateBashPattern,
    generatePattern,
    isAlreadyCovered,
    collidesWithDeny,
    persistPattern,
    isSafeDirectory,
    isReversibleAction,
    classifySeverity,
    loadSafeDirectories,
    loadAutoAllowTools,
    loadSeverityTimeouts,
    Severity,
    DESTRUCTIVE_PATTERNS,
    AUTO_APPROVE_ON_TIMEOUT
};

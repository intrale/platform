#!/bin/bash
# El Portero 🚪 — Permission Tracker Hook
# PostToolUse hook: detecta comandos Bash aprobados y los persiste en settings.local.json
# Solo procesa tool_name=Bash, genera patron generalizado y lo agrega a allow[]
# NUNCA modifica deny[], NUNCA agrega patrones que matcheen deny[]
# Todo el parsing JSON se hace en node para evitar problemas con comillas escapadas

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
SETTINGS="$PROJECT_DIR/.claude/settings.local.json"
LOG_FILE="$PROJECT_DIR/.claude/permissions-log.jsonl"

# Verificar que settings existe antes de gastar CPU
if [[ ! -f "$SETTINGS" ]]; then
    exit 0
fi

# Leer stdin y pasar todo a node en un solo paso
cat | node -e '
const fs = require("fs");

const settingsPath = process.argv[1];
const logPath = process.argv[2];

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    try {
        const data = JSON.parse(input);

        // Solo procesar Bash
        if (data.tool_name !== "Bash") process.exit(0);

        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command) process.exit(0);

        // --- Generar patron generalizado ---
        const pattern = generatePattern(command.trim());
        if (!pattern) process.exit(0);

        // --- Leer settings ---
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        } catch(e) {
            process.exit(0);
        }

        const allow = (settings.permissions && settings.permissions.allow) || [];
        const deny = (settings.permissions && settings.permissions.deny) || [];

        // Ya existe?
        if (allow.includes(pattern)) process.exit(0);

        // Matchea deny?
        const newMatch = pattern.match(/^Bash\((.+?):\*\)$/);
        if (newMatch) {
            const newCmd = newMatch[1];
            for (const d of deny) {
                const dm = d.match(/^Bash\((.+?):\*\)$/);
                if (!dm) continue;
                const denyCmd = dm[1];
                if (denyCmd.startsWith(newCmd) || newCmd.startsWith(denyCmd)) {
                    process.exit(0);
                }
            }
        }

        // Agregar a allow
        allow.push(pattern);
        settings.permissions = settings.permissions || {};
        settings.permissions.allow = allow;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

        // Registrar en log
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const sessionId = data.session_id || "";
        const logEntry = JSON.stringify({ ts, action: "added", pattern, command, session: sessionId });

        // Crear directorio si no existe
        const logDir = require("path").dirname(logPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(logPath, logEntry + "\n", "utf8");

        // Rotacion
        try {
            const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
            if (lines.length > 200) {
                fs.writeFileSync(logPath, lines.slice(-100).join("\n") + "\n", "utf8");
            }
        } catch(e) {}

    } catch(e) {
        // Silenciar errores — nunca bloquear Claude Code
        process.exit(0);
    }
});

function generatePattern(cmd) {
    // Comando entre comillas: "C:/Program Files/..." args
    if (cmd.startsWith("\"")) {
        const end = cmd.indexOf("\"", 1);
        if (end > 0) {
            const quoted = cmd.substring(1, end);
            return "Bash(\"" + quoted + "\":*)";
        }
    }

    const parts = cmd.split(/\s+/);
    const first = parts[0];

    // Comando sin argumentos
    if (parts.length === 1) return "Bash(" + first + ":*)";

    // git <subcommand>
    if (first === "git") {
        const sub = parts[1];
        if (sub === "credential" && parts.length > 2) {
            return "Bash(git credential " + parts[2] + ":*)";
        }
        if (sub === "-C") return "Bash(git -C:*)";
        return "Bash(git " + sub + ":*)";
    }

    // export VAR=...
    if (first === "export") {
        const rest = parts.slice(1).join(" ");
        const eqIdx = rest.indexOf("=");
        if (eqIdx > 0) {
            const varname = rest.substring(0, eqIdx);
            return "Bash(export " + varname + "=*)";
        }
        return "Bash(export " + parts[1] + ":*)";
    }

    // Path commands: ./gradlew, /c/...
    if (first.startsWith("./") || first.startsWith("/")) {
        return "Bash(" + first + ":*)";
    }

    // VARIABLE=value
    if (first.includes("=")) {
        const varname = first.substring(0, first.indexOf("="));
        return "Bash(" + varname + "=*)";
    }

    // Generico
    return "Bash(" + first + ":*)";
}
' "$SETTINGS" "$LOG_FILE" 2>/dev/null

exit 0

// ensure-permissions.js — Auto-healing de permisos
// PostToolUse hook: verifica que settings.local.json tenga las reglas baseline.
// Fast path: stat() de un flag file — si es reciente (<1h), exit inmediato sin leer stdin.
// Pure Node.js — sin dependencias externas.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const BASELINE_FILE = path.join(CLAUDE_DIR, "permissions-baseline.json");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.local.json");
const FLAG_FILE = path.join(CLAUDE_DIR, "tmp", "permissions-last-check");
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hora

// --- Fast path: no leer stdin, solo stat() del flag ---
try {
    if (fs.existsSync(FLAG_FILE)) {
        const age = Date.now() - fs.statSync(FLAG_FILE).mtimeMs;
        if (age < MAX_AGE_MS) process.exit(0); // <10ms
    }
} catch(e) {}

// --- Slow path: validar y reparar permisos ---
try {
    if (!fs.existsSync(BASELINE_FILE)) process.exit(0);

    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    const baseAllow = baseline.allow || [];
    const baseDeny = baseline.deny || [];

    // Leer settings actual (o crear estructura base)
    let settings = { permissions: { allow: [], deny: [] } };
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        } catch(e) {
            settings = { permissions: { allow: [], deny: [] } };
        }
    }

    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
    if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

    // Merge: agregar reglas faltantes
    let modified = false;

    for (const rule of baseAllow) {
        if (!settings.permissions.allow.includes(rule)) {
            settings.permissions.allow.push(rule);
            modified = true;
        }
    }

    for (const rule of baseDeny) {
        if (!settings.permissions.deny.includes(rule)) {
            settings.permissions.deny.push(rule);
            modified = true;
        }
    }

    if (modified) {
        const tmpPath = SETTINGS_FILE + ".tmp." + process.pid;
        fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        fs.renameSync(tmpPath, SETTINGS_FILE);
    }

    // Crear/actualizar flag
    const flagDir = path.dirname(FLAG_FILE);
    if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
    fs.writeFileSync(FLAG_FILE, new Date().toISOString(), "utf8");

} catch(e) {
    // Nunca bloquear el hook por un error
}

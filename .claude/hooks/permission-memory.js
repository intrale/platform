// permission-memory.js — Análisis de frecuencia del log de permisos (#1159)
// Detecta patrones aprobados con alta frecuencia para proponer como defaults
// Pure Node.js — sin dependencias npm adicionales
// Puede ejecutarse como módulo (importado por stop-notify.js) o standalone

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
    enabled: true,
    window_days: 7,
    threshold_count: 10,
    max_issues_per_session: 3
};

/**
 * Analiza el log de permisos y retorna candidatos que superan el umbral.
 * @param {string} repoRoot - Path al repo principal
 * @param {object} config - Configuración (window_days, threshold_count)
 * @returns {Array<{pattern, count, firstSeen, lastSeen, tools, sessions, topContext}>}
 */
function analyzePermissions(repoRoot, config) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.enabled) return [];

    const logPath = path.join(repoRoot, ".claude", "permissions-log.jsonl");
    if (!fs.existsSync(logPath)) return [];

    // Leer log
    let lines;
    try {
        lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    } catch (e) {
        return [];
    }

    // Ventana de tiempo
    const now = Date.now();
    const windowMs = cfg.window_days * 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;

    // Agrupar por pattern
    const groups = {};
    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; }
        if (!entry.pattern || !entry.ts) continue;

        const entryTime = new Date(entry.ts).getTime();
        if (isNaN(entryTime) || entryTime < cutoff) continue;

        const key = entry.pattern;
        if (!groups[key]) {
            groups[key] = {
                pattern: key,
                count: 0,
                firstSeen: entry.ts,
                lastSeen: entry.ts,
                tools: new Set(),
                sessions: new Set(),
                contexts: {}
            };
        }

        const g = groups[key];
        g.count++;
        if (entry.ts < g.firstSeen) g.firstSeen = entry.ts;
        if (entry.ts > g.lastSeen) g.lastSeen = entry.ts;
        if (entry.tool) g.tools.add(entry.tool);
        if (entry.session) g.sessions.add(entry.session);
        if (entry.context) {
            g.contexts[entry.context] = (g.contexts[entry.context] || 0) + 1;
        }
    }

    // Leer settings para excluir patrones ya presentes
    const existingPatterns = loadExistingAllowPatterns(repoRoot);

    // Filtrar candidatos que superan umbral y no están en settings
    const candidates = [];
    for (const key of Object.keys(groups)) {
        const g = groups[key];
        if (g.count < cfg.threshold_count) continue;
        if (existingPatterns.has(g.pattern)) continue;

        // Determinar contexto más frecuente
        let topContext = "";
        let topCount = 0;
        for (const [ctx, cnt] of Object.entries(g.contexts)) {
            if (cnt > topCount) { topContext = ctx; topCount = cnt; }
        }

        candidates.push({
            pattern: g.pattern,
            count: g.count,
            firstSeen: g.firstSeen,
            lastSeen: g.lastSeen,
            tools: Array.from(g.tools),
            sessions: Array.from(g.sessions),
            topContext
        });
    }

    // Ordenar por frecuencia descendente
    candidates.sort((a, b) => b.count - a.count);

    return candidates;
}

/**
 * Carga los patrones ya presentes en settings.local.json (allow list).
 */
function loadExistingAllowPatterns(repoRoot) {
    const patterns = new Set();
    const settingsPath = path.join(repoRoot, ".claude", "settings.local.json");
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        const allow = (settings.permissions && settings.permissions.allow) || [];
        for (const p of allow) patterns.add(p);
    } catch (e) { /* no settings o error de lectura */ }
    return patterns;
}

module.exports = { analyzePermissions, DEFAULT_CONFIG };

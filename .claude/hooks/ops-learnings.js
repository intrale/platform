// ops-learnings.js — Bitácora operativa auto-actualizable (P-15 + P-16)
// Captura automática de errores, clasificación, escalamiento de severidad
// Auto-mitigation, auto-resolution, digest semanal, promoción a MEMORY.md
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const LEARNINGS_FILE = path.join(HOOKS_DIR, "ops-learnings.jsonl");
const ARCHIVE_FILE = path.join(HOOKS_DIR, "ops-learnings-archive.jsonl");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const MAX_ENTRIES = 500;
const MITIGATE_AFTER_DAYS = 7;
const ARCHIVE_AFTER_DAYS = 30;
const PROMOTE_THRESHOLD_TIMES = 5;
const PROMOTE_THRESHOLD_SEVERITY = "critical";

// Ruta al memory file para promoción (P-16)
const MEMORY_DIR = path.join(
    process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Administrator",
    ".claude", "projects",
    "C--Workspaces-Intrale-platform",
    "memory"
);
const MEMORY_FILE = path.join(MEMORY_DIR, "ops-lessons.md");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] OpsLearnings: " + msg + "\n"); } catch (e) {}
}

// ─── Core CRUD ──────────────────────────────────────────────────────────────

function loadAll() {
    try {
        if (!fs.existsSync(LEARNINGS_FILE)) return [];
        const raw = fs.readFileSync(LEARNINGS_FILE, "utf8").trim();
        if (!raw) return [];
        return raw.split("\n").map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) { return []; }
}

function saveAll(entries) {
    try {
        // Rotación: mantener últimas MAX_ENTRIES
        const toSave = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
        fs.writeFileSync(LEARNINGS_FILE, toSave.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } catch (e) { log("Error guardando learnings: " + e.message); }
}

function findBySymptom(entries, symptom) {
    return entries.find(e => e.symptom === symptom && e.status !== "archived");
}

/**
 * Registrar o actualizar una lección aprendida.
 * Si el symptom ya existe, incrementa times_seen y escala severidad.
 * @param {object} learning - { source, category, severity, symptom, root_cause, resolution, affected }
 */
function recordLearning(learning) {
    const entries = loadAll();
    const now = new Date().toISOString();
    const existing = findBySymptom(entries, learning.symptom);

    if (existing) {
        existing.times_seen = (existing.times_seen || 1) + 1;
        existing.last_seen = now;
        existing.source = learning.source || existing.source;
        if (learning.root_cause) existing.root_cause = learning.root_cause;
        if (learning.resolution) existing.resolution = learning.resolution;

        // Auto-escalamiento de severidad
        if (existing.times_seen >= 5 && existing.severity !== "critical") {
            existing.severity = "critical";
            log("Escalado a critical: " + existing.symptom + " (x" + existing.times_seen + ")");
        } else if (existing.times_seen >= 3 && existing.severity === "low") {
            existing.severity = "high";
            log("Escalado a high: " + existing.symptom + " (x" + existing.times_seen + ")");
        }

        // Si estaba mitigated, reabrir
        if (existing.status === "mitigated") {
            existing.status = "open";
            log("Reabierto: " + existing.symptom);
        }

        saveAll(entries);

        // P-16: Verificar si debe promoverse a MEMORY.md
        if (existing.severity === PROMOTE_THRESHOLD_SEVERITY || existing.times_seen >= PROMOTE_THRESHOLD_TIMES) {
            promoteToMemory(existing);
        }
        return existing;
    }

    // Nueva entry
    const entry = {
        ts: now,
        source: learning.source || "unknown",
        category: learning.category || "unknown",
        severity: learning.severity || "low",
        symptom: learning.symptom,
        root_cause: learning.root_cause || "",
        resolution: learning.resolution || "",
        affected: learning.affected || [],
        auto_detected: learning.auto_detected !== false,
        times_seen: 1,
        first_seen: now,
        last_seen: now,
        status: "open"
    };
    entries.push(entry);
    saveAll(entries);
    log("Nueva lección: [" + entry.severity + "] " + entry.symptom);
    return entry;
}

/**
 * Obtener lecciones con filtros opcionales.
 * @param {object} [filter] - { category, severity, status, source }
 * @returns {Array}
 */
function getLearnings(filter) {
    let entries = loadAll();
    if (!filter) return entries;
    if (filter.category) entries = entries.filter(e => e.category === filter.category);
    if (filter.severity) entries = entries.filter(e => e.severity === filter.severity);
    if (filter.status) entries = entries.filter(e => e.status === filter.status);
    if (filter.source) entries = entries.filter(e => e.source === filter.source);
    return entries;
}

/**
 * Actualizar una lección existente.
 * @param {string} symptom - Symptom a buscar
 * @param {object} updates - Campos a actualizar
 */
function updateLearning(symptom, updates) {
    const entries = loadAll();
    const entry = findBySymptom(entries, symptom);
    if (!entry) return null;
    Object.assign(entry, updates);
    saveAll(entries);
    return entry;
}

/**
 * Auto-mitigar entries sin ocurrencia en N días.
 * Llamar periódicamente (ej: desde Commander en startup o digest).
 */
function autoMitigate() {
    const entries = loadAll();
    const cutoffMs = MITIGATE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let changed = 0;

    for (const entry of entries) {
        if (entry.status !== "open") continue;
        const lastSeen = new Date(entry.last_seen).getTime();
        if (now - lastSeen > cutoffMs) {
            entry.status = "mitigated";
            changed++;
            log("Auto-mitigado: " + entry.symptom + " (sin ocurrencia en " + MITIGATE_AFTER_DAYS + " días)");
        }
    }

    if (changed > 0) saveAll(entries);
    return changed;
}

/**
 * Auto-resolver entries cuando se detecta un commit fix(hooks):
 * @param {string} commitMsg - Mensaje del commit
 */
function autoResolve(commitMsg) {
    if (!commitMsg.match(/fix\(hooks?\)/i)) return 0;
    const entries = loadAll();
    let resolved = 0;

    for (const entry of entries) {
        if (entry.status !== "open" && entry.status !== "mitigated") continue;
        // Buscar si algún archivo afectado aparece en el commit message
        for (const affected of (entry.affected || [])) {
            const filename = path.basename(affected);
            if (commitMsg.includes(filename)) {
                entry.status = "resolved";
                entry.resolved_at = new Date().toISOString();
                resolved++;
                log("Auto-resuelto: " + entry.symptom + " (commit: " + commitMsg.substring(0, 60) + ")");
                break;
            }
        }
    }

    if (resolved > 0) saveAll(entries);
    return resolved;
}

/**
 * Archivar entries resolved hace más de ARCHIVE_AFTER_DAYS días.
 */
function archiveOld() {
    const entries = loadAll();
    const cutoffMs = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toArchive = [];
    const toKeep = [];

    for (const entry of entries) {
        if (entry.status === "resolved" && entry.resolved_at) {
            const resolvedAt = new Date(entry.resolved_at).getTime();
            if (now - resolvedAt > cutoffMs) {
                toArchive.push(entry);
                continue;
            }
        }
        toKeep.push(entry);
    }

    if (toArchive.length > 0) {
        try {
            const archiveLines = toArchive.map(e => JSON.stringify({ ...e, archived_at: new Date().toISOString() })).join("\n") + "\n";
            fs.appendFileSync(ARCHIVE_FILE, archiveLines, "utf8");
            log("Archivados: " + toArchive.length + " entries resueltos");
        } catch (e) { log("Error archivando: " + e.message); }
        saveAll(toKeep);
    }
    return toArchive.length;
}

/**
 * Generar digest para Telegram (resumen de lecciones activas).
 * @returns {string} Texto HTML formateado
 */
function getDigest() {
    const entries = loadAll();
    const open = entries.filter(e => e.status === "open");
    const mitigated = entries.filter(e => e.status === "mitigated");
    const resolved = entries.filter(e => e.status === "resolved");
    const critical = open.filter(e => e.severity === "critical");
    const high = open.filter(e => e.severity === "high");

    let msg = "📋 <b>Ops Learnings — Digest</b>\n\n";
    msg += "📊 " + open.length + " abiertas | " + mitigated.length + " mitigadas | " + resolved.length + " resueltas\n";

    if (critical.length > 0) {
        msg += "\n🚨 <b>Críticas:</b>\n";
        for (const e of critical.slice(0, 5)) {
            msg += "• <code>" + escHtml(e.symptom.substring(0, 60)) + "</code> (x" + e.times_seen + ")\n";
        }
    }

    if (high.length > 0) {
        msg += "\n⚠️ <b>Altas:</b>\n";
        for (const e of high.slice(0, 5)) {
            msg += "• <code>" + escHtml(e.symptom.substring(0, 60)) + "</code> (x" + e.times_seen + ")\n";
        }
    }

    if (open.length === 0 && mitigated.length === 0) {
        msg += "\n✅ Sin lecciones activas — todo limpio.";
    }

    return msg;
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── P-16: Promoción automática a MEMORY.md ────────────────────────────────

function promoteToMemory(entry) {
    try {
        if (!fs.existsSync(MEMORY_DIR)) {
            fs.mkdirSync(MEMORY_DIR, { recursive: true });
        }

        let content = "";
        if (fs.existsSync(MEMORY_FILE)) {
            content = fs.readFileSync(MEMORY_FILE, "utf8");
        } else {
            content = "# Ops Lessons — Lecciones operativas auto-detectadas\n\n";
        }

        // Dedup: no agregar si el symptom ya está
        if (content.includes(entry.symptom.substring(0, 40))) {
            return false;
        }

        const dateStr = entry.first_seen ? entry.first_seen.substring(0, 10) : "?";
        const line = "- **" + entry.severity.toUpperCase() + "** " + entry.symptom
            + (entry.resolution ? " → " + entry.resolution : "")
            + " [" + dateStr + ", x" + entry.times_seen + "]\n";

        content += line;
        fs.writeFileSync(MEMORY_FILE, content, "utf8");
        log("Promovido a MEMORY: " + entry.symptom.substring(0, 60));
        return true;
    } catch (e) {
        log("Error promoviendo a MEMORY: " + e.message);
        return false;
    }
}

// ─── Digest state (para no enviar más de 1 por semana) ───────────────────

const DIGEST_STATE_FILE = path.join(HOOKS_DIR, "ops-learnings-digest.json");
const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 semana

function shouldSendDigest() {
    try {
        if (!fs.existsSync(DIGEST_STATE_FILE)) return true;
        const data = JSON.parse(fs.readFileSync(DIGEST_STATE_FILE, "utf8"));
        return (Date.now() - (data.lastDigest || 0)) > DIGEST_INTERVAL_MS;
    } catch (e) { return true; }
}

function markDigestSent() {
    try { fs.writeFileSync(DIGEST_STATE_FILE, JSON.stringify({ lastDigest: Date.now() }), "utf8"); } catch (e) {}
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    recordLearning,
    getLearnings,
    updateLearning,
    autoMitigate,
    autoResolve,
    archiveOld,
    getDigest,
    promoteToMemory,
    shouldSendDigest,
    markDigestSent
};

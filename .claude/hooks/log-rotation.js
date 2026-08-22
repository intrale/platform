#!/usr/bin/env node
// log-rotation.js — Rotación de logs de hooks para prevenir crecimiento indefinido
//
// Política de retención:
//   .log files:   max 100 KB → rotar a .log.1 (archivado, no eliminación)
//   JSONL files:  max 200 entries → archivar exceso en .archive.jsonl
//
// Uso standalone:  node log-rotation.js [--dry-run] [--verbose]
// Uso desde hooks: require('./log-rotation').rotate()

"use strict";

const fs = require("fs");
const path = require("path");

// #4174 — mecanismo único de rotación gzip+retención. Require guardado: si el
// helper no está disponible (worktree parcial), la rotación by-entries sigue.
let jsonlRotation = null;
try {
    jsonlRotation = require(path.resolve(__dirname, "..", "..", ".pipeline", "lib", "jsonl-rotation.js"));
} catch (e) { /* helper no disponible — degradar a solo by-entries */ }

const HOOKS_DIR = path.dirname(require.main ? require.main.filename : __filename);
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

// ─── Configuración ──────────────────────────────────────────────────────────

const LOG_MAX_BYTES = 100 * 1024; // 100 KB
const JSONL_MAX_ENTRIES = 200;
const ARCHIVE_RETENTION_DAYS = 30; // #4174 — retención de `.gz` archivados.

/**
 * #4174 — JSONL que crecen by-size (no by-entries) y van directo al pipeline
 * gzip+retención del helper. Antes quedaban sin política.
 */
const BY_SIZE_JSONL_FILES = [
    "agent-metrics-history.jsonl",
    "sprint-history.jsonl",
];

/** Archivos .log que requieren rotación por tamaño */
const LOG_FILES = [
    "hook-debug.log",
    "agent-watcher.log",
];

/** Archivos JSONL que requieren rotación por número de entradas */
const JSONL_FILES = [
    "delivery-gate-audit.jsonl",
    "ops-learnings.jsonl",
    "restart-log.jsonl",
    "approval-audit.jsonl",
];

// ─── Utilidades ─────────────────────────────────────────────────────────────

function log(msg) {
    if (VERBOSE) console.log(msg);
}

function fileSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    } catch (e) {
        return 0;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ─── Rotación de archivos .log ───────────────────────────────────────────────

/**
 * Rota un archivo .log si supera el límite de tamaño.
 * Estrategia (#1661): mover a archivo datado (.YYYY-MM-DD.log) para preservar historial.
 * Los archivos datados se acumulan — cleanup externo puede borrar >90 días.
 *
 * @param {string} fileName nombre del archivo (ej: "hook-debug.log")
 * @returns {{ rotated: boolean, before: number, reason: string }}
 */
function rotateLogFile(fileName) {
    const filePath = path.join(HOOKS_DIR, fileName);

    if (!fs.existsSync(filePath)) {
        log(`  [SKIP] ${fileName} no existe`);
        return { rotated: false, before: 0, reason: "no existe" };
    }

    const size = fileSize(filePath);
    if (size <= LOG_MAX_BYTES) {
        log(`  [OK]   ${fileName} ${formatBytes(size)} ≤ 100 KB, sin rotación necesaria`);
        return { rotated: false, before: size, reason: `${formatBytes(size)} bajo el límite` };
    }

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const baseName = fileName.replace(/\.log$/, "");
    const archivePath = path.join(HOOKS_DIR, `${baseName}.${dateStr}.log`);

    log(`  [ROT]  ${fileName} ${formatBytes(size)} > 100 KB → rotando a ${baseName}.${dateStr}.log`);

    if (!DRY_RUN) {
        // Si ya existe archivo datado de hoy, append en vez de sobreescribir
        if (fs.existsSync(archivePath)) {
            fs.appendFileSync(archivePath, fs.readFileSync(filePath, "utf8"));
        } else {
            fs.copyFileSync(filePath, archivePath);
        }
        const header = `[${new Date().toISOString()}] Log rotado — archivo anterior en ${baseName}.${dateStr}.log\n`;
        fs.writeFileSync(filePath, header, "utf8");
    }

    return { rotated: true, before: size, reason: `${formatBytes(size)} > 100 KB` };
}

// ─── Rotación de archivos JSONL ──────────────────────────────────────────────

/**
 * Rota un archivo JSONL si supera el límite de entradas.
 * Estrategia: conservar las últimas N entradas en el archivo actual,
 * y archivar el exceso en .archive.jsonl (append).
 * Esto preserva todos los datos históricos.
 *
 * @param {string} fileName nombre del archivo (ej: "delivery-gate-audit.jsonl")
 * @returns {{ rotated: boolean, before: number, after: number, archived: number, reason: string }}
 */
function rotateJsonlFile(fileName) {
    const filePath = path.join(HOOKS_DIR, fileName);
    const archivePath = filePath.replace(".jsonl", ".archive.jsonl");

    if (!fs.existsSync(filePath)) {
        log(`  [SKIP] ${fileName} no existe`);
        return { rotated: false, before: 0, after: 0, archived: 0, reason: "no existe" };
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n").filter(l => l.trim().length > 0);
    const count = lines.length;

    if (count <= JSONL_MAX_ENTRIES) {
        log(`  [OK]   ${fileName} ${count} entradas ≤ 200, sin rotación necesaria`);
        return { rotated: false, before: count, after: count, archived: 0, reason: `${count} entradas bajo el límite` };
    }

    const excess = lines.slice(0, count - JSONL_MAX_ENTRIES);
    const keep = lines.slice(count - JSONL_MAX_ENTRIES);
    const archivedCount = excess.length;

    log(`  [ROT]  ${fileName} ${count} entradas > 200 → archivando ${archivedCount} en ${path.basename(archivePath)}`);

    if (!DRY_RUN) {
        // Archivar exceso (append al archivo de archivo histórico)
        fs.appendFileSync(archivePath, excess.join("\n") + "\n", "utf8");
        // Escribir solo las entradas recientes
        fs.writeFileSync(filePath, keep.join("\n") + "\n", "utf8");
        // #4174 — el `.archive.jsonl` ya no crece sin política: cuando supera
        // el umbral se gzipea y se le aplica retención (mecanismo único).
        if (jsonlRotation) {
            try {
                jsonlRotation.rotateIfNeeded({ path: archivePath, redact: true });
                jsonlRotation.cleanupOldArchives({
                    dir: path.dirname(archivePath),
                    basename: path.basename(archivePath, ".jsonl"),
                    retentionDays: ARCHIVE_RETENTION_DAYS,
                });
            } catch (e) { log(`  [WARN] gzip/retención del archive falló: ${e.message}`); }
        }
    }

    return {
        rotated: true,
        before: count,
        after: keep.length,
        archived: archivedCount,
        reason: `${count} entradas > 200`,
    };
}

// ─── Rotación by-size (gzip + retención) ─────────────────────────────────────

/**
 * #4174 — Rota by-size los JSONL de BY_SIZE_JSONL_FILES delegando en el helper
 * `jsonl-rotation.js` (gzip cuando supera el umbral + retención 30d + redacción
 * de secrets pre-gzip). Unifica el mecanismo: no quedan JSONL creciendo sin
 * política. Si el helper no está disponible, no hace nada.
 *
 * @returns {Array<{ file: string, rotated: boolean, reason?: string }>}
 */
function rotateBySizeJsonl() {
    const results = [];
    if (!jsonlRotation) return results;
    for (const fileName of BY_SIZE_JSONL_FILES) {
        const filePath = path.join(HOOKS_DIR, fileName);
        if (!fs.existsSync(filePath)) {
            results.push({ file: fileName, rotated: false, reason: "no existe" });
            continue;
        }
        let r = { rotated: false, reason: "dry-run" };
        if (!DRY_RUN) {
            try {
                r = jsonlRotation.rotateIfNeeded({ path: filePath, redact: true });
                jsonlRotation.cleanupOldArchives({
                    dir: HOOKS_DIR,
                    basename: path.basename(filePath, ".jsonl"),
                    retentionDays: ARCHIVE_RETENTION_DAYS,
                });
            } catch (e) { r = { rotated: false, error: e.message }; }
        }
        results.push({ file: fileName, ...r });
    }
    return results;
}

// ─── Función principal ───────────────────────────────────────────────────────

/**
 * Ejecuta la rotación completa de todos los logs configurados.
 * Puede llamarse como módulo desde /ghostbusters u otros scripts.
 *
 * @param {{ dryRun?: boolean, verbose?: boolean }} opts
 * @returns {{ logs: Array, jsonl: Array, summary: string }}
 */
function rotate(opts = {}) {
    const isDry = opts.dryRun || DRY_RUN;
    const isVerbose = opts.verbose || VERBOSE;

    const results = {
        logs: [],
        jsonl: [],
        bySize: [],
    };

    if (isVerbose) {
        console.log(`\n=== Log Rotation ${isDry ? "[DRY-RUN] " : ""}===`);
        console.log(`Directorio: ${HOOKS_DIR}`);
        console.log(`Límite .log: ${formatBytes(LOG_MAX_BYTES)} | Límite JSONL: ${JSONL_MAX_ENTRIES} entradas\n`);
    }

    // Rotar archivos .log
    if (isVerbose) console.log("Archivos .log:");
    for (const fileName of LOG_FILES) {
        const result = rotateLogFile(fileName);
        results.logs.push({ file: fileName, ...result });
    }

    // Rotar archivos JSONL (by-entries)
    if (isVerbose) console.log("\nArchivos JSONL:");
    for (const fileName of JSONL_FILES) {
        const result = rotateJsonlFile(fileName);
        results.jsonl.push({ file: fileName, ...result });
    }

    // Rotar archivos JSONL by-size (gzip + retención, #4174)
    if (isVerbose) console.log("\nArchivos JSONL by-size (gzip + retención):");
    results.bySize = rotateBySizeJsonl();

    // Resumen
    const rotatedLogs = results.logs.filter(r => r.rotated).length;
    const rotatedJsonl = results.jsonl.filter(r => r.rotated).length;
    const rotatedBySize = results.bySize.filter(r => r.rotated).length;
    const total = rotatedLogs + rotatedJsonl + rotatedBySize;

    results.summary = total === 0
        ? "Sin rotaciones necesarias — todos los logs dentro del límite"
        : `${total} archivo(s) rotado(s): ${rotatedLogs} .log, ${rotatedJsonl} JSONL, ${rotatedBySize} by-size`;

    if (isVerbose || require.main) {
        console.log(`\n${isDry ? "[DRY-RUN] " : ""}${results.summary}`);
    }

    return results;
}

// ─── Ejecución standalone ────────────────────────────────────────────────────

if (require.main === module) {
    const results = rotate({ verbose: true });

    // Exit code 0 siempre (rotación exitosa o sin necesidad)
    process.exit(0);
}

module.exports = { rotate, rotateBySizeJsonl, LOG_FILES, JSONL_FILES, BY_SIZE_JSONL_FILES, LOG_MAX_BYTES, JSONL_MAX_ENTRIES, ARCHIVE_RETENTION_DAYS };

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

const HOOKS_DIR = path.dirname(require.main ? require.main.filename : __filename);
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

// ─── Configuración ──────────────────────────────────────────────────────────

const LOG_MAX_BYTES = 100 * 1024; // 100 KB
const JSONL_MAX_ENTRIES = 200;

/** Archivos .log que requieren rotación por tamaño */
const LOG_FILES = [
    "hook-debug.log",
    "agent-watcher.log",
];

/** Archivos JSONL que requieren rotación por número de entradas */
const JSONL_FILES = [
    "delivery-gate-audit.jsonl",
    "scrum-health-history.jsonl",
    "sprint-audit.jsonl",
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
    }

    return {
        rotated: true,
        before: count,
        after: keep.length,
        archived: archivedCount,
        reason: `${count} entradas > 200`,
    };
}

// ─── Función principal ───────────────────────────────────────────────────────

/**
 * Ejecuta la rotación completa de todos los logs configurados.
 * Puede llamarse como módulo desde /cleanup u otros scripts.
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

    // Rotar archivos JSONL
    if (isVerbose) console.log("\nArchivos JSONL:");
    for (const fileName of JSONL_FILES) {
        const result = rotateJsonlFile(fileName);
        results.jsonl.push({ file: fileName, ...result });
    }

    // Resumen
    const rotatedLogs = results.logs.filter(r => r.rotated).length;
    const rotatedJsonl = results.jsonl.filter(r => r.rotated).length;
    const total = rotatedLogs + rotatedJsonl;

    results.summary = total === 0
        ? "Sin rotaciones necesarias — todos los logs dentro del límite"
        : `${total} archivo(s) rotado(s): ${rotatedLogs} .log, ${rotatedJsonl} JSONL`;

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

module.exports = { rotate, LOG_FILES, JSONL_FILES, LOG_MAX_BYTES, JSONL_MAX_ENTRIES };

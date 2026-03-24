// atomic-write.js — Solucion S1 del reporte operativo 2026-03-24
// Escritura atomica de archivos JSON/JSONL para prevenir corrupcion por hooks concurrentes
// Mecanismo: Serializa → Valida JSON parseable → Escribe a .tmp-[random] → Rename atomico
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Escribe un objeto JSON de forma atomica (write-to-temp + rename).
 * @param {string} filePath - Ruta del archivo destino
 * @param {*} data - Objeto a serializar
 * @param {object} [opts] - Opciones: { backup: false, indent: 2 }
 */
function writeJsonAtomic(filePath, data, opts) {
  opts = opts || {};
  const indent = opts.indent !== undefined ? opts.indent : 2;
  const content = JSON.stringify(data, null, indent);

  // Validar que lo serializado sea parseable
  JSON.parse(content);

  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, ".tmp-" + crypto.randomBytes(6).toString("hex"));

  try {
    fs.writeFileSync(tmpFile, content, "utf8");

    // Backup opcional antes de sobreescribir
    if (opts.backup && fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, filePath + ".bak"); } catch (e) {}
    }

    // Rename atomico (en NTFS mismo volumen es atomico)
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    // Limpiar temp file si quedo
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    throw e;
  }
}

/**
 * Append una entrada JSONL de forma segura (valida JSON antes de escribir).
 * @param {string} filePath - Ruta del archivo JSONL
 * @param {*} entry - Objeto a agregar como linea
 */
function appendJsonlAtomic(filePath, entry) {
  const line = JSON.stringify(entry);
  // Validar que sea JSON valido
  JSON.parse(line);
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

/**
 * Lee un archivo JSON con auto-sanitizacion de merge conflict markers.
 * Si el archivo esta corrupto, intenta .bak como fallback.
 * @param {string} filePath - Ruta del archivo
 * @param {*} [defaultValue] - Valor por defecto si no se puede leer
 * @returns {*} Objeto parseado
 */
function readJsonSafe(filePath, defaultValue) {
  if (defaultValue === undefined) defaultValue = {};
  try {
    let content = fs.readFileSync(filePath, "utf8");
    if (hasConflictMarkers(content)) {
      content = sanitizeConflictMarkers(content);
      // Auto-reparar: reescribir sin markers
      try { fs.writeFileSync(filePath, content, "utf8"); } catch (_) {}
    }
    return JSON.parse(content);
  } catch (e) {
    // Fallback: intentar .bak
    try {
      const bakContent = fs.readFileSync(filePath + ".bak", "utf8");
      const parsed = JSON.parse(bakContent);
      // Restaurar desde backup
      try { fs.writeFileSync(filePath, bakContent, "utf8"); } catch (_) {}
      return parsed;
    } catch (_) {}
    return defaultValue;
  }
}

/**
 * Lee un archivo JSONL filtrando lineas invalidas y conflict markers.
 * Auto-reescribe si detecta corrupcion.
 * @param {string} filePath - Ruta del archivo JSONL
 * @returns {Array} Array de objetos parseados
 */
function readJsonlSafe(filePath) {
  try {
    let content = fs.readFileSync(filePath, "utf8");
    let corrupted = false;

    if (hasConflictMarkers(content)) {
      content = sanitizeConflictMarkers(content);
      corrupted = true;
    }

    const lines = content.split("\n").filter(l => l.trim());
    const valid = [];
    for (const line of lines) {
      try {
        valid.push(JSON.parse(line));
      } catch (_) {
        corrupted = true; // Linea invalida detectada
      }
    }

    // Auto-reparar si hubo corrupcion
    if (corrupted) {
      try {
        const cleaned = valid.map(v => JSON.stringify(v)).join("\n") + (valid.length ? "\n" : "");
        fs.writeFileSync(filePath, cleaned, "utf8");
      } catch (_) {}
    }

    return valid;
  } catch (_) {
    return [];
  }
}

/**
 * Detecta si un string contiene merge conflict markers.
 */
function hasConflictMarkers(content) {
  return /^<{7}\s/m.test(content) || /^={7}$/m.test(content) || /^>{7}\s/m.test(content);
}

/**
 * Remueve marcadores de merge conflict, manteniendo la seccion "ours".
 * @param {string} content - Contenido con posibles markers
 * @returns {string} Contenido limpio
 */
function sanitizeConflictMarkers(content) {
  // Patron: <<<<<<< ... (ours content) ... ======= ... (theirs content) ... >>>>>>>
  return content.replace(
    /^<{7}[^\n]*\n([\s\S]*?)^={7}\n[\s\S]*?^>{7}[^\n]*/gm,
    "$1"
  );
}

/**
 * Limpia archivos .tmp-* stale de un directorio.
 * @param {string} dir - Directorio a limpiar
 * @param {number} [maxAgeMs=60000] - Edad maxima en ms (default 60s)
 * @returns {number} Cantidad de archivos eliminados
 */
function cleanStaleTempFiles(dir, maxAgeMs) {
  maxAgeMs = maxAgeMs || 60000;
  let count = 0;
  try {
    const files = fs.readdirSync(dir);
    const now = Date.now();
    for (const f of files) {
      if (!f.startsWith(".tmp-")) continue;
      try {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          count++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return count;
}

module.exports = {
  writeJsonAtomic,
  appendJsonlAtomic,
  readJsonSafe,
  readJsonlSafe,
  sanitizeConflictMarkers,
  hasConflictMarkers,
  cleanStaleTempFiles
};

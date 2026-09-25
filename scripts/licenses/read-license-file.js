// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// read-license-file.js — Lectura acotada de LICENSE*/NOTICE* (#7592, SR-6)
//
// Se usa sólo para extraer las líneas de copyright de un paquete npm instalado.
// Reglas:
//   - El archivo se busca DENTRO del directorio del paquete; se resuelve con
//     realpath y se exige que el resultado quede contenido en ese directorio
//     (bloquea `../../` y symlinks que apuntan afuera).
//   - lstat: se rechazan symlinks (aunque apunten adentro) y todo lo que no sea
//     un archivo regular.
//   - Tope de tamaño (256 KB). Se lee sólo como texto utf8.
// Nunca lanza: ante cualquier problema devuelve `null`.
// =============================================================================
'use strict';

const nodeFs = require('fs');
const path = require('path');
const sanitize = require('./sanitize');

const MAX_BYTES = 256 * 1024;
const LICENSE_FILE_RE = /^(licen[sc]e|copying|notice)(\.[a-z0-9]+)?$/i;
const COPYRIGHT_LINE_RE = /^\s*(copyright\b|\(c\)\s|©)/i;
const MAX_COPYRIGHT_LINES = 3;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Lee un archivo de licencia de forma segura.
 * @param {string} packageDir  directorio del paquete
 * @param {string} relName     nombre (o path relativo declarado) del archivo
 * @param {{ fs?: object, maxBytes?: number }} [opts]
 * @returns {string|null}
 */
function readLicenseFile(packageDir, relName, opts = {}) {
  const fs = opts.fs || nodeFs;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  try {
    if (typeof relName !== 'string' || relName === '' || path.isAbsolute(relName)) return null;
    const realDir = fs.realpathSync(packageDir);
    const candidate = path.resolve(realDir, relName);
    if (!isInside(realDir, candidate)) return null;
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > maxBytes) return null;
    const real = fs.realpathSync(candidate);
    if (!isInside(realDir, real)) return null;
    return fs.readFileSync(real, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

// Busca LICENSE, COPYING y NOTICE (con o sin extensión) en la raíz del paquete,
// en orden estable.
function findLicenseFiles(packageDir, opts = {}) {
  const fs = opts.fs || nodeFs;
  try {
    return fs.readdirSync(packageDir)
      .filter((name) => LICENSE_FILE_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extrae hasta 3 líneas de copyright de los archivos de licencia del paquete.
 * @returns {string|null} líneas saneadas unidas con " / ", o null si no hay.
 */
function extractCopyright(packageDir, opts = {}) {
  const lines = [];
  for (const name of findLicenseFiles(packageDir, opts)) {
    const content = readLicenseFile(packageDir, name, opts);
    if (content === null) continue;
    for (const line of content.split(/\r?\n/)) {
      if (!COPYRIGHT_LINE_RE.test(line)) continue;
      const clean = sanitize.text(line, 160);
      if (clean && !lines.includes(clean)) lines.push(clean);
      if (lines.length >= MAX_COPYRIGHT_LINES) break;
    }
    if (lines.length >= MAX_COPYRIGHT_LINES) break;
  }
  return lines.length ? lines.join(' / ') : null;
}

module.exports = { MAX_BYTES, readLicenseFile, findLicenseFiles, extractCopyright };

// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// collect-npm.js — Inventario npm desde package-lock.json v2/v3 (#7592)
//
// Lee el campo `packages[*].license` del lockfile (npm ya lo resuelve). NO copia
// `resolved`, `integrity` ni ningún otro dato de registry (SR-7): la URL pública
// se deriva del nombre del paquete.
//
// Exclusiones: el paquete raíz (clave ''), entradas `link: true` (workspaces
// locales), entradas fuera de `node_modules/` y paquetes `private: true`.
// Los lockfiles que no se inventarían (ej. fixtures de test) se declaran en la
// política (`npm.excluidos`) y aparecen en el reporte como fuera de alcance.
// =============================================================================
'use strict';

const nodeFs = require('fs');
const path = require('path');
const { normalizeLicense } = require('./spdx');

const NM = 'node_modules/';

function packageNameFromKey(key) {
  const idx = key.lastIndexOf(NM);
  return idx === -1 ? null : key.slice(idx + NM.length);
}

/**
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {Array<{path:string, alcance?:string}>} opts.lockfiles  declarados en la política
 * @param {Map} opts.aliasIndex
 * @param {object} [opts.fs]
 * @returns {{ entries: object[], stats: Record<string, number> }}
 */
function collectNpm({ rootDir, lockfiles, aliasIndex, fs = nodeFs }) {
  if (!Array.isArray(lockfiles) || lockfiles.length === 0) {
    throw new Error('la política no declara lockfiles npm (npm.lockfiles)');
  }
  const byKey = new Map();
  const stats = {};

  for (const lf of lockfiles) {
    const rel = lf && lf.path;
    if (typeof rel !== 'string' || rel === '') throw new Error('lockfile npm sin path en la política');
    const abs = path.join(rootDir, rel);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new Error(`no se pudo leer el lockfile npm ${rel}: ${e.code || e.message}`);
    }
    if (!doc || (doc.lockfileVersion !== 2 && doc.lockfileVersion !== 3) || typeof doc.packages !== 'object') {
      throw new Error(`lockfile npm ${rel}: se esperaba lockfileVersion 2 o 3 con "packages"`);
    }
    let count = 0;
    for (const [key, pkg] of Object.entries(doc.packages)) {
      if (key === '' || !pkg || typeof pkg !== 'object') continue;
      if (pkg.link === true || pkg.private === true) continue;
      const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : packageNameFromKey(key);
      if (!name || typeof pkg.version !== 'string' || !pkg.version) continue;

      const version = pkg.version;
      // Alcance: el lockfile puede fijarlo para todas sus entradas (ej. tooling
      // interno que nunca se distribuye); si no, las devDependencies son
      // build/test y el resto se distribuye.
      const scope = lf.alcance === 'build/test' || lf.alcance === 'distribuido'
        ? lf.alcance
        : (pkg.dev === true ? 'build/test' : 'distribuido');
      const id = `npm|${name}|${version}`;
      count++;

      let entry = byKey.get(id);
      if (!entry) {
        const norm = normalizeLicense(pkg.license, aliasIndex);
        entry = {
          ecosystem: 'npm',
          coordinate: name,
          version,
          declared: norm.declared,
          expression: norm.expression,
          unknownReason: norm.ast.kind === 'unknown' ? norm.ast.reason : null,
          unmapped: [],
          scope,
          origins: [],
          url: `https://www.npmjs.com/package/${name}`,
          // Directorios instalados (relativos a la raíz): sólo para buscar el
          // copyright en `generate`. No se serializan.
          installDirs: [],
        };
        byKey.set(id, entry);
      } else if (scope === 'distribuido') {
        entry.scope = 'distribuido';
      }
      if (!entry.origins.includes(rel)) entry.origins.push(rel);
      entry.installDirs.push(path.posix.join(path.posix.dirname(rel.replace(/\\/g, '/')), key));
    }
    stats[rel] = count;
  }

  for (const e of byKey.values()) e.origins.sort();
  return { entries: [...byKey.values()], stats };
}

module.exports = { collectNpm, packageNameFromKey };

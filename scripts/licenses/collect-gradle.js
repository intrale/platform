// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// collect-gradle.js — Inventario Gradle desde los reportes de licensee (#7592)
//
// `./gradlew licensesInventory` deja, por módulo y por target, un
// `<módulo>/build/reports/licensee/[<target>/]artifacts.json`. Acá sólo se leen
// y se normalizan; la decisión de política la toma policy.js.
//
// Semántica de licencias del POM: varias `<license>` en un mismo POM se leen
// como licenciamiento dual (OR), igual que licensee. Las licencias que licensee
// no pudo mapear a SPDX se intentan resolver con `aliases` de la política (por
// URL y por nombre); si ninguna licencia del artefacto queda mapeada, el
// artefacto es DESCONOCIDO (fail-closed).
//
// CA-1: si un módulo esperado no tiene ningún artifacts.json, se lanza error.
//
// Variantes nativas por host: `compose.desktop.currentOs` resuelve el artefacto
// del SO que corre Gradle (desktop-jvm-windows-x64 en la máquina del operador,
// desktop-jvm-linux-x64 en CI). Para que el inventario sea el mismo en cualquier
// host, las coordenadas declaradas en `gradle.variantes_por_host` de la política
// se normalizan a `<prefijo><os>-<arch>` (misma licencia en todas las variantes).
// =============================================================================
'use strict';

const nodeFs = require('fs');
const path = require('path');
const { lookupAlias, parseExpression, toString } = require('./spdx');

function findArtifactFiles(dir, fs) {
  const out = [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...findArtifactFiles(p, fs));
    else if (it.isFile() && it.name === 'artifacts.json') out.push(p);
  }
  return out;
}

function resolveLicenses(artifact, aliasIndex) {
  const ids = [];
  const unmapped = [];
  const declaredParts = [];
  for (const l of Array.isArray(artifact.spdxLicenses) ? artifact.spdxLicenses : []) {
    if (l && typeof l.identifier === 'string' && l.identifier) {
      ids.push(l.identifier);
      declaredParts.push(l.identifier);
    }
  }
  for (const l of Array.isArray(artifact.unknownLicenses) ? artifact.unknownLicenses : []) {
    if (!l || typeof l !== 'object') continue;
    const name = typeof l.name === 'string' ? l.name : '';
    const url = typeof l.url === 'string' ? l.url : '';
    declaredParts.push(name || url || '?');
    const mapped = (url && lookupAlias(url, aliasIndex)) || (name && lookupAlias(name, aliasIndex));
    if (mapped) ids.push(mapped);
    else unmapped.push(name && url ? `${name} <${url}>` : name || url || '(sin nombre ni URL)');
  }
  const unique = [...new Set(ids)];
  const declared = declaredParts.join(' | ');
  if (unique.length === 0) {
    const reason = unmapped.length
      ? 'la licencia declarada en el POM no mapea a SPDX'
      : 'sin licencia declarada en el POM';
    return { declared, expression: null, unknownReason: reason, unmapped };
  }
  const exprText = unique.length === 1 ? unique[0] : unique.map((x) => `(${x})`).join(' OR ');
  const ast = parseExpression(exprText);
  if (ast.kind === 'unknown') return { declared, expression: null, unknownReason: ast.reason, unmapped };
  return { declared, expression: toString(ast), unknownReason: null, unmapped };
}

const HOST_SUFFIX = /^(windows|linux|macos)-(x64|arm64)$/;

/** Normaliza el artifactId de una variante nativa por host; si no aplica, lo deja igual. */
function normalizeHostVariant(groupId, artifactId, hostVariants) {
  for (const v of Array.isArray(hostVariants) ? hostVariants : []) {
    if (!v || v.grupo !== groupId || typeof v.prefijo !== 'string' || !v.prefijo) continue;
    if (!artifactId.startsWith(v.prefijo)) continue;
    if (HOST_SUFFIX.test(artifactId.slice(v.prefijo.length))) return `${v.prefijo}<os>-<arch>`;
  }
  return artifactId;
}

function publicUrl(artifact) {
  const u = artifact && artifact.scm && artifact.scm.url;
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {Array<{path:string, dir:string, alcance:string}>} opts.modules
 * @param {Map} opts.aliasIndex
 * @param {Array<{grupo:string, prefijo:string}>} [opts.hostVariants]
 * @param {object} [opts.fs]
 */
function collectGradle({ rootDir, modules, aliasIndex, hostVariants = [], fs = nodeFs }) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('la política no declara módulos Gradle (gradle.modulos)');
  }
  const byKey = new Map();
  const stats = {};
  const missing = [];

  for (const mod of modules) {
    const reportDir = path.join(rootDir, mod.dir, 'build', 'reports', 'licensee');
    const files = findArtifactFiles(reportDir, fs);
    if (files.length === 0) {
      missing.push(mod.path);
      continue;
    }
    const scope = mod.alcance === 'distribuido' ? 'distribuido' : 'build/test';
    let count = 0;
    for (const file of files) {
      let artifacts;
      try {
        artifacts = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`artifacts.json ilegible en ${path.relative(rootDir, file)}: ${e.message}`);
      }
      if (!Array.isArray(artifacts)) {
        throw new Error(`artifacts.json inválido en ${path.relative(rootDir, file)}: se esperaba un array`);
      }
      for (const a of artifacts) {
        if (!a || typeof a.groupId !== 'string' || typeof a.artifactId !== 'string' || typeof a.version !== 'string') continue;
        const coordinate = `${a.groupId}:${normalizeHostVariant(a.groupId, a.artifactId, hostVariants)}`;
        const id = `gradle|${coordinate}|${a.version}`;
        count++;
        let entry = byKey.get(id);
        if (!entry) {
          const lic = resolveLicenses(a, aliasIndex);
          entry = {
            ecosystem: 'gradle',
            coordinate,
            version: a.version,
            declared: lic.declared,
            expression: lic.expression,
            unknownReason: lic.unknownReason,
            unmapped: lic.unmapped,
            scope,
            origins: [],
            url: publicUrl(a),
          };
          byKey.set(id, entry);
        } else if (scope === 'distribuido') {
          entry.scope = 'distribuido';
        }
        if (!entry.origins.includes(mod.path)) entry.origins.push(mod.path);
      }
    }
    stats[mod.path] = count;
  }

  if (missing.length) {
    throw new Error(
      `faltan los artifacts.json de licensee en: ${missing.join(', ')}. ` +
        'Ejecutá: ./gradlew licensesInventory --no-daemon'
    );
  }
  for (const e of byKey.values()) e.origins.sort();
  return { entries: [...byKey.values()], stats };
}

module.exports = { collectGradle, resolveLicenses, findArtifactFiles, normalizeHostVariant };

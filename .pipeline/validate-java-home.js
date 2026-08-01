#!/usr/bin/env node
// =============================================================================
// validate-java-home.js — Fail-fast validator para $JAVA_HOME
//
// Criterio CA-1 de #2405:
//   - Lee `build.java_home_allowlist` de `pipeline.config.json` (lado producto,
//     #5174), con fallback a `.pipeline/config.yaml` para el rollback de la
//     partición.
//   - Compara normalizando:
//       * separadores `/` vs `\` (Windows)
//       * case-insensitive (Windows FS default)
//       * symlinks/junctions resueltos (fs.realpathSync)
//       * rechaza `..` y whitespace embebido
//   - Si matchea → exit 0.
//   - Si no matchea → exit 78 (sysexits EX_CONFIG) + mensaje accionable a stderr.
//   - Si allowlist vacía o YAML roto → exit 78 (fail-closed).
//
// CLI:
//   node .pipeline/validate-java-home.js [--quiet]
//
// API:
//   const { validateJavaHome } = require('./validate-java-home');
//   const { ok, reason } = validateJavaHome({ javaHome, allowlist });
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const EXIT_CONFIG_ERROR = 78;

/**
 * Normaliza un path para comparar contra la allowlist:
 *   - Cambia `\` por `/`.
 *   - Quita trailing slash.
 *   - Lowercase (en Windows el FS es case-insensitive; también aceptamos
 *     allowlist en mayúsculas/minúsculas).
 */
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return String(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Resuelve symlinks/junctions sin tirar si el path no existe. Si no podemos
 * resolver (disco offline, permisos), devolvemos el path original normalizado.
 */
function realpathBestEffort(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * #5174 — Dónde vive `pipeline.config.json` dado el `config.yaml` del kernel.
 *
 * Réplica DELIBERADA de `productPathFor()` de `lib/config-resolver.js`: este
 * script corre como validador fail-fast ANTES del build, también en worktrees
 * sin `node_modules` (por eso el `require('yaml')` de abajo está en try/catch).
 * `config-resolver` hace `require('js-yaml')` y `require('ajv')` en su tope, así
 * que requerirlo acá mataría el validador en el import — el modo de fallo mudo
 * que la nota G-3 de `config-resolver.js` advierte explícitamente.
 *
 * Lo que SÍ se comparte es la regla de ubicación: derivada de la raíz del
 * kernel, nunca del entorno ni del propio manifiesto.
 */
function productManifestPathFor(configPath) {
  const kernelDir = path.dirname(path.resolve(configPath));
  const base = path.basename(kernelDir) === '.pipeline' ? path.dirname(kernelDir) : kernelDir;
  return path.join(base, 'pipeline.config.json');
}

/**
 * #5174 — Lee `build.java_home_allowlist` del lado PRODUCTO.
 *
 * `build:` es una de las 12 secciones que la partición movió de `config.yaml`
 * a `pipeline.config.json`. Sin este lector la allowlist quedaba VACÍA y el
 * validador rechazaba todo JAVA_HOME con exit 78: no es degradación silenciosa
 * (falla cerrado, como debe), pero deja el build fuera de servicio.
 *
 * `JSON.parse` es built-in: cero dependencias, corre igual sin `node_modules`.
 *
 * @returns {string[]|null} la lista, o `null` si el manifiesto no está o no
 *          declara la clave (⇒ el llamador cae al kernel, que es el estado
 *          pre-partición y el destino del rollback).
 */
function loadAllowlistFromProduct(configPath) {
  let raw = '';
  try {
    raw = fs.readFileSync(productManifestPathFor(configPath), 'utf8');
  } catch {
    return null; // sin manifiesto ⇒ partición apagada o rollback: usar el kernel
  }
  try {
    const doc = JSON.parse(raw);
    const slice = (doc && doc.productConfig) || doc;
    const list = slice && slice.build && slice.build.java_home_allowlist;
    if (!Array.isArray(list)) return null;
    return list.filter((x) => typeof x === 'string');
  } catch {
    // Manifiesto ilegible: NO lo tapamos con el kernel (ahí la clave ya no está)
    // ni inventamos una lista. Lista vacía ⇒ fail-closed en el validador.
    return [];
  }
}

/**
 * Carga la allowlist desde la configuración del pipeline. Usa `yaml` si está
 * disponible, si no hace un parseo manual muy conservador (sólo el bloque
 * `build.java_home_allowlist`).
 *
 * #5174 — Post-partición `build:` vive en `pipeline.config.json`, así que ese
 * lado tiene PRECEDENCIA. El kernel (`config.yaml`) queda como fallback para el
 * rollback de la partición, donde la clave vuelve al YAML.
 *
 * Fail-closed: si no podemos parsear → allowlist vacía, el validador falla 78.
 */
function loadAllowlist(configPath) {
  const desdeProducto = loadAllowlistFromProduct(configPath);
  if (desdeProducto !== null) return { ok: true, list: desdeProducto };

  let rawYaml = '';
  try {
    rawYaml = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, reason: `cannot-read-config: ${configPath}`, list: [] };
  }

  // 1) Intentar con paquete `yaml` si está
  try {
    // eslint-disable-next-line global-require
    const yaml = require('yaml');
    const doc = yaml.parse(rawYaml) || {};
    const list = (doc.build && Array.isArray(doc.build.java_home_allowlist))
      ? doc.build.java_home_allowlist.filter((x) => typeof x === 'string')
      : [];
    return { ok: true, list };
  } catch (e) {
    // fallthrough
  }

  // 2) Parseo manual minimalista: busca bloque `build:` → `  java_home_allowlist:` → items `    - "..."`
  const lines = rawYaml.split(/\r?\n/);
  let inBuild = false;
  let inList = false;
  const list = [];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    if (/^build:\s*$/.test(line)) { inBuild = true; inList = false; continue; }
    if (inBuild && /^\S/.test(line) && !/^build:\s*$/.test(line)) {
      // top-level distinto → salimos del bloque build
      inBuild = false;
      inList = false;
    }
    if (inBuild && /^\s{2,}java_home_allowlist:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inBuild && inList) {
      const m = line.match(/^\s{4,}-\s*(['"]?)([^'"\s].*?)\1\s*$/);
      if (m) {
        list.push(m[2].trim());
      } else if (/^\s{2,}\S/.test(line) && !/^\s{4,}-/.test(line)) {
        // clave hermana → cierra la lista
        inList = false;
      }
    }
  }
  return { ok: true, list };
}

/**
 * ¿El path es sospechoso?
 *
 * Rechaza:
 *   - Directory traversal (`..`)
 *   - Metacaracteres de shell (`;`, `&&`, `|`, backticks, `$(`, `>`, `<`)
 *   - Bordes con whitespace (trimmeable)
 *   - Caracteres de control
 *
 * ACEPTA paths Windows legítimos como "C:/Program Files/..." — el espacio
 * dentro del path es válido; sólo lo rechazamos si está al inicio/fin o
 * mezclado con metacaracteres de shell.
 */
function isSuspicious(p) {
  if (typeof p !== 'string') return true;
  if (p.length === 0) return true;
  if (p.includes('..')) return true;
  if (p !== p.trim()) return true; // bordes con whitespace
  // Metacaracteres de shell que no tienen lugar en un path filesystem.
  if (/[;&|`$><\n\r\t\x00]/.test(p)) return true;
  // Secuencias tipo `$(` o `${`.
  if (/\$\(|\$\{/.test(p)) return true;
  return false;
}

/**
 * Validación pura (sin side effects, testable). No lee filesystem.
 *
 * @param {{ javaHome: string, allowlist: string[] }} opts
 * @returns {{ ok: boolean, reason?: string, matched?: string }}
 */
function validateJavaHome({ javaHome, allowlist }) {
  if (!javaHome || typeof javaHome !== 'string') {
    return { ok: false, reason: 'javahome-empty' };
  }
  if (isSuspicious(javaHome)) {
    return { ok: false, reason: 'javahome-suspicious' };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { ok: false, reason: 'allowlist-empty' };
  }

  const candidate = normalizePath(javaHome);
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || !entry) continue;
    if (isSuspicious(entry)) continue; // allowlist defensiva
    const target = normalizePath(entry);
    if (!target) continue;
    if (candidate === target) {
      return { ok: true, matched: entry };
    }
    // Match por prefijo: `JAVA_HOME` puede contener un subdirectorio (jre/bin) del JDK.
    // Sin embargo, sólo aceptamos si `candidate` está DENTRO de `target` con separador.
    if (candidate.startsWith(target + '/')) {
      return { ok: true, matched: entry };
    }
  }

  return { ok: false, reason: 'not-in-allowlist' };
}

/**
 * Wrapper que además resuelve symlinks antes de comparar. Útil desde CLI.
 */
function validateJavaHomeFs({ javaHome, allowlist }) {
  const first = validateJavaHome({ javaHome, allowlist });
  if (first.ok) return first;
  if (first.reason !== 'not-in-allowlist') return first;

  // Reintentar con realpath por si el JAVA_HOME es un junction/symlink.
  const real = realpathBestEffort(javaHome);
  if (real && real !== javaHome) {
    return validateJavaHome({ javaHome: real, allowlist });
  }
  return first;
}

/**
 * Main CLI. Exit 0 si ok, exit 78 si no.
 */
function mainCli() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');

  const javaHome = process.env.JAVA_HOME || '';
  const configPath = path.join(__dirname, 'config.yaml');

  const loaded = loadAllowlist(configPath);
  if (!loaded.ok) {
    if (!quiet) process.stderr.write(`FATAL: no se pudo leer allowlist (${loaded.reason})\n`);
    process.exit(EXIT_CONFIG_ERROR);
  }

  const result = validateJavaHomeFs({ javaHome, allowlist: loaded.list });
  if (result.ok) {
    if (!quiet) process.stdout.write(`OK: JAVA_HOME aceptado (${result.matched})\n`);
    process.exit(0);
  }

  if (!quiet) {
    const lines = [];
    lines.push('FATAL: JAVA_HOME no esta en la allowlist.');
    lines.push('');
    lines.push(`  JAVA_HOME actual:  ${javaHome || '(vacio)'}`);
    lines.push(`  Razon:             ${result.reason}`);
    lines.push('  Allowlist esperada (`build.java_home_allowlist`):');
    for (const entry of loaded.list) {
      lines.push(`    - ${entry}`);
    }
    if (loaded.list.length === 0) lines.push('    (vacia — fail-closed)');
    lines.push('');
    lines.push('Como resolver:');
    lines.push('  1. Si el path es legitimo -> agregalo a `build.java_home_allowlist`');
    lines.push('     de pipeline.config.json (lado producto, #5174) y commitea');
    lines.push('     (ver docs/operacion-pipeline.md).');
    lines.push('  2. Si el path es stale (ej. JDK desinstalado) -> corregi JAVA_HOME');
    lines.push('     en el profile del host.');
    lines.push('');
    lines.push('Exit code: 78 (mapeado a rebote_tipo=infra)');
    process.stderr.write(lines.join('\n') + '\n');
  }
  process.exit(EXIT_CONFIG_ERROR);
}

if (require.main === module) {
  mainCli();
}

module.exports = {
  validateJavaHome,
  validateJavaHomeFs,
  loadAllowlist,
  loadAllowlistFromProduct,
  productManifestPathFor,
  normalizePath,
  isSuspicious,
  EXIT_CONFIG_ERROR,
};

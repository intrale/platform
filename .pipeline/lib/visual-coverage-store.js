'use strict';

// =============================================================================
// #5708 / CA-11 · D11 — Store de cobertura visual por pasada.
//
// Problema que resuelve: `regression` venía DECLARADO en el contrato que
// escribe el agente de QA (texto generado por un LLM). Un booleano declarativo
// sobre "esto ya estaba verificado en la pasada anterior" miente por
// construcción: nadie escribía ni leía el artefacto que lo sostiene.
//
// Acá `regression` pasa a ser DERIVADO por código:
//   - `writeCoverage` deja, por pasada, qué secciones se verificaron y cuáles
//     quedaron sin hallazgos. Lo llama `rejection-report.js`, NO el agente QA,
//     así el store es determinístico y auditable.
//   - `deriveRegressions` compara los diffs de la pasada actual contra la
//     pasada previa registrada. Sin pasada previa ⇒ todo `false`, que es
//     literalmente el criterio de cierre de CA-11: no puede quedar
//     `regression: true` sin una pasada previa que haya declarado esa sección
//     verificada y sin hallazgos.
//
// Determinístico: sin red, sin LLM, sin dependencias. Mismo confinamiento de
// path que `loadVisualComparison` (issue numérico, resolve, prefijo de baseDir,
// `lstatSync` con rechazo de symlink). NUNCA persiste imágenes ni base64.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_RE = /^visual-coverage-rev(\d+)\.json$/;

/** Directorio de evidencia del issue, con el issue validado como numérico. */
function resolveBaseDir(issue, baseDir) {
  if (!/^\d+$/.test(String(issue))) return null;
  const target = path.resolve(baseDir || path.join(ROOT, 'qa', 'evidence', String(issue)));
  const evidenceRoot = path.resolve(ROOT, 'qa', 'evidence');
  // Confinamiento: el baseDir debe caer bajo `qa/evidence/` (o ser exactamente
  // el del issue). Un override que apunte afuera se descarta.
  if (target !== evidenceRoot && !target.startsWith(evidenceRoot + path.sep)) return null;
  return target;
}

/** Path del archivo de cobertura de una revisión, ya confinado. Null si no aplica. */
function coveragePathFor(issue, rev, baseDir) {
  const dir = resolveBaseDir(issue, baseDir);
  if (dir === null) return null;
  if (!Number.isInteger(Number(rev)) || Number(rev) < 0) return null;
  const target = path.resolve(dir, `visual-coverage-rev${Number(rev)}.json`);
  if (!target.startsWith(dir + path.sep)) return null;
  return target;
}

/** Lee un JSON confinado rechazando symlinks. Devuelve null ante cualquier problema. */
function readJsonSafe(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toSectionList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Registra la cobertura de la pasada actual.
 *
 * Persiste SÓLO `{ issue, rev, verificadas, sin_hallazgos }` — sin imágenes,
 * sin base64, sin texto libre del contrato.
 *
 * @returns {{written: boolean, path: string|null, reason?: string}}
 */
function writeCoverage({ issue, rev, coverage, diffs, baseDir } = {}) {
  const target = coveragePathFor(issue, rev, baseDir);
  if (target === null) return { written: false, path: null, reason: 'path-invalido' };

  const verificadas = toSectionList(coverage && coverage.verificadas);
  const conHallazgos = new Set(
    (Array.isArray(diffs) ? diffs : [])
      .map(d => String((d && d.section) != null ? d.section : ''))
      .filter(Boolean)
  );
  const sinHallazgos = verificadas.filter(section => !conHallazgos.has(section));

  const payload = {
    issue: Number(issue),
    rev: Number(rev),
    verificadas,
    sin_hallazgos: sinHallazgos,
  };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Si ya existe y es symlink, no escribimos a través de él (path traversal).
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { written: false, path: target, reason: 'symlink' };
      }
    }
    fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return { written: true, path: target };
  } catch (e) {
    console.error(`[visual-coverage] no se pudo registrar la cobertura: ${e && e.message}`);
    return { written: false, path: target, reason: 'io-error' };
  }
}

/** Cobertura de la pasada previa registrada (mayor `rev` estrictamente menor). */
function readPreviousCoverage({ issue, rev, baseDir } = {}) {
  const dir = resolveBaseDir(issue, baseDir);
  if (dir === null) return null;
  const current = Number(rev);
  if (!Number.isFinite(current)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const candidate = Number(m[1]);
    if (!Number.isFinite(candidate) || candidate >= current) continue;
    if (best === null || candidate > best) best = candidate;
  }
  if (best === null) return null;
  const target = coveragePathFor(issue, best, baseDir);
  return target ? readJsonSafe(target) : null;
}

/**
 * Deriva, por diff, si el desvío es una REGRESIÓN del código.
 *
 * Regresión = la pasada previa declaró esa sección verificada y sin hallazgos,
 * y ahora aparece un desvío ahí. Si la sección no fue verificada antes, el
 * hallazgo es tardío (barrido incompleto), no regresión — y se reporta `false`.
 *
 * @returns {boolean[]} alineado 1:1 con `diffs`.
 */
function deriveRegressions({ issue, rev, diffs, baseDir } = {}) {
  const list = Array.isArray(diffs) ? diffs : [];
  const prev = readPreviousCoverage({ issue, rev, baseDir });
  if (!prev) return list.map(() => false);
  const sinHallazgos = new Set(toSectionList(prev.sin_hallazgos));
  return list.map(d => sinHallazgos.has(String((d && d.section) != null ? d.section : '')));
}

module.exports = {
  writeCoverage,
  deriveRegressions,
  readPreviousCoverage,
  coveragePathFor,
};

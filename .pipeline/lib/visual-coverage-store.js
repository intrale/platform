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
//     quedaron sin hallazgos. Lo llaman procesos determinísticos del pipeline
//     (`rejection-report.js` para rechazos y el cierre del Pulpo para aprobados),
//     NO el agente QA, así el store es auditable.
//   - `deriveRegressions` compara los diffs de la pasada actual contra la
//     pasada previa registrada. Sin pasada previa ⇒ todo `no-baseline`, que es
//     literalmente el criterio de cierre de CA-11: no puede quedar
//     `regression` sin una pasada previa que haya declarado esa sección
//     verificada y sin hallazgos.
//
// #5708 / CA-21 · UX-17 — el retorno es TRI-ESTADO, no booleano: ver el bloque
// de `deriveRegressionReport` para por qué `false` mentía en dos casos.
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
  // El prefijo lexico no detecta junctions/symlinks intermedios. Para paths
  // todavia inexistentes se canoniza el ancestro existente mas cercano; luego
  // de crear el directorio `writeCoverage` vuelve a validar la ruta completa.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  try {
    const realRoot = fs.realpathSync(evidenceRoot);
    const realAncestor = fs.realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) return null;
  } catch {
    return null;
  }
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
    // Revalidar despues de mkdir cierra el caso donde un componente intermedio
    // ya era (o termino siendo) un junction hacia fuera de qa/evidence.
    const validatedDir = resolveBaseDir(issue, path.dirname(target));
    if (validatedDir === null) {
      return { written: false, path: target, reason: 'path-invalido' };
    }
    const realDir = fs.realpathSync(validatedDir);
    const realEvidenceRoot = fs.realpathSync(path.resolve(ROOT, 'qa', 'evidence'));
    if (realDir !== realEvidenceRoot && !realDir.startsWith(realEvidenceRoot + path.sep)) {
      return { written: false, path: target, reason: 'path-invalido' };
    }
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

// #5708 / CA-21 · UX-17 — TRES estados, no dos.
//
// `deriveRegressions` devolvía `boolean[]`, y ese booleano colapsaba dos casos
// que significan cosas distintas:
//
//   - `false` porque HAY línea base y la sección no estaba verificada
//     ⇒ el hallazgo es tardío (barrido incompleto), no un defecto nuevo.
//   - `false` porque NO HAY línea base (primera pasada, o `qa/evidence/` limpio)
//     ⇒ no se pudo tipificar nada. Es el falso negativo estructural que D11
//     acepta a propósito.
//
// Mostrarlos igual afirma que se verificó algo que nunca se verificó — el mismo
// defecto que este issue ataca. El valor de retorno los distingue para que el
// chip del PDF pueda distinguirlos también.
const REGRESSION = 'regression';
const NOT_REGRESSION = 'not-regression';
const NO_BASELINE = 'no-baseline';

// Sub-motivo del estado: el chip necesita decir POR QUÉ, y «no es regresión»
// tiene dos causas que no se pueden narrar igual (ver `deriveRegressionReport`).
const PREV_CLEAN = 'prev-clean';                 // verificada y sin hallazgos
const PREV_HAD_FINDINGS = 'prev-had-findings';   // verificada, pero ya tenía hallazgos
const PREV_NOT_VERIFIED = 'prev-not-verified';   // no se verificó en la pasada previa
const NO_BASELINE_REASON = 'no-baseline';        // no hay pasada previa registrada

/**
 * Deriva, por diff, la tipificación de regresión contra la pasada previa.
 *
 * @returns {{baselineRev: number|null, states: string[]}} `states` alineado 1:1
 *   con `diffs`; `baselineRev` es la pasada usada como línea base (null si no hay).
 */
function deriveRegressionReport({ issue, rev, diffs, baseDir } = {}) {
  const list = Array.isArray(diffs) ? diffs : [];
  const prev = readPreviousCoverage({ issue, rev, baseDir });
  // Sin pasada previa registrada NADA es tipificable: ni regresión ni no-regresión.
  if (!prev) {
    return { baselineRev: null, states: list.map(() => NO_BASELINE), reasons: list.map(() => NO_BASELINE_REASON) };
  }
  const sinHallazgos = new Set(toSectionList(prev.sin_hallazgos));
  const verificadas = new Set(toSectionList(prev.verificadas));
  const baselineRev = Number.isFinite(Number(prev.rev)) ? Number(prev.rev) : null;
  const states = [];
  const reasons = [];
  for (const d of list) {
    const section = String((d && d.section) != null ? d.section : '');
    if (sinHallazgos.has(section)) {
      states.push(REGRESSION);
      reasons.push(PREV_CLEAN);
      continue;
    }
    states.push(NOT_REGRESSION);
    // `not-regression` cubre DOS situaciones distintas, y confundirlas afirma
    // un hecho falso. Si la sección estaba verificada y ya tenía hallazgos, el
    // desvío es un pendiente conocido — decir "sección no verificada" mentiría
    // sobre una sección que sí se barrió.
    reasons.push(verificadas.has(section) ? PREV_HAD_FINDINGS : PREV_NOT_VERIFIED);
  }
  return { baselineRev, states, reasons };
}

/**
 * Estados de regresión, alineados 1:1 con `diffs`.
 *
 * Regresión = la pasada previa declaró esa sección verificada y sin hallazgos,
 * y ahora aparece un desvío ahí. Sin pasada previa registrada ⇒ `no-baseline`,
 * NUNCA `regression`: es literalmente el criterio de cierre de CA-11.
 *
 * @returns {string[]} `'regression' | 'not-regression' | 'no-baseline'`.
 */
function deriveRegressions(args) {
  return deriveRegressionReport(args).states;
}

module.exports = {
  writeCoverage,
  deriveRegressions,
  deriveRegressionReport,
  readPreviousCoverage,
  coveragePathFor,
  REGRESSION,
  NOT_REGRESSION,
  NO_BASELINE,
  PREV_CLEAN,
  PREV_HAD_FINDINGS,
  PREV_NOT_VERIFIED,
};

// =============================================================================
// workfile-name.js — Frontera FS: derivación segura de issue + skill (EP5-H1, #3938)
//
// CONTEXTO
// --------
// Los archivos de trabajo del pipeline se nombran `<issue>.<skill>` (ej:
// `1732.po`, `2505.pipeline-dev`). El Pulpo deriva el número de issue y el
// skill a partir de ese nombre para agrupar, mover y construir paths del
// filesystem.
//
// Antes de este módulo, esa derivación vivía embebida en `pulpo.js`
// (`issueFromFile` / `skillFromFile`, L1217-1224) como un `split('.')` sin
// validación. Como esos valores terminan formando paths del FS
// (`${issue}.${skill}` en `pendiente/`, etc.), un nombre malicioso o corrupto
// (`../../etc`, skill desconocido) podría derivar un path fuera del árbol del
// pipeline (path traversal, SEC / CA-7).
//
// CONTRATO
// --------
//   - `issueFromFile` / `skillFromFile`: helpers LENIENTES, preservan el
//     comportamiento histórico exacto (split por '.') para no romper los ~40
//     call-sites del monolito. Refactor mecánico, comportamiento invariante
//     (CA-5).
//   - `parseWorkfileName({ filename, skillAllowlist })`: helper ESTRICTO de la
//     frontera FS. Valida que `issue` matchee `/^\d+$/` y que `skill`
//     pertenezca al allowlist derivado de `config.skills_por_fase`. Input
//     inválido → retorno `null` (nunca un path derivado). Es el helper que
//     debe usarse cuando el nombre proviene de una fuente no confiable.
//   - `buildSkillAllowlist(config)`: deriva el Set de skills conocidos de la
//     config del pipeline (`pipelines[*].skills_por_fase`).
//
// SEGURIDAD
// ---------
// `parseWorkfileName` rechaza explícitamente separadores de path (`/`, `\`),
// segmentos `..`, bytes nulos y nombres vacíos. Sin acceso a `fs` / `gh` /
// estado global: función pura sobre strings (datos ya leídos en la frontera).
// =============================================================================

'use strict';

// Un issue válido es una secuencia de dígitos no vacía. Sin signo, sin
// separadores de miles, sin notación científica.
const ISSUE_RE = /^\d+$/;

// Un skill válido sólo contiene letras minúsculas, dígitos y guiones (los
// skills reales: po, ux, guru, backend-dev, pipeline-dev, ...). Sin puntos,
// sin separadores de path, sin espacios. El allowlist es la autoridad final;
// esta regex es defensa-en-profundidad para cuando no se provee allowlist.
const SKILL_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extraer el número de issue del nombre de archivo (LENIENTE).
 *
 * Preserva el comportamiento histórico de `pulpo.js:issueFromFile`:
 * `"1732.po" → "1732"`. NO valida — los ~40 call-sites del monolito esperan
 * un string. Para validación usar `parseWorkfileName`.
 *
 * @param {string} filename
 * @returns {string} el primer segmento antes del primer punto
 */
function issueFromFile(filename) {
  return String(filename == null ? '' : filename).split('.')[0];
}

/**
 * Extraer el skill del nombre de archivo (LENIENTE).
 *
 * Preserva el comportamiento histórico de `pulpo.js:skillFromFile`:
 * `"1732.pipeline-dev" → "pipeline-dev"`, `"1732.po" → "po"`. Reúne todos los
 * segmentos posteriores al primer punto (un skill puede contener guiones, no
 * puntos, pero el join preserva el legacy exacto).
 *
 * @param {string} filename
 * @returns {string}
 */
function skillFromFile(filename) {
  return String(filename == null ? '' : filename).split('.').slice(1).join('.');
}

/**
 * Construir el allowlist de skills conocidos a partir de la config del
 * pipeline. Recorre `config.pipelines[*].skills_por_fase[*]` y junta todos los
 * skills declarados en cualquier fase de cualquier pipeline.
 *
 * @param {object} config - config.yaml ya parseada
 * @returns {Set<string>} conjunto de skills válidos (puede estar vacío)
 */
function buildSkillAllowlist(config) {
  const out = new Set();
  const pipelines = config && config.pipelines;
  if (!pipelines || typeof pipelines !== 'object') return out;
  for (const pipelineConfig of Object.values(pipelines)) {
    const porFase = pipelineConfig && pipelineConfig.skills_por_fase;
    if (!porFase || typeof porFase !== 'object') continue;
    for (const skills of Object.values(porFase)) {
      if (!Array.isArray(skills)) continue;
      for (const s of skills) {
        if (typeof s === 'string' && s.length > 0) out.add(s);
      }
    }
  }
  return out;
}

/**
 * ¿El string contiene algo que pueda derivar un path fuera del árbol del
 * pipeline? Separadores de path, segmentos de traversal, bytes nulos.
 * @param {string} s
 * @returns {boolean}
 */
function hasPathDanger(s) {
  if (typeof s !== 'string' || s.length === 0) return true;
  if (s.includes('/') || s.includes('\\')) return true;   // separadores de path
  if (s.includes('\0')) return true;                       // null byte
  if (s === '.' || s === '..') return true;                // segmentos de traversal
  return false;
}

/**
 * Parsear y VALIDAR un nombre de work-file de forma estricta (frontera FS).
 *
 * Reglas:
 *   - El nombre completo no debe contener separadores de path ni traversal.
 *   - `issue` (primer segmento) debe matchear `/^\d+$/`.
 *   - `skill` (resto) debe ser no vacío, matchear `SKILL_RE` y —si se provee
 *     `skillAllowlist`— pertenecer a él.
 *
 * Cualquier violación → `null` (nunca se deriva un path).
 *
 * @param {object} p
 * @param {string} p.filename - nombre de archivo (sin directorio)
 * @param {Set<string>|string[]|null} [p.skillAllowlist] - skills permitidos
 * @returns {{issue:string, skill:string}|null}
 */
function parseWorkfileName({ filename, skillAllowlist = null } = {}) {
  if (typeof filename !== 'string' || filename.length === 0) return null;
  // Defensa temprana: cualquier separador de path o traversal en el nombre
  // completo es inaceptable (readdir nunca debería devolverlos, pero el input
  // puede venir de otra fuente).
  if (hasPathDanger(filename)) return null;
  if (filename.startsWith('.')) return null; // dotfiles / flags internos

  const dot = filename.indexOf('.');
  if (dot <= 0) return null; // sin punto, o empieza con punto (ya cubierto)

  const issue = filename.slice(0, dot);
  const skill = filename.slice(dot + 1);

  if (!ISSUE_RE.test(issue)) return null;
  if (skill.length === 0) return null;
  if (hasPathDanger(skill)) return null;
  if (!SKILL_RE.test(skill)) return null;

  if (skillAllowlist != null) {
    const allow = skillAllowlist instanceof Set ? skillAllowlist : new Set(skillAllowlist);
    if (allow.size > 0 && !allow.has(skill)) return null;
  }

  return { issue, skill };
}

/**
 * Conveniencia booleana sobre `parseWorkfileName`.
 * @param {string} filename
 * @param {Set<string>|string[]|null} [skillAllowlist]
 * @returns {boolean}
 */
function isValidWorkfileName(filename, skillAllowlist = null) {
  return parseWorkfileName({ filename, skillAllowlist }) !== null;
}

module.exports = {
  issueFromFile,
  skillFromFile,
  parseWorkfileName,
  isValidWorkfileName,
  buildSkillAllowlist,
  ISSUE_RE,
  SKILL_RE,
};

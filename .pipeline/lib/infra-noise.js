// =============================================================================
// infra-noise.js — Clasificador de "ruido de infra" en el árbol sucio de un
// worktree (#6708).
//
// El problema
// -----------
// El guard de seguridad de `ghostbusters-worktrees.js` protege cualquier
// worktree con `git status --porcelain` no vacío. Medido el 2026-08-28 sobre
// los worktrees vivos de la máquina, la abrumadora mayoría de ese estado sucio
// NO es trabajo humano:
//
//     ?? qa/evidence/6146/                          (artefacto de QA)
//     ?? .claude/hooks/agent-6150.heartbeat         (latido del agente)
//      M .claude/hooks/activity-logger-last.json    (cursor del hook)
//      M .pipeline/ready/dashboard.ready            (marker de servicio)
//      M .pipeline/state/label-mutations.jsonl      (bitácora de estado)
//
// Todo eso lo reescribe la propia infra en cada corrida. Contarlo como trabajo
// dejaba protegidos worktrees de issues cerrados hace meses (#5978, #6012,
// #6032, #6146, #6150, #6179, #6180, #6206, #6226...), y por eso el cron de
// ghostbusters reportaba "liberación potencial 0.00 GB" mientras el disco se
// llenaba.
//
// Lo que NO es ruido
// ------------------
// Código real sin pushear. Medido en la misma corrida:
//
//      M users/src/main/kotlin/ar/com/intrale/Modules.kt
//      M .pipeline/lib/stuck-phase-reconciler.js
//      M .pipeline/roles/qa.md
//      M docs/pipeline/self-healing-fases-varadas.md
//     UU .pipeline/lib/operational-state-lint.allowlist.json
//
// Ese worktree se conserva. La asimetría es deliberada: un falso "es ruido"
// borra trabajo humano irrecuperable; un falso "es trabajo" sólo deja un
// worktree ocupando disco una corrida más. Ante la duda, NO es ruido.
//
// Diferencia con el criterio de `cleanup-worktrees.js` (#6290)
// -----------------------------------------------------------
// Aquel filtra `.pipeline/` entero. Acá NO: `.pipeline/lib/*.js`,
// `.pipeline/roles/*.md`, `.pipeline/*.js` y `.pipeline/config.yaml` son el
// código fuente del pipeline — es exactamente lo que edita un agente
// `pipeline-dev`, y filtrarlo entero borraría su trabajo. Sólo son ruido los
// subdirectorios de ESTADO (colas de fases, sesiones y markers). Logs y audit
// quedan protegidos: pueden contener evidencia operativa que no es regenerable.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Subdirectorios de `.pipeline/` que son ESTADO en runtime, no código fuente.
// El pipeline los reescribe solo en cada tick. Lista explícita (allowlist) y no
// un "todo `.pipeline/` menos `*.js`": si mañana aparece un directorio nuevo,
// que quede protegido por default es el fallo seguro.
// -----------------------------------------------------------------------------
const PIPELINE_STATE_DIRS = Object.freeze([
  'archived', 'historico', 'sessions', 'state', 'ready',
  'rejections', 'metrics', 'handoff', 'locks', 'claims', 'quota', 'tmp',
]);

// Colas de fases: `.pipeline/<pipeline>/<fase>/<estado>/...`. Los nombres de
// pipeline vienen de `config.yaml` pero se anclan acá para que el módulo sea
// puro (sin IO): son dos y no cambian sin un cambio de arquitectura.
const PIPELINE_QUEUE_ROOTS = Object.freeze(['desarrollo', 'definicion']);

// Estados de código de `git status --porcelain` que indican conflicto de merge
// sin resolver. NUNCA son ruido, esté donde esté el archivo: un `UU` es trabajo
// humano a medio hacer y borrarlo es irrecuperable.
const CONFLICT_CODES = Object.freeze(new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']));

/**
 * Normaliza un path del working tree a separadores POSIX, sin `./` inicial.
 */
function normalize(filepath) {
  return String(filepath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * ¿El path es ruido de infra regenerable?
 *
 * Puro: no toca el filesystem. Recibe un path relativo a la raíz del worktree.
 */
function isInfraNoisePath(filepath) {
  const p = normalize(filepath);
  if (!p) return false;

  // Heartbeats del agente: `.claude/hooks/agent-6150.heartbeat`,
  // `...heartbeat.stale`, y cualquier variante futura del sufijo.
  if (/(^|\/)[^/]*\.heartbeat(\.[^/]+)?$/.test(p)) return true;

  // Copia/junction de `.claude/` que el launcher materializa en cada worktree.
  if (p === '.claude' || p.startsWith('.claude/')) return true;

  // Evidencia de QA: la produce el gate de verificación dentro del worktree y
  // se regenera corriendo QA de nuevo. Es además la deuda documentada en
  // `docs/pipeline/gestion-de-disco.md` (185 MB replicados por worktree).
  if (p === 'qa/evidence' || p.startsWith('qa/evidence/')) return true;

  // Artefactos de build de cualquier módulo (`build/`, `app/build/`, ...).
  if (/(^|\/)(build|\.gradle|\.kotlin|kotlin-js-store|node_modules)(\/|$)/.test(p)) return true;

  // Basura del sistema de archivos. Los logs quedan protegidos por default:
  // pueden ser evidencia operativa o de seguridad y requieren OK explícito.
  if (/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(p)) return true;

  if (p === '.pipeline' || p.startsWith('.pipeline/')) {
    const rest = p.slice('.pipeline/'.length);
    const seg = rest.split('/');
    // Estado de runtime del pipeline.
    if (PIPELINE_STATE_DIRS.includes(seg[0])) return true;
    // Colas de fases: `.pipeline/desarrollo/dev/pendiente/6708.pipeline-dev`.
    // Se exige profundidad >= 3 para no clasificar como ruido un archivo suelto
    // en `.pipeline/desarrollo/` que no sea una cola.
    if (PIPELINE_QUEUE_ROOTS.includes(seg[0]) && seg.length >= 3) return true;
    // Archivos de estado sueltos en la raíz de `.pipeline/`
    // (agent-registry.json, rest-mode.json, qa-env-state.json, .paused...).
    // `config.yaml` NO entra acá: es configuración versionada.
    if (seg.length === 1 && /\.(json|jsonl|flag|lock|ready|tmp)$/.test(seg[0])) return true;
    if (seg.length === 1 && /^\.[a-z-]+$/.test(seg[0])) return true; // .paused, .desync-detected
    return false; // `.pipeline/lib/*.js`, `.pipeline/roles/*.md`, `.pipeline/*.js` => CODIGO
  }

  return false;
}

/**
 * Extrae el path de una línea de `git status --porcelain` (formato v1).
 *
 * Formato: `XY <path>` o `XY <origen> -> <destino>` en renames/copias.
 * Los paths con caracteres especiales vienen entre comillas dobles.
 * Devuelve `{ code, filepath }`, o `null` si la línea no es parseable.
 */
function parsePorcelainLine(line) {
  const raw = String(line == null ? '' : line);
  if (!raw.trim()) return null;
  // El código son SIEMPRE los 2 primeros caracteres; el path arranca en el 4to.
  // No hacer `.trim()` de la línea entera: comería el espacio del código ` M`.
  const code = raw.slice(0, 2);
  let rest = raw.slice(3);
  if (!rest) return null;
  // Rename/copy: `R  vieja -> nueva`. El destino es el que existe en disco.
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  let filepath = rest.trim();
  // Path citado por `core.quotePath`: `"users/ñ.kt"`.
  if (filepath.startsWith('"') && filepath.endsWith('"') && filepath.length >= 2) {
    filepath = filepath.slice(1, -1);
  }
  if (!filepath) return null;
  return { code, filepath };
}

/**
 * ¿Esta entrada de porcelain es ruido de infra?
 *
 * Fail-closed en dos puntos: una línea que no se puede parsear NO es ruido, y
 * un conflicto de merge NO es ruido aunque el path lo sea.
 */
function isInfraNoiseEntry(line) {
  const parsed = parsePorcelainLine(line);
  if (!parsed) return false;
  if (CONFLICT_CODES.has(parsed.code)) return false;
  return isInfraNoisePath(parsed.filepath);
}

/**
 * Filtra el output de `git status --porcelain` y devuelve SOLO los cambios que
 * representan trabajo real.
 *
 * @returns {string[]} paths (no líneas) de los cambios relevantes.
 */
function relevantChanges(porcelainStdout) {
  const out = [];
  for (const line of String(porcelainStdout == null ? '' : porcelainStdout).split('\n')) {
    if (!line.trim()) continue;
    if (isInfraNoiseEntry(line)) continue;
    const parsed = parsePorcelainLine(line);
    out.push(parsed ? parsed.filepath : line.trim());
  }
  return out;
}

module.exports = {
  PIPELINE_STATE_DIRS,
  PIPELINE_QUEUE_ROOTS,
  CONFLICT_CODES,
  isInfraNoisePath,
  isInfraNoiseEntry,
  parsePorcelainLine,
  relevantChanges,
};

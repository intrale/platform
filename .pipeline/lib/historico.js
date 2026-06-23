'use strict';

// =============================================================================
// historico.js — Frontera explícita entre el ESTADO ACTIVO y el HISTÓRICO del
// pipeline V3 (issue #4136).
//
// Problema que resuelve: hoy el trabajo activo y el histórico de tareas ya
// terminadas conviven en el MISMO camino vivo (`<pipeline>/<fase>/procesado`).
// El snapshot del dashboard (`_genPipelineState`) recorre TODO ese camino y
// parsea miles de YAML, congelando el event loop durante `/restart` (freezes de
// 54s..92s medidos por el watchdog #4135) → rollback por timeout del smoke test.
//
// Diseño (receta del Arquitecto, validada por guru/security):
//   1. `procesado/` SIGUE siendo el sink por-fase del CICLO VIVO. No se redirige
//      cada `renameSync(... 'procesado')` (rompería la lectura de "pasadas
//      anteriores" del rebote y la detección de ola, que usan `procesado/`
//      DENTRO del ciclo activo).
//   2. Cuando un issue queda EN REPOSO TOTAL (sin archivos en
//      pendiente/trabajando/listo de NINGUNA fase de NINGÚN pipeline, y alcanzó
//      su fase terminal o está `closed` en GitHub), un barrido centralizado muda
//      TODOS sus artefactos `procesado/` (de todas las fases) a `historico/`.
//      Así el camino vivo se mantiene acotado solo, sin re-acumular.
//   3. `historico/` vive en una RAÍZ APARTE (`.pipeline/historico/`), nunca hija
//      de `<pipeline>/<fase>/`, por lo que el snapshot no lo walkea.
//
// Toda la lógica de la frontera se concentra acá para NO tocar los ~30
// call-sites sueltos de `renameSync(... 'procesado')` del Pulpo (riesgo #5 de
// guru).
//
// Atomicidad: `historico/` es hijo de `pipelineDir` → MISMO volumen →
// `renameSync` atómico en Windows. `moverAHistorico` tolera reintentos por la
// no-confiabilidad de `renameSync` bajo concurrencia en Windows (pulpo.js:833).
//
// Seguridad (lector on-demand): `issue` forzado a `^\d+$`, `pipeline`/`fase`
// validados contra la allowlist de `config.pipelines`, path resuelto y acotado
// con `startsWith(root + sep)` para cortar `../` y rutas absolutas. Nunca lista
// el árbol completo (no es file-server).
// =============================================================================

const fs = require('fs');
const path = require('path');

// Fase terminal por pipeline: alcanzar su `procesado/` marca al issue como
// "completado el flujo". Coincide con config.pipelines[*].fases (último elemento).
const TERMINAL_FASES = {
  desarrollo: 'entrega',
  definicion: 'sizing',
};

const TRANSITIONS_LOG = 'historico-transitions.jsonl';

// --- helpers internos --------------------------------------------------------

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.gitkeep'));
  } catch {
    return [];
  }
}

/** Archivos de un issue en un dir, por prefijo exacto `<issue>.` (no matchea 41360 con 4136). */
function listIssueFiles(dir, issue) {
  const prefix = String(issue) + '.';
  return safeReaddir(dir).filter((f) => f.startsWith(prefix));
}

function hasIssueFiles(dir, issue) {
  return listIssueFiles(dir, issue).length > 0;
}

/** Raíz del histórico. Hijo de pipelineDir ⇒ mismo volumen ⇒ rename atómico. */
function historicoRoot(pipelineDir) {
  return path.join(pipelineDir, 'historico');
}

/**
 * Asegura que el histórico esté en el MISMO volumen que el pipeline (CA-1).
 * Por construcción (hijo de pipelineDir) siempre lo está; esta verificación
 * documenta el invariante y atrapa el caso de un pipelineDir vía symlink a otro
 * drive. Lanza si los drive-roots difieren.
 */
function assertSameVolume(pipelineDir) {
  const root = historicoRoot(pipelineDir);
  const a = path.parse(path.resolve(pipelineDir)).root.toLowerCase();
  const b = path.parse(path.resolve(root)).root.toLowerCase();
  if (a !== b) {
    throw new Error(`historico: ${root} no está en el mismo volumen que ${pipelineDir} (rename no atómico)`);
  }
  return true;
}

/** Registro append-only de cada muda (NUNCA writeFileSync). Best-effort. */
function appendTransition(pipelineDir, record) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(path.join(pipelineDir, TRANSITIONS_LOG), line, 'utf8');
  } catch {
    /* el log es best-effort: no abortar la muda si el log falla */
  }
}

/**
 * Mueve un archivo de origen a destino con tolerancia a la no-confiabilidad de
 * `renameSync` bajo concurrencia en Windows (EPERM/EBUSY/EEXIST). Idempotente:
 * si el origen ya no está pero el destino sí, asume que otra pasada ya lo movió.
 */
function moveWithRetry(src, dest, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(src, dest);
      return true;
    } catch (e) {
      // Ya movido por otra pasada/proceso (idempotencia).
      if (e.code === 'ENOENT' && fs.existsSync(dest)) return true;
      // Destino ya existe (re-corrida): el destino es la copia canónica del
      // histórico; descartamos el origen duplicado.
      if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EBUSY') {
        if (fs.existsSync(dest)) {
          try { fs.rmSync(src, { force: true }); } catch { /* noop */ }
          return true;
        }
      }
      if (i === retries - 1) {
        // Último intento: fallback copy+unlink (no atómico, pero mismo volumen
        // hace que sea raro llegar acá). Mantiene el dato a salvo.
        try {
          fs.copyFileSync(src, dest);
          fs.rmSync(src, { force: true });
          return true;
        } catch (e2) {
          throw new Error(`historico: no pude mover ${src} → ${dest}: ${e2.message}`);
        }
      }
    }
  }
  return false;
}

// --- API pública -------------------------------------------------------------

/**
 * Muda un artefacto concreto de `<pipeline>/<fase>/procesado/<fname>` a
 * `historico/<pipeline>/<fase>/<fname>`. Registra la muda (append-only).
 * @returns {string} path destino
 */
function moverAHistorico({ issue, pipeline, fase, fname, pipelineDir, logTransition = true }) {
  const src = path.join(pipelineDir, pipeline, fase, 'procesado', fname);
  const destDir = path.join(historicoRoot(pipelineDir), pipeline, fase);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, fname);
  moveWithRetry(src, dest);
  if (logTransition) {
    appendTransition(pipelineDir, { issue: String(issue), pipeline, fase, fname, op: 'mover_a_historico' });
  }
  return dest;
}

/**
 * Predicado de reposo total: el issue NO tiene archivos en
 * pendiente/trabajando/listo de NINGUNA fase de NINGÚN pipeline.
 */
function estaEnReposo({ issue, config, pipelineDir }) {
  for (const [pName, pCfg] of Object.entries(config.pipelines || {})) {
    for (const fase of pCfg.fases || []) {
      for (const estado of ['pendiente', 'trabajando', 'listo']) {
        if (hasIssueFiles(path.join(pipelineDir, pName, fase, estado), issue)) {
          return false;
        }
      }
    }
  }
  return true;
}

/** ¿El issue alcanzó la fase terminal (tiene marker en su procesado terminal)? */
function alcanzoTerminal({ issue, config, pipelineDir }) {
  for (const [pName, fase] of Object.entries(TERMINAL_FASES)) {
    if (!config.pipelines || !config.pipelines[pName]) continue;
    if (hasIssueFiles(path.join(pipelineDir, pName, fase, 'procesado'), issue)) {
      return true;
    }
  }
  return false;
}

/**
 * ¿El issue es archivable? Debe estar en reposo total Y (haber alcanzado su
 * fase terminal O estar cerrado en GitHub según el predicado opcional isClosed).
 */
function esArchivable({ issue, config, pipelineDir, isClosed }) {
  if (!estaEnReposo({ issue, config, pipelineDir })) return false;
  if (alcanzoTerminal({ issue, config, pipelineDir })) return true;
  if (typeof isClosed === 'function') {
    try { if (isClosed(String(issue))) return true; } catch { /* best-effort */ }
  }
  return false;
}

/**
 * Si el issue es archivable, muda TODOS sus artefactos de `procesado/` (de todas
 * las fases de todos los pipelines) a `historico/`. Idempotente.
 * @returns {{archived:boolean, moved:string[]}}
 */
function archivarIssueTerminado({ issue, config, pipelineDir, isClosed }) {
  issue = String(issue);
  if (!/^\d+$/.test(issue)) {
    throw new Error(`historico: issue inválido: ${issue}`);
  }
  if (!esArchivable({ issue, config, pipelineDir, isClosed })) {
    return { archived: false, moved: [] };
  }
  const moved = [];
  for (const [pName, pCfg] of Object.entries(config.pipelines || {})) {
    for (const fase of pCfg.fases || []) {
      const procesadoDir = path.join(pipelineDir, pName, fase, 'procesado');
      for (const fname of listIssueFiles(procesadoDir, issue)) {
        moverAHistorico({ issue, pipeline: pName, fase, fname, pipelineDir });
        moved.push(`${pName}/${fase}/${fname}`);
      }
    }
  }
  return { archived: moved.length > 0, moved };
}

/**
 * Barrido idempotente: recorre todos los `procesado/` del camino vivo, junta los
 * issues presentes y archiva los que cumplan el predicado. Cubre también el
 * histórico previo al deploy (CA-6, sin script de migración aparte).
 * @returns {{scanned:number, archivedIssues:string[], movedCount:number}}
 */
function barrerHistorico({ config, pipelineDir, isClosed, max = Infinity }) {
  const issues = new Set();
  for (const [pName, pCfg] of Object.entries(config.pipelines || {})) {
    for (const fase of pCfg.fases || []) {
      const dir = path.join(pipelineDir, pName, fase, 'procesado');
      for (const fname of safeReaddir(dir)) {
        const m = fname.match(/^(\d+)\./);
        if (m) issues.add(m[1]);
      }
    }
  }
  const result = { scanned: issues.size, archivedIssues: [], movedCount: 0 };
  let n = 0;
  for (const issue of issues) {
    if (n >= max) break;
    const r = archivarIssueTerminado({ issue, config, pipelineDir, isClosed });
    if (r.archived) {
      result.archivedIssues.push(issue);
      result.movedCount += r.moved.length;
      n++;
    }
  }
  return result;
}

/**
 * Lector on-demand del histórico de un issue en una fase concreta. Devuelve solo
 * los nombres de archivo `<issue>.*`, nunca el árbol completo. Validación de path
 * obligatoria (security):
 *   - issue: `^\d+$`
 *   - pipeline/fase: allowlist de config.pipelines (nunca concatenar crudo)
 *   - path resuelto y acotado con startsWith(root + sep) (corta ../ y absolutos)
 * @returns {string[]} nombres de archivo
 */
function leerHistorico({ issue, pipeline, fase, config, pipelineDir }) {
  if (!/^\d+$/.test(String(issue))) {
    throw new Error('historico: issue inválido');
  }
  const pipelines = Object.keys(config.pipelines || {});
  if (!pipelines.includes(pipeline)) {
    throw new Error(`historico: pipeline inválido: ${pipeline}`);
  }
  const fases = (config.pipelines[pipeline] && config.pipelines[pipeline].fases) || [];
  if (!fases.includes(fase)) {
    throw new Error(`historico: fase inválida: ${fase}`);
  }
  const root = historicoRoot(pipelineDir);
  const dir = path.resolve(root, pipeline, fase);
  if (!(dir === path.resolve(root) || dir.startsWith(path.resolve(root) + path.sep))) {
    throw new Error('historico: path fuera de la raíz');
  }
  return listIssueFiles(dir, issue);
}

module.exports = {
  TERMINAL_FASES,
  TRANSITIONS_LOG,
  historicoRoot,
  assertSameVolume,
  moverAHistorico,
  estaEnReposo,
  alcanzoTerminal,
  esArchivable,
  archivarIssueTerminado,
  barrerHistorico,
  leerHistorico,
};

// =============================================================================
// eta-markers.js — Infra compartida de scanning de markers FS (#3517).
//
// Extrae a un único lugar el walk de `.pipeline/<pipeline>/<fase>/{procesado,listo}/`
// que hasta ahora estaba duplicado en tres consumidores:
//
//   - `lib/eta-wave.js._collectMarkers` (#3492) — necesita perIssue + perFase.
//   - `dashboard.js` (builder de `state.etaAverages`, líneas ~640-667) — necesita
//     perFaseSkill con avg redondeado para el render del Kanban.
//   - `lib/eta.js` (#2895) — re-exporta `fmtAbsoluteHHMM`, que vivía acá embebido.
//
// Decisiones de diseño (cerradas en el issue #3517):
//   - D1: el módulo es PURA INFRAESTRUCTURA. Las APIs públicas de eta.js y
//         eta-wave.js no cambian — sus contratos siguen exactamente como están.
//   - D2: una sola pasada sobre el FS produce las tres formas (perIssue,
//         perFase, perFaseSkill) en un solo objeto, para evitar dos walks por
//         refresh del dashboard.
//   - D3: la lectura del contenido del marker para detectar `resultado: rechazado`
//         está detrás de `includeRejection`. El dashboard no necesita esa señal
//         (corre frecuentemente y leer cientos de archivos por refresh es caro);
//         eta-wave sí la necesita pero está cacheada 30s.
//
// Invariantes inquebrantables (CA-S1..S8 de #3517):
//   - Read-only sobre el FS (CA-S2): cero fs.writeFile*, fs.appendFile*,
//     fs.createWriteStream, fs.mkdir*, fs.rename*, fs.unlink*.
//   - Sin eval / new Function / vm (CA-S1).
//   - Sin nuevas dependencias npm (CA-S3): solo built-ins `fs`, `path` y el
//     helper local `isMarkerArtifact` re-importado desde `lib/human-block.js`.
//   - Outputs sin paths absolutos, hostnames ni usernames (CA-S4): solo issue
//     numbers, fase, skill y duraciones en ms.
//   - Logs solo agregados, nunca filenames/issue numbers individuales (CA-S5).
//   - Errores de readdir/lstat se manejan con try/catch silencioso (CA-S6).
//   - Usa lstat (no stat) y descarta no-files para defensa contra symlinks
//     plantados bajo `.pipeline/` (CA-S7).
//   - La validación defensiva de issue numbers / concurrency / issueList caps
//     NO vive acá — permanece en eta.js y eta-wave.js (CA-S8).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
// #3638 CA-F-1: import desde fuente canónica `lib/marker-artifact.js`.
const { isMarkerArtifact } = require('./marker-artifact');

// ─── Constantes públicas ───────────────────────────────────────────────────

// Límites de duración válida por marker. Valores literales preservados desde
// las tres ubicaciones duplicadas (eta-wave.js:85-86 y dashboard.js:651).
const MIN_VALID_DURATION_MS = 5000;            // <5s = run espurio
const MAX_VALID_DURATION_MS = 4 * 60 * 60 * 1000; // >4h = abandono

// Pipelines conocidos (mismo set que `lib/human-block.js`).
const PIPELINES = ['desarrollo', 'definicion'];

// ─── Resolución de root ────────────────────────────────────────────────────

/**
 * Devuelve el directorio `.pipeline/` del proyecto. Respeta
 * `PIPELINE_ROOT_OVERRIDE` para tests (mismo patrón que eta-wave.js).
 *
 * `PIPELINE_ROOT_OVERRIDE` apunta al "root del proyecto"; el `.pipeline/` es
 * subdirectorio. Si el override no existe se cae al __dirname/../..
 */
function defaultPipelineDir() {
  if (process.env.PIPELINE_ROOT_OVERRIDE) {
    return path.join(process.env.PIPELINE_ROOT_OVERRIDE, '.pipeline');
  }
  // .pipeline/lib/eta-markers.js → ../..(repoRoot) + .pipeline
  return path.join(__dirname, '..');
}

// ─── Listado de archivos por fase ──────────────────────────────────────────

/**
 * Devuelve los basenames de markers válidos dentro de
 * `<faseDir>/procesado/` y `<faseDir>/listo/`, filtrando:
 *
 *   - dotfiles (`.gitkeep`, `.something`)
 *   - prefijo `_` (uso interno del pipeline)
 *   - artifacts auxiliares según `lib/human-block.isMarkerArtifact`
 *     (`.reason.json`, `.guidance.txt`, `.comment.md`, > 2 segments)
 *
 * Devuelve `[{ dir, name }]` para que el caller pueda reconstruir el path
 * absoluto sin acoplar a este módulo.
 *
 * Errores de `readdir` (directorio inexistente, EACCES) son tragados — la
 * función nunca crashea, simplemente devuelve un array vacío para ese estado
 * (CA-S6).
 *
 * @param {string} faseDir — path absoluto a `.pipeline/<pipeline>/<fase>`
 * @returns {Array<{dir: string, name: string}>}
 */
function listProcessedFiles(faseDir) {
  const out = [];
  for (const estado of ['procesado', 'listo']) {
    const dir = path.join(faseDir, estado);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name) continue;
      if (name.startsWith('.') || name.startsWith('_')) continue;
      if (isMarkerArtifact(name)) continue;
      out.push({ dir, name });
    }
  }
  return out;
}

// ─── lstat defensivo (CA-S7) ───────────────────────────────────────────────

/**
 * `fs.lstatSync` envuelto en try/catch + filtro `isFile()`. Devuelve null si
 * el archivo no existe (TOCTOU entre readdir y stat), está caído (EACCES) o
 * resulta ser un symlink/directorio plantado en `procesado/`.
 *
 * Usar lstat (no stat) evita seguir symlinks que un agente comprometido
 * podría plantar bajo `.pipeline/<fase>/procesado/`. Para regular files
 * lstat == stat, así que no hay diferencia de comportamiento normal.
 */
function safeLstat(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!st || !st.isFile()) return null;
  return st;
}

// ─── Lectura defensiva del contenido para detectar rechazo ────────────────

/**
 * Lee el marker y busca `resultado: rechazado` al inicio de línea. Lectura
 * sincrónica de archivos pequeños del pipeline (NO del JSONL — CA-12 del
 * spike #3492 solo aplica a `metrics-history.jsonl`).
 *
 * Cualquier error de I/O → false silencioso (el marker simplemente no cuenta
 * como rechazo).
 */
function hasRejectionMarker(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    return /^[ \t]*resultado[ \t]*:[ \t]*rechazado\b/m.test(txt);
  } catch {
    return false;
  }
}

// ─── collectMarkers — single-pass walk del pipeline ────────────────────────

/**
 * Walk de los markers de todas las fases del pipeline, devolviendo tres
 * vistas agregadas en un solo objeto (D2). Esto evita que cada consumidor
 * tenga que repetir el walk.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 *   Path absoluto a `.pipeline/`. Default: `defaultPipelineDir()`.
 * @param {Array<{pipeline:string, fase:string}>} [opts.allFases]
 *   Si se pasa, restringe el walk a esas tuplas. Si se omite, auto-descubre
 *   los directorios bajo `<root>/{desarrollo,definicion}/`. El dashboard usa
 *   esta opción para mantener orden y consistencia con su lista interna.
 * @param {boolean} [opts.includeRejection=false]
 *   Si true, lee cada marker para detectar `resultado: rechazado` y populá
 *   `perIssue[issue].rejected` + `totalRejected`. Cuesta una syscall extra
 *   por archivo, así que solo eta-wave (cacheado 30s) lo prende.
 *
 * @returns {{
 *   perIssue:      { [issueNum:number]: { totalMs:number, fases:{[fase:string]:number}, rejected:boolean } },
 *   perFase:       { [fase:string]: number[] },                       // duraciones crudas en ms
 *   perFaseSkill:  { [key:string]: { total:number, count:number, avgMs:number } },
 *                                                                     // keys: `${fase}/${skill}` y `${fase}` (coarse)
 *   totalProcessed:number,
 *   totalRejected: number,
 * }}
 */
function collectMarkers(opts) {
  const o = opts || {};
  const root = o.root || defaultPipelineDir();
  const includeRejection = o.includeRejection === true;

  // Resolver lista de (pipeline, fase) a recorrer.
  let pairs = [];
  if (Array.isArray(o.allFases) && o.allFases.length > 0) {
    pairs = o.allFases
      .filter((x) => x && x.pipeline && x.fase)
      .map((x) => ({ pipeline: String(x.pipeline), fase: String(x.fase) }));
  } else {
    // Auto-descubrir: para cada pipeline conocido, listar subdirectorios.
    for (const pipelineName of PIPELINES) {
      const pdir = path.join(root, pipelineName);
      let entries = [];
      try {
        entries = fs.readdirSync(pdir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const fase of entries) {
        pairs.push({ pipeline: pipelineName, fase });
      }
    }
  }

  const perIssue = {};
  const perFase = {};
  const perFaseSkill = {};
  let totalProcessed = 0;
  let totalRejected = 0;

  for (const { pipeline: pName, fase } of pairs) {
    const faseDir = path.join(root, pName, fase);
    const files = listProcessedFiles(faseDir);
    for (const { dir, name } of files) {
      const fullPath = path.join(dir, name);
      const st = safeLstat(fullPath);
      if (!st) continue;

      const dur = st.ctimeMs - st.birthtimeMs;
      if (!Number.isFinite(dur)) continue;
      if (dur <= MIN_VALID_DURATION_MS) continue;
      if (dur > MAX_VALID_DURATION_MS) continue;

      // Parseo de `<issue>.<skill>` — formato estable garantizado por
      // isMarkerArtifact (descarta > 2 segments).
      const dot = name.indexOf('.');
      if (dot <= 0) continue;
      const issueStr = name.slice(0, dot);
      const skill = name.slice(dot + 1);
      const issue = Number(issueStr);
      if (!Number.isInteger(issue) || issue <= 0) continue;
      if (!skill) continue;

      totalProcessed++;

      // perIssue: agregado total + por fase + flag rejected (opcional).
      if (!perIssue[issue]) {
        perIssue[issue] = { totalMs: 0, fases: {}, rejected: false };
      }
      perIssue[issue].totalMs += dur;
      perIssue[issue].fases[fase] = (perIssue[issue].fases[fase] || 0) + dur;

      // perFase: duraciones crudas para percentiles posteriores.
      if (!perFase[fase]) perFase[fase] = [];
      perFase[fase].push(dur);

      // perFaseSkill: agregado para el dashboard. Mantiene el shape exacto
      // que produce `dashboard.js` (líneas 640-667): `${fase}/${skill}` →
      // { total, count, avgMs }.
      const finegrain = `${fase}/${skill}`;
      if (!perFaseSkill[finegrain]) perFaseSkill[finegrain] = { total: 0, count: 0, avgMs: 0 };
      perFaseSkill[finegrain].total += dur;
      perFaseSkill[finegrain].count += 1;

      // Rechazo: opcional para no penalizar consumidores que no lo necesitan.
      if (includeRejection && hasRejectionMarker(fullPath)) {
        if (!perIssue[issue].rejected) {
          perIssue[issue].rejected = true;
          totalRejected++;
        }
      }
    }
  }

  // Calcular avgMs y construir el bucket coarse (solo `fase` sin skill).
  // El dashboard hace esto inline (líneas 660-669); lo replicamos byte-a-byte:
  //  1) primero avgMs de los finegrain
  //  2) luego acumular en el coarse y calcular su avgMs al final
  // Hacemos una copia previa de las keys finegrain para no iterar sobre
  // un objeto que mutamos durante el recorrido.
  const finegrainKeys = Object.keys(perFaseSkill);
  for (const key of finegrainKeys) {
    const entry = perFaseSkill[key];
    entry.avgMs = Math.round(entry.total / entry.count);
    const fase = key.split('/')[0];
    if (!perFaseSkill[fase]) perFaseSkill[fase] = { total: 0, count: 0, avgMs: 0 };
    perFaseSkill[fase].total += entry.total;
    perFaseSkill[fase].count += entry.count;
  }
  // Calcular avgMs solo de los coarse (las keys sin `/`).
  for (const key of Object.keys(perFaseSkill)) {
    if (!key.includes('/')) {
      const entry = perFaseSkill[key];
      if (entry.count > 0) entry.avgMs = Math.round(entry.total / entry.count);
    }
  }

  return { perIssue, perFase, perFaseSkill, totalProcessed, totalRejected };
}

// ─── fmtAbsoluteHHMM — re-uso del helper desde eta.js (#2895) ─────────────

/**
 * Formatea un epoch ms a "HH:MM" en hora local. Idéntico byte-a-byte al
 * helper original que vivía en `lib/eta.js`. Se mueve acá para que tanto
 * eta.js (card render) como eta-wave.js (panel de ola) puedan importarlo
 * sin duplicarlo (CA-F2).
 */
function fmtAbsoluteHHMM(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  // API pública
  collectMarkers,
  listProcessedFiles,
  fmtAbsoluteHHMM,
  // Constantes
  MIN_VALID_DURATION_MS,
  MAX_VALID_DURATION_MS,
  PIPELINES,
  // Internals expuestos para tests
  _internal: {
    defaultPipelineDir,
    safeLstat,
    hasRejectionMarker,
  },
};

// .pipeline/lib/restart-orphan-annotator.js
// =============================================================================
// Mueve archivos huérfanos de `trabajando/` → `pendiente/` durante un restart,
// anotando trazabilidad sobre la interrupción.
//
// Issue #2374 Parte 1 — preservación de trabajo interrumpido por restart.
//
// Contrato:
//   annotateAndMoveOrphans({ pipelineRoot, pipelinesScan, restartAt }) → { movedCount }
//
//   - pipelineRoot:   absoluto, raíz del `.pipeline/` (donde viven los dirs
//                     `desarrollo/` y `definicion/`).
//   - pipelinesScan:  array de nombres de subcarpetas de pipelines a barrer
//                     (default: ['desarrollo', 'definicion']).
//   - restartAt:      ISO string del timestamp del restart.
//
//   Por cada archivo `<issue>.<skill>` en `<pipeline>/<fase>/trabajando/`:
//     1. Lee el contenido.
//     2. Si parece YAML estructurado y NO tiene ya `restart_interrupted:`,
//        agrega las claves `restart_interrupted: true` y `restart_at: <ISO>`.
//     3. Escribe el resultado en `<pipeline>/<fase>/pendiente/<f>`.
//     4. Borra el origen.
//
//   Idempotente: si el archivo ya tiene la marca (caso patológico de dos
//   restarts consecutivos sin que el agente arranque) no la duplica.
//
//   Defensivo: si la lectura/parseo falla, hace un rename clásico para no
//   perder el archivo (comportamiento histórico pre-#2374).
//
// El módulo es side-effect heavy (toca el filesystem) pero está acotado a
// `pipelineRoot` para test con un tmpdir.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// `<issueId>.<skill>` — ej. `1915.qa`, `2441.guru`. Filtra `.gitkeep` y otros.
const AGENTE_FILE_REGEX = /^\d+\.[a-z][a-z0-9-]*$/;

// Heurística simple para detectar YAML estructurado: empieza con una clave
// de identificador seguido de `:`.
const YAML_LIKE_RE = /^\s*[a-zA-Z_][a-zA-Z0-9_-]*\s*:/;

function annotateContent(raw, restartAt) {
  if (raw.includes('restart_interrupted:')) return raw; // idempotente
  const trimmed = raw.replace(/\s*$/, '');
  return `${trimmed}\nrestart_interrupted: true\nrestart_at: '${restartAt}'\n`;
}

function annotateAndMoveOrphans(opts) {
  const {
    pipelineRoot,
    pipelinesScan = ['desarrollo', 'definicion'],
    restartAt,
  } = opts;

  if (!pipelineRoot || typeof pipelineRoot !== 'string') {
    throw new Error('annotateAndMoveOrphans: pipelineRoot requerido');
  }
  const stamp = restartAt || new Date().toISOString();

  let movedCount = 0;

  for (const pipeline of pipelinesScan) {
    const pipeDir = path.join(pipelineRoot, pipeline);
    if (!fs.existsSync(pipeDir)) continue;
    let fases;
    try { fases = fs.readdirSync(pipeDir); } catch { continue; }
    for (const fase of fases) {
      const trabajando = path.join(pipeDir, fase, 'trabajando');
      const pendiente = path.join(pipeDir, fase, 'pendiente');
      if (!fs.existsSync(trabajando)) continue;
      try {
        if (!fs.existsSync(pendiente)) fs.mkdirSync(pendiente, { recursive: true });
      } catch { continue; }

      let entries;
      try { entries = fs.readdirSync(trabajando); } catch { continue; }
      for (const f of entries) {
        if (!AGENTE_FILE_REGEX.test(f)) continue;
        const srcPath = path.join(trabajando, f);
        const dstPath = path.join(pendiente, f);
        let annotated = false;
        try {
          const raw = fs.readFileSync(srcPath, 'utf8');
          if (raw && YAML_LIKE_RE.test(raw)) {
            fs.writeFileSync(dstPath, annotateContent(raw, stamp));
            try { fs.unlinkSync(srcPath); } catch {}
            annotated = true;
          }
        } catch {
          // I/O falló — caemos al rename clásico abajo.
        }
        if (!annotated) {
          try { fs.renameSync(srcPath, dstPath); } catch {}
        }
        movedCount++;
      }
    }
  }

  return { movedCount };
}

module.exports = {
  annotateAndMoveOrphans,
  annotateContent,
  AGENTE_FILE_REGEX,
};

// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// singleton.js — Garantiza una sola instancia por componente del pipeline
//
// Fuente de verdad: el SO (wmic/ps via pid-discovery), no el filesystem.
// Uso: require('./singleton')('pulpo') al inicio de cada script.
//
// El archivo .pid se escribe como hint informativo para diagnóstico, pero
// NO se lee ni se confía en él: la detección de singleton y el estado real
// se obtienen siempre del SO en el momento.

const fs = require('fs');
const path = require('path');
const { findPidByScript, SCRIPT_MAP, invalidateCache } = require('./pid-discovery');

// #7112 — El directorio base del pipeline se resuelve POR LLAMADA vía
// `lib/write-target` sobre `lib/pipeline-env` (SEC-13): ninguna const de módulo
// captura el destino al `require`. Sin ambiente declarado (`PIPELINE_AMBIENTE`
// del lanzador) y sin dir de pruebas, `writeDir` avisa por stderr y LANZA:
// nunca se escribe en el productivo por defecto (CA-3 / SEC-10). Se conservan
// los identificadores en mayúsculas para que el reemplazo const→función sea
// mecánico: cada uso pasó de `X` a `X()`.
const writeTarget = require('./lib/write-target');
function PIPELINE() { return writeTarget.writeDir(process.env, { canal: 'estado', destino: '<servicio>.pid' }); }
function READY_DIR() { return writeTarget.writePath(process.env, { canal: 'estado', destino: 'ready/' }, 'ready'); }

/**
 * Garantiza singleton. Si ya hay una instancia viva del mismo script (según
 * el SO), aborta. pid-discovery cachea el scan de procesos 2s, así que los
 * 7 singletons que arrancan en paralelo por launchAll() comparten un único
 * scan wmic y no hace falta lock de filesystem.
 *
 * @param {string} name — nombre del componente (pulpo, listener, etc.)
 */
module.exports = function singleton(name) {
  const scriptName = SCRIPT_MAP[name] || `${name}.js`;

  // Forzar refresh: si el scan viene cacheado de antes de que arrancáramos,
  // podríamos no vernos a nosotros mismos (no necesitamos vernos) pero sí
  // queremos ver cualquier instancia previa que siga viva.
  invalidateCache();
  const existing = findPidByScript(scriptName);

  if (existing && existing.pid !== process.pid) {
    // Antes de abortar, refrescar el marker ready con el PID de la instancia
    // viva. Motivo: si el marker no existe o tiene un PID stale, smoke-test
    // reporta MISSING/STALE a pesar de que el proceso correcto está corriendo
    // (ver issue #2450). Al abortar silenciosamente, el proceso original
    // nunca reescribe su marker. Lo hacemos acá en su lugar, usando el PID
    // que el SO nos reporta como vivo. No-op si falla (best-effort).
    try {
      if (!fs.existsSync(READY_DIR())) fs.mkdirSync(READY_DIR(), { recursive: true });
      const markerPath = path.join(READY_DIR(), `${name}.ready`);
      const now = new Date().toISOString();
      fs.writeFileSync(markerPath, JSON.stringify({
        name,
        pid: existing.pid,
        startedAt: existing.creationDate || now,
        readyAt: now,
        meta: { refreshedBy: 'singleton-abort', abortedPid: process.pid },
      }, null, 2));
    } catch {}
    console.error(`[FATAL] Ya hay una instancia de ${name} corriendo (PID ${existing.pid}). Abortando.`);
    process.exit(1);
  }

  // Hint informativo para diagnóstico humano — no es fuente de verdad.
  const pidFile = path.join(PIPELINE(), `${name}.pid`);
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}

  process.on('exit', () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {}
  });

  return pidFile;
};

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

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);

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
    console.error(`[FATAL] Ya hay una instancia de ${name} corriendo (PID ${existing.pid}). Abortando.`);
    process.exit(1);
  }

  // Hint informativo para diagnóstico humano — no es fuente de verdad.
  const pidFile = path.join(PIPELINE, `${name}.pid`);
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}

  process.on('exit', () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {}
  });

  return pidFile;
};

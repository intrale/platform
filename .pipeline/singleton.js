// singleton.js — Garantiza una sola instancia por componente del pipeline
// Verifica en la lista de procesos del SO, no depende de archivos PID.
//
// Uso: require('./singleton')('pulpo') al inicio de cada script
// Si ya hay otro node.exe corriendo el mismo script, aborta.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);

/**
 * Busca procesos node.exe que tengan el mismo script en su command line.
 * Retorna array de PIDs (excluyendo el proceso actual).
 */
function findSiblings(scriptName) {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('wmic', [
        'process', 'where', "name='node.exe'",
        'get', 'ProcessId,CommandLine', '/format:csv'
      ], { encoding: 'utf8', timeout: 10000, windowsHide: true });

      const lines = (r.stdout || '').split('\n');
      const pids = [];
      for (const line of lines) {
        if (line.includes(scriptName) && !line.includes('wmic')) {
          // CSV format: node,commandline,pid
          const match = line.match(/(\d+)\s*$/);
          if (match) {
            const pid = parseInt(match[1]);
            if (pid !== process.pid) pids.push(pid);
          }
        }
      }
      return pids;
    } catch { return []; }
  }

  // Linux/Mac: usar ps
  try {
    const r = spawnSync('ps', ['aux'], { encoding: 'utf8', timeout: 5000 });
    const lines = (r.stdout || '').split('\n');
    const pids = [];
    for (const line of lines) {
      if (line.includes(scriptName) && line.includes('node')) {
        const match = line.match(/^\S+\s+(\d+)/);
        if (match) {
          const pid = parseInt(match[1]);
          if (pid !== process.pid) pids.push(pid);
        }
      }
    }
    return pids;
  } catch { return []; }
}

/**
 * Garantiza singleton. Si ya hay una instancia viva del mismo script, aborta.
 * @param {string} name — nombre del componente (pulpo, listener, svc-telegram, etc.)
 */
module.exports = function singleton(name) {
  // Mapeo nombre → script filename
  const scriptMap = {
    'pulpo': 'pulpo.js',
    'listener': 'listener-telegram.js',
    'svc-telegram': 'servicio-telegram.js',
    'svc-github': 'servicio-github.js',
    'svc-drive': 'servicio-drive.js',
    'svc-emulador': 'servicio-emulador.js',
    'dashboard': 'dashboard-v2.js'
  };

  const scriptName = scriptMap[name] || `${name}.js`;
  const siblings = findSiblings(scriptName);

  if (siblings.length > 0) {
    console.error(`[FATAL] Ya hay ${siblings.length} instancia(s) de ${name} corriendo: PIDs ${siblings.join(', ')}. Abortando.`);
    process.exit(1);
  }

  // Escribir PID file (informativo, para el watchdog y diagnóstico)
  const pidFile = path.join(PIPELINE, `${name}.pid`);
  fs.writeFileSync(pidFile, String(process.pid));

  // Cleanup al salir
  process.on('exit', () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {}
  });

  return pidFile;
};

// singleton.js — Garantiza una sola instancia por componente del pipeline
// Uso: require('./singleton')('pulpo') al inicio de cada script

const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);

function isProcessAlive(pid) {
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true
      });
      return (r.stdout || '').includes(`"${pid}"`);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Garantiza singleton. Si ya hay una instancia viva, mata este proceso.
 * @param {string} name — nombre del componente (pulpo, listener, svc-telegram, etc.)
 * @returns {string} path al PID file (para cleanup en shutdown)
 */
module.exports = function singleton(name) {
  const pidFile = path.join(PIPELINE, `${name}.pid`);

  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (oldPid && oldPid !== process.pid && isProcessAlive(oldPid)) {
      console.error(`[FATAL] Ya hay un ${name} corriendo (PID ${oldPid}). Abortando.`);
      process.exit(1);
    }
  } catch {}

  // Registrar nuestro PID
  fs.writeFileSync(pidFile, String(process.pid));

  // Cleanup al salir
  const cleanup = () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return pidFile;
};

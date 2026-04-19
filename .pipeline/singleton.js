// singleton.js — Garantiza una sola instancia por componente del pipeline
// Verifica en la lista de procesos del SO, no depende de archivos PID.
//
// Uso: require('./singleton')('pulpo') al inicio de cada script
// Si ya hay otro node.exe corriendo el mismo script, aborta.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);

// Sleep sincrónico reutilizable (mismo patrón que restart.js).
function sleepMs(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 1000 });
}

// Lock file-based para serializar wmic scans en Windows.
// Cuando restart.js spawnea 7 componentes en paralelo, los 7 singletons
// ejecutan wmic al mismo tiempo; en Windows eso puede tomar >30s por
// contención (wmic es lento y no concurrente). Serializamos.
const WMIC_LOCK_FILE = path.join(PIPELINE, '.wmic-scan.lock');
const WMIC_LOCK_MAX_WAIT_MS = 45000;
const WMIC_LOCK_POLL_MS = 200;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireWmicLock() {
  const start = Date.now();
  while (Date.now() - start < WMIC_LOCK_MAX_WAIT_MS) {
    try {
      const fd = fs.openSync(WMIC_LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      // Si el dueño del lock murió, lo liberamos.
      try {
        const ownerPid = parseInt((fs.readFileSync(WMIC_LOCK_FILE, 'utf8') || '').trim(), 10);
        if (ownerPid && ownerPid !== process.pid && !pidAlive(ownerPid)) {
          try { fs.unlinkSync(WMIC_LOCK_FILE); } catch {}
          continue;
        }
      } catch {}
      sleepMs(WMIC_LOCK_POLL_MS);
    }
  }
  // Si no pudimos obtener el lock, seguimos igual — mejor un scan
  // concurrente que abortar el arranque del componente.
  return false;
}

function releaseWmicLock(held) {
  if (!held) return;
  try {
    const ownerPid = parseInt((fs.readFileSync(WMIC_LOCK_FILE, 'utf8') || '').trim(), 10);
    if (ownerPid === process.pid) fs.unlinkSync(WMIC_LOCK_FILE);
  } catch {}
}

/**
 * Busca procesos node.exe que tengan el mismo script en su command line.
 * Retorna array de PIDs (excluyendo el proceso actual).
 */
function findSiblings(scriptName) {
  if (process.platform === 'win32') {
    const held = acquireWmicLock();
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
    finally { releaseWmicLock(held); }
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

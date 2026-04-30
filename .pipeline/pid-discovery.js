// pid-discovery.js — Descubre PIDs de componentes del pipeline al vuelo.
//
// Fuente de verdad: el sistema operativo (wmic/ps + netstat/lsof), no el
// filesystem. Elimina la clase de bug "archivo .pid desincronizado del
// proceso real" cuando watchdogs respawnean o cuando dos instancias se
// pisan durante un restart.
//
// API pública:
//   findPidByComponent(name)  → { pid, commandLine, creationDate } | null
//   findPidByScript(scriptFile) → idem
//   findPidByPort(port)       → pid | null  (socket LISTENING)
//   pidAlive(pid)             → boolean
//   scanNodeProcesses()       → [{ pid, commandLine, creationDate }]  (cacheado 2s)
//   invalidateCache()         → fuerza refresh del próximo scan
//   SCRIPT_MAP                → mapa nombre → scriptfile

const { spawnSync } = require('child_process');

const SCRIPT_MAP = {
  'pulpo': 'pulpo.js',
  'listener': 'listener-telegram.js',
  'svc-telegram': 'servicio-telegram.js',
  'svc-github': 'servicio-github.js',
  'svc-drive': 'servicio-drive.js',
  'svc-emulador': 'servicio-emulador.js',
  'svc-reconciler': 'servicio-reconciler.js',
  'dashboard': 'dashboard.js',
  'outbox-drain': 'outbox-drain.js',
};

const CACHE_TTL_MS = 2000;
let _scanCache = null;
let _scanCacheAt = 0;

function scanNodeProcesses() {
  const now = Date.now();
  if (_scanCache && (now - _scanCacheAt) < CACHE_TTL_MS) return _scanCache;

  const processes = [];
  if (process.platform === 'win32') {
    try {
      // Sin WHERE. Cuando el comando se pasa con shell:true, Node lanza
      // cmd.exe /d /s /c "<cmd>"; cmd.exe /c quita las comillas externas y
      // el filtro "name='node.exe'" llega a wmic sin comillas (name=node.exe),
      // disparando "No se reconoce el filtro de búsqueda" en loop.
      // Solución: traer todos los procesos y filtrar Name=node.exe en JS.
      const r = spawnSync(
        'wmic process get Name,ProcessId,CommandLine,CreationDate /format:csv',
        { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true }
      );
      const lines = (r.stdout || '').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.includes(',')) continue;
        // header: Node,CommandLine,CreationDate,Name,ProcessId
        if (/^Node,/i.test(t)) continue;
        const parts = t.split(',');
        if (parts.length < 5) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!pid || Number.isNaN(pid)) continue;
        const name = (parts[parts.length - 2] || '').trim();
        if (name.toLowerCase() !== 'node.exe') continue;
        const creationDate = parts[parts.length - 3] || '';
        const commandLine = parts.slice(1, -3).join(',');
        processes.push({ pid, commandLine, creationDate });
      }
    } catch {}
  } else {
    try {
      const r = spawnSync('ps', ['-eo', 'pid,lstart,command'], { encoding: 'utf8', timeout: 5000 });
      const lines = (r.stdout || '').split('\n').slice(1);
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
        if (!m) continue;
        const cmd = m[3];
        if (!cmd.includes('node')) continue;
        processes.push({ pid: parseInt(m[1], 10), commandLine: cmd, creationDate: m[2] });
      }
    } catch {}
  }

  _scanCache = processes;
  _scanCacheAt = now;
  return processes;
}

function findPidByScript(scriptName) {
  for (const p of scanNodeProcesses()) {
    if (p.commandLine && p.commandLine.includes(scriptName)) return p;
  }
  return null;
}

function findPidByComponent(name) {
  const script = SCRIPT_MAP[name] || `${name}.js`;
  return findPidByScript(script);
}

function findPidByPort(port) {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const lines = (r.stdout || '').split('\n');
      for (const line of lines) {
        if (!line.includes('LISTENING')) continue;
        const m = line.trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (m && parseInt(m[1], 10) === port) return parseInt(m[2], 10);
      }
    } catch {}
  } else {
    try {
      const r = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', `-i:${port}`], { encoding: 'utf8', timeout: 5000 });
      const lines = (r.stdout || '').split('\n').slice(1);
      for (const line of lines) {
        const m = line.trim().match(/^\S+\s+(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    } catch {}
  }
  return null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function invalidateCache() {
  _scanCache = null;
  _scanCacheAt = 0;
}

module.exports = {
  SCRIPT_MAP,
  scanNodeProcesses,
  findPidByScript,
  findPidByComponent,
  findPidByPort,
  pidAlive,
  invalidateCache,
};

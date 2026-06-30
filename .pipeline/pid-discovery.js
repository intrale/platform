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

const { spawnSync, exec } = require('child_process');

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

// Comando del scan de procesos node por plataforma. Extraído para que el
// scan SÍNCRONO (spawnSync) y el ASÍNCRONO (exec) compartan exactamente el
// mismo comando + parser, evitando divergencias.
// Sin WHERE en wmic: con shell, cmd.exe /c quita las comillas externas y el
// filtro "name='node.exe'" llega sin comillas → "No se reconoce el filtro de
// búsqueda" en loop. Solución: traer todos y filtrar Name=node.exe en JS.
const _WMIC_CMD = 'wmic process get Name,ProcessId,CommandLine,CreationDate /format:csv';

function _parseWmicCsv(stdout) {
  const processes = [];
  const lines = (stdout || '').split('\n');
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
  return processes;
}

function _parsePsOutput(stdout) {
  const processes = [];
  const lines = (stdout || '').split('\n').slice(1);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
    if (!m) continue;
    const cmd = m[3];
    if (!cmd.includes('node')) continue;
    processes.push({ pid: parseInt(m[1], 10), commandLine: cmd, creationDate: m[2] });
  }
  return processes;
}

function scanNodeProcesses() {
  const now = Date.now();
  if (_scanCache && (now - _scanCacheAt) < CACHE_TTL_MS) return _scanCache;

  let processes = [];
  if (process.platform === 'win32') {
    try {
      const r = spawnSync(_WMIC_CMD, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true });
      processes = _parseWmicCsv(r.stdout);
    } catch {}
  } else {
    try {
      const r = spawnSync('ps', ['-eo', 'pid,lstart,command'], { encoding: 'utf8', timeout: 5000 });
      processes = _parsePsOutput(r.stdout);
    } catch {}
  }

  _scanCache = processes;
  _scanCacheAt = now;
  return processes;
}

// Variante ASÍNCRONA del scan (#4126). Idéntica salida que scanNodeProcesses()
// pero usando `exec` para NO bloquear el event loop: spawnSync(wmic) podía
// clavar el loop hasta 15s y starvar el smoke (/api/health) del restart. El
// dashboard la consume desde un refresh en background con TTL; el resto del
// pipeline puede seguir usando la versión sync. Comparte `_scanCache`, así que
// cualquier llamada sync posterior dentro del TTL reusa el resultado caliente.
function scanNodeProcessesAsync() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (_scanCache && (now - _scanCacheAt) < CACHE_TTL_MS) return resolve(_scanCache);

    const onDone = (stdout, parser) => {
      let processes = [];
      try { processes = parser(stdout); } catch { processes = []; }
      _scanCache = processes;
      _scanCacheAt = Date.now();
      resolve(processes);
    };

    if (process.platform === 'win32') {
      exec(_WMIC_CMD, { encoding: 'utf8', timeout: 15000, windowsHide: true },
        (err, stdout) => onDone(err ? '' : stdout, _parseWmicCsv));
    } else {
      exec('ps -eo pid,lstart,command', { encoding: 'utf8', timeout: 5000 },
        (err, stdout) => onDone(err ? '' : stdout, _parsePsOutput));
    }
  });
}

function findPidByScript(scriptName) {
  return findPidByScriptIn(scanNodeProcesses(), scriptName);
}

// Matcher PURO (sin syscalls) sobre una lista ya obtenida. Permite que un
// consumidor que ya escaneó async (scanNodeProcessesAsync) resuelva varios
// componentes sin re-spawnear nada. (#4126)
function findPidByScriptIn(list, scriptName) {
  for (const p of (Array.isArray(list) ? list : [])) {
    if (p && p.commandLine && p.commandLine.includes(scriptName)) return p;
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

// Sleep síncrono y bloqueante reusando spawnSync (mismo patrón que restart.js).
// Evita meter timers async en una función que se llama desde un flujo
// secuencial de restart. Acotado por el `timeout` del spawn.
function _sleepBlocking(ms) {
  if (!ms || ms <= 0) return;
  try {
    spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
  } catch {}
}

// commandLineForPid(pid) → string | null
// Busca el PID dentro del scan de procesos node (que ya devuelve
// {pid, commandLine}) y retorna su commandLine. NO ejecuta comandos nuevos de
// shell (CA-6 / SEC-1): solo lee el resultado del scan ya cacheado.
function commandLineForPid(pid) {
  const p = scanNodeProcesses().find(x => x.pid === pid);
  return p ? p.commandLine : null;
}

// waitForPortFree(port, { attempts, delayMs, onHolder }) → boolean
// Espera de forma ACOTADA a que `port` quede libre (sin proceso LISTENING).
// En cada vuelta: invalida cache, consulta findPidByPort(port); si está libre
// retorna true; si hay holder invoca onHolder(pid) — para que el caller valide
// ownership y re-mate — y duerme delayMs. Al agotar `attempts` revalida una vez
// más y retorna si el puerto quedó libre. Sin while(true) ni kill indiscriminado
// (SEC-4 / CA-3): el peor caso es degradar al comportamiento actual, nunca peor.
function waitForPortFree(port, { attempts = 6, delayMs = 500, onHolder } = {}) {
  // Resolvemos findPidByPort vía module.exports para que los unit tests puedan
  // sustituirlo (mock de findPidByPort, CA-7) sin tocar netstat real.
  const findPid = (module.exports && module.exports.findPidByPort) || findPidByPort;
  for (let i = 0; i < attempts; i++) {
    invalidateCache();
    const holder = findPid(port);
    if (!holder) return true;                                // puerto libre
    if (typeof onHolder === 'function') onHolder(holder);    // caller valida ownership + re-mata
    _sleepBlocking(delayMs);
  }
  invalidateCache();
  return findPid(port) == null;
}

module.exports = {
  SCRIPT_MAP,
  scanNodeProcesses,
  scanNodeProcessesAsync,
  findPidByScript,
  findPidByScriptIn,
  findPidByComponent,
  findPidByPort,
  pidAlive,
  invalidateCache,
  waitForPortFree,
  commandLineForPid,
};

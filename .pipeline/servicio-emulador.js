#!/usr/bin/env node
// =============================================================================
// Servicio Emulador — Gestión del emulador Android via cola con coalescencia
//
// Patrón: servicio independiente con cola filesystem (como svc-telegram, svc-github).
// Productores (Pulpo, agentes QA/tester) encolan { action: "start"|"stop" }.
// El servicio coalesce mensajes pendientes con last-write-wins y ejecuta
// contra qa-environment.js como backend de ejecución.
//
// Diseño completo: docs/pipeline/diseno-servicio-emulador.md
// =============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = path.join(PIPELINE, 'logs');

const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'emulador');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');

const QA_ENV_SCRIPT = path.join(PIPELINE, 'qa-environment.js');
const STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');
const ADB = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';

const POLL_INTERVAL = 10000; // 10 segundos
const BOOT_TIMEOUT = 120000; // 2 minutos para boot
const KILL_TIMEOUT = 15000;  // 15 segundos para kill

// --- Healthcheck zombi (#2322) ---
// Ventana de gracia para no pisar un arranque concurrente: si el state file
// fue escrito hace menos de N ms, no se limpia aunque parezca zombi.
const ZOMBIE_MTIME_GUARD_MS = 10000;
// Cada N polls del loop principal se corre el healthcheck de zombi.
// Con POLL_INTERVAL=10s y factor 3 → healthcheck cada 30s.
const ZOMBIE_HEALTHCHECK_EVERY_N_POLLS = 3;

// --- Sanitización de PIDs (CA-5 #2160) ---
// Valida que un PID leído del state file sea un entero positivo antes de
// interpolarlo en comandos tasklist/taskkill. Previene inyección de comandos
// si qa-env-state.json es corrupto o manipulado.
function sanitizePid(pid) {
  if (pid === null || pid === undefined) return null;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    log(`⚠️ PID inválido rechazado: ${JSON.stringify(pid)} — se ignora`);
    return null;
  }
  return n;
}

// --- Estado interno ---
// stopped | starting | running | stopping
let emulatorState = 'stopped';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-emulador] ${msg}`);
}

function sendTelegram(text) {
  const svcDir = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');
  try {
    fs.mkdirSync(svcDir, { recursive: true });
    const filename = `${Date.now()}-emulador.json`;
    fs.writeFileSync(path.join(svcDir, filename),
      JSON.stringify({ text, parse_mode: 'Markdown' }));
  } catch (e) {
    log(`Error encolando Telegram: ${e.message}`);
  }
}

// --- Detección de estado real del emulador ---

function detectEmulatorState() {
  // Check 1: ADB devices — es el indicador más confiable
  try {
    const adbOutput = execSync(`"${ADB}" devices`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }).trim();
    const lines = adbOutput.split('\n').filter(l => l.includes('emulator') && l.includes('device'));
    if (lines.length > 0) return 'running';
  } catch {}

  // Check 2: qa-env-state.json + proceso vivo
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const pid = sanitizePid(state.emulator || state.emulador);
    if (pid && isProcessAlive(pid)) return 'running'; // proceso vivo pero ADB no responde = starting
  } catch {}

  // Check 3: QEMU por nombre de proceso
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    if (out.includes('qemu-system')) return 'running';
  } catch {}

  return 'stopped';
}

function isProcessAlive(pid) {
  const safePid = sanitizePid(pid);
  if (!safePid) return false;
  try {
    const r = execSync(`tasklist /FI "PID eq ${safePid}" /NH /FO CSV`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.includes(`"${safePid}"`);
  } catch { return false; }
}

// --- Zombie state healthcheck (#2322) ---
// CA-4: escritura atómica del state file. Escribimos a .tmp + rename para que
// un crash a mitad del write no deje JSON corrupto en qa-env-state.json.
function atomicWriteJson(targetPath, obj) {
  const tmpPath = targetPath + '.tmp';
  const content = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

// Lee qa-env-state.json de forma tolerante (nunca throw). Si no existe o está
// corrupto, devuelve null.
function readStateFileSafe() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

// Chequea si QEMU (el binario del emulador) está vivo por nombre de proceso.
// Es lo único que podemos usar como confirmación fuera del PID del state file.
function isQemuProcessAlive() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    return out.includes('qemu-system');
  } catch { return false; }
}

// Chequea si ADB reporta algún emulador conectado con estado device.
function adbHasEmulatorAttached() {
  try {
    const adbOutput = execSync(`"${ADB}" devices`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }).trim();
    return adbOutput.split('\n').some(l => l.includes('emulator') && l.includes('device'));
  } catch { return false; }
}

// Detecta estado zombi: el state file tiene emulator=<pid> pero el PID no está
// vivo, ADB está vacío y no hay QEMU corriendo. Protección contra race:
// el state file debe haber sido modificado hace > ZOMBIE_MTIME_GUARD_MS.
// Retorna { zombie: boolean, reason, zombiePid }.
function detectZombieState() {
  const state = readStateFileSafe();
  if (!state) return { zombie: false, reason: 'sin state file' };
  const pid = sanitizePid(state.emulator || state.emulador);
  if (!pid) return { zombie: false, reason: 'sin PID en state file' };

  // Ventana de gracia: no pisar un arranque concurrente
  try {
    const mtimeAge = Date.now() - fs.statSync(STATE_FILE).mtimeMs;
    if (mtimeAge < ZOMBIE_MTIME_GUARD_MS) {
      return { zombie: false, reason: `state file recién escrito (${mtimeAge}ms)` };
    }
  } catch {}

  // Tres condiciones simultáneas para declarar zombi
  const pidAlive = isProcessAlive(pid);
  const adbAttached = adbHasEmulatorAttached();
  const qemuAlive = isQemuProcessAlive();

  if (pidAlive) return { zombie: false, reason: `PID ${pid} vivo` };
  if (adbAttached) return { zombie: false, reason: 'ADB reporta emulador conectado' };
  if (qemuAlive) return { zombie: false, reason: 'QEMU corriendo por nombre de proceso' };

  return { zombie: true, reason: 'PID muerto + ADB vacío + sin QEMU', zombiePid: pid };
}

// CA-1 / CA-3: si detecta zombi, limpia el campo emulator del state file de
// forma atómica y loggea + Telegram. Rotamos frases (CA-UX) para evitar spam
// idéntico en healthchecks recurrentes.
const ZOMBIE_MESSAGES = [
  (pid) => `⚠️ Emulador zombi detectado (PID ${pid} muerto)\n→ state file limpiado, reintentando arranque automático\nSi no levanta en 2 min, revisar: tasklist QEMU + adb devices`,
  (pid) => `🧟 Otro zombi emulador (PID ${pid}) — limpiando state file y continuando`,
  (pid) => `⚠️ State file desincronizado otra vez (PID ${pid} muerto) — reseteando`,
];
let zombieNotifCount = 0;

function cleanupZombieIfNeeded(phase /* 'startup' | 'runtime' */) {
  const result = detectZombieState();
  if (!result.zombie) return false;

  const pid = result.zombiePid;
  try {
    const state = readStateFileSafe() || {};
    delete state.emulator;
    delete state.emulador;
    state.zombieCleanedAt = new Date().toISOString();
    atomicWriteJson(STATE_FILE, state);
  } catch (e) {
    log(`Error limpiando state file zombi: ${e.message}`);
    return false;
  }

  // Log: solo PID y fase, sin paths absolutos ni contenido crudo del state
  log(`⚠️ Estado zombi detectado (${phase}) — state file limpiado (PID zombi: ${pid})`);

  // Telegram: rotar mensaje para no spamear idéntico
  const msgFn = ZOMBIE_MESSAGES[zombieNotifCount % ZOMBIE_MESSAGES.length];
  zombieNotifCount++;
  sendTelegram(msgFn(pid));

  // Marcar estado interno como stopped para que el próximo start request
  // efectivamente intente levantar, en vez de creer que ya está running.
  emulatorState = 'stopped';
  return true;
}

// --- Acciones ---

function doStart() {
  // Si venimos de una limpieza de zombi reciente, esto dejará un mensaje
  // de recuperación cuando el arranque termine bien (CA-UX cierre de ciclo).
  const cameFromZombie = zombieNotifCount > 0 && emulatorState === 'stopped';

  emulatorState = 'starting';
  log('Levantando emulador Android via qa-environment.js...');
  try {
    execSync(`node "${QA_ENV_SCRIPT}" start`, {
      cwd: ROOT, encoding: 'utf8', timeout: BOOT_TIMEOUT, windowsHide: true
    });
    emulatorState = 'running';
    log('Emulador levantado OK');
    if (cameFromZombie) {
      const newPid = sanitizePid((readStateFileSafe() || {}).emulator) || '?';
      sendTelegram(`✅ Emulador recuperado (PID ${newPid}) — volviendo a operación normal`);
      zombieNotifCount = 0; // resetear el rotador de mensajes
    } else {
      sendTelegram('🧪 Emulador Android levantado (servicio-emulador)');
    }
    return true;
  } catch (e) {
    log(`Error levantando emulador: ${e.message}`);
    emulatorState = detectEmulatorState(); // puede haber levantado parcialmente
    sendTelegram(`⚠️ Error levantando emulador: ${e.message.slice(0, 100)}`);
    return false;
  }
}

function doStop() {
  emulatorState = 'stopping';
  log('Deteniendo emulador Android via qa-environment.js...');
  try {
    execSync(`node "${QA_ENV_SCRIPT}" stop`, {
      cwd: ROOT, encoding: 'utf8', timeout: KILL_TIMEOUT, windowsHide: true
    });
  } catch (e) {
    log(`Error deteniendo via script: ${e.message}`);
  }

  // Fallback: matar QEMU por nombre si sigue vivo
  try {
    const check = execSync('tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    if (check.includes('qemu-system')) {
      execSync('taskkill /IM qemu-system-x86_64-headless.exe /F /T',
        { timeout: 10000, windowsHide: true, stdio: 'ignore' });
      log('QEMU matado por nombre (fallback)');
    }
  } catch {}

  emulatorState = 'stopped';
  log('Emulador detenido OK');
  sendTelegram('🔌 Emulador Android apagado (servicio-emulador)');
  return true;
}

// --- Cola y coalescencia ---

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

/**
 * Coalescencia last-write-wins: lee todos los mensajes pendientes,
 * ordena por timestamp, y solo ejecuta el último. Los anteriores se descartan.
 */
function coalesce(pendingFiles) {
  if (pendingFiles.length === 0) return null;

  // Leer y parsear todos los mensajes
  const messages = [];
  for (const file of pendingFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      messages.push({ file, data, timestamp: data.timestamp || 0 });
    } catch (e) {
      log(`Error leyendo ${file.name}: ${e.message}`);
      // Mover archivos corruptos a listo/ para no bloquear la cola
      try { fs.renameSync(file.path, path.join(LISTO, file.name)); } catch {}
    }
  }

  if (messages.length === 0) return null;

  // Ordenar por timestamp (el último gana)
  messages.sort((a, b) => a.timestamp - b.timestamp);
  const winner = messages[messages.length - 1];

  // Mover todos a listo/ (descartados + ganador)
  for (const msg of messages) {
    try {
      fs.renameSync(msg.file.path, path.join(LISTO, msg.file.name));
    } catch {} // otro proceso podría haberlo movido
  }

  if (messages.length > 1) {
    log(`Coalescencia: ${messages.length} mensajes → last-write-wins: ${winner.data.action} (de ${winner.data.requester || 'unknown'})`);
  }

  return winner.data;
}

// --- Procesamiento principal ---

async function processQueue() {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  // Mover todos a trabajando/ atómicamente
  const movedFiles = [];
  for (const file of files) {
    try {
      const dest = path.join(TRABAJANDO, file.name);
      fs.renameSync(file.path, dest);
      movedFiles.push({ name: file.name, path: dest });
    } catch {} // otro proceso lo tomó
  }

  if (movedFiles.length === 0) return;

  // Coalescer desde trabajando/
  const action = coalesce(movedFiles);
  if (!action) return;

  const actionType = action.action;
  const requester = action.requester || 'unknown';
  const issue = action.issue || '-';

  log(`Procesando: action=${actionType}, requester=${requester}, issue=#${issue}`);

  // Deduplicar contra estado actual
  if (actionType === 'start' && emulatorState === 'running') {
    log(`No-op: emulador ya está running (pedido por ${requester})`);
    return;
  }
  if (actionType === 'stop' && emulatorState === 'stopped') {
    log(`No-op: emulador ya está stopped (pedido por ${requester})`);
    return;
  }

  // Ejecutar
  if (actionType === 'start') {
    doStart();
  } else if (actionType === 'stop') {
    doStop();
  } else {
    log(`Acción desconocida: ${actionType}`);
  }
}

// --- Main loop ---

async function main() {
  // Asegurar directorios existen
  for (const dir of [PENDIENTE, TRABAJANDO, LISTO]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // CA-1 (#2322): healthcheck de zombi al arrancar, ANTES de detectar estado.
  // Si el state file tiene un PID zombi (proceso muerto + ADB vacío + sin
  // QEMU), lo limpiamos de forma atómica para que detectEmulatorState() no
  // devuelva 'running' basándose en un PID fantasma.
  cleanupZombieIfNeeded('startup');

  // Sincronizar estado real al arrancar
  emulatorState = detectEmulatorState();
  log(`Servicio Emulador iniciado — estado actual: ${emulatorState}`);

  // Limpiar trabajando/ huérfano al arrancar (crash recovery)
  const orphaned = listWorkFiles(TRABAJANDO);
  if (orphaned.length > 0) {
    log(`Recuperando ${orphaned.length} mensajes huérfanos de trabajando/ → pendiente/`);
    for (const file of orphaned) {
      try { fs.renameSync(file.path, path.join(PENDIENTE, file.name)); } catch {}
    }
  }

  let pollCount = 0;
  while (true) {
    try {
      await processQueue();
    } catch (e) {
      log(`Error en processQueue: ${e.message}`);
    }

    // CA-3 (#2322): healthcheck periódico de zombi durante runtime.
    // Idempotente: si el estado es consistente, no hace nada.
    pollCount++;
    if (pollCount % ZOMBIE_HEALTHCHECK_EVERY_N_POLLS === 0) {
      try { cleanupZombieIfNeeded('runtime'); } catch (e) {
        log(`Error en cleanupZombieIfNeeded: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// --- Crash handlers ---

process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [svc-emulador] CRASH uncaughtException: ${err.stack || err.message}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-emulador.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] [svc-emulador] CRASH unhandledRejection: ${reason?.stack || reason}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-emulador.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

// --- SINGLETON ---
require('./singleton')('svc-emulador');
main();

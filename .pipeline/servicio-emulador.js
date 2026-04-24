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

// Saneado global de JAVA_HOME — propaga un JDK válido a qa-environment y a
// los builds QA que corren contra el emulador. Incidente 2026-04-21.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});

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

// --- Acciones ---

function doStart() {
  emulatorState = 'starting';
  log('Levantando emulador Android via qa-environment.js...');
  try {
    execSync(`node "${QA_ENV_SCRIPT}" start`, {
      cwd: ROOT, encoding: 'utf8', timeout: BOOT_TIMEOUT, windowsHide: true
    });
    emulatorState = 'running';
    log('Emulador levantado OK');
    sendTelegram('🧪 Emulador Android levantado (servicio-emulador)');
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
  // Sincronizar estado real al arrancar
  emulatorState = detectEmulatorState();
  log(`Servicio Emulador iniciado — estado actual: ${emulatorState}`);

  // Asegurar directorios existen
  for (const dir of [PENDIENTE, TRABAJANDO, LISTO]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Limpiar trabajando/ huérfano al arrancar (crash recovery)
  const orphaned = listWorkFiles(TRABAJANDO);
  if (orphaned.length > 0) {
    log(`Recuperando ${orphaned.length} mensajes huérfanos de trabajando/ → pendiente/`);
    for (const file of orphaned) {
      try { fs.renameSync(file.path, path.join(PENDIENTE, file.name)); } catch {}
    }
  }

  // Heartbeat mantiene el marker fresh (issue #2450).
  try { require('./lib/ready-marker').startHeartbeat('svc-emulador'); } catch {}

  while (true) {
    try {
      await processQueue();
    } catch (e) {
      log(`Error en processQueue: ${e.message}`);
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

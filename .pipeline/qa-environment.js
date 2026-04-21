#!/usr/bin/env node
// =============================================================================
// QA Environment Manager — Levanta y mantiene emulador Android para QA
// Backend y DynamoDB son REMOTOS (Lambda AWS) — no se levantan localmente.
// Se ejecuta UNA VEZ y el emulador queda corriendo.
//
// Uso:
//   node .pipeline/qa-environment.js start   → levantar todo
//   node .pipeline/qa-environment.js stop    → bajar todo
//   node .pipeline/qa-environment.js status  → verificar estado
// =============================================================================

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Saneado global de JAVA_HOME — qa-environment se ejecuta standalone y como
// hijo de svc-emulador; en ambos casos hay que asegurar JDK válido para los
// scripts de QA Android que disparan gradle. Incidente 2026-04-21.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(PIPELINE, '..');
const STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');

const ADB = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const EMULATOR = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe';

// Snapshot conocido-bueno (docs/qa/android-emulator, memoria android-emulator.md).
// Usamos -snapshot + -no-snapshot-save para arrancar desde un estado estable
// y NO reescribir el quickboot en cada stop (los ciclos rápidos lo corrompían).
const EMULATOR_ARGS = [
  '-avd', 'virtualAndroid',
  '-no-window', '-no-audio',
  '-gpu', 'swiftshader_indirect',
  '-snapshot', 'qa-ready',
  '-no-snapshot-save',
];

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

// Timeouts del gating de boot
const BOOT_TIMEOUT_MS = 180000;  // 3 minutos de margen total para boot
const BOOT_POLL_MS = 1000;       // poll cada segundo

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] [qa-env] ${msg}`);
}

// Sleep sincrónico portable a Windows (no usa el comando shell `sleep`,
// que no existe en cmd.exe — ver pulpo.js:2067 para el patrón).
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Fallback si SharedArrayBuffer no está disponible
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// Espera que el framework de Android esté REALMENTE listo:
//   1. adbd escuchando (wait-for-device)
//   2. sys.boot_completed == 1
//   3. init.svc.bootanim == stopped
//   4. el service manager tiene `settings` (evita race con `settings put`)
// En laboratorio (fresh boot desde snapshot) esto tarda ~13-30s.
function waitBootCompleted(timeoutMs = BOOT_TIMEOUT_MS) {
  const t0 = Date.now();
  execSync(`"${ADB}" wait-for-device`, { timeout: timeoutMs, windowsHide: true });

  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const bc = execSync(`"${ADB}" shell getprop sys.boot_completed`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      const anim = execSync(`"${ADB}" shell getprop init.svc.bootanim`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      if (bc === '1' && anim === 'stopped') {
        const svc = execSync(`"${ADB}" shell service check settings`,
          { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (svc.includes('found')) {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          log(`  Boot completo confirmado en ${elapsed}s (boot_completed=1, bootanim=stopped, service settings=found)`);
          return true;
        }
      }
    } catch { /* retry */ }
    sleepSync(BOOT_POLL_MS);
  }
  throw new Error(`Boot del emulador no completado dentro de ${Math.round(timeoutMs/1000)}s`);
}

// Devuelve el PID real del proceso QEMU del emulador (o null si no corre).
// Lo usamos después del boot para reemplazar el PID del wrapper emulator.exe
// por el del worker real de QEMU, que es el que persiste.
function detectQemuPid() {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    // Formato CSV: "qemu-system-x86_64-headless.exe","1234","Console","1","234,567 KB"
    // Campo [0] = imagen, [1] = PID, [2] = session, [3] = session#, [4] = mem.
    const line = out.split('\n').find(l => l.toLowerCase().includes('qemu-system'));
    if (!line) return null;
    const fields = line.match(/"([^"]*)"/g);
    if (fields && fields.length >= 2) {
      const pid = parseInt(fields[1].replace(/"/g, ''), 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch { /* fallthrough */ }
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { emulator: null }; }
}

function isAlive(pid) {
  const safePid = sanitizePid(pid);
  if (!safePid) return false;
  try {
    const r = execSync(`tasklist /FI "PID eq ${safePid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.includes(`"${safePid}"`);
  } catch { return false; }
}

// --- START ---

function startAll() {
  const state = loadState();

  // Backend y DynamoDB son remotos (Lambda AWS) — no se levantan localmente

  // Emulador Android (único componente local)
  if (!isAlive(state.emulator)) {
    log('Levantando emulador Android (virtualAndroid, snapshot qa-ready)...');
    const emu = spawn(EMULATOR, EMULATOR_ARGS, {
      stdio: 'ignore', detached: true, windowsHide: true
    });
    emu.unref();
    log(`  Wrapper PID: ${emu.pid} — esperando boot completo...`);

    // Gating REAL: esperar a que el framework esté listo antes de terminar.
    // Si esto falla, el catch re-lanza para que el servicio lo sepa.
    try {
      waitBootCompleted();
      execSync(`"${ADB}" shell settings put global window_animation_scale 0`, { windowsHide: true });
      execSync(`"${ADB}" shell settings put global transition_animation_scale 0`, { windowsHide: true });
      execSync(`"${ADB}" shell settings put global animator_duration_scale 0`, { windowsHide: true });
      log('  Animaciones desactivadas');
    } catch (e) {
      log(`  Error esperando boot del emulador: ${e.message}`);
      throw e; // propagar al servicio emulador
    }

    // Tras boot completo, persistir el PID REAL del worker QEMU
    // (el wrapper emulator.exe puede terminar después del spawn).
    const qemuPid = detectQemuPid();
    state.emulator = qemuPid || emu.pid;
    // Anchor del grace period post-boot (leído por pulpo.shutdownIdleEmulator)
    state.lastStartedAt = Date.now();
    log(`  Emulador PID real (QEMU): ${state.emulator}`);
  } else {
    log(`Emulador ya corriendo (PID ${state.emulator})`);
  }

  saveState(state);
  log('QA Environment listo');
}

// --- STOP ---

function stopAll() {
  const state = loadState();

  for (const [name, rawPid] of Object.entries(state)) {
    const pid = sanitizePid(rawPid);
    if (pid && isAlive(pid)) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        log(`Stopped ${name} (PID ${pid})`);
      } catch {}
    }
  }

  // Fallback: matar QEMU por nombre si quedó huérfano (state.emulator stale,
  // wrapper muerto pero QEMU vivo, etc). Mismo patrón que servicio-emulador.doStop.
  try {
    const check = execSync(
      'tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    if (check.includes('qemu-system')) {
      execSync('taskkill /IM qemu-system-x86_64-headless.exe /F /T',
        { timeout: 10000, windowsHide: true, stdio: 'ignore' });
      log('QEMU matado por nombre (fallback)');
    }
  } catch { /* no qemu running — ok */ }

  saveState({ emulator: null, lastStartedAt: 0 });
  log('QA Environment detenido');
}

// --- STATUS ---

function status() {
  const state = loadState();

  log('=== QA Environment Status ===');
  for (const [name, pid] of Object.entries(state)) {
    const alive = isAlive(pid);
    log(`  ${alive ? '✓' : '✗'} ${name}: ${pid ? `PID ${pid}` : 'no iniciado'} ${alive ? '(corriendo)' : '(muerto)'}`);
  }

  // Backend y DynamoDB son remotos (Lambda AWS) — no se verifican puertos locales

  // Verificar emulador via adb
  try {
    const devices = execSync(`"${ADB}" devices`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const connected = devices.includes('emulator') || devices.includes('device');
    log(`  ADB devices: ${connected ? '✓ conectado' : '✗ sin dispositivos'}`);
  } catch {
    log('  ADB: ✗ no disponible');
  }
}

// --- Individual component control ---

function startOne(component) {
  const state = loadState();

  if (component === 'dynamo' || component === 'backend') {
    log(`${component} es remoto (Lambda AWS) — no se levanta localmente`);
    return;
  }

  if (component === 'emulator' && !isAlive(state.emulator)) {
    log('Levantando emulador Android (virtualAndroid, snapshot qa-ready)...');
    const emu = spawn(EMULATOR, EMULATOR_ARGS, {
      stdio: 'ignore', detached: true, windowsHide: true
    });
    emu.unref();
    log(`  Wrapper PID: ${emu.pid} — esperando boot completo...`);
    try {
      waitBootCompleted();
      execSync(`"${ADB}" shell settings put global window_animation_scale 0`, { windowsHide: true });
      execSync(`"${ADB}" shell settings put global transition_animation_scale 0`, { windowsHide: true });
      execSync(`"${ADB}" shell settings put global animator_duration_scale 0`, { windowsHide: true });
      log('  Animaciones desactivadas');
    } catch (e) {
      log(`  Error esperando boot del emulador: ${e.message}`);
      throw e;
    }
    const qemuPid = detectQemuPid();
    state.emulator = qemuPid || emu.pid;
    state.lastStartedAt = Date.now();
    log(`  Emulador PID real (QEMU): ${state.emulator}`);
  } else {
    log(`${component} ya corriendo o no reconocido`);
  }
  saveState(state);
}

function stopOne(component) {
  const state = loadState();
  const pid = sanitizePid(state[component]);
  if (pid && isAlive(pid)) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      log(`Stopped ${component} (PID ${pid})`);
    } catch {}
  }
  state[component] = null;
  saveState(state);
}

// --- MAIN ---

const action = process.argv[2] || 'status';
const target = process.argv[3]; // optional: 'emulator' (dynamo/backend are remote)
if (target && ['dynamo', 'backend', 'emulator'].includes(target)) {
  if (action === 'start') startOne(target);
  else if (action === 'stop') stopOne(target);
  else status();
} else {
  switch (action) {
    case 'start': startAll(); break;
    case 'stop': stopAll(); break;
    default: status();
  }
}

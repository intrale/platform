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

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(PIPELINE, '..');
const STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');

const ADB = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const EMULATOR = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe';

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] [qa-env] ${msg}`);
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { emulator: null }; }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    const r = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.includes(`"${pid}"`);
  } catch { return false; }
}

// --- START ---

function startAll() {
  const state = loadState();

  // Backend y DynamoDB son remotos (Lambda AWS) — no se levantan localmente

  // Emulador Android (único componente local)
  if (!isAlive(state.emulator)) {
    log('Levantando emulador Android (virtualAndroid)...');
    const emu = spawn(EMULATOR, [
      '-avd', 'virtualAndroid', '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'
    ], {
      stdio: 'ignore', detached: true, windowsHide: true
    });
    emu.unref();
    state.emulator = emu.pid;
    log(`  Emulador PID: ${emu.pid}`);

    // Desactivar animaciones después de boot (~60s)
    log('  Esperando boot del emulador (60s)...');
    setTimeout(() => {
      try {
        execSync(`"${ADB}" wait-for-device`, { timeout: 120000, windowsHide: true });
        execSync(`"${ADB}" shell settings put global window_animation_scale 0`, { windowsHide: true });
        execSync(`"${ADB}" shell settings put global transition_animation_scale 0`, { windowsHide: true });
        execSync(`"${ADB}" shell settings put global animator_duration_scale 0`, { windowsHide: true });
        log('  Animaciones desactivadas');
      } catch (e) {
        log(`  Error configurando emulador: ${e.message}`);
      }
    }, 5000); // adb wait-for-device maneja el timing
  } else {
    log(`Emulador ya corriendo (PID ${state.emulator})`);
  }

  saveState(state);
  log('QA Environment listo');
}

// --- STOP ---

function stopAll() {
  const state = loadState();

  for (const [name, pid] of Object.entries(state)) {
    if (pid && isAlive(pid)) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        log(`Stopped ${name} (PID ${pid})`);
      } catch {}
    }
  }

  saveState({ emulator: null });
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
    log('Levantando emulador Android (virtualAndroid)...');
    const emu = spawn(EMULATOR, [
      '-avd', 'virtualAndroid', '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'
    ], { stdio: 'ignore', detached: true, windowsHide: true });
    emu.unref();
    state.emulator = emu.pid;
    log(`  Emulador PID: ${emu.pid}`);
    setTimeout(() => {
      try {
        execSync(`"${ADB}" wait-for-device`, { timeout: 120000, windowsHide: true });
        execSync(`"${ADB}" shell settings put global window_animation_scale 0`, { windowsHide: true });
        execSync(`"${ADB}" shell settings put global transition_animation_scale 0`, { windowsHide: true });
        execSync(`"${ADB}" shell settings put global animator_duration_scale 0`, { windowsHide: true });
        log('  Animaciones desactivadas');
      } catch (e) { log(`  Error configurando emulador: ${e.message}`); }
    }, 5000);
  } else {
    log(`${component} ya corriendo o no reconocido`);
  }
  saveState(state);
}

function stopOne(component) {
  const state = loadState();
  const pid = state[component];
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

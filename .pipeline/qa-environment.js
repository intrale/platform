#!/usr/bin/env node
// =============================================================================
// QA Environment Manager — Levanta y mantiene emulador + backend para QA
// Se ejecuta UNA VEZ y los servicios quedan corriendo.
// El agente QA los usa sin levantarlos ni bajarlos.
//
// Uso:
//   node .pipeline/qa-environment.js start   → levantar todo
//   node .pipeline/qa-environment.js stop    → bajar todo
//   node .pipeline/qa-environment.js status  → verificar estado
// =============================================================================

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');
const STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');

const JAVA_HOME = 'C:\\Users\\Administrator\\.jdks\\temurin-21.0.7';
const ADB = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const EMULATOR = 'C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe';
const DYNAMO_JAR = 'C:\\Users\\Administrator\\.dynamodb\\DynamoDBLocal.jar';

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] [qa-env] ${msg}`);
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { dynamo: null, backend: null, emulator: null }; }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    const r = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.includes(`"${pid}"`);
  } catch { return false; }
}

function checkPort(port) {
  try {
    execSync(`netstat -an | findstr ":${port} "`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

// --- START ---

function startAll() {
  const state = loadState();
  const env = { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}\\bin;${process.env.PATH}` };

  // 1. DynamoDB Local
  if (!isAlive(state.dynamo)) {
    log('Levantando DynamoDB Local en :8000...');
    const dynamo = spawn('java', [
      '-Djava.library.path=DynamoDBLocal_lib',
      '-jar', 'DynamoDBLocal.jar', '-sharedDb', '-port', '8000'
    ], {
      cwd: path.dirname(DYNAMO_JAR),
      stdio: 'ignore', detached: true, windowsHide: true, env
    });
    dynamo.unref();
    state.dynamo = dynamo.pid;
    log(`  DynamoDB PID: ${dynamo.pid}`);
  } else {
    log(`DynamoDB ya corriendo (PID ${state.dynamo})`);
  }

  // 2. Backend (:users:run)
  if (!isAlive(state.backend)) {
    log('Levantando backend :users:run en :80...');
    const backend = spawn(path.join(ROOT, 'gradlew.bat'), [':users:run'], {
      cwd: ROOT,
      stdio: 'ignore', detached: true, windowsHide: true, env
    });
    backend.unref();
    state.backend = backend.pid;
    log(`  Backend PID: ${backend.pid}`);
  } else {
    log(`Backend ya corriendo (PID ${state.backend})`);
  }

  // 3. Emulador Android
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

  saveState({ dynamo: null, backend: null, emulator: null });
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

  // Verificar puertos
  log(`  Puerto 8000 (DynamoDB): ${checkPort(8000) ? '✓ escuchando' : '✗ libre'}`);
  log(`  Puerto 80 (Backend): ${checkPort(80) ? '✓ escuchando' : '✗ libre'}`);

  // Verificar emulador via adb
  try {
    const devices = execSync(`"${ADB}" devices`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const connected = devices.includes('emulator') || devices.includes('device');
    log(`  ADB devices: ${connected ? '✓ conectado' : '✗ sin dispositivos'}`);
  } catch {
    log('  ADB: ✗ no disponible');
  }
}

// --- MAIN ---

const action = process.argv[2] || 'status';
switch (action) {
  case 'start': startAll(); break;
  case 'stop': stopAll(); break;
  default: status();
}

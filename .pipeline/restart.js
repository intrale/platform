#!/usr/bin/env node
// restart.js — Reinicio drástico y seguro del pipeline V2
//
// Estrategia: sincronizar con main, matar TODOS los node.exe del pipeline,
// limpiar PID files, y relanzar. El pipeline es idempotente —
// el estado vive en el filesystem, no en memoria.
//
// Uso:
//   node .pipeline/restart.js              → sync + kill all + relaunch
//   node .pipeline/restart.js --paused     → relaunch solo Telegram + dashboard (sin procesar issues)
//   node .pipeline/restart.js stop         → kill all
//   node .pipeline/restart.js status       → verificar estado

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');

const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
  { name: 'svc-emulador', script: 'servicio-emulador.js', pid: 'svc-emulador.pid' },
  { name: 'dashboard', script: 'dashboard-v2.js', pid: 'dashboard.pid' },
];

const SCRIPT_NAMES = COMPONENTS.map(c => c.script);

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`);
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
}

// --- SYNC: actualizar repo principal con main ---

function syncWithMain() {
  try {
    execSync('git fetch origin main', { cwd: ROOT, timeout: 30000, windowsHide: true });
    execSync('git reset --hard FETCH_HEAD', { cwd: ROOT, timeout: 15000, windowsHide: true, encoding: 'utf8' });
    log('Sincronizado con origin/main');
  } catch (e) {
    log(`Warning: no se pudo sincronizar con main: ${e.message.slice(0, 100)}`);
  }
}

// --- KILL: drástico — matar todo lo que sea del pipeline ---

function killAll() {
  log('=== STOP ===');

  // Obtener TODOS los PIDs de node.exe que corren scripts del pipeline
  const pidsToKill = new Set();

  try {
    const output = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', timeout: 10000 }
    );
    for (const line of output.split('\n')) {
      if (!line.includes('.pipeline')) continue;
      const match = line.match(/(\d+)\s*$/);
      if (!match) continue;
      const pid = parseInt(match[1]);
      if (pid === process.pid) continue;
      pidsToKill.add(pid);
    }
  } catch (e) {
    log(`  Error listando procesos: ${e.message}`);
  }

  // También agregar PIDs de los archivos .pid
  for (const comp of COMPONENTS) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(PIPELINE, comp.pid), 'utf8').trim());
      if (pid && pid !== process.pid) pidsToKill.add(pid);
    } catch {}
  }

  if (pidsToKill.size === 0) {
    log('  No hay procesos del pipeline corriendo');
  } else {
    for (const pid of pidsToKill) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, stdio: 'ignore' });
        log(`  Killed PID ${pid}`);
      } catch {}
    }
    log(`  ${pidsToKill.size} proceso(s) eliminado(s)`);
  }

  // Limpiar PID files
  for (const comp of COMPONENTS) {
    try { fs.unlinkSync(path.join(PIPELINE, comp.pid)); } catch {}
  }

  // Mover archivos de trabajando/ Y pendiente/ a listo/ en commander
  // IMPORTANTE: limpiar AMBAS colas — si hay un mensaje de restart pendiente
  // y el usuario ya hizo restart manual, el mensaje se re-procesaría
  // provocando un segundo restart que mata el dashboard recién levantado
  const cmdPendiente = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
  const cmdTrabajando = path.join(PIPELINE, 'servicios', 'commander', 'trabajando');
  const cmdListo = path.join(PIPELINE, 'servicios', 'commander', 'listo');
  try {
    if (!fs.existsSync(cmdListo)) fs.mkdirSync(cmdListo, { recursive: true });
    for (const dir of [cmdTrabajando, cmdPendiente]) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) {
          fs.renameSync(path.join(dir, f), path.join(cmdListo, f));
          const src = dir === cmdPendiente ? 'pendiente' : 'trabajando';
          log(`  Completado: commander/${src}/${f} → listo/`);
        }
      }
    }
  } catch {}

  // Escribir timestamp de último restart para evitar restarts encadenados
  try {
    fs.writeFileSync(
      path.join(PIPELINE, 'last-restart.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid })
    );
  } catch {}

  sleep(2000);

  // Verificar que no quede nada
  try {
    const check = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', timeout: 10000 }
    );
    const survivors = check.split('\n').filter(l => l.includes('.pipeline') && !l.includes('restart.js'));
    if (survivors.length > 0) {
      log('  Quedan procesos vivos — segundo intento:');
      for (const line of survivors) {
        const m = line.match(/(\d+)\s*$/);
        if (m) {
          try { execSync(`taskkill /PID ${m[1]} /F /T`, { timeout: 5000, stdio: 'ignore' }); } catch {}
          log(`    Force killed PID ${m[1]}`);
        }
      }
    }
  } catch {}
}

// --- LAUNCH ---

function launchAll() {
  log('=== START ===');

  const logsDir = path.join(PIPELINE, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  for (const comp of COMPONENTS) {
    const scriptPath = path.join(PIPELINE, comp.script);
    if (!fs.existsSync(scriptPath)) continue;

    const logPath = path.join(logsDir, `${comp.name}.log`);
    fs.writeFileSync(logPath, `--- restart ${new Date().toISOString()} ---\n`);
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }
    });
    child.unref();
    fs.closeSync(logFd);

    log(`  ${comp.name}: PID ${child.pid}`);
  }

  sleep(3000);
}

// --- STATUS ---

function status() {
  log('=== STATUS ===');
  let allOk = true;

  for (const comp of COMPONENTS) {
    if (!fs.existsSync(path.join(PIPELINE, comp.script))) continue;

    try {
      const pid = fs.readFileSync(path.join(PIPELINE, comp.pid), 'utf8').trim();
      const check = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 5000 });
      if (check.includes(`"${pid}"`)) {
        log(`  OK ${comp.name} (PID ${pid})`);
      } else {
        log(`  FAIL ${comp.name}`);
        allOk = false;
      }
    } catch {
      log(`  FAIL ${comp.name}`);
      allOk = false;
    }
  }
  return allOk;
}

// --- MAIN ---

const action = process.argv[2] || 'restart';
const flagPaused = process.argv.includes('--paused');

switch (action) {
  case 'stop':
    killAll();
    log('Pipeline detenido.');
    break;
  case 'status':
    status();
    break;
  default:
    killAll();
    syncWithMain();
    if (flagPaused) {
      fs.writeFileSync(path.join(PIPELINE, '.paused'), new Date().toISOString());
      log('Modo PAUSADO — solo Telegram + dashboard activos (intake/lanzamiento deshabilitados)');
    } else {
      try { fs.unlinkSync(path.join(PIPELINE, '.paused')); } catch {}
    }
    launchAll();
    const ok = status();
    log(ok ? '=== Pipeline V2 operativo ===' : '=== Revisar componentes ===');
}

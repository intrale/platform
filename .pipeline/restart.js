#!/usr/bin/env node
// restart.js — Reinicio seguro de todos los componentes del pipeline
// Mata TODOS los procesos del pipeline (por command line, no por PID) y relanza.
// Uso: node .pipeline/restart.js

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');

const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pidFile: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pidFile: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pidFile: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pidFile: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pidFile: 'svc-drive.pid' },
];

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// --- PASO 1: Matar todos los procesos del pipeline ---

function killAll() {
  log('=== Matando procesos del pipeline ===');

  try {
    const output = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', timeout: 10000 }
    );

    let killed = 0;
    for (const line of output.split('\n')) {
      if (!line.includes('.pipeline')) continue;
      const match = line.match(/(\d+)\s*$/);
      if (!match) continue;
      const pid = match[1];

      // No matarse a sí mismo
      if (parseInt(pid) === process.pid) continue;

      try {
        execSync(`taskkill /PID ${pid} /F`, { timeout: 5000, windowsHide: true });
        const script = COMPONENTS.find(c => line.includes(c.script));
        log(`  Killed ${script ? script.name : 'unknown'} (PID ${pid})`);
        killed++;
      } catch {}
    }

    if (killed === 0) log('  Ningún proceso del pipeline encontrado');
    else log(`  ${killed} proceso(s) eliminado(s)`);
  } catch (e) {
    log(`  Error listando procesos: ${e.message}`);
  }

  // Limpiar PID files
  for (const comp of COMPONENTS) {
    try { fs.unlinkSync(path.join(PIPELINE, comp.pidFile)); } catch {}
  }
}

// --- PASO 2: Lanzar todos los componentes ---

function launchAll() {
  log('=== Lanzando componentes ===');

  const launched = [];

  for (const comp of COMPONENTS) {
    const scriptPath = path.join(PIPELINE, comp.script);
    if (!fs.existsSync(scriptPath)) {
      log(`  SKIP ${comp.name} — ${comp.script} no existe`);
      continue;
    }

    const logFile = path.join(PIPELINE, 'logs', `${comp.name}.log`);
    const logFd = fs.openSync(logFile, 'a');

    const child = spawn('node', [scriptPath], {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true
    });
    child.unref();

    launched.push({ name: comp.name, pid: child.pid, pidFile: comp.pidFile });
    log(`  ${comp.name}: PID ${child.pid} → ${comp.script}`);

    fs.closeSync(logFd);
  }

  return launched;
}

// --- PASO 3: Verificar que todos arrancaron ---

function verify() {
  log('=== Verificando ===');

  // Esperar 3 segundos
  const { spawnSync: sleepSync } = require('child_process');
  sleepSync('node', ['-e', 'setTimeout(()=>{},3000)'], { timeout: 5000 });

  let allOk = true;
  for (const comp of COMPONENTS) {
    const pidPath = path.join(PIPELINE, comp.pidFile);
    try {
      const pid = fs.readFileSync(pidPath, 'utf8').trim();
      const check = execSync(
        `tasklist /FI "PID eq ${pid}" /NH /FO CSV`,
        { encoding: 'utf8', timeout: 5000 }
      );
      if (check.includes(`"${pid}"`)) {
        log(`  ✓ ${comp.name} (PID ${pid})`);
      } else {
        log(`  ✗ ${comp.name} — proceso muerto`);
        allOk = false;
      }
    } catch {
      if (!fs.existsSync(path.join(PIPELINE, comp.script))) {
        log(`  - ${comp.name} (no existe)`);
      } else {
        log(`  ✗ ${comp.name} — sin PID file`);
        allOk = false;
      }
    }
  }

  return allOk;
}

// --- Main ---

const action = process.argv[2] || 'restart';

if (action === 'stop') {
  killAll();
  log('Pipeline detenido.');
} else if (action === 'status') {
  verify();
} else {
  killAll();

  // Pequeña pausa para que los procesos terminen
  const { spawnSync: sleepSync2 } = require('child_process');
  sleepSync2('node', ['-e', 'setTimeout(()=>{},2000)'], { timeout: 5000 });

  launchAll();
  const ok = verify();

  if (ok) {
    log('=== Pipeline V2 operativo ===');
  } else {
    log('=== ADVERTENCIA: algunos componentes no arrancaron ===');
  }
}

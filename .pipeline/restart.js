#!/usr/bin/env node
// restart.js — Reinicio drástico y seguro del pipeline V2
//
// Estrategia: matar TODOS los node.exe del pipeline (por taskkill),
// limpiar PID files, y relanzar. El pipeline es idempotente —
// el estado vive en el filesystem, no en memoria.
//
// Uso:
//   node .pipeline/restart.js          → kill all + relaunch
//   node .pipeline/restart.js stop     → kill all
//   node .pipeline/restart.js status   → verificar estado

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');
const MAIN_ROOT = process.env.PIPELINE_MAIN_ROOT || 'C:\\Workspaces\\Intrale\\platform';


// --- Worktree ops: los scripts operativos SIEMPRE corren desde platform.ops (main) ---
const OPS_WORKTREE = path.resolve(ROOT, '..', 'platform.ops');
const OPS_PIPELINE = path.join(OPS_WORKTREE, '.pipeline');

function ensureOpsWorktree() {
  if (!fs.existsSync(OPS_WORKTREE)) {
    log('Creando worktree ops en origin/main...');
    try {
      execSync('git fetch origin main', { cwd: ROOT, timeout: 30000, windowsHide: true });
      execSync(`git worktree add "${OPS_WORKTREE}" origin/main`, { cwd: ROOT, timeout: 60000, windowsHide: true });
      log('Worktree ops creado OK');
    } catch (e) {
      log(`ERROR creando worktree ops: ${e.message}`);
      return false;
    }
  }
  try {
    execSync('git fetch origin main && git checkout FETCH_HEAD --force', {
      cwd: OPS_WORKTREE, timeout: 30000, windowsHide: true, encoding: 'utf8'
    });
    log('Worktree ops sincronizado con origin/main');
  } catch (e) {
    log(`Warning: no se pudo sincronizar ops: ${e.message.slice(0, 100)}`);
  }
  return true;
}
const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
  { name: 'dashboard', script: 'dashboard-v2.js', pid: 'dashboard.pid' },
];

const SCRIPT_NAMES = COMPONENTS.map(c => c.script);

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`);
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
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
      // Matar si tiene .pipeline/ en su command line
      if (!line.includes('.pipeline')) continue;
      // No matarse a sí mismo
      const match = line.match(/(\d+)\s*$/);
      if (!match) continue;
      const pid = parseInt(match[1]);
      if (pid === process.pid) continue;
      pidsToKill.add(pid);
    }
  } catch (e) {
    log(`  Error listando procesos: ${e.message}`);
  }

  // También agregar PIDs de los archivos .pid (por si wmic no los encontró)
  for (const comp of COMPONENTS) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(PIPELINE, comp.pid), 'utf8').trim());
      if (pid && pid !== process.pid) pidsToKill.add(pid);
    } catch {}
  }

  if (pidsToKill.size === 0) {
    log('  No hay procesos del pipeline corriendo');
  } else {
    // Matar todos de un solo golpe con taskkill /T (tree kill — mata hijos también)
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

  // Devolver archivos de trabajando/ a pendiente/ en commander (por si quedaron)
  const cmdTrabajando = path.join(PIPELINE, 'servicios', 'commander', 'trabajando');
  const cmdPendiente = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
  try {
    for (const f of fs.readdirSync(cmdTrabajando)) {
      if (f.endsWith('.json')) {
        fs.renameSync(path.join(cmdTrabajando, f), path.join(cmdPendiente, f));
        log(`  Recuperado: commander/${f} → pendiente/`);
      }
    }
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
      log('  ⚠️ Quedan procesos vivos — segundo intento:');
      for (const line of survivors) {
        const m = line.match(/(\d+)\s*$/);
        if (m) {
          execSync(`taskkill /PID ${m[1]} /F /T`, { timeout: 5000, stdio: 'ignore' }).catch(() => {});
          log(`    Force killed PID ${m[1]}`);
        }
      }
    }
  } catch {}
}

// --- LAUNCH ---

function launchAll() {
  log('=== START ===');

  const opsReady = ensureOpsWorktree();
  const activePipeline = opsReady ? OPS_PIPELINE : PIPELINE;
  const activeRoot = opsReady ? OPS_WORKTREE : ROOT;
  if (opsReady) log(`  Ejecutando desde worktree ops: ${OPS_WORKTREE}`);
  else log('  Fallback: directorio principal');
  const logsDir = path.join(PIPELINE, 'logs');

  for (const comp of COMPONENTS) {
    const scriptPath = path.join(activePipeline, comp.script);
    if (!fs.existsSync(scriptPath)) continue;

    const logPath = path.join(logsDir, `${comp.name}.log`);
    fs.writeFileSync(logPath, `--- restart ${new Date().toISOString()} ---\n`);
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(process.execPath, [scriptPath], {
      cwd: activeRoot,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true,
      env: { ...process.env, PIPELINE_STATE_DIR: PIPELINE, PIPELINE_MAIN_ROOT: MAIN_ROOT, NODE_PATH: path.join(MAIN_ROOT, "node_modules") }
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
        log(`  ✓ ${comp.name} (PID ${pid})`);
      } else {
        log(`  ✗ ${comp.name}`);
        allOk = false;
      }
    } catch {
      log(`  ✗ ${comp.name}`);
      allOk = false;
    }
  }
  return allOk;
}

// --- MAIN ---

const action = process.argv[2] || 'restart';

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
    launchAll();
    const ok = status();
    log(ok ? '=== Pipeline V2 operativo ===' : '=== ⚠️ Revisar componentes ===');
}

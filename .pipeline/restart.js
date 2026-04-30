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
const {
  scanNodeProcesses,
  findPidByComponent,
  findPidByPort,
  pidAlive,
  invalidateCache,
  SCRIPT_MAP,
} = require('./pid-discovery');
const { clearAllMarkers } = require('./lib/ready-marker');

// Saneado global de JAVA_HOME — si restart.js heredó una ruta stale (ej. JBR
// de IntelliJ obsoleto), la corregimos antes de spawnear pulpo/servicios, así
// todos los hijos reciben un JDK válido. Incidente 2026-04-21.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');

const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
  { name: 'svc-emulador', script: 'servicio-emulador.js', pid: 'svc-emulador.pid' },
  { name: 'svc-reconciler', script: 'servicio-reconciler.js', pid: 'svc-reconciler.pid' },
  { name: 'dashboard', script: 'dashboard.js', pid: 'dashboard.pid' },
];

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

  // Fuente de verdad: el SO. Descubrimos todos los node.exe del pipeline en
  // el momento vía pid-discovery.scanNodeProcesses() — NO leemos archivos
  // .pid (pueden estar desincronizados con la realidad del proceso).
  invalidateCache();
  const pidsToKill = new Set();

  // Procesos lanzados con `Start-Process -WorkingDirectory .pipeline` tienen
  // CommandLine = `node pulpo.js` sin `.pipeline` visible — el workdir no
  // aparece en la CommandLine. Por eso matcheamos por CUALQUIERA de: path
  // `.pipeline` en la CommandLine, o nombre de script conocido del pipeline.
  const scriptNames = new Set(Object.values(SCRIPT_MAP));
  for (const p of scanNodeProcesses()) {
    if (!p.commandLine) continue;
    if (p.pid === process.pid) continue;
    const cmd = p.commandLine;
    const matchByPath = cmd.includes('.pipeline');
    const matchByScript = [...scriptNames].some(s => cmd.includes(s));
    if (!matchByPath && !matchByScript) continue;
    pidsToKill.add(p.pid);
  }

  // Además, mata lo que escuche en el puerto del dashboard aunque su
  // commandLine no coincida (casos borde: proceso respawneado por watchdog
  // entre el scan y el kill).
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
  const dashOwner = findPidByPort(dashPort);
  if (dashOwner && dashOwner !== process.pid) pidsToKill.add(dashOwner);

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

  // Limpiar ready markers — cada componente debe reescribir el suyo
  // al completar su init tras el relaunch. Si no aparecen, el smoke
  // los reporta como "missing" (booting o crasheado).
  const cleared = clearAllMarkers();
  if (cleared > 0) log(`  ${cleared} ready marker(s) limpiados`);

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

  // Devolver agentes huérfanos de desarrollo/<fase>/trabajando/ y
  // definicion/<fase>/trabajando/ a pendiente/. Al matar todos los procesos
  // los archivos de agentes que estaban corriendo quedan en trabajando/ sin
  // dueño; sin esta limpieza, el mecanismo [huerfanos] del Pulpo tarda hasta
  // `orphan_timeout_minutes` (10min default) en moverlos — dejando el
  // dashboard mostrando "activos" agentes que ya no existen.
  // Formato de archivo de agente: `<issueId>.<skill>` (ej. 1915.qa, 2441.guru).
  // Filtramos `.gitkeep` y cualquier otro archivo sin ese patrón.
  const agenteFileRegex = /^\d+\.[a-z][a-z0-9-]*$/;
  let orphansMoved = 0;
  for (const pipeline of ['desarrollo', 'definicion']) {
    const pipeDir = path.join(PIPELINE, pipeline);
    if (!fs.existsSync(pipeDir)) continue;
    for (const fase of fs.readdirSync(pipeDir)) {
      const trabajando = path.join(pipeDir, fase, 'trabajando');
      const pendiente = path.join(pipeDir, fase, 'pendiente');
      if (!fs.existsSync(trabajando)) continue;
      try {
        if (!fs.existsSync(pendiente)) fs.mkdirSync(pendiente, { recursive: true });
        for (const f of fs.readdirSync(trabajando)) {
          if (!agenteFileRegex.test(f)) continue;
          fs.renameSync(path.join(trabajando, f), path.join(pendiente, f));
          orphansMoved++;
        }
      } catch {}
    }
  }
  if (orphansMoved > 0) log(`  ${orphansMoved} agente(s) huérfano(s) de fases → pendiente/`);

  // Escribir timestamp de último restart para evitar restarts encadenados
  try {
    fs.writeFileSync(
      path.join(PIPELINE, 'last-restart.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid })
    );
  } catch {}

  sleep(2000);

  // Verificar que no quede nada (discovery fresco, no cache).
  invalidateCache();
  const survivors = scanNodeProcesses().filter(p =>
    p.commandLine && p.commandLine.includes('.pipeline') &&
    !p.commandLine.includes('restart.js') &&
    p.pid !== process.pid
  );
  if (survivors.length > 0) {
    log('  Quedan procesos vivos — segundo intento:');
    for (const p of survivors) {
      try { execSync(`taskkill /PID ${p.pid} /F /T`, { timeout: 5000, stdio: 'ignore' }); } catch {}
      log(`    Force killed PID ${p.pid}`);
    }
  }
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

// --- SMOKE TEST + TAG pipeline-stable + AUTO-ROLLBACK ---

function runSmokeTest() {
  const script = path.join(PIPELINE, 'smoke-test.js');
  if (!fs.existsSync(script)) {
    log('Smoke test ausente, se omite');
    return { ok: true, skipped: true };
  }

  log('=== SMOKE TEST ===');
  try {
    // smoke-test.js es Node puro: lee ready markers + chequea HTTP en
    // :3200. No usa wmic ni bash. Timeout holgado (90s) porque el smoke
    // internamente hace polling hasta 60s a que los 7 componentes
    // escriban sus markers.
    const result = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      timeout: 90000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const exitCode = result.status === null ? -1 : result.status;
    if (exitCode === 0) {
      log('Smoke test OK');
      return { ok: true, exitCode, output };
    }
    log(`Smoke test FAIL (exit ${exitCode}, signal=${result.signal || 'none'})`);
    if (output) log(output.split('\n').slice(-12).join('\n'));
    return { ok: false, exitCode, output };
  } catch (e) {
    log(`Smoke test error: ${e.message}`);
    return { ok: false, exitCode: -1, output: e.message };
  }
}

function moveStableTag() {
  try {
    execSync('git tag -f pipeline-stable HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true });
    try {
      execSync('git push origin --force pipeline-stable', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'ignore' });
      log('Tag pipeline-stable movido y pusheado');
    } catch (e) {
      log(`Tag movido local, push falló: ${e.message.slice(0, 100)}`);
    }
  } catch (e) {
    log(`No se pudo mover tag pipeline-stable: ${e.message.slice(0, 100)}`);
  }
}

function stablePointsToHead() {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
    const stable = execSync('git rev-parse pipeline-stable', { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
    return head === stable;
  } catch {
    return false;
  }
}

function hasStableTag() {
  try {
    execSync('git rev-parse --verify pipeline-stable', { cwd: ROOT, timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function enqueueTelegramAlert(text) {
  const msg = text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  const svcDir = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');
  try {
    if (!fs.existsSync(svcDir)) fs.mkdirSync(svcDir, { recursive: true });
    const filename = `${Date.now()}-restart-alert.json`;
    fs.writeFileSync(path.join(svcDir, filename), JSON.stringify({ text: msg, parse_mode: 'Markdown' }));
    log(`Alerta Telegram encolada (${msg.length} chars)`);
  } catch (e) {
    log(`No se pudo encolar alerta Telegram: ${e.message}`);
  }
}

function launchRollbackOrphan() {
  // Estrategia detached-orphan: el rollback corre independiente de restart.js.
  // Problema anterior: cuando rollback.sh hacía `taskkill /T` sobre procesos
  // del pipeline, se comía a restart.js (su parent) y moría mid-ejecución.
  //
  // Solución: restart.js spawnea rollback.js con detached+stdio:ignore+unref,
  // sale de inmediato, y el rollback orphan es libre de matar lo que
  // quiera — nuestro proceso ya no existe. No hay loop de self-kill.
  log('=== AUTO-ROLLBACK (orphan detached) ===');
  const script = path.join(PIPELINE, 'rollback.js');
  if (!fs.existsSync(script)) {
    log('rollback.js ausente — no se puede ejecutar rollback');
    return false;
  }

  const logsDir = path.join(PIPELINE, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, 'rollback.log');
  const logFd = fs.openSync(logPath, 'a');
  try { fs.writeSync(logFd, `\n--- orphan rollback launch ${new Date().toISOString()} ---\n`); } catch {}

  const child = spawn(process.execPath, [script, 'pipeline-stable'], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    detached: true,
    windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
  });
  child.unref();
  fs.closeSync(logFd);

  log(`  Rollback lanzado como orphan PID ${child.pid}`);
  log(`  Seguir progreso: tail -f .pipeline/logs/rollback.log`);
  return true;
}

// --- STATUS ---

function status() {
  log('=== STATUS ===');
  let allOk = true;

  invalidateCache();
  for (const comp of COMPONENTS) {
    if (!fs.existsSync(path.join(PIPELINE, comp.script))) continue;

    // Descubrir PID al vuelo — el SO es la fuente de verdad.
    const found = findPidByComponent(comp.name);
    if (found && pidAlive(found.pid)) {
      log(`  OK ${comp.name} (PID ${found.pid})`);
    } else {
      log(`  FAIL ${comp.name}`);
      allOk = false;
    }
  }

  // Sanity extra: el dashboard debe tener el puerto 3200.
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
  const dashOwner = findPidByPort(dashPort);
  if (dashOwner) log(`  puerto ${dashPort} → PID ${dashOwner}`);

  return allOk;
}

// --- MAIN ---

const action = process.argv[2] || 'restart';
const flagPaused = process.argv.includes('--paused');
const flagNoSmokeTest = process.argv.includes('--no-smoke-test');
const flagNoRollback = process.argv.includes('--no-rollback');
const flagNoSync = process.argv.includes('--no-sync');

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
    if (!flagNoSync) syncWithMain();
    else log('Saltando sync con origin/main (--no-sync)');
    if (flagPaused) {
      fs.writeFileSync(path.join(PIPELINE, '.paused'), new Date().toISOString());
      log('Modo PAUSADO — solo Telegram + dashboard activos (intake/lanzamiento deshabilitados)');
    } else {
      try { fs.unlinkSync(path.join(PIPELINE, '.paused')); } catch {}
    }
    launchAll();
    const ok = status();
    log(ok ? '=== Pipeline V2 operativo ===' : '=== Revisar componentes ===');

    // Smoke test + tag pipeline-stable + auto-rollback
    // Se omite si --no-smoke-test (caso típico: rollback.sh relanza restart.js).
    // Se omite si --paused (no todos los componentes están arriba en modo pausado).
    if (!flagNoSmokeTest && !flagPaused) {
      sleep(3000);
      let smoke = runSmokeTest();
      // Retry antes de disparar rollback destructivo: el smoke-test puede fallar
      // por bug del singleton (procesos viejos que no fueron matados + respawn
      // aborta sin escribir marker, ver issue #2450). Reintentamos matando
      // stragglers y relanzando componentes missing. Solo si el segundo smoke
      // también falla → rollback.
      if (!smoke.ok && !flagNoRollback) {
        log('Primer smoke test FAIL — reintento tras limpieza de stragglers');
        killAll();
        launchAll();
        sleep(5000);
        smoke = runSmokeTest();
        if (smoke.ok) log('Segundo smoke test OK tras retry — pipeline recuperado sin rollback');
      }
      if (smoke.ok) {
        if (!stablePointsToHead()) moveStableTag();
      } else if (flagNoRollback) {
        log('Smoke test falló pero --no-rollback activo (diagnóstico)');
        enqueueTelegramAlert(`⚠️ *Pipeline restart: smoke test FAIL*\nExit ${smoke.exitCode}\n\nModo diagnóstico (--no-rollback), sin rollback automático.`);
      } else if (!hasStableTag()) {
        log('Smoke test falló pero no existe tag pipeline-stable — primer deploy, sin rollback');
        enqueueTelegramAlert(`⚠️ *Pipeline restart: smoke test FAIL*\nExit ${smoke.exitCode}\n\nNo existe tag \`pipeline-stable\` (primer deploy). Revisar manualmente.`);
      } else {
        enqueueTelegramAlert(`🚨 *Pipeline restart FALLÓ tras retry — lanzando rollback orphan*\nSmoke test exit ${smoke.exitCode}.\nVolviendo a \`pipeline-stable\`. Progreso en \`logs/rollback.log\`.`);
        // Lanzamos rollback como orphan detached y salimos. El rollback
        // notifica por Telegram cuando termina (OK o FAIL).
        launchRollbackOrphan();
      }
    }
}

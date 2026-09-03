#!/usr/bin/env node
// #6812 — Windows: suprimir la ventana de consola de cada hijo (gh, git,
// tasklist, powershell). Debe ir ANTES de cualquier require que spawnee.
require('./lib/force-windows-hide').apply();
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
  waitForPortFree,
  processForPid,
  SCRIPT_MAP,
} = require('./pid-discovery');
// #5722 — la decisión de ownership y la terminación con fallback verificado
// viven en un módulo importable para que los tests ejerciten el guard REAL.
const portGuard = require('./lib/port-guard');
const { clearAllMarkers } = require('./lib/ready-marker');
const smokeBudget = require('./lib/smoke-budget');
const { annotateAndMoveOrphans } = require('./lib/restart-orphan-annotator');
// #4664 (Ola 9.1 · cutover de wiring) — el arranque del motor (pulpo/dashboard)
// se resuelve vía el kernel-resolver: apunta al kernel migrado cuando el consumo
// está habilitado, y al motor local de `.pipeline/` en coexistencia (default).
const kernelResolver = require('./lib/kernel-resolver');
// #6441 — la verificación post-arranque vive en un módulo importable para que
// `node --test` la ejercite sin spawnear el pipeline entero.
const restartVerify = require('./lib/restart-verify');
const dropfileWriter = require('./lib/dropfile-writer');

// Saneado global de JAVA_HOME — si restart.js heredó una ruta stale (ej. JBR
// de IntelliJ obsoleto), la corregimos antes de spawnear pulpo/servicios, así
// todos los hijos reciben un JDK válido. Incidente 2026-04-21.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});

// #3311 — Hidratar process.env desde ~/.claude/secrets/credentials.json antes
// de spawnear los hijos del pipeline (pulpo, listener, svc-*). Los procesos
// hijo heredan el env del padre, así que con una sola invocación acá todos
// los componentes reciben las API keys de providers + tokens Telegram sin que
// el operador tenga que setear setx manualmente. Degradación silenciosa si
// el archivo no existe.
require('./lib/credentials').loadIntoEnv({
  logger: (m) => console.error(m),
});

// --- VALIDACIÓN FORCE_PROVIDER_OVERRIDE (#3680 CA-A9) ---
// Boot fail-fast EN restart.js TAMBIÉN (no sólo pulpo). Si el operador hace
// `set FORCE_PROVIDER_OVERRIDE=cerebras` y después `node .pipeline/restart.js`,
// el flag se hereda a los spawn children del pulpo y rompe la disciplina de
// routing productivo. Defense-in-depth contra esa misma ruta de bypass —
// abortar acá mismo antes de matar/relanzar los componentes.
//
// Escape hatch: PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 acepta el flag igual
// (sólo emergencias documentadas).
if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE !== '1') {
  console.error(
    '[restart] FATAL FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo — ' +
    'uso exclusivo del harness multi-provider-smoke-test (per-spawn env del child). ' +
    'Unset la variable (`set FORCE_PROVIDER_OVERRIDE=` en Windows, ' +
    '`unset FORCE_PROVIDER_OVERRIDE` en bash) y reintentar.'
  );
  process.exit(2);
} else if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE === '1') {
  console.error(
    '[restart] WARN FORCE_PROVIDER_OVERRIDE presente con PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 — ' +
    'pipeline corre en modo override forzado. Sólo emergencias documentadas.'
  );
}

const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(PIPELINE, '..');

// #2880 — capturar mtime de este archivo al cargarse, para detectar después
// de syncWithMain() si el `git reset --hard FETCH_HEAD` cambió el código del
// propio restart.js. Si cambió, re-exec con la versión nueva antes de
// launchAll() para evitar el race entre código en memoria (viejo) y archivos
// en disco (nuevos). Sin esto, cualquier merge que toque COMPONENTS rompe
// el primer restart post-merge (incidente 2026-04-30 con svc-reconciler).
let SELF_LOAD_MTIME_MS = 0;
try { SELF_LOAD_MTIME_MS = fs.statSync(__filename).mtimeMs; } catch {}

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

// #5646 — Marca en `stale-services.json` los componentes cuyo código cambió con
// el reset. NUNCA lanza: el sync no puede romperse por el marcado.
// Los paths que se loguean vienen del contenido del commit y ya salen
// sanitizados del helper (REQ-SEC-5646-8): un path con CR/LF embebido no puede
// falsificar líneas en `pulpo.log`.
function marcarComponentesConCodigoViejo(prevHead, head) {
  try {
    const stale = require('./lib/stale-services');
    const res = stale.computeAffectedComponents({
      prevSha: prevHead || undefined,
      headSha: head,
      repoRoot: ROOT,
      pipelineDir: PIPELINE,
    });
    if (!res.components.length) {
      // CA-2 / UX G-1: el caso "no afectó a nadie" también deja una línea; sin
      // ella, el log silencioso es indistinguible de "no corrió".
      log('restart selectivo: sin componentes afectados por el reset');
      return;
    }
    const mark = stale.markAffected(res.components, { sha: res.headSha, reasons: res.reasons });
    for (const r of res.reasons) {
      if (!mark.marked.includes(r.component)) continue;
      log(`restart selectivo: ${r.component} quedó con código viejo — cambio en ${r.path}`);
    }
  } catch (e) {
    log(`Warning: no se pudo marcar servicios con código viejo: ${(e && e.message || '').slice(0, 80)}`);
  }
}

// #5646 (CA-3, corregido por PO sobre P-1 de guru) — Baja del registro de
// pendientes SÓLO los componentes que `launchAll()` relanzó de verdad. La lista
// se DERIVA de lo efectivamente lanzado, no de una constante duplicada: limpiar
// el registro entero desmarcaría `outbox-drain` (que no está en COMPONENTS de
// este archivo) sin haberlo relanzado jamás → quedaría con código viejo, en
// silencio y para siempre, que es el fail-open que cierra CA-5.
function limpiarPendientesRelanzados(lanzados) {
  if (!Array.isArray(lanzados) || !lanzados.length) return;
  try {
    const stale = require('./lib/stale-services');
    const res = stale.clearComponents(lanzados);
    if (res.cleared.length) {
      log(`restart selectivo: ${res.cleared.join(', ')} relanzados por restart.js — pendiente dado de baja`);
    }
    const restantes = stale.readPending();
    if (restantes.components.length) {
      log(`restart selectivo: siguen pendientes para el watchdog: ${restantes.components.join(', ')}`);
    }
  } catch (e) {
    log(`Warning: no se pudieron limpiar pendientes: ${(e && e.message || '').slice(0, 80)}`);
  }
}

function syncWithMain() {
  // #5646 — HEAD ANTES del reset. Es la referencia contra la que se calcula qué
  // componentes quedaron con código viejo. Se captura acá (no después) porque
  // el `reset --hard` de abajo la destruye. Best-effort: si no se puede
  // resolver, el marcado usa el boot marker como referencia.
  let prevHead = null;
  try {
    prevHead = execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
  } catch { /* sin referencia previa: se resuelve más abajo con el boot marker */ }
  try {
    execSync('git fetch origin main', { cwd: ROOT, timeout: 30000, windowsHide: true });
    // #4577 GATE 3 — INVARIANTE log-antes-de-mutar (RS-2/RS-6): registrar el
    // reset del working tree ANTES del `git reset --hard`. Corre fuera del loop
    // del Pulpo durante recovery; si el proceso muere entre el log y el reset,
    // queda el intento registrado y el working tree intacto (recuperable).
    // Best-effort: el audit NUNCA rompe el rollback transaccional.
    try {
      require('./lib/kernel-actions-audit').safeAppendAction({
        action: 'worktree-reset', impact: 'alto',
        reason: 'syncWithMain: git reset --hard FETCH_HEAD (recovery de restart)',
        authorizedBy: 'restart:rollback',
      });
      require('./lib/kernel-action-policy').enforceActionPolicy('worktree-reset', {
        impact: 'alto',
        reason: 'syncWithMain: git reset --hard FETCH_HEAD (recovery de restart)',
      });
    } catch (e) {
      // #5172 — dejó de ser mudo. `worktree-reset` es notify-and-proceed y el
      // veredicto no se lee: el reset transaccional sigue igual (el audit NUNCA
      // rompe el rollback). Sólo se hace visible que el aviso no salió.
      require('./lib/kernel-action-policy').logPolicyEnforcementFailure(
        'restart', 'worktree-reset', e);
    }
    execSync('git reset --hard FETCH_HEAD', { cwd: ROOT, timeout: 15000, windowsHide: true, encoding: 'utf8' });
    log('Sincronizado con origin/main');
    // #4460 — Registrar el HEAD tras el reset como SHA canónico de "qué corre
    // vivo". Es la referencia que la detección de drift compara contra
    // origin/main para saber si hay entregables del modelo operativo sin
    // aplicar. Best-effort: si falla, el marker queda como estaba (el slice lo
    // trata como estado desconocido, nunca como "sin pendientes").
    try {
      const head = execSync('git rev-parse HEAD', { cwd: ROOT, timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
      // #5646 — Marcar qué componentes quedaron con código viejo por este reset.
      // `restart.js` relanza los suyos en `launchAll()` y los baja del registro
      // ahí mismo; lo que queda pendiente (típicamente `outbox-drain`, que NO
      // está en COMPONENTS de este archivo) lo relanza el watchdog. Va ANTES de
      // `writeBootMarker` sólo por orden de lectura: el cómputo usa `prevHead`
      // explícito, no el marker.
      marcarComponentesConCodigoViejo(prevHead, head);
      const res = require('./lib/runtime-boot').writeBootMarker(head, { pipelineDir: PIPELINE });
      if (res && res.ok) log(`Boot marker actualizado: ${head.slice(0, 8)}`);
    } catch (e2) {
      log(`Warning: no se pudo escribir runtime-boot.json: ${(e2 && e2.message || '').slice(0, 80)}`);
    }
  } catch (e) {
    log(`Warning: no se pudo sincronizar con main: ${e.message.slice(0, 100)}`);
  }
}

// #2880 — si syncWithMain() trajo una versión nueva de restart.js al disco,
// nuestro código en memoria está obsoleto (no conoce nuevos componentes ni
// nuevas constantes). Re-exec con la versión nueva antes de launchAll() para
// que use el lifecycle correcto. Limitado por --no-reexec para evitar loop
// infinito si el archivo cambia en cada iteración (caso patológico).
function reexecIfSelfChanged() {
  if (process.argv.includes('--no-reexec')) {
    log('Saltando self-reexec check (--no-reexec)');
    return;
  }
  let currentMtime = 0;
  try { currentMtime = fs.statSync(__filename).mtimeMs; } catch { return; }
  if (currentMtime <= SELF_LOAD_MTIME_MS) return;

  log(`restart.js cambió en disco (${Math.round(currentMtime - SELF_LOAD_MTIME_MS)}ms más nuevo) — re-exec con la versión nueva`);
  // Preservar args originales + agregar --no-reexec --no-sync (kill/sync ya hechos en esta instancia).
  const newArgs = process.argv.slice(2).concat(['--no-reexec', '--no-sync']);
  const result = spawnSync(process.execPath, [__filename, ...newArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exit(result.status === null ? 1 : result.status);
}

// --- KILL: drástico — matar todo lo que sea del pipeline ---

// #5722 — PIDs que los propios componentes declararon al arrancar. Es la
// corroboración de ownership que permite matar un node.exe opaco sin caer en
// "matar cualquier node.exe", que se llevaría puestos editores, MCP servers y
// agentes. Devuelve Map<pid, archivo> (el archivo va al log, para auditoría).
function readDeclaredPipelinePids() {
  const map = new Map();
  for (const comp of COMPONENTS) {
    try {
      const raw = fs.readFileSync(path.join(PIPELINE, comp.pid), 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (pid && !Number.isNaN(pid) && pid !== process.pid) map.set(pid, comp.pid);
    } catch {}
  }
  return map;
}

// #5722 (CA-3) — terminación con fallback verificado, compartida por killAll()
// y el guard del puerto.
function killPipelineProcess(pid) {
  return portGuard.terminateProcess(pid, {
    pidAlive,
    sleep,
    platform: process.platform,
    exec: (cmd) => execSync(cmd, { timeout: 8000, stdio: 'pipe', windowsHide: true }),
  });
}

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

  // Además, mata lo que escuche en el puerto del dashboard aunque su
  // commandLine no coincida (casos borde: proceso respawneado por watchdog
  // entre el scan y el kill).
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
  const dashOwner = findPidByPort(dashPort);

  // #5722 (CA-5) — Se lee ANTES de borrar los .pid de más abajo. Los componentes
  // escriben su propio PID al arrancar, así que estos archivos corroboran
  // ownership de un node.exe cuya CommandLine es ilegible. Sin esta señal, el
  // `if (!p.commandLine) continue` anterior dejaba escapar del kill principal a
  // pulpo/servicios opacos, en silencio — el mismo modo de falla de #5704.
  const declaredPids = readDeclaredPipelinePids();

  const seleccion = portGuard.selectPipelinePidsToKill({
    processes: scanNodeProcesses(),
    scriptNames: [...scriptNames],
    declaredPids,
    dashOwner,
    selfPid: process.pid,
  });
  for (const pid of seleccion.pids) pidsToKill.add(pid);
  for (const o of seleccion.opacos) {
    log(`  PID ${o.pid}: node con CommandLine ilegible, ${o.motivo} — se mata igual (#5722)`);
  }

  if (pidsToKill.size === 0) {
    log('  No hay procesos del pipeline corriendo');
  } else {
    for (const pid of pidsToKill) {
      // #5722 (CA-3) — con fallback a `wmic call terminate` y verificación por
      // pidAlive: `taskkill` puede reportar éxito (o "Acceso denegado" tragado)
      // y dejar el proceso vivo.
      const res = killPipelineProcess(pid);
      if (res.killed) log(`  Killed PID ${pid} (${res.intentos[res.intentos.length - 1].label})`);
      else log(`  PID ${pid} NO se pudo terminar: ${res.intentos.map(i => i.label).join(' → ')}`);
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
  //
  // #2374 Parte 1 — preservación de trabajo interrumpido por restart:
  //   Hoy `killAll()` mata claude.exe (spawn no-detached), por lo que el
  //   trabajo en memoria del agente se pierde. El YAML del archivo SE PRESERVA
  //   (el helper lo escribe íntegro en `pendiente/`), pero el agente re-lanzado
  //   parte de cero. Para dejar trazabilidad del corte el helper agrega al
  //   YAML las claves `restart_interrupted: true` y `restart_at: <ISO>` — el
  //   agente que re-tome el archivo verá explícitamente que es un re-run
  //   post-restart y puede decidir comportamiento defensivo (por ejemplo,
  //   builder puede limpiar daemons stale antes de empezar).
  //
  //   Hot-restart real (preservar el proceso del agente vivo, sin matarlo,
  //   y que el nuevo pulpo lo reattach) requiere `detached:true` en
  //   `lib/agent-launcher.js`, persistencia de PID + heartbeat, y handler de
  //   reattach en pulpo.js. Esa entrega queda como follow-up por el riesgo
  //   regresivo en el spawn.
  //
  //   El helper `annotateAndMoveOrphans` está testeado en
  //   `lib/__tests__/restart-orphan-annotator.test.js`.
  const { movedCount: orphansMoved } = annotateAndMoveOrphans({
    pipelineRoot: PIPELINE,
    pipelinesScan: ['desarrollo', 'definicion'],
    restartAt: new Date().toISOString(),
  });
  if (orphansMoved > 0) log(`  ${orphansMoved} agente(s) interrumpido(s) por restart → pendiente/ (marcados con restart_interrupted: true)`);

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
  // #5722 — misma regla que arriba: un superviviente con CommandLine ilegible
  // no se perdona si el pipeline declaró ese PID. `declaredPids` se leyó al
  // inicio de killAll(), antes de borrar los .pid.
  const survivors = scanNodeProcesses().filter(p => {
    if (!p.pid || p.pid === process.pid) return false;
    const cmd = (p.commandLine || '').trim();
    if (!cmd) return declaredPids.has(p.pid);
    return cmd.includes('.pipeline') && !cmd.includes('restart.js');
  });
  if (survivors.length > 0) {
    log('  Quedan procesos vivos — segundo intento:');
    for (const p of survivors) {
      const res = killPipelineProcess(p.pid);
      log(res.killed
        ? `    Force killed PID ${p.pid} (${res.intentos[res.intentos.length - 1].label})`
        : `    PID ${p.pid} SIGUE VIVO tras ${res.intentos.map(i => i.label).join(' → ')}`);
    }
  }
}

// --- LIBERACIÓN DETERMINÍSTICA DEL PUERTO DEL DASHBOARD (#4308) ---
//
// Entre killAll() y launchAll() verificamos de forma ACOTADA que el puerto del
// dashboard (3200 por default) quedó libre antes de relanzar. Sin esto, si el
// socket TCP no se liberó aún o un proceso respawneó entre scan y kill, el
// dashboard nuevo choca con EADDRINUSE, el smoke test falla 2× y se dispara un
// rollback espurio a `pipeline-stable`.
//
// onHolder (SEC-2): antes de re-matar valida ownership, LOGUEA PID + imagen +
// commandLine ANTES de matar (auditoría), y mata SOLO por PID numérico (SEC-1 /
// CA-6: nada de `$(...)`, `fkill <puerto>` ni interpolar salida de netstat). Un
// proceso ajeno que casualmente tome el puerto NO se mata.
//
// #5722 — La decisión de ownership se delega a `lib/port-guard`, que distingue
// "no es un proceso node" (ajeno, se perdona) de "es node.exe con CommandLine
// ilegible" (se trata como del pipeline). Y si el backoff se agota, esto ya NO
// degrada a "avanzar igual": aborta ruidoso. Avanzar hacia un arranque que se
// sabe condenado es lo que costó 20 h de pipeline caído — la supuesta "red
// secundaria" del retry EADDRINUSE nunca existió, porque el puerto seguía tomado.
const PORT_GUARD_ATTEMPTS = 6;
const PORT_GUARD_DELAY_MS = 500;

function freeDashboardPortOrAbort() {
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
  const res = portGuard.freeDashboardPort(dashPort, {
    waitForPortFree,
    processForPid,
    pidAlive,
    selfPid: process.pid,
    platform: process.platform,
    attempts: PORT_GUARD_ATTEMPTS,
    delayMs: PORT_GUARD_DELAY_MS,
    log,
    sleep,
    // stdio 'pipe' (no 'ignore'): necesitamos el stderr del "Acceso denegado"
    // para poder reportarlo. El fallback igual se decide con pidAlive.
    exec: (cmd) => execSync(cmd, { timeout: 8000, stdio: 'pipe', windowsHide: true }),
  });

  if (res.free) {
    log(`  [puerto ${dashPort}] libre antes de launchAll()`);
    return true;
  }

  // CA-2 — fallar explícito y ruidoso. NO se encadena a rollback: volver a una
  // revisión anterior deja el mismo holder vivo y reproduce el loop del incidente.
  const alerta = portGuard.buildAbortAlert({
    port: dashPort,
    holder: res.holder,
    platform: process.platform,
    attempts: PORT_GUARD_ATTEMPTS,
    delayMs: PORT_GUARD_DELAY_MS,
  });
  log(alerta.logText);
  enqueueTelegramAlert(alerta.telegram);
  // Exit code propio: permite que watchdog/supervisor distingan "puerto
  // bloqueado, no reintentar en loop" de "falló otra cosa".
  process.exit(portGuard.EXIT_PORT_BLOCKED);
}

// --- LAUNCH ---

// #6441 — Spawn de UN componente. Extraído de `launchAll()` para que el
// reintento de la verificación post-arranque use exactamente el mismo camino
// (REQ-SEC-6441-6): `spawn` sin shell, script resuelto contra `PIPELINE` o el
// kernel-resolver, nombre siempre proveniente de `COMPONENTS`. Nunca se arma
// una command line con datos externos.
//
// `truncarLog`: en el primer intento el log se trunca (arranque limpio); en el
// REINTENTO se appendea, porque truncarlo borraría justo el stack que explica
// por qué el servicio no arrancó la primera vez.
function lanzarComponente(comp, logsDir, truncarLog) {
  // #4664 — pulpo y dashboard son los entrypoints del motor que migraron a
  // `core/` del kernel: se resuelven vía kernel-resolver (kernel migrado vs
  // motor local, según coexistencia). El resto de servicios (listener/svc-*)
  // son del adaptador y quedan en `.pipeline/`.
  let scriptPath;
  if (comp.name === 'pulpo' || comp.name === 'dashboard') {
    const resolved = kernelResolver.resolveEntry(comp.name);
    scriptPath = resolved.path;
    if (resolved.source === 'kernel') {
      log(`  ${comp.name}: usando kernel migrado @${resolved.version} (${scriptPath})`);
    }
  } else {
    scriptPath = path.join(PIPELINE, comp.script);
  }
  if (!fs.existsSync(scriptPath)) return null;

  const logPath = path.join(logsDir, `${comp.name}.log`);
  if (truncarLog !== false) {
    fs.writeFileSync(logPath, `--- restart ${new Date().toISOString()} ---\n`);
  } else {
    try { fs.appendFileSync(logPath, `--- reintento ${new Date().toISOString()} ---\n`); } catch {}
  }
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
  return child.pid;
}

// #5646 — Devuelve los nombres de los componentes efectivamente lanzados. El
// caller usa ESA lista (no una constante duplicada) para bajar pendientes del
// registro de "código viejo": lo que no se lanzó, no se desmarca.
// #6441 — Ojo: "lanzado" es "spawneado", NO "vivo". Quién quedó realmente vivo
// lo decide `verificarArranque()`.
function launchAll() {
  log('=== START ===');

  const logsDir = path.join(PIPELINE, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const lanzados = [];
  for (const comp of COMPONENTS) {
    const pid = lanzarComponente(comp, logsDir, true);
    if (pid == null) continue;
    lanzados.push(comp.name);
    log(`  ${comp.name}: PID ${pid}`);
  }

  sleep(3000);
  return lanzados;
}

// #6441 — Sonda de liveness por IDENTIDAD, no por pid file: `findPidByComponent`
// matchea la command line del proceso node. Un pid file rancio cuyo número fue
// reciclado por otro proceso (le pasó a `svc-emulador.pid`) daría vivo un
// servicio muerto.
function componenteVivo(name) {
  const found = findPidByComponent(name);
  return !!(found && pidAlive(found.pid));
}

// #6441 (CA-1/CA-2) — Verifica servicio por servicio que el arranque funcionó,
// reintenta los que no quedaron vivos y devuelve el veredicto. NO decide el exit
// code: eso lo hace el caller, para que el punto donde el restart se declara
// degradado sea uno solo y visible.
//
// @returns {{vivos:string[], muertos:string[], degradado:boolean}}
function verificarArranque(lanzados) {
  const logsDir = path.join(PIPELINE, 'logs');
  log('=== VERIFICACIÓN POST-ARRANQUE ===');

  // Misma clasificación que usa el barrido del watchdog: un solo lugar decide
  // qué ausencia es un incidente. `svc-emulador` sólo corre en la ventana QA,
  // así que su ausencia se REPORTA pero no deja el restart en degradado — si no,
  // cada /restart terminaría avisando y el aviso dejaría de significar algo.
  let supervisados;
  try { supervisados = require('./lib/stale-services').SUPERVISED_COMPONENTS; }
  catch (e) {
    // Fail-closed: sin la clasificación, TODO cuenta. Preferimos un falso
    // degradado antes que dejar pasar un servicio caído en silencio.
    supervisados = undefined;
    log(`Warning: no se pudo leer la clasificación de servicios supervisados (${(e && e.message || '').slice(0, 80)}) — se exige que levanten todos`);
  }

  invalidateCache();
  let res = restartVerify.evaluarArranque(lanzados, componenteVivo, supervisados);
  for (const linea of restartVerify.lineasLog(res)) log(linea);
  if (!res.degradado) return res;

  log(`Reintentando los que no levantaron: ${res.muertosSupervisados.join(', ')}`);
  const porNombre = new Map(COMPONENTS.map(c => [c.name, c]));
  for (const name of res.muertosSupervisados) {
    const comp = porNombre.get(name);
    if (!comp) continue; // nombre fuera de COMPONENTS: no se spawnea nada
    try {
      const pid = lanzarComponente(comp, logsDir, false);
      log(`  ${name}: reintento PID ${pid == null ? '(script ausente)' : pid}`);
    } catch (e) {
      log(`  ${name}: ERROR en el reintento — ${(e && e.message || '').slice(0, 120)}`);
    }
  }
  sleep(3000);

  invalidateCache();
  res = restartVerify.evaluarArranque(lanzados, componenteVivo, supervisados);
  log('--- tras el reintento ---');
  for (const linea of restartVerify.lineasLog(res)) log(linea);
  return res;
}

// #6441 — Cierra el ciclo de arranque: lanza, verifica, reintenta, baja del
// registro de "código viejo" SÓLO lo que quedó vivo (bajar un servicio que no
// arrancó es fail-open) y deja el restart en estado degradado si algo faltó.
function launchAllVerificado() {
  const res = verificarArranque(launchAll());
  limpiarPendientesRelanzados(res.vivos);
  if (res.degradado) {
    log(`=== RESTART DEGRADADO: no levantaron ${res.muertosSupervisados.join(', ')} ===`);
    enqueueTelegramAlert(restartVerify.textoAlerta(res.muertosSupervisados));
    // `process.exitCode` y NO `process.exit()`: abajo siguen el smoke test, el
    // avance del tag y el rollback, que no se pueden cortar acá. El código de
    // salida se materializa cuando el proceso termina solo.
    process.exitCode = 1;
  }
  return res;
}

// --- SMOKE TEST + TAG pipeline-stable + AUTO-ROLLBACK ---

function runSmokeTest() {
  const script = path.join(PIPELINE, 'smoke-test.js');
  if (!fs.existsSync(script)) {
    log('Smoke test ausente, se omite');
    return { ok: true, skipped: true };
  }

  // CA-1 — la ventana del runner se DERIVA de las mismas constantes que usa el
  // smoke (lib/smoke-budget), en vez de ser un 90000 hardcodeado que nadie
  // mantenía sincronizado. Antes el runner cortaba ANTES que el smoke: lo mataba
  // con SIGTERM a mitad de la espera de markers y el diagnóstico nunca llegaba a
  // escribirse. Por construcción esta ventana ya no puede quedar corta: si sube
  // la ventana del dashboard, sube sola.
  const timeoutMs = smokeBudget.runnerTimeoutMs();
  log('=== SMOKE TEST ===');
  log(`  ventana del runner: ${Math.round(timeoutMs / 1000)}s (derivada del presupuesto del smoke)`);
  try {
    // smoke-test.js es Node puro: lee ready markers + chequea HTTP en :3200.
    // No usa wmic ni bash. El smoke se autolimita ANTES de este timeout y
    // vuelca su estado parcial, así que llegar acá ya es anómalo.
    const result = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const cls = smokeBudget.classifySmokeResult(result);

    if (cls.ok) {
      log('Smoke test OK');
      return { ok: true, exitCode: 0, incomplete: false, output };
    }

    // CA-3 — "no completó" y "falló con diagnóstico" son cosas distintas y se
    // reportan distinto. Colapsar ambas en `exit -1` fue lo que disparó el
    // rollback a ciegas del 2026-08-09.
    if (cls.incomplete) {
      log(`Smoke test NO COMPLETÓ sus chequeos: ${cls.reason}`);
      log('  Sin veredicto sobre el pipeline — no hay evidencia de que el código sea la causa.');
    } else {
      log(`Smoke test FAIL (exit ${cls.exitCode}, signal=${result.signal || 'none'})`);
    }
    if (output) log(output.split('\n').slice(-12).join('\n'));
    else log('  Sin salida capturada — revisar .pipeline/logs/smoke-test.log');
    return { ok: false, exitCode: cls.exitCode, incomplete: cls.incomplete, reason: cls.reason, output };
  } catch (e) {
    // No pudimos ni lanzarlo: tampoco hay evidencia contra el código.
    log(`Smoke test error: ${e.message}`);
    return {
      ok: false, exitCode: -1, incomplete: true,
      reason: `no se pudo ejecutar el smoke test (${e.message})`, output: e.message,
    };
  }
}

// #5723 (CA-2) — el tag tiene que avanzar en CADA smoke limpio, no sólo
// cuando el tag local está desalineado. Antes se llamaba únicamente si
// `!stablePointsToHead()`, así que un tag local en HEAD con el remoto atrasado
// nunca se corregía. `git tag -f` y el push son idempotentes: llamarlos
// siempre es barato y cierra ese hueco.
//
// La guarda nueva es la inversa: NO mover el tag si el CÓDIGO de .pipeline/
// difiere de HEAD. Ese es exactamente el estado post-rollback (HEAD apunta a
// un commit pero .pipeline/ en disco viene de otro). Taggear ahí grabaría como
// "estable" un commit cuyo contenido no es el que pasó el smoke, y el próximo
// rollback volvería a un punto que nunca se validó.
//
// OJO (bloqueante 1 de la review de #5723): mirar el diff crudo de `.pipeline/`
// NO sirve. Hay estado runtime TRACKEADO que el pipeline reescribe durante el
// propio boot — `telegram-health.json`, `process-transitions.jsonl`,
// `metrics-history.jsonl`… — así que entre el `reset --hard` de syncWithMain()
// y este punto el árbol está sucio SIEMPRE. Con el diff crudo el tag no
// avanzaría jamás y encima alertaría en cada restart: la condición del
// incidente del 2026-08-09 vuelta permanente. Por eso la lectura y el filtrado
// viven en `guard.readDirtyPipelineCode()`, que descarta estado runtime pero
// deja pasar cualquier extensión de código, esté donde esté.
//
// La lectura vive en el módulo (y no inline acá) para que los tests la
// ejerciten de verdad: requerir restart.js dispararía un restart real, así que
// mientras esto fuera inline no había forma de cubrirlo — y ese fue justamente
// el hueco por el que se coló el bloqueante 1.
function pipelineTreeDirty() {
  const { all, relevant, readFailed } = require('./lib/rollback-guard')
    .readDirtyPipelineCode({ cwd: ROOT });
  if (readFailed) {
    // Fail-open deliberado: si git no responde no podemos afirmar que el árbol
    // esté sucio, y bloquear el avance del tag por una lectura fallida nos
    // devuelve al problema original (tag que se queda atrás).
    log('No se pudo leer el diff de .pipeline/ contra HEAD — se asume limpio y el tag avanza');
    return null;
  }
  if (!relevant.length) {
    if (all.length) {
      log(`Árbol de .pipeline/ con ${all.length} archivo(s) modificados, todos estado runtime — no frenan el tag`);
    }
    return null;
  }
  return relevant;
}

function moveStableTag() {
  const dirty = pipelineTreeDirty();
  if (dirty) {
    log(`Tag pipeline-stable NO se mueve: el código de .pipeline/ en disco difiere de HEAD (${dirty.length} archivo(s))`);
    for (const f of dirty.slice(0, 10)) log(`    - ${f}`);
    if (dirty.length > 10) log(`    - ...y ${dirty.length - 10} más`);
    log('  Es el estado típico post-rollback. Taggear acá marcaría como estable algo que no es lo que corrió.');
    enqueueTelegramAlert(
      '⚠️ *Smoke test OK pero el tag `pipeline-stable` no avanzó.*\n\n' +
      `El código de \`.pipeline/\` en disco no coincide con el commit actual. Difieren ${dirty.length} archivo(s):\n` +
      dirty.slice(0, 10).map((f) => `• \`${f}\``).join('\n') +
      (dirty.length > 10 ? `\n• ...y ${dirty.length - 10} más` : '') +
      '\n\nSuele pasar después de un rollback. Mientras siga así el tag queda atrás, ' +
      'y un próximo rollback puede borrar cambios buenos.\n\n' +
      'Qué hacer:\n' +
      '1. Si eso es código que querés conservar: mergealo.\n' +
      '2. Si lo de disco ya no sirve: `git checkout HEAD -- .pipeline/`.\n' +
      '3. Si alguno es estado runtime que el pipeline reescribe solo, no es código: ' +
      'sumalo a `RUNTIME_STATE_FILES` en `.pipeline/lib/rollback-guard.js` (o a `.gitignore`) ' +
      'para que deje de frenar el tag.'
    );
    return false;
  }
  try {
    let before = null;
    try {
      before = execSync('git rev-parse pipeline-stable', { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    } catch {}
    execSync('git tag -f pipeline-stable HEAD', { cwd: ROOT, timeout: 5000, windowsHide: true });
    const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (before && before !== head) {
      let ahead = '';
      try {
        ahead = execSync(`git rev-list --count ${before}..${head}`, { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      } catch {}
      log(`Tag pipeline-stable avanzó ${ahead ? ahead + ' commit(s): ' : ''}${before.slice(0, 8)} → ${head.slice(0, 8)}`);
    }
    try {
      execSync('git push origin --force pipeline-stable', { cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'ignore' });
      log(`Tag pipeline-stable movido y pusheado (${head.slice(0, 8)})`);
    } catch (e) {
      log(`Tag movido local, push falló: ${e.message.slice(0, 100)}`);
    }
    return true;
  } catch (e) {
    log(`No se pudo mover tag pipeline-stable: ${e.message.slice(0, 100)}`);
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
    // #6226 — nombre único + escritura `wx`: dos dropfiles del mismo
    // milisegundo ya no se pisan entre sí ni pisan los de otro proceso.
    dropfileWriter.writeDropfileSync({
      dir: svcDir,
      suffix: 'restart-alert.json',
      data: JSON.stringify({ text: msg, parse_mode: 'Markdown' }),
      onCollision: (name) => log(`Colisión de nombre de dropfile (${name}) — se reintenta`),
    });
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
    // ROLLBACK_STDIO_IS_LOG — su stdout ya apunta a rollback.log (logFd). Sin
    // esta señal rollback.js escribiría cada línea dos veces: una por
    // appendFileSync y otra por console.log (#5723, G-6).
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules'), ROLLBACK_STDIO_IS_LOG: '1' },
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
// Estado de pausa PREVIO al restart: si el pipeline estaba en pausa total
// (.paused presente) antes de reiniciar, el restart debe CONSERVAR esa pausa
// en lugar de soltarla. Un /restart no es un "destrabe" implícito.
// #5179 grupo 3b / CA-6b — se consulta al envoltorio único, no al marker crudo.
// FAIL-CLOSED (ver `lib/full-pause-state.js`): si el estado no se puede
// determinar se asume PAUSADO, para que un restart no suelte una pausa del
// operador por no poder leerla — el fail-open que #5399 vino a cerrar (un
// /restart no es un destrabe implícito).
//
// MEMOIZADO Y LAZY a propósito: el valor se resuelve la primera vez que alguien
// lo pide, no al cargar el módulo. `stop` / `status` no despachan pausa y así no
// pagan el costo de arrastrar el envoltorio (waves + partial-pause + audit-log +
// Telegram), que es la misma razón por la que el require del branch `--paused`
// también es lazy.
let _wasPausedBeforeCache = null;
function wasPausedBefore() {
  if (_wasPausedBeforeCache === null) {
    _wasPausedBeforeCache = require('./lib/full-pause-state').isFullPauseActive();
  }
  return _wasPausedBeforeCache;
}
// El short-circuit de `--paused` se preserva: con la flag explícita ni se
// consulta el estado en disco.
function flagPausedFn() { return process.argv.includes('--paused') || wasPausedBefore(); }
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
  default: {
    // Se resuelve ANTES de matar procesos y sincronizar, igual que cuando era
    // una const de módulo: el estado que interesa es el previo al restart, no el
    // que quede después de `killAll()` / `syncWithMain()`. Memoizado, así que las
    // lecturas de más abajo devuelven este mismo valor.
    const flagPaused = flagPausedFn();
    killAll();
    if (!flagNoSync) syncWithMain();
    else log('Saltando sync con origin/main (--no-sync)');
    // #2880 — si syncWithMain() cambió este propio archivo, re-exec antes de
    // launchAll() para que la versión nueva sea la que lance los componentes.
    reexecIfSelfChanged();
    if (flagPaused) {
      // #5399 — el restart YA NO reescribe el marker con un ISO pelado: eso
      // destruía la autoría de la pausa y la volvía indistinguible de una
      // manual, así que el auto-recovery de #4832 nunca la levantaba (1h33 sin
      // despachar el 2026-08-02). Ruteamos por el dueño del estado
      // (`lib/partial-pause.js`), que escribe bajo lock + atómico (CA-11).
      // `require` LAZY: `stop`/`status` no pagan el costo de arrastrar
      // file-lock + waves + audit-log + Telegram en el arranque.
      const partialPause = require('./lib/partial-pause');
      let res = null;
      try {
        if (wasPausedBefore()) {
          // El marker se lee del disco DENTRO del lock, no desde memoria: así la
          // operación es idempotente ante el re-exec de #2880.
          res = partialPause.preserveFullPause();
        } else {
          // `--paused` sin pausa previa = pausa NUEVA pedida por el operador → humana.
          res = partialPause.setFullPause({
            source: 'restart',
            authorizedBy: 'restart:preserve-pause',
            justification: 'restart --paused (pausa nueva solicitada por el operador)',
          });
        }
      } catch (e) {
        // Nunca abortamos el restart por no poder anotar la preservación: el
        // marker original queda intacto, que ya es la preservación correcta.
        // UX-3: no se comunica como falla. La pausa siguió preservada; lo único
        // que faltó es el rastro del restart. Un texto de error empuja a una
        // intervención manual sobre un estado sano.
        log(`La pausa quedó preservada, pero no se pudo anotar el rastro del restart (${e.message})`);
      }
      // CA-7 — el operador tiene que poder distinguir "esperá 30s y se levanta
      // sola" de "esto no se levanta hasta que lo destrabes a mano".
      const autoLiftable = !!(res && res.autoLiftable);
      const autoria = (res && res.source) || 'unknown';
      const heredada = wasPausedBefore() ? 'heredada' : 'nueva';
      let extra = autoLiftable
        ? 'se auto-levanta cuando la causa se resuelva'
        : 'requiere destrabe explícito';
      // UX-3 — el camino degradado NO es una falla: la pausa se preservó bien,
      // sólo no quedó anotado `preservedFrom`. Redactarlo como error empuja al
      // `rm .pipeline/.paused` manual, que destruye justo la autoría que este
      // issue crea (UX-2).
      if (res && res.lockFailed) extra += '; preservada tal cual, sin anotar el rastro del restart';
      if (res && res.undetermined) extra += `; autoría no determinable (${res.undetermined})`;
      log(`Modo PAUSADO — pausa ${heredada} (autoría: ${autoria}; ${extra}) — `
        + 'solo Telegram + dashboard activos (intake/lanzamiento deshabilitados)');
    } else {
      // #5179 grupo 3b — restart en modo normal (ni `--paused` ni pausa previa):
      // se limpia cualquier marker residual vía el gate, con lock + audit, en vez
      // del `unlinkSync` crudo que borraba el estado sin dejar rastro.
      // `restart:preserve-pause` es la identidad del ciclo de vida de pausa que
      // usa restart.js (#5399) — de hecho es el default del propio módulo dueño.
      // `restart:rollback` NO corresponde: está reservado al recovery
      // transaccional (restart.js:185), que es otra operación.
      try {
        require('./lib/operational-state').clearFullPause({
          source: 'restart',
          authorizedBy: 'restart:preserve-pause',
          justification: 'restart normal: sin pausa previa ni --paused, se limpia marker residual',
        });
      } catch { /* nunca abortar el restart por no poder limpiar el marker */ }
    }
    freeDashboardPortOrAbort(); // #4308/#5722 — puerto 3200 libre, o abortar ruidoso
    // #5646 — Estos componentes acaban de arrancar leyendo el código de disco:
    // se bajan del registro de "código viejo" para que el watchdog no los
    // reinicie de nuevo un minuto después. Lo que restart.js NO lanza (p. ej.
    // `outbox-drain`) queda pendiente a propósito.
    // #6441 — ahora se bajan sólo los VERIFICADOS VIVOS, no los spawneados.
    launchAllVerificado();
    const ok = status();
    log(ok ? '=== Pipeline operativo ===' : '=== Revisar componentes ===');

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
        // #5722 — si acá el puerto sigue tomado, esto aborta ruidoso y NO cae al
        // rollback de más abajo: el rollback no libera un puerto ocupado, sólo
        // reproduce el loop del incidente.
        freeDashboardPortOrAbort(); // #4308/#5722
        launchAllVerificado();
        sleep(5000);
        smoke = runSmokeTest();
        if (smoke.ok) log('Segundo smoke test OK tras retry — pipeline recuperado sin rollback');
      }
      if (smoke.ok) {
        // #5723 (CA-2 + CA-4) — un smoke limpio es la única evidencia de que
        // el pipeline está sano: avanza el tag y corta la racha de rollbacks.
        moveStableTag();
        try {
          if (require('./lib/rollback-guard').clearState()) {
            log('Estado de rollback reseteado (un smoke limpio corta la racha)');
          }
        } catch (e) {
          log(`No se pudo resetear el estado de rollback: ${e.message.slice(0, 100)}`);
        }
      } else if (smoke.incomplete) {
        // CA-3 — el smoke no llegó a emitir veredicto. Rollbackear acá sería
        // revertir un deploy potencialmente sano por un problema del propio
        // gate: no hay ninguna evidencia que apunte al código. Avisamos fuerte
        // y dejamos la decisión en manos del operador.
        log('Smoke test no completó — NO se dispara rollback (sin evidencia contra el código)');
        log('  Diagnóstico parcial en .pipeline/logs/smoke-test.log');
        enqueueTelegramAlert(
          `⚠️ *Pipeline restart: el smoke test no llegó a terminar*\n\n`
          + `${smoke.reason || 'motivo no determinado'}.\n\n`
          + `No se hizo rollback automático: el smoke no alcanzó a emitir un veredicto, `
          + `así que no hay evidencia de que el código sea la causa. `
          + `El pipeline quedó con la versión nueva.\n\n`
          + `Diagnóstico parcial en \`logs/smoke-test.log\`. Requiere revisión manual.`
        );
      } else if (flagNoRollback) {
        const causa = smokeBudget.describeExitCode(smoke.exitCode);
        log('Smoke test falló pero --no-rollback activo (diagnóstico)');
        enqueueTelegramAlert(`⚠️ *Pipeline restart: smoke test FAIL*\n\n${causa} (exit ${smoke.exitCode}).\n\nModo diagnóstico (--no-rollback), sin rollback automático.`);
      } else if (!hasStableTag()) {
        const causa = smokeBudget.describeExitCode(smoke.exitCode);
        log('Smoke test falló pero no existe tag pipeline-stable — primer deploy, sin rollback');
        enqueueTelegramAlert(`⚠️ *Pipeline restart: smoke test FAIL*\n\n${causa} (exit ${smoke.exitCode}).\n\nNo existe tag \`pipeline-stable\` (primer deploy). Revisar manualmente.`);
      } else {
        const causa = smokeBudget.describeExitCode(smoke.exitCode);
        enqueueTelegramAlert(`🚨 *Pipeline restart FALLÓ tras retry — lanzando rollback orphan*\n\n${causa} (exit ${smoke.exitCode}).\n\nVolviendo a \`pipeline-stable\`. Progreso en \`logs/rollback.log\`.`);
        // Lanzamos rollback como orphan detached y salimos. El rollback
        // notifica por Telegram cuando termina (OK o FAIL).
        launchRollbackOrphan();
      }
    }
  }
}

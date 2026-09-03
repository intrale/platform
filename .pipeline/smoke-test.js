#!/usr/bin/env node
// smoke-test.js — Verificación post-restart del pipeline V2 (Node puro)
//
// Reemplazo de smoke-test.sh. Eliminamos la cadena bash + wmic + node
// anidada que se rompía por el quoting bajo cmd.exe. Este script usa
// únicamente el fs + el módulo ready-marker (cada componente del
// pipeline escribe su propio marker al terminar de inicializar).
//
// Chequeos:
//   1. Todos los componentes del pipeline escribieron su .ready marker
//      y su PID sigue vivo.
//   2. Dashboard responde HTTP 200 en :3200 (/api/health, gate liviano O(1);
//      /api/state se chequea como secundario no-bloqueante). Ver #4096.
//   3. last-restart.json existe y es reciente.
//   4. No quedaron mensajes huérfanos en commander/trabajando/ (warn).
//
// Exit codes:
//   0 → pipeline sano (todos los componentes ready + dashboard responde)
//   1 → componente no llegó a "ready" en el timeout, o su PID murió (stale)
//   2 → dashboard no responde en :3200 (/api/health caído)
//   3 → last-restart.json ausente
//   4 → self-check de un skill determinístico falló
//   5 → el smoke NO COMPLETÓ sus chequeos (se autolimitó o lo interrumpieron).
//       Distinto de 1..4: no hay veredicto sobre el pipeline, así que el caller
//       NO debe tratarlo como evidencia de que el código esté roto (#5725).
//
// Uso:
//   node .pipeline/smoke-test.js                       → chequeo estándar
//   node .pipeline/smoke-test.js --timeout 90          → espera hasta 90s
//   node .pipeline/smoke-test.js --components=a,b,c    → solo esos
//   node .pipeline/smoke-test.js --no-http             → salta chequeo HTTP

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { componentState, waitForMarkers } = require('./lib/ready-marker');
const { isMarkerArtifact } = require('./lib/marker-artifact');
const budget = require('./lib/smoke-budget');
// SEC-10 (#5725) — el volcado de CA-4 NO es una frontera de confianza: su salida
// la copia `restart.js` a `restart.log`, que SÍ está en `TAIL_ALLOWED_FILES` y
// por lo tanto sale por Telegram vía `/tail`. Redactamos en el punto de ESCRITURA,
// igual que `pulpo.js` con `pulpo.log`, en vez de confiar sólo en el redactor de
// egreso. Requires defensivos: este módulo corre en el camino de emergencia y una
// falla de carga no puede dejar el smoke sin diagnóstico (ver `redactLogLine`).
const { redactSecretValue } = require('./lib/redact');
let _redactReadOutput = null;
try { _redactReadOutput = require('./lib/commander/redact-read').redactReadOutput; } catch { /* opcional */ }

const PIPELINE_DIR = __dirname;
const LOG_FILE = path.join(PIPELINE_DIR, 'logs', 'smoke-test.log');

// --- Resolución del directorio de RUNTIME del pipeline (#4686) ---
// El estado vivo del pipeline (last-restart.json, ready markers, colas) vive en
// el checkout CANÓNICO desde el que corre la infra. En producción el smoke test
// corre desde ese checkout y PIPELINE_DIR ya es correcto. Cuando corre desde un
// worktree de agente (self-check de pipeline-dev) el worktree sólo tiene el
// CÓDIGO: el estado runtime no existe ahí. Resolvemos el .pipeline canónico para
// chequear el pipeline realmente vivo, sin alterar el path de producción
// (fast-path sin git cuando el marker local existe).
function resolveRuntimeDir(scriptDir = PIPELINE_DIR, env = process.env) {
  // 1) Override explícito (operación manual / tests).
  if (env.PIPELINE_RUNTIME_DIR) return env.PIPELINE_RUNTIME_DIR;
  // 2) Producción / checkout canónico: el marker de runtime está presente. Sin git.
  if (fs.existsSync(path.join(scriptDir, 'last-restart.json'))) return scriptDir;
  // 3) Worktree de agente: resolver el .pipeline del checkout principal vía git.
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: scriptDir, encoding: 'utf8', timeout: 5000,
    });
    if (r.status === 0 && r.stdout) {
      let commonDir = r.stdout.trim();
      if (commonDir && !path.isAbsolute(commonDir)) {
        commonDir = path.resolve(scriptDir, commonDir);
      }
      const mainRoot = path.dirname(commonDir);
      const candidate = path.join(mainRoot, '.pipeline');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* git ausente o worktree raro → fallback abajo */ }
  // 4) Fallback: el propio directorio (comportamiento previo).
  return scriptDir;
}

const RUNTIME_DIR = resolveRuntimeDir();
const RUNTIME_READY_DIR = path.join(RUNTIME_DIR, 'ready');

// Componentes que deben escribir marker tras initialize.
// Debe estar sincronizado con restart.js COMPONENTS y con las llamadas
// signalReady() inyectadas en cada componente.
const DEFAULT_COMPONENTS = [
  'pulpo',
  'listener',
  'svc-telegram',
  'svc-github',
  'svc-drive',
  'svc-emulador',
  'svc-reconciler',
  'dashboard',
];

// Skills determinísticos a verificar con --self-check (acción 3 — relax CODEOWNERS).
// Si alguno falla, el smoke test rebota → restart dispara rollback al tag pipeline-stable.
// Esto es el reemplazo del bloqueo CODEOWNERS sobre `.pipeline/`: el rollback cubre
// componentes residentes Y skills determinísticos.
const SELF_CHECK_SKILLS = [
  { name: 'tester',   path: 'skills-deterministicos/tester.js' },
  { name: 'build',    path: 'skills-deterministicos/build.js' },
  { name: 'delivery', path: 'skills-deterministicos/delivery.js' },
  { name: 'linter',   path: 'skills-deterministicos/linter.js' },
];

function parseArgs(argv) {
  // El default sale de lib/smoke-budget (#5725): es el mismo valor del que
  // `restart.js` deriva su ventana, así que no pueden desincronizarse.
  const args = {
    timeoutMs: budget.MARKER_LIGHT_TIMEOUT_MS,
    components: null,
    http: true,
    selfCheck: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout' && argv[i + 1]) { args.timeoutMs = parseInt(argv[++i], 10) * 1000; }
    else if (a.startsWith('--timeout=')) { args.timeoutMs = parseInt(a.split('=')[1], 10) * 1000; }
    else if (a === '--components' && argv[i + 1]) { args.components = argv[++i].split(','); }
    else if (a.startsWith('--components=')) { args.components = a.split('=')[1].split(','); }
    else if (a === '--no-http') { args.http = false; }
    else if (a === '--no-self-check') { args.selfCheck = false; }
  }
  return args;
}

function runSelfChecks() {
  const failed = [];
  for (const skill of SELF_CHECK_SKILLS) {
    const scriptPath = path.join(PIPELINE_DIR, skill.path);
    if (!fs.existsSync(scriptPath)) {
      log(`  SKIP ${skill.name} (script no existe: ${skill.path})`);
      continue;
    }
    const r = spawnSync(process.execPath, [scriptPath, '--self-check'], {
      cwd: PIPELINE_DIR,
      timeout: budget.SELF_CHECK_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      log(`  OK self-check ${skill.name}`);
    } else {
      const tail = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).slice(-5).join(' | ');
      log(`  FAIL self-check ${skill.name} (exit ${r.status}): ${tail.slice(0, 300)}`);
      failed.push(skill.name);
    }
  }
  return failed;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

function fail(msg, code = 1) {
  log(`FAIL: ${msg}`);
  process.exit(code);
}

// --- CA-4: cola del log del componente que no llegó a ready ---
//
// En el incidente del 2026-08-09 el `EADDRINUSE` del dashboard estaba escrito
// en `dashboard.log` desde el primer segundo, pero el smoke —que es el gate que
// decide el rollback— no lo mencionaba, y el operador tardó horas en cruzar los
// dos archivos. Adjuntamos las últimas líneas del log del componente caído
// dentro del propio diagnóstico del smoke.
//
// `pulpo.log` pesa ~6,4 MB: leemos SÓLO el último bloque con un read posicional.
// Un `readFileSync().split('\n')` acá cargaría el archivo entero en memoria
// dentro del camino de emergencia, que es justo cuando el sistema está peor.
const TAIL_MAX_LINES = 12;
const TAIL_MAX_BYTES = 16 * 1024;
const TAIL_MAX_LINE_CHARS = 200;

// Neutraliza control chars: una línea de log con CR/LF o ANSI embebido no puede
// falsificar la estructura del diagnóstico del smoke (el operador lee ese log
// para decidir, así que su formato tiene que ser confiable). Filtramos por
// código de carácter y no por regex con escapes, que es más difícil de auditar.
function stripControlChars(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const esTab = c === 9;
    const esControl = c < 32 || c === 127;
    if (!esControl || esTab) out += ch;
  }
  return out;
}

// SEC-10 (#5725) — redacta UNA línea de log de componente antes de volcarla al
// diagnóstico. El tail se dispara justo cuando un componente NO llegó a ready, y
// los que manejan credenciales (svc-drive/OAuth, svc-github/token gh,
// svc-telegram/bot token) fallan al arrancar típicamente por errores de auth:
// exactamente cuando el log escupe el payload o el header con la credencial.
//
// Cadena en 3 pasos, la misma que ya usa el repo para texto leído de FS que va a
// salir por Telegram (`renderCanonicalCitation` en commander-deterministic.js):
//   1. `redactReadOutput` — construido para tails de log: cubre ghp_/gho_, AKIA,
//      JWT, bot tokens de Telegram, `password=`/`secret=`/`token=`, emails.
//   2. `redactSecretValue` — patrones de valor por proveedor (sk-ant-, sk-, gsk_,
//      AKIA, JWT, ARNs). Es el control que cita SEC-10 y el que aplica el caso
//      análogo de `kernel-degradation-alert.js`, de forma categórica.
//   3. `redactSecretValue` token-a-token — la heurística de entropía de Shannon
//      exige un token >40 chars SIN espacios, así que sobre la línea entera NUNCA
//      dispara. Token-a-token sí atrapa el secreto OPACO sin formato conocido
//      (mismo motivo por el que `pulpo.js:10753` hace este split).
//
// Cobertura parcial y conocida: `GOCSPX-` (client secret de Google) no está en
// ninguna de las dos tablas de patrones. Ese hueco es preexistente e
// independiente de este volcado, y quedó registrado en #5758.
//
// Defensivo a propósito: si un redactor tira, devolvemos la línea NEUTRALIZADA
// pero marcada, nunca la cruda — el camino de emergencia no puede convertirse en
// la fuga que intenta prevenir, y tampoco puede tumbar el smoke.
function redactLogLine(line) {
  try {
    // `stripControlChars` va DENTRO del try: hace `String(s)`, que ejecuta un
    // `toString` ajeno y por lo tanto puede tirar. Afuera, esa excepción subía
    // por el `.map()` de `tailComponentLog` y tumbaba el diagnóstico entero —
    // justo en el camino de emergencia, que es cuando más se lo necesita.
    let out = stripControlChars(line);
    if (typeof _redactReadOutput === 'function') {
      const r = _redactReadOutput(out);
      if (r && typeof r.text === 'string') out = r.text;
    }
    out = redactSecretValue(out);
    // Paso 3: preservamos los separadores para no destruir el formato del log.
    out = out.split(/(\s+)/).map(tok => (tok.trim() ? redactSecretValue(tok) : tok)).join('');
    return out;
  } catch {
    return '[REDACTED: falló el redactor, línea omitida]';
  }
}

function readTailBytes(file, maxBytes = TAIL_MAX_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len === 0) return { text: '', truncated: false };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), truncated: size > len };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Devuelve { file, lines, reason }. `reason` explica por qué no hay líneas.
function tailComponentLog(name, {
  maxLines = TAIL_MAX_LINES,
  logsDir = path.join(RUNTIME_DIR, 'logs'),
} = {}) {
  const file = path.join(logsDir, `${name}.log`);
  const read = readTailBytes(file);
  if (read === null) return { file, lines: [], reason: 'no se pudo leer el log' };
  // Si cortamos por bytes, la primera línea del bloque viene partida al medio.
  const raw = read.text.split(/\r?\n/);
  const usable = read.truncated ? raw.slice(1) : raw;
  const lines = usable
    .filter(l => l.trim().length > 0)
    .slice(-maxLines)
    // Neutralizamos control chars (una línea de log con CR/LF o ANSI embebido no
    // puede falsificar la estructura del diagnóstico) y REDACTAMOS secretos
    // (SEC-10 #5725) antes de que esto llegue a `restart.log` → Telegram.
    // El orden importa: redactar ANTES de recortar. Al revés, el corte podría
    // partir un secreto por la mitad, romper el match del patrón y dejar el
    // prefijo de la credencial en claro.
    .map(l => redactLogLine(l).slice(0, TAIL_MAX_LINE_CHARS));
  return { file, lines, reason: lines.length ? null : 'log vacío' };
}

// Emite la cola indentada BAJO la línea del componente y acotada (guideline UX):
// un volcado de 200 líneas por componente entierra el resto del diagnóstico.
function logComponentTail(name) {
  const t = tailComponentLog(name);
  if (!t.lines.length) {
    log(`    └ sin pistas en logs/${name}.log (${t.reason})`);
    return;
  }
  log(`    └ últimas ${t.lines.length} líneas de logs/${name}.log:`);
  for (const line of t.lines) log(`      ${line}`);
}

// Reporte de un componente, compartido por el camino normal y el volcado
// parcial, para que el operador no tenga que aprender un segundo formato
// justo cuando está leyendo el log a las 2 AM (guideline UX).
//
// `pendingLabel` distingue dos situaciones que NO son la misma:
//   MISSING   → se agotó su ventana sin marker: hay veredicto, no completó init.
//   PENDIENTE → seguíamos esperándolo cuando nos interrumpieron: sin veredicto.
function reportComponent(name, st, waitedSec, { pendingLabel = 'MISSING', withTail = true } = {}) {
  if (st.state === 'ready') {
    log(`  OK ${name} (PID ${st.marker.pid}, ready en ${new Date(st.marker.readyAt).toTimeString().slice(0, 8)})`);
    return;
  }
  if (st.state === 'stale') {
    log(`  STALE ${name} (PID ${st.marker?.pid || '?'} muerto — crash post-ready o no-arrancó)`);
  } else if (pendingLabel === 'PENDIENTE') {
    log(`  PENDIENTE ${name} (seguía sin marker ready tras ${waitedSec}s)`);
  } else {
    log(`  MISSING ${name} (sin marker ready tras ${waitedSec}s — no completó init)`);
  }
  if (withTail) logComponentTail(name);
}

// --- CA-2: el log nunca puede quedar en "Esperando marker ready…" ---
//
// OJO: `process.on('SIGTERM')` NO sirve como único mecanismo en este entorno.
// Verificado empíricamente: Node en Windows no tiene señales POSIX, y el
// `timeout` de spawnSync mata al hijo con TerminateProcess (incondicional,
// equivalente a SIGKILL). El handler del hijo nunca corre — el `signal=SIGTERM`
// que ve `restart.js` es lo que observa el PADRE, no algo interceptable.
//
// Por eso el mecanismo principal es COOPERATIVO: el smoke se autolimita a una
// ventana propia, estrictamente menor que la del runner, y vuelca él mismo el
// estado parcial antes de salir. Los handlers de señal quedan como red de
// seguridad para POSIX y para el Ctrl-C manual del operador.
const progress = {
  phase: 'arranque',
  startedAt: Date.now(),
  components: [],
  dumped: false,
};

function safeComponentState(name) {
  try { return componentState(name, RUNTIME_READY_DIR); } catch { return { state: 'missing', marker: null }; }
}

function dumpPartialState(motivo, { exitCode = budget.EXIT_INCOMPLETE, exit = true } = {}) {
  if (progress.dumped) return;
  progress.dumped = true;
  const waitedSec = Math.round((Date.now() - progress.startedAt) / 1000);

  // Veredicto propio y distinguible: NUNCA reutilizamos "=== SMOKE TEST OK ==="
  // ni el "FAIL:" de un fallo real, que significan otra cosa.
  log(`=== SMOKE TEST INTERRUMPIDO (${motivo} tras ${waitedSec}s) ===`);
  log(`  fase alcanzada: ${progress.phase}`);

  const sinResolver = [];
  for (const name of progress.components) {
    const st = safeComponentState(name);
    reportComponent(name, st, waitedSec, { pendingLabel: 'PENDIENTE' });
    if (st.state !== 'ready') sinResolver.push(name);
  }

  const detalle = sinResolver.length
    ? ` Sin resolver: ${sinResolver.join(', ')}.`
    : ' Todos los componentes tenían marker ready.';
  log(`INCOMPLETO: el smoke test no llegó a terminar sus chequeos (fase ${progress.phase}, ${waitedSec}s).`
    + detalle
    + ' No hay evidencia de que el código sea la causa — no corresponde rollback automático.');

  if (exit) process.exit(exitCode);
}

let watchdogTimer = null;
function armWatchdog(budgetMs) {
  watchdogTimer = setTimeout(() => {
    dumpPartialState(`agotó su ventana propia de ${Math.round(budgetMs / 1000)}s`);
  }, budgetMs);
  return watchdogTimer;
}
function disarmWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// Red de seguridad para POSIX / Ctrl-C. No-op cuando el SO mata sin avisar.
function armSignalHandlers() {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => dumpPartialState(`señal ${sig}`)); } catch { /* señal no soportada */ }
  }
}

// Heartbeat: `log()` hace appendFileSync línea por línea, así que TODO lo que se
// loguea sobrevive incluso a una muerte abrupta. El log se cortaba porque entre
// "Esperando marker ready…" y el reporte final no se escribía nada durante hasta
// 120s. Con esto, aun en el peor caso el operador ve el último estado conocido.
function armHeartbeat(components, everyMs = 15000) {
  const timer = setInterval(() => {
    const pendientes = components.filter(n => safeComponentState(n).state !== 'ready');
    const waited = Math.round((Date.now() - progress.startedAt) / 1000);
    if (pendientes.length) {
      log(`  ... ${waited}s — faltan ${pendientes.length}/${components.length}: ${pendientes.join(', ')}`);
    } else {
      log(`  ... ${waited}s — todos los markers presentes`);
    }
  }, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

async function checkDashboardHttp(port, timeoutMs = 5000, urlPath = '/api/health') {
  return new Promise(resolve => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: urlPath,
      timeout: timeoutMs,
    }, res => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: e.code || 'error' }));
  });
}

// Gate de rollback resiliente al pico de arranque (#4131).
// El dashboard responde /api/health en ~0,2-0,7s ya estabilizado, pero durante
// el arranque (pulpo + 7 servicios peleando CPU al mismo tiempo) ese tiempo se
// estira y un único tiro de 5s gatillaba un FALSO rollback. Reintentamos varias
// veces con espera corta: damos una ventana holgada (~30s) para que el health
// responda 200 cuando sólo está lento por contención, pero un dashboard
// realmente caído (ECONNREFUSED inmediato) sigue fallando todas las pasadas y
// el gate lo detecta igual. No relaja la condición de salud, sólo la espera.
// Los defaults salen de lib/smoke-budget (#5725): son los MISMOS valores con
// los que se dimensiona el presupuesto, así que el gasto real de la sonda no
// puede superar lo presupuestado sin que ambos se muevan juntos.
async function checkDashboardHttpWithRetry(port, urlPath, {
  attempts = budget.HTTP_RETRY.attempts,
  perAttemptMs = budget.HTTP_RETRY.perAttemptMs,
  delayMs = budget.HTTP_RETRY.delayMs,
} = {}) {
  let last = { ok: false, status: 'unknown' };
  for (let i = 1; i <= attempts; i++) {
    last = await checkDashboardHttp(port, perAttemptMs, urlPath);
    if (last.ok) {
      if (i > 1) log(`  ${urlPath} respondió 200 en intento ${i}/${attempts}`);
      return last;
    }
    if (i < attempts) {
      log(`  ${urlPath} intento ${i}/${attempts} status=${last.status} — reintento en ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return last;
}

// #4520 — Espera de markers con ventana DIFERENCIADA para el dashboard.
//
// El dashboard es el proceso más pesado y, bajo la contención del arranque
// (pulpo + 7 servicios peleando CPU al mismo tiempo), su boot se estira más
// allá de los 60s planos que a los componentes livianos les alcanzan de sobra
// (ready en ~5-7s). #4130 hizo resiliente al pico de arranque SÓLO la sonda
// HTTP (/api/health, gate B / exit 2) pero dejó este gate de markers (gate A /
// exit 1) con 60s parejos → un dashboard sano-pero-lento gatillaba un rollback
// espurio a pipeline-stable. Darle una ventana mayor NO relaja la detección: un
// dashboard realmente caído sigue sin escribir marker tras dashTimeoutMs y el
// gate lo detecta igual; sólo absorbe la contención, igual que el retry con
// backoff de #4130 absorbe la del HTTP.
//
// `waitFn`/`now` son inyectables para test (por defecto: IO real de markers).
async function waitForComponentMarkers(components, {
  lightTimeoutMs = 60000,
  dashTimeoutMs = 120000,
  waitFn = waitForMarkers,
  now = Date.now,
  readyDir = RUNTIME_READY_DIR,
} = {}) {
  const start = now();
  const hasDashboard = components.includes('dashboard');
  const lightComponents = components.filter(n => n !== 'dashboard');

  // 1a) Componentes livianos — timeout estándar. `readyDir` apunta al runtime
  // canónico (#4686), relevante cuando el smoke corre desde un worktree.
  const resLight = lightComponents.length
    ? await waitFn(lightComponents, lightTimeoutMs, 1000, readyDir)
    : { ok: true, results: {} };

  // 1b) Dashboard — ventana extendida. Ya venía booteando durante 1a, así que
  // descontamos lo transcurrido para acotar el peor caso (dashboard caído) y no
  // encadenar dos timeouts en serie.
  let resDash = { ok: true, results: {} };
  if (hasDashboard) {
    const dashRemaining = Math.max(5000, dashTimeoutMs - (now() - start));
    resDash = await waitFn(['dashboard'], dashRemaining, 1000, readyDir);
  }

  return {
    ok: resLight.ok && resDash.ok,
    results: { ...resLight.results, ...resDash.results },
    waitedMs: now() - start,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const components = args.components || DEFAULT_COMPONENTS;

  const { dashTimeoutMs } = budget.resolveMarkerTimeouts();
  const selfBudgetMs = budget.smokeBudgetMs({
    http: args.http,
    selfCheck: args.selfCheck,
    // Conteo REAL de esta corrida, no la constante: si mañana se suma un skill
    // a SELF_CHECK_SKILLS, el presupuesto crece solo y el watchdog no corta en
    // medio de self-checks legítimos (#5725).
    selfCheckCount: SELF_CHECK_SKILLS.length,
    lightTimeoutMs: args.timeoutMs,
    dashTimeoutMs,
  });

  progress.startedAt = Date.now();
  progress.components = components;
  progress.phase = 'espera de markers';
  armSignalHandlers();
  armWatchdog(selfBudgetMs);

  log('=== SMOKE TEST ===');
  // El operador tiene que saber de entrada cuánto puede llegar a esperar y por
  // qué; si no, un smoke lento es indistinguible de uno colgado.
  log(`Ventana propia del smoke: ${Math.round(selfBudgetMs / 1000)}s `
    + `(markers ${Math.round(budget.markerWaitBudgetMs({ lightTimeoutMs: args.timeoutMs, dashTimeoutMs }) / 1000)}s `
    + `+ chequeos posteriores ${Math.round(budget.postWaitBudgetMs({
      http: args.http,
      selfCheck: args.selfCheck,
      selfCheckCount: SELF_CHECK_SKILLS.length,
    }) / 1000)}s)`);
  log(`Esperando marker ready de: ${components.join(', ')} `
    + `(livianos ${args.timeoutMs / 1000}s, dashboard ${dashTimeoutMs / 1000}s)`);

  // 1) Componentes listos — polling sobre los markers, con ventana propia y más
  // holgada para el dashboard (ver waitForComponentMarkers / #4520).
  const start = progress.startedAt;
  const heartbeat = armHeartbeat(components);
  const res = await waitForComponentMarkers(components, {
    lightTimeoutMs: args.timeoutMs,
    dashTimeoutMs,
  });
  clearInterval(heartbeat);
  const waitedSec = Math.round((Date.now() - start) / 1000);

  // Log del estado final componente por componente. Los que no llegaron a ready
  // se acompañan de la cola de su log (CA-4).
  for (const name of components) {
    const st = res.results[name] || { state: 'missing' };
    reportComponent(name, st, waitedSec);
  }

  if (!res.ok) {
    const bad = components.filter(n => res.results[n]?.state !== 'ready');
    fail(`Componentes no-ready tras ${waitedSec}s: ${bad.join(', ')}`, 1);
  }

  // 2) Dashboard HTTP — gate de rollback contra /api/health (#4096).
  // ANTES: el gate apuntaba a /api/state, que reconstruía todo el histórico
  // sincrónicamente en cada request (O(N archivos)). Con la cola crecida eso
  // clavaba un núcleo de CPU al 100% y /api/state nunca devolvía 200 dentro del
  // timeout → fail(...,2) → rollback en loop del restart (cambios nunca
  // aplicados). AHORA el gate usa /api/health: endpoint O(1) garantizado
  // liviano (no toca el FS), así que un timeout de 5s vuelve a ser sano y un
  // fallo acá indica un problema real (dashboard caído), no carga histórica.
  // /api/state queda como chequeo SECUNDARIO no-bloqueante (warn): puede
  // devolver { ready:false } en cold start o el snapshot ya armado; nunca
  // dispara rollback.
  if (args.http) {
    progress.phase = 'sonda HTTP del dashboard';
    log('Verificando dashboard HTTP :3200 (/api/health)...');
    const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
    const healthRes = await checkDashboardHttpWithRetry(dashPort, '/api/health');
    if (!healthRes.ok) {
      fail(`Dashboard /api/health no responde en :${dashPort} tras reintentos (status=${healthRes.status})`, 2);
    }
    log(`  OK dashboard /api/health HTTP 200`);

    // Chequeo secundario no-bloqueante: /api/state sirve desde el snapshot en
    // memoria (O(1)). No gatea rollback; sólo informa. Cold start legítimo
    // devuelve { ready:false } con 200.
    const stateRes = await checkDashboardHttp(dashPort, budget.HTTP_SECONDARY_TIMEOUT_MS, '/api/state');
    if (stateRes.ok) {
      log(`  OK dashboard /api/state HTTP 200 (snapshot)`);
    } else {
      log(`  WARN dashboard /api/state status=${stateRes.status} (secundario, no bloquea rollback)`);
    }
  }

  // 3) last-restart.json — resuelto contra el runtime canónico (#4686).
  progress.phase = 'chequeo de last-restart.json';
  const lastRestart = path.join(RUNTIME_DIR, 'last-restart.json');
  if (!fs.existsSync(lastRestart)) {
    fail(`last-restart.json ausente (runtime_dir=${RUNTIME_DIR})`, 3);
  }
  const ageSec = Math.round((Date.now() - fs.statSync(lastRestart).mtimeMs) / 1000);
  if (ageSec > 300) {
    log(`  WARN last-restart.json tiene ${ageSec}s (esperado < 300)`);
  } else {
    log(`  OK last-restart.json (${ageSec}s)`);
  }

  // 4) Huérfanos en commander/trabajando/ (solo warn) — runtime canónico.
  const orphanDir = path.join(RUNTIME_DIR, 'servicios', 'commander', 'trabajando');
  try {
    if (fs.existsSync(orphanDir)) {
      // Excluir marker artifacts: no son mensajes operacionales huérfanos.
      const orphans = fs.readdirSync(orphanDir).filter(f => f.endsWith('.json') && !isMarkerArtifact(f)).length;
      if (orphans > 0) {
        log(`  WARN ${orphans} mensaje(s) en commander/trabajando/ (esperado 0 post-restart)`);
      }
    }
  } catch {}

  // 5) Self-checks de skills determinísticos. Cobertura post-merge para
  // cambios en .pipeline/ que el rollback de componentes residentes no toca.
  if (args.selfCheck) {
    progress.phase = 'self-checks de skills determinísticos';
    log('Ejecutando self-checks de skills determinísticos...');
    const failed = runSelfChecks();
    if (failed.length > 0) {
      fail(`Self-checks fallaron: ${failed.join(', ')}`, 4);
    }
  }

  disarmWatchdog();
  log('=== SMOKE TEST OK ===');
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    log(`Smoke test error: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  checkDashboardHttp,
  checkDashboardHttpWithRetry,
  waitForComponentMarkers,
  resolveRuntimeDir,
  // Expuestos para test (#5725).
  stripControlChars,
  redactLogLine,
  readTailBytes,
  tailComponentLog,
  dumpPartialState,
  progress,
  // Lista real de self-checks: la expone para que smoke-budget.test.js pueda
  // assertear SELF_CHECK_SKILLS.length === budget.SELF_CHECK_COUNT (#5725).
  SELF_CHECK_SKILLS,
};

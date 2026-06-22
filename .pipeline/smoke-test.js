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

const PIPELINE_DIR = __dirname;
const LOG_FILE = path.join(PIPELINE_DIR, 'logs', 'smoke-test.log');

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
  const args = { timeoutMs: 60000, components: null, http: true, selfCheck: true };
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
      timeout: 30000,
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
async function checkDashboardHttpWithRetry(port, urlPath, { attempts = 5, perAttemptMs = 5000, delayMs = 1500 } = {}) {
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

async function main() {
  const args = parseArgs(process.argv);
  const components = args.components || DEFAULT_COMPONENTS;

  log('=== SMOKE TEST ===');
  log(`Esperando marker ready de: ${components.join(', ')} (timeout ${args.timeoutMs / 1000}s)`);

  // 1) Componentes listos — polling sobre los markers.
  const start = Date.now();
  const res = await waitForMarkers(components, args.timeoutMs, 1000);
  const waitedSec = Math.round((Date.now() - start) / 1000);

  // Log del estado final componente por componente.
  for (const name of components) {
    const st = res.results[name] || { state: 'missing' };
    if (st.state === 'ready') {
      log(`  OK ${name} (PID ${st.marker.pid}, ready en ${new Date(st.marker.readyAt).toTimeString().slice(0, 8)})`);
    } else if (st.state === 'stale') {
      log(`  STALE ${name} (PID ${st.marker?.pid || '?'} muerto — crash post-ready o no-arrancó)`);
    } else {
      log(`  MISSING ${name} (sin marker ready tras ${waitedSec}s — no completó init)`);
    }
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
    const stateRes = await checkDashboardHttp(dashPort, 5000, '/api/state');
    if (stateRes.ok) {
      log(`  OK dashboard /api/state HTTP 200 (snapshot)`);
    } else {
      log(`  WARN dashboard /api/state status=${stateRes.status} (secundario, no bloquea rollback)`);
    }
  }

  // 3) last-restart.json.
  const lastRestart = path.join(PIPELINE_DIR, 'last-restart.json');
  if (!fs.existsSync(lastRestart)) {
    fail('last-restart.json ausente', 3);
  }
  const ageSec = Math.round((Date.now() - fs.statSync(lastRestart).mtimeMs) / 1000);
  if (ageSec > 300) {
    log(`  WARN last-restart.json tiene ${ageSec}s (esperado < 300)`);
  } else {
    log(`  OK last-restart.json (${ageSec}s)`);
  }

  // 4) Huérfanos en commander/trabajando/ (solo warn).
  const orphanDir = path.join(PIPELINE_DIR, 'servicios', 'commander', 'trabajando');
  try {
    if (fs.existsSync(orphanDir)) {
      const orphans = fs.readdirSync(orphanDir).filter(f => f.endsWith('.json')).length;
      if (orphans > 0) {
        log(`  WARN ${orphans} mensaje(s) en commander/trabajando/ (esperado 0 post-restart)`);
      }
    }
  } catch {}

  // 5) Self-checks de skills determinísticos. Cobertura post-merge para
  // cambios en .pipeline/ que el rollback de componentes residentes no toca.
  if (args.selfCheck) {
    log('Ejecutando self-checks de skills determinísticos...');
    const failed = runSelfChecks();
    if (failed.length > 0) {
      fail(`Self-checks fallaron: ${failed.join(', ')}`, 4);
    }
  }

  log('=== SMOKE TEST OK ===');
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    log(`Smoke test error: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { checkDashboardHttp, checkDashboardHttpWithRetry };

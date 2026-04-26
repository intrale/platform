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
//   2. Dashboard responde HTTP 200 en :3200 (/api/state).
//   3. last-restart.json existe y es reciente.
//   4. No quedaron mensajes huérfanos en commander/trabajando/ (warn).
//
// Exit codes:
//   0 → pipeline sano (todos los componentes ready + dashboard responde)
//   1 → componente no llegó a "ready" en el timeout, o su PID murió (stale)
//   2 → dashboard no responde en :3200
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
  'dashboard',
];

function parseArgs(argv) {
  const args = { timeoutMs: 60000, components: null, http: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout' && argv[i + 1]) { args.timeoutMs = parseInt(argv[++i], 10) * 1000; }
    else if (a.startsWith('--timeout=')) { args.timeoutMs = parseInt(a.split('=')[1], 10) * 1000; }
    else if (a === '--components' && argv[i + 1]) { args.components = argv[++i].split(','); }
    else if (a.startsWith('--components=')) { args.components = a.split('=')[1].split(','); }
    else if (a === '--no-http') { args.http = false; }
  }
  return args;
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

async function checkDashboardHttp(port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/state',
      timeout: timeoutMs,
    }, res => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: e.code || 'error' }));
  });
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

  // 2) Dashboard HTTP. Timeout holgado (30s) porque /api/state lee bastante
  // estado del filesystem (issueMatrix + servicios + bloqueados-humano +
  // métricas). Con la cola creciendo se acerca al límite anterior de 5s y
  // dispara rollbacks falsos positivos. 30s es margen amplio sin retrasar
  // demasiado el restart cuando hay un problema real.
  if (args.http) {
    log('Verificando dashboard HTTP :3200...');
    const dashPort = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
    const httpRes = await checkDashboardHttp(dashPort, 30000);
    if (!httpRes.ok) {
      fail(`Dashboard no responde en :${dashPort} (status=${httpRes.status})`, 2);
    }
    log(`  OK dashboard HTTP 200`);
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

  log('=== SMOKE TEST OK ===');
  process.exit(0);
}

main().catch(e => {
  log(`Smoke test error: ${e.stack || e.message}`);
  process.exit(1);
});

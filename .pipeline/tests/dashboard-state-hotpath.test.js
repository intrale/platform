'use strict';

// =============================================================================
// dashboard-state-hotpath.test.js — guardrail anti-regresión (#4096).
//
// Contexto: /api/state reconstruía TODO el histórico de forma sincrónica en
// cada request (getPipelineState() directo). Con la cola crecida eso clavaba un
// núcleo de CPU al 100% y el endpoint nunca devolvía 200 dentro del timeout del
// smoke (paso 2) → fail(...,2) → rollback en loop del restart. La solución
// estructural saca el cómputo pesado del request: un worker en background
// puebla `_stateSnapshot` y el handler lo sirve en O(1); el smoke gatea contra
// /api/health (liviano garantizado).
//
// Este test congela ese contrato para que ninguna ola futura reintroduzca el
// escaneo pesado en el hot path:
//   A. GUARDRAIL ESTÁTICO — el bloque del handler /api/state NO contiene la
//      llamada getPipelineState() directa; sirve desde _stateSnapshot; cold
//      start devuelve { ready:false } sin computar.
//   B. ESTRUCTURA — refreshStateSnapshot (setImmediate + inflight), arranque
//      del worker en startListen, clearInterval en SIGINT/SIGTERM, /api/health
//      O(1) sin FS, SEC-1 (/^\d+$/) en fetchIssueTitles.
//   C. FUNCIONAL — levantando el dashboard real: /api/health responde 200 con
//      shape { ok:true, uptime:<number> } y sin claves sensibles; /api/state
//      responde 200 con JSON válido sin colgarse.
// =============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PIPELINE_SRC = path.resolve(__dirname, '..');
const dashboardPath = path.join(PIPELINE_SRC, 'dashboard.js');
const src = fs.readFileSync(dashboardPath, 'utf8');

// Recorta el cuerpo del handler `/api/state` (desde el `if (req.url === '/api/state'`
// hasta el cierre del bloque) para acotar las aserciones al hot path.
function stateHandlerBlock() {
  const start = src.indexOf("if (req.url === '/api/state' || req.url === '/api/status') {");
  assert.ok(start > 0, 'el handler de /api/state debe existir');
  // El bloque cierra en el primer `\n  }\n` posterior (indentación del handler).
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'el cierre del handler /api/state debe encontrarse');
  return src.slice(start, end);
}

// ── A. GUARDRAIL ESTÁTICO ─────────────────────────────────────────────────────

test('GUARDRAIL — /api/state NO invoca getPipelineState() en el hot path', () => {
  const body = stateHandlerBlock();
  assert.doesNotMatch(
    body,
    /getPipelineState\s*\(/,
    'REGRESIÓN #4096: el handler de /api/state reintrodujo getPipelineState() en el ' +
    'request. Eso vuelve a clavar la CPU y a colgar el smoke (paso 2) → rollback en ' +
    'loop. El estado debe servirse desde _stateSnapshot (worker en background).',
  );
});

test('GUARDRAIL — /api/state sirve desde _stateSnapshot', () => {
  const body = stateHandlerBlock();
  assert.match(body, /_stateSnapshot/, 'debe servir la vista cacheada _stateSnapshot');
  assert.match(
    body,
    /JSON\.stringify\(\s*_stateSnapshot/,
    'debe serializar _stateSnapshot directo (sin recomputar)',
  );
});

test('GUARDRAIL — cold start de /api/state devuelve { ready:false } sin computar', () => {
  const body = stateHandlerBlock();
  assert.match(body, /if\s*\(\s*!_stateSnapshot\s*\)/, 'debe contemplar el cold start');
  assert.match(body, /ready:\s*false/, 'cold start debe responder { ready:false }');
});

// ── B. ESTRUCTURA DEL WORKER / ENDPOINTS ──────────────────────────────────────

test('refreshStateSnapshot usa setImmediate + flag inflight (no bloquea el tick)', () => {
  const start = src.indexOf('function refreshStateSnapshot()');
  assert.ok(start > 0, 'refreshStateSnapshot debe existir');
  const body = src.slice(start, start + 800);
  assert.match(body, /_stateRefreshInflight/, 'debe usar el flag inflight para no solapar');
  assert.match(body, /setImmediate\(/, 'debe sacar el cómputo pesado del tick con setImmediate');
  // #4126 — el worker computa el snapshot con el driver ASÍNCRONO chunked
  // (getPipelineStateAsync cede el loop entre chunks). NUNCA con getPipelineState()
  // sync a fondo: ese bloque monolítico starvaba /api/health y disparaba el
  // rollback en loop del restart.
  assert.match(body, /getPipelineStateAsync\(\)/, 'el worker usa el driver async-chunked (no el sync a fondo)');
  assert.match(body, /_stateSnapshot\s*=\s*snap/, 'swap atómico del snapshot recién al terminar el cómputo');
});

// #4126 — GUARDRAIL: el snapshot se construye con un generador con yields reales
// y dos drivers (sync para legacy, async-chunked para el worker). Congelar esta
// estructura evita que una ola futura vuelva a un escaneo síncrono monolítico.
test('GUARDRAIL #4126 — getPipelineState se construye con generador + driver async-chunked', () => {
  assert.match(src, /function\*\s*_genPipelineState\s*\(/, 'debe existir el generador _genPipelineState');
  // El driver async cede el event loop con setImmediate en cada yield.
  const asyncStart = src.indexOf('async function getPipelineStateAsync()');
  assert.ok(asyncStart > 0, 'getPipelineStateAsync debe existir');
  const asyncBody = src.slice(asyncStart, asyncStart + 400);
  assert.match(asyncBody, /setImmediate/, 'el driver async debe ceder el loop entre chunks');
  assert.match(asyncBody, /\.next\(\)/, 'el driver async debe pumpear el generador');
  // El driver sync corre el generador a fondo (legacy callers).
  assert.match(src, /function getPipelineState\(\)\s*\{[\s\S]*?_genPipelineState\(\)/, 'getPipelineState (sync) maneja el mismo generador');
});

// #4126 — GUARDRAIL: los scans del SO (wmic/tasklist) NO pueden vivir síncronos
// dentro del generador del snapshot — eran el bloqueo principal del event loop.
test('GUARDRAIL #4126 — el generador del snapshot no spawnea wmic/tasklist sync', () => {
  const genStart = src.indexOf('function* _genPipelineState()');
  assert.ok(genStart > 0, 'el generador debe existir');
  // Acotar al cuerpo del generador: hasta la próxima función top-level que le
  // sigue (readGhostArtifactSummary). Los drivers sync/async están definidos
  // ANTES del generador, así que no sirven como cota inferior.
  const genEnd = src.indexOf('\nfunction readGhostArtifactSummary', genStart);
  assert.ok(genEnd > genStart, 'el cierre del generador debe ubicarse');
  const genBody = src.slice(genStart, genEnd);
  // Stripear comentarios (de línea y de bloque) para chequear CÓDIGO real: los
  // comentarios documentan justamente lo que se sacó (execSync(tasklist), etc.).
  const genCode = genBody
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(genCode, /execSync\s*\(/, 'REGRESIÓN #4126: execSync sync dentro del snapshot bloquea el loop');
  assert.doesNotMatch(genCode, /spawnSync\s*\(/, 'REGRESIÓN #4126: spawnSync sync dentro del snapshot bloquea el loop');
  assert.doesNotMatch(genCode, /tasklist/, 'REGRESIÓN #4126: tasklist debe resolverse async (cache), no en el snapshot');
  assert.doesNotMatch(genCode, /invalidateCache\s*\(\)/, 'REGRESIÓN #4126: invalidar el cache de PIDs forzaba un wmic fresco por tick');
  // Procesos + QA env se sirven desde el cache async.
  assert.match(genCode, /_scheduleProcStatusRefresh\s*\(\)/, 'procesos/QA se agendan async');
  assert.match(genCode, /_procStatusCache/, 'procesos/QA se leen del cache async');
});

test('startListen arranca el worker de snapshot (refresh + setInterval unref)', () => {
  const start = src.indexOf('function startListen()');
  assert.ok(start > 0, 'startListen debe existir');
  const body = src.slice(start, start + 900);
  assert.match(body, /refreshStateSnapshot\(\)/, 'primer refresh async en el arranque');
  assert.match(body, /setInterval\(\s*refreshStateSnapshot\s*,\s*STATE_REFRESH_MS\s*\)/, 'refresh periódico');
  assert.match(body, /_stateRefreshTimer\.unref/, 'el timer debe unref-earse para no bloquear el exit');
});

test('SIGINT/SIGTERM limpian el timer del worker (clearInterval)', () => {
  const sigint = src.match(/process\.on\('SIGINT',[^\n]*\)/);
  const sigterm = src.match(/process\.on\('SIGTERM',[^\n]*\)/);
  assert.ok(sigint, 'handler SIGINT presente');
  assert.ok(sigterm, 'handler SIGTERM presente');
  assert.match(sigint[0], /clearInterval\(_stateRefreshTimer\)/, 'SIGINT debe limpiar el timer');
  assert.match(sigterm[0], /clearInterval\(_stateRefreshTimer\)/, 'SIGTERM debe limpiar el timer');
});

test('/api/health existe, es O(1) y no toca el FS', () => {
  const start = src.indexOf("if (req.url === '/api/health') {");
  assert.ok(start > 0, 'el handler /api/health debe existir');
  const body = src.slice(start, start + 500);
  assert.match(body, /process\.uptime\(\)/, 'expone uptime liviano');
  assert.match(body, /ok:\s*true/, 'shape { ok:true }');
  // No debe haber lecturas del FS ni cómputo de estado en el handler.
  assert.doesNotMatch(body, /getPipelineState|fs\.|readYamlSafe|listWorkFiles/, '/api/health no debe tocar el FS');
});

test('SEC-1 — fetchIssueTitles valida IDs numéricos antes de gh/execSync', () => {
  const start = src.indexOf('function fetchIssueTitles(');
  assert.ok(start > 0, 'fetchIssueTitles debe existir');
  const body = src.slice(start, start + 700);
  assert.match(body, /\/\^\\d\+\$\/\.test/, 'debe filtrar IDs con /^\\d+$/ (CWE-78)');
});

// ── C. FUNCIONAL — dashboard real ─────────────────────────────────────────────

const PROHIBIDAS = ['config', 'issueMatrix', 'pid', 'PID', 'path', 'cwd', 'state', 'pipeline', 'rejection'];
let tmpDir, child, port;

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function getJson(p, urlPath, cb) {
  http.get({ host: '127.0.0.1', port: p, path: urlPath, timeout: 5000 }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => cb(null, { status: res.statusCode, body: data }));
  }).on('error', cb).on('timeout', function () { this.destroy(); cb(new Error('timeout')); });
}

before(async () => {
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(PIPELINE_SRC, 'config.yaml'), 'utf8'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash4096-'));
  for (const [pname, pcfg] of Object.entries(config.pipelines)) {
    for (const fase of pcfg.fases) {
      for (const st of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        mkdirp(path.join(tmpDir, pname, fase, st));
      }
    }
  }
  mkdirp(path.join(tmpDir, 'logs'));
  fs.copyFileSync(path.join(PIPELINE_SRC, 'config.yaml'), path.join(tmpDir, 'config.yaml'));

  port = 3400 + Math.floor((Date.now() % 300));
  child = spawn(process.execPath, [dashboardPath], {
    env: {
      ...process.env,
      PIPELINE_STATE_DIR: tmpDir,
      PIPELINE_DIR_OVERRIDE: tmpDir,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1',
      GH_BIN: 'gh-noop-nonexistent',
    },
    stdio: 'ignore',
  });

  await new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      getJson(port, '/api/health', (err, r) => {
        if (!err && r && r.status === 200) return resolve();
        if (++tries > 40) return reject(new Error('dashboard no levantó: ' + (err && err.message)));
        setTimeout(tick, 250);
      });
    };
    setTimeout(tick, 500);
  });
});

after(() => {
  if (child) { try { child.kill(); } catch {} }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('FUNCIONAL — /api/health responde 200 con shape { ok, uptime } y sin info sensible', async () => {
  const r = await new Promise((res, rej) => getJson(port, '/api/health', (e, x) => e ? rej(e) : res(x)));
  assert.strictEqual(r.status, 200, 'HTTP 200');
  const json = JSON.parse(r.body);
  assert.strictEqual(json.ok, true, 'ok:true');
  assert.strictEqual(typeof json.uptime, 'number', 'uptime numérico');
  // CWE-200: shape EXACTO, sin claves extra ni info sensible.
  assert.deepStrictEqual(Object.keys(json).sort(), ['ok', 'uptime'], 'sólo { ok, uptime }');
  for (const k of PROHIBIDAS) {
    assert.ok(!(k in json), `/api/health no debe exponer "${k}"`);
  }
});

test('FUNCIONAL — /api/state responde 200 con JSON válido (sin colgarse)', async () => {
  const t0 = Date.now();
  const r = await new Promise((res, rej) => getJson(port, '/api/state', (e, x) => e ? rej(e) : res(x)));
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 200, 'HTTP 200');
  const json = JSON.parse(r.body); // no debe tirar
  assert.ok(json && typeof json === 'object', 'JSON objeto');
  // O(1): la respuesta llega muy por debajo del límite del smoke (< 2s).
  assert.ok(elapsed < 2000, `/api/state debe responder O(1) (< 2s), tardó ${elapsed}ms`);
});

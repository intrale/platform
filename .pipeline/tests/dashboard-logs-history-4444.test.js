// =============================================================================
// dashboard-logs-history-4444.test.js — Test de integración del endpoint
// GET /logs/history/<issue>/<agente> (#4444).
//
// Levanta el dashboard real contra un state dir temporal con un LOG_DIR poblado
// de archivos attempt-N y verifica:
//   - issue+agente válidos → 200 con la lista de intentos ordenada (CA-F2).
//   - issue no numérico     → 400 (CA-S1, path traversal / IDOR).
//   - agente fuera de la allowlist skills_por_fase → 404 (CA-S1).
//   - fallback legacy al alias cuando no hay attempt-N (CA-F6).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { getFreePort } = require('./helpers/free-port');
const { seedConfig } = require('./helpers/sandbox-config');

const PIPELINE_SRC = path.join(__dirname, '..');
const dashboardPath = path.join(PIPELINE_SRC, 'dashboard.js');

let tmpDir;
let child;
let port;

function getJson(p, urlPath, timeoutMs, cb) {
  const req = http.request(
    { host: '127.0.0.1', port: p, path: urlPath, method: 'GET', timeout: timeoutMs },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch { body = buf; }
        cb(null, { status: res.statusCode, body });
      });
    },
  );
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.end();
}
function get(urlPath) {
  return new Promise((resolve, reject) => {
    getJson(port, urlPath, 5000, (err, r) => (err ? reject(err) : resolve(r)));
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-loghist-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  // config.yaml real → getKnownSkills lee skills_por_fase (incluye pipeline-dev).
  // #5174 — los DOS lados de la config (kernel + pipeline.config.json).
  // Copiar sólo el YAML deja el sandbox a medias y el resolver falla cerrado.
  seedConfig(tmpDir);

  // Poblar LOG_DIR: issue 4444 skill pipeline-dev con 3 intentos (rebotes).
  fs.writeFileSync(path.join(logsDir, '4444-pipeline-dev.attempt-1.log'), 'intento 1\n');
  fs.writeFileSync(path.join(logsDir, '4444-pipeline-dev.attempt-2.log'), 'intento 2\n');
  fs.writeFileSync(path.join(logsDir, '4444-pipeline-dev.attempt-3.log'), 'intento 3\n');
  fs.writeFileSync(path.join(logsDir, '4444-pipeline-dev.log'), 'intento 3 (alias)\n');
  // issue legacy 999 skill guru: sólo alias, sin attempt-N.
  fs.writeFileSync(path.join(logsDir, '999-guru.log'), 'log legacy\n');

  port = await getFreePort();
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
      getJson(port, '/api/health', 3000, (err, r) => {
        if (!err && r && r.status === 200) return resolve();
        if (++tries > 60) return reject(new Error('dashboard no levantó'));
        setTimeout(tick, 250);
      });
    };
    setTimeout(tick, 400);
  });
});

after(() => {
  if (child) { try { child.kill(); } catch {} }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('CA-F2 — issue+agente válidos devuelven la lista de intentos ordenada', async () => {
  const r = await get('/logs/history/4444/pipeline-dev');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.deepEqual(r.body.map((i) => i.intento), [1, 2, 3]);
  assert.ok(r.body.every((i) => /^4444-pipeline-dev\.attempt-\d+\.log$/.test(i.file)));
  assert.ok(r.body.every((i) => typeof i.bytes === 'number' && typeof i.mtime === 'number'));
});

test('CA-S1 — issue no numérico → 400 (path traversal / IDOR)', async () => {
  const r = await get('/logs/history/..%2F..%2Fetc/pipeline-dev');
  assert.equal(r.status, 400);
});

test('CA-S1 — agente fuera de la allowlist → 404', async () => {
  const r = await get('/logs/history/4444/notaskill');
  assert.equal(r.status, 404);
});

test('CA-S1 — agente con path traversal → 404 (no matchea allowlist)', async () => {
  const r = await get('/logs/history/4444/' + encodeURIComponent('../../secret'));
  assert.equal(r.status, 404);
});

test('CA-F6 — fallback legacy: issue viejo con sólo alias devuelve 1 ejecución', async () => {
  const r = await get('/logs/history/999/guru');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].file, '999-guru.log');
  assert.equal(r.body[0].legacy, true);
});

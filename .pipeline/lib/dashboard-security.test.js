// =============================================================================
// dashboard-security.test.js — tests de integracion del server HTTP
// Arranca dashboard-v2.js en puerto aleatorio y verifica bind + headers + Host.
// Ejecución: node --test .pipeline/lib/dashboard-security.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DASHBOARD = path.resolve(__dirname, '..', 'dashboard-v2.js');

function pickPort() {
  // Puerto aleatorio > 3300 para evitar colisión con 3200 (default) y 3201 (métricas)
  return 3300 + Math.floor(Math.random() * 20000);
}

function startDashboard(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DASHBOARD], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let ready = false;
    const onData = (chunk) => {
      const s = chunk.toString();
      if (!ready && /bind efectivo/.test(s)) {
        ready = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => {
      if (!ready) reject(new Error('dashboard no arrancó en 8s'));
    }, 8000);
  });
}

function request(host, port, urlPath, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: urlPath,
      method: 'GET',
      headers: extraHeaders || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard bindea a 127.0.0.1 y responde /api/state', async () => {
  const port = pickPort();
  const tmpPipeline = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  // Copiar los archivos mínimos requeridos al tmp pipeline (o usar el actual).
  // Usamos PIPELINE_STATE_DIR=tmp para no ensuciar el .pipeline real con dashboard.pid.
  const child = await startDashboard({
    DASHBOARD_PORT: String(port),
    PIPELINE_STATE_DIR: tmpPipeline,
    DASHBOARD_BIND_HOST: '127.0.0.1',
  });
  try {
    const r = await request('127.0.0.1', port, '/api/state');
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    // /api/state NO aplica los security headers (fuera del alcance mínimo),
    // pero el dashboard HTML sí debe aplicarlos.
    const h = await request('127.0.0.1', port, '/');
    assert.equal(h.status, 200);
    assert.equal(h.headers['x-content-type-options'], 'nosniff');
    assert.equal(h.headers['x-frame-options'], 'DENY');
    assert.equal(h.headers['cache-control'], 'no-store');
    assert.equal(h.headers['referrer-policy'], 'no-referrer');
  } finally {
    child.kill('SIGTERM');
  }
});

test('dashboard rechaza Host header no-loopback con 403', async () => {
  const port = pickPort();
  const tmpPipeline = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const child = await startDashboard({
    DASHBOARD_PORT: String(port),
    PIPELINE_STATE_DIR: tmpPipeline,
    DASHBOARD_BIND_HOST: '127.0.0.1',
  });
  try {
    // Conectamos a 127.0.0.1 pero mandamos Host: attacker.com
    const r = await request('127.0.0.1', port, '/', { 'Host': 'attacker.com' });
    assert.equal(r.status, 403);
    assert.match(r.body, /Host header/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('dashboard acepta Host: localhost y 127.0.0.1 con puerto', async () => {
  const port = pickPort();
  const tmpPipeline = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const child = await startDashboard({
    DASHBOARD_PORT: String(port),
    PIPELINE_STATE_DIR: tmpPipeline,
    DASHBOARD_BIND_HOST: '127.0.0.1',
  });
  try {
    const r1 = await request('127.0.0.1', port, '/api/state', { 'Host': `localhost:${port}` });
    assert.equal(r1.status, 200);
    const r2 = await request('127.0.0.1', port, '/api/state', { 'Host': `127.0.0.1:${port}` });
    assert.equal(r2.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});

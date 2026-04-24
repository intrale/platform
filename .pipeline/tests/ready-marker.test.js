// =============================================================================
// ready-marker.test.js — Tests de heartbeat y freshness (issue #2450)
//
// Corre con: node --test .pipeline/tests/ready-marker.test.js
//
// Estrategia: apuntamos PIPELINE_STATE_DIR (vía override de READY_DIR) a un
// directorio temporal para no tocar los markers reales del pipeline corriendo.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// El módulo ready-marker resuelve READY_DIR en tiempo de require. Para tests
// cargamos el módulo contra un dir temporal manipulando el path antes de
// requerirlo. La forma más limpia es inyectar vía env vars que el módulo
// ya respeta (PIPELINE_HEARTBEAT_MS y PIPELINE_HEARTBEAT_STALE_MS) y usar
// el READY_DIR real para cada sub-test en un scope aislado con prefijo único.

// Truco: como READY_DIR es fijo al cargarse el módulo, usamos nombres de
// componente únicos por test para aislarse. El fs real se toca pero en
// paths controlados por los nombres.
const UNIQUE = `test-${process.pid}-${Date.now()}`;
const readyMarker = require('../lib/ready-marker');

function uniqueName(suffix) { return `${UNIQUE}-${suffix}`; }
function cleanupMarker(name) { try { readyMarker.clearMarker(name); } catch {} }

// ─── signalReady / readMarker / componentState ─────────────────────────────

test('signalReady escribe marker con pid y readyAt', () => {
  const name = uniqueName('basic');
  try {
    const ok = readyMarker.signalReady(name, { source: 'test' });
    assert.strictEqual(ok, true);
    const m = readyMarker.readMarker(name);
    assert.ok(m, 'marker debe existir');
    assert.strictEqual(m.name, name);
    assert.strictEqual(m.pid, process.pid);
    assert.ok(m.readyAt, 'readyAt requerido');
    assert.deepStrictEqual(m.meta, { source: 'test' });
  } finally {
    cleanupMarker(name);
  }
});

test('componentState devuelve ready con marker fresco y PID vivo', () => {
  const name = uniqueName('ready');
  try {
    readyMarker.signalReady(name);
    const st = readyMarker.componentState(name);
    assert.strictEqual(st.state, 'ready');
    assert.strictEqual(st.marker.pid, process.pid);
  } finally {
    cleanupMarker(name);
  }
});

test('componentState devuelve stale si el PID del marker murió', () => {
  const name = uniqueName('stale-pid');
  try {
    // Escribimos manualmente un marker con un PID que seguro no existe.
    fs.mkdirSync(readyMarker.READY_DIR, { recursive: true });
    const markerPath = path.join(readyMarker.READY_DIR, `${name}.ready`);
    fs.writeFileSync(markerPath, JSON.stringify({
      name,
      pid: 99999999, // PID imposible
      startedAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
      meta: {},
    }));
    const st = readyMarker.componentState(name);
    assert.strictEqual(st.state, 'stale');
  } finally {
    cleanupMarker(name);
  }
});

test('componentState devuelve missing si no hay marker', () => {
  const st = readyMarker.componentState(uniqueName('nope'));
  assert.strictEqual(st.state, 'missing');
  assert.strictEqual(st.marker, null);
});

test('componentState devuelve stale-heartbeat si readyAt es viejo pero PID vivo', () => {
  const name = uniqueName('stale-hb');
  try {
    fs.mkdirSync(readyMarker.READY_DIR, { recursive: true });
    const markerPath = path.join(readyMarker.READY_DIR, `${name}.ready`);
    const oldReadyAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min atrás
    fs.writeFileSync(markerPath, JSON.stringify({
      name,
      pid: process.pid, // este proceso está vivo
      startedAt: oldReadyAt,
      readyAt: oldReadyAt,
      meta: {},
    }));
    // Con umbral default (120s), 10 min atrás es stale-heartbeat.
    const st = readyMarker.componentState(name);
    assert.strictEqual(st.state, 'stale-heartbeat');
    assert.ok(st.ageMs > 120000, 'ageMs debe superar staleMs');
  } finally {
    cleanupMarker(name);
  }
});

test('componentState con staleMs:0 desactiva el chequeo de freshness', () => {
  const name = uniqueName('stale-hb-disabled');
  try {
    fs.mkdirSync(readyMarker.READY_DIR, { recursive: true });
    const markerPath = path.join(readyMarker.READY_DIR, `${name}.ready`);
    const oldReadyAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(markerPath, JSON.stringify({
      name,
      pid: process.pid,
      startedAt: oldReadyAt,
      readyAt: oldReadyAt,
      meta: {},
    }));
    const st = readyMarker.componentState(name, { staleMs: 0 });
    assert.strictEqual(st.state, 'ready', 'staleMs:0 ignora freshness');
  } finally {
    cleanupMarker(name);
  }
});

// ─── startHeartbeat ─────────────────────────────────────────────────────────

test('startHeartbeat escribe marker inmediato y refresca cada intervalo', async () => {
  const name = uniqueName('heartbeat');
  const prevEnv = process.env.PIPELINE_HEARTBEAT_MS;
  process.env.PIPELINE_HEARTBEAT_MS = '50'; // para el test, 50ms
  // Recargar módulo para que tome el env var nuevo.
  delete require.cache[require.resolve('../lib/ready-marker')];
  const rm = require('../lib/ready-marker');

  let hb;
  try {
    hb = rm.startHeartbeat(name, { note: 'test-hb' });
    const first = rm.readMarker(name);
    assert.ok(first, 'marker escrito inmediatamente');
    const firstReadyAt = first.readyAt;
    // Esperamos un par de ticks del heartbeat.
    await new Promise(r => setTimeout(r, 180));
    const second = rm.readMarker(name);
    assert.ok(second, 'marker todavía presente');
    assert.notStrictEqual(second.readyAt, firstReadyAt, 'readyAt se refrescó');
    // startedAt debe preservarse entre escrituras (misma PID).
    assert.strictEqual(second.startedAt, first.startedAt, 'startedAt estable');
  } finally {
    if (hb) hb.stop();
    cleanupMarker(name);
    if (prevEnv === undefined) delete process.env.PIPELINE_HEARTBEAT_MS;
    else process.env.PIPELINE_HEARTBEAT_MS = prevEnv;
    // Restaurar caché al módulo con env var original.
    delete require.cache[require.resolve('../lib/ready-marker')];
    require('../lib/ready-marker');
  }
});

test('startHeartbeat.stop() detiene el timer', async () => {
  const name = uniqueName('heartbeat-stop');
  const prevEnv = process.env.PIPELINE_HEARTBEAT_MS;
  process.env.PIPELINE_HEARTBEAT_MS = '50';
  delete require.cache[require.resolve('../lib/ready-marker')];
  const rm = require('../lib/ready-marker');

  try {
    const hb = rm.startHeartbeat(name);
    const beforeStop = rm.readMarker(name).readyAt;
    hb.stop();
    await new Promise(r => setTimeout(r, 180));
    const afterStop = rm.readMarker(name);
    // Tras stop(), el marker no debe refrescarse.
    assert.strictEqual(afterStop.readyAt, beforeStop, 'marker no se refresca tras stop');
  } finally {
    cleanupMarker(name);
    if (prevEnv === undefined) delete process.env.PIPELINE_HEARTBEAT_MS;
    else process.env.PIPELINE_HEARTBEAT_MS = prevEnv;
    delete require.cache[require.resolve('../lib/ready-marker')];
    require('../lib/ready-marker');
  }
});

// ─── waitForMarkers ─────────────────────────────────────────────────────────

test('waitForMarkers retorna ok si todos los componentes están ready', async () => {
  const names = [uniqueName('wait-a'), uniqueName('wait-b')];
  try {
    for (const n of names) readyMarker.signalReady(n);
    const res = await readyMarker.waitForMarkers(names, 2000, 100);
    assert.strictEqual(res.ok, true);
    for (const n of names) {
      assert.strictEqual(res.results[n].state, 'ready');
    }
  } finally {
    for (const n of names) cleanupMarker(n);
  }
});

test('waitForMarkers timeout si falta algún componente', async () => {
  const names = [uniqueName('wait-present'), uniqueName('wait-absent')];
  try {
    readyMarker.signalReady(names[0]); // solo uno
    const res = await readyMarker.waitForMarkers(names, 300, 100);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.results[names[0]].state, 'ready');
    assert.strictEqual(res.results[names[1]].state, 'missing');
  } finally {
    for (const n of names) cleanupMarker(n);
  }
});

test('waitForMarkers con staleMs:0 ignora freshness durante bootstrap', async () => {
  // Escribir marker con readyAt viejo pero PID vivo. Con staleMs por defecto
  // saldría stale-heartbeat; con staleMs:0 pasa como ready.
  const name = uniqueName('wait-stale-hb-ignored');
  try {
    fs.mkdirSync(readyMarker.READY_DIR, { recursive: true });
    const markerPath = path.join(readyMarker.READY_DIR, `${name}.ready`);
    const oldReadyAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(markerPath, JSON.stringify({
      name, pid: process.pid, startedAt: oldReadyAt, readyAt: oldReadyAt, meta: {},
    }));
    const res = await readyMarker.waitForMarkers([name], 500, 100, { staleMs: 0 });
    assert.strictEqual(res.ok, true);
  } finally {
    cleanupMarker(name);
  }
});

// =============================================================================
// smoke-marker-gate-4520.test.js — gate de markers con ventana diferenciada
// para el dashboard (#4520).
//
// Contexto: tras un restart, el smoke test gatea el rollback esperando el
// marker `.ready` de cada componente. Con 60s planos para los 8, el dashboard
// (el proceso más pesado) no alcanzaba a escribir su marker bajo la contención
// del arranque y disparaba un rollback espurio a pipeline-stable. #4130 hizo
// resiliente sólo la sonda HTTP; este fix le da al MARKER del dashboard una
// ventana mayor que a los componentes livianos.
//
// Cubre:
//   1. El dashboard recibe una ventana mayor que los componentes livianos.
//   2. Un dashboard sano-pero-lento (ready entre 60s y el nuevo umbral) → ok.
//   3. Un dashboard realmente caído (nunca escribe marker) → !ok.
//   4. Un componente liviano caído → !ok (no se relaja su detección).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForComponentMarkers } = require('../smoke-test.js');

const COMPONENTS = [
  'pulpo', 'listener', 'svc-telegram', 'svc-github',
  'svc-drive', 'svc-emulador', 'svc-reconciler', 'dashboard',
];

const ready = (names) => ({
  ok: true,
  results: Object.fromEntries(names.map(n => [n, { state: 'ready', marker: { pid: 1, readyAt: new Date(0).toISOString() } }])),
});
const missing = (names) => ({
  ok: false,
  results: Object.fromEntries(names.map(n => [n, { state: 'missing', marker: null }])),
});

test('1 · el dashboard recibe una ventana mayor que los componentes livianos', async () => {
  const calls = [];
  const waitFn = async (names, timeoutMs) => { calls.push({ names, timeoutMs }); return ready(names); };
  const r = await waitForComponentMarkers(COMPONENTS, {
    lightTimeoutMs: 60000, dashTimeoutMs: 120000, waitFn, now: () => 0,
  });
  assert.equal(r.ok, true);
  const light = calls.find(c => !c.names.includes('dashboard'));
  const dash = calls.find(c => c.names.includes('dashboard') && c.names.length === 1);
  assert.ok(light && dash, 'se esperó livianos y dashboard por separado');
  assert.equal(light.timeoutMs, 60000, 'livianos: timeout estándar');
  assert.ok(dash.timeoutMs > light.timeoutMs, 'dashboard: ventana mayor');
  assert.ok(!light.names.includes('dashboard'), 'el dashboard no viaja con los livianos');
});

test('2 · dashboard sano-pero-lento (ready a los ~90s) → ok', async () => {
  // Livianos ready al toque; dashboard sólo "ready" si le dan >60s de ventana.
  const waitFn = async (names, timeoutMs) => {
    if (names.length === 1 && names[0] === 'dashboard') {
      return timeoutMs > 60000 ? ready(names) : missing(names);
    }
    return ready(names);
  };
  const r = await waitForComponentMarkers(COMPONENTS, {
    lightTimeoutMs: 60000, dashTimeoutMs: 120000, waitFn, now: () => 0,
  });
  assert.equal(r.ok, true, 'con la ventana extendida el dashboard lento pasa');
  assert.equal(r.results.dashboard.state, 'ready');
});

test('3 · dashboard realmente caído (nunca escribe marker) → !ok', async () => {
  const waitFn = async (names) => (names.includes('dashboard') && names.length === 1)
    ? missing(names) : ready(names);
  const r = await waitForComponentMarkers(COMPONENTS, {
    lightTimeoutMs: 60000, dashTimeoutMs: 120000, waitFn, now: () => 0,
  });
  assert.equal(r.ok, false, 'un dashboard caído sigue gateando el fail');
  assert.equal(r.results.dashboard.state, 'missing');
});

test('4 · componente liviano caído → !ok (no se relaja su detección)', async () => {
  const waitFn = async (names) => names.includes('svc-github')
    ? { ok: false, results: { ...ready(names.filter(n => n !== 'svc-github')).results, 'svc-github': { state: 'missing', marker: null } } }
    : ready(names);
  const r = await waitForComponentMarkers(COMPONENTS, {
    lightTimeoutMs: 60000, dashTimeoutMs: 120000, waitFn, now: () => 0,
  });
  assert.equal(r.ok, false, 'un liviano caído sigue gateando el fail');
});

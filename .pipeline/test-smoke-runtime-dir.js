'use strict';

// Regresión #4686 — resolución del directorio de RUNTIME del smoke test.
//
// El smoke test debe chequear el estado VIVO del pipeline (last-restart.json,
// ready markers), que vive en el checkout canónico. Cuando corre desde un
// worktree de agente (self-check de pipeline-dev) ese estado no existe en la
// copia local del código; resolveRuntimeDir debe caer al .pipeline canónico.
// En producción (el marker local existe) no debe tocar git ni cambiar el path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeDir } = require('./smoke-test');
const { signalReady, componentState, waitForMarkers } = require('./lib/ready-marker');

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('override explícito PIPELINE_RUNTIME_DIR tiene prioridad', () => {
  const dir = mkdtemp('smoke-override-');
  const resolved = resolveRuntimeDir('/cualquier/path', { PIPELINE_RUNTIME_DIR: dir });
  assert.equal(resolved, dir);
});

test('fast-path producción: si last-restart.json existe localmente, usa scriptDir sin git', () => {
  const scriptDir = mkdtemp('smoke-prod-');
  fs.writeFileSync(path.join(scriptDir, 'last-restart.json'), '{}');
  // Env sin override; no debe depender de git porque el marker local existe.
  const resolved = resolveRuntimeDir(scriptDir, {});
  assert.equal(resolved, scriptDir);
});

test('worktree sin marker local ni git resoluble → fallback al propio scriptDir', () => {
  const scriptDir = mkdtemp('smoke-fallback-');
  // No hay last-restart.json y el dir no es un repo git → debe devolver scriptDir.
  const resolved = resolveRuntimeDir(scriptDir, {});
  assert.equal(resolved, scriptDir);
});

test('ready-marker: readyDir opcional permite leer markers de otro directorio', async () => {
  const canonicalReady = mkdtemp('ready-canonical-');
  // Escribimos un marker "a mano" con el PID actual (vivo) en el dir canónico.
  const marker = {
    name: 'pulpo',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    meta: {},
  };
  fs.writeFileSync(path.join(canonicalReady, 'pulpo.ready'), JSON.stringify(marker));

  // componentState con readyDir explícito lo encuentra...
  const stCanonical = componentState('pulpo', canonicalReady);
  assert.equal(stCanonical.state, 'ready');

  // ...y en un dir vacío no hay marker.
  const emptyReady = mkdtemp('ready-empty-');
  const stEmpty = componentState('pulpo', emptyReady);
  assert.equal(stEmpty.state, 'missing');

  // waitForMarkers respeta el readyDir pasado como 4º argumento.
  const res = await waitForMarkers(['pulpo'], 1000, 50, canonicalReady);
  assert.equal(res.ok, true);
  assert.equal(res.results.pulpo.state, 'ready');
});

test('signalReady sin readyDir sigue escribiendo en el dir por defecto (backward compat)', () => {
  // No debe lanzar y debe devolver true escribiendo en el READY_DIR del módulo.
  const ok = signalReady('smoke-test-selfcheck', { probe: true });
  assert.equal(ok, true);
  const st = componentState('smoke-test-selfcheck');
  assert.equal(st.state, 'ready');
});

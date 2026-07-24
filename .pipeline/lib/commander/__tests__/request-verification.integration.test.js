// =============================================================================
// request-verification.integration.test.js — Test de INTEGRACIÓN de la cadena
// completa de la verificación de Sherlock en el Historial del Commander
// (#3951 / EP7-H4 — rebote de `aprobacion`).
//
// Motivación (defecto del rebote): los unit tests probaban cada módulo aislado y
// los 49 pasaban, pero NINGUNO cubría la integración real
//   classify → writeRequestMeta (sidecar) → buildResultBadges (render)
// para el caso de un turno SIN verificación efectiva de Sherlock (verdict
// 'skipped'). Ese hueco dejó pasar a producción un chip "cross-provider" en
// peticiones que jamás fueron verificadas (estado inventado, viola CA-3 + la
// guideline UX "si no hubo verificación → no renderizar chip").
//
// Este test ejercita los TRES módulos juntos contra disco real (sidecar) para
// que el camino "sin chip" deje de ser código muerto.
//
// Cobertura:
//   I-1  Turno 'skipped' → sidecar SIN campo → render SIN chip cross/same.
//   I-2  Sherlock no invocado (sin verdict) → mismo resultado (sin chip).
//   I-3  Control positivo cross: verdict ok + sameProvider:false → chip cross.
//   I-4  Control positivo same:  verdict ok + sameProvider:true  → chip same.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyCommanderResult } = require('../request-classify');
const { writeRequestMeta, buildRequestId } = require('../request-log');
const { buildResultBadges } = require('../result-badge');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reqverif-'));
}

// Replica del flujo real de `pulpo.js persistCommanderResult`: clasifica el turno,
// escribe el sidecar y devuelve { classification, sidecar }. Luego, como hace el
// dashboard, releemos el sidecar de disco y renderizamos los badges desde ESE
// objeto (no desde la clasificación en memoria) — así el test cruza el límite de
// serialización igual que producción.
function runTurn(dir, reqId, { sherlockVerdict } = {}) {
  const classification = classifyCommanderResult({
    dispatchResolution: { provider: 'anthropic', crossProvider: false, fallbackUsed: null },
    sherlockVerdict,
  });
  writeRequestMeta(dir, reqId, {
    resultado: classification.resultado,
    provider: classification.provider,
    sameProviderVerification: classification.sameProviderVerification,
    crossProviderDispatch: classification.crossProviderDispatch,
  });
  const metaPath = path.join(dir, `commander-${reqId}.meta.json`);
  const sidecar = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const html = buildResultBadges(sidecar);
  return { classification, sidecar, html };
}

// --- I-1 turno skipped --------------------------------------------------------
test('integración: turno SKIPPED → sidecar sin sameProviderVerification → render SIN chip', () => {
  const dir = tmpDir();
  const reqId = buildRequestId(-100, 1718000000020);
  const { classification, sidecar, html } = runTurn(dir, reqId, {
    sherlockVerdict: { verdict: 'skipped', sameProvider: false },
  });

  // 1) El clasificador NO emite boolean para un turno sin verificación.
  assert.equal(classification.sameProviderVerification, null);
  // 2) El sidecar persistido NO trae el campo (camino "sin chip").
  assert.ok(!('sameProviderVerification' in sidecar), 'el sidecar NO debe traer el campo en skipped');
  // 3) El render NO emite NINGÚN chip de verificación (ni cross ni same).
  assert.ok(!html.includes('cmd-verif'), 'no debe renderizarse chip de verificación');
  assert.ok(!html.includes('cross-provider'), 'JAMÁS "cross-provider" sin verificación (el defecto)');
  assert.ok(!html.includes('same-provider'));
  // Sanity: el badge de resultado + provider SÍ se renderizan (CA-3: badge sin chip).
  assert.ok(html.includes('cmd-result'), 'el badge de resultado debe seguir presente');
  assert.ok(html.includes('cmd-provider'), 'el chip de provider debe seguir presente');
});

// --- I-2 Sherlock no invocado -------------------------------------------------
test('integración: Sherlock NO invocado (sin verdict) → render SIN chip', () => {
  const dir = tmpDir();
  const reqId = buildRequestId(-100, 1718000000021);
  const { sidecar, html } = runTurn(dir, reqId, { sherlockVerdict: undefined });
  assert.ok(!('sameProviderVerification' in sidecar));
  assert.ok(!html.includes('cmd-verif'));
});

// --- I-3 control positivo cross -----------------------------------------------
test('integración: verdict ok + sameProvider:false → sidecar con campo → chip cross-provider', () => {
  const dir = tmpDir();
  const reqId = buildRequestId(-100, 1718000000022);
  const { classification, sidecar, html } = runTurn(dir, reqId, {
    sherlockVerdict: { verdict: 'ok', sameProvider: false },
  });
  assert.equal(classification.sameProviderVerification, false);
  assert.equal(sidecar.sameProviderVerification, false);
  assert.ok(html.includes('cmd-verif-cross'), 'verificación real cross → chip cross');
  assert.ok(html.includes('cross-provider'));
  assert.ok(!html.includes('same-provider'));
});

// --- I-4 control positivo same ------------------------------------------------
test('integración: verdict ok + sameProvider:true → sidecar con campo → chip same-provider', () => {
  const dir = tmpDir();
  const reqId = buildRequestId(-100, 1718000000023);
  const { classification, sidecar, html } = runTurn(dir, reqId, {
    sherlockVerdict: { verdict: 'ok', sameProvider: true },
  });
  assert.equal(classification.sameProviderVerification, true);
  assert.equal(sidecar.sameProviderVerification, true);
  assert.ok(html.includes('cmd-verif-same'), 'verificación real same → chip same');
  assert.ok(html.includes('same-provider'));
  assert.ok(!html.includes('cmd-verif-cross'));
});

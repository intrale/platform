// =============================================================================
// sherlock-consolidated-send.test.js — #4139
//
// Consolidación de la corrección de Sherlock en un ÚNICO mensaje final (texto y
// audio). Reemplaza el modelo OPTIMISTA de #4105 (liberación ⏳ + corrección
// diferida en background + follow-up por voz) por un flujo SÍNCRONO: el Commander
// espera SIEMPRE el verdict antes de despachar y entrega un solo saliente ya
// verificado. Si el presupuesto de espera se agota, degrada a F-6 y envía igual.
//
// Cobertura:
//   - getSherlockWaitBudgetMs: clamp [10s, 90s] + default (funcional, CA-5).
//   - shouldEmitSoftTimeoutDisclaimer: el agotamiento del presupuesto SIN verdict
//     habilita la degradación a F-6 (CA-5). Verdict real nunca se pisa.
//   - Invariantes de fuente (grep + funcional, según los Tests obligatorios del
//     issue): el flujo síncrono ya NO tiene segundo envío ni ⏳. El send flow vive
//     inline en el chat handler de pulpo.js (no extraíble sin un refactor mayor,
//     fuera de scope), por eso estos CA se cubren con aserciones sobre la fuente.
//   - sherlock-verifier: F-7/PENDING_VERIFICATION removidos; F-5/F-6 conservados.
//   - config.yaml: sherlock_wait_budget_ms presente; claves optimistas removidas.
// =============================================================================
'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pulpo = require('../../pulpo.js');
const sherlock = require('../sherlock-verifier.js');

const PIPELINE_DIR = path.join(__dirname, '..', '..');
const PULPO_SRC = fs.readFileSync(path.join(PIPELINE_DIR, 'pulpo.js'), 'utf8');
// Quitamos los comentarios de línea para que las aserciones "ausente" no matcheen
// las menciones explicativas de los símbolos removidos.
const PULPO_CODE = PULPO_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// --- getSherlockWaitBudgetMs: presupuesto máximo de espera (CA-5) -------------

test('#4139 wait-budget: sin config usa el default 90000ms', () => {
  assert.equal(pulpo.getSherlockWaitBudgetMs({}), 90_000);
});

test('#4139 wait-budget: valor dentro de rango se respeta', () => {
  assert.equal(pulpo.getSherlockWaitBudgetMs({ sherlock_wait_budget_ms: 30_000 }), 30_000);
});

test('#4139 wait-budget: valor por debajo del piso (10s) cae al default', () => {
  assert.equal(pulpo.getSherlockWaitBudgetMs({ sherlock_wait_budget_ms: 5_000 }), 90_000);
});

test('#4139 wait-budget: valor por encima del techo (90s) se recorta a 90s', () => {
  assert.equal(pulpo.getSherlockWaitBudgetMs({ sherlock_wait_budget_ms: 120_000 }), 90_000);
});

test('#4139 wait-budget: valor no numérico cae al default', () => {
  assert.equal(pulpo.getSherlockWaitBudgetMs({ sherlock_wait_budget_ms: 'x' }), 90_000);
});

// --- Degradación F-6 al agotar el presupuesto (CA-5) --------------------------

test('#4139 F-6: presupuesto agotado SIN verdict habilita la degradación', () => {
  // shouldEmitSoftTimeoutDisclaimer(softTimedOut=true, resolved=false) === true →
  // el caller setea TIMEOUT_OR_NO_PROVIDER (F-6) y despacha la original.
  assert.equal(pulpo.shouldEmitSoftTimeoutDisclaimer(true, false), true);
});

test('#4139 F-6: si Sherlock ya resolvió, el presupuesto NO pisa el verdict real', () => {
  assert.equal(pulpo.shouldEmitSoftTimeoutDisclaimer(true, true), false);
});

// --- Invariantes del flujo síncrono en la fuente (grep + funcional) -----------

test('#4139 sin segundo envío: scheduleOptimisticCorrection no se invoca en el código', () => {
  assert.doesNotMatch(PULPO_CODE, /scheduleOptimisticCorrection\s*\(/);
  assert.doesNotMatch(PULPO_CODE, /function\s+scheduleOptimisticCorrection/);
});

test('#4139 sin ⏳: PENDING_VERIFICATION no se usa en el código del Commander', () => {
  assert.doesNotMatch(PULPO_CODE, /DISCLAIMER_TYPES\.PENDING_VERIFICATION/);
  assert.doesNotMatch(PULPO_CODE, /sherlockOptimisticReleased/);
});

test('#4139 sin follow-up de voz: FOLLOWUP_F7_VOICE_CORRECTION no se referencia', () => {
  assert.doesNotMatch(PULPO_CODE, /FOLLOWUP_F7_VOICE_CORRECTION/);
});

test('#4139 TTS coherente: el audio se genera del mismo outboundText verificado (CA-4)', () => {
  assert.match(PULPO_CODE, /splitTextForTTSChunks\(outboundText,/);
});

// --- F-7 removido del verifier; F-5/F-6 conservados (CA-7) --------------------

test('#4139 verifier: PENDING_VERIFICATION y F-7 ya no existen', () => {
  assert.equal(sherlock.DISCLAIMER_TYPES.PENDING_VERIFICATION, undefined);
  assert.equal(sherlock.DISCLAIMER_F7_PENDING_VERIFICATION, undefined);
  assert.equal(sherlock.FOLLOWUP_F7_VOICE_CORRECTION, undefined);
});

test('#4139 verifier: F-5 y F-6 siguen aplicando', () => {
  assert.match(sherlock.applyDisclaimer('x', sherlock.DISCLAIMER_TYPES.PERSISTENT_INCONSISTENCY), /Ajusté la respuesta/);
  assert.match(sherlock.applyDisclaimer('x', sherlock.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER), /No pude verificar/);
});

// --- config.yaml: clave renombrada, optimistas removidas (CA-7) ---------------

test('#4139 config: sherlock_wait_budget_ms presente y claves optimistas removidas', () => {
  const cfg = fs.readFileSync(path.join(PIPELINE_DIR, 'config.yaml'), 'utf8');
  assert.match(cfg, /^sherlock_wait_budget_ms:\s*\d+/m);
  assert.doesNotMatch(cfg, /sherlock_optimistic_ceiling_ms/);
  assert.doesNotMatch(cfg, /sherlock_optimistic_cap/);
});

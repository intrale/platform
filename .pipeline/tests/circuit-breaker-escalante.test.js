// .pipeline/tests/circuit-breaker-escalante.test.js
// =============================================================================
// #4707 — Circuit breaker escalante (fail-open → fail-closed).
//
// Cubre el corte del circuit breaker que hasta #4700 "paraba en silencio":
//   - resolveRebotesMax: cap configurable con clamp fail-closed (CA-4 / SEC-R1).
//   - escalarACircuitBreaker: escalada fail-closed que deja marker
//     bloqueado-humano + label needs-human + comentario con causa raíz + alerta
//     Telegram con ola (CA-1, CA-2, CA-3).
//   - idempotencia (SEC-5): con marker preexistente no re-marca ni re-notifica.
//   - fail-closed (CA-3): si reportHumanBlock falla, igual queda marker mínimo.
//   - invariante RIESGO-1: un rechazo de `security` nunca es elegible para
//     auto-promoción por convergencia (re-afirmado tras el refactor).
//
// Los tests inyectan `deps` para no tocar Telegram/multimedia ni el .pipeline
// real: el filesystem se aísla en un tmp por corrida.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
process.env.PULPO_SKIP_AGENT_MODELS_VALIDATE = '1';

const pulpo = require('../pulpo.js');
const convergence = require('../lib/convergence-detector');

const { resolveRebotesMax, escalarACircuitBreaker } = pulpo;

// --- Helpers de fixture --------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-escalante-'));
  // Estructura mínima de una fase con un work-file activo.
  fs.mkdirSync(path.join(root, 'desarrollo', 'dev', 'trabajando'), { recursive: true });
  fs.mkdirSync(path.join(root, 'servicios', 'github', 'pendiente'), { recursive: true });
  return root;
}

function writeWorkFile(root, issue, skill) {
  const p = path.join(root, 'desarrollo', 'dev', 'trabajando', `${issue}.${skill}`);
  fs.writeFileSync(p, `issue: ${issue}\n`);
  return p;
}

// Fake de human-block que registra llamadas sin tocar el FS real ni GitHub.
function makeFakeHumanBlock(overrides = {}) {
  const calls = { reportHumanBlock: [], enqueueGithub: [], findBlockedMarker: [], audio: [] };
  const fake = {
    _calls: calls,
    findBlockedMarker(issue) { calls.findBlockedMarker.push(issue); return overrides.blocked || null; },
    reportHumanBlock(opts) {
      calls.reportHumanBlock.push(opts);
      if (overrides.reportThrows) throw new Error('reportHumanBlock boom (simulado)');
      return { issue: opts.issue, skill: opts.skill, phase: opts.phase, pipeline: opts.pipeline };
    },
    enqueueGithub(action, payload) { calls.enqueueGithub.push({ action, payload }); return true; },
    inferHumanBlockQuestion(motivo, o = {}) { return `¿Podés revisar? [${o.skill || '?'}] ${String(motivo).slice(0, 40)}`; },
    buildBlockedSummaryMarkdown(o = {}) {
      const h = o.highlight || {};
      return `🚧 #${h.issue} (${h.skill})\n📝 ${h.reason}`;
    },
    buildBlockedActionMarkup() { return { inline_keyboard: [[{ text: 'ok', url: 'http://x' }]] }; },
    sendNeedHumanAudio(o) { calls.audio.push(o); return Promise.resolve({ ok: true }); },
  };
  return fake;
}

function makeDeps(root, fakeHb, extra = {}) {
  const tg = { calls: [] };
  return {
    deps: {
      humanBlock: fakeHb,
      sanitize: (s) => String(s), // identidad — la redacción real se testea en human-block
      sendTelegramWithMarkup: (text, markup) => { tg.calls.push({ text, markup }); },
      log: () => {},
      pipelineRoot: root,
      resolveWaveForIssue: () => ({ number: 9, name: 'Ola de prueba', issues: [] }),
      sendAudio: () => null, // evita require('./multimedia')
      ...extra,
    },
    tg,
  };
}

// --- resolveRebotesMax (CA-4 / SEC-R1) -----------------------------------

test('resolveRebotesMax cae a 3 ante 0, negativo, NaN, string no-numérica e Infinity', () => {
  assert.equal(resolveRebotesMax(undefined), 3);
  assert.equal(resolveRebotesMax({}), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: {} }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 0 } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: -1 } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: NaN } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 'abc' } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: Infinity } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 2.5 } }), 3); // no entero
});

test('resolveRebotesMax respeta un cap válido y aplica cota superior sana (nunca desactiva el breaker)', () => {
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 3 } }), 3);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 5 } }), 5);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 1 } }), 1);
  assert.equal(resolveRebotesMax({ circuit_breaker: { rebotes_max: 999 } }), 20); // clamp superior
});

// --- escalarACircuitBreaker (CA-1, CA-2, CA-3) ---------------------------

test('el corte del circuit breaker crea marker bloqueado-humano + encola comment + dispara Telegram con ola y causa', () => {
  const root = makeTmpRoot();
  const wf = writeWorkFile(root, 4707, 'backend-dev');
  const fakeHb = makeFakeHumanBlock();
  const { deps, tg } = makeDeps(root, fakeHb);

  const res = escalarACircuitBreaker({
    issue: 4707, skill: 'backend-dev', phase: 'dev', pipeline: 'desarrollo',
    reason: 'El servicio X no arranca por dependencia externa caída',
    archivos: [{ path: wf }], faseRechazo: null, kind: 'generico',
  }, deps);

  assert.equal(res.escalado, true);
  assert.equal(res.yaBloqueado, false);
  assert.equal(res.markerOk, true);

  // reportHumanBlock invocado (marker + label needs-human vía human-block real).
  assert.equal(fakeHb._calls.reportHumanBlock.length, 1);
  const rhb = fakeHb._calls.reportHumanBlock[0];
  assert.equal(rhb.issue, 4707);
  assert.equal(rhb.skill, 'backend-dev');
  assert.equal(rhb.phase, 'dev');
  assert.equal(rhb.moveFromActive, false);
  assert.match(rhb.reason, /dependencia externa/);

  // Comentario de causa raíz encolado en la cola del servicio-github.
  const ghDir = path.join(root, 'servicios', 'github', 'pendiente');
  const comments = fs.readdirSync(ghDir).filter(f => f.includes('cb-escalate-comment'));
  assert.equal(comments.length, 1);
  const comment = JSON.parse(fs.readFileSync(path.join(ghDir, comments[0]), 'utf8'));
  assert.equal(comment.action, 'comment');
  assert.equal(comment.issue, 4707);
  assert.match(comment.body, /needs-human/);
  assert.match(comment.body, /Ola 9/);
  assert.match(comment.body, /dependencia externa/);

  // Alerta Telegram con issue + ola + causa (CA-2).
  assert.equal(tg.calls.length, 1);
  assert.match(tg.calls[0].text, /#4707/);
  assert.match(tg.calls[0].text, /Ola 9/);
  assert.match(tg.calls[0].text, /dependencia externa/);
  assert.ok(tg.calls[0].markup, 'la alerta debe incluir botones de acción rápida');

  // El work-file activo se archivó (sacado del flujo), NO quedó en trabajando/.
  assert.equal(fs.existsSync(wf), false);
  const archivados = fs.readdirSync(path.join(root, 'desarrollo', 'dev', 'archivado'));
  assert.ok(archivados.includes('4707.backend-dev'));
});

test('escalarACircuitBreaker es idempotente — con marker preexistente no re-marca ni re-notifica (SEC-5)', () => {
  const root = makeTmpRoot();
  const wf = writeWorkFile(root, 4707, 'backend-dev');
  const fakeHb = makeFakeHumanBlock({ blocked: { issue: 4707, skill: 'po', phase: 'dev' } });
  const { deps, tg } = makeDeps(root, fakeHb);

  const res = escalarACircuitBreaker({
    issue: 4707, skill: 'backend-dev', phase: 'dev', pipeline: 'desarrollo',
    reason: 'segundo tick del barrido', archivos: [{ path: wf }], kind: 'generico',
  }, deps);

  assert.equal(res.escalado, false);
  assert.equal(res.yaBloqueado, true);
  // No re-marca, no re-comenta, no re-Telegram.
  assert.equal(fakeHb._calls.reportHumanBlock.length, 0);
  assert.equal(tg.calls.length, 0);
  const ghDir = path.join(root, 'servicios', 'github', 'pendiente');
  assert.equal(fs.readdirSync(ghDir).filter(f => f.includes('cb-escalate-comment')).length, 0);
  // Pero igual limpia el work-file residual (archivado), no lo deja en el flujo.
  assert.equal(fs.existsSync(wf), false);
});

test('falla de reportHumanBlock NO degrada el corte a parar mudo — deja marker mínimo + label + alerta (fail-closed CA-3)', () => {
  const root = makeTmpRoot();
  const wf = writeWorkFile(root, 4707, 'backend-dev');
  const fakeHb = makeFakeHumanBlock({ reportThrows: true });
  const { deps, tg } = makeDeps(root, fakeHb);

  const res = escalarACircuitBreaker({
    issue: 4707, skill: 'backend-dev', phase: 'dev', pipeline: 'desarrollo',
    reason: 'causa raíz que igual debe quedar registrada',
    archivos: [{ path: wf }], kind: 'generico',
  }, deps);

  // El corte NO se degrada: marker mínimo queda igual.
  assert.equal(res.markerOk, true);
  const markerPath = path.join(root, 'desarrollo', 'dev', 'bloqueado-humano', '4707.backend-dev');
  assert.ok(fs.existsSync(markerPath), 'debe existir el marker mínimo bloqueado-humano');
  const reason = JSON.parse(fs.readFileSync(`${markerPath}.reason.json`, 'utf8'));
  assert.equal(reason.fallback, true);
  assert.equal(reason.issue, 4707);
  assert.match(reason.reason, /causa raíz/);

  // Label needs-human encolado por la vía de fallback (FS↔GitHub consistente).
  const labelCalls = fakeHb._calls.enqueueGithub.filter(c => c.action === 'label');
  assert.equal(labelCalls.length, 1);
  assert.equal(labelCalls[0].payload.label, 'needs-human');

  // La alerta Telegram igual se dispara (no se pierde observabilidad).
  assert.equal(tg.calls.length, 1);
  assert.match(tg.calls[0].text, /#4707/);
});

test('el corte archiva residuales de la fase de rechazo cuando se pasa faseRechazo', () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, 'desarrollo', 'verificacion', 'procesado'), { recursive: true });
  const residual = path.join(root, 'desarrollo', 'verificacion', 'procesado', '4707.qa');
  fs.writeFileSync(residual, 'issue: 4707\n');
  const fakeHb = makeFakeHumanBlock();
  const { deps } = makeDeps(root, fakeHb);

  escalarACircuitBreaker({
    issue: 4707, skill: 'qa', phase: 'dev', pipeline: 'desarrollo',
    reason: 'rebotes agotados', archivos: [], faseRechazo: 'verificacion', kind: 'generico',
  }, deps);

  assert.equal(fs.existsSync(residual), false);
  const arch = fs.readdirSync(path.join(root, 'desarrollo', 'verificacion', 'archivado'));
  assert.ok(arch.includes('4707.qa'));
});

test('causa vacía tras redacción cae a un fallback UX legible (no string vacío)', () => {
  const root = makeTmpRoot();
  const fakeHb = makeFakeHumanBlock();
  const { deps, tg } = makeDeps(root, fakeHb, { sanitize: () => '' });

  escalarACircuitBreaker({
    issue: 4707, skill: 'backend-dev', phase: 'dev', pipeline: 'desarrollo',
    reason: 'AWS_SECRET=xxx (todo redactado)', archivos: [], kind: 'generico',
  }, deps);

  const rhb = fakeHb._calls.reportHumanBlock[0];
  assert.match(rhb.reason, /Causa no disponible/);
  assert.match(tg.calls[0].text, /Causa no disponible/);
});

// --- Invariante RIESGO-1 (heredado de security) --------------------------

test('rechazo de security nunca es elegible para auto-promoción por convergencia (RIESGO-1 preservado)', () => {
  // El corte del circuit breaker corre ANTES del gate de convergencia en pulpo.js
  // y no altera el orden ni la exclusión `security`. Re-afirmamos el invariante
  // sobre la primitiva que el gate usa.
  const soloSecurity = convergence.isEligibleForAutoPromote({
    rechazos: [{ skill: 'security', accionable: true, motivo: 'claim empírico' }],
  });
  assert.equal(soloSecurity.eligible, false);

  // Aunque venga mezclado con ruido no-accionable de otros skills.
  const mezclado = convergence.isEligibleForAutoPromote({
    rechazos: [
      { skill: 'verificacion', accionable: false, motivo: 'ruido' },
      { skill: 'security', accionable: true, motivo: 'vuln real' },
    ],
  });
  assert.equal(mezclado.eligible, false);
});

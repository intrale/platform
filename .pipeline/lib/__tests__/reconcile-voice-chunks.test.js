// =============================================================================
// Tests de reconciliación de chunks de audio (#4750)
//
// Cubre los 2 escenarios Gherkin del issue #4750:
//   (a) Respuesta fragmentada en 3 audios, las 3 partes confirman → se cierra sin
//       reenvío ni aviso.
//   (b) Parte 1/2 no confirma dentro del timeout → reenvío automático; al agotar
//       los reintentos, aviso al usuario (chat del padre) — nunca hueco silencioso.
//
// Testea el módulo puro/DI `voice-parts.js` (la reconcile de `pulpo.js` es un
// wrapper delgado sobre estas funciones). Sin credenciales, sin red.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vp = require('../voice-parts');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-parts-'));
}

const CFG = { max_retries: 3, backoff_base_ms: 5000, backoff_max_ms: 300000, stale_ttl_ms: 86400000 };

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------
test('isVoicePartReceipt: sólo true con partIndex/partTotal enteros', () => {
  assert.equal(vp.isVoicePartReceipt({ correlationId: 'v', partIndex: 0, partTotal: 2 }), true);
  assert.equal(vp.isVoicePartReceipt({ correlationId: 'v' }), false, 'recibo de texto');
  assert.equal(vp.isVoicePartReceipt(null), false);
  assert.equal(vp.isVoicePartReceipt({ partIndex: '0', partTotal: '2' }), false, 'strings no cuentan');
});

test('applyConfirmation: idempotente', () => {
  const s = vp.buildInitialState({ correlationId: 'voice-1-abcdef', partTotal: 2, chatId: 9,
    parts: [{ partIndex: 0, path: '/a' }, { partIndex: 1, path: '/b' }], now: 1000 });
  assert.equal(vp.applyConfirmation(s, 0), true, 'primera confirmación cambia');
  assert.equal(vp.applyConfirmation(s, 0), false, 'segunda es no-op');
  assert.equal(s.parts['0'].confirmed, true);
  assert.equal(s.parts['1'].confirmed, false);
});

test('formatMissingNotice: humano, sin ids crudos, aclara que el texto llegó', () => {
  const one = vp.formatMissingNotice([1], 2);
  assert.ok(one.includes('parte 1 de 2'), 'referencia humana a la parte');
  assert.ok(/texto/.test(one), 'aclara que el texto sí llegó');
  assert.ok(!/correlationId|partIndex/i.test(one), 'no expone ids técnicos crudos');
  const many = vp.formatMissingNotice([1, 3], 3);
  assert.ok(many.includes('partes 1 y 3 de 3'), 'consolida varias partes');
});

// -----------------------------------------------------------------------------
// Escenario (a): 3/3 confirman → cierre sin reenvío ni aviso
// -----------------------------------------------------------------------------
test('Gherkin (a): 3 partes confirman → estado cerrado sin reenvío ni aviso', () => {
  const dir = sandbox();
  const cid = 'voice-a-abcdef';
  const t0 = 100000;
  vp.initState({ pipelineDir: dir, correlationId: cid, partTotal: 3, chatId: 77,
    parts: [{ partIndex: 0, path: '/0.ogg' }, { partIndex: 1, path: '/1.ogg' }, { partIndex: 2, path: '/2.ogg' }], now: t0 });

  // Llegan los 3 recibos `enviado` → se confirman las 3 partes.
  for (const idx of [0, 1, 2]) {
    assert.equal(vp.recordPartConfirmation({ pipelineDir: dir, correlationId: cid, partIndex: idx }), true);
  }

  const resends = [];
  const notices = [];
  const res = vp.sweepVoiceStates({
    pipelineDir: dir, now: t0 + 10000, config: CFG,
    enqueue: (a) => resends.push(a),
    notify: (text, chatId) => notices.push({ text, chatId }),
  });
  assert.equal(res.resent, 0, 'sin reenvíos');
  assert.equal(res.notified, 0, 'sin aviso al usuario');
  assert.equal(res.closed, 1, 'la respuesta se cierra');
  // El estado se archivó (ya no está activo).
  assert.equal(fs.existsSync(vp.statePath(vp.voicePartsDir(dir), cid)), false);
  assert.ok(fs.existsSync(path.join(vp.archivedVoicePartsDir(dir), `${cid}.json`)), 'archivado');
});

// -----------------------------------------------------------------------------
// Escenario (b): parte 1/2 no confirma → reenvío; al agotar reintentos, aviso
// -----------------------------------------------------------------------------
test('Gherkin (b): parte faltante se reenvía dentro del timeout', () => {
  const dir = sandbox();
  const cid = 'voice-b-abcdef';
  const t0 = 200000;
  vp.initState({ pipelineDir: dir, correlationId: cid, partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/p0.ogg' }, { partIndex: 1, path: '/p1.ogg' }], now: t0 });
  // Sólo confirma la parte 2 (índice 1); la parte 1 (índice 0) se pierde.
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: cid, partIndex: 1 });

  const resends = [];
  const notices = [];
  // Antes del backoff (base 5000ms): NO reenvía todavía.
  let res = vp.sweepVoiceStates({ pipelineDir: dir, now: t0 + 1000, config: CFG,
    enqueue: (a) => resends.push(a), notify: (t, c) => notices.push({ t, c }) });
  assert.equal(res.resent, 0, 'dentro del backoff aún no reenvía');
  assert.equal(res.closed, 0, 'sigue abierto esperando');

  // Pasado el backoff: reenvía la parte 0.
  res = vp.sweepVoiceStates({ pipelineDir: dir, now: t0 + 6000, config: CFG,
    enqueue: (a) => resends.push(a), notify: (t, c) => notices.push({ t, c }) });
  assert.equal(res.resent, 1, 'reenvía la parte faltante');
  assert.equal(resends[0].partIndex, 0, 'reenvía el índice 0');
  assert.equal(resends[0].path, '/p0.ogg', 'reenvía el .ogg persistido');
  assert.equal(resends[0].correlationId, cid);
  assert.equal(notices.length, 0, 'todavía no avisa (hay reintentos)');
});

test('Gherkin (b): al agotar N reintentos, avisa al chat del padre (sin hueco silencioso)', () => {
  const dir = sandbox();
  const cid = 'voice-c-abcdef';
  const t0 = 300000;
  vp.initState({ pipelineDir: dir, correlationId: cid, partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/p0.ogg' }, { partIndex: 1, path: '/p1.ogg' }], now: t0 });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: cid, partIndex: 1 });

  const resends = [];
  const notices = [];
  const enqueue = (a) => resends.push(a);
  const notify = (text, chatId) => notices.push({ text, chatId });

  // Avanzamos el reloj muy por encima del backoff en cada tick para forzar los
  // reintentos hasta agotar max_retries (3). El backoff crece exponencial, así
  // que sumamos un margen amplio por tick.
  let now = t0;
  for (let tick = 0; tick < 6; tick++) {
    now += CFG.backoff_max_ms + 1000; // garantiza superar el backoff siempre
    vp.sweepVoiceStates({ pipelineDir: dir, now, config: CFG, enqueue, notify });
  }

  // Se reenvió exactamente max_retries veces la parte 0, y luego se avisó una vez.
  assert.equal(resends.length, CFG.max_retries, 'reenvía tope N reintentos y no más');
  assert.ok(resends.every((r) => r.partIndex === 0), 'siempre la parte faltante');
  assert.equal(notices.length, 1, 'un único aviso consolidado');
  assert.equal(notices[0].chatId, 55, 'aviso al chatId del padre (SEC-R5)');
  assert.ok(notices[0].text.includes('parte 1 de 2'), 'copy humana de la parte faltante');
  // El estado quedó cerrado/archivado (no reenvía infinito).
  assert.equal(fs.existsSync(vp.statePath(vp.voicePartsDir(dir), cid)), false);
});

test('sweepVoiceStates: estado corrupto → cuarentena, nunca reenvío ciego', () => {
  const dir = sandbox();
  const stateDir = vp.voicePartsDir(dir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'voice-x-abcdef.json'), '{ corrupto');
  const resends = [];
  const res = vp.sweepVoiceStates({ pipelineDir: dir, now: 1, config: CFG,
    enqueue: (a) => resends.push(a), notify: () => {} });
  assert.equal(res.quarantined, 1);
  assert.equal(resends.length, 0, 'no reenvía sobre estado corrupto');
});

test('planSweep: estado stale se fuerza terminal y avisa', () => {
  const s = vp.buildInitialState({ correlationId: 'voice-s-abcdef', partTotal: 2, chatId: 3,
    parts: [{ partIndex: 0, path: '/a' }, { partIndex: 1, path: '/b' }], now: 0 });
  s.parts['1'].confirmed = true;
  // now muy por encima de stale_ttl → terminal aunque no se agotaran reintentos.
  const plan = vp.planSweep(s, { now: CFG.stale_ttl_ms + 1, maxRetries: 3,
    backoffBaseMs: 5000, backoffMaxMs: 300000, staleTtlMs: CFG.stale_ttl_ms });
  assert.equal(plan.terminal, true);
  assert.equal(plan.resends.length, 0, 'stale no reenvía, cierra');
  assert.ok(plan.notify, 'avisa la parte faltante');
  assert.deepEqual(plan.notify.partNumbers, [1]);
});

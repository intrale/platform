// =============================================================================
// Tests de deduplicación cross-retry de audios (#4903)
//
// Cubre los 2 escenarios Gherkin del issue #4903:
//   (a) Un mensaje con texto + N audios cuya confirmación de entrega falla (pero
//       cuyos audios ya llegaron) reintenta reenviando solo el texto, sin duplicar
//       audios → al re-despachar el mismo audio (mismo dedupeKey), TODAS las partes
//       se detectan ya-entregadas y NO se reenvía ninguna.
//   (b) Un mensaje que efectivamente no llegó (nada entregado) sí se reenvía
//       completo → sin estado previo confirmado, `findDeliveredParts` no encuentra
//       nada y las partes se reenvían.
//
// Testea el módulo puro/DI `voice-parts.js` (la dedup en `dispatchVoiceParts` de
// `pulpo.js` es un wrapper delgado sobre estas funciones). Sin credenciales, sin red.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vp = require('../voice-parts');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-dedup-'));
}

// -----------------------------------------------------------------------------
// computeDedupeKey — estable por (chat, texto), robusto a whitespace, null si vacío
// -----------------------------------------------------------------------------
test('computeDedupeKey: mismo (chat, texto) → misma key (sobrevive al reintento)', () => {
  const a = vp.computeDedupeKey({ chatId: 55, text: 'Hola, estas son tus opciones' });
  const b = vp.computeDedupeKey({ chatId: 55, text: 'Hola,   estas son   tus opciones ' });
  assert.equal(a, b, 'normaliza whitespace: el reintento del mismo turno matchea');
  assert.ok(/^vk_[0-9a-f]{32}$/.test(a), 'formato de key');
});

test('computeDedupeKey: distinto chat o texto → distinta key', () => {
  const base = vp.computeDedupeKey({ chatId: 55, text: 'X' });
  assert.notEqual(base, vp.computeDedupeKey({ chatId: 56, text: 'X' }), 'chat distinto');
  assert.notEqual(base, vp.computeDedupeKey({ chatId: 55, text: 'Y' }), 'texto distinto');
});

test('computeDedupeKey: texto vacío o solo-espacios → null (no deduplica basura)', () => {
  assert.equal(vp.computeDedupeKey({ chatId: 55, text: '' }), null);
  assert.equal(vp.computeDedupeKey({ chatId: 55, text: '   ' }), null);
  assert.equal(vp.computeDedupeKey({ chatId: 55, text: null }), null);
});

// -----------------------------------------------------------------------------
// isFullyDelivered / confirmedIndexes — puros
// -----------------------------------------------------------------------------
test('isFullyDelivered: true sólo cuando TODAS las partes están confirmadas', () => {
  const s = vp.buildInitialState({ correlationId: 'voice-f-abcdef', partTotal: 2, chatId: 9,
    parts: [{ partIndex: 0, path: '/a' }, { partIndex: 1, path: '/b' }], now: 1000 });
  assert.equal(vp.isFullyDelivered(s), false, 'ninguna confirmada');
  vp.applyConfirmation(s, 0);
  assert.equal(vp.isFullyDelivered(s), false, 'parcial');
  vp.applyConfirmation(s, 1);
  assert.equal(vp.isFullyDelivered(s), true, 'todas confirmadas');
});

test('confirmedIndexes: devuelve los índices confirmados', () => {
  const s = vp.buildInitialState({ correlationId: 'voice-g-abcdef', partTotal: 3, chatId: 9,
    parts: [{ partIndex: 0 }, { partIndex: 1 }, { partIndex: 2 }], now: 1000 });
  vp.applyConfirmation(s, 0);
  vp.applyConfirmation(s, 2);
  assert.deepEqual([...vp.confirmedIndexes(s)].sort(), [0, 2]);
});

// -----------------------------------------------------------------------------
// buildInitialState: persiste dedupeKey y respeta parts pre-confirmadas
// -----------------------------------------------------------------------------
test('buildInitialState: guarda dedupeKey y confirmed inicial por parte', () => {
  const s = vp.buildInitialState({ correlationId: 'voice-h-abcdef', partTotal: 2, chatId: 9,
    parts: [{ partIndex: 0, confirmed: true }, { partIndex: 1 }], now: 1000, dedupeKey: 'vk_deadbeef' });
  assert.equal(s.dedupeKey, 'vk_deadbeef');
  assert.equal(s.parts['0'].confirmed, true, 'parte pre-confirmada (ya entregada)');
  assert.equal(s.parts['1'].confirmed, false);
  assert.equal(vp.isValidState(s), true, 'estado con dedupeKey sigue siendo válido');
});

test('isValidState: dedupeKey no-string → inválido (fail-closed); ausente → válido', () => {
  const base = { correlationId: 'voice-i-abcdef', partTotal: 1, parts: {} };
  assert.equal(vp.isValidState(base), true, 'sin dedupeKey: backward-compat');
  assert.equal(vp.isValidState({ ...base, dedupeKey: 42 }), false, 'número no vale');
  assert.equal(vp.isValidState({ ...base, dedupeKey: '' }), false, 'vacío no vale');
  assert.equal(vp.isValidState({ ...base, dedupeKey: 'vk_x' }), true);
});

// -----------------------------------------------------------------------------
// findDeliveredParts — consolida entregas por dedupeKey en activos + archivados
// -----------------------------------------------------------------------------
test('findDeliveredParts: encuentra partes confirmadas del estado activo por dedupeKey', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'respuesta con audios' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-p1-abcdef', partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }, { partIndex: 1, path: '/1' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p1-abcdef', partIndex: 0 });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p1-abcdef', partIndex: 1 });

  const res = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 110000, ttlMs: 86400000 });
  assert.equal(res.found, true);
  assert.equal(res.partTotal, 2);
  assert.deepEqual([...res.confirmed].sort(), [0, 1], 'ambas partes ya entregadas');
});

test('findDeliveredParts: también lee estados ARCHIVADOS (el turno previo se cerró/archivó)', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'ya archivado' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-p2-abcdef', partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }, { partIndex: 1, path: '/1' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p2-abcdef', partIndex: 0 });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p2-abcdef', partIndex: 1 });
  // Cerramos el turno: el sweep archiva el estado (todas confirmadas → terminal).
  const swept = vp.sweepVoiceStates({ pipelineDir: dir, now: 110000,
    config: { max_retries: 3, backoff_base_ms: 5000, backoff_max_ms: 300000, stale_ttl_ms: 86400000 },
    enqueue: () => {}, notify: () => {} });
  assert.equal(swept.closed, 1, 'el estado se archivó');
  assert.equal(fs.existsSync(vp.statePath(vp.voicePartsDir(dir), 'voice-p2-abcdef')), false);

  const res = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 120000, ttlMs: 86400000 });
  assert.equal(res.found, true, 'lo encuentra en archivado');
  assert.deepEqual([...res.confirmed].sort(), [0, 1]);
});

test('findDeliveredParts: dedupeKey distinto → no matchea (respuesta diferente se reenvía)', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'A' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-p3-abcdef', partTotal: 1, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p3-abcdef', partIndex: 0 });

  const other = vp.computeDedupeKey({ chatId: 55, text: 'B' });
  const res = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: other, now: 110000, ttlMs: 86400000 });
  assert.equal(res.found, false, 'otra respuesta → no dedup');
  assert.equal(res.confirmed.size, 0);
});

test('findDeliveredParts: fuera de la ventana ttl → se ignora (no dedup infinito)', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'viejo' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-p4-abcdef', partTotal: 1, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-p4-abcdef', partIndex: 0 });

  const res = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 100000 + 86400000 + 1, ttlMs: 86400000 });
  assert.equal(res.found, false, 'fuera de ttl → ignorado');
});

test('findDeliveredParts: solo partes NO confirmadas → confirmed vacío (nada que dedupear)', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'no entregado' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-p5-abcdef', partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }, { partIndex: 1, path: '/1' }], now: 100000, dedupeKey: key });
  // Ninguna confirma (el mensaje no llegó).
  const res = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 110000, ttlMs: 86400000 });
  assert.equal(res.found, true, 'existe el estado');
  assert.equal(res.confirmed.size, 0, 'pero nada entregado → se reenviará completo');
});

// -----------------------------------------------------------------------------
// Escenario Gherkin (a): confirmación falló pero audios llegaron → dedup total
// -----------------------------------------------------------------------------
test('Gherkin (a): reintento con audios ya entregados → 0 partes a reenviar', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'texto + 2 audios' });
  // Pasada 1: 2 audios, ambos entregados (recibos `enviado`).
  vp.initState({ pipelineDir: dir, correlationId: 'voice-a1-abcdef', partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }, { partIndex: 1, path: '/1' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-a1-abcdef', partIndex: 0 });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-a1-abcdef', partIndex: 1 });

  // Reintento del turno (misma respuesta): ¿qué partes hay que reenviar?
  const delivered = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 110000, ttlMs: 86400000 });
  const partTotal = 2;
  const toResend = [];
  for (let i = 0; i < partTotal; i++) if (!delivered.confirmed.has(i)) toResend.push(i);
  assert.deepEqual(toResend, [], 'no se reenvía ningún audio (solo faltaba el texto)');
});

// -----------------------------------------------------------------------------
// Escenario Gherkin (b): nada entregado → se reenvía completo
// -----------------------------------------------------------------------------
test('Gherkin (b): mensaje que no llegó → se reenvían todas las partes', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'texto + 1 audio no entregado' });
  // No hay estado previo alguno para este dedupeKey.
  const delivered = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 110000, ttlMs: 86400000 });
  const partTotal = 2;
  const toResend = [];
  for (let i = 0; i < partTotal; i++) if (!delivered.confirmed.has(i)) toResend.push(i);
  assert.deepEqual(toResend, [0, 1], 'se reenvía texto + audio completos');
});

// -----------------------------------------------------------------------------
// Dedup PARCIAL: solo 1 de 2 audios llegó → se reenvía únicamente el faltante
// -----------------------------------------------------------------------------
test('dedup parcial: 1 de 2 audios entregado → solo se reenvía el faltante (idempotente)', () => {
  const dir = sandbox();
  const key = vp.computeDedupeKey({ chatId: 55, text: 'parcial' });
  vp.initState({ pipelineDir: dir, correlationId: 'voice-pp-abcdef', partTotal: 2, chatId: 55,
    parts: [{ partIndex: 0, path: '/0' }, { partIndex: 1, path: '/1' }], now: 100000, dedupeKey: key });
  vp.recordPartConfirmation({ pipelineDir: dir, correlationId: 'voice-pp-abcdef', partIndex: 1 }); // solo la 2da

  const delivered = vp.findDeliveredParts({ pipelineDir: dir, dedupeKey: key, now: 110000, ttlMs: 86400000 });
  const toResend = [];
  for (let i = 0; i < 2; i++) if (!delivered.confirmed.has(i)) toResend.push(i);
  assert.deepEqual(toResend, [0], 'solo se reenvía la parte 0 (la 1 ya llegó)');
});

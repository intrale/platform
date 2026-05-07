// =============================================================================
// Tests pr-status-message.js — Issue #3030
//
// Cubre los CAs del PO en el comentario de criterios:
//   CA-1  PR mergeado → mensaje explícito + SHA + link
//   CA-2  OPEN, todos verdes → "listo para mergear"
//   CA-3  OPEN, checks pendientes → "esperando checks externos"
//   CA-4  OPEN, checks rojos → alerta ⚠️
//   CA-5  CLOSED sin merge → alerta ⚠️
//   CA-6  Sin PR detectado → ℹ️
//   CA-7  Error de gh / JSON malformado → fallback con sufijo
// + Seguridad / robustez:
//   - Título con caracteres reservados Markdown: mensaje no se corrompe
//     (no usamos parse_mode → safe).
//   - prInfo con campos faltantes (mergeCommit null, statusCheckRollup undef).
//   - summarizePrInfoForLog en cada escenario.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompletionMessage,
  summarizePrInfoForLog,
  __classifyRollup,
} = require('../pr-status-message');

// -- CA-1: PR mergeado --------------------------------------------------------

test('CA-1 | PR mergeado emite mensaje explícito con SHA corto y link', () => {
  const prInfo = {
    state: 'MERGED',
    mergedAt: '2026-05-06T20:00:00Z',
    mergeCommit: { oid: 'a1b2c3d4e5f6789012345678901234567890abcd' },
    url: 'https://github.com/intrale/platform/pull/9999',
    statusCheckRollup: [],
    reviewDecision: 'APPROVED',
  };
  const { text, replyMarkup } = buildCompletionMessage(3030, prInfo);

  assert.match(text, /^✅ #3030 mergeado a main/);
  assert.match(text, /pipeline cerrado/);
  // SHA corto en línea aparte.
  assert.match(text, /\nmerge: a1b2c3d$/);
  assert.deepEqual(replyMarkup, {
    inline_keyboard: [[{ text: 'Ver PR', url: 'https://github.com/intrale/platform/pull/9999' }]],
  });
});

test('CA-1 | PR mergeado SIN mergeCommit no rompe (omite SHA)', () => {
  const { text } = buildCompletionMessage(3030, {
    state: 'MERGED',
    mergedAt: '2026-05-06T20:00:00Z',
    mergeCommit: null,
    url: 'https://github.com/intrale/platform/pull/9999',
  });
  assert.match(text, /^✅ #3030 mergeado a main/);
  assert.doesNotMatch(text, /merge: /);
});

// -- CA-2: OPEN, todos verdes -------------------------------------------------

test('CA-2 | OPEN con statusCheckRollup todo SUCCESS → listo para mergear', () => {
  const prInfo = {
    state: 'OPEN',
    url: 'https://github.com/intrale/platform/pull/9999',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { state: 'SUCCESS' },
    ],
    reviewDecision: 'APPROVED',
  };
  const { text, replyMarkup } = buildCompletionMessage(3030, prInfo);

  assert.match(text, /^✅ #3030 listo para mergear/);
  assert.match(text, /todos los gates verdes/);
  assert.equal(replyMarkup.inline_keyboard[0][0].text, 'Ver PR');
});

test('CA-2 | OPEN sin checks declarados → tratado como SUCCESS (listo)', () => {
  const { text } = buildCompletionMessage(3030, {
    state: 'OPEN',
    url: 'https://example.test/pr/1',
    statusCheckRollup: [],
  });
  assert.match(text, /listo para mergear/);
});

// -- CA-3: OPEN, checks pendientes --------------------------------------------

test('CA-3 | OPEN con un check IN_PROGRESS → esperando checks externos', () => {
  const prInfo = {
    state: 'OPEN',
    url: 'https://github.com/intrale/platform/pull/9999',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS' },
    ],
  };
  const { text, replyMarkup } = buildCompletionMessage(3030, prInfo);

  assert.match(text, /^🟡 #3030 terminó el pipeline/);
  assert.match(text, /esperando checks de CI\/QA externos/);
  assert.ok(replyMarkup, 'replyMarkup con botón al PR esperado');
});

test('CA-3 | OPEN con StatusContext PENDING (legacy) → pendiente', () => {
  const { text } = buildCompletionMessage(3030, {
    state: 'OPEN',
    url: 'https://example.test/pr/1',
    statusCheckRollup: [{ state: 'PENDING' }],
  });
  assert.match(text, /^🟡 /);
});

// -- CA-4: OPEN, checks rojos -------------------------------------------------

test('CA-4 | OPEN con un check FAILURE → alerta ⚠️ requiere atención', () => {
  const prInfo = {
    state: 'OPEN',
    url: 'https://github.com/intrale/platform/pull/9999',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'IN_PROGRESS' }, // un PENDING + FAILURE → predomina FAILURE
    ],
  };
  const { text } = buildCompletionMessage(3030, prInfo);

  assert.match(text, /^⚠️ #3030 terminó pero hay checks en rojo/);
  assert.match(text, /requiere atención/);
});

test('CA-4 | conclusion CANCELLED y TIMED_OUT también cuentan como falla', () => {
  for (const conclusion of ['CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) {
    const { text } = buildCompletionMessage(3030, {
      state: 'OPEN',
      url: 'x',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion }],
    });
    assert.match(text, /^⚠️ #3030 terminó pero hay checks en rojo/, `conclusion=${conclusion}`);
  }
});

// -- CA-5: CLOSED sin mergear -------------------------------------------------

test('CA-5 | CLOSED sin merge → alerta ⚠️ cerrado sin mergear', () => {
  const { text, replyMarkup } = buildCompletionMessage(3030, {
    state: 'CLOSED',
    mergedAt: null,
    url: 'https://github.com/intrale/platform/pull/9999',
    statusCheckRollup: [],
  });
  assert.match(text, /^⚠️ #3030 completó el pipeline pero el PR fue cerrado sin mergear/);
  assert.ok(replyMarkup, 'mantiene botón al PR para inspeccionar');
});

// -- CA-6: sin PR -------------------------------------------------------------

test('CA-6 | prInfo === null → mensaje informativo, sin replyMarkup', () => {
  const { text, replyMarkup } = buildCompletionMessage(3030, null);
  assert.match(text, /^ℹ️ #3030 completó el pipeline — no detecté PR asociado/);
  assert.equal(replyMarkup, null);
});

// -- CA-7: error de gh / JSON malformado --------------------------------------

test('CA-7 | prInfo.error → fallback con sufijo "estado del PR no verificable"', () => {
  const { text, replyMarkup } = buildCompletionMessage(3030, { error: true });
  assert.match(text, /^❓ #3030 completó el pipeline de desarrollo/);
  assert.match(text, /estado del PR no verificable/);
  assert.equal(replyMarkup, null);
});

test('CA-7 | estado desconocido (no MERGED/OPEN/CLOSED) cae al fallback', () => {
  const { text } = buildCompletionMessage(3030, { state: 'WEIRD_STATE', url: 'x' });
  assert.match(text, /estado del PR no verificable/);
});

// -- Robustez / seguridad -----------------------------------------------------

test('Seguridad | Mensaje no usa parse_mode (CA-13) — caracteres Markdown se envían tal cual', () => {
  // El módulo no agrega `parse_mode`; es responsabilidad del caller.
  // Este test verifica que el texto generado no contenga sintaxis Markdown
  // creada por el módulo (asteriscos/underscores fuera de URLs).
  const { text } = buildCompletionMessage(3030, {
    state: 'MERGED',
    mergeCommit: { oid: '1234567890' },
    url: 'https://example.test/pr/1',
  });
  assert.doesNotMatch(text, /\*[^\n]*\*/);
  assert.doesNotMatch(text, /_[^\n]*_/);
});

test('Robustez | statusCheckRollup undefined no rompe', () => {
  const { text } = buildCompletionMessage(3030, {
    state: 'OPEN',
    url: 'x',
    // sin statusCheckRollup
  });
  assert.match(text, /listo para mergear/);
});

test('Robustez | statusCheckRollup con entradas null/string es ignorado', () => {
  const { text } = buildCompletionMessage(3030, {
    state: 'OPEN',
    url: 'x',
    statusCheckRollup: [null, 'garbage', { status: 'COMPLETED', conclusion: 'SUCCESS' }],
  });
  assert.match(text, /listo para mergear/);
});

// -- summarizePrInfoForLog ----------------------------------------------------

test('summarizePrInfoForLog | MERGED', () => {
  const summary = summarizePrInfoForLog({
    state: 'MERGED',
    url: 'https://example.test/pr/1',
    statusCheckRollup: [],
  });
  assert.deepEqual(summary, {
    prState: 'MERGED',
    rollupState: 'N_A',
    prUrl: 'https://example.test/pr/1',
  });
});

test('summarizePrInfoForLog | OPEN con FAILURE', () => {
  const summary = summarizePrInfoForLog({
    state: 'OPEN',
    url: 'https://example.test/pr/1',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  });
  assert.equal(summary.prState, 'OPEN');
  assert.equal(summary.rollupState, 'FAILURE');
});

test('summarizePrInfoForLog | OPEN con PENDING', () => {
  const summary = summarizePrInfoForLog({
    state: 'OPEN',
    url: 'x',
    statusCheckRollup: [{ status: 'IN_PROGRESS' }],
  });
  assert.equal(summary.rollupState, 'PENDING');
});

test('summarizePrInfoForLog | null y error', () => {
  assert.deepEqual(summarizePrInfoForLog(null), {
    prState: 'NO_PR', rollupState: 'N_A', prUrl: null,
  });
  assert.deepEqual(summarizePrInfoForLog({ error: true }), {
    prState: 'UNKNOWN', rollupState: 'N_A', prUrl: null,
  });
});

// -- classifyRollup directo ---------------------------------------------------

test('classifyRollup | array vacío → SUCCESS', () => {
  assert.equal(__classifyRollup([]), 'SUCCESS');
});

test('classifyRollup | success + pending + failure → FAILURE', () => {
  assert.equal(__classifyRollup([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]), 'FAILURE');
});

test('classifyRollup | success + pending → PENDING', () => {
  assert.equal(__classifyRollup([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'QUEUED' },
  ]), 'PENDING');
});

test('classifyRollup | NEUTRAL/SKIPPED no cuentan como falla ni como pending', () => {
  assert.equal(__classifyRollup([
    { status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' },
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]), 'SUCCESS');
});

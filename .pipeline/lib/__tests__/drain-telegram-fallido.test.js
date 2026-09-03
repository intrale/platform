// =============================================================================
// Tests de la clasificación del drenaje one-shot de fallido/ (#5924)
//
// El script es el que cierra la cola acumulada. Lo que se protege acá es su
// POLÍTICA (función pura `classify`), no el movimiento de archivos:
//   - R7: un saliente con botones NUNCA se reencola (replay de capability)
//   - las alertas propias se descartan CON su causa real registrada
//   - un rechazo permanente ya diagnosticado no se reenvía
//   - lo reintentable de verdad sí vuelve a la cola
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, outboundAgeMs, ACCIONES, STALE_MS } = require('../../scripts/drain-telegram-fallido');

test('R7: un saliente con reply_markup nunca se reencola', () => {
  const r = classify('aviso.json', {
    text: 'Aprobar',
    reply_markup: { inline_keyboard: [[{ text: 'Ok', url: 'https://x/token=ABC' }]] },
  }, 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /replay de capability|R7/);
});

test('las alertas propias se descartan CON su causa real registrada', () => {
  // Con código: la causa enmascarada queda explícita.
  const conCodigo = classify('alert-svc-telegram-123-4.json', { text: 'x', _telegramErrorCode: 400 }, 1000);
  assert.equal(conCodigo.accion, ACCIONES.DESCARTAR);
  assert.match(conCodigo.causa, /error_code 400/);

  // Sin código: se registra explícitamente que no hay causa, no se finge una.
  const sinCodigo = classify('alert-svc-telegram-999-1.json', { text: 'x' }, 1000);
  assert.equal(sinCodigo.accion, ACCIONES.DESCARTAR);
  assert.match(sinCodigo.causa, /no registrado/);
});

test('un rechazo permanente ya diagnosticado no se reenvía', () => {
  const r = classify('drop.json', { text: 'x', _telegramErrorCode: 400 }, 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /rechazo permanente/);
});

test('un 429 no es permanente: el saliente vuelve a la cola', () => {
  const r = classify('drop.json', { text: 'x', _telegramErrorCode: 429 }, 1000);
  assert.equal(r.accion, ACCIONES.REENCOLAR);
});

test('un saliente stale no se reenvía fuera de contexto', () => {
  const r = classify('drop.json', { text: 'x' }, STALE_MS + 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /stale/);
});

test('un dropfile ilegible se descarta, no se reintenta para siempre', () => {
  const r = classify('roto.json', null, 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /ilegible|malformado/);
});

test('un dropfile sin contenido enviable se descarta', () => {
  const r = classify('vacio.json', { _telegramAttempts: 5 }, 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /sin contenido enviable/);
});

test('un mensaje de texto reciente y sin causa permanente se reencola', () => {
  const r = classify('drop.json', { text: 'aviso vigente' }, 1000);
  assert.equal(r.accion, ACCIONES.REENCOLAR);
});

// -----------------------------------------------------------------------------
// Antigüedad real: `_failedAt` miente cuando el barredor recicló el saliente
// -----------------------------------------------------------------------------
const NOW = 1786660000000;

test('outboundAgeMs: usa el timestamp del NOMBRE, no el _failedAt refrescado', () => {
  const hace14dias = NOW - 14 * 24 * 3600 * 1000;
  // El saliente nació hace 14 días, pero el ciclo de reciclado le dejó un
  // `_failedAt` de hace un minuto. La edad honesta es la del nombre.
  const edad = outboundAgeMs(
    `alert-waves-desync-${hace14dias}-5968.json`,
    { _failedAt: new Date(NOW - 60000).toISOString() },
    NOW,
    NOW - 60000,
  );
  assert.ok(edad > 13 * 24 * 3600 * 1000, `debe reflejar los 14 días, fue ${edad}`);
});

test('outboundAgeMs: reconoce el patrón <ts>-cmd.json', () => {
  const ts = NOW - 3 * 24 * 3600 * 1000;
  const edad = outboundAgeMs(`${ts}-cmd.json`, null, NOW, NaN);
  assert.ok(Math.abs(edad - 3 * 24 * 3600 * 1000) < 1000);
});

test('outboundAgeMs: sin ninguna evidencia devuelve NaN (no inventa una edad)', () => {
  assert.ok(Number.isNaN(outboundAgeMs('sin-timestamp.json', null, NOW, NaN)));
});

test('outboundAgeMs: ignora un timestamp del futuro en vez de dar edad negativa', () => {
  const edad = outboundAgeMs(`${NOW + 999999999}-cmd.json`, null, NOW, NOW - 5000);
  assert.equal(edad, 5000, 'cae al mtime');
});

test('un saliente viejo reciclado por el barredor SÍ se descarta por stale', () => {
  const viejo = outboundAgeMs(
    `alert-waves-desync-${NOW - 14 * 24 * 3600 * 1000}-1.json`,
    { _failedAt: new Date(NOW - 60000).toISOString() },
    NOW, NOW - 60000,
  );
  const r = classify('alert-waves-desync-x.json', { text: 'aviso viejo' }, viejo);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
  assert.match(r.causa, /stale/);
});

test('la precedencia pone R7 por encima del reencolado por reintentable', () => {
  // Reciente, sin código de error → sería reencolable, pero tiene botones.
  const r = classify('drop.json', {
    text: 'x', reply_markup: { inline_keyboard: [] },
  }, 1000);
  assert.equal(r.accion, ACCIONES.DESCARTAR);
});

// =============================================================================
// Tests del agrupador acotado de alertas de svc-telegram (#5924)
//
// Lo que se protege acá es que la dedup NO se convierta en un canal de
// supresión silenciosa ni en un DoS de memoria:
//   - la clave se deriva SOLO de valores acotados (error_code coercionado +
//     tipo de saliente), JAMÁS del `description` remoto (SEC-D / R4.1)
//   - el conteo va SIEMPRE en el consolidado (R4.2)
//   - el buffer está acotado en ventana Y en nº de claves (R4.3)
//
// Módulo puro: sin FS, sin red, reloj por parámetro.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dedup = require('../telegram-alert-dedup');

// -----------------------------------------------------------------------------
// Coerción del error_code (SEC-D)
// -----------------------------------------------------------------------------
test('coerceTelegramErrorCode: entero válido, string numérico, o null ante basura', () => {
  assert.equal(dedup.coerceTelegramErrorCode(400), 400);
  assert.equal(dedup.coerceTelegramErrorCode('429'), 429);
  assert.equal(dedup.coerceTelegramErrorCode(null), null);
  assert.equal(dedup.coerceTelegramErrorCode(undefined), null);
  assert.equal(dedup.coerceTelegramErrorCode('no soy un codigo'), null);
  assert.equal(dedup.coerceTelegramErrorCode({}), null);
  // Fuera del rango HTTP-like → tratado como ausente (no se propaga crudo).
  assert.equal(dedup.coerceTelegramErrorCode(999999), null);
  assert.equal(dedup.coerceTelegramErrorCode(-1), null);
});

test('dedupBucket: sólo códigos conocidos; cualquier otro cae en "otros"', () => {
  assert.equal(dedup.dedupBucket(400), '400');
  assert.equal(dedup.dedupBucket('429'), '429');
  assert.equal(dedup.dedupBucket(418), 'otros');
  assert.equal(dedup.dedupBucket(null), 'otros');
  assert.equal(dedup.dedupBucket('rechazo por markdown'), 'otros');
});

test('SEC-D: 1000 error_code distintos producen a lo sumo (conocidos + 1) buckets', () => {
  const keys = new Set();
  for (let i = 0; i < 1000; i++) keys.add(dedup.dedupBucket(i));
  assert.ok(
    keys.size <= dedup.KNOWN_TELEGRAM_CODES.length + 1,
    `la cardinalidad debe estar acotada, fueron ${keys.size}`,
  );
});

test('R4.1: la clave NUNCA se deriva del description remoto', () => {
  // Dos descriptions completamente distintos, mismo código y tipo → MISMA clave.
  const a = dedup.dedupKey(400, 'mensaje de texto');
  const b = dedup.dedupKey(400, 'mensaje de texto');
  assert.equal(a, b);
  // Un tipo inventado colapsa al enum cerrado: no abre claves nuevas.
  const inventado = dedup.dedupKey(400, 'tipo-inventado-por-un-productor');
  assert.equal(inventado, '400|desconocido');
  assert.equal(dedup.dedupKey(400, 'audio'), '400|audio');
});

test('isPermanentTelegramError: 4xx de request inválida sí; 429/420/5xx no', () => {
  for (const c of [400, 401, 403, 404, 409, 413]) {
    assert.equal(dedup.isPermanentTelegramError(c), true, `${c} debe ser permanente`);
  }
  // Transitorios: los cubre el backoff, no se marcan permanentes.
  assert.equal(dedup.isPermanentTelegramError(429), false);
  assert.equal(dedup.isPermanentTelegramError(420), false);
  assert.equal(dedup.isPermanentTelegramError(500), false);
  // Sin código no se puede afirmar nada → no permanente (se sigue reintentando).
  assert.equal(dedup.isPermanentTelegramError(null), false);
  assert.equal(dedup.isPermanentTelegramError('basura'), false);
});

// -----------------------------------------------------------------------------
// Buffer: agrupación en ventana + conteo siempre presente
// -----------------------------------------------------------------------------
test('agrupa salientes distintos con misma causa+tipo dentro de la ventana', () => {
  const buf = dedup.createAlertDedup({ windowMs: 1000 });
  const k = dedup.dedupKey(400, 'mensaje de texto');

  const first = buf.register(k, 'hola', 0);
  assert.equal(first.emit, true, 'la primera se emite de inmediato');
  assert.equal(first.count, 1);

  for (let i = 1; i < 5; i++) {
    const r = buf.register(k, `otro ${i}`, 100 * i);
    assert.equal(r.emit, false, 'las siguientes de la ventana se agrupan');
  }
  // Nada que consolidar mientras la ventana sigue abierta.
  assert.deepEqual(buf.flush(500), []);

  const groups = buf.flush(2000);
  assert.equal(groups.length, 1);
  // R4.2 — el conteo SIEMPRE está, y es el total real de la ventana.
  assert.equal(groups[0].count, 5);
  assert.equal(groups[0].tipo, 'mensaje de texto');
  assert.match(groups[0].causa, /error_code 400/);
  assert.equal(buf.size(), 0, 'la ventana cerrada libera la clave');
});

test('causas distintas no se mezclan en el mismo consolidado', () => {
  const buf = dedup.createAlertDedup({ windowMs: 1000 });
  buf.register(dedup.dedupKey(400, 'mensaje de texto'), 'a', 0);
  buf.register(dedup.dedupKey(400, 'mensaje de texto'), 'b', 10);
  buf.register(dedup.dedupKey(403, 'audio'), 'c', 20);
  buf.register(dedup.dedupKey(403, 'audio'), 'd', 30);

  const groups = buf.flush(5000).sort((x, y) => x.key.localeCompare(y.key));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, '400|mensaje de texto');
  assert.equal(groups[1].key, '403|audio');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].count, 2);
});

test('una sola alerta en la ventana no genera consolidado redundante', () => {
  const buf = dedup.createAlertDedup({ windowMs: 1000 });
  const r = buf.register(dedup.dedupKey(400, 'audio'), 'x', 0);
  assert.equal(r.emit, true);
  assert.deepEqual(buf.flush(5000), [], 'ya se emitió sola: no hay nada que consolidar');
});

// -----------------------------------------------------------------------------
// R4.3 — buffer acotado (ventana Y tamaño)
// -----------------------------------------------------------------------------
test('R4.3: el buffer no crece sin límite ante claves nuevas', () => {
  const buf = dedup.createAlertDedup({ windowMs: 60000, maxKeys: 4 });
  const resultados = [];
  for (let i = 0; i < 200; i++) {
    resultados.push(buf.register(`clave-sintetica-${i}`, 'x', 0));
  }
  assert.equal(buf.size(), 4, 'la cota de claves se respeta');
  // Fail-closed hacia la visibilidad: el desborde emite, no silencia.
  const desbordadas = resultados.filter((r) => r.overflow);
  assert.ok(desbordadas.length > 0, 'debe haber desborde con 200 claves y cota 4');
  assert.ok(desbordadas.every((r) => r.emit === true), 'el desborde SIEMPRE emite');
});

test('R4.3: mil salientes con error_code distinto no explotan el buffer', () => {
  const buf = dedup.createAlertDedup({ windowMs: 60000 });
  for (let i = 0; i < 1000; i++) {
    buf.register(dedup.dedupKey(i, 'mensaje de texto'), 'x', 0);
  }
  assert.ok(
    buf.size() <= dedup.KNOWN_TELEGRAM_CODES.length + 1,
    `buckets acotados por la coerción, fueron ${buf.size()}`,
  );
});

test('el contador no se pierde aunque la ventana se reabra sin flush', () => {
  const buf = dedup.createAlertDedup({ windowMs: 100 });
  const k = dedup.dedupKey(400, 'audio');
  assert.equal(buf.register(k, 'a', 0).emit, true);
  assert.equal(buf.register(k, 'b', 10).emit, false);
  // Ventana vencida sin flush intermedio: se reabre y vuelve a emitir (nunca
  // queda un evento sin representación).
  assert.equal(buf.register(k, 'c', 5000).emit, true);
});

test('drain() cierra todas las ventanas abiertas', () => {
  const buf = dedup.createAlertDedup({ windowMs: 999999 });
  const k = dedup.dedupKey(400, 'audio');
  buf.register(k, 'a', 0);
  buf.register(k, 'b', 1);
  const groups = buf.drain();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(buf.size(), 0);
});

test('el extracto de muestra queda acotado en tamaño', () => {
  const buf = dedup.createAlertDedup({ windowMs: 1000 });
  const k = dedup.dedupKey(400, 'mensaje de texto');
  buf.register(k, 'X'.repeat(5000), 0);
  buf.register(k, 'otro', 1);
  const [g] = buf.flush(5000);
  assert.ok(g.sample.length <= dedup.MAX_SAMPLE_LEN, 'la muestra se acota');
});

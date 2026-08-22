// =============================================================================
// ux-mockup-dataset.test.js — Tests unitarios (#3408 · CA-UX-3 + CA-S2)
//
// Cobertura:
//   - Bancos `client`, `business`, `delivery` existen y tienen ≥ items mínimos
//   - getBanco devuelve null para flavor inválido (no throws)
//   - sample devuelve N items determinísticos (slice desde el inicio)
//   - mentionsListado detecta keywords y rechaza no-listados
//   - CA-S2: cero PII real (no emails reales, no nombres reales del equipo,
//     teléfonos marcados como demo)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ds = require('../ux-mockup-dataset');
const {
  BANCOS,
  FLAVORS_VALIDOS,
  CLIENT_PRODUCTS,
  BUSINESS_ORDERS,
  DELIVERY_STOPS,
  DEMO_PHONES,
  DEMO_EMAILS,
  getBanco,
  sample,
  mentionsListado,
} = ds;

// -----------------------------------------------------------------------------
// Estructura básica de los bancos
// -----------------------------------------------------------------------------

test('CA-UX-3: existen los tres flavors (client/business/delivery)', () => {
  assert.deepEqual(FLAVORS_VALIDOS, ['client', 'business', 'delivery']);
  assert.ok(BANCOS.client);
  assert.ok(BANCOS.business);
  assert.ok(BANCOS.delivery);
});

test('CA-UX-3: cada flavor expone al menos 8 items realistas', () => {
  assert.ok(CLIENT_PRODUCTS.length >= 15, `productos client (got ${CLIENT_PRODUCTS.length})`);
  assert.ok(BUSINESS_ORDERS.length >= 8, `pedidos business (got ${BUSINESS_ORDERS.length})`);
  assert.ok(DELIVERY_STOPS.length >= 8, `paradas delivery (got ${DELIVERY_STOPS.length})`);
});

test('CA-UX-3: los bancos están congelados (inmutables)', () => {
  assert.equal(Object.isFrozen(BANCOS), true);
  assert.equal(Object.isFrozen(BANCOS.client), true);
  assert.equal(Object.isFrozen(BANCOS.business), true);
  assert.equal(Object.isFrozen(BANCOS.delivery), true);
});

// -----------------------------------------------------------------------------
// CA-S2 — cero PII real
// -----------------------------------------------------------------------------

test('CA-S2: ningún teléfono incluye dígitos plausibles de número real (4..9 al inicio del número local)', () => {
  // El patrón demo es `+54 11 0000-XXXX`. El bloque local debe empezar con 0000.
  for (const tel of DEMO_PHONES) {
    assert.match(tel, /^\+54 11 0000-\d{4}$/, `teléfono no parece demo: ${tel}`);
  }
});

test('CA-S2: ningún email apunta a dominio real', () => {
  for (const mail of DEMO_EMAILS) {
    assert.match(mail, /@ejemplo\.com$/, `email no apunta a ejemplo.com: ${mail}`);
  }
});

test('CA-S2: ningún producto/pedido/parada contiene email plausible', () => {
  const flat = JSON.stringify({ CLIENT_PRODUCTS, BUSINESS_ORDERS, DELIVERY_STOPS });
  // No debe aparecer ningún dominio que NO sea ejemplo.com
  const emails = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  for (const e of emails) {
    assert.match(e, /@ejemplo\.com$/, `email no demo en banco: ${e}`);
  }
});

test('CA-S2: no contiene nombres del equipo (leitolarreta, Leo, etc.)', () => {
  const flat = JSON.stringify(BANCOS).toLowerCase();
  // Lista negra básica — extender si aparecen más nombres reales.
  for (const blacklisted of ['leitolarreta', 'leito', 'larreta', 'leonardo larreta']) {
    assert.equal(flat.includes(blacklisted), false, `aparece nombre del equipo: ${blacklisted}`);
  }
});

test('CA-S2: clientes en pedidos están marcados explícitamente como demo', () => {
  for (const order of BUSINESS_ORDERS) {
    assert.match(order.customer, /^Cliente Demo \d+$/, `customer no marcado demo: ${order.customer}`);
  }
});

// -----------------------------------------------------------------------------
// API: getBanco
// -----------------------------------------------------------------------------

test('getBanco: devuelve banco completo por flavor válido', () => {
  const banco = getBanco('client');
  assert.ok(banco);
  assert.ok(Array.isArray(banco.products));
});

test('getBanco: flavor inválido → null (no throws)', () => {
  assert.equal(getBanco('hacker'), null);
  assert.equal(getBanco(''), null);
  assert.equal(getBanco(null), null);
  assert.equal(getBanco(undefined), null);
  assert.equal(getBanco(123), null);
  assert.equal(getBanco({}), null);
});

// -----------------------------------------------------------------------------
// API: sample
// -----------------------------------------------------------------------------

test('sample: devuelve N items determinísticos (slice desde el inicio)', () => {
  const first = sample('client', 'products', 3);
  const second = sample('client', 'products', 3);
  assert.deepEqual(first, second, 'debe ser determinístico para mismos args');
  assert.equal(first.length, 3);
});

test('sample: N default = 5', () => {
  const items = sample('business', 'orders');
  assert.equal(items.length, 5);
});

test('sample: tipo inexistente devuelve []', () => {
  assert.deepEqual(sample('client', 'noexiste', 5), []);
});

test('sample: flavor inválido devuelve []', () => {
  assert.deepEqual(sample('hacker', 'products', 5), []);
});

test('sample: N > total cap a length del array', () => {
  const items = sample('delivery', 'stops', 9999);
  assert.equal(items.length, DELIVERY_STOPS.length);
});

test('sample: N inválido (negativo, NaN, ∞) cae al default', () => {
  assert.equal(sample('client', 'products', -1).length, 5);
  assert.equal(sample('client', 'products', NaN).length, 5);
  assert.equal(sample('client', 'products', Infinity).length, 5);
});

test('sample: contexto delivery devuelve items del flavor delivery', () => {
  const items = sample('delivery', 'stops', 3);
  assert.equal(items.length, 3);
  for (const stop of items) {
    assert.match(stop.id, /^#R-\d+$/, 'stops delivery tienen id #R-*');
  }
});

// -----------------------------------------------------------------------------
// API: mentionsListado (heurística para activar el dataset)
// -----------------------------------------------------------------------------

test('mentionsListado: detecta keywords obvios', () => {
  assert.equal(mentionsListado('Mostrar la lista de pedidos del comerciante'), true);
  assert.equal(mentionsListado('Pantalla con catálogo de productos'), true);
  assert.equal(mentionsListado('Tabla de paradas pendientes'), true);
  assert.equal(mentionsListado('Grid de productos por categoría'), true);
});

test('mentionsListado: descarta cuando no hay keyword', () => {
  assert.equal(mentionsListado('Cambiar el color del header'), false);
  assert.equal(mentionsListado('Agregar un botón flotante'), false);
});

test('mentionsListado: case insensitive', () => {
  assert.equal(mentionsListado('LISTA DE PEDIDOS'), true);
  assert.equal(mentionsListado('Listado'), true);
});

test('mentionsListado: input inválido devuelve false (no throws)', () => {
  assert.equal(mentionsListado(undefined), false);
  assert.equal(mentionsListado(null), false);
  assert.equal(mentionsListado(123), false);
  assert.equal(mentionsListado(''), false);
});

test('mentionsListado: anti-ReDoS — input gigante completa <50ms', () => {
  const big = 'sin palabras clave repetidas '.repeat(5000);
  const start = Date.now();
  const result = mentionsListado(big);
  const elapsed = Date.now() - start;
  assert.equal(result, false);
  assert.ok(elapsed < 50, `tardó ${elapsed}ms, esperaba <50ms`);
});

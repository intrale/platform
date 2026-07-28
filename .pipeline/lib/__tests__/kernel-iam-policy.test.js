'use strict';

// =============================================================================
// kernel-iam-policy.test.js — La policy IAM del kernel, verificada COMO DATO
// (#5124 · CA-1 / CA-4 · REQ-SEC-1 / REQ-SEC-2)
//
// Por qué existe este archivo:
//
// La garantía de no-repudio del kernel (firmas + audit) no la sostiene el código:
// la sostiene la policy IAM. Hasta #5124, el `Deny` que la respaldaba estaba
// condicionado por `dynamodb:LeadingKeys` con patrones `signature#*`/`audit#*` —
// pero `LeadingKeys` evalúa la **partition key** y esos prefijos viven en la
// **sort key**, así que la condición no matcheaba nunca. El `Deny` era inerte y
// nadie lo notaba, porque un archivo JSON no se rompe: se lee bien y miente bien.
//
// Estos tests leen el JSON como dato y afirman las propiedades que hacen que la
// garantía sea real. No prueban enforcement de AWS (eso requiere credenciales y
// es CA-B2 de #5126); prueban que la policy que se va a aplicar dice lo que
// tiene que decir, y que los dos atajos que la deshacen en una línea —un wildcard
// en el `Resource` del `Allow`, o un `Deny` demasiado amplio— quedan bloqueados.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'pipeline', 'kernel-iam-policy.json');

const ARN_NO_REPUDIO = 'arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE';
const ARN_COORD = 'arn:aws:dynamodb:REGION:ACCOUNT:table/COORD_TABLE';

// Las 7 acciones: cada camino de escritura de DynamoDB es una acción IAM distinta.
// `BatchWriteItem`, `TransactWriteItems` y las tres PartiQL borran o pisan un ítem
// SIN invocar `UpdateItem`/`DeleteItem`. Denegar sólo esas dos deja 5 puertas.
const ACCIONES_MUTACION = [
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:TransactWriteItems',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
  'dynamodb:PartiQLInsert',
];

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const statementsOf = (policy, effect) => policy.Statement.filter((s) => s.Effect === effect);

test('#5124 · la policy es JSON válido con la forma esperada', () => {
  const policy = loadPolicy();
  assert.equal(policy.Version, '2012-10-17');
  assert.ok(Array.isArray(policy.Statement) && policy.Statement.length >= 3,
    'runtime de no-repudio + deny + coordinación');
  for (const s of policy.Statement) {
    assert.ok(typeof s.Sid === 'string' && s.Sid, 'todo statement lleva Sid (trazabilidad)');
    assert.ok(s.Effect === 'Allow' || s.Effect === 'Deny');
    assert.ok(asArray(s.Action).length > 0);
    assert.ok(asArray(s.Resource).length > 0);
  }
});

// ---------------------------------------------------------------------------
// CA-1 — El Deny de no-repudio es efectivo, no ceremonial
// ---------------------------------------------------------------------------

test('#5124 CA-1 · el Deny sobre la tabla de no-repudio enumera las 7 acciones de mutación', () => {
  const policy = loadPolicy();
  const denies = statementsOf(policy, 'Deny')
    .filter((s) => asArray(s.Resource).includes(ARN_NO_REPUDIO));
  assert.equal(denies.length, 1, 'exactamente un Deny sobre la tabla de no-repudio');

  const acciones = asArray(denies[0].Action);
  for (const a of ACCIONES_MUTACION) {
    assert.ok(acciones.includes(a),
      `el Deny debe cubrir ${a}: es un camino de escritura independiente de UpdateItem/DeleteItem`);
  }
  assert.equal(acciones.length, ACCIONES_MUTACION.length,
    'sin acciones de más (mínimo privilegio también aplica al Deny)');
});

test('#5124 CA-1 · el Deny NO tiene Condition (la de LeadingKeys era inerte)', () => {
  const policy = loadPolicy();
  const deny = statementsOf(policy, 'Deny').find((s) => asArray(s.Resource).includes(ARN_NO_REPUDIO));
  assert.equal('Condition' in deny, false,
    'una Condition volvería a atar la garantía a una convención de nombres en la sort key');
});

test('#5124 CA-1 · ninguna Condition de la policy usa dynamodb:LeadingKeys sobre prefijos de sort key', () => {
  // Regresión dirigida: `LeadingKeys` evalúa la PARTITION KEY. Usarlo con
  // `signature#*`/`audit#*` (que son prefijos de SORT KEY) no matchea nunca.
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  assert.equal(/LeadingKeys/.test(raw), false,
    'LeadingKeys no puede scopear por prefijo de sort key: IAM no lo ofrece de ninguna forma');
  assert.equal(/signature#|audit#|claim#/.test(raw), false,
    'la policy no puede depender de prefijos de sort key para su efectividad');
});

test('#5124 CA-1 · ningún Allow concede mutación sobre la tabla de no-repudio', () => {
  // Deny-by-default: ésta es la capa que SÍ estaba enforced desde siempre.
  const policy = loadPolicy();
  const allowsNoRepudio = statementsOf(policy, 'Allow')
    .filter((s) => asArray(s.Resource).includes(ARN_NO_REPUDIO));
  assert.ok(allowsNoRepudio.length >= 1, 'el runtime necesita leer/escribir append-only');

  for (const s of allowsNoRepudio) {
    for (const a of asArray(s.Action)) {
      assert.equal(ACCIONES_MUTACION.includes(a), false,
        `el Allow "${s.Sid}" no puede conceder ${a} sobre la tabla de no-repudio`);
    }
  }
});

// ---------------------------------------------------------------------------
// CA-4 — La tabla de coordinación, con mínimo privilegio y ARNs literales
// ---------------------------------------------------------------------------

test('#5124 CA-4 · el Allow de coordinación concede exactamente 4 acciones (sin Query ni UpdateItem)', () => {
  const policy = loadPolicy();
  const coord = statementsOf(policy, 'Allow')
    .filter((s) => asArray(s.Resource).includes(ARN_COORD));
  assert.equal(coord.length, 1, 'un único Allow para la tabla de coordinación');

  const acciones = asArray(coord[0].Action).slice().sort();
  assert.deepEqual(acciones, [
    'dynamodb:ConditionCheckItem',
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
  ].sort(), 'son las operaciones que kernel-coordination-store ejecuta realmente');

  // Contraprueba explícita: no se copió el Allow de la tabla principal "por simetría".
  assert.equal(acciones.includes('dynamodb:Query'), false, 'el coordination store nunca hace Query');
  assert.equal(acciones.includes('dynamodb:UpdateItem'), false, 'el CAS se hace con PutItem condicional');
});

test('#5124 CA-4 · ningún Allow que conceda borrado/mutación tiene wildcard en su Resource', () => {
  // El atajo que deshace CA-1 en una línea: `table/TABLE*` en el Allow de coord
  // vuelve a alcanzar `table/TABLE` y el borrado queda concedido sobre no-repudio.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Allow')) {
    const concedeMutacion = asArray(s.Action).some((a) => ACCIONES_MUTACION.includes(a));
    if (!concedeMutacion) continue;
    for (const r of asArray(s.Resource)) {
      assert.equal(r.includes('*'), false,
        `el Allow "${s.Sid}" concede mutación: su Resource debe ser un ARN literal, no ${r}`);
    }
  }
});

test('#5124 CA-4 · el Deny apunta al ARN exacto, sin wildcard (o trabaría la coordinación)', () => {
  // El mismo bug del otro lado: un Deny amplio alcanzaría la tabla coord y, como
  // el Deny siempre gana, el release de un claim quedaría bloqueado para siempre.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Deny')) {
    for (const r of asArray(s.Resource)) {
      assert.equal(r.includes('*'), false, `Deny "${s.Sid}" con wildcard: ${r}`);
      assert.notEqual(r, ARN_COORD, 'el Deny no puede alcanzar la tabla de coordinación');
    }
  }
});

test('#5124 CA-4 · los Resource de las dos tablas son ARNs literales y distintos', () => {
  const policy = loadPolicy();
  const arns = new Set(policy.Statement.flatMap((s) => asArray(s.Resource)));
  assert.ok(arns.has(ARN_NO_REPUDIO), 'está la tabla de no-repudio');
  assert.ok(arns.has(ARN_COORD), 'está la tabla de coordinación');
  assert.notEqual(ARN_NO_REPUDIO, ARN_COORD);
  // Ningún ARN de la policy contiene comodines en el segmento de nombre de tabla.
  for (const r of arns) {
    assert.match(r, /^arn:aws:dynamodb:[^:]+:[^:]+:table\/[A-Za-z0-9_.-]+$/, `ARN no literal: ${r}`);
  }
});

// ---------------------------------------------------------------------------
// CA-4 — Cero valores reales commiteados
// ---------------------------------------------------------------------------

test('#5124 CA-4 · los placeholders se conservan: nada de cuentas ni tablas reales en el repo', () => {
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  for (const ph of ['REGION', 'ACCOUNT', 'TABLE', 'COORD_TABLE']) {
    assert.ok(raw.includes(ph), `falta el placeholder ${ph}`);
  }
  // Un account-id de AWS es de 12 dígitos: si aparece uno, se filtró un valor real.
  assert.equal(/:\d{12}:/.test(raw), false, 'hay un account-id real commiteado');
  // Regiones reales típicas en el segmento de región.
  assert.equal(/arn:aws:dynamodb:[a-z]{2}-[a-z]+-\d:/.test(raw), false, 'hay una región real commiteada');
});

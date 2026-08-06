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

test('#5124 CA-4 · el Deny de PLANO DE DATOS apunta al ARN exacto, sin wildcard (o trabaría la coordinación)', () => {
  // El mismo bug del otro lado: un Deny amplio alcanzaría la tabla coord y, como
  // el Deny siempre gana, el release de un claim quedaría bloqueado para siempre.
  //
  // #5211 — El alcance de esta assertion es el Deny de PLANO DE DATOS. Los Deny
  // de CONTROL PLANE agregados en #5211 (CreateTable/DeleteTable/…) sí usan
  // `table/*` a propósito: el runtime no debe administrar NINGUNA tabla, ni las
  // suyas ni una que alguien cree mañana. Ese wildcard no puede trabar la
  // coordinación porque no alcanza ninguna acción de plano de datos — invariante
  // que verifica el test "ningún Deny de control plane…" más abajo.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Deny')) {
    const esPlanoDeDatos = asArray(s.Action).some((a) => ACCIONES_MUTACION.includes(a));
    if (!esPlanoDeDatos) continue;
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
  // Ningún ARN que nombre una tabla concreta puede llevar comodín en ese segmento.
  // (`table/*` del Deny de control plane queda fuera: no nombra una tabla, las
  // abarca a todas a propósito.)
  for (const r of arns) {
    if (!r.startsWith('arn:aws:dynamodb:')) continue;
    if (r.endsWith(':table/*')) continue;
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

// ---------------------------------------------------------------------------
// #5211 CA-3 — El runtime no administra nada: Deny EXPLÍCITO de control plane
//
// Antes de #5211, `DeleteTable`/`UpdateTable`/`UpdateContinuousBackups` caían en
// **implicitDeny** (falta un Allow). Está denegado hoy, sí — pero un implicitDeny
// se deshace con que alguien agregue un `Allow` de más, y nadie se entera. Un
// `Deny` explícito gana sobre cualquier `Allow` futuro: es la diferencia entre
// "hoy no puede" y "no va a poder".
//
// Lo que está en juego con cada uno: apagar PITR o deletion protection deja la
// evidencia de no-repudio borrable **por otra vía** — el append-only del plano
// de datos no sirve de nada si el runtime puede tirar la tabla entera.
// ---------------------------------------------------------------------------

// Acciones que destruyen o degradan la evidencia sin tocar un solo ítem.
const ACCIONES_CONTROL_PLANE = [
  'dynamodb:CreateTable',
  'dynamodb:DeleteTable',
  'dynamodb:UpdateTable',
  'dynamodb:UpdateContinuousBackups',
  'dynamodb:DeleteBackup',
  'dynamodb:RestoreTableFromBackup',
  'dynamodb:RestoreTableToPointInTime',
];

// Las tres que el runtime necesita para leer/escribir una tabla cifrada con CMK.
// Un `Deny` que las alcance deja el store ILEGIBLE: es la regresión que el probe
// `nonrepudio-get-item` de kernel-iam-verify.js vigila en caliente.
const ACCIONES_KMS_DE_USO = ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'];

test('#5211 CA-3 · el control plane de DynamoDB está denegado EXPLÍCITAMENTE, no por ausencia de Allow', () => {
  const policy = loadPolicy();
  const denegadas = new Set(
    statementsOf(policy, 'Deny').flatMap((s) => asArray(s.Action)),
  );
  for (const a of ACCIONES_CONTROL_PLANE) {
    assert.ok(denegadas.has(a),
      `${a} debe llevar Deny explícito: en implicitDeny, un Allow futuro la habilita en silencio`);
  }
});

test('#5211 CA-3 · el Deny de control plane abarca TODA tabla de la cuenta/región, no sólo las dos del kernel', () => {
  // Acotarlo a `table/TABLE` dejaría al runtime crear tablas nuevas y operarlas
  // sin restricción: el mínimo privilegio se evalúa sobre la cuenta, no sobre
  // los recursos que hoy conocemos.
  const policy = loadPolicy();
  const deny = statementsOf(policy, 'Deny')
    .find((s) => asArray(s.Action).includes('dynamodb:CreateTable'));
  assert.ok(deny, 'existe el Deny de control plane');
  assert.deepEqual(asArray(deny.Resource), ['arn:aws:dynamodb:REGION:ACCOUNT:table/*'],
    'alcanza toda tabla de la cuenta/región, y sigue acotado a cuenta+región (no `*` global)');
});

test('#5211 CA-3 · ningún Deny de control plane arrastra acciones de plano de datos', () => {
  // El wildcard `table/*` del control plane alcanza la tabla de coordinación.
  // Si a ese statement se le colara un `DeleteItem`, el release de un claim
  // quedaría bloqueado para siempre — el bug de #5124, reintroducido por la
  // puerta de atrás.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Deny')) {
    const alcanzaTodaTabla = asArray(s.Resource).some((r) => r.endsWith(':table/*') || r === '*');
    if (!alcanzaTodaTabla) continue;
    for (const a of asArray(s.Action)) {
      assert.equal(ACCIONES_MUTACION.includes(a), false,
        `el Deny amplio "${s.Sid}" no puede incluir ${a}: trabaría la coordinación`);
      assert.equal(a === 'dynamodb:GetItem' || a === 'dynamodb:Query' || a === 'dynamodb:PutItem', false,
        `el Deny amplio "${s.Sid}" no puede incluir ${a}: dejaría el store inoperante`);
    }
  }
});

test('#5211 CA-3 · la administración de KMS e IAM está denegada explícitamente', () => {
  const policy = loadPolicy();
  const denegadas = new Set(statementsOf(policy, 'Deny').flatMap((s) => asArray(s.Action)));
  // KMS: borrar/deshabilitar la CMK haría ilegible TODA la evidencia histórica.
  for (const a of ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:CreateGrant']) {
    assert.ok(denegadas.has(a), `falta Deny explícito de ${a}`);
  }
  // IAM: sin esto, el runtime se auto-adjunta AdministratorAccess y todo lo
  // anterior es decorativo.
  for (const a of ['iam:AttachUserPolicy', 'iam:PutUserPolicy', 'iam:CreateAccessKey']) {
    assert.ok(denegadas.has(a), `falta Deny explícito de ${a}`);
  }
});

test('#5211 · el catch-all de KMS NO alcanza Decrypt/GenerateDataKey (dejaría el store ilegible)', () => {
  // Riesgo señalado en la validación: un `Deny` de `kms:*` sobre `*` apaga la
  // administración… y de paso el descifrado. La tabla queda inaccesible y el
  // pipeline cae fail-closed al primer read. El Deny enumera acciones de
  // administración una por una, justamente para no poder cometer este error.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Deny')) {
    for (const a of asArray(s.Action)) {
      assert.equal(a === 'kms:*', false,
        `el Deny "${s.Sid}" usa kms:* — alcanzaría Decrypt y el store queda ilegible`);
      assert.equal(ACCIONES_KMS_DE_USO.includes(a), false,
        `el Deny "${s.Sid}" alcanza ${a}: el runtime no podría leer la tabla cifrada`);
    }
  }
});

test('#5211 · la policy de datos NO concede kms:* — el uso de la CMK vive en la key policy', () => {
  // Hallazgo empírico de #5211: el runtime lee y escribe una tabla cifrada con
  // CMK **sin un solo statement kms en su identity policy**. La autorización la
  // da la key policy del CMK (`RuntimeUseViaDynamoDBOnly`, condicionada por
  // `kms:ViaService`), versionada aparte en kernel-kms-key-policy.json.
  //
  // Agregar `kms:Decrypt` acá sería privilegio redundante Y peligroso: en la
  // identity policy no está atado a `ViaService`, así que habilitaría usar la
  // CMK fuera de DynamoDB. Este test lo bloquea.
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Allow')) {
    for (const a of asArray(s.Action)) {
      assert.equal(a.startsWith('kms:'), false,
        `el Allow "${s.Sid}" concede ${a}: el uso de la CMK se autoriza por key policy, no por identity policy`);
    }
  }
});

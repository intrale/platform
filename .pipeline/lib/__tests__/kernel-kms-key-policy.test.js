'use strict';

// =============================================================================
// kernel-kms-key-policy.test.js — La KEY POLICY de la CMK, verificada COMO DATO
// (#5211 · CA-1 / CA-3)
//
// POR QUÉ ESTE ARCHIVO EXISTE
// ---------------------------
// La validación de #5211 detectó que `grep -c "kms:" kernel-iam-policy.json`
// daba **0**: los permisos de la CMK no tenían ninguna representación en el repo.
// La conclusión intuitiva era "faltan statements KMS en la identity policy".
//
// La verificación empírica mostró otra cosa. El principal runtime escribe y lee
// una tabla cifrada con CMK **sin un solo statement kms en su identity policy**,
// y al mismo tiempo `kms:DescribeKey` directo le da AccessDenied. Eso sólo puede
// pasar por una vía: la autorización vive en la **key policy** del CMK
// (`RuntimeUseViaDynamoDBOnly`), condicionada por `kms:ViaService`.
//
// O sea: el permiso existía y estaba bien diseñado, pero era invisible para el
// repo — nadie podía revisarlo en un PR ni detectar que se aflojara. Lo que
// faltaba no era permiso, era **versionado**. Este archivo prueba el artefacto
// que cierra ese hueco.
//
// LÍMITE HONESTO DE LO QUE ESTOS TESTS PRUEBAN
// ---------------------------------------------
// Prueban que el JSON versionado dice lo correcto. NO prueban que la key policy
// aplicada en AWS sea igual a este archivo — para eso está la matriz empírica
// (`kernel-iam-verify.js`, probes `kms-describe-key` y `nonrepudio-get-item`).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.resolve(
  __dirname, '..', '..', '..', 'docs', 'pipeline', 'kernel-kms-key-policy.json',
);

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const loadPolicy = () => JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const sid = (policy, name) => policy.Statement.find((s) => s.Sid === name);

// Las tres acciones que DynamoDB ejerce sobre la CMK en nombre del runtime.
const ACCIONES_DE_USO = ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'];

test('#5211 · la key policy es JSON válido con la forma esperada', () => {
  const policy = loadPolicy();
  assert.equal(policy.Version, '2012-10-17');
  assert.ok(Array.isArray(policy.Statement) && policy.Statement.length >= 2,
    'admin delegado + uso acotado del runtime');
  for (const s of policy.Statement) {
    assert.ok(typeof s.Sid === 'string' && s.Sid, 'todo statement lleva Sid');
    assert.ok(s.Principal && typeof s.Principal === 'object',
      'una key policy es resource-based: el Principal es obligatorio');
  }
});

test('#5211 CA-3 · el runtime recibe SÓLO uso de la clave, nunca administración', () => {
  const policy = loadPolicy();
  const runtime = sid(policy, 'RuntimeUseViaDynamoDBOnly');
  assert.ok(runtime, 'existe el statement del principal runtime');
  assert.equal(runtime.Effect, 'Allow');

  const acciones = asArray(runtime.Action).slice().sort();
  assert.deepEqual(acciones, ACCIONES_DE_USO.slice().sort(),
    'exactamente las tres de uso: nada de PutKeyPolicy, ScheduleKeyDeletion ni CreateGrant');
});

test('#5211 CA-3 · el uso de la CMK está atado a kms:ViaService de DynamoDB', () => {
  // Sin esta Condition, el principal podría llamar kms:Decrypt DIRECTO y usar la
  // clave para descifrar cualquier cosa cifrada con ella, fuera del store. La
  // Condition es lo que convierte "puede usar la clave" en "puede usar la clave
  // únicamente como efecto de una operación DynamoDB".
  const policy = loadPolicy();
  const runtime = sid(policy, 'RuntimeUseViaDynamoDBOnly');
  const cond = runtime.Condition && runtime.Condition.StringEquals;
  assert.ok(cond, 'el statement del runtime lleva Condition StringEquals');
  assert.equal(cond['kms:ViaService'], 'dynamodb.REGION.amazonaws.com',
    'ViaService pinnea servicio Y región');
});

test('#5211 · el encryption context acota la CMK a las DOS tablas del kernel', () => {
  // Las dos tablas comparten CMK. `ViaService` sólo pinnea el servicio: sin
  // encryption context, el runtime podría usar la clave vía DynamoDB sobre
  // CUALQUIER otra tabla de la cuenta cifrada con ella (uso cruzado).
  const policy = loadPolicy();
  const runtime = sid(policy, 'RuntimeUseViaDynamoDBOnly');
  const cond = runtime.Condition.StringEquals;
  const ctx = cond['kms:EncryptionContext:aws:dynamodb:tableName'];
  assert.ok(ctx, 'hay condición por encryption context de tabla');

  const tablas = asArray(ctx).slice().sort();
  assert.deepEqual(tablas, ['COORD_TABLE', 'TABLE'],
    'enumera las dos tablas por placeholder, sin comodines');
  for (const t of tablas) {
    assert.equal(t.includes('*'), false,
      `"${t}" con comodín: reabriría el uso cruzado que esta condición cierra`);
  }
});

test('#5211 · la administración queda delegada al IAM de la cuenta, no al runtime', () => {
  // Una key policy sin statement de admin deja la clave **inadministrable para
  // siempre**: ni el root puede recuperarla. El statement de root es obligatorio
  // — pero tiene que ser del root, no del principal runtime.
  const policy = loadPolicy();
  const admin = sid(policy, 'AdminDelegatedToAccountIAM');
  assert.ok(admin, 'existe el statement de administración delegada');
  assert.match(admin.Principal.AWS, /:root$/, 'la administración va al root de la cuenta');
  assert.equal(admin.Action, 'kms:*');

  // Y el principal runtime NO puede aparecer en ese statement.
  assert.equal(/RUNTIME_PRINCIPAL/.test(JSON.stringify(admin)), false,
    'el runtime no puede estar en el statement de administración');
});

test('#5211 CA-4 · los placeholders se conservan: nada real commiteado', () => {
  const raw = fs.readFileSync(POLICY_PATH, 'utf8');
  for (const ph of ['ACCOUNT', 'REGION', 'TABLE', 'COORD_TABLE', 'RUNTIME_PRINCIPAL']) {
    assert.ok(raw.includes(ph), `falta el placeholder ${ph}`);
  }
  assert.equal(/:\d{12}:/.test(raw), false, 'hay un account-id real commiteado');
  assert.equal(/dynamodb\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com/.test(raw), false,
    'hay una región real commiteada');
  // UUID de CMK: la key policy va adjunta a la clave, no la referencia por id.
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw), false,
    'hay un id de CMK real commiteado');
});

'use strict';

// =============================================================================
// vault-iam-policy.test.js — La policy IAM del vault, verificada COMO DATO
// (#5351 · CA-10 … CA-16)
//
// Por qué existe este archivo:
//
// Un JSON de policy no se rompe al leerse: se lee bien y miente bien. La lección
// es literal de `kernel-iam-policy.test.js`: ahí un `Deny` quedó inerte durante
// meses porque su `Condition` usaba `dynamodb:LeadingKeys` (que evalúa la
// partition key) contra prefijos de sort key. Nadie lo notó, porque el archivo
// parseaba perfecto.
//
// Acá hay DOS trampas del mismo tipo, y son las que estas aserciones bloquean:
//
//   1. Un `Allow` cuyo Resource sea `…:parameter/intrale/PROJECT/*` (el prefijo
//      de PROYECTO, no el del host). Con `GetParametersByPath --recursive` eso le
//      entrega a cada host el vault de todos sus pares — y la policy sigue
//      pareciendo acotada, porque no tiene ningún `Resource: "*"`.
//   2. Un statement `kms:Decrypt` sin `Condition`, o con las dos claves de
//      `EncryptionContext` en el MISMO statement. La CMK es compartida con el
//      store durable de #5210: sin `Condition`, el rol de host puede descifrar
//      material que no le corresponde. Y con las dos claves juntas —que IAM
//      evalúa en AND— no matchea nunca y el vault queda inutilizable.
//
// Estos tests NO prueban enforcement de AWS: la policy todavía no está aplicada
// (eso es #5211, y sale como gap G-4 con `verified: null` en el doc). Prueban que
// la policy que se va a aplicar dice lo que tiene que decir.
//
// Lo que NO se pudo calcar de `kernel-iam-policy.test.js`, y por qué:
//
//   | Aserción del kernel                       | Por qué acá no sirve                                    |
//   |-------------------------------------------|---------------------------------------------------------|
//   | `assert.equal(r.includes('*'), false)`    | En SSM/Secrets Manager el scoping ES por prefijo: el `*` |
//   |                                           | final es obligatorio, y el ARN de un secreto de SM lleva |
//   |                                           | además un sufijo aleatorio que impide escribirlo literal.|
//   | regex `arn:aws:dynamodb:<region>:`        | Acá hay tres servicios: ssm, secretsmanager y kms.       |
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'pipeline', 'vault-iam-policy.json');
const DOC_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'pipeline', 'vault-secretos-aws.md');

// Los cinco placeholders del entregable. Convención SCREAMING, la misma ya
// commiteada y testeada en `kernel-iam-policy.json`.
const PLACEHOLDERS = ['REGION', 'ACCOUNT', 'PROJECT', 'HOST', 'CMK_ID'];

// Las 7 acciones de escritura del vault. Denegar sólo `ssm:PutParameter` deja
// seis puertas abiertas: cada una es un camino de escritura independiente.
const ACCIONES_ESCRITURA_SSM = [
  'ssm:PutParameter',
  'ssm:DeleteParameter',
  'ssm:DeleteParameters',
  'ssm:LabelParameterVersion',
];
const ACCIONES_ESCRITURA_SM = [
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DeleteSecret',
];
const ACCIONES_ESCRITURA = [...ACCIONES_ESCRITURA_SSM, ...ACCIONES_ESCRITURA_SM];

// Acciones que NO admiten permisos a nivel de recurso: concederlas es concederlas
// sobre TODO el vault de la cuenta (D6).
const ACCIONES_QUE_ENUMERAN = ['ssm:DescribeParameters', 'secretsmanager:ListSecrets'];

// Prefijos que abarcan un servicio entero. No son "scoping por prefijo": son un
// `Resource: "*"` con más caracteres.
const RESOURCE_DEMASIADO_AMPLIO = [/:parameter\/\*$/, /:secret:\*$/];

function loadRaw() {
  return fs.readFileSync(POLICY_PATH, 'utf8');
}
function loadPolicy() {
  return JSON.parse(loadRaw());
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const statementsOf = (policy, effect) => policy.Statement.filter((s) => s.Effect === effect);
const accionesDe = (policy) => policy.Statement.flatMap((s) => asArray(s.Action));
const esStatementKms = (s) => asArray(s.Action).some((a) => a.startsWith('kms:'));

// -----------------------------------------------------------------------------
// Las reglas, extraídas como funciones puras para poder correrlas contra una
// policy MUTADA (contrapruebas del final). Un test de policy que nunca vio rojo
// no prueba nada.
// -----------------------------------------------------------------------------

/** CA-10 · ningún Allow apunta al prefijo de PROYECTO a secas. */
function reglaAllowNoAlcanzaElProyectoEntero(policy) {
  for (const s of statementsOf(policy, 'Allow')) {
    for (const r of asArray(s.Resource)) {
      assert.equal(/:parameter\/intrale\/PROJECT\/\*$/.test(r), false,
        `Allow "${s.Sid}": con Resource ${r}, un GetParametersByPath --recursive le entrega ` +
        `a cada host el vault de todos sus pares. El aislamiento por host desaparece en un ` +
        `carácter y la policy sigue pareciendo acotada porque no tiene Resource "*".`);
    }
  }
}

/** CA-12 · todo statement KMS lleva Condition, con ViaService y EncryptionContext. */
function reglaKmsSiempreCondicionado(policy) {
  const kms = policy.Statement.filter(esStatementKms);
  assert.ok(kms.length > 0, 'la policy necesita al menos un statement KMS: sin él no se lee ningún SecureString');
  for (const s of kms) {
    assert.ok(s.Condition,
      `statement KMS "${s.Sid}" sin Condition: la CMK es COMPARTIDA con el store durable de #5210. ` +
      `Sin Condition, el rol de host puede descifrar material de ese store — el Deny de no-repudio ` +
      `de #5210 protege a nivel DynamoDB, no a nivel KMS.`);
    const cond = JSON.stringify(s.Condition);
    assert.ok(cond.includes('kms:ViaService'),
      `statement KMS "${s.Sid}" sin kms:ViaService: quedaría habilitada la llamada directa a KMS, ` +
      `salteando el servicio que da el contexto de cifrado.`);
    assert.match(cond, /kms:EncryptionContext:(PARAMETER_ARN|SecretARN)/,
      `statement KMS "${s.Sid}" sin EncryptionContext: ViaService solo acota el CANAL, no el material. ` +
      `Cualquier parámetro de la cuenta leído vía SSM quedaría descifrable.`);
  }
}

// -----------------------------------------------------------------------------
// Forma del artefacto
// -----------------------------------------------------------------------------

test('#5351 · la policy es JSON válido con la forma esperada', () => {
  const policy = loadPolicy();
  assert.equal(policy.Version, '2012-10-17');
  assert.ok(Array.isArray(policy.Statement) && policy.Statement.length >= 6,
    '2 lecturas SSM disjuntas + 1 lectura SM + 2 KMS + al menos 1 Deny');
  for (const s of policy.Statement) {
    assert.ok(typeof s.Sid === 'string' && s.Sid,
      'todo statement lleva Sid: sin él, un AccessDenied en CloudTrail no se puede atribuir ' +
      'a una decisión de diseño');
    assert.ok(s.Effect === 'Allow' || s.Effect === 'Deny', `Effect inválido en "${s.Sid}"`);
    assert.ok(asArray(s.Action).length > 0, `statement "${s.Sid}" sin Action`);
    assert.ok(asArray(s.Resource).length > 0, `statement "${s.Sid}" sin Resource`);
  }
});

// -----------------------------------------------------------------------------
// CA-10 — Dos statements de lectura, separados y disjuntos
// -----------------------------------------------------------------------------

test('#5351 CA-10 · hay dos lecturas SSM separadas: el prefijo del host y el compartido', () => {
  const policy = loadPolicy();
  const arnsAllowSsm = statementsOf(policy, 'Allow')
    .filter((s) => asArray(s.Action).some((a) => a.startsWith('ssm:')))
    .flatMap((s) => asArray(s.Resource));

  assert.ok(arnsAllowSsm.includes('arn:aws:ssm:REGION:ACCOUNT:parameter/intrale/PROJECT/hosts/HOST/*'),
    'falta el Allow sobre el prefijo del host: sin él, hosts/ no es legible y la jerarquía no sirve');
  assert.ok(arnsAllowSsm.includes('arn:aws:ssm:REGION:ACCOUNT:parameter/intrale/PROJECT/shared/*'),
    'falta el Allow sobre el prefijo compartido');

  // Disjuntos: ningún ARN de lectura puede ser prefijo del otro.
  const hosts = 'arn:aws:ssm:REGION:ACCOUNT:parameter/intrale/PROJECT/hosts/HOST/';
  const shared = 'arn:aws:ssm:REGION:ACCOUNT:parameter/intrale/PROJECT/shared/';
  assert.equal(hosts.startsWith(shared), false, 'los dos prefijos de lectura deben ser disjuntos');
  assert.equal(shared.startsWith(hosts), false, 'los dos prefijos de lectura deben ser disjuntos');
});

test('#5351 CA-10 · ningún Allow apunta al prefijo de PROYECTO a secas', () => {
  reglaAllowNoAlcanzaElProyectoEntero(loadPolicy());
});

test('#5351 CA-10 · el Deny SÍ puede usar el prefijo de proyecto (por eso la regla filtra por Allow)', () => {
  // Documenta por qué la regla de arriba filtra `Effect === 'Allow'`: sin ese
  // filtro, el test se rompería contra su propia policy correcta. Denegar de más
  // es seguro; permitir de más, no.
  const policy = loadPolicy();
  const denyProyecto = statementsOf(policy, 'Deny')
    .flatMap((s) => asArray(s.Resource))
    .filter((r) => /\/intrale\/PROJECT\/\*$/.test(r));
  assert.ok(denyProyecto.length >= 1,
    'el Deny debe cubrir todo el prefijo del proyecto: un Deny más angosto que el Allow deja hueco');
});

// -----------------------------------------------------------------------------
// CA-11 — El rol de host no puede enumerar (D6)
// -----------------------------------------------------------------------------

test('#5351 CA-11 · la policy no concede acciones que exijan Resource "*"', () => {
  const acciones = accionesDe(loadPolicy());
  for (const a of ACCIONES_QUE_ENUMERAN) {
    assert.equal(acciones.includes(a), false,
      `${a} no admite permisos a nivel de recurso: concederla es concederla sobre TODO el vault ` +
      `de la cuenta. Un host comprometido pasaría de "lee lo que sabe pedir" a "inventaria todo".`);
  }
});

// -----------------------------------------------------------------------------
// CA-12 — kms:Decrypt acotado, en dos statements separados
// -----------------------------------------------------------------------------

test('#5351 CA-12 · ningún statement KMS sin Condition, y con ViaService + EncryptionContext', () => {
  reglaKmsSiempreCondicionado(loadPolicy());
});

test('#5351 CA-12 · las dos claves de EncryptionContext viven en statements SEPARADOS', () => {
  // Las condiciones de un mismo statement se evalúan en AND. Un Decrypt originado
  // en SSM trae PARAMETER_ARN pero NO trae SecretARN: un statement único con las
  // dos claves no matchea nunca y el vault queda inutilizable, con un AccessDenied
  // que parece de permisos de lectura y manda a diagnosticar al lugar equivocado.
  const policy = loadPolicy();
  const kms = policy.Statement.filter(esStatementKms);
  for (const s of kms) {
    const cond = JSON.stringify(s.Condition);
    const tieneParam = cond.includes('kms:EncryptionContext:PARAMETER_ARN');
    const tieneSecret = cond.includes('kms:EncryptionContext:SecretARN');
    assert.equal(tieneParam && tieneSecret, false,
      `statement KMS "${s.Sid}" mezcla PARAMETER_ARN y SecretARN: las Condition de un statement ` +
      `se evalúan en AND, así que este statement no matchearía NUNCA y el vault quedaría muerto.`);
    assert.ok(tieneParam || tieneSecret, `statement KMS "${s.Sid}" sin ninguna clave de EncryptionContext`);
  }
  assert.equal(kms.filter((s) => JSON.stringify(s.Condition).includes('PARAMETER_ARN')).length, 1,
    'exactamente un statement KMS para el camino de Parameter Store');
  assert.equal(kms.filter((s) => JSON.stringify(s.Condition).includes('SecretARN')).length, 1,
    'exactamente un statement KMS para el camino de Secrets Manager');
});

test('#5351 CA-12 · cada ViaService apunta al servicio que corresponde a su EncryptionContext', () => {
  // Cruzar ViaService con la clave de contexto (ssm + SecretARN, p.ej.) produce un
  // statement que tampoco matchea nunca — mismo modo de falla, más difícil de ver.
  const policy = loadPolicy();
  for (const s of policy.Statement.filter(esStatementKms)) {
    const cond = JSON.stringify(s.Condition);
    if (cond.includes('kms:EncryptionContext:PARAMETER_ARN')) {
      assert.match(cond, /"kms:ViaService":\s*"ssm\.REGION\.amazonaws\.com"/,
        `"${s.Sid}" condiciona por PARAMETER_ARN pero su ViaService no es el de SSM`);
    } else {
      assert.match(cond, /"kms:ViaService":\s*"secretsmanager\.REGION\.amazonaws\.com"/,
        `"${s.Sid}" condiciona por SecretARN pero su ViaService no es el de Secrets Manager`);
    }
  }
});

// -----------------------------------------------------------------------------
// CA-13 — El rol de runtime no escribe: las 7 acciones, no una
// -----------------------------------------------------------------------------

test('#5351 CA-13 · ningún Allow concede ninguna de las 7 acciones de escritura', () => {
  const policy = loadPolicy();
  for (const s of statementsOf(policy, 'Allow')) {
    for (const a of asArray(s.Action)) {
      assert.equal(ACCIONES_ESCRITURA.includes(a), false,
        `el Allow "${s.Sid}" concede ${a}: escribir en el vault es del rol de PROVISIÓN, ` +
        `no del de runtime. Son dos principales distintos.`);
    }
  }
});

test('#5351 CA-13 · el Deny enumera las 7 acciones de escritura, sin extras', () => {
  const policy = loadPolicy();
  const denegadas = statementsOf(policy, 'Deny').flatMap((s) => asArray(s.Action));
  for (const a of ACCIONES_ESCRITURA) {
    assert.ok(denegadas.includes(a),
      `el Deny no cubre ${a}: es un camino de escritura independiente. Denegar sólo ` +
      `ssm:PutParameter deja seis puertas abiertas.`);
  }
  assert.deepEqual([...new Set(denegadas)].sort(), [...ACCIONES_ESCRITURA].sort(),
    'sin acciones de más: el mínimo privilegio también aplica al Deny, porque un Deny ' +
    'gana siempre y uno demasiado ancho traba operaciones legítimas');
});

test('#5351 CA-13 · cada acción denegada cae bajo un Resource de SU MISMO servicio', () => {
  // La trampa: un único Deny que enumera las 7 acciones con un Resource de SSM.
  // Un Deny matchea sólo si la acción Y el recurso caen dentro del statement, así
  // que las 3 acciones de Secrets Manager quedarían INERTES — se leen perfecto y
  // no protegen nada. Es exactamente el bug de LeadingKeys de #5124, de nuevo.
  const policy = loadPolicy();
  const servicioDeAccion = (a) => a.split(':')[0];
  const servicioDeArn = (r) => r.split(':')[2];

  for (const a of ACCIONES_ESCRITURA) {
    const cubierta = statementsOf(policy, 'Deny').some((s) =>
      asArray(s.Action).includes(a) &&
      asArray(s.Resource).some((r) => servicioDeArn(r) === servicioDeAccion(a)));
    assert.ok(cubierta,
      `${a} está enumerada en un Deny pero NINGÚN Resource de ese Deny es del servicio ` +
      `"${servicioDeAccion(a)}": el Deny es inerte para esa acción.`);
  }
});

// -----------------------------------------------------------------------------
// CA-14 — Ningún Allow con Resource "*"
// -----------------------------------------------------------------------------

test('#5351 CA-14 · ningún statement tiene Resource "*" ni un prefijo de servicio entero', () => {
  const policy = loadPolicy();
  for (const s of policy.Statement) {
    for (const r of asArray(s.Resource)) {
      assert.notEqual(r, '*', `statement "${s.Sid}" con Resource "*"`);
      for (const patron of RESOURCE_DEMASIADO_AMPLIO) {
        assert.equal(patron.test(r), false,
          `statement "${s.Sid}": el Resource ${r} abarca el servicio entero. ` +
          `Es un Resource "*" con más caracteres.`);
      }
    }
  }
});

test('#5351 CA-14 · todo Resource es un ARN de ssm, secretsmanager o kms bien formado', () => {
  const policy = loadPolicy();
  for (const s of policy.Statement) {
    for (const r of asArray(s.Resource)) {
      assert.match(r, /^arn:aws:(ssm|secretsmanager|kms):[^:]+:[^:]+:/,
        `statement "${s.Sid}": ARN de servicio inesperado — ${r}`);
    }
  }
});

// -----------------------------------------------------------------------------
// CA-15 / CA-16 — Higiene del artefacto público (invariante A05, extendido al .md)
// -----------------------------------------------------------------------------

test('#5351 CA-16 · los cinco placeholders están en el JSON, con convención SCREAMING', () => {
  const raw = loadRaw();
  for (const ph of PLACEHOLDERS) {
    assert.ok(raw.includes(ph), `falta el placeholder ${ph} en la policy`);
  }
});

test('#5351 CA-16 · la tabla del doc y el JSON declaran los MISMOS placeholders', () => {
  // Si el doc documenta un placeholder que el JSON no tiene (o al revés), el
  // operador resuelve un valor que no existe o deja uno sin resolver — y un
  // placeholder sin resolver rompe TODA lectura (ver la tabla de diagnóstico).
  const md = fs.readFileSync(DOC_PATH, 'utf8');
  const raw = loadRaw();
  for (const ph of PLACEHOLDERS) {
    assert.ok(md.includes(ph), `el doc no documenta el placeholder ${ph}`);
    assert.ok(raw.includes(ph), `el JSON no usa el placeholder ${ph} que el doc documenta`);
  }
});

test('#5351 CA-15 · no hay account-id real commiteado (ni en el JSON ni en el doc)', () => {
  // Un account-id de AWS es de 12 dígitos: si aparece uno, se filtró un valor real.
  assert.equal(/:\d{12}:/.test(loadRaw()), false, 'account-id real en la policy');
  assert.equal(/:\d{12}:/.test(fs.readFileSync(DOC_PATH, 'utf8')), false, 'account-id real en el doc');
});

test('#5351 CA-15 · no hay región real commiteada (ni en el JSON ni en el doc)', () => {
  // Tres servicios, no uno: la regex del kernel (fija a dynamodb) no sirve acá.
  const REGION_EN_ARN = /arn:aws:[a-z]+:[a-z]{2}-[a-z]+-\d:/;
  assert.equal(REGION_EN_ARN.test(loadRaw()), false, 'región real en un ARN de la policy');
  assert.equal(REGION_EN_ARN.test(fs.readFileSync(DOC_PATH, 'utf8')), false, 'región real en un ARN del doc');
  // `kms:ViaService` lleva la región fuera de un ARN: `<servicio>.<region>.amazonaws.com`.
  assert.equal(/\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com/.test(loadRaw()), false,
    'región real en un kms:ViaService de la policy');
});

test('#5351 CA-15 · el doc no publica el catálogo del vault', () => {
  // docs/pipeline/ es un repo PÚBLICO y la Restricción 2 le niega al host enumerar.
  // Un .md con nombres concretos le devolvería gratis exactamente esa capacidad.
  const md = fs.readFileSync(DOC_PATH, 'utf8');
  const nombresConcretos = md.match(/\/intrale\/(?!PROJECT\b)[A-Za-z0-9._-]+/g) || [];
  assert.deepEqual(nombresConcretos, [],
    `el doc usa un projectId concreto en la jerarquía en vez del placeholder PROJECT: ` +
    `${nombresConcretos.join(', ')}`);
  const hostsConcretos = md.match(/\/hosts\/(?!HOST\b|OTRO_HOST\b|<hostId>)[A-Za-z0-9._-]+/g) || [];
  assert.deepEqual(hostsConcretos, [],
    `el doc usa un hostId concreto: ${hostsConcretos.join(', ')}`);
});

// -----------------------------------------------------------------------------
// CONTRAPRUEBAS — un test de policy que nunca vio rojo no prueba nada
//
// Se muta la policy EN MEMORIA (nunca en disco) y se afirma que la regla FALLA.
// Sin esto, una aserción mal escrita —un filtro de más, una regex que no matchea—
// pasa en verde para siempre sin verificar absolutamente nada.
// -----------------------------------------------------------------------------

test('#5351 contraprueba · la regla de CA-10 detecta un Allow sobre el prefijo de proyecto', () => {
  const policy = loadPolicy();
  policy.Statement.push({
    Sid: 'AllowDemasiadoAncho',
    Effect: 'Allow',
    Action: ['ssm:GetParametersByPath'],
    Resource: 'arn:aws:ssm:REGION:ACCOUNT:parameter/intrale/PROJECT/*',
  });
  assert.throws(() => reglaAllowNoAlcanzaElProyectoEntero(policy), assert.AssertionError,
    'la regla de CA-10 no detectó un Allow sobre el prefijo de proyecto: está rota');
});

test('#5351 contraprueba · la regla de CA-12 detecta un statement KMS sin Condition', () => {
  const policy = loadPolicy();
  policy.Statement.push({
    Sid: 'KmsSinCondition',
    Effect: 'Allow',
    Action: ['kms:Decrypt'],
    Resource: 'arn:aws:kms:REGION:ACCOUNT:key/CMK_ID',
  });
  assert.throws(() => reglaKmsSiempreCondicionado(policy), assert.AssertionError,
    'la regla de CA-12 no detectó un statement KMS sin Condition: está rota');
});

test('#5351 contraprueba · la regla de CA-12 detecta un statement KMS sin EncryptionContext', () => {
  const policy = loadPolicy();
  policy.Statement.push({
    Sid: 'KmsSoloViaService',
    Effect: 'Allow',
    Action: ['kms:Decrypt'],
    Resource: 'arn:aws:kms:REGION:ACCOUNT:key/CMK_ID',
    Condition: { StringEquals: { 'kms:ViaService': 'ssm.REGION.amazonaws.com' } },
  });
  assert.throws(() => reglaKmsSiempreCondicionado(policy), assert.AssertionError,
    'ViaService solo acota el canal, no el material: la regla debe exigir EncryptionContext');
});

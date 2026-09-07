'use strict';

// =============================================================================
// kernel-runtime-credentials.test.js — #5208
//
// El invariante que protegen estos tests es el modo de falla que se descubrió al
// ejecutar el cutover: con `kernel.durable: true` y sin claves estáticas en el
// entorno, el boot durable construía mal el driver, degradaba a filesystem y
// dejaba el flag mintiendo. Acá se fija que las credenciales del runtime se
// resuelvan del PERFIL declarado, que el entorno tenga precedencia, y que la
// falta se reporte como dato accionable en vez de romper.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const creds = require('../kernel-runtime-credentials');

const KERNEL = { region: 'us-east-2', runtimeProfile: 'kernel-runtime' };

// Doble de `aws configure get`: devuelve claves para el perfil esperado y nada
// para cualquier otro.
function fakeAws(perfilConClaves, contador = { n: 0 }) {
  return (cmd, args) => {
    contador.n += 1;
    const i = args.indexOf('--profile');
    const perfil = i > -1 ? args[i + 1] : null;
    if (perfil !== perfilConClaves) return { status: 1, stdout: '', stderr: 'profile not found' };
    const key = args[2];
    if (key === 'aws_access_key_id') return { status: 0, stdout: 'CLAVE-DOBLE-DE-TEST\n' };
    if (key === 'aws_secret_access_key') return { status: 0, stdout: 'secreto-de-test\n' };
    return { status: 1, stdout: '' };
  };
}

test.beforeEach(() => creds.clearCache());

test('resuelve las claves del perfil declarado en kernel.runtimeProfile', () => {
  const r = creds.resolveRuntimeAwsEnv({
    kernel: KERNEL,
    env: { AWS_PROFILE: 'un-admin-cualquiera' },
    deps: { spawnSync: fakeAws('kernel-runtime') },
    noCache: true,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, 'profile');
  assert.equal(r.env.AWS_ACCESS_KEY_ID, 'CLAVE-DOBLE-DE-TEST');
  assert.equal(r.env.AWS_SECRET_ACCESS_KEY, 'secreto-de-test');
  assert.equal(r.env.AWS_REGION, 'us-east-2', 'la región sale del config, no del ambiente');
});

test('AWS_PROFILE del entorno NO alcanza: el runner exige claves estáticas', () => {
  // Éste es exactamente el estado del pipeline antes de #5208: sólo AWS_PROFILE,
  // apuntando además al perfil administrativo.
  const r = creds.resolveRuntimeAwsEnv({
    kernel: { region: 'us-east-2' },   // sin runtimeProfile
    env: { AWS_PROFILE: 'intrale' },
    deps: { spawnSync: fakeAws('kernel-runtime') },
    noCache: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runtime_profile_ausente');
  assert.match(r.error, /AWS_PROFILE.*NO alcanza|claves ESTÁTICAS|claves estáticas/i);
});

test('las claves ya presentes en el entorno GANAN y no se spawnea nada', () => {
  const contador = { n: 0 };
  const r = creds.resolveRuntimeAwsEnv({
    kernel: KERNEL,
    env: { AWS_ACCESS_KEY_ID: 'DEL-ENTORNO', AWS_SECRET_ACCESS_KEY: 'tambien-del-entorno' },
    deps: { spawnSync: fakeAws('kernel-runtime', contador) },
    noCache: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
  assert.equal(r.env.AWS_ACCESS_KEY_ID, 'DEL-ENTORNO');
  assert.equal(contador.n, 0, 'con claves en el entorno no puede haber un solo spawn de la CLI');
});

test('un perfil sin claves estáticas se reporta como dato accionable, nunca lanza', () => {
  const r = creds.resolveRuntimeAwsEnv({
    kernel: { region: 'us-east-2', runtimeProfile: 'perfil-que-no-existe' },
    env: {},
    deps: { spawnSync: fakeAws('kernel-runtime') },
    noCache: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'credenciales_runtime_ausentes');
  assert.match(r.error, /perfil administrativo/, 'debe advertir contra el atajo del perfil admin');
});

test('el fallo NO se cachea: un perfil que aparece después tiene que resolverse', () => {
  const kernel = { region: 'us-east-2', runtimeProfile: 'kernel-runtime' };
  let disponible = false;
  const spawnSync = (cmd, args) => {
    if (!disponible) return { status: 1, stdout: '' };
    return fakeAws('kernel-runtime')(cmd, args);
  };
  const primero = creds.resolveRuntimeAwsEnv({ kernel, env: {}, deps: { spawnSync } });
  assert.equal(primero.ok, false);

  disponible = true;
  const segundo = creds.resolveRuntimeAwsEnv({ kernel, env: {}, deps: { spawnSync } });
  assert.equal(segundo.ok, true, 'cachear el fallo dejaría el pipeline degradado hasta el próximo reinicio');
});

test('el éxito SÍ se cachea: el boot construye varios stores y no puede pagar dos spawns por cada uno', () => {
  const contador = { n: 0 };
  const deps = { spawnSync: fakeAws('kernel-runtime', contador) };
  creds.resolveRuntimeAwsEnv({ kernel: KERNEL, env: {}, deps });
  const spawnsTrasPrimera = contador.n;
  assert.equal(spawnsTrasPrimera, 2, 'la primera resolución lee access key + secret');

  creds.resolveRuntimeAwsEnv({ kernel: KERNEL, env: {}, deps });
  creds.resolveRuntimeAwsEnv({ kernel: KERNEL, env: {}, deps });
  assert.equal(contador.n, spawnsTrasPrimera, 'las resoluciones siguientes salen de la caché');
});

test('describe() dice de dónde salieron las credenciales sin poder filtrar el valor', () => {
  const r = creds.resolveRuntimeAwsEnv({
    kernel: KERNEL, env: {}, deps: { spawnSync: fakeAws('kernel-runtime') }, noCache: true,
  });
  const d = creds.describe(r);
  assert.match(d, /perfil AWS "kernel-runtime"/);
  assert.equal(d.includes('CLAVE-DOBLE-DE-TEST'), false, 'describe() no puede filtrar la clave');
  assert.equal(d.includes('secreto-de-test'), false);

  assert.match(creds.describe({ ok: false, code: 'x' }), /sin credenciales/);
});

// -----------------------------------------------------------------------------
// El invariante que motivó el módulo, verificado contra el config REAL
// -----------------------------------------------------------------------------

test('#5208: con durable encendido, el config real declara el perfil que necesita el driver', () => {
  const yaml = require('js-yaml');
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));

  if (cfg.kernel.durable !== true) return; // con el switch apagado no aplica

  assert.ok(
    cfg.kernel.runtimeProfile,
    'con `kernel.durable: true` falta `kernel.runtimeProfile`: el boot durable no podría construir el '
    + 'driver y degradaría a filesystem con el flag diciendo DynamoDB',
  );
  assert.notEqual(
    cfg.kernel.runtimeProfile, cfg.kernel.iamAdminProfile,
    'el perfil del runtime no puede ser el administrativo: los Deny de la policy dejarían de probarse',
  );
});

'use strict';

// =============================================================================
// credentials-scoped-refs.test.js — aislamiento de secretos por producto
// (Ola Puente P2 · #4687 · grupo C del PO)
//
//   - CA-C2 : resolveScopedRefs entrega SOLO los scopes declarados, sin expandir
//             a todo el archivo de credenciales. Preserva el mapping legacy.
//   - CA-C3 : redactScoped nunca ecoa valores de secretos.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const cred = require('../credentials');

// Archivo de credenciales de prueba con dos productos namespaceados + secretos
// que NO deben cruzarse entre productos.
const FAKE_DATA = {
  namespaces: {
    intrale: { github: 'gh-intrale-token', aws: 'aws-intrale-key', providers: 'anthropic-intrale' },
    acme: { github: 'gh-acme-token', aws: 'aws-acme-key' },
  },
  // top-level legacy (loadIntoEnv sigue leyendo esto — no lo tocamos).
  telegram: { bot_token: 'legacy-bot' },
};

test('CA-C2: entrega SOLO los scopes declarados del namespace', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#intrale', ['github'], { data: FAKE_DATA });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.scopes), ['github']);
  assert.equal(res.scopes.github, 'gh-intrale-token');
  // NO expande: aws NO debe estar aunque exista en el namespace.
  assert.equal(res.scopes.aws, undefined);
});

test('CA-C2: NO expande a otros namespaces (aislamiento de blast radius)', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#intrale', ['github', 'aws'], { data: FAKE_DATA });
  assert.equal(res.ok, true);
  // sólo secretos de intrale, jamás de acme.
  assert.equal(res.scopes.github, 'gh-intrale-token');
  assert.equal(res.scopes.aws, 'aws-intrale-key');
  assert.ok(!Object.values(res.scopes).includes('gh-acme-token'));
});

test('CA-C2: scope declarado pero ausente en el namespace ⇒ missing (no ok)', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#acme', ['github', 'providers'], { data: FAKE_DATA });
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['providers']);
  assert.equal(res.scopes.github, 'gh-acme-token');
});

test('CA-C2: ref sin #namespace (valor literal) es rechazada', () => {
  const res = cred.resolveScopedRefs('AKIAIOSFODNN7EXAMPLE', ['aws'], { data: FAKE_DATA });
  assert.equal(res.ok, false);
  assert.match(res.error, /ref inválida/);
});

test('CA-C2: namespace inexistente ⇒ no ok, sin exponer datos', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#desconocido', ['github'], { data: FAKE_DATA });
  assert.equal(res.ok, false);
  assert.deepEqual(res.scopes, {});
});

test('CA-C2: scopes vacío / no-array es rechazado', () => {
  assert.equal(cred.resolveScopedRefs('~/.claude/secrets/credentials.json#intrale', [], { data: FAKE_DATA }).ok, false);
  assert.equal(cred.resolveScopedRefs('~/.claude/secrets/credentials.json#intrale', null, { data: FAKE_DATA }).ok, false);
});

test('CA-C3: redactScoped devuelve SOLO nombres de scope, nunca valores', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#intrale', ['github', 'aws'], { data: FAKE_DATA });
  const red = cred.redactScoped(res);
  assert.deepEqual(red.scopes.sort(), ['aws', 'github']);
  // el objeto redactado NO contiene ningún valor de secreto.
  const serialized = JSON.stringify(red);
  assert.ok(!serialized.includes('gh-intrale-token'));
  assert.ok(!serialized.includes('aws-intrale-key'));
});

test('parseSecretRef parsea path#namespace y rechaza formas inválidas', () => {
  assert.deepEqual(cred.parseSecretRef('~/.claude/secrets/credentials.json#intrale'), { path: '~/.claude/secrets/credentials.json', namespace: 'intrale' });
  assert.equal(cred.parseSecretRef('no-namespace'), null);
  assert.equal(cred.parseSecretRef('path#'), null);
});

// =============================================================================
// #5217 — Google Drive resuelto por namespace, sin pasar por ENV_MAPPING.
//
// Valores SINTÉTICOS. Estos tests jamás leen el credentials.json real.
// =============================================================================

const DRIVE_DATA = {
  google_drive: {
    oauth_client_id: 'fake-client-id.apps.googleusercontent.com',
    oauth_client_secret: 'FAKE-client-secret-0000',
    oauth_refresh_token: '1//fake-refresh-token-000000',
    drive_folder_id: '1FakeFolderIdForUnitTests000000',
  },
};

const DRIVE_SCOPES = ['oauth_client_id', 'oauth_client_secret', 'oauth_refresh_token', 'drive_folder_id'];

test('#5217: resolveScopedRefs devuelve los 4 scopes de google_drive', () => {
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#google_drive', DRIVE_SCOPES, { data: DRIVE_DATA });
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(Object.keys(res.scopes).sort(), [...DRIVE_SCOPES].sort());
});

test('#5217: un scope con placeholder cae en missing (no se devuelve vacío)', () => {
  const withPlaceholder = {
    google_drive: { ...DRIVE_DATA.google_drive, oauth_refresh_token: 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS' },
  };
  const res = cred.resolveScopedRefs('~/x.json#google_drive', DRIVE_SCOPES, { data: withPlaceholder });
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['oauth_refresh_token']);
  // El consumidor debe poder caer al siguiente nivel de la cadena: el scope
  // inválido NO viene como string vacío disfrazado de valor.
  assert.equal(res.scopes.oauth_refresh_token, undefined);
});

test('#5217: Drive NO está en ENV_MAPPING (CA-6 — no amplía el process.env global)', () => {
  // loadIntoEnv() escribe en process.env y lo invocan pulpo.js y restart.js, así
  // que todo lo que entre a ENV_MAPPING lo hereda cada proceso hijo de cada
  // agente, incluidos los de providers de IA de terceros. Drive lo usa un solo
  // consumidor puntual: se resuelve bajo demanda.
  const mapped = Object.keys(cred.ENV_MAPPING);
  assert.ok(!mapped.some((k) => k.startsWith('google_drive.')), 'google_drive no debe estar en ENV_MAPPING');
  assert.ok(!mapped.some((k) => k.startsWith('r2.')), 'r2 no debe estar en ENV_MAPPING');
  assert.ok(!mapped.some((k) => k.startsWith('aws.')), 'aws no debe estar en ENV_MAPPING');
});

// -----------------------------------------------------------------------------
// RIESGO A-1 (#5217): la trampa que reintroduce el bug por la vía del fix.
// -----------------------------------------------------------------------------

test('A-1: un ref con path absoluto estilo Windows es rechazado SIN excepción', () => {
  // El regex de parseSecretRef no admite `\` ni `C:`. Un dev que escriba lo
  // natural —`credentialsLib.CANONICAL_PATH + '#google_drive'`— no recibe un
  // error: recibe {ok:false, namespace:null, scopes:{}} y Drive vuelve a fallar
  // en silencio, que es exactamente el modo de falla que este issue cierra.
  const winRef = 'C:\\Users\\Administrator\\.claude\\secrets\\credentials.json#google_drive';

  assert.equal(cred.parseSecretRef(winRef), null);

  const res = cred.resolveScopedRefs(winRef, DRIVE_SCOPES, { data: DRIVE_DATA });
  assert.equal(res.ok, false);
  assert.equal(res.namespace, null);
  assert.deepEqual(res.scopes, {});
  assert.match(res.error, /ref inválida/);
});

test('A-1: la mitigación es ref en forma tilde + canonicalPath explícito', () => {
  // Forma correcta: el ref se arma SIEMPRE con `~`, y el path real del SO viaja
  // por opts.canonicalPath, que resolveScopedRefs prioriza sobre expandHome().
  const res = cred.resolveScopedRefs('~/.claude/secrets/credentials.json#google_drive', DRIVE_SCOPES, { data: DRIVE_DATA });
  assert.equal(res.ok, true);
  assert.equal(res.namespace, 'google_drive');

  // Y el override de path se respeta aunque el ref apunte a otro lado.
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-a1-'));
  const file = path.join(tmp, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify(DRIVE_DATA), 'utf8');
  try {
    const viaOverride = cred.resolveScopedRefs('~/otro/lugar.json#google_drive', DRIVE_SCOPES, { canonicalPath: file });
    assert.equal(viaOverride.ok, true);
    assert.deepEqual(viaOverride.missing, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadIntoEnv (legacy) sigue exportado y funcional — sin regresión', () => {
  // resolveScopedRefs NO debe romper el cargador legacy.
  assert.equal(typeof cred.loadIntoEnv, 'function');
  const env = {};
  const result = cred.loadIntoEnv({
    env,
    canonicalPath: '/no/existe/canonical.json',
    legacyPath: '/no/existe/legacy.json',
    logger: () => {},
  });
  assert.equal(result.source, 'none');
});

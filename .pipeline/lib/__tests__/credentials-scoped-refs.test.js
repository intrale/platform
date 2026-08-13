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

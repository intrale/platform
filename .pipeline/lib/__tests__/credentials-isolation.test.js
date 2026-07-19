// .pipeline/lib/__tests__/credentials-isolation.test.js
// Ola Puente P7 #4692 · CA-3 — aislamiento estricto de secretos por producto
// (blast radius acotado, requisito de seguridad #4 · OWASP A01/A02).
//
// Verifica el invariante ya implementado en credentials.js:155 SIN reescribirlo:
// `resolveScopedRefs` entrega SÓLO el sub-objeto del namespace del producto en
// curso y SÓLO los scopes declarados — un producto A no puede leer el namespace
// de B. `redactScoped` no expone valores en logs/handoff.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { resolveScopedRefs, redactScoped } = require('../credentials');

// Fixture con ≥2 productos dummy en el mismo archivo de credenciales (multi-tenant).
// Estructura canónica multi-producto: `namespaces.<producto>`.
const CREDS_FIXTURE = {
  namespaces: {
    'prod-a': {
      github: 'ghp_AAA_token',
      aws: 'AKIA_AAA_secret',
    },
    'prod-b': {
      github: 'ghp_BBB_token',
      telegram: 'BBB_bot_token',
    },
  },
};

test('CA-3 · producto A resuelve SÓLO su namespace y scopes declarados', () => {
  const res = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-a', ['github', 'aws'], { data: CREDS_FIXTURE });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.namespace, 'prod-a');
  assert.deepStrictEqual(Object.keys(res.scopes).sort(), ['aws', 'github']);
  assert.strictEqual(res.scopes.github, 'ghp_AAA_token');
});

test('CA-3 · A NO puede leer los secretos de B (blast radius acotado)', () => {
  // A pide su github; el resultado no contiene NINGÚN valor del namespace de B.
  const res = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-a', ['github', 'aws'], { data: CREDS_FIXTURE });
  const serialized = JSON.stringify(res.scopes);
  assert.ok(!serialized.includes('BBB'), 'no debe filtrar secretos de prod-b');
  assert.ok(!serialized.includes('telegram'), 'no debe exponer scopes de prod-b');
  // Y aunque A intente pedir un scope que sólo existe en B, no lo obtiene: falta.
  const cross = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-a', ['telegram'], { data: CREDS_FIXTURE });
  assert.strictEqual(cross.ok, false);
  assert.deepStrictEqual(cross.missing, ['telegram']);
  assert.deepStrictEqual(cross.scopes, {});
});

test('CA-3 · un scope NO declarado por el descriptor no se entrega aunque exista en el namespace', () => {
  // prod-a declara sólo `github`; `aws` existe en su namespace pero no se pide ⇒
  // no se expande (sólo los scopes declarados salen).
  const res = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-a', ['github'], { data: CREDS_FIXTURE });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(Object.keys(res.scopes), ['github']);
  assert.ok(!('aws' in res.scopes), 'aws no declarado ⇒ no se entrega');
});

test('CA-3 · redactScoped no expone valores de secretos (logs/handoff)', () => {
  const res = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-b', ['github', 'telegram'], { data: CREDS_FIXTURE });
  const redacted = redactScoped(res);
  const serialized = JSON.stringify(redacted);
  // Sólo nombres de scope, nunca valores.
  assert.deepStrictEqual(redacted.scopes.sort(), ['github', 'telegram']);
  assert.ok(!serialized.includes('ghp_BBB_token'), 'redactScoped no debe incluir el valor del token');
  assert.ok(!serialized.includes('BBB_bot_token'), 'redactScoped no debe incluir el valor del bot token');
});

test('CA-3 · namespace inexistente ⇒ fail (no cae al archivo entero)', () => {
  const res = resolveScopedRefs('~/.claude/secrets/credentials.json#prod-zzz', ['github'], { data: CREDS_FIXTURE });
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.scopes, {});
  assert.match(res.error, /namespace no encontrado/);
});

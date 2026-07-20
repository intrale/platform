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

const { resolveScopedRefs, redactScoped, parseSecretRef } = require('../credentials');

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

// -----------------------------------------------------------------------------
// #4811 CA-7 — sin fuga de secretos cross-tenant en la ola del producto nuevo.
//
// Refuerza el requisito de seguridad #5 del análisis de #4811: los agentes/olas
// de un producto nuevo no heredan ni exponen en env/logs secretos con scope de
// otro producto. La BD guarda REFS namespaceadas (`<path>#<namespace>`), nunca
// valores. Estos casos modelan el "producto nuevo" leyendo su ref y verifican que
// ni el resultado resuelto ni su forma redactada (la que va a env/logs/handoff)
// filtran material del monorepo `intrale-platform`.
// -----------------------------------------------------------------------------

// Fixture con el monorepo + un producto nuevo en el MISMO archivo (multi-tenant).
const CROSS_TENANT_FIXTURE = {
  namespaces: {
    'intrale-platform': {
      github: 'ghp_MONOREPO_secret_token',
      aws: 'AKIA_MONOREPO_secret',
      telegram: 'MONOREPO_bot_token',
    },
    'producto-nuevo': {
      github: 'ghp_NUEVO_token',
    },
  },
};

test('#4811 CA-7 · el producto nuevo resuelve SÓLO su namespace, sin material del monorepo', () => {
  const res = resolveScopedRefs(
    '~/.claude/secrets/credentials.json#producto-nuevo',
    ['github'],
    { data: CROSS_TENANT_FIXTURE },
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.namespace, 'producto-nuevo');
  const serialized = JSON.stringify(res.scopes);
  // Ningún valor ni scope exclusivo del monorepo debe aparecer.
  assert.ok(!serialized.includes('MONOREPO'), 'no filtra secretos de intrale-platform');
  assert.ok(!serialized.includes('AKIA_MONOREPO'), 'no filtra la AWS key del monorepo');
  assert.ok(!('aws' in res.scopes) && !('telegram' in res.scopes), 'no expone scopes que sólo tiene el monorepo');
});

test('#4811 CA-7 · el producto nuevo NO puede resolver los scopes del monorepo aunque los pida', () => {
  // Aunque declare scopes que sólo existen en intrale-platform, no los obtiene:
  // resuelve contra SU namespace, que no los tiene ⇒ faltan, scopes vacío.
  const cross = resolveScopedRefs(
    '~/.claude/secrets/credentials.json#producto-nuevo',
    ['aws', 'telegram'],
    { data: CROSS_TENANT_FIXTURE },
  );
  assert.strictEqual(cross.ok, false);
  assert.deepStrictEqual(cross.missing.sort(), ['aws', 'telegram']);
  assert.deepStrictEqual(cross.scopes, {});
  assert.ok(!JSON.stringify(cross).includes('MONOREPO'), 'el fallo no filtra valores del monorepo');
});

test('#4811 CA-7 · la forma redactada (env/logs/handoff) nunca incluye valores de otro tenant', () => {
  // El monorepo resuelve lo suyo; la forma que se persiste en logs son SÓLO
  // nombres de scope, jamás el valor — verificado para el tenant del monorepo.
  const res = resolveScopedRefs(
    '~/.claude/secrets/credentials.json#intrale-platform',
    ['github', 'aws', 'telegram'],
    { data: CROSS_TENANT_FIXTURE },
  );
  const redacted = redactScoped(res);
  const serialized = JSON.stringify(redacted);
  assert.deepStrictEqual(redacted.scopes.sort(), ['aws', 'github', 'telegram']);
  assert.ok(!serialized.includes('ghp_MONOREPO_secret_token'), 'redactScoped no incluye el github token');
  assert.ok(!serialized.includes('AKIA_MONOREPO_secret'), 'redactScoped no incluye la aws key');
  assert.ok(!serialized.includes('MONOREPO_bot_token'), 'redactScoped no incluye el bot token');
});

test('#4811 CA-7 · una ref sin namespace (no namespaceada) es rechazada por parseSecretRef', () => {
  // Defensa: sólo se aceptan refs `<path>#<namespace>`; una ref plana al archivo
  // entero (sin `#namespace`) no parsea ⇒ no habilita lectura cross-tenant.
  assert.strictEqual(parseSecretRef('~/.claude/secrets/credentials.json'), null);
  const parsed = parseSecretRef('~/.claude/secrets/credentials.json#producto-nuevo');
  assert.ok(parsed && parsed.namespace === 'producto-nuevo', 'la ref namespaceada sí parsea a su namespace');
});

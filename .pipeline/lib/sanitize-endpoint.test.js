// =============================================================================
// sanitize-endpoint.test.js — tests unitarios (node:test / --test)
// Ejecución: node --test .pipeline/lib/sanitize-endpoint.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeEndpoint,
  validateParentIssue,
  validateBlockedReason,
  validateTimestamp,
  SENSITIVE_QUERY_KEYS,
  MAX_ENDPOINT_LENGTH,
} = require('./sanitize-endpoint');

// ─── sanitizeEndpoint ────────────────────────────────────────────────────────

test('sanitizeEndpoint strips api_key query param', () => {
  const out = sanitizeEndpoint('https://api.github.com/repos?api_key=abc123');
  assert.equal(out, 'https://api.github.com/repos');
});

test('sanitizeEndpoint strips token variants case-insensitive', () => {
  for (const key of ['token', 'TOKEN', 'Token', 'access_token', 'refresh_token']) {
    const out = sanitizeEndpoint(`https://api.example.com/v1?${key}=sekret`);
    assert.equal(out, 'https://api.example.com/v1', `fallo con clave ${key}`);
  }
});

test('sanitizeEndpoint strips every key in the deny-list', () => {
  for (const key of SENSITIVE_QUERY_KEYS) {
    const url = `https://example.com/?${key}=value123&safe=keep`;
    const out = sanitizeEndpoint(url);
    assert.equal(
      out,
      'https://example.com/?safe=keep',
      `clave sensible "${key}" no fue strippeada correctamente`,
    );
  }
});

test('sanitizeEndpoint keeps safe query params', () => {
  const out = sanitizeEndpoint('https://api.github.com/repos?per_page=100&page=2');
  assert.equal(out, 'https://api.github.com/repos?per_page=100&page=2');
});

test('sanitizeEndpoint removes `?` when all params were sensitive', () => {
  const out = sanitizeEndpoint('https://example.com/endpoint?token=x&api_key=y');
  assert.equal(out, 'https://example.com/endpoint');
});

test('sanitizeEndpoint strips basic auth embebido', () => {
  const out = sanitizeEndpoint('https://user:pass@api.github.com/path');
  assert.equal(out, 'https://api.github.com/path');
});

test('sanitizeEndpoint strips basic auth con path y query', () => {
  const out = sanitizeEndpoint('https://admin:secret@host.com/v1?foo=bar');
  assert.equal(out, 'https://host.com/v1?foo=bar');
});

test('sanitizeEndpoint strips puerto del host con scheme', () => {
  assert.equal(sanitizeEndpoint('https://api.github.com:8443/path'), 'https://api.github.com/path');
  assert.equal(sanitizeEndpoint('http://localhost:3200/dashboard'), 'http://localhost/dashboard');
});

test('sanitizeEndpoint strips puerto cuando no hay scheme', () => {
  assert.equal(sanitizeEndpoint('api.github.com:443/repos'), 'api.github.com/repos');
});

test('sanitizeEndpoint strips fragmento si contiene `=`', () => {
  assert.equal(
    sanitizeEndpoint('https://example.com/x#access_token=xyz'),
    'https://example.com/x',
  );
});

test('sanitizeEndpoint conserva fragmento simple sin `=`', () => {
  assert.equal(sanitizeEndpoint('https://example.com/page#section2'), 'https://example.com/page#section2');
});

test('sanitizeEndpoint strips caracteres de control (CRLF)', () => {
  const malicioso = 'https://api.github.com/repos\r\nSet-Cookie: evil=1';
  const out = sanitizeEndpoint(malicioso);
  assert.equal(out, 'https://api.github.com/reposSet-Cookie: evil=1');
  assert.ok(!/[\r\n\t]/.test(out), 'no debe quedar ningún CR/LF/TAB');
});

test('sanitizeEndpoint strips TAB y otros control chars', () => {
  const out = sanitizeEndpoint('https://host\t.com/p\x00\x01ath');
  assert.equal(out, 'https://host.com/path');
});

test('sanitizeEndpoint strips unicode bidi (Trojan Source)', () => {
  // U+202E right-to-left override
  const malicioso = 'https://evil\u202Egood.com/path';
  const out = sanitizeEndpoint(malicioso);
  assert.equal(out, 'https://evilgood.com/path');
  assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(out));
});

test('sanitizeEndpoint trunca a 500 caracteres', () => {
  const long = 'https://example.com/' + 'a'.repeat(1000);
  const out = sanitizeEndpoint(long);
  assert.equal(out.length, MAX_ENDPOINT_LENGTH);
  assert.ok(out.startsWith('https://example.com/'));
});

test('sanitizeEndpoint maneja input null/undefined/no-string', () => {
  assert.equal(sanitizeEndpoint(null), '');
  assert.equal(sanitizeEndpoint(undefined), '');
  assert.equal(sanitizeEndpoint(''), '');
  assert.equal(sanitizeEndpoint(123), '123');
  assert.equal(sanitizeEndpoint({}), '[object Object]');
});

test('sanitizeEndpoint trim whitespace', () => {
  assert.equal(sanitizeEndpoint('   https://example.com/   '), 'https://example.com/');
});

test('sanitizeEndpoint combinación: basic auth + puerto + token + fragment', () => {
  const hostil = 'https://admin:pwd@api.github.com:8443/repos?api_key=x&per_page=10#token=leak';
  const out = sanitizeEndpoint(hostil);
  assert.equal(out, 'https://api.github.com/repos?per_page=10');
});

test('sanitizeEndpoint percent-encoded sensitive key sigue detectado', () => {
  // "api_key" → percent-encoded de una letra para engañar al matcher naive
  const out = sanitizeEndpoint('https://example.com/?api%5Fkey=x&safe=y');
  // decodeURIComponent('api%5Fkey') === 'api_key' → debe strippearse
  assert.equal(out, 'https://example.com/?safe=y');
});

test('sanitizeEndpoint rechaza patrón de GitHub token si apareciera como valor', () => {
  // Aunque el deny-list strippea por CLAVE, no debería quedar el token si fue pasado con clave sensible.
  const out = sanitizeEndpoint('https://api.github.com/?authorization=ghp_1234567890abcdefghij1234567890ABCDEF');
  assert.ok(!/ghp_/.test(out), 'no debe quedar el token en el output');
  assert.equal(out, 'https://api.github.com/');
});

// ─── validateParentIssue ─────────────────────────────────────────────────────

test('validateParentIssue acepta enteros positivos acotados', () => {
  assert.equal(validateParentIssue(1), 1);
  assert.equal(validateParentIssue(2328), 2328);
  assert.equal(validateParentIssue(999999), 999999);
  assert.equal(validateParentIssue('2314'), 2314); // string numérico OK
});

test('validateParentIssue rechaza no-enteros, negativos y excesivos', () => {
  assert.equal(validateParentIssue(0), null);
  assert.equal(validateParentIssue(-1), null);
  assert.equal(validateParentIssue(1.5), null);
  assert.equal(validateParentIssue(1000000), null);
  assert.equal(validateParentIssue('abc'), null);
  assert.equal(validateParentIssue('123/../evil'), null);
  assert.equal(validateParentIssue(null), null);
  assert.equal(validateParentIssue(undefined), null);
  assert.equal(validateParentIssue({}), null);
});

// ─── validateBlockedReason ───────────────────────────────────────────────────

test('validateBlockedReason acepta solo infra|code', () => {
  assert.equal(validateBlockedReason('infra'), 'infra');
  assert.equal(validateBlockedReason('code'), 'code');
});

test('validateBlockedReason rechaza cualquier otro valor', () => {
  assert.equal(validateBlockedReason('INFRA'), null); // case-sensitive
  assert.equal(validateBlockedReason('other'), null);
  assert.equal(validateBlockedReason(''), null);
  assert.equal(validateBlockedReason(null), null);
  assert.equal(validateBlockedReason({ reason: 'infra' }), null);
  // Evitar CSS injection vía valor controlado
  assert.equal(validateBlockedReason('code; background:url(evil)'), null);
});

// ─── validateTimestamp ───────────────────────────────────────────────────────

test('validateTimestamp acepta ISO 8601 dentro de ventana', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const out = validateTimestamp('2026-04-17T11:30:00Z', now);
  assert.equal(out, '2026-04-17T11:30:00.000Z');
});

test('validateTimestamp rechaza strings no parseables', () => {
  assert.equal(validateTimestamp('not-a-date'), null);
  assert.equal(validateTimestamp(''), null);
  assert.equal(validateTimestamp(null), null);
  assert.equal(validateTimestamp(12345), null);
});

test('validateTimestamp rechaza timestamps fuera de ±365 días', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  // 2 años en el pasado
  assert.equal(validateTimestamp('2024-01-01T00:00:00Z', now), null);
  // 2 años en el futuro
  assert.equal(validateTimestamp('2028-01-01T00:00:00Z', now), null);
});

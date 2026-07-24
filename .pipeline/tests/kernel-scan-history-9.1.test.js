'use strict';

// Tests del escáner de secretos historia-completa de la migración del motor
// (Ola 9.1 · #4663). Cubre la lógica pura: glob→regex, allowlist y fail-closed.
// No requiere un repo git (esa parte se validó empíricamente en el inventario).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  globToRe, isAllowlisted, loadAllowlist,
} = require('../kernel-bootstrap/scan-history-9.1.js');

const ALLOWLIST_FILE = path.join(
  __dirname, '..', 'kernel-bootstrap', 'motor-9.1-secret-allowlist.json',
);

test('globToRe: ** cruza directorios, * no', () => {
  assert.ok(globToRe('**/__tests__/**').test('lib/commander/__tests__/x.js'));
  assert.ok(globToRe('**/*.test.js').test('lib/write-deliverable.test.js'));
  assert.ok(globToRe('*.test.js').test('foo.test.js'));
  assert.equal(globToRe('*.test.js').test('lib/foo.test.js'), false); // * no cruza /
  assert.ok(globToRe('**/*.mp3').test('lib/__tests__/fixtures/audio/01.mp3'));
});

test('loadAllowlist: parsea paths y globs del JSON real', () => {
  const allow = loadAllowlist(ALLOWLIST_FILE);
  assert.ok(allow.paths.size >= 20, 'debe haber paths adjudicados');
  assert.ok(allow.globs.length >= 6, 'debe haber globs adjudicados');
});

test('isAllowlisted: cubre test/fixtures por glob y fuentes por path exacto', () => {
  const allow = loadAllowlist(ALLOWLIST_FILE);
  // globs (suite de test / fixtures)
  assert.ok(isAllowlisted('lib/__tests__/credentials.test.js', allow));
  assert.ok(isAllowlisted('lib/write-deliverable.test.js', allow));
  assert.ok(isAllowlisted('lib/__tests__/fixtures/audio-es-ar/01.mp3', allow));
  // paths exactos (fuentes con falso positivo adjudicado)
  assert.ok(isAllowlisted('core/pulpo.js', allow));
  assert.ok(isAllowlisted('lib/handoff.js', allow));
  assert.ok(isAllowlisted('lib/redact.js', allow));
});

test('isAllowlisted: fail-closed — un path NO adjudicado no pasa', () => {
  const allow = loadAllowlist(ALLOWLIST_FILE);
  // Un archivo fuente nuevo con secreto no está en la allowlist → debe frenar.
  assert.equal(isAllowlisted('lib/new-secret-leak.js', allow), false);
  assert.equal(isAllowlisted('core/nuevo-modulo.js', allow), false);
  assert.equal(isAllowlisted('skills/delivery/otro.js', allow), false);
});

test('loadAllowlist: sin archivo devuelve allowlist vacía (todo frena)', () => {
  const empty = loadAllowlist(null);
  assert.equal(empty.paths.size, 0);
  assert.equal(empty.globs.length, 0);
  assert.equal(isAllowlisted('lib/handoff.js', empty), false);
});

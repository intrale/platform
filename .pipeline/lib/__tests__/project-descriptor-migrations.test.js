'use strict';

// =============================================================================
// project-descriptor-migrations.test.js — (Ola Puente P2 · #4687)
//
// Cobertura → CA-F1 (migración identidad 1.0→1.0, "descriptor viejo sigue
// arrancando") y CA-B4 / requisito de seguridad #7 (downgrade rechazado).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../project-descriptor-migrations');

test('CA-F1: descriptor 1.0 migra por identidad (1.0 → 1.0) y "sigue arrancando"', () => {
  const desc = { schemaVersion: '1.0', identity: { projectId: 'x', name: 'X' } };
  const res = m.migrateDescriptor(desc);
  assert.equal(res.ok, true);
  assert.equal(res.from, '1.0');
  assert.equal(res.to, '1.0');
  assert.deepEqual(res.descriptor, desc);
});

test('CA-B4 (#7): downgrade de schemaVersion (0.9 < 1.0) es RECHAZADO', () => {
  const res = m.migrateDescriptor({ schemaVersion: '0.9' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'downgrade_rejected');
  assert.match(res.error, /downgrade/);
});

test('version más nueva que la soportada es rechazada (kernel viejo)', () => {
  const res = m.migrateDescriptor({ schemaVersion: '2.0' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unsupported_newer');
});

test('schemaVersion inválido / ausente / unicode es rechazado', () => {
  assert.equal(m.migrateDescriptor({ schemaVersion: 'v1' }).ok, false);
  assert.equal(m.migrateDescriptor({ schemaVersion: '1' }).ok, false);
  assert.equal(m.migrateDescriptor({ schemaVersion: '1.0.0' }).ok, false);
  assert.equal(m.migrateDescriptor({ schemaVersion: '1.٠' }).ok, false); // dígito árabe-índico
  assert.equal(m.migrateDescriptor({}).ok, false);
  assert.equal(m.migrateDescriptor(null).ok, false);
});

test('compareVersions ordena correctamente', () => {
  assert.equal(m.compareVersions('1.0', '1.0'), 0);
  assert.equal(m.compareVersions('1.0', '1.1'), -1);
  assert.equal(m.compareVersions('2.0', '1.9'), 1);
  assert.equal(m.compareVersions('bad', '1.0'), null);
});

test('CURRENT_SCHEMA_VERSION es 1.0 y KNOWN_VERSIONS lo incluye', () => {
  assert.equal(m.CURRENT_SCHEMA_VERSION, '1.0');
  assert.ok(m.KNOWN_VERSIONS.includes('1.0'));
});

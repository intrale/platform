// =============================================================================
// validate-java-home.test.js — Tests para el fail-fast de JAVA_HOME (#2405 CA-1)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  validateJavaHome,
  validateJavaHomeFs,
  loadAllowlist,
  normalizePath,
  isSuspicious,
  EXIT_CONFIG_ERROR,
} = require(path.join(__dirname, '..', 'validate-java-home.js'));

test('normalizePath: unifica separadores y case', () => {
  assert.equal(
    normalizePath('C:\\Users\\Admin\\.jdks\\temurin-21.0.7'),
    'c:/users/admin/.jdks/temurin-21.0.7',
  );
  assert.equal(
    normalizePath('C:/Users/Admin/.jdks/temurin-21.0.7/'),
    'c:/users/admin/.jdks/temurin-21.0.7',
  );
});

test('isSuspicious: rechaza paths con `..`, shell-metachars, y bordes con whitespace', () => {
  assert.equal(isSuspicious('C:/Users/../../secret'), true);
  assert.equal(isSuspicious(' C:/Users/Admin'), true);
  assert.equal(isSuspicious('C:/Users; rm -rf /'), true);
  assert.equal(isSuspicious('C:/Users/Admin && malicious'), true);
  assert.equal(isSuspicious('C:/Program Files/Java/jdk-21'), false, 'espacios embebidos son legítimos en Windows');
  assert.equal(isSuspicious('C:/Users/Admin/.jdks/temurin-21.0.7'), false);
});

test('validateJavaHome: match exacto', () => {
  const r = validateJavaHome({
    javaHome: 'C:/Users/Administrator/.jdks/temurin-21.0.7',
    allowlist: ['C:/Users/Administrator/.jdks/temurin-21.0.7'],
  });
  assert.equal(r.ok, true);
});

test('validateJavaHome: match con separadores Windows distintos', () => {
  const r = validateJavaHome({
    javaHome: 'C:\\Users\\Administrator\\.jdks\\temurin-21.0.7',
    allowlist: ['C:/Users/Administrator/.jdks/temurin-21.0.7'],
  });
  assert.equal(r.ok, true);
});

test('validateJavaHome: match case-insensitive', () => {
  const r = validateJavaHome({
    javaHome: 'c:/users/administrator/.jdks/TEMURIN-21.0.7',
    allowlist: ['C:/Users/Administrator/.jdks/temurin-21.0.7'],
  });
  assert.equal(r.ok, true);
});

test('validateJavaHome: match como subdirectorio (JDK/bin debajo de JDK)', () => {
  const r = validateJavaHome({
    javaHome: 'C:/Users/Administrator/.jdks/temurin-21.0.7/bin',
    allowlist: ['C:/Users/Administrator/.jdks/temurin-21.0.7'],
  });
  assert.equal(r.ok, true);
});

test('validateJavaHome: falla si no matchea', () => {
  const r = validateJavaHome({
    javaHome: 'C:/Program Files/Eclipse Adoptium/jdk-17',
    allowlist: ['C:/Users/Administrator/.jdks/temurin-21.0.7'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-in-allowlist');
});

test('validateJavaHome: fail-closed si allowlist vacía', () => {
  const r = validateJavaHome({
    javaHome: 'C:/any/path',
    allowlist: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'allowlist-empty');
});

test('validateJavaHome: fail-closed si JAVA_HOME vacío', () => {
  const r = validateJavaHome({ javaHome: '', allowlist: ['/usr/lib/jvm/jdk21'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'javahome-empty');
});

test('validateJavaHome: rechaza JAVA_HOME con `..`', () => {
  const r = validateJavaHome({
    javaHome: 'C:/Users/Admin/../../malicious',
    allowlist: ['C:/Users/Admin'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'javahome-suspicious');
});

test('loadAllowlist: parsea config.yaml real del repo', () => {
  const configPath = path.join(__dirname, '..', 'config.yaml');
  const result = loadAllowlist(configPath);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.list));
  assert.ok(result.list.length > 0, 'allowlist no debe estar vacía en config.yaml');
  assert.ok(
    result.list.some(e => e.includes('temurin-21')),
    'debe contener al menos un JDK Temurin 21',
  );
});

test('loadAllowlist: parser manual con YAML minimal', () => {
  const tmp = path.join(os.tmpdir(), `test-yaml-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, [
    '# test',
    'build:',
    '  java_home_allowlist:',
    '    - "C:/path/one"',
    '    - "C:/path/two"',
    'other: value',
  ].join('\n'));
  try {
    const result = loadAllowlist(tmp);
    assert.equal(result.ok, true);
    // Si yaml está disponible, se usa; si no, el fallback manual saca lo mismo.
    assert.deepEqual(result.list, ['C:/path/one', 'C:/path/two']);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('EXIT_CONFIG_ERROR es 78 (sysexits EX_CONFIG)', () => {
  assert.equal(EXIT_CONFIG_ERROR, 78);
});

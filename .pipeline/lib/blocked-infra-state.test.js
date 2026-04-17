// =============================================================================
// blocked-infra-state.test.js — tests unitarios
// Ejecución: node --test .pipeline/lib/blocked-infra-state.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateEntry,
  readInfraStateFromDisk,
  writeInfraState,
  DEFAULT_FILENAME,
  SCHEMA_VERSION,
} = require('./blocked-infra-state');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infra-state-'));
}

const nowIso = new Date().toISOString();

// ─── validateEntry ───────────────────────────────────────────────────────────

test('validateEntry acepta entry válida', () => {
  const entry = validateEntry({
    blocked_reason: 'infra',
    endpoint: 'https://api.github.com/repos',
    timestamp: nowIso,
    parent_issue: 2314,
  });
  assert.ok(entry);
  assert.equal(entry.blocked_reason, 'infra');
  assert.equal(entry.endpoint, 'https://api.github.com/repos');
  assert.equal(entry.parent_issue, 2314);
});

test('validateEntry sanitiza endpoint con token', () => {
  const entry = validateEntry({
    blocked_reason: 'infra',
    endpoint: 'https://api.github.com/repos?api_key=secret&per_page=10',
    timestamp: nowIso,
    parent_issue: 2314,
  });
  assert.ok(entry);
  assert.equal(entry.endpoint, 'https://api.github.com/repos?per_page=10');
  assert.ok(!entry.endpoint.includes('secret'));
});

test('validateEntry rechaza blocked_reason inválido', () => {
  assert.equal(validateEntry({ blocked_reason: 'other', endpoint: 'x', timestamp: nowIso, parent_issue: 1 }), null);
  assert.equal(validateEntry({ blocked_reason: null, endpoint: 'x', timestamp: nowIso, parent_issue: 1 }), null);
});

test('validateEntry rechaza endpoint vacío/no-sanitizable', () => {
  assert.equal(validateEntry({ blocked_reason: 'infra', endpoint: '', timestamp: nowIso, parent_issue: 1 }), null);
  assert.equal(validateEntry({ blocked_reason: 'infra', endpoint: '   ', timestamp: nowIso, parent_issue: 1 }), null);
});

test('validateEntry rechaza parent_issue inválido', () => {
  assert.equal(validateEntry({ blocked_reason: 'code', endpoint: 'x.com', timestamp: nowIso, parent_issue: 0 }), null);
  assert.equal(validateEntry({ blocked_reason: 'code', endpoint: 'x.com', timestamp: nowIso, parent_issue: -1 }), null);
  assert.equal(validateEntry({ blocked_reason: 'code', endpoint: 'x.com', timestamp: nowIso, parent_issue: 'abc' }), null);
});

test('validateEntry rechaza objeto null/undefined', () => {
  assert.equal(validateEntry(null), null);
  assert.equal(validateEntry(undefined), null);
  assert.equal(validateEntry('string'), null);
});

// ─── readInfraStateFromDisk ──────────────────────────────────────────────────

test('readInfraStateFromDisk devuelve vacío si no existe el archivo', () => {
  const dir = makeTempDir();
  const res = readInfraStateFromDisk(dir);
  assert.deepEqual(res.issues, {});
  assert.equal(res.error, undefined);
});

test('readInfraStateFromDisk devuelve vacío + error si JSON inválido', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, DEFAULT_FILENAME), '{not valid json');
  const res = readInfraStateFromDisk(dir);
  assert.deepEqual(res.issues, {});
  assert.equal(res.error, 'invalid-json');
});

test('readInfraStateFromDisk filtra entries inválidas', () => {
  const dir = makeTempDir();
  const payload = {
    version: 1,
    updatedAt: nowIso,
    issues: {
      '2314': {
        blocked_reason: 'infra',
        endpoint: 'https://api.github.com/v3',
        timestamp: nowIso,
        parent_issue: 2314,
      },
      '9999': {
        // reason inválido — debe ser filtrada
        blocked_reason: 'maybe',
        endpoint: 'https://x.com',
        timestamp: nowIso,
        parent_issue: 9999,
      },
    },
  };
  fs.writeFileSync(path.join(dir, DEFAULT_FILENAME), JSON.stringify(payload));
  const res = readInfraStateFromDisk(dir);
  assert.equal(Object.keys(res.issues).length, 1);
  assert.ok(res.issues['2314']);
  assert.equal(res.issues['9999'], undefined);
});

// ─── writeInfraState ─────────────────────────────────────────────────────────

test('writeInfraState persiste entries válidas y omite inválidas', () => {
  const dir = makeTempDir();
  const res = writeInfraState({
    '2314': { blocked_reason: 'infra', endpoint: 'https://api.github.com', timestamp: nowIso, parent_issue: 2314 },
    '2319': { blocked_reason: 'code', endpoint: 'https://api.github.com/v3', timestamp: nowIso, parent_issue: 2319 },
    'bad-id': { blocked_reason: 'infra', endpoint: 'x', timestamp: nowIso, parent_issue: 1 },
  }, dir);
  assert.equal(res.ok, true);
  assert.equal(res.written, 2);
  assert.equal(res.dropped, 1);
  const file = JSON.parse(fs.readFileSync(path.join(dir, DEFAULT_FILENAME), 'utf8'));
  assert.equal(file.version, SCHEMA_VERSION);
  assert.equal(Object.keys(file.issues).length, 2);
});

test('writeInfraState strippea tokens al persistir', () => {
  const dir = makeTempDir();
  writeInfraState({
    '2314': {
      blocked_reason: 'infra',
      endpoint: 'https://admin:pwd@api.github.com:443/repos?api_key=SHOULDNOTLEAK',
      timestamp: nowIso,
      parent_issue: 2314,
    },
  }, dir);
  const file = fs.readFileSync(path.join(dir, DEFAULT_FILENAME), 'utf8');
  assert.ok(!file.includes('SHOULDNOTLEAK'), 'el archivo persistido no debe contener el token');
  assert.ok(!file.includes('admin:pwd'), 'no debe persistir basic auth');
  assert.ok(!file.includes(':443'), 'no debe persistir puertos');
});

test('writeInfraState no persiste patrones de tokens reales', () => {
  // Grep pre-merge (CA4): aunque el deny-list filtra por clave, verificamos
  // que incluso con endpoint adversario no queda un token reconocible.
  const dir = makeTempDir();
  writeInfraState({
    '2314': {
      blocked_reason: 'infra',
      endpoint: 'https://api.github.com/?authorization=ghp_1234567890abcdefghij1234567890ABCDEF',
      timestamp: nowIso,
      parent_issue: 2314,
    },
  }, dir);
  const file = fs.readFileSync(path.join(dir, DEFAULT_FILENAME), 'utf8');
  const patterns = [
    /gh[pousr]_[A-Za-z0-9]{36,}/, // GitHub
    /AKIA[0-9A-Z]{16}/,            // AWS
    /sk-[A-Za-z0-9]{48}/,          // OpenAI
    /xox[baprs]-/,                  // Slack
  ];
  for (const p of patterns) {
    assert.ok(!p.test(file), `token pattern ${p} encontrado en archivo persistido`);
  }
});

#!/usr/bin/env node
// =============================================================================
// test-retrying-state.js — Tests de `.pipeline/retrying-state.js` (#2337 CA7/CA8)
//
// Cubre:
//   CA7.1 — escritura atomica del estado (FS-first)
//   CA7.4 — anti-parpadeo: retryingUntil = now + minRetryMs (2s por default)
//   CA7.5 — state persistido: dashboard puede leer sin race con el pulpo
//   CA8   — getActiveRetrying() filtra expirados (anti-memory leak)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  markRetrying,
  getActiveRetrying,
  sweepExpired,
  readState,
  emptyState,
  purgeExpired,
  DEFAULT_MIN_RETRY_MS,
  SCHEMA_VERSION,
  REASON_CONNECTIVITY_RESTORED,
} = require('./retrying-state');

function mkTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrying-state-'));
  return { file: path.join(dir, 'state.json'), dir };
}

function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('markRetrying — escribe retryingUntil = now + DEFAULT_MIN_RETRY_MS', () => {
  const { file, dir } = mkTempFile();
  try {
    const now = 1_700_000_000_000;
    const result = markRetrying([2337, 2335], { stateFile: file, now });
    assert.equal(result.retryingUntil, now + DEFAULT_MIN_RETRY_MS);
    assert.equal(result.written.length, 2);
    assert.ok(fs.existsSync(file));

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.version, SCHEMA_VERSION);
    assert.equal(persisted.issues['2337'].retryingUntil, now + DEFAULT_MIN_RETRY_MS);
    assert.equal(persisted.issues['2337'].reason, REASON_CONNECTIVITY_RESTORED);
    assert.equal(persisted.issues['2337'].previousState, 'blocked:infra');
    assert.equal(persisted.issues['2337'].since, now);
  } finally { rmRf(dir); }
});

test('markRetrying — overrideable minRetryMs (para smoke tests)', () => {
  const { file, dir } = mkTempFile();
  try {
    const now = 1_700_000_000_000;
    const result = markRetrying([2337], { stateFile: file, now, minRetryMs: 500 });
    assert.equal(result.retryingUntil, now + 500);
  } finally { rmRf(dir); }
});

test('markRetrying — lista vacia no escribe archivo', () => {
  const { file, dir } = mkTempFile();
  try {
    const result = markRetrying([], { stateFile: file });
    assert.equal(result.written.length, 0);
    assert.equal(result.retryingUntil, 0);
    assert.equal(fs.existsSync(file), false);
  } finally { rmRf(dir); }
});

test('markRetrying — valores invalidos se filtran (NaN, negativos)', () => {
  const { file, dir } = mkTempFile();
  try {
    const result = markRetrying([NaN, -1, 0, 2337, '2338', null, undefined], {
      stateFile: file,
      now: 1_700_000_000_000,
    });
    assert.equal(result.written.length, 2, 'solo 2337 y 2338 son validos');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(persisted.issues['2337']);
    assert.ok(persisted.issues['2338']);
    assert.equal(Object.keys(persisted.issues).length, 2);
  } finally { rmRf(dir); }
});

test('markRetrying — dedup: issues repetidos se consolidan', () => {
  const { file, dir } = mkTempFile();
  try {
    const result = markRetrying([2337, 2337, 2337], {
      stateFile: file,
      now: 1_700_000_000_000,
    });
    assert.equal(result.written.length, 1, 'dedup');
  } finally { rmRf(dir); }
});

test('getActiveRetrying — filtra issues con retryingUntil vencido', () => {
  const { file, dir } = mkTempFile();
  try {
    const now = 1_700_000_000_000;
    markRetrying([2337, 2335], { stateFile: file, now, minRetryMs: 1000 });
    // Mismo tick: ambos activos
    const active1 = getActiveRetrying({ stateFile: file, now: now + 500 });
    assert.equal(Object.keys(active1).length, 2);
    // Tras la ventana: ninguno activo
    const active2 = getActiveRetrying({ stateFile: file, now: now + 2000 });
    assert.equal(Object.keys(active2).length, 0);
  } finally { rmRf(dir); }
});

test('getActiveRetrying — archivo inexistente devuelve {} sin throw', () => {
  const { file, dir } = mkTempFile();
  try {
    const active = getActiveRetrying({ stateFile: file });
    assert.deepEqual(active, {});
  } finally { rmRf(dir); }
});

test('readState — archivo corrupto devuelve emptyState', () => {
  const { file, dir } = mkTempFile();
  try {
    fs.writeFileSync(file, '{not valid json');
    const state = readState(file, fs);
    assert.deepEqual(state, emptyState());
  } finally { rmRf(dir); }
});

test('readState — version incompatible devuelve emptyState', () => {
  const { file, dir } = mkTempFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 99, issues: { '1': {} } }));
    const state = readState(file, fs);
    assert.deepEqual(state, emptyState());
  } finally { rmRf(dir); }
});

test('purgeExpired — mantiene entradas dentro de la ventana + grace', () => {
  const now = 1_700_000_000_000;
  const state = {
    version: SCHEMA_VERSION,
    issues: {
      'recent': { retryingUntil: now + 1000, since: now },
      'justExpired': { retryingUntil: now - 100, since: now - 5000 },
      'veryOld': { retryingUntil: now - 999_999, since: now - 999_999 },
    },
    lastUpdate: now,
  };
  purgeExpired(state, now, 60 * 1000);
  assert.ok(state.issues.recent);
  assert.ok(state.issues.justExpired, 'dentro del grace de 60s');
  assert.equal(state.issues.veryOld, undefined);
});

test('sweepExpired — persiste y reporta removidos', () => {
  const { file, dir } = mkTempFile();
  try {
    const now = 1_700_000_000_000;
    // Escribimos dos entradas: una vigente, otra vencida
    const raw = {
      version: SCHEMA_VERSION,
      issues: {
        '2337': { retryingUntil: now + 1000, since: now },
        '9999': { retryingUntil: now - 10 * 60 * 1000, since: now - 20 * 60 * 1000 },
      },
      lastUpdate: now,
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = sweepExpired({ stateFile: file, now, graceMs: 60 * 1000 });
    assert.equal(r.removed, 1);
    assert.equal(r.remaining, 1);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(persisted.issues['2337']);
    assert.equal(persisted.issues['9999'], undefined);
  } finally { rmRf(dir); }
});

test('markRetrying — sobrescribe entrada existente (nueva ventana)', () => {
  const { file, dir } = mkTempFile();
  try {
    const t1 = 1_700_000_000_000;
    markRetrying([2337], { stateFile: file, now: t1, minRetryMs: 1000 });
    const t2 = t1 + 500;
    markRetrying([2337], { stateFile: file, now: t2, minRetryMs: 2000 });
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.issues['2337'].retryingUntil, t2 + 2000);
    assert.equal(persisted.issues['2337'].since, t2);
  } finally { rmRf(dir); }
});

test('FS-first contract — escritura atomica: no deja archivos .tmp leaking', () => {
  const { file, dir } = mkTempFile();
  try {
    markRetrying([2337], { stateFile: file });
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((f) => f.includes('.tmp'));
    assert.deepEqual(tmps, [], 'no debe quedar ningun .tmp tras write atomico');
  } finally { rmRf(dir); }
});

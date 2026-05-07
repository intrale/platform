// =============================================================================
// quota-snapshot-scheduler.test.js — Tests del scheduler de snapshots cuota.
// Issue #3012 (split de #3008, hija 1).
//
// Cubre:
//   - CA-18: kill switch (`QUOTA_SNAPSHOT_ENABLED=false`).
//   - CA-2:  frecuencia configurable (`QUOTA_SNAPSHOT_INTERVAL_MIN`).
//   - CA-16: capture/parse/persist fallidos no bloquean (no throw).
//   - Mapeo correcto de exit codes del .ps1 a categorías del alerter.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const scheduler = require('../quota-snapshot-scheduler');

// CA-18 — kill switch
test('isEnabled: respeta QUOTA_SNAPSHOT_ENABLED=false', () => {
  const prev = process.env.QUOTA_SNAPSHOT_ENABLED;
  try {
    process.env.QUOTA_SNAPSHOT_ENABLED = 'false';
    assert.strictEqual(scheduler.isEnabled(), false);
    process.env.QUOTA_SNAPSHOT_ENABLED = '0';
    assert.strictEqual(scheduler.isEnabled(), false);
    process.env.QUOTA_SNAPSHOT_ENABLED = 'no';
    assert.strictEqual(scheduler.isEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_ENABLED;
    else process.env.QUOTA_SNAPSHOT_ENABLED = prev;
  }
});

test('isEnabled: default es habilitado', () => {
  const prev = process.env.QUOTA_SNAPSHOT_ENABLED;
  try {
    delete process.env.QUOTA_SNAPSHOT_ENABLED;
    assert.strictEqual(scheduler.isEnabled(), true);
    process.env.QUOTA_SNAPSHOT_ENABLED = 'true';
    assert.strictEqual(scheduler.isEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_ENABLED;
    else process.env.QUOTA_SNAPSHOT_ENABLED = prev;
  }
});

// CA-2 — frecuencia configurable, con clamps
test('getIntervalMs: respeta QUOTA_SNAPSHOT_INTERVAL_MIN dentro de rango', () => {
  const prev = process.env.QUOTA_SNAPSHOT_INTERVAL_MIN;
  try {
    process.env.QUOTA_SNAPSHOT_INTERVAL_MIN = '120';
    assert.strictEqual(scheduler.getIntervalMs(), 120 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_INTERVAL_MIN;
    else process.env.QUOTA_SNAPSHOT_INTERVAL_MIN = prev;
  }
});

test('getIntervalMs: clampea valores fuera de rango (min 5, max 1440)', () => {
  const prev = process.env.QUOTA_SNAPSHOT_INTERVAL_MIN;
  try {
    process.env.QUOTA_SNAPSHOT_INTERVAL_MIN = '1';
    assert.strictEqual(scheduler.getIntervalMs(), scheduler.MIN_INTERVAL_MIN * 60 * 1000);
    process.env.QUOTA_SNAPSHOT_INTERVAL_MIN = '999999';
    assert.strictEqual(scheduler.getIntervalMs(), scheduler.MAX_INTERVAL_MIN * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_INTERVAL_MIN;
    else process.env.QUOTA_SNAPSHOT_INTERVAL_MIN = prev;
  }
});

// CA-16 — fallos no bloquean
test('runOnce: kill switch ON → retorna sin error', async () => {
  const prev = process.env.QUOTA_SNAPSHOT_ENABLED;
  try {
    process.env.QUOTA_SNAPSHOT_ENABLED = 'false';
    const r = await scheduler.runOnce({});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'killswitch');
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_ENABLED;
    else process.env.QUOTA_SNAPSHOT_ENABLED = prev;
  }
});

test('runOnce: capture exit 2 (operador enfocado) es skip silencioso, sin alerta', async () => {
  const calls = { failure: 0, success: 0, mismatch: 0, accountOk: 0 };
  const fakeAlerter = {
    recordFailure: () => { calls.failure += 1; },
    recordSuccess: () => { calls.success += 1; },
    recordAccountMismatch: () => { calls.mismatch += 1; },
    recordAccountOk: () => { calls.accountOk += 1; },
  };
  const r = await scheduler.runOnce({
    runCapture: async () => ({ exitCode: 2, stdout: '', stderr: '' }),
    alerter: fakeAlerter,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'capture_skipped');
  assert.strictEqual(calls.failure, 0);
});

test('runOnce: capture exit 5 (timeout) registra fallo categorizado session_disconnected', async () => {
  let lastFailure = null;
  const fakeAlerter = {
    recordFailure: (cat) => { lastFailure = cat; },
    recordSuccess: () => {},
    recordAccountMismatch: () => {},
    recordAccountOk: () => {},
  };
  const r = await scheduler.runOnce({
    runCapture: async () => ({ exitCode: 5, stdout: '', stderr: '' }),
    alerter: fakeAlerter,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'session_disconnected');
  assert.strictEqual(lastFailure, 'session_disconnected');
});

test('runOnce: ciclo completo OK con fakes ejecuta append + recordSuccess + recordAccountOk', async () => {
  const tmp = path.join(os.tmpdir(), `sched-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const fakePng = path.join(tmp, 'quota-fake.png');
  fs.writeFileSync(fakePng, 'x');

  const calls = { append: 0, success: 0, accountOk: 0, rotate: 0, cleanup: 0 };
  const fakeAlerter = {
    recordFailure: () => { throw new Error('no debería llamar failure'); },
    recordSuccess: () => { calls.success += 1; },
    recordAccountMismatch: () => { throw new Error('no debería llamar mismatch'); },
    recordAccountOk: () => { calls.accountOk += 1; },
  };

  const fakeSnapshot = {
    ts: '2026-05-07T00:00:00Z',
    session_pct: 10,
    parse_confidence: 91,
  };

  const r = await scheduler.runOnce({
    runCapture: async () => ({ exitCode: 0, stdout: fakePng + '\n', stderr: '' }),
    parseSnapshot: async () => ({ ok: true, snapshot: fakeSnapshot }),
    appendSnapshot: () => { calls.append += 1; },
    rotateIfNeeded: () => { calls.rotate += 1; return { rotated: false }; },
    cleanupOldPngs: () => { calls.cleanup += 1; return { deleted: 0 }; },
    alerter: fakeAlerter,
    allowedRoot: tmp,
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.append, 1);
  assert.strictEqual(calls.success, 1);
  assert.strictEqual(calls.accountOk, 1);
  assert.strictEqual(calls.rotate, 1);
  assert.strictEqual(calls.cleanup, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runOnce: account_mismatch llama recordAccountMismatch, no recordFailure', async () => {
  const tmp = path.join(os.tmpdir(), `sched-mismatch-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const fakePng = path.join(tmp, 'quota-mm.png');
  fs.writeFileSync(fakePng, 'x');

  const calls = { failure: 0, mismatch: 0 };
  const fakeAlerter = {
    recordFailure: () => { calls.failure += 1; },
    recordSuccess: () => {},
    recordAccountMismatch: () => { calls.mismatch += 1; },
    recordAccountOk: () => {},
  };

  const r = await scheduler.runOnce({
    runCapture: async () => ({ exitCode: 0, stdout: fakePng + '\n', stderr: '' }),
    parseSnapshot: async () => ({ ok: false, category: 'account_mismatch', reason: 'account_mismatch' }),
    appendSnapshot: () => {},
    rotateIfNeeded: () => ({ rotated: false }),
    cleanupOldPngs: () => ({ deleted: 0 }),
    alerter: fakeAlerter,
    allowedRoot: tmp,
  });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.mismatch, 1);
  assert.strictEqual(calls.failure, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('categorizeCaptureExit: mapea exit codes a la whitelist o null', () => {
  assert.strictEqual(scheduler.categorizeCaptureExit(0), null);
  assert.strictEqual(scheduler.categorizeCaptureExit(2), null);
  assert.strictEqual(scheduler.categorizeCaptureExit(3), null);
  assert.strictEqual(scheduler.categorizeCaptureExit(4), 'unknown');
  assert.strictEqual(scheduler.categorizeCaptureExit(5), 'session_disconnected');
  assert.strictEqual(scheduler.categorizeCaptureExit(6), 'unknown');
  assert.strictEqual(scheduler.categorizeCaptureExit(99), 'unknown');
});

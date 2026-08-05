'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { executeVaultCutFallback, VaultCutError, resolvePolicy } = require('../vault-cut-fallback');

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cut-'));
  const configPath = path.join(dir, 'config.yaml');
  const document = {
    vault: {
      enabled: true,
      bootstrap_fallback: true,
      cut_fallback: { authorization_ttl_seconds: 300, operation_timeout_ms: 1000, runbook: 'docs/runbook.md' },
      ...overrides,
    },
  };
  fs.writeFileSync(configPath, yaml.dump(document));
  return { dir, configPath, read: () => yaml.load(fs.readFileSync(configPath, 'utf8')) };
}

function validOptions(fx, overrides = {}) {
  return {
    configPath: fx.configPath,
    now: () => new Date('2026-08-04T12:00:00Z'),
    validateAllowlist: async () => true,
    evaluateCoverage: async () => ({ ok: true }),
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => true },
    ...overrides,
  };
}

test('corta el fallback, consume una autorización y relee el estado persistido', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  let consumed = 0;
  const result = await executeVaultCutFallback(validOptions(fx, {
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  }));
  assert.deepEqual(result, { ok: true, alreadyCut: false });
  assert.equal(consumed, 1);
  assert.equal(fx.read().vault.bootstrap_fallback, false);
  assert.match(fs.readFileSync(path.join(fx.dir, 'audit', 'vault-cut-fallback.jsonl'), 'utf8'), /fallback_cut/);
});

test('estado ya cortado es éxito idempotente y no consume autorización', async (t) => {
  const fx = fixture({ bootstrap_fallback: false });
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  let consumed = 0;
  const result = await executeVaultCutFallback(validOptions(fx, {
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  }));
  assert.equal(result.alreadyCut, true);
  assert.equal(consumed, 0);
});

test('fallo de auditoría posterior al reemplazo queda explícito y se recupera sin consumir otra autorización', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const auditPath = path.join(fx.dir, 'audit', 'vault-cut-fallback.jsonl');
  const fakeFs = Object.create(fs);
  let failAudit = true;
  fakeFs.appendFileSync = (file, ...args) => {
    if (failAudit && path.resolve(file) === path.resolve(auditPath)) throw new Error('audit disk failure');
    return fs.appendFileSync(file, ...args);
  };
  let consumed = 0;

  await assert.rejects(executeVaultCutFallback(validOptions(fx, {
    auditPath,
    fsImpl: fakeFs,
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  })), (error) => error.code === 'audit_pending' && error.stateApplied === true && error.recoverable === true);

  assert.equal(fx.read().vault.bootstrap_fallback, false);
  assert.equal(consumed, 1);
  assert.equal(fs.existsSync(`${fx.configPath}.cut-fallback.pending-audit.json`), true);

  failAudit = false;
  const retry = await executeVaultCutFallback(validOptions(fx, {
    auditPath,
    fsImpl: fakeFs,
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  }));
  assert.deepEqual(retry, { ok: true, alreadyCut: true, auditRecovered: true });
  assert.equal(consumed, 1);
  assert.equal(fs.existsSync(`${fx.configPath}.cut-fallback.pending-audit.json`), false);
  assert.match(fs.readFileSync(auditPath, 'utf8'), /"event":"fallback_cut"/);
});

test('firmante removido falla antes de consumir y conserva el fallback', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  let consumed = 0;
  await assert.rejects(executeVaultCutFallback(validOptions(fx, {
    validateAllowlist: async () => false,
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  })), (error) => error instanceof VaultCutError && error.code === 'allowlist_invalid');
  assert.equal(consumed, 0);
  assert.equal(fx.read().vault.bootstrap_fallback, true);
});

test('cobertura caída falla antes de consumir y conserva el fallback', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  await assert.rejects(executeVaultCutFallback(validOptions(fx, {
    evaluateCoverage: async () => ({ ok: false }),
  })), (error) => error.code === 'coverage_incomplete');
  assert.equal(fx.read().vault.bootstrap_fallback, true);
});

test('una autorización rechazada permite un retry posterior válido', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  await assert.rejects(executeVaultCutFallback(validOptions(fx, {
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => false },
  })), (error) => error.code === 'authorization_consumed');
  const retry = await executeVaultCutFallback(validOptions(fx));
  assert.equal(retry.ok, true);
});

test('fallo de reemplazo revierte el temporal y conserva YAML válido', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const fakeFs = Object.create(fs);
  fakeFs.renameSync = () => { throw new Error('disk failure'); };
  await assert.rejects(executeVaultCutFallback(validOptions(fx, { fsImpl: fakeFs })), (error) => error.code === 'persist_failed');
  assert.equal(fx.read().vault.bootstrap_fallback, true);
  assert.equal(fs.readdirSync(fx.dir).some((name) => name.endsWith('.tmp')), false);
});

test('dos cortes concurrentes permiten como máximo un consumo exitoso', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let consumed = 0;
  const first = executeVaultCutFallback(validOptions(fx, {
    validateAllowlist: async () => { await gate; return true; },
    authorization: { issuedAt: '2026-08-04T11:59:00Z', consume: async () => { consumed += 1; return true; } },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = executeVaultCutFallback(validOptions(fx));
  await assert.rejects(second, (error) => error.code === 'concurrent_execution');
  release();
  await first;
  assert.equal(consumed, 1);
});

test('TTL, timeout y runbook usan defaults y rechazan valores fail-open', () => {
  assert.deepEqual(resolvePolicy({ vault: {} }), {
    authorizationTtlSeconds: 300, operationTimeoutMs: 10000, runbook: 'docs/pipeline/vault-secretos-aws.md',
  });
  assert.throws(() => resolvePolicy({ vault: { cut_fallback: { authorization_ttl_seconds: 901 } } }), /TTL/);
  assert.throws(() => resolvePolicy({ vault: { cut_fallback: { operation_timeout_ms: 60001 } } }), /timeout/);
  assert.throws(() => resolvePolicy({ vault: { cut_fallback: { runbook: '' } } }), /runbook/);
});

test('timeout cancela validaciones y no produce consumo, corte ni auditoría tardíos', async (t) => {
  const fx = fixture({
    cut_fallback: { authorization_ttl_seconds: 300, operation_timeout_ms: 100, runbook: 'docs/runbook.md' },
  });
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const auditPath = path.join(fx.dir, 'audit', 'vault-cut-fallback.jsonl');
  let consumed = 0;
  let observedSignal;
  const pending = executeVaultCutFallback({
    configPath: fx.configPath,
    auditPath,
    validateAllowlist: async ({ signal }) => {
      observedSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return true;
    },
    evaluateCoverage: async () => true,
    authorization: { issuedAt: new Date().toISOString(), consume: async () => { consumed += 1; return true; } },
  });
  const timedOut = assert.rejects(pending, (error) => error.code === 'timeout');

  await new Promise((resolve) => setTimeout(resolve, 120));
  await assert.rejects(executeVaultCutFallback(validOptions(fx)), (error) => error.code === 'concurrent_execution');
  await timedOut;
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(observedSignal.aborted, true);
  assert.equal(consumed, 0);
  assert.equal(fx.read().vault.bootstrap_fallback, true);
  const audit = fs.readFileSync(auditPath, 'utf8');
  assert.doesNotMatch(audit, /fallback_cut/);
  assert.match(audit, /"code":"timeout"/);
});

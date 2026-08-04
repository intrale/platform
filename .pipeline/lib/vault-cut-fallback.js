'use strict';

// Ejecutor operacional del corte de bootstrap. No conoce work-files, estados
// del pipeline ni Telegram: esas fronteras quedan fuera de este módulo.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULTS = Object.freeze({
  authorizationTtlSeconds: 300,
  operationTimeoutMs: 10000,
  runbook: 'docs/pipeline/vault-secretos-aws.md',
});
const MAX_AUTHORIZATION_TTL_SECONDS = 900;
const MAX_OPERATION_TIMEOUT_MS = 60000;

class VaultCutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultCutError';
    this.code = code;
  }
}

function readDocument(configPath, fsImpl = fs) {
  let raw;
  try { raw = fsImpl.readFileSync(configPath, 'utf8'); }
  catch { throw new VaultCutError('config_unavailable', 'No se pudo leer la configuración del vault'); }
  let document;
  try { document = yaml.load(raw); }
  catch { throw new VaultCutError('config_invalid', 'La configuración del vault no es YAML válido'); }
  if (!document || typeof document !== 'object' || !document.vault || typeof document.vault !== 'object') {
    throw new VaultCutError('config_invalid', 'La configuración no contiene una sección vault válida');
  }
  return { raw, document };
}

function resolvePolicy(document) {
  const raw = document.vault.cut_fallback || {};
  const policy = {
    authorizationTtlSeconds: raw.authorization_ttl_seconds ?? DEFAULTS.authorizationTtlSeconds,
    operationTimeoutMs: raw.operation_timeout_ms ?? DEFAULTS.operationTimeoutMs,
    runbook: raw.runbook ?? DEFAULTS.runbook,
  };
  if (!Number.isInteger(policy.authorizationTtlSeconds) || policy.authorizationTtlSeconds < 1
      || policy.authorizationTtlSeconds > MAX_AUTHORIZATION_TTL_SECONDS) {
    throw new VaultCutError('policy_invalid', 'El TTL de autorización del corte es inválido');
  }
  if (!Number.isInteger(policy.operationTimeoutMs) || policy.operationTimeoutMs < 100
      || policy.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new VaultCutError('policy_invalid', 'El timeout operacional del corte es inválido');
  }
  if (typeof policy.runbook !== 'string' || !policy.runbook.trim()) {
    throw new VaultCutError('policy_invalid', 'El runbook del corte no está configurado');
  }
  return policy;
}

function appendAudit(auditPath, event, fsImpl = fs) {
  if (!auditPath) return;
  fsImpl.mkdirSync(path.dirname(auditPath), { recursive: true });
  fsImpl.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function renderCutDocument(raw) {
  const pattern = /^(\s{2}bootstrap_fallback:\s*)true\s*$/m;
  const matches = raw.match(new RegExp(pattern.source, 'gm')) || [];
  if (matches.length !== 1) throw new VaultCutError('state_invalid', 'No se pudo ubicar un único estado de fallback para cortar');
  return raw.replace(pattern, '$1false');
}

function atomicWrite(configPath, content, fsImpl = fs) {
  const dir = path.dirname(configPath);
  const temp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(temp, configPath);
  } catch (error) {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch {}
    throw new VaultCutError('persist_failed', 'No se pudo persistir atómicamente el corte del fallback');
  }
}

function acquireLock(configPath, fsImpl = fs) {
  const lockPath = `${configPath}.cut-fallback.lock`;
  try {
    const fd = fsImpl.openSync(lockPath, 'wx', 0o600);
    fsImpl.writeFileSync(fd, String(process.pid));
    return () => { try { fsImpl.closeSync(fd); } catch {} try { fsImpl.unlinkSync(lockPath); } catch {} };
  } catch {
    throw new VaultCutError('concurrent_execution', 'Ya hay un corte del fallback en ejecución');
  }
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new VaultCutError('timeout', 'El corte excedió el timeout operacional')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function accepted(result) {
  return result === true || (result && result.ok === true);
}

async function executeVaultCutFallback(opts = {}) {
  const configPath = path.resolve(opts.configPath || path.join(__dirname, '..', 'config.yaml'));
  const fsImpl = opts.fsImpl || fs;
  const auditPath = opts.auditPath || path.join(path.dirname(configPath), 'audit', 'vault-cut-fallback.jsonl');
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const release = acquireLock(configPath, fsImpl);
  let policy = DEFAULTS;
  try {
    const initial = readDocument(configPath, fsImpl);
    policy = resolvePolicy(initial.document);
    if (initial.document.vault.bootstrap_fallback === false) {
      appendAudit(auditPath, { ts: now().toISOString(), event: 'already_cut', ok: true, runbook: policy.runbook }, fsImpl);
      return { ok: true, alreadyCut: true };
    }
    if (initial.document.vault.bootstrap_fallback !== true) throw new VaultCutError('state_invalid', 'El estado del fallback es inválido');

    return await withTimeout(async () => {
      if (typeof opts.validateAllowlist !== 'function' || !accepted(await opts.validateAllowlist())) {
        throw new VaultCutError('allowlist_invalid', 'La allowlist vault-only no autoriza el corte');
      }
      if (typeof opts.evaluateCoverage !== 'function' || !accepted(await opts.evaluateCoverage())) {
        throw new VaultCutError('coverage_incomplete', 'La cobertura positiva del vault no habilita el corte');
      }
      if (!opts.authorization || typeof opts.authorization.consume !== 'function') {
        throw new VaultCutError('authorization_missing', 'Falta una autorización consumible para el corte');
      }
      const issuedAt = new Date(opts.authorization.issuedAt);
      const ageMs = now().getTime() - issuedAt.getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.authorizationTtlSeconds * 1000) {
        throw new VaultCutError('authorization_expired', 'La autorización del corte expiró');
      }
      if (!accepted(await opts.authorization.consume())) {
        throw new VaultCutError('authorization_consumed', 'La autorización del corte ya fue consumida');
      }

      // Relectura dentro del lock justo antes de escribir: jamás sobrescribir un
      // documento cambiado desde la evaluación inicial.
      const current = readDocument(configPath, fsImpl);
      if (current.raw !== initial.raw) throw new VaultCutError('config_changed', 'La configuración cambió durante el corte');
      atomicWrite(configPath, renderCutDocument(current.raw), fsImpl);
      const persisted = readDocument(configPath, fsImpl);
      if (persisted.document.vault.bootstrap_fallback !== false) {
        throw new VaultCutError('verification_failed', 'La relectura no confirmó el corte del fallback');
      }
      appendAudit(auditPath, { ts: now().toISOString(), event: 'fallback_cut', ok: true, runbook: policy.runbook }, fsImpl);
      return { ok: true, alreadyCut: false };
    }, policy.operationTimeoutMs);
  } catch (error) {
    const safe = error instanceof VaultCutError ? error : new VaultCutError('unexpected_error', 'El corte del fallback falló de forma segura');
    try { appendAudit(auditPath, { ts: now().toISOString(), event: 'cut_rejected', ok: false, code: safe.code, runbook: policy.runbook }, fsImpl); } catch {}
    throw safe;
  } finally {
    release();
  }
}

module.exports = {
  executeVaultCutFallback,
  execute: executeVaultCutFallback,
  resolvePolicy,
  renderCutDocument,
  atomicWrite,
  VaultCutError,
  DEFAULTS,
  MAX_AUTHORIZATION_TTL_SECONDS,
  MAX_OPERATION_TIMEOUT_MS,
};

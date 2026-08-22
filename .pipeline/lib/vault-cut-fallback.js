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

function pendingAuditPath(configPath) {
  return `${configPath}.cut-fallback.pending-audit.json`;
}

function writePendingAudit(configPath, event, fsImpl = fs) {
  const pendingPath = pendingAuditPath(configPath);
  try {
    fsImpl.writeFileSync(pendingPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    throw new VaultCutError('audit_journal_failed', 'No se pudo preparar la auditoría recuperable del corte');
  }
  return pendingPath;
}

function recoverPendingAudit(configPath, auditPath, fsImpl = fs) {
  const pendingPath = pendingAuditPath(configPath);
  if (!fsImpl.existsSync(pendingPath)) return false;
  try {
    const event = JSON.parse(fsImpl.readFileSync(pendingPath, 'utf8'));
    if (!event || event.event !== 'fallback_cut' || event.ok !== true) throw new Error('invalid journal');
    let alreadyAudited = false;
    if (auditPath && fsImpl.existsSync(auditPath)) {
      const records = fsImpl.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
      alreadyAudited = records.some((line) => {
        try { return JSON.parse(line).operation_id === event.operation_id; } catch { return false; }
      });
    }
    if (!alreadyAudited) appendAudit(auditPath, event, fsImpl);
    fsImpl.unlinkSync(pendingPath);
    return true;
  } catch {
    const error = new VaultCutError('audit_pending', 'El fallback ya fue cortado y su auditoría durable sigue pendiente');
    error.stateApplied = true;
    error.recoverable = true;
    throw error;
  }
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
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  const timeoutError = () => new VaultCutError('timeout', 'El corte excedió el timeout operacional');
  const assertActive = () => {
    if (timedOut || controller.signal.aborted || Date.now() >= deadline) {
      timedOut = true;
      if (!controller.signal.aborted) controller.abort(timeoutError());
      throw timeoutError();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, timeoutMs);
  try {
    // Esperar siempre la terminación real mantiene el lock mientras una
    // dependencia que todavía no soporta AbortSignal completa su trabajo.
    const result = await operation({ signal: controller.signal, assertActive });
    assertActive();
    return result;
  } catch (error) {
    if (timedOut || controller.signal.aborted || Date.now() >= deadline) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      if (recoverPendingAudit(configPath, auditPath, fsImpl)) {
        return { ok: true, alreadyCut: true, auditRecovered: true };
      }
      appendAudit(auditPath, { ts: now().toISOString(), event: 'already_cut', ok: true, runbook: policy.runbook }, fsImpl);
      return { ok: true, alreadyCut: true };
    }
    if (initial.document.vault.bootstrap_fallback !== true) throw new VaultCutError('state_invalid', 'El estado del fallback es inválido');
    const stalePendingPath = pendingAuditPath(configPath);
    if (fsImpl.existsSync(stalePendingPath)) {
      try { fsImpl.unlinkSync(stalePendingPath); }
      catch { throw new VaultCutError('audit_journal_failed', 'No se pudo limpiar una auditoría pendiente sin corte aplicado'); }
    }

    return await withTimeout(async ({ signal, assertActive }) => {
      if (typeof opts.validateAllowlist !== 'function' || !accepted(await opts.validateAllowlist({ signal }))) {
        throw new VaultCutError('allowlist_invalid', 'La allowlist vault-only no autoriza el corte');
      }
      assertActive();
      if (typeof opts.evaluateCoverage !== 'function' || !accepted(await opts.evaluateCoverage({ signal }))) {
        throw new VaultCutError('coverage_incomplete', 'La cobertura positiva del vault no habilita el corte');
      }
      assertActive();
      if (!opts.authorization || typeof opts.authorization.consume !== 'function') {
        throw new VaultCutError('authorization_missing', 'Falta una autorización consumible para el corte');
      }
      const issuedAt = new Date(opts.authorization.issuedAt);
      const ageMs = now().getTime() - issuedAt.getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.authorizationTtlSeconds * 1000) {
        throw new VaultCutError('authorization_expired', 'La autorización del corte expiró');
      }
      // Gate irreversible: una operación vencida jamás inicia el consumo.
      assertActive();
      if (!accepted(await opts.authorization.consume({ signal }))) {
        throw new VaultCutError('authorization_consumed', 'La autorización del corte ya fue consumida');
      }

      // Relectura dentro del lock justo antes de escribir: jamás sobrescribir un
      // documento cambiado desde la evaluación inicial.
      const current = readDocument(configPath, fsImpl);
      if (current.raw !== initial.raw) throw new VaultCutError('config_changed', 'La configuración cambió durante el corte');
      // Segundo gate irreversible, inmediatamente antes de persistir.
      assertActive();
      const cutEvent = {
        ts: now().toISOString(), event: 'fallback_cut', ok: true, runbook: policy.runbook,
        operation_id: `${process.pid}-${Date.now()}`,
      };
      const pendingPath = writePendingAudit(configPath, cutEvent, fsImpl);
      try {
        atomicWrite(configPath, renderCutDocument(current.raw), fsImpl);
      } catch (error) {
        try { fsImpl.unlinkSync(pendingPath); } catch {}
        throw error;
      }
      const persisted = readDocument(configPath, fsImpl);
      if (persisted.document.vault.bootstrap_fallback !== false) {
        throw new VaultCutError('verification_failed', 'La relectura no confirmó el corte del fallback');
      }
      try {
        appendAudit(auditPath, cutEvent, fsImpl);
        fsImpl.unlinkSync(pendingPath);
      } catch {
        const error = new VaultCutError('audit_pending', 'El fallback ya fue cortado y su auditoría durable sigue pendiente');
        error.stateApplied = true;
        error.recoverable = true;
        throw error;
      }
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

const PRECONDITION_CODES = new Set([
  'allowlist_invalid', 'coverage_incomplete', 'state_invalid', 'config_invalid',
  'config_unavailable', 'policy_invalid', 'authorization_missing',
  'authorization_expired', 'authorization_consumed', 'config_changed',
  'concurrent_execution', 'timeout', 'persist_failed', 'verification_failed',
]);

/** Adapta el ejecutor al vocabulario cerrado consumido por operationalToast(). */
function createOperationalExecutor(options = {}) {
  return async function operationalVaultCutExecutor() {
    try {
      const result = await executeVaultCutFallback(options);
      return { ok: true, status: result.alreadyCut ? 'already-cut' : 'cut' };
    } catch (error) {
      // El journal durable prueba que el estado ya fue aplicado; no mentir al
      // operador diciendo que el fallback se conservó. El próximo retry
      // reconstruye el JSONL de auditoría de forma idempotente.
      if (error && error.code === 'audit_pending' && error.stateApplied === true) {
        return { ok: true, status: 'cut' };
      }
      if (error && error.code === 'audit_journal_failed') {
        return { ok: false, status: 'audit-failed' };
      }
      return {
        ok: false,
        status: error && PRECONDITION_CODES.has(error.code)
          ? 'precondition-failed'
          : 'executor-unavailable',
      };
    }
  };
}

module.exports = {
  executeVaultCutFallback,
  execute: executeVaultCutFallback,
  createOperationalExecutor,
  resolvePolicy,
  renderCutDocument,
  atomicWrite,
  VaultCutError,
  DEFAULTS,
  MAX_AUTHORIZATION_TTL_SECONDS,
  MAX_OPERATION_TIMEOUT_MS,
};

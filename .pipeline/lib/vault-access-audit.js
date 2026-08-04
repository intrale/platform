'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendChained } = require('./audit-log');

const ACCESS_EVENT_NAMES = Object.freeze([
  'GetSecretValue',
  'BatchGetSecretValue',
  'GetParameter',
  'GetParameters',
  'GetParametersByPath',
]);
const CAUSAS = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'Un principal fuera de la allowlist leyó un secreto del vault.',
  AUTORIZACION_RECHAZADA: 'Se repitieron rechazos de autorización contra el vault.',
  RAFAGA_DE_LECTURAS: 'El volumen de lecturas superó el umbral de la ventana.',
});
const UNKNOWN_SCOPE = 'desconocido';
const DEFAULT_AUTH_FAILURE_THRESHOLD = 3;

function asMillis(value) {
  const n = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

function normalizePrincipal(value) {
  if (typeof value !== 'string' || !value) return null;
  const assumed = /^arn:aws[^:]*:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(value);
  return assumed ? `arn:aws:iam::${assumed[1]}:role/${assumed[2]}` : value;
}

function hashPrincipal(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex');
}

function parseCloudTrailEvent(event) {
  if (!event || typeof event !== 'object') return {};
  if (event.cloudTrailEvent && typeof event.cloudTrailEvent === 'object') return event.cloudTrailEvent;
  if (typeof event.CloudTrailEvent !== 'string') return {};
  try { return JSON.parse(event.CloudTrailEvent); } catch { return {}; }
}

function logicalScope(event, detail) {
  if (detail && detail.errorCode && detail.requestParameters == null) return UNKNOWN_SCOPE;
  const request = (detail && detail.requestParameters) || {};
  const raw = request.name || request.secretId || request.path || request.names;
  if (Array.isArray(raw)) return raw.map((v) => logicalName(v)).filter(Boolean).join(',') || UNKNOWN_SCOPE;
  return logicalName(raw) || UNKNOWN_SCOPE;
}

function logicalName(value) {
  if (typeof value !== 'string' || !value) return null;
  const withoutQuery = value.split('?')[0];
  const parts = withoutQuery.split(/[/:]/).filter(Boolean);
  const candidate = parts[parts.length - 1] || '';
  return /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : UNKNOWN_SCOPE;
}

function normalizeEvent(event) {
  const detail = parseCloudTrailEvent(event);
  const principal = normalizePrincipal(
    detail.userIdentity && (detail.userIdentity.arn || detail.userIdentity.principalId)
      || event.Username
  );
  const errorCode = detail.errorCode || null;
  return {
    id: event.EventId || detail.eventID || crypto.createHash('sha256')
      .update(JSON.stringify([event.EventName, event.EventTime, principal, errorCode])).digest('hex'),
    timestamp: event.EventTime || detail.eventTime || null,
    principal,
    event_name: event.EventName || detail.eventName || 'Unknown',
    scope_logico: logicalScope(event, detail),
    resultado: errorCode ? 'denied' : 'ok',
  };
}

function findingKey(finding) {
  return `${finding.causa}:${finding.principal_hash}:${finding.scope_logico}`;
}

/** Núcleo puro: clasifica eventos y aplica dedupe/cooldown sin I/O. */
function evaluateAccessEvents({ now, events, state, config }) {
  const nowMs = asMillis(now);
  const cfg = config && typeof config === 'object' ? config : {};
  const expected = new Set((cfg.expected_principals || []).map(normalizePrincipal).filter(Boolean));
  const previous = state && typeof state === 'object' ? state : {};
  const seen = { ...(previous.seen_events || {}) };
  const lastNotified = { ...(previous.last_notified || {}) };
  const cooldownMs = Math.max(0, Number(cfg.cooldown_min || 10) * 60 * 1000);
  const records = [];
  const candidates = [];

  for (const raw of Array.isArray(events) ? events : []) {
    const ev = normalizeEvent(raw);
    if (seen[ev.id]) continue;
    seen[ev.id] = nowMs;
    const principalHash = hashPrincipal(ev.principal);
    let causa = null;
    if (!ev.principal || !expected.has(ev.principal)) causa = 'IDENTIDAD_NO_ESPERADA';
    records.push({
      timestamp: ev.timestamp,
      principal_hash: principalHash,
      scope_logico: ev.scope_logico,
      tier: ev.event_name.includes('Secret') ? 'rotating' : 'standard',
      event_name: ev.event_name,
      resultado: ev.resultado,
      causa,
    });
    if (causa) candidates.push({ causa, principal_hash: principalHash, scope_logico: ev.scope_logico });
  }

  const denied = records.filter((r) => r.resultado === 'denied');
  if (denied.length >= Number(cfg.authorization_failure_threshold || DEFAULT_AUTH_FAILURE_THRESHOLD)) {
    candidates.push({ causa: 'AUTORIZACION_RECHAZADA', principal_hash: 'multiple', scope_logico: UNKNOWN_SCOPE });
  }
  const burstThreshold = Number(cfg.burst_threshold || 0);
  if (burstThreshold > 0 && records.length > burstThreshold) {
    candidates.push({ causa: 'RAFAGA_DE_LECTURAS', principal_hash: 'multiple', scope_logico: 'vault' });
  }

  const notifications = [];
  for (const finding of candidates) {
    const key = findingKey(finding);
    if (lastNotified[key] && nowMs - lastNotified[key] < cooldownMs) continue;
    lastNotified[key] = nowMs;
    notifications.push(finding);
  }

  const retentionFloor = nowMs - Math.max(60, Number(cfg.lookback_min || 30) * 3) * 60 * 1000;
  for (const [id, timestamp] of Object.entries(seen)) {
    if (timestamp < retentionFloor) delete seen[id];
  }
  return { records, notifications, nextState: { seen_events: seen, last_notified: lastNotified } };
}

function formatAccessAlert(findings, correlationId) {
  const unique = [...new Set(findings.map((f) => f.causa))];
  const scopes = [...new Set(findings.map((f) => f.scope_logico || UNKNOWN_SCOPE))].slice(0, 5);
  return [
    '⚠️ *Acceso anómalo al vault* — el pipeline sigue operativo',
    '',
    ...unique.map((cause) => `Causa: \`${cause}\` — ${CAUSAS[cause]}`),
    '',
    `Scopes lógicos: ${scopes.join(', ') || UNKNOWN_SCOPE}`,
    `id: ${correlationId}`,
    '',
    'Qué hacer: consultar CloudTrail Event history y validar el rol del host.',
  ].join('\n');
}

function createCloudTrailRunner(sourceEnv, region, deps = {}) {
  const runFile = deps.execFileSync || execFileSync;
  return (eventName, startTime, endTime) => {
    const args = ['cloudtrail', 'lookup-events', '--lookup-attributes',
      `AttributeKey=EventName,AttributeValue=${eventName}`,
      '--start-time', startTime, '--end-time', endTime,
      '--region', region, '--output', 'json', '--no-cli-pager'];
    return runFile('aws', args, {
      env: sourceEnv,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
  };
}

function readJson(file, fsImpl) {
  try { return fsImpl.existsSync(file) ? JSON.parse(fsImpl.readFileSync(file, 'utf8')) : {}; }
  catch { return {}; }
}

function runAccessAuditTick(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (config.enabled !== true) return { skipped: true, reason: 'disabled', records: [], notifications: [], errors: [] };
  if (!Array.isArray(config.expected_principals) || config.expected_principals.length === 0) {
    log('[vault-access-audit] tick omitido: expected_principals está vacía');
    return { skipped: true, reason: 'empty-allowlist', records: [], notifications: [], errors: [] };
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const pipelineDir = opts.pipelineDir || path.resolve(__dirname, '..');
  const statePath = opts.statePath || path.join(pipelineDir, 'vault-access-audit-state.json');
  const auditPath = opts.auditPath || path.join(pipelineDir, 'logs', 'vault-access-audit.jsonl');
  const lookbackMin = Math.max(1, Number(config.lookback_min || 30));
  const start = new Date(now.getTime() - lookbackMin * 60 * 1000).toISOString();
  const runner = opts.lookupEvents || createCloudTrailRunner(opts.sourceEnv || process.env,
    opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION, opts);
  const events = [];
  const errors = [];

  for (const eventName of ACCESS_EVENT_NAMES) {
    try {
      const payload = JSON.parse(runner(eventName, start, now.toISOString()) || '{}');
      events.push(...(Array.isArray(payload.Events) ? payload.Events : []));
    } catch (_err) {
      errors.push({ stage: 'lookup-events', event_name: eventName, message: 'consulta CloudTrail falló' });
      log(`[vault-access-audit] WARN lookup-events falló para ${eventName}`);
    }
  }

  const state = readJson(statePath, fsImpl);
  const result = evaluateAccessEvents({ now, events, state, config });
  for (const entry of result.records) {
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo escribir el rastro encadenado' }); }
  }

  if (result.notifications.length && typeof opts.sendTelegramFn === 'function') {
    const correlationId = `vault-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    try { opts.sendTelegramFn(formatAccessAlert(result.notifications, correlationId)); }
    catch (_err) {
      errors.push({ stage: 'send-telegram', message: 'no se pudo notificar al operador' });
      log('[vault-access-audit] WARN no se pudo notificar al operador');
    }
  }

  try {
    fsImpl.writeFileSync(statePath, JSON.stringify(result.nextState, null, 2));
  } catch (_err) {
    errors.push({ stage: 'persist-state', message: 'no se pudo persistir el cursor de auditoría' });
  }
  return { ...result, errors, skipped: false };
}

module.exports = {
  ACCESS_EVENT_NAMES,
  CAUSAS,
  UNKNOWN_SCOPE,
  normalizePrincipal,
  normalizeEvent,
  evaluateAccessEvents,
  formatAccessAlert,
  createCloudTrailRunner,
  runAccessAuditTick,
};

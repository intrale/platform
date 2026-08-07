'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendChained } = require('./audit-log');
const { redactAwsEvidence } = require('./kernel-table-verify');
const { buildAwsScopedEnv } = require('./kernel-provision');

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
const UNKNOWN_PRINCIPAL = 'desconocido';
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

/**
 * Identidad LÓGICA para el registro consultable (CA-3): tipo + nombre del
 * principal, sin account id ni ARN. La unidad es el rol por host (D-3): la
 * sesión ya viene colapsada al rol por `normalizePrincipal`.
 * Lo que no se puede nombrar con seguridad queda `desconocido` — nunca inferido.
 */
function logicalPrincipal(value) {
  if (typeof value !== 'string' || !value) return UNKNOWN_PRINCIPAL;
  const typed = /:(role|user|assumed-role|group)\/([^/]+)/.exec(value);
  const candidate = typed ? typed[2] : value.split(/[/:]/).filter(Boolean).pop();
  if (!candidate || /^\d{12}$/.test(candidate)) return UNKNOWN_PRINCIPAL;
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(candidate)) return UNKNOWN_PRINCIPAL;
  return typed ? `${typed[1] === 'assumed-role' ? 'role' : typed[1]}/${candidate}` : candidate;
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
    principal_logico: logicalPrincipal(principal),
    event_name: event.EventName || detail.eventName || 'Unknown',
    scope_logico: logicalScope(event, detail),
    resultado: errorCode ? 'denied' : 'ok',
    error_code: errorCode,
  };
}

/**
 * De qué almacén salió la lectura. Se deriva del nombre del evento porque es
 * lo único que el rastro informa: el *tier* del vault (`rotating`/`static`) NO
 * es observable desde CloudTrail y por eso no se registra — inventarlo sería
 * el mismo error que completar el scope de un `AccessDenied`.
 */
function almacenFor(eventName) {
  return String(eventName || '').includes('Secret') ? 'secrets-manager' : 'parameter-store';
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
      // Identidad en dos formas: la lógica hace consultable el registro (CA-3),
      // el hash permite correlacionar sin conservar la topología de la cuenta.
      principal_logico: ev.principal_logico,
      principal_hash: principalHash,
      scope_logico: ev.scope_logico,
      almacen: almacenFor(ev.event_name),
      event_name: ev.event_name,
      resultado: ev.resultado,
      causa,
      evidencia: ev.error_code ? redactAwsEvidence(ev.error_code) : null,
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

// -----------------------------------------------------------------------------
// Copy del operador. Texto 100% FIJO (UX-1/UX-4). Las únicas partes variables
// son el TOKEN del enum, el nombre LÓGICO del scope y el correlationId, y los
// tres los produce el pipeline — nunca el driver de AWS. Glifo ⚠️ (UX-2): el
// pipeline sigue operativo, no quedó pausado. El sujeto es la superficie
// ("acceso al vault"), no el módulo (UX-3).
// -----------------------------------------------------------------------------
const HEADER_ALERTA = '⚠️ *Acceso al vault fuera de lo esperado* — el pipeline sigue operativo';

const CONSECUENCIA = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'alguien que no está en la lista de identidades autorizadas leyó credenciales '
    + 'del vault: hay que asumir que esas credenciales quedaron expuestas hasta demostrar lo contrario',
  AUTORIZACION_RECHAZADA: 'se acumularon rechazos de permisos contra el vault: o hay una identidad '
    + 'probando accesos que no le corresponden, o un host quedó con permisos incompletos y sus agentes '
    + 'van a fallar al arrancar',
  RAFAGA_DE_LECTURAS: 'el volumen de lecturas se salió del patrón normal de la ventana: puede ser un '
    + 'lazo de reintentos del propio pipeline o un uso que no debería estar ocurriendo',
});

const ACCION = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'revisá el Event history de CloudTrail para la ventana informada y confirmá si '
    + 'ese acceso era legítimo. Si no lo era, rotá los secretos del scope afectado siguiendo '
    + '`docs/pipeline/vault-rotacion-auditoria.md`. Si lo era, sumá el rol a '
    + '`vault.access_audit.expected_principals` en `.pipeline/config.yaml`.',
  AUTORIZACION_RECHAZADA: 'revisá en el Event history quién recibió los rechazos y contrastá la policy '
    + 'del rol del host contra `docs/pipeline/vault-rotacion-auditoria.md`.',
  RAFAGA_DE_LECTURAS: 'revisá el detalle del rastro antes de subir `vault.access_audit.burst_threshold`: '
    + 'si el volumen viene del propio pipeline, el umbral está mal calibrado y hay que recalibrarlo, no silenciarlo.',
});

/**
 * Arma la alerta desde un template FIJO, en el orden de UX-1:
 * (1) severidad · (2) consecuencia en criollo · (3) causa como TOKEN + glosa ·
 * (4) qué hacer · y recién al final el diagnóstico. El diagnóstico NUNCA va
 * antes de la acción.
 *
 * @param {Array<{causa: string, scope_logico?: string}>} findings
 * @param {string} correlationId handle que liga alerta ↔ registro ↔ pulpo.log.
 * @returns {string}
 */
function formatAccessAlert(findings, correlationId) {
  const causas = [...new Set((Array.isArray(findings) ? findings : [])
    .map((f) => f && f.causa).filter((c) => Object.hasOwn(CAUSAS, c)))];
  const scopes = [...new Set((Array.isArray(findings) ? findings : [])
    .map((f) => (f && f.scope_logico) || UNKNOWN_SCOPE))].slice(0, 5);
  const lines = [HEADER_ALERTA, ''];
  for (const causa of causas) {
    lines.push(CONSECUENCIA[causa], '', `Causa: \`${causa}\` — ${CAUSAS[causa]}`, '',
      `Qué hacer: ${ACCION[causa]}`, '');
  }
  // Diagnóstico al final (UX-1). Sólo nombres lógicos: nada de ARN, account id,
  // IP, path completo ni salida de la CLI.
  lines.push(`Scopes afectados: ${scopes.join(', ') || UNKNOWN_SCOPE}`);
  lines.push(`id: ${correlationId}`);
  lines.push('El detalle completo está en el Event history de CloudTrail y en '
    + '`.pipeline/logs/vault-access-audit.jsonl`.');
  return lines.join('\n');
}

/**
 * Runner de sólo lectura sobre el Event history. Sin shell (así que la trampa
 * de MSYS no aplica al runtime, sí a los comandos manuales del runbook) y con
 * el env armado por ALLOWLIST: el proceso hijo NO hereda las API keys de los
 * proveedores que viven en `process.env`.
 */
function createCloudTrailRunner(sourceEnv, region, deps = {}) {
  const runFile = deps.execFileSync || execFileSync;
  const env = buildAwsScopedEnv(sourceEnv, region);
  return (eventName, startTime, endTime) => {
    const args = ['cloudtrail', 'lookup-events', '--lookup-attributes',
      `AttributeKey=EventName,AttributeValue=${eventName}`,
      '--start-time', startTime, '--end-time', endTime,
      '--region', region, '--output', 'json', '--no-cli-pager'];
    return runFile('aws', args, {
      env,
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

  // La región sale SÓLO de `kernel.region` (pulpo.js la pasa en opts.region), que
  // es la misma fuente que documenta el runbook. NO se cae a AWS_REGION /
  // AWS_DEFAULT_REGION a propósito: el Event history de CloudTrail es POR REGIÓN,
  // así que una región heredada del ambiente que no sea la del vault no falla —
  // devuelve `Events: 0`, indistinguible de "nadie accedió al vault". Ese falso
  // negativo silencioso es justamente lo que este control existe para evitar, y
  // un fallback lo reintroduce por la puerta de atrás.
  const region = opts.region;
  // Sin región no se consulta nada: `--region undefined` devolvería un error de
  // la CLI que se leería como "no hubo accesos", o sea un control apagado que
  // aparenta estar prendido. Se prefiere no correr y decirlo (R-H).
  if (!opts.lookupEvents && !region) {
    log('[vault-access-audit] tick omitido: falta kernel.region');
    return { skipped: true, reason: 'sin-region', records: [], notifications: [], errors: [] };
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const pipelineDir = opts.pipelineDir || path.resolve(__dirname, '..');
  const statePath = opts.statePath || path.join(pipelineDir, 'vault-access-audit-state.json');
  const auditPath = opts.auditPath || path.join(pipelineDir, 'logs', 'vault-access-audit.jsonl');
  const lookbackMin = Math.max(1, Number(config.lookback_min || 30));
  const start = new Date(now.getTime() - lookbackMin * 60 * 1000).toISOString();
  const runner = opts.lookupEvents
    || createCloudTrailRunner(opts.sourceEnv || process.env, region, opts);
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
      // R-D · El canal de la alerta depende del propio vault que la alerta
      // vigila. Fail-SOFT en la notificación, fail-CLOSED en el rastro: si no
      // se pudo avisar, el silencio del canal no puede leerse como "todo bien"
      // (UX-5), así que la falla queda como entrada encadenada.
      errors.push({ stage: 'send-telegram', message: 'no se pudo notificar al operador' });
      log('[vault-access-audit] WARN no se pudo notificar al operador');
      const failure = {
        timestamp: now.toISOString(),
        principal_logico: 'pipeline',
        principal_hash: hashPrincipal('pipeline'),
        scope_logico: 'telegram',
        almacen: 'pipeline',
        event_name: 'VaultAuditNotification',
        resultado: 'error',
        causa: null,
        // Nunca el error del canal: sólo un marcador cerrado del pipeline.
        evidencia: 'NOTIFICACION_NO_ENVIADA',
      };
      try { appendChained({ file: auditPath, entry: failure, fsImpl }); }
      catch (_e) { errors.push({ stage: 'append-audit', message: 'no se pudo registrar la falla de notificación' }); }
      result.records.push(failure);
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
  UNKNOWN_PRINCIPAL,
  normalizePrincipal,
  logicalPrincipal,
  almacenFor,
  normalizeEvent,
  evaluateAccessEvents,
  formatAccessAlert,
  createCloudTrailRunner,
  runAccessAuditTick,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyChain, readAll } = require('../audit-log');
const audit = require('../vault-access-audit');

const NOW = new Date('2026-08-03T12:00:00.000Z');
const EXPECTED = 'arn:aws:iam::123456789012:role/intrale-host-a';

function event(overrides = {}) {
  const detail = {
    eventTime: '2026-08-03T11:59:00Z',
    eventName: 'GetParameter',
    userIdentity: { arn: EXPECTED },
    requestParameters: { name: '/intrale/project/shared/providers' },
    ...overrides.detail,
  };
  return {
    EventId: overrides.id || 'event-1',
    EventName: detail.eventName,
    EventTime: detail.eventTime,
    CloudTrailEvent: JSON.stringify(detail),
  };
}

function config(overrides = {}) {
  return { expected_principals: [EXPECTED], cooldown_min: 10, burst_threshold: 0, ...overrides };
}

test('principal fuera de la allowlist produce IDENTIDAD_NO_ESPERADA', () => {
  const result = audit.evaluateAccessEvents({
    now: NOW,
    events: [event({ detail: { userIdentity: { arn: 'arn:aws:iam::999999999999:role/otro' } } })],
    state: {},
    config: config(),
  });
  assert.equal(result.records[0].causa, 'IDENTIDAD_NO_ESPERADA');
  assert.equal(result.notifications[0].causa, 'IDENTIDAD_NO_ESPERADA');
});

test('normaliza una sesión STS al rol esperado por host', () => {
  const result = audit.evaluateAccessEvents({
    now: NOW,
    events: [event({ detail: { userIdentity: { arn: 'arn:aws:sts::123456789012:assumed-role/intrale-host-a/session-7' } } })],
    state: {},
    config: config(),
  });
  assert.equal(result.records[0].causa, null);
  assert.equal(result.notifications.length, 0);
});

test('allowlist vacía hace que el tick no consulte ni alerte', () => {
  let queries = 0;
  let alerts = 0;
  const logs = [];
  const result = audit.runAccessAuditTick({
    config: { enabled: true, expected_principals: [] },
    lookupEvents: () => { queries++; return '{}'; },
    sendTelegramFn: () => { alerts++; },
    log: (line) => logs.push(line),
  });
  assert.equal(result.reason, 'empty-allowlist');
  assert.equal(queries, 0);
  assert.equal(alerts, 0);
  assert.match(logs.join('\n'), /expected_principals.*vacía/);
});

test('cooldown suprime la segunda notificación pero conserva el segundo registro', () => {
  const first = audit.evaluateAccessEvents({
    now: NOW,
    events: [event({ id: 'first', detail: { userIdentity: { arn: 'arn:aws:iam::999999999999:role/otro' } } })],
    state: {},
    config: config(),
  });
  const second = audit.evaluateAccessEvents({
    now: new Date(NOW.getTime() + 60_000),
    events: [event({ id: 'second', detail: { userIdentity: { arn: 'arn:aws:iam::999999999999:role/otro' } } })],
    state: first.nextState,
    config: config(),
  });
  assert.equal(first.notifications.length, 1);
  assert.equal(second.notifications.length, 0);
  assert.equal(second.records.length, 1);
});

test('AccessDenied sin requestParameters registra scope desconocido sin inventarlo', () => {
  const result = audit.evaluateAccessEvents({
    now: NOW,
    events: [event({ detail: { errorCode: 'AccessDenied', requestParameters: null } })],
    state: {},
    config: config(),
  });
  assert.equal(result.records[0].resultado, 'denied');
  assert.equal(result.records[0].scope_logico, audit.UNKNOWN_SCOPE);
});

test('el mensaje cerrado no filtra ARN, account id, IP ni stderr', () => {
  const message = audit.formatAccessAlert([{
    causa: 'IDENTIDAD_NO_ESPERADA',
    principal_hash: 'abc',
    scope_logico: 'providers',
  }], 'vault-test-1');
  assert.doesNotMatch(message, /arn:aws/i);
  assert.doesNotMatch(message, /\b\d{12}\b/);
  assert.doesNotMatch(message, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(message, /stderr|AccessDeniedException|AKIA/i);
  assert.match(message, /IDENTIDAD_NO_ESPERADA/);
});

test('el runner escribe JSONL encadenado verificable y nunca valores secretos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-'));
  const statePath = path.join(dir, 'state.json');
  const auditPath = path.join(dir, 'audit.jsonl');
  let sent = 0;
  const result = audit.runAccessAuditTick({
    pipelineDir: dir,
    statePath,
    auditPath,
    now: NOW,
    config: { enabled: true, ...config() },
    lookupEvents: (eventName) => JSON.stringify({ Events: eventName === 'GetParameter'
      ? [event({ id: 'chain-event' })] : [] }),
    sendTelegramFn: () => { sent++; },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(sent, 0);
  assert.deepEqual(verifyChain(auditPath), { ok: true, entriesChecked: 1 });
  const [entry] = readAll(auditPath);
  assert.equal(entry.scope_logico, 'providers');
  assert.equal(entry.resultado, 'ok');
  assert.equal(JSON.stringify(entry).includes('/intrale/project'), false);
});

test('fallos repetidos de autorización y ráfaga usan causas cerradas', () => {
  const events = [1, 2, 3].map((n) => event({
    id: `denied-${n}`,
    detail: { errorCode: 'AccessDenied', requestParameters: null },
  }));
  const result = audit.evaluateAccessEvents({
    now: NOW,
    events,
    state: {},
    config: config({ burst_threshold: 2, authorization_failure_threshold: 3 }),
  });
  const causes = result.notifications.map((n) => n.causa);
  assert.ok(causes.includes('AUTORIZACION_RECHAZADA'));
  assert.ok(causes.includes('RAFAGA_DE_LECTURAS'));
});

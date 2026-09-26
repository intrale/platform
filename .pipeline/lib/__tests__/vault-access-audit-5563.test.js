// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #5563 — Encendido del gate de auditoría de accesos al vault: allowlist
// DERIVADA por host (CA-1), fail-closed de recolección (CA-2), copy UX-A/UX-B
// y línea de log UX-C. Extiende la suite base (`vault-access-audit.test.js`)
// sin duplicarla: los helpers `event`/`config` se replican mínimamente acá
// para que cada archivo corra solo con `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyChain, readAll } = require('../audit-log');
const audit = require('../vault-access-audit');

const NOW = new Date('2026-09-14T12:00:00.000Z');
const ACCT = '123456789012';
const HOST = 'HOST-A';
const EXPECTED = 'arn:aws:iam::123456789012:role/intrale-host-a';
const BURST_THRESHOLD_TEST = 12;
const VAULT_CFG = { hostId: '', hostIdFromHostname: true };
const IDENTITY_OK = () => JSON.stringify({
  UserId: 'AIDAFAKE', Account: ACCT, Arn: `arn:aws:iam::${ACCT}:user/claude-code`,
});

function event(overrides = {}) {
  const detail = {
    eventTime: '2026-09-14T11:59:00Z',
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

/** Config literal (sin derivación), como la usa la suite base. */
function config(overrides = {}) {
  return { expected_principals: [EXPECTED], cooldown_min: 10, burst_threshold: BURST_THRESHOLD_TEST, ...overrides };
}

/** Config con derivación pedida y allowlist literal vacía (estado del YAML real). */
function derivedConfig(overrides = {}) {
  return {
    enabled: true, expected_principals: [], expected_principals_from_hosts: true,
    cooldown_min: 10, lookback_min: 30, burst_threshold: BURST_THRESHOLD_TEST, ...overrides,
  };
}

function tmpPaths(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, statePath: path.join(dir, 'state.json'), auditPath: path.join(dir, 'audit.jsonl') };
}

test('#5563 · CA-1 · el ARN derivado matchea un evento real del rol del host (sesión STS)', () => {
  const derivado = audit.buildHostRoleArn(ACCT, HOST);
  assert.equal(derivado, `arn:aws:iam::${ACCT}:role/${audit.HOST_ROLE_PREFIX}${HOST}`);
  assert.equal(derivado, audit.normalizePrincipal(
    `arn:aws:sts::${ACCT}:assumed-role/${audit.HOST_ROLE_PREFIX}${HOST}/session-42`));
  // Nunca un ARN a medias: segmentos inválidos devuelven null.
  assert.equal(audit.buildHostRoleArn('12345', HOST), null);
  assert.equal(audit.buildHostRoleArn(ACCT, 'a.fqdn.local'), null);
  assert.equal(audit.buildHostRoleArn(ACCT, ''), null);
  assert.equal(audit.buildHostRoleArn(123456789012, HOST), null);
});

test('#5563 · CA-1 · con derivación pedida y literales vacíos el tick NO sale por empty-allowlist', () => {
  const { dir, statePath, auditPath } = tmpPaths('vault-audit-derive-');
  const alerts = [];
  let stsCalls = 0;
  const result = audit.runAccessAuditTick({
    pipelineDir: dir, statePath, auditPath, now: NOW,
    config: derivedConfig(),
    vaultConfig: VAULT_CFG,
    hostname: () => HOST,
    accountIdCache: new Map(),
    getCallerIdentity: () => { stsCalls++; return IDENTITY_OK(); },
    lookupEvents: (eventName) => JSON.stringify({ Events: eventName === 'GetParameter'
      ? [event({ id: 'host-read', detail: { userIdentity: {
        arn: `arn:aws:sts::${ACCT}:assumed-role/${audit.HOST_ROLE_PREFIX}${HOST}/session-1` } } })] : [] }),
    sendTelegramFn: (m) => alerts.push(m),
  });
  assert.equal(result.skipped, false);
  assert.equal(stsCalls, 1);
  assert.equal(result.errors.length, 0);
  // El evento del rol derivado es un acceso ESPERADO: sin causa y sin alerta.
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].causa, null);
  assert.equal(alerts.length, 0);
  assert.equal(result.resumen.degradado, false);
  assert.equal(result.resumen.accesos_observados, 1);
  assert.ok(Number.isFinite(result.duration_ms));
});

test('#5563 · CA-1 · la allowlist efectiva es derivadas ∪ literales y el account id se memoiza por proceso', () => {
  const cache = new Map();
  let stsCalls = 0;
  const literal = 'arn:aws:iam::123456789012:role/otro-host';
  const args = {
    config: derivedConfig({ expected_principals: [literal] }), vaultConfig: VAULT_CFG,
    hostname: () => HOST, cache, region: 'us-east-2',
    getCallerIdentity: () => { stsCalls++; return IDENTITY_OK(); },
  };
  const first = audit.resolveExpectedPrincipals(args);
  const second = audit.resolveExpectedPrincipals(args);
  assert.deepEqual(first.principals, [literal, audit.buildHostRoleArn(ACCT, HOST)]);
  assert.deepEqual(second.principals, first.principals);
  assert.equal(stsCalls, 1, 'la segunda resolución no vuelve a llamar a sts');
  assert.deepEqual(first.derivation, { requested: true, ok: true, reason: null });
});

test('#5563 · CA-1 · "true" string NO deriva: booleano exacto como hostIdFromHostname', () => {
  const logs = [];
  const result = audit.runAccessAuditTick({
    config: derivedConfig({ expected_principals_from_hosts: 'true' }),
    vaultConfig: VAULT_CFG, hostname: () => HOST, accountIdCache: new Map(),
    getCallerIdentity: () => { throw new Error('no debería llamarse'); },
    lookupEvents: () => { throw new Error('no debería consultar'); },
    log: (l) => logs.push(l),
  });
  assert.equal(result.reason, 'empty-allowlist');
  assert.match(logs.join('\n'), /tick omitido: expected_principals/);
});

test('#5563 · CA-1 · si la derivación falla el tick sale por allowlist-no-derivable, escribe rastro y avisa UNA vez', () => {
  const { dir, statePath, auditPath } = tmpPaths('vault-audit-noderiv-');
  const alerts = [];
  const logs = [];
  const cache = new Map();
  const base = {
    pipelineDir: dir, statePath, auditPath, region: 'us-east-2',
    config: derivedConfig(), vaultConfig: VAULT_CFG, hostname: () => HOST, accountIdCache: cache,
    getCallerIdentity: () => { throw new Error('sts: AccessDenied 10.0.0.9'); },
    lookupEvents: () => { throw new Error('no debería consultar sin allowlist'); },
    sendTelegramFn: (m) => alerts.push(m),
    log: (l) => logs.push(l),
  };
  const first = audit.runAccessAuditTick({ ...base, now: NOW });
  assert.equal(first.skipped, true);
  assert.equal(first.reason, 'allowlist-no-derivable');
  assert.ok(first.errors.some((e) => e.stage === 'derive-allowlist'));
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].startsWith('⚠️ *Auditoría del vault a oscuras*'));
  assert.match(logs.join('\n'), /tick omitido: allowlist-no-derivable \(sts-fallo\)/);
  assert.equal(first.resumen.degradado, true);
  assert.equal(cache.size, 0, 'la memo del account id queda invalidada tras la falla');
  const entries = readAll(auditPath);
  const rastro = entries.find((e) => e.stage === 'derive-allowlist');
  assert.equal(rastro.causa, 'RECOLECCION_FALLIDA');
  assert.equal(rastro.resultado, 'error');
  assert.doesNotMatch(JSON.stringify(entries), /10\.0\.0\.9|AccessDenied/);
  assert.deepEqual(verifyChain(auditPath), { ok: true, entriesChecked: entries.length });
  // Segundo tick dentro del cooldown: detección registrada, aviso suprimido.
  const second = audit.runAccessAuditTick({ ...base, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.reason, 'allowlist-no-derivable');
  assert.equal(alerts.length, 1);
  assert.ok(second.detections.some((d) => d.causa === 'RECOLECCION_FALLIDA' && d.notificada === false));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).ticks_degradados_consecutivos, 2);
});

test('#5563 · CA-1 · sin hostId resoluble la derivación falla nombrando la razón', () => {
  const r = audit.resolveExpectedPrincipals({
    config: derivedConfig(), vaultConfig: { hostId: '', hostIdFromHostname: false },
    hostname: () => HOST, cache: new Map(), getCallerIdentity: IDENTITY_OK,
  });
  assert.deepEqual(r.derivation, { requested: true, ok: false, reason: 'host-id-no-resuelto' });
  assert.deepEqual(r.principals, []);
  const fqdn = audit.resolveExpectedPrincipals({
    config: derivedConfig(), vaultConfig: VAULT_CFG, hostname: () => 'a.uno.local',
    cache: new Map(), getCallerIdentity: IDENTITY_OK,
  });
  assert.equal(fqdn.derivation.reason, 'host-id-no-resuelto');
  const sinSts = audit.resolveExpectedPrincipals({
    config: derivedConfig(), vaultConfig: VAULT_CFG, hostname: () => HOST, cache: new Map(),
  });
  assert.equal(sinSts.derivation.reason, 'sts-no-disponible');
  const ilegible = audit.resolveExpectedPrincipals({
    config: derivedConfig(), vaultConfig: VAULT_CFG, hostname: () => HOST, cache: new Map(),
    getCallerIdentity: () => JSON.stringify({ Account: '12' }),
  });
  assert.equal(ilegible.derivation.reason, 'account-id-ilegible');
  // Sin la señal, comportamiento de siempre: sólo literales, sin tocar sts.
  const off = audit.resolveExpectedPrincipals({
    config: { expected_principals: [EXPECTED] },
    getCallerIdentity: () => { throw new Error('no'); },
  });
  assert.deepEqual(off, { principals: [EXPECTED], derivation: { requested: false, ok: true, reason: null } });
});

test('#5563 · CA-1 · el runner de sts usa el mismo env por allowlist y sin shell que el de CloudTrail', () => {
  let visto = null;
  const runner = audit.createStsIdentityRunner(
    { AWS_ACCESS_KEY_ID: 'AKIAFAKE', OPENAI_API_KEY: 'sk-secreto', PATH: '/usr/bin' }, 'us-east-2',
    { execFileSync: (cmd, args, opts) => { visto = { cmd, args, opts }; return IDENTITY_OK(); } });
  runner();
  assert.equal(visto.cmd, 'aws');
  assert.deepEqual(visto.args.slice(0, 2), ['sts', 'get-caller-identity']);
  assert.equal(visto.opts.shell, false);
  assert.equal(visto.opts.env.AWS_REGION, 'us-east-2');
  assert.equal(visto.opts.env.OPENAI_API_KEY, undefined);
});

test('#5563 · CA-2 · escenario de guru: cinco consultas fallidas producen UNA alerta "a oscuras" y rastro por consulta', () => {
  const { dir, statePath, auditPath } = tmpPaths('vault-audit-oscuras-');
  const alerts = [];
  const logs = [];
  const base = {
    pipelineDir: dir, statePath, auditPath,
    config: { enabled: true, ...config() },
    lookupEvents: () => { throw new Error('An error occurred (AccessDeniedException) 10.0.0.7'); },
    sendTelegramFn: (m) => alerts.push(m),
    log: (l) => logs.push(l),
  };
  const first = audit.runAccessAuditTick({ ...base, now: NOW });
  assert.equal(first.skipped, false);
  assert.equal(first.errors.filter((e) => e.stage === 'lookup-events').length, 5);
  assert.ok(first.records.length >= 5, 'una entrada de rastro por consulta fallida');
  assert.equal(first.notifications.length, 1, 'un solo aviso por tick, no uno por event_name');
  assert.equal(alerts.length, 1);
  assert.equal(first.resumen.degradado, true);
  assert.equal(first.resumen.consultas_fallidas, 5);
  assert.equal(first.resumen.accesos_observados, 0);
  const entries = readAll(auditPath);
  const fallidas = entries.filter((e) => e.stage === 'lookup-events');
  assert.equal(fallidas.length, 5);
  assert.deepEqual(fallidas.map((e) => e.event_name).sort(), [...audit.ACCESS_EVENT_NAMES].sort());
  for (const e of fallidas) {
    assert.equal(e.causa, 'RECOLECCION_FALLIDA');
    assert.equal(e.evidencia, 'RECOLECCION_FALLIDA');
    assert.equal(e.resultado, 'error');
  }
  assert.doesNotMatch(JSON.stringify(entries), /AccessDeniedException|10\.0\.0\.7/);
  const deteccion = entries.find((e) => e.event_name === 'VaultAuditDetection');
  assert.equal(deteccion.causa, 'RECOLECCION_FALLIDA');
  assert.equal(deteccion.notificada, true);
  assert.deepEqual(verifyChain(auditPath), { ok: true, entriesChecked: entries.length });
  // Segundo tick degradado dentro del cooldown: sin aviso, con detección encadenada.
  const second = audit.runAccessAuditTick({ ...base, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.notifications.length, 0);
  assert.equal(alerts.length, 1);
  assert.ok(second.detections.some((d) => d.causa === 'RECOLECCION_FALLIDA' && d.notificada === false));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).ticks_degradados_consecutivos, 2);
  // Tercer tick sano: UNA línea de recuperación en el log, nada por Telegram.
  const third = audit.runAccessAuditTick({
    ...base, now: new Date(NOW.getTime() + 120_000), lookupEvents: () => '{"Events":[]}',
  });
  assert.equal(third.resumen.degradado, false);
  assert.equal(alerts.length, 1);
  assert.match(logs.join('\n'), /Tick recuperado tras 2 tick\(s\) degradado\(s\)/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).ticks_degradados_consecutivos, 0);
  assert.deepEqual(verifyChain(auditPath), { ok: true, entriesChecked: readAll(auditPath).length });
});

test('#5563 · CA-2 · un fallo parcial también se declara degradado y no se mezcla con la alerta de acceso', () => {
  const { dir, statePath, auditPath } = tmpPaths('vault-audit-parcial-');
  const alerts = [];
  const result = audit.runAccessAuditTick({
    pipelineDir: dir, statePath, auditPath, now: NOW,
    config: { enabled: true, ...config() },
    lookupEvents: (eventName) => {
      if (eventName === 'GetSecretValue') throw new Error('timeout');
      return JSON.stringify({ Events: eventName === 'GetParameter'
        ? [event({ id: 'intruso', detail: { userIdentity: { arn: 'arn:aws:iam::999999999999:role/otro' } } })] : [] });
    },
    sendTelegramFn: (m) => alerts.push(m),
  });
  assert.equal(result.resumen.consultas_fallidas, 1);
  assert.equal(result.resumen.degradado, true);
  assert.equal(result.resumen.accesos_observados, 1);
  // Dos hechos, dos mensajes, dos headers: nunca en el mismo texto.
  assert.equal(alerts.length, 2);
  const acceso = alerts.find((m) => m.startsWith('⚠️ *Acceso al vault fuera de lo esperado*'));
  const oscuras = alerts.find((m) => m.startsWith('⚠️ *Auditoría del vault a oscuras*'));
  assert.ok(acceso && oscuras);
  assert.doesNotMatch(acceso, /RECOLECCION_FALLIDA/);
  assert.doesNotMatch(oscuras, /IDENTIDAD_NO_ESPERADA/);
  assert.match(oscuras, /Consultas fallidas: 1\/5/);
});

test('#5563 · UX-B · la alerta "a oscuras" usa su header, diagnóstico con unidad y copy cerrado', () => {
  const message = audit.formatAccessAlert([{
    causa: 'RECOLECCION_FALLIDA', principal_hash: 'pipeline', scope_logico: 'vault',
    consultas_fallidas: 5, consultas_total: 5, ventana_min: 30,
  }], 'vault-oscuras-1');
  assert.ok(message.startsWith('⚠️ *Auditoría del vault a oscuras* — el pipeline sigue operativo'));
  assert.match(message, /desde el último tick exitoso no hay garantía/);
  assert.match(message, /Causa: `RECOLECCION_FALLIDA`/);
  assert.match(message, /VaultAuditReadEventHistory/);
  assert.match(message, /Consultas fallidas: 5\/5/);
  assert.match(message, /Ventana no observada: 30 minutos/);
  assert.ok(message.indexOf('Qué hacer:') < message.indexOf('Consultas fallidas:'));
  assert.match(message, /id: vault-oscuras-1/);
  // Mismo set de prohibiciones que CA-6.
  assert.doesNotMatch(message, /arn:aws/i);
  assert.doesNotMatch(message, /\b\d{12}\b/);
  assert.doesNotMatch(message, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(message, /stderr|AccessDeniedException|Traceback|AKIA/i);
});

test('#5563 · UX-A · la acción de IDENTIDAD_NO_ESPERADA ya no manda a editar config.yaml', () => {
  const message = audit.formatAccessAlert(
    [{ causa: 'IDENTIDAD_NO_ESPERADA', scope_logico: 'providers' }], 'vault-uxa');
  assert.doesNotMatch(message, /expected_principals/);
  assert.doesNotMatch(message, /config\.yaml/);
  assert.match(message, /lectura manual tuya, es la alerta esperada/);
  assert.match(message, /intrale-vault-runtime-<hostId>/);
  assert.match(message, /la allowlist se deriva sola/);
  assert.match(message, /rotá los secretos del scope afectado/);
  assert.ok(message.startsWith('⚠️ *Acceso al vault fuera de lo esperado*'));
});

test('#5563 · UX-C · la línea del tick es greppable: DEGRADADO al principio y duración en ms', () => {
  assert.equal(audit.formatTickLogLine({
    resumen: { consultas_total: 5, consultas_fallidas: 0, accesos_observados: 0, degradado: false },
    notifications: [], duration_ms: 1834,
  }), 'Tick OK: 0 acceso(s), 0 alerta(s), 5/5 consultas, 1834 ms');
  assert.equal(audit.formatTickLogLine({
    resumen: { consultas_total: 5, consultas_fallidas: 5, accesos_observados: 0, degradado: true },
    notifications: [{ causa: 'RECOLECCION_FALLIDA' }], duration_ms: 20012,
  }), 'Tick DEGRADADO: 5/5 consultas fallaron, 0 acceso(s) observados, 20012 ms');
  assert.match(audit.formatTickLogLine({
    resumen: { consultas_total: 5, consultas_fallidas: 0, accesos_observados: 2, degradado: false },
    notifications: [{ causa: 'IDENTIDAD_NO_ESPERADA' }], duration_ms: 900,
  }), /^Tick OK: 2 acceso\(s\), 1 alerta\(s\), 5\/5 consultas, 900 ms$/);
});

test('#5563 · el tick omitido por disabled/empty-allowlist no toca sts ni el rastro', () => {
  let sts = 0;
  const off = audit.runAccessAuditTick({
    config: derivedConfig({ enabled: false }), vaultConfig: VAULT_CFG,
    getCallerIdentity: () => { sts++; return IDENTITY_OK(); }, lookupEvents: () => '{}',
  });
  assert.equal(off.reason, 'disabled');
  assert.ok(Number.isFinite(off.duration_ms));
  assert.equal(sts, 0);
});

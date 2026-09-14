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

// #5801 — El default del helper ya NO es `0`: el cero dejó de ser un valor
// admisible del umbral (es el control apagado) y el esquema lo rechaza. Se usa
// un entero positivo holgado para que los tests que NO son de ráfaga sigan
// afirmando sobre su propio comportamiento y no rocen el umbral de rebote.
const BURST_THRESHOLD_TEST = 12;

function config(overrides = {}) {
  return {
    expected_principals: [EXPECTED],
    cooldown_min: 10,
    burst_threshold: BURST_THRESHOLD_TEST,
    ...overrides,
  };
}

/** Lectura FÍSICA distinta: id propio para que el dedupe no las colapse. */
function physicalRead(n) {
  return event({ id: `physical-${n}` });
}

/** Evento del rastro LOCAL del vault (`{category, ts_ms}`, #5803). */
function telemetry(category, n = 0) {
  return { category, ts_ms: NOW.getTime() - n };
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

test('sin región configurada el tick no corre y lo dice, en vez de fingir cero accesos', () => {
  const logs = [];
  const previo = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  try {
    const result = audit.runAccessAuditTick({
      config: { enabled: true, ...config() },
      log: (line) => logs.push(line),
    });
    assert.equal(result.reason, 'sin-region');
    assert.match(logs.join('\n'), /kernel\.region/);
  } finally {
    if (previo.AWS_REGION !== undefined) process.env.AWS_REGION = previo.AWS_REGION;
    if (previo.AWS_DEFAULT_REGION !== undefined) process.env.AWS_DEFAULT_REGION = previo.AWS_DEFAULT_REGION;
  }
});

test('CA-9 · una región heredada del ambiente NO reemplaza a kernel.region', () => {
  // El Event history de CloudTrail es POR REGIÓN: consultar la región equivocada
  // no falla, devuelve `Events: 0` — indistinguible de "nadie accedió al vault".
  // Por eso un AWS_REGION del ambiente no habilita el tick: sin kernel.region se
  // omite y se dice, en vez de auditar en silencio la región que no es.
  const logs = [];
  const previo = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
  process.env.AWS_REGION = 'us-east-1';           // NO es la región del vault
  process.env.AWS_DEFAULT_REGION = 'eu-west-1';
  try {
    const result = audit.runAccessAuditTick({
      config: { enabled: true, ...config() },
      log: (line) => logs.push(line),
    });
    assert.equal(result.reason, 'sin-region');
    assert.deepEqual(result.records, []);
    assert.match(logs.join('\n'), /kernel\.region/);
  } finally {
    if (previo.AWS_REGION === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previo.AWS_REGION;
    if (previo.AWS_DEFAULT_REGION === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = previo.AWS_DEFAULT_REGION;
  }
});

test('el hijo de la CLI recibe un env por allowlist, sin las API keys de los proveedores', () => {
  let visto = null;
  const runner = audit.createCloudTrailRunner(
    { AWS_ACCESS_KEY_ID: 'AKIAFAKE', ANTHROPIC_API_KEY: 'sk-secreto', PATH: '/usr/bin' },
    'us-east-2',
    { execFileSync: (_cmd, _args, opts) => { visto = opts.env; return '{}'; } },
  );
  runner('GetParameter', '2026-08-03T00:00:00Z', '2026-08-03T01:00:00Z');
  assert.equal(visto.AWS_ACCESS_KEY_ID, 'AKIAFAKE');
  assert.equal(visto.AWS_REGION, 'us-east-2');
  assert.equal(visto.ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(visto), /sk-secreto/);
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
  // CA-3 · el registro es consultable: dice QUIÉN, sin account id ni ARN.
  assert.equal(entry.principal_logico, 'role/intrale-host-a');
  assert.equal(entry.almacen, 'parameter-store');
  assert.doesNotMatch(JSON.stringify(entry), /arn:aws|\b\d{12}\b/);
});

test('CA-3 · la identidad del registro nunca se inventa cuando el rastro no la informa', () => {
  assert.equal(audit.logicalPrincipal('arn:aws:iam::123456789012:role/intrale-host-a'), 'role/intrale-host-a');
  assert.equal(audit.logicalPrincipal('arn:aws:sts::123456789012:assumed-role/host-a/session-9'), 'role/host-a');
  assert.equal(audit.logicalPrincipal('arn:aws:iam::123456789012:user/provisioner'), 'user/provisioner');
  assert.equal(audit.logicalPrincipal('123456789012'), audit.UNKNOWN_PRINCIPAL);
  assert.equal(audit.logicalPrincipal(null), audit.UNKNOWN_PRINCIPAL);
});

test('UX-5 · una notificación que no sale queda registrada en el rastro encadenado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-fail-'));
  const auditPath = path.join(dir, 'audit.jsonl');
  const result = audit.runAccessAuditTick({
    pipelineDir: dir,
    statePath: path.join(dir, 'state.json'),
    auditPath,
    now: NOW,
    config: { enabled: true, ...config() },
    lookupEvents: (eventName) => JSON.stringify({ Events: eventName === 'GetParameter'
      ? [event({ id: 'intruso', detail: { userIdentity: { arn: 'arn:aws:iam::999999999999:role/otro' } } })] : [] }),
    sendTelegramFn: () => { throw new Error('canal caído: AccessDenied 10.0.0.7'); },
  });
  assert.ok(result.errors.some((e) => e.stage === 'send-telegram'));
  const entries = readAll(auditPath);
  const failure = entries.find((e) => e.event_name === 'VaultAuditNotification');
  assert.equal(failure.evidencia, 'NOTIFICACION_NO_ENVIADA');
  assert.equal(failure.resultado, 'error');
  // El error del canal no se copia al rastro: sólo el marcador cerrado.
  assert.doesNotMatch(JSON.stringify(entries), /canal caído|10\.0\.0\.7/);
  assert.deepEqual(verifyChain(auditPath), { ok: true, entriesChecked: entries.length });
});

test('UX-1 · la alerta pone la acción antes del diagnóstico y usa el glifo de warning', () => {
  const message = audit.formatAccessAlert(
    [{ causa: 'IDENTIDAD_NO_ESPERADA', scope_logico: 'providers' }], 'vault-orden-1');
  assert.ok(message.startsWith('⚠️'), 'abre con el glifo de anomalía, no con el de pipeline pausado');
  assert.doesNotMatch(message, /^🛑|^🔴/);
  assert.ok(message.indexOf('Qué hacer:') < message.indexOf('Scopes afectados:'),
    'el diagnóstico va después de la acción');
  assert.ok(message.indexOf('Causa: `') < message.indexOf('Qué hacer:'));
  // UX-3 · el sujeto es la superficie, no el módulo.
  assert.doesNotMatch(message.split('\n')[0], /vault-access-audit/);
});

test('CA-6 · toda causa del enum produce copy cerrada sin topología de la cuenta', () => {
  for (const causa of Object.keys(audit.CAUSAS)) {
    const message = audit.formatAccessAlert([{ causa, scope_logico: 'providers' }], 'vault-enum');
    assert.doesNotMatch(message, /arn:aws/i);
    assert.doesNotMatch(message, /\b\d{12}\b/);
    assert.doesNotMatch(message, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    assert.doesNotMatch(message, /stderr|AccessDeniedException|Traceback|AKIA/i);
    assert.match(message, new RegExp(`Causa: \`${causa}\``));
    assert.match(message, /Qué hacer:/);
  }
  // Una causa fuera del enum no puede colarse como texto libre en el mensaje.
  const intruso = audit.formatAccessAlert(
    [{ causa: 'arn:aws:iam::123456789012:role/atacante', scope_logico: 'x' }], 'vault-enum');
  assert.doesNotMatch(intruso, /arn:aws/i);
});

// ---------------------------------------------------------------------------
// Greps estáticos sobre el módulo: los invariantes que no se pueden demostrar
// ejecutando (CA-7 · CA-8 · CA-6) se verifican sobre el fuente.
// ---------------------------------------------------------------------------
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'vault-access-audit.js'), 'utf8');

test('CA-7 · el rastro se escribe sólo con appendChained, nunca con writeFileSync', () => {
  assert.match(SOURCE, /appendChained\(/);
  for (const line of SOURCE.split('\n')) {
    if (!/writeFileSync/.test(line)) continue;
    // El único writeFileSync admitido es el del cursor de estado, no el JSONL.
    assert.match(line, /statePath/, `writeFileSync fuera del cursor de estado: ${line.trim()}`);
  }
  assert.doesNotMatch(SOURCE, /appendFileSync\s*\(\s*auditPath/);
});

test('CA-8 · el módulo no provisiona trails ni toca event selectors', () => {
  assert.doesNotMatch(SOURCE, /create-trail|put-event-selectors|start-logging|delete-trail/);
  assert.match(SOURCE, /lookup-events/);
});

test('CA-6 · el módulo no importa el canal ni arma mensajes con texto del driver AWS', () => {
  assert.doesNotMatch(SOURCE, /require\(['"]\.\/notify-telegram['"]\)/);
  assert.doesNotMatch(SOURCE, /notifyTelegram\(/);
  // La CLI se invoca sin shell: nada de string interpolado a un intérprete.
  assert.match(SOURCE, /shell:\s*false/);
  assert.doesNotMatch(SOURCE, /\bexecSync\s*\(/);
  assert.doesNotMatch(SOURCE, /shell:\s*true/);
});

test('fallos repetidos de autorización usan la causa cerrada y NO cuentan como ráfaga', () => {
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
  // #5801 — Un `AccessDenied` NO leyó ningún secreto: no es `physical_read` y
  // por lo tanto no puede disparar la ráfaga. Ese tráfico ya tiene su propio
  // control (`authorization_failure_threshold`); contarlo dos veces convertía
  // un pico de rechazos en una alerta de volumen que no describía nada real.
  assert.ok(!causes.includes('RAFAGA_DE_LECTURAS'));
  assert.equal(result.counters.physical_read, 0);
  assert.equal(result.counters.rechazados, 3);
});

test('lecturas físicas por encima del umbral sí producen la ráfaga', () => {
  const result = audit.evaluateAccessEvents({
    now: NOW,
    events: [1, 2, 3].map(physicalRead),
    state: {},
    config: config({ burst_threshold: 2 }),
  });
  const causes = result.notifications.map((n) => n.causa);
  assert.ok(causes.includes('RAFAGA_DE_LECTURAS'));
  assert.equal(result.counters.physical_read, 3);
  assert.equal(result.burst.umbral, 2);
  assert.equal(result.burst.lecturas_fisicas, 3);
});

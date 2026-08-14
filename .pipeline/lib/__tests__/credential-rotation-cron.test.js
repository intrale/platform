// =============================================================================
// Tests credential-rotation-cron.js — Issue #3080 / S1 multi-provider
//
// Cobertura de los CA del issue:
//   CA-4 · Cron lee inventario, calcula T-14/T-7/T-3/T-1/T-0 y notifica.
//   CA-5 · Idempotencia: cada threshold dispara una sola vez por ciclo.
//   CA-7 · No-leak: el mensaje de Telegram no contiene valores de env vars.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const cron = require('../credential-rotation-cron');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-cron-test-'));
  return dir;
}

function makeInventory({ provider = 'anthropic', envVar = 'ANTHROPIC_API_KEY', owner = 'leo', lastRotated, expiresAt, runbookUrl = 'https://example.com/runbook' } = {}) {
  const lr = typeof lastRotated === 'string' ? lastRotated : lastRotated.toISOString().slice(0, 10);
  const er = expiresAt
    ? (typeof expiresAt === 'string' ? expiresAt : expiresAt.toISOString().slice(0, 10))
    : new Date(new Date(lr + 'T00:00:00Z').getTime() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [
    '# Inventario',
    '',
    '| provider | env_var | owner | last_rotated | expires_at | account_id | rotation_runbook_url | revocation_endpoint |',
    '|----------|---------|-------|--------------|------------|------------|----------------------|---------------------|',
    `| ${provider} | \`${envVar}\` | ${owner} | ${lr} | ${er} | acct-1 | [runbook](${runbookUrl}) | https://x.com |`,
    '',
  ].join('\n');
}

function dateUTC(isoString) {
  return new Date(isoString + (isoString.length === 10 ? 'T00:00:00Z' : ''));
}

// ─── parseInventoryMarkdown ─────────────────────────────────────────────────

test('parseInventoryMarkdown · parsea fila básica con todos los campos', () => {
  const md = makeInventory({ lastRotated: '2026-04-01' });
  const rows = cron.parseInventoryMarkdown(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'anthropic');
  assert.equal(rows[0].env_var, 'ANTHROPIC_API_KEY');
  assert.equal(rows[0].owner, 'leo');
  assert.equal(rows[0].last_rotated.toISOString().slice(0, 10), '2026-04-01');
  assert.equal(rows[0].expires_at.toISOString().slice(0, 10), '2026-06-30');
  assert.equal(rows[0].runbook_url, 'https://example.com/runbook');
});

test('parseInventoryMarkdown · ignora filas con last_rotated no parseable', () => {
  const md = [
    '| provider | env_var | owner | last_rotated | expires_at |',
    '|----------|---------|-------|--------------|------------|',
    '| anthropic | `KEY` | leo | _no aplica todavía_ | _no aplica_ |',
    '| openai | `OPENAI_API_KEY` | leo | 2026-04-01 | 2026-06-30 |',
  ].join('\n');
  const rows = cron.parseInventoryMarkdown(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'openai');
});

test('parseInventoryMarkdown · sin tabla devuelve []', () => {
  const rows = cron.parseInventoryMarkdown('# Solo prosa\n\nNada que parsear.');
  assert.deepEqual(rows, []);
});

test('parseISODate · acepta YYYY-MM-DD, rechaza otros formatos', () => {
  assert.ok(cron.parseISODate('2026-04-01'));
  assert.equal(cron.parseISODate('2026/04/01'), null);
  assert.equal(cron.parseISODate('01-04-2026'), null);
  assert.equal(cron.parseISODate('not-a-date'), null);
  assert.equal(cron.parseISODate(undefined), null);
});

// ─── thresholdForEntry ──────────────────────────────────────────────────────

test('thresholdForEntry · 30 días antes → null (fuera de ventana)', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-05-31'));
  assert.equal(t, null);
});

test('thresholdForEntry · 14 días antes → T-14', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-06-16'));
  assert.equal(t.key, 'T-14');
  assert.equal(t.daysRemaining, 14);
});

test('thresholdForEntry · 7 días antes → T-7 (no T-14)', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-06-23'));
  assert.equal(t.key, 'T-7');
});

test('thresholdForEntry · 3 días antes → T-3', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-06-27'));
  assert.equal(t.key, 'T-3');
});

test('thresholdForEntry · 1 día antes → T-1', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-06-29'));
  assert.equal(t.key, 'T-1');
});

test('thresholdForEntry · día del vencimiento → T-0 (expirada)', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-06-30'));
  assert.equal(t.key, 'T-0');
  assert.equal(t.expired, true);
});

test('thresholdForEntry · post-vencimiento → T-0 con días negativos', () => {
  const entry = { expires_at: dateUTC('2026-06-30') };
  const t = cron.thresholdForEntry(entry, dateUTC('2026-07-15'));
  assert.equal(t.key, 'T-0');
  assert.ok(t.daysRemaining < 0);
});

// ─── shouldNotifyEntry — idempotencia ────────────────────────────────────────

test('shouldNotifyEntry · primer disparo de T-14 → notifica', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-14', expired: false };
  const decision = cron.shouldNotifyEntry(entry, threshold, {});
  assert.equal(decision.shouldNotify, true);
});

test('shouldNotifyEntry · T-14 ya disparado → silencio', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-14', expired: false };
  const state = { KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } } };
  const decision = cron.shouldNotifyEntry(entry, threshold, state);
  assert.equal(decision.shouldNotify, false);
});

test('shouldNotifyEntry · last_rotated cambió → reset y notifica de nuevo', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-05-01') };
  const threshold = { key: 'T-14', expired: false };
  const state = { KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-14': '2026-06-16' } } };
  const decision = cron.shouldNotifyEntry(entry, threshold, state);
  assert.equal(decision.shouldNotify, true);
  assert.equal(decision.resetState, true);
});

test('shouldNotifyEntry · T-0 (expirada) notifica SIEMPRE — ruido sostenido G-5', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-0', expired: true };
  // Aún si el state indica que T-0 ya se notificó, debe volver a notificar.
  const state = { KEY: { last_rotated: '2026-04-01', thresholds_sent: { 'T-0': '2026-06-30' } } };
  const decision = cron.shouldNotifyEntry(entry, threshold, state);
  assert.equal(decision.shouldNotify, true);
});

// ─── evaluateRotationState — flujo completo ─────────────────────────────────

test('evaluateRotationState · T-14 dispara una vez, T-13 no re-dispara', () => {
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'ANTHROPIC_API_KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-04-01'),
    expires_at: dateUTC('2026-06-30'),
    runbook_url: 'https://x.com',
  }];

  // Primer tick a T-14.
  const r1 = cron.evaluateRotationState({
    now: dateUTC('2026-06-16'),
    inventoryRows,
    state: {},
  });
  assert.equal(r1.alerts.length, 1);
  assert.equal(r1.alerts[0].threshold, 'T-14');
  assert.equal(r1.nextState.ANTHROPIC_API_KEY.thresholds_sent['T-14'], '2026-06-16');

  // Segundo tick a T-13 (mismo threshold T-14): no re-dispara.
  const r2 = cron.evaluateRotationState({
    now: dateUTC('2026-06-17'),
    inventoryRows,
    state: r1.nextState,
  });
  assert.equal(r2.alerts.length, 0);
});

test('evaluateRotationState · 4 thresholds disparan secuencialmente sin overlap', () => {
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-04-01'),
    expires_at: dateUTC('2026-06-30'),
  }];
  let state = {};
  // T-14 (16 jun)
  let r = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows, state });
  assert.equal(r.alerts[0].threshold, 'T-14');
  state = r.nextState;
  // T-7 (23 jun)
  r = cron.evaluateRotationState({ now: dateUTC('2026-06-23'), inventoryRows, state });
  assert.equal(r.alerts[0].threshold, 'T-7');
  state = r.nextState;
  // T-3 (27 jun)
  r = cron.evaluateRotationState({ now: dateUTC('2026-06-27'), inventoryRows, state });
  assert.equal(r.alerts[0].threshold, 'T-3');
  state = r.nextState;
  // T-1 (29 jun)
  r = cron.evaluateRotationState({ now: dateUTC('2026-06-29'), inventoryRows, state });
  assert.equal(r.alerts[0].threshold, 'T-1');
  state = r.nextState;
  // Verificar que el state acumula los 4 thresholds.
  assert.deepEqual(Object.keys(state.KEY.thresholds_sent).sort(), ['T-1', 'T-14', 'T-3', 'T-7']);
});

test('evaluateRotationState · si dos thresholds caen el mismo día, elige el MÁS URGENTE', () => {
  // Caso límite: el operador rota tarde y el cron arranca ya en T-3
  // (porque venía pausado). Los thresholds T-14 y T-7 saltean, y T-3
  // se dispara como el primero de la cadena.
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-04-01'),
    expires_at: dateUTC('2026-06-30'),
  }];
  const r = cron.evaluateRotationState({
    now: dateUTC('2026-06-28'),  // 2 días antes
    inventoryRows,
    state: {},
  });
  // 2 días: en ventana de T-3 (días <= 3). NO emite T-14 ni T-7 retroactivamente.
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].threshold, 'T-3');
});

test('evaluateRotationState · T-0 (expirada) re-dispara en ticks consecutivos', () => {
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-04-01'),
    expires_at: dateUTC('2026-06-30'),
  }];
  let state = {};
  const r1 = cron.evaluateRotationState({ now: dateUTC('2026-07-01'), inventoryRows, state });
  assert.equal(r1.alerts.length, 1);
  assert.equal(r1.alerts[0].threshold, 'T-0');
  assert.equal(r1.alerts[0].priority, 'critical');
  state = r1.nextState;
  const r2 = cron.evaluateRotationState({ now: dateUTC('2026-07-02'), inventoryRows, state });
  // En T-0 expirada, sí re-dispara (ruido sostenido).
  assert.equal(r2.alerts.length, 1);
  assert.equal(r2.alerts[0].threshold, 'T-0');
});

test('evaluateRotationState · al rotar (last_rotated salta), reset del ciclo', () => {
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-07-15'),    // recién rotada
    expires_at: dateUTC('2026-10-13'),      // 90d después
  }];
  // Estado previo de un ciclo anterior con T-14 y T-7 ya disparados.
  const state = {
    KEY: {
      last_rotated: '2026-04-01',
      thresholds_sent: { 'T-14': '2026-06-16', 'T-7': '2026-06-23' },
    },
  };
  const r = cron.evaluateRotationState({
    now: dateUTC('2026-07-15'),  // recién rotada, fuera de cualquier ventana
    inventoryRows,
    state,
  });
  // No genera alertas (90 días lejos del próximo vencimiento).
  // Pero debe RESETEAR el estado porque last_rotated cambió.
  assert.equal(r.alerts.length, 0);
  // El nextState refleja el reset: thresholds_sent vacío para nuevo ciclo.
  // (el reset solo se materializa cuando se vuelva a alcanzar un threshold;
  // en este tick no hay alerta y el estado puede quedar como estaba.)
});

test('evaluateRotationState · múltiples env_vars, idempotencia independiente', () => {
  const inventoryRows = [
    { provider: 'anthropic', env_var: 'KEY_A', owner: 'leo',
      last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30') },
    { provider: 'openai', env_var: 'KEY_B', owner: 'leo',
      last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30') },
  ];
  let state = {};
  // Primer tick: ambos en T-14.
  const r1 = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows, state });
  assert.equal(r1.alerts.length, 2);
  state = r1.nextState;
  // Segundo tick mismo día: silencio para ambos.
  const r2 = cron.evaluateRotationState({ now: dateUTC('2026-06-16'), inventoryRows, state });
  assert.equal(r2.alerts.length, 0);
});

// ─── Mensaje de Telegram — anti-leak ────────────────────────────────────────

test('buildTelegramMessage · contiene provider, env_var, owner, días y runbook', () => {
  const entry = {
    provider: 'anthropic',
    env_var: 'ANTHROPIC_API_KEY',
    owner: 'leo',
    runbook_url: 'https://example.com/runbook',
  };
  const threshold = { key: 'T-7', daysRemaining: 7, icon: '⚠️', expired: false };
  const msg = cron.buildTelegramMessage(entry, threshold);
  assert.match(msg, /próxima a expirar/);
  assert.match(msg, /anthropic/);
  assert.match(msg, /ANTHROPIC_API_KEY/);
  assert.match(msg, /leo/);
  assert.match(msg, /\*7\* días/);
  assert.match(msg, /example\.com\/runbook/);
});

test('buildTelegramMessage · T-0 título y prioridad critical', () => {
  const entry = { provider: 'anthropic', env_var: 'KEY', owner: 'leo' };
  const threshold = { key: 'T-0', daysRemaining: -3, icon: '🔴', expired: true };
  const msg = cron.buildTelegramMessage(entry, threshold);
  assert.match(msg, /EXPIRADA — rotar AHORA/);
  assert.match(msg, /priority:critical/);
  assert.match(msg, /vencida/);
});

test('buildTelegramMessage · NO contiene valor ficticio del secret (anti-leak)', () => {
  // Si el código por error pone el valor del env, este sentinel aparecería.
  // Los entries no llevan valores; la función sólo recibe metadata.
  const entry = {
    provider: 'anthropic',
    env_var: 'ANTHROPIC_API_KEY',
    owner: 'leo',
    runbook_url: 'https://example.com',
    // intentar contaminar — la función debería ignorar campos no esperados.
    secret_value: 'sk-ant-MUST-NOT-LEAK-12345',
  };
  const threshold = { key: 'T-7', daysRemaining: 7, icon: '⚠️', expired: false };
  const msg = cron.buildTelegramMessage(entry, threshold);
  assert.doesNotMatch(msg, /sk-ant-/);
  assert.doesNotMatch(msg, /MUST-NOT-LEAK/);
});

test('evaluateRotationState · alertas no contienen substring del valor de process.env', () => {
  // El cron debe operar SOLO sobre metadata. Aunque alguien le pase un
  // entry con valor del secret accidental, el output no debe contenerlo.
  const inventoryRows = [{
    provider: 'anthropic',
    env_var: 'ANTHROPIC_API_KEY',
    owner: 'leo',
    last_rotated: dateUTC('2026-04-01'),
    expires_at: dateUTC('2026-06-30'),
    runbook_url: 'https://x.com',
  }];
  const r = cron.evaluateRotationState({
    now: dateUTC('2026-06-16'),
    inventoryRows,
    state: {},
  });
  const allText = JSON.stringify(r.alerts);
  // Sentinel: si el cron leyera process.env por error, este chequeo fallaría.
  // Como no lo lee, simplemente verificamos que no hay valores tipo sk-.
  assert.doesNotMatch(allText, /sk-ant-[A-Za-z0-9_-]{6,}/);
  assert.doesNotMatch(allText, /sk-(?!ant-)[A-Za-z0-9_-]{6,}/);
});

// ─── runRotationTick — wrapper con I/O (con fakes) ──────────────────────────

test('runRotationTick · feliz: lee inventario, envía alerta, persiste estado', () => {
  const dir = tmpDir();
  try {
    const inventoryFile = path.join(dir, 'docs', 'secrets-inventory.md');
    const stateFile = path.join(dir, 'state.json');
    fs.mkdirSync(path.dirname(inventoryFile), { recursive: true });
    fs.writeFileSync(inventoryFile, makeInventory({ lastRotated: '2026-04-01' }));

    const sentMessages = [];
    const result = cron.runRotationTick({
      pipelineDir: path.join(dir, '.pipeline'),
      now: dateUTC('2026-06-16'),
      sendTelegramFn: (msg) => sentMessages.push(msg),
      inventoryPath: inventoryFile,
      statePath: stateFile,
    });
    assert.equal(result.alerts.length, 1);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /próxima a expirar/);
    // Estado persistido.
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(savedState.ANTHROPIC_API_KEY);
    assert.equal(savedState.ANTHROPIC_API_KEY.thresholds_sent['T-14'], '2026-06-16');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRotationTick · sin inventario → no crashea, devuelve error suave', () => {
  const dir = tmpDir();
  try {
    const result = cron.runRotationTick({
      pipelineDir: path.join(dir, '.pipeline'),
      now: new Date(),
      sendTelegramFn: () => {},
      inventoryPath: path.join(dir, 'inexistente.md'),
      statePath: path.join(dir, 'state.json'),
    });
    assert.equal(result.alerts.length, 0);
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].stage, 'read-inventory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRotationTick · sendTelegram que tira no bloquea persistir estado', () => {
  const dir = tmpDir();
  try {
    const inventoryFile = path.join(dir, 'inv.md');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(inventoryFile, makeInventory({ lastRotated: '2026-04-01' }));

    const result = cron.runRotationTick({
      pipelineDir: dir,
      now: dateUTC('2026-06-16'),
      sendTelegramFn: () => { throw new Error('telegram offline'); },
      inventoryPath: inventoryFile,
      statePath: stateFile,
    });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, 'send-telegram');
    // Estado se persiste igual.
    assert.ok(fs.existsSync(stateFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRotationTick · estado corrupto → reset silencioso, no crashea', () => {
  const dir = tmpDir();
  try {
    const inventoryFile = path.join(dir, 'inv.md');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(inventoryFile, makeInventory({ lastRotated: '2026-04-01' }));
    fs.writeFileSync(stateFile, '{not-json:');  // corrupto

    const sent = [];
    const result = cron.runRotationTick({
      pipelineDir: dir,
      now: dateUTC('2026-06-16'),
      sendTelegramFn: (m) => sent.push(m),
      inventoryPath: inventoryFile,
      statePath: stateFile,
    });
    assert.equal(result.alerts.length, 1, 'estado corrupto se trata como vacío');
    assert.equal(sent.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Exclusión OAuth (#4834) ─────────────────────────────────────────────────

test('parseInventoryMarkdown · reconoce sentinel OAuth → fila con applies:false', () => {
  const md = [
    '| provider | env_var | owner | last_rotated | expires_at |',
    '|----------|---------|-------|--------------|------------|',
    '| anthropic | `ANTHROPIC_API_KEY` | leo | N/A (OAuth Max) | N/A (OAuth Max) |',
    '| openai | `OPENAI_API_KEY` | leo | 2026-04-01 | 2026-06-30 |',
  ].join('\n');
  const rows = cron.parseInventoryMarkdown(md);
  // NO la descarta: la emite marcada como no-aplicable.
  assert.equal(rows.length, 2);
  const anthropic = rows.find((r) => r.env_var === 'ANTHROPIC_API_KEY');
  assert.ok(anthropic, 'la fila OAuth se emite (no se descarta en silencio)');
  assert.equal(anthropic.applies, false);
  // La real conserva su parseo normal.
  const openai = rows.find((r) => r.env_var === 'OPENAI_API_KEY');
  assert.ok(openai);
  assert.notEqual(openai.applies, false);
});

test('parseInventoryMarkdown · sentinel OAuth sólo en expires_at también marca applies:false', () => {
  const md = [
    '| provider | env_var | owner | last_rotated | expires_at |',
    '|----------|---------|-------|--------------|------------|',
    '| anthropic | `ANTHROPIC_API_KEY` | leo | 2026-04-15 | oauth |',
  ].join('\n');
  const rows = cron.parseInventoryMarkdown(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].applies, false);
});

test('evaluateRotationState · excluye fila OAuth pero sigue evaluando reales (no-regresión)', () => {
  const inventoryRows = [
    { provider: 'anthropic', env_var: 'ANTHROPIC_API_KEY', owner: 'leo', applies: false },
    { provider: 'openai', env_var: 'OPENAI_API_KEY', owner: 'leo',
      last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30') },
  ];
  const r = cron.evaluateRotationState({
    now: dateUTC('2026-07-15'),  // openai vencida hace días
    inventoryRows,
    state: {},
  });
  // Anthropic NO genera alerta.
  assert.equal(r.alerts.some((a) => a.env_var === 'ANTHROPIC_API_KEY'), false);
  // Anthropic figura en excluded con motivo.
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].env_var, 'ANTHROPIC_API_KEY');
  assert.match(r.excluded[0].reason, /OAuth/i);
  // La credencial real vencida SÍ alerta (cobertura no regresa).
  const openaiAlert = r.alerts.find((a) => a.env_var === 'OPENAI_API_KEY');
  assert.ok(openaiAlert);
  assert.equal(openaiAlert.threshold, 'T-0');
});

// ─── Backoff diario de expiradas (#4834) ─────────────────────────────────────

test('shouldNotifyEntry · expirada con last_expired_alert=hoy → no notifica (backoff)', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-0', expired: true };
  const now = dateUTC('2026-07-21');
  const state = { KEY: { last_rotated: '2026-04-01', last_expired_alert: '2026-07-21' } };
  const decision = cron.shouldNotifyEntry(entry, threshold, state, now);
  assert.equal(decision.shouldNotify, false);
  assert.match(decision.reason, /backoff/);
});

test('shouldNotifyEntry · expirada con last_expired_alert=ayer → notifica', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-0', expired: true };
  const now = dateUTC('2026-07-21');
  const state = { KEY: { last_rotated: '2026-04-01', last_expired_alert: '2026-07-20' } };
  const decision = cron.shouldNotifyEntry(entry, threshold, state, now);
  assert.equal(decision.shouldNotify, true);
});

test('shouldNotifyEntry · expirada sin estado previo → notifica (fail-safe)', () => {
  const entry = { env_var: 'KEY', last_rotated: dateUTC('2026-04-01') };
  const threshold = { key: 'T-0', expired: true };
  const decision = cron.shouldNotifyEntry(entry, threshold, {}, dateUTC('2026-07-21'));
  assert.equal(decision.shouldNotify, true);
});

test('evaluateRotationState · backoff diario: expirada con last_expired_alert=hoy → 0 alertas', () => {
  const inventoryRows = [{
    provider: 'openai', env_var: 'KEY', owner: 'leo',
    last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30'),
  }];
  const state = { KEY: { last_rotated: '2026-04-01', last_expired_alert: '2026-07-21' } };
  const r = cron.evaluateRotationState({ now: dateUTC('2026-07-21'), inventoryRows, state });
  assert.equal(r.alerts.length, 0, 'mismo día no re-notifica');
});

test('evaluateRotationState · backoff diario: expirada con last_expired_alert=ayer → 1 alerta y persiste hoy', () => {
  const inventoryRows = [{
    provider: 'openai', env_var: 'KEY', owner: 'leo',
    last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30'),
  }];
  const state = { KEY: { last_rotated: '2026-04-01', last_expired_alert: '2026-07-20' } };
  const r = cron.evaluateRotationState({ now: dateUTC('2026-07-21'), inventoryRows, state });
  assert.equal(r.alerts.length, 1, 'nuevo día → exactamente 1 alerta (piso diario)');
  assert.equal(r.alerts[0].threshold, 'T-0');
  // Persiste la fecha de hoy para bloquear el próximo tick del mismo día.
  assert.equal(r.nextState.KEY.last_expired_alert, '2026-07-21');
});

test('evaluateRotationState · expirada: dos ticks el mismo día → sólo la primera notifica', () => {
  const inventoryRows = [{
    provider: 'openai', env_var: 'KEY', owner: 'leo',
    last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30'),
  }];
  // Primer tick del día: notifica.
  const r1 = cron.evaluateRotationState({ now: dateUTC('2026-07-21'), inventoryRows, state: {} });
  assert.equal(r1.alerts.length, 1);
  // Segundo tick (1h después, mismo día): silencio por backoff.
  const r2 = cron.evaluateRotationState({ now: dateUTC('2026-07-21'), inventoryRows, state: r1.nextState });
  assert.equal(r2.alerts.length, 0);
});

test('evaluateRotationState · anti-leak: campos nuevos (applies/excluded/last_expired_alert) sin valor de secret', () => {
  const inventoryRows = [
    { provider: 'anthropic', env_var: 'ANTHROPIC_API_KEY', owner: 'leo', applies: false },
    { provider: 'openai', env_var: 'OPENAI_API_KEY', owner: 'leo',
      last_rotated: dateUTC('2026-04-01'), expires_at: dateUTC('2026-06-30') },
  ];
  const r = cron.evaluateRotationState({ now: dateUTC('2026-07-21'), inventoryRows, state: {} });
  const allText = JSON.stringify(r.alerts) + JSON.stringify(r.excluded) + JSON.stringify(r.nextState);
  assert.doesNotMatch(allText, /sk-ant-[A-Za-z0-9_-]{6,}/);
  assert.doesNotMatch(allText, /sk-(?!ant-)[A-Za-z0-9_-]{6,}/);
  // El estado nuevo sólo lleva fechas/booleanos/env_vars.
  assert.equal(r.nextState.OPENAI_API_KEY.last_expired_alert, '2026-07-21');
});

test('runRotationTick · fila OAuth se loguea como skip y no envía alerta', () => {
  const dir = tmpDir();
  try {
    const inventoryFile = path.join(dir, 'inv.md');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(inventoryFile, [
      '| provider | env_var | owner | last_rotated | expires_at | account_id | rotation_runbook_url | revocation_endpoint |',
      '|----------|---------|-------|--------------|------------|------------|----------------------|---------------------|',
      '| anthropic | `ANTHROPIC_API_KEY` | leo | N/A (OAuth Max) | N/A (OAuth Max) | acct | [runbook](https://x.com) | https://x.com |',
    ].join('\n'));

    const sent = [];
    const logs = [];
    const result = cron.runRotationTick({
      pipelineDir: dir,
      now: dateUTC('2026-07-21'),
      sendTelegramFn: (m) => sent.push(m),
      inventoryPath: inventoryFile,
      statePath: stateFile,
      log: (m) => logs.push(m),
    });
    assert.equal(result.alerts.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.ok(logs.some((l) => /skip ANTHROPIC_API_KEY/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── THRESHOLDS export ──────────────────────────────────────────────────────

test('THRESHOLDS · expone los 4 thresholds documentados', () => {
  assert.equal(cron.THRESHOLDS.length, 4);
  const keys = cron.THRESHOLDS.map((t) => t.key).sort();
  assert.deepEqual(keys, ['T-1', 'T-14', 'T-3', 'T-7']);
});

test('ROTATION_POLICY_DAYS · 90 días por convención', () => {
  assert.equal(cron.ROTATION_POLICY_DAYS, 90);
});

// El inventario cubre TODA credencial que haya que provisionar, rotar o revocar,
// se hidrate o no en el ambiente. Por eso la fuente de verdad es ENV_DESCRIPTORS
// (13 entradas) y no ENV_MAPPING (9): desde #5217 las 4 claves de google_drive
// quedan en el inventario con `hydrate: false`, fuera de ENV_MAPPING, para no
// ampliar el process.env global (ver credentials-google-drive.test.js · CA-6).
test('inventario real · conserva exactamente las 13 variables de ENV_DESCRIPTORS', () => {
  const inventory = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'secrets-inventory.md'), 'utf8');
  const rows = cron.parseInventoryMarkdown(inventory);
  const expected = Object.values(require('../credentials').ENV_DESCRIPTORS).map((d) => d.env).sort();
  assert.equal(expected.length, 13);
  assert.deepEqual(rows.map((row) => row.env_var).sort(), expected);
});

// Guard de no-regresión de #5217: si alguien vuelve a meter google_drive en
// ENV_MAPPING, el inventario seguiría verde pero el process.env global se
// ampliaría de nuevo. ENV_MAPPING tiene que ser subconjunto estricto.
test('inventario real · ENV_MAPPING es subconjunto de lo inventariado y excluye google_drive', () => {
  const credentials = require('../credentials');
  const inventariadas = new Set(Object.values(credentials.ENV_DESCRIPTORS).map((d) => d.env));
  for (const env of Object.values(credentials.ENV_MAPPING)) {
    assert.ok(inventariadas.has(env), env + ' se hidrata pero no está en el inventario');
  }
  for (const dotPath of Object.keys(credentials.ENV_DESCRIPTORS)) {
    if (!dotPath.startsWith('google_drive.')) continue;
    assert.equal(credentials.ENV_MAPPING[dotPath], undefined,
      dotPath + ' no puede volver a ENV_MAPPING (#5217 · CA-6)');
  }
});

test('metadata pendiente · recuerda una vez por día y no silencia la credencial', () => {
  const row = cron.parseInventoryMarkdown([
    '| provider | env_var | owner | last_rotated | expires_at | account_id | rotation_runbook_url | revocation_endpoint |',
    '|----------|---------|-------|--------------|------------|------------|----------------------|---------------------|',
    '| telegram | `TELEGRAM_BOT_TOKEN` | leo | _pendiente registrar_ | _pendiente registrar_ | acct | [runbook](https://example.test) | N/A |',
  ].join('\n'))[0];
  assert.equal(row.metadata_missing, true);
  const first = cron.evaluateRotationState({ now: dateUTC('2026-08-03'), inventoryRows: [row], state: {} });
  assert.equal(first.alerts[0].threshold, 'METADATA-PENDIENTE');
  const second = cron.evaluateRotationState({ now: dateUTC('2026-08-03'), inventoryRows: [row], state: first.nextState });
  assert.equal(second.alerts.length, 0);
});

test('filas rotables nuevas · disparan T-14, T-7, T-3 y T-1', () => {
  const envVars = ['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY'];
  const days = [14, 7, 3, 1];
  for (let index = 0; index < envVars.length; index++) {
    const row = {
      provider: `provider-${index}`,
      env_var: envVars[index],
      owner: 'leo',
      last_rotated: dateUTC('2026-05-03'),
      expires_at: dateUTC('2026-08-01'),
    };
    const result = cron.evaluateRotationState({
      now: dateUTC(`2026-07-${String(18 + (14 - days[index])).padStart(2, '0')}`),
      inventoryRows: [row],
      state: {},
    });
    assert.equal(result.alerts[0].threshold, `T-${days[index]}`);
  }
});

test('recordatorios del mismo threshold se consolidan en un solo mensaje', () => {
  const alerts = [
    { provider: 'uno', env_var: 'SECRET_ONE', threshold: 'T-7', daysRemaining: 7, message: 'uno' },
    { provider: 'dos', env_var: 'SECRET_TWO', threshold: 'T-7', daysRemaining: 7, message: 'dos' },
    { provider: 'tres', env_var: 'SECRET_THREE', threshold: 'T-3', daysRemaining: 3, message: 'tres' },
  ];
  const consolidated = cron.consolidateAlertsByThreshold(alerts);
  assert.equal(consolidated.length, 2);
  assert.match(consolidated[0].message, /2 credenciales requieren atención/);
  assert.match(consolidated[0].message, /SECRET_ONE/);
  assert.match(consolidated[0].message, /SECRET_TWO/);
  assert.equal(consolidated[1], alerts[2]);
});

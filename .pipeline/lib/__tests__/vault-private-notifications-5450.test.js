'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { notifyTelegram, _internal } = require('../notify-telegram');
const burst = require('../telegram-burst-grouper');
const { createVaultShadowMetrics, VIA, ESTADO } = require('../vault-shadow-metrics');
const { resolvePrivateDestination } = require('../../servicio-telegram');

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value == null) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (previous == null) delete process.env[name]; else process.env[name] = previous;
  }
}

test('chat privado acepta exclusivamente el ancla canónica autorizada', () => {
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-12345', () => {
    assert.deepEqual(_internal.resolvePrivateChatId('-12345'), { ok: true, chatId: '-12345' });
    for (const value of ['12345', '-12345x', ' -12345', '01', '9007199254740992']) {
      assert.equal(_internal.resolvePrivateChatId(value).reason, 'unauthorized_chat_id');
    }
  });
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', null, () => {
    assert.equal(_internal.resolvePrivateChatId('-12345').reason, 'no_operator_chat_id');
  });
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', 'abc', () => {
    assert.equal(_internal.resolvePrivateChatId('-12345').reason, 'invalid_operator_chat_id');
  });
});

test('consumidor aplica la misma allowlist y nunca deriva al grupo', () => {
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-12345', () => {
    assert.deepEqual(resolvePrivateDestination('-12345'), { ok: true, chatId: '-12345' });
    assert.equal(resolvePrivateDestination('-99999').reason, 'unauthorized_chat_id');
    assert.equal(resolvePrivateDestination('-12345x').reason, 'unauthorized_chat_id');
    assert.deepEqual(resolvePrivateDestination(undefined), { ok: true, chatId: null });
  });
});

test('drop privado se redacta antes de persistir y usa permisos restrictivos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-private-'));
  const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const result = notifyTelegram({
      chat_id: '-777', component: canary, message: canary, diag: canary,
      action: canary, detail: canary, context: { canary }, holder: { pid: canary, hostname: canary, startTime: canary },
    });
    assert.equal(result.ok, true);
    const raw = fs.readFileSync(result.dropPath, 'utf8');
    assert.equal(raw.includes(canary), false);
    assert.equal(JSON.parse(raw).chat_id, '-777');
    if (process.platform !== 'win32') assert.equal(fs.statSync(result.dropPath).mode & 0o777, 0o600);
  }));
});

test('context redacta valores de baja entropía bajo claves sensibles antes de persistir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-private-low-entropy-'));
  const canary = 'clave-corta-5450';
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const result = notifyTelegram({
      chat_id: '-777', component: 'vault-shadow', message: 'evento',
      context: { nested: { password: canary, token: canary, api_key: canary } },
    });
    assert.equal(result.ok, true);
    const raw = fs.readFileSync(result.dropPath, 'utf8');
    assert.equal(raw.includes(canary), false);
  }));
});

// Regresión #5450 rev-2: el secreto colgado DIRECTO de una clave sensible de
// primer nivel se persistía en texto plano — `redactObject` sólo consultaba la
// tabla de claves al iterar entradas de objeto, y un string suelto caía a la
// redacción por patrón/entropía, ciega ante un valor corto.
test('context redacta claves sensibles de PRIMER NIVEL antes de persistir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-private-top-level-'));
  const canary = 'clave-corta-5450';
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const result = notifyTelegram({
      chat_id: '-777', component: 'vault-shadow', message: 'evento',
      context: { password: canary, token: canary, api_key: canary, apiKey: canary, secret: canary },
    });
    assert.equal(result.ok, true);
    const raw = fs.readFileSync(result.dropPath, 'utf8');
    assert.equal(raw.includes(canary), false, 'el canario de primer nivel no debe persistir en el dropfile');
    // #5400 / SEC-1 — el dropfile sale con el texto ESCAPADO para Markdown
    // legacy, así que el marcador viaja como `\[REDACTED]`: `[` es metacarácter
    // y sin escapar Telegram responde `400 can't parse entities`, el servicio
    // reintenta con el mismo `parse_mode` y la notificación muere en `fallido/`
    // (o sea: el aviso de secreto redactado no llegaría). Telegram renderiza
    // `\[` como `[`, con lo cual el operador sigue leyendo `[REDACTED]`.
    // La aserción de seguridad de este test es la de arriba (el canario NO
    // persiste) y queda intacta; acá sólo se acepta el marcador en su forma
    // escapada o cruda.
    assert.match(JSON.parse(raw).text, /password: \\?\[REDACTED\]/);
  }));
});

// Regresión #5450 rev-2: el camino histórico SIN `chat_id` va al chat GRUPAL,
// así que un secreto sin redactar ahí tiene una audiencia todavía más amplia.
test('camino sin chat_id (destino grupal) también redacta claves sensibles de primer nivel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-group-top-level-'));
  const canary = 'clave-corta-5450';
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', null, () => {
    const result = notifyTelegram({
      component: 'vault-shadow', message: 'evento grupal',
      context: { password: canary }, holder: { pid: 1234, hostname: 'host-1' },
    });
    assert.equal(result.ok, true);
    const drop = JSON.parse(fs.readFileSync(result.dropPath, 'utf8'));
    assert.equal(drop.chat_id, undefined, 'sin chat_id el drop va al grupo');
    assert.equal(fs.readFileSync(result.dropPath, 'utf8').includes(canary), false);
  }));
});

test('holder pasa por el motor de claves sensibles y conserva los campos benignos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-holder-'));
  const canary = 'clave-corta-5450';
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const result = notifyTelegram({
      chat_id: '-777', component: 'vault-shadow', message: 'evento',
      holder: { pid: 4321, hostname: 'host-1', token: canary },
      context: { via: 'env', intentos: 3 },
    });
    const text = JSON.parse(fs.readFileSync(result.dropPath, 'utf8')).text;
    assert.equal(text.includes(canary), false);
    // Retrocompatibilidad: lo no sensible se sigue mostrando tal cual.
    assert.match(text, /holder: pid=4321 host=host-1/);
    assert.match(text, /via: env/);
    assert.match(text, /intentos: 3/);
  }));
});

test('sin ancla no crea drop ni degrada al destino grupal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-private-'));
  withEnv('PIPELINE_DIR_OVERRIDE', dir, () => withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', null, () => {
    const result = notifyTelegram({ chat_id: '-777', component: 'vault-shadow', message: 'evento' });
    assert.equal(result.reason, 'no_operator_chat_id');
    assert.equal(fs.existsSync(path.join(dir, 'servicios', 'telegram', 'pendiente')), false);
  }));
});

test('drops privados quedan fuera del agrupamiento burst', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-burst-'));
  const entries = [];
  for (let i = 0; i < 2; i++) {
    const name = `private-${i}.json`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, JSON.stringify({ text: 'x', chat_id: '-777', meta: { pid: 1, skill: 'vault', issue: 5450 } }));
    entries.push({ name, path: filePath });
  }
  const groups = burst.groupByBurst({ fileEntries: entries, windowMs: 60_000 });
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.files.length === 1));
});

test('fallback avisa una vez por nombre y nunca incluye el valor', () => {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-notify-'));
  const sent = [];
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const metrics = createVaultShadowMetrics({ auditDir, now: () => Date.parse('2026-08-03T12:00:00Z'), notify: (p) => { sent.push(p); return { ok: true }; }, autoFlushOnExit: false });
    const descriptors = { 'providers.openai.api_key': { env: 'OPENAI_API_KEY' } };
    metrics.record({ OPENAI_API_KEY: VIA.FILE_BOOTSTRAP }, { descriptors, hostId: 'host-a' });
    metrics.record({ OPENAI_API_KEY: VIA.FILE_BOOTSTRAP }, { descriptors, hostId: 'host-a' });
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /providers\.openai\.api_key/);
  assert.equal(JSON.stringify(sent).includes('OPENAI_API_KEY'), false);
});

test('fallback reintenta si el primer encolado falla', () => {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-notify-retry-'));
  let attempts = 0;
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const metrics = createVaultShadowMetrics({ auditDir, notify: () => ({ ok: ++attempts > 1, reason: 'write_failed' }), autoFlushOnExit: false });
    const descriptors = { 'providers.openai.api_key': { env: 'OPENAI_API_KEY' } };
    metrics.record({ OPENAI_API_KEY: VIA.FILE_BOOTSTRAP }, { descriptors, hostId: 'host-a' });
    metrics.record({ OPENAI_API_KEY: VIA.FILE_BOOTSTRAP }, { descriptors, hostId: 'host-a' });
  });
  assert.equal(attempts, 2);
});

test('cumplimiento avisa una vez por ciclo persistido', () => {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-compliance-'));
  const now = Date.parse('2026-08-03T12:00:00Z');
  fs.writeFileSync(path.join(auditDir, 'vault-resolution.t0.json'), JSON.stringify({ t0: new Date(now - 2 * 3600_000).toISOString() }));
  fs.writeFileSync(path.join(auditDir, 'vault-resolution.jsonl'), JSON.stringify({
    ts: new Date(now - 1000).toISOString(), name: 'telegram.bot_token', host: 'host-a', via: 'vault', count: 1,
    first_ts: new Date(now - 1000).toISOString(), last_ts: new Date(now - 1000).toISOString(),
  }) + '\n');
  const sent = [];
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const metrics = createVaultShadowMetrics({ auditDir, now: () => now, notify: (p) => { sent.push(p); return { ok: true }; }, autoFlushOnExit: false });
    const params = { descriptors: { 'telegram.bot_token': { env: 'TELEGRAM_BOT_TOKEN' } }, hostsActivos: ['host-a'], durationHours: 1 };
    assert.equal(metrics.evaluate(params).estado, ESTADO.CUMPLE);
    assert.equal(metrics.evaluate(params).estado, ESTADO.CUMPLE);
  });
  assert.equal(sent.length, 1);
});

test('cumplimiento reintenta si el primer encolado falla', () => {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-compliance-retry-'));
  const now = Date.parse('2026-08-03T12:00:00Z');
  fs.writeFileSync(path.join(auditDir, 'vault-resolution.t0.json'), JSON.stringify({ t0: new Date(now - 2 * 3600_000).toISOString() }));
  fs.writeFileSync(path.join(auditDir, 'vault-resolution.jsonl'), JSON.stringify({
    ts: new Date(now - 1000).toISOString(), name: 'telegram.bot_token', host: 'host-a', via: 'vault', count: 1,
    first_ts: new Date(now - 1000).toISOString(), last_ts: new Date(now - 1000).toISOString(),
  }) + '\n');
  let attempts = 0;
  withEnv('TELEGRAM_LEO_OPERATOR_CHAT_ID', '-777', () => {
    const metrics = createVaultShadowMetrics({ auditDir, now: () => now, notify: () => ({ ok: ++attempts > 1, reason: 'write_failed' }), autoFlushOnExit: false });
    const params = { descriptors: { 'telegram.bot_token': { env: 'TELEGRAM_BOT_TOKEN' } }, hostsActivos: ['host-a'], durationHours: 1 };
    metrics.evaluate(params);
    metrics.evaluate(params);
  });
  assert.equal(attempts, 2);
});

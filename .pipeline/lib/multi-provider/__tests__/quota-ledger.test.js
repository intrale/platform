// =============================================================================
// quota-ledger.test.js — Serie temporal de cuota persistida (#6560). Runner:
//   node --test .pipeline/lib/multi-provider/__tests__/quota-ledger.test.js
//
// Cubre: append-only con whitelist de campos, debounce (sólo cambio de valor o
// intervalo mínimo), detección de reinicio de ventana (reposición y crédito
// #7185, CA-7), ingesta desde el shape de `quotaSlice`, snapshot de series con
// debounce horario, lectura por cola acotada y lectores whitelist de las
// fuentes externas (detector, health, schedule, créditos).
//
// Dir temporal por archivo de test, borrado en `after` (#7210: nada queda en
// %TEMP%).
// =============================================================================
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../quota-ledger');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-6560-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } });

let n = 0;
function freshDir() {
  const d = path.join(ROOT, `case-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function lines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

const T = Date.parse('2026-09-21T16:00:00Z');
const MIN = 60000;

test('recordSample escribe una línea append-only con EXACTAMENTE los campos whitelist y ts ISO UTC', () => {
  const dir = freshDir();
  const rec = ledger.recordSample({ provider: 'claude', bucket: 'weekly', pct: 19, reset_at: '2026-09-28T00:00:00Z', confidence: 'fresh', source: 'quota-slice', extra: 'NO' }, { pipelineDir: dir, now: T });
  assert.ok(rec);
  const rows = lines(ledger.ledgerPath({ pipelineDir: dir }));
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(Object.keys(rows[0]), ['ts', 'provider', 'bucket', 'pct', 'reset_at', 'confidence', 'source', 'window_reset', 'reset_motivo']);
  assert.strictEqual(rows[0].provider, 'anthropic', 'alias normalizado');
  assert.strictEqual(rows[0].ts, new Date(T).toISOString());
  assert.strictEqual(rows[0].window_reset, false);
  assert.strictEqual(rows[0].extra, undefined);
});

test('debounce: mismo valor dentro del intervalo mínimo no se escribe; cambio de valor sí; intervalo vencido sí', () => {
  const dir = freshDir();
  const o = (now) => ({ pipelineDir: dir, now, minIntervalMs: 15 * MIN });
  const s = { provider: 'anthropic', bucket: 'weekly', pct: 20, confidence: 'fresh' };
  assert.ok(ledger.recordSample(s, o(T)));
  assert.strictEqual(ledger.recordSample(s, o(T + 1 * MIN)), null, 'mismo valor, 1 min después: debounce');
  assert.ok(ledger.recordSample({ ...s, pct: 21 }, o(T + 2 * MIN)), 'cambió el valor');
  assert.strictEqual(ledger.recordSample({ ...s, pct: 21 }, o(T + 10 * MIN)), null);
  assert.ok(ledger.recordSample({ ...s, pct: 21 }, o(T + 18 * MIN)), 'venció el intervalo mínimo');
  assert.strictEqual(ledger.recordSample({ ...s, pct: 21 }, o(T + 17 * MIN)), null, 'reloj hacia atrás: no se escribe');
  assert.strictEqual(lines(ledger.ledgerPath({ pipelineDir: dir })).length, 3);
});

test('CA-7: una caída del % marca window_reset con motivo reposicion y se escribe aunque no venció el intervalo', () => {
  const dir = freshDir();
  const o = (now) => ({ pipelineDir: dir, now });
  ledger.recordSample({ provider: 'openai-codex', bucket: 'weekly', pct: 96, reset_at: new Date(T + 60 * MIN).toISOString(), confidence: 'fresh' }, o(T));
  const rec = ledger.recordSample({ provider: 'openai-codex', bucket: 'weekly', pct: 1, reset_at: new Date(T + 60 * MIN + 7 * 24 * 60 * MIN).toISOString(), confidence: 'fresh' }, o(T + 1 * MIN));
  assert.ok(rec);
  assert.strictEqual(rec.window_reset, true);
  assert.strictEqual(rec.reset_motivo, 'reposicion');
  // Una caída de 1 pt es redondeo, no reinicio.
  const noise = ledger.recordSample({ provider: 'openai-codex', bucket: 'weekly', pct: 0.5, reset_at: rec.reset_at, confidence: 'fresh' }, o(T + 2 * MIN));
  assert.strictEqual(noise.window_reset, false);
});

test('CA-7: un canje de crédito de codex (#7185) a ±15 min explica el reinicio con motivo credito', () => {
  const dir = freshDir();
  const credits = [{ provider: 'openai-codex', redeemed_at: new Date(T + 3 * MIN).toISOString() }];
  ledger.recordSample({ provider: 'openai-codex', bucket: 'weekly', pct: 100, confidence: 'fresh' }, { pipelineDir: dir, now: T });
  const rec = ledger.recordSample({ provider: 'openai-codex', bucket: 'weekly', pct: 0, confidence: 'fresh' }, { pipelineDir: dir, now: T + 5 * MIN, creditRedemptions: credits });
  assert.strictEqual(rec.window_reset, true);
  assert.strictEqual(rec.reset_motivo, 'credito');
});

test('recordSamplesFromSlice ingiere weekly y session de cada proveedor con dato, lee los créditos del estado y nunca tira', () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'codex-reset-credit.json'), JSON.stringify({ redemptions: [{ redeemed_at: new Date(T).toISOString(), outcome: 'reset' }] }));
  const providers = {
    anthropic: { session: { pct: 47, confidence: 'fresh', resetAt: '2026-09-21T18:50:00.000Z' }, weekly: { pct: 19, confidence: 'fresh', resetAt: '2026-09-28T00:00:00.000Z' } },
    'openai-codex': { session: { pct: null, confidence: 'missing' }, weekly: { pct: 94, confidence: 'fresh', resetAt: null } },
    antigravity: { session: { pct: null, confidence: 'missing' }, weekly: { pct: null, confidence: 'missing' } },
    roto: null,
  };
  const written = ledger.recordSamplesFromSlice(providers, { pipelineDir: dir, now: T });
  assert.strictEqual(written, 3);
  const rows = ledger.readSamples({ pipelineDir: dir });
  assert.deepStrictEqual(rows.map(r => `${r.provider}|${r.bucket}|${r.pct}`), ['anthropic|weekly|19', 'anthropic|session|47', 'openai-codex|weekly|94']);
  // Segundo poll idéntico ⇒ 0 escrituras.
  assert.strictEqual(ledger.recordSamplesFromSlice(providers, { pipelineDir: dir, now: T + MIN }), 0);
  assert.strictEqual(ledger.recordSamplesFromSlice(undefined, { pipelineDir: dir }), 0);
  assert.deepStrictEqual(ledger.readCreditRedemptions({ pipelineDir: dir }), [{ provider: 'openai-codex', redeemed_at: new Date(T).toISOString() }]);
});

test('readSamples filtra por sinceMs y proveedores, saltea líneas corruptas y lee sólo la cola del archivo', () => {
  const dir = freshDir();
  const file = ledger.ledgerPath({ pipelineDir: dir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts = ['{corrupta'];
  for (let i = 0; i < 50; i++) parts.push(JSON.stringify({ ts: new Date(T + i * MIN).toISOString(), provider: i % 2 ? 'anthropic' : 'openai-codex', bucket: 'weekly', pct: i, confidence: 'fresh' }));
  fs.writeFileSync(file, parts.join('\n') + '\n');
  assert.strictEqual(ledger.readSamples({ pipelineDir: dir }).length, 50);
  assert.strictEqual(ledger.readSamples({ pipelineDir: dir, sinceMs: T + 40 * MIN }).length, 10);
  assert.strictEqual(ledger.readSamples({ pipelineDir: dir, providers: ['claude'] }).length, 25);
  // Cola acotada: con maxBytes chico sólo entran las últimas líneas completas.
  const tail = ledger.readSamples({ pipelineDir: dir, maxBytes: 400 });
  assert.ok(tail.length > 0 && tail.length < 10, `cola acotada: ${tail.length}`);
  assert.strictEqual(tail[tail.length - 1].pct, 49);
  assert.deepStrictEqual(ledger.readTailLines(path.join(dir, 'no-existe.jsonl')), []);
});

test('recordSeriesSnapshot persiste append-only con debounce horario y readSeriesSnapshots lo devuelve ordenado', () => {
  const dir = freshDir();
  const series = { ventana: { desde: 'a', hasta: 'b', horas: 24 }, gateado: { anthropic: { horas: { total: 1 } } }, cadena_agotada: { horas_total: 2 }, unica_pata: { horas_unica_pata: 3 }, trabajo_por_cuota: {} };
  assert.ok(ledger.recordSeriesSnapshot(series, { pipelineDir: dir, now: T }));
  assert.strictEqual(ledger.recordSeriesSnapshot(series, { pipelineDir: dir, now: T + 30 * MIN }), null, 'debounce 1 h');
  assert.ok(ledger.recordSeriesSnapshot(series, { pipelineDir: dir, now: T + 61 * MIN }));
  const snaps = ledger.readSeriesSnapshots({ pipelineDir: dir });
  assert.strictEqual(snaps.length, 2);
  assert.deepStrictEqual(Object.keys(snaps[0]), ['ts', 'schema', 'ventana', 'gateado', 'cadena_agotada', 'unica_pata', 'trabajo_por_cuota']);
  assert.strictEqual(snaps[1].ts, new Date(T + 61 * MIN).toISOString());
  assert.strictEqual(ledger.recordSeriesSnapshot(null, { pipelineDir: dir }), null);
});

test('readDetectorEvents lee los logs diarios del rango (+lookback), con whitelist y raw_excerpt truncado; readHealthEvents y readScheduleEntries idem', () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  const day = (d) => `2026-09-${String(d).padStart(2, '0')}`;
  const ev = (d, event, extra = {}) => JSON.stringify({ timestamp: `${day(d)}T10:00:00.000Z`, event, agent: 'x', provider: 'openai-codex', model: null, error_type: 'insufficient_quota', raw_excerpt: 'r'.repeat(500), flag_set: true, secreto: 'sk-NO', ...extra });
  fs.writeFileSync(path.join(dir, 'logs', `quota-detector-${day(1)}.log`), ev(1, 'flag_set') + '\n');   // fuera del lookback
  fs.writeFileSync(path.join(dir, 'logs', `quota-detector-${day(15)}.log`), ev(15, 'flag_set') + '\n'); // dentro del lookback (8 d)
  fs.writeFileSync(path.join(dir, 'logs', `quota-detector-${day(21)}.log`), ev(21, 'gate_blocked_spawn') + '\nbasura\n' + ev(21, 'futuro', { timestamp: '2026-09-21T23:00:00.000Z' }) + '\n');
  fs.writeFileSync(path.join(dir, 'logs', 'otro.log'), ev(21, 'no') + '\n');
  const evs = ledger.readDetectorEvents({ pipelineDir: dir, desde: Date.parse('2026-09-21T00:00:00Z'), hasta: T });
  assert.deepStrictEqual(evs.map(e => e.event), ['flag_set', 'gate_blocked_spawn']);
  assert.deepStrictEqual(Object.keys(evs[0]), ['timestamp', 'event', 'agent', 'provider', 'error_type', 'raw_excerpt', 'flag_set']);
  assert.strictEqual(evs[0].raw_excerpt.length, 200);

  const h = (created_at, to, type = 'health_state_transition') => JSON.stringify({ type, provider: 'anthropic', from_state: 'green', to_state: to, reason_code: 'rc', status_code: 500, created_at, hash_prev: 'x', hash_self: 'y' });
  fs.writeFileSync(path.join(dir, 'audit', 'multi-provider-health.jsonl'), [h(T - 60 * MIN, 'red'), h(T - 30 * MIN, 'green'), h(T - 10 * MIN, 'red', 'health_alert_emitted'), h(T + 60 * MIN, 'red')].join('\n') + '\n');
  const hev = ledger.readHealthEvents({ pipelineDir: dir, desde: T - 2 * 60 * MIN, hasta: T });
  assert.strictEqual(hev.length, 2, 'sólo transiciones dentro del rango');
  assert.deepStrictEqual(Object.keys(hev[0]), ['type', 'provider', 'from_state', 'to_state', 'reason_code', 'created_at']);

  fs.writeFileSync(path.join(dir, 'provider-schedule.json'), JSON.stringify({ providers: { anthropic: { active: true, schedule: { monday: [{ start: '00:00', end: '07:00' }] }, timezone: 'America/Argentina/Buenos_Aires' } } }));
  const sched = ledger.readScheduleEntries({ pipelineDir: dir });
  assert.strictEqual(sched.anthropic.active, true);
  assert.deepStrictEqual(ledger.readScheduleEntries({ pipelineDir: freshDir() }), {});
  assert.deepStrictEqual(ledger.readCreditRedemptions({ pipelineDir: freshDir() }), []);
  assert.deepStrictEqual(ledger.readCostRecords({ pipelineDir: freshDir() }), []);
});

test('el ledger degrada sin tirar cuando el dir no es escribible', () => {
  const file = path.join(ROOT, 'no-dir', 'x', 'quota-ledger.jsonl');
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.dirname(file), 'soy un archivo, no un dir');
  assert.strictEqual(ledger.recordSample({ provider: 'anthropic', bucket: 'weekly', pct: 1, confidence: 'fresh' }, { file, now: T }), null);
});

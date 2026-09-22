// =============================================================================
// quota-balance.test.js — Saldo, ritmo y proyección de agotamiento (#6560).
// Runner:
//   node --test .pipeline/lib/multi-provider/__tests__/quota-balance.test.js
//
// Cubre los dos escenarios Gherkin del issue (proyección a ritmo constante y
// período recién repuesto) y los criterios de aceptación CA-1..CA-4 y CA-7:
// excedente cuantificado, reset por reposición declarada, proveedor sin datos
// ⇒ saldo completo sin error, y crédito de codex marcado como reinicio de
// ventana (no consumo). Más los bordes que guru/UX marcaron: nunca proyectar
// sobre dato stale, mínimo de muestras, `sin_datos` distinguible de "100 %
// libre real", y estados del veredicto.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const qb = require('../quota-balance');

const H = 3600 * 1000;
const NOW = Date.parse('2026-09-21T16:00:00Z'); // lunes 13:00 ART

function configFixture() {
  return {
    multi_provider: {
      quota: {
        anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' },
        'openai-codex': { plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
        antigravity: { plan: 'Google One', periodo: 'diario', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
      },
    },
  };
}

// Serie lineal: `n` muestras cada `stepMin` terminando en `endMs`, de `from` a `to` puntos.
function linear(provider, from, to, n, stepMin, endMs, extra = {}) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push({
      ts: endMs - i * stepMin * 60000,
      provider,
      bucket: 'weekly',
      pct: to - (to - from) * (i / (n - 1)),
      confidence: 'fresh',
      ...extra,
    });
  }
  return out;
}

const ENV = { QUOTA_TZ_OFFSET_MIN: '-180' };

// --- Gherkin 1: proyección a ritmo constante ---------------------------------

test('Gherkin: con 60 % consumido y ritmo estable devuelve saldo, ritmo y momento de agotamiento', () => {
  // 7 muestras cada 10 min, de 58 a 60 pts ⇒ 2 pts/h en la última hora.
  const samples = linear('anthropic', 58, 60, 7, 10, NOW, { reset_at: '2026-09-28T00:00:00Z' });
  const r = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV });
  const a = r.providers.anthropic;
  assert.strictEqual(a.consumo, 60);
  assert.strictEqual(a.saldo_pts, 40);
  assert.strictEqual(a.excedente_pts, 0);
  assert.strictEqual(a.balance_pts, 40);
  assert.strictEqual(a.ritmo_pts_por_hora, 2);
  assert.strictEqual(a.confidence, 'fresh');
  // 40 pts / 2 pts/h = 20 h desde la última muestra (= now).
  assert.strictEqual(a.agota_at, new Date(NOW + 20 * H).toISOString());
  assert.strictEqual(a.agota_en_ms, 20 * H);
  // El cierre es dom 21:00 ART = lunes 00:00Z de la semana siguiente.
  assert.strictEqual(a.cierre_periodo_at, '2026-09-28T00:00:00.000Z');
  assert.strictEqual(a.periodo_inicio_at, '2026-09-21T00:00:00.000Z');
  assert.strictEqual(a.estado, 'se_agota_antes');
  assert.ok(a.al_cierre_pts < 0, 'a ese ritmo falta cuota al cierre');
  assert.strictEqual(a.muestras, 7);
  assert.strictEqual(a.ventana_movil_min, 60);
});

test('con ritmo 0 (consumo plano) no hay agotamiento y el estado es alcanza', () => {
  const samples = linear('anthropic', 30, 30, 5, 10, NOW);
  const a = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.anthropic;
  assert.strictEqual(a.ritmo_pts_por_hora, 0);
  assert.strictEqual(a.agota_at, null);
  assert.strictEqual(a.estado, 'alcanza');
  assert.strictEqual(a.al_cierre_pts, 70);
});

test('si a ese ritmo llega al cierre, el estado es alcanza y al_cierre_pts es lo que sobra', () => {
  // 0,1 pt/h con 90 pts de saldo ⇒ se agota en 900 h, mucho después del cierre (159 h).
  const samples = linear('anthropic', 9.9, 10, 7, 10, NOW);
  const a = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.anthropic;
  assert.strictEqual(a.estado, 'alcanza');
  assert.ok(a.al_cierre_pts > 0 && a.al_cierre_pts < 90);
  assert.ok(Date.parse(a.agota_at) > Date.parse(a.cierre_periodo_at));
});

// --- Gherkin 2: período recién repuesto -------------------------------------

test('Gherkin: proveedor que acaba de pasar su hora de reposición ⇒ consumo 0 y saldo = techo', () => {
  // Reposición dom 21:00 ART = 2026-09-21T00:00Z. "Ahora" = 00:05Z; las muestras
  // son de antes del corte (pertenecen al período anterior).
  const now = Date.parse('2026-09-21T00:05:00Z');
  const samples = linear('anthropic', 80, 95, 6, 10, now - 10 * 60000 - 60000);
  const a = qb.computeQuotaBalance(configFixture(), samples, { now, env: ENV }).providers.anthropic;
  assert.strictEqual(a.periodo_inicio_at, '2026-09-21T00:00:00.000Z');
  assert.strictEqual(a.consumo, 0);
  assert.strictEqual(a.saldo_pts, 100);
  assert.strictEqual(a.excedente_pts, 0);
  assert.strictEqual(a.estado, 'sin_datos');
  assert.strictEqual(a.confidence, 'missing');
});

// --- CA-2: excedente cuantificado --------------------------------------------

test('CA-2: consumo por encima del techo responde "por cuánto nos pasamos" con excedente ≥ 0 y saldo 0', () => {
  const samples = linear('openai-codex', 100, 112, 5, 10, NOW, { reset_at: NOW + 20 * H });
  const c = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers['openai-codex'];
  assert.strictEqual(c.estado, 'excedido');
  assert.strictEqual(c.saldo_pts, 0, 'el saldo nunca es negativo (UX §3)');
  assert.strictEqual(c.excedente_pts, 12);
  assert.strictEqual(c.balance_pts, -12, 'si cerrara ahora: −12');
  assert.strictEqual(c.agota_at, null, 'ya está agotado: no hay momento futuro');
  assert.ok(c.al_cierre_pts <= -12);
});

// --- CA-3: reset en la hora/día de reposición declarada ---------------------

test('CA-3: lastFixedResetMs respeta día/hora local de reposición para semanal, diario y horario', () => {
  const tz = { tz_offset_min: -180 };
  // semanal dom 21:00 ART: lunes 13:00 ART ⇒ domingo 20/09 21:00 ART = 21/09 00:00Z
  assert.strictEqual(new Date(qb.lastFixedResetMs({ periodo: 'semanal', reposicion: 'dom 21:00', ...tz }, NOW)).toISOString(), '2026-09-21T00:00:00.000Z');
  // domingo 20/09 20:59 ART (23:59Z) ⇒ el reset fue hace 7 días
  const sunBefore = Date.parse('2026-09-20T23:59:00Z');
  assert.strictEqual(new Date(qb.lastFixedResetMs({ periodo: 'semanal', reposicion: 'dom 21:00', ...tz }, sunBefore)).toISOString(), '2026-09-14T00:00:00.000Z');
  // diario 03:00 ART = 06:00Z: a las 05:00Z el corte fue ayer
  assert.strictEqual(new Date(qb.lastFixedResetMs({ periodo: 'diario', reposicion: '03:00', ...tz }, Date.parse('2026-09-21T05:00:00Z'))).toISOString(), '2026-09-20T06:00:00.000Z');
  assert.strictEqual(new Date(qb.lastFixedResetMs({ periodo: 'diario', reposicion: '03:00', ...tz }, Date.parse('2026-09-21T07:00:00Z'))).toISOString(), '2026-09-21T06:00:00.000Z');
  // horario :30
  assert.strictEqual(new Date(qb.lastFixedResetMs({ periodo: 'horario', reposicion: ':30', ...tz }, Date.parse('2026-09-21T16:10:00Z'))).toISOString(), '2026-09-21T15:30:00.000Z');
  // rolling ⇒ null (lo informa el proveedor)
  assert.strictEqual(qb.lastFixedResetMs({ periodo: 'semanal', reposicion: 'rolling', ...tz }, NOW), null);
});

test('CA-3: con reposicion rolling el cierre es el reset_at reportado y el inicio es cierre − período', () => {
  const resetAt = NOW + 26 * H;
  const samples = linear('openai-codex', 90, 94, 5, 10, NOW, { reset_at: resetAt });
  const c = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers['openai-codex'];
  assert.strictEqual(c.cierre_periodo_at, new Date(resetAt).toISOString());
  assert.strictEqual(c.periodo_inicio_at, new Date(resetAt - 7 * 24 * H).toISOString());
  assert.strictEqual(c.cierre_en_ms, 26 * H);
  assert.strictEqual(c.cierre_fuente, 'rolling');
});

test('CA-3: rolling sin reset_at ⇒ cierre desconocido (null) y, si se agota, estado conservador', () => {
  const samples = linear('antigravity', 50, 60, 7, 10, NOW);
  const g = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.antigravity;
  assert.strictEqual(g.cierre_periodo_at, null);
  assert.strictEqual(g.cierre_fuente, 'rolling_sin_reset');
  assert.ok(g.agota_at);
  assert.strictEqual(g.estado, 'se_agota_antes');
  assert.strictEqual(g.al_cierre_pts, null);
});

// --- CA-4: sin datos ⇒ saldo completo, no error ------------------------------

test('CA-4: proveedor sin muestras devuelve saldo completo con confidence missing y estado sin_datos (nunca "100 % libre real")', () => {
  const r = qb.computeQuotaBalance(configFixture(), [], { now: NOW, env: ENV });
  for (const id of ['anthropic', 'openai-codex', 'antigravity']) {
    const p = r.providers[id];
    assert.strictEqual(p.saldo_pts, 100, id);
    assert.strictEqual(p.consumo, 0, id);
    assert.strictEqual(p.confidence, 'missing', id);
    assert.strictEqual(p.estado, 'sin_datos', id);
    assert.strictEqual(p.ritmo_pts_por_hora, null, id);
    assert.strictEqual(p.agota_at, null, id);
  }
});

test('CA-1: todos los proveedores con techo declarado aparecen; sin techo no se inventa infinito', () => {
  const cfg = configFixture();
  delete cfg.multi_provider.quota.antigravity;
  const r = qb.computeQuotaBalance(cfg, [], { now: NOW, env: ENV });
  assert.deepStrictEqual(Object.keys(r.providers).sort(), ['anthropic', 'openai-codex']);
  assert.strictEqual(qb.computeQuotaBalance(cfg, [], { now: NOW, providers: ['antigravity'], env: ENV }).providers.antigravity, undefined);
});

// --- Honestidad: stale y mínimo de muestras ---------------------------------

test('nunca proyecta sobre dato viejo: última muestra > staleAfterMs ⇒ desactualizado, sin ritmo ni agota_at', () => {
  const samples = linear('anthropic', 58, 60, 7, 10, NOW - 45 * 60000);
  const a = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.anthropic;
  assert.strictEqual(a.confidence, 'stale');
  assert.strictEqual(a.estado, 'desactualizado');
  assert.strictEqual(a.ritmo_pts_por_hora, null);
  assert.strictEqual(a.agota_at, null);
  assert.strictEqual(a.saldo_pts, 40, 'el saldo conocido sí se informa');
  assert.strictEqual(a.muestra_at, new Date(NOW - 45 * 60000).toISOString());
});

test('con menos muestras que el mínimo en la ventana móvil no hay ritmo: estado sin_proyeccion', () => {
  const samples = linear('anthropic', 59, 60, 2, 10, NOW);
  const a = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.anthropic;
  assert.strictEqual(a.muestras, 2);
  assert.strictEqual(a.min_muestras, 3);
  assert.strictEqual(a.ritmo_pts_por_hora, null);
  assert.strictEqual(a.estado, 'sin_proyeccion');
  // Con minMuestras: 2 sí proyecta.
  const a2 = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV, minMuestras: 2 }).providers.anthropic;
  assert.strictEqual(a2.ritmo_pts_por_hora, 6);
  assert.strictEqual(a2.estado, 'se_agota_antes');
});

test('la ventana móvil sólo mira las últimas ventanaMovilMin: un ritmo viejo no contamina el actual', () => {
  // 3 h de subida rápida (0→60) y luego 1 h plana en 60.
  const fast = linear('anthropic', 0, 60, 19, 10, NOW - 60 * 60000);
  const flat = linear('anthropic', 60, 60, 6, 10, NOW).slice(1);
  const a = qb.computeQuotaBalance(configFixture(), [...fast, ...flat], { now: NOW, env: ENV }).providers.anthropic;
  assert.ok(a.ritmo_pts_por_hora < 5, `el ritmo de la última hora es casi plano, no 20 pts/h: ${a.ritmo_pts_por_hora}`);
});

// --- CA-7: reinicios de ventana y créditos de codex --------------------------

test('CA-7: una caída del % es reinicio de ventana (reposicion), no consumo negativo; el ritmo arranca después', () => {
  const before = linear('openai-codex', 90, 96, 4, 10, NOW - 60 * 60000, { reset_at: NOW - 55 * 60000 });
  const after = linear('openai-codex', 0, 3, 6, 10, NOW, { reset_at: NOW - 55 * 60000 + 7 * 24 * H });
  const c = qb.computeQuotaBalance(configFixture(), [...before, ...after], { now: NOW, env: ENV }).providers['openai-codex'];
  assert.strictEqual(c.consumo, 3);
  assert.strictEqual(c.saldo_pts, 97);
  assert.ok(c.ritmo_pts_por_hora > 0 && c.ritmo_pts_por_hora < 5, `ritmo post-reset: ${c.ritmo_pts_por_hora}`);
  assert.ok(c.ultimo_reset, 'expone el último reinicio');
  assert.strictEqual(c.ultimo_reset.motivo, 'reposicion');
  assert.strictEqual(c.ultimo_reset.at, new Date(NOW - 50 * 60000).toISOString());
  assert.strictEqual(c.periodo_inicio_at, c.ultimo_reset.at, 'el reinicio observado corre el inicio del período');
});

test('CA-7: el crédito de reset de codex (#7185) queda marcado como reinicio con motivo credito', () => {
  const before = linear('openai-codex', 100, 100, 3, 10, NOW - 30 * 60000);
  const after = linear('openai-codex', 0, 1, 3, 10, NOW);
  const redemptions = [{ provider: 'openai-codex', redeemed_at: new Date(NOW - 22 * 60000).toISOString() }];
  const c = qb.computeQuotaBalance(configFixture(), [...before, ...after], { now: NOW, env: ENV, creditRedemptions: redemptions }).providers['openai-codex'];
  assert.strictEqual(c.ultimo_reset.motivo, 'credito');
  assert.strictEqual(c.consumo, 1, 'el salto 100→0 no cuenta como consumo');
  assert.strictEqual(c.excedente_pts, 0);
  assert.notStrictEqual(c.estado, 'excedido');
});

test('markWindowResets respeta la marca que ya trae el ledger y sólo completa el motivo', () => {
  const s = qb.prepareSamples([
    { ts: NOW - 20 * 60000, provider: 'anthropic', bucket: 'weekly', pct: 40, confidence: 'fresh' },
    { ts: NOW - 10 * 60000, provider: 'anthropic', bucket: 'weekly', pct: 39.5, confidence: 'fresh', window_reset: true },
  ], {});
  assert.strictEqual(s.anthropic[1].window_reset, true);
  assert.strictEqual(s.anthropic[1].reset_motivo, 'reposicion');
  // Una caída de 0,5 pts sin marca es ruido de redondeo, no reinicio.
  const s2 = qb.prepareSamples([
    { ts: NOW - 20 * 60000, provider: 'anthropic', bucket: 'weekly', pct: 40, confidence: 'fresh' },
    { ts: NOW - 10 * 60000, provider: 'anthropic', bucket: 'weekly', pct: 39.5, confidence: 'fresh' },
  ], {});
  assert.strictEqual(s2.anthropic[1].window_reset, false);
});

// --- Unidades absolutas y forma del resultado --------------------------------

test('techo en tokens sin muestras usa provider-cost v2 como consumo (v1 no confiable se ignora)', () => {
  const cfg = { multi_provider: { quota: { anthropic: { plan: 'API', periodo: 'diario', techo: 1000, unidad: 'tokens', reposicion: '00:00' } } } };
  const cost = [
    { provider: 'anthropic', timestamp: new Date(NOW - H).toISOString(), tokens_in: 300, tokens_out: 100, reliable: true },
    { provider: 'anthropic', timestamp: null, tokens_in: 9999, tokens_out: 0, reliable: false },
    { provider: 'openai-codex', timestamp: new Date(NOW - H).toISOString(), tokens_in: 50, tokens_out: 50, reliable: true },
  ];
  const a = qb.computeQuotaBalance(cfg, [], { now: NOW, env: ENV, costRecords: cost }).providers.anthropic;
  assert.strictEqual(a.consumo, 400);
  assert.strictEqual(a.saldo_pts, 600);
  assert.strictEqual(a.consumo_pct, 40);
  assert.strictEqual(a.fuente, 'provider-cost');
});

test('el resultado trae tiempos absolutos (ISO UTC) y relativos (ms) y el vocabulario cerrado de estados', () => {
  const samples = linear('anthropic', 58, 60, 7, 10, NOW);
  const r = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV });
  assert.strictEqual(r.schema, 1);
  assert.strictEqual(r.computed_at, new Date(NOW).toISOString());
  const a = r.providers.anthropic;
  for (const k of ['agota_at', 'cierre_periodo_at', 'muestra_at', 'periodo_inicio_at']) assert.match(a[k], /Z$/, k);
  for (const k of ['agota_en_ms', 'cierre_en_ms']) assert.ok(Number.isInteger(a[k]) && a[k] >= 0, k);
  assert.ok(qb.ESTADOS.includes(a.estado));
  assert.deepStrictEqual(qb.ESTADOS, ['alcanza', 'se_agota_antes', 'excedido', 'sin_datos', 'desactualizado', 'sin_proyeccion']);
});

test('los alias de proveedor (claude/codex) en las muestras se normalizan al id canónico', () => {
  const samples = linear('claude', 10, 12, 4, 10, NOW);
  const r = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV });
  assert.strictEqual(r.providers.anthropic.consumo, 12);
});

test('muestras del bucket session no entran al balance del período (ventana larga)', () => {
  const samples = linear('anthropic', 40, 47, 4, 10, NOW).map(s => ({ ...s, bucket: 'session' }));
  const a = qb.computeQuotaBalance(configFixture(), samples, { now: NOW, env: ENV }).providers.anthropic;
  assert.strictEqual(a.estado, 'sin_datos');
});

// =============================================================================
// quota-series.test.js — Series derivadas del libro contable de cuota (#6560,
// CA-6). Runner:
//   node --test .pipeline/lib/multi-provider/__tests__/quota-series.test.js
//
// Fixtures con el shape REAL del audit del detector (`timestamp`/`event`/
// `provider`/`error_type`/`raw_excerpt`), del audit de health (`created_at` ms,
// `to_state`) y del schedule (inyectado por `isActiveAt`). El caso central es
// el que motiva la serie: 2026-09-11, codex única pata viva gateado ≈15 h de
// 26 h con anthropic apagado por schedule.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const qs = require('../quota-series');

const H = 3600 * 1000;
const T0 = Date.parse('2026-09-11T00:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();
const PROVIDERS = ['anthropic', 'openai-codex'];

function det(event, provider, hours, extra = {}) {
  return { timestamp: at(hours), event, agent: extra.agent || null, provider, model: null, error_type: extra.error_type || null, raw_excerpt: extra.raw_excerpt || null, flag_set: event === 'flag_set' };
}
function health(provider, hours, to) {
  return { type: 'health_state_transition', provider, from_state: null, to_state: to, reason_code: 'x', created_at: T0 + hours * H };
}
// Schedule OFF para anthropic entre las 20:00 y las 07:00 UTC del fixture.
const offNight = (provider, ms) => {
  if (provider !== 'anthropic') return true;
  const h = new Date(ms).getUTCHours();
  return !(h >= 20 || h < 7);
};
const SCHED = { anthropic: { active: true, schedule: {}, timezone: 'UTC' } };

// --- Serie 1: horas gateado por proveedor y motivo ---------------------------

test('Serie 1: flag_set → drained_post_reset cuenta horas de cuota por ventana según error_type', () => {
  const events = [
    det('flag_set', 'openai-codex', 2, { error_type: 'usage_limit_reached' }),
    det('drained_post_reset', 'openai-codex', 5, { error_type: 'usage_limit_reached' }),
    det('flag_set', 'openai-codex', 8, { error_type: 'insufficient_quota' }),
    det('cleared', 'openai-codex', 20),
    det('flag_set', 'anthropic', 10, { error_type: 'weekly_limit_content_channel' }),
    det('manual_clear', 'anthropic', 12),
  ];
  const g = qs.gatedByProvider({ detectorEvents: events, providers: PROVIDERS, desde: T0, hasta: T0 + 26 * H, isActiveAt: () => true });
  assert.strictEqual(g['openai-codex'].horas.quota_exhausted_sesion, 3);
  assert.strictEqual(g['openai-codex'].horas.quota_exhausted_semanal, 12);
  assert.strictEqual(g['openai-codex'].horas.total, 15);
  assert.strictEqual(g.anthropic.horas.quota_exhausted_semanal, 2);
  assert.strictEqual(g.anthropic.horas.schedule, 0);
  assert.strictEqual(g['openai-codex'].intervalos.length, 2);
  assert.strictEqual(g['openai-codex'].intervalos[0].abierto, false);
});

test('Serie 1: un gate abierto antes del rango y sin drenar se acota al rango y queda marcado abierto', () => {
  const events = [det('flag_set', 'openai-codex', -30, { error_type: 'insufficient_quota' })];
  const g = qs.gatedByProvider({ detectorEvents: events, providers: PROVIDERS, desde: T0, hasta: T0 + 26 * H, isActiveAt: () => true });
  assert.strictEqual(g['openai-codex'].horas.quota_exhausted_semanal, 26);
  assert.strictEqual(g['openai-codex'].intervalos[0].abierto, true);
  assert.strictEqual(g['openai-codex'].intervalos[0].desde, at(0));
});

test('Serie 1: error_type de credencial se clasifica como credencial; desconocido corto ⇒ sesion, largo ⇒ semanal', () => {
  const events = [
    det('flag_set', 'anthropic', 1, { error_type: 'authentication_error' }),
    det('cleared', 'anthropic', 2),
    det('flag_set', 'openai-codex', 3, { error_type: 'algo_nuevo' }),
    det('cleared', 'openai-codex', 5),
    det('flag_set', 'openai-codex', 6, { error_type: 'otro_nuevo' }),
  ];
  const g = qs.gatedByProvider({ detectorEvents: events, providers: PROVIDERS, desde: T0, hasta: T0 + 40 * H, isActiveAt: () => true });
  assert.strictEqual(g.anthropic.horas.credencial, 1);
  assert.strictEqual(g['openai-codex'].intervalos[0].motivo, 'quota_exhausted_sesion');
  assert.strictEqual(g['openai-codex'].intervalos[1].motivo, 'quota_exhausted_semanal', 'abierto y sin duración conocida ⇒ semanal (conservador)');
});

test('Serie 1: health red→green y schedule OFF suman horas por su motivo; total no duplica solapamientos', () => {
  const events = [det('flag_set', 'anthropic', 22, { error_type: 'usage_limit_error' }), det('drained_post_reset', 'anthropic', 25)];
  const hev = [health('anthropic', 3, 'red'), health('anthropic', 5, 'green'), health('openai-codex', 10, 'red')];
  const g = qs.gatedByProvider({ detectorEvents: events, healthEvents: hev, scheduleEntries: SCHED, providers: PROVIDERS, desde: T0, hasta: T0 + 26 * H, isActiveAt: offNight });
  assert.strictEqual(g.anthropic.horas.health, 2);
  assert.strictEqual(g.anthropic.horas.schedule, 7 + 6, 'OFF 00–07 y 20–02 del fixture de 26 h');
  assert.strictEqual(g.anthropic.horas.quota_exhausted_sesion, 3);
  // health 03–05 cae dentro del OFF 00–07 y la cuota 22–25 dentro del OFF 20–02:
  // la unión son las 13 h de schedule, sin doble conteo.
  assert.strictEqual(g.anthropic.horas.total, 13);
  assert.strictEqual(g['openai-codex'].horas.health, 16, 'rojo abierto desde las 10 hasta el fin del rango');
});

// --- Serie 2: cadena agotada con trabajo elegible ---------------------------

test('Serie 2: gate_blocked_spawn (issue, fase) hasta dispatch_resumed del mismo skill:issue; repeticiones no duplican', () => {
  const raw = 'issue=6274 fase=dev pipeline=desarrollo chain=anthropic->openai-codex';
  const events = [
    det('gate_blocked_spawn', 'anthropic', 1, { agent: 'pipeline-dev', raw_excerpt: raw }),
    det('gate_blocked_spawn', 'anthropic', 1.5, { agent: 'pipeline-dev', raw_excerpt: raw }),
    det('gate_blocked_spawn', 'anthropic', 2, { agent: 'pipeline-dev', raw_excerpt: raw }),
    det('dispatch_resumed', 'openai-codex', 4, { agent: 'pipeline-dev', raw_excerpt: 'issue=6274 fase=dev pipeline=desarrollo source=fallback' }),
    det('gate_blocked_spawn', 'anthropic', 6, { agent: 'qa', raw_excerpt: 'issue=7000 fase=verificacion pipeline=desarrollo chain=anthropic' }),
  ];
  const c = qs.chainExhausted({ detectorEvents: events, desde: T0, hasta: T0 + 10 * H });
  assert.strictEqual(c.intervalos.length, 2);
  assert.deepStrictEqual(c.intervalos[0], { skill: 'pipeline-dev', issue: 6274, fase: 'dev', desde: at(1), hasta: at(4), horas: 3, intentos: 3, abierto: false });
  assert.strictEqual(c.intervalos[1].abierto, true);
  assert.strictEqual(c.intervalos[1].horas, 4);
  assert.strictEqual(c.horas_total, 7);
  assert.strictEqual(c.abiertos, 1);
  assert.deepStrictEqual(c.por_fase, { dev: 3, verificacion: 4 });
});

test('Serie 2: un intervalo abierto cuyo último intento cae antes del rango no se arrastra', () => {
  const events = [det('gate_blocked_spawn', 'anthropic', -50, { agent: 'po', raw_excerpt: 'issue=1 fase=dev pipeline=desarrollo' })];
  const c = qs.chainExhausted({ detectorEvents: events, desde: T0, hasta: T0 + 10 * H });
  assert.strictEqual(c.intervalos.length, 0);
  assert.strictEqual(c.horas_total, 0);
});

test('parseChainExcerpt extrae issue y fase del raw_excerpt real', () => {
  assert.deepStrictEqual(qs.parseChainExcerpt('issue=5110 fase=dev pipeline=desarrollo chain=anthropic->openai-codex'), { issue: 5110, fase: 'dev' });
  assert.deepStrictEqual(qs.parseChainExcerpt('nada'), { issue: null, fase: null });
});

// --- Serie 3: única pata viva (caso 2026-09-11) ------------------------------

test('Serie 3 (caso 11/09): anthropic OFF por schedule y codex gateado por cuota ⇒ horas de única pata y cuántas gateada', () => {
  // Rango 26 h: 00:00 → 02:00 del día siguiente. anthropic OFF 00–07 y 20–02 (13 h).
  // codex gateado por cuota semanal de 01:00 a 16:00 (15 h).
  const events = [det('flag_set', 'openai-codex', 1, { error_type: 'insufficient_quota' }), det('drained_post_reset', 'openai-codex', 16)];
  const series = qs.computeSeries({ providers: PROVIDERS, desde: T0, hasta: T0 + 26 * H, detectorEvents: events, scheduleEntries: SCHED, isActiveAt: offNight, samples: [], costRecords: [] });
  const u = series.unica_pata;
  assert.strictEqual(u.horas_unica_pata, 13, 'codex fue la única pata mientras anthropic dormía');
  // De esas 13 h (00–07 y 20–02), codex estuvo gateado 01–07 = 6 h.
  assert.strictEqual(u.horas_unica_pata_gateada, 6);
  assert.strictEqual(u.por_pata['openai-codex'].horas_unica, 13);
  assert.strictEqual(u.por_pata['openai-codex'].horas_unica_gateada, 6);
  assert.strictEqual(u.por_pata.anthropic.horas_unica, 0);
  assert.strictEqual(u.horas_sin_patas, 0);
  assert.strictEqual(series.gateado['openai-codex'].horas.quota_exhausted_semanal, 15);
  assert.strictEqual(series.ventana.horas, 26);
});

test('Serie 3: con ambas patas fuera de circulación cuenta horas_sin_patas', () => {
  const hev = [health('openai-codex', 0, 'red'), health('openai-codex', 3, 'green')];
  const g = qs.gatedByProvider({ healthEvents: hev, scheduleEntries: SCHED, providers: PROVIDERS, desde: T0, hasta: T0 + 8 * H, isActiveAt: offNight });
  const u = qs.singleLeg(g, T0, T0 + 8 * H);
  assert.strictEqual(u.horas_sin_patas, 3);
  assert.strictEqual(u.horas_unica_pata, 4, 'codex sola de 03 a 07');
});

// --- Serie 4: trabajo ganado por unidad de cuota ----------------------------

test('Serie 4: fases ganadas ÷ puntos consumidos por proveedor y fase; los reinicios no cuentan como consumo', () => {
  const samples = [
    { ts: T0 + 1 * H, provider: 'anthropic', bucket: 'weekly', pct: 10, confidence: 'fresh' },
    { ts: T0 + 2 * H, provider: 'anthropic', bucket: 'weekly', pct: 14, confidence: 'fresh' },
    { ts: T0 + 3 * H, provider: 'anthropic', bucket: 'weekly', pct: 0, confidence: 'fresh' },  // reinicio
    { ts: T0 + 4 * H, provider: 'anthropic', bucket: 'weekly', pct: 6, confidence: 'fresh' },
  ];
  const cost = [
    { provider: 'anthropic', timestamp: at(1.5), fase: 'dev', resultado: 'ganada', reliable: true },
    { provider: 'anthropic', timestamp: at(2.5), fase: 'dev', resultado: 'error', reliable: true },
    { provider: 'anthropic', timestamp: at(3.5), fase: 'verificacion', resultado: 'ganada', reliable: true },
    { provider: 'anthropic', timestamp: null, fase: 'dev', resultado: 'ganada', reliable: false }, // v1: no entra
    { provider: 'openai-codex', timestamp: at(2), fase: 'dev', resultado: 'ganada', reliable: true },
  ];
  const w = qs.workPerQuota({ samples, costRecords: cost, providers: PROVIDERS, desde: T0, hasta: T0 + 10 * H });
  assert.strictEqual(w.anthropic.pct_consumido, 10, '4 + 6, el salto 14→0 no cuenta');
  assert.strictEqual(w.anthropic.ganadas, 2);
  assert.strictEqual(w.anthropic.totales, 3);
  assert.strictEqual(w.anthropic.ganadas_por_pct, 0.2);
  assert.deepStrictEqual(w.anthropic.por_fase.dev, { ganadas: 1, totales: 2, ganadas_por_pct: 0.1 });
  assert.strictEqual(w['openai-codex'].ganadas, 1);
  assert.strictEqual(w['openai-codex'].ganadas_por_pct, null, 'sin consumo medido no se divide por cero');
});

test('computeSeries devuelve las cuatro series con ventana y sin el campo interno _raw', () => {
  const s = qs.computeSeries({ providers: PROVIDERS, desde: T0, hasta: T0 + 2 * H, detectorEvents: [], samples: [], costRecords: [], isActiveAt: () => true });
  assert.deepStrictEqual(Object.keys(s).sort(), ['cadena_agotada', 'gateado', 'schema', 'trabajo_por_cuota', 'unica_pata', 'ventana']);
  assert.strictEqual(s.gateado.anthropic._raw, undefined);
  assert.deepStrictEqual(Object.keys(s.gateado.anthropic.horas), [...qs.MOTIVOS, 'total']);
});

// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de report.js (#7688): reporte comparativo semanal puro.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const report = require('../report');
const { buildMapping } = require('../mapping');

const {
  monthly, sanitizeName, buildWeek, pickWeek, evaluarSuficiente,
  WEEK_KEYS, ROW_KEYS, EXCESS_KEYS, PLAN_KEYS, PLAN_NAMES,
} = report;

const EVIDENCE = path.resolve(__dirname, '../../../../docs/pipeline/evidence/7594');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(EVIDENCE, f), 'utf8'));
const pricing = readJson('pricing.json');
const baseline = readJson('actions-usage-summary.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

function weekSummary(workflows, days = 7, extra = {}) {
  const wf = {};
  let total = 0;
  for (const [n, v] of Object.entries(workflows)) {
    wf[n] = { billable_min: v };
    total += v;
  }
  return { window: { days }, repos: { platform: { workflows: wf } }, totals: { billable_min: total }, ...extra };
}

// Semana "real": algunos workflows de la baseline, uno nuevo real y uno que falta.
const REAL_WEEK = weekSummary({
  'Security SAST': 700,
  'PR Checks': 280,
  'Admission Gate': 280,
  'License Header Lint': 14,
});

// ---------------- monthly ----------------

test('monthly normaliza a 30 días y devuelve null ante entradas inválidas', () => {
  assert.equal(monthly(100, 30), 100);
  assert.equal(monthly(70, 7), 300);
  assert.equal(monthly(100, 0), null);
  assert.equal(monthly(100, -1), null);
  assert.equal(monthly(NaN, 7), null);
  assert.equal(monthly('a', 7), null);
  assert.equal(monthly(100, Infinity), null);
  assert.equal(monthly(Infinity, 7), null);
  assert.equal(monthly(100, '7'), null);
});

// ---------------- normalización / parcial ----------------

test('semana de 7 días ⇒ parcial false y total mensualizado v*30/7', () => {
  const week = buildWeek(REAL_WEEK, baseline, new Map(), pricing, null);
  assert.equal(week.dias, 7);
  assert.equal(week.parcial, false);
  assert.equal(week.total_min_mes, (1274 * 30) / 7);
});

test('semana de 3 días ⇒ parcial true, valores ×10', () => {
  const week = buildWeek(weekSummary({ 'PR Checks': 50 }, 3), baseline, new Map(), pricing, null);
  assert.equal(week.parcial, true);
  assert.equal(week.total_min_mes, 500);
  assert.equal(week.filas.find((r) => r.workflow === 'PR Checks').actual_min_mes, 500);
});

test('la baseline se normaliza con su propio window.days (no un literal)', () => {
  const week = buildWeek(REAL_WEEK, baseline, new Map(), pricing, null);
  assert.equal(week.base_dias, 30);
  assert.equal(week.base_total_min_mes, 18008);
  const b15 = clone(baseline);
  b15.window.days = 15;
  const w15 = buildWeek(REAL_WEEK, b15, new Map(), pricing, null);
  assert.equal(w15.base_total_min_mes, 36016);
  assert.equal(w15.filas.find((r) => r.workflow === 'PR Checks').base_min_mes, 951 * 2);
});

test('baseline sin window.days ⇒ bases null y total de baseline null', () => {
  const b = clone(baseline);
  delete b.window;
  const week = buildWeek(REAL_WEEK, b, new Map(), pricing, null);
  assert.equal(week.base_dias, null);
  assert.equal(week.base_total_min_mes, null);
  const pr = week.filas.find((r) => r.workflow === 'PR Checks');
  assert.equal(pr.base_min_mes, null);
  assert.equal(pr.delta_pct, null);
  // Sin base no hay excedente calculable para las comparadas; los nuevos (base 0) sí.
  assert.deepEqual(week.excedente_por_workflow.map((r) => r.workflow), ['License Header Lint']);
});

test('semana con days ausente, 0, negativo o no numérico ⇒ total null y proyección sin_dato', () => {
  for (const days of [undefined, 0, -3, 'x', NaN]) {
    const s = weekSummary({ 'PR Checks': 50 });
    s.window.days = days;
    const week = buildWeek(s, baseline, new Map(), pricing, null);
    assert.equal(week.dias, null);
    assert.equal(week.parcial, null);
    assert.equal(week.total_min_mes, null);
    for (const p of PLAN_NAMES) assert.equal(week.proyeccion[p].veredicto, 'sin_dato');
    assert.ok(!JSON.stringify(week).includes('NaN'));
  }
  const noWindow = buildWeek({ repos: {} }, baseline, new Map(), pricing, null);
  assert.equal(noWindow.total_min_mes, null);
});

// ---------------- filas ----------------

test('filas nuevo/eliminado/comparado, con "License Header Lint" como nuevo', () => {
  const week = buildWeek(REAL_WEEK, baseline, new Map(), pricing, null);
  const by = Object.fromEntries(week.filas.map((r) => [r.workflow, r]));
  assert.equal(by['License Header Lint'].estado, 'nuevo');
  assert.equal(by['License Header Lint'].base_min_mes, 0);
  assert.equal(by['License Header Lint'].delta_pct, null);
  assert.equal(by['CI-CD Plataforma'].estado, 'eliminado');
  assert.equal(by['CI-CD Plataforma'].actual_min_mes, 0);
  assert.equal(by['PR Checks'].estado, 'comparado');
  assert.equal(by['PR Checks'].actual_min_mes, 1200);
  assert.equal(by['PR Checks'].delta_pct, (1200 - 951) / 951);
  assert.equal(week.filas.length, 13); // 12 de la baseline + License Header Lint
  // Una sola repo ⇒ las filas no llevan `repo`.
  assert.ok(week.filas.every((r) => !Object.hasOwn(r, 'repo')));
});

test('fila comparada con base 0 o valor roto ⇒ delta_pct null', () => {
  const b = weekSummary({ A: 0, B: 10 }, 30);
  const s = weekSummary({ A: 7, B: 7 });
  s.repos.platform.workflows.B.billable_min = 'x';
  const week = buildWeek(s, b, new Map(), pricing, null);
  const by = Object.fromEntries(week.filas.map((r) => [r.workflow, r]));
  assert.equal(by.A.delta_pct, null);
  assert.equal(by.B.actual_min_mes, null);
  assert.equal(by.B.delta_pct, null);
});

test('N viejos → 1 nuevo con un valor roto ⇒ la base sumada sale null (fail-closed)', () => {
  const b = clone(baseline);
  b.repos.platform.workflows['Test Env Lint'].billable_min = 'roto';
  const mapping = buildMapping(pricing, { 'Test Env Lint': 'Lints', 'Write Target Lint': 'Lints', 'Ghost Artifact Lint': 'Lints' });
  const week = buildWeek(weekSummary({ Lints: 10 }), b, mapping, pricing, null);
  assert.equal(week.filas.find((r) => r.workflow === 'Lints').base_min_mes, null);
  // Orden inverso: el roto llega primero y el siguiente no lo "arregla".
  const b2 = clone(baseline);
  b2.repos.platform.workflows['Ghost Artifact Lint'] = 'no-objeto';
  const w2 = buildWeek(weekSummary({ Lints: 10 }), b2, mapping, pricing, null);
  assert.equal(w2.filas.find((r) => r.workflow === 'Lints').base_min_mes, null);
});

test('multi-repo: cada fila lleva repo y no hay colisiones entre repos', () => {
  const s = weekSummary({ CI: 7 });
  s.repos.otra = { workflows: { CI: { billable_min: 14 } } };
  const b = weekSummary({ CI: 30 }, 30);
  const week = buildWeek(s, b, new Map(), pricing, null);
  assert.equal(week.filas.length, 2);
  const byRepo = Object.fromEntries(week.filas.map((r) => [r.repo, r]));
  assert.equal(byRepo.platform.estado, 'comparado');
  assert.equal(byRepo.otra.estado, 'nuevo');
  assert.ok(week.excedente_por_workflow.every((r) => typeof r.repo === 'string'));
});

test('summary/baseline con repos o workflows no-objeto se toleran', () => {
  const week = buildWeek({ window: { days: 7 }, repos: { platform: 'x', otra: { workflows: [] } } },
    { window: { days: 30 }, repos: null }, new Map(), pricing, null);
  assert.deepEqual(week.filas, []);
  assert.deepEqual(week.excedente_por_workflow, []);
  const w2 = buildWeek(null, undefined, new Map(), pricing, null);
  assert.equal(w2.total_min_mes, null);
});

// ---------------- proyección (CA-4 / RS-E) ----------------

test('CA-4: con 2000 excede y mutando el fixture a 50000 queda dentro', () => {
  const week = buildWeek(REAL_WEEK, baseline, new Map(), pricing, null);
  const total = week.total_min_mes;
  assert.equal(week.proyeccion.free.cuota, 2000);
  assert.equal(week.proyeccion.free.veredicto, 'excede');
  assert.equal(week.proyeccion.free.excedente_min, total - 2000);
  assert.equal(week.proyeccion.team.cuota, 3000);
  assert.equal(week.proyeccion.team.veredicto, 'excede');
  const p = clone(pricing);
  p.plans.free.included_minutes = 50000;
  const w2 = buildWeek(REAL_WEEK, baseline, new Map(), p, null);
  assert.equal(w2.proyeccion.free.veredicto, 'dentro');
  assert.equal(w2.proyeccion.free.excedente_min, 0);
  assert.equal(w2.proyeccion.team.veredicto, 'excede');
});

test('plans ausente o included_minutes 0 / "2000" / no finito ⇒ sin_dato, sin cuota por default', () => {
  const variants = [
    (p) => { delete p.plans; },
    (p) => { p.plans.free.included_minutes = 0; p.plans.team.included_minutes = '2000'; },
    (p) => { p.plans.free = null; p.plans.team.included_minutes = Infinity; },
    (p) => { delete p.plans.free; delete p.plans.team; },
  ];
  for (const mutate of variants) {
    const p = clone(pricing);
    mutate(p);
    const week = buildWeek(REAL_WEEK, baseline, new Map(), p, null);
    for (const plan of PLAN_NAMES) {
      assert.equal(week.proyeccion[plan].veredicto, 'sin_dato');
      assert.equal(week.proyeccion[plan].cuota, null);
      assert.equal(week.proyeccion[plan].excedente_min, null);
    }
  }
  const noPricing = buildWeek(REAL_WEEK, baseline, new Map(), null, null);
  assert.equal(noPricing.proyeccion.free.veredicto, 'sin_dato');
});

// ---------------- excedente (CA-5) ----------------

test('CA-5: excedente ordenado desc con empate resuelto por nombre', () => {
  const b = weekSummary({ A: 30, B: 30, C: 30, D: 300 }, 30);
  const s = weekSummary({ C: 14, A: 14, B: 21, D: 7, E: 7 }); // ×30/7
  const week = buildWeek(s, b, new Map(), pricing, null);
  // A: 60-30=30, C: 30, B: 90-30=60, E (nuevo): 30, D: 30-300 <0 (excluido)
  assert.deepEqual(week.excedente_por_workflow.map((r) => r.workflow), ['B', 'A', 'C', 'E']);
  assert.equal(week.excedente_por_workflow[0].excedente_min_mes, 60);
  const again = buildWeek(s, b, new Map(), pricing, null);
  assert.deepEqual(again.excedente_por_workflow, week.excedente_por_workflow);
});

test('excedente: empate de monto y nombre se desempata por repo', () => {
  const s = weekSummary({ X: 7 });
  s.repos.b = { workflows: { X: { billable_min: 7 } } };
  s.repos.a = { workflows: { X: { billable_min: 7 } } };
  const week = buildWeek(s, { window: { days: 30 }, repos: {} }, new Map(), pricing, null);
  assert.deepEqual(week.excedente_por_workflow.map((r) => r.repo), ['a', 'b', 'platform']);
});

// ---------------- delta vs semana anterior ----------------

test('delta_vs_semana_anterior: calcula y devuelve null sin prev, prev 0 o no finito, o total null', () => {
  const s = weekSummary({ A: 7 }); // total mes 30
  assert.equal(buildWeek(s, baseline, new Map(), pricing, { total_min_mes: 20 }).delta_vs_semana_anterior, 0.5);
  assert.equal(buildWeek(s, baseline, new Map(), pricing, null).delta_vs_semana_anterior, null);
  assert.equal(buildWeek(s, baseline, new Map(), pricing, { total_min_mes: 0 }).delta_vs_semana_anterior, null);
  assert.equal(buildWeek(s, baseline, new Map(), pricing, { total_min_mes: NaN }).delta_vs_semana_anterior, null);
  assert.equal(buildWeek(s, baseline, new Map(), pricing, { total_min_mes: '20' }).delta_vs_semana_anterior, null);
  const sBad = weekSummary({ A: 7 }, 0);
  assert.equal(buildWeek(sBad, baseline, new Map(), pricing, { total_min_mes: 20 }).delta_vs_semana_anterior, null);
});

// ---------------- evaluarSuficiente (CA-6) ----------------

const full = (t) => ({ parcial: false, total_min_mes: t });
const part = (t) => ({ parcial: true, total_min_mes: t });

test('evaluarSuficiente: 2 completas con Δ ≤ 20 % ⇒ suficiente', () => {
  const r = evaluarSuficiente([full(100), full(110)]);
  assert.equal(r.estado, 'suficiente');
  assert.match(r.motivo, /10%/);
});

test('evaluarSuficiente: Δ = 20 % exacto (subida o bajada) cuenta como estable', () => {
  assert.equal(evaluarSuficiente([full(100), full(120)]).estado, 'suficiente');
  assert.equal(evaluarSuficiente([full(100), full(80)]).estado, 'suficiente');
  assert.equal(evaluarSuficiente([full(100), full(120.01)]).estado, 'midiendo');
});

test('evaluarSuficiente: una parcial en medio no cuenta ni corta la consecutividad', () => {
  assert.equal(evaluarSuficiente([full(100), part(500), full(105)]).estado, 'suficiente');
  assert.equal(evaluarSuficiente([part(100), part(100)]).estado, 'midiendo');
});

test('evaluarSuficiente: delta null / total no finito / prev 0 ⇒ inestable (fail-closed)', () => {
  assert.equal(evaluarSuficiente([full(null), full(100)]).estado, 'midiendo');
  assert.equal(evaluarSuficiente([full(100), full(NaN)]).estado, 'midiendo');
  assert.equal(evaluarSuficiente([full(0), full(0)]).estado, 'midiendo');
  assert.equal(evaluarSuficiente([full(null), full(null), full(null), full(null)]).estado, 'no_estabiliza');
});

test('evaluarSuficiente: 4 completas inestables ⇒ no_estabiliza; 3 ⇒ midiendo', () => {
  assert.equal(evaluarSuficiente([full(100), full(200), full(100), full(200)]).estado, 'no_estabiliza');
  const r = evaluarSuficiente([full(100), full(200), full(100)]);
  assert.equal(r.estado, 'midiendo');
  assert.match(r.motivo, /3 semana/);
});

test('evaluarSuficiente: olaCerrada === true ⇒ suficiente; "true" string no alcanza', () => {
  assert.equal(evaluarSuficiente([], { olaCerrada: true }).estado, 'suficiente');
  assert.equal(evaluarSuficiente([], { olaCerrada: 'true' }).estado, 'midiendo');
  assert.equal(evaluarSuficiente(null).estado, 'midiendo');
  assert.equal(evaluarSuficiente([null, 'x', full(1)], null).estado, 'midiendo');
  for (const r of [evaluarSuficiente([]), evaluarSuficiente([], { olaCerrada: true })]) {
    assert.equal(typeof r.motivo, 'string');
    assert.ok(r.motivo.length > 0);
  }
});

test('evaluarSuficiente consume la serie producida por buildWeek', () => {
  const w1 = buildWeek(weekSummary({ A: 70 }), baseline, new Map(), pricing, null);
  const w2 = buildWeek(weekSummary({ A: 75 }), baseline, new Map(), pricing, w1);
  assert.equal(evaluarSuficiente([w1, w2]).estado, 'suficiente');
});

// ---------------- seguridad (RS-A / RS-B / RS-C / CA-7) ----------------

test('RS-A: workflows __proto__, constructor y toString producen filas normales sin contaminar', () => {
  const raw = '{"window":{"days":7},"totals":{"billable_min":21},"repos":{"platform":{"workflows":'
    + '{"__proto__":{"billable_min":7,"polluted":1},"constructor":{"billable_min":7},"toString":{"billable_min":7}}}}}';
  const s = JSON.parse(raw);
  const b = JSON.parse(raw.replace('"days":7', '"days":30'));
  const week = buildWeek(s, b, new Map(), pricing, null);
  assert.deepEqual(week.filas.map((r) => r.workflow).sort(), ['__proto__', 'constructor', 'toString']);
  assert.ok(week.filas.every((r) => r.estado === 'comparado' && r.actual_min_mes === 30));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof {}.toString, 'function');
});

test('RS-B / CA-7: claves extra del summary no aparecen en la salida', () => {
  const s = weekSummary({ 'PR Checks': 70 });
  s.head_branch = 'feature/x';
  s.head_sha = 'abc';
  s.actor = { login: 'user@example.com' };
  s.runs = [[1, 2], { login: 'x' }];
  s.repos.platform.workflows['PR Checks'].head_branch = 'main';
  s.repos.platform.workflows['PR Checks'].actor = { login: 'someone' };
  s.repos.platform.head_sha = 'def';
  s.totals.login = 'x';
  const b = clone(baseline);
  b.repos.platform.workflows['PR Checks'].head_sha = 'zzz';
  const week = buildWeek(s, b, new Map(), pricing, { total_min_mes: 10, head_branch: 'x', login: 'y' });
  const json = JSON.stringify(week);
  assert.doesNotMatch(json, /head_branch|head_sha|@|login/);
  assert.deepEqual(Object.keys(week).sort(), [...WEEK_KEYS].sort());
});

test('RS-C / CA-7: nombre hostil sale ≤ 100 chars, sin controles ni @ ASCII, con | y ` escapados', () => {
  const hostile = `@leitolarreta\n| x | \`code\` \u0007\u2028` + 'a'.repeat(300);
  const s = weekSummary({ [hostile]: 7 });
  const week = buildWeek(s, baseline, new Map(), pricing, null);
  const row = week.filas.find((r) => r.estado === 'nuevo');
  assert.ok(row.workflow.length <= 100);
  assert.doesNotMatch(row.workflow, /[\u0000-\u001F\u007F-\u009F\u2028\u2029@]/);
  assert.ok(row.workflow.startsWith('＠leitolarreta'));
  assert.ok(row.workflow.includes('\\|'));
  assert.ok(row.workflow.includes('\\`code\\`'));
  assert.doesNotMatch(row.workflow, /(^|[^\\])[|`]/);
  assert.doesNotMatch(JSON.stringify(week), /head_branch|head_sha|@|login/);
});

test('sanitizeName: escapa backslash, no corta escapes ni pares sustitutos, convierte no-strings', () => {
  assert.equal(sanitizeName('a\\b'), 'a\\\\b');
  assert.equal(sanitizeName(42), '42');
  const s = sanitizeName('a'.repeat(99) + '|');
  assert.equal(s, 'a'.repeat(99)); // el escape "\\|" no entra entero ⇒ se descarta
  const emoji = sanitizeName('a'.repeat(99) + '😀');
  assert.equal(emoji, 'a'.repeat(99)); // el par sustituto no entra entero
  assert.equal(sanitizeName('x\u0085y\u009Fz\u007F'), 'xyz');
});

test('pickWeek: descarta objetos/arrays/no finitos y reconstruye sub-objetos', () => {
  const hostile = {
    dias: 7, parcial: false, total_min_mes: Infinity, base_dias: { a: 1 }, base_total_min_mes: [1],
    delta_vs_semana_anterior: null, extra: 'x',
    filas: [
      { workflow: 'A', estado: 'raro', base_min_mes: NaN, actual_min_mes: 1, delta_pct: 0, repo: 'r', login: 'x' },
      null,
      { workflow: { x: 1 }, estado: 'nuevo' },
    ],
    excedente_por_workflow: 'no-array',
    proyeccion: { free: { cuota: 1, veredicto: 'dentro', nested: { a: 1 } }, team: 'x', otro: {} },
  };
  const out = pickWeek(hostile);
  assert.equal(Object.getPrototypeOf(out), null);
  assert.deepEqual(Object.keys(out).sort(), ['delta_vs_semana_anterior', 'dias', 'excedente_por_workflow', 'filas', 'parcial', 'proyeccion']);
  assert.deepEqual({ ...out.filas[0] }, { workflow: 'A', estado: null, actual_min_mes: 1, delta_pct: 0 });
  assert.deepEqual({ ...out.filas[1] }, {});
  assert.deepEqual({ ...out.filas[2] }, { estado: 'nuevo' });
  assert.deepEqual(out.excedente_por_workflow, []);
  assert.deepEqual({ ...out.proyeccion.free }, { cuota: 1, veredicto: 'dentro' });
  assert.deepEqual({ ...out.proyeccion.team }, {});
  assert.deepEqual(Object.keys(out.proyeccion), ['free', 'team']);
  assert.notEqual(out.filas, hostile.filas);
  const multi = pickWeek({ filas: [{ workflow: 'A', repo: 'a@b' }, { workflow: 'B', repo: 5 }] }, true);
  assert.equal(multi.filas[0].repo, 'a＠b');
  assert.equal(Object.hasOwn(multi.filas[1], 'repo'), false);
  const empty = pickWeek(null);
  assert.deepEqual(empty.filas, []);
  assert.deepEqual(Object.keys(empty.proyeccion), ['free', 'team']);
});

// ---------------- contrato y pureza ----------------

test('contrato: WEEK_KEYS / ROW_KEYS / EXCESS_KEYS / PLAN_KEYS fijados literalmente', () => {
  assert.deepEqual([...WEEK_KEYS], [
    'dias', 'parcial', 'total_min_mes', 'base_dias', 'base_total_min_mes',
    'delta_vs_semana_anterior', 'filas', 'proyeccion', 'excedente_por_workflow',
  ]);
  assert.deepEqual([...ROW_KEYS], ['repo', 'workflow', 'estado', 'base_min_mes', 'actual_min_mes', 'delta_pct']);
  assert.deepEqual([...EXCESS_KEYS], ['repo', 'workflow', 'estado', 'base_min_mes', 'actual_min_mes', 'excedente_min_mes']);
  assert.deepEqual([...PLAN_KEYS], ['cuota', 'total_min_mes', 'excedente_min', 'veredicto']);
  assert.deepEqual([...PLAN_NAMES], ['free', 'team']);
  for (const k of [WEEK_KEYS, ROW_KEYS, EXCESS_KEYS, PLAN_KEYS, PLAN_NAMES]) assert.ok(Object.isFrozen(k));
});

test('RS-F: report.js y mapping.js no importan I/O ni usan process.env / Date.now', () => {
  for (const f of ['report.js', 'mapping.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?(fs|child_process|https?|net)['"]\)|process\.env|Date\.now/, f);
  }
});

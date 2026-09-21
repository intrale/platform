'use strict';

// =============================================================================
// agent-quality-signal.test.js — Tests de la señal de calidad por agente (#7518).
//
// Un test por criterio de aceptación del comentario canónico de `criterios`
// (CA-8, 8b, 8c, 9, 10, 11, 12, Q1…Q4, Q6…Q9). Los fixtures de CA-8b y CA-10
// son filas LITERALES de `logs/spawn-exit-*.jsonl` y `state/label-mutations.jsonl`
// (writer real: `action: 'label'`, timestamp en `at`), para que un cambio en
// el contrato de entrada lo delate este archivo y no producción.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { compute, DEFAULTS, OUTPUT_KEYS, isValidIssue, dedupSpawns } =
  require('../agent-quality-signal');
const { rates } = require('../../model-propagation-rollout');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'agent-quality-signal.js'), 'utf8');

// Skills con rol dev: en producción los deriva el caller de `skills_por_fase.dev`.
// Acá se inyectan como fixture (CA-Q6: el módulo no los conoce).
const DEV_SKILLS = ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'dev'];
const MEASURABLE_WINDOW = { from: '2026-09-10T00:00:00Z', reboundSince: '2026-09-06T20:15:29.660Z' };

// Fila de spawn-exit "sana": exit_code 0, duración 5 s, issue numérico.
function spawn(over = {}) {
  return Object.assign({
    ts: '2026-09-21T10:00:00.000Z', skill: 'guru', issue: 100, provider: 'anthropic',
    exit_code: 0, duration_ms: 5000, death_kind: undefined,
  }, over);
}
function at(base, offsetMs) { return new Date(Date.parse(base) + offsetMs).toISOString(); }
function base(over = {}) {
  return Object.assign({ integrity: { spawn_exit: 'verificada' }, minSample: 1, rebounds: [], qaFailures: [] },
    MEASURABLE_WINDOW, over);
}

// ---------------------------------------------------------------------------
// CA-8 · reuso de `rates` sumando providers
// ---------------------------------------------------------------------------
test('CA-8 · un skill con dos providers coincide exactamente con rates sobre las filas dedup sumadas', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = [
    spawn({ ts: at(t0, 0), issue: 1, provider: 'anthropic', exit_code: 0, duration_ms: 4000 }),
    spawn({ ts: at(t0, 60000), issue: 2, provider: 'openai-codex', exit_code: 1, duration_ms: 3000 }),   // muerte temprana
    spawn({ ts: at(t0, 120000), issue: 3, provider: 'anthropic', exit_code: 0, duration_ms: 90000 }),
    spawn({ ts: at(t0, 180000), issue: 4, provider: 'openai-codex', exit_code: null, duration_ms: 500 }), // no medible
    spawn({ ts: at(t0, 240000), issue: 5, provider: 'openai-codex', exit_code: 0, duration_ms: 12000 }),
  ];
  const rebounds = [{ ts: at(t0, 300000), issue: '1', skill: 'guru', provider: 'anthropic', rechazado_en_fase: 'verificacion' },
    { ts: at(t0, 300000), issue: '5', skill: 'guru', provider: 'openai-codex', rechazado_en_fase: 'build' }];
  const r = compute(base({ spawns: rows, rebounds, earlyDeathMs: 15000 }));
  const expected = rates(rows, rebounds.length, 15000, true);
  const g = r.skills.guru;
  assert.deepEqual(
    { n: g.n, nUnmeasurable: g.nUnmeasurable, earlyDeathRate: g.earlyDeathRate, durationP50Ms: g.durationP50Ms,
      durationP95Ms: g.durationP95Ms, reboundRate: g.reboundRate },
    { n: expected.n, nUnmeasurable: expected.nUnmeasurable, earlyDeathRate: expected.earlyDeathRate,
      durationP50Ms: expected.durationP50Ms, durationP95Ms: expected.durationP95Ms, reboundRate: expected.reboundRate });
  assert.equal(g.n, 4);
  assert.equal(g.reboundRate, 0.5);
  assert.equal(g.earlyDeathRate, 0.25);
  assert.equal(Object.keys(r.skills).length, 1, 'sumando providers: una sola fila por skill');
  assert.equal(g.successRate, undefined, 'successRate se descarta (PQ3)');
});

// ---------------------------------------------------------------------------
// CA-8b · dedup de la doble emisión (H4)
// ---------------------------------------------------------------------------
// Filas literales de ux/#6558 (2026-09-21): la primera con first_byte_at y
// raw_excerpt vacío (launcher), la segunda sin first_byte_at (pulpo).
const UX_6558 = [
  { ts: '2026-09-21T10:55:15.972Z', skill: 'ux', issue: 6558, provider: 'anthropic', exit_code: 0, duration_ms: 483210,
    death_kind: undefined, codepath: 'generalized', first_byte_at: '2026-09-21T10:47:14.101Z', raw_excerpt: '' },
  { ts: '2026-09-21T10:55:16.009Z', skill: 'ux', issue: 6558, provider: 'anthropic', exit_code: 0, duration_ms: 483247,
    death_kind: undefined, codepath: 'generalized', first_byte_at: null, raw_excerpt: 'Validación UX — ux (fase validacion)' },
];

test('CA-8b (a) · las dos filas literales de ux/#6558 colapsan a n:1 nDuplicadas:1 conservando la primera', () => {
  const r = compute(base({ spawns: UX_6558 }));
  assert.equal(r.skills.ux.n, 1);
  assert.equal(r.skills.ux.nDuplicadas, 1);
  assert.equal(r.skills.ux.nRaw, 2);
  // Se conserva la primera: la duración p50 es la del launcher (483210), no la del pulpo.
  assert.equal(r.skills.ux.durationP50Ms, 483210);
  const entries = UX_6558.map((row, i) => ({ row, i, t: Date.parse(row.ts) }));
  const { kept, duplicates } = dedupSpawns(entries, DEFAULTS.dedupWindowMs);
  assert.equal(duplicates, 1);
  assert.equal(kept[0].row.first_byte_at, '2026-09-21T10:47:14.101Z');
});

test('CA-8b (b) · mismo grupo a 5 s no se deduplica', () => {
  const r = compute(base({ spawns: [UX_6558[0], Object.assign({}, UX_6558[1], { ts: at(UX_6558[0].ts, 5000) })] }));
  assert.equal(r.skills.ux.n, 2);
  assert.equal(r.skills.ux.nDuplicadas, 0);
});

test('CA-8b (c) · a 1 s con distinto provider son dos corridas', () => {
  const r = compute(base({ spawns: [UX_6558[0], Object.assign({}, UX_6558[1], { ts: at(UX_6558[0].ts, 1000), provider: 'openai-codex' })] }));
  assert.equal(r.skills.ux.n, 2);
  assert.equal(r.skills.ux.nDuplicadas, 0);
});

test('CA-8b (d) · tres filas a 1 s cada una colapsan a una sola: la ventana es contra la última conservada', () => {
  const t0 = UX_6558[0].ts;
  const rows = [0, 1000, 2000].map(off => Object.assign({}, UX_6558[0], { ts: at(t0, off) }));
  const r = compute(base({ spawns: rows }));
  assert.equal(r.skills.ux.n, 1);
  assert.equal(r.skills.ux.nDuplicadas, 2);
});

test('CA-8b (e) · el orden de entrada no importa: se ordena por ts antes de deduplicar', () => {
  const r = compute(base({ spawns: [UX_6558[1], UX_6558[0]] }));
  assert.equal(r.skills.ux.n, 1);
  assert.equal(r.skills.ux.durationP50Ms, 483210, 'conserva la primera por ts, no la primera por entrada');
});

// ---------------------------------------------------------------------------
// CA-8c · filas que no son un spawn + invariante
// ---------------------------------------------------------------------------
test('CA-8c · premature-death y ts inválido van a nDescartadas y el invariante nRaw = n + nUnmeasurable + nDuplicadas + nDescartadas se cumple', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = [
    spawn({ ts: at(t0, 0), issue: 1 }),
    spawn({ ts: at(t0, 40), issue: 1 }),                                             // duplicada
    spawn({ ts: at(t0, 60000), issue: 2, codepath: 'premature-death', exit_code: 1, duration_ms: 800 }), // anotación
    spawn({ ts: 'ayer', issue: 3 }),                                                 // ts inválido
    spawn({ ts: at(t0, 120000), issue: 4, exit_code: null }),                        // no medible
    spawn({ ts: at(t0, 180000), issue: 5 }),
  ];
  const g = compute(base({ spawns: rows })).skills.guru;
  assert.equal(g.nRaw, 6);
  assert.equal(g.nDescartadas, 2);
  assert.equal(g.nDuplicadas, 1);
  assert.equal(g.nUnmeasurable, 1);
  assert.equal(g.n, 2);
  assert.equal(g.nRaw, g.n + g.nUnmeasurable + g.nDuplicadas + g.nDescartadas);
});

// ---------------------------------------------------------------------------
// CA-9 · retriesPerIssue
// ---------------------------------------------------------------------------
test('CA-9 · issue mixto 7114 / "7114" es un solo issue con un reintento', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const r = compute(base({ spawns: [spawn({ ts: at(t0, 0), issue: 7114 }), spawn({ ts: at(t0, 3600000), issue: '7114' })] }));
  assert.equal(r.skills.guru.retriesPerIssue, 1);
  assert.equal(r.skills.guru.n, 2);
});

test('CA-9 · skill sólo con issue null (commander) da retriesPerIssue null, no 0', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = Array.from({ length: 5 }, (_, k) => spawn({ ts: at(t0, k * 60000), skill: 'commander', issue: null }));
  const c = compute(base({ spawns: rows })).skills.commander;
  assert.equal(c.retriesPerIssue, null);
  assert.equal(c.n, 5);
  assert.equal(c.nSinIssue, 5);
});

test('CA-9 · una fila no medible (exit_code null) del mismo issue sí cuenta como reintento', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const r = compute(base({ spawns: [spawn({ ts: at(t0, 0), issue: 9, exit_code: null }), spawn({ ts: at(t0, 3600000), issue: 9 })] }));
  assert.equal(r.skills.guru.retriesPerIssue, 1);
  assert.equal(r.skills.guru.n, 1);
});

test('CA-9 · promedio sobre los issues válidos del skill', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = [
    spawn({ ts: at(t0, 0), issue: 1 }), spawn({ ts: at(t0, 60000), issue: 1 }), spawn({ ts: at(t0, 120000), issue: 1 }), // 2 reintentos
    spawn({ ts: at(t0, 180000), issue: 2 }),                                                                              // 0
  ];
  assert.equal(compute(base({ spawns: rows })).skills.guru.retriesPerIssue, 1);
});

// ---------------------------------------------------------------------------
// CA-10 · qaFailRate atribuido al último dev del issue
// ---------------------------------------------------------------------------
// Fila literal de state/label-mutations.jsonl (writer real: action 'label', timestamp en `at`).
const QA_7185 = { issue: 7185, label: 'qa:failed', action: 'label', target: 'issue', at: '2026-09-21T11:00:41.601Z' };
const DEV_7185 = spawn({ ts: '2026-09-21T10:50:00.000Z', skill: 'pipeline-dev', issue: 7185 });
const TESTER_7185 = spawn({ ts: '2026-09-21T10:58:00.000Z', skill: 'tester', issue: 7185 });

test('CA-10 (a) · la fila literal de qa:failed se imputa al último dev del issue, no al tester posterior', () => {
  const r = compute(base({ spawns: [DEV_7185, TESTER_7185], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.ok(r.skills['pipeline-dev'].qaFailRate > 0);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 1);
  assert.equal(r.skills.tester.qaFailRate, 0);
  assert.equal(r.no_atribuidos.qa, 0);
  assert.equal(r.skills['pipeline-dev'].integrity.label_mutations, 'no_verificada');
});

test('CA-10 (b) · sin dev previo el evento va a no_atribuidos.qa y no se imputa a nadie', () => {
  const r = compute(base({ spawns: [TESTER_7185], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.equal(r.no_atribuidos.qa, 1);
  assert.equal(r.skills.tester.qaFailRate, 0);
});

test('CA-10 (b2) · el dev posterior al evento no cuenta: sólo spawns estrictamente anteriores', () => {
  const late = spawn({ ts: '2026-09-21T11:30:00.000Z', skill: 'pipeline-dev', issue: 7185 });
  const r = compute(base({ spawns: [late], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.equal(r.no_atribuidos.qa, 1);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
});

test('CA-10 (c) · remove-label de qa:failed no cuenta ni resta', () => {
  const r = compute(base({ spawns: [DEV_7185], qaFailures: [Object.assign({}, QA_7185, { action: 'remove-label' })], devSkills: DEV_SKILLS }));
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
  assert.equal(r.no_atribuidos.qa, 0);
});

test('CA-10 (c2) · otras labels y action add también se aceptan: qa:passed no cuenta, add sí', () => {
  const r = compute(base({ spawns: [DEV_7185], devSkills: DEV_SKILLS, qaFailures: [
    Object.assign({}, QA_7185, { label: 'qa:passed' }),
    Object.assign({}, QA_7185, { action: 'add', ts: QA_7185.at, at: undefined }),
  ] }));
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 1);
});

test('CA-10 (d) · qaFailures undefined o null ⇒ qaFailRate null en todos, nunca 0', () => {
  for (const qaFailures of [undefined, null]) {
    const r = compute(base({ spawns: [DEV_7185, TESTER_7185], qaFailures, devSkills: DEV_SKILLS }));
    assert.equal(r.skills['pipeline-dev'].qaFailRate, null);
    assert.equal(r.skills.tester.qaFailRate, null);
  }
});

test('CA-10 (e) · evento con at igual al ts del spawn no se atribuye (estrictamente anterior)', () => {
  const r = compute(base({ spawns: [DEV_7185], qaFailures: [Object.assign({}, QA_7185, { at: DEV_7185.ts })], devSkills: DEV_SKILLS }));
  assert.equal(r.no_atribuidos.qa, 1);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
});

test('CA-10 (f) · evento con at no parseable se descarta antes del join', () => {
  const r = compute(base({ spawns: [DEV_7185], qaFailures: [Object.assign({}, QA_7185, { at: 'ayer' })], devSkills: DEV_SKILLS }));
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
  assert.equal(r.no_atribuidos.qa, 1);
});

test('CA-10 (g) · el join usa las filas deduplicadas: una doble emisión del dev no duplica el n del divisor', () => {
  const dup = Object.assign({}, DEV_7185, { ts: at(DEV_7185.ts, 40) });
  const r = compute(base({ spawns: [DEV_7185, dup], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.equal(r.skills['pipeline-dev'].n, 1);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 1);
});

test('CA-10 (h) · con dos skills dev en el mismo issue, gana el último anterior al evento', () => {
  const backend = spawn({ ts: '2026-09-21T10:55:00.000Z', skill: 'backend-dev', issue: 7185 });
  const r = compute(base({ spawns: [DEV_7185, backend], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.equal(r.skills['backend-dev'].qaFailRate, 1);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
});

// ---------------------------------------------------------------------------
// CA-11 · reboundRate null cuando no es medible
// ---------------------------------------------------------------------------
test('CA-11 · from anterior a reboundSince ⇒ reboundRate null (nunca 0) y reboundMeasurable false', () => {
  const r = compute(base({ spawns: [spawn()], from: '2026-08-22T00:00:00Z', reboundSince: '2026-09-06T20:15:29.660Z',
    rebounds: [{ skill: 'guru', issue: '100' }] }));
  assert.equal(r.reboundMeasurable, false);
  assert.strictEqual(r.skills.guru.reboundRate, null);
});

test('CA-11 · from no parseable ("ayer") ⇒ reboundRate null', () => {
  const r = compute(base({ spawns: [spawn()], from: 'ayer' }));
  assert.equal(r.reboundMeasurable, false);
  assert.strictEqual(r.skills.guru.reboundRate, null);
});

test('CA-11 · from posterior a reboundSince con 2 rebounds sobre n:10 ⇒ 0.2', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = Array.from({ length: 10 }, (_, k) => spawn({ ts: at(t0, k * 60000), issue: k + 1 }));
  const rebounds = [{ ts: t0, issue: '1', skill: 'guru', provider: 'anthropic' }, { ts: t0, issue: '2', skill: 'guru', provider: 'openai-codex' }];
  const r = compute(base({ spawns: rows, rebounds }));
  assert.equal(r.reboundMeasurable, true);
  assert.equal(r.skills.guru.reboundRate, 0.2);
  assert.equal(r.no_atribuidos.rebounds, 0);
});

test('CA-11 · rebound de un skill sin spawns va a no_atribuidos.rebounds y no crea entrada', () => {
  const r = compute(base({ spawns: [spawn()], rebounds: [{ skill: 'fantasma', issue: '100' }] }));
  assert.equal(r.no_atribuidos.rebounds, 1);
  assert.equal(r.skills.fantasma, undefined);
  assert.equal(r.skills.guru.reboundRate, 0);
});

test('CA-11 · rebounds undefined o null ⇒ reboundRate null aunque la ventana sea medible', () => {
  for (const rebounds of [undefined, null]) {
    const r = compute(base({ spawns: [spawn()], rebounds }));
    assert.strictEqual(r.skills.guru.reboundRate, null);
    assert.equal(r.reboundMeasurable, false);
  }
});

// ---------------------------------------------------------------------------
// CA-12 / CA-Q4 · umbrales de muestra
// ---------------------------------------------------------------------------
function fourEach(skills) {
  const t0 = '2026-09-21T10:00:00.000Z';
  return skills.flatMap(skill => Array.from({ length: 4 }, (_, k) => spawn({ ts: at(t0, k * 60000), skill, issue: k + 1 })));
}

test('CA-12 · min_sample global 10 con override guru:3 ⇒ guru n:4 ok, tester n:4 no', () => {
  const r = compute(base({ spawns: fourEach(['guru', 'tester']), minSample: 10, minSampleBySkill: { guru: 3 } }));
  assert.equal(r.skills.guru.sample_ok, true);
  assert.equal(r.skills.tester.sample_ok, false);
});

test('CA-12 · el default de minSample es 10', () => {
  const r = compute(base({ spawns: fourEach(['guru']), minSample: undefined }));
  assert.equal(DEFAULTS.minSample, 10);
  assert.equal(r.skills.guru.sample_ok, false);
});

test('CA-Q4 · minSampleBySkill con string "10" ⇒ sample_ok false aunque n sea 50', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = Array.from({ length: 50 }, (_, k) => spawn({ ts: at(t0, k * 60000), issue: k + 1 }));
  const r = compute(base({ spawns: rows, minSampleBySkill: { guru: '10' } }));
  assert.equal(r.skills.guru.n, 50);
  assert.equal(r.skills.guru.sample_ok, false);
});

test('CA-Q4 · minSample NaN (o 0) ⇒ todos sample_ok false', () => {
  for (const minSample of [NaN, 0, -5, 'diez']) {
    const r = compute(base({ spawns: fourEach(['guru', 'tester']), minSample }));
    assert.equal(r.skills.guru.sample_ok, false, `minSample=${minSample}`);
    assert.equal(r.skills.tester.sample_ok, false, `minSample=${minSample}`);
  }
});

test('CA-Q4 · dedupWindowMs inválido (-1, NaN, string) se comporta como el default 3000', () => {
  for (const dedupWindowMs of [-1, NaN, '3000', undefined]) {
    const r = compute(base({ spawns: UX_6558, dedupWindowMs }));
    assert.equal(r.skills.ux.nDuplicadas, 1, `dedupWindowMs=${dedupWindowMs}`);
  }
  assert.equal(compute(base({ spawns: UX_6558, dedupWindowMs: 0 })).skills.ux.nDuplicadas, 0, 'ventana 0 desactiva la dedup');
});

test('CA-Q4 · earlyDeathMs no numérico cae al default de rates', () => {
  const rows = [spawn({ issue: 1, exit_code: 1, duration_ms: 3000 })];
  const a = compute(base({ spawns: rows, earlyDeathMs: 'quince' })).skills.guru.earlyDeathRate;
  const b = compute(base({ spawns: rows })).skills.guru.earlyDeathRate;
  assert.equal(a, 1);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// CA-Q1 · integridad recibida, nunca inventada
// ---------------------------------------------------------------------------
test('CA-Q1 · sin integrity ⇒ spawn_exit rota, nada "verificada" y todos sample_ok false', () => {
  const r = compute(base({ spawns: fourEach(['guru', 'tester']), integrity: undefined }));
  for (const s of Object.values(r.skills)) {
    assert.equal(s.integrity.spawn_exit, 'rota');
    assert.equal(s.sample_ok, false);
    assert.ok(!Object.values(s.integrity).includes('verificada'), 'ningún valor "verificada"');
  }
});

test('CA-Q1 · rebound_events y label_mutations son constantes no_verificada aunque el input diga otra cosa', () => {
  const r = compute(base({ spawns: [spawn()], integrity: { spawn_exit: 'verificada', rebound_events: 'verificada', label_mutations: 'verificada' } }));
  assert.deepEqual(r.skills.guru.integrity, { spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada' });
  assert.equal(r.skills.guru.sample_ok, true);
});

test('CA-Q1 · spawn_exit con un valor distinto de "verificada" (true, "ok") se trata como rota', () => {
  for (const spawn_exit of [true, 'ok', 'VERIFICADA', 1]) {
    const r = compute(base({ spawns: [spawn()], integrity: { spawn_exit } }));
    assert.equal(r.skills.guru.integrity.spawn_exit, 'rota');
    assert.equal(r.skills.guru.sample_ok, false);
  }
});

// ---------------------------------------------------------------------------
// CA-Q2 · acumuladores sin prototipo
// ---------------------------------------------------------------------------
test('CA-Q2 · skills hostiles en rebounds y qaFailures no lanzan, van a no_atribuidos y no contaminan', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const spawns = [DEV_7185, TESTER_7185, spawn({ ts: t0, issue: 1 }), spawn({ ts: at(t0, 60000), issue: 1 })];
  const clean = compute(base({ spawns, devSkills: DEV_SKILLS, qaFailures: [QA_7185],
    rebounds: [{ skill: 'guru', issue: '1' }] }));
  const hostileRebounds = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map(skill => ({ skill, issue: '1', ts: t0 }));
  const hostileQa = ['__proto__', 'constructor', 'toString'].map(skill => ({ skill, issue: 424242, label: 'qa:failed', action: 'label', at: t0 }));
  let r;
  assert.doesNotThrow(() => {
    r = compute(base({ spawns, devSkills: DEV_SKILLS, qaFailures: [QA_7185, ...hostileQa],
      rebounds: [{ skill: 'guru', issue: '1' }, ...hostileRebounds] }));
  });
  assert.deepEqual(r.no_atribuidos, { rebounds: hostileRebounds.length, qa: hostileQa.length });
  assert.deepEqual(Object.keys(r.skills).sort(), ['guru', 'pipeline-dev', 'tester']);
  assert.deepEqual(r.skills, clean.skills, 'los skills legítimos no cambian');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.skills), Object.prototype, 'el resultado sigue siendo un objeto plano');
});

test('CA-Q2 · un spawn con skill "__proto__" o "constructor" queda como clave propia sin tocar el prototipo', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const spawns = [spawn({ ts: t0, skill: '__proto__', issue: 1 }), spawn({ ts: at(t0, 1000), skill: 'constructor', issue: 2 }),
    spawn({ ts: at(t0, 2000), skill: 'guru', issue: 3 })];
  let r;
  assert.doesNotThrow(() => { r = compute(base({ spawns, devSkills: ['constructor'], qaFailures: [
    { issue: 2, label: 'qa:failed', action: 'label', at: at(t0, 5000) }] })); });
  assert.ok(Object.hasOwn(r.skills, '__proto__'));
  assert.ok(Object.hasOwn(r.skills, 'constructor'));
  assert.equal(Object.getPrototypeOf(r.skills), Object.prototype);
  assert.equal(r.skills.constructor.qaFailRate, 1);
  assert.equal(r.skills.guru.n, 1);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof Object.prototype.constructor, 'function', 'Object.prototype intacto');
});

test('CA-Q2 · minSampleBySkill con __proto__ no contamina y sólo aplica a claves propias', () => {
  const r = compute(base({ spawns: fourEach(['guru']), minSample: 10,
    minSampleBySkill: JSON.parse('{"__proto__": {"guru": 1}, "otro": 1}') }));
  assert.equal(r.skills.guru.sample_ok, false);
  assert.equal(Object.prototype.guru, undefined);
});

// ---------------------------------------------------------------------------
// CA-Q3 · issue validado, no coaccionado
// ---------------------------------------------------------------------------
test('CA-Q3 · null, {}, "7114abc" y -1 van a nSinIssue pero cuentan en n si son medibles', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const bad = [null, {}, '7114abc', -1];
  const rows = bad.map((issue, k) => spawn({ ts: at(t0, k * 60000), issue }));
  rows.push(spawn({ ts: at(t0, 300000), issue: 7114 }), spawn({ ts: at(t0, 360000), issue: '7114' }));
  const g = compute(base({ spawns: rows })).skills.guru;
  assert.equal(g.nSinIssue, 4);
  assert.equal(g.n, 6);
  assert.equal(g.retriesPerIssue, 1, 'sólo el issue válido participa del join');
});

test('CA-Q3 · isValidIssue acepta enteros positivos y strings de dígitos, nada más', () => {
  for (const ok of [1, 7114, '7114', '1']) assert.equal(isValidIssue(ok), true, String(ok));
  for (const bad of [0, -1, 1.5, NaN, Infinity, '', '0x1', ' 7114', '7114 ', '7114abc', null, undefined, {}, [], true, '1e3', '-1'])
    assert.equal(isValidIssue(bad), false, JSON.stringify(bad));
});

test('CA-Q3 · las filas sin issue válido no se deduplican entre sí', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const rows = [spawn({ ts: t0, skill: 'commander', issue: null }), spawn({ ts: at(t0, 40), skill: 'commander', issue: null })];
  const c = compute(base({ spawns: rows })).skills.commander;
  assert.equal(c.n, 2);
  assert.equal(c.nDuplicadas, 0);
});

// ---------------------------------------------------------------------------
// CA-Q6 · devSkills inyectado
// ---------------------------------------------------------------------------
test('CA-Q6 · devSkills vacío o ausente ⇒ todos los eventos de QA van a no_atribuidos.qa', () => {
  const events = [QA_7185, Object.assign({}, QA_7185, { at: at(QA_7185.at, 60000) })];
  for (const devSkills of [[], undefined, null]) {
    const r = compute(base({ spawns: [DEV_7185, TESTER_7185], qaFailures: events, devSkills }));
    assert.equal(r.no_atribuidos.qa, events.length, `devSkills=${JSON.stringify(devSkills)}`);
    assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
  }
});

test('CA-Q6 · el skill atribuido sale del spawn y nunca de la fila de QA', () => {
  const r = compute(base({ spawns: [DEV_7185], qaFailures: [Object.assign({}, QA_7185, { skill: 'tester' })], devSkills: DEV_SKILLS }));
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 1);
  assert.equal(r.skills.tester, undefined);
});

test('CA-Q6 · empate de ts entre dos devs del mismo issue se resuelve por orden de entrada', () => {
  const a = spawn({ ts: DEV_7185.ts, skill: 'backend-dev', issue: 7185 });
  const r1 = compute(base({ spawns: [DEV_7185, a], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  const r2 = compute(base({ spawns: [a, DEV_7185], qaFailures: [QA_7185], devSkills: DEV_SKILLS }));
  assert.equal(r1.skills['backend-dev'].qaFailRate, 1, 'último por entrada gana');
  assert.equal(r1.skills['pipeline-dev'].qaFailRate, 0);
  assert.equal(r2.skills['pipeline-dev'].qaFailRate, 1);
  assert.equal(r2.skills['backend-dev'].qaFailRate, 0);
});

test('CA-Q6 (estático) · el fuente no contiene ningún nombre de skill dev como literal', () => {
  assert.doesNotMatch(SOURCE, /backend-dev|android-dev|web-dev|pipeline-dev|['"]dev['"]/);
});

// ---------------------------------------------------------------------------
// CA-Q7 · sin I/O por construcción
// ---------------------------------------------------------------------------
test('CA-Q7 (estático) · el fuente no contiene primitivas de escritura', () => {
  assert.doesNotMatch(SOURCE, /writeFileSync|appendFileSync|appendChained|unlinkSync|renameSync|rmSync|mkdirSync|writeFile\(/);
});

test('CA-Q7 (estático) · el fuente no requiere módulos de Node core y su único require es el rollout', () => {
  assert.doesNotMatch(SOURCE, /require\(\s*['"](node:)?(fs|child_process|http|https|net|os|worker_threads|path)['"]/);
  const requires = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.deepEqual(requires, ['../model-propagation-rollout']);
  assert.equal((SOURCE.match(/require\(/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// CA-Q8 · salida cerrada
// ---------------------------------------------------------------------------
test('CA-Q8 · la salida no ecoa campos del input y las claves por skill son exactamente OUTPUT_KEYS', () => {
  const t0 = '2026-09-21T10:00:00.000Z';
  const spawns = [
    spawn({ ts: t0, skill: 'pipeline-dev', issue: 424242, provider: 'openai-codex', raw_excerpt: 'RAW_EXCERPT_X', evidence: 'EVIDENCE_X',
      status: 'STATUS_X', first_byte_at: 'FIRST_BYTE_X' }),
    spawn({ ts: at(t0, 60000), skill: 'pipeline-dev', issue: 424242, provider: 'anthropic' }),
  ];
  const rebounds = [{ ts: at(t0, 120000), issue: '424242', skill: 'pipeline-dev', provider: 'anthropic', rechazado_en_fase: 'RECHAZADO_X',
    evaluadores: ['EVALUADORES_X'] }];
  const qaFailures = [{ issue: 424242, label: 'qa:failed', action: 'label', at: at(t0, 180000), target: 'issue', evidence: 'EVIDENCE_Y' }];
  const r = compute(base({ spawns, rebounds, qaFailures, devSkills: DEV_SKILLS }));
  const json = JSON.stringify(r);
  for (const leak of ['raw_excerpt', 'evidence', 'evaluadores', 'status', 'first_byte_at', 'rechazado_en_fase', 'provider',
    '424242', 'RAW_EXCERPT_X', 'EVIDENCE_X', 'STATUS_X', 'FIRST_BYTE_X', 'RECHAZADO_X', 'EVALUADORES_X', 'EVIDENCE_Y', 'anthropic', 'openai-codex']) {
    assert.ok(!json.includes(leak), `no debe contener ${leak}`);
  }
  for (const s of Object.keys(r.skills)) {
    assert.deepEqual(Object.keys(r.skills[s]).sort(), [...OUTPUT_KEYS].sort());
    assert.deepEqual(Object.keys(r.skills[s].integrity).sort(), ['label_mutations', 'rebound_events', 'spawn_exit']);
  }
  assert.deepEqual(Object.keys(r).sort(), ['no_atribuidos', 'reboundMeasurable', 'skills']);
  assert.deepEqual(Object.keys(r.no_atribuidos).sort(), ['qa', 'rebounds']);
});

test('CA-Q8 · OUTPUT_KEYS y DEFAULTS están congelados', () => {
  assert.ok(Object.isFrozen(OUTPUT_KEYS));
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.deepEqual(DEFAULTS, { earlyDeathMs: 15000, minSample: 10, dedupWindowMs: 3000 });
});

// ---------------------------------------------------------------------------
// CA-Q9 · complejidad acotada
// ---------------------------------------------------------------------------
test('CA-Q9 (humo) · 20.000 spawns y 2.000 eventos de QA terminan en menos de 2 s', () => {
  const t0 = Date.parse('2026-08-25T00:00:00Z');
  const skills = ['backend-dev', 'android-dev', 'pipeline-dev', 'guru', 'tester', 'po', 'ux', 'security', 'qa', 'review'];
  const spawns = [];
  for (let issue = 1; issue <= 2000; issue++) {
    for (let k = 0; k < 10; k++) {
      spawns.push(spawn({ ts: new Date(t0 + issue * 600000 + k * 30000).toISOString(), skill: skills[k], issue,
        provider: k % 2 ? 'anthropic' : 'openai-codex', exit_code: k % 7 ? 0 : 1, duration_ms: 1000 + k * 5000 }));
    }
  }
  const qaFailures = Array.from({ length: 2000 }, (_, i) => ({ issue: i + 1, label: 'qa:failed', action: 'label',
    at: new Date(t0 + (i + 1) * 600000 + 400000).toISOString() }));
  const rebounds = Array.from({ length: 2000 }, (_, i) => ({ ts: new Date(t0 + i * 600000).toISOString(), issue: String(i + 1),
    skill: skills[i % skills.length], provider: 'anthropic' }));
  const start = performance.now();
  const r = compute(base({ spawns, qaFailures, rebounds, devSkills: DEV_SKILLS, minSample: 10 }));
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `tardó ${elapsed.toFixed(0)} ms`);
  assert.equal(Object.keys(r.skills).length, skills.length);
  assert.equal(r.skills['pipeline-dev'].n, 2000);
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 1, 'el último dev antes de cada evento es pipeline-dev (k=2)');
  assert.equal(r.no_atribuidos.qa, 0);
  assert.equal(r.skills.guru.sample_ok, true);
});

// ---------------------------------------------------------------------------
// Robustez de entrada
// ---------------------------------------------------------------------------
test('robustez · compute sin argumentos o con spawns no-array devuelve tabla vacía sin lanzar', () => {
  for (const input of [undefined, {}, { spawns: null }, { spawns: 'x' }, { spawns: [null, 1, 'a', {}, { skill: '' }, { skill: 5 }] }]) {
    const r = compute(input);
    assert.deepEqual(r.skills, {});
    assert.deepEqual(r.no_atribuidos, { rebounds: 0, qa: 0 });
    assert.equal(r.reboundMeasurable, false);
  }
});

test('robustez · rebounds y qaFailures con filas nulas o sin skill no lanzan', () => {
  const r = compute(base({ spawns: [DEV_7185], devSkills: DEV_SKILLS, rebounds: [null, {}, { skill: 7 }], qaFailures: [null, {}, { label: 'qa:failed' }] }));
  assert.equal(r.no_atribuidos.rebounds, 3);
  assert.equal(r.no_atribuidos.qa, 0, 'un qa:failed sin action válida se ignora, no se cuenta');
  assert.equal(r.skills['pipeline-dev'].qaFailRate, 0);
});

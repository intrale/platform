'use strict';

// =============================================================================
// agent-quality-signal.js — Señal de calidad por agente (#7518, parte 2 de #6793).
//
// Cálculo PURO: recibe filas ya proyectadas por la parte 1 (#7517) y devuelve
// una tabla por skill. Sin I/O por construcción (CA-Q7): la única dependencia
// es `rates` del rollout, que es la autoridad de las tasas base y NO se toca
// (config-schema `model_propagation_rollout: 'autoridad'`).
//
// Pipeline de 4 etapas, en este orden (DA1):
//   (1) normalizar  → descarta anotaciones `codepath: 'premature-death'` y filas
//                     con `ts` no parseable (`nDescartadas`); valida `issue`
//                     (`nSinIssue`); orden estable por (ts, índice de entrada).
//   (2) dedup       → colapsa la doble emisión de spawn-exit (H4 de guru, #7527)
//                     por (skill, issue válido, provider) dentro de `dedupWindowMs`
//                     contra la ÚLTIMA fila conservada (`nDuplicadas`).
//   (3) rates       → tasas base del rollout sobre las filas post-dedup,
//                     SUMANDO providers.
//   (4) joins       → `retriesPerIssue` (CA-9) y `qaFailRate` (CA-10).
//
// Invariante por skill (CA-8c): nRaw === n + nUnmeasurable + nDuplicadas + nDescartadas.
//
// Principio "no medible ≠ cero" (PQ5 / DA3): todo divisor cero o fuente ausente
// produce `null`, nunca `0`. Un auditor que emite un falso verde no sirve.
// =============================================================================

const { rates } = require('../model-propagation-rollout');

const DEFAULTS = Object.freeze({ earlyDeathMs: 15000, minSample: 10, dedupWindowMs: 3000 });

// Salida cerrada por skill (PQ3 / SEC-Q8): se construye clave a clave desde esta
// lista, nunca con spread del resultado de `rates` ni de una fila de entrada.
const OUTPUT_KEYS = Object.freeze([
  'n', 'nRaw', 'nUnmeasurable', 'nDuplicadas', 'nDescartadas', 'nSinIssue',
  'reboundRate', 'earlyDeathRate', 'retriesPerIssue', 'qaFailRate',
  'durationP50Ms', 'durationP95Ms', 'integrity', 'sample_ok',
]);

// Acciones del writer real de label-mutations (`label-mutation-log.js`) que
// significan "se agregó la label". `remove-label` no cuenta ni resta (DA4/PQ2).
const QA_ADD_ACTIONS = new Set(['add', 'label']);
const QA_LABEL = 'qa:failed';

// CA-Q3: un issue es válido si es entero positivo o string de dígitos. Se valida
// ANTES de normalizar con String(): `null` → "null" sería un pseudo-issue (H2).
function isValidIssue(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0;
  return typeof v === 'string' && /^\d+$/.test(v);
}
const issueKey = v => (isValidIssue(v) ? String(v) : null);

// Timestamp de una fila: `ts` (spawn-exit / rebound) o `at` (label-mutations,
// fila literal del writer). NaN si no es parseable (PQ2).
const tsMs = r => Date.parse(r && (r.ts ?? r.at));

const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);
const positiveOr = (v, d) => (isFiniteNumber(v) && v >= 0 ? v : d);

// Comparador estable por (ts, índice de entrada). Sólo se aplica a entradas con
// `t` finito: las de `ts` inválido se descartan antes para no meter NaN al sort.
const byTsThenIndex = (a, b) => (a.t - b.t) || (a.i - b.i);

// DA2 / CA-8b: conserva la PRIMERA fila del grupo (la del launcher, que trae
// `first_byte_at`) y descarta las que estén a menos de `windowMs` de la ÚLTIMA
// CONSERVADA del mismo (skill, issue, provider). Sin issue válido no se
// deduplica: la doble emisión sólo ocurre en el camino con issue, y colapsar
// `commander` (issue null) por (skill, provider) fundiría corridas reales.
// `sorted` es una lista de `{ row, i, t }` ya ordenada por (t, i).
function dedupSpawns(sorted, windowMs) {
  const lastKept = new Map();
  const kept = [];
  let duplicates = 0;
  for (const e of sorted) {
    const ik = issueKey(e.row.issue);
    if (ik === null) { kept.push(e); continue; }
    const key = `${e.row.skill}|${ik}|${e.row.provider}`;
    const prev = lastKept.get(key);
    if (prev !== undefined && e.t - prev < windowMs) { duplicates++; continue; }
    lastKept.set(key, e.t);
    kept.push(e);
  }
  return { kept, duplicates };
}

// Bisección: último índice j tal que arr[j].t < t (estricto). -1 si no hay.
function lastBefore(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

// CA-11 / SEC-Q4: la ventana es medible sólo si `from` y `reboundSince` parsean
// y `from >= reboundSince` (mismo criterio que `collect()` del rollout).
function windowMeasurable(from, reboundSince) {
  const f = Date.parse(from), s = Date.parse(reboundSince);
  return Number.isFinite(f) && Number.isFinite(s) && f >= s;
}

// Asigna una clave en un objeto plano sin pasar por setters heredados: con
// `defineProperty`, un skill llamado `__proto__` queda como propiedad propia y
// no reemplaza el prototipo (CA-Q2).
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function compute(input = {}) {
  const { spawns, rebounds, qaFailures, integrity, devSkills, from, reboundSince } = input;
  const earlyDeathMs = input.earlyDeathMs; // `rates` ya cae a su default si no es numérico (CA-Q4)
  const dedupWindowMs = positiveOr(input.dedupWindowMs, DEFAULTS.dedupWindowMs);

  // CA-Q1: la integridad se recibe, nunca se calcula ni se relaja. Ausente ⇒ rota.
  const spawnIntegrity = integrity && integrity.spawn_exit === 'verificada' ? 'verificada' : 'rota';
  // CA-11 / PQ5: sin lista de rebounds tampoco es medible.
  const reboundMeasurable = windowMeasurable(from, reboundSince) && Array.isArray(rebounds);
  const qaMeasurable = Array.isArray(qaFailures);
  // CA-Q6: el conjunto de skills con rol de desarrollo lo inyecta el caller.
  const devSet = new Set(Array.isArray(devSkills) ? devSkills.map(String) : []);

  // ---- (1) normalizar -------------------------------------------------------
  // skill -> { raw, descartadas, sinIssue, rows: [{ row, i, t }] }
  const bySkill = new Map();
  const acc = skill => {
    let a = bySkill.get(skill);
    if (!a) { a = { raw: 0, descartadas: 0, sinIssue: 0, rows: [] }; bySkill.set(skill, a); }
    return a;
  };
  const rowsIn = Array.isArray(spawns) ? spawns : [];
  for (let i = 0; i < rowsIn.length; i++) {
    const row = rowsIn[i];
    if (!row || typeof row.skill !== 'string' || !row.skill) continue;
    const a = acc(row.skill);
    a.raw++;
    const t = tsMs(row);
    if (row.codepath === 'premature-death' || !Number.isFinite(t)) { a.descartadas++; continue; } // CA-8c
    if (issueKey(row.issue) === null) a.sinIssue++; // CA-Q3
    a.rows.push({ row, i, t });
  }

  // Rebounds: se cuentan por skill sumando providers, sólo si el skill tiene
  // spawns en la ventana (fuente verificada). Si no ⇒ no_atribuidos (SEC-Q2).
  const noAtrib = { rebounds: 0, qa: 0 };
  const reboundCount = new Map();
  for (const r of Array.isArray(rebounds) ? rebounds : []) {
    if (r && typeof r.skill === 'string' && bySkill.has(r.skill)) {
      reboundCount.set(r.skill, (reboundCount.get(r.skill) || 0) + 1);
    } else {
      noAtrib.rebounds++;
    }
  }

  // ---- (2) dedup  (3) rates  (4a) retriesPerIssue ---------------------------
  const devIndex = new Map(); // issueKey -> [{ t, i, skill }] (se ordena después)
  const perSkill = new Map();
  for (const [skill, a] of bySkill) {
    a.rows.sort(byTsThenIndex);
    const { kept, duplicates } = dedupSpawns(a.rows, dedupWindowMs);
    const base = rates(kept.map(e => e.row), reboundCount.get(skill) || 0, earlyDeathMs, reboundMeasurable);
    const perIssue = new Map();
    for (const e of kept) {
      const ik = issueKey(e.row.issue);
      if (ik === null) continue;
      perIssue.set(ik, (perIssue.get(ik) || 0) + 1);
      if (devSet.has(skill)) {
        let list = devIndex.get(ik);
        if (!list) devIndex.set(ik, (list = []));
        list.push({ t: e.t, i: e.i, skill });
      }
    }
    // CA-9: (spawns dedup del issue − 1) promediado sobre los issues válidos. Sin
    // issues válidos ⇒ null (commander).
    let retries = null;
    if (perIssue.size) {
      let sum = 0;
      for (const c of perIssue.values()) sum += c - 1;
      retries = sum / perIssue.size;
    }
    perSkill.set(skill, { a, base, duplicates, retries, qaHits: 0 });
  }
  // Orden global entre skills distintos del mismo issue (cada lista se llenó
  // skill por skill). Empate de ts ⇒ orden de entrada (CA-Q6).
  for (const list of devIndex.values()) list.sort(byTsThenIndex);

  // ---- (4b) qaFailRate (CA-10) ---------------------------------------------
  if (qaMeasurable) {
    for (const ev of qaFailures) {
      if (!ev || ev.label !== QA_LABEL || !QA_ADD_ACTIONS.has(ev.action)) continue;
      const t = tsMs(ev);
      const ik = issueKey(ev.issue);
      const list = ik !== null && Number.isFinite(t) ? devIndex.get(ik) : undefined;
      const j = list ? lastBefore(list, t) : -1;
      if (j < 0) { noAtrib.qa++; continue; }
      // El skill sale del spawn (fuente verificada), jamás de la fila de QA.
      perSkill.get(list[j].skill).qaHits++;
    }
  }

  // ---- salida cerrada -------------------------------------------------------
  const minBySkill = Object.assign(Object.create(null), input.minSampleBySkill || {});
  const out = {};
  for (const [skill, s] of perSkill) {
    const min = Object.hasOwn(minBySkill, skill) ? minBySkill[skill] : (input.minSample ?? DEFAULTS.minSample);
    const minOk = isFiniteNumber(min) && min >= 1; // CA-Q4: umbral inválido ⇒ fail-closed
    const { n, nUnmeasurable, reboundRate, earlyDeathRate, durationP50Ms, durationP95Ms } = s.base; // successRate NO (PQ3)
    setOwn(out, skill, {
      n,
      nRaw: s.a.raw, // filas recibidas para el skill, NO el nRaw post-dedup de `rates` (CA-8c)
      nUnmeasurable,
      nDuplicadas: s.duplicates,
      nDescartadas: s.a.descartadas,
      nSinIssue: s.a.sinIssue,
      reboundRate, // tal cual de `rates`: ya es null cuando no es medible (CA-11)
      earlyDeathRate,
      retriesPerIssue: s.retries,
      qaFailRate: qaMeasurable ? (n ? s.qaHits / n : null) : null,
      durationP50Ms,
      durationP95Ms,
      integrity: { spawn_exit: spawnIntegrity, rebound_events: 'no_verificada', label_mutations: 'no_verificada' },
      sample_ok: spawnIntegrity === 'verificada' && minOk && n >= min,
    });
  }
  return { skills: out, no_atribuidos: noAtrib, reboundMeasurable };
}

module.exports = { compute, DEFAULTS, OUTPUT_KEYS, isValidIssue, dedupSpawns };

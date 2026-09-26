// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Reporte comparativo semanal de GitHub Actions (#7688, parte 2/4 de #7661).
//
// Lógica PURA: recibe todo ya parseado y devuelve un `week` listo para que
// #7689 lo persista y #7690 lo publique en un issue público. Sin I/O, sin
// variables de entorno y sin reloj (la marca de tiempo la pone #7689).
//
// Entradas:
//  - summary:  salida de `scripts/measure-actions-billing.js` (#7687).
//  - baseline: `docs/pipeline/evidence/7594/actions-usage-summary.json` (misma forma).
//  - mapping:  `Map` de `mapping.buildMapping(...)`.
//  - pricing:  `docs/pipeline/evidence/7594/pricing.json` (trae `plans`).
//  - prevWeek: el `week` anterior de la serie, o `null`.
//
// Unidad: `billable_min` ya incluye el multiplicador del runner, así que se
// compara directo contra `included_minutes`.
//
// Nota: cada job se redondea a 1 min × multiplicador, así que los workflows
// chicos tienen ruido alto en el delta por fila. El criterio de "suficiente"
// usa sólo el total mensualizado y no se ve afectado.

const { resolve } = require('./mapping');

const DAYS_PER_MONTH = 30;
const FULL_WEEK_DAYS = 7;
const STABLE_DELTA = 0.20;
const MAX_FULL_WEEKS = 4;
const MAX_NAME_LEN = 100;
// Tolerancia de punto flotante para que un Δ del 20 % exacto cuente como estable.
const EPSILON = 1e-9;

const PLAN_NAMES = Object.freeze(['free', 'team']);
const ESTADOS_FILA = Object.freeze(['comparado', 'nuevo', 'eliminado']);

// Contrato con #7689/#7690. Un test los fija literalmente.
const WEEK_KEYS = Object.freeze([
  'dias', 'parcial', 'total_min_mes', 'base_dias', 'base_total_min_mes',
  'delta_vs_semana_anterior', 'filas', 'proyeccion', 'excedente_por_workflow',
]);
const ROW_KEYS = Object.freeze(['repo', 'workflow', 'estado', 'base_min_mes', 'actual_min_mes', 'delta_pct']);
const EXCESS_KEYS = Object.freeze(['repo', 'workflow', 'estado', 'base_min_mes', 'actual_min_mes', 'excedente_min_mes']);
const PLAN_KEYS = Object.freeze(['cuota', 'total_min_mes', 'excedente_min', 'veredicto']);

// Asigna una clave propia sin pasar por setters heredados (RS-A).
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isPositiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Mensualiza `v` medido en `dias` días. Devuelve `null` (nunca NaN/Infinity)
 * si `v` no es un número finito o si `dias` no es finito y > 0 (RS-D).
 */
function monthly(v, dias) {
  if (finiteOrNull(v) === null || !isPositiveFinite(dias)) return null;
  return (v * DAYS_PER_MONTH) / dias;
}

// Caracteres de control C0, DEL, C1 y separadores de línea/párrafo Unicode.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Neutraliza un nombre para publicarlo en markdown (RS-C): sin controles,
 * `@` → `＠` (no dispara menciones), `\`, `|` y backtick escapados, y ≤ 100
 * caracteres sin cortar a la mitad un escape ni un par sustituto.
 * Se aplica SÓLO a la salida; las claves internas usan el nombre crudo.
 */
function sanitizeName(s) {
  const clean = String(s).replace(CONTROL_CHARS, '').replace(/@/g, '＠');
  let out = '';
  for (const ch of clean) {
    const unit = ch === '|' || ch === '`' || ch === '\\' ? `\\${ch}` : ch;
    if (out.length + unit.length > MAX_NAME_LEN) break;
    out += unit;
  }
  return out;
}

// Recorre `repos.<repo>.workflows.<name>.billable_min` sólo por claves propias.
// Devuelve Map(clave interna → {repo, workflow, min}) con `min` finito o null.
function collectWorkflows(doc, mapping) {
  const out = new Map();
  const repos = isObject(doc) && isObject(doc.repos) ? doc.repos : {};
  for (const repo of Object.keys(repos)) {
    const workflows = isObject(repos[repo]) && isObject(repos[repo].workflows) ? repos[repo].workflows : {};
    for (const rawName of Object.keys(workflows)) {
      const name = resolve(mapping, rawName);
      const key = `${repo}\u0000${name}`;
      const entry = workflows[rawName];
      const min = isObject(entry) ? finiteOrNull(entry.billable_min) : null;
      const prev = out.get(key);
      if (!prev) {
        out.set(key, { repo, workflow: name, min });
      } else {
        // N viejos → 1 nuevo: se suman; un valor roto contamina la suma (null).
        prev.min = prev.min === null || min === null ? null : prev.min + min;
      }
    }
  }
  return out;
}

function windowDays(doc) {
  return isObject(doc) && isObject(doc.window) ? doc.window.days : undefined;
}

function totalBillable(doc) {
  return isObject(doc) && isObject(doc.totals) ? doc.totals.billable_min : undefined;
}

function buildRows(base, actual, dias, baseDias) {
  const keys = new Set([...base.keys(), ...actual.keys()]);
  const rows = [];
  for (const key of keys) {
    const b = base.get(key);
    const a = actual.get(key);
    const ref = a || b;
    let estado;
    if (a && b) estado = 'comparado';
    else if (a) estado = 'nuevo';
    else estado = 'eliminado';
    const baseMes = b ? monthly(b.min, baseDias) : 0;
    const actualMes = a ? monthly(a.min, dias) : 0;
    const deltaPct = estado === 'comparado' && baseMes !== null && actualMes !== null && baseMes !== 0
      ? (actualMes - baseMes) / baseMes
      : null;
    rows.push({ repo: ref.repo, workflow: ref.workflow, estado, base_min_mes: baseMes, actual_min_mes: actualMes, delta_pct: deltaPct });
  }
  rows.sort((x, y) => cmpStr(x.repo, y.repo) || cmpStr(x.workflow, y.workflow));
  return rows;
}

function cmpStr(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function buildExcess(rows) {
  const out = [];
  for (const r of rows) {
    if (r.actual_min_mes === null || r.base_min_mes === null) continue;
    const diff = r.actual_min_mes - r.base_min_mes;
    if (diff > 0) out.push({ ...r, excedente_min_mes: diff });
  }
  out.sort((x, y) => (y.excedente_min_mes - x.excedente_min_mes)
    || cmpStr(x.workflow, y.workflow) || cmpStr(x.repo, y.repo));
  return out;
}

function projectPlan(pricing, planName, total) {
  const plans = isObject(pricing) && isObject(pricing.plans) ? pricing.plans : null;
  const plan = plans && Object.hasOwn(plans, planName) && isObject(plans[planName]) ? plans[planName] : null;
  const cuota = plan && isPositiveFinite(plan.included_minutes) ? plan.included_minutes : null;
  if (cuota === null || total === null) {
    return { cuota, total_min_mes: total, excedente_min: null, veredicto: 'sin_dato' };
  }
  const excedente = Math.max(0, total - cuota);
  return { cuota, total_min_mes: total, excedente_min: excedente, veredicto: total > cuota ? 'excede' : 'dentro' };
}

function deltaVsPrev(total, prevWeek) {
  const prevTotal = isObject(prevWeek) ? finiteOrNull(prevWeek.total_min_mes) : null;
  if (total === null || prevTotal === null || prevTotal === 0) return null;
  return (total - prevTotal) / prevTotal;
}

// --- Whitelist profunda (RS-B) ---

function pickScalar(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  return v === null || typeof v === 'boolean' || typeof v === 'string' ? v : undefined;
}

function pick(obj, keys) {
  const o = Object.create(null);
  for (const k of keys) {
    if (!Object.hasOwn(obj, k)) continue;
    const v = pickScalar(obj[k]);
    if (v !== undefined) setOwn(o, k, v);
  }
  return o;
}

// Los strings de filas se sanean acá, al final; `repo` sólo sale en multi-repo.
// `estado` es un enum cerrado: cualquier otro valor sale como null.
function pickRow(row, keys, multiRepo) {
  if (!isObject(row)) return Object.create(null);
  const src = Object.create(null);
  for (const k of keys) if (Object.hasOwn(row, k)) setOwn(src, k, row[k]);
  if (typeof src.workflow === 'string') src.workflow = sanitizeName(src.workflow);
  if (multiRepo && typeof src.repo === 'string') src.repo = sanitizeName(src.repo);
  else delete src.repo;
  if (Object.hasOwn(src, 'estado') && !ESTADOS_FILA.includes(src.estado)) src.estado = null;
  return pick(src, keys);
}

function pickRows(rows, keys, multiRepo) {
  return Array.isArray(rows) ? rows.map((r) => pickRow(r, keys, multiRepo)) : [];
}

/**
 * Whitelist profunda del `week` (RS-B): raíz, cada fila, cada ítem de
 * `excedente_por_workflow` y cada plan de `proyeccion` se reconstruyen con su
 * propia lista de claves. Valores: número finito, null, boolean o string
 * saneado. Objetos/arrays no previstos se descartan. Nada se copia por referencia.
 */
function pickWeek(week, multiRepo = false) {
  const src = isObject(week) ? week : {};
  const out = pick(src, WEEK_KEYS);
  setOwn(out, 'filas', pickRows(src.filas, ROW_KEYS, multiRepo));
  setOwn(out, 'excedente_por_workflow', pickRows(src.excedente_por_workflow, EXCESS_KEYS, multiRepo));
  const proyeccionIn = isObject(src.proyeccion) ? src.proyeccion : {};
  const proyeccion = Object.create(null);
  for (const plan of PLAN_NAMES) {
    const p = Object.hasOwn(proyeccionIn, plan) && isObject(proyeccionIn[plan]) ? proyeccionIn[plan] : {};
    setOwn(proyeccion, plan, pick(p, PLAN_KEYS));
  }
  setOwn(out, 'proyeccion', proyeccion);
  return out;
}

/**
 * Arma el reporte de una semana contra la baseline y las cuotas de los planes.
 * @returns {object} week (sólo claves de WEEK_KEYS, en profundidad)
 */
function buildWeek(summary, baseline, mapping, pricing, prevWeek) {
  const dias = windowDays(summary);
  const baseDias = windowDays(baseline);
  const diasOk = isPositiveFinite(dias);
  const parcial = diasOk ? dias < FULL_WEEK_DAYS : null;

  const base = collectWorkflows(baseline, mapping);
  const actual = collectWorkflows(summary, new Map());
  const repos = new Set([...base.values(), ...actual.values()].map((e) => e.repo));

  const total = monthly(totalBillable(summary), dias);
  const filas = buildRows(base, actual, dias, baseDias);
  const proyeccion = {};
  for (const plan of PLAN_NAMES) proyeccion[plan] = projectPlan(pricing, plan, total);

  return pickWeek({
    dias: diasOk ? dias : null,
    parcial,
    total_min_mes: total,
    base_dias: isPositiveFinite(baseDias) ? baseDias : null,
    base_total_min_mes: monthly(totalBillable(baseline), baseDias),
    delta_vs_semana_anterior: deltaVsPrev(total, prevWeek),
    filas,
    proyeccion,
    excedente_por_workflow: buildExcess(filas),
  }, repos.size > 1);
}

/**
 * ¿La medición ya es suficiente?
 *  - `olaCerrada === true` ⇒ suficiente.
 *  - Sólo cuentan semanas completas (`parcial !== true`); el Δ se recalcula
 *    entre completas consecutivas (una parcial en medio no corta la racha).
 *  - Δ null/no finito ⇒ inestable (fail-closed).
 *  - ≥ 4 completas sin un par estable ⇒ no_estabiliza; si no, midiendo.
 */
function evaluarSuficiente(series, opts) {
  const olaCerrada = isObject(opts) ? opts.olaCerrada : undefined;
  if (olaCerrada === true) {
    return { estado: 'suficiente', motivo: 'La ola está cerrada: la medición se da por terminada.' };
  }
  const completas = (Array.isArray(series) ? series : []).filter((w) => isObject(w) && w.parcial !== true);
  for (let i = 1; i < completas.length; i++) {
    const prev = finiteOrNull(completas[i - 1].total_min_mes);
    const cur = finiteOrNull(completas[i].total_min_mes);
    if (prev === null || cur === null || prev === 0) continue;
    const delta = (cur - prev) / prev;
    if (Math.abs(delta) <= STABLE_DELTA + EPSILON) {
      const pct = Math.round(delta * 1000) / 10;
      return {
        estado: 'suficiente',
        motivo: `Dos semanas completas consecutivas con variación de ${pct}% (umbral ±20%).`,
      };
    }
  }
  if (completas.length >= MAX_FULL_WEEKS) {
    return {
      estado: 'no_estabiliza',
      motivo: `${completas.length} semanas completas sin dos consecutivas dentro de ±20%.`,
    };
  }
  return {
    estado: 'midiendo',
    motivo: `${completas.length} semana(s) completa(s) medida(s); hacen falta dos consecutivas dentro de ±20%.`,
  };
}

module.exports = {
  monthly,
  sanitizeName,
  buildWeek,
  pickWeek,
  evaluarSuficiente,
  WEEK_KEYS,
  ROW_KEYS,
  EXCESS_KEYS,
  PLAN_KEYS,
  PLAN_NAMES,
};

// =============================================================================
// quota-series.js — Series derivadas del libro contable de cuota (#6560, CA-6).
//
// Cuatro series que el auditor del modelo operativo (#6809) necesita para
// concluir sobre plan/schedule/cadena SIN cruzar logs a mano. Caso que las
// motiva: 2026-09-11, codex única pata viva gateado ≈15 h de 26 h — la
// conclusión hubo que armarla cruzando 4 archivos.
//
//   1. `gatedByProvider`   — horas gateado por proveedor y motivo
//                            (`quota_exhausted_sesion` | `quota_exhausted_semanal`
//                             | `health` | `schedule` | `credencial`).
//   2. `chainExhausted`    — horas de cadena agotada CON trabajo elegible: cada
//                            `gate_blocked_spawn` (issue, fase) hasta el siguiente
//                            lanzamiento efectivo del mismo skill:issue
//                            (`dispatch_resumed`, emitido por pulpo.js).
//   3. `singleLeg`         — horas de única pata viva (un solo proveedor en
//                            circulación por schedule/health/credencial) y
//                            cuántas de ellas esa pata estuvo gateada por cuota.
//   4. `workPerQuota`      — trabajo ganado por unidad de cuota: fases
//                            `ganada` (#6558) ÷ puntos de ventana consumidos en
//                            el mismo intervalo, por proveedor y fase.
//
// PURO: recibe los eventos ya leídos (los lectores viven en `quota-ledger.js`)
// y un `isActiveAt(provider, ms, scheduleEntry)` inyectable para el schedule
// (default: `provider-schedule.isProviderActiveNow`, que ya resuelve la zona
// IANA). Todo se calcula sobre un rango `[desde, hasta]` cerrado a `hasta`:
// los intervalos abiertos (gate sin drenar, cadena sin relanzar) cuentan hasta
// `hasta`, nunca más allá.
//
// Fuentes (ver multi-provider.md §19.4):
//   - `logs/quota-detector-*.log`  → eventos `flag_set` / `drained_post_reset` /
//     `cleared` / `manual_clear` / `reset_credit_redeemed` (gate por cuota o
//     credencial) y `gate_blocked_spawn` / `dispatch_resumed` (cadena).
//   - `audit/multi-provider-health.jsonl` → `health_state_transition`.
//   - `provider-schedule.json` → ventanas OFF por día (vía `isActiveAt`).
//   - `state/provider-cost.jsonl` v2 + muestras del ledger → trabajo por cuota.
// =============================================================================
'use strict';

const { normalizeProviderId } = require('./validate-quota-ceilings');
const { prepareSamples } = require('./quota-balance');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Motivos de gate (vocabulario cerrado de la serie 1). */
const MOTIVOS = Object.freeze([
  'quota_exhausted_sesion',
  'quota_exhausted_semanal',
  'health',
  'schedule',
  'credencial',
]);

/** Motivos que sacan al proveedor de CIRCULACIÓN (no es "pata viva"). */
const MOTIVOS_FUERA_DE_CIRCULACION = Object.freeze(['schedule', 'health', 'credencial']);

/** Motivos de cuota (la pata está viva pero gateada). */
const MOTIVOS_CUOTA = Object.freeze(['quota_exhausted_sesion', 'quota_exhausted_semanal']);

/** Eventos del detector que ABREN un gate por proveedor. */
const EVENTOS_ABREN = new Set(['flag_set']);
/** Eventos del detector que CIERRAN un gate por proveedor. */
const EVENTOS_CIERRAN = new Set(['drained_post_reset', 'cleared', 'manual_clear', 'reset_credit_redeemed', 'success_spawn']);

/**
 * `error_type` → ventana. Medido sobre los logs reales del repo (21/09):
 *   weekly_limit_content_channel (anthropic) → semanal
 *   insufficient_quota (codex/free)         → semanal
 *   usage_limit_reached (codex rolling)      → sesion
 *   usage_limit_error (anthropic 5h)         → sesion
 * Desconocido → por duración del gate (< 24 h ⇒ sesion). #7550 promoverá la
 * ventana a campo estructurado; hasta entonces este mapeo es la fuente.
 */
const ERROR_TYPE_VENTANA = Object.freeze({
  weekly_limit_content_channel: 'semanal',
  insufficient_quota: 'semanal',
  usage_limit_reached: 'sesion',
  usage_limit_error: 'sesion',
  rate_limit_error: 'sesion',
});
const CREDENCIAL_RE = /auth|credential|api[_-]?key|permission|unauthorized|forbidden/i;

const DEFAULT_STEP_MS = 5 * 60000; // granularidad del muestreo del schedule y del barrido

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
function hours(ms) { return Math.round((ms / HOUR_MS) * 100) / 100; }
function clampRange(a, b, desde, hasta) {
  const s = Math.max(a, desde);
  const e = Math.min(b, hasta);
  return e > s ? [s, e] : null;
}

function eventTs(e) { return toMs(e && (e.timestamp != null ? e.timestamp : (e.ts != null ? e.ts : e.created_at))); }

/** Normaliza y ordena eventos del detector dentro del rango ampliado (para cerrar gates abiertos antes de `desde`). */
function sortedEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map(e => ({ e, t: eventTs(e) }))
    .filter(x => x.t != null)
    .sort((a, b) => a.t - b.t);
}

function motivoDeGate(flagEvent, durationMs) {
  const et = String(flagEvent.error_type || '');
  if (CREDENCIAL_RE.test(et)) return 'credencial';
  const ventana = ERROR_TYPE_VENTANA[et] || (durationMs != null && durationMs < DAY_MS ? 'sesion' : 'semanal');
  return `quota_exhausted_${ventana}`;
}

function emptyHoras() {
  const h = {};
  for (const m of MOTIVOS) h[m] = 0;
  h.total = 0;
  return h;
}

/** Une intervalos solapados `[s,e]` (mismo motivo o no) y devuelve la medida total en ms. */
function measureUnion(intervals) {
  const sorted = intervals.map(i => [i[0], i[1]]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [s, e] of sorted) {
    if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; }
    else if (e > cur[1]) cur[1] = e;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// -----------------------------------------------------------------------------
// Serie 1 — horas gateado por proveedor y motivo
// -----------------------------------------------------------------------------

/**
 * Intervalos de gate por cuota/credencial desde el audit del detector.
 * Un `flag_set` abre; el primer evento de cierre del mismo proveedor cierra.
 * Un `flag_set` sobre un gate ya abierto lo prolonga (no duplica).
 */
function quotaGateIntervals(detectorEvents, providers, desde, hasta) {
  const open = {};
  const out = {};
  for (const p of providers) out[p] = [];
  for (const { e, t } of sortedEvents(detectorEvents)) {
    const p = normalizeProviderId(e.provider);
    if (!p || !out[p]) continue;
    if (EVENTOS_ABREN.has(e.event)) {
      if (!open[p]) open[p] = { start: t, flag: e };
    } else if (EVENTOS_CIERRAN.has(e.event) && open[p]) {
      const r = clampRange(open[p].start, t, desde, hasta);
      if (r) out[p].push({ desde: r[0], hasta: r[1], motivo: motivoDeGate(open[p].flag, t - open[p].start), abierto: false });
      delete open[p];
    }
  }
  for (const p of Object.keys(open)) {
    const r = clampRange(open[p].start, hasta, desde, hasta);
    if (r) out[p].push({ desde: r[0], hasta: r[1], motivo: motivoDeGate(open[p].flag, null), abierto: true });
  }
  return out;
}

/** Intervalos en `red` desde `health_state_transition`. */
function healthGateIntervals(healthEvents, providers, desde, hasta) {
  const open = {};
  const out = {};
  for (const p of providers) out[p] = [];
  const evs = (Array.isArray(healthEvents) ? healthEvents : [])
    .filter(e => e && e.type === 'health_state_transition')
    .map(e => ({ e, t: toMs(e.created_at) }))
    .filter(x => x.t != null)
    .sort((a, b) => a.t - b.t);
  for (const { e, t } of evs) {
    const p = normalizeProviderId(e.provider);
    if (!p || !out[p]) continue;
    if (e.to_state === 'red') { if (open[p] == null) open[p] = t; }
    else if (open[p] != null) {
      const r = clampRange(open[p], t, desde, hasta);
      if (r) out[p].push({ desde: r[0], hasta: r[1], motivo: 'health', abierto: false });
      delete open[p];
    }
  }
  for (const p of Object.keys(open)) {
    const r = clampRange(open[p], hasta, desde, hasta);
    if (r) out[p].push({ desde: r[0], hasta: r[1], motivo: 'health', abierto: true });
  }
  return out;
}

/**
 * Intervalos OFF por schedule, muestreando `isActiveAt` cada `stepMs`. Usa el
 * schedule VIGENTE para todo el rango (los cambios de schedule no quedan
 * versionados: por eso el snapshot horario de la serie se persiste).
 */
function scheduleGateIntervals(scheduleEntries, providers, desde, hasta, isActiveAt, stepMs) {
  const out = {};
  for (const p of providers) {
    out[p] = [];
    const entry = scheduleEntries && scheduleEntries[p];
    if (!entry || entry.active !== true) continue;
    let offStart = null;
    for (let t = desde; t < hasta; t += stepMs) {
      let active = true;
      try { active = isActiveAt(p, t, entry) !== false; } catch { active = true; }
      if (!active && offStart == null) offStart = t;
      if (active && offStart != null) { out[p].push({ desde: offStart, hasta: t, motivo: 'schedule', abierto: false }); offStart = null; }
    }
    if (offStart != null) out[p].push({ desde: offStart, hasta, motivo: 'schedule', abierto: true });
  }
  return out;
}

/**
 * Serie 1. Devuelve por proveedor los intervalos (con motivo) y las horas por
 * motivo + `total` (unión, sin doble conteo de solapamientos).
 *
 * @param {object} p
 * @param {Array} p.detectorEvents
 * @param {Array} [p.healthEvents]
 * @param {object} [p.scheduleEntries] - `{ [provider]: entry }` de provider-schedule.json.
 * @param {string[]} p.providers
 * @param {number} p.desde - ms
 * @param {number} p.hasta - ms
 * @param {function} [p.isActiveAt] - `(provider, ms, entry) => boolean`.
 * @param {number} [p.stepMs]
 */
function gatedByProvider(p) {
  const providers = (p.providers || []).map(normalizeProviderId).filter(Boolean);
  const desde = toMs(p.desde);
  const hasta = toMs(p.hasta);
  const stepMs = p.stepMs || DEFAULT_STEP_MS;
  const isActiveAt = typeof p.isActiveAt === 'function' ? p.isActiveAt : defaultIsActiveAt;
  const quota = quotaGateIntervals(p.detectorEvents, providers, desde, hasta);
  const health = healthGateIntervals(p.healthEvents, providers, desde, hasta);
  const sched = scheduleGateIntervals(p.scheduleEntries, providers, desde, hasta, isActiveAt, stepMs);
  const out = {};
  for (const prov of providers) {
    const intervalos = [...quota[prov], ...health[prov], ...sched[prov]].sort((a, b) => a.desde - b.desde);
    const horas = emptyHoras();
    for (const m of MOTIVOS) {
      horas[m] = hours(measureUnion(intervalos.filter(i => i.motivo === m).map(i => [i.desde, i.hasta])));
    }
    horas.total = hours(measureUnion(intervalos.map(i => [i.desde, i.hasta])));
    out[prov] = {
      horas,
      intervalos: intervalos.map(i => ({ desde: iso(i.desde), hasta: iso(i.hasta), motivo: i.motivo, abierto: i.abierto, horas: hours(i.hasta - i.desde) })),
      _raw: intervalos, // uso interno (singleLeg); el slice lo quita antes de servir
    };
  }
  return out;
}

function defaultIsActiveAt(provider, ms, entry) {
  try {
    return require('../provider-schedule').isProviderActiveNow(provider, ms, { scheduleEntry: entry, auditLogEnabled: false });
  } catch { return true; }
}

// -----------------------------------------------------------------------------
// Serie 2 — cadena agotada con trabajo elegible
// -----------------------------------------------------------------------------

const RAW_ISSUE_RE = /\bissue=(\d+)\b/;
const RAW_FASE_RE = /\bfase=([a-z0-9_-]+)\b/i;

/** Extrae `{issue, fase}` del `raw_excerpt` (`issue=N fase=X pipeline=Y chain=…`). */
function parseChainExcerpt(raw) {
  const s = String(raw || '');
  const mi = RAW_ISSUE_RE.exec(s);
  const mf = RAW_FASE_RE.exec(s);
  return { issue: mi ? Number(mi[1]) : null, fase: mf ? mf[1] : null };
}

/**
 * Serie 2. Cada `gate_blocked_spawn` abre (o prolonga) un intervalo por
 * `skill:issue`; el primer `dispatch_resumed` del mismo `skill:issue` lo cierra.
 * Los abiertos cuentan hasta `hasta`.
 *
 * @returns {{ horas_total:number, horas_union:number, intervalos:Array, por_fase:Object<string,number>, abiertos:number }}
 */
function chainExhausted(p) {
  const desde = toMs(p.desde);
  const hasta = toMs(p.hasta);
  const open = {};
  const done = [];
  for (const { e, t } of sortedEvents(p.detectorEvents)) {
    if (e.event === 'gate_blocked_spawn') {
      const { issue, fase } = parseChainExcerpt(e.raw_excerpt);
      const key = `${e.agent || 'unknown'}:${issue != null ? issue : '?'}`;
      if (!open[key]) open[key] = { start: t, skill: e.agent || 'unknown', issue, fase, chain_hits: 0, ultimo: t };
      open[key].chain_hits += 1;
      open[key].ultimo = t;
    } else if (e.event === 'dispatch_resumed') {
      const { issue } = parseChainExcerpt(e.raw_excerpt);
      const key = `${e.agent || 'unknown'}:${issue != null ? issue : '?'}`;
      if (open[key]) {
        const r = clampRange(open[key].start, t, desde, hasta);
        if (r) done.push({ ...open[key], desde: r[0], hasta: r[1], abierto: false });
        delete open[key];
      }
    }
  }
  for (const key of Object.keys(open)) {
    // Un intervalo abierto sólo se considera vivo si su ÚLTIMO gate_blocked_spawn
    // cae dentro del rango: si dejó de intentarse hace más de un rango entero,
    // lo más probable es que el dropfile se haya resuelto por otra vía (reset
    // de estado, cierre del issue) sin dejar `dispatch_resumed`.
    const o = open[key];
    if (o.ultimo < desde) continue;
    const r = clampRange(o.start, hasta, desde, hasta);
    if (r) done.push({ ...o, desde: r[0], hasta: r[1], abierto: true });
  }
  done.sort((a, b) => a.desde - b.desde);
  const porFase = {};
  let total = 0;
  for (const d of done) {
    const h = d.hasta - d.desde;
    total += h;
    const f = d.fase || 'desconocida';
    porFase[f] = (porFase[f] || 0) + h;
  }
  for (const f of Object.keys(porFase)) porFase[f] = hours(porFase[f]);
  return {
    horas_total: hours(total),
    horas_union: hours(measureUnion(done.map(d => [d.desde, d.hasta]))),
    abiertos: done.filter(d => d.abierto).length,
    por_fase: porFase,
    intervalos: done.map(d => ({
      skill: d.skill, issue: d.issue, fase: d.fase, desde: iso(d.desde), hasta: iso(d.hasta),
      horas: hours(d.hasta - d.desde), intentos: d.chain_hits, abierto: d.abierto,
    })),
  };
}

// -----------------------------------------------------------------------------
// Serie 3 — única pata viva
// -----------------------------------------------------------------------------

/**
 * Serie 3. Barrido temporal con paso `stepMs` sobre los intervalos de la
 * serie 1: en cada paso, "viva" = no gateada por schedule/health/credencial.
 * Cuenta las horas con exactamente UNA pata viva, cuántas de ellas esa pata
 * estuvo gateada por cuota, y las horas con CERO patas vivas.
 *
 * @param {object} gated - resultado de `gatedByProvider` (con `_raw`).
 */
function singleLeg(gated, desde, hasta, stepMs) {
  const step = stepMs || DEFAULT_STEP_MS;
  const providers = Object.keys(gated || {});
  const d = toMs(desde);
  const h = toMs(hasta);
  let unica = 0;
  let unicaGateada = 0;
  let ninguna = 0;
  const porPata = {};
  for (const p of providers) porPata[p] = { horas_unica: 0, horas_unica_gateada: 0 };
  const inAt = (intervals, t, motivos) => intervals.some(i => motivos.includes(i.motivo) && t >= i.desde && t < i.hasta);
  for (let t = d; t < h; t += step) {
    const vivas = providers.filter(p => !inAt((gated[p] && gated[p]._raw) || [], t, MOTIVOS_FUERA_DE_CIRCULACION));
    if (vivas.length === 0) { ninguna += step; continue; }
    if (vivas.length !== 1) continue;
    const p = vivas[0];
    unica += step;
    porPata[p].horas_unica += step;
    if (inAt(gated[p]._raw, t, MOTIVOS_CUOTA)) { unicaGateada += step; porPata[p].horas_unica_gateada += step; }
  }
  for (const p of providers) {
    porPata[p].horas_unica = hours(porPata[p].horas_unica);
    porPata[p].horas_unica_gateada = hours(porPata[p].horas_unica_gateada);
  }
  return {
    horas_unica_pata: hours(unica),
    horas_unica_pata_gateada: hours(unicaGateada),
    horas_sin_patas: hours(ninguna),
    por_pata: porPata,
  };
}

// -----------------------------------------------------------------------------
// Serie 4 — trabajo ganado por unidad de cuota
// -----------------------------------------------------------------------------

/**
 * Serie 4. Por proveedor y fase: fases `ganada` (provider-cost v2, `reliable`)
 * en el rango ÷ puntos de ventana consumidos en el mismo rango (suma de deltas
 * positivos de las muestras del ledger; los reinicios de ventana no cuentan).
 *
 * @param {object} p - { costRecords, samples, providers, desde, hasta, bucket? }
 */
function workPerQuota(p) {
  const desde = toMs(p.desde);
  const hasta = toMs(p.hasta);
  const providers = (p.providers || []).map(normalizeProviderId).filter(Boolean);
  const byProv = prepareSamples(p.samples, { bucket: p.bucket || 'weekly', creditRedemptions: p.creditRedemptions });
  const out = {};
  for (const prov of providers) {
    const samples = (byProv[prov] || []).filter(s => s.ts >= desde && s.ts <= hasta);
    let pts = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].window_reset) continue;
      const delta = samples[i].valor - samples[i - 1].valor;
      if (delta > 0) pts += delta;
    }
    const porFase = {};
    let ganadas = 0;
    let totales = 0;
    for (const r of Array.isArray(p.costRecords) ? p.costRecords : []) {
      if (!r || r.reliable === false || normalizeProviderId(r.provider) !== prov) continue;
      const t = toMs(r.timestamp);
      if (t == null || t < desde || t > hasta) continue;
      const fase = r.fase || 'desconocida';
      const cell = porFase[fase] || (porFase[fase] = { ganadas: 0, totales: 0 });
      cell.totales += 1;
      totales += 1;
      if (r.resultado === 'ganada') { cell.ganadas += 1; ganadas += 1; }
    }
    for (const f of Object.keys(porFase)) {
      porFase[f].ganadas_por_pct = pts > 0 ? Math.round((porFase[f].ganadas / pts) * 1000) / 1000 : null;
    }
    out[prov] = {
      pct_consumido: Math.round(pts * 100) / 100,
      muestras: samples.length,
      ganadas,
      totales,
      ganadas_por_pct: pts > 0 ? Math.round((ganadas / pts) * 1000) / 1000 : null,
      por_fase: porFase,
    };
  }
  return out;
}

// -----------------------------------------------------------------------------
// Snapshot completo
// -----------------------------------------------------------------------------

/**
 * Calcula las cuatro series sobre un rango. Es lo que el slice sirve y lo que
 * `quota-ledger.recordSeriesSnapshot` persiste (append-only, con timestamp).
 *
 * @param {object} p - { providers, desde, hasta, detectorEvents, healthEvents,
 *                       scheduleEntries, isActiveAt, costRecords, samples,
 *                       creditRedemptions, stepMs }
 */
function computeSeries(p) {
  const desde = toMs(p.desde);
  const hasta = toMs(p.hasta);
  const gated = gatedByProvider(p);
  const unica = singleLeg(gated, desde, hasta, p.stepMs);
  const cadena = chainExhausted(p);
  const trabajo = workPerQuota(p);
  const gateado = {};
  for (const prov of Object.keys(gated)) gateado[prov] = { horas: gated[prov].horas, intervalos: gated[prov].intervalos };
  return {
    schema: 1,
    ventana: { desde: iso(desde), hasta: iso(hasta), horas: hours(hasta - desde) },
    gateado,
    cadena_agotada: cadena,
    unica_pata: unica,
    trabajo_por_cuota: trabajo,
  };
}

module.exports = {
  MOTIVOS,
  MOTIVOS_CUOTA,
  MOTIVOS_FUERA_DE_CIRCULACION,
  ERROR_TYPE_VENTANA,
  DEFAULT_STEP_MS,
  gatedByProvider,
  chainExhausted,
  singleLeg,
  workPerQuota,
  computeSeries,
  parseChainExcerpt,
  measureUnion,
};

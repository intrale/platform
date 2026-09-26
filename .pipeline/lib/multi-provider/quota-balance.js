// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// quota-balance.js — Saldo, ritmo y proyección de agotamiento de cuota por
// proveedor y período (#6560).
//
// Programa "Contabilidad y balanceo de cuota por proveedor" (3 de 10). Este
// módulo es EL BALANCE del libro contable: cruza el HABER declarado en
// `config.yaml` (#6559, `getQuotaCeiling`) con el DEBE observado (la serie de
// muestras que persiste `quota-ledger.js`) y responde, por proveedor:
//
//   - cuánto llevamos consumido en el período vigente,
//   - cuánto nos falta (saldo) o por cuánto nos pasamos (excedente),
//   - a qué ritmo vamos (ventana móvil) y cuándo se agota a ese ritmo,
//   - si el período cerrara ahora / al cierre proyectado, cuánto sobra o falta.
//
// PURO por diseño: sin I/O, sin `Date.now()` implícito (el llamador pasa
// `now`), testeable con fixtures. Es el ÚNICO punto donde vive la fórmula
// (CA-5): el ruteo (#6561) lo llama directo y el dashboard (#6565) lo consume
// vía el slice `quotaBalanceSlice` → `/api/dash/quota-balance`. Nadie más
// re-deriva umbrales ni semáforos.
//
// Unidad de medida (decisión documentada en multi-provider.md §19):
//   con `unidad: porcentaje` el consumo acumulado del período ES el % que
//   reporta el proveedor (Claude Max / ChatGPT Plus no publican el cupo en
//   tokens, no hay conversión). Cada muestra del ledger es "consumo acumulado
//   reportado por el proveedor en la unidad del techo"; con unidades absolutas
//   (`tokens`, `mensajes`, `creditos`) la muestra es el acumulado absoluto, y
//   si no hay muestras se cae a la suma de `provider-cost.jsonl` v2 (#6558).
//
// Reglas de honestidad (guru §6 + UX §4):
//   - NUNCA proyectar sobre dato viejo: `ritmo` y `agota_*` son `null` cuando
//     la última muestra no es `fresh` o hay menos muestras que el mínimo.
//   - El excedente es un campo propio ≥ 0; el saldo nunca es negativo.
//   - Un proveedor sin muestras en el período devuelve saldo completo con
//     `confidence: 'missing'` y `estado: 'sin_datos'` — nunca error, y nunca
//     "100 % libre real".
//   - Una caída del % entre muestras es un REINICIO DE VENTANA (reposición o
//     crédito de reset de codex, #7185), no consumo negativo: se marca y el
//     ritmo se calcula desde la muestra posterior al reinicio.
// =============================================================================
'use strict';

const { getQuotaCeiling, listQuotaCeilings, normalizeProviderId } = require('./validate-quota-ceilings');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Longitud del período por `periodo` declarado. */
const PERIOD_MS = Object.freeze({ horario: HOUR_MS, diario: DAY_MS, semanal: WEEK_MS });

/** Día abreviado de `reposicion` semanal → getUTCDay() (0 = domingo). */
const DIAS = Object.freeze({ dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 });

/** Estados del veredicto (UX §1 + `sin_proyeccion` para "fresco pero sin ritmo"). */
const ESTADOS = Object.freeze([
  'alcanza',          // proyección de agotamiento ≥ cierre del período (o ritmo 0)
  'se_agota_antes',   // proyección < cierre del período
  'excedido',         // consumo > techo
  'sin_datos',        // sin muestras en el período (confidence: missing)
  'desactualizado',   // última muestra stale — sin proyección
  'sin_proyeccion',   // muestra fresca pero sin ritmo (muestras < mínimo o Δt = 0)
]);

/** Motivos de reinicio de ventana (UX §5). */
const RESET_MOTIVOS = Object.freeze(['reposicion', 'credito']);

const DEFAULTS = Object.freeze({
  ventanaMovilMin: 60,       // ventana móvil del ritmo (PO: documentado en el PR)
  minMuestras: 3,            // mínimo de muestras en la ventana para proyectar (guru §6)
  staleAfterMs: 30 * 60000,  // última muestra más vieja que esto ⇒ 'stale' (misma escala que anthropic-usage)
  resetDropPts: 2,           // caída de % entre muestras ≥ esto ⇒ reinicio de ventana (tolerancia de redondeo)
  creditoWindowMs: 15 * 60000, // un canje de crédito (#7185) a ±15 min del reinicio lo explica
  bucket: 'weekly',          // bucket del ledger que agrega el período declarado (ventana larga)
  ritmoMinimo: 1e-3,         // pendiente (pts/h) por debajo de la cual el ritmo es 0
});

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function toMs(v) {
  if (v == null || v === '') return null;
  if (isFiniteNum(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const MAX_DATE_MS = 8.64e15; // rango válido de Date
function iso(ms) { return isFiniteNum(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null; }
function round(v, d = 2) {
  if (!isFiniteNum(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// -----------------------------------------------------------------------------
// Período vigente
// -----------------------------------------------------------------------------

/**
 * Último corte de reposición FIJA (no rolling) anterior o igual a `nowMs`, en
 * UTC. Misma aritmética que `weekly-quota.js#getLastWeeklyResetMs` (hora local
 * = UTC + tz_offset_min, con getters UTC sobre el instante desplazado), pero
 * parametrizada por `periodo`/`reposicion` del techo declarado.
 *
 * @param {{periodo:string, reposicion:string, tz_offset_min:number}} ceiling
 * @param {number} nowMs
 * @returns {number|null} ms UTC del último corte, o null si no se puede derivar.
 */
function lastFixedResetMs(ceiling, nowMs) {
  if (!ceiling || typeof ceiling.reposicion !== 'string' || ceiling.reposicion === 'rolling') return null;
  const tz = isFiniteNum(ceiling.tz_offset_min) ? ceiling.tz_offset_min : -180;
  const local = new Date(nowMs + tz * 60000);
  const cut = new Date(local.getTime());
  const rep = ceiling.reposicion.trim();

  if (ceiling.periodo === 'semanal') {
    const m = /^(lun|mar|mie|jue|vie|sab|dom) (\d{2}):(\d{2})$/.exec(rep);
    if (!m) return null;
    const day = DIAS[m[1]];
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    cut.setUTCHours(hh, mm, 0, 0);
    let daysBack = (local.getUTCDay() - day + 7) % 7;
    if (daysBack === 0 && local.getTime() < cut.getTime()) daysBack = 7;
    cut.setUTCDate(cut.getUTCDate() - daysBack);
  } else if (ceiling.periodo === 'diario') {
    const m = /^(\d{2}):(\d{2})$/.exec(rep);
    if (!m) return null;
    cut.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    if (local.getTime() < cut.getTime()) cut.setUTCDate(cut.getUTCDate() - 1);
  } else if (ceiling.periodo === 'horario') {
    const m = /^:(\d{2})$/.exec(rep);
    if (!m) return null;
    cut.setUTCMinutes(Number(m[1]), 0, 0);
    if (local.getTime() < cut.getTime()) cut.setUTCHours(cut.getUTCHours() - 1);
  } else {
    return null;
  }
  return cut.getTime() - tz * 60000;
}

/**
 * Límites del período vigente para un techo.
 *
 *   - reposición fija: inicio = último corte; cierre = inicio + longitud.
 *   - rolling: el proveedor informa el cierre (`reset_at` de la muestra más
 *     reciente); inicio = cierre − longitud. Sin `reset_at` no hay cierre
 *     conocido: inicio = ahora − longitud (ventana móvil desde el primer uso),
 *     `cierre_periodo_at: null`.
 *
 * @returns {{inicio:number, cierre:number|null, fuente:'fija'|'rolling'|'rolling_sin_reset'}}
 */
function periodBounds(ceiling, nowMs, latestResetAtMs) {
  const len = PERIOD_MS[ceiling.periodo] || WEEK_MS;
  if (!ceiling.rolling) {
    const inicio = lastFixedResetMs(ceiling, nowMs);
    if (inicio != null) return { inicio, cierre: inicio + len, fuente: 'fija' };
  }
  if (isFiniteNum(latestResetAtMs) && latestResetAtMs > nowMs - len) {
    return { inicio: latestResetAtMs - len, cierre: latestResetAtMs, fuente: 'rolling' };
  }
  return { inicio: nowMs - len, cierre: null, fuente: 'rolling_sin_reset' };
}

// -----------------------------------------------------------------------------
// Muestras
// -----------------------------------------------------------------------------

/**
 * Normaliza una muestra del ledger (o de un fixture). Devuelve null si no es
 * utilizable (sin proveedor, sin timestamp o sin valor numérico).
 *
 * Shape aceptado: `{ ts, provider, bucket, pct|valor, reset_at, confidence,
 * source, window_reset, reset_motivo }`.
 */
function normalizeSample(s) {
  if (!s || typeof s !== 'object') return null;
  const provider = normalizeProviderId(s.provider);
  const ts = toMs(s.ts != null ? s.ts : s.timestamp);
  const raw = s.valor != null ? s.valor : s.pct;
  const valor = Number(raw);
  if (!provider || ts == null || !Number.isFinite(valor)) return null;
  return {
    ts,
    provider,
    bucket: typeof s.bucket === 'string' ? s.bucket : DEFAULTS.bucket,
    valor,
    reset_at: toMs(s.reset_at),
    confidence: s.confidence === 'fresh' || s.confidence === 'stale' ? s.confidence : 'missing',
    source: typeof s.source === 'string' ? s.source : null,
    window_reset: s.window_reset === true,
    reset_motivo: RESET_MOTIVOS.includes(s.reset_motivo) ? s.reset_motivo : null,
  };
}

/**
 * Detecta reinicios de ventana entre muestras consecutivas del mismo
 * proveedor/bucket (ordenadas por ts): cambio de `reset_at` hacia adelante o
 * caída del acumulado ≥ `resetDropPts`. Marca la muestra POSTERIOR al reinicio
 * (`window_reset: true`) con su motivo: `credito` si hay un canje de crédito
 * (#7185) a ±`creditoWindowMs`, `reposicion` en cualquier otro caso. Respeta
 * las marcas que ya vienen del ledger.
 *
 * @param {Array} samples - normalizadas y ordenadas por ts asc.
 * @param {Array<{provider:string, redeemed_at:*}>} [redemptions]
 */
function markWindowResets(samples, redemptions, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const credits = (Array.isArray(redemptions) ? redemptions : [])
    .map(r => ({ provider: normalizeProviderId(r && r.provider), at: toMs(r && r.redeemed_at) }))
    .filter(r => r.provider && r.at != null);
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (cur.window_reset) {
      if (!cur.reset_motivo) cur.reset_motivo = creditoCerca(credits, cur, o) ? 'credito' : 'reposicion';
      continue;
    }
    const resetMoved = prev.reset_at != null && cur.reset_at != null && cur.reset_at > prev.reset_at;
    const dropped = prev.valor - cur.valor >= o.resetDropPts;
    if (resetMoved || dropped) {
      cur.window_reset = true;
      cur.reset_motivo = creditoCerca(credits, cur, o) ? 'credito' : 'reposicion';
    }
  }
  return samples;
}

function creditoCerca(credits, sample, o) {
  return credits.some(c => c.provider === sample.provider && Math.abs(c.at - sample.ts) <= o.creditoWindowMs);
}

/**
 * Agrupa, normaliza, ordena y marca reinicios. Devuelve `{ [provider]: samples[] }`
 * sólo con el bucket pedido.
 */
function prepareSamples(samples, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const byProv = {};
  for (const raw of Array.isArray(samples) ? samples : []) {
    const s = normalizeSample(raw);
    if (!s || s.bucket !== o.bucket) continue;
    (byProv[s.provider] || (byProv[s.provider] = [])).push(s);
  }
  for (const p of Object.keys(byProv)) {
    byProv[p].sort((a, b) => a.ts - b.ts);
    markWindowResets(byProv[p], o.creditRedemptions, o);
  }
  return byProv;
}

/**
 * Pendiente por mínimos cuadrados (puntos/hora) de `valor` sobre `ts`.
 * Devuelve null si hay < 2 puntos o Δt = 0. Con ≥ 2 puntos y consumo
 * monótono, aproxima la derivada suavizando el ruido de redondeo del %.
 */
function slopePerHour(points) {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0].ts;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const p of points) {
    const x = (p.ts - t0) / HOUR_MS;
    sx += x; sy += p.valor; sxx += x * x; sxy += x * p.valor;
  }
  const den = n * sxx - sx * sx;
  if (den <= 0) return null; // todas las muestras en el mismo instante
  return (n * sxy - sx * sy) / den;
}

/**
 * Consumo acumulado desde `provider-cost.jsonl` (v2, `reliable`) para techos
 * en unidad absoluta `tokens` cuando no hay muestras del proveedor.
 */
function consumoDesdeCostos(costRecords, provider, inicioMs, nowMs) {
  let total = 0;
  let n = 0;
  for (const r of Array.isArray(costRecords) ? costRecords : []) {
    if (!r || r.reliable === false || normalizeProviderId(r.provider) !== provider) continue;
    const t = toMs(r.timestamp);
    if (t == null || t < inicioMs || t > nowMs) continue;
    total += (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0);
    n += 1;
  }
  return { total, n };
}

// -----------------------------------------------------------------------------
// Balance por proveedor
// -----------------------------------------------------------------------------

/**
 * Balance de UN proveedor. `samples` ya preparadas (ordenadas, marcadas) de su
 * bucket largo. Ver `computeQuotaBalance` para el shape.
 */
function balanceForProvider(ceiling, samples, nowMs, o) {
  const techo = ceiling.techo;
  const latest = samples.length ? samples[samples.length - 1] : null;
  const bounds = periodBounds(ceiling, nowMs, latest ? latest.reset_at : null);

  // Muestras dentro del período vigente. Un reinicio de ventana observado
  // DESPUÉS del inicio calculado (crédito de codex, drift del proveedor) corre
  // el inicio efectivo: lo que había antes pertenece al período anterior.
  let inPeriod = samples.filter(s => s.ts >= bounds.inicio && s.ts <= nowMs);
  let ultimoReset = null;
  for (const s of inPeriod) {
    if (s.window_reset) ultimoReset = { at: iso(s.ts), motivo: s.reset_motivo || 'reposicion' };
  }
  if (ultimoReset) {
    const resetTs = toMs(ultimoReset.at);
    inPeriod = inPeriod.filter(s => s.ts >= resetTs);
    if (resetTs > bounds.inicio) bounds.inicio = resetTs;
  }

  const out = {
    provider: ceiling.provider,
    plan: ceiling.plan,
    periodo: ceiling.periodo,
    unidad: ceiling.unidad,
    techo,
    reposicion: ceiling.reposicion,
    rolling: ceiling.rolling,
    periodo_inicio_at: iso(bounds.inicio),
    cierre_periodo_at: iso(bounds.cierre),
    cierre_en_ms: bounds.cierre != null ? Math.max(0, bounds.cierre - nowMs) : null,
    cierre_fuente: bounds.fuente,
    consumo: 0,
    consumo_pct: 0,
    saldo_pts: techo,
    excedente_pts: 0,
    balance_pts: techo,          // techo − consumo, con signo: "si cerrara ahora"
    ritmo_pts_por_hora: null,
    agota_at: null,
    agota_en_ms: null,
    al_cierre_pts: null,         // saldo proyectado al cierre, con signo
    estado: 'sin_datos',
    confidence: 'missing',
    muestra_at: null,
    muestras: 0,
    ventana_movil_min: o.ventanaMovilMin,
    min_muestras: o.minMuestras,
    ultimo_reset: ultimoReset,
    fuente: null,
  };

  // Consumo acumulado del período.
  let consumo = null;
  let confidence = 'missing';
  let muestraTs = null;
  const last = inPeriod.length ? inPeriod[inPeriod.length - 1] : null;
  if (last) {
    consumo = last.valor;
    muestraTs = last.ts;
    const age = nowMs - last.ts;
    confidence = last.confidence === 'missing' ? 'missing' : (age > o.staleAfterMs ? 'stale' : last.confidence);
    out.fuente = last.source || 'ledger';
  } else if (ceiling.unidad === 'tokens' && o.costRecords) {
    const c = consumoDesdeCostos(o.costRecords, ceiling.provider, bounds.inicio, nowMs);
    if (c.n > 0) {
      consumo = c.total;
      confidence = 'fresh';
      muestraTs = nowMs;
      out.fuente = 'provider-cost';
    }
  }

  if (consumo == null) return out; // sin datos ⇒ saldo completo (CA-4), estado sin_datos

  const consumoClamped = Math.max(0, consumo);
  out.consumo = round(consumoClamped);
  out.consumo_pct = techo > 0 ? round((consumoClamped / techo) * 100) : null;
  out.saldo_pts = round(Math.max(0, techo - consumoClamped));
  out.excedente_pts = round(Math.max(0, consumoClamped - techo));
  out.balance_pts = round(techo - consumoClamped);
  out.confidence = confidence;
  out.muestra_at = iso(muestraTs);

  // Ritmo en ventana móvil (sólo con dato fresco y muestras suficientes).
  const windowStart = muestraTs - o.ventanaMovilMin * 60000;
  const windowPts = inPeriod.filter(s => s.ts >= windowStart && s.confidence !== 'missing');
  out.muestras = windowPts.length;
  let ritmo = null;
  if (confidence === 'fresh' && windowPts.length >= o.minMuestras) {
    const slope = slopePerHour(windowPts);
    // El consumo acumulado no baja: pendiente negativa o ínfima (ruido de
    // punto flotante / redondeo del %) se toma como 0 — nunca proyecta al infinito.
    if (slope != null) ritmo = slope > o.ritmoMinimo ? slope : 0;
  }
  out.ritmo_pts_por_hora = ritmo != null ? round(ritmo, 3) : null;

  // Estado + proyección.
  if (consumoClamped > techo) {
    out.estado = 'excedido';
  } else if (confidence === 'missing') {
    out.estado = 'sin_datos';
  } else if (confidence === 'stale') {
    out.estado = 'desactualizado';
  } else if (ritmo == null) {
    out.estado = 'sin_proyeccion';
  }

  if (ritmo != null) {
    const saldoReal = techo - consumoClamped; // puede ser negativo si excedido
    if (ritmo > 0 && saldoReal > 0) {
      const agotaMs = muestraTs + (saldoReal / ritmo) * HOUR_MS;
      out.agota_at = iso(agotaMs);
      out.agota_en_ms = Math.max(0, Math.round(agotaMs - nowMs));
    }
    if (bounds.cierre != null) {
      const horasHastaCierre = Math.max(0, bounds.cierre - muestraTs) / HOUR_MS;
      out.al_cierre_pts = round(saldoReal - ritmo * horasHastaCierre);
    }
    if (out.estado !== 'excedido') {
      if (out.agota_at == null) out.estado = 'alcanza';                 // ritmo 0: no se agota
      else if (bounds.cierre == null) out.estado = 'se_agota_antes';    // cierre desconocido: conservador
      else out.estado = toMs(out.agota_at) >= bounds.cierre ? 'alcanza' : 'se_agota_antes';
    }
  } else if (out.estado === 'excedido') {
    // Excedido sin ritmo: al cierre falta al menos el excedente.
    out.al_cierre_pts = round(techo - consumoClamped);
  }

  return out;
}

/**
 * Balance de cuota de todos los proveedores con techo declarado (CA-1..CA-5).
 *
 * @param {object} config - `config.yaml` parseado (fuente de `multi_provider.quota`).
 * @param {Array} samples - muestras del ledger (ver `normalizeSample`); pueden
 *                          venir de varios proveedores/buckets mezclados.
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {string[]} [opts.providers] - subconjunto de proveedores (default: todos los declarados).
 * @param {number} [opts.ventanaMovilMin=60]
 * @param {number} [opts.minMuestras=3]
 * @param {number} [opts.staleAfterMs=1800000]
 * @param {Array} [opts.creditRedemptions] - canjes de #7185 `{provider, redeemed_at}`.
 * @param {Array} [opts.costRecords] - `readProviderCostRecords()` (sólo techos en tokens).
 * @param {object} [opts.env] - para `QUOTA_TZ_OFFSET_MIN`.
 * @returns {{schema:number, computed_at:string, ventana_movil_min:number, min_muestras:number, providers:Object<string,object>}}
 */
function computeQuotaBalance(config, samples, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const nowMs = isFiniteNum(o.now) ? o.now : Date.now();
  const ceilings = listQuotaCeilings(config, { env: o.env });
  const wanted = Array.isArray(o.providers) && o.providers.length
    ? o.providers.map(normalizeProviderId).filter(Boolean)
    : Object.keys(ceilings);
  const byProv = prepareSamples(samples, o);
  const providers = {};
  for (const id of wanted) {
    const ceiling = ceilings[id] || getQuotaCeiling(config, id, { env: o.env });
    if (!ceiling) continue; // sin techo declarado: NO se asume infinito, no se reporta
    providers[id] = balanceForProvider(ceiling, byProv[id] || [], nowMs, o);
  }
  return {
    schema: 1,
    computed_at: iso(nowMs),
    ventana_movil_min: o.ventanaMovilMin,
    min_muestras: o.minMuestras,
    providers,
  };
}

module.exports = {
  DEFAULTS,
  ESTADOS,
  RESET_MOTIVOS,
  PERIOD_MS,
  computeQuotaBalance,
  balanceForProvider,
  lastFixedResetMs,
  periodBounds,
  normalizeSample,
  markWindowResets,
  prepareSamples,
  slopePerHour,
  consumoDesdeCostos,
};

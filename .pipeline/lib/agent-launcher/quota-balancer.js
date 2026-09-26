// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// quota-balancer.js — Balanceo de carga entre proveedores por saldo de cuota y
// ritmo de consumo (#6561).
//
// Programa "Contabilidad y balanceo de cuota por proveedor" (4 de 10). Es la
// CAPA DE DECISIÓN del libro contable: con el balance de #6560 (`saldo_pts`,
// `techo`, `ritmo_pts_por_hora`, `confidence`) ordena la cadena de un skill
// (primario + `fallbacks[]`) para que el dispatcher prefiera al proveedor con
// mayor saldo relativo, en vez de fundir uno mientras otro queda sin usar.
//
// Qué hace y qué NO hace (CA-3, guru §2, PO §1):
//   - NO expande la cadena: sólo REORDENA los candidatos que el skill ya tiene
//     declarados. La capacidad por fase la garantiza `agent-models-validate.js`
//     sobre la cadena declarada, y acá se respeta por construcción.
//   - NO decide disponibilidad: los hard gates (cuota agotada, kill-switch,
//     horario, pacing rojo, health rojo, credencial) los aplica el dispatcher
//     ANTES y DESPUÉS de este plan; un candidato hard-gated se descarta aunque
//     este módulo lo rankee primero.
//   - El orden declarado por agente define el CONJUNTO y el DESEMPATE: sólo se
//     reordena cuando la diferencia de saldo relativo supera `delta_min_pct`
//     (anti-flapping, PO §2). Por debajo del umbral gana el orden declarado.
//   - Reserva de fin de período (cambio 3): fuera de las `fases_criticas`, un
//     candidato con saldo relativo < `margen_reserva_pct` queda "reservado" y
//     se rankea DESPUÉS de los no reservados. Nunca es un veto: si es el único
//     hábil, el dispatcher lo usa igual (PO §4).
//   - Degradación (CA-5): sin balance, sin ledger, con dato viejo (`stale`) o
//     con menos de dos candidatos comparables ⇒ orden declarado, regla
//     `degradado` con el motivo explícito (UX §4: nunca silencioso).
//   - Honestidad (#6560): un candidato sin dato fresco NO participa de la
//     comparación y conserva su posición declarada; los que sí participan se
//     reordenan entre las posiciones que ellos ocupaban.
//
// PURO por diseño: sin I/O, sin `Date.now()`. La lectura del ledger vive en
// `readQuotaBalanceForDispatch` (única función con I/O, inyectable y con
// caché corta) para que el camino caliente del dispatcher no relea el archivo
// en cada spawn de una ráfaga.
// =============================================================================
'use strict';

const HOUR_MS = 3600 * 1000;

/** Defaults de `multi_provider.balanceo` (config.yaml). */
const DEFAULTS = Object.freeze({
  enabled: true,
  delta_min_pct: 15,                                   // diferencia mínima de saldo relativo para reordenar
  fases_criticas: Object.freeze(['verificacion', 'aprobacion', 'delivery']),
  margen_reserva_pct: 20,                              // saldo relativo bajo el cual se reserva para fases críticas
  cache_ttl_ms: 30 * 1000,                             // caché en memoria del balance leído del ledger
  ledger_window_ms: 8 * 24 * HOUR_MS,                  // misma ventana que quotaBalanceSlice
});

/** Reglas que puede aplicar el plan (UX §6). */
const REGLAS = Object.freeze(['saldo', 'orden', 'degradado', 'reserva']);

/** Motivos de degradación (UX §4: reutiliza el enumerado de #6560, sin sinónimos). */
const DEGRADADO_MOTIVOS = Object.freeze([
  'deshabilitado',      // multi_provider.balanceo.enabled: false
  'sin_balance',        // no hubo balance (sin config, sin ledger o error de lectura)
  'sin_datos',          // ningún candidato tiene muestras en el período
  'desactualizado',     // los datos existentes son stale
  'sin_techo',          // los candidatos no tienen techo declarado
  'un_solo_candidato',  // cadena de un eslabón: no hay nada que balancear
  'insuficiente',       // sólo un candidato con dato fresco: no hay comparación posible
]);

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round(v, d = 1) {
  if (!isFiniteNum(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

/**
 * Lee y normaliza `multi_provider.balanceo` de la config parseada. Tipos y
 * rangos inválidos caen al default (fail-open a la política por defecto: un
 * typo en el YAML nunca frena el spawn ni apaga el balanceo en silencio — el
 * campo `warnings` lo deja registrado).
 */
function readBalanceoConfig(config) {
  const raw = config && typeof config === 'object'
    && config.multi_provider && typeof config.multi_provider === 'object'
    && config.multi_provider.balanceo && typeof config.multi_provider.balanceo === 'object'
    ? config.multi_provider.balanceo : {};
  const warnings = [];
  const out = {
    enabled: DEFAULTS.enabled,
    delta_min_pct: DEFAULTS.delta_min_pct,
    fases_criticas: DEFAULTS.fases_criticas.slice(),
    margen_reserva_pct: DEFAULTS.margen_reserva_pct,
    cache_ttl_ms: DEFAULTS.cache_ttl_ms,
    ledger_window_ms: DEFAULTS.ledger_window_ms,
  };
  if (raw.enabled != null) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warnings.push('enabled: se esperaba booleano');
  }
  if (raw.delta_min_pct != null) {
    const v = Number(raw.delta_min_pct);
    if (Number.isFinite(v) && v >= 0 && v <= 100) out.delta_min_pct = v;
    else warnings.push('delta_min_pct: se esperaba número en [0,100]');
  }
  if (raw.margen_reserva_pct != null) {
    const v = Number(raw.margen_reserva_pct);
    if (Number.isFinite(v) && v >= 0 && v <= 100) out.margen_reserva_pct = v;
    else warnings.push('margen_reserva_pct: se esperaba número en [0,100]');
  }
  if (raw.fases_criticas != null) {
    if (Array.isArray(raw.fases_criticas) && raw.fases_criticas.every((f) => typeof f === 'string')) {
      out.fases_criticas = raw.fases_criticas.map((f) => f.trim()).filter(Boolean);
    } else {
      warnings.push('fases_criticas: se esperaba lista de strings');
    }
  }
  if (raw.cache_ttl_ms != null) {
    const v = Number(raw.cache_ttl_ms);
    if (Number.isFinite(v) && v >= 0 && v <= 10 * 60 * 1000) out.cache_ttl_ms = v;
    else warnings.push('cache_ttl_ms: se esperaba número en [0,600000]');
  }
  out.warnings = warnings;
  return out;
}

// -----------------------------------------------------------------------------
// Candidatos
// -----------------------------------------------------------------------------

/**
 * Proyecta un candidato de la cadena sobre su balance (#6560). `participa` es
 * true SÓLO con dato fresco y saldo relativo numérico: un `stale`/`missing` no
 * entra en la comparación (regla de honestidad: nunca decidir sobre dato viejo).
 */
function describeCandidate(provider, indexDeclarado, entry) {
  const c = {
    provider,
    orden_declarado: indexDeclarado,
    saldo_relativo: null,
    saldo_pts: null,
    techo: null,
    consumo_pct: null,
    ritmo_pts_por_hora: null,
    agota_at: null,
    estado: 'sin_datos',
    confidence: 'missing',
    participa: false,
    reservado: false,
    motivo: null,
  };
  if (!entry || typeof entry !== 'object') {
    c.estado = 'sin_techo';
    c.motivo = 'sin techo declarado o sin balance';
    return c;
  }
  c.techo = isFiniteNum(entry.techo) ? entry.techo : null;
  c.saldo_pts = isFiniteNum(entry.saldo_pts) ? entry.saldo_pts : null;
  c.consumo_pct = isFiniteNum(entry.consumo_pct) ? entry.consumo_pct : null;
  c.ritmo_pts_por_hora = isFiniteNum(entry.ritmo_pts_por_hora) ? entry.ritmo_pts_por_hora : null;
  c.agota_at = typeof entry.agota_at === 'string' ? entry.agota_at : null;
  c.estado = typeof entry.estado === 'string' ? entry.estado : 'sin_datos';
  c.confidence = entry.confidence === 'fresh' || entry.confidence === 'stale' ? entry.confidence : 'missing';
  if (c.techo != null && c.techo > 0 && c.saldo_pts != null) {
    c.saldo_relativo = round((Math.max(0, c.saldo_pts) / c.techo) * 100, 1);
  }
  c.participa = c.confidence === 'fresh' && c.saldo_relativo != null;
  if (!c.participa) {
    c.motivo = c.confidence === 'stale' ? 'dato desactualizado: no participa'
      : c.saldo_relativo == null ? 'sin saldo calculable: no participa'
        : 'sin datos en el período: no participa';
  }
  return c;
}

/**
 * Ordena un grupo de candidatos que participan aplicando la regla de saldo con
 * umbral y desempate por orden declarado (greedy): en cada paso gana el de
 * mayor saldo relativo, salvo que el primero por orden declarado esté a menos
 * de `deltaMin` puntos — en ese caso gana el orden declarado.
 */
function rankBySaldo(group, deltaMin) {
  const rest = group.slice().sort((a, b) => a.orden_declarado - b.orden_declarado);
  const out = [];
  while (rest.length) {
    let best = rest[0];
    for (const c of rest) {
      if (c.saldo_relativo > best.saldo_relativo
        || (c.saldo_relativo === best.saldo_relativo && c.orden_declarado < best.orden_declarado)) best = c;
    }
    const first = rest[0];
    const winner = (best !== first && best.saldo_relativo - first.saldo_relativo < deltaMin) ? first : best;
    out.push(winner);
    rest.splice(rest.indexOf(winner), 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Plan
// -----------------------------------------------------------------------------

/**
 * Arma el plan de balanceo para una cadena.
 *
 * @param {object} opts
 * @param {string[]} opts.chain - proveedores en orden declarado (primario primero).
 * @param {object|null} opts.balance - `computeQuotaBalance(...).providers` (mapa por id) o null.
 * @param {object} [opts.policy] - salida de `readBalanceoConfig` (o config cruda).
 * @param {string} [opts.fase] - fase del pipeline que se despacha.
 * @returns {{regla:string, elegido:string|null, orden:string[], rank:Object<string,number>,
 *   umbral:number, margen_reserva_pct:number, fase:string|null, fase_critica:boolean,
 *   fuente:'fresh'|'degradado', degradado_motivo:string|null, candidatos:object[],
 *   reordeno:boolean, resumen:string}}
 */
function planQuotaBalance(opts = {}) {
  const chain = Array.isArray(opts.chain) ? opts.chain.filter((p) => typeof p === 'string' && p) : [];
  const policy = opts.policy && Array.isArray(opts.policy.warnings) ? opts.policy : readBalanceoConfig(opts.policy ? { multi_provider: { balanceo: opts.policy } } : null);
  const fase = typeof opts.fase === 'string' && opts.fase ? opts.fase : null;
  const faseCritica = fase != null && policy.fases_criticas.includes(fase);
  const balance = opts.balance && typeof opts.balance === 'object' ? opts.balance : null;

  const candidatos = chain.map((p, i) => describeCandidate(p, i, balance ? balance[p] : null));
  const plan = {
    regla: 'orden',
    elegido: chain.length ? chain[0] : null,
    orden: chain.slice(),
    rank: {},
    umbral: policy.delta_min_pct,
    margen_reserva_pct: policy.margen_reserva_pct,
    fase,
    fase_critica: faseCritica,
    fuente: 'degradado',
    degradado_motivo: null,
    candidatos,
    reordeno: false,
    resumen: '',
  };

  const finish = () => {
    plan.orden.forEach((p, i) => { plan.rank[p] = i; });
    plan.elegido = plan.orden.length ? plan.orden[0] : null;
    plan.reordeno = plan.orden.some((p, i) => p !== chain[i]);
    plan.resumen = buildResumen(plan);
    return plan;
  };

  if (!policy.enabled) { plan.regla = 'degradado'; plan.degradado_motivo = 'deshabilitado'; return finish(); }
  if (chain.length < 2) { plan.regla = 'orden'; plan.degradado_motivo = 'un_solo_candidato'; return finish(); }
  if (!balance) { plan.regla = 'degradado'; plan.degradado_motivo = 'sin_balance'; return finish(); }

  const participantes = candidatos.filter((c) => c.participa);
  if (participantes.length < 2) {
    plan.regla = 'degradado';
    // Prioridad del motivo: lo más accionable para el operador primero.
    if (candidatos.every((c) => c.estado === 'sin_techo')) plan.degradado_motivo = 'sin_techo';
    else if (candidatos.some((c) => c.confidence === 'stale')) plan.degradado_motivo = 'desactualizado';
    else if (participantes.length === 1) plan.degradado_motivo = 'insuficiente';
    else plan.degradado_motivo = 'sin_datos';
    return finish();
  }

  // Reserva de fin de período: fuera de fases críticas, los que están bajo el
  // margen van al fondo del grupo. Si TODOS están reservados no hay a quién
  // priorizar: la reserva no aplica (sigue siendo soft por construcción).
  plan.fuente = 'fresh';
  let libres = participantes;
  let reservados = [];
  if (!faseCritica && policy.margen_reserva_pct > 0) {
    libres = participantes.filter((c) => c.saldo_relativo >= policy.margen_reserva_pct);
    reservados = participantes.filter((c) => c.saldo_relativo < policy.margen_reserva_pct);
    if (libres.length === 0) { libres = participantes; reservados = []; }
  }
  for (const c of reservados) {
    c.reservado = true;
    c.motivo = `reservado para fases críticas (saldo ${c.saldo_relativo} % < margen ${policy.margen_reserva_pct} %)`;
  }
  const rankedLibres = rankBySaldo(libres, policy.delta_min_pct);
  const rankedReservados = rankBySaldo(reservados, policy.delta_min_pct);
  const ranked = rankedLibres.concat(rankedReservados);

  // Los participantes se reparten las posiciones que ellos mismos ocupaban;
  // los que no participan conservan su posición declarada.
  const slots = participantes.map((c) => c.orden_declarado).sort((a, b) => a - b);
  const orden = chain.slice();
  ranked.forEach((c, k) => { orden[slots[k]] = c.provider; });
  plan.orden = orden;

  // Regla aplicada en la CABEZA (lo que decide el spawn). `reserva` sólo si la
  // reserva CAMBIÓ el resultado respecto de la regla de saldo pura; si el saldo
  // solo ya elegía al mismo, la regla es `saldo`.
  const declaradoPrimero = candidatos[0];
  const cabeza = candidatos.find((c) => c.provider === orden[0]);
  const sinReserva = rankBySaldo(participantes, policy.delta_min_pct);
  if (cabeza.provider === declaradoPrimero.provider) {
    plan.regla = 'orden';
  } else if (sinReserva[0] && sinReserva[0].provider === cabeza.provider) {
    plan.regla = 'saldo';
  } else {
    plan.regla = 'reserva';
  }
  for (const c of participantes) {
    if (c.motivo) continue;
    if (c === cabeza) {
      c.motivo = plan.regla === 'orden'
        ? (declaradoPrimero.participa ? 'orden declarado (delta < umbral o mayor saldo)' : 'orden declarado')
        : `mayor saldo relativo (${c.saldo_relativo} %)`;
    } else if (declaradoPrimero.participa && c.saldo_relativo < cabeza.saldo_relativo) {
      c.motivo = `saldo relativo menor (${c.saldo_relativo} % vs ${cabeza.saldo_relativo} %)`;
    } else {
      c.motivo = 'orden declarado (desempate)';
    }
  }
  return finish();
}

function fmtPct(v) { return v == null ? '—' : `${round(v, 0)} %`; }

/** Texto corto para el sufijo del happy path / línea `Regla:` (UX §2/§3). */
function buildResumen(plan) {
  const saldos = plan.candidatos
    .map((c) => `${c.provider} ${c.participa ? fmtPct(c.saldo_relativo) : `(${c.confidence === 'stale' ? 'desactualizado' : c.estado === 'sin_techo' ? 'sin_techo' : 'sin_datos'})`}`)
    .join(' · ');
  if (plan.regla === 'degradado') {
    return `degradado (${plan.degradado_motivo}) → orden declarado`;
  }
  if (plan.degradado_motivo === 'un_solo_candidato') return 'un solo candidato → orden declarado';
  const first = plan.candidatos[0];
  const head = plan.candidatos.find((c) => c.provider === plan.elegido);
  const delta = first && head && first.participa && head.participa ? round(head.saldo_relativo - first.saldo_relativo, 0) : null;
  if (plan.regla === 'orden') {
    // Si el primero declarado tiene el mayor saldo, lo decimos; si no, el delta
    // no alcanzó el umbral (UX §4: distinguir "parecidos" de "sin datos").
    const top = Math.max(...plan.candidatos.filter((c) => c.participa).map((c) => c.saldo_relativo));
    const reason = first && first.participa && first.saldo_relativo >= top ? 'mayor saldo' : `delta < ${plan.umbral}`;
    return `${saldos}, ${reason} → orden declarado`;
  }
  if (plan.regla === 'reserva') {
    return `${saldos}, ${first.provider} reservado (< ${plan.margen_reserva_pct} %, fase=${plan.fase || '?'}) → ${plan.elegido}`;
  }
  return `${saldos}, delta ${delta != null ? delta : '?'} ≥ umbral ${plan.umbral} → ${plan.elegido}`;
}

/** Línea `Regla:` del bloque multilínea (UX §3). */
function formatRuleLine(plan) {
  if (!plan) return null;
  return `Balanceo: regla=${plan.regla} (${plan.resumen}) · restricciones respetadas: hard-gates ✓ capacidad ✓ horario ✓ orden=desempate`;
}

/** Shape ESTRUCTURADO del audit `balance_by_quota` (UX §6). Sin material sensible. */
function toAuditEntry(plan) {
  return {
    elegido: plan.elegido,
    regla: plan.regla,
    fuente: plan.fuente,
    degradado_motivo: plan.degradado_motivo,
    umbral: plan.umbral,
    margen_reserva_pct: plan.margen_reserva_pct,
    fase: plan.fase,
    fase_critica: plan.fase_critica,
    orden: plan.orden.slice(),
    candidatos: plan.candidatos.map((c) => ({
      provider: c.provider,
      orden_declarado: c.orden_declarado,
      saldo_relativo: c.saldo_relativo,
      ritmo_pts_por_hora: c.ritmo_pts_por_hora,
      agota_at: c.agota_at,
      estado: c.estado,
      confidence: c.confidence,
      participa: c.participa,
      reservado: c.reservado,
      motivo: c.motivo,
    })),
  };
}

// -----------------------------------------------------------------------------
// Lectura del balance (única función con I/O) — inyectable y con caché corta
// -----------------------------------------------------------------------------

const _cache = new Map(); // pipelineDir → { at, providers, key }

/**
 * Lee el ledger y calcula el balance de los proveedores pedidos. NUNCA tira:
 * ante cualquier error devuelve null (el plan degrada a orden declarado, CA-5).
 * Caché en memoria por `pipelineDir` (TTL `cache_ttl_ms`) para ráfagas de spawn.
 */
function readQuotaBalanceForDispatch(opts = {}) {
  const { config, pipelineDir, providers } = opts;
  const now = isFiniteNum(opts.now) ? opts.now : Date.now();
  const policy = opts.policy || readBalanceoConfig(config);
  if (!config || !pipelineDir) return null;
  const key = `${pipelineDir}|${(providers || []).slice().sort().join(',')}`;
  const hit = _cache.get(key);
  if (hit && policy.cache_ttl_ms > 0 && (now - hit.at) >= 0 && (now - hit.at) < policy.cache_ttl_ms) return hit.providers;
  try {
    const ledger = opts.ledgerModule || require('../multi-provider/quota-ledger');
    const qb = opts.balanceModule || require('../multi-provider/quota-balance');
    const samples = ledger.readSamples({ pipelineDir, sinceMs: now - policy.ledger_window_ms, providers });
    let creditRedemptions = [];
    try { creditRedemptions = ledger.readCreditRedemptions({ pipelineDir }); } catch { creditRedemptions = []; }
    const res = qb.computeQuotaBalance(config, samples, { now, providers, creditRedemptions });
    const out = res && res.providers && typeof res.providers === 'object' ? res.providers : null;
    if (out) _cache.set(key, { at: now, providers: out });
    return out;
  } catch {
    return null;
  }
}

function _resetCacheForTests() { _cache.clear(); }

module.exports = {
  DEFAULTS,
  REGLAS,
  DEGRADADO_MOTIVOS,
  readBalanceoConfig,
  describeCandidate,
  rankBySaldo,
  planQuotaBalance,
  buildResumen,
  formatRuleLine,
  toAuditEntry,
  readQuotaBalanceForDispatch,
  _resetCacheForTests,
};

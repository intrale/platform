'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({ baselineMinRuns: 30, evaluationMinRuns: 20, earlyDeathMs: 15000,
  thresholds: { rebound_absolute: 0.10, early_death_absolute: 0.10 } });

function paths(pipelineDir) {
  const state = path.join(pipelineDir, 'state', 'model-propagation-rollout.json');
  return { state, reboundSince: path.join(pipelineDir, 'state', 'model-propagation-rebound-since.json'),
    audit: path.join(pipelineDir, 'logs', 'model-propagation-rollout-audit.jsonl'), logs: path.join(pipelineDir, 'logs') };
}
function pairKey(actor, provider) { return `${actor}::${provider}`; }
function atomicJson(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, file);
}
function readState(pipelineDir, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(paths(pipelineDir).state, 'utf8')); }
  catch { return { version: 1, baselines: {}, flags: {}, waveEvidence: {} }; }
}
function audit(pipelineDir, event, fsImpl = fs) {
  const file = paths(pipelineDir).audit;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

// --- Actores despachables --------------------------------------------------
// Un escalon solo puede nombrar skills que el pulpo despacha como agente. Un
// actor que nunca es despachado no escribe `spawn-exit-*.jsonl`, asi que su
// baseline queda en n=0 para siempre y el escalon se traba de forma permanente.
// Regresion detectada en la review de #6274: `telegram-sherlock` es una chain de
// proveedores del bot de Telegram, no un skill de fase.
function dispatchableActors(fullConfig) {
  const out = new Set();
  for (const pipeline of Object.values((fullConfig && fullConfig.pipelines) || {})) {
    for (const skills of Object.values((pipeline && pipeline.skills_por_fase) || {})) {
      for (const skill of skills || []) if (skill) out.add(String(skill));
    }
  }
  return out;
}
// Fail-closed: sin lista de actores despachables NO se valida a ciegas.
function validateWaves(config, actors) {
  const waves = (config && config.waves) || [];
  if (!waves.length) throw new Error('model_propagation_rollout.waves esta vacio: no hay escalones que encender');
  if (!actors || !actors.size) throw new Error('no se pudo resolver la lista de actores despachables; el rollout no valida escalones a ciegas');
  const problemas = [];
  const vistos = new Map();
  waves.forEach((wave, i) => {
    for (const actor of (wave.actors || [])) {
      if (!actors.has(actor)) problemas.push(`'${actor}' (escalon ${i + 1}) no es un skill despachado por el pulpo; nunca acumularia telemetria de corridas`);
      if (vistos.has(actor)) problemas.push(`'${actor}' esta repetido en los escalones ${vistos.get(actor) + 1} y ${i + 1}; el orden quedaria ambiguo`);
      else vistos.set(actor, i);
    }
  });
  if (problemas.length) throw new Error(`escalones invalidos: ${problemas.join('; ')}`);
  return true;
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1];
}
function rates(rows, rebounds = 0, earlyDeathMs = DEFAULTS.earlyDeathMs, reboundMeasurable = true) {
  const n = rows.length;
  const agentDeaths = rows.filter(r => Number(r.exit_code) !== 0 && Number(r.duration_ms) < earlyDeathMs && r.death_kind !== 'provider-death').length;
  const durations = rows.map(r => Number(r.duration_ms)).filter(Number.isFinite);
  return { n, successRate: n ? rows.filter(r => Number(r.exit_code) === 0).length / n : 0,
    // `null` != 0: distingue "no hubo rebotes" de "la ventana es anterior al
    // productor de rebotes, asi que la metrica no es medible" (review #6274).
    reboundRate: reboundMeasurable ? (n ? rebounds / n : 0) : null,
    earlyDeathRate: n ? agentDeaths / n : 0,
    durationP50Ms: percentile(durations, .5), durationP95Ms: percentile(durations, .95) };
}
// `minDate` acota que archivos diarios se abren: la evaluacion corre en el
// camino caliente del pulpo (cada salida de agente) y el historico crece sin
// techo. Se resta un dia por desfasaje de zona horaria en el nombre del archivo.
function minFileDate(fromMs) {
  if (!Number.isFinite(fromMs)) return null;
  return new Date(fromMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
}
function readJsonlFiles(dir, prefix, fsImpl = fs, minDate = null) {
  let names = [];
  try { names = fsImpl.readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.jsonl')).sort(); } catch { return []; }
  if (minDate) {
    names = names.filter(n => {
      const d = n.slice(prefix.length, prefix.length + 10);
      return !/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= minDate;
    });
  }
  const out = [];
  for (const name of names) {
    let raw = ''; try { raw = fsImpl.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}

// --- Productor de rebotes: marca de arranque -------------------------------
// La tasa de rebotes solo existe desde que el pulpo empezo a emitirla. Sin esta
// marca, una ventana historica devolveria reboundRate=0 y el baseline quedaria
// congelado en un cero falso e inmutable (hallazgo de la review de #6274).
const marcados = new Set();
function markReboundProducerLive(pipelineDir, opts = {}) {
  if (marcados.has(pipelineDir) && !opts.fsImpl && !opts.now) return null;
  const fsImpl = opts.fsImpl || fs;
  const file = paths(pipelineDir).reboundSince;
  try {
    const cur = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (cur && cur.since) { marcados.add(pipelineDir); return cur.since; }
  } catch { /* todavia no existe */ }
  const since = (opts.now ? new Date(opts.now) : new Date()).toISOString();
  atomicJson(file, { version: 1, since }, fsImpl);
  audit(pipelineDir, { ts: since, event: 'rebound_producer_live', since }, fsImpl);
  marcados.add(pipelineDir);
  return since;
}
function reboundSince(pipelineDir, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(paths(pipelineDir).reboundSince, 'utf8')).since || null; }
  catch { return null; }
}

function collect(pipelineDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const from = opts.from ? new Date(opts.from).getTime() : -Infinity;
  const until = opts.until ? new Date(opts.until).getTime() : Infinity;
  const minDate = minFileDate(from);
  const filter = r => { const t = Date.parse(r.ts || r.created_at); return t >= from && t <= until; };
  const spawns = readJsonlFiles(paths(pipelineDir).logs, 'spawn-exit-', fsImpl, minDate).filter(filter);
  const reboundRows = readJsonlFiles(paths(pipelineDir).logs, 'rebound-events-', fsImpl, minDate).filter(filter);
  // La ventana es medible solo si arranca en o despues del instante en que el
  // productor de rebotes quedo vivo.
  const since = reboundSince(pipelineDir, fsImpl);
  const reboundMeasurable = Boolean(since) && Number.isFinite(from) && from >= Date.parse(since);
  const reboundCounts = {};
  for (const r of reboundRows) { const k = pairKey(r.skill, r.provider); reboundCounts[k] = (reboundCounts[k] || 0) + 1; }
  const grouped = {};
  for (const r of spawns) { if (!r.skill || !r.provider) continue; (grouped[pairKey(r.skill, r.provider)] ||= []).push(r); }
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k,
    rates(rows, reboundCounts[k] || 0, opts.earlyDeathMs, reboundMeasurable)]));
}
function captureBaseline(pipelineDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const now = opts.now || new Date();
  const state = readState(pipelineDir, fsImpl);
  if (Object.keys(state.baselines).length) throw new Error('el baseline ya esta congelado; no se sobrescribe');
  const metrics = collect(pipelineDir, opts);
  state.baselines = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { ...v,
    window: { from: opts.from || null, until: opts.until || now.toISOString() }, frozenAt: now.toISOString() }]));
  atomicJson(paths(pipelineDir).state, state, fsImpl);
  const sinRebotes = Object.values(state.baselines).filter(b => b.reboundRate === null).length;
  audit(pipelineDir, { ts: now.toISOString(), event: 'baseline_frozen', pairs: Object.keys(metrics).length,
    pairs_sin_rebotes: sinRebotes, origin: 'humano' }, fsImpl);
  return state.baselines;
}
// Completa SOLO la tasa de rebotes de los pares que quedaron sin medir, una vez
// que el productor acumulo ventana propia. No re-mide nada ya congelado: es un
// relleno append-only, auditado y explicitamente humano. Sin esto el baseline de
// rebotes es estructuralmente 0 e inmutable (hallazgo de la review de #6274).
function captureReboundBaseline(pipelineDir, config = {}, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const now = opts.now || new Date();
  const state = readState(pipelineDir, fsImpl);
  if (!Object.keys(state.baselines).length) throw new Error('no hay baseline congelado todavia; corre primero `baseline`');
  const since = reboundSince(pipelineDir, fsImpl);
  if (!since) throw new Error('el productor de rebotes todavia no arranco; no existe ventana medible');
  if (!opts.from) throw new Error('se requiere --from para acotar la ventana medible de rebotes');
  if (Date.parse(opts.from) < Date.parse(since)) {
    throw new Error(`la ventana debe empezar en o despues de ${since}, cuando arranco el productor de rebotes`);
  }
  const metrics = collect(pipelineDir, opts);
  const min = config.baseline_min_runs || DEFAULTS.baselineMinRuns;
  const medidos = {}; const omitidos = {};
  for (const [key, base] of Object.entries(state.baselines)) {
    if (Number.isFinite(base.reboundRate)) { omitidos[key] = 'ya estaba medido'; continue; }
    const m = metrics[key];
    if (!m || !Number.isFinite(m.reboundRate)) { omitidos[key] = 'sin corridas en la ventana medible'; continue; }
    if (m.n < min) { omitidos[key] = `muestra ${m.n}/${min}`; continue; }
    state.baselines[key] = { ...base, reboundRate: m.reboundRate,
      reboundWindow: { from: opts.from, until: opts.until || now.toISOString(), n: m.n },
      reboundFrozenAt: now.toISOString() };
    medidos[key] = m.reboundRate;
  }
  if (!Object.keys(medidos).length) throw new Error(`ningun par quedo medible: ${JSON.stringify(omitidos)}`);
  atomicJson(paths(pipelineDir).state, state, fsImpl);
  audit(pipelineDir, { ts: now.toISOString(), event: 'rebound_baseline_frozen', origin: 'humano',
    pairs: Object.keys(medidos), window: { from: opts.from, until: opts.until || now.toISOString() } }, fsImpl);
  return { medidos, omitidos };
}
function waveIndex(actor, config) { return (config.waves || []).findIndex(w => (w.actors || []).includes(actor)); }
function waveEvidenceKey(wave, provider) { return `${wave}::${provider}`; }
function enablePair(pipelineDir, actor, provider, config, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  // Validar los escalones antes de tocar estado: un escalon que nombra actores
  // no despachados es un rollout inarrancable, no un encendido valido.
  if (opts.dispatchableActors) validateWaves(config, opts.dispatchableActors);
  const state = readState(pipelineDir, fsImpl); const key = pairKey(actor, provider);
  const baseline = state.baselines[key]; const min = config.baseline_min_runs || DEFAULTS.baselineMinRuns;
  if (!baseline || baseline.n < min) throw new Error(`no se puede encender ${actor} en ${provider}: baseline con ${baseline ? baseline.n : 0} corridas, se necesitan ${min}`);
  const wave = waveIndex(actor, config); if (wave < 0) throw new Error(`actor '${actor}' no esta declarado en los escalones`);
  if (wave > 0 && !state.waveEvidence[waveEvidenceKey(wave - 1, provider)]) {
    const previos = (config.waves[wave - 1].actors || []).join(', ');
    throw new Error(`el escalon ${wave + 1} en ${provider} requiere evidencia sana del escalon ${wave} (${previos}): todos los actores deben estar encendidos y evaluados como sanos en ${provider}`);
  }
  const now = opts.now || new Date(); state.flags[key] = { enabled: true, enabledAt: now.toISOString(), enabledBy: opts.actor || 'operador', rollback: null };
  atomicJson(paths(pipelineDir).state, state, fsImpl); audit(pipelineDir, { ts: now.toISOString(), event: 'enabled', pair: key, origin: 'humano', by: opts.actor || 'operador' }, fsImpl);
  return state.flags[key];
}
function shouldPropagate(pipelineDir, actor, provider, fsImpl = fs) { return readState(pipelineDir, fsImpl).flags[pairKey(actor, provider)]?.enabled === true; }
const MODEL_ENV_BY_PROVIDER = Object.freeze({
  'openai-codex': 'CODEX_MODEL', 'gemini-google': 'GEMINI_MODEL',
  cerebras: 'CEREBRAS_MODEL', 'nvidia-nim': 'NVIDIA_NIM_MODEL',
});
function applyToSpawn(pipelineDir, actor, resolution, args, env, fsImpl = fs) {
  const nextArgs = Array.isArray(args) ? [...args] : [];
  const nextEnv = { ...(env || {}) };
  if (!resolution?.provider || !resolution.model || !shouldPropagate(pipelineDir, actor, resolution.provider, fsImpl)) {
    return { args: nextArgs, env: nextEnv, propagated: false };
  }
  if (resolution.provider === 'anthropic') nextArgs.push('--model', String(resolution.model));
  else if (MODEL_ENV_BY_PROVIDER[resolution.provider]) nextEnv[MODEL_ENV_BY_PROVIDER[resolution.provider]] = String(resolution.model);
  else return { args: nextArgs, env: nextEnv, propagated: false };
  return { args: nextArgs, env: nextEnv, propagated: true };
}
// `event.skill` DEBE ser el actor REBOTADO (el que vuelve a correr en la fase
// destino), no el evaluador que emitio el veredicto `rechazado`: la metrica mide
// la calidad del trabajo del actor cuyo modelo se propago (review de #6274).
function recordRebound(pipelineDir, event, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  if (!event || !event.skill) return { recorded: false, reason: 'sin actor rebotado' };
  const rows = readJsonlFiles(paths(pipelineDir).logs, 'spawn-exit-', fsImpl)
    .filter(r => String(r.issue) === String(event.issue) && r.skill === event.skill && r.provider);
  const spawn = rows.at(-1);
  if (!spawn) return { recorded: false, reason: 'sin spawn asociado' };
  const row = { ts: event.ts || new Date().toISOString(), issue: event.issue, skill: event.skill, provider: spawn.provider,
    rechazado_en_fase: event.rechazado_en_fase || null, evaluadores: event.evaluadores || null };
  const file = path.join(paths(pipelineDir).logs, `rebound-events-${row.ts.slice(0, 10)}.jsonl`);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return { recorded: true, row };
}
function evaluatePair(pipelineDir, actor, provider, observed, config, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl); const key = pairKey(actor, provider);
  if (!state.flags[key]?.enabled) return { action: 'off' };
  const min = config.evaluation_min_runs || DEFAULTS.evaluationMinRuns;
  if (!observed || observed.n < min) return { action: 'deferred', reason: `muestra ${observed?.n || 0}/${min}` };
  const base = state.baselines[key]; if (!base) return { action: 'deferred', reason: 'sin baseline' };
  const th = config.thresholds || DEFAULTS.thresholds;
  if (!Number.isFinite(th.early_death_absolute) || !Number.isFinite(th.rebound_absolute)) {
    return { action: 'deferred', reason: 'umbrales ausentes o no numericos' };
  }
  // La comparacion de rebotes solo esta armada cuando AMBOS lados son medibles.
  // Comparar contra un baseline no medido produce rollbacks falsos.
  const reboundArmed = Number.isFinite(base.reboundRate) && Number.isFinite(observed.reboundRate);
  const metric = observed.earlyDeathRate - base.earlyDeathRate > th.early_death_absolute ? 'muertes tempranas'
    : (reboundArmed && observed.reboundRate - base.reboundRate > th.rebound_absolute) ? 'rebotes' : null;
  if (!metric) return { action: 'healthy', reboundArmed };
  const now = opts.now || new Date(); state.flags[key] = { ...state.flags[key], enabled: false,
    rollback: { at: now.toISOString(), metric, baseline: metric === 'rebotes' ? base.reboundRate : base.earlyDeathRate,
      observed: metric === 'rebotes' ? observed.reboundRate : observed.earlyDeathRate, n: observed.n } };
  atomicJson(paths(pipelineDir).state, state, fsImpl);
  audit(pipelineDir, { ts: now.toISOString(), event: 'auto_rollback', pair: key, origin: 'auto', ...state.flags[key].rollback }, fsImpl);
  if (opts.notify) opts.notify({ level: 'warn', component: 'model-rollout',
    message: `propagacion de modelo apagada para ${actor} en ${provider}: subieron los ${metric}`,
    context: { metrica: metric, baseline: state.flags[key].rollback.baseline, observado: state.flags[key].rollback.observed,
      muestra: observed.n, ventana: observed.window || 'ventana actual' },
    action: `node .pipeline/model-rollout.js reenable --actor ${actor} --provider ${provider} --by <operador>`,
    detail: 'El despacho sigue activo; solo se omitira el modelo declarado.' });
  return { action: 'rollback', metric, reboundArmed };
}
function evaluateEnabled(pipelineDir, config, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl);
  const results = {};
  const cache = new Map(); // una lectura por ventana, no una por par
  for (const [key, flag] of Object.entries(state.flags)) {
    if (!flag.enabled) continue;
    const [actor, provider] = key.split('::');
    const from = opts.from || flag.enabledAt;
    if (!cache.has(from)) cache.set(from, collect(pipelineDir, { ...opts, from }));
    results[key] = evaluatePair(pipelineDir, actor, provider, cache.get(from)[key], config, opts);
  }
  const refreshed = readState(pipelineDir, fsImpl);
  const providers = new Set(Object.keys(refreshed.flags).map(key => key.split('::')[1]).filter(Boolean));
  for (let i = 0; i < (config.waves || []).length; i++) {
    const actors = config.waves[i].actors || [];
    for (const provider of providers) {
      const keys = actors.map(actor => pairKey(actor, provider));
      const evidenceKey = waveEvidenceKey(i, provider);
      // La wave siguiente solo se abre cuando TODOS los pares aplicables de la
      // anterior estuvieron encendidos y acumularon una evaluacion sana. Un par
      // ausente no es evidencia y debe mantener el rollout cerrado (CA-4).
      const sano = keys.length > 0 && keys.every(key =>
        refreshed.flags[key]?.enabled === true && results[key]?.action === 'healthy');
      if (sano) refreshed.waveEvidence[evidenceKey] = {
        at: (opts.now || new Date()).toISOString(), provider, pairs: keys,
        sin_evidencia: [],
        minRuns: config.evaluation_min_runs || DEFAULTS.evaluationMinRuns };
      else delete refreshed.waveEvidence[evidenceKey];
    }
  }
  atomicJson(paths(pipelineDir).state, refreshed, fsImpl);
  return results;
}
function reenablePair(pipelineDir, actor, provider, by, opts = {}) {
  if (!by) throw new Error('el reencendido requiere --by explicito');
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl); const key = pairKey(actor, provider);
  if (!state.baselines[key]) throw new Error(`no existe baseline para ${key}`);
  if (!state.flags[key]?.rollback || state.flags[key].enabled !== false) {
    throw new Error(`no se puede reencender ${key}: el par no fue apagado por auto_rollback`);
  }
  const now = opts.now || new Date(); state.flags[key] = { enabled: true, enabledAt: now.toISOString(), enabledBy: by, rollback: null };
  atomicJson(paths(pipelineDir).state, state, fsImpl); audit(pipelineDir, { ts: now.toISOString(), event: 'reenabled', pair: key, origin: 'humano', by }, fsImpl);
  return state.flags[key];
}

module.exports = { DEFAULTS, pairKey, rates, collect, captureBaseline, captureReboundBaseline, enablePair,
  evaluatePair, evaluateEnabled, reenablePair, shouldPropagate, applyToSpawn, recordRebound, readState,
  dispatchableActors, validateWaves, markReboundProducerLive, reboundSince };

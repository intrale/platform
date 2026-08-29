'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({ baselineMinRuns: 30, evaluationMinRuns: 20, earlyDeathMs: 15000,
  thresholds: { rebound_absolute: 0.10, early_death_absolute: 0.10 } });

function paths(pipelineDir) {
  const state = path.join(pipelineDir, 'state', 'model-propagation-rollout.json');
  return { state, audit: path.join(pipelineDir, 'logs', 'model-propagation-rollout-audit.jsonl'), logs: path.join(pipelineDir, 'logs') };
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
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1];
}
function rates(rows, rebounds = 0, earlyDeathMs = DEFAULTS.earlyDeathMs) {
  const n = rows.length;
  const agentDeaths = rows.filter(r => Number(r.exit_code) !== 0 && Number(r.duration_ms) < earlyDeathMs && r.death_kind !== 'provider-death').length;
  const durations = rows.map(r => Number(r.duration_ms)).filter(Number.isFinite);
  return { n, successRate: n ? rows.filter(r => Number(r.exit_code) === 0).length / n : 0,
    reboundRate: n ? rebounds / n : 0, earlyDeathRate: n ? agentDeaths / n : 0,
    durationP50Ms: percentile(durations, .5), durationP95Ms: percentile(durations, .95) };
}
function readJsonlFiles(dir, prefix, fsImpl = fs) {
  let names = [];
  try { names = fsImpl.readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.jsonl')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    let raw = ''; try { raw = fsImpl.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}
function collect(pipelineDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const from = opts.from ? new Date(opts.from).getTime() : -Infinity;
  const until = opts.until ? new Date(opts.until).getTime() : Infinity;
  const filter = r => { const t = Date.parse(r.ts || r.created_at); return t >= from && t <= until; };
  const spawns = readJsonlFiles(paths(pipelineDir).logs, 'spawn-exit-', fsImpl).filter(filter);
  const reboundRows = readJsonlFiles(paths(pipelineDir).logs, 'rebound-events-', fsImpl).filter(filter);
  const reboundCounts = {};
  for (const r of reboundRows) { const k = pairKey(r.skill, r.provider); reboundCounts[k] = (reboundCounts[k] || 0) + 1; }
  const grouped = {};
  for (const r of spawns) { if (!r.skill || !r.provider) continue; (grouped[pairKey(r.skill, r.provider)] ||= []).push(r); }
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, rates(rows, reboundCounts[k] || 0, opts.earlyDeathMs)]));
}
function captureBaseline(pipelineDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const now = opts.now || new Date();
  const state = readState(pipelineDir, fsImpl);
  if (Object.keys(state.baselines).length) throw new Error('el baseline ya está congelado; no se sobrescribe');
  const metrics = collect(pipelineDir, opts);
  state.baselines = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { ...v,
    window: { from: opts.from || null, until: opts.until || now.toISOString() }, frozenAt: now.toISOString() }]));
  atomicJson(paths(pipelineDir).state, state, fsImpl);
  audit(pipelineDir, { ts: now.toISOString(), event: 'baseline_frozen', pairs: Object.keys(metrics).length, origin: 'humano' }, fsImpl);
  return state.baselines;
}
function waveIndex(actor, config) { return (config.waves || []).findIndex(w => (w.actors || []).includes(actor)); }
function waveEvidenceKey(wave, provider) { return `${wave}::${provider}`; }
function enablePair(pipelineDir, actor, provider, config, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl); const key = pairKey(actor, provider);
  const baseline = state.baselines[key]; const min = config.baseline_min_runs || DEFAULTS.baselineMinRuns;
  if (!baseline || baseline.n < min) throw new Error(`no se puede encender ${actor} en ${provider}: baseline con ${baseline ? baseline.n : 0} corridas, se necesitan ${min}`);
  const wave = waveIndex(actor, config); if (wave < 0) throw new Error(`actor '${actor}' no está declarado en los escalones`);
  if (wave > 0 && !state.waveEvidence[waveEvidenceKey(wave - 1, provider)]) {
    throw new Error(`el escalón ${wave + 1} en ${provider} requiere que todos los actores del escalón ${wave} acumulen la muestra mínima sin degradación`);
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
function recordRebound(pipelineDir, event, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const rows = readJsonlFiles(paths(pipelineDir).logs, 'spawn-exit-', fsImpl)
    .filter(r => String(r.issue) === String(event.issue) && r.skill === event.skill && r.provider);
  const spawn = rows.at(-1);
  if (!spawn) return { recorded: false, reason: 'sin spawn asociado' };
  const row = { ts: event.ts || new Date().toISOString(), issue: event.issue, skill: event.skill, provider: spawn.provider };
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
  const metric = observed.earlyDeathRate - base.earlyDeathRate > th.early_death_absolute ? 'muertes tempranas'
    : observed.reboundRate - base.reboundRate > th.rebound_absolute ? 'rebotes' : null;
  if (!metric) return { action: 'healthy' };
  const now = opts.now || new Date(); state.flags[key] = { ...state.flags[key], enabled: false,
    rollback: { at: now.toISOString(), metric, baseline: metric === 'rebotes' ? base.reboundRate : base.earlyDeathRate,
      observed: metric === 'rebotes' ? observed.reboundRate : observed.earlyDeathRate, n: observed.n } };
  atomicJson(paths(pipelineDir).state, state, fsImpl);
  audit(pipelineDir, { ts: now.toISOString(), event: 'auto_rollback', pair: key, origin: 'auto', ...state.flags[key].rollback }, fsImpl);
  if (opts.notify) opts.notify({ level: 'warn', component: 'model-rollout',
    message: `propagación de modelo apagada para ${actor} en ${provider}: subieron los ${metric}`,
    context: { metrica: metric, baseline: state.flags[key].rollback.baseline, observado: state.flags[key].rollback.observed,
      muestra: observed.n, ventana: observed.window || 'ventana actual' },
    action: `node .pipeline/model-rollout.js reenable --actor ${actor} --provider ${provider} --by <operador>`,
    detail: 'El despacho sigue activo; sólo se omitirá el modelo declarado.' });
  return { action: 'rollback', metric };
}
function evaluateEnabled(pipelineDir, config, opts = {}) {
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl);
  const results = {};
  for (const [key, flag] of Object.entries(state.flags)) {
    if (!flag.enabled) continue;
    const [actor, provider] = key.split('::');
    const observedByPair = collect(pipelineDir, { ...opts, from: opts.from || flag.enabledAt });
    results[key] = evaluatePair(pipelineDir, actor, provider, observedByPair[key], config, opts);
  }
  const refreshed = readState(pipelineDir, fsImpl);
  const providers = new Set(Object.keys(refreshed.flags).map(key => key.split('::')[1]).filter(Boolean));
  for (let i = 0; i < (config.waves || []).length; i++) {
    const actors = config.waves[i].actors || [];
    for (const provider of providers) {
      const keys = actors.map(actor => pairKey(actor, provider));
      const evidenceKey = waveEvidenceKey(i, provider);
      const completeAndHealthy = keys.length > 0 && keys.every(key =>
        refreshed.flags[key]?.enabled === true && results[key]?.action === 'healthy');
      if (completeAndHealthy) refreshed.waveEvidence[evidenceKey] = {
        at: (opts.now || new Date()).toISOString(), provider, pairs: keys,
        minRuns: config.evaluation_min_runs || DEFAULTS.evaluationMinRuns };
      else delete refreshed.waveEvidence[evidenceKey];
    }
  }
  atomicJson(paths(pipelineDir).state, refreshed, fsImpl);
  return results;
}
function reenablePair(pipelineDir, actor, provider, by, opts = {}) {
  if (!by) throw new Error('el reencendido requiere --by explícito');
  const fsImpl = opts.fsImpl || fs; const state = readState(pipelineDir, fsImpl); const key = pairKey(actor, provider);
  if (!state.baselines[key]) throw new Error(`no existe baseline para ${key}`);
  const now = opts.now || new Date(); state.flags[key] = { enabled: true, enabledAt: now.toISOString(), enabledBy: by, rollback: null };
  atomicJson(paths(pipelineDir).state, state, fsImpl); audit(pipelineDir, { ts: now.toISOString(), event: 'reenabled', pair: key, origin: 'humano', by }, fsImpl);
  return state.flags[key];
}

module.exports = { DEFAULTS, pairKey, rates, collect, captureBaseline, enablePair, evaluatePair, evaluateEnabled, reenablePair, shouldPropagate, applyToSpawn, recordRebound, readState };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactSecretValue } = require('../redact');

const NOT_OBSERVABLE = 'not_observable';
const WHITELIST = Object.freeze([
    'ts', 'issue', 'skill', 'provider', 'model_declared',
    'model_resolved', 'model_effective', 'source',
]);
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function defaultFile() {
    return path.join(__dirname, '..', '..', 'state', 'effective-model.jsonl');
}

function normalizeModelId(value) {
    const candidate = String(value || '').replace(/\[[^\]]*\]\s*$/, '').trim();
    // El modelo observado viene de un log no confiable. El redactor central es
    // la fuente canonica para detectar credenciales: si altera el valor, jamas
    // se valida ni se persiste una version parcial/redactada como model id.
    if (redactSecretValue(candidate) !== candidate) return null;
    const normalized = candidate.toLowerCase();
    return MODEL_ID.test(normalized) ? normalized : null;
}

function jsonLines(raw) {
    const out = [];
    for (const line of String(raw || '').split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try { out.push(JSON.parse(line)); } catch { /* línea truncada */ }
    }
    return out;
}

function anthropic(raw) {
    let found = null;
    for (const obj of jsonLines(raw)) {
        if (obj.type === 'assistant' && obj.message && obj.message.model) found = obj.message.model;
    }
    return found;
}

function gemini(raw) {
    for (const obj of jsonLines(raw)) {
        const models = obj && obj.stats && obj.stats.models;
        if (models && typeof models === 'object') return Object.keys(models)[0] || null;
    }
    return null;
}

function openAiCompatible(raw) {
    let found = null;
    for (const obj of jsonLines(raw)) if (obj && typeof obj.model === 'string') found = obj.model;
    return found;
}

const EXTRACTORS = Object.freeze({
    anthropic,
    'kimi-moonshot': anthropic,
    'gemini-google': gemini,
    cerebras: openAiCompatible,
    'nvidia-nim': openAiCompatible,
    'openai-codex': null,
    deterministic: null,
});

function extractEffectiveModel(opts = {}, deps = {}) {
    try {
        const extractor = EXTRACTORS[String(opts.provider || '')];
        if (typeof extractor !== 'function') return { model: null, source: NOT_OBSERVABLE, observable: false };
        let raw = opts.raw;
        if (raw == null) raw = (deps.fs || fs).readFileSync(opts.logPath, 'utf8');
        const model = normalizeModelId(extractor(raw));
        return model
            ? { model, source: 'agent-log', observable: true }
            : { model: null, source: NOT_OBSERVABLE, observable: false };
    } catch {
        return { model: null, source: NOT_OBSERVABLE, observable: false };
    }
}

function recordEffectiveModel(opts = {}, deps = {}) {
    try {
        const _fs = deps.fs || fs;
        const file = deps.file || defaultFile();
        const observed = opts.observed || extractEffectiveModel(opts, deps);
        const rec = {
            ts: String(opts.ts || new Date().toISOString()),
            issue: Number(opts.issue) || null,
            skill: String(opts.skill || 'unknown'),
            provider: String(opts.provider || 'unknown'),
            model_declared: normalizeModelId(opts.model_declared),
            model_resolved: normalizeModelId(opts.model_resolved),
            model_effective: normalizeModelId(observed.model),
            source: observed.observable ? 'agent-log' : NOT_OBSERVABLE,
        };
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best effort */ }
        _fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
        return rec;
    } catch { return null; }
}

function recordEffectiveModelForRun(opts = {}, deps = {}) {
    try {
        const provider = String(
            (opts.launchResult && opts.launchResult.provider)
            || (opts.dispatchResolution && opts.dispatchResolution.provider)
            || opts.configuredProvider
            || 'unknown'
        );
        const observed = extractEffectiveModel({ provider, logPath: opts.logPath, raw: opts.raw }, deps);
        const record = recordEffectiveModel({
            issue: opts.issue,
            skill: opts.skill,
            provider,
            model_declared: opts.model_declared,
            model_resolved: (opts.launchResult && opts.launchResult.model) || opts.model_resolved,
            observed,
            ts: opts.ts,
        }, deps);
        return { observed, record };
    } catch {
        return { observed: { model: null, source: NOT_OBSERVABLE, observable: false }, record: null };
    }
}

function readRecords(deps = {}) {
    try {
        const raw = (deps.fs || fs).readFileSync(deps.file || defaultFile(), 'utf8');
        return jsonLines(raw).filter((r) => r && r.skill && r.provider);
    } catch { return []; }
}

function auditDeclaredVsEffective(deps = {}) {
    const buckets = new Map();
    for (const r of deps.records || readRecords(deps)) {
        const key = `${r.skill}\0${r.provider}`;
        let b = buckets.get(key);
        if (!b) {
            b = { skill: r.skill, provider: r.provider, model_declared: r.model_declared || null,
                model_resolved: r.model_resolved || null, runs: 0, runs_matched: 0,
                runs_diverged: 0, runs_not_observable: 0, effective: new Map() };
            buckets.set(key, b);
        }
        b.runs += 1;
        b.model_declared = r.model_declared || b.model_declared;
        b.model_resolved = r.model_resolved || b.model_resolved;
        if (!r.model_effective || r.source === NOT_OBSERVABLE) b.runs_not_observable += 1;
        else {
            b.effective.set(r.model_effective, (b.effective.get(r.model_effective) || 0) + 1);
            if (normalizeModelId(r.model_declared) === normalizeModelId(r.model_effective)) b.runs_matched += 1;
            else b.runs_diverged += 1;
        }
    }
    return [...buckets.values()].map((b) => {
        const top = [...b.effective.entries()].sort((a, c) => c[1] - a[1])[0];
        const observable = b.runs_matched + b.runs_diverged;
        return { skill: b.skill, provider: b.provider, model_declared: b.model_declared,
            model_resolved: b.model_resolved, model_effective_top: top ? top[0] : null,
            runs: b.runs, runs_matched: b.runs_matched, runs_diverged: b.runs_diverged,
            runs_not_observable: b.runs_not_observable,
            match_pct: observable ? Number((b.runs_matched * 100 / observable).toFixed(2)) : null };
    }).sort((a, b) => (b.runs_diverged - a.runs_diverged) || a.skill.localeCompare(b.skill));
}

function evaluateDivergence(deps = {}) {
    try {
        const cfg = deps.config || {};
        if (cfg.alert_enabled !== true) return [];
        const minRuns = Number(cfg.min_runs) || 20;
        const maxPct = Number.isFinite(Number(cfg.max_divergence_pct)) ? Number(cfg.max_divergence_pct) : 10;
        const notify = deps.notify || (() => {});
        const alerts = [];
        for (const row of auditDeclaredVsEffective(deps)) {
            const observable = row.runs_matched + row.runs_diverged;
            const divergence = observable ? row.runs_diverged * 100 / observable : 0;
            if (observable < minRuns || divergence <= maxPct) continue;
            const key = `${row.skill}|${row.provider}|${row.model_effective_top}`;
            const shouldNotify = deps.shouldNotify || persistentShouldNotify;
            if (!shouldNotify(key, row, deps)) continue;
            notify({ level: 'warn', component: 'multi-provider/effective-model',
                message: `${row.skill} corre con ${row.model_effective_top} pero tiene declarado ${row.model_declared} (${row.match_pct}% de coincidencia en ${observable} corridas)`,
                context: { actor: row.skill, proveedor: row.provider, modelo_declarado: row.model_declared,
                    modelo_efectivo: row.model_effective_top, corridas: observable, coincidencia_pct: row.match_pct } });
            alerts.push({ key, ...row });
        }
        return alerts;
    } catch { return []; }
}

function persistentShouldNotify(key, _row, deps = {}) {
    try {
        const _fs = deps.fs || fs;
        const file = deps.dedupFile || path.join(__dirname, '..', '..', 'state', 'effective-model-alerts.json');
        let state = {};
        try { state = JSON.parse(_fs.readFileSync(file, 'utf8')); } catch {}
        if (state[key]) return false;
        state[key] = new Date().toISOString();
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
        _fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
        return true;
    } catch { return true; }
}

function recordsFromLogs(logDir, deps = {}) {
    const _fs = deps.fs || fs;
    const maxBytes = Number(deps.maxBytes) || 1024 * 1024;
    let resolve = deps.resolveModel;
    if (!resolve) {
        const agentModels = require('../agent-models');
        const loaded = agentModels.loadAndValidate();
        const config = loaded.ok ? loaded.config : null;
        resolve = (skill) => config ? agentModels.resolveModel(skill, { config }) : null;
    }
    let names;
    try { names = _fs.readdirSync(logDir); } catch { return []; }
    const candidates = names.filter((n) => /^\d+-[a-z][a-z0-9-]*(?:\.attempt-\d+)?\.log$/.test(n));
    const attemptBases = new Set(candidates.filter((n) => /\.attempt-\d+\.log$/.test(n))
        .map((n) => n.replace(/\.attempt-\d+(?=\.log$)/, '')));
    const canonical = candidates.filter((n) => /\.attempt-\d+\.log$/.test(n) || !attemptBases.has(n));
    const out = [];
    for (const name of canonical) {
        const match = /^(\d+)-([a-z][a-z0-9-]*?)(?:\.attempt-\d+)?\.log$/.exec(name);
        if (!match || match[2] === 'build') continue;
        const declared = resolve(match[2]);
        if (!declared) continue;
        let raw = '';
        try {
            const file = path.join(logDir, name);
            const stat = _fs.statSync(file);
            const start = Math.max(0, stat.size - maxBytes);
            const fd = _fs.openSync(file, 'r');
            const buffer = Buffer.alloc(stat.size - start);
            _fs.readSync(fd, buffer, 0, buffer.length, start); _fs.closeSync(fd);
            raw = buffer.toString('utf8');
        } catch { continue; }
        const observed = extractEffectiveModel({ provider: declared.provider, raw });
        out.push({ skill: match[2], provider: declared.provider, model_declared: declared.model,
            model_resolved: null, model_effective: observed.model, source: observed.source });
    }
    return out;
}

module.exports = { NOT_OBSERVABLE, WHITELIST, normalizeModelId, extractEffectiveModel,
    recordEffectiveModel, recordEffectiveModelForRun, auditDeclaredVsEffective, evaluateDivergence, readRecords,
    persistentShouldNotify, recordsFromLogs };

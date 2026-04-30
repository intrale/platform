#!/usr/bin/env node
// V3 Metrics Aggregator — lee activity-log.jsonl, indexa eventos V3 y persiste snapshots
// Contrato definido en issue #2477.
//
// Modos:
//   node aggregator.js                 → modo daemon, refresh cada 60s
//   node aggregator.js --once          → snapshot único y exit
//   node aggregator.js --window 24h    → aplicar ventana temporal al snapshot (1h|24h|7d|all)
//
// Output: .pipeline/metrics/snapshot.json (ver schema abajo).
// Consumido por dashboard.js y report-daily.js.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { LOG_FILE, REPO_ROOT, estimateCostUsd, MODEL_PRICING } = require('../lib/traceability');
const { computeProjections } = require('./projections');

const METRICS_DIR = path.join(REPO_ROOT, '.pipeline', 'metrics');
const SNAPSHOT_FILE = path.join(METRICS_DIR, 'snapshot.json');
const DEFAULT_REFRESH_MS = 60000;

// Baseline horario (#2891 PR-B) — rolling window de 7-14 días.
// El detector de anomalías usa hourlySeries["HH"].cost_usd como baseline para
// la hora actual y currentHour.cost_usd como "actual". Default: 7 días.
const DEFAULT_LOOKBACK_DAYS = 7;
const MIN_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 14;

function pad2(n) { return String(n).padStart(2, '0'); }

function clampLookbackDays(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LOOKBACK_DAYS;
    if (n < MIN_LOOKBACK_DAYS) return MIN_LOOKBACK_DAYS;
    if (n > MAX_LOOKBACK_DAYS) return MAX_LOOKBACK_DAYS;
    return Math.floor(n);
}

// Normaliza el modelo a "deterministic" | "llm" para comparativa (#2488)
function classifyExecutionMode(model) {
    const m = String(model || '').toLowerCase().trim();
    return m === 'deterministic' ? 'deterministic' : 'llm';
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

function parseWindow(s) {
    if (!s || s === 'all') return null;
    const m = String(s).match(/^(\d+)([hd])$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const mult = m[2].toLowerCase() === 'h' ? 3600e3 : 86400e3;
    return n * mult;
}

function emptyBucket() {
    return {
        sessions: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read: 0,
        cache_write: 0,
        duration_ms: 0,
        tool_calls: 0,
        cost_usd: 0,
        tts_chars: 0,
        tts_audio_seconds: 0,
        tts_cost_usd: 0,
        tts_count: 0,
    };
}

function addToBucket(b, evt) {
    if (evt.event === 'session:end') {
        b.sessions += 1;
        b.tokens_in += Number(evt.tokens_in || 0);
        b.tokens_out += Number(evt.tokens_out || 0);
        b.cache_read += Number(evt.cache_read || 0);
        b.cache_write += Number(evt.cache_write || 0);
        b.duration_ms += Number(evt.duration_ms || 0);
        b.tool_calls += Number(evt.tool_calls || 0);
        b.cost_usd += estimateCostUsd(evt.model, evt);
    } else if (evt.event === 'tts:generated') {
        b.tts_chars += Number(evt.chars || 0);
        b.tts_audio_seconds += Number(evt.audio_seconds || 0);
        b.tts_cost_usd += Number(evt.cost_estimate_usd || 0);
        b.tts_count += 1;
    }
}

function withAvg(bucket) {
    const avg_tokens = bucket.sessions > 0 ? Math.round((bucket.tokens_in + bucket.tokens_out + bucket.cache_read + bucket.cache_write) / bucket.sessions) : 0;
    const avg_duration_ms = bucket.sessions > 0 ? Math.round(bucket.duration_ms / bucket.sessions) : 0;
    return Object.assign({}, bucket, {
        avg_tokens_per_session: avg_tokens,
        avg_duration_ms,
        cost_usd: Math.round(bucket.cost_usd * 10000) / 10000,
        tts_cost_usd: Math.round(bucket.tts_cost_usd * 10000) / 10000,
    });
}

async function buildSnapshot(options) {
    options = options || {};
    const windowMs = parseWindow(options.window);
    const nowMs = options.nowMs != null ? Number(options.nowMs) : Date.now();
    const cutoffMs = windowMs ? nowMs - windowMs : null;
    const lookbackDays = clampLookbackDays(options.lookbackDays);
    // Normalizar cutoff a start-of-day UTC: la semántica de "últimos 7 días"
    // es por días calendario, no por hora exacta. Sin esto, eventos a las 10am
    // de hace exactamente 7 días quedaban excluidos sólo porque la hora del
    // pivot era 15:00 → desconcierta y rompe baselines tempranos.
    const _now = new Date(nowMs);
    const todayStartMs = Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate(), 0, 0, 0, 0);
    const lookbackCutoffMs = todayStartMs - lookbackDays * 86400e3;

    const byAgent = new Map();        // skill → bucket
    const byPhase = new Map();        // phase → bucket
    const byIssue = new Map();        // issue → { total: bucket, timeline, by_skill, tts_by_provider } (#2488)
    const byProvider = new Map();     // provider → bucket (TTS)
    const byAgentProvider = new Map();// `${skill}|${provider}` → bucket (TTS)
    const byAgentMode = new Map();    // `${skill}|${mode}` → bucket (#2488 — LLM vs determinístico)
    const dailySeries = new Map();    // YYYY-MM-DD → { cost_usd, tts_cost_usd, sessions } (para proyecciones)
    const hourlyBuckets = new Map();  // "YYYY-MM-DD HH" → { cost_usd, tokens, sessions } (#2891 baseline horario)
    // Top consumidores por hora-del-dia (#2892 PR-C). Bucket "YYYY-MM-DD HH|skill" → cost_usd.
    // Permite que el alert builder de Telegram extraiga top 3 de la franja anómala.
    const hourlyBySkill = new Map();  // "YYYY-MM-DD HH|skill" → cost_usd acumulado

    let totalEvents = 0;
    let v3Events = 0;

    if (!fs.existsSync(LOG_FILE)) {
        return emitEmptySnapshot(options);
    }

    const stream = fs.createReadStream(LOG_FILE, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line) continue;
        totalEvents += 1;
        let evt;
        try { evt = JSON.parse(line); } catch (_) { continue; }
        if (!evt || !evt.event) continue; // línea vieja (shape {ts, session, tool, target}) — ignorar
        if (evt.event !== 'session:end' && evt.event !== 'tts:generated') continue;
        v3Events += 1;

        if (cutoffMs && evt.ts) {
            const tsMs = Date.parse(evt.ts);
            if (Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
        }

        const skill = evt.skill || 'unknown';
        const phase = evt.phase || 'unknown';
        const issue = evt.issue || null;
        const provider = evt.provider || null;
        const mode = evt.event === 'session:end' ? classifyExecutionMode(evt.model) : null;

        if (!byAgent.has(skill)) byAgent.set(skill, emptyBucket());
        addToBucket(byAgent.get(skill), evt);

        if (!byPhase.has(phase)) byPhase.set(phase, emptyBucket());
        addToBucket(byPhase.get(phase), evt);

        if (issue) {
            if (!byIssue.has(issue)) byIssue.set(issue, {
                total: emptyBucket(),
                timeline: [],
                by_skill: new Map(),        // skill → bucket (tokens/costo por skill dentro del issue)
                tts_by_provider: new Map(), // provider → bucket (TTS por issue y provider)
            });
            const entry = byIssue.get(issue);
            addToBucket(entry.total, evt);

            if (!entry.by_skill.has(skill)) entry.by_skill.set(skill, emptyBucket());
            addToBucket(entry.by_skill.get(skill), evt);

            if (evt.event === 'tts:generated' && provider) {
                if (!entry.tts_by_provider.has(provider)) entry.tts_by_provider.set(provider, emptyBucket());
                addToBucket(entry.tts_by_provider.get(provider), evt);
            }

            entry.timeline.push({
                event: evt.event,
                skill,
                phase,
                ts: evt.ts,
                tokens: evt.event === 'session:end' ? (Number(evt.tokens_in || 0) + Number(evt.tokens_out || 0)) : null,
                cache: evt.event === 'session:end' ? (Number(evt.cache_read || 0) + Number(evt.cache_write || 0)) : null,
                duration_ms: evt.event === 'session:end' ? Number(evt.duration_ms || 0) : null,
                cost_usd: evt.event === 'session:end' ? estimateCostUsd(evt.model, evt) : Number(evt.cost_estimate_usd || 0),
                tts_chars: evt.event === 'tts:generated' ? Number(evt.chars || 0) : null,
                tts_audio_seconds: evt.event === 'tts:generated' ? Number(evt.audio_seconds || 0) : null,
                model: evt.model || provider || null,
                execution_mode: mode,
            });
        }

        if (evt.event === 'tts:generated' && provider) {
            if (!byProvider.has(provider)) byProvider.set(provider, emptyBucket());
            addToBucket(byProvider.get(provider), evt);

            const key = `${skill}|${provider}`;
            if (!byAgentProvider.has(key)) byAgentProvider.set(key, emptyBucket());
            addToBucket(byAgentProvider.get(key), evt);
        }

        if (evt.event === 'session:end' && mode) {
            const key = `${skill}|${mode}`;
            if (!byAgentMode.has(key)) byAgentMode.set(key, emptyBucket());
            addToBucket(byAgentMode.get(key), evt);
        }

        // Serie temporal diaria para proyecciones (#2488)
        if (evt.ts) {
            const day = String(evt.ts).substring(0, 10); // YYYY-MM-DD
            if (!dailySeries.has(day)) dailySeries.set(day, { cost_usd: 0, tts_cost_usd: 0, sessions: 0, tts_chars: 0, tts_audio_seconds: 0 });
            const d = dailySeries.get(day);
            if (evt.event === 'session:end') {
                d.cost_usd += estimateCostUsd(evt.model, evt);
                d.sessions += 1;
            } else if (evt.event === 'tts:generated') {
                d.tts_cost_usd += Number(evt.cost_estimate_usd || 0);
                d.tts_chars += Number(evt.chars || 0);
                d.tts_audio_seconds += Number(evt.audio_seconds || 0);
            }
        }

        // Buckets por (día, hora) para baseline horario (#2891 PR-B).
        // Solo session:end aporta cost_usd; tts:generated lo contabilizamos también
        // para tener el costo total por hora (cost_usd incluye tts).
        if (evt.ts) {
            const tsMs = Date.parse(evt.ts);
            if (Number.isFinite(tsMs)) {
                const d = new Date(tsMs);
                const hourKey = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}`;
                if (!hourlyBuckets.has(hourKey)) hourlyBuckets.set(hourKey, { cost_usd: 0, tokens: 0, sessions: 0 });
                const hb = hourlyBuckets.get(hourKey);
                if (evt.event === 'session:end') {
                    hb.cost_usd += estimateCostUsd(evt.model, evt);
                    hb.tokens += Number(evt.tokens_in || 0) + Number(evt.tokens_out || 0);
                    hb.sessions += 1;
                } else if (evt.event === 'tts:generated') {
                    hb.cost_usd += Number(evt.cost_estimate_usd || 0);
                }
                // (#2892 PR-C) breakdown por skill dentro de la franja, para el
                // mensaje "Top 3 skills consumidores" del Telegram alert.
                const bySkillKey = `${hourKey}|${skill}`;
                let bySkillCost = hourlyBySkill.get(bySkillKey) || 0;
                if (evt.event === 'session:end') {
                    bySkillCost += estimateCostUsd(evt.model, evt);
                } else if (evt.event === 'tts:generated') {
                    bySkillCost += Number(evt.cost_estimate_usd || 0);
                }
                hourlyBySkill.set(bySkillKey, bySkillCost);
            }
        }
    }

    const agents = [...byAgent.entries()].map(([k, v]) => Object.assign({ skill: k }, withAvg(v)));
    const phases = [...byPhase.entries()].map(([k, v]) => Object.assign({ phase: k }, withAvg(v)));

    const issues = [...byIssue.entries()].map(([k, v]) => {
        v.timeline.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        const bySkill = [...v.by_skill.entries()].map(([s, b]) => Object.assign({ skill: s }, withAvg(b)));
        const ttsByProvider = [...v.tts_by_provider.entries()].map(([p, b]) => Object.assign({ provider: p }, withAvg(b)));
        bySkill.sort((a, b) => b.cost_usd - a.cost_usd);
        ttsByProvider.sort((a, b) => b.tts_cost_usd - a.tts_cost_usd);
        return Object.assign({
            issue: k,
            timeline: v.timeline,
            by_skill: bySkill,
            tts_by_provider: ttsByProvider,
        }, withAvg(v.total));
    });

    const tts = {
        by_provider: [...byProvider.entries()].map(([k, v]) => Object.assign({ provider: k }, withAvg(v))),
        by_agent: [...byAgentProvider.entries()].map(([k, v]) => {
            const [skill, provider] = k.split('|');
            return Object.assign({ skill, provider }, withAvg(v));
        }),
        // TTS por issue — ranking completo (#2488)
        by_issue: issues
            .filter(i => i.tts_chars > 0 || i.tts_audio_seconds > 0)
            .map(i => ({
                issue: i.issue,
                tts_chars: i.tts_chars,
                tts_audio_seconds: i.tts_audio_seconds,
                tts_cost_usd: i.tts_cost_usd,
                tts_count: i.tts_count,
                by_provider: i.tts_by_provider,
            }))
            .sort((a, b) => b.tts_cost_usd - a.tts_cost_usd),
    };

    // Comparativa LLM vs determinístico (#2488)
    const modeComparison = [...byAgentMode.entries()].map(([k, v]) => {
        const [skill, execution_mode] = k.split('|');
        return Object.assign({ skill, execution_mode }, withAvg(v));
    });
    // Para cada skill que tiene ambos modos, calcular % de ahorro cuando det > 0
    const modeBySkill = {};
    for (const row of modeComparison) {
        modeBySkill[row.skill] = modeBySkill[row.skill] || {};
        modeBySkill[row.skill][row.execution_mode] = row;
    }
    const llmVsDeterministic = Object.entries(modeBySkill).map(([skill, byMode]) => {
        const llm = byMode.llm || null;
        const det = byMode.deterministic || null;
        const llmAvgCost = llm && llm.sessions > 0 ? llm.cost_usd / llm.sessions : 0;
        const detSessions = det ? det.sessions : 0;
        const savingsUsd = Math.round(detSessions * llmAvgCost * 10000) / 10000;
        return {
            skill,
            llm_sessions: llm ? llm.sessions : 0,
            llm_cost_usd: llm ? llm.cost_usd : 0,
            llm_avg_cost_per_session: Math.round(llmAvgCost * 10000) / 10000,
            deterministic_sessions: detSessions,
            deterministic_cost_usd: det ? det.cost_usd : 0,
            estimated_savings_usd: savingsUsd,
            migrated: !!det && detSessions > 0,
        };
    }).sort((a, b) => b.estimated_savings_usd - a.estimated_savings_usd);

    // Rankings
    agents.sort((a, b) => b.cost_usd - a.cost_usd);
    phases.sort((a, b) => b.cost_usd - a.cost_usd);
    issues.sort((a, b) => b.cost_usd - a.cost_usd);
    tts.by_provider.sort((a, b) => b.tts_cost_usd - a.tts_cost_usd);
    tts.by_agent.sort((a, b) => b.tts_cost_usd - a.tts_cost_usd);

    // Serie diaria ordenada (para proyecciones)
    const daily = [...dailySeries.entries()]
        .map(([day, d]) => ({ day, ...d, cost_usd: Math.round(d.cost_usd * 10000) / 10000, tts_cost_usd: Math.round(d.tts_cost_usd * 10000) / 10000 }))
        .sort((a, b) => a.day.localeCompare(b.day));

    const projections = computeProjections({ daily, now: new Date(nowMs) });

    // Baseline horario y hora actual (#2891 PR-B).
    // hourlySeries[HH] = promedio por hora-del-día calculado sobre los días en
    // [lookbackCutoff, today_start). El día de hoy NO entra al baseline porque
    // es la "actual" parcial — eso evita auto-confirmar anomalías.
    const hourly = computeHourlySeries({ hourlyBuckets, nowMs, lookbackCutoffMs });
    const currentHour = computeCurrentHour({ hourlyBuckets, hourlyBySkill, nowMs });

    return {
        generated_at: new Date().toISOString(),
        window: options.window || 'all',
        cutoff_ts: cutoffMs ? new Date(cutoffMs).toISOString() : null,
        totals: {
            sessions: agents.reduce((s, a) => s + a.sessions, 0),
            tokens_in: agents.reduce((s, a) => s + a.tokens_in, 0),
            tokens_out: agents.reduce((s, a) => s + a.tokens_out, 0),
            cache_read: agents.reduce((s, a) => s + a.cache_read, 0),
            cache_write: agents.reduce((s, a) => s + a.cache_write, 0),
            cost_usd: Math.round(agents.reduce((s, a) => s + a.cost_usd, 0) * 10000) / 10000,
            tts_chars: agents.reduce((s, a) => s + a.tts_chars, 0),
            tts_audio_seconds: Math.round(agents.reduce((s, a) => s + a.tts_audio_seconds, 0) * 10) / 10,
            tts_cost_usd: Math.round(agents.reduce((s, a) => s + a.tts_cost_usd, 0) * 10000) / 10000,
            v3_events: v3Events,
            total_log_lines: totalEvents,
        },
        agents,
        phases,
        issues,
        tts,
        llm_vs_deterministic: llmVsDeterministic,
        daily,
        projections,
        hourlySeries: hourly.series,
        hourlyMeta: hourly.meta,
        currentHour,
        pricing: MODEL_PRICING,
    };
}

// Calcula hourlySeries["HH"] como promedio cost_usd/tokens/sessions de la
// hora-del-día sobre los días dentro de [lookbackCutoffMs, today_start).
// Si una hora no fue observada en el window, devuelve ceros con samples=0.
// El denominador es la cantidad de días distintos del window que tuvieron
// cualquier dato — así no penalizamos pre-warmup con divisores grandes
// artificiales (eso lo cubre la lógica de WARMUP_DAYS en el detector).
function computeHourlySeries({ hourlyBuckets, nowMs, lookbackCutoffMs }) {
    const today = new Date(nowMs);
    const todayStartMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0);
    const distinctDays = new Set();
    const series = {};
    const sums = {};
    for (let h = 0; h < 24; h++) {
        const HH = pad2(h);
        sums[HH] = { cost_usd: 0, tokens: 0, sessions: 0, samples: 0 };
    }
    for (const [key, bucket] of hourlyBuckets) {
        const [day, HH] = key.split(' ');
        if (!HH || !sums[HH]) continue;
        const dayMs = Date.parse(day + 'T00:00:00Z');
        if (!Number.isFinite(dayMs)) continue;
        if (dayMs < lookbackCutoffMs) continue;     // fuera del window
        if (dayMs >= todayStartMs) continue;        // hoy es "actual", no baseline
        sums[HH].cost_usd += bucket.cost_usd;
        sums[HH].tokens += bucket.tokens;
        sums[HH].sessions += bucket.sessions;
        sums[HH].samples += 1;
        distinctDays.add(day);
    }
    const denom = Math.max(1, distinctDays.size);
    for (let h = 0; h < 24; h++) {
        const HH = pad2(h);
        const s = sums[HH];
        series[HH] = {
            cost_usd: Math.round((s.cost_usd / denom) * 10000) / 10000,
            tokens: Math.round(s.tokens / denom),
            sessions: Math.round((s.sessions / denom) * 100) / 100,
            samples: s.samples,
        };
    }
    return {
        series,
        meta: {
            lookbackDays: Math.round((nowMs - lookbackCutoffMs) / 86400e3),
            daysWithData: distinctDays.size,
            windowStart: new Date(lookbackCutoffMs).toISOString(),
            windowEnd: new Date(todayStartMs).toISOString(),
        },
    };
}

function computeCurrentHour({ hourlyBuckets, hourlyBySkill, nowMs }) {
    const now = new Date(nowMs);
    const HH = pad2(now.getUTCHours());
    const date = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    const key = `${date} ${HH}`;
    const b = hourlyBuckets.get(key) || { cost_usd: 0, tokens: 0, sessions: 0 };
    // (#2892 PR-C) bySkill: array ordenado desc por cost_usd, en la franja
    // actual. El alert builder de Telegram extrae los top-N de acá. Si la
    // hora actual aún no tiene buckets, devuelve [].
    let bySkill = [];
    if (hourlyBySkill instanceof Map) {
        const prefix = key + '|';
        const entries = [];
        for (const [k, v] of hourlyBySkill.entries()) {
            if (typeof k === 'string' && k.startsWith(prefix)) {
                entries.push({ skill: k.slice(prefix.length), cost_usd: Math.round(Number(v) * 10000) / 10000 });
            }
        }
        entries.sort((x, y) => y.cost_usd - x.cost_usd);
        bySkill = entries;
    }
    return {
        hour: HH,
        date,
        cost_usd: Math.round(b.cost_usd * 10000) / 10000,
        tokens: b.tokens,
        sessions: b.sessions,
        ts: now.toISOString(),
        bySkill,
    };
}

function emitEmptySnapshot(options) {
    const nowMs = (options && options.nowMs != null) ? Number(options.nowMs) : Date.now();
    const lookbackDays = clampLookbackDays(options && options.lookbackDays);
    const lookbackCutoffMs = nowMs - lookbackDays * 86400e3;
    const hourly = computeHourlySeries({ hourlyBuckets: new Map(), nowMs, lookbackCutoffMs });
    const currentHour = computeCurrentHour({ hourlyBuckets: new Map(), hourlyBySkill: new Map(), nowMs });
    return {
        generated_at: new Date(nowMs).toISOString(),
        window: (options && options.window) || 'all',
        cutoff_ts: null,
        totals: emptyBucket(),
        agents: [], phases: [], issues: [],
        tts: { by_provider: [], by_agent: [], by_issue: [] },
        llm_vs_deterministic: [],
        daily: [],
        projections: computeProjections({ daily: [], now: new Date(nowMs) }),
        hourlySeries: hourly.series,
        hourlyMeta: hourly.meta,
        currentHour,
        pricing: MODEL_PRICING,
    };
}

function writeSnapshot(snap) {
    ensureDir(METRICS_DIR);
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
}

async function runOnce(options) {
    const snap = await buildSnapshot(options);
    writeSnapshot(snap);
    return snap;
}

function parseArgs(argv) {
    const args = { once: false, window: 'all', refreshMs: DEFAULT_REFRESH_MS, lookbackDays: DEFAULT_LOOKBACK_DAYS };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') args.once = true;
        else if (a === '--window' && argv[i + 1]) { args.window = argv[++i]; }
        else if (a === '--refresh' && argv[i + 1]) { args.refreshMs = Math.max(5000, parseInt(argv[++i], 10) || DEFAULT_REFRESH_MS); }
        else if (a === '--lookback-days' && argv[i + 1]) { args.lookbackDays = clampLookbackDays(parseInt(argv[++i], 10)); }
        else if (a === '--help' || a === '-h') {
            process.stdout.write('Uso: aggregator.js [--once] [--window 1h|24h|7d|all] [--refresh ms] [--lookback-days 7-14]\n');
            process.exit(0);
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.once) {
        const snap = await runOnce(args);
        process.stdout.write(`[aggregator] snapshot window=${args.window} sessions=${snap.totals.sessions || 0} cost=$${(snap.totals.cost_usd || 0).toFixed(4)} tts=$${(snap.totals.tts_cost_usd || 0).toFixed(4)}\n`);
        return;
    }
    let busy = false;
    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const snap = await runOnce(args);
            process.stdout.write(`[aggregator] ${new Date().toISOString()} ventana=${args.window} sesiones=${snap.totals.sessions || 0} costo=$${(snap.totals.cost_usd || 0).toFixed(4)}\n`);
        } catch (e) {
            process.stderr.write(`[aggregator] error: ${e.message}\n`);
        } finally { busy = false; }
    }
    await tick();
    setInterval(tick, args.refreshMs);
}

if (require.main === module) {
    main().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });
}

module.exports = {
    buildSnapshot,
    runOnce,
    writeSnapshot,
    classifyExecutionMode,
    computeHourlySeries,
    computeCurrentHour,
    clampLookbackDays,
    DEFAULT_LOOKBACK_DAYS,
    MIN_LOOKBACK_DAYS,
    MAX_LOOKBACK_DAYS,
    SNAPSHOT_FILE,
    METRICS_DIR,
};

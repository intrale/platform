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
// Consumido por dashboard-v2.js y report-daily.js.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { LOG_FILE, REPO_ROOT, estimateCostUsd, MODEL_PRICING } = require('../lib/traceability');
const { computeProjections } = require('./projections');

const METRICS_DIR = path.join(REPO_ROOT, '.pipeline', 'metrics');
const SNAPSHOT_FILE = path.join(METRICS_DIR, 'snapshot.json');
const DEFAULT_REFRESH_MS = 60000;

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
    const nowMs = Date.now();
    const cutoffMs = windowMs ? nowMs - windowMs : null;

    const byAgent = new Map();        // skill → bucket
    const byPhase = new Map();        // phase → bucket
    const byIssue = new Map();        // issue → { total: bucket, timeline, by_skill, tts_by_provider } (#2488)
    const byProvider = new Map();     // provider → bucket (TTS)
    const byAgentProvider = new Map();// `${skill}|${provider}` → bucket (TTS)
    const byAgentMode = new Map();    // `${skill}|${mode}` → bucket (#2488 — LLM vs determinístico)
    const dailySeries = new Map();    // YYYY-MM-DD → { cost_usd, tts_cost_usd, sessions } (para proyecciones)

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
        pricing: MODEL_PRICING,
    };
}

function emitEmptySnapshot(options) {
    return {
        generated_at: new Date().toISOString(),
        window: (options && options.window) || 'all',
        cutoff_ts: null,
        totals: emptyBucket(),
        agents: [], phases: [], issues: [],
        tts: { by_provider: [], by_agent: [], by_issue: [] },
        llm_vs_deterministic: [],
        daily: [],
        projections: computeProjections({ daily: [], now: new Date() }),
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
    const args = { once: false, window: 'all', refreshMs: DEFAULT_REFRESH_MS };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') args.once = true;
        else if (a === '--window' && argv[i + 1]) { args.window = argv[++i]; }
        else if (a === '--refresh' && argv[i + 1]) { args.refreshMs = Math.max(5000, parseInt(argv[++i], 10) || DEFAULT_REFRESH_MS); }
        else if (a === '--help' || a === '-h') {
            process.stdout.write('Uso: aggregator.js [--once] [--window 1h|24h|7d|all] [--refresh ms]\n');
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

module.exports = { buildSnapshot, runOnce, writeSnapshot, classifyExecutionMode, SNAPSHOT_FILE, METRICS_DIR };

#!/usr/bin/env node
// Multi-Bot Aggregator (#2854) — consolida snapshots de varios bots que
// comparten la misma cuenta Anthropic en un único `multi-bot-snapshot.json`.
//
// Funcionamiento:
//   1. Lee la lista de bots de `metrics/multi-bot-config.json`.
//   2. Por cada bot habilitado intenta abrir su `snapshot_path`.
//      - Si no existe / está corrupto → lo registra en `bots_unavailable`
//        sin abortar (fail-open).
//   3. Suma totales globales y mantiene un breakdown por bot, por
//      bot×skill (agente), por bot×issue.
//   4. Drill-down completo: bot → agente → issue (re-expone los issues
//      de cada bot con el bot_id pegado para filtrar en UI).
//
// Output: `metrics/multi-bot-snapshot.json` con:
//   {
//     generated_at, window, bots_count, bots_available, bots_unavailable[],
//     totals: { cost_usd, sessions, tokens_in, tokens_out, cache_read,
//               cache_write, tts_cost_usd },
//     by_bot: [{ bot_id, label, totals, agents[], issues[] }],
//     by_skill: [{ skill, total_cost_usd, by_bot: [{bot_id, cost_usd}] }],
//     by_issue: [{ issue, bot_id, cost_usd, by_skill[] }],
//   }
//
// Modos:
//   node multi-bot-aggregator.js               → daemon, refresh cada 60s
//   node multi-bot-aggregator.js --once        → consolida y exit
//
// El consumidor principal es el dashboard `/metrics/multi-bot/*`.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const METRICS_DIR = path.join(PIPELINE_DIR, 'metrics');
const CONFIG_FILE = path.join(METRICS_DIR, 'multi-bot-config.json');
const OUTPUT_FILE = path.join(METRICS_DIR, 'multi-bot-snapshot.json');
const DEFAULT_REFRESH_MS = 60000;

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function loadConfig() {
    const cfg = readJsonSafe(CONFIG_FILE);
    if (!cfg || !Array.isArray(cfg.bots)) {
        return { bots: [] };
    }
    return cfg;
}

// Resuelve un path del config — si es relativo, lo ancla al REPO_ROOT
// del proyecto Intrale (porque los otros bots viven en repos hermanos).
function resolveSnapshotPath(rawPath) {
    if (path.isAbsolute(rawPath)) return rawPath;
    return path.resolve(REPO_ROOT, rawPath);
}

function emptyTotals() {
    return {
        sessions: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read: 0,
        cache_write: 0,
        cost_usd: 0,
        tts_cost_usd: 0,
    };
}

function addInto(target, source) {
    if (!source) return;
    target.sessions += Number(source.sessions || 0);
    target.tokens_in += Number(source.tokens_in || 0);
    target.tokens_out += Number(source.tokens_out || 0);
    target.cache_read += Number(source.cache_read || 0);
    target.cache_write += Number(source.cache_write || 0);
    target.cost_usd += Number(source.cost_usd || 0);
    target.tts_cost_usd += Number(source.tts_cost_usd || 0);
}

function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }

function consolidate() {
    const cfg = loadConfig();
    const enabledBots = (cfg.bots || []).filter(b => b.enabled !== false);

    const totals = emptyTotals();
    const byBot = [];
    const bySkillMap = new Map();    // skill → { skill, total_cost_usd, by_bot: Map<bot_id, cost> }
    const byIssue = [];               // [{ issue, bot_id, label, ... }]
    const botsUnavailable = [];

    for (const botCfg of enabledBots) {
        const snapPath = resolveSnapshotPath(botCfg.snapshot_path || '');
        const snap = readJsonSafe(snapPath);
        if (!snap) {
            botsUnavailable.push({
                bot_id: botCfg.bot_id,
                label: botCfg.label || botCfg.bot_id,
                snapshot_path: snapPath,
                reason: fs.existsSync(snapPath) ? 'invalid_json' : 'not_found',
            });
            continue;
        }

        // Tolerancia: el snapshot puede no traer bot_id (bots que aún no
        // se actualizaron). Caer al config.
        const botId = snap.bot_id || botCfg.bot_id;
        const label = snap.bot_label || botCfg.label || botId;

        const botTotals = emptyTotals();
        addInto(botTotals, snap.totals || {});
        addInto(totals, botTotals);

        const agents = Array.isArray(snap.agents) ? snap.agents : [];
        const issues = Array.isArray(snap.issues) ? snap.issues : [];

        // Agentes — agregar al breakdown global por skill
        for (const a of agents) {
            const skill = a.skill || 'unknown';
            if (!bySkillMap.has(skill)) {
                bySkillMap.set(skill, {
                    skill,
                    total_cost_usd: 0,
                    sessions: 0,
                    by_bot: new Map(),
                });
            }
            const entry = bySkillMap.get(skill);
            entry.total_cost_usd += Number(a.cost_usd || 0);
            entry.sessions += Number(a.sessions || 0);
            const prev = entry.by_bot.get(botId) || { bot_id: botId, label, cost_usd: 0, sessions: 0 };
            prev.cost_usd += Number(a.cost_usd || 0);
            prev.sessions += Number(a.sessions || 0);
            entry.by_bot.set(botId, prev);
        }

        // Issues — pegar bot_id para filtrar en UI sin perder identidad
        for (const i of issues) {
            byIssue.push({
                bot_id: botId,
                bot_label: label,
                issue: i.issue,
                sessions: i.sessions || 0,
                cost_usd: Number(i.cost_usd || 0),
                tokens_in: i.tokens_in || 0,
                tokens_out: i.tokens_out || 0,
                cache_read: i.cache_read || 0,
                cache_write: i.cache_write || 0,
                tts_cost_usd: Number(i.tts_cost_usd || 0),
                by_skill: Array.isArray(i.by_skill) ? i.by_skill : [],
            });
        }

        byBot.push({
            bot_id: botId,
            label,
            owner: botCfg.owner || null,
            generated_at: snap.generated_at || null,
            window: snap.window || 'all',
            totals: {
                sessions: botTotals.sessions,
                tokens_in: botTotals.tokens_in,
                tokens_out: botTotals.tokens_out,
                cache_read: botTotals.cache_read,
                cache_write: botTotals.cache_write,
                cost_usd: round4(botTotals.cost_usd),
                tts_cost_usd: round4(botTotals.tts_cost_usd),
            },
            agents,
            issues_count: issues.length,
            agents_count: agents.length,
            // Top-3 issues por costo para vista rápida
            top_issues: issues.slice(0, 3).map(i => ({
                issue: i.issue,
                cost_usd: round4(i.cost_usd || 0),
                sessions: i.sessions || 0,
            })),
        });
    }

    const bySkill = [...bySkillMap.values()]
        .map(e => ({
            skill: e.skill,
            total_cost_usd: round4(e.total_cost_usd),
            sessions: e.sessions,
            by_bot: [...e.by_bot.values()]
                .map(b => ({ ...b, cost_usd: round4(b.cost_usd) }))
                .sort((a, b) => b.cost_usd - a.cost_usd),
        }))
        .sort((a, b) => b.total_cost_usd - a.total_cost_usd);

    byIssue.sort((a, b) => b.cost_usd - a.cost_usd);
    byBot.sort((a, b) => b.totals.cost_usd - a.totals.cost_usd);

    return {
        generated_at: new Date().toISOString(),
        bots_configured: enabledBots.length,
        bots_available: byBot.length,
        bots_unavailable: botsUnavailable,
        totals: {
            sessions: totals.sessions,
            tokens_in: totals.tokens_in,
            tokens_out: totals.tokens_out,
            cache_read: totals.cache_read,
            cache_write: totals.cache_write,
            cost_usd: round4(totals.cost_usd),
            tts_cost_usd: round4(totals.tts_cost_usd),
        },
        by_bot: byBot,
        by_skill: bySkill,
        by_issue: byIssue,
    };
}

function writeSnapshot(snap) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    const tmp = OUTPUT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmp, OUTPUT_FILE);
}

function runOnce() {
    const snap = consolidate();
    writeSnapshot(snap);
    return snap;
}

function parseArgs(argv) {
    const args = { once: false, refreshMs: DEFAULT_REFRESH_MS };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') args.once = true;
        else if (a === '--refresh' && argv[i + 1]) {
            args.refreshMs = Math.max(5000, parseInt(argv[++i], 10) || DEFAULT_REFRESH_MS);
        } else if (a === '--help' || a === '-h') {
            process.stdout.write('Uso: multi-bot-aggregator.js [--once] [--refresh ms]\n');
            process.exit(0);
        }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);
    const tick = () => {
        try {
            const snap = runOnce();
            process.stdout.write(`[multi-bot] ${new Date().toISOString()} bots=${snap.bots_available}/${snap.bots_configured} costo=$${snap.totals.cost_usd.toFixed(4)}\n`);
        } catch (e) {
            process.stderr.write(`[multi-bot] error: ${e.message}\n`);
        }
    };
    tick();
    if (!args.once) setInterval(tick, args.refreshMs);
}

if (require.main === module) {
    main();
}

module.exports = { consolidate, runOnce, writeSnapshot, OUTPUT_FILE, CONFIG_FILE };

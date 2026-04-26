// V3 Traceability helpers — emite eventos session:start / session:end al activity-log
// Contrato definido en issue #2477. Los consumen skills LLM y skills determinísticos.
//
// Uso típico (skill determinístico):
//   const trace = require('./traceability');
//   const ctx = trace.emitSessionStart({ skill: 'builder', issue: 2476, phase: 'build', model: 'deterministic' });
//   // ... trabajo ...
//   trace.emitSessionEnd(ctx, { tool_calls: 0 });
//
// Uso típico (skill LLM, instrumentación desde pulpo.js):
//   const ctx = trace.emitSessionStart({ skill: 'android-dev', issue: 2476, phase: 'dev', model: 'claude-opus-4-7' });
//   // al terminar, extraer tokens del stream-json:
//   trace.emitSessionEnd(ctx, { tokens_in, tokens_out, cache_read, cache_write, tool_calls });

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolveRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || process.env.PIPELINE_REPO_ROOT || 'C:\\Workspaces\\Intrale\\platform';
    try {
        const gitCommon = execSync('git rev-parse --git-common-dir', { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, '/');
        if (gitCommon === '.git') return candidate;
        const gitIdx = gitCommon.indexOf('/.git');
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, '..');
    } catch (e) { return candidate; }
}

const REPO_ROOT = resolveRepoRoot();
const LOG_FILE = path.join(REPO_ROOT, '.claude', 'activity-log.jsonl');

function appendEvent(evt) {
    try {
        const line = JSON.stringify(evt) + '\n';
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (e) {
        // no throw — la traza nunca debe romper un skill
        try { process.stderr.write('[traceability] append failed: ' + e.message + '\n'); } catch(_) {}
    }
}

function pick(obj, key, fallback) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    return fallback;
}

function envCtx() {
    return {
        skill: process.env.PIPELINE_SKILL || null,
        issue: process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null,
        phase: process.env.PIPELINE_FASE || process.env.PIPELINE_PHASE || null,
    };
}

function emitSessionStart(opts) {
    opts = opts || {};
    const env = envCtx();
    const ctx = {
        event: 'session:start',
        skill: pick(opts, 'skill', env.skill),
        issue: pick(opts, 'issue', env.issue),
        phase: pick(opts, 'phase', env.phase),
        model: pick(opts, 'model', 'deterministic'),
        ts: new Date().toISOString(),
        pid: process.pid,
    };
    appendEvent(ctx);
    // handle que los callers pasan a emitSessionEnd para preservar start_ts y ctx
    return {
        skill: ctx.skill,
        issue: ctx.issue,
        phase: ctx.phase,
        model: ctx.model,
        start_ts: Date.now(),
        pid: ctx.pid,
    };
}

function emitSessionEnd(handle, metrics) {
    handle = handle || {};
    metrics = metrics || {};
    const env = envCtx();
    const startMs = handle.start_ts || Date.now();
    const evt = {
        event: 'session:end',
        skill: pick(handle, 'skill', env.skill),
        issue: pick(handle, 'issue', env.issue),
        phase: pick(handle, 'phase', env.phase),
        model: pick(handle, 'model', 'deterministic'),
        tokens_in: Number(metrics.tokens_in || 0),
        tokens_out: Number(metrics.tokens_out || 0),
        cache_read: Number(metrics.cache_read || 0),
        cache_write: Number(metrics.cache_write || 0),
        duration_ms: Number(metrics.duration_ms || (Date.now() - startMs)),
        tool_calls: Number(metrics.tool_calls || 0),
        exit_code: metrics.exit_code === undefined ? null : Number(metrics.exit_code),
        ts: new Date().toISOString(),
        pid: handle.pid || process.pid,
    };
    appendEvent(evt);
    return evt;
}

// Helper pricing (input/output/cache read/cache write) — USD por 1M tokens
// Fuente: pricing público Anthropic. Actualizar acá si cambian precios.
const MODEL_PRICING = {
    'claude-opus-4-7':    { in: 15.00, out: 75.00, cache_read: 1.50,  cache_write: 18.75 },
    'claude-opus-4-6':    { in: 15.00, out: 75.00, cache_read: 1.50,  cache_write: 18.75 },
    'claude-sonnet-4-6':  { in:  3.00, out: 15.00, cache_read: 0.30,  cache_write:  3.75 },
    'claude-haiku-4-5':   { in:  1.00, out:  5.00, cache_read: 0.10,  cache_write:  1.25 },
    'deterministic':      { in:  0.00, out:  0.00, cache_read: 0.00,  cache_write:  0.00 },
};

function estimateCostUsd(model, tokens) {
    const key = String(model || '').toLowerCase().replace(/-\d{8}$/, '').trim();
    const p = MODEL_PRICING[key] || MODEL_PRICING['deterministic'];
    const ti = Number(tokens && tokens.tokens_in || 0);
    const to = Number(tokens && tokens.tokens_out || 0);
    const cr = Number(tokens && tokens.cache_read || 0);
    const cw = Number(tokens && tokens.cache_write || 0);
    const cost = (ti * p.in + to * p.out + cr * p.cache_read + cw * p.cache_write) / 1e6;
    return Math.round(cost * 10000) / 10000; // 4 decimales
}

module.exports = {
    emitSessionStart,
    emitSessionEnd,
    appendEvent,           // expuesto para extensión (ej: tts-logger.js)
    estimateCostUsd,
    MODEL_PRICING,
    LOG_FILE,
    REPO_ROOT,
};

// =============================================================================
// Tests handoffMetricsSlice — #2993 (CA-C2)
//
// Valida que el slice del dashboard:
//   - lee `.claude/activity-log.jsonl`
//   - calcula hit rate y fallback %
//   - expone tokens_in_24h y bytes_out_7d
//   - genera sparkline 7d
//   - estima USD/mes con pricing conservador
//   - NUNCA expone contenido del handoff (CA-C1)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');

function mkTmpRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-handoff-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    return {
        repoRoot: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
        appendEvents(events) {
            const file = path.join(dir, '.claude', 'activity-log.jsonl');
            fs.appendFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
        },
    };
}

function mkSessionEnd(opts) {
    return {
        event: 'session:end',
        skill: opts.skill || 'guru',
        issue: opts.issue || 1234,
        phase: opts.phase || 'verificacion',
        model: opts.model || 'claude-opus-4-7',
        tokens_in: opts.tokens_in || 1000,
        tokens_out: opts.tokens_out || 100,
        cache_read: 0,
        cache_write: 0,
        duration_ms: opts.duration_ms || 1000,
        tool_calls: 1,
        exit_code: 0,
        handoff_in_tokens: opts.handoff_in_tokens || 0,
        handoff_out_bytes: opts.handoff_out_bytes || 0,
        handoff_sections_in: opts.handoff_sections_in || 0,
        ts: opts.ts || new Date().toISOString(),
        pid: 1234,
    };
}

test('handoffMetricsSlice: archivo inexistente devuelve métrica vacía', () => {
    const tmp = mkTmpRepo();
    try {
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.sample_size, 0);
        assert.equal(out.hit_rate_pct, 0);
        assert.equal(out.fallback_pct, 0);
        assert.equal(out.tokens_in_24h, 0);
        assert.equal(out.bytes_out_7d, 0);
        assert.equal(out.usd_saved_estimate_monthly, 0);
        assert.equal(Array.isArray(out.sparkline), true);
        assert.equal(out.sparkline.length, 7);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: hit rate cuando todos los eventos tienen handoff', () => {
    const tmp = mkTmpRepo();
    try {
        const events = [
            mkSessionEnd({ handoff_in_tokens: 200, handoff_sections_in: 2, handoff_out_bytes: 1500 }),
            mkSessionEnd({ handoff_in_tokens: 300, handoff_sections_in: 3, handoff_out_bytes: 2000 }),
            mkSessionEnd({ handoff_in_tokens: 100, handoff_sections_in: 1, handoff_out_bytes: 800 }),
        ];
        tmp.appendEvents(events);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.sample_size, 3);
        assert.equal(out.hit_rate_pct, 100);
        assert.equal(out.fallback_pct, 0);
        assert.equal(out.tokens_in_24h, 600);
        assert.equal(out.bytes_out_7d, 4300);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: hit rate parcial', () => {
    const tmp = mkTmpRepo();
    try {
        tmp.appendEvents([
            mkSessionEnd({ handoff_in_tokens: 100, handoff_sections_in: 1 }),
            mkSessionEnd({ handoff_in_tokens: 0, handoff_sections_in: 0 }),
            mkSessionEnd({ handoff_in_tokens: 0, handoff_sections_in: 0 }),
            mkSessionEnd({ handoff_in_tokens: 200, handoff_sections_in: 2 }),
        ]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.sample_size, 4);
        assert.equal(out.hit_rate_pct, 50);
        assert.equal(out.fallback_pct, 50);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: ignora eventos > 7 días', () => {
    const tmp = mkTmpRepo();
    try {
        const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const recent = new Date().toISOString();
        tmp.appendEvents([
            mkSessionEnd({ ts: old, handoff_in_tokens: 9999 }),
            mkSessionEnd({ ts: recent, handoff_in_tokens: 100 }),
        ]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.sample_size, 1);  // sólo el reciente
        assert.equal(out.tokens_in_24h, 100);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: ignora eventos que no son session:end', () => {
    const tmp = mkTmpRepo();
    try {
        const file = path.join(tmp.repoRoot, '.claude', 'activity-log.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ event: 'session:start', ts: new Date().toISOString() }),
            JSON.stringify({ event: 'tts:played', ts: new Date().toISOString() }),
            JSON.stringify(mkSessionEnd({ handoff_in_tokens: 100, handoff_sections_in: 1 })),
        ].join('\n') + '\n');
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.sample_size, 1);
        assert.equal(out.hit_rate_pct, 100);
    } finally { tmp.cleanup(); }
});

test('CA-C1 · handoffMetricsSlice nunca expone contenido del handoff (sólo contadores)', () => {
    const tmp = mkTmpRepo();
    try {
        tmp.appendEvents([mkSessionEnd({ handoff_in_tokens: 500, handoff_sections_in: 3 })]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        const json = JSON.stringify(out);
        // Whitelist explícita de keys: solo metadata.
        const allowedKeys = new Set([
            'enabled', 'kill_switch', 'sample_window', 'sample_size',
            'hit_rate_pct', 'fallback_pct', 'tokens_in_24h', 'bytes_out_7d',
            'usd_saved_estimate_monthly', 'sparkline', 'updated_at',
        ]);
        for (const k of Object.keys(out)) {
            assert.ok(allowedKeys.has(k), `key inesperada en payload del slice: "${k}"`);
        }
        // Sparkline solo debe tener day, pct, total, with_handoff
        for (const item of out.sparkline) {
            for (const k of Object.keys(item)) {
                assert.ok(['day', 'pct', 'total', 'with_handoff'].includes(k));
            }
        }
        // No menciones de strings sensibles
        assert.ok(!/content|body|text|raw|excerpt/i.test(json));
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: USD savings estimate usa pricing conservador (Sonnet)', () => {
    const tmp = mkTmpRepo();
    try {
        // 1M tokens en 24h × $3/M = $3/día × 30 días = ~$90/mes.
        tmp.appendEvents([mkSessionEnd({ handoff_in_tokens: 1_000_000 })]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.usd_saved_estimate_monthly, 90);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: kill_switch en config se refleja en payload', () => {
    const tmp = mkTmpRepo();
    try {
        tmp.appendEvents([mkSessionEnd({})]);
        const out = slices.handoffMetricsSlice(null, {
            REPO_ROOT: tmp.repoRoot,
            config: { handoff: { enabled: true, kill_switch: true } },
        });
        assert.equal(out.enabled, false);     // kill_switch fuerza enabled=false
        assert.equal(out.kill_switch, true);
    } finally { tmp.cleanup(); }
});

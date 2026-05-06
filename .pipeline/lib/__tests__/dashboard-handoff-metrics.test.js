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
        // #2993 rev-2: agregamos top_issues y audit_events para alimentar la
        // tabla y la banda de auditoría del widget. Ambos contienen solo
        // metadata (issue#, skill, ts, status) — verificado abajo.
        const allowedKeys = new Set([
            'enabled', 'kill_switch', 'sample_window', 'sample_size',
            'hit_rate_pct', 'fallback_pct', 'tokens_in_24h', 'bytes_out_7d',
            'usd_saved_estimate_monthly', 'sparkline', 'updated_at',
            'top_issues', 'audit_events',
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
        // top_issues: solo issue#, skills, sections_in, tokens_in, bytes_out, status.
        // Sin títulos, sin descripciones, sin contenido del handoff.
        const allowedIssueKeys = new Set([
            'issue', 'skills', 'sections_in', 'tokens_in', 'bytes_out', 'status',
        ]);
        for (const item of out.top_issues || []) {
            for (const k of Object.keys(item)) {
                assert.ok(allowedIssueKeys.has(k),
                    `key inesperada en top_issues[]: "${k}" — viola CA-C1`);
            }
        }
        // audit_events: solo ts, agent, phase, issue, status, sections_in.
        // Sin mensajes propios, sin contenido del handoff.
        const allowedAuditKeys = new Set([
            'ts', 'agent', 'phase', 'issue', 'status', 'sections_in',
        ]);
        for (const item of out.audit_events || []) {
            for (const k of Object.keys(item)) {
                assert.ok(allowedAuditKeys.has(k),
                    `key inesperada en audit_events[]: "${k}" — viola CA-C1`);
            }
        }
        // No menciones de strings sensibles. Ojo con "text": un valor literal
        // como "verificacion" no contiene "text", pero queremos prohibir keys
        // como "text" o "raw_text".
        assert.ok(!/content|body|raw|excerpt/i.test(json),
            'payload sospechoso: contiene strings reservados a contenido');
        // Aseguramos que ningún valor literal del JSON tenga la palabra "text"
        // como substring de una key (no de un valor: "verificacion" pasa OK).
        for (const k of Object.keys(out)) assert.ok(!/text/i.test(k));
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

// =============================================================================
// #2993 rev-2 — top_issues y audit_events para el widget del dashboard.
// =============================================================================

test('handoffMetricsSlice: top_issues agrega por issue y ordena por tokens_in desc', () => {
    const tmp = mkTmpRepo();
    try {
        tmp.appendEvents([
            mkSessionEnd({ issue: 2993, skill: 'guru',     handoff_in_tokens: 5000, handoff_sections_in: 1 }),
            mkSessionEnd({ issue: 2993, skill: 'security', handoff_in_tokens: 4000, handoff_sections_in: 1 }),
            mkSessionEnd({ issue: 2993, skill: 'po',       handoff_in_tokens: 3000, handoff_sections_in: 1 }),
            mkSessionEnd({ issue: 2882, skill: 'guru',     handoff_in_tokens: 1000, handoff_sections_in: 1 }),
            mkSessionEnd({ issue: 2890, skill: 'po',       handoff_in_tokens:  500, handoff_sections_in: 1 }),
        ]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.ok(Array.isArray(out.top_issues));
        // ordenado desc por tokens_in
        assert.equal(out.top_issues[0].issue, 2993);
        assert.equal(out.top_issues[0].tokens_in, 12000);
        assert.deepEqual(out.top_issues[0].skills.sort(), ['guru', 'po', 'security']);
        assert.equal(out.top_issues[0].status, 'activo');
        assert.equal(out.top_issues[1].issue, 2882);
        assert.equal(out.top_issues[2].issue, 2890);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: top_issues máx 5', () => {
    const tmp = mkTmpRepo();
    try {
        const events = [];
        for (let i = 1; i <= 12; i++) {
            events.push(mkSessionEnd({
                issue: 1000 + i,
                handoff_in_tokens: i * 100,
                handoff_sections_in: 1,
            }));
        }
        tmp.appendEvents(events);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.top_issues.length, 5);
        // los 5 con más tokens_in
        assert.deepEqual(
            out.top_issues.map(i => i.issue),
            [1012, 1011, 1010, 1009, 1008]
        );
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: top_issues marca status=fallback cuando issue no leyó handoff', () => {
    const tmp = mkTmpRepo();
    try {
        tmp.appendEvents([
            mkSessionEnd({ issue: 2882, skill: 'guru', handoff_in_tokens: 0, handoff_sections_in: 0,
                          phase: 'aprobacion' }),
        ]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.top_issues.length, 1);
        assert.equal(out.top_issues[0].issue, 2882);
        assert.equal(out.top_issues[0].status, 'fallback');
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: audit_events expone últimos eventos en orden cronológico desc', () => {
    const tmp = mkTmpRepo();
    try {
        const now = Date.now();
        tmp.appendEvents([
            mkSessionEnd({ ts: new Date(now - 3 * 3600_000).toISOString(), skill: 'guru', issue: 2993, handoff_in_tokens: 100, handoff_sections_in: 1 }),
            mkSessionEnd({ ts: new Date(now - 2 * 3600_000).toISOString(), skill: 'security', issue: 2993, handoff_in_tokens: 50,  handoff_sections_in: 1 }),
            mkSessionEnd({ ts: new Date(now - 1 * 3600_000).toISOString(), skill: 'po',       issue: 2993, handoff_in_tokens: 200, handoff_sections_in: 2 }),
            mkSessionEnd({ ts: new Date(now -     30_000).toISOString(),   skill: 'qa',       issue: 2993, handoff_in_tokens: 0,   handoff_sections_in: 0,
                          phase: 'aprobacion' }),
        ]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.ok(Array.isArray(out.audit_events));
        assert.equal(out.audit_events.length, 4);
        // El más reciente (qa, fallback) primero
        assert.equal(out.audit_events[0].agent, 'qa');
        assert.equal(out.audit_events[0].status, 'FALLBACK');
        assert.equal(out.audit_events[0].issue, 2993);
        // Luego po, security, guru
        assert.equal(out.audit_events[1].agent, 'po');
        assert.equal(out.audit_events[1].status, 'OK');
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: audit_events límite 4 (cabe en banda del mockup)', () => {
    const tmp = mkTmpRepo();
    try {
        const events = [];
        for (let i = 0; i < 10; i++) {
            events.push(mkSessionEnd({
                ts: new Date(Date.now() - i * 60_000).toISOString(),
                skill: 'guru',
                issue: 2000 + i,
                handoff_in_tokens: 100,
                handoff_sections_in: 1,
            }));
        }
        tmp.appendEvents(events);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.audit_events.length, 4);
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: audit_events status=REDACTED cuando hay secrets', () => {
    const tmp = mkTmpRepo();
    try {
        const ev = mkSessionEnd({
            skill: 'security', issue: 2882,
            handoff_in_tokens: 100, handoff_sections_in: 1,
        });
        ev.handoff_secrets_redacted = 1; // CA-B3
        tmp.appendEvents([ev]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.audit_events.length, 1);
        assert.equal(out.audit_events[0].status, 'REDACTED');
    } finally { tmp.cleanup(); }
});

test('handoffMetricsSlice: audit_events status=TRUNCATED cuando hay sección truncada', () => {
    const tmp = mkTmpRepo();
    try {
        const ev = mkSessionEnd({
            skill: 'guru', issue: 2993,
            handoff_in_tokens: 100, handoff_sections_in: 1,
        });
        ev.handoff_truncated = 1; // CA-B6
        tmp.appendEvents([ev]);
        const out = slices.handoffMetricsSlice(null, { REPO_ROOT: tmp.repoRoot });
        assert.equal(out.audit_events.length, 1);
        assert.equal(out.audit_events[0].status, 'TRUNCATED');
    } finally { tmp.cleanup(); }
});

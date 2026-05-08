// =============================================================================
// Tests aggregator.js · bloque crossProvider — #3090
//
// Cubre:
//   CA-1   — shape de snapshot.crossProvider con fixture multi-provider real.
//   CA-9   — estado degradado pre-S5 (sin campo provider) y pre-H3 (1 solo
//            provider activo).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCrossProvider, isFixedSkill, FIXED_SKILLS } = require('../aggregator');

// -----------------------------------------------------------------------------
// Helpers para construir el Map<skill, {sessions[]}> que computeCrossProvider
// recibe internamente.
// -----------------------------------------------------------------------------

function fakeSession(opts) {
    const ts = opts.ts || '2026-05-05T10:00:00Z';
    return {
        ts,
        ts_ms: Date.parse(ts),
        provider: opts.provider != null ? opts.provider : 'anthropic',
        model: opts.model || 'claude-sonnet-4-6',
        cost_usd: Number(opts.cost_usd || 0.01),
        issue: Number.isInteger(opts.issue) ? opts.issue : null,
        sessions: 1,
    };
}

function buildMap(skillsConfig) {
    const m = new Map();
    for (const [skill, sessions] of Object.entries(skillsConfig)) {
        m.set(skill, { sessions: sessions.map(fakeSession) });
    }
    return m;
}

// -----------------------------------------------------------------------------
// CA-1 — Shape básico
// -----------------------------------------------------------------------------

test('CA-1 · shape de crossProvider con fixture multi-provider', () => {
    const map = buildMap({
        qa: [
            // Pre-switch: 5 sesiones con anthropic/sonnet a $0.01
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.01, issue: 3001 },
            { ts: '2026-05-01T09:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.01, issue: 3002 },
            { ts: '2026-05-01T10:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.01, issue: 3003 },
            { ts: '2026-05-01T11:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.01, issue: 3004 },
            { ts: '2026-05-01T12:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.01, issue: 3005 },
            // Switch: post-switch 5 sesiones con openai a $0.02 → +100%
            { ts: '2026-05-02T08:00:00Z', provider: 'openai', model: 'gpt-5-codex', cost_usd: 0.02, issue: 3006 },
            { ts: '2026-05-02T09:00:00Z', provider: 'openai', model: 'gpt-5-codex', cost_usd: 0.02, issue: 3007 },
            { ts: '2026-05-02T10:00:00Z', provider: 'openai', model: 'gpt-5-codex', cost_usd: 0.02, issue: 3008 },
            { ts: '2026-05-02T11:00:00Z', provider: 'openai', model: 'gpt-5-codex', cost_usd: 0.02, issue: 3009 },
            { ts: '2026-05-02T12:00:00Z', provider: 'openai', model: 'gpt-5-codex', cost_usd: 0.02, issue: 3010 },
        ],
    });

    const fromMs = Date.parse('2026-04-30T00:00:00Z');
    const toMs = Date.parse('2026-05-07T00:00:00Z');
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs,
        toMs,
    });

    assert.equal(cp.windowDays, 7);
    assert.ok(cp.from && cp.to);
    assert.equal(cp.bySkill.length, 1);
    const qa = cp.bySkill[0];
    assert.equal(qa.skill, 'qa');
    assert.equal(qa.providers.length, 2, 'qa debe tener 2 providers');
    assert.equal(qa.multi_provider, true);
    assert.equal(qa.fixed, false);
    assert.equal(qa.switches.length, 1);
    assert.equal(qa.pre_switch_sessions, 5);
    assert.equal(qa.post_switch_sessions, 5);
    // pre 0.01, post 0.02 → +100% delta
    assert.equal(qa.pre_switch_avg_cost_usd, 0.01);
    assert.equal(qa.post_switch_avg_cost_usd, 0.02);
    // Estado NO degradado
    assert.equal(cp.degraded.reason, null);
});

test('CA-1 · share_pct se calcula y suma 100', () => {
    const map = buildMap({
        qa: [
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'sonnet', cost_usd: 0.01 },
            { ts: '2026-05-01T09:00:00Z', provider: 'openai', model: 'codex', cost_usd: 0.03 },
        ],
    });
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    const sum = cp.bySkill[0].providers.reduce((s, p) => s + p.share_pct, 0);
    assert.ok(Math.abs(sum - 100) < 1, `share_pct debe sumar ~100, got ${sum}`);
});

// -----------------------------------------------------------------------------
// CA-9 — Estado degradado pre-S5: TODOS los providers son 'unknown'
// -----------------------------------------------------------------------------

test('CA-9 · sin campo provider en session:end → degraded.reason = no-provider-field', () => {
    const map = buildMap({
        qa: [
            { ts: '2026-05-01T08:00:00Z', provider: 'unknown', model: 'unknown', cost_usd: 0.01 },
            { ts: '2026-05-01T09:00:00Z', provider: 'unknown', model: 'unknown', cost_usd: 0.01 },
        ],
    });
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    assert.equal(cp.degraded.reason, 'no-provider-field');
    assert.match(cp.degraded.message, /3083/);
});

// -----------------------------------------------------------------------------
// CA-9 — Estado degradado pre-H3: 1 solo provider real activo
// -----------------------------------------------------------------------------

test('CA-9 · 1 solo provider real → degraded.reason = single-provider', () => {
    const map = buildMap({
        qa: [
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'sonnet', cost_usd: 0.01 },
            { ts: '2026-05-01T09:00:00Z', provider: 'anthropic', model: 'sonnet', cost_usd: 0.01 },
        ],
        guru: [
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'opus', cost_usd: 0.05 },
        ],
    });
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    assert.equal(cp.degraded.reason, 'single-provider');
    assert.match(cp.degraded.message, /3075/);
});

// -----------------------------------------------------------------------------
// FIXED_SKILLS hardcoded (CA-8)
// -----------------------------------------------------------------------------

test('FIXED_SKILLS hardcoded incluye security/review/builder/tester', () => {
    assert.equal(isFixedSkill('security'), true);
    assert.equal(isFixedSkill('review'), true);
    assert.equal(isFixedSkill('builder'), true);
    assert.equal(isFixedSkill('tester'), true);
    assert.equal(isFixedSkill('qa'), false);
    assert.equal(isFixedSkill('android-dev'), false);
    assert.equal(isFixedSkill(null), false);
    assert.equal(FIXED_SKILLS instanceof Set, true);
});

test('skill FIJA marca row.fixed=true en computeCrossProvider', () => {
    const map = buildMap({
        review: [
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'opus', cost_usd: 0.10 },
        ],
    });
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    assert.equal(cp.bySkill[0].fixed, true);
});

// -----------------------------------------------------------------------------
// Vacío / borderline
// -----------------------------------------------------------------------------

test('input vacío produce bySkill:[] y degraded.reason:null', () => {
    const cp = computeCrossProvider({
        byCrossProviderSkill: new Map(),
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    assert.equal(cp.bySkill.length, 0);
    assert.equal(cp.degraded.reason, null);
});

test('switches detectados solo cuando cambia provider O model', () => {
    const map = buildMap({
        qa: [
            { ts: '2026-05-01T08:00:00Z', provider: 'anthropic', model: 'sonnet', cost_usd: 0.01 },
            { ts: '2026-05-01T09:00:00Z', provider: 'anthropic', model: 'sonnet', cost_usd: 0.01 },
            // Switch de modelo (mismo provider): cuenta como switch
            { ts: '2026-05-01T10:00:00Z', provider: 'anthropic', model: 'opus', cost_usd: 0.05 },
            { ts: '2026-05-01T11:00:00Z', provider: 'anthropic', model: 'opus', cost_usd: 0.05 },
        ],
    });
    const cp = computeCrossProvider({
        byCrossProviderSkill: map,
        windowDays: 7,
        fromMs: Date.parse('2026-04-30T00:00:00Z'),
        toMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    assert.equal(cp.bySkill[0].switches.length, 1);
    assert.equal(cp.bySkill[0].switches[0].from, 'anthropic/sonnet');
    assert.equal(cp.bySkill[0].switches[0].to, 'anthropic/opus');
});

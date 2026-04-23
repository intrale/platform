// Tests de .pipeline/metrics/aggregator.js (#2488)
// Verifica agregación extendida: execution_mode, TTS por issue, LLM vs det, daily series.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-agg-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'metrics'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../../lib/traceability')];
delete require.cache[require.resolve('../projections')];
delete require.cache[require.resolve('../aggregator')];

const trace = require('../../lib/traceability');
const aggregator = require('../aggregator');

function writeLog(events) {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(trace.LOG_FILE, lines, 'utf8');
}

function sessionEnd({ skill, issue, phase, model, tokens_in, tokens_out, cache_read, cache_write, duration_ms, ts }) {
    return {
        event: 'session:end',
        skill, issue, phase, model,
        tokens_in: tokens_in || 0,
        tokens_out: tokens_out || 0,
        cache_read: cache_read || 0,
        cache_write: cache_write || 0,
        duration_ms: duration_ms || 1000,
        tool_calls: 0,
        ts: ts || new Date().toISOString(),
    };
}

function ttsGen({ skill, issue, phase, provider, chars, audio_seconds, cost, ts }) {
    return {
        event: 'tts:generated',
        skill, issue, phase, provider,
        chars: chars || 0,
        audio_seconds: audio_seconds || 0,
        cost_estimate_usd: cost || 0,
        ts: ts || new Date().toISOString(),
    };
}

test('classifyExecutionMode distingue deterministic vs llm', () => {
    assert.equal(aggregator.classifyExecutionMode('deterministic'), 'deterministic');
    assert.equal(aggregator.classifyExecutionMode('DETERMINISTIC'), 'deterministic');
    assert.equal(aggregator.classifyExecutionMode('claude-opus-4-7'), 'llm');
    assert.equal(aggregator.classifyExecutionMode('claude-sonnet-4-6'), 'llm');
    assert.equal(aggregator.classifyExecutionMode(null), 'llm');
    assert.equal(aggregator.classifyExecutionMode(''), 'llm');
});

test('buildSnapshot genera llm_vs_deterministic con ahorro estimado', async () => {
    writeLog([
        sessionEnd({ skill: 'builder', issue: 2476, phase: 'build', model: 'claude-opus-4-7', tokens_in: 10000, tokens_out: 2000, ts: '2026-04-22T10:00:00Z' }),
        sessionEnd({ skill: 'builder', issue: 2476, phase: 'build', model: 'claude-opus-4-7', tokens_in: 8000, tokens_out: 1500, ts: '2026-04-22T11:00:00Z' }),
        sessionEnd({ skill: 'builder', issue: 2484, phase: 'build', model: 'deterministic', ts: '2026-04-22T12:00:00Z' }),
        sessionEnd({ skill: 'builder', issue: 2485, phase: 'build', model: 'deterministic', ts: '2026-04-22T13:00:00Z' }),
        sessionEnd({ skill: 'builder', issue: 2486, phase: 'build', model: 'deterministic', ts: '2026-04-22T14:00:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    assert.ok(Array.isArray(snap.llm_vs_deterministic));
    const builder = snap.llm_vs_deterministic.find(r => r.skill === 'builder');
    assert.ok(builder, 'builder debe existir en llm_vs_deterministic');
    assert.equal(builder.llm_sessions, 2);
    assert.equal(builder.deterministic_sessions, 3);
    assert.ok(builder.llm_avg_cost_per_session > 0);
    assert.ok(builder.estimated_savings_usd > 0);
    assert.equal(builder.migrated, true);
});

test('buildSnapshot expone TTS por issue con break-down por provider', async () => {
    writeLog([
        sessionEnd({ skill: 'qa', issue: 2477, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 5000, ts: '2026-04-22T10:00:00Z' }),
        ttsGen({ skill: 'qa', issue: 2477, phase: 'qa', provider: 'openai', chars: 500, audio_seconds: 35, cost: 0.01, ts: '2026-04-22T10:05:00Z' }),
        ttsGen({ skill: 'qa', issue: 2477, phase: 'qa', provider: 'edge-tts', chars: 300, audio_seconds: 20, cost: 0, ts: '2026-04-22T10:06:00Z' }),
        ttsGen({ skill: 'qa', issue: 2488, phase: 'qa', provider: 'openai', chars: 1000, audio_seconds: 70, cost: 0.02, ts: '2026-04-22T11:00:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    assert.ok(Array.isArray(snap.tts.by_issue));
    assert.equal(snap.tts.by_issue.length, 2);

    // Ranking por cost_usd desc — 2488 tiene cost=0.02, 2477 tiene 0.01
    assert.equal(snap.tts.by_issue[0].issue, 2488);
    assert.equal(snap.tts.by_issue[0].tts_chars, 1000);
    assert.equal(snap.tts.by_issue[0].tts_audio_seconds, 70);

    const issue2477 = snap.tts.by_issue.find(i => i.issue === 2477);
    assert.equal(issue2477.tts_chars, 800); // 500 + 300
    assert.equal(issue2477.by_provider.length, 2);
    const byProv = Object.fromEntries(issue2477.by_provider.map(p => [p.provider, p]));
    assert.equal(byProv.openai.tts_chars, 500);
    assert.equal(byProv['edge-tts'].tts_chars, 300);
});

test('buildSnapshot expone by_skill dentro de cada issue', async () => {
    writeLog([
        sessionEnd({ skill: 'builder',  issue: 2500, phase: 'build', model: 'deterministic',  ts: '2026-04-22T10:00:00Z' }),
        sessionEnd({ skill: 'tester',   issue: 2500, phase: 'test',  model: 'deterministic',  ts: '2026-04-22T10:05:00Z' }),
        sessionEnd({ skill: 'delivery', issue: 2500, phase: 'deliver', model: 'deterministic', ts: '2026-04-22T10:10:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    const issue = snap.issues.find(i => i.issue === 2500);
    assert.ok(issue);
    assert.ok(Array.isArray(issue.by_skill));
    assert.equal(issue.by_skill.length, 3);
    const skills = issue.by_skill.map(s => s.skill).sort();
    assert.deepEqual(skills, ['builder', 'delivery', 'tester']);
});

test('buildSnapshot incluye daily series para proyecciones', async () => {
    writeLog([
        sessionEnd({ skill: 'qa', issue: 2600, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 1000000, ts: '2026-04-20T10:00:00Z' }),
        sessionEnd({ skill: 'qa', issue: 2600, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 500000,  ts: '2026-04-21T10:00:00Z' }),
        sessionEnd({ skill: 'qa', issue: 2600, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 2000000, ts: '2026-04-22T10:00:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    assert.ok(Array.isArray(snap.daily));
    assert.equal(snap.daily.length, 3);
    assert.equal(snap.daily[0].day, '2026-04-20');
    assert.equal(snap.daily[2].day, '2026-04-22');
    // Orden ascendente
    assert.ok(snap.daily[0].day < snap.daily[2].day);
});

test('buildSnapshot genera projections con tokens y tts', async () => {
    writeLog([
        sessionEnd({ skill: 'qa', issue: 2700, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 100000, tokens_out: 50000, ts: '2026-04-22T10:00:00Z' }),
        ttsGen({ skill: 'qa', issue: 2700, phase: 'qa', provider: 'openai', chars: 5000, audio_seconds: 350, cost: 0.0875, ts: '2026-04-22T10:30:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    assert.ok(snap.projections);
    assert.ok(snap.projections.tokens);
    assert.ok(snap.projections.tts);
    assert.ok(snap.projections.tokens.dimension === 'tokens');
    assert.ok(snap.projections.tts.dimension === 'tts');
});

test('buildSnapshot con log vacío no explota', async () => {
    // Sobrescribir con archivo vacío
    fs.writeFileSync(trace.LOG_FILE, '', 'utf8');
    const snap = await aggregator.buildSnapshot({});
    assert.equal(snap.totals.sessions, 0);
    assert.deepEqual(snap.llm_vs_deterministic, []);
    assert.deepEqual(snap.tts.by_issue, []);
    assert.ok(snap.projections);
});

test('buildSnapshot respeta ventana temporal', async () => {
    const now = Date.now();
    const old = new Date(now - 8 * 86400e3).toISOString();
    const recent = new Date(now - 1 * 86400e3).toISOString();
    writeLog([
        sessionEnd({ skill: 'qa', issue: 2800, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 10000, ts: old }),
        sessionEnd({ skill: 'qa', issue: 2801, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 20000, ts: recent }),
    ]);
    const snapAll = await aggregator.buildSnapshot({ window: 'all' });
    const snap7d = await aggregator.buildSnapshot({ window: '7d' });
    // Ventana 7d excluye el de hace 8 días
    assert.equal(snapAll.totals.sessions, 2);
    assert.equal(snap7d.totals.sessions, 1);
});

test('by_issue queda vacío cuando no hay TTS (pero sí hay sesiones)', async () => {
    writeLog([
        sessionEnd({ skill: 'builder', issue: 2900, phase: 'build', model: 'deterministic', ts: '2026-04-22T10:00:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({});
    assert.equal(snap.tts.by_issue.length, 0);
    // Pero el issue sí existe en snap.issues
    assert.ok(snap.issues.find(i => i.issue === 2900));
});

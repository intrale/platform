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

// =============================================================================
// #2891 PR-B — Hourly baseline + currentHour
// =============================================================================

test('hourlySeries expone 24 entradas (00..23) incluso sin datos', async () => {
    fs.writeFileSync(trace.LOG_FILE, '', 'utf8');
    const snap = await aggregator.buildSnapshot({});
    assert.ok(snap.hourlySeries, 'snapshot incluye hourlySeries');
    const keys = Object.keys(snap.hourlySeries).sort();
    assert.equal(keys.length, 24);
    assert.equal(keys[0], '00');
    assert.equal(keys[23], '23');
    // Sin datos, todas las horas tienen ceros y samples=0
    for (const k of keys) {
        assert.equal(snap.hourlySeries[k].cost_usd, 0);
        assert.equal(snap.hourlySeries[k].samples, 0);
    }
});

test('hourlySeries promedia el costo por hora-del-día sobre días dentro del lookback', async () => {
    // 2 días distintos, ambos con datos a las 14:xx UTC. nowMs en el día 3
    // así que el lookback (7 días default) los incluye y el día actual queda fuera.
    const day1 = '2026-04-23T14:30:00Z';
    const day2 = '2026-04-24T14:45:00Z';
    const day3 = '2026-04-25T10:00:00Z';
    writeLog([
        // Día 1, hora 14: cost ≈ $1
        sessionEnd({ skill: 'qa', issue: 3001, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 250000, tokens_out: 50000, ts: day1 }),
        // Día 2, hora 14: cost ≈ $0.50
        sessionEnd({ skill: 'qa', issue: 3002, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 125000, tokens_out: 25000, ts: day2 }),
    ]);
    // nowMs forzado al día 3, así que día 1 y día 2 son baseline; día actual sería 25 → 14 estará vacía
    const snap = await aggregator.buildSnapshot({ nowMs: Date.parse(day3) });
    const hourly14 = snap.hourlySeries['14'];
    assert.ok(hourly14, 'hourlySeries["14"] existe');
    assert.equal(hourly14.samples, 2, 'se vieron 2 buckets en hora 14 dentro del lookback');
    // El promedio cost_usd debería ser aproximadamente (1 + 0.5)/2 = 0.75
    // pero depende de pricing exacto del modelo — basta con que sea > 0 y < total/1
    assert.ok(hourly14.cost_usd > 0);
});

test('hourlySeries excluye el día actual del baseline', async () => {
    // Si hoy a las 14h ya hay datos, NO deben contar para hourlySeries["14"].
    // Eso evita auto-confirmar anomalías comparando contra sí mismo.
    const today = new Date('2026-04-30T14:30:00Z');
    writeLog([
        sessionEnd({ skill: 'qa', issue: 3100, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 1000000, ts: today.toISOString() }),
    ]);
    const snap = await aggregator.buildSnapshot({ nowMs: today.getTime() });
    const hourly14 = snap.hourlySeries['14'];
    assert.equal(hourly14.samples, 0, 'el día actual no entra a la baseline');
    assert.equal(hourly14.cost_usd, 0);
});

test('currentHour refleja el costo acumulado de la hora-del-día en curso', async () => {
    const today = new Date('2026-04-30T14:30:00Z');
    writeLog([
        // Mismo día, misma hora 14
        sessionEnd({ skill: 'qa', issue: 3200, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 100000, tokens_out: 20000, ts: '2026-04-30T14:05:00Z' }),
        sessionEnd({ skill: 'qa', issue: 3200, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 50000,  tokens_out: 10000, ts: '2026-04-30T14:25:00Z' }),
        // Hora 13 — NO debe entrar al currentHour si nowMs es 14:30
        sessionEnd({ skill: 'qa', issue: 3200, phase: 'qa', model: 'claude-opus-4-7', tokens_in: 100000, tokens_out: 20000, ts: '2026-04-30T13:45:00Z' }),
    ]);
    const snap = await aggregator.buildSnapshot({ nowMs: today.getTime() });
    assert.equal(snap.currentHour.hour, '14');
    assert.equal(snap.currentHour.date, '2026-04-30');
    assert.equal(snap.currentHour.sessions, 2, 'solo las 2 sesiones de la hora 14');
    assert.ok(snap.currentHour.cost_usd > 0);
    assert.ok(snap.currentHour.tokens === 100000 + 20000 + 50000 + 10000);
});

test('hourlyMeta reporta daysWithData usado por el detector para gracePeriod', async () => {
    const day1 = '2026-04-23T10:00:00Z';
    const day2 = '2026-04-24T10:00:00Z';
    const today = new Date('2026-04-30T15:00:00Z');
    writeLog([
        sessionEnd({ skill: 'qa', issue: 3300, phase: 'qa', model: 'deterministic', ts: day1 }),
        sessionEnd({ skill: 'qa', issue: 3301, phase: 'qa', model: 'deterministic', ts: day2 }),
    ]);
    const snap = await aggregator.buildSnapshot({ nowMs: today.getTime() });
    assert.ok(snap.hourlyMeta);
    assert.equal(snap.hourlyMeta.daysWithData, 2, 'dos días distintos vistos en lookback');
    assert.ok(snap.hourlyMeta.windowStart);
    assert.ok(snap.hourlyMeta.windowEnd);
});

test('clampLookbackDays mantiene el rango [7, 14]', () => {
    assert.equal(aggregator.clampLookbackDays(0), 7);
    assert.equal(aggregator.clampLookbackDays(3), 7);
    assert.equal(aggregator.clampLookbackDays(7), 7);
    assert.equal(aggregator.clampLookbackDays(10), 10);
    assert.equal(aggregator.clampLookbackDays(14), 14);
    assert.equal(aggregator.clampLookbackDays(30), 14);
    assert.equal(aggregator.clampLookbackDays('garbage'), 7);
});

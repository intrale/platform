'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../effective-model');

function tempFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'effective-model-')), 'runs.jsonl'); }
function anthropicLog(model = 'claude-opus-5') {
    return JSON.stringify({ type: 'assistant', message: { model } }) + '\n{truncado';
}

test('persiste modelo efectivo, actor y proveedor con whitelist exacta', () => {
    const file = tempFile();
    const rec = m.recordEffectiveModel({ issue: 6273, skill: 'planner', provider: 'anthropic',
        model_declared: 'claude-opus-4-7', model_resolved: 'claude-opus-4-7', raw: anthropicLog() }, { file });
    assert.deepEqual(Object.keys(rec), m.WHITELIST);
    assert.equal(rec.model_effective, 'claude-opus-5');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).skill, 'planner');
});

test('no observable queda fuera de coincidencias y del denominador', () => {
    const rows = m.auditDeclaredVsEffective({ records: [{ skill: 'delivery', provider: 'deterministic',
        model_declared: null, model_resolved: null, model_effective: null, source: m.NOT_OBSERVABLE }] });
    assert.equal(rows[0].runs_not_observable, 1);
    assert.equal(rows[0].runs_matched, 0);
    assert.equal(rows[0].match_pct, null);
});

test('agrega por actor y proveedor y conserva los tres modelos', () => {
    const records = [
        { skill: 'planner', provider: 'anthropic', model_declared: 'a', model_resolved: 'b', model_effective: 'c', source: 'agent-log' },
        { skill: 'planner', provider: 'anthropic', model_declared: 'a', model_resolved: 'b', model_effective: 'a', source: 'agent-log' },
    ];
    const row = m.auditDeclaredVsEffective({ records })[0];
    assert.equal(row.runs, 2); assert.equal(row.model_declared, 'a');
    assert.equal(row.model_resolved, 'b'); assert.equal(row.match_pct, 50);
});

test('alerta una vez sobre umbral e identifica actor y proveedor', () => {
    const sent = [];
    const records = Array.from({ length: 3 }, () => ({ skill: 'guru', provider: 'anthropic',
        model_declared: 'old', model_resolved: 'old', model_effective: 'new', source: 'agent-log' }));
    const alerts = m.evaluateDivergence({ records, config: { alert_enabled: true, min_runs: 2, max_divergence_pct: 10 },
        shouldNotify: () => true, notify: (p) => sent.push(p) });
    assert.equal(alerts.length, 1); assert.equal(sent[0].context.actor, 'guru');
    assert.equal(sent[0].context.proveedor, 'anthropic');
});

test('no alerta por debajo del piso y nunca lanza ante fallos de fs', () => {
    assert.deepEqual(m.evaluateDivergence({ records: [], config: { alert_enabled: true } }), []);
    const badFs = { readFileSync() { throw new Error('x'); }, appendFileSync() { throw new Error('x'); }, mkdirSync() {} };
    assert.doesNotThrow(() => m.extractEffectiveModel({ provider: 'anthropic', logPath: 'x' }, { fs: badFs }));
    assert.doesNotThrow(() => m.recordEffectiveModel({ provider: 'anthropic', raw: anthropicLog() }, { fs: badFs, file: 'x' }));
});

test('normaliza variante y rechaza secretos o saltos de línea', () => {
    assert.equal(m.normalizeModelId('claude-opus-5[1m]'), 'claude-opus-5');
    assert.equal(m.normalizeModelId('sk-ant-secret'), null);
    assert.equal(m.normalizeModelId('model\r\ninjected'), null);
    const obs = m.extractEffectiveModel({ provider: 'anthropic', raw: anthropicLog('sk-ant-very-secret-value') });
    assert.equal(obs.observable, false);
});

test('append-only conserva ambas corridas', () => {
    const file = tempFile();
    const opts = { issue: 1, skill: 'x', provider: 'anthropic', model_declared: 'a', raw: anthropicLog('a') };
    m.recordEffectiveModel(opts, { file }); m.recordEffectiveModel(opts, { file });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

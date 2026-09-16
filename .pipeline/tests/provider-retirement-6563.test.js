'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../lib/agent-models-validate');
const { buildMatrixFromAgentModels } = require('../lib/multi-provider/smoke-test');
const config = require('../agent-models.json');

test('la baja conserva exactamente tres proveedores LLM y cobertura Codex por skill', () => {
    const matrix = buildMatrixFromAgentModels(config);
    assert.deepEqual([...new Set(matrix.map(cell => cell.provider))].sort(),
        ['anthropic', 'gemini-google', 'openai-codex']);
    for (const skill of new Set(matrix.map(cell => cell.skill))) {
        assert.ok(matrix.some(cell => cell.skill === skill &&
            cell.provider === 'openai-codex' && cell.eligible), skill);
    }
});

test('Gemini conserva billing free y sigue admitido después del vencimiento anterior', () => {
    const gemini = config.providers['gemini-google'];
    assert.equal(gemini.billing, 'free');
    assert.equal(gemini.admission.exception.issue, 6564);
    for (const date of ['2026-09-16', '2026-11-01']) {
        const result = validator.validate(undefined, { now: new Date(`${date}T00:00:00Z`) });
        assert.equal(result.ok, true, JSON.stringify(result.errors));
    }
    for (const provider of Object.values(config.providers)) {
        assert.notEqual(provider.admission?.exception?.issue, 6563);
    }
});

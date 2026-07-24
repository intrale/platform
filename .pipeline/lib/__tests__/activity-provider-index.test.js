// =============================================================================
// Tests de activity-provider-index (#4199).
//   - Construye el índice (issue, skill, fase) → provider desde el activity-log.
//   - resolve() estricto (issue+skill+fase) y flojo (issue+skill).
//   - Ignora eventos que no son session:start/session:end.
//   - «último gana» en colisiones.
//   - Degradación fail-safe: archivo ausente → índice vacío inerte.
//
// node:test puro. Usa un fixture temporal en os.tmpdir.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pi = require(path.resolve(__dirname, '..', 'activity-provider-index.js'));

function writeTmp(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'));
    const file = path.join(dir, 'activity-log.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
}

test('construye el join issue/skill/fase → provider desde session:start', () => {
    pi._resetCacheForTests();
    const file = writeTmp([
        JSON.stringify({ event: 'session:start', issue: 100, skill: 'backend-dev', phase: 'dev', provider: 'anthropic' }),
        JSON.stringify({ event: 'session:start', issue: 200, skill: 'qa', phase: 'verificacion', provider: 'groq' }),
    ]);
    const idx = pi.buildProviderIndex(file);
    assert.equal(idx.resolve(100, 'backend-dev', 'dev'), 'anthropic');
    assert.equal(idx.resolve(200, 'qa', 'verificacion'), 'groq');
    assert.deepEqual(idx.providers, ['anthropic', 'groq']);
});

test('resolve flojo (issue+skill) cuando la fase no matchea', () => {
    pi._resetCacheForTests();
    const file = writeTmp([
        JSON.stringify({ event: 'session:start', issue: 300, skill: 'pipeline-dev', phase: 'dev', provider: 'cerebras' }),
    ]);
    const idx = pi.buildProviderIndex(file);
    // fase distinta → cae al match flojo issue+skill.
    assert.equal(idx.resolve(300, 'pipeline-dev', 'otra-fase'), 'cerebras');
    // skill distinto → no resuelve.
    assert.equal(idx.resolve(300, 'qa', 'dev'), null);
});

test('ignora eventos que no son de sesión y líneas corruptas', () => {
    pi._resetCacheForTests();
    const file = writeTmp([
        '{ no es json',
        JSON.stringify({ event: 'tool:call', issue: 400, skill: 'x', provider: 'anthropic' }),
        JSON.stringify({ event: 'session:end', issue: 400, skill: 'review', phase: 'aprobacion', provider: 'gemini-google' }),
    ]);
    const idx = pi.buildProviderIndex(file);
    assert.equal(idx.size, 1);
    assert.equal(idx.resolve(400, 'review', 'aprobacion'), 'gemini-google');
});

test('«último gana» en colisiones de la misma ejecución', () => {
    pi._resetCacheForTests();
    const file = writeTmp([
        JSON.stringify({ event: 'session:start', issue: 500, skill: 'tester', phase: 'linteo', provider: 'groq' }),
        JSON.stringify({ event: 'session:end', issue: 500, skill: 'tester', phase: 'linteo', provider: 'anthropic' }),
    ]);
    const idx = pi.buildProviderIndex(file);
    assert.equal(idx.resolve(500, 'tester', 'linteo'), 'anthropic');
});

test('archivo ausente → índice vacío inerte (degradación CA-3)', () => {
    pi._resetCacheForTests();
    const idx = pi.buildProviderIndex(path.join(os.tmpdir(), 'no-existe-jamas-4199.jsonl'));
    assert.equal(idx.size, 0);
    assert.deepEqual(idx.providers, []);
    assert.equal(idx.resolve(1, 'x', 'y'), null);
});

test('entrada sin provider o sin issue se descarta', () => {
    pi._resetCacheForTests();
    const file = writeTmp([
        JSON.stringify({ event: 'session:start', issue: 600, skill: 'x', phase: 'dev' }), // sin provider
        JSON.stringify({ event: 'session:start', skill: 'y', phase: 'dev', provider: 'anthropic' }), // sin issue
        JSON.stringify({ event: 'session:start', issue: 600, skill: 'guru', phase: 'analisis', provider: 'anthropic' }),
    ]);
    const idx = pi.buildProviderIndex(file);
    assert.equal(idx.size, 1);
    assert.equal(idx.resolve(600, 'guru', 'analisis'), 'anthropic');
});

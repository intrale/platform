// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const handler = require('../lib/agent-launcher/providers/antigravity');
const quota = require('../lib/quota-exhausted');
const dispatcher = require('../lib/agent-launcher/dispatch-with-fallback');
const allowlist = ['resource_exhausted', 'quota_exceeded'];
const evt = error => ({ event: 'result', result: { status: 'ERROR', error } });

test('cuota: valida exclusivamente el error estructural y respeta allowlist', () => {
    const cases = [null, {}, { event: 'result' }, { event: 'result', result: 'x' },
        { event: 'result', result: { status: 'SUCCESS', response: 'RESOURCE_EXHAUSTED 429 quota' } },
        { event: 'step_update', step_update: { text_delta: 'RESOURCE_EXHAUSTED' } },
        evt(null), evt(''), evt({ code: 429 }), evt('invalid model selection'), evt('14290 xquota')];
    for (const input of cases) assert.deepEqual(quota._detectAntigravity(input, allowlist), { matched: false });
    for (const [error, type] of [['RESOURCE_EXHAUSTED: quota exceeded (429)', 'resource_exhausted'], ['429', 'resource_exhausted'], ['Quota exceeded', 'quota_exceeded']]) {
        const expected = { matched: true, errorType: type, resetsAt: null };
        assert.deepEqual(quota._detectAntigravity(evt(error), allowlist), expected);
        assert.deepEqual(quota.detectQuotaError(evt(error), { output_parser: 'antigravity-stream-json', quota_error_types: allowlist }), expected);
        const fakeFs = { readFileSync: () => JSON.stringify(evt(error)) + '\n' };
        assert.deepEqual(handler.detectQuotaExhausted('log', null, quota, fakeFs), expected);
        assert.deepEqual(quota._detectAntigravity(evt(error), []), { matched: false });
    }
    assert.doesNotMatch(quota._detectAntigravity.toString(), /response|text_delta/);
});

test('usage: fixture real y reasoning sin doble conteo; fallback legacy preservado', () => {
    const fixture = path.join(__dirname, '../lib/__tests__/fixtures/agy-stream-json-1.2.4.ndjson');
    assert.deepEqual(handler.parseTokensFromLog(fixture), { input: 13038, output: 13, cache_read: 0, cache_create: 0, tool_calls: 0 });
    const log = [ { event: 'init' }, { event: 'step_update', step_update: { usage: { input_tokens: 13052 } } },
        { event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 13052, output_tokens: 37, thinking_tokens: 36, cache_read_tokens: 3 } } } ].map(JSON.stringify).join('\n');
    assert.deepEqual(handler.parseTokensFromLog('log', { readFileSync: () => log }), { input: 13052, output: 37, cache_read: 3, cache_create: 0, tool_calls: 0 });
    assert.ok(Object.isFrozen(handler.AGY_HARDENING_ARGS));
    assert.match(fs.readFileSync(require.resolve('../lib/agent-launcher/providers/antigravity'), 'utf8'), /--disable-slash-commands/);
});

test('onSpawnExit: cuota Gemini comparte detector en camino generalizado', () => {
    const fakeQuota = { ...quota, setFlag: () => ({}) };
    const result = dispatcher.onSpawnExit({ skill: 'guru', issue: 7290, provider: 'antigravity', transport: 'cli',
        rawOutput: JSON.stringify(evt('RESOURCE_EXHAUSTED: quota exceeded (429)')), exitCode: 1, quotaModule: fakeQuota });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
});

test('salida Gemini: fixture real llega al registro contable con tokens positivos', () => {
    // El Pulpo registra costo después de onSpawnExit usando el handler resuelto.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cost-7290-'));
    const raw = fs.readFileSync(path.join(__dirname, '../lib/__tests__/fixtures/agy-stream-json-1.2.4.ndjson'), 'utf8');
    const result = dispatcher.onSpawnExit({ skill: 'guru', issue: 7290, provider: 'antigravity', transport: 'cli', rawOutput: raw, exitCode: 0, pipelineDir: dir });
    assert.equal(result.flagSet, false);
    const tokens = handler.parseTokensFromLog('fixture', { readFileSync: () => raw });
    const cost = require('../lib/metrics/provider-cost');
    const file = path.join(dir, 'provider-cost.jsonl');
    cost.recordProviderCost({ provider: 'antigravity', skill: 'guru', issue: 7290, tokens_in: tokens.input, tokens_out: tokens.output, status: 'ok' }, { file });
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(row.provider, 'antigravity');
    assert.equal(row.tokens_in, 13038);
    assert.equal(row.tokens_out, 13);
});

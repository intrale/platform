'use strict';
// #7633 (P2) — Lectores exportados de trailer.js, sobre las mismas regex de build/verify.

const test = require('node:test');
const assert = require('node:assert');

const T = require('../trailer');

const HASH = 'f'.repeat(64);

test('parseHumanDirection lee una firma válida', () => {
    const line = T.formatHumanDirection({ ok: true, login: 'leitolarreta', ts: '2026-09-23T19:12:00Z', kind: 'gate2', hash: HASH });
    assert.deepStrictEqual(T.parseHumanDirection(line), {
        signed: true, login: 'leitolarreta', ts: '2026-09-23T19:12:00Z', kind: 'gate2', hash: HASH,
    });
});

test('parseHumanDirection lee un none con su motivo', () => {
    assert.deepStrictEqual(T.parseHumanDirection('none; 2026-09-24T13:23:02Z; missing'),
        { signed: false, ts: '2026-09-24T13:23:02Z', reason: 'missing' });
});

test('parseHumanDirection rechaza lo que build/verify rechazan', () => {
    for (const v of [null, 42, '', 'none; 2026-09-24T13:23:02Z; otro', `x y; 2026-09-23T19:12:00Z; gate2:sha256:${HASH}`,
        `leito; 2026-09-23T19:12:00Z; gate3:sha256:${HASH}`, '<script>; x; y']) {
        assert.strictEqual(T.parseHumanDirection(v), null, String(v));
    }
});

test('parseAiAssisted: lista, unknown y formato inválido', () => {
    assert.deepStrictEqual(T.parseAiAssisted('anthropic/claude-opus-5-5 (backend-dev), openai/gpt-5-codex (review)'), [
        { provider: 'anthropic', model: 'claude-opus-5-5', role: 'backend-dev' },
        { provider: 'openai', model: 'gpt-5-codex', role: 'review' },
    ]);
    assert.strictEqual(T.parseAiAssisted('unknown'), 'unknown');
    assert.strictEqual(T.parseAiAssisted('anthropic (x)'), null);
    assert.strictEqual(T.parseAiAssisted(undefined), null);
});

test('hasIntraleKey detecta claves en cualquier párrafo, con normalización', () => {
    assert.strictEqual(T.hasIntraleKey('titulo\n\ncuerpo'), false);
    assert.strictEqual(T.hasIntraleKey(null), false);
    assert.strictEqual(T.hasIntraleKey('titulo\n\nIntrale-Issue: #1'), true);
    assert.strictEqual(T.hasIntraleKey('titulo\r\n\r\nintrale-x: y\r\n\r\nfin'), true);
    assert.strictEqual(T.hasIntraleKey('titulo\n\nIntrale​-Issue: #1'), true);
});

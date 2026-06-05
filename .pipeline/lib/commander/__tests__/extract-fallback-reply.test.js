// =============================================================================
// extract-fallback-reply.test.js — Cobertura del normalizador de salida de los
// providers de respaldo del Commander.
//
// Contexto: los providers no-Anthropic (codex `exec --json`, gemini, cerebras,
// nvidia) emiten su salida como JSONL. El path de fallback dumpeaba ese stream
// crudo a Telegram y el TTS lo partía en una lluvia de audios técnicos. El
// helper extrae sólo el/los `agent_message` finales para entregar un único
// mensaje conversacional.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractFallbackReply } = require('../multi-provider');

test('extrae el agent_message de un stream JSONL de codex', () => {
    const stdout = [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"tool_call","name":"Bash"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Listo Leo, el pipeline está arriba."}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Listo Leo, el pipeline está arriba.');
});

test('concatena múltiples agent_message en orden', () => {
    const stdout = [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Parte uno."}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Parte dos."}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Parte uno.\n\nParte dos.');
});

test('JSONL sin agent_message → texto vacío (caller cae al canned)', () => {
    const stdout = [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"tool_call","name":"Bash"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":0}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
});

test('texto plano (provider no-stream-json) se devuelve tal cual', () => {
    const r = extractFallbackReply('Respuesta en texto plano sin JSON.');
    assert.equal(r.parsed, false);
    assert.equal(r.text, 'Respuesta en texto plano sin JSON.');
});

test('stdout vacío o nulo → vacío sin romper', () => {
    assert.deepEqual(extractFallbackReply(''), { text: '', parsed: false });
    assert.deepEqual(extractFallbackReply('   '), { text: '', parsed: false });
    assert.deepEqual(extractFallbackReply(null), { text: '', parsed: false });
    assert.deepEqual(extractFallbackReply(undefined), { text: '', parsed: false });
});

test('ignora líneas JSON malformadas sin tirar', () => {
    const stdout = [
        '{ esto no es json valido',
        '{"type":"item.completed","item":{"type":"agent_message","text":"OK igual."}}',
        'ruido suelto',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'OK igual.');
});

test('agent_message sin campo text se ignora (no rompe)', () => {
    const stdout = '{"type":"item.completed","item":{"type":"agent_message"}}';
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
});

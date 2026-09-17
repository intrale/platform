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
    // #4353 CA-4 — `reason` es un campo ADITIVO del shape de retorno: stdout
    // totalmente vacío se clasifica como fallo RECUPERABLE 'empty_output' para
    // que el walk de cadena avance al siguiente eslabón. Los callers históricos
    // sólo leen `.text`/`.parsed` (back-compat intacta); el shape completo
    // incluye ahora `reason`.
    assert.deepEqual(extractFallbackReply(''), { text: '', parsed: false, reason: 'empty_output' });
    assert.deepEqual(extractFallbackReply('   '), { text: '', parsed: false, reason: 'empty_output' });
    assert.deepEqual(extractFallbackReply(null), { text: '', parsed: false, reason: 'empty_output' });
    assert.deepEqual(extractFallbackReply(undefined), { text: '', parsed: false, reason: 'empty_output' });
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

// =============================================================================
// Gemini `-o json` → objeto JSON único { session_id, response, stats }.
// Antes del fix, al no matchear el path JSONL de Codex, se dumpeaba el JSON
// crudo a Telegram (session_id arriba, stats al final). Ahora extraemos sólo
// el campo `response`.
// =============================================================================
test('extrae solo response de un objeto JSON de gemini (pretty-printed)', () => {
    const stdout = JSON.stringify({
        session_id: '5e5318cd-8c81-4279-803c-afb4d25c4903',
        response: '¡Excelente, Leo! Analicé el estado del repo.',
        stats: { models: { 'gemini-3.8-flash-medium': { tokens: { total: 2973 } } } },
    }, null, 2);
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, '¡Excelente, Leo! Analicé el estado del repo.');
    assert.ok(!r.text.includes('session_id'));
    assert.ok(!r.text.includes('stats'));
});

test('objeto JSON de gemini con ruido de stderr alrededor se recupera', () => {
    const stdout = [
        'warning: deprecated flag ignored',
        JSON.stringify({ session_id: 'abc', response: 'Listo, todo verde.', stats: {} }),
        '',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Listo, todo verde.');
});

test('objeto JSON de error de gemini (sin response) → vacío para canned', () => {
    const stdout = JSON.stringify({
        session_id: 'abc',
        error: { status: 'RESOURCE_EXHAUSTED', code: 429 },
        stats: {},
    });
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
});

test('shape estilo OpenAI choices[].message.content se extrae', () => {
    const stdout = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Respuesta del modelo.' } }],
        usage: { total_tokens: 100 },
    });
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Respuesta del modelo.');
});

test('el path JSONL de codex NO se rompe por el path de objeto único', () => {
    // Un stream JSONL multi-evento sin agent_message no debe extraerse como
    // objeto (el recovery primer-{ a último-} da JSON inválido) → vacío.
    const stdout = [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"tool_call","name":"Bash"}}',
        '{"type":"turn.completed"}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
});

// -----------------------------------------------------------------------------
// Path A2 — NDJSON de Antigravity (agy 1.2.x, `--output-format stream-json`).
// Incidente 2026-09-17: el Commander descartaba toda respuesta de Gemini como
// `malformed_body` porque el stream multi-evento no es ni el JSONL de Codex ni
// el objeto único del Gemini CLI viejo.
// -----------------------------------------------------------------------------
const AGY_INIT = '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-low","cwd":"C:\\x","tools":["run_command"],"permission_mode":"always-proceed"}}';
const AGY_USER_DONE = '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}';

test('agy stream-json: extrae result.response y descarta init/step_update', () => {
    const stdout = [
        AGY_INIT,
        AGY_USER_DONE,
        '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"PONG"}}',
        '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":13111,"output_tokens":2}}}',
        '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"PONG\n","duration_seconds":7.6,"num_turns":1,"usage":{"total_tokens":13113}}}',
        '',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.reason, null);
    assert.equal(r.text, 'PONG');
});

test('agy stream-json: el result.response manda sobre los deltas (deltas de tool-calls no se cuelan)', () => {
    const stdout = [
        AGY_INIT,
        '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool_call","tool":"run_command","text_delta":"ls -la"}}',
        '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Borrador "}}',
        '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"parcial"}}',
        '{"event":"result","result":{"status":"SUCCESS","response":"Listo Leo, el pipeline está arriba."}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Listo Leo, el pipeline está arriba.');
});

test('agy stream-json sin result (kill por budget) → entrega los deltas del agent_response acumulados', () => {
    const stdout = [
        AGY_INIT,
        AGY_USER_DONE,
        '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Estoy revisando "}}',
        '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"el pipeline."}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, true);
    assert.equal(r.text, 'Estoy revisando el pipeline.');
});

test('agy stream-json con result de error (sin response) → vacío recuperable, no filtra el error', () => {
    const stdout = [
        AGY_INIT,
        '{"event":"result","result":{"status":"FAILED","error":"quota exceeded for model gemini-3.8-flash-low","num_turns":0}}',
    ].join('\n');
    const r = extractFallbackReply(stdout);
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
    assert.equal(r.reason, 'malformed_body');
});

test('agy stream-json: sólo eventos técnicos sin texto → vacío recuperable', () => {
    const r = extractFallbackReply([AGY_INIT, AGY_USER_DONE].join('\n'));
    assert.equal(r.parsed, false);
    assert.equal(r.text, '');
    assert.equal(r.reason, 'malformed_body');
});

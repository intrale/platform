// =============================================================================
// provider-error-parser-truncation-4865.test.js — Bug 1 de #4865.
//
// Cierra el falso positivo por truncación 16KB (regresión de #4541): un frame
// stream-json/SSE cuyo contenido supera MAX_LINE_BYTES se corta en
// `splitBoundedLines` → deja de parsear como JSON → caía en `plainTextLines` y
// el body del propio issue (que menciona "quota exhausted"/"insufficient_quota")
// matcheaba CLI_QUOTA_PATTERNS, disparando un flag espurio.
//
// Garantía: una línea que arranca como frame estructurado (`{`,`[`,`data:`) y
// se truncó por el cap NO se clasifica como texto libre → no dispara
// quota_exhausted por substring.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../provider-error-parser');
const { parseProviderError, MAX_LINE_BYTES } = parser;

// Construye un frame stream-json `type:user` con un `tool_result` cuyo texto
// (el "body del issue #4861/#4863") menciona cuota y hace que la línea supere
// MAX_LINE_BYTES. Al ser una sola línea JSON sin newlines, se trunca entera.
function bigUserFrameMentioningQuota() {
    const chunk = 'El gate de cuota agotada ignora la fuente unica: insufficient_quota, '
        + 'quota exhausted, hit your usage limit. ';
    // ~110 chars * 300 = ~33KB de contenido, muy por encima del cap de 16KB.
    const body = chunk.repeat(300);
    return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: body }] },
    });
}

test('#4865 · frame type:user >16KB con "insufficient_quota" NO dispara quota_exhausted', () => {
    const stdout = bigUserFrameMentioningQuota();
    assert.ok(stdout.length > MAX_LINE_BYTES, 'la línea debe exceder el cap para reproducir el bug');

    const r = parseProviderError(stdout, { provider: 'anthropic', transport: 'cli' });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'un tool_result grande truncado no debe clasificarse por substring');
    assert.equal(r.errorClass, 'unknown');
});

test('#4865 · el mismo frame precedido/seguido de otros frames tampoco dispara flag', () => {
    const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        bigUserFrameMentioningQuota(),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n');

    const r = parseProviderError(stdout, { provider: 'anthropic', transport: 'cli' });
    assert.notEqual(r.errorClass, 'quota_exhausted');
});

test('#4865 · un frame SSE `data: {...}` >16KB que menciona cuota tampoco matchea', () => {
    const body = 'insufficient_quota billing hard limit reached '.repeat(500);
    const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: body } }] });
    assert.ok(frame.length > MAX_LINE_BYTES);

    const r = parseProviderError(frame, { provider: 'openai-codex', transport: 'cli' });
    assert.notEqual(r.errorClass, 'quota_exhausted');
});

test('#4865 · regresión inversa: stderr de texto libre corto SÍ sigue matcheando', () => {
    // No debemos sobre-bloquear: un stderr genuino de texto libre (sin shape
    // JSON, sin truncar) con "quota exhausted" debe seguir clasificando.
    const stderr = 'API Error: weekly quota exhausted for your account';
    const r = parseProviderError(stderr, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
});

test('#4865 · _splitBoundedLinesMeta marca truncated=true sólo en líneas > cap', () => {
    const shortLine = 'linea corta';
    const longLine = 'x'.repeat(MAX_LINE_BYTES + 100);
    const meta = parser._splitBoundedLinesMeta(`${shortLine}\n${longLine}`);
    assert.equal(meta.length, 2);
    assert.equal(meta[0].truncated, false);
    assert.equal(meta[0].text, shortLine);
    assert.equal(meta[1].truncated, true);
    assert.equal(meta[1].text.length, MAX_LINE_BYTES);
});

test('#4865 · _startsWithStructuredFramePrefix reconoce {, [ y data:', () => {
    const f = parser._startsWithStructuredFramePrefix;
    assert.equal(f('{"type":"user"}'), true);
    assert.equal(f('  [1,2,3]'), true);
    assert.equal(f('data: {"choices":[]}'), true);
    assert.equal(f('data:[1]'), true);
    assert.equal(f('API Error: quota exhausted'), false);
    assert.equal(f(''), false);
    assert.equal(f(null), false);
});

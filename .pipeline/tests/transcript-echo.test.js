// =============================================================================
// transcript-echo.test.js — Tests del helper de eco de transcripción (#3918 / EP1-H3)
//
// Cobertura (100% ramas de formatTranscriptEcho):
//   - RS-1: escaping Markdown de `*_[]()<>&` y backticks.
//   - RS-2: redacción de AWS keys / JWT / tokens de alta entropía / emails.
//   - RS-5: truncado con cap TOTAL sobre N audios consolidados + elipsis.
//   - array vacío / no-array / entradas vacías → string vacío.
//   - buildEchoHistoryFields: campos aditivos + mapeo source openai→api.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const echo = require('../lib/commander/transcript-echo');

test('array vacío → string vacío', () => {
    assert.equal(echo.formatTranscriptEcho([]), '');
});

test('no-array → string vacío', () => {
    assert.equal(echo.formatTranscriptEcho(null), '');
    assert.equal(echo.formatTranscriptEcho(undefined), '');
    assert.equal(echo.formatTranscriptEcho('hola'), '');
});

test('entradas vacías / no-string → string vacío', () => {
    assert.equal(echo.formatTranscriptEcho(['', '   ', null, 42, {}]), '');
});

test('transcripción simple → eco con formato 🎤 Entendí: «…»', () => {
    const out = echo.formatTranscriptEcho(['reiniciá el pipeline']);
    assert.equal(out, '🎤 Entendí: «reiniciá el pipeline»');
});

test('N audios consolidados → todas las transcripciones con separador', () => {
    const out = echo.formatTranscriptEcho(['primero', 'segundo', 'tercero']);
    assert.match(out, /primero \/ segundo \/ tercero/);
});

test('RS-1: escapa metacaracteres Markdown legacy (* _ ` [)', () => {
    const out = echo.formatTranscriptEcho(['texto *con* _formato_ y `code` y [link']);
    // Cada metacaracter legacy debe quedar escapado con backslash.
    assert.match(out, /\\\*con\\\*/);
    assert.match(out, /\\_formato\\_/);
    assert.match(out, /\\`code\\`/);
    assert.match(out, /\\\[link/);
});

test('RS-1: caracteres especiales no rompen ni dejan entidad sin cerrar', () => {
    // Asteriscos/underscores impares (caso clásico de rechazo 400 de Telegram).
    const out = echo.formatTranscriptEcho(['*_[]()<>& ` un solo asterisco *']);
    // No debe quedar ningún `*`, `_`, `` ` `` ni `[` SIN un backslash previo.
    const sinEscape = /(^|[^\\])[*_`\[]/;
    // Quitamos el prefijo fijo del eco para inspeccionar sólo el cuerpo.
    const body = out.replace(/^🎤 Entendí: «/, '').replace(/»$/, '');
    assert.equal(sinEscape.test(body), false, `quedó un metacaracter sin escapar: ${body}`);
});

test('RS-2: redacta AWS access key', () => {
    const out = echo.formatTranscriptEcho(['mi clave es AKIAIOSFODNN7EXAMPLE ok']);
    assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
});

test('RS-2: redacta JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = echo.formatTranscriptEcho([`token ${jwt} fin`]);
    assert.equal(out.includes(jwt), false);
});

test('RS-2: redacta token opaco de alta entropía', () => {
    const secret = 'Zk9q2mWp7xR4tL8nV3bC6yH1jF5dG0sA2eU7iO4pQ9wZ8xK';
    const out = echo.formatTranscriptEcho([secret]);
    assert.equal(out.includes(secret), false);
});

test('RS-2: redacta email', () => {
    const out = echo.formatTranscriptEcho(['escribime a leito.larreta@gmail.com gracias']);
    assert.equal(out.includes('leito.larreta@gmail.com'), false);
});

test('RS-5: cap TOTAL sobre el conjunto consolidado + elipsis', () => {
    const a = 'a'.repeat(150);
    const b = 'b'.repeat(150);
    const out = echo.formatTranscriptEcho([a, b], { maxLen: 200 });
    assert.match(out, /…/);
    // El cuerpo (sin prefijo/sufijo del formato) no debe exceder maxLen + elipsis.
    const body = out.replace(/^🎤 Entendí: «/, '').replace(/»$/, '');
    assert.ok(body.length <= 201, `cuerpo demasiado largo: ${body.length}`);
});

test('RS-5: texto corto no se trunca (sin elipsis)', () => {
    const out = echo.formatTranscriptEcho(['corto'], { maxLen: 200 });
    assert.equal(out.includes('…'), false);
});

test('maxLen inválido cae al default', () => {
    const out = echo.formatTranscriptEcho(['hola'], { maxLen: -5 });
    assert.equal(out, '🎤 Entendí: «hola»');
});

// --- buildEchoHistoryFields ---

test('buildEchoHistoryFields: audio null o fallido → objeto vacío', () => {
    assert.deepEqual(echo.buildEchoHistoryFields(null), {});
    assert.deepEqual(echo.buildEchoHistoryFields({ ok: false }), {});
});

test('buildEchoHistoryFields: source local + confianza', () => {
    const fields = echo.buildEchoHistoryFields({ ok: true, source: 'local', confidence: { avgLogprob: -0.4 } });
    assert.equal(fields.transcript_echo, true);
    assert.equal(fields.stt_source, 'local');
    assert.equal(fields.stt_confidence, -0.4);
});

test('buildEchoHistoryFields: source openai se mapea a api, sin confianza → null', () => {
    const fields = echo.buildEchoHistoryFields({ ok: true, source: 'openai' });
    assert.equal(fields.stt_source, 'api');
    assert.equal(fields.stt_confidence, null);
});

test('buildEchoHistoryFields: avgLogprob no finito → stt_confidence null', () => {
    const fields = echo.buildEchoHistoryFields({ ok: true, source: 'local', confidence: { avgLogprob: Infinity } });
    assert.equal(fields.stt_confidence, null);
});

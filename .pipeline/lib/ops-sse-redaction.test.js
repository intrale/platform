'use strict';

// Test del contrato de redacción del SSE de logs (EP8-H7 #3960, REQ-SEC-H7-1).
// El handler `/logs/stream/:file` de dashboard.js mapea CADA línea (init +
// append) por `require('../sanitizer').sanitize` ANTES de emitir el SSE. Este
// test verifica esa transformación exacta: un secret simulado (AWS key / JWT)
// sale REDACTADO del stream, nunca crudo al browser.
// node --test .pipeline/lib/ops-sse-redaction.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitize } = require('../sanitizer');

// Espejo EXACTO del map server-side del SSE (dashboard.js):
//   lines.slice(-1000).map(l => _sanitizeLog(l))  // init
//   buf.split('\n').filter(...).map(l => _sanitizeLog(l))  // append
function sseTransform(lines) {
    return lines.map(l => sanitize(l));
}

test('una AWS access key en el log sale redactada del SSE', () => {
    const lines = [
        '16:02:11 [drive] subiendo maestro.mp4',
        '16:02:12 [drive] AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE en config',
    ];
    const out = sseTransform(lines);
    assert.ok(!out.join('\n').includes('AKIAIOSFODNN7EXAMPLE'), 'la AWS key NO debe salir cruda');
    assert.ok(/REDACTED/i.test(out.join('\n')), 'debe aparecer el marcador de redacción');
});

test('un JWT en el log sale redactado del SSE', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = sseTransform([`16:02:13 [svc-github] Authorization: Bearer ${jwt}`]);
    assert.ok(!out.join('\n').includes(jwt), 'el JWT NO debe salir crudo');
});

test('líneas sin secrets pasan intactas (salvo normalización utf-8)', () => {
    const lines = ['16:02:14 [pulpo] worker iniciado', '16:02:15 [pulpo] tomando issue 3960'];
    const out = sseTransform(lines);
    assert.ok(out[0].includes('worker iniciado'));
    assert.ok(out[1].includes('issue 3960'));
});

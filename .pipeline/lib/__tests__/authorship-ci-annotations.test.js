// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// #7632 — Anotaciones y resumen del check de autoría (annotations.js).

const test = require('node:test');
const assert = require('node:assert');

const a = require('../authorship/annotations');
const { CODES } = require('../authorship/verify');

test('escapeData escapa %, \\r y \\n', () => {
    assert.strictEqual(a.escapeData('%0A::error::x'), '%250A::error::x');
    assert.strictEqual(a.escapeData('a\n::add-mask::b\r'), 'a%0A::add-mask::b%0D');
});

test('escapeProperty además escapa : y ,', () => {
    assert.strictEqual(a.escapeProperty('a:b,c\n'), 'a%3Ab%2Cc%0A');
});

test('dry-run: warning con el prefijo literal y title fijo', () => {
    const line = a.formatAnnotation({ code: 'MISSING_TRAILER', mode: 'dry-run' });
    assert.ok(line.startsWith('::warning title=Autoría del PR::[modo de prueba — no bloquea] '), line);
});

test('enforce: error sin prefijo', () => {
    const line = a.formatAnnotation({ code: 'ANCHOR_MISMATCH', mode: 'enforce' });
    assert.ok(line.startsWith('::error title=Autoría del PR::El bloque authorship-anchor'), line);
    assert.ok(!line.includes(a.DRY_RUN_PREFIX));
});

test('cada código del enum tiene un mensaje fijo de una línea, sin jerga interna', () => {
    for (const code of CODES) {
        const msg = a.MESSAGES[code];
        assert.ok(msg, `falta mensaje para ${code}`);
        assert.ok(!/\n/.test(msg));
        assert.ok(!/\bS\d\b|\bRS-\d/.test(msg), `jerga interna en ${code}`);
    }
});

test('el único dato interpolado es el issue validado; cualquier otra cosa sale como ?', () => {
    assert.match(a.formatAnnotation({ code: 'ISSUE_NOT_FOUND', issue: '7632', mode: 'dry-run' }), /\(#7632\)/);
    const inyectado = a.formatAnnotation({ code: 'ISSUE_NOT_FOUND', issue: '1\n::add-mask::x', mode: 'dry-run' });
    assert.match(inyectado, /\(#\?\)/);
    assert.ok(!inyectado.includes('add-mask'));
});

test('UNVERIFIABLE usa el mensaje de "no se pudo verificar", distinto de un hallazgo', () => {
    assert.match(a.formatAnnotation({ code: 'UNVERIFIABLE', mode: 'enforce' }), /No se pudo consultar GitHub/);
});

test('notice de desactivado y warning de auditoría con sha corto validado', () => {
    assert.match(a.formatDisabledNotice(), /^::notice title=Autoría del PR::La verificación de autoría está desactivada/);
    assert.match(a.formatAuditWarning('ABCDEF1234567890'), /\(commit abcdef1\)\.$/);
    assert.match(a.formatAuditWarning('zzz;rm'), /\(commit \?\)\.$/);
});

test('renderSummary: modo + tres chequeos + aclaración de consistencia', () => {
    const s = a.renderSummary({ format: 'ok', issue: 'fail', anchor: 'unknown' }, 'dry-run');
    assert.match(s, /\| Modo \| prueba \|/);
    assert.match(s, /\| Formato del trailer \| ✅ \|/);
    assert.match(s, /\| Issue existe \| ❌ \|/);
    assert.match(s, /\| Bloque = trailer \| ⚠️ \|/);
    assert.match(s, /consistencia, no autenticidad/);
    assert.match(a.renderSummary({}, 'enforce'), /\| Modo \| bloqueante \|/);
});

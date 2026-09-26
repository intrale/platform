// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// Tests commit-builder.js — refactor de /delivery (#2870)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    build,
    parseDeliveryPayload,
    buildFallbackMessage,
    ensureClosesReference,
} = require('../delivery/commit-builder');

// ---- parseDeliveryPayload --------------------------------------------------

test('parseDeliveryPayload extrae la sección commit-message del payload', () => {
    const issue = `
<!-- delivery-payload -->
## commit-message
fix(api): corregir parsing JSON

Body adicional del commit.

## pr-body
- Punto 1
- Punto 2

## qa-disposition
qa:passed
<!-- /delivery-payload -->
`;
    const result = parseDeliveryPayload(issue);
    assert.equal(result, 'fix(api): corregir parsing JSON\n\nBody adicional del commit.');
});

test('parseDeliveryPayload devuelve null si no hay payload', () => {
    const issue = 'Este es solo un comentario sin payload';
    const result = parseDeliveryPayload(issue);
    assert.equal(result, null);
});

test('parseDeliveryPayload maneja espacios y saltos de línea alrededor del marker', () => {
    const issue = `
<!--  delivery-payload  -->
## commit-message
feat: nueva característica

## pr-body
Descripción

<!--  /delivery-payload  -->
`;
    const result = parseDeliveryPayload(issue);
    assert.match(result, /feat: nueva característica/);
});

// ---- buildFallbackMessage --------------------------------------------------

test('buildFallbackMessage construye mensaje convencional simple', () => {
    const msg = buildFallbackMessage('feat', 'nueva funcionalidad X');
    assert.equal(msg, 'feat: nueva funcionalidad X');
});

test('buildFallbackMessage trunca subject a 72 caracteres', () => {
    const longSubject = 'a'.repeat(100);
    const msg = buildFallbackMessage('fix', longSubject);
    const lines = msg.split('\n');
    assert.ok(lines[0].length <= 72);
});

test('buildFallbackMessage incluye body multilinea', () => {
    const description = `Sujeto corto
Primer párrafo del body.
Segundo párrafo.`;
    const msg = buildFallbackMessage('refactor', description);
    assert.match(msg, /Primer párrafo del body/);
    assert.match(msg, /Segundo párrafo/);
});

test('buildFallbackMessage normaliza tipo a minúsculas', () => {
    const msg = buildFallbackMessage('FIX', 'algo');
    assert.match(msg, /^fix:/);
});

test('buildFallbackMessage rechaza tipo inválido, usa chore', () => {
    const msg = buildFallbackMessage('invalid', 'algo');
    assert.match(msg, /^chore:/);
});

test('buildFallbackMessage con null type y description devuelve default', () => {
    const msg = buildFallbackMessage(null, null);
    assert.equal(msg, 'chore: actualizar estado del delivery');
});

// ---- build principal -------------------------------------------------------

test('build lee payload del último comentario del issue', () => {
    const result = build({
        issueComments: [
            { body: 'Comentario 1' },
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n## pr-body\n...\n<!-- /delivery-payload -->' },
            { body: 'Comentario 3 sin payload' },
        ],
    });
    // El comentario más nuevo (índice 2) no tiene payload, pero hay uno en el índice 1
    assert.equal(result.source, 'issue-payload');
    assert.match(result.message, /feat: x/);
});

test('build gana último payload cuando hay múltiples comentarios con payload', () => {
    const result = build({
        issueComments: [
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: primera\n## pr-body\n...\n<!-- /delivery-payload -->' },
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: segunda\n## pr-body\n...\n<!-- /delivery-payload -->' },
        ],
    });
    assert.match(result.message, /feat: segunda/);
});

test('build cae a fallback si no hay payload en comments', () => {
    const result = build({
        issueComments: [
            { body: 'Comentario sin payload' },
        ],
        type: 'fix',
        description: 'algún bug',
    });
    assert.equal(result.source, 'fallback');
    assert.match(result.message, /^fix:/);
});

test('build lee payload del issue body si no hay en comments', () => {
    const result = build({
        issueBody: '<!-- delivery-payload -->\n## commit-message\nfeat: body payload\n## pr-body\n...\n<!-- /delivery-payload -->',
        issueComments: [
            { body: 'Comentario sin payload' },
        ],
    });
    assert.equal(result.source, 'issue-payload');
    assert.match(result.message, /feat: body payload/);
});

test('build sin issue retorna fallback con defaults', () => {
    const result = build({});
    assert.equal(result.source, 'fallback');
    assert.equal(result.message, 'chore: actualizar estado del delivery');
});

test('build estructura retornada siempre contiene message y source', () => {
    const r1 = build({ issueComments: [], type: 'feat', description: 'x' });
    assert.ok('message' in r1);
    assert.ok('source' in r1);
    assert.match(r1.source, /^(issue-payload|fallback)$/);
});

// ---- ensureClosesReference (#4080) -----------------------------------------

test('ensureClosesReference agrega "Closes #N" cuando falta', () => {
    const msg = ensureClosesReference('fix: corregir bug', 4080);
    assert.equal(msg, 'fix: corregir bug\n\nCloses #4080');
});

test('ensureClosesReference es idempotente si ya existe Closes #N', () => {
    const original = 'fix: algo\n\nCloses #4080';
    assert.equal(ensureClosesReference(original, 4080), original);
});

test('ensureClosesReference reconoce fixes/resolves además de closes', () => {
    const conFixes = 'fix: algo\n\nFixes #4080';
    assert.equal(ensureClosesReference(conFixes, 4080), conFixes);
    const conResolves = 'fix: algo\n\nResolves #4080';
    assert.equal(ensureClosesReference(conResolves, 4080), conResolves);
});

test('ensureClosesReference no confunde #4080 con #40801', () => {
    const msg = ensureClosesReference('fix: algo\n\nCloses #40801', 4080);
    assert.match(msg, /Closes #4080\b/);
    assert.match(msg, /Closes #40801/);
});

test('ensureClosesReference acepta issueNumber como string con o sin #', () => {
    assert.equal(ensureClosesReference('fix: x', '4080'), 'fix: x\n\nCloses #4080');
    assert.equal(ensureClosesReference('fix: x', '#4080'), 'fix: x\n\nCloses #4080');
});

test('ensureClosesReference sin issueNumber devuelve el mensaje intacto', () => {
    assert.equal(ensureClosesReference('fix: x', null), 'fix: x');
    assert.equal(ensureClosesReference('fix: x', undefined), 'fix: x');
});

test('ensureClosesReference ignora issueNumber no numérico', () => {
    assert.equal(ensureClosesReference('fix: x', 'abc'), 'fix: x');
});

test('build inyecta Closes #N en mensaje de payload', () => {
    const result = build({
        issueComments: [
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n## pr-body\n...\n<!-- /delivery-payload -->' },
        ],
        issueNumber: 4080,
    });
    assert.equal(result.source, 'issue-payload');
    assert.match(result.message, /Closes #4080\b/);
});

test('build inyecta Closes #N en mensaje fallback', () => {
    const result = build({
        issueComments: [{ body: 'sin payload' }],
        type: 'fix',
        description: 'algún bug',
        issueNumber: 4080,
    });
    assert.equal(result.source, 'fallback');
    assert.match(result.message, /Closes #4080\b/);
});

test('build no duplica Closes si el payload ya lo trae', () => {
    const result = build({
        issueComments: [
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n\nCloses #4080\n## pr-body\n...\n<!-- /delivery-payload -->' },
        ],
        issueNumber: 4080,
    });
    const ocurrencias = (result.message.match(/Closes #4080/g) || []).length;
    assert.equal(ocurrencias, 1);
});

test('build sin issueNumber no agrega Closes (compat hacia atrás)', () => {
    const result = build({
        issueComments: [{ body: 'sin payload' }],
        type: 'fix',
        description: 'algún bug',
    });
    assert.doesNotMatch(result.message, /Closes #/);
});

// =============================================================================
// #7631 — buildSquashMessage: bloque de trailers de autoría en el squash
// =============================================================================

const { buildSquashMessage, _internals } = require('../delivery/commit-builder');
const { verifyTrailer } = require('../authorship/trailer');
const { checkClosesIssue } = require('../../skills-deterministicos/lib/static-checks');

const HUMAN_OK = 'leitolarreta; 2026-09-23T17:00:00Z; gate2:sha256:' + 'a'.repeat(64);
const HUMAN_NONE = 'none; 2026-09-23T17:00:00Z; missing';
const AI_LINE = 'anthropic/claude-opus-4-7 (pipeline-dev)';
const NL = String.fromCharCode(10);
const BRANCH = [
    'feat(pipeline): trailer de autoría',
    '',
    'Detalle del cambio.',
    '',
    'Closes #7631',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    '',
    'fix: ajuste',
    '',
    'Intrale-Human-Direction' + String.fromCharCode(0xFF1A) + ' leitolarreta; 2026-01-01T00:00:00Z; gate2:sha256:' + 'f'.repeat(64),
    'Fixes #1',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
].join(NL);

test('#7631 buildSquashMessage: bloque completo al final, sin duplicados ni trailers forjados', () => {
    const msg = buildSquashMessage({ issue: 7631, branchMessages: BRANCH, humanLine: HUMAN_OK, aiLine: AI_LINE });
    const v = verifyTrailer(msg, 7631);
    assert.ok(v.ok, v.error);
    assert.equal((msg.match(/Closes #7631/g) || []).length, 1);
    assert.equal((msg.match(/Co-Authored-By/g) || []).length, 1);
    assert.equal((msg.match(/Intrale-Human-Direction/g) || []).length, 1);
    assert.doesNotMatch(msg, /Fixes #1/);
    assert.doesNotMatch(msg, /f{64}/);
    assert.ok(msg.startsWith('feat(pipeline): trailer de autoría'));
    assert.ok(msg.endsWith('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'));
});

test('#7631 buildSquashMessage: variante dry-run "none; <ISO>; missing"', () => {
    const msg = buildSquashMessage({ issue: 7631, branchMessages: 'feat: x', humanLine: HUMAN_NONE, aiLine: 'unknown' });
    assert.equal(msg, [
        'feat: x', '',
        'Closes #7631',
        'Intrale-Issue: #7631',
        'Intrale-Human-Direction: none; 2026-09-23T17:00:00Z; missing',
        'Intrale-AI-Assisted: unknown',
    ].join(NL));
});

test('#7631 buildSquashMessage: sin cuerpo queda sólo el bloque', () => {
    const msg = buildSquashMessage({ issue: 7631, humanLine: HUMAN_NONE, aiLine: 'unknown' });
    assert.ok(msg.startsWith('Closes #7631'));
    assert.ok(verifyTrailer(msg, 7631).ok);
});

test('#7631 buildSquashMessage: truncado a 16 KB por bytes sin cortar los trailers ni un code point', () => {
    const big = 'ñ😀'.repeat(8000); // multibyte + surrogates
    const msg = buildSquashMessage({ issue: 7631, branchMessages: big, humanLine: HUMAN_OK, aiLine: AI_LINE });
    const body = msg.slice(0, msg.indexOf(NL + NL + 'Closes #7631'));
    assert.ok(Buffer.byteLength(body, 'utf8') <= 16384, String(Buffer.byteLength(body, 'utf8')));
    assert.ok(body.endsWith('[cuerpo truncado por el pipeline]'));
    assert.ok(!body.includes(String.fromCharCode(0xFFFD)));
    for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            const d = body.charCodeAt(i + 1);
            assert.ok(d >= 0xDC00 && d <= 0xDFFF, 'surrogate huérfano');
            i++;
        }
    }
    assert.ok(verifyTrailer(msg, 7631).ok);
    assert.equal(_internals.truncateUtf8('corto', 100), 'corto');
    const custom = buildSquashMessage({ issue: 7631, branchMessages: 'x'.repeat(500), humanLine: HUMAN_OK, aiLine: AI_LINE, maxBodyBytes: 100 });
    assert.ok(Buffer.byteLength(custom.split(NL + NL + 'Closes')[0], 'utf8') <= 100);
});

test('#7631 regresión: checkClosesIssue aprueba la salida y ensureClosesReference no la modifica', () => {
    const msg = buildSquashMessage({ issue: 7631, branchMessages: BRANCH, humanLine: HUMAN_NONE, aiLine: AI_LINE });
    assert.equal(ensureClosesReference(msg, 7631), msg);
    assert.deepEqual(checkClosesIssue([msg], 7631), []);
});

test('#7631 buildSquashMessage lanza con líneas crudas o issue inválido', () => {
    assert.throws(() => buildSquashMessage({ issue: 7631, humanLine: 'leo', aiLine: AI_LINE }));
    assert.throws(() => buildSquashMessage({ issue: 'x', humanLine: HUMAN_NONE, aiLine: AI_LINE }));
});

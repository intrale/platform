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

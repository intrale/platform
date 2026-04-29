// =============================================================================
// Tests pr-builder.js — refactor de /delivery (#2870)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    build,
    parseDeliveryPayload,
    buildFallbackBody,
} = require('../delivery/pr-builder');

// ---- parseDeliveryPayload --------------------------------------------------

test('parseDeliveryPayload extrae la sección pr-body del payload', () => {
    const issue = `
<!-- delivery-payload -->
## commit-message
fix(api): corregir parsing JSON

## pr-body
- Punto 1 del PR
- Punto 2 del PR

Descripción larga del PR.

## qa-disposition
qa:passed
<!-- /delivery-payload -->
`;
    const result = parseDeliveryPayload(issue);
    assert.match(result, /Punto 1 del PR/);
    assert.match(result, /Descripción larga del PR/);
});

test('parseDeliveryPayload devuelve null si no hay payload', () => {
    const issue = 'Este es solo un comentario sin payload';
    const result = parseDeliveryPayload(issue);
    assert.equal(result, null);
});

test('parseDeliveryPayload maneja espacios alrededor del marker', () => {
    const issue = `
<!--  delivery-payload  -->
## commit-message
feat: x

##  pr-body
Contenido del PR

##  qa-disposition
qa:passed
<!--  /delivery-payload  -->
`;
    const result = parseDeliveryPayload(issue);
    assert.match(result, /Contenido del PR/);
});

// ---- buildFallbackBody --------------------------------------------------

test('buildFallbackBody genera body simple sin contenido', () => {
    const body = buildFallbackBody({});
    assert.match(body, /## Resumen/);
    assert.match(body, /Actualización del sistema de entrega/);
    assert.match(body, /Claude Code/);
});

test('buildFallbackBody incluye descripción cuando existe', () => {
    const body = buildFallbackBody({
        description: 'Implementar nueva API de usuarios',
    });
    assert.match(body, /Implementar nueva API de usuarios/);
});

test('buildFallbackBody incluye estadísticas de diff', () => {
    const body = buildFallbackBody({
        filesChanged: 5,
        insertions: 120,
        deletions: 30,
    });
    assert.match(body, /5 archivo/);
    assert.match(body, /120 línea.*agregada/);
    assert.match(body, /30 línea.*removida/);
});

test('buildFallbackBody incluye Closes cuando hay issue number', () => {
    const body = buildFallbackBody({
        issueNumber: 123,
    });
    assert.match(body, /Closes #123/);
});

test('buildFallbackBody incluye footer con Claude Code', () => {
    const body = buildFallbackBody({});
    assert.match(body, /🤖 Generado con/);
    assert.match(body, /claude-code/i);
});

// ---- build principal -------------------------------------------------------

test('build lee payload del último comentario del issue', () => {
    const result = build({
        issueComments: [
            { body: 'Comentario 1' },
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n## pr-body\nPayload PR\n## qa-disposition\n...\n<!-- /delivery-payload -->' },
            { body: 'Comentario 3 sin payload' },
        ],
    });
    assert.equal(result.source, 'issue-payload');
    assert.match(result.body, /Payload PR/);
});

test('build gana último payload cuando hay múltiples comentarios con payload', () => {
    const result = build({
        issueComments: [
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n## pr-body\nPrimera\n## qa-disposition\nqa:passed\n<!-- /delivery-payload -->' },
            { body: '<!-- delivery-payload -->\n## commit-message\nfeat: y\n## pr-body\nSegunda\n## qa-disposition\nqa:passed\n<!-- /delivery-payload -->' },
        ],
    });
    assert.match(result.body, /Segunda/);
});

test('build cae a fallback si no hay payload en comments', () => {
    const result = build({
        issueComments: [
            { body: 'Comentario sin payload' },
        ],
        description: 'Nueva feature',
        diffStat: { files: 2, insertions: 50, deletions: 10 },
    });
    assert.equal(result.source, 'fallback');
    assert.match(result.body, /Nueva feature/);
    assert.match(result.body, /2 archivo/);
});

test('build lee payload del issue body si no hay en comments', () => {
    const result = build({
        issueBody: '<!-- delivery-payload -->\n## commit-message\nfeat: x\n## pr-body\nPayload body\n## qa-disposition\nqa:passed\n<!-- /delivery-payload -->',
        issueComments: [
            { body: 'Comentario sin payload' },
        ],
    });
    assert.equal(result.source, 'issue-payload');
    assert.match(result.body, /Payload body/);
});

test('build sin issue retorna fallback con defaults', () => {
    const result = build({});
    assert.equal(result.source, 'fallback');
    assert.match(result.body, /Actualización del sistema de entrega/);
});

test('build estructura retornada siempre contiene body y source', () => {
    const r1 = build({ issueComments: [] });
    assert.ok('body' in r1);
    assert.ok('source' in r1);
    assert.match(r1.source, /^(issue-payload|fallback)$/);
});

test('build combina descripción + diff stat + issue number en fallback', () => {
    const result = build({
        description: 'Arreglar bug crítico',
        diffStat: { files: 3, insertions: 75, deletions: 20 },
        issueNumber: 456,
    });
    assert.match(result.body, /Arreglar bug crítico/);
    assert.match(result.body, /3 archivo/);
    assert.match(result.body, /75 línea.*agregada/);
    assert.match(result.body, /Closes #456/);
});

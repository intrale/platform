'use strict';

// =============================================================================
// gh-title-cache-poison-4566.test.js — regresión #4566.
//
// Incidente 2026-07-08: un hipo transitorio de `gh` (rate-limit / red / timeout)
// hizo que el handler de error confundiera "el comando gh falló" con "el issue no
// existe" y persistiera cada issue como `{ notFound: true }` — una negative-cache
// PERMANENTE. `title-cache-freshness` nunca la re-consultaba, así un fallo de 3s
// envenenó los 31 issues de la ola y clavó el avance del dashboard en ~12%.
//
// Estos tests cubren las funciones PURAS de clasificación (lib/gh-title-fetch.js)
// y la frescura (lib/title-cache-freshness.js). Sin red, determinísticos.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');

const {
    parseGraphqlBody,
    applyGraphqlBatch,
    classify1x1Error,
    applyFallbackError,
    markTransient,
    TRANSIENT_RE,
} = require('../lib/gh-title-fetch');
const { needsRefetch } = require('../lib/title-cache-freshness');

const NOW = 1_000_000;

// --- parseGraphqlBody --------------------------------------------------------

test('parseGraphqlBody: respuesta sana clasifica issues como buenos, sin transitorio', () => {
    const out = JSON.stringify({
        data: { repository: {
            i0: { number: 10, title: 'A', state: 'CLOSED', labels: { nodes: [{ name: 'bug' }] } },
            i1: { number: 11, title: 'B', state: 'OPEN', labels: { nodes: [] } },
        } },
    });
    const body = parseGraphqlBody(out);
    assert.equal(body.ok, true);
    assert.equal(body.transient, false);
    assert.equal(body.notFoundAliases.size, 0);
});

test('parseGraphqlBody: RATE_LIMITED con repository:null marca transitorio, NO notFound', () => {
    const out = JSON.stringify({
        data: { repository: null },
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
    });
    const body = parseGraphqlBody(out);
    assert.equal(body.ok, true);
    assert.equal(body.transient, true);
    assert.equal(body.notFoundAliases.size, 0);
});

test('parseGraphqlBody: NOT_FOUND por-alias marca ese alias, sin transitorio', () => {
    const out = JSON.stringify({
        data: { repository: { i0: { number: 10, title: 'A', state: 'OPEN', labels: { nodes: [] } }, i1: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'i1'], message: 'Could not resolve to an Issue' }],
    });
    const body = parseGraphqlBody(out);
    assert.equal(body.ok, true);
    assert.equal(body.transient, false);
    assert.ok(body.notFoundAliases.has('i1'));
    assert.ok(!body.notFoundAliases.has('i0'));
});

test('parseGraphqlBody: body ilegible → ok:false y transitorio', () => {
    const body = parseGraphqlBody('esto no es json <html>500</html>');
    assert.equal(body.ok, false);
    assert.equal(body.transient, true);
});

test('parseGraphqlBody: stdout vacío (comando falló sin body) → ok:false y transitorio', () => {
    const body = parseGraphqlBody('');
    assert.equal(body.ok, false);
    assert.equal(body.transient, true);
});

// --- applyGraphqlBatch: EL BUG DEL INCIDENTE ---------------------------------

test('applyGraphqlBatch: batch RATE_LIMITED NO envenena entradas previas buenas (CA principal)', () => {
    // Cache previo: los 3 issues estaban resueltos y CLOSED (avance real 100%).
    const cache = {
        '10': { title: 'A', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 },
        '11': { title: 'B', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 },
        '12': { title: 'C', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 },
    };
    const out = JSON.stringify({
        data: { repository: null },
        errors: [{ type: 'RATE_LIMITED', message: 'rate limit' }],
    });
    applyGraphqlBatch(cache, ['10', '11', '12'], parseGraphqlBody(out), NOW);

    // NINGUNA entrada quedó como notFound; todas conservan state CLOSED.
    for (const k of ['10', '11', '12']) {
        assert.equal(cache[k].notFound, undefined, `#${k} no debe marcarse notFound`);
        assert.equal(cache[k].state, 'CLOSED', `#${k} conserva state CLOSED`);
    }
});

test('applyGraphqlBatch: transitorio sin entrada previa marca transientError (reintentar), no notFound', () => {
    const cache = {};
    const out = JSON.stringify({ data: { repository: null }, errors: [{ type: 'RATE_LIMITED' }] });
    applyGraphqlBatch(cache, ['99'], parseGraphqlBody(out), NOW);
    assert.equal(cache['99'].transientError, true);
    assert.equal(cache['99'].notFound, undefined);
});

test('applyGraphqlBatch: 404 GENUINO sí marca notFound', () => {
    const cache = {};
    const out = JSON.stringify({
        data: { repository: { i0: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'i0'], message: 'Could not resolve to an Issue' }],
    });
    applyGraphqlBatch(cache, ['777'], parseGraphqlBody(out), NOW);
    assert.equal(cache['777'].notFound, true);
    assert.equal(cache['777'].transientError, undefined);
});

test('applyGraphqlBatch: mezcla bueno + 404 genuino sin transitorio global', () => {
    const cache = {};
    const out = JSON.stringify({
        data: { repository: {
            i0: { number: 10, title: 'A', state: 'OPEN', labels: { nodes: [{ name: 'Ready' }] } },
            i1: null,
        } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'i1'] }],
    });
    applyGraphqlBatch(cache, ['10', '11'], parseGraphqlBody(out), NOW);
    assert.equal(cache['10'].state, 'OPEN');
    assert.deepEqual(cache['10'].labels, ['Ready']);
    assert.equal(cache['11'].notFound, true);
});

test('applyGraphqlBatch: 404 aparente PERO con error transitorio global → no envenena (conserva previo)', () => {
    // Si hubo RATE_LIMITED en el batch, un `null` de issue NO es prueba de 404.
    const cache = { '11': { title: 'B', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 } };
    const out = JSON.stringify({
        data: { repository: { i0: null } },
        errors: [{ type: 'RATE_LIMITED' }],
    });
    applyGraphqlBatch(cache, ['11'], parseGraphqlBody(out), NOW);
    assert.equal(cache['11'].notFound, undefined);
    assert.equal(cache['11'].state, 'CLOSED');
});

// --- classify1x1Error / applyFallbackError -----------------------------------

test('classify1x1Error: error de red (ECONNRESET) es transitorio', () => {
    assert.equal(classify1x1Error({ message: 'read ECONNRESET' }), 'transient');
});

test('classify1x1Error: timeout es transitorio', () => {
    assert.equal(classify1x1Error(new Error('Command timed out after 10000ms')), 'transient');
});

test('classify1x1Error: rate limit en stderr es transitorio (aunque mencione recurso)', () => {
    assert.equal(classify1x1Error({ stderr: 'HTTP 403: API rate limit exceeded' }), 'transient');
});

test('classify1x1Error: stderr "Could not resolve to an Issue" es 404 genuino', () => {
    assert.equal(classify1x1Error({ stderr: 'GraphQL: Could not resolve to an Issue with the number of 999 (repository.issue)' }), 'notfound');
});

test('applyFallbackError: error de red NO escribe notFound (marca transientError si no hay previo)', () => {
    const cache = {};
    applyFallbackError(cache, '55', { message: 'connect ETIMEDOUT' }, NOW);
    assert.equal(cache['55'].notFound, undefined);
    assert.equal(cache['55'].transientError, true);
});

test('applyFallbackError: error de red conserva entrada previa buena', () => {
    const cache = { '55': { title: 'X', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 } };
    applyFallbackError(cache, '55', { message: 'connect ETIMEDOUT' }, NOW);
    assert.equal(cache['55'].state, 'CLOSED');
    assert.equal(cache['55'].transientError, undefined);
});

test('applyFallbackError: 404 genuino SÍ escribe notFound', () => {
    const cache = {};
    applyFallbackError(cache, '55', { stderr: 'Could not resolve to an Issue with the number of 55' }, NOW);
    assert.equal(cache['55'].notFound, true);
});

// --- #4732: `gh` ausente en el PATH (ENOENT) es transitorio, no 404 ----------

test('TRANSIENT_RE matchea ENOENT y "spawn gh ENOENT" (#4732)', () => {
    assert.equal(TRANSIENT_RE.test('spawn gh ENOENT'), true);
    assert.equal(TRANSIENT_RE.test('Error: spawn C:/Workspaces/gh-cli/bin/gh ENOENT'), true);
    assert.equal(TRANSIENT_RE.test('ENOENT'), true);
});

test('classify1x1Error: gh ausente (ENOENT) clasifica como transient, no notfound (#4732)', () => {
    assert.equal(classify1x1Error({ message: 'spawn gh ENOENT' }), 'transient');
    assert.equal(classify1x1Error({ code: 'ENOENT', message: 'spawn ENOENT' }), 'transient');
});

test('applyFallbackError: gh ausente (ENOENT) conserva la entrada previa buena (#4732)', () => {
    const cache = { '4685': { title: 'X', state: 'CLOSED', labels: [], fetchedAt: NOW - 5000 } };
    applyFallbackError(cache, '4685', { message: 'spawn gh ENOENT' }, NOW);
    assert.equal(cache['4685'].state, 'CLOSED');
    assert.equal(cache['4685'].notFound, undefined);
    assert.equal(cache['4685'].transientError, undefined);
});

test('markTransient: ENOENT sin entrada previa marca transientError (reintentar), no notFound (#4732)', () => {
    const cache = {};
    markTransient(cache, '4685', NOW);
    assert.equal(cache['4685'].transientError, true);
    assert.equal(cache['4685'].notFound, undefined);
});

// --- needsRefetch (freshness) ------------------------------------------------

test('needsRefetch: transientError siempre se reintenta', () => {
    assert.equal(needsRefetch({ transientError: true, fetchedAt: NOW }, { now: NOW }), true);
});

test('needsRefetch: notFound reciente NO se re-consulta (SEC-3)', () => {
    assert.equal(needsRefetch({ notFound: true, fetchedAt: NOW }, { now: NOW }), false);
});

test('needsRefetch: notFound viejo (> TTL negativo) se re-consulta (auto-cura)', () => {
    const veryOld = NOW - 25 * 3600000; // 25h > 24h
    assert.equal(needsRefetch({ notFound: true, fetchedAt: veryOld }, { now: NOW }), true);
});

test('needsRefetch: entrada buena fresca NO se re-consulta', () => {
    assert.equal(needsRefetch({ state: 'CLOSED', fetchedAt: NOW }, { now: NOW }), false);
});

test('needsRefetch: entrada buena vencida se re-consulta', () => {
    assert.equal(needsRefetch({ state: 'CLOSED', fetchedAt: NOW - 2 * 3600000 }, { now: NOW }), true);
});

test('needsRefetch: sin entrada se re-consulta', () => {
    assert.equal(needsRefetch(undefined, { now: NOW }), true);
});

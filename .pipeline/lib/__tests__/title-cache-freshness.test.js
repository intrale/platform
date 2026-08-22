// =============================================================================
// title-cache-freshness.test.js — Frescura del issue-title-cache (#4099, CA-3).
//
// Cubre los escenarios Gherkin del issue:
//   - entrada vencida (now - fetchedAt > TTL) → se marca para refetch
//   - entrada `notFound` (negative cache)    → NO dispara gh (SEC-3)
//   - entrada fresca con `state`             → NO se re-pide
//   - sin entrada / entrada pre-#3905        → refetch
//
// Ejecutar: node --test .pipeline/lib/__tests__/title-cache-freshness.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { needsRefetch, DEFAULT_TITLE_CACHE_TTL_MS } = require('../title-cache-freshness');

const NOW = 1781887018616;
const TTL = DEFAULT_TITLE_CACHE_TTL_MS; // 1h

test('#4099 CA-3: entrada vencida (now - fetchedAt > TTL) se marca para refetch', () => {
    const entry = { state: 'OPEN', labels: ['Ready'], fetchedAt: NOW - (TTL + 1000) };
    assert.equal(needsRefetch(entry, { now: NOW, ttlMs: TTL }), true);
});

test('#4099 CA-3: entrada fresca con state NO se re-pide', () => {
    const entry = { state: 'CLOSED', labels: ['done'], fetchedAt: NOW - 1000 };
    assert.equal(needsRefetch(entry, { now: NOW, ttlMs: TTL }), false);
});

test('#4099 CA-3: entrada notFound (negative cache) NO dispara gh aunque esté vieja', () => {
    const entry = { title: '', labels: [], notFound: true, fetchedAt: NOW - (TTL * 10) };
    assert.equal(needsRefetch(entry, { now: NOW, ttlMs: TTL }), false);
});

test('#4099: sin entrada en cache → refetch', () => {
    assert.equal(needsRefetch(undefined, { now: NOW, ttlMs: TTL }), true);
    assert.equal(needsRefetch(null, { now: NOW, ttlMs: TTL }), true);
});

test('#4099: entrada pre-#3905 (sin state) → refetch para poblar state', () => {
    const entry = { title: 'Algo', labels: ['Ready'], fetchedAt: NOW - 1000 };
    assert.equal(needsRefetch(entry, { now: NOW, ttlMs: TTL }), true);
});

test('#4099: entrada justo en el límite del TTL no se re-pide (estrictamente mayor)', () => {
    const entry = { state: 'OPEN', labels: [], fetchedAt: NOW - TTL };
    // now - fetchedAt === TTL, no es > TTL → fresca.
    assert.equal(needsRefetch(entry, { now: NOW, ttlMs: TTL }), false);
});

test('#4099: caso #4050 — entrada CLOSED fresca no se re-pide; vencida sí', () => {
    const fresh = { state: 'CLOSED', labels: ['enhancement', 'blocked:dependencies'], fetchedAt: NOW - 60000 };
    assert.equal(needsRefetch(fresh, { now: NOW, ttlMs: TTL }), false);
    const stale = { ...fresh, fetchedAt: NOW - (TTL + 60000) };
    assert.equal(needsRefetch(stale, { now: NOW, ttlMs: TTL }), true);
});

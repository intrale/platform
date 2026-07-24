// =============================================================================
// multi-provider-health-badge-4364.test.js — #4364
// Valida la lógica PURA del badge de salud/cuota por provider de la vista
// "Salud MP" del dashboard: mapeo de estado y normalización de id.
//
// Cobertura de la lógica pura (mapeo/normalización) al 100% — sin I/O ni DOM.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeHealthId,
    healthById,
    healthBadge,
    CLIENT_JS,
} = require('../views/dashboard/multi-provider-health');

// Muestra representativa de lo que devuelve /api/pulpo/provider-health.
const PROVIDERS = [
    { id: 'anthropic', status: 'not_applicable', resets_at: null },
    { id: 'openai-codex', status: 'ok', resets_at: null },
    { id: 'gemini-google', status: 'gated', resets_at: '2026-07-02T18:00:00.000Z' },
    { id: 'cerebras', status: 'unknown', resets_at: null },
    { id: 'nvidia-nim', status: 'ok', resets_at: null },
];

test('normalizeHealthId mapea openai a openai-codex y deja el resto igual', () => {
    assert.equal(normalizeHealthId('openai'), 'openai-codex');
    assert.equal(normalizeHealthId('openai-codex'), 'openai-codex');
    assert.equal(normalizeHealthId('anthropic'), 'anthropic');
    assert.equal(normalizeHealthId('cerebras'), 'cerebras');
});

test('healthById encuentra el provider canonico normalizando openai', () => {
    const found = healthById('openai', PROVIDERS);
    assert.ok(found);
    assert.equal(found.id, 'openai-codex');
    assert.equal(found.status, 'ok');
});

test('healthById devuelve null cuando no hay match tras normalizar', () => {
    assert.equal(healthById('inexistente', PROVIDERS), null);
    assert.equal(healthById('openai', []), null);
    assert.equal(healthById('anthropic', null), null);
});

test('healthBadge mapea status ok a sano con clase health-ok', () => {
    const b = healthBadge('openai-codex', PROVIDERS);
    assert.deepEqual(b, { cls: 'health-ok', label: 'sano', icon: 'ic-health-ok' });
});

test('healthBadge mapea status gated a agotado con clase health-gated y conserva resets_at', () => {
    const b = healthBadge('gemini-google', PROVIDERS);
    assert.equal(b.cls, 'health-gated');
    assert.equal(b.label, 'agotado');
    assert.equal(b.icon, 'ic-quota-exhausted');
    assert.equal(b.resets_at, '2026-07-02T18:00:00.000Z');
});

test('healthBadge mapea status unknown a inutilizable con clase health-broken', () => {
    const b = healthBadge('cerebras', PROVIDERS);
    assert.deepEqual(b, { cls: 'health-broken', label: 'inutilizable', icon: 'ic-health-dead' });
});

test('healthBadge mapea cualquier status desconocido a inutilizable (defensa)', () => {
    const b = healthBadge('x', [{ id: 'x', status: 'algo_raro' }]);
    assert.equal(b.cls, 'health-broken');
    assert.equal(b.label, 'inutilizable');
});

test('healthBadge devuelve null para status not_applicable (no se pinta badge)', () => {
    assert.equal(healthBadge('anthropic', PROVIDERS), null);
});

test('healthBadge cae a "sin dato" visible cuando no hay match (CA-4)', () => {
    const b = healthBadge('openai', []);
    assert.deepEqual(b, { cls: 'nodata', label: 'sin dato', icon: 'ic-provider-unknown' });
});

test('healthBadge normaliza openai al indexar (openai -> openai-codex)', () => {
    const b = healthBadge('openai', PROVIDERS);
    assert.equal(b.cls, 'health-ok');
    assert.equal(b.label, 'sano');
});

test('CLIENT_JS embebe las funciones puras y el fetch al endpoint sanitizado', () => {
    // Single source of truth: el browser corre las mismas funciones testeadas.
    assert.match(CLIENT_JS, /function healthBadge\(/);
    assert.match(CLIENT_JS, /function normalizeHealthId\(/);
    assert.match(CLIENT_JS, /function healthById\(/);
    assert.match(CLIENT_JS, /function healthBadgeHtml\(/);
    // Reutiliza el endpoint existente, sin crear uno nuevo.
    assert.match(CLIENT_JS, /\/api\/pulpo\/provider-health/);
    // Campo de estado agregado.
    assert.match(CLIENT_JS, /health: null/);
});

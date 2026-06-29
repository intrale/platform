// =============================================================================
// mission-banner-eta.test.js — #4296
//
// Cobertura del helper COMPARTIDO de hidratación del banner de ola
// (avance %, velocidad, ETA) que consumen TODAS las ventanas del dashboard.
// Antes cada subventana derivaba el avance de conteos de issues y quedaba
// congelada/divergente respecto de la HOME; ahora hay una sola fuente.
//
// Cubre:
//   - hydrateMissionBanner aplica totalPct vivo en modo velocity Y fallback.
//   - totalPct null/no-finito → "—" (sin coerción a 0); totalPct 0 → "0%" real.
//   - velocidad %/h sólo con ritmo medido; si no, "—".
//   - ETA por velocidad cuando hay ritmo; p50 si no.
//   - defensivo: document nulo / payload nulo / ready:false → no toca nada.
//   - el snippet client (MISSION_OLA_ETA_CLIENT_JS) es JS parseable.
//
// node --test .pipeline/views/dashboard/__tests__/mission-banner-eta.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hydrateMissionBanner, MISSION_OLA_ETA_CLIENT_JS, buildClientJs } = require('../mission-banner-eta.js');

// document fake mínimo: getElementById sobre un mapa de ids conocidos.
function fakeDoc() {
    const els = {};
    ['mission-avance-pct', 'mission-vel-value', 'mission-eta-value', 'mission-eta-sub'].forEach((id) => {
        els[id] = { textContent: '', innerHTML: '' };
    });
    return { getElementById: (id) => els[id] || null, _els: els };
}

test('hydrateMissionBanner — modo velocity: avance, %/h y ETA por velocidad', () => {
    const doc = fakeDoc();
    hydrateMissionBanner(doc, {
        ready: true, etaSource: 'velocity', totalPct: 60.4, totalP50: 90,
        velocityETA: { velocityPctPerMin: 0.25, remainingMs: 7200000 },
    });
    assert.strictEqual(doc._els['mission-avance-pct'].textContent, '60%');
    assert.strictEqual(doc._els['mission-vel-value'].textContent, '15.0 %/h');
    assert.strictEqual(doc._els['mission-eta-value'].textContent, '2h', 'restante proyectado por velocidad');
    assert.strictEqual(doc._els['mission-eta-sub'].textContent, 'proyección por velocidad');
});

test('hydrateMissionBanner — modo fallback: avance vivo, velocidad "—", ETA p50', () => {
    const doc = fakeDoc();
    hydrateMissionBanner(doc, { ready: true, etaSource: 'fallback', totalPct: 42, totalP50: 120, velocityETA: null });
    assert.strictEqual(doc._els['mission-avance-pct'].textContent, '42%', 'avance vivo aunque sea fallback');
    assert.strictEqual(doc._els['mission-vel-value'].textContent, '— %/h');
    assert.strictEqual(doc._els['mission-eta-value'].textContent, '2h', 'ETA cae a p50 sin ritmo');
    assert.strictEqual(doc._els['mission-eta-sub'].textContent, 'estimación por percentiles');
});

test('hydrateMissionBanner — totalPct null → "—" (sin coerción a 0)', () => {
    const doc = fakeDoc();
    hydrateMissionBanner(doc, { ready: true, etaSource: 'fallback', totalPct: null, totalP50: null, velocityETA: null });
    assert.strictEqual(doc._els['mission-avance-pct'].textContent, '—');
    assert.strictEqual(doc._els['mission-eta-value'].textContent, '—');
});

test('hydrateMissionBanner — totalPct 0 es avance real (0%), no "—"', () => {
    const doc = fakeDoc();
    hydrateMissionBanner(doc, { ready: true, etaSource: 'fallback', totalPct: 0, totalP50: 30, velocityETA: null });
    assert.strictEqual(doc._els['mission-avance-pct'].textContent, '0%');
});

test('hydrateMissionBanner — velocityPctPerMin <= 0 no cuenta como ritmo medido', () => {
    const doc = fakeDoc();
    hydrateMissionBanner(doc, {
        ready: true, etaSource: 'velocity', totalPct: 10, totalP50: 60,
        velocityETA: { velocityPctPerMin: 0, remainingMs: 600000 },
    });
    assert.strictEqual(doc._els['mission-vel-value'].textContent, '— %/h', 'sin ritmo positivo → "—"');
    assert.strictEqual(doc._els['mission-eta-value'].textContent, '1h', 'cae a p50');
});

test('hydrateMissionBanner — defensivo: document nulo / payload nulo / ready:false no rompen', () => {
    assert.doesNotThrow(() => hydrateMissionBanner(null, { ready: true, totalPct: 50 }));
    const doc = fakeDoc();
    hydrateMissionBanner(doc, null);
    hydrateMissionBanner(doc, { ready: false, totalPct: 99 });
    assert.strictEqual(doc._els['mission-avance-pct'].textContent, '', 'ready:false no toca el DOM');
});

test('MISSION_OLA_ETA_CLIENT_JS — snippet client es JS parseable y referencia /api/dash/ola-eta', () => {
    assert.doesNotThrow(() => new Function(MISSION_OLA_ETA_CLIENT_JS));
    assert.ok(MISSION_OLA_ETA_CLIENT_JS.includes('/api/dash/ola-eta'));
    assert.ok(MISSION_OLA_ETA_CLIENT_JS.includes('__mbOlaETAInit'), 'guard idempotente presente');
    // buildClientJs es determinístico (mismo source cada vez).
    assert.strictEqual(buildClientJs(), MISSION_OLA_ETA_CLIENT_JS);
});

// =============================================================================
// dashboard-routes-ola-eta.test.js — #4287 (CA-1)
//
// Cobertura del passthrough del route /api/dash/ola-eta: debe exponer la fuente
// determinística de avance/velocidad de la ola (velocityETA / etaSource /
// totalPct) que computa el server (dashboard.js), para que la HOME (MIZPÁ)
// hidrate `mission-avance-pct` / `mission-vel-value` desde el MISMO cómputo que
// el handler de estado de ola — no desde conteos de issues client-side.
//
// Cubre:
//   - ready:false cuando no hay cache (olaETA ausente).
//   - passthrough de velocityETA/etaSource/totalPct cuando hay ritmo medido.
//   - normalización a 'fallback' / null cuando no hay ritmo medido todavía.
//   - totalPct no-finito (NaN/undefined) → null (no se filtra basura al cliente).
//
// node --test .pipeline/lib/__tests__/dashboard-routes-ola-eta.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../dashboard-routes');
const olaETARoute = _internal.API_ROUTES['/api/dash/ola-eta'];

test('el route /api/dash/ola-eta está registrado', () => {
    assert.equal(typeof olaETARoute, 'function');
});

test('sin cache (state.olaETA ausente) devuelve ready:false', () => {
    assert.deepEqual(olaETARoute({}), { ready: false });
    assert.deepEqual(olaETARoute(null), { ready: false });
});

test('expone velocityETA/etaSource/totalPct cuando hay ritmo medido (velocity)', () => {
    const velocityETA = { source: 'velocity', remainingMs: 7200000, velocityPctPerMin: 0.25, totalPct: 60 };
    const state = {
        olaETA: {
            issues: [101, 102],
            totalP50: 90,
            etaSource: 'velocity',
            velocityETA,
            totalPct: 60,
            refreshedAt: 123,
        },
    };
    const out = olaETARoute(state);
    assert.equal(out.ready, true);
    assert.equal(out.etaSource, 'velocity');
    assert.deepEqual(out.velocityETA, velocityETA);
    assert.equal(out.totalPct, 60);
});

test('sin ritmo medido normaliza etaSource a "fallback" y velocityETA a null', () => {
    const state = {
        olaETA: {
            issues: [101],
            totalP50: 120,
            // dashboard.js dejó velocityETA null y etaSource 'fallback'; el route
            // no debe inventar un objeto vacío ni un etaSource undefined.
            velocityETA: null,
            etaSource: 'fallback',
            totalPct: 30,
        },
    };
    const out = olaETARoute(state);
    assert.equal(out.ready, true);
    assert.equal(out.etaSource, 'fallback');
    assert.equal(out.velocityETA, null);
    assert.equal(out.totalPct, 30);
});

test('totalPct no-finito (undefined/NaN) se normaliza a null (no se filtra basura)', () => {
    const undef = olaETARoute({ olaETA: { issues: [], etaSource: 'fallback' } });
    assert.equal(undef.totalPct, null);

    const nan = olaETARoute({ olaETA: { issues: [], etaSource: 'fallback', totalPct: NaN } });
    assert.equal(nan.totalPct, null);
});

test('etaSource ausente cae a "fallback" por defecto', () => {
    const out = olaETARoute({ olaETA: { issues: [], totalPct: 0 } });
    assert.equal(out.etaSource, 'fallback');
    // totalPct 0 es un avance real (0%), no "sin dato": debe pasar como 0.
    assert.equal(out.totalPct, 0);
});

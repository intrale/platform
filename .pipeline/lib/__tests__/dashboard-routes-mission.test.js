// =============================================================================
// dashboard-routes-mission.test.js — #4192
//
// Cobertura de deriveIssuesMission(state): arma el banner de misión del rediseño
// MIZPÁ de la ventana Issues desde el state en vivo. Lógica nueva no trivial que
// estaba 100% sin red (rebote del gate de aprobación).
//
// Cubre:
//   - Conteo de entregados = issues de la ola con state CLOSED (case-insensitive).
//   - Defensividad: state null / sin activeWave / sin issueTitles → estructura
//     neutra sin romper (CA-A3 del épico).
//   - Extracción de label/number de la ola y velocidad/ETA desde olaETA.
//
// node --test .pipeline/lib/__tests__/dashboard-routes-mission.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../dashboard-routes');
const { deriveIssuesMission } = _internal;

test('deriveIssuesMission cuenta entregados = issues CLOSED de la ola (case-insensitive)', () => {
    const state = {
        activeWave: { number: 7, name: 'Ola 7.1', issues: [{ number: 100 }, { number: 101 }, { number: 102 }] },
        issueTitles: {
            '100': { state: 'CLOSED' },
            '101': { state: 'closed' }, // mayúsculas indiferentes
            '102': { state: 'OPEN' },
        },
    };
    const m = deriveIssuesMission(state);
    assert.strictEqual(m.total, 3, 'total = cantidad de issues de la ola');
    assert.strictEqual(m.entregados, 2, 'sólo los CLOSED cuentan como entregados');
    assert.strictEqual(m.label, 'Ola 7.1');
    assert.strictEqual(m.number, 7);
});

test('deriveIssuesMission acepta issues como números crudos (no sólo objetos)', () => {
    const state = {
        activeWave: { number: 8, issues: [200, 201] },
        issueTitles: { '200': { state: 'CLOSED' }, '201': { state: 'OPEN' } },
    };
    const m = deriveIssuesMission(state);
    assert.strictEqual(m.total, 2);
    assert.strictEqual(m.entregados, 1);
    assert.strictEqual(m.label, 'Ola 8', 'fallback de label a "Ola <number>"');
});

test('deriveIssuesMission extrae ETA y velocidad desde olaETA.velocityETA', () => {
    const state = {
        activeWave: { number: 9, label: 'Ola Nueve', issues: [{ number: 1 }] },
        issueTitles: {},
        olaETA: { velocityETA: { remainingMs: 7200000, velocityPctPerMin: 0.25, totalPct: 60 } },
    };
    const m = deriveIssuesMission(state);
    assert.strictEqual(m.etaRemainingMs, 7200000);
    assert.strictEqual(m.velocityPctPerMin, 0.25);
    assert.strictEqual(m.totalPct, 60);
    assert.strictEqual(m.label, 'Ola Nueve', 'usa label cuando está presente');
});

test('deriveIssuesMission es defensivo ante state null/parcial sin romper', () => {
    // state null → estructura neutra.
    const m0 = deriveIssuesMission(null);
    assert.ok(m0 && typeof m0 === 'object', 'no devuelve null por state nulo');
    assert.strictEqual(m0.total, 0);
    assert.strictEqual(m0.entregados, 0);
    assert.strictEqual(m0.label, 'Ola actual', 'label por defecto');
    assert.strictEqual(m0.etaRemainingMs, null, 'sin velocidad → ETA null');
    assert.strictEqual(m0.velocityPctPerMin, null);

    // state sin activeWave ni issueTitles → no explota.
    const m1 = deriveIssuesMission({});
    assert.strictEqual(m1.total, 0);
    assert.strictEqual(m1.entregados, 0);
    assert.strictEqual(m1.number, null, 'sin number entero → null');
});

test('deriveIssuesMission no cuenta entregados si falta metadata del issue', () => {
    const state = {
        activeWave: { number: 10, issues: [{ number: 300 }, { number: 301 }] },
        issueTitles: { '300': { state: 'CLOSED' } }, // 301 sin metadata
    };
    const m = deriveIssuesMission(state);
    assert.strictEqual(m.total, 2);
    assert.strictEqual(m.entregados, 1, 'el issue sin metadata no cuenta como entregado');
});

test('deriveIssuesMission ignora velocidad con campos no finitos', () => {
    const state = {
        activeWave: { number: 11, issues: [] },
        issueTitles: {},
        olaETA: { velocityETA: { remainingMs: NaN, velocityPctPerMin: 'x', totalPct: null } },
    };
    const m = deriveIssuesMission(state);
    assert.strictEqual(m.etaRemainingMs, null);
    assert.strictEqual(m.velocityPctPerMin, null);
    assert.strictEqual(m.totalPct, null);
});

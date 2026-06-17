// =============================================================================
// pulpo-night-window.test.js — #4051
//
// Verifica la integración de la ventana nocturna en pulpo.js:
//   - getEffectiveResourceLimits aplica los umbrales nocturnos dentro de la
//     ventana, devuelve los diurnos fuera, y la base intacta sin bloque.
//   - orangeFloorReached respeta el piso de concurrencia (CA-1): con piso 2 y
//     1 agente corriendo deja pasar (false); con 2 corriendo bloquea (true).
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('../../pulpo.js');
const { getEffectiveResourceLimits, orangeFloorReached } = pulpo;

const TZ = 'America/Argentina/Buenos_Aires';

// Instante UTC correspondiente a una hora local de Buenos Aires (UTC-3).
function baLocal(hh, mm, day = 16) {
    return Date.UTC(2026, 5, day, hh + 3, mm, 0);
}

const BASE_LIMITS = {
    green_max_percent: 50,
    yellow_max_percent: 65,
    orange_max_percent: 80,
    red_max_percent: 90,
    max_concurrent_devs: 1,
    night_window: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        timezone: TZ,
        yellow_max_percent: 78,
        orange_max_percent: 88,
        red_max_percent: 93,
        min_concurrency_floor: 2,
        max_concurrent_devs: 2,
    },
};

function configWith(limits) {
    return { resource_limits: limits };
}

test('getEffectiveResourceLimits — DENTRO de la ventana aplica umbrales nocturnos', () => {
    const eff = getEffectiveResourceLimits(configWith(BASE_LIMITS), baLocal(23, 30));
    assert.equal(eff.yellow_max_percent, 78);
    assert.equal(eff.orange_max_percent, 88);
    assert.equal(eff.red_max_percent, 93);
    assert.equal(eff.min_concurrency_floor, 2);
    assert.equal(eff.max_concurrent_devs, 2);
    assert.equal(eff._nightWindowActive, true);
});

test('getEffectiveResourceLimits — FUERA de la ventana devuelve los diurnos', () => {
    const eff = getEffectiveResourceLimits(configWith(BASE_LIMITS), baLocal(12, 0));
    assert.equal(eff.yellow_max_percent, 65);
    assert.equal(eff.orange_max_percent, 80);
    assert.equal(eff.red_max_percent, 90);
    assert.equal(eff.max_concurrent_devs, 1);
    assert.equal(eff.min_concurrency_floor, undefined);
    assert.notEqual(eff._nightWindowActive, true);
});

test('getEffectiveResourceLimits — sin bloque night_window devuelve la base intacta', () => {
    const base = {
        green_max_percent: 50, yellow_max_percent: 65,
        orange_max_percent: 80, red_max_percent: 90, max_concurrent_devs: 1,
    };
    const eff = getEffectiveResourceLimits(configWith(base), baLocal(23, 30));
    assert.deepEqual(eff, base);
    assert.equal(eff._nightWindowActive, undefined);
});

test('getEffectiveResourceLimits — night_window.enabled:false no aplica overrides de noche', () => {
    const limits = JSON.parse(JSON.stringify(BASE_LIMITS));
    limits.night_window.enabled = false;
    const eff = getEffectiveResourceLimits(configWith(limits), baLocal(23, 30));
    assert.equal(eff.orange_max_percent, 80); // diurno
    assert.equal(eff.min_concurrency_floor, undefined);
});

test('getEffectiveResourceLimits — config sin resource_limits no rompe', () => {
    const eff = getEffectiveResourceLimits({}, baLocal(23, 30));
    assert.deepEqual(eff, {});
});

// --- CA-1: piso de concurrencia en ORANGE ---

test('orangeFloorReached — piso 2: con 1 agente corriendo DEJA PASAR (false)', () => {
    const eff = getEffectiveResourceLimits(configWith(BASE_LIMITS), baLocal(2, 0, 17));
    assert.equal(eff.min_concurrency_floor, 2);
    assert.equal(orangeFloorReached(1, eff), false);
});

test('orangeFloorReached — piso 2: con 2 agentes corriendo BLOQUEA (true)', () => {
    const eff = getEffectiveResourceLimits(configWith(BASE_LIMITS), baLocal(2, 0, 17));
    assert.equal(orangeFloorReached(2, eff), true);
});

test('orangeFloorReached — sin piso (diurno) el default es 1: 1 corriendo BLOQUEA', () => {
    const eff = getEffectiveResourceLimits(configWith(BASE_LIMITS), baLocal(12, 0));
    assert.equal(eff.min_concurrency_floor, undefined);
    assert.equal(orangeFloorReached(0, eff), false); // deja pasar el 1º
    assert.equal(orangeFloorReached(1, eff), true);  // bloquea el 2º
});

// =============================================================================
// mission-ola-eta.test.js — #4296
//
// Cobertura del accessor compartido del banner de ola (avance %, velocidad %/h,
// ETA). Es la fuente ÚNICA que consumen TODAS las ventanas del dashboard, así
// que su comportamiento en los dos modos (`velocity` y `fallback`) define lo que
// se ve en HOME y subventanas por igual (CA-1..CA-4).
//
// node --test .pipeline/lib/__tests__/mission-ola-eta.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMissionOlaEta, missionOlaEtaClientScript } = require('../mission-ola-eta');

test('payload nulo/indefinido degrada a estructura neutra sin romper', () => {
    for (const input of [null, undefined, 42, 'x']) {
        const m = deriveMissionOlaEta(input);
        assert.deepEqual(m, {
            avancePct: null,
            velocityPctPerHour: null,
            etaRemainingMin: null,
            etaFromVelocity: false,
            hasVelocity: false,
        });
    }
});

test('modo velocity: expone avance %, velocidad %/h y ETA por velocidad', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 61.7,
        totalP50: 120,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.25, remainingMs: 7200000, totalPct: 61.7 },
    });
    assert.equal(m.avancePct, 62);                 // totalPct redondeado
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityPctPerHour, 15);        // 0.25 × 60
    assert.equal(m.etaFromVelocity, true);
    assert.equal(m.etaRemainingMin, 120);          // 7200000ms / 60000
});

test('modo fallback: avance % vivo desde totalPct aunque velocityETA sea null', () => {
    // Este es el caso que dejaba el banner "fosilizado"/vacío en subventanas:
    // sin ritmo medido velocityETA es null, pero el totalPct determinístico está
    // presente y DEBE mostrarse (alineado con la HOME).
    const m = deriveMissionOlaEta({
        etaSource: 'fallback',
        totalPct: 40,
        totalP50: 90,
        velocityETA: null,
    });
    assert.equal(m.avancePct, 40);                 // avance vivo, NO null
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);      // "— %/h" en la vista
    assert.equal(m.etaFromVelocity, false);
    assert.equal(m.etaRemainingMin, 90);           // cae a la mediana teórica p50
});

test('velocity con velocityPctPerMin <= 0 no cuenta como ritmo medido', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 10,
        totalP50: 200,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0, remainingMs: 999 },
    });
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);
    assert.equal(m.etaRemainingMin, 200);          // fallback a p50, no remainingMs
});

test('totalPct no finito (NaN/undefined) → avancePct null (no se muestra basura)', () => {
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback' }).avancePct, null);
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: NaN }).avancePct, null);
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: '50' }).avancePct, null);
});

test('etaSource velocity pero sin remainingMs finito → ETA cae a p50', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 30,
        totalP50: 75,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.5 },
    });
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityPctPerHour, 30);
    assert.equal(m.etaFromVelocity, false);
    assert.equal(m.etaRemainingMin, 75);
});

test('el emisor de script cliente reusa la función pura y es self-wiring/idempotente', () => {
    const src = missionOlaEtaClientScript();
    assert.equal(typeof src, 'string');
    // DRY: la lógica viaja serializada, no reimplementada.
    assert.ok(src.includes('function deriveMissionOlaEta'));
    // Hidrata los tres ids del banner compartido.
    assert.ok(src.includes('mission-avance-pct'));
    assert.ok(src.includes('mission-vel-value'));
    assert.ok(src.includes('mission-eta-value'));
    // Consume la fuente viva única.
    assert.ok(src.includes('/api/dash/ola-eta'));
    // Guard de idempotencia + poll periódico.
    assert.ok(src.includes('__missionOlaEtaWired'));
    assert.ok(src.includes('setInterval'));
    // Unidad alineada con la HOME (%/h, no iss/h).
    assert.ok(src.includes('%/h'));
    assert.ok(!src.includes('iss/h'));
});

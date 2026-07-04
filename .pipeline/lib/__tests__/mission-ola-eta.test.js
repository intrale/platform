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

const { deriveMissionOlaEta, missionOlaEtaClientScript, MISSION_INSUFFICIENT_DATA } = require('../mission-ola-eta');

test('payload nulo/indefinido degrada a estructura neutra sin romper', () => {
    for (const input of [null, undefined, 42, 'x']) {
        const m = deriveMissionOlaEta(input);
        assert.deepEqual(m, {
            avancePct: null,
            velocityPctPerHour: null,
            etaRemainingMin: null,
            etaFromVelocity: false,
            hasVelocity: false,
            velocityState: 'sin datos suficientes', // #4325 CA-4: estado explícito, no mudo
            throughputPerDay: null,                 // #4450 — throughput sin dato
            throughputState: 'insufficient',        // #4450 — estado explícito
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
    // #4450 — la celda de velocidad ahora expresa throughput en issues/día, no %/h.
    assert.ok(src.includes('issues/día'));
    assert.ok(!src.includes('%/h'));
    assert.ok(!src.includes('iss/h'));
});

// -----------------------------------------------------------------------------
// #4325 (CA-4) — estado explícito "sin datos suficientes" cuando no hay ritmo
// medido, en vez del guion mudo o un 0 silencioso.
// -----------------------------------------------------------------------------

test('etaSource fallback → velocityState expone "sin datos suficientes" (no "—" ni 0)', () => {
    const m = deriveMissionOlaEta({ etaSource: 'fallback', totalPct: 66 });
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);            // sigue null (no se inventa un valor)
    assert.equal(m.velocityState, 'sin datos suficientes');
    assert.equal(m.velocityState, MISSION_INSUFFICIENT_DATA); // misma cadena exportada
    assert.notEqual(m.velocityState, '—');
    assert.notEqual(m.velocityState, 0);
});

test('etaSource velocity con ritmo medido → velocityState "measured"', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 40,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.5, remainingMs: 600000 },
    });
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityState, 'measured');
});

test('el script cliente renderiza la leyenda explícita (velocityState) en vez del guion', () => {
    const src = missionOlaEtaClientScript();
    // El cliente traduce el estado a la leyenda cuando no hay ritmo medido.
    assert.ok(src.includes('velocityState'));
    // La cadena viaja dentro de la función serializada (self-contained, sin ref a
    // constante de módulo que rompería el eval del cliente).
    assert.ok(src.includes('sin datos suficientes'));
});

// -----------------------------------------------------------------------------
// #4450 — throughput de entrega (issues/día) en la celda 🚀 VELOCIDAD.
// deriveMissionOlaEta expone throughputPerDay/throughputState; el client script
// pinta "issues/día" (measured, incluye 0.0) o la leyenda "sin datos suficientes"
// (insufficient). Render XSS-safe (sin innerHTML sobre mission-vel-value).
// -----------------------------------------------------------------------------

test('deriveMissionOlaEta expone throughput measured (issues/día) desde el payload', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'fallback',
        totalPct: 25,
        throughputPerDay: 1.4,
        throughputState: 'measured',
    });
    assert.equal(m.throughputPerDay, 1.4);
    assert.equal(m.throughputState, 'measured');
});

test('deriveMissionOlaEta: throughput 0.0 con estado measured es cero legítimo', () => {
    const m = deriveMissionOlaEta({ throughputPerDay: 0, throughputState: 'measured' });
    assert.equal(m.throughputPerDay, 0);
    assert.equal(m.throughputState, 'measured');
});

test('deriveMissionOlaEta: throughput sin dato / no finito → insufficient (nunca measured con null)', () => {
    // Todos estos casos deben resolver a insufficient (sin valor confiable).
    for (const payload of [
        {},                                                    // sin campos
        { throughputState: 'measured' },                       // estado sin valor finito
        { throughputPerDay: NaN, throughputState: 'measured' },// valor no finito
        { throughputPerDay: 2, throughputState: 'insufficient' }, // estado gana: insufficient
        { throughputPerDay: '3', throughputState: 'measured' },// tipo inválido
    ]) {
        const m = deriveMissionOlaEta(payload);
        assert.equal(m.throughputState, 'insufficient');
    }
    // El valor no finito se normaliza a null.
    assert.equal(deriveMissionOlaEta({ throughputPerDay: NaN }).throughputPerDay, null);
    assert.equal(deriveMissionOlaEta({ throughputPerDay: '3' }).throughputPerDay, null);
});

test('el script cliente pinta issues/día (throughput) y la leyenda "sin datos suficientes"', () => {
    const src = missionOlaEtaClientScript();
    assert.ok(src.includes("'issues/día'"));            // unidad de throughput
    assert.ok(src.includes('throughputState'));         // gate por estado
    assert.ok(src.includes('throughputPerDay'));        // valor pintado
    assert.ok(src.includes('sin datos suficientes'));   // leyenda insufficient
});

test('el script cliente NO usa innerHTML para pintar mission-vel-value (R-1 / G-UX-6)', () => {
    const src = missionOlaEtaClientScript();
    // Fuente única XSS-safe: nodo de texto + span de unidad por DOM, nunca una
    // asignación `.innerHTML = ...` (la palabra puede aparecer en comentarios).
    assert.ok(!/\.innerHTML\s*=/.test(src), 'no debe asignar innerHTML');
    assert.ok(src.includes('createTextNode'));
    assert.ok(src.includes('setMzValueUnit'));
});

// -----------------------------------------------------------------------------
// #4450 (AC-5) — verificación estática de fuente única: el ÚNICO writer JS del id
// `mission-vel-value` es el client script de este módulo. Ninguna vista debe
// escribir ese id por su cuenta (evita reintroducir la divergencia de #4296).
// -----------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

test('ninguna vista escribe mission-vel-value por JS (fuente única = mission-ola-eta.js)', () => {
    const viewsDir = path.join(__dirname, '..', '..', 'views', 'dashboard');
    const files = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.js'));
    // Un writer JS toma el nodo por id y lo muta. El markup estático (SSR) que
    // sólo declara `id="mission-vel-value"` y los comentarios NO cuentan.
    const jsWriterRe = /getElementById\(['"]mission-vel-value['"]\)/;
    for (const f of files) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        assert.ok(!jsWriterRe.test(src), `la vista ${f} no debe escribir mission-vel-value por JS`);
    }
});

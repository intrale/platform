#!/usr/bin/env node
// =============================================================================
// Test del ETA por velocidad media de la ola (#4039).
// Ejecutar: node .pipeline/test-wave-velocity-eta.js
//
// Cubre los criterios del PO:
//   CA-1  — el restante DECRECE entre dos lecturas con avancePct creciente.
//   CA-2  — velocidad = (28−21)/23min y restante ≈ 240min con 28% hecho.
//   CA-4  — < 2 snapshots o Δt < 60s → source:'fallback'.
//   CA-5  — convergencia: serie monótona de velocidad estable → la hora meta
//           no retrocede entre lecturas.
//   CA-6  — reset al resembrar: waveKey distinto no consume snapshots de otra ola.
//   CA-14 — velocidad ≤ 0 por rebote → clamp/fallback, sin NaN/Infinity/negativo.
//
// `now` se inyecta en cada lectura para determinismo (sin tocar el reloj real).
// Aislado en un tmp root vía PIPELINE_ROOT_OVERRIDE (lo respetan tanto
// eta-wave.js como wave-progress.js).
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

// Los tests se registran y corren SECUENCIALMENTE: comparten el global
// PIPELINE_ROOT_OVERRIDE, así que no pueden solaparse.
const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function runAll() {
    for (const { name, fn } of _tests) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

// Root temporal aislado. Apunta PIPELINE_ROOT_OVERRIDE acá; el store vive en
// `<root>/.pipeline/wave-progress.jsonl`.
function freshRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-eta-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    process.env.PIPELINE_ROOT_OVERRIDE = root;
    return root;
}

const waveProgress = require('./lib/wave-progress');
const etaWave = require('./lib/eta-wave');

const MIN = 60 * 1000;
const BASE = 1700000000000;  // epoch fijo (sin Date.now → determinístico)

// Helpers de escritura de snapshots.
function seed(root, waveKey, points) {
    for (const [ts, pct] of points) {
        const ok = waveProgress.appendSnapshot({ pipelineRoot: root, waveKey, avancePct: pct, now: ts });
        assert(ok, `seed falló para (${ts}, ${pct})`);
    }
}

async function run() {
    // ── CA-2 — velocidad = (28−21)/23min, restante ≈ 240min ──────────────────
    test('CA-2: velocidad (28−21)/23min y restante ≈ 240min con 28% hecho', async () => {
        const root = freshRoot();
        const t0 = BASE;
        const t1 = BASE + 23 * MIN;
        seed(root, 4, [[t0, 21], [t1, 28]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 28, t1);
        assert(r.source === 'velocity', `esperaba velocity, fue ${r.source} (${r.reason})`);
        // velocidad ≈ 0.304 %/min
        assert(Math.abs(r.velocityPctPerMin - 7 / 23) < 0.01,
            `velocityPctPerMin=${r.velocityPctPerMin} esperaba ~${7 / 23}`);
        const remainMin = r.remainingMs / MIN;
        assert(remainMin > 230 && remainMin < 245, `remainMin=${remainMin} esperaba ~236`);
        assert(r.absoluteMs === t1 + r.remainingMs, 'absoluteMs debe ser now + remaining');
    });

    // ── CA-1 — el restante DECRECE entre dos lecturas ────────────────────────
    test('CA-1: el restante decrece entre dos lecturas con avancePct creciente', async () => {
        const root = freshRoot();
        const tA = BASE + 9 * MIN;
        const tB = BASE + 32 * MIN;
        // Lectura 1 (10:09): existen dos snapshots (10:00,18) y (10:09,21).
        seed(root, 4, [[BASE, 18], [tA, 21]]);
        const r1 = await etaWave.calculateWaveVelocityETA(4, 21, tA);
        assert(r1.source === 'velocity', `r1 esperaba velocity, fue ${r1.source}`);
        // Lectura 2 (10:32): se agrega (10:32,28).
        seed(root, 4, [[tB, 28]]);
        const r2 = await etaWave.calculateWaveVelocityETA(4, 28, tB);
        assert(r2.source === 'velocity', `r2 esperaba velocity, fue ${r2.source}`);
        assert(r2.remainingMs < r1.remainingMs,
            `restante no decreció: r1=${r1.remainingMs / MIN}min r2=${r2.remainingMs / MIN}min`);
    });

    // ── CA-5 — convergencia: hora meta no retrocede con velocidad estable ────
    test('CA-5: convergencia — con velocidad estable la hora meta no retrocede', async () => {
        const root = freshRoot();
        // Velocidad constante de 1%/min: (0,10),(10,20),(20,30).
        const tA = BASE + 10 * MIN;
        const tB = BASE + 20 * MIN;
        seed(root, 4, [[BASE, 10], [tA, 20]]);
        const rA = await etaWave.calculateWaveVelocityETA(4, 20, tA);
        seed(root, 4, [[tB, 30]]);
        const rB = await etaWave.calculateWaveVelocityETA(4, 30, tB);
        assert(rA.source === 'velocity' && rB.source === 'velocity', 'ambas deben ser velocity');
        // La hora meta no debe alejarse (converge). Tolerancia de 1 min por redondeos.
        assert(rB.absoluteMs <= rA.absoluteMs + 1 * MIN,
            `meta retrocedió: A=${rA.absoluteMs} B=${rB.absoluteMs}`);
        // Y el restante baja (avanzamos 10 min, restante baja ~10 min).
        assert(rB.remainingMs < rA.remainingMs, 'el restante debe bajar al avanzar');
    });

    // ── CA-4 — fallback por snapshots insuficientes / Δt chico ───────────────
    test('CA-4: < 2 snapshots → fallback', async () => {
        const root = freshRoot();
        seed(root, 4, [[BASE, 21]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 21, BASE + MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'insufficient-snapshots', `reason=${r.reason}`);
    });

    test('CA-4: Δt < 60s → fallback', async () => {
        const root = freshRoot();
        seed(root, 4, [[BASE, 21], [BASE + 30 * 1000, 28]]);  // 30s < 60s
        const r = await etaWave.calculateWaveVelocityETA(4, 28, BASE + 30 * 1000);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'delta-too-small', `reason=${r.reason}`);
    });

    // ── CA-6 — reset al resembrar: otra ola no consume snapshots ─────────────
    test('CA-6: waveKey distinto (resembrado) no consume snapshots de la ola anterior', async () => {
        const root = freshRoot();
        // Ola 4 con serie completa.
        seed(root, 4, [[BASE, 18], [BASE + 23 * MIN, 28]]);
        // La ola 5 (resembrada) no tiene snapshots propios → fallback.
        const r = await etaWave.calculateWaveVelocityETA(5, 5, BASE + 23 * MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'insufficient-snapshots', `reason=${r.reason}`);
        // La ola 4 sí proyecta por velocidad.
        const r4 = await etaWave.calculateWaveVelocityETA(4, 28, BASE + 23 * MIN);
        assert(r4.source === 'velocity', 'la ola 4 debe seguir proyectando por velocidad');
    });

    // ── CA-14 — velocidad ≤ 0 por rebote → clamp/fallback, sin NaN/Inf/neg ───
    test('CA-14: velocidad ≤ 0 por rebote → fallback, sin NaN/Infinity/negativo', async () => {
        const root = freshRoot();
        // avancePct baja (rebote / /wave add): 30% → 20%.
        seed(root, 4, [[BASE, 30], [BASE + 10 * MIN, 20]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 20, BASE + 10 * MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'non-positive-velocity', `reason=${r.reason}`);
        // No hay remaining/absolute degenerados expuestos.
        assert(r.remainingMs === undefined && r.absoluteMs === undefined, 'fallback no expone proyección');
    });

    test('CA-14: avancePct no finito → fallback', async () => {
        const root = freshRoot();
        seed(root, 4, [[BASE, 18], [BASE + 23 * MIN, 28]]);
        const r = await etaWave.calculateWaveVelocityETA(4, NaN, BASE + 23 * MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
    });

    test('CA-14: waveKey inválido → fallback', async () => {
        freshRoot();
        const r1 = await etaWave.calculateWaveVelocityETA(4.5, 28, BASE);
        const r2 = await etaWave.calculateWaveVelocityETA(0, 28, BASE);
        const r3 = await etaWave.calculateWaveVelocityETA(-1, 28, BASE);
        assert(r1.source === 'fallback' && r2.source === 'fallback' && r3.source === 'fallback',
            'waveKey inválido debe caer a fallback');
    });

    // ── Ola completada (100%) — restante 0, meta = ahora ─────────────────────
    test('avancePct ≥ 100 → restante 0, meta = ahora', async () => {
        const root = freshRoot();
        seed(root, 4, [[BASE, 90], [BASE + 10 * MIN, 100]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 100, BASE + 10 * MIN);
        assert(r.source === 'velocity', `esperaba velocity, fue ${r.source}`);
        assert(r.remainingMs === 0, `remainingMs=${r.remainingMs} esperaba 0`);
        assert(r.absoluteMs === BASE + 10 * MIN, 'meta = ahora');
    });

    // =========================================================================
    // #4734 — ETA por RELOJ DE PARED: ventana temporal + EWMA + reposo proveedor
    // =========================================================================
    const HOUR = 60 * MIN;

    // Helper: función de solapamiento OFF sobre un intervalo absoluto [offStart,
    // offEnd) — inyectada vía `opts.offOverlapFn` para tests deterministas del
    // algoritmo (sin depender del reloj de pared/timezone reales).
    function fixedOffOverlap(offStart, offEnd) {
        return (a, b) => {
            const lo = Math.max(a, offStart);
            const hi = Math.min(b, offEnd);
            return hi > lo ? hi - lo : 0;
        };
    }

    // ── Gherkin 1 — la velocidad se mide sobre las horas EFECTIVAS ────────────
    test('#4734 Gherkin 1: reposo intermedio → velocidad sobre tiempo efectivo, no reloj de pared', async () => {
        const root = freshRoot();
        const t0 = BASE;
        const tNow = BASE + 150 * MIN;          // 2.5 h de reloj de pared
        seed(root, 4, [[t0, 20], [tNow, 25]]);  // +5% en 2.5 h

        // 30 min de reposo dentro de la ventana medida → efectivo = 2.0 h.
        const off = fixedOffOverlap(BASE + 60 * MIN, BASE + 90 * MIN);
        const rConReposo = await etaWave.calculateWaveVelocityETA(4, 25, tNow, { offOverlapFn: off });
        const rSinReposo = await etaWave.calculateWaveVelocityETA(4, 25, tNow, { offOverlapFn: () => 0 });

        assert(rConReposo.source === 'velocity', `con reposo esperaba velocity, fue ${rConReposo.source}`);
        assert(rSinReposo.source === 'velocity', `sin reposo esperaba velocity, fue ${rSinReposo.source}`);
        // Efectivo 120 min: 5% / 120 min = 0.041667 %/min → 2.5 %/h.
        assert(Math.abs(rConReposo.velocityPctPerMin - 5 / 120) < 1e-6,
            `velPctPerMin=${rConReposo.velocityPctPerMin} esperaba ${5 / 120}`);
        assert(Math.abs(rConReposo.velocityPctPerHour - 2.5) < 1e-4,
            `velPctPerHour=${rConReposo.velocityPctPerHour} esperaba 2.5`);
        // NO subestima: con reposo descontado la velocidad es MAYOR que medida
        // sobre las 2.5 h crudas (5/150 = 0.0333 %/min).
        assert(rConReposo.velocityPctPerMin > rSinReposo.velocityPctPerMin,
            'descontar reposo pasado no debe bajar la velocidad medida');
    });

    // ── Gherkin 2 — la proyección SUMA el reposo futuro del horizonte ─────────
    test('#4734 Gherkin 2: reposo futuro dentro del horizonte se suma al ETA', async () => {
        const root = freshRoot();
        const t0 = BASE;
        const tNow = BASE + 120 * MIN;          // ventana de medición sin reposo
        seed(root, 4, [[t0, 50], [tNow, 70]]);  // +20% en 2 h → 10 %/h efectiva

        // Ventana de reposo FUTURA de 2 h, dentro del horizonte de cómputo (3 h).
        const off = fixedOffOverlap(tNow + 30 * MIN, tNow + 150 * MIN);
        const r = await etaWave.calculateWaveVelocityETA(4, 70, tNow, { offOverlapFn: off });

        assert(r.source === 'velocity', `esperaba velocity, fue ${r.source}`);
        assert(Math.abs(r.velocityPctPerHour - 10) < 1e-4,
            `velPctPerHour=${r.velocityPctPerHour} esperaba 10`);
        // 30% restante / 10 %/h = 3 h de cómputo + 2 h de reposo = 5 h.
        assert(Math.abs(r.remainingMs - 5 * HOUR) < MIN,
            `remainingMs=${r.remainingMs / HOUR}h esperaba 5h`);
        assert(Math.abs(r.restOffFutureMs - 2 * HOUR) < MIN,
            `restOffFutureMs=${r.restOffFutureMs / HOUR}h esperaba 2h`);
        // El ETA refleja reloj de pared (compute + reposo), no solo cómputo.
        assert(r.absoluteMs === tNow + r.remainingMs, 'absoluteMs = now + remaining (reloj de pared)');
    });

    // ── Gherkin 3 — sin muestras dentro de la ventana temporal → fallback ─────
    test('#4734 Gherkin 3: muestras fuera de la ventana temporal → estimación insuficiente', async () => {
        const root = freshRoot();
        // Snapshots viejos (hace > 2.5 h). now cae 5 h después → quedan fuera de
        // la ventana móvil → 0 muestras → fallback claro (no ETA absurdo).
        seed(root, 4, [[BASE, 20], [BASE + 30 * MIN, 25]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 25, BASE + 5 * HOUR);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'insufficient-snapshots', `reason=${r.reason}`);
    });

    // ── EWMA — suavizado no salta por un único snapshot nuevo ─────────────────
    test('#4734 EWMA: suaviza el slope, no salta al último tramo', () => {
        const { _ewma, WAVE_VELOCITY_EWMA_ALPHA } = etaWave._internal;
        // Serie estable 0.01 con un tramo final rápido 0.05.
        const v = _ewma([0.01, 0.01, 0.05], WAVE_VELOCITY_EWMA_ALPHA);
        // α=0.5 → 0.5*0.01+0.5*0.01=0.01 ; 0.5*0.05+0.5*0.01=0.03.
        assert(Math.abs(v - 0.03) < 1e-9, `ewma=${v} esperaba 0.03`);
        // No saltó al 0.05 del último tramo (suavizado), pero se movió del 0.01.
        assert(v < 0.05 && v > 0.01, 'EWMA debe quedar entre el estable y el pico');
        // Casos borde.
        assert(_ewma([0.02], WAVE_VELOCITY_EWMA_ALPHA) === 0.02, 'un elemento = ese valor');
        assert(Number.isNaN(_ewma([], WAVE_VELOCITY_EWMA_ALPHA)), 'sin slopes = NaN');
    });

    // ── Integración real con rest-mode-window (delegación de timezone/DST) ────
    test('#4734 integración: _offOverlapMs delega en rest-mode-window (ventana real)', () => {
        const { _offOverlapMs } = etaWave._internal;
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const schedule = {};
        for (const d of days) schedule[d] = [{ start: '00:00', end: '23:59' }];
        const win = { active: true, schedule, timezone: 'America/Argentina/Buenos_Aires' };
        // Ventana OFF 24/7 → un rango de 3 h solapa ~3 h de reposo.
        const off = _offOverlapMs(win, BASE, BASE + 3 * HOUR);
        assert(off > 2.9 * HOUR && off <= 3 * HOUR, `off=${off / HOUR}h esperaba ~3h`);
        // Ventana inactiva / nula → sin descuento.
        assert(_offOverlapMs({ active: false, schedule }, BASE, BASE + HOUR) === 0, 'inactiva → 0');
        assert(_offOverlapMs(null, BASE, BASE + HOUR) === 0, 'null → 0');
        // Rango vacío → 0.
        assert(_offOverlapMs(win, BASE, BASE) === 0, 'rango vacío → 0');
    });

    // ── EWMA con ventana temporal: no salta por un snapshot nuevo en la serie ─
    test('#4734 EWMA end-to-end: un snapshot rápido nuevo no dispara el ETA', async () => {
        const root = freshRoot();
        // Serie estable ~1%/min por 60 min, luego un tramo final más rápido.
        const pts = [
            [BASE, 10],
            [BASE + 20 * MIN, 30],
            [BASE + 40 * MIN, 50],
            [BASE + 60 * MIN, 58],   // tramo final: 8% en 20 min = 0.4 %/min (más lento)
        ];
        seed(root, 4, pts);
        const rEwma = await etaWave.calculateWaveVelocityETA(4, 58, BASE + 60 * MIN, { offOverlapFn: () => 0 });
        // Pendiente global punta-a-punta: (58−10)/60 = 0.8 %/min.
        const globalSlope = (58 - 10) / 60;
        assert(rEwma.source === 'velocity', `esperaba velocity, fue ${rEwma.source}`);
        // El EWMA pondera el último tramo (0.4) → velocidad < global (0.8):
        // demuestra que NO usa la pendiente punta-a-punta.
        assert(rEwma.velocityPctPerMin < globalSlope,
            `EWMA=${rEwma.velocityPctPerMin} debería ser < global ${globalSlope}`);
        assert(rEwma.velocityPctPerMin > 0, 'velocidad positiva');
    });
}

// `run()` solo REGISTRA los tests (sync). `runAll()` los corre en orden.
run();
runAll().then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
});

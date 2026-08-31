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

// #6259 (P2) — `PIPELINE_ROOT_OVERRIDE` es variable COMUN
// (`isSecurityControlVar` -> false), asi que va con `withEnv`.
const { withEnv } = require('./lib/test-helpers/with-env');

// Los tests se registran y corren SECUENCIALMENTE: comparten el global
// PIPELINE_ROOT_OVERRIDE, así que no pueden solaparse.
const _tests = [];

// #6259 (R-1) — cada test corre con `PIPELINE_ROOT_OVERRIDE` apuntando a un root
// temporal PROPIO, y `withEnv` lo restaura al terminar pase lo que pase (antes
// quedaba seteado en el proceso al salir: fuga medida por el probe). El root se
// inyecta como argumento del cuerpo.
//
// El CUERPO COMPLETO va adentro de `withEnv`, asserts incluidos: `eta-wave.js`
// resuelve el override en CADA llamada (`pipelineRoot()`), asi que restaurarlo
// antes de los asserts mandaria las lecturas/escrituras al `.pipeline/` REAL
// del repo. El callback es async y el helper restaura DESPUES del settle, que
// es exactamente lo que hace falta aca.
function test(name, fn) {
    _tests.push({
        name,
        fn: () => {
            const root = freshRoot();
            return withEnv({ PIPELINE_ROOT_OVERRIDE: root }, () => fn(root));
        },
    });
}

async function runAll() {
    for (const { name, fn } of _tests) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

// Root temporal aislado; el store vive en `<root>/.pipeline/wave-progress.jsonl`.
// #6259 — ya NO setea `PIPELINE_ROOT_OVERRIDE`: de eso se ocupa el `withEnv` del
// registrador de tests, que ademas lo restaura al salir.
function freshRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-eta-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
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
    test('CA-2: velocidad (28−21)/23min y restante ≈ 240min con 28% hecho', async (root) => {
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
    test('CA-1: el restante decrece entre dos lecturas con avancePct creciente', async (root) => {
        // #4886 (rev-1) — spans llevados a ≥ WAVE_VELOCITY_MIN_SPAN_MS (15 min).
        // Los 9 min originales quedaban por debajo de la ventana de agregación
        // mínima que ahora exige la métrica (medir %/min sobre una señal
        // cuantizada con menos de 15 min no informa el ritmo real). La propiedad
        // que valida el test — el restante DECRECE — es la misma.
        const tA = BASE + 20 * MIN;
        const tB = BASE + 32 * MIN;
        // Lectura 1 (10:20): existen dos snapshots (10:00,18) y (10:20,21).
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
    test('CA-5: convergencia — con velocidad estable la hora meta no retrocede', async (root) => {
        // Velocidad constante de 1%/min: (0,10),(20,30),(40,50). #4886 (rev-1):
        // pasos de 20 min (≥ ventana de agregación mínima), misma velocidad.
        const tA = BASE + 20 * MIN;
        const tB = BASE + 40 * MIN;
        seed(root, 4, [[BASE, 10], [tA, 30]]);
        const rA = await etaWave.calculateWaveVelocityETA(4, 30, tA);
        seed(root, 4, [[tB, 50]]);
        const rB = await etaWave.calculateWaveVelocityETA(4, 50, tB);
        assert(rA.source === 'velocity' && rB.source === 'velocity', 'ambas deben ser velocity');
        // La hora meta no debe alejarse (converge). Tolerancia de 1 min por redondeos.
        assert(rB.absoluteMs <= rA.absoluteMs + 1 * MIN,
            `meta retrocedió: A=${rA.absoluteMs} B=${rB.absoluteMs}`);
        // Y el restante baja (avanzamos 10 min, restante baja ~10 min).
        assert(rB.remainingMs < rA.remainingMs, 'el restante debe bajar al avanzar');
    });

    // ── CA-4 — fallback por snapshots insuficientes / Δt chico ───────────────
    test('CA-4: < 2 snapshots → fallback', async (root) => {
        seed(root, 4, [[BASE, 21]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 21, BASE + MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'insufficient-snapshots', `reason=${r.reason}`);
    });

    test('CA-4: Δt < 60s → fallback', async (root) => {
        seed(root, 4, [[BASE, 21], [BASE + 30 * 1000, 28]]);  // 30s < 60s
        const r = await etaWave.calculateWaveVelocityETA(4, 28, BASE + 30 * 1000);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'delta-too-small', `reason=${r.reason}`);
    });

    // ── CA-6 — reset al resembrar: otra ola no consume snapshots ─────────────
    test('CA-6: waveKey distinto (resembrado) no consume snapshots de la ola anterior', async (root) => {
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
    test('CA-14: velocidad ≤ 0 por rebote → fallback, sin NaN/Infinity/negativo', async (root) => {
        // avancePct baja (rebote / /wave add): 30% → 20%. #4886 (rev-1): span de
        // 20 min para que el caso evaluado sea la pendiente NEGATIVA y no el
        // recorte previo por ventana de agregación insuficiente.
        seed(root, 4, [[BASE, 30], [BASE + 20 * MIN, 20]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 20, BASE + 20 * MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
        assert(r.reason === 'non-positive-velocity', `reason=${r.reason}`);
        // No hay remaining/absolute degenerados expuestos.
        assert(r.remainingMs === undefined && r.absoluteMs === undefined, 'fallback no expone proyección');
    });

    test('CA-14: avancePct no finito → fallback', async (root) => {
        seed(root, 4, [[BASE, 18], [BASE + 23 * MIN, 28]]);
        const r = await etaWave.calculateWaveVelocityETA(4, NaN, BASE + 23 * MIN);
        assert(r.source === 'fallback', `esperaba fallback, fue ${r.source}`);
    });

    test('CA-14: waveKey inválido → fallback', async () => {
        const r1 = await etaWave.calculateWaveVelocityETA(4.5, 28, BASE);
        const r2 = await etaWave.calculateWaveVelocityETA(0, 28, BASE);
        const r3 = await etaWave.calculateWaveVelocityETA(-1, 28, BASE);
        assert(r1.source === 'fallback' && r2.source === 'fallback' && r3.source === 'fallback',
            'waveKey inválido debe caer a fallback');
    });

    // ── Ola completada (100%) — restante 0, meta = ahora ─────────────────────
    test('avancePct ≥ 100 → restante 0, meta = ahora', async (root) => {
        seed(root, 4, [[BASE, 90], [BASE + 20 * MIN, 100]]);
        const r = await etaWave.calculateWaveVelocityETA(4, 100, BASE + 20 * MIN);
        assert(r.source === 'velocity', `esperaba velocity, fue ${r.source}`);
        assert(r.remainingMs === 0, `remainingMs=${r.remainingMs} esperaba 0`);
        assert(r.absoluteMs === BASE + 20 * MIN, 'meta = ahora');
    });
}

// `run()` solo REGISTRA los tests (sync). `runAll()` los corre en orden.
run();
runAll().then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
});

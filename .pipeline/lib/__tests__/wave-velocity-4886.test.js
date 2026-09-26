// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// wave-velocity-4886.test.js — #4886
//
// La velocidad y el ETA de la ola se mostraban falseados (~308 %/hora sobre una
// ola quieta) porque la serie histórica quedaba contaminada con los SALTOS
// ARTIFICIALES de los resets/restores: cuando el espejo local se re-hidrata, el
// avance salta de 18% a 97% de golpe y esa pendiente gigante —positiva, así que
// pasaba todos los filtros— se registraba como si fuera ritmo real.
//
// Cobertura:
//   1. Techo de plausibilidad al ESCRIBIR: un pico de reset nunca entra al store.
//   2. Higiene retroactiva al LEER y al PODAR: el JSONL ya contaminado deja de
//      envenenar el promedio (y el saneo lo borra del disco).
//   3. EWMA que descarta el tramo discontinuo de re-hidratación (Gherkin 2).
//   4. Degradación HONESTA con la ola quieta: fallback ("sin datos suficientes")
//      en vez del promedio histórico envenenado (Gherkin 1).
//   5. No regresión de #4532: la ola NUEVA sin serie propia sigue heredando la
//      estimación histórica (limpia).
//   6. El banner traduce ese fallback a leyenda explícita + ETA "—" (sin tiempo
//      falso).
//
// node --test .pipeline/lib/__tests__/wave-velocity-4886.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hist = require('../wave-velocity-history');
const etaWave = require('../eta-wave');
const waves = require('../waves');
const { deriveMissionOlaEta, MISSION_INSUFFICIENT_DATA } = require('../mission-ola-eta');
const { withEnv } = require('../test-helpers/with-env');

const MIN = 60 * 1000;

// Pico típico del incidente: el avance saltó ~79 puntos en un tick → decenas de
// % por minuto, dos órdenes de magnitud sobre cualquier ritmo real.
const PICO_DE_RESTORE = 32;

function freshRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4886-'));
    hist._internal._resetCounter();
    return dir;
}

// Escribe una serie de avance de la ola en un root temporal y corre `fn({ dir })`
// con el entorno aislado por el helper sancionado (#6258/#6260), restaurandolo
// despues del settle (soporta `fn` async).
//
// #7082 — aisla AMBOS resolvedores: `wave-progress` lee por
// `PIPELINE_ROOT_OVERRIDE` y `waves.json` por `PIPELINE_DIR_OVERRIDE`
// (`waves.js:pipelineDir()`). Con uno solo, `eta-wave._waveIssueCount()` leia la
// ola de PRODUCCION y el quantum (100/N) cambiaba el veredicto: con la ola 23
// planificada con N=1 el salto de -79/+79 dejaba de ser discontinuo (raiz en
// #7110). Cada llamada crea un `mkdtemp` nuevo: `waves.js` cachea por
// pipelineRoot con TTL de 2 s, y reutilizar `dir` entre tests leeria cache.
function withSeries(waveKey, points, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4886-eta-'));
    fs.mkdirSync(path.join(dir, '.pipeline'), { recursive: true });
    const body = points.map((p) => JSON.stringify({ waveKey, ts: p.ts, avancePct: p.avancePct })).join('\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'wave-progress.jsonl'), body);
    const limpiar = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    let result;
    try {
        result = withEnv(
            { PIPELINE_ROOT_OVERRIDE: dir, PIPELINE_DIR_OVERRIDE: path.join(dir, '.pipeline') },
            () => fn({ dir }),
        );
    } catch (e) {
        limpiar();
        throw e;
    }
    if (result && typeof result.then === 'function') return result.finally(limpiar);
    limpiar();
    return result;
}

// ─── 1. Filtro de plausibilidad AL ESCRIBIR ─────────────────────────────────

test('recordSample descarta el salto artificial de un reset y conserva el ritmo real', () => {
    const root = freshRoot();
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 0.4, now: 1000 }), true);
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: PICO_DE_RESTORE, now: 2000 }), false);

    const samples = hist.readSamples({ pipelineRoot: root });
    assert.equal(samples.length, 1, 'el pico de restore no debe persistirse');
    assert.equal(samples[0].velocityPctPerMin, 0.4);
    // El promedio queda limpio (no arrastra el pico).
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root }), 0.4);
});

test('el techo de plausibilidad es configurable por env (y tolera valores inválidos)', () => {
    // #7082: cada valor bajo el helper sancionado; `undefined` = variable ausente.
    withEnv({ WAVE_VELOCITY_MAX_PCT_PER_MIN: undefined }, () => {
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
    });
    withEnv({ WAVE_VELOCITY_MAX_PCT_PER_MIN: '5' }, () => {
        assert.equal(hist.maxPlausiblePctPerMin(), 5);
        assert.equal(hist.isPlausibleVelocity(4), true);
    });
    // Inválidos → default, nunca romper el pipeline por una env mal seteada.
    withEnv({ WAVE_VELOCITY_MAX_PCT_PER_MIN: 'no-es-numero' }, () => {
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
    });
    withEnv({ WAVE_VELOCITY_MAX_PCT_PER_MIN: '-3' }, () => {
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
    });
});

// ─── 2. Higiene retroactiva del JSONL ya contaminado ────────────────────────

test('el histórico ya contaminado deja de envenenar el promedio al leerlo', () => {
    const root = freshRoot();
    const file = hist._internal.storePath(root);
    fs.writeFileSync(file, [
        '{"ts":1000,"waveKey":1,"velocityPctPerMin":0.4}',
        `{"ts":2000,"waveKey":1,"velocityPctPerMin":${PICO_DE_RESTORE}}`,   // salto de restore
        '{"ts":3000,"waveKey":1,"velocityPctPerMin":0.6}',
        '{"ts":4000,"waveKey":1,"velocityPctPerMin":28.5}',                 // salto de restore
        '',
    ].join('\n'));
    // Sin filtro el promedio daría ~14.9 %/min (≈ 895 %/hora, el número imposible).
    assert.deepEqual(hist.readSamples({ pipelineRoot: root }).map((s) => s.velocityPctPerMin), [0.4, 0.6]);
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root }), 0.5);
});

test('si TODO el histórico es contaminación, no hay estimación (null, no un número imposible)', () => {
    const root = freshRoot();
    fs.writeFileSync(hist._internal.storePath(root), [
        `{"ts":1000,"waveKey":1,"velocityPctPerMin":${PICO_DE_RESTORE}}`,
        '{"ts":2000,"waveKey":1,"velocityPctPerMin":45}',
        '',
    ].join('\n'));
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root }), null);
});

test('pruneStore sanea del disco los picos artificiales heredados', () => {
    const root = freshRoot();
    const file = hist._internal.storePath(root);
    const now = 10_000_000;
    fs.writeFileSync(file, [
        `{"ts":${now - 1000},"waveKey":1,"velocityPctPerMin":0.7}`,
        `{"ts":${now - 900},"waveKey":1,"velocityPctPerMin":${PICO_DE_RESTORE}}`,
        '',
    ].join('\n'));
    const res = hist.pruneStore({ pipelineRoot: root, now });
    assert.equal(res.kept, 1);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(String(PICO_DE_RESTORE)), 'el pico debe desaparecer del archivo');
});

// ─── 3. Gherkin 2 · el salto de re-hidratación no cuenta como ritmo ─────────

test('el salto de re-hidratación (18% → 97%) no se computa como velocidad ni entra al histórico', async () => {
    const now = 10_000_000;
    // Serie real del incidente: la ola venía quieta en 18% y un restore la
    // re-hidrató a 97% de golpe entre dos snapshots consecutivos.
    await withSeries(11, [
        { ts: now - 30 * MIN, avancePct: 18 },
        { ts: now - 20 * MIN, avancePct: 18 },
        { ts: now - 10 * MIN, avancePct: 97 },   // ← salto artificial
        { ts: now, avancePct: 97 },
    ], async ({ dir }) => {
        const r = await etaWave.calculateWaveVelocityETA(11, 97, now, { restWindow: null });
        // Sin el filtro, el tramo del salto daba 7.9 %/min (474 %/hora).
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'discontinuous-jump');
        assert.equal(r.velocityPctPerHour, undefined);
        assert.equal(r.remainingMs, undefined, 'sin velocidad confiable no se emite ETA');
        // Y el salto tampoco quedó persistido en la serie histórica cross-ola.
        assert.deepEqual(hist.readSamples({ pipelineRoot: dir }), []);
    });
});

// ─── 4. Gherkin 1 · ola quieta → degradación honesta, no promedio envenenado ─

test('ola quieta con histórico contaminado degrada honestamente en vez de mostrar el promedio', async () => {
    const now = 20_000_000;
    // Avance plano/negativo (97 → 94 → 92), tal cual el incidente.
    await withSeries(12, [
        { ts: now - 40 * MIN, avancePct: 97 },
        { ts: now - 20 * MIN, avancePct: 94 },
        { ts: now, avancePct: 92 },
    ], async ({ dir }) => {
        // Histórico envenenado por los resets de hoy.
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":${PICO_DE_RESTORE}}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(12, 92, now, { restWindow: null });
        assert.equal(r.source, 'fallback', 'la ola quieta no puede heredar el promedio contaminado');
        assert.equal(r.reason, 'non-positive-velocity');
        assert.equal(r.remainingMs, undefined);
    });
});

test('ola quieta tampoco hereda un histórico LIMPIO: sin ritmo propio no hay velocidad propia', async () => {
    const now = 30_000_000;
    await withSeries(13, [
        { ts: now - 40 * MIN, avancePct: 60 },
        { ts: now - 20 * MIN, avancePct: 60 },
        { ts: now, avancePct: 60 },
    ], async ({ dir }) => {
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":0.8}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(13, 60, now, { restWindow: null });
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'non-positive-velocity');
    });
});

// ─── 5. No regresión #4532 · la ola NUEVA sí hereda la estimación limpia ────

test('#4532 intacto: la ola NUEVA sin serie propia sigue heredando el histórico limpio', async () => {
    const now = 40_000_000;
    await withSeries(99, [], async ({ dir }) => { // ola 14 sin snapshots propios
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":1.0}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(14, 60, now, { restWindow: null });
        assert.equal(r.source, 'historical');
        assert.equal(r.reason, 'insufficient-snapshots');
        assert.equal(r.velocityPctPerMin, 1.0);
        assert.equal(Math.round(r.remainingMs), 40 * MIN); // 40 % restante a 1 %/min
    });
});

test('la velocidad medida real (ritmo plausible) sigue funcionando y se registra', async () => {
    const now = 50_000_000;
    await withSeries(15, [
        { ts: now - 60 * MIN, avancePct: 40 },
        { ts: now - 30 * MIN, avancePct: 43 },
        { ts: now, avancePct: 46 },
    ], async ({ dir }) => {
        const r = await etaWave.calculateWaveVelocityETA(15, 46, now, { restWindow: null });
        assert.equal(r.source, 'velocity');
        assert.ok(Math.abs(r.velocityPctPerHour - 6) < 1e-6, `esperaba 6 %/h, obtuvo ${r.velocityPctPerHour}`);
        // Ritmo plausible → sí entra al histórico cross-ola.
        const samples = hist.readSamples({ pipelineRoot: dir });
        assert.equal(samples.length, 1);
        assert.ok(hist.isPlausibleVelocity(samples[0].velocityPctPerMin));
    });
});

// ─── 7. rev-1 · CADENCIA REAL DE PRODUCCIÓN ────────────────────────────────
//
// Los tests de arriba usan snapshots separados 10–30 min. La cadencia REAL de
// `wave-progress.jsonl` es ~33 s (mediana medida sobre la ola 8: 0,55 min) y
// `avancePct` es ENTERO, así que la señal está CUANTIZADA en saltos de 100/N
// puntos. Sobre esa señal, cualquier criterio de plausibilidad expresado en
// %/min por TRAMO clasifica los cierres reales como saltos artificiales: en la
// ola 8 (N=37) un solo cierre mueve 2,7 puntos en un tick = 4,9 %/min.
//
// Estos tests reproducen esa cadencia para que el fixture no pueda "pasar por
// cadencia irreal" (defecto D3 del rechazo rev-0).

const CADENCIA_REAL_MS = 33 * 1000;   // ~0,55 min, mediana real de la ola 8
const OLA_8_ISSUES = 37;              // quantum = 100/37 = 2,7 puntos

/**
 * Serie con la cadencia real de producción: un snapshot cada ~33 s, y el avance
 * subiendo de a un quantum entero cada `cierreCadaMin`.
 */
function serieCadenciaReal({ now, durationMin, cierreCadaMin, avanceInicial, nIssues }) {
    const quantum = 100 / nIssues;
    const points = [];
    const start = now - durationMin * MIN;
    for (let t = start; t <= now; t += CADENCIA_REAL_MS) {
        const cierres = Math.floor((t - start) / (cierreCadaMin * MIN));
        // avancePct es ENTERO en producción (lo redondea el writer).
        points.push({ ts: t, avancePct: Math.round(avanceInicial + cierres * quantum) });
    }
    return points;
}

test('rev-1 · con la cadencia REAL (~33 s) un cierre cada ~20 min da velocity, no fallback', async () => {
    const now = 60_000_000;
    // Ola de 37 issues cerrando 1 issue cada 20 min durante 3 h.
    const puntos = serieCadenciaReal({
        now, durationMin: 180, cierreCadaMin: 20, avanceInicial: 40, nIssues: OLA_8_ISSUES,
    });
    const ultimo = puntos[puntos.length - 1].avancePct;
    await withSeries(21, puntos, async () => {
        const r = await etaWave.calculateWaveVelocityETA(21, ultimo, now, { restWindow: null });
        // ANTES (rev-0): cada cierre daba 4,9 %/min > techo de 2 → 'discontinuous-jump'
        // y la card quedaba en "sin datos suficientes" el 98 % del tiempo.
        assert.equal(r.source, 'velocity',
            `esperaba velocity con ritmo real, obtuvo ${r.source}/${r.reason}`);
        // Ritmo esperado: 9 cierres × 2,7 puntos en 3 h ≈ 8,1 %/h.
        assert.ok(r.velocityPctPerHour > 5 && r.velocityPctPerHour < 12,
            `ritmo implausible: ${r.velocityPctPerHour} %/h`);
        // Y sigue respetando el techo físico (CA-2).
        assert.ok(r.velocityPctPerMin <= hist.maxPlausiblePctPerMin());
        assert.ok(Number.isFinite(r.remainingMs) && r.remainingMs > 0, 'debe emitir ETA');
    });
});

test('rev-1 · un cierre aislado a cadencia real NO se descarta como salto artificial', async () => {
    const now = 70_000_000;
    // Ola quieta que cierra UN issue (2,7 → 3 puntos enteros) en un solo tick.
    const puntos = [];
    const start = now - 40 * MIN;
    for (let t = start; t <= now; t += CADENCIA_REAL_MS) {
        puntos.push({ ts: t, avancePct: t < now - 20 * MIN ? 50 : 53 });
    }
    await withSeries(22, puntos, async () => {
        const r = await etaWave.calculateWaveVelocityETA(22, 53, now, { restWindow: null });
        // +3 puntos en 0,55 min = 5,4 %/min: rev-0 lo tiraba como artificial.
        assert.equal(r.source, 'velocity',
            `un cierre real no puede ser artificial (${r.source}/${r.reason})`);
        assert.ok(r.velocityPctPerHour > 0);
    });
});

test('rev-1 · el restore sigue siendo artificial aunque la cadencia sea real', async () => {
    const now = 80_000_000;
    // Misma cadencia, pero el espejo se vacía (−79) y se re-hidrata (+79).
    const puntos = [];
    const start = now - 60 * MIN;
    for (let t = start; t <= now; t += CADENCIA_REAL_MS) {
        let v = 97;
        if (t >= now - 40 * MIN && t < now - 20 * MIN) v = 18;   // espejo vacío
        puntos.push({ ts: t, avancePct: v });
    }
    await withSeries(23, puntos, async ({ dir }) => {
        const r = await etaWave.calculateWaveVelocityETA(23, 97, now, { restWindow: null });
        // Los DOS escalones (−79 y +79) se neutralizan → serie plana → sin ritmo.
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'discontinuous-jump');
        assert.equal(r.remainingMs, undefined, 'sin velocidad confiable no se emite ETA');
        assert.deepEqual(hist.readSamples({ pipelineRoot: dir }), []);
    });
});

test('rev-1 · el avance real ANTES y DESPUÉS de un restore sigue siendo medible', async () => {
    const now = 90_000_000;
    // La ola avanza de a 3 puntos cada 20 min; en el medio hay un restore que
    // vacía y re-hidrata el espejo. El ritmo real NO debe perderse.
    const puntos = [];
    const start = now - 120 * MIN;
    for (let t = start; t <= now; t += CADENCIA_REAL_MS) {
        const cierres = Math.floor((t - start) / (20 * MIN));
        let v = 50 + cierres * 3;
        // Restore entre los minutos 60 y 70: el espejo cae a 5 y vuelve.
        if (t >= now - 60 * MIN && t < now - 50 * MIN) v = 5;
        puntos.push({ ts: t, avancePct: v });
    }
    await withSeries(24, puntos, async () => {
        const r = await etaWave.calculateWaveVelocityETA(24, 68, now, { restWindow: null });
        // rev-0 descartaba los tramos del salto y perdía TODO el ritmo del período.
        assert.equal(r.source, 'velocity',
            `el ritmo real debe sobrevivir al restore (${r.source}/${r.reason})`);
        // 6 cierres × 3 puntos en 2 h = 9 %/h.
        assert.ok(r.velocityPctPerHour > 6 && r.velocityPctPerHour < 12,
            `ritmo esperado ~9 %/h, obtuvo ${r.velocityPctPerHour}`);
    });
});

test('rev-1 · el umbral de discontinuidad se expresa en QUANTUMS de la ola', () => {
    const { _jumpThresholdPct, _repairDiscontinuities, WAVE_MAX_STEP_ISSUES } = etaWave._internal;
    // Sin waves.json resoluble cae al umbral absoluto histórico.
    assert.equal(_jumpThresholdPct(999), etaWave._internal._maxStepPct());

    // Con quantum de la ola 8 (2,7 puntos), el umbral son 4 cierres = 10,8 puntos:
    const umbralOla8 = (100 / OLA_8_ISSUES) * WAVE_MAX_STEP_ISSUES;
    assert.ok(umbralOla8 > 10 && umbralOla8 < 11, `umbral ${umbralOla8}`);

    // Los deltas REALES observados en la ola 8 quedan de cada lado del umbral:
    // +3/+4/+7/+8 son 1–3 cierres (se conservan); +18 y +79 son re-hidratación.
    const serie = [0, 3, 7, 15, 23, 41, 120].map((v, i) => ({ ts: i * 33_000, avancePct: v }));
    const { series, discardedJumps } = _repairDiscontinuities(serie, umbralOla8);
    assert.equal(discardedJumps, 2, '+18 y +79 son los únicos artificiales');
    // El avance REAL acumulado (3+4+8+8 = 23) sobrevive intacto.
    assert.equal(series[series.length - 1].avancePct - series[0].avancePct, 23);
});

test('rev-2 · waves.json activa el quantum y el camino público descarta +18', async () => {
    const now = 95_000_000;
    // PIPELINE_DIR_OVERRIDE ya lo setea withSeries (#7082): el waves.json del
    // fixture se escribe adentro del recinto y se invalida el cache alrededor.
    await withSeries(8, [
        { ts: now - 40 * MIN, avancePct: 18 },
        { ts: now - 20 * MIN, avancePct: 36 }, // re-hidratación: +18
        { ts: now, avancePct: 36 },
    ], async ({ dir }) => {
        fs.writeFileSync(path.join(dir, '.pipeline', 'waves.json'), JSON.stringify({
            version: 1,
            active_wave: {
                number: 8,
                name: 'Fixture ola 8',
                issues: Array.from({ length: OLA_8_ISSUES }, (_, i) => ({ number: 1000 + i })),
            },
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        }));
        waves.invalidateCache();
        try {
            assert.equal(etaWave._internal._waveIssueCount(8), 37);
            const threshold = etaWave._internal._jumpThresholdPct(8);
            assert.ok(Math.abs(threshold - (400 / 37)) < 1e-12, `umbral ${threshold}`);

            const result = await etaWave.calculateWaveVelocityETA(8, 36, now, { restWindow: null });
            assert.equal(result.source, 'fallback');
            assert.equal(result.reason, 'discontinuous-jump');
            assert.equal(result.velocityPctPerHour, undefined);
            assert.equal(result.remainingMs, undefined);
            assert.deepEqual(hist.readSamples({ pipelineRoot: dir }), []);
        } finally {
            waves.invalidateCache();
        }
    });
});

test('rev-1 · el filtro de discontinuidad es SIMÉTRICO (la caída del espejo también)', () => {
    const { _repairDiscontinuities } = etaWave._internal;
    // Serie real: el restore vacía el espejo (−94 puntos en 0,43 min) y luego
    // re-hidrata. rev-0 sólo miraba `segDelta > umbral`, así que la CAÍDA entraba
    // al cálculo y se reportaba como 'non-positive-velocity'.
    const serie = [
        { ts: 0, avancePct: 97 },
        { ts: 26_000, avancePct: 3 },     // −94 artificial
        { ts: 60_000, avancePct: 6 },     // +3 real
        { ts: 90_000, avancePct: 100 },   // +94 artificial
    ];
    const { series, discardedJumps } = _repairDiscontinuities(serie, 25);
    assert.equal(discardedJumps, 2, 'la caída y la subida son ambas artificiales');
    // Neto real = +3, no −94 ni +94.
    assert.equal(series[series.length - 1].avancePct - series[0].avancePct, 3);
});

// ─── 6. El banner traduce el fallback a leyenda + ETA "—" ───────────────────

test('el banner muestra leyenda explícita y ETA vacío cuando no hay ritmo confiable', () => {
    const m = deriveMissionOlaEta({ totalPct: 92, etaSource: 'fallback', velocityETA: null });
    assert.equal(m.avancePct, 92, 'el avance % sigue siendo el valor sano');
    assert.equal(m.velocityPctPerHour, null);
    assert.equal(m.velocityState, MISSION_INSUFFICIENT_DATA);
    assert.equal(m.velocitySource, 'insufficient');
    assert.equal(m.etaRemainingMin, null, 'sin velocidad confiable, no se muestra un ETA falso');
    assert.equal(m.etaFromVelocity, false);
});

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
const { deriveMissionOlaEta, MISSION_INSUFFICIENT_DATA } = require('../mission-ola-eta');

const MIN = 60 * 1000;

// Pico típico del incidente: el avance saltó ~79 puntos en un tick → decenas de
// % por minuto, dos órdenes de magnitud sobre cualquier ritmo real.
const PICO_DE_RESTORE = 32;

function freshRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4886-'));
    hist._internal._resetCounter();
    return dir;
}

// Escribe una serie de avance de la ola bajo un PIPELINE_ROOT_OVERRIDE temporal
// (mismo patrón que eta-wave-4734.test.js) y devuelve el root + un restore().
function withSeries(waveKey, points) {
    const prev = process.env.PIPELINE_ROOT_OVERRIDE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4886-eta-'));
    process.env.PIPELINE_ROOT_OVERRIDE = dir;
    fs.mkdirSync(path.join(dir, '.pipeline'), { recursive: true });
    const body = points.map((p) => JSON.stringify({ waveKey, ts: p.ts, avancePct: p.avancePct })).join('\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'wave-progress.jsonl'), body);
    return {
        dir,
        restore: () => {
            if (prev === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
            else process.env.PIPELINE_ROOT_OVERRIDE = prev;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
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
    const prev = process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN;
    try {
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
        process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN = '5';
        assert.equal(hist.maxPlausiblePctPerMin(), 5);
        assert.equal(hist.isPlausibleVelocity(4), true);
        // Inválidos → default, nunca romper el pipeline por una env mal seteada.
        process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN = 'no-es-numero';
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
        process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN = '-3';
        assert.equal(hist.maxPlausiblePctPerMin(), hist.MAX_PLAUSIBLE_PCT_PER_MIN);
    } finally {
        if (prev === undefined) delete process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN;
        else process.env.WAVE_VELOCITY_MAX_PCT_PER_MIN = prev;
    }
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
    const { dir, restore } = withSeries(11, [
        { ts: now - 30 * MIN, avancePct: 18 },
        { ts: now - 20 * MIN, avancePct: 18 },
        { ts: now - 10 * MIN, avancePct: 97 },   // ← salto artificial
        { ts: now, avancePct: 97 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(11, 97, now, { restWindow: null });
        // Sin el filtro, el tramo del salto daba 7.9 %/min (474 %/hora).
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'discontinuous-jump');
        assert.equal(r.velocityPctPerHour, undefined);
        assert.equal(r.remainingMs, undefined, 'sin velocidad confiable no se emite ETA');
        // Y el salto tampoco quedó persistido en la serie histórica cross-ola.
        assert.deepEqual(hist.readSamples({ pipelineRoot: dir }), []);
    } finally {
        restore();
    }
});

// ─── 4. Gherkin 1 · ola quieta → degradación honesta, no promedio envenenado ─

test('ola quieta con histórico contaminado degrada honestamente en vez de mostrar el promedio', async () => {
    const now = 20_000_000;
    // Avance plano/negativo (97 → 94 → 92), tal cual el incidente.
    const { dir, restore } = withSeries(12, [
        { ts: now - 40 * MIN, avancePct: 97 },
        { ts: now - 20 * MIN, avancePct: 94 },
        { ts: now, avancePct: 92 },
    ]);
    try {
        // Histórico envenenado por los resets de hoy.
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":${PICO_DE_RESTORE}}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(12, 92, now, { restWindow: null });
        assert.equal(r.source, 'fallback', 'la ola quieta no puede heredar el promedio contaminado');
        assert.equal(r.reason, 'non-positive-velocity');
        assert.equal(r.remainingMs, undefined);
    } finally {
        restore();
    }
});

test('ola quieta tampoco hereda un histórico LIMPIO: sin ritmo propio no hay velocidad propia', async () => {
    const now = 30_000_000;
    const { dir, restore } = withSeries(13, [
        { ts: now - 40 * MIN, avancePct: 60 },
        { ts: now - 20 * MIN, avancePct: 60 },
        { ts: now, avancePct: 60 },
    ]);
    try {
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":0.8}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(13, 60, now, { restWindow: null });
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'non-positive-velocity');
    } finally {
        restore();
    }
});

// ─── 5. No regresión #4532 · la ola NUEVA sí hereda la estimación limpia ────

test('#4532 intacto: la ola NUEVA sin serie propia sigue heredando el histórico limpio', async () => {
    const now = 40_000_000;
    const { dir, restore } = withSeries(99, []); // ola 14 sin snapshots propios
    try {
        fs.writeFileSync(hist._internal.storePath(dir), [
            `{"ts":${now - 100000},"waveKey":9,"velocityPctPerMin":1.0}`,
            '',
        ].join('\n'));
        const r = await etaWave.calculateWaveVelocityETA(14, 60, now, { restWindow: null });
        assert.equal(r.source, 'historical');
        assert.equal(r.reason, 'insufficient-snapshots');
        assert.equal(r.velocityPctPerMin, 1.0);
        assert.equal(Math.round(r.remainingMs), 40 * MIN); // 40 % restante a 1 %/min
    } finally {
        restore();
    }
});

test('la velocidad medida real (ritmo plausible) sigue funcionando y se registra', async () => {
    const now = 50_000_000;
    const { dir, restore } = withSeries(15, [
        { ts: now - 60 * MIN, avancePct: 40 },
        { ts: now - 30 * MIN, avancePct: 43 },
        { ts: now, avancePct: 46 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(15, 46, now, { restWindow: null });
        assert.equal(r.source, 'velocity');
        assert.ok(Math.abs(r.velocityPctPerHour - 6) < 1e-6, `esperaba 6 %/h, obtuvo ${r.velocityPctPerHour}`);
        // Ritmo plausible → sí entra al histórico cross-ola.
        const samples = hist.readSamples({ pipelineRoot: dir });
        assert.equal(samples.length, 1);
        assert.ok(hist.isPlausibleVelocity(samples[0].velocityPctPerMin));
    } finally {
        restore();
    }
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

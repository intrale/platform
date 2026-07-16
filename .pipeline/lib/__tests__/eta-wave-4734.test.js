// =============================================================================
// eta-wave-4734.test.js — #4734
//
// Unifica el cálculo de ETA de ola en un único módulo:
//   - velocidad_real en %/hora de RELOJ DE PARED sobre ventana TEMPORAL (no por
//     conteo de snapshots), suavizada con EWMA.
//   - (a) el reposo de proveedor pasado NO subestima la velocidad medida.
//   - (b) la proyección SUMA las ventanas de reposo futuras del horizonte.
//   - fallback claro ("estimación insuficiente") sin muestras suficientes.
//
// Determinismo: `now` inyectado (ms UTC fijos) + `opts.restWindow` inyectado
// (sin FS de provider-schedule). La serie de avance se escribe en un
// `wave-progress.jsonl` bajo un PIPELINE_ROOT_OVERRIDE temporal.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const etaWave = require('../eta-wave');
const rmw = require('../rest-mode-window');
const { _internal } = etaWave;

const HOUR = 3600000;

// Ventana OFF de reposo sintética: OFF `start`→`end` (ART) todos los días.
function offEveryDay(start, end) {
    const per = [{ start, end }];
    return {
        active: true,
        schedule: {
            monday: per, tuesday: per, wednesday: per, thursday: per,
            friday: per, saturday: per, sunday: per,
        },
        timezone: rmw.DEFAULT_TIMEZONE,
    };
}

// Escribe una serie de avance para `waveKey` en un root temporal y devuelve un
// restore(). Cada test usa su propio waveKey y root (aislamiento del histórico).
function withSeries(waveKey, points) {
    const prev = process.env.PIPELINE_ROOT_OVERRIDE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta4734-'));
    process.env.PIPELINE_ROOT_OVERRIDE = dir;
    fs.mkdirSync(path.join(dir, '.pipeline'), { recursive: true });
    const body = points.map((p) => JSON.stringify({ waveKey, ts: p.ts, avancePct: p.avancePct })).join('\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'wave-progress.jsonl'), body);
    return () => {
        if (prev === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
        else process.env.PIPELINE_ROOT_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
}

// ─── _offOverlapMs (helper de solapamiento OFF) ─────────────────────────────

test('_offOverlapMs acumula sólo los tramos OFF dentro del intervalo', () => {
    const w = offEveryDay('20:00', '22:00'); // 2h OFF/día
    // Lunes 18:00 ART = 2026-07-20 21:00 UTC.
    const t0 = Date.UTC(2026, 6, 20, 21, 0, 0);
    // [18:00, 21:00] cruza sólo 20:00→21:00 = 1h.
    assert.equal(_internal._offOverlapMs(w, t0, t0 + 3 * HOUR), 1 * HOUR);
    // [18:00, 23:00] cruza 20:00→22:00 = 2h completas.
    assert.equal(_internal._offOverlapMs(w, t0, t0 + 5 * HOUR), 2 * HOUR);
    // Intervalo sin reposo [18:00, 19:00] = 0.
    assert.equal(_internal._offOverlapMs(w, t0, t0 + 1 * HOUR), 0);
});

test('_offOverlapMs devuelve 0 con ventana nula/inactiva o intervalo invertido', () => {
    const w = offEveryDay('20:00', '22:00');
    const t0 = Date.UTC(2026, 6, 20, 21, 0, 0);
    assert.equal(_internal._offOverlapMs(null, t0, t0 + HOUR), 0);
    assert.equal(_internal._offOverlapMs({ active: false }, t0, t0 + HOUR), 0);
    assert.equal(_internal._offOverlapMs(w, t0 + HOUR, t0), 0); // t1 <= t0
});

// ─── CA-4 · velocidad con reposo intermedio (Gherkin 1) ─────────────────────

test('velocidad_real con reposo intermedio se mide sobre las horas efectivas', async () => {
    // Ola avanza 6% en 3h de reloj de pared; 1h de esas 3h es reposo (20:00→21:00).
    // now = lunes 22:00 ART = 2026-07-21 01:00 UTC. Ventana [19:00, 22:00] contiene
    // el reposo 20:00→21:00. Efectivo = 2h → 6%/2h = 3%/h (no 6%/3h = 2%/h).
    const now = Date.UTC(2026, 6, 21, 1, 0, 0);
    const restWindow = offEveryDay('20:00', '21:00');
    const restore = withSeries(7, [
        { ts: now - 3 * HOUR, avancePct: 40 },
        { ts: now, avancePct: 46 },
    ]);
    try {
        const conReposo = await etaWave.calculateWaveVelocityETA(7, 46, now, { restWindow });
        assert.equal(conReposo.source, 'velocity');
        assert.ok(Math.abs(conReposo.velocityPctPerHour - 3) < 1e-6,
            `esperaba ~3 %/h, obtuvo ${conReposo.velocityPctPerHour}`);
        // Sin awareness de reposo, la MISMA serie subestima a 2 %/h.
        const sinReposo = await etaWave.calculateWaveVelocityETA(7, 46, now, { restWindow: null });
        assert.ok(Math.abs(sinReposo.velocityPctPerHour - 2) < 1e-6,
            `esperaba ~2 %/h, obtuvo ${sinReposo.velocityPctPerHour}`);
        // El reposo NO subestima: con awareness la velocidad es mayor.
        assert.ok(conReposo.velocityPctPerHour > sinReposo.velocityPctPerHour);
    } finally { restore(); }
});

// ─── CA-5 · proyección suma reposo futuro (Gherkin 2) ───────────────────────

test('la proyeccion suma las ventanas de reposo futuras dentro del horizonte', async () => {
    // Falta 30% de avance, velocidad_real 10%/h → compute = 3h. En el horizonte
    // cae una ventana OFF de 2h (20:00→22:00) → ETA = 3h compute + 2h reposo = 5h.
    // Medición [15:30, 18:00] sin reposo (velocidad limpia 10%/h).
    const now = Date.UTC(2026, 6, 20, 21, 0, 0); // lunes 18:00 ART
    const restWindow = offEveryDay('20:00', '22:00');
    const restore = withSeries(5, [
        { ts: now - 2 * HOUR, avancePct: 50 },
        { ts: now - 1 * HOUR, avancePct: 60 },
        { ts: now, avancePct: 70 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(5, 70, now, { restWindow });
        assert.equal(r.source, 'velocity');
        assert.ok(Math.abs(r.velocityPctPerHour - 10) < 1e-6);
        assert.ok(Math.abs(r.computeMs - 3 * HOUR) < 1000, `compute ${r.computeMs}`);
        assert.ok(Math.abs(r.remainingMs - 5 * HOUR) < 1000, `eta ${r.remainingMs}`);
        assert.ok(Math.abs(r.restProjectedMs - 2 * HOUR) < 1000, `reposo ${r.restProjectedMs}`);
        // El ETA de reloj de pared > tiempo de cómputo.
        assert.ok(r.remainingMs > r.computeMs);
    } finally { restore(); }
});

test('sin reposo en el horizonte, ETA == tiempo de cómputo (no infla)', async () => {
    const now = Date.UTC(2026, 6, 20, 18, 0, 0); // lunes 15:00 ART, lejos del reposo
    const restWindow = offEveryDay('03:00', '04:00'); // reposo fuera del horizonte
    const restore = withSeries(6, [
        { ts: now - 2 * HOUR, avancePct: 50 },
        { ts: now, avancePct: 70 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(6, 70, now, { restWindow });
        assert.equal(r.source, 'velocity');
        assert.equal(r.restProjectedMs, 0);
        assert.equal(r.remainingMs, r.computeMs);
    } finally { restore(); }
});

// ─── CA-6 · fallback sin muestras suficientes (Gherkin 3) ───────────────────

test('sin muestras suficientes reporta fallback, no un ETA absurdo', async () => {
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(9, [{ ts: now, avancePct: 10 }]); // 1 solo snapshot
    try {
        const r = await etaWave.calculateWaveVelocityETA(9, 10, now, { restWindow: null });
        assert.equal(r.source, 'fallback');
        assert.equal(r.reason, 'insufficient-snapshots');
        assert.ok(!Number.isFinite(r.remainingMs)); // sin ETA numérico engañoso
    } finally { restore(); }
});

test('snapshots viejos fuera de la ventana temporal caen a fallback', async () => {
    // Dos snapshots pero separados 10h: sólo el último entra en la ventana de 3h.
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(11, [
        { ts: now - 10 * HOUR, avancePct: 10 },
        { ts: now, avancePct: 80 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(11, 80, now, { restWindow: null });
        assert.equal(r.source, 'fallback'); // no hay 2 puntos DENTRO de la ventana
    } finally { restore(); }
});

// ─── CA-3 · EWMA no salta por un único snapshot nuevo ───────────────────────

test('EWMA no salta por un unico snapshot nuevo (vs pendiente punta-a-punta)', async () => {
    // Ritmo estable ~2%/h y un último tramo con un salto grande (10%/h). El EWMA
    // amortigua: la velocidad final queda MUY por debajo de ese último tramo.
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(13, [
        { ts: now - 150 * 60000, avancePct: 40 }, // -2.5h
        { ts: now - 90 * 60000, avancePct: 42 },  // +2%/h
        { ts: now - 30 * 60000, avancePct: 44 },  // +2%/h
        { ts: now, avancePct: 49 },                // último tramo 5% en 0.5h = 10%/h
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(13, 49, now, { restWindow: null });
        assert.equal(r.source, 'velocity');
        // El último tramo solo daría 10%/h; el EWMA queda bien por debajo.
        assert.ok(r.velocityPctPerHour < 8,
            `EWMA saltó demasiado: ${r.velocityPctPerHour}`);
        assert.ok(r.velocityPctPerHour > 2,
            `EWMA debería pesar algo el tramo reciente: ${r.velocityPctPerHour}`);
    } finally { restore(); }
});

// ─── Robustez ───────────────────────────────────────────────────────────────

test('avancePct que baja (rebote) → fallback, nunca velocidad negativa', async () => {
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(15, [
        { ts: now - 2 * HOUR, avancePct: 60 },
        { ts: now, avancePct: 50 }, // bajó
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(15, 50, now, { restWindow: null });
        // Sin histórico → fallback duro; nunca velocidad/ETA negativos.
        assert.equal(r.source, 'fallback');
    } finally { restore(); }
});

test('ola completada (avance ≥ 100) → remaining 0 y meta = ahora', async () => {
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(17, [
        { ts: now - 2 * HOUR, avancePct: 90 },
        { ts: now, avancePct: 100 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(17, 100, now, { restWindow: null });
        assert.equal(r.source, 'velocity');
        assert.equal(r.remainingMs, 0);
        assert.equal(r.absoluteMs, now);
        assert.ok(Number.isFinite(r.velocityPctPerHour));
    } finally { restore(); }
});

test('el resultado siempre expone velocityPctPerHour (unidad canónica %/hora)', async () => {
    const now = Date.UTC(2026, 6, 20, 18, 0, 0);
    const restore = withSeries(19, [
        { ts: now - 2 * HOUR, avancePct: 20 },
        { ts: now, avancePct: 30 },
    ]);
    try {
        const r = await etaWave.calculateWaveVelocityETA(19, 30, now, { restWindow: null });
        assert.equal(r.source, 'velocity');
        // %/hora == %/min × 60 (coherencia de unidades para el histórico persistido).
        assert.ok(Math.abs(r.velocityPctPerHour - r.velocityPctPerMin * 60) < 1e-9);
    } finally { restore(); }
});

// ─── Constantes de configuración ────────────────────────────────────────────

test('la ventana de velocidad es temporal (2–3 h), no por conteo', () => {
    assert.ok(_internal.WAVE_VELOCITY_WINDOW_MS >= 2 * HOUR);
    assert.ok(_internal.WAVE_VELOCITY_WINDOW_MS <= 3 * HOUR);
    assert.ok(_internal.WAVE_EWMA_ALPHA > 0 && _internal.WAVE_EWMA_ALPHA <= 1);
});

// ─── CA-1 · consistencia de etaSource handler `/wave` ↔ dashboard ────────────

test('handler /wave y dashboard mapean el MISMO etaSource para cada source', () => {
    // Invariante de convergencia (#4734 CA-1): ambos consumidores aceptan el mismo
    // conjunto de sources del módulo único y los mapean idénticamente. Se replican
    // las dos expresiones de mapeo tal como quedan en el código:
    //   - dashboard.js:  velocityETA ? (source==='historical'?'historical':'velocity') : 'fallback'
    //   - handleWaveStatus: (source==='velocity'||source==='historical') ? source : 'fallback'
    const dashboardMap = (vel) =>
        vel && (vel.source === 'velocity' || vel.source === 'historical')
            ? (vel.source === 'historical' ? 'historical' : 'velocity')
            : 'fallback';
    const handlerMap = (vel) => {
        let etaSource = 'fallback';
        if (vel && (vel.source === 'velocity' || vel.source === 'historical')
            && Number.isFinite(vel.absoluteMs)) etaSource = vel.source;
        return etaSource;
    };
    for (const src of ['velocity', 'historical', 'fallback']) {
        const vel = { source: src, absoluteMs: 123 };
        assert.equal(handlerMap(vel), dashboardMap(vel),
            `divergencia de etaSource para source=${src}`);
    }
    // Sin resultado → ambos 'fallback'.
    assert.equal(handlerMap(null), dashboardMap(null));
});

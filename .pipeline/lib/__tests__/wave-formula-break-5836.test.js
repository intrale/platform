// =============================================================================
// wave-formula-break-5836.test.js — #5836 (rev-1)
//
// Regresión del rebote de `aprobacion`: el corte de serie (`formulaV`) se
// persistía pero NINGÚN consumidor de la serie lo honraba. La ventana de
// velocidad mezclaba puntos v1 (conteo plano) con v2 (ponderado por size) y
// medía el escalón del cambio de fórmula como avance REAL — fabricando
// velocidad sobre una ola quieta y persistiéndola en el histórico cross-ola,
// donde sobrevive a la ventana de 3 h y contamina el fallback `historical` de
// las olas siguientes (misma clase de incidente que #4886).
//
// Cubre:
//   - _truncateAtFormulaChange: deja sólo el tramo final homogéneo.
//   - _streamWaveProgress: propaga `formulaV` (ausencia → v1).
//   - calculateWaveVelocityETA: serie mixta v1→v2 SIN avance real ⇒ NO mide
//     velocidad NI persiste muestra en el histórico.
//   - appendSnapshotWithDelta: compara contra un punto con antigüedad
//     suficiente, así la nota de CA-5 es alcanzable con cadencia de ~33 s.
//
// Determinismo: `now` inyectado + PIPELINE_ROOT_OVERRIDE temporal por test.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const etaWave = require('../eta-wave');
const waveProgress = require('../wave-progress');
const { _internal } = etaWave;

const HOUR = 3600000;
const MIN = 60000;

// Serie sintética en un root temporal. `points` acepta `formulaV` opcional:
// omitirlo reproduce EXACTAMENTE los ~5000 registros ya escritos en la serie
// viva, que no traen el campo.
function withSeries(waveKey, points) {
    const prevRoot = process.env.PIPELINE_ROOT_OVERRIDE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf5836-'));
    process.env.PIPELINE_ROOT_OVERRIDE = dir;
    fs.mkdirSync(path.join(dir, '.pipeline'), { recursive: true });
    const body = points.map((p) => {
        const rec = { waveKey, ts: p.ts, avancePct: p.avancePct };
        if (p.formulaV !== undefined) rec.formulaV = p.formulaV;
        if (p.totalWeight !== undefined) rec.totalWeight = p.totalWeight;
        if (p.issueCount !== undefined) rec.issueCount = p.issueCount;
        return JSON.stringify(rec);
    }).join('\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'wave-progress.jsonl'), body);
    return {
        dir,
        // El histórico cross-ola vive en la RAÍZ del root override.
        velocityHistory() {
            const f = path.join(dir, 'wave-velocity-history.jsonl');
            if (!fs.existsSync(f)) return [];
            return fs.readFileSync(f, 'utf8').trim().split('\n')
                .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
        },
        restore() {
            if (prevRoot === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
            else process.env.PIPELINE_ROOT_OVERRIDE = prevRoot;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
}

// ─── _truncateAtFormulaChange ───────────────────────────────────────────────

test('_truncateAtFormulaChange deja solo el tramo final homogeneo', () => {
    const s = [
        { ts: 1, avancePct: 48, formulaV: 1 },
        { ts: 2, avancePct: 48, formulaV: 1 },
        { ts: 3, avancePct: 52, formulaV: 2 },
        { ts: 4, avancePct: 52, formulaV: 2 },
    ];
    const r = _internal._truncateAtFormulaChange(s);
    assert.equal(r.series.length, 2);
    assert.equal(r.droppedByFormulaChange, 2);
    assert.ok(r.series.every((p) => p.formulaV === 2));
});

test('_truncateAtFormulaChange trata la ausencia de formulaV como v1', () => {
    // Los registros viejos NO traen el campo: no deben mezclarse con los v2.
    const s = [
        { ts: 1, avancePct: 48 },
        { ts: 2, avancePct: 52, formulaV: 2 },
    ];
    const r = _internal._truncateAtFormulaChange(s);
    assert.equal(r.series.length, 1);
    assert.equal(r.droppedByFormulaChange, 1);
});

test('_truncateAtFormulaChange no recorta una serie homogenea ni rompe con vacio', () => {
    const homo = [
        { ts: 1, avancePct: 40, formulaV: 2 },
        { ts: 2, avancePct: 41, formulaV: 2 },
        { ts: 3, avancePct: 42, formulaV: 2 },
    ];
    const r = _internal._truncateAtFormulaChange(homo);
    assert.equal(r.series.length, 3);
    assert.equal(r.droppedByFormulaChange, 0);

    const vacio = _internal._truncateAtFormulaChange([]);
    assert.deepEqual(vacio.series, []);
    assert.equal(vacio.droppedByFormulaChange, 0);
    assert.deepEqual(_internal._truncateAtFormulaChange(null).series, []);
});

// ─── _streamWaveProgress propaga formulaV ───────────────────────────────────

test('_streamWaveProgress propaga formulaV y normaliza la ausencia a v1', async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const h = withSeries(41, [
        { ts: now - HOUR, avancePct: 48 },                  // sin campo → v1
        { ts: now, avancePct: 52, formulaV: 2 },
    ]);
    try {
        const got = await _internal._streamWaveProgress(41);
        assert.equal(got.length, 2);
        assert.equal(got[0].formulaV, waveProgress.LEGACY_FORMULA_VERSION);
        assert.equal(got[1].formulaV, 2);
    } finally { h.restore(); }
});

// ─── BLOQUEANTE: la ventana no cruza el corte de serie ──────────────────────

test('serie mixta v1->v2 sin avance real NO mide velocidad ni persiste muestra', async () => {
    // Reproduce el escenario del rechazo: 1 h de serie, avance REAL 0 pp, y el
    // único cambio es la fórmula (48 % plano → 52 % ponderado). Antes del fix
    // esos ~4 pp de re-expresión se medían como ritmo (≈3 pp/h → ETA 16 h).
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    // 30 min de puntos v1 planos en 48 (sin campo, como la serie viva).
    for (let t = now - HOUR; t < now - 30 * MIN; t += MIN) {
        points.push({ ts: t, avancePct: 48 });
    }
    // 30 min de puntos v2 planos en 52: la ola NO se movió, sólo cambió la unidad.
    for (let t = now - 30 * MIN; t <= now; t += MIN) {
        points.push({ ts: t, avancePct: 52, formulaV: 2 });
    }
    const h = withSeries(42, points);
    try {
        const res = await etaWave.calculateWaveVelocityETA(42, 52, now, { restWindow: null });
        // El tramo v2 es plano ⇒ pendiente 0 ⇒ degradación honesta, NO 'velocity'.
        assert.notEqual(res.source, 'velocity',
            `no debe medir velocidad sobre un corte de serie (obtuvo ${JSON.stringify(res)})`);
        // Y NO se contamina el histórico cross-ola (raíz de #4886).
        assert.deepEqual(h.velocityHistory(), [],
            'no debe persistir muestra de velocidad fabricada por el cambio de formula');
    } finally { h.restore(); }
});

test('el tramo v2 corto degrada con reason formula-change, no como ola nueva', async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    for (let t = now - HOUR; t < now; t += MIN) points.push({ ts: t, avancePct: 48 });
    points.push({ ts: now, avancePct: 52, formulaV: 2 });   // único punto v2
    const h = withSeries(43, points);
    try {
        const res = await etaWave.calculateWaveVelocityETA(43, 52, now, { restWindow: null });
        assert.notEqual(res.source, 'velocity');
        assert.equal(res.reason, 'formula-change');
        assert.deepEqual(h.velocityHistory(), []);
    } finally { h.restore(); }
});

test('el avance REAL dentro del tramo v2 se sigue midiendo', async () => {
    // El fix no puede volver ciega a la ola: pasado el corte, el ritmo se mide.
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    for (let t = now - 3 * HOUR; t < now - 2 * HOUR; t += MIN) {
        points.push({ ts: t, avancePct: 48 });               // v1 viejo
    }
    // 2 h de tramo v2 con avance real de 50 → 56 (3 pp/h).
    for (let i = 0; i <= 120; i++) {
        points.push({ ts: now - 2 * HOUR + i * MIN, avancePct: 50 + (6 * i) / 120, formulaV: 2 });
    }
    const h = withSeries(44, points);
    try {
        const res = await etaWave.calculateWaveVelocityETA(44, 56, now, { restWindow: null });
        assert.equal(res.source, 'velocity');
        assert.ok(Math.abs(res.velocityPctPerHour - 3) < 0.2,
            `esperaba ~3 pp/h del tramo v2, obtuvo ${res.velocityPctPerHour}`);
    } finally { h.restore(); }
});

// ─── CA-5 alcanzable: delta contra un punto con antiguedad suficiente ───────

test('la nota de CA-5 sobrevive a la cadencia de ~33s del dashboard', async () => {
    // Serie densa como la viva (un punto cada 33 s). El alta de split ocurrió
    // hace 5 min: con la comparación contra el punto INMEDIATO anterior (~33 s)
    // la caída ya estaba absorbida y el delta daba `estable`, así que la nota
    // no aparecía nunca. Contra un punto de ≥10 min, sigue siendo visible.
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    for (let t = now - 30 * MIN; t < now - 5 * MIN; t += 33000) {
        points.push({ ts: t, avancePct: 57, totalWeight: 100, issueCount: 95, formulaV: 2 });
    }
    // Después del alta: mismo trabajo, denominador más grande ⇒ el % baja.
    for (let t = now - 5 * MIN; t < now; t += 33000) {
        points.push({ ts: t, avancePct: 52, totalWeight: 124, issueCount: 113, formulaV: 2 });
    }
    const h = withSeries(45, points);
    try {
        const { delta } = waveProgress.appendSnapshotWithDelta({
            waveKey: 45, avancePct: 52, now,
            totalWeight: 124, issueCount: 113, formulaV: 2,
        });
        assert.equal(delta.kind, 'altas',
            `la caida por altas debe seguir siendo visible a los 10 min (obtuvo ${delta.kind})`);
        assert.ok(delta.deltaPp < 0);
        assert.ok(delta.deltaWeight > 0);
    } finally { h.restore(); }
});

test('con la comparacion vieja (lookback 0) la misma caida quedaba invisible', async () => {
    // Prueba de que el fix es el que cambia el resultado, no la serie: con
    // `WAVE_PROGRESS_DELTA_LOOKBACK_MS=0` se recupera el comportamiento previo
    // (punto inmediato anterior) y la MISMA serie da `estable`.
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    for (let t = now - 30 * MIN; t < now - 5 * MIN; t += 33000) {
        points.push({ ts: t, avancePct: 57, totalWeight: 100, issueCount: 95, formulaV: 2 });
    }
    for (let t = now - 5 * MIN; t < now; t += 33000) {
        points.push({ ts: t, avancePct: 52, totalWeight: 124, issueCount: 113, formulaV: 2 });
    }
    const h = withSeries(47, points);
    const prevEnv = process.env.WAVE_PROGRESS_DELTA_LOOKBACK_MS;
    process.env.WAVE_PROGRESS_DELTA_LOOKBACK_MS = '0';
    try {
        const { delta } = waveProgress.appendSnapshotWithDelta({
            waveKey: 47, avancePct: 52, now,
            totalWeight: 124, issueCount: 113, formulaV: 2,
        });
        assert.equal(delta.kind, 'estable');
    } finally {
        if (prevEnv === undefined) delete process.env.WAVE_PROGRESS_DELTA_LOOKBACK_MS;
        else process.env.WAVE_PROGRESS_DELTA_LOOKBACK_MS = prevEnv;
        h.restore();
    }
});

test('un retroceso real dentro de la ventana sigue clasificando como retroceso', async () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const points = [];
    for (let t = now - 30 * MIN; t < now; t += 33000) {
        points.push({ ts: t, avancePct: 57, totalWeight: 124, issueCount: 113, formulaV: 2 });
    }
    const h = withSeries(46, points);
    try {
        const { delta } = waveProgress.appendSnapshotWithDelta({
            waveKey: 46, avancePct: 52, now,
            totalWeight: 124, issueCount: 113, formulaV: 2,   // denominador IGUAL
        });
        assert.equal(delta.kind, 'retroceso');
    } finally { h.restore(); }
});

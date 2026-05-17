// =============================================================================
// wave-renderer.test.js — Tests del render Markdown V2 y TTS (#3262).
//
// Cubre los CAs visuales:
//   - CA-7  : formato compacto (header + tabla + 2 secciones cortas).
//   - CA-9  : renderAudioText 1 frase corta.
//   - CA-10 : reply ≤ 4096 chars.
//   - CA-11 : header bold con valores accionables.
//   - CA-12 : emoji semántico por status.
//   - CA-13 : render degradado sin issues activos.
//   - CA-14 : truncado a 12 con sufijo "+N en fase X".
//   - CA-15 : header "sin label" cuando no se resuelve la ola.
//   - CA-UX-5: copy "humana" (no "Leo").
//   - CA-UX-6: 0% → "—" en vez de "0%".
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-renderer.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderWaveSnapshot, renderAudioText, _internal } = require('../wave-renderer');

const NOW = 1747440000000;

function baseSnapshot(overrides = {}) {
    return Object.assign({
        waveLabel: 'N+5',
        waveSource: 'active-wave.json',
        waveOpenedAt: '2026-05-16T23:48:00Z',
        totalIssues: 3,
        closedCount: 1,
        activeCount: 2,
        totalPct: 65,
        etaAbsoluteMs: NOW + 90 * 60000, // 1h30m
        etaAvailable: true,
        etasMissing: 0,
        activeWithEta: 2,
        issues: [
            {
                id: 3229, title: 'Done feature', labels: ['closed'],
                faseActual: null, faseAbbrev: 'done', faseIdx: -1, denominador: 0,
                pct: 100, agente: null, status: 'closed',
                isClosed: true, isBlocked: false, isPaused: false, isStale: false,
                staleMin: 0, bounces: 0, hasEta: false, etaAbsoluteMs: null,
            },
            {
                id: 3242, title: 'Testing tester', labels: ['Ready'],
                faseActual: 'desarrollo/verificacion', faseAbbrev: 'verif (4/7)', faseIdx: 3, denominador: 7,
                pct: 57, agente: 'tester', status: 'dev',
                isClosed: false, isBlocked: false, isPaused: false, isStale: false,
                staleMin: 30, bounces: 0, hasEta: true, etaAbsoluteMs: NOW + 60 * 60000,
            },
            {
                id: 3251, title: 'Review pending', labels: ['Ready'],
                faseActual: 'desarrollo/aprobacion', faseAbbrev: 'aprob (6/7)', faseIdx: 5, denominador: 7,
                pct: 86, agente: 'review', status: 'approval',
                isClosed: false, isBlocked: false, isPaused: false, isStale: false,
                staleMin: 10, bounces: 0, hasEta: true, etaAbsoluteMs: NOW + 90 * 60000,
            },
        ],
        blocks: [],
        humanInterventions: [],
        generatedAt: NOW,
        staleThresholdMin: 90,
    }, overrides);
}

// -----------------------------------------------------------------------------
// CA-7 / CA-10 — formato compacto y caps
// -----------------------------------------------------------------------------

test('CA-10: reply siempre cabe en 4096 chars', () => {
    const snap = baseSnapshot();
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.ok(out.length <= 4096, `reply tiene ${out.length} chars, supera 4096`);
});

test('CA-7: reply incluye header, tabla y trace line', () => {
    const snap = baseSnapshot();
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.match(out, /N\\\+5/, 'falta etiqueta de ola escapada');
    assert.match(out, /```/, 'falta code block de la tabla');
    assert.match(out, /Generado/, 'falta trace line');
});

test('CA-7: secciones bloqueos/intervención solo aparecen si tienen items', () => {
    const snap = baseSnapshot();
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.doesNotMatch(out, /🛑/, 'no debería haber bloqueos en este test');
    assert.doesNotMatch(out, /👤/, 'no debería haber intervención en este test');
});

// -----------------------------------------------------------------------------
// CA-11 — header con valores accionables en bold
// -----------------------------------------------------------------------------

test('CA-11: header usa bold en label, %, ETA', () => {
    const snap = baseSnapshot();
    const out = renderWaveSnapshot(snap, { now: NOW });
    const firstLine = out.split('\n')[0];
    // *...* es bold MarkdownV2. Esperamos 3 bolds: label, %, ETA.
    const boldMatches = firstLine.match(/\*[^*]+\*/g) || [];
    assert.ok(boldMatches.length >= 3, `header debe tener ≥3 bolds, tiene ${boldMatches.length}: ${firstLine}`);
});

// -----------------------------------------------------------------------------
// CA-13 — render degradado
// -----------------------------------------------------------------------------

test('CA-13: ola sin issues → render degradado', () => {
    const snap = baseSnapshot({ totalIssues: 0, activeCount: 0, closedCount: 0, issues: [] });
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.match(out, /Sin issues activos/);
    assert.match(out, /Generado/);
});

test('CA-13: ola con todos cerrados → header ola completada', () => {
    const snap = baseSnapshot({
        totalIssues: 2, activeCount: 0, closedCount: 2,
        issues: [
            { id: 1, title: '', labels: [], faseActual: null, faseAbbrev: 'done', faseIdx: -1, denominador: 0, pct: 100, agente: null, status: 'closed', isClosed: true, isBlocked: false, isPaused: false, isStale: false, staleMin: 0, bounces: 0, hasEta: false, etaAbsoluteMs: null },
            { id: 2, title: '', labels: [], faseActual: null, faseAbbrev: 'done', faseIdx: -1, denominador: 0, pct: 100, agente: null, status: 'closed', isClosed: true, isBlocked: false, isPaused: false, isStale: false, staleMin: 0, bounces: 0, hasEta: false, etaAbsoluteMs: null },
        ],
        totalPct: 100,
        blocks: [],
        humanInterventions: [],
    });
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.match(out, /ola completada/);
});

// -----------------------------------------------------------------------------
// CA-14 — truncado a 12 issues
// -----------------------------------------------------------------------------

test('CA-14: con >12 issues, truncar tabla y agregar sufijo "+N en X"', () => {
    const issues = [];
    for (let i = 1; i <= 18; i++) {
        issues.push({
            id: 4000 + i, title: '', labels: [], faseActual: 'desarrollo/dev',
            faseAbbrev: 'dev (2/7)', faseIdx: 1, denominador: 7, pct: 29,
            agente: 'backend-dev', status: 'dev',
            isClosed: false, isBlocked: false, isPaused: false, isStale: false,
            staleMin: 5, bounces: 0, hasEta: true, etaAbsoluteMs: NOW + 600000,
        });
    }
    const snap = baseSnapshot({ totalIssues: 18, activeCount: 18, closedCount: 0, issues, totalPct: 29 });
    const out = renderWaveSnapshot(snap, { now: NOW });
    // Debe contener "+6 más"
    assert.match(out, /\+6 más/);
    // No debe romper el code block.
    const codeBlocks = (out.match(/```/g) || []).length;
    assert.equal(codeBlocks % 2, 0, 'code blocks deben estar balanceados');
});

// -----------------------------------------------------------------------------
// CA-15 — header sin label
// -----------------------------------------------------------------------------

test('CA-15: label "Ola actual (sin label)" se renderiza sin romperse', () => {
    const snap = baseSnapshot({ waveLabel: 'Ola actual (sin label)', totalIssues: 0, activeCount: 0, closedCount: 0, issues: [] });
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.match(out, /Ola actual/);
});

// -----------------------------------------------------------------------------
// CA-UX-5 — copy estable "humana"
// -----------------------------------------------------------------------------

test('CA-UX-5: sección de intervención usa "humana", no "Leo"', () => {
    const snap = baseSnapshot({
        humanInterventions: [{ id: 3260, motivo: 'falta promover de needs-definition (3h sin acción)' }],
    });
    const out = renderWaveSnapshot(snap, { now: NOW });
    assert.match(out, /Intervención humana/);
    assert.doesNotMatch(out, /\bLeo\b/);
});

// -----------------------------------------------------------------------------
// CA-UX-6 — 0% → "—"
// -----------------------------------------------------------------------------

test('CA-UX-6: issue activo en 0% renderiza "—" en columna pct', () => {
    const snap = baseSnapshot({
        totalIssues: 1, activeCount: 1, closedCount: 0,
        issues: [{
            id: 5000, title: '', labels: [], faseActual: null, faseAbbrev: '—', faseIdx: -1, denominador: 7, pct: 0,
            agente: null, status: 'pending',
            isClosed: false, isBlocked: false, isPaused: false, isStale: false,
            staleMin: 0, bounces: 0, hasEta: false, etaAbsoluteMs: null,
        }],
        totalPct: 0,
        blocks: [], humanInterventions: [],
    });
    const out = renderWaveSnapshot(snap, { now: NOW });
    // El bloque tabular debe tener "—" para el pct, no "0%"
    const codeBlockMatch = out.match(/```([\s\S]+?)```/);
    assert.ok(codeBlockMatch, 'debería haber code block');
    assert.match(codeBlockMatch[1], /—/, `pct=0 debería renderizar como "—": ${codeBlockMatch[1]}`);
});

// -----------------------------------------------------------------------------
// CA-9 — audio TTS opt-in
// -----------------------------------------------------------------------------

test('CA-9: audio text ≤30 palabras con label + % + ETA + intervención', () => {
    const snap = baseSnapshot({
        humanInterventions: [{ id: 3260, motivo: 'algo' }],
    });
    const audio = renderAudioText(snap, { now: NOW });
    assert.match(audio, /N\+5/);
    assert.match(audio, /65 por ciento/);
    assert.match(audio, /1 issue necesita tu atención/);
    const words = audio.split(/\s+/).filter(Boolean);
    assert.ok(words.length <= 30, `audio tiene ${words.length} palabras, supera 30`);
});

test('CA-9: audio sin intervenciones omite la cláusula', () => {
    const snap = baseSnapshot({ humanInterventions: [] });
    const audio = renderAudioText(snap, { now: NOW });
    assert.doesNotMatch(audio, /necesita/);
    assert.doesNotMatch(audio, /necesitan/);
});

test('CA-9: audio con ola vacía → frase de "sin issues activos"', () => {
    const audio = renderAudioText({ waveLabel: 'N+5', totalIssues: 0 }, { now: NOW });
    assert.match(audio, /sin issues activos/);
});

test('CA-9: audio sin ETA → "por estimar"', () => {
    const snap = baseSnapshot({ etaAvailable: false, etaAbsoluteMs: null });
    const audio = renderAudioText(snap, { now: NOW });
    assert.match(audio, /por estimar/);
});

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

test('formatRemainingMs: formatea ms a string humano', () => {
    assert.equal(_internal.formatRemainingMs(null), '—');
    assert.equal(_internal.formatRemainingMs(0), '—');
    assert.equal(_internal.formatRemainingMs(30 * 60000), '30m');
    assert.equal(_internal.formatRemainingMs(90 * 60000), '1h 30m');
    assert.equal(_internal.formatRemainingMs(120 * 60000), '2h');
});

test('rankForTruncate: precedencia bloqueados > intervención > stale > approval > ...', () => {
    const blocked = { isBlocked: true, labels: [], isStale: false, status: 'dev' };
    const human = { isBlocked: false, labels: ['needs-human'], isStale: false, status: 'dev' };
    const stale = { isBlocked: false, labels: [], isStale: true, status: 'dev' };
    const approval = { isBlocked: false, labels: [], isStale: false, status: 'approval' };
    const dev = { isBlocked: false, labels: [], isStale: false, status: 'dev' };
    const closed = { isBlocked: false, labels: [], isStale: false, status: 'closed' };
    assert.ok(_internal.rankForTruncate(blocked) < _internal.rankForTruncate(human));
    assert.ok(_internal.rankForTruncate(human) < _internal.rankForTruncate(stale));
    assert.ok(_internal.rankForTruncate(stale) < _internal.rankForTruncate(approval));
    assert.ok(_internal.rankForTruncate(approval) < _internal.rankForTruncate(dev));
    assert.ok(_internal.rankForTruncate(dev) < _internal.rankForTruncate(closed));
});

test('formatEta: ETA available → "ETA ~HH:MM (Xh Ym)"', () => {
    const out = _internal.formatEta({
        etaAbsoluteMs: NOW + 90 * 60000,
        etaAvailable: true,
        etasMissing: 0,
        now: NOW,
    });
    assert.match(out, /^ETA ~\d{2}:\d{2} \(1h 30m\)$/);
});

test('formatEta: ETA missing → "ETA insuficiente data"', () => {
    const out = _internal.formatEta({
        etaAvailable: false,
        etaAbsoluteMs: null,
        etasMissing: 3,
        now: NOW,
    });
    assert.equal(out, 'ETA insuficiente data');
});

test('formatEta: parciales con etasMissing añade sufijo', () => {
    const out = _internal.formatEta({
        etaAvailable: true,
        etaAbsoluteMs: NOW + 30 * 60000,
        etasMissing: 2,
        now: NOW,
    });
    assert.match(out, /\(\+2 sin estimación\)/);
});

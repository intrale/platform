// =============================================================================
// Tests del núcleo lógico del Historial timeline (#3963).
//   - buildAgentHistory: deriva agentHistory[] desde issueMatrix + prInfo.
//   - historialTimelineSlice: filtros (skill/resultado/issue/q literal/period),
//     agrupación por día, paginación (cursor/límite), agregados (count,
//     %aprobado, mediana p50).
//   - REQ-SEC-5 / CA-6: búsqueda literal (no RegExp → ReDoS-safe) + límite
//     máximo por request.
//
// node:test puro, sin filesystem (state inline).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const slices = require(path.resolve(__dirname, '..', 'dashboard-slices.js'));
const { historialTimelineSlice, buildAgentHistory, HIST_PAGE_MAX } = slices;

const NOW = 1_718_000_000_000; // ancla fija (jun 2024)
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function entry(extra) {
    return Object.assign({
        issue: 100,
        titulo: 'Algo',
        skill: 'backend-dev',
        pipeline: 'desarrollo',
        fase: 'build',
        estado: 'procesado',
        resultado: 'aprobado',
        motivo: null,
        duration: 10 * MIN,
        startedAt: NOW - 20 * MIN,
        finishedAt: NOW - 5 * MIN,
        hasLog: true,
        logFile: '100-build.log',
        hasRejectionPdf: false,
        rejectionPdf: null,
        prUrl: null,
        reboteNumero: 0,
        crossphaseCount: 0,
        costo: null,
    }, extra || {});
}

// --- buildAgentHistory desde issueMatrix ---
test('buildAgentHistory deriva entradas desde issueMatrix + prInfo y ordena trabajando-first', () => {
    const state = {
        issueMatrix: {
            '10': {
                titulo: 'Uno', crossphaseCount: 1,
                fases: { 'desarrollo/dev': [{ skill: 'pipeline-dev', estado: 'procesado', resultado: 'aprobado', durationMs: 5 * MIN, updatedAt: NOW - 2 * HOUR }] },
            },
            '20': {
                titulo: 'Dos', crossphaseCount: 0,
                fases: { 'desarrollo/build': [{ skill: 'build', estado: 'trabajando', startedAt: NOW - 3 * MIN }] },
            },
        },
        prInfo: { '10': { url: 'https://github.com/intrale/platform/pull/5' } },
    };
    const list = buildAgentHistory(state);
    assert.equal(list.length, 2);
    // trabajando primero
    assert.equal(list[0].estado, 'trabajando');
    assert.equal(list[0].issue, '20');
    // prUrl + crossphase mapeados
    const uno = list.find((h) => h.issue === '10');
    assert.equal(uno.prUrl, 'https://github.com/intrale/platform/pull/5');
    assert.equal(uno.crossphaseCount, 1);
});

test('buildAgentHistory usa state.agentHistory tal cual si ya viene armado', () => {
    const arr = [entry()];
    assert.equal(buildAgentHistory({ agentHistory: arr }), arr);
});

// --- agregados: count, %aprobado, mediana p50 ---
test('agregados — count, pctApproved y mediana p50 sobre el set filtrado', () => {
    const items = [
        entry({ issue: 1, resultado: 'aprobado', duration: 10 * MIN }),
        entry({ issue: 2, resultado: 'aprobado', duration: 20 * MIN }),
        entry({ issue: 3, resultado: 'rechazado', duration: 30 * MIN }),
        entry({ issue: 4, estado: 'trabajando', resultado: null, duration: 0 }),
    ];
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, {});
    assert.equal(r.aggregates.count, 4);
    assert.equal(r.aggregates.approved, 2);
    assert.equal(r.aggregates.pctApproved, 0.5);
    // durations finalizadas: [10,20,30]m → p50 = 20m
    assert.equal(r.aggregates.medianMs, 20 * MIN);
});

test('mediana null cuando no hay ejecuciones finalizadas', () => {
    const r = historialTimelineSlice({ agentHistory: [entry({ estado: 'trabajando', resultado: null, duration: 0 })] }, { now: NOW }, {});
    assert.equal(r.aggregates.medianMs, null);
});

// --- agrupación por día: Hoy / Ayer / fecha ---
test('agrupación por día — Hoy, Ayer y fecha previa, orden descendente', () => {
    const items = [
        entry({ issue: 1, finishedAt: NOW - 1 * HOUR }),       // hoy
        entry({ issue: 2, finishedAt: NOW - 26 * HOUR }),      // ayer
        entry({ issue: 3, finishedAt: NOW - 3 * DAY }),        // hace 3 días
    ];
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, {});
    assert.equal(r.groups.length, 3);
    assert.equal(r.groups[0].dayLabel, 'Hoy');
    assert.equal(r.groups[1].dayLabel, 'Ayer');
    assert.match(r.groups[2].dayLabel, /de /); // "N de <mes>"
    // agregados por día
    assert.equal(r.groups[0].count, 1);
    assert.equal(r.groups[0].pctApproved, 1);
});

// --- filtros combinables ---
test('filtros — skill, resultado, issue se combinan', () => {
    const items = [
        entry({ issue: 1, skill: 'backend-dev', resultado: 'aprobado' }),
        entry({ issue: 2, skill: 'android-dev', resultado: 'rechazado' }),
        entry({ issue: 3, skill: 'backend-dev', resultado: 'rechazado' }),
    ];
    const st = { agentHistory: items };
    assert.equal(historialTimelineSlice(st, { now: NOW }, { skill: 'backend-dev' }).total, 2);
    assert.equal(historialTimelineSlice(st, { now: NOW }, { resultado: 'rechazado' }).total, 2);
    assert.equal(historialTimelineSlice(st, { now: NOW }, { skill: 'backend-dev', resultado: 'rechazado' }).total, 1);
    assert.equal(historialTimelineSlice(st, { now: NOW }, { issue: 2 }).total, 1);
});

test('filtro resultado=trabajando matchea por estado', () => {
    const items = [entry({ issue: 1, estado: 'trabajando', resultado: null }), entry({ issue: 2 })];
    assert.equal(historialTimelineSlice({ agentHistory: items }, { now: NOW }, { resultado: 'trabajando' }).total, 1);
});

// --- búsqueda literal (REQ-SEC-5 / CA-6) ---
test('búsqueda literal — match case-insensitive sobre titulo/skill/motivo/issue', () => {
    const items = [
        entry({ issue: 1, titulo: 'Deep-link entre flavors', motivo: null }),
        entry({ issue: 2, titulo: 'Otra cosa', motivo: 'falla en build' }),
    ];
    const st = { agentHistory: items };
    assert.equal(historialTimelineSlice(st, { now: NOW }, { q: 'deep-link' }).total, 1);
    assert.equal(historialTimelineSlice(st, { now: NOW }, { q: 'BUILD' }).total, 1);
    assert.equal(historialTimelineSlice(st, { now: NOW }, { q: 'inexistente' }).total, 0);
});

test('búsqueda con metacaracteres regex NO rompe ni hace ReDoS (match literal)', () => {
    // input catastrófico para un RegExp ingenuo: si se compilara como patrón,
    // (a+)+$ contra una cadena larga colgaría. Acá es literal → no matchea, no cuelga.
    const items = [entry({ issue: 1, titulo: 'a'.repeat(5000) })];
    const start = process.hrtime.bigint();
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, { q: '(a+)+$' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(r.total, 0);
    assert.ok(elapsedMs < 200, `la búsqueda literal debe ser rápida (fue ${elapsedMs.toFixed(1)}ms)`);
    // un literal que SÍ está presente matchea
    assert.equal(historialTimelineSlice({ agentHistory: items }, { now: NOW }, { q: 'aaa' }).total, 1);
});

// --- paginación: cursor + límite máximo ---
test('paginación — cursor avanza y nextCursor se agota; límite por defecto', () => {
    const items = Array.from({ length: 12 }, (_, i) => entry({ issue: i, finishedAt: NOW - i * MIN }));
    const p1 = historialTimelineSlice({ agentHistory: items }, { now: NOW }, { limit: 5, cursor: 0 });
    assert.equal(p1.page.returned, 5);
    assert.equal(p1.nextCursor, 5);
    assert.equal(p1.total, 12);
    const p3 = historialTimelineSlice({ agentHistory: items }, { now: NOW }, { limit: 5, cursor: 10 });
    assert.equal(p3.page.returned, 2);
    assert.equal(p3.nextCursor, null);
});

test('límite máximo por request — el slice NUNCA devuelve más de HIST_PAGE_MAX', () => {
    const items = Array.from({ length: HIST_PAGE_MAX + 50 }, (_, i) => entry({ issue: i, finishedAt: NOW - i * MIN }));
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, { limit: 99999 });
    assert.equal(r.page.limit, HIST_PAGE_MAX);
    assert.ok(r.page.returned <= HIST_PAGE_MAX);
    assert.equal(r.total, HIST_PAGE_MAX + 50); // total refleja todo, pero la página se acota
});

// --- período ---
test('filtro period=today recorta a las ejecuciones del día actual', () => {
    const items = [
        entry({ issue: 1, finishedAt: NOW - 1 * HOUR }),   // hoy
        entry({ issue: 2, finishedAt: NOW - 2 * DAY }),    // fuera
    ];
    assert.equal(historialTimelineSlice({ agentHistory: items }, { now: NOW }, { period: 'today' }).total, 1);
    assert.equal(historialTimelineSlice({ agentHistory: items }, { now: NOW }, { period: '7d' }).total, 2);
});

// --- inyección de entregables (CA-2) ---
test('collectAttachments inyectado enriquece las entradas de la página (best-effort)', () => {
    const items = [entry({ issue: 1, skill: 'ux' })];
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, {
        collectAttachments: (skill, issue) => [{ type: 'document', descriptor: 'mockup', path: `assets/${issue}.md` }],
    });
    const it = r.groups[0].items[0];
    assert.equal(it.attachments.length, 1);
    assert.equal(it.attachments[0].descriptor, 'mockup');
    // el objeto fuente NO se muta (copia defensiva)
    assert.equal(items[0].attachments, undefined);
});

test('collectAttachments que lanza degrada a [] sin romper el slice (CA-3)', () => {
    const items = [entry({ issue: 1 })];
    const r = historialTimelineSlice({ agentHistory: items }, { now: NOW }, {
        collectAttachments: () => { throw new Error('fs boom'); },
    });
    assert.deepEqual(r.groups[0].items[0].attachments, []);
});

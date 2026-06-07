// =============================================================================
// Tests SSR de la ventana KPIs — #3733 (split de #3715).
//
// Cubre los criterios de aceptación del PO (Bloques A, E, G, H):
//   CA-1   → renderKpis exporta y produce HTML válido.
//   CA-9   → CTA visible hacia /metrics (recupera memoria endpoint-lost).
//   CA-14  → XSS hardening con ≥4 payloads canónicos sobre cada KPI dinámico
//            (nombre de provider, nombre de skill, session ID, routing forzado).
//   CA-17  → safeSessionId trunca a 8 chars + descarta no-alfanuméricos.
//   CA-20  → ventana read-only: sin <form action>, sin method=POST, sin onclick POST.
//   CA-29  → render SSR + payload XSS escapado en el output.
//
// Framework: node:test + node:assert/strict (sin Jest). El render es una función
// pura del slice → testeable en aislamiento sin servidor HTTP.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshView() {
    delete require.cache[require.resolve('../kpis')];
    return require('../kpis');
}

// Payloads XSS canónicos exigidos por el análisis security del issue.
const XSS_IMG = '<img src=x onerror=alert(1)>';
const XSS_SVG = '<svg/onload=alert(1)>';
const XSS_ATTR = '";alert(1);//';
const XSS_BREAKOUT = '</script><script>alert(1)</script>';

// Slice válido de ejemplo (shape real de kpisSlice + getMetricsSlice).
function validOpts() {
    return {
        kpisSlice: {
            prsLast7d: 7,
            tokens24h: { total: 120000, by_provider: { claude: 90000, codex: 30000 } },
            agentDurationMedianMs: 1800000,
            issueCycleTimeMs: 7200000,
            bouncePct: { overall: 12.5 },
        },
        metricsSlice: {
            agentPerf: { 'backend-dev': { issues: 10, rejected: 1 }, qa: { issues: 5, rejected: 0 } },
            tokenEstimates: { bySession: [{ id: 'abcd1234', tools: 12, tokens: 45000 }] },
        },
        matrixDerived: { definidos: 3, pendientes: 2, trabajando: 1, blockedCount: 0, needsHuman: 0 },
        sysMini: { cpu: 42, mem: 55, health: 'Óptimo' },
        routingMetrics: { today: { percentDeterministic: 65, deterministic: 13, llm: 7, unknown: 0, total: 20 } },
        currentView: 'kpis',
    };
}

// Helper: una cadena escapada no debe contener el payload crudo ejecutable.
function assertNoRawPayload(html, payload, label) {
    assert.ok(!html.includes(payload), `${label}: el payload XSS crudo NO debe aparecer literal`);
}

test('CA-1/CA-29.1 — renderKpis produce HTML válido con secciones esperadas', () => {
    const view = freshView();
    const html = view.renderKpis(validOpts());
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'arranca con doctype');
    assert.match(html, /<title>Intrale · KPIs<\/title>/);
    assert.match(html, /class="kpis-row"/, 'incluye la fila de KPIs');
    assert.match(html, /dora-mini-grid/, 'incluye grid DORA');
    assert.match(html, /kpi-tooltip/, 'incluye tooltips operativos (CA-C1)');
});

test('CA-9/R10 — renderKpis incluye el CTA visible hacia /metrics', () => {
    const view = freshView();
    const html = view.renderKpis(validOpts());
    assert.match(html, /href="\/metrics"/, 'link visual a /metrics recuperado');
});

test('CA-20 — ventana read-only: sin form/POST/onclick state-changing', () => {
    const view = freshView();
    const html = view.renderKpis(validOpts());
    assert.ok(!/<form\s+action=/i.test(html), 'sin <form action=>');
    assert.ok(!/method=["']?post/i.test(html), 'sin method=POST');
    assert.ok(!/<button[^>]*onclick=/i.test(html), 'sin <button onclick=>');
});

test('CA-14.a — XSS en key de tokens24h.by_provider (nombre de provider) escapado', () => {
    const view = freshView();
    const opts = validOpts();
    opts.kpisSlice.tokens24h.by_provider = { [XSS_IMG]: 1000 };
    const html = view.renderKpis(opts);
    assertNoRawPayload(html, XSS_IMG, 'provider name');
    assert.match(html, /&lt;img/, 'aparece escapado');
});

test('CA-14.b — XSS en nombre de skill (agentPerf) escapado', () => {
    const view = freshView();
    const opts = validOpts();
    opts.metricsSlice.agentPerf = { [XSS_SVG]: { issues: 3, rejected: 0 } };
    const html = view.renderKpis(opts);
    assertNoRawPayload(html, XSS_SVG, 'skill name');
    assert.match(html, /&lt;svg/, 'aparece escapado');
});

test('CA-14.c — breakout en session ID neutralizado por safeSessionId', () => {
    const view = freshView();
    const opts = validOpts();
    opts.metricsSlice.tokenEstimates.bySession = [{ id: XSS_ATTR, tools: 1, tokens: 1000 }];
    const html = view.renderKpis(opts);
    assertNoRawPayload(html, XSS_ATTR, 'session id');
    // safeSessionId descarta todo lo no alfanumérico → de '";alert(1);//' queda 'alert1' (≤8)
    assert.ok(!html.includes('alert(1)'), 'no queda alert(1) ejecutable');
});

test('CA-14.d — breakout forzado en routingMetrics.today.deterministic escapado', () => {
    const view = freshView();
    const opts = validOpts();
    opts.routingMetrics.today.deterministic = XSS_BREAKOUT;
    const html = view.renderKpis(opts);
    assertNoRawPayload(html, XSS_BREAKOUT, 'routing deterministic');
    assert.match(html, /&lt;\/script&gt;/, 'aparece escapado');
});

test('CA-17 — safeSessionId trunca a 8 chars y descarta no-alfanuméricos', () => {
    const view = freshView();
    assert.equal(view.safeSessionId('abcdefghijklmnop'), 'abcdefgh');
    assert.equal(view.safeSessionId('abc;rm -rf'), 'abc'); // corta en el primer no-alfanumérico
    assert.equal(view.safeSessionId(null), '');
    assert.equal(view.safeSessionId(undefined), '');
});

test('R3/CA-29.2 — renderKpiCardsHTML es determinístico para el mismo state', () => {
    const view = freshView();
    const md = { definidos: 3, pendientes: 2, trabajando: 1, blockedCount: 4, needsHuman: 2 };
    const sys = { cpu: 40, mem: 50, health: 'Óptimo' };
    const a = view.renderKpiCardsHTML(md, sys);
    const b = view.renderKpiCardsHTML(md, sys);
    assert.equal(a, b, 'mismo input → mismo HTML (una sola fuente, home ↔ ventana)');
});

test('CA-A3 — renderKpis defensivo ante opts ausente (no rompe el render)', () => {
    const view = freshView();
    const html = view.renderKpis();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'render no queda en blanco sin opts');
    assert.match(html, /class="kpis-row"/);
});

test('CA-A3 — renderInert produce panel visible con motivo escapado', () => {
    const view = freshView();
    const html = view.renderInert(XSS_IMG);
    assertNoRawPayload(html, XSS_IMG, 'inert reason');
    assert.match(html, /Ventana KPIs no disponible/);
});

test('renderMetricsPage — XSS en skill/session escapado + sin patrones de secreto', () => {
    const view = freshView();
    const data = {
        snapshots: [{ ts: Date.now(), cpu: 30, mem: 40, agents: 2, level: 'green' }],
        etaAverages: { dev: { avgMs: 60000, count: 3 } },
        entregas: [{ issue: '1', ts: Date.now() }],
        tokenEstimates: { totalSessions: 1, totalTools: 5, totalEstimatedTokens: 100000, bySession: [{ id: XSS_ATTR, tools: 5, durMin: 10, tokens: 100000 }] },
        totalProcessed: 10,
        totalRejected: 1,
        agentPerf: { [XSS_SVG]: { issues: 2, rejected: 0, totalDurMs: 0, durCount: 0, toolCalls: 0 } },
    };
    const html = view.renderMetricsPage({ data });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'render válido');
    assertNoRawPayload(html, XSS_SVG, 'metrics skill');
    assertNoRawPayload(html, XSS_ATTR, 'metrics session id');
    // CA-16 — no debe filtrar patrones de secreto.
    assert.ok(!/sk-ant|AKIA|BEGIN PRIVATE KEY|aws_secret/.test(html), 'sin patrones de secreto');
});

test('CA-19 — tabla de providers no expone API keys (solo tokens)', () => {
    const view = freshView();
    const html = view.renderProvidersHTML({ tokens24h: { by_provider: { claude: 1000 } } });
    assert.match(html, /Tokens por proveedor/);
    assert.ok(!/api[_-]?key/i.test(html), 'sin mención de api key');
});

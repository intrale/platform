// =============================================================================
// kpis-ep8h8.test.js — #3961 EP8-H8. Render de KPIs operativos con sparkline,
// banda, tooltip, pintado por umbral y bandeja de alertas.
//
// Cubre:
//   - CA-2: sparkline con banda presente en el HTML.
//   - CA-3: tooltip "cómo se calcula" (data-tip) por KPI.
//   - CA-5a/b/c: cards de sherlock/voz con valores y "muestra insuficiente".
//   - CA-6: pintado por umbral (kpi-over-threshold) + entrada en bandeja.
//   - CA-7 (BLOQUEANTE): provider/skill malicioso queda ESCAPADO (no ejecuta).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const kpis = require('../kpis');
const thresholds = require('../../../lib/dashboard-thresholds');

const T = thresholds.loadThresholds(null);
const XSS = '<img src=x onerror=alert(1)>';

function opSection({ sherlockOver, voiceOver, insufficientVoice, maliciousProvider } = {}) {
    const sherlock = {
        ratio: sherlockOver ? 0.5 : 0.95, insufficient_sample: false,
        same_provider_ratio: 0.05,
        spark7d: [0.9, 0.92, 0.95, 0.9, 0.95, 0.96, sherlockOver ? 0.5 : 0.95],
        same_provider_spark7d: [0, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
        by_provider: maliciousProvider
            ? { [XSS]: { totales: 10, correctas: 1, incorrectas: 9, rejection_rate: 0.9, insufficient_sample: false } }
            : { anthropic: { totales: 10, correctas: 9, incorrectas: 1, rejection_rate: 0.1, insufficient_sample: false } },
    };
    const voice = insufficientVoice
        ? { p95_ms: null, insufficient_sample: true, spark7d: [0, 0, 0, 0, 0, 0, 0] }
        : { p95_ms: voiceOver ? 12000 : 3000, insufficient_sample: false, spark7d: [2000, 3000, 4000, 3000, 3000, 5000, voiceOver ? 12000 : 3000] };
    return kpis.renderOperationalKpisHTML({ sherlock, voice, thresholds: T });
}

// -----------------------------------------------------------------------------
// CA-2 / CA-3 — sparkline + banda + tooltip.
// -----------------------------------------------------------------------------
test('CA-2: la sparkline con banda de rango normal está en el HTML', () => {
    const html = opSection();
    assert.ok(html.includes('<svg class="kpi-spark"'), 'svg de sparkline presente');
    assert.ok(html.includes('fill-opacity="0.14"'), 'rect de banda presente');
    assert.ok(html.includes('stroke-dasharray="2 2"'), 'línea de target punteada presente');
});

test('CA-3: cada KPI tiene tooltip "cómo se calcula" (data-tip)', () => {
    const html = opSection();
    assert.ok(html.includes('data-tip='), 'tooltips presentes');
    assert.ok(/data-tip="[^"]*Fuente:[^"]*"/.test(html), 'el tooltip explica la fuente');
});

// -----------------------------------------------------------------------------
// CA-5 — métricas nuevas visibles.
// -----------------------------------------------------------------------------
test('CA-5b/c: muestra insuficiente de voz NO dibuja un p95 engañoso', () => {
    const html = opSection({ insufficientVoice: true });
    assert.ok(html.includes('muestra insuficiente'), 'estado de muestra insuficiente visible');
});

// -----------------------------------------------------------------------------
// CA-6 — pintado por umbral + bandeja.
// -----------------------------------------------------------------------------
test('CA-6: KPI fuera de umbral se pinta (kpi-over-threshold) con dual-encoding', () => {
    const html = opSection({ sherlockOver: true, voiceOver: true });
    assert.ok(html.includes('kpi-over-threshold'), 'card pintada');
    // Dual-encoding: además del color, un icono no-cromático (⚠ o 🚨).
    assert.ok(html.includes('kpi-alert-icon'), 'icono no-cromático presente');
});

test('CA-6: bandeja de alertas lista las entradas threshold_alerts', () => {
    const alertTray = {
        threshold_alerts: [
            { id: 'voice_p95', kpi: 'voice_p95', severity: 'warn', message: 'p95 latencia de voz 12000ms > 8000ms' },
            { id: 'sherlock_precision', kpi: 'sherlock_precision', severity: 'bad', message: 'Precisión de Sherlock 50% < 80%' },
        ],
    };
    const html = kpis.renderThresholdAlertsHTML(alertTray);
    assert.ok(html.includes('p95 latencia de voz 12000ms'), 'alerta de voz renderizada');
    assert.ok(html.includes('sev-bad'), 'severidad bad mapeada');
    assert.ok(html.includes('sev-warn'), 'severidad warn mapeada');
});

test('CA-6: bandeja vacía muestra estado "dentro de rango"', () => {
    const html = kpis.renderThresholdAlertsHTML({ threshold_alerts: [] });
    assert.ok(html.includes('dentro de rango'));
});

// -----------------------------------------------------------------------------
// CA-7 (BLOQUEANTE) — XSS: provider/skill malicioso queda escapado.
// -----------------------------------------------------------------------------
test('CA-7: provider con nombre malicioso queda ESCAPADO en los chips (no ejecuta)', () => {
    const html = opSection({ maliciousProvider: true });
    assert.ok(!html.includes(XSS), 'NO debe aparecer el <img onerror> crudo');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'aparece escapado');
});

test('CA-7: provider malicioso en la bandeja de alertas queda escapado', () => {
    const html = kpis.renderThresholdAlertsHTML({
        threshold_alerts: [{ id: 'p', kpi: 'sherlock_provider', severity: 'warn', provider: XSS, message: 'Rechazo 90% > 10%' }],
    });
    assert.ok(!html.includes(XSS), 'NO crudo');
    assert.ok(html.includes('&lt;img'), 'escapado');
});

test('CA-7: sparklineWithBand sanea color no-constante (defensa en profundidad)', () => {
    const svg = kpis.sparklineWithBand([1, 2, 3], { color: '"><script>alert(1)</script>' });
    assert.ok(!svg.includes('<script>'), 'no inyecta script vía color');
});

// -----------------------------------------------------------------------------
// Robustez — render con datos ausentes no rompe.
// -----------------------------------------------------------------------------
test('render operacional con opts vacío no lanza y degrada', () => {
    const html = kpis.renderOperationalKpisHTML({});
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(html.includes('muestra insuficiente'));
});

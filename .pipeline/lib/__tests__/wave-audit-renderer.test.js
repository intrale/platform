// =============================================================================
// wave-audit-renderer.test.js — Render server-side XSS-safe del widget de audit
// trail de olas/issues (#4371 CA-8). No repetir el patrón de XSS de #2893/#3960.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-audit-renderer.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const renderer = require('../wave-audit-renderer');

// ─── XSS: dato dinámico con payload → inerte ────────────────────────────────

test('un actor/nota con <img onerror> se renderiza como texto inerte (CA-8)', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = renderer._renderRow({
        event: 'issue_added',
        wave: 3,
        issue: 100,
        actor: payload,
        note: payload,
        estado_previo: { issues: [] },
        estado_posterior: { issues: [100] },
        visual: 'human',
        timestamp: '2026-07-02T10:00:00.000Z',
    });
    // El payload crudo NO debe aparecer; sí su forma escapada.
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'no debe haber HTML crudo inyectado');
    assert.ok(html.includes('&lt;img'), 'el < debe estar escapado a &lt;');
    assert.ok(!/onerror=alert\(1\)>/.test(html.replace(/&lt;|&gt;|&quot;|&#39;/g, '')), 'no queda un tag ejecutable');
});

test('estado con forma de objeto/array raro no rompe ni inyecta', () => {
    const html = renderer._renderRow({
        event: 'wave_promoted',
        wave: 2,
        actor: 'Leo',
        estado_previo: '"><script>alert(1)</script>',
        estado_posterior: 'active',
        visual: 'human',
        timestamp: '2026-07-02T10:00:00.000Z',
    });
    assert.ok(!html.includes('<script>'), 'sin <script> crudo');
    assert.ok(html.includes('&lt;script&gt;') || html.includes('&quot;&gt;&lt;script&gt;'), 'script escapado');
});

// ─── contenido esperado ─────────────────────────────────────────────────────

test('renderRow incluye icono del evento y clase de estado', () => {
    const html = renderer._renderRow({
        event: 'priority_changed',
        issue: 100,
        actor: 'Leo',
        prioridad_previa: 'priority:high',
        prioridad_nueva: 'priority:medium',
        visual: 'priority',
        timestamp: '2026-07-02T10:00:00.000Z',
    });
    assert.ok(html.includes('#ic-priority-change'), 'usa el icono nuevo del sprite');
    assert.ok(html.includes('wia-row-D'), 'estado D para cambio de prioridad');
    assert.ok(html.includes('priority:high') && html.includes('priority:medium'), 'muestra previo→nuevo');
});

test('estado unauthorized muestra microcopy de alerta y actor "sin autoría"', () => {
    const html = renderer._renderRow({
        event: 'issue_added',
        wave: 3,
        issue: 100,
        actor: 'desconocido',
        visual: 'unauthorized',
        timestamp: '2026-07-02T10:00:00.000Z',
    });
    assert.ok(html.includes('wia-row-C'), 'estado C');
    assert.ok(html.includes('Bypass detectado'), 'microcopy de alerta');
    assert.ok(html.includes('sin autoría'), 'texto sin autoría');
});

test('renderRows vacío devuelve fila empty explicativa', () => {
    const html = renderer.renderRows([]);
    assert.ok(html.includes('wia-empty'));
    assert.ok(html.includes('Sin movimientos'));
});

test('renderRows mapea múltiples entries', () => {
    const html = renderer.renderRows([
        { event: 'issue_added', wave: 3, issue: 100, actor: 'Leo', visual: 'human', timestamp: '2026-07-02T10:00:00.000Z' },
        { event: 'wave_archived', wave: 2, actor: 'System', visual: 'subsystem', timestamp: '2026-07-02T10:01:00.000Z' },
    ]);
    const rows = (html.match(/<tr/g) || []).length;
    assert.equal(rows, 2);
    assert.ok(html.includes('#ic-issue-added'));
    assert.ok(html.includes('#ic-archive-box'));
});

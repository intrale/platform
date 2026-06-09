// =============================================================================
// Tests de la ventana Bloqueados extraída a su propio módulo (#3729, padre #3715).
//
// Cubre (contrato del issue + comentario de security + narrativa UX):
//   - Exports canónicos ({ slug, renderBloqueadosSsr, renderBloqueadosClientScript,
//     renderBloqueados }).
//   - Render vacío → empty-state celebratorio (#bloqueados-empty + mini-stats),
//     NO string vacío (decisión UX D5 vs el monolito legacy).
//   - Render con 1 fila normal → datos escapados, IDs estables, severidad correcta.
//   - Matriz XSS canónica 4 × 5 (payloads × superficies de origen externo):
//     tags vivos ausentes, texto escapado presente, atributos title="" no rotos.
//   - Coerción `b.issue`: entradas inválidas descartan la fila; válidas renderizan
//     el número exacto en href/onclick.
//   - recent_events ausente/vacío no rompe; summary_stale → estado loading;
//     reason truncado a 280 chars.
//   - Client script expone handlers needsHuman*/toggleNeedsHumanPanel.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/bloqueados.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bloqueados = require('..' + path.sep + 'bloqueados.js');
const {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosClientScript,
    renderBloqueados,
    safeIssueNumber,
    severityOf,
} = bloqueados;

// "Ahora" fijo para tests deterministas del tiempo relativo de eventos.
const NOW = Date.parse('2026-06-09T12:00:00Z');
const opts = { nowMs: NOW };

const XSS_PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"><svg onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
];

// Detecta tags vivos provenientes de dato externo. La propiedad de seguridad es
// que el `<` del payload se neutraliza a `&lt;`, así que un `<script`/`<img`/
// `<svg` LITERAL no puede aparecer (la fila no usa esos tags en su markup
// propio). `onerror=`/`onload=` como texto escapado son inertes (su `<` ya fue
// neutralizado), por eso basta con chequear la apertura de tag literal.
function hasLiveTags(html) {
    return /<script\b/i.test(html)
        || /<img\b/i.test(html)
        || /<svg\b/i.test(html);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Bloqueados', () => {
    assert.equal(slug, 'bloqueados');
    assert.equal(typeof renderBloqueadosSsr, 'function');
    assert.equal(typeof renderBloqueadosClientScript, 'function');
    assert.equal(typeof renderBloqueados, 'function');
    assert.equal(typeof safeIssueNumber, 'function');
    assert.equal(typeof severityOf, 'function');
});

// ---------------------------------------------------------------------------
// Render vacío — empty-state celebratorio (CA-G1 / D5)
// ---------------------------------------------------------------------------

test('render vacío emite empty-state celebratorio con mini-stats', () => {
    const html = renderBloqueadosSsr({ bloqueados: [] }, opts);
    assert.match(html, /id="view-content"/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /v3-bloqueados-view/);
    assert.match(html, /id="bloqueados-empty"/);
    assert.match(html, /SLA promedio/);
    assert.match(html, /Resueltos hoy/);
    // NO debe contener filas.
    assert.doesNotMatch(html, /id="bloqueados-row-/);
    assert.ok(!hasLiveTags(html));
});

test('state.bloqueados undefined/null cae al empty-state sin romper', () => {
    assert.match(renderBloqueadosSsr({}, opts), /id="bloqueados-empty"/);
    assert.match(renderBloqueadosSsr(null, opts), /id="bloqueados-empty"/);
    assert.match(renderBloqueadosSsr(undefined, opts), /id="bloqueados-empty"/);
});

test('mini-stats usa valores del state cuando existen', () => {
    const html = renderBloqueadosSsr({ bloqueados: [], bloqueadosStats: { avgSla: '2h 14min', resolvedToday: 7 } }, opts);
    assert.match(html, /2h 14min/);
    assert.match(html, />7</);
});

// ---------------------------------------------------------------------------
// Render con 1 fila normal (CA-G1)
// ---------------------------------------------------------------------------

test('render con 1 fila normal: IDs estables, severidad y datos escapados', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{
            issue: 2891, title: 'Issue de prueba', skill: 'ux', phase: 'validacion',
            age_hours: 29, reason: 'motivo del bloqueo',
            recent_events: [{ when: '2026-06-08T12:00:00Z', author: 'leito', preview: 'comentario' }],
        }],
    }, opts);
    assert.match(html, /id="bloqueados-row-2891"/);
    assert.match(html, /v3-bloqueados-sev-danger/); // 29h ≥ 24h
    assert.match(html, /v3-bloqueados-row/);
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/2891"/);
    assert.match(html, /needsHumanReactivate\(2891\)/);
    assert.match(html, /needsHumanDismiss\(2891\)/);
    assert.match(html, /Issue de prueba/);
    assert.match(html, /motivo del bloqueo/);
    assert.match(html, /Actividad reciente/);
    // Header con badge de cantidad.
    assert.match(html, /Necesitan intervención humana/);
    assert.ok(!hasLiveTags(html));
});

test('umbrales de severidad: info < 4h, warning 4-24h, danger ≥ 24h', () => {
    assert.equal(severityOf(0.5), 'info');
    assert.equal(severityOf(3.9), 'info');
    assert.equal(severityOf(4), 'warning');
    assert.equal(severityOf(23.9), 'warning');
    assert.equal(severityOf(24), 'danger');
    assert.equal(severityOf(100), 'danger');
    const fresh = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1 }] }, opts);
    assert.match(fresh, /v3-bloqueados-sev-info/);
    const warn = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 10 }] }, opts);
    assert.match(warn, /v3-bloqueados-sev-warning/);
});

// ---------------------------------------------------------------------------
// Matriz XSS canónica 4 × 5 (CA-D1 + security)
// ---------------------------------------------------------------------------

test('matriz XSS 4×5: ningún payload produce tags vivos y el texto se escapa', () => {
    const surfaces = ['title', 'reason', 'summary', 'eventAuthor', 'eventPreview'];
    for (const payload of XSS_PAYLOADS) {
        for (const surface of surfaces) {
            const b = { issue: 1234, age_hours: 5 };
            if (surface === 'title') b.title = payload;
            if (surface === 'reason') b.reason = payload;
            if (surface === 'summary') b.summary = payload;
            if (surface === 'eventAuthor') b.recent_events = [{ when: '2026-06-08T12:00:00Z', author: payload, preview: 'ok' }];
            if (surface === 'eventPreview') b.recent_events = [{ when: '2026-06-08T12:00:00Z', author: 'ok', preview: payload }];

            const html = renderBloqueadosSsr({ bloqueados: [b] }, opts);
            assert.ok(!hasLiveTags(html), `payload ${payload} en ${surface} produjo tags vivos`);
            // El dato llegó escapado (al menos uno de los marcadores canónicos).
            assert.ok(
                html.includes('&lt;') || html.includes('&quot;') || html.includes('&#39;'),
                `payload ${payload} en ${surface} no aparece escapado`,
            );
        }
    }
});

test('título con comilla doble no rompe el atributo title=""', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1, title: '"><svg onload=alert(1)>' }],
    }, opts);
    // Todos los atributos title="..." están bien delimitados (sin comillas
    // internas sin escapar que rompan el parseo).
    const titleAttrs = html.match(/title="[^"]*"/g) || [];
    // El payload con comilla doble NO debe haber partido un atributo dejando
    // un `<svg` vivo fuera de comillas.
    assert.ok(!hasLiveTags(html));
    assert.ok(titleAttrs.length >= 1);
});

// ---------------------------------------------------------------------------
// Coerción b.issue (CA-D2)
// ---------------------------------------------------------------------------

test('coerción b.issue: entradas inválidas descartan la fila', () => {
    const invalid = ['1) alert(1) //', '<script>', null, '', 0, -5, '3.14', 'abc', NaN];
    for (const bad of invalid) {
        const html = renderBloqueadosSsr({ bloqueados: [{ issue: bad, age_hours: 1, title: 'x' }] }, opts);
        // Sin filas válidas → empty-state, sin row.
        assert.doesNotMatch(html, /id="bloqueados-row-/, `issue inválido ${JSON.stringify(bad)} no descartó la fila`);
    }
});

test('coerción b.issue: entradas válidas renderizan el número exacto', () => {
    for (const good of [1, '2', 99999]) {
        const n = Number(good);
        const html = renderBloqueadosSsr({ bloqueados: [{ issue: good, age_hours: 1, title: 'x' }] }, opts);
        assert.match(html, new RegExp('id="bloqueados-row-' + n + '"'));
        assert.match(html, new RegExp('needsHumanReactivate\\(' + n + '\\)'));
        assert.match(html, new RegExp('issues/' + n + '"'));
    }
});

test('safeIssueNumber: contrato directo', () => {
    assert.equal(safeIssueNumber(5), 5);
    assert.equal(safeIssueNumber('42'), 42);
    assert.equal(safeIssueNumber(0), null);
    assert.equal(safeIssueNumber(-1), null);
    assert.equal(safeIssueNumber('3.14'), null);
    assert.equal(safeIssueNumber('<script>'), null);
    assert.equal(safeIssueNumber(null), null);
});

// ---------------------------------------------------------------------------
// Estados especiales (CA-G1)
// ---------------------------------------------------------------------------

test('recent_events ausente o vacío no genera el bloque de actividad', () => {
    const noEvents = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1 }] }, opts);
    assert.doesNotMatch(noEvents, /Actividad reciente/);
    const emptyEvents = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, recent_events: [] }] }, opts);
    assert.doesNotMatch(emptyEvents, /Actividad reciente/);
});

test('summary_stale sin summary renderiza estado loading', () => {
    const html = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, summary_stale: true }] }, opts);
    assert.match(html, /Cargando resumen funcional/);
    assert.match(html, /needs-human-summary-loading/);
});

test('reason se trunca a 280 chars con elipsis', () => {
    const longReason = 'a'.repeat(400);
    const html = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, reason: longReason }] }, opts);
    assert.match(html, /a{280}…/);
    assert.doesNotMatch(html, /a{281}/);
});

// ---------------------------------------------------------------------------
// Client script + documento completo
// ---------------------------------------------------------------------------

test('client script expone handlers needsHuman* y toggleNeedsHumanPanel', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /window\.needsHumanReactivate/);
    assert.match(js, /window\.needsHumanDismiss/);
    assert.match(js, /window\.toggleNeedsHumanPanel/);
    assert.match(js, /\/api\/needs-human\//);
    // Preparado para CSRF sin hardcodear ausencia (R8 security).
    assert.match(js, /csrf-token/);
});

test('renderBloqueados emite documento SSR completo con shell V3', () => {
    const doc = renderBloqueados({ bloqueados: [] }, opts);
    assert.match(doc, /<!DOCTYPE html>/);
    assert.match(doc, /<title>Intrale · Bloqueados<\/title>/);
    assert.match(doc, /data-slug="bloqueados"/);
    assert.match(doc, /window\.needsHumanReactivate/);
});

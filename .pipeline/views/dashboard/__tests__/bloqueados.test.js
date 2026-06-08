'use strict';

// =============================================================================
// bloqueados.test.js — Ventana Bloqueados V3 (#3729, split de #3715).
//
// Cubre (receta architect + comentarios PO/security):
//   1. Render vacío → empty-state celebratorio (#bloqueados-empty + mini-stats),
//      NUNCA string vacío (UX cambió la decisión del monolito).
//   2. Render con 1 fila normal → #bloqueados-row-N + clases de severidad.
//   3. Matriz XSS canónica 4 × 5 (payloads × superficies) → sin tags vivos,
//      con texto escapado, title="..." consistente.
//   4. Coerción estricta de b.issue → inválidos descartados, válidos exactos.
//   5. recent_events ausente/vacío → sin bloque de Actividad reciente.
//   6. summary_stale sin summary → estado loading.
//   7. Truncation de reason a 280 chars + ellipsis.
// Convención de aserciones XSS alineada con costos.test.js / ops.test.js:
// se verifica que el PAYLOAD CRUDO COMPLETO no aparezca y que el texto quede
// escapado (el `<` de cualquier payload queda como `&lt;`, así que no hay tag
// ejecutable; substrings inertes dentro de texto escapado son seguros).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bloqueados = require('../bloqueados');

// Payloads XSS canónicos (paridad con home.test.js / costos.test.js).
const XSS_PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"><svg onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
];

// Superficies de datos externos (5) que el render interpola.
const SURFACES = ['title', 'reason', 'summary', 'eventAuthor', 'eventPreview'];

function buildState(surface, payload) {
    const b = { issue: 7, skill: 'tester', phase: 'verificacion', age_hours: 5 };
    switch (surface) {
        case 'title': b.title = payload; break;
        case 'reason': b.reason = payload; break;
        case 'summary': b.summary = payload; break;
        case 'eventAuthor': b.recent_events = [{ when: null, author: payload, preview: 'ok' }]; break;
        case 'eventPreview': b.recent_events = [{ when: null, author: 'bot', preview: payload }]; break;
    }
    return { bloqueados: [b] };
}

// ── 1. Render vacío ─────────────────────────────────────────────────────────
test('renderBloqueadosSsr vacío → empty-state celebratorio, no string vacío (CA-A1)', () => {
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [] });
    assert.notEqual(html, '', 'no debe retornar string vacío (UX #3729)');
    assert.match(html, /id="bloqueados-empty"/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /Resueltos hoy/);            // mini-stat
    assert.match(html, /SLA promedio/);             // mini-stat
    assert.match(html, /v3-bloqueados-view-empty/);
});

test('state sin propiedad bloqueados o null → empty-state, no rompe (CA-A3)', () => {
    assert.match(bloqueados.renderBloqueadosSsr({}), /id="bloqueados-empty"/);
    assert.match(bloqueados.renderBloqueadosSsr(null), /id="bloqueados-empty"/);
    assert.match(bloqueados.renderBloqueadosSsr(undefined), /id="bloqueados-empty"/);
});

// ── 2. Render con 1 fila normal ─────────────────────────────────────────────
test('renderBloqueadosSsr con 1 fila sana → id de fila + severidad (CA-A1)', () => {
    const html = bloqueados.renderBloqueadosSsr({
        bloqueados: [{ issue: 3819, title: 'Algo', skill: 'tester', phase: 'verificacion', age_hours: 2, reason: 'esperando' }],
    });
    assert.match(html, /id="bloqueados-row-3819"/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /class="[^"]*v3-bloqueados-row[^"]*"/);
    assert.match(html, /v3-bloqueados-severity-info/);   // 2h < 4h → info
    assert.match(html, /github\.com\/intrale\/platform\/issues\/3819/);
});

test('severidad por umbral de age_hours (CA-E1)', () => {
    assert.equal(bloqueados.severityOf(0.5), 'info');
    assert.equal(bloqueados.severityOf(3.9), 'info');
    assert.equal(bloqueados.severityOf(4), 'warning');
    assert.equal(bloqueados.severityOf(23.9), 'warning');
    assert.equal(bloqueados.severityOf(24), 'danger');
    assert.equal(bloqueados.severityOf(100), 'danger');
    assert.equal(bloqueados.severityOf('nope'), 'info'); // no numérico → fresh
});

// ── 3. Matriz XSS canónica 4 × 5 ────────────────────────────────────────────
test('matriz XSS 4×5: ningún payload crudo ejecutable + texto escapado (CA-D1)', () => {
    for (const surface of SURFACES) {
        for (const payload of XSS_PAYLOADS) {
            const html = bloqueados.renderBloqueadosSsr(buildState(surface, payload));
            const ctx = `${surface} / ${payload}`;

            // No queda el payload crudo COMPLETO (tag ejecutable).
            assert.ok(!html.includes(payload), `payload crudo presente en ${ctx}`);
            // No hay aperturas de tag peligrosas crudas (el < quedó como &lt;).
            assert.ok(!/<script\b/i.test(html), `<script vivo en ${ctx}`);
            assert.ok(!/<img\b/i.test(html), `<img vivo en ${ctx}`);
            assert.ok(!/<svg\b/i.test(html), `<svg vivo en ${ctx}`);

            // El dato llegó y el < se neutralizó (garantía anti-XSS universal:
            // sin `<` crudo no hay tag ejecutable en ningún contexto).
            if (payload.includes('<')) assert.match(html, /&lt;/, `sin &lt; en ${ctx}`);

            // Atributos title="..." consistentes: ningún valor contiene comilla
            // doble cruda (rompería el atributo). Cubre el contexto-atributo
            // cuando el payload entra a `title=` (superficie title).
            const titleVals = [...html.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
            for (const v of titleVals) {
                assert.ok(!v.includes('"'), `title roto por comilla en ${ctx}`);
            }
        }
    }
});

// El payload en contexto-atributo (title=) DEBE escapar la comilla doble
// (escapeHtmlAttr), si no rompe el atributo. El title de la fila usa b.title.
test('payload con comilla en title → escapeHtmlAttr neutraliza la comilla (CA-C1/CA-D1)', () => {
    const html = bloqueados.renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1, title: '"><svg onload=alert(1)>' }],
    });
    // El title="..." no se rompe y la comilla quedó como &quot;.
    assert.match(html, /title="[^"]*&quot;/);
    assert.ok(!/<svg\b/i.test(html), 'svg vivo desde title');
    const titleVals = [...html.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
    for (const v of titleVals) assert.ok(!v.includes('"'), 'title roto por comilla');
});

test('payload con apóstrofo en title → escapeHtmlAttr lo neutraliza', () => {
    const html = bloqueados.renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1, title: "'><img src=x onerror=alert(1)>" }],
    });
    assert.match(html, /&#39;/);
    assert.ok(!/<img\b/i.test(html), 'img vivo desde title');
});

// ── 4. Coerción estricta de b.issue ─────────────────────────────────────────
test('coerción de b.issue: inválidos descartados (CA-D2)', () => {
    const invalid = ['1) alert(1) //', '<script>', null, '', 0, -5, '3.14', 'NaN', {}, []];
    for (const issue of invalid) {
        const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue, title: 'x' }] });
        // Ninguna fila renderizada → empty-state.
        assert.match(html, /id="bloqueados-empty"/, `issue inválido ${JSON.stringify(issue)} no descartado`);
        assert.ok(!/id="bloqueados-row-/.test(html), `fila renderizada para issue inválido ${JSON.stringify(issue)}`);
    }
});

test('coerción de b.issue: válidos renderizados con número exacto (CA-D2)', () => {
    const valid = [[1, 1], ['2', 2], [99999, 99999]];
    for (const [issue, expected] of valid) {
        const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue, title: 'x', age_hours: 1 }] });
        assert.match(html, new RegExp(`id="bloqueados-row-${expected}"`), `issue ${JSON.stringify(issue)}`);
        assert.match(html, new RegExp(`issues/${expected}"`), `href issue ${JSON.stringify(issue)}`);
        assert.match(html, new RegExp(`needsHumanReactivate\\(${expected}\\)`), `onclick issue ${JSON.stringify(issue)}`);
    }
});

test('safeIssueNumber export directo', () => {
    assert.equal(bloqueados.safeIssueNumber('2'), 2);
    assert.equal(bloqueados.safeIssueNumber(99999), 99999);
    assert.equal(bloqueados.safeIssueNumber('3.14'), null);
    assert.equal(bloqueados.safeIssueNumber(0), null);
    assert.equal(bloqueados.safeIssueNumber(-1), null);
    assert.equal(bloqueados.safeIssueNumber('<script>'), null);
});

// ── 5. recent_events ausente / vacío ────────────────────────────────────────
test('recent_events ausente o vacío → sin bloque Actividad reciente (CA-A1)', () => {
    const sinEv = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 5, age_hours: 1 }] });
    assert.ok(!sinEv.includes('Actividad reciente'));
    const vacio = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 5, age_hours: 1, recent_events: [] }] });
    assert.ok(!vacio.includes('Actividad reciente'));
    const conEv = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 5, age_hours: 1, recent_events: [{ when: null, author: 'bot', preview: 'hola' }] }] });
    assert.match(conEv, /Actividad reciente/);
});

// ── 6. summary_stale sin summary → loading ──────────────────────────────────
test('summary_stale sin summary → estado loading (CA-A1)', () => {
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 9, age_hours: 1, summary_stale: true }] });
    assert.match(html, /Cargando resumen funcional/);
    assert.match(html, /v3-bloqueados-summary-loading/);
});

test('summary presente → no muestra loading', () => {
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 9, age_hours: 1, summary: 'listo', summary_stale: true }] });
    assert.match(html, /listo/);
    assert.ok(!html.includes('Cargando resumen funcional'));
});

// ── 7. Truncation de reason a 280 chars ─────────────────────────────────────
test('reason se trunca a 280 chars + ellipsis (CA-A1)', () => {
    const long = 'a'.repeat(400);
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 11, age_hours: 1, reason: long }] });
    assert.match(html, /…/, 'falta ellipsis');
    assert.ok(html.includes('a'.repeat(280)), 'faltan los primeros 280 chars');
    assert.ok(!html.includes('a'.repeat(281)), 'no debe incluir > 280 chars');
});

test('reason <= 280 chars → sin ellipsis', () => {
    const short = 'b'.repeat(50);
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 11, age_hours: 1, reason: short }] });
    assert.ok(html.includes(short));
    assert.ok(!html.includes(short + '…'));
});

// ── Tooltips + leyenda (CA-C1 / CA-C3) ──────────────────────────────────────
test('cada acción operativa tiene tooltip + leyenda de severidad (CA-C1/CA-C3)', () => {
    const html = bloqueados.renderBloqueadosSsr({ bloqueados: [{ issue: 12, age_hours: 30, title: 'x' }] });
    const titleCount = (html.match(/title="/g) || []).length;
    assert.ok(titleCount >= 4, `esperaba >=4 tooltips, encontré ${titleCount}`);
    assert.match(html, /aria-label="Reactivar issue #12"/);
    assert.match(html, /aria-label="Desestimar issue #12"/);
    assert.match(html, /v3-bloqueados-legend/);
});

// ── Client script (R3) ──────────────────────────────────────────────────────
test('renderBloqueadosClientScript expone handlers como window.* (R3)', () => {
    const js = bloqueados.renderBloqueadosClientScript();
    assert.match(js, /window\.toggleNeedsHumanPanel\s*=/);
    assert.match(js, /window\.needsHumanReactivate\s*=/);
    assert.match(js, /window\.needsHumanDismiss\s*=/);
    assert.match(js, /__bloqueadosWired/);              // idempotencia
    assert.match(js, /\/api\/needs-human\//);           // endpoint preservado
});

test('exports del módulo (CA-B)', () => {
    assert.equal(bloqueados.slug, 'bloqueados');
    assert.equal(typeof bloqueados.renderBloqueadosSsr, 'function');
    assert.equal(typeof bloqueados.renderBloqueadosClientScript, 'function');
    assert.equal(typeof bloqueados.loadTheme, 'function');
});

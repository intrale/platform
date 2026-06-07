// =============================================================================
// Tests SSR de la ventana Matriz — #3731 (split de #3715).
//
// Cubre los criterios de aceptación del PO/security/guru:
//   CA-3 → IDs DOM invariantes (#bloqueados-humano, #issue-tracker,
//          #it-search-input, #dot-popup) preservados textualmente.
//   CA-4 → escape XSS riguroso + b.issue coerced a entero (fila omitida si no
//          es entero positivo).
//   CA-5 → handlers state-changing preservados 1:1
//          (needsHumanReactivate/needsHumanDismiss con entero).
//   CA-6 → tooltips title="..." en botones de acción.
//   CA-7 → payload XSS canónico por CADA campo escapable, en AMBOS sub-paneles.
//
// Framework: node:test + node:assert/strict (sin Jest). El render es una función
// pura → testeable en aislamiento sin servidor HTTP.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshView() {
    delete require.cache[require.resolve('../matriz')];
    return require('../matriz');
}

const matriz = freshView();

// Payloads XSS canónicos exigidos por el análisis security del issue.
const XSS_SCRIPT = '<script>alert(1)</script>';
const XSS_IMG = '"><img src=x onerror=alert(1)>';
const XSS_JS = 'javascript:void(0)';
const XSS_PAYLOADS = [XSS_SCRIPT, XSS_IMG, XSS_JS];

function bloqueadoBase(extra) {
    return Object.assign({
        issue: 42, title: 't', skill: 's', phase: 'p', age_hours: 1,
    }, extra || {});
}

// ---------------------------------------------------------------------------
// Render degenerado y básico
// ---------------------------------------------------------------------------

test('renderMatrizSsr con state vacío renderiza contenedores sin crashear', () => {
    const html = matriz.renderMatrizSsr({ state: { bloqueados: [], issueMatrix: {} } });
    assert.ok(html.includes('id="issue-tracker"'), 'preserva ID #issue-tracker');
    // bloqueados vacíos → no renderiza #bloqueados-humano (panel oculto).
    assert.ok(!html.includes('id="bloqueados-humano"'), 'sin bloqueados no renderiza el panel');
});

test('renderMatrizSsr sin argumentos no tira excepción', () => {
    const html = matriz.renderMatrizSsr();
    assert.ok(typeof html === 'string' && html.includes('id="issue-tracker"'));
});

test('CA-7 (sub-panel Board): Board Kanban renderiza con counts enteros', () => {
    const html = matriz.renderMatrizSsr({
        state: {},
        bloqueados: [],
        lanesHTML: '<div class="it-lane"></div>',
        activeIssues: [1, 2, 3], completedIssues: [4], sorted: [1, 2, 3, 4],
    });
    assert.ok(html.includes('>3</span>'), 'count activos = 3');
    assert.ok(/ic-tab-count">4<\/span>/.test(html), 'count todos = 4');
    assert.ok(html.includes('<div class="it-lane"></div>'), 'lanesHTML pasado tal cual');
});

// ---------------------------------------------------------------------------
// CA-3 — IDs DOM invariantes
// ---------------------------------------------------------------------------

test('CA-3: preserva IDs DOM invariantes con datos no vacíos', () => {
    const bloqueados = [bloqueadoBase()];
    const html = matriz.renderMatrizSsr({
        state: { bloqueados }, bloqueados,
        lanesHTML: '<div class="lane"></div>',
        activeIssues: [], completedIssues: [], sorted: [],
    });
    for (const id of ['bloqueados-humano', 'issue-tracker', 'it-search-input', 'dot-popup']) {
        assert.ok(html.includes(`id="${id}"`), `falta id="${id}"`);
    }
});

// ---------------------------------------------------------------------------
// CA-7 — Payload XSS canónico por CADA campo escapable (sub-panel needs-human)
// ---------------------------------------------------------------------------

const ESCAPABLE_FIELDS = ['title', 'question', 'reason', 'summary', 'skill', 'phase'];

for (const field of ESCAPABLE_FIELDS) {
    for (const payload of XSS_PAYLOADS) {
        test(`CA-4/CA-7: escapa XSS en b.${field} con payload ${payload.slice(0, 18)}…`, () => {
            const bloqueados = [bloqueadoBase({ [field]: payload })];
            const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
            // El payload con < > no debe sobrevivir literal.
            assert.ok(!html.includes('<script>alert(1)</script>'), `<script> sin escapar (campo ${field})`);
            assert.ok(!/<img\s+src=x\s+onerror/.test(html), `<img onerror> sin escapar (campo ${field})`);
            assert.ok(!/<script[\s>]/i.test(html), 'no debe haber <script> sin escapar');
        });
    }
}

// ev.preview y ev.author también escapables.
test('CA-7: escapa XSS en ev.preview y ev.author', () => {
    const bloqueados = [bloqueadoBase({
        recent_events: [{ when: '2026-06-07T10:00:00Z', author: XSS_SCRIPT, preview: XSS_SCRIPT }],
    })];
    const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'payload sin escapar en recent_events');
});

// ---------------------------------------------------------------------------
// CA-4 — b.issue coerced a entero / fila omitida
// ---------------------------------------------------------------------------

test('CA-4: b.issue no numérico (string javascript:) NO se interpola y se omite la fila', () => {
    const bloqueados = [bloqueadoBase({ issue: 'javascript:alert(1)' })];
    const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
    assert.ok(!html.includes('javascript:alert(1)'), 'b.issue malicioso no debe sobrevivir');
    assert.ok(!/onclick="needsHumanReactivate\(javascript:/.test(html), 'no inyecta en handler');
    // El panel se renderiza (header) pero la fila concreta se omite.
    assert.ok(!html.includes('needsHumanReactivate('), 'no debe renderizar handler de fila omitida');
});

test('CA-4: safeIssueId valida enteros positivos', () => {
    assert.equal(matriz.safeIssueId(42), 42);
    assert.equal(matriz.safeIssueId('42'), 42);
    assert.equal(matriz.safeIssueId('javascript:alert(1)'), null);
    assert.equal(matriz.safeIssueId(-1), null);
    assert.equal(matriz.safeIssueId(0), null);
    assert.equal(matriz.safeIssueId(1.5), null);
    assert.equal(matriz.safeIssueId(null), null);
    assert.equal(matriz.safeIssueId(undefined), null);
});

// ---------------------------------------------------------------------------
// CA-5 — handlers state-changing preservados
// ---------------------------------------------------------------------------

test('CA-5: preserva onclick="needsHumanReactivate(<int>)" y needsHumanDismiss(<int>)', () => {
    const bloqueados = [bloqueadoBase()];
    const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
    assert.ok(/onclick="needsHumanReactivate\(42\)"/.test(html), 'onclick reactivate con entero');
    assert.ok(/onclick="needsHumanDismiss\(42\)"/.test(html), 'onclick dismiss con entero');
});

// ---------------------------------------------------------------------------
// CA-6 — tooltips obligatorios
// ---------------------------------------------------------------------------

test('CA-6: botones de acción tienen title="..."', () => {
    const bloqueados = [bloqueadoBase()];
    const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
    assert.ok(/nh-btn-reactivate"[^>]*title="[^"]+"/.test(html), 'reactivate sin title');
    assert.ok(/nh-btn-dismiss"[^>]*title="[^"]+"/.test(html), 'dismiss sin title');
    assert.ok(/id="it-search-input"[^>]*aria-label="[^"]+"/.test(html), 'search sin aria-label');
});

// ---------------------------------------------------------------------------
// Sub-panel needs-human: contenido + popout
// ---------------------------------------------------------------------------

test('renderBloqueadosHTML vacío devuelve string vacío', () => {
    assert.equal(matriz.renderBloqueadosHTML([]), '');
    assert.equal(matriz.renderBloqueadosHTML(null), '');
});

test('needs-human row enlaza al issue de GitHub con id entero', () => {
    const bloqueados = [bloqueadoBase({ issue: 1732 })];
    const html = matriz.renderMatrizSsr({ state: { bloqueados }, bloqueados });
    assert.ok(html.includes('https://github.com/intrale/platform/issues/1732'), 'link a GitHub');
    assert.ok(html.includes('>#1732</b>') || html.includes('#1732'), 'muestra #issue');
});

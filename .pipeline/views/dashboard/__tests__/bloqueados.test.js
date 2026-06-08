// =============================================================================
// Tests de la ventana Bloqueados extraída a su propio módulo (#3729, padre #3715).
//
// Cubre (criterios CA-3729.B/C/D/D2 + tests obligatorios del issue):
//   1. Exports canónicos + render vacío → empty-state celebratorio (#bloqueados-empty
//      + mini-stats). NO retorna string vacío (UX cambió la decisión del monolito).
//   2. Render con 1 fila normal → HTML válido (#bloqueados-row-N, clases de
//      severidad correctas según age_hours).
//   3. Matriz XSS canónica 4 × 5 (payloads × superficies): NO tags vivos, SÍ texto
//      escapado, atributo title="..." no se rompe.
//   4. Coerción b.issue: entradas inválidas → fila descartada; válidas → número exacto.
//   5. recent_events ausente/vacío → no genera bloque de actividad.
//   6. summary_stale sin summary → estado loading.
//   7. Truncation de reason a 280 chars.
//   + severidad (3 umbrales), data-slug boundary, tooltips con escape attr-context,
//     y el full doc con shell V3.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/bloqueados.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bloqueados = require('..' + path.sep + 'bloqueados.js');
const {
    renderBloqueadosSsr,
    renderBloqueados,
    renderBloqueadosInner,
    renderBloqueadosClientScript,
    slug,
    escapeHtmlSsr,
    safeIssueNumber,
    severity,
    fmtAge,
} = bloqueados;

// nowMs fijo para tests deterministas de tiempos relativos.
const NOW = Date.parse('2026-06-08T12:00:00.000Z');

function row(extra) {
    return Object.assign({
        issue: 1732,
        title: 'Issue de prueba',
        skill: 'po',
        phase: 'criterios',
        pipeline: 'desarrollo',
        age_hours: 5,
        question: 'por qué se bloqueó?',
        recent_events: [],
    }, extra || {});
}

// ---------------------------------------------------------------------------
// 1. Exports + render vacío
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Bloqueados', () => {
    assert.equal(slug, 'bloqueados');
    assert.equal(typeof renderBloqueadosSsr, 'function');
    assert.equal(typeof renderBloqueados, 'function');
    assert.equal(typeof renderBloqueadosInner, 'function');
    assert.equal(typeof renderBloqueadosClientScript, 'function');
    assert.equal(typeof escapeHtmlSsr, 'function');
    assert.equal(typeof safeIssueNumber, 'function');
});

test('render vacío → empty-state celebratorio con mini-stats (NO string vacío)', () => {
    const html = renderBloqueadosSsr({ bloqueados: [] });
    assert.notEqual(html.trim(), '');
    assert.match(html, /id="bloqueados-empty"/);
    assert.match(html, /id="bloqueados-empty-stats"/);
    assert.match(html, /id="bloqueados-stat-sla"/);
    assert.match(html, /id="bloqueados-stat-resueltos"/);
    // Boundary del router (#3773 / smoke CA-G2).
    assert.match(html, /data-slug="bloqueados"/);
});

test('empty-state usa mini-stats de state.bloqueadosStats si existen', () => {
    const html = renderBloqueadosSsr({ bloqueados: [], bloqueadosStats: { sla_promedio: '3h', resueltos_hoy: 4 } });
    assert.match(html, /id="bloqueados-stat-sla"[^>]*>3h</);
    assert.match(html, /id="bloqueados-stat-resueltos"[^>]*>4</);
});

test('state.bloqueados undefined no rompe el render', () => {
    const html = renderBloqueadosSsr({});
    assert.match(html, /id="bloqueados-empty"/);
});

// ---------------------------------------------------------------------------
// 2. Render con 1 fila normal
// ---------------------------------------------------------------------------

test('render con 1 fila normal → HTML válido con id y datos escapados', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row()] }, { nowMs: NOW });
    assert.match(html, /id="bloqueados-row-1732"/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /Necesitan intervención humana/);
    // Badge con el conteo.
    assert.match(html, /v3-bloqueados-badge[^>]*>1</);
    // href y onclick con el número exacto.
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/1732"/);
    assert.match(html, /needsHumanReactivate\(1732\)/);
    assert.match(html, /needsHumanDismiss\(1732\)/);
});

test('severidad 3 umbrales según age_hours (info/warning/danger)', () => {
    assert.equal(severity(2), 'info');       // < 4h
    assert.equal(severity(3.9), 'info');
    assert.equal(severity(4), 'warning');    // 4-24h
    assert.equal(severity(23.9), 'warning');
    assert.equal(severity(24), 'danger');    // >= 24h
    assert.equal(severity(100), 'danger');
    assert.equal(severity('nope'), 'info');  // defensivo

    const fresh = renderBloqueadosSsr({ bloqueados: [row({ issue: 1, age_hours: 1 })] }, { nowMs: NOW });
    assert.match(fresh, /v3-bloqueados-severity-info/);
    const warn = renderBloqueadosSsr({ bloqueados: [row({ issue: 2, age_hours: 10 })] }, { nowMs: NOW });
    assert.match(warn, /v3-bloqueados-severity-warning/);
    const danger = renderBloqueadosSsr({ bloqueados: [row({ issue: 3, age_hours: 48 })] }, { nowMs: NOW });
    assert.match(danger, /v3-bloqueados-severity-danger/);
});

test('fmtAge formatea minutos/horas/días', () => {
    assert.equal(fmtAge(0.5), '30min');
    assert.equal(fmtAge(5), '5h');
    assert.equal(fmtAge(72), '3d');
    assert.equal(fmtAge('x'), '—');
});

test('clases v3-bloqueados-row y v3-bloqueados-severity-* presentes (R2)', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row()] }, { nowMs: NOW });
    assert.match(html, /class="[^"]*v3-bloqueados-row[^"]*"/);
    assert.match(html, /v3-bloqueados-severity-(info|warning|danger)/);
});

// ---------------------------------------------------------------------------
// 3. Matriz XSS canónica 4 × 5
// ---------------------------------------------------------------------------

const XSS_PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"><svg onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
];

// Cada superficie inyecta el payload en un campo distinto del entry.
const SURFACES = [
    { name: 'title',        build: (p) => row({ title: p }) },
    { name: 'question',     build: (p) => row({ question: p, reason: '' }) },
    { name: 'reason',       build: (p) => row({ question: '', reason: p }) },
    { name: 'summary',      build: (p) => row({ summary: p }) },
    { name: 'event.author', build: (p) => row({ recent_events: [{ when: '2026-06-08T11:00:00Z', author: p, preview: 'ok' }] }) },
    { name: 'event.preview', build: (p) => row({ recent_events: [{ when: '2026-06-08T11:00:00Z', author: 'bot', preview: p }] }) },
];

for (const surface of SURFACES) {
    for (const payload of XSS_PAYLOADS) {
        test(`XSS — ${surface.name} con payload ${JSON.stringify(payload)} no escapa crudo`, () => {
            const html = renderBloqueadosSsr({ bloqueados: [surface.build(payload)] }, { nowMs: NOW });
            // NO tags vivos del payload: todos los `<` del dato externo deben
            // quedar escapados como `&lt;`, neutralizando cualquier tag/handler.
            assert.ok(!/<script\b/i.test(html), 'no <script vivo');
            assert.ok(!/<img\b/i.test(html), 'no <img vivo');
            assert.ok(!/<svg\b/i.test(html), 'no <svg vivo');
            // SÍ aparece el rastro escapado del payload (el dato llegó al output).
            if (payload.includes('<')) assert.ok(html.includes('&lt;'), 'contiene &lt;');
        });
    }
}

test('title="..." de los tooltips no se rompe con payload de comilla doble', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ title: '"><svg onload=alert(1)>' })] }, { nowMs: NOW });
    // Todos los atributos title="..." deben parsear con regex consistente: el
    // contenido interno nunca contiene una comilla doble cruda.
    const re = /title="([^"]*)"/g;
    let m;
    let count = 0;
    while ((m = re.exec(html)) !== null) {
        count++;
        assert.ok(!m[1].includes('<svg'), 'tooltip no contiene tag vivo');
    }
    assert.ok(count >= 4, 'hay al menos 4 atributos title (tooltips CA-C1)');
    // No queda ningún <svg onload vivo en todo el HTML.
    assert.ok(!html.includes('<svg onload'), 'sin svg vivo');
});

test('hay al menos 5 tooltips title="..." en una fila (CA-3729.C)', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row()] }, { nowMs: NOW });
    const titles = html.match(/title="[^"]*"/g) || [];
    assert.ok(titles.length >= 5, `esperaba >=5 tooltips, hubo ${titles.length}`);
});

// ---------------------------------------------------------------------------
// 4. Coerción b.issue (CA-3729.D2)
// ---------------------------------------------------------------------------

test('coerción b.issue — entradas inválidas descartan la fila', () => {
    const invalid = ['1) alert(1) //', '<script>', null, '', 0, -5, '3.14', 'NaN', '  '];
    for (const bad of invalid) {
        const html = renderBloqueadosSsr({ bloqueados: [row({ issue: bad })] }, { nowMs: NOW });
        // Con una sola fila inválida, cae al empty-state (no hay filas válidas).
        assert.match(html, /id="bloqueados-empty"/, `issue=${JSON.stringify(bad)} debería descartarse`);
        assert.ok(!/id="bloqueados-row-/.test(html), `issue=${JSON.stringify(bad)} no debe renderizar fila`);
    }
});

test('coerción b.issue — entradas válidas renderizan el número exacto', () => {
    const valid = [[1, 1], ['2', 2], [99999, 99999]];
    for (const [input, expected] of valid) {
        const html = renderBloqueadosSsr({ bloqueados: [row({ issue: input })] }, { nowMs: NOW });
        assert.match(html, new RegExp(`id="bloqueados-row-${expected}"`));
        assert.match(html, new RegExp(`needsHumanReactivate\\(${expected}\\)`));
        assert.match(html, new RegExp(`issues/${expected}"`));
    }
});

test('safeIssueNumber unit', () => {
    assert.equal(safeIssueNumber('1) alert(1) //'), null);
    assert.equal(safeIssueNumber('<script>'), null);
    assert.equal(safeIssueNumber(0), null);
    assert.equal(safeIssueNumber(-5), null);
    assert.equal(safeIssueNumber('3.14'), null);
    assert.equal(safeIssueNumber(1), 1);
    assert.equal(safeIssueNumber('2'), 2);
    assert.equal(safeIssueNumber(99999), 99999);
});

test('fila descartada entre filas válidas no rompe el resto', () => {
    const html = renderBloqueadosSsr({ bloqueados: [
        row({ issue: 10 }),
        row({ issue: '<script>' }),
        row({ issue: 20 }),
    ] }, { nowMs: NOW });
    assert.match(html, /id="bloqueados-row-10"/);
    assert.match(html, /id="bloqueados-row-20"/);
    assert.ok(!html.includes('<script>'));
    // El badge cuenta sólo las válidas (2).
    assert.match(html, /v3-bloqueados-badge[^>]*>2</);
});

// ---------------------------------------------------------------------------
// 5. recent_events ausente / vacío
// ---------------------------------------------------------------------------

test('recent_events ausente no genera bloque de actividad', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ recent_events: undefined })] }, { nowMs: NOW });
    assert.ok(!html.includes('Actividad reciente'));
});

test('recent_events vacío no genera bloque de actividad', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ recent_events: [] })] }, { nowMs: NOW });
    assert.ok(!html.includes('Actividad reciente'));
});

test('recent_events con datos genera bloque + tiempos relativos', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({
        recent_events: [{ when: '2026-06-08T11:00:00.000Z', author: 'leito', preview: 'comentario' }],
    })] }, { nowMs: NOW });
    assert.match(html, /Actividad reciente/);
    assert.match(html, /leito/);
    assert.match(html, /comentario/);
    assert.match(html, /1h/); // 12:00 - 11:00 = 1h
});

// ---------------------------------------------------------------------------
// 6. summary_stale sin summary → loading
// ---------------------------------------------------------------------------

test('summary_stale sin summary → estado loading', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ summary: '', summary_stale: true })] }, { nowMs: NOW });
    assert.match(html, /v3-bloqueados-summary-loading/);
    assert.match(html, /Cargando resumen funcional/);
});

test('summary presente → no loading', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ summary: 'Resumen real', summary_stale: true })] }, { nowMs: NOW });
    assert.match(html, /Resumen real/);
    assert.ok(!html.includes('Cargando resumen funcional'));
});

// ---------------------------------------------------------------------------
// 7. Truncation de reason a 280 chars
// ---------------------------------------------------------------------------

test('reason se trunca a 280 chars con ellipsis', () => {
    const long = 'x'.repeat(400);
    const html = renderBloqueadosSsr({ bloqueados: [row({ question: long, reason: '' })] }, { nowMs: NOW });
    assert.match(html, /x{280}…/);
    assert.ok(!html.includes('x'.repeat(281)));
});

test('reason corto no agrega ellipsis', () => {
    const html = renderBloqueadosSsr({ bloqueados: [row({ question: 'corto', reason: '' })] }, { nowMs: NOW });
    assert.match(html, /❓ corto/);
    assert.ok(!/corto…/.test(html));
});

// ---------------------------------------------------------------------------
// Full doc + inner + client script
// ---------------------------------------------------------------------------

test('renderBloqueados full doc emite shell V3 con data-slug', () => {
    const html = renderBloqueados({ bloqueados: [row()] }, { nowMs: NOW });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<title>Intrale · Bloqueados<\/title>/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /class="v3-nav"/);
});

test('renderBloqueadosInner sin DOCTYPE (fragmento morphing) + scripts', () => {
    const html = renderBloqueadosInner({ bloqueados: [row()] }, { nowMs: NOW });
    assert.ok(!html.includes('<!DOCTYPE'));
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /tickBloqueados/);
});

test('client script expone handlers globales window.needsHuman*', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /window\.needsHumanReactivate\s*=/);
    assert.match(js, /window\.needsHumanDismiss\s*=/);
    assert.match(js, /window\.toggleNeedsHumanPanel\s*=/);
    // Preparado para CSRF (R8): lee meta csrf-token, no hardcodea ausencia.
    assert.match(js, /csrf-token/);
});

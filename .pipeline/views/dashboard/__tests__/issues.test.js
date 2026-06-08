'use strict';

// =============================================================================
// issues.test.js — Tests SSR de la ventana Issues V3 (#3730, split de #3715).
//
// Cubre: CA-G1 (render SSR parseable), CA-D1 (payloads XSS canónicos),
// CA-UX-2 (cero HEX literal), CA-UX-3 (iconos sólo vía <use>), CA-UX-4 (ARIA
// en cards), CA-UX-5 (chips con aria-pressed), R-6 (number inválido → '').
//
// node --test .pipeline/views/dashboard/__tests__/issues.test.js --no-warnings
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');

const issues = require('../issues');

const XSS_IMG = '<img src=x onerror=alert(1)>';
const XSS_SVG = '"><svg onload=alert(1)>';

// Quita los bloques <style>…</style> (theme + tokens + módulo) para que las
// aserciones de "cero HEX" e "iconos vía use" sólo miren el markup emitido por
// el módulo, no la paleta heredada (CA-UX-2 dice "fuera del bloque <style>").
function stripStyles(html) {
    return html.replace(/<style[\s\S]*?<\/style>/g, '');
}
// Quita el contenedor del sprite inline (símbolos SVG globales con <path>) —
// el módulo NO debe emitir <path> propios; el sprite es responsabilidad de
// nav-tabs/home (CA-UX-3).
function stripSprite(html) {
    return html.replace(/<div aria-hidden="true"[^>]*>[\s\S]*?<\/div>/, '');
}

// ── CA-G1: render SSR estructural ────────────────────────────────────────────
test('renderIssuesHTML retorna HTML con DOCTYPE y contenedor #issues-grid', () => {
    const html = issues.renderIssuesHTML();
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /id="issues-grid"/);
    assert.match(html, /<dialog id="issues-dialog"/);
    assert.match(html, /role="toolbar"/);
});

test('renderIssuesHTML renderiza cards iniciales desde opts.matrix (SSR sin JS)', () => {
    const html = issues.renderIssuesHTML({
        matrix: { '1732': { title: 'Arreglar login', faseActual: 'dev', estadoActual: 'trabajando', labels: [], bounces: 0 } },
        priorityOrder: ['1732'],
    });
    assert.match(html, /data-issue="1732"/);
    assert.match(html, /Arreglar login/);
    assert.match(html, /Trabajando/);
});

// ── CA-D1: sanitización XSS ──────────────────────────────────────────────────
// Un handler de evento sólo es peligroso si el payload logra ABRIR un tag o
// ROMPER el atributo que lo contiene. Tras escapar `<`→&lt; y `"`→&quot; el
// texto "onerror=" sobrevive como contenido inerte dentro del valor de un
// atributo. Verificamos la propiedad real: el tag-open / breakout del payload
// NO sobrevive. (Los `<svg>` legítimos de los iconos sí están presentes y son
// esperados — sólo prohibimos `<img`, el breakout `"><svg` y `<svg…onload`.)
test('renderIssueCard sanitiza title con payload XSS canónico (img/onerror)', () => {
    const out = issues.renderIssueCard({ number: 1, title: XSS_IMG });
    assert.ok(!out.includes('<img'), 'no debe sobrevivir <img crudo');
    assert.match(out, /&lt;img/, 'el < del payload quedó escapado a &lt;');
});

test('renderIssueCard sanitiza title con payload de cierre prematuro (svg/onload)', () => {
    const out = issues.renderIssueCard({ number: 1, title: XSS_SVG });
    // El payload `"><svg onload=…>` no debe producir un <svg> real con handler.
    // (Los <svg> de iconos legítimos no llevan onload.)
    assert.ok(!/<svg\b[^>]*onload/i.test(out), 'ningún <svg> con onload ejecutable');
    assert.match(out, /&lt;svg/i, 'el < del payload quedó escapado a &lt;');
});

test('renderIssueCard sanitiza motivo_rechazo del tooltip de rebote', () => {
    const out = issues.renderIssueCard({ number: 5, title: 'x', rebote: true, motivo_rechazo: XSS_IMG, rechazado_en_fase: 'build' });
    assert.ok(!out.includes('<img'), 'el motivo no debe romper el atributo title con <img crudo');
    assert.match(out, /↩ rechazo/);
});

test('renderIssuesHTML no contiene payloads XSS crudos al inyectar en matrix', () => {
    const html = issues.renderIssuesHTML({
        matrix: { '99': { title: XSS_IMG, labels: [XSS_SVG], faseActual: 'dev', estadoActual: 'trabajando' } },
        priorityOrder: [],
    });
    const body = stripStyles(html); // el script cliente vive en <script>, no <style>; revisamos markup
    // El markup SSR (cards) no debe tener los vectores crudos.
    const ssr = body.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok(!ssr.includes('<img'), 'no img crudo en SSR');
    assert.ok(!/<svg\b[^>]*onload/i.test(ssr), 'no svg con onload ejecutable en SSR');
});

// ── R-6: number inválido ─────────────────────────────────────────────────────
test('renderIssueCard descarta issues con number inválido', () => {
    assert.strictEqual(issues.renderIssueCard({ number: 'foo', title: 'x' }), '');
    assert.strictEqual(issues.renderIssueCard({ number: '<img>', title: 'x' }), '');
    assert.strictEqual(issues.renderIssueCard({ number: -3, title: 'x' }), '');
    assert.strictEqual(issues.renderIssueCard({ number: 0, title: 'x' }), '');
    assert.strictEqual(issues.renderIssueCard(null), '');
});

// ── CA-UX-4: ARIA en cards ───────────────────────────────────────────────────
test('cards tienen tabindex="0", role="article" y aria-label descriptivo', () => {
    const out = issues.renderIssueCard({ number: 42, title: 'Mi issue', faseActual: 'dev', estadoActual: 'trabajando' });
    assert.match(out, /tabindex="0"/);
    assert.match(out, /role="article"/);
    assert.match(out, /aria-label="Issue 42: Mi issue, fase dev, estado Trabajando"/);
});

// ── CA-UX-5: chips con aria-pressed ──────────────────────────────────────────
test('chips de filtro tienen aria-pressed, aria-label y data-filter', () => {
    const bar = issues.renderIssuesFilterBar();
    assert.match(bar, /data-filter="all"/);
    assert.match(bar, /data-filter="trabajando"/);
    assert.match(bar, /aria-pressed="true"/);  // chip "Todos" activo por defecto
    assert.match(bar, /aria-pressed="false"/);
    assert.ok((bar.match(/aria-label="/g) || []).length >= 5, 'cada chip + search con aria-label');
});

// ── CA-UX-2: cero HEX literal en color:/background: del módulo ────────────────
test('el CSS del módulo no usa HEX literal en color:/background:', () => {
    const css = issues.ISSUES_CSS;
    const hex = css.match(/(?:color|background[a-z-]*):\s*#[0-9a-fA-F]{3,6}/g);
    assert.strictEqual(hex, null, 'ISSUES_CSS debe usar sólo tokens var(--…), no HEX directo');
});

test('el markup SSR (sin <style> ni sprite) no contiene HEX en atributos de color', () => {
    const html = stripSprite(stripStyles(issues.renderIssuesHTML({
        matrix: { '7': { title: 'x', faseActual: 'dev', estadoActual: 'listo' } }, priorityOrder: ['7'],
    })));
    const hex = html.match(/(?:color|background[a-z-]*):\s*#[0-9a-fA-F]{3,6}/g);
    assert.strictEqual(hex, null);
});

// ── CA-UX-3: iconos sólo vía <use href="#ic-…"> ──────────────────────────────
test('renderIssueCard usa iconos vía <use href="#ic-…"> sin <path> inline', () => {
    const out = issues.renderIssueCard({ number: 8, title: 'x', faseActual: 'build', estadoActual: 'trabajando' });
    assert.ok(!/<path/.test(out), 'no debe haber <path> inline');
    assert.ok(!/<circle/.test(out) && !/<rect/.test(out), 'no geometría SVG inline');
    // Cada <svg> del card debe contener un <use>.
    const svgs = out.match(/<svg[\s\S]*?<\/svg>/g) || [];
    assert.ok(svgs.length > 0, 'el card emite al menos un ícono');
    svgs.forEach((s) => assert.match(s, /<use href="#ic-/));
});

test('el markup SSR (sin sprite ni style) no emite <path> propios', () => {
    const html = stripSprite(stripStyles(issues.renderIssuesHTML({
        matrix: { '7': { title: 'x', faseActual: 'dev', estadoActual: 'listo' } }, priorityOrder: ['7'],
    })));
    // El script cliente contiene strings 'ic-…' pero no <path>; lo dejamos.
    const noScript = html.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok(!/<path/.test(noScript), 'sin <path> inline en el markup del módulo');
});

// ── Exports puros (CA-UX-1) ──────────────────────────────────────────────────
test('el módulo exporta las funciones puras esperadas (CA-UX-1)', () => {
    for (const fn of ['renderIssuesHTML', 'renderIssueCard', 'renderIssuesClientScript', 'escapeHtmlSsr', 'escapeHtmlAttr']) {
        assert.strictEqual(typeof issues[fn], 'function', fn + ' debe exportarse');
    }
});

test('deriveState prioriza rebote > needs-human > bloqueado > estado', () => {
    assert.strictEqual(issues.deriveState({ rebote: true, estadoActual: 'trabajando' }), 'rebote');
    assert.strictEqual(issues.deriveState({ labels: ['needs-human'], estadoActual: 'listo' }), 'needs-human');
    assert.strictEqual(issues.deriveState({ labels: ['blocked:dependencies'] }), 'bloqueado');
    assert.strictEqual(issues.deriveState({ estadoActual: 'listo' }), 'listo');
    assert.strictEqual(issues.deriveState({}), 'pendiente');
});

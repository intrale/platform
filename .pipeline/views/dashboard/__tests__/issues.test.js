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

// #3730 rebote — los botones de las cards no deben ser controles muertos.
// El script cliente DEBE definir moveIssue/pauseIssue propios (no depender de
// window.moveIssue/window.pauseIssue, que no se cargan en /issues ni ?view=issues).
// =============================================================================
// #4192 — Cobertura de las funciones puras del rediseño MIZPÁ.
// Hasta acá las 6 funciones nuevas (deriveGroup, renderGroupedSSR, countGroups,
// renderCounters, renderMizpaChrome, deriveIssuesMission) estaban exportadas y
// marcadas "PURA y testeable" pero sin red. Estos tests cierran ese hueco +
// la regresión CA-7 (no truncar el backlog).
// =============================================================================

// ── deriveGroup: prioridad bloqueado > trabajando > listo > backlog ───────────
test('deriveGroup prioriza bloqueado sobre el estado real (needs-human/blocked)', () => {
    // Un issue "trabajando" pero con label de bloqueo cae en "bloqueado": la
    // prioridad de bloqueo gana sobre el estado del agente.
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'trabajando', labels: ['needs-human'] }), 'bloqueado');
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'listo', labels: ['blocked:dependencies'] }), 'bloqueado');
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'pendiente', labels: ['needs-human'] }), 'bloqueado');
});

test('deriveGroup mapea trabajando/listo/backlog según estadoActual cuando no hay bloqueo', () => {
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'trabajando', labels: [] }), 'trabajando');
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'listo', labels: [] }), 'listo');
    // Cualquier estado que no sea trabajando/listo (pendiente, null, desconocido) → backlog.
    assert.strictEqual(issues.deriveGroup({ estadoActual: 'pendiente', labels: [] }), 'backlog');
    assert.strictEqual(issues.deriveGroup({ estadoActual: null }), 'backlog');
    assert.strictEqual(issues.deriveGroup({}), 'backlog');
    assert.strictEqual(issues.deriveGroup(null), 'backlog');
});

// ── renderGroupedSSR: secciones en GROUP_ORDER con encabezado+conteo ──────────
const grpFixture = [
    { number: 1, title: 'a', estadoActual: 'trabajando', labels: [] },
    { number: 2, title: 'b', estadoActual: 'trabajando', labels: [] },
    { number: 3, title: 'c', estadoActual: 'listo', labels: [] },
    { number: 4, title: 'd', estadoActual: 'pendiente', labels: ['needs-human'] },
    { number: 5, title: 'e', estadoActual: 'pendiente', labels: [] },
];

test('renderGroupedSSR agrupa en secciones siguiendo GROUP_ORDER, con encabezado y conteo', () => {
    const html = issues.renderGroupedSSR(grpFixture);
    // Las secciones presentes deben aparecer en el orden canónico de GROUP_ORDER.
    const orden = (html.match(/data-group-key="([a-z]+)"/g) || []).map((s) => s.replace(/.*"([a-z]+)"/, '$1'));
    assert.deepStrictEqual(orden, ['trabajando', 'listo', 'bloqueado', 'backlog'],
        'las secciones respetan GROUP_ORDER y omiten las vacías');
    // Encabezado con label + conteo por sección.
    assert.match(html, /class="iss-group-title">Trabajando<\/span><span class="iss-group-count">2</);
    assert.match(html, /class="iss-group-title">Listos<\/span><span class="iss-group-count">1</);
    assert.match(html, /class="iss-group-title">Bloqueados<\/span><span class="iss-group-count">1</);
    assert.match(html, /class="iss-group-title">Backlog<\/span><span class="iss-group-count">1</);
});

test('renderGroupedSSR omite secciones sin issues y muestra empty-state global cuando no hay ninguno', () => {
    // Sólo "trabajando": no debe emitir secciones de listo/bloqueado/backlog.
    const soloTrabajando = issues.renderGroupedSSR([{ number: 9, title: 'x', estadoActual: 'trabajando', labels: [] }]);
    assert.match(soloTrabajando, /data-group-key="trabajando"/);
    assert.ok(!/data-group-key="listo"/.test(soloTrabajando), 'sin sección listo si está vacía');
    assert.ok(!/data-group-key="backlog"/.test(soloTrabajando), 'sin sección backlog si está vacía');
    // Backlog totalmente vacío → empty-state.
    const vacio = issues.renderGroupedSSR([]);
    assert.match(vacio, /class="iss-empty"/);
    assert.ok(!/data-group-key=/.test(vacio), 'sin secciones cuando no hay issues');
});

// ── countGroups / renderCounters: valores total/trabajando/listo/bloqueado ────
test('countGroups cuenta total/trabajando/listo/blocked para un set fijo', () => {
    const c = issues.countGroups(grpFixture);
    assert.strictEqual(c.total, 5, 'total = cantidad de issues, sin perder ninguno');
    assert.strictEqual(c.trabajando, 2);
    assert.strictEqual(c.listo, 1);
    assert.strictEqual(c.blocked, 1);
    // El backlog (e) no tiene contador propio pero entra en el total.
});

test('renderCounters refleja los valores de countGroups en sus celdas', () => {
    const html = issues.renderCounters(issues.countGroups(grpFixture));
    assert.match(html, /id="iss-count-total">5</);
    assert.match(html, /id="iss-count-working">2</);
    assert.match(html, /id="iss-count-ready">1</);
    assert.match(html, /id="iss-count-blocked">1</);
});

test('renderCounters sin argumento degrada a ceros sin emitir "undefined"', () => {
    const html = issues.renderCounters();
    assert.match(html, /id="iss-count-blocked">0</, 'la celda bloqueados cae a 0, no a undefined');
    assert.ok(!/>undefined</.test(html), 'ninguna celda renderiza "undefined"');
});

// ── renderMizpaChrome: banner de misión defensivo ────────────────────────────
test('renderMizpaChrome arma el banner de misión con entregados/total y barra de progreso', () => {
    const html = issues.renderMizpaChrome({ label: 'Ola 7.1', total: 10, entregados: 4, etaRemainingMs: 3600000, velocityPctPerMin: 0.5 });
    assert.match(html, /id="mz-delivered">4</);
    assert.match(html, /id="mz-total">10</);
    assert.match(html, /width:40%/, '40% = 4/10 entregados');
    assert.match(html, /Ola 7\.1/);
});

test('renderMizpaChrome es defensivo ante mission null/parcial (sin NaN ni división por cero)', () => {
    const html = issues.renderMizpaChrome(null);
    assert.match(html, /id="mz-delivered">0</);
    assert.match(html, /id="mz-total">0</);
    assert.match(html, /width:0%/, 'total 0 → 0% sin dividir por cero');
    assert.ok(!/NaN/.test(html), 'ningún NaN en el markup');
    assert.match(html, /Ola actual/, 'label por defecto cuando falta');
});

// ── Regresión CA-7: el backlog NO se trunca (Gherkin de los 66 issues) ────────
test('CA-7 renderGroupedSSR renderiza TODOS los issues sin truncar (>200)', () => {
    const N = 240;
    const many = Array.from({ length: N }, (_, i) => ({
        number: i + 1, title: 'Issue ' + (i + 1), estadoActual: 'trabajando', labels: [],
    }));
    const html = issues.renderGroupedSSR(many);
    const cards = (html.match(/role="article"/g) || []).length;
    assert.strictEqual(cards, N, 'se renderizan los ' + N + ' issues, ningún slice() silencioso');
    assert.match(html, /class="iss-group-count">240</, 'el conteo de la sección refleja los 240');
});

test('CA-7 renderIssuesHTML no trunca el backlog inyectado por matrix (>200)', () => {
    const N = 210;
    const matrix = {};
    const priorityOrder = [];
    for (let i = 1; i <= N; i++) {
        matrix[String(i)] = { title: 'I' + i, faseActual: 'dev', estadoActual: 'trabajando', labels: [], bounces: 0 };
        priorityOrder.push(String(i));
    }
    // Contamos sólo dentro del <main> SSR: el script cliente contiene un
    // template '<article … role="article">' que sumaría un falso positivo.
    const html = issues.renderIssuesHTML({ matrix, priorityOrder });
    const main = html.slice(html.indexOf('id="issues-body"'), html.indexOf('</main>'));
    const cards = (main.match(/role="article"/g) || []).length;
    assert.strictEqual(cards, N, 'la página completa renderiza los ' + N + ' issues sin truncar');
});

test('el script cliente define moveIssue/pauseIssue propios (no gatea en window.*)', () => {
    const script = issues.renderIssuesClientScript();
    assert.match(script, /async function moveIssue\s*\(/, 'debe definir moveIssue local');
    assert.match(script, /async function pauseIssue\s*\(/, 'debe definir pauseIssue local');
    assert.ok(!/typeof window\.moveIssue === 'function'/.test(script), 'no debe gatear en window.moveIssue');
    assert.ok(!/typeof window\.pauseIssue === 'function'/.test(script), 'no debe gatear en window.pauseIssue');
});

// Ejecuta el IIFE del script cliente en un DOM falso y verifica que un click en
// los botones de acción dispara POST al endpoint correcto (cableado real, no no-op).
test('click en acciones de card hace POST /api/issue/<id>/<action> (CA-PO1)', async () => {
    const script = issues.renderIssuesClientScript();
    const calls = [];

    // Captura los handlers que el script registra sobre #issues-grid.
    const handlers = {};
    const grid = {
        addEventListener: (type, fn) => { handlers[type] = fn; },
    };
    const fakeEl = () => ({
        addEventListener: () => {},
        setAttribute: () => {},
        appendChild: () => {},
        style: {},
        textContent: '',
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    });
    const document = {
        readyState: 'complete',
        getElementById: (id) => (id === 'issues-grid' ? grid : null),
        querySelectorAll: () => [],
        createElement: () => fakeEl(),
        addEventListener: () => {},
        body: { appendChild: () => {} },
    };
    const window = { showToast: () => {} };
    const fetch = (url, opts) => {
        calls.push({ url, method: opts && opts.method });
        // /api/dash/pipeline (tickIssues inicial) → ok:false corta temprano.
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    };
    // #3953 — el script ahora consume los globals fetchJson (FETCH_CLIENT_JS) y
    // inConfirm (CONFIRM_MODAL_JS), inyectados aparte en la página real. Acá se
    // proveen fakes equivalentes: fetchJson delega al mock de fetch; inConfirm
    // confirma sin abrir modal real.
    const fetchJson = async (url, opts) => {
        const r = await fetch(url, opts);
        return r.ok ? r.json() : null;
    };
    const inConfirm = () => Promise.resolve(true);

    const run = new Function(
        'document', 'window', 'fetch', 'fetchJson', 'inConfirm', 'setInterval', 'setTimeout', 'confirm',
        script,
    );
    run(document, window, fetch, fetchJson, inConfirm, () => 0, () => 0, () => true);

    assert.strictEqual(typeof handlers.click, 'function', 'el grid debe tener handler de click');

    const evFor = (action, issue) => ({
        stopPropagation: () => {},
        target: {
            closest: (sel) => {
                if (sel === 'button[data-action]') {
                    return { getAttribute: (k) => (k === 'data-action' ? action : issue) };
                }
                return null;
            },
        },
    });

    handlers.click(evFor('move-up', '123'));
    handlers.click(evFor('move-top', '456'));
    handlers.click(evFor('pause', '789'));

    // pause ahora hace `await inConfirm(...)` antes del POST, por lo que el fetch
    // se difiere a un microtask. Drenar la cola antes de aseverar.
    await new Promise((resolve) => setImmediate(resolve));

    const urls = calls.map((c) => c.url);
    assert.ok(urls.includes('/api/issue/123/move-up'), 'move-up debe pegarle al endpoint');
    assert.ok(urls.includes('/api/issue/456/move-top'), 'move-top debe pegarle al endpoint');
    assert.ok(urls.includes('/api/issue/789/pause'), 'pause debe pegarle al endpoint');
    assert.ok(calls.every((c) => c.method === undefined || c.method === 'POST'),
        'las acciones usan POST');
});

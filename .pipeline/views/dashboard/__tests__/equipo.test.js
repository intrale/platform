// =============================================================================
// Tests de la ventana Equipo extraída del dashboard V3 (#3727, padre #3715).
//
// Cubre:
//   - renderEquipoSsr emite el contenedor #equipo + el grid de áreas + chips
//     (CA-A1: no perder funcionalidad; CA-G1: test SSR).
//   - renderEquipoSsr escapa los payloads XSS canónicos en name, tagline,
//     tooltip y color de persona (CA-B3 escape unificado, CA-D1 payload XSS).
//   - safeLogHref neutraliza href tipo `javascript:` venidos del filesystem.
//   - El HTML no filtra process.env ni paths absolutos del FS.
//   - Fallback visible cuando el state está vacío (sin skills).
//
// Runner: node --test .pipeline/views/dashboard/__tests__/equipo.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    renderEquipoSsr,
    eqAreaGrid,
    personaCard,
    skillHistoryStrip,
    safeColor,
    safeLogHref,
} = require('../equipo');

// Vectores XSS canónicos (alineados con el DoD de security del épico).
const XSS_VECTORS = [
    '"><img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    "';alert(1);//",
    '</script><script>alert(1)</script>',
    '&#x3C;script&#x3E;',
];

// Construye un state mínimo válido para renderEquipoSsr.
function baseState(overrides = {}) {
    return Object.assign({
        skillsByCategory: {
            dev: [['backend-dev', { running: 1, max: 2 }]],
            product: [['po', { running: 0, max: 1 }]],
        },
        recentBySkill: {
            'backend-dev': [{ issue: 10, resultado: 'aprobado', hasLog: true, logFile: 'bd-10.log' }],
        },
        skillUsageCount: { 'backend-dev': 5, po: 2 },
        skillStats: { 'backend-dev': { ok: 1, bad: 0, total: 1 } },
        agentPersona: {
            'backend-dev': { icon: '⚡', name: 'BackendDev', tagline: 'Fowler · Newman', color: '#3fb950' },
            po: { icon: '📋', name: 'PO', tagline: 'Cagan', color: '#d29922' },
        },
        categoryMeta: {
            dev: { label: 'Desarrollo', icon: '🛠', color: '#3fb950' },
            product: { label: 'Producto', icon: '🎯', color: '#d29922' },
        },
        pendientes: 3,
        activeStripHTML: '<div class="eq-active-cards"></div>',
        svcCardsHTML: '<div class="svc-layer"></div>',
    }, overrides);
}

test('renderEquipoSsr emite el contenedor #equipo, el grid de áreas y chips', () => {
    const html = renderEquipoSsr(baseState());
    assert.match(html, /id="equipo"/, 'falta id="equipo"');
    assert.match(html, /class="bar-section panel-equipo/, 'falta la clase panel-equipo');
    assert.match(html, /eq-areas-grid/, 'falta el grid de áreas');
    assert.match(html, /eq-chip/, 'falta al menos un chip de skill');
    // Header: con 2 skills (1 busy) → Activos 1/2, Utilización 50%, Cola 3.
    assert.match(html, /Activos <b>1<\/b>\/2/, 'totales del header incorrectos');
    assert.match(html, /Utilizacion <b>50%/, 'utilización incorrecta');
    assert.match(html, /Cola <b>3<\/b>/, 'cola incorrecta');
    // Los HTML pre-renderizados se inyectan tal cual.
    assert.match(html, /eq-active-cards/, 'falta activeStripHTML');
    assert.match(html, /eq-svc-section/, 'falta el bloque Servicios');
});

test('renderEquipoSsr escapa payloads XSS canónicos en nombre, tagline y tooltip', () => {
    for (const payload of XSS_VECTORS) {
        const st = baseState({
            agentPersona: {
                'backend-dev': { icon: 'i', name: payload, tagline: payload, color: '#3fb950' },
            },
            skillsByCategory: { dev: [['backend-dev', { running: 1, max: 1 }]] },
        });
        const html = renderEquipoSsr(st);
        // Ningún tag activo sobrevive: todo `<` del payload queda como entidad,
        // por lo que el `<img>`/`<script>` no se interpretan (quedan inertes como
        // texto escapado). Comprobamos que no exista ningún `<img`/`<script` real.
        assert.ok(!html.includes('<img src=x'), `<img> crudo presente para: ${payload}`);
        assert.ok(!html.includes('<script>alert(1)</script>'), `<script> crudo presente para: ${payload}`);
        // Si el payload trae `<`, debe aparecer escapado como &lt; en el output.
        if (payload.includes('<')) {
            assert.ok(html.includes('&lt;'), `el '<' no se escapó para: ${payload}`);
        }
        // Defensa fuerte: tras descartar las entidades &lt;, no debe quedar ningún
        // tag <img>/<script> crudo (un escape parcial dejaría el tag vivo).
        assert.ok(!/<img|<script/i.test(html.replace(/&lt;/g, '')), `tag crudo presente para: ${payload}`);
    }
});

test('renderEquipoSsr valida el color de persona contra CSS-injection', () => {
    const st = baseState({
        agentPersona: {
            'backend-dev': { icon: 'i', name: 'X', tagline: 't', color: 'red;background:url(//evil)' },
        },
        skillsByCategory: { dev: [['backend-dev', { running: 1, max: 1 }]] },
    });
    const html = renderEquipoSsr(st);
    assert.ok(!html.includes('url(//evil)'), 'color malicioso se interpoló en style');
    assert.match(html, /background:var\(--dim\)/, 'color inválido no cayó al fallback seguro');
});

test('safeColor acepta hex y var(), rechaza el resto', () => {
    assert.equal(safeColor('#3fb950'), '#3fb950');
    assert.equal(safeColor('#abc'), '#abc');
    assert.equal(safeColor('var(--ac)'), 'var(--ac)');
    assert.equal(safeColor('red'), 'var(--dim)');
    assert.equal(safeColor('red;background:url(x)'), 'var(--dim)');
    assert.equal(safeColor(null), 'var(--dim)');
    assert.equal(safeColor('javascript:alert(1)'), 'var(--dim)');
});

test('safeLogHref usa whitelist de prefijo + encodeURIComponent', () => {
    assert.equal(safeLogHref(null), null);
    const href = safeLogHref('javascript:alert(1)');
    assert.ok(href.startsWith('/logs/view/'), 'no usa el prefijo whitelisted');
    assert.ok(!href.startsWith('javascript:'), 'href empieza con esquema peligroso');
    assert.ok(!href.includes('javascript:'), 'href contiene javascript: sin codificar');
    assert.equal(safeLogHref('bd-10.log', true), '/logs/view/bd-10.log?live=1');
});

test('skillHistoryStrip escapa el href del log proveniente del filesystem', () => {
    const html = skillHistoryStrip({
        recentBySkill: { x: [{ issue: 1, resultado: 'aprobado', hasLog: true, logFile: 'javascript:alert(1)' }] },
    }, 'x');
    assert.ok(!html.includes('href="javascript:'), 'href javascript: crudo presente');
    assert.match(html, /href="\/logs\/view\//, 'no usó el prefijo whitelisted');
});

test('personaCard emite .persona-card y escapa el name', () => {
    const html = personaCard({
        agentPersona: { x: { icon: 'i', name: '"><img src=x onerror=alert(1)>', tagline: 't', color: '#fff' } },
        skillStats: {}, skillUsageCount: {},
    }, 'x', { running: 0, max: 1 });
    assert.match(html, /persona-card/, 'falta .persona-card');
    assert.ok(!html.includes('<img src=x'), '<img> crudo presente en persona-card');
});

test('renderEquipoSsr no filtra process.env ni paths absolutos del FS', () => {
    const html = renderEquipoSsr(baseState());
    assert.ok(!html.includes('process.env'), 'filtró process.env');
    assert.ok(!/[A-Za-z]:[\\/]Workspaces/.test(html), 'filtró un path absoluto del FS');
    assert.ok(!html.includes('credentials'), 'filtró referencia a credentials');
});

test('renderEquipoSsr cae a fallback visible cuando el state está vacío', () => {
    const html = renderEquipoSsr({});
    assert.match(html, /id="equipo"/, 'el fallback debe mantener el contenedor');
    assert.match(html, /Sin skills configurados/, 'falta el empty-label de skills');
    assert.match(html, /Activos <b>0<\/b>\/0/, 'totales del header vacío incorrectos');
});

test('eqAreaGrid devuelve totales coherentes con la lista de skills', () => {
    const grid = eqAreaGrid(baseState());
    assert.equal(grid.totalSkills, 2, 'totalSkills incorrecto');
    assert.equal(grid.totalBusy, 1, 'totalBusy incorrecto');
    assert.match(grid.html, /eq-areas-grid/);
    // Sin skills → html vacío, totales en 0.
    const empty = eqAreaGrid({});
    assert.equal(empty.html, '');
    assert.equal(empty.totalSkills, 0);
});

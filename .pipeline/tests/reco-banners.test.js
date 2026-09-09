// =============================================================================
// Tests de la vista de recomendaciones del dashboard tras #5678 (issue #5691).
// Cubre los CA E1 · E2 · E3 · E4 · E5.
//
// Regla transversal del issue: ningún CA se verifica por número de línea (las
// anclas del cuerpo están corridas ~130 commits) ni fija una constante numérica
// de producción. Todo se verifica por símbolo, por `grep` o por render.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const banners = require('../lib/reco-banners');

const RAIZ = path.join(__dirname, '..');
const DASHBOARD = path.join(RAIZ, 'dashboard.js');
const SPRITE = path.join(RAIZ, 'assets', 'icons', 'sprite.svg');
const MOCKUP = path.join(RAIZ, 'assets', 'mockups', '48-needs-human-vs-triage-backlog.svg');

const dashboardSrc = () => fs.readFileSync(DASHBOARD, 'utf8');

// =============================================================================
// E1 · Regresión del empty state
// =============================================================================

test('E1 · el empty state de reco-section no menciona needs-human', () => {
    const src = dashboardSrc();
    // Se localiza el bloque por su marca estructural, no por número de línea.
    const i = src.indexOf('Sin recomendaciones pendientes.');
    assert.ok(i > 0, 'el empty state debe existir');
    const bloque = src.slice(i, i + 400);
    assert.ok(!bloque.includes('needs-human'), 'el empty state describiría un modelo que #5678 eliminó');
    assert.ok(bloque.includes('needs:triage-backlog'), 'debe nombrar la cola de triaje vigente');
    assert.ok(bloque.includes('tipo:recomendacion'), 'y el discriminador de backlog');
});

// =============================================================================
// E2 · Banner de transición
// =============================================================================

test('E2 · el banner de transición nombra a #5678, es descartable y vive en la vista de recomendaciones', () => {
    const html = banners.renderTransitionBanner();
    assert.match(html, /#5678/, 'nombra la historia madre');
    assert.match(html, /reco-banner-transicion/);
    assert.match(html, /recoDescartarBanner/, 'es descartable');
    assert.match(html, /hidden/, 'nace oculto: se muestra sólo si no fue descartado');
    assert.match(html, /needs:triage-backlog/);
    // Dual-encoding (E6d): ícono + texto, no sólo color.
    assert.match(html, /ic-triage-backlog/, 'ícono del sprite, no sólo tinte');

    // Se inyecta en la sección de recomendaciones, no en el KPI.
    const src = dashboardSrc();
    assert.match(src, /renderTransitionBanner\(\)/);
    const iReco = src.indexOf('function renderRecommendationsSection');
    const iBanner = src.indexOf('renderTransitionBanner()', iReco);
    assert.ok(iBanner > iReco && iBanner - iReco < 2000, 'el banner se arma dentro del render de recomendaciones');
});

test('E2b · el banner NO se cuelga del KPI kpi-needs-human, que no lee el label de GitHub', () => {
    // Evidencia del CA (opción a): el KPI se alimenta de markers del filesystem.
    const humanBlock = fs.readFileSync(path.join(RAIZ, 'lib', 'human-block.js'), 'utf8');
    const m = humanBlock.match(/GITHUB_HUMAN_BLOCK_LABELS\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'existe la lista de labels de GitHub que el KPI considera');
    assert.ok(!m[1].includes('needs-human'), 'needs-human NO está: la migración no mueve el KPI');

    const src = dashboardSrc();
    const iKpi = src.indexOf('kpi-needs-human');
    assert.ok(iKpi > 0);
    const cerca = src.slice(Math.max(0, iKpi - 1500), iKpi + 1500);
    assert.ok(!cerca.includes('reco-banner-transicion'), 'el banner no se coloca sobre el KPI');
});

// =============================================================================
// E3 · Banner de truncamiento
// =============================================================================

test('E3 · el banner ámbar declara "Mostrando N de M" con M computado en runtime', () => {
    const html = banners.renderTruncationBanner({ mostrando: 200, total: 2108 });
    assert.match(html, /Mostrando 200 de 2108/);
    assert.match(html, /reco-banner-truncado/);
    assert.match(html, /github\.com\/search\?q=/, 'ofrece salida a la búsqueda completa');

    // El total sale del cache, no de una constante en el código.
    const src = fs.readFileSync(path.join(RAIZ, 'lib', 'reco-banners.js'), 'utf8');
    assert.ok(!/\b(200|924|1076|2104|2108)\b/.test(src.replace(/^[^\n]*\/\/.*$/gm, '')),
        'ninguna cifra de producción hardcodeada en el render');
    assert.match(dashboardSrc(), /renderTruncationBanner\(\{\s*mostrando: items\.length, total: cache\.totalAbiertas/);
});

test('E3b · sin total conocido, o sin truncamiento, no se inventa banner', () => {
    assert.strictEqual(banners.renderTruncationBanner({ mostrando: 12, total: null }), '');
    assert.strictEqual(banners.renderTruncationBanner({ mostrando: 12, total: 12 }), '');
    assert.strictEqual(banners.renderTruncationBanner({ mostrando: 12, total: 3 }), '');
    assert.strictEqual(banners.renderTruncationBanner({ mostrando: 12, total: 'DROP TABLE' }), '');
});

test('E3c · el cache de recomendaciones expone totalAbiertas y tolera caches viejos', () => {
    const reco = require('../lib/recommendations');
    assert.strictEqual(typeof reco.contarAbiertas, 'function');
    assert.strictEqual(reco._emptyCache().totalAbiertas, null, 'default seguro para caches pre-#5691');

    const ghFake = (args) => (args.includes('search/issues')
        ? { ok: true, stdout: '317\n', stderr: '', status: 0 }
        : { ok: false, stdout: '', stderr: 'no', status: 1 });
    assert.strictEqual(reco.contarAbiertas({ ghRunner: ghFake }), 317);
    assert.strictEqual(reco.contarAbiertas({ ghRunner: () => ({ ok: false, stdout: '', stderr: 'x', status: 1 }) }), null);
});

// =============================================================================
// REQ-SEC-C · XSS en los banners nuevos (A03)
// =============================================================================

test('SEC-C · los banners escapan toda interpolación y no aceptan conteos no numéricos', () => {
    const hostil = '"><script>alert(1)</script>';
    const conKey = banners.renderTransitionBanner({ key: hostil });
    assert.ok(!conKey.includes('<script>'), 'la clave del banner va escapada');

    // Los conteos nunca llegan crudos al DOM.
    assert.strictEqual(banners.conteoSeguro('12<script>'), null);
    assert.strictEqual(banners.conteoSeguro(-3), null);
    assert.strictEqual(banners.conteoSeguro('42'), 42);

    // El href se construye con encodeURIComponent y el repo se valida.
    assert.strictEqual(banners.urlBusquedaCompleta('malo repo; rm -rf /'), null);
    const url = banners.urlBusquedaCompleta('intrale/platform');
    assert.ok(!/[ <>"]/.test(url), 'la URL queda codificada');

    // Se usa el helper compartido, no un `esc()` nuevo.
    const src = fs.readFileSync(path.join(RAIZ, 'lib', 'reco-banners.js'), 'utf8');
    assert.match(src, /require\('\.\/escape-html'\)/);
    assert.ok(!/function\s+esc\s*\(/.test(src), 'no se introduce un escapador propio');

    // El estado del banner en localStorage es entrada no confiable: sólo se
    // compara contra un literal, nunca se inyecta.
    const dash = dashboardSrc();
    const i = dash.indexOf('function recoInitBanners');
    const bloque = dash.slice(i, i + 900);
    assert.ok(bloque.includes("!== '1'"), 'se compara contra un literal');
    assert.ok(!/innerHTML/.test(bloque), 'el valor leído nunca se inyecta en el DOM');
});

// =============================================================================
// E4 · La urgencia visual del panel de bloqueados queda intacta
// =============================================================================

test('E4 · el pulso rojo y el accent #B60205 del panel de bloqueados siguen intactos', () => {
    const src = dashboardSrc();
    assert.match(src, /#B60205/i, 'el accent de bloqueo real sobrevive');
    assert.match(src, /needs-human-pulse/, 'la animación de pulso sobrevive');
    assert.match(src, /kpi-needs-human/, 'el selector del KPI sobrevive');
});

test('E4b · la vista de triaje no toma el lenguaje visual de alarma', () => {
    const css = dashboardSrc();
    const i = css.indexOf('.reco-banner{');
    assert.ok(i > 0, 'el CSS de los banners existe');
    const bloque = css.slice(i, i + 1400);
    assert.ok(!/#B60205/i.test(bloque), 'sin rojo de incidente');
    assert.ok(!/pulse/i.test(bloque), 'sin pulso');
    assert.ok(!/INCIDENTE/i.test(bloque), 'sin badge de incidente');
    assert.match(bloque, /var\(--purple/, 'el acento sale del token --purple, no hardcodeado');

    const tokens = fs.readFileSync(path.join(RAIZ, 'assets', 'design-tokens.css'), 'utf8');
    assert.match(tokens, /--purple:/, 'el token existe en el design system');
});

// =============================================================================
// Regresión de arranque: el script del cliente vive dentro de un template
// literal de `dashboard.js`. Un backtick suelto —incluso en un comentario— lo
// cierra antes de tiempo y el dashboard muere al arrancar con SyntaxError, o
// sea que el pipeline se queda sin tablero. Barato de verificar, caro de
// descubrir en producción.
// =============================================================================

test('REGRESIÓN · dashboard.js parsea: ningún backtick suelto en el script del cliente', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['--check', DASHBOARD], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `dashboard.js no parsea:\n${r.stderr}`);

    // El bloque de banners no puede introducir backticks en esa zona.
    const src = dashboardSrc();
    const i = src.indexOf('function recoInitBanners');
    const j = src.indexOf('function recoRefresh');
    assert.ok(i > 0 && j > i);
    assert.ok(!src.slice(i, j).includes('`'), 'el bloque cliente de los banners no puede tener backticks');
});

// =============================================================================
// E5 · Assets de UX
// =============================================================================

test('E5 · el sprite suma ic-triage-backlog y conserva los tres símbolos que sólo existían en main', () => {
    const sprite = fs.readFileSync(SPRITE, 'utf8');
    for (const id of ['ic-triage-backlog', 'ic-dispatch-resumed', 'ic-dispatch-stalled', 'ic-watchdog-off']) {
        assert.ok(sprite.includes(`id="${id}"`), `falta el símbolo ${id}`);
    }
    assert.ok(fs.existsSync(MOCKUP), 'el mockup acordado está versionado');
});

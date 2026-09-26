// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// Tests de la vista de recomendaciones del dashboard tras #5678 (issue #5691).
// Cubre los CA E1 · E2 · E3 · E4 · E5 · E6-a (UX-2).
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
// E6-a / UX-2 · Tarjeta de KPI "Triaje de backlog" en la fila de KPI
// (mockup 48, superficie A: "Dos KPI, dos urgencias, dos destinos de click")
// =============================================================================

test('E6-a · la tarjeta kpi-triage-backlog es un contador no-alarma con ícono + texto', () => {
    const html = banners.renderTriageBacklogKpi({ total: 2222 });
    assert.match(html, /class="kpi kpi-triage-backlog kpi-clickable"/, 'es una tarjeta de la fila de KPI');
    assert.match(html, /Triaje de backlog/, 'texto del label (dual-encoding)');
    assert.match(html, /ic-triage-backlog/, 'ícono del sprite (dual-encoding)');
    assert.ok(html.includes('<div class="kpi-value">2222</div>'), 'el valor es el total recibido');
    assert.match(html, /no frenan ninguna ola/, 'copy del mockup: no es urgencia');
    assert.ok(html.includes('onclick="recoIrATriaje()"'), 'destino de click: la vista de triaje');
    assert.ok(!/toggleNeedsHumanPanel/.test(html), 'ningún click lleva al panel de incidentes');
    assert.ok(!/#B60205/i.test(html), 'sin rojo de incidente');
    assert.ok(!/pulse/i.test(html), 'sin pulso');
    assert.ok(!/danger|has-blocked|INCIDENTE/i.test(html), 'sin lenguaje visual de alarma');
    assert.ok(!/telegram/i.test(html), 'sin notificación');
});

test('E6-a-b · sin total conocido la tarjeta muestra "—" y lo dice; nunca degrada al conteo truncado', () => {
    for (const total of [null, undefined, '', 'x', -1, '12<script>']) {
        const html = banners.renderTriageBacklogKpi({ total });
        assert.match(html, /&mdash;/, 'valor desconocido → guion, no 0 (total=' + String(total) + ')');
        assert.match(html, /total sin sincronizar/);
        assert.ok(!html.includes('<script>'), 'nada crudo llega al DOM');
    }
    // 0 real sí es 0 (es distinto de "no sé").
    assert.ok(banners.renderTriageBacklogKpi({ total: 0 }).includes('<div class="kpi-value muted">0</div>'));
    // El onclick no interpola JS arbitrario.
    assert.ok(banners.renderTriageBacklogKpi({ total: 1, onclick: 'alert(1)//' }).includes('onclick="recoIrATriaje()"'));
});

test('E6-a-c · la tarjeta vive en la fila de KPI, pegada a NECESITAN HUMANO, y su valor es totalAbiertas (no items.length)', () => {
    const src = dashboardSrc();
    // 1) La fila pasa a 7 tarjetas y la de triaje va inmediatamente después de la roja.
    const iFila = src.indexOf('<div class="kpis kpis-' + String.fromCharCode(36) + '{recoKpiTriajeHTML ? 7 : 6}">');
    assert.ok(iFila > 0, 'la fila de KPI declara 7 columnas');
    const iRoja = src.indexOf('class="kpi kpi-needs-human', iFila);
    assert.ok(iRoja > iFila, 'NECESITAN HUMANO está en la fila');
    const iTriaje = src.indexOf(String.fromCharCode(36) + '{recoKpiTriajeHTML}', iRoja);
    assert.ok(iTriaje > iRoja && iTriaje - iRoja < 900, 'la tarjeta de triaje va justo al lado de NECESITAN HUMANO');
    const iCierre = src.indexOf('</div>', iTriaje);
    assert.ok(iCierre - iTriaje < 40, 'y cierra la fila: no hay otra tarjeta entre medio');
    assert.ok(src.includes('.kpis.kpis-7{') && src.includes('grid-template-columns:repeat(7,'), 'CSS de la fila de 7');

    // 2) El valor sale de cache.totalAbiertas — el mismo total que el banner E3.
    const iCalc = src.indexOf('const recoKpiTriajeHTML');
    assert.ok(iCalc > 0);
    const calc = src.slice(iCalc, iCalc + 600);
    assert.ok(calc.includes('readCache().totalAbiertas'), 'lee totalAbiertas del cache en runtime');
    assert.ok(calc.includes('renderTriageBacklogKpi({ total })'));
    assert.ok(!calc.includes('items.length'), 'NUNCA el conteo truncado del listado');

    // 3) Estética del token, no hardcodeada; sin alarma.
    const iCss = src.indexOf('.kpi.kpi-triage-backlog{');
    assert.ok(iCss > 0, 'CSS de la tarjeta');
    const css = src.slice(iCss, iCss + 500);
    assert.ok(css.includes('--kpi-accent:var(--purple'), 'acento del token --purple');
    assert.ok(!/#B60205/i.test(css), 'sin rojo de incidente');
    assert.ok(!/pulse/i.test(css), 'sin pulso');

    // 4) Destino del click: la vista de triaje, que ahora tiene id.
    assert.ok(src.includes('function recoIrATriaje()'), 'handler cliente definido');
    const iH = src.indexOf('function recoIrATriaje()');
    const handler = src.slice(iH, iH + 500);
    assert.ok(handler.includes("getElementById('reco-section')"));
    assert.match(handler, /scrollIntoView/);
    assert.ok(!/toggleNeedsHumanPanel|bloqueados-humano/.test(handler), 'ningún click lleva al otro lado');
    assert.ok(!handler.includes('`'), 'el handler vive dentro del script del cliente: sin backticks');
    assert.ok(src.includes('<details id="reco-section" class="collapse-section reco-section">'), 'reco-section (empty state) tiene id');
    assert.ok(src.includes('<details id="reco-section" class="collapse-section reco-section" open>'), 'reco-section (con items) tiene id');

    // 5) La tarjeta no dispara Telegram: el render puro no importa ni llama al
    //    notificador. Se mira el CÓDIGO sin comentarios: la cabecera del módulo
    //    sí nombra a Telegram, justamente para explicar que la tarjeta NO lo usa.
    const lib = fs.readFileSync(path.join(RAIZ, 'lib', 'reco-banners.js'), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    //    (el copy del banner E2 dice "no notifican": se buscan símbolos, no palabras)
    assert.ok(!/require\(['"][^'"]*(telegram|notif)/i.test(lib), 'no importa ningún notificador');
    assert.ok(!/\b(sendTelegram|sendMessage|notify\w*|telegram\w*)\s*\(/i.test(lib), 'no llama a ningún notificador');
    assert.ok(!/child_process|spawn|exec/.test(lib), 'render puro: no ejecuta nada');
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

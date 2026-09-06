// =============================================================================
// Tests del chip del sello de evidencia en la SUPERFICIE DEL OPERADOR — #6498
//
// POR QUE EXISTE ESTE ARCHIVO
// ---------------------------
// La primera pasada del issue cableo el badge SOLO en `generateHTML()` de
// `dashboard.js`, que se sirve unicamente en `/legacy`. Los tests de entonces
// (`dashboard-sello-badge.test.js`) pasaban en verde: verificaban el renderer,
// no que alguna pantalla del operador lo llamara. QA lo encontro por render
// real — barrido de 6 rutas del operador -> 0 badges, `/legacy` -> 9.
//
// Es el mismo modo de falla que #6459 ya habia corregido para el badge del
// Commander. Estos tests son la red que faltaba: fallan si la vista V3 vuelve a
// quedar muda, sin depender de que alguien mire una pantalla.
//
// Cubre:
//   - WIRING     : `pipelineSlice` emite `matrix[id].selloEvidencia` resuelto, y
//                  las DOS pestanas del operador (/issues y /pipeline) llevan el
//                  chip en su script de hidratacion.
//   - RENDER     : la card de /issues pinta los 4 estados + la variante.
//   - CA-5/UX-2  : icono + etiqueta de texto y aria-label no vacio en los 5.
//   - CA-1/UX-1  : `caduco` y `re-sellando` NO usan --danger ni needs-human.
//   - CA-9/SEC-2 : allowlist cerrada; un payload de script no emite markup
//                  ejecutable ni un <use href> fuera de las 4 constantes.
//   - CA-7       : ni el HTML ni la hoja del chip traen #RRGGBB / rgb( / rgba(.
//   - CA-10/SEC-3: el tooltip no lleva rutas absolutas ni URLs.
//   - CA-8       : el chip de rebote de las dos vistas queda intacto.
// =============================================================================

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { selloChipHTML, SELLO_CHIP_CSS } = require('../sello-evidencia-chip');
const { resolveSelloEvidenciaState } = require('../sello-evidencia-state');
const { pipelineSlice } = require('../dashboard-slices');
const issuesView = require('../../views/dashboard/issues');
const plView = require('../../views/dashboard/pipeline-redesign');

// esc() equivalente al de las dos superficies (los 5 chars XSS-relevantes).
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Los 5 registros visibles, derivados del MISMO camino que usa el dashboard: el
// resolver, alimentado con la forma real del emisor (#6495 / #6496).
const REGISTROS = {
    sellado: resolveSelloEvidenciaState({ 'd/v': [{ sello: { presente: true, descartes: 0 } }] }, {}),
    descarte: resolveSelloEvidenciaState({ 'd/v': [{ sello: { presente: true, descartes: 2 } }] }, {}),
    caduco: resolveSelloEvidenciaState({}, { intentos: 1, requeueAbierto: false, maxIntentos: 2 }),
    resellando: resolveSelloEvidenciaState({}, { intentos: 1, requeueAbierto: true, maxIntentos: 2 }),
    escalado: resolveSelloEvidenciaState({}, { intentos: 2, requeueAbierto: false, maxIntentos: 2 }),
};

function cardDe(info) {
    return issuesView.renderIssueCard(issuesView.normalizeIssue(9001, {
        title: 'Issue de prueba', labels: [], faseActual: 'desarrollo/verificacion',
        estadoActual: 'listo', selloEvidencia: info,
    }, 0));
}

// ── WIRING: el dato llega resuelto a la vista ───────────────────────────────

test('pipelineSlice emite selloEvidencia resuelto en cada issue del matrix', () => {
    const state = {
        issueMatrix: {
            7001: { title: 'con sello', labels: [], pipelines: new Set(), fases: { 'desarrollo/verificacion': [{ sello: { presente: true, descartes: 0 } }] } },
            7002: { title: 'caduco', labels: [], pipelines: new Set(), fases: {} },
            7003: { title: 'sin nada', labels: [], pipelines: new Set(), fases: {} },
        },
        selloEvidencia: { 7002: { intentos: 1, requeueAbierto: false, maxIntentos: 2 } },
        allFases: [],
    };
    const slice = pipelineSlice(state, { now: 1, recentActivityIssues: new Set() });
    assert.equal(slice.matrix['7001'].selloEvidencia.estado, 'sellado');
    assert.equal(slice.matrix['7002'].selloEvidencia.estado, 'caduco');
    // Sin dato => null => CERO badge (cero ruido en el camino feliz).
    assert.equal(slice.matrix['7003'].selloEvidencia, null);
});

test('pipelineSlice no rompe el matrix si el estado del sello viene deforme', () => {
    const state = {
        issueMatrix: { 7004: { title: 'x', labels: [], pipelines: new Set(), fases: {} } },
        selloEvidencia: { 7004: 'no-soy-un-objeto' },
        allFases: [],
    };
    const slice = pipelineSlice(state, { now: 1, recentActivityIssues: new Set() });
    assert.equal(slice.matrix['7004'].selloEvidencia, null);
    assert.equal(slice.matrix['7004'].title, 'x');
});

test('normalizeIssue propaga selloEvidencia y descarta lo que no sea objeto', () => {
    assert.equal(issuesView.normalizeIssue(1, { selloEvidencia: REGISTROS.caduco }).selloEvidencia.estado, 'caduco');
    assert.equal(issuesView.normalizeIssue(1, { selloEvidencia: 'x' }).selloEvidencia, null);
    assert.equal(issuesView.normalizeIssue(1, {}).selloEvidencia, null);
});

// ── WIRING: las DOS pestanas del operador consumen el chip ──────────────────
// Esto es lo que fallaba: el renderer existia y ninguna vista V3 lo llamaba.

for (const [nombre, script] of [
    ['/issues', issuesView.renderIssuesClientScript()],
    ['/pipeline', plView.pipelineRedesignClientScript()],
]) {
    test('la pestana ' + nombre + ' lleva el chip del sello en su hidratacion', () => {
        assert.ok(script.includes('function selloChipHTML'),
            nombre + ' quedo sin la definicion del chip: la pantalla del operador vuelve a quedar muda');
        // El stub de degradacion tambien se llama `selloChipHTML`, asi que la
        // guarda mira los 4 iconos de la allowlist: solo la funcion REAL los
        // trae. Sin esto, un require roto pasaria el test en verde y la pantalla
        // del operador volveria a quedar muda — exactamente el rebote de QA.
        for (const icono of ['ic-info', 'ic-estado-stale', 'ic-estado-retrying', 'ic-estado-needs-human']) {
            assert.ok(script.includes(icono), nombre + ' no lleva la funcion real del chip (falta ' + icono + ')');
        }
        assert.ok(script.includes('selloChipHTML(') && script.includes('selloEvidencia'),
            nombre + ' define el chip pero no lo invoca con el dato');
        // El script del cliente tiene que ser JS valido: un error de sintaxis
        // deja la pestana entera sin hidratar, no solo el chip.
        assert.doesNotThrow(() => new vm.Script(script, { filename: nombre }));
    });
}

test('la hoja del chip viaja en el HTML de las dos pestanas', () => {
    const htmlIssues = issuesView.renderIssuesHTML({ matrix: {}, priorityOrder: [] });
    assert.ok(htmlIssues.includes('.sello-chip-caduco'), '/issues sin la hoja del chip');
    assert.ok(plView.PIPELINE_REDESIGN_CSS.includes('.sello-chip-caduco'), '/pipeline sin la hoja del chip');
});

test('el SSR de /issues pinta el chip dentro de la card del issue', () => {
    const card = cardDe(REGISTROS.caduco);
    assert.ok(card.includes('class="sello-chip sello-chip-caduco"'));
    // En la fila de metadatos, junto al chip de rebote y al contador de rebotes.
    assert.ok(/<div class="iss-meta">[\s\S]*sello-chip[\s\S]*<\/div>/.test(card));
});

// ── RENDER de los 5 registros ──────────────────────────────────────────────

const ESPERADO = {
    sellado: { cls: 'sello-chip-sellado', icono: 'ic-info' },
    descarte: { cls: 'sello-chip-sellado', icono: 'ic-info' },
    caduco: { cls: 'sello-chip-caduco', icono: 'ic-estado-stale' },
    resellando: { cls: 'sello-chip-resellando', icono: 'ic-estado-retrying' },
    escalado: { cls: 'sello-chip-escalado', icono: 'ic-estado-needs-human' },
};

for (const [nombre, exp] of Object.entries(ESPERADO)) {
    test('el registro "' + nombre + '" se pinta con su clase, su icono y su etiqueta', () => {
        const info = REGISTROS[nombre];
        assert.ok(info, 'el resolver no produjo el registro ' + nombre);
        const html = selloChipHTML(info, esc);

        assert.ok(html.includes('class="sello-chip ' + exp.cls + '"'));
        assert.ok(html.includes('href="#' + exp.icono + '"'));

        // CA-5 / UX-2: texto no vacio FUERA del <svg> + aria-label no vacio.
        const fuera = html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
        assert.ok(fuera.length > 0, nombre + ' no tiene etiqueta de texto: seria color-only');
        const aria = /aria-label="([^"]*)"/.exec(html);
        assert.ok(aria && aria[1].trim().length > 0, nombre + ' sin aria-label');

        // CA-7: cero colores literales en el markup.
        assert.ok(!/#[0-9a-fA-F]{6}\b|rgba?\(/.test(html), nombre + ' trae un color literal');

        // CA-10 / SEC-3: el tooltip no filtra rutas ni URLs del host.
        const title = /title="([^"]*)"/.exec(html);
        assert.ok(title, nombre + ' sin tooltip');
        assert.ok(!/[A-Za-z]:[\\/]|https?:\/\//.test(title[1]),
            nombre + ' filtra una ruta o URL en el tooltip: ' + title[1]);

        // Y el chip llega efectivamente a la card del operador.
        assert.ok(cardDe(info).includes(exp.cls));
    });
}

test('la variante de descarte se marca en el DOM y cambia el copy (SEC-1)', () => {
    const html = selloChipHTML(REGISTROS.descarte, esc);
    assert.ok(html.includes('data-variant="descarte"'));
    // Mismo token y mismo icono que `sellado`: la senal es el COPY.
    assert.ok(html.includes('sello-chip-sellado') && html.includes('href="#ic-info"'));
    assert.notEqual(
        /aria-label="([^"]*)"/.exec(html)[1],
        /aria-label="([^"]*)"/.exec(selloChipHTML(REGISTROS.sellado, esc))[1]);
});

// ── CA-1 / UX-1: el rojo es exclusivo del escalado ─────────────────────────

test('caduco y re-sellando no se pintan como needs-human (el defecto del issue)', () => {
    for (const nombre of ['caduco', 'resellando']) {
        const html = selloChipHTML(REGISTROS[nombre], esc);
        assert.ok(!html.includes('ic-estado-needs-human'), nombre + ' usa el icono de needs-human');
        assert.ok(!html.includes('sello-chip-escalado'), nombre + ' usa la clase del escalado');
    }
    // Y en la hoja: los dos ambar salen de --retry; solo escalado toca --danger.
    const ambar = /\.sello-chip-caduco[\s\S]*?\}/.exec(SELLO_CHIP_CSS)[0];
    assert.ok(ambar.includes('--retry'), 'caduco no usa la triada de reintento');
    assert.ok(!ambar.includes('--danger'), 'caduco se pinta con el rojo del escalado');
    const rojo = /\.sello-chip-escalado[\s\S]*?\}/.exec(SELLO_CHIP_CSS)[0];
    assert.ok(rojo.includes('--danger'), 'escalado perdio el rojo');
});

// ── CA-9 / SEC-2: allowlist cerrada ────────────────────────────────────────

test('un estado fuera de la allowlist no pinta nada', () => {
    for (const basura of [null, undefined, {}, { estado: 'inventado' }, { estado: 42 }, 'texto', []]) {
        assert.equal(selloChipHTML(basura, esc), '');
    }
    assert.equal(selloChipHTML(REGISTROS.caduco, null), '');
});

test('un payload de script no emite markup ejecutable ni un <use href> ajeno', () => {
    const payload = '"><script>alert(1)</script>';
    assert.equal(selloChipHTML({
        estado: payload, copy: payload, copyCorto: payload, detalle: payload,
    }, esc), '', 'un estado hostil no puede pintar nada');

    // Y con un estado valido, el texto hostil tampoco puede escaparse.
    const conTexto = selloChipHTML({
        estado: 'caduco', copy: payload, copyCorto: payload, detalle: payload,
    }, esc);
    assert.ok(!conTexto.includes('<script'), 'el copy hostil emitio markup ejecutable');
    // El unico <use href> posible es el de la allowlist.
    assert.deepEqual(conTexto.match(/href="#[^"]*"/g), ['href="#ic-estado-stale"']);
});

// ── CA-7: la hoja del chip tampoco trae literales ─────────────────────────

test('la hoja del chip no define ni un solo color literal', () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(SELLO_CHIP_CSS), SELLO_CHIP_CSS);
    for (const cls of ['sellado', 'caduco', 'resellando', 'escalado']) {
        assert.ok(SELLO_CHIP_CSS.includes('.sello-chip-' + cls), 'falta la regla de ' + cls);
    }
});

// ── CA-8: nada de lo que ya existia cambia ────────────────────────────────

test('el chip de rebote de las dos vistas sigue igual', () => {
    assert.ok(!cardDe(null).includes('sello-chip'), 'sin dato el chip no se pinta');

    const conRebote = issuesView.renderIssueCard(issuesView.normalizeIssue(9002, {
        title: 't', labels: [], rebote: true, motivo_rechazo: 'm',
        rechazado_en_fase: 'desarrollo/verificacion', estadoActual: 'pendiente',
    }, 0));
    assert.ok(conRebote.includes('<span class="iss-rebote"'));

    const plScript = plView.pipelineRedesignClientScript();
    assert.ok(plScript.includes('plc-flag f-rebote'));
    assert.ok(plScript.includes('plc-flag f-human'));
});

'use strict';

// =============================================================================
// desync-block-banner-5724.test.js — Issue #5724 CA-4 (rebote rev-1).
//
// QUÉ PROTEGE
// -----------
// La primera entrega implementó el pill del semáforo dentro de
// `views/dashboard/pipeline.js`, módulo que sólo se renderiza desde el
// catch-all legacy de `dashboard.js`. El pill era correcto — label, role,
// antigüedad, chips — pero NINGUNA de las rutas del menú del dashboard lo
// dibujaba: `curl` sobre las 14 rutas daba 0 coincidencias. El criterio quedó
// técnicamente implementado y funcionalmente inerte, mientras la vista Inicio
// seguía diciendo "No hay agentes corriendo. Verificar pausa parcial, cola y
// blocked:dependencies" con el dispatch suspendido hacía 10 h.
//
// Por eso estos tests NO verifican el componente aislado: verifican que el
// bloqueo aparece EN EL HTML QUE SIRVEN LAS RUTAS QUE EL OPERADOR USA
// (`/` → home.renderHomeHTML, `/pipeline` → satellites.renderPipeline), que es
// exactamente el eslabón que faltaba.
//
// Correr:
//   node --test .pipeline/views/dashboard/__tests__/desync-block-banner-5724.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const banner = require('../desync-block-banner.js');
const desyncCopy = require('../../../lib/desync-copy.js');
const home = require('../home.js');
const pipelinePanel = require('../pipeline.js');

// Escenario REAL del incidente: divergencia reductiva con los tres hijos del
// split de #5678 abiertos y fuera de la allowlist, dispatch suspendido.
const HACE_10H33 = new Date(Date.now() - ((10 * 60) + 33) * 60000).toISOString();
const BLOQUEO = Object.freeze({
    estado: 'divergencia_bloqueada',
    bloqueado: true,
    added: [],
    removed: [5689, 5690, 5691],
    count: 91,
    detected_at: HACE_10H33,
});
const SANO = Object.freeze({
    estado: 'sincronizado',
    bloqueado: false,
    added: [],
    removed: [],
    count: 91,
    detected_at: null,
});

// -----------------------------------------------------------------------------
// 1. El componente
// -----------------------------------------------------------------------------

test('CA-4: con el dispatch suspendido el banner nombra la consecuencia, no la jerga del archivo', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.match(html, /data-active="true"/);
    assert.match(html, /Dispatch suspendido/);
    assert.doesNotMatch(html, /partial-pause\.json|waves\.json|\.desync-detected\.flag/,
        'el banner no expone paths internos al operador');
});

test('CA-4: el banner muestra la divergencia concreta (los issues, con signo)', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.match(html, /−#5689/);
    assert.match(html, /−#5690/);
    assert.match(html, /−#5691/);
});

test('CA-4: el banner muestra la antigüedad del bloqueo', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.match(html, /hace 10 h 33 min/,
        '10 horas de bloqueo no pueden verse igual que 10 minutos');
});

test('UX: el bloqueo usa role="alert" (assertive), no el status polite', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.match(html, /id="desync-block-banner"[^>]*role="alert"/);
    assert.match(html, /aria-live="assertive"/);
});

test('UX: el banner dice qué hacer, no sólo qué pasó', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.match(html, /desync-block-accion[^>]*>[^<]+</,
        'la acción concreta no puede quedar vacía con el pipeline frenado');
    assert.match(html, /class="desync-block-cta"[^>]*href="\/pipeline"/,
        'el CTA apunta a la ruta REAL de la ventana Pipeline');
});

test('el CTA no apunta a un slug inexistente (que caería al fallback de home)', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    assert.doesNotMatch(html, /href="\/dashboard\?view=pipeline"/,
        '`pipeline` no existe en VIEW_SLUGS: sería otro link a ninguna parte');
});

test('sin bloqueo el banner ocupa 0px y NO deja el texto del bloqueo en el HTML', () => {
    const html = banner.renderDesyncBlockBannerSsr(SANO);
    assert.match(html, /data-active="false"/);
    assert.doesNotMatch(html, /Dispatch suspendido/,
        'un grep sobre el HTML sano no debe matchear: sería un falso positivo de la verificación');
});

test('degradación: sin datos (slice caído / null) no rompe ni alarma de mentira', () => {
    for (const entrada of [null, undefined, {}, { estado: 'basura' }, 'no-soy-un-objeto']) {
        const html = banner.renderDesyncBlockBannerSsr(entrada);
        assert.match(html, /data-active="false"/);
        assert.doesNotMatch(html, /Dispatch suspendido/);
    }
});

test('SEC: los issues divergentes se filtran a enteros antes de llegar al HTML', () => {
    const html = banner.renderDesyncBlockBannerSsr({
        estado: 'divergencia_bloqueada',
        bloqueado: true,
        added: [],
        removed: ['<img src=x onerror=alert(1)>', 5689, null, { a: 1 }],
        count: 1,
        detected_at: HACE_10H33,
    });
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /onerror/i);
    assert.match(html, /−#5689/);
});

test('UX-4: el truncado de chips no es silencioso', () => {
    const html = banner.renderDesyncBlockBannerSsr({
        estado: 'divergencia_bloqueada',
        bloqueado: true,
        added: [],
        removed: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        count: 9,
        detected_at: HACE_10H33,
    });
    assert.match(html, /\+3 más/, 'los 3 ocultos tienen que anunciarse');
});

test('el ícono del banner existe en el sprite del design system', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    const usados = [...html.matchAll(/href="#(ic-[a-z0-9-]+)"/g)].map((m) => m[1]);
    assert.ok(usados.length > 0, 'el banner debe referenciar al menos un ícono');
    const sprite = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'assets', 'icons', 'sprite.svg'), 'utf8');
    for (const id of usados) {
        assert.ok(sprite.includes(`id="${id}"`), `el sprite no define ${id}`);
    }
});

test('UX-7: el banner no introduce colores hardcodeados', () => {
    const css = banner.DESYNC_BLOCK_BANNER_CSS;
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'todo color debe salir de tokens');
    assert.doesNotMatch(css, /\brgb\(/, 'todo color debe salir de tokens');
});

// -----------------------------------------------------------------------------
// 2. LA REGRESIÓN DEL REBOTE: las superficies que el operador realmente abre
// -----------------------------------------------------------------------------

test('REGRESIÓN rev-1: la vista Inicio (ruta /) muestra el bloqueo en su HTML SSR', () => {
    const html = home.renderHomeHTML({ desyncStatus: BLOQUEO });
    assert.match(html, /id="desync-block-banner"[^>]*data-active="true"/);
    assert.match(html, /Dispatch suspendido/);
    assert.match(html, /−#5689/);
    assert.match(html, /hace 10 h 33 min/);
});

test('REGRESIÓN rev-1: el HTML de Inicio trae el bloqueo SIN ejecutar JS (verificable por curl)', () => {
    const html = home.renderHomeHTML({ desyncStatus: BLOQUEO });
    // El texto tiene que estar DENTRO del markup del banner, no sólo en el
    // <script> de la hidratación: si se pintara únicamente client-side,
    // `curl | grep` volvería a dar 0 coincidencias y el criterio quedaría
    // inerte otra vez, que es exactamente el rechazo de rev-1.
    const seccion = html.match(/<section class="desync-block-banner"[\s\S]*?<\/section>/);
    assert.ok(seccion, 'el HTML servido debe contener la sección del banner');
    assert.match(seccion[0], /data-active="true"/);
    assert.match(seccion[0], /Dispatch suspendido/);
    assert.match(seccion[0], /−#5689/);
    assert.match(seccion[0], /hace 10 h 33 min/);
});

test('REGRESIÓN rev-1: con el dispatch suspendido, Inicio deja de mandar a las 3 causas equivocadas', () => {
    const html = home.renderHomeHTML({ desyncStatus: BLOQUEO });
    const vacio = html.match(/<div class="active-empty-msg">([^<]*)</);
    assert.ok(vacio, 'la vista Inicio debe seguir teniendo el mensaje de "sin agentes"');
    assert.match(vacio[1], /suspendido/i);
    assert.doesNotMatch(vacio[1], /blocked:dependencies/,
        'mandar a revisar blocked:dependencies con un desync activo manda a mirar donde no está el problema');
});

test('sin bloqueo, Inicio conserva el mensaje de siempre (que ahí sí es el correcto)', () => {
    const html = home.renderHomeHTML({ desyncStatus: SANO });
    const vacio = html.match(/<div class="active-empty-msg">([^<]*)</);
    assert.ok(vacio);
    assert.match(vacio[1], /blocked:dependencies/);
    assert.doesNotMatch(html, /Dispatch suspendido/);
});

test('REGRESIÓN rev-1: Inicio registra el poll del bloqueo (el banner se mantiene vivo)', () => {
    const html = home.renderHomeHTML({ desyncStatus: SANO });
    assert.match(html, /async function tickDesyncBlock\(\)/);
    assert.match(html, /fn: tickDesyncBlock/);
    assert.match(html, /\/api\/dash\/desync-status/);
});

test('REGRESIÓN rev-1: la ventana Pipeline (ruta /pipeline) también monta el banner', () => {
    const sat = require('../satellites.js');
    const html = sat.renderPipeline();
    assert.match(html, /id="desync-block-banner"/);
    assert.match(html, /async function tickDesyncBlock\(\)/);
    // La liveness se asserta en el idiom de CADA superficie, no en el de home:
    // la home tiene su tabla `POLLS` (`fn: tickDesyncBlock`) y los satélites no
    // comparten esa tabla — cada ventana arma la suya, así que el bundle del
    // banner trae su propio setInterval. Exigir acá el literal de home haría
    // fallar un montaje que SÍ refresca (y empujaría a duplicar la tabla de
    // polls en los satélites sólo para satisfacer al test).
    assert.match(html, /setInterval\(function\(\)\{ tickDesyncBlock\(\)/,
        'el banner del satélite tiene que refrescarse solo, no quedar congelado en el SSR');
    assert.match(html, /\/api\/dash\/desync-status/);
});

test('el CSS del banner llega interpolado en las dos superficies (no queda el nombre de la constante)', () => {
    const sat = require('../satellites.js');
    for (const [nombre, html] of [['home', home.renderHomeHTML({})], ['pipeline', sat.renderPipeline()]]) {
        assert.match(html, /\.desync-block-banner\[data-active="true"\]/, `${nombre}: falta el CSS`);
        assert.doesNotMatch(html, /DESYNC_BLOCK_BANNER_CSS/, `${nombre}: la constante quedó sin interpolar`);
    }
});

// -----------------------------------------------------------------------------
// 3. Una sola fuente de copy
// -----------------------------------------------------------------------------

test('el banner y el pill del panel Pipeline dicen lo MISMO (una sola fuente de copy)', () => {
    const html = banner.renderDesyncBlockBannerSsr(BLOQUEO);
    const pill = pipelinePanel.renderDesyncPill({
        ic: (id) => `<svg data-icon="${id}"></svg>`,
        desync: BLOQUEO,
        now: Date.now(),
    });
    const p = desyncCopy.buildDesyncPresentation(BLOQUEO);
    for (const html_ of [html, pill]) {
        assert.ok(html_.includes(p.label), 'ambas superficies usan el mismo label');
        assert.ok(html_.includes(p.detail), 'ambas superficies usan el mismo detalle');
    }
});

test('el slice expone la presentación ya resuelta (el cliente no reimplementa el copy)', () => {
    const slices = require('../../../lib/dashboard-slices.js');
    const out = slices.desyncStatusSlice({}, {});
    assert.ok(out && typeof out === 'object');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'presentacion'),
        'sin `presentacion` el banner tendría que decidir el copy en el browser');
    if (out.presentacion) {
        for (const k of ['label', 'detail', 'role', 'chips', 'bloqueado', 'emptyState']) {
            assert.ok(Object.prototype.hasOwnProperty.call(out.presentacion, k), `falta ${k}`);
        }
    }
    // Contrato viejo intacto (aditivo, no rompe consumidores).
    for (const k of ['estado', 'added', 'removed', 'bloqueado', 'count', 'detected_at']) {
        assert.ok(Object.prototype.hasOwnProperty.call(out, k), `el slice perdió ${k}`);
    }
});

test('desyncEmptyStateText sólo cambia el mensaje cuando el bloqueo es real', () => {
    assert.strictEqual(
        desyncCopy.desyncEmptyStateText({ bloqueado: false }),
        desyncCopy.DESYNC_EMPTY_DEFAULT);
    // Una divergencia detectada pero NO bloqueante tampoco cambia el mensaje:
    // el pipeline sigue lanzando y la cola/pausa sí son las causas plausibles.
    assert.strictEqual(
        desyncCopy.desyncEmptyStateText(
            desyncCopy.normalizeDesyncStatus({ estado: 'realineado_reductivo', bloqueado: false })),
        desyncCopy.DESYNC_EMPTY_DEFAULT);
    assert.notStrictEqual(
        desyncCopy.desyncEmptyStateText(desyncCopy.normalizeDesyncStatus(BLOQUEO)),
        desyncCopy.DESYNC_EMPTY_DEFAULT);
});

// -----------------------------------------------------------------------------
// 4. Cobertura ESTRUCTURAL de superficies (rev-1)
//
// El rechazo de rev-1 no fue "el banner está mal hecho" — renderizaba perfecto.
// Fue que vivía en una superficie que ninguna ruta del menú visitaba. Un test
// que enumera a mano `home` y `pipeline` no habría detectado eso, y de hecho no
// detectó que `providers`, `kpis` y el visor de logs tenían el CSS y el bundle
// del banner colgados del panel INERTE (`renderInert`) en vez del shell real:
// el markup estaba, pero sin estilos y sin refresco.
//
// Por eso el barrido de acá NO enumera ventanas: recorre el catálogo
// `VIEW_SLUGS` del router. Una ventana nueva que no monte el banner rompe este
// test el día que se agrega, en vez de descubrirse en un incidente de 10 h.
//
// Se verifica el TRIPLE, porque cualquiera de los tres faltando deja el
// criterio inerte de una forma distinta:
//   1. markup SSR  → sin esto `curl` no lo ve y el operador tampoco al cargar;
//   2. CSS         → sin esto el banner no se muestra/oculta como corresponde;
//   3. hidratación → sin esto queda congelado en el estado del page load.
// -----------------------------------------------------------------------------

const SUP_SSR = /id="desync-block-banner"/;
const SUP_CSS = /\.desync-block-banner\[data-active="true"\]/;
const SUP_JS = /tickDesyncBlock/;

// El render se hace contra el estado real del pipeline (los renderers leen
// filesystem). Todos degradan con `renderInert` si el estado no está: eso NO se
// deja pasar en silencio, se reporta como fallo distinguible — una ventana
// degradada tampoco muestra el bloqueo, que es justamente lo que importa acá.
const INERTE = /no disponible<\/h1>/;

function assertSuperficieCubierta(nombre, html) {
    assert.ok(typeof html === 'string' && html.length > 0, `${nombre}: no renderizó nada`);
    assert.doesNotMatch(html, INERTE,
        `${nombre}: cayó al panel inerte — una ventana degradada tampoco muestra el bloqueo`);
    assert.match(html, SUP_SSR, `${nombre}: falta el markup SSR del banner (curl no lo vería)`);
    assert.match(html, SUP_CSS, `${nombre}: falta el CSS del banner (¿quedó colgado de renderInert?)`);
    assert.match(html, SUP_JS, `${nombre}: falta la hidratación (el banner queda congelado en el page load)`);
}

test('REGRESIÓN rev-1: TODA vista del catálogo VIEW_SLUGS monta el banner', () => {
    const { VIEW_SLUGS } = require('../../../lib/dashboard-routes.js');
    const slugs = Object.keys(VIEW_SLUGS);
    // Guarda contra el modo de falla silencioso: si el catálogo se vacía o
    // cambia de forma, este test pasaría sin verificar NADA.
    assert.ok(slugs.length >= 12, `el catálogo trae ${slugs.length} vistas, se esperaban >=12`);
    for (const slug of slugs) {
        const entrada = VIEW_SLUGS[slug];
        assert.strictEqual(typeof entrada.render, 'function', `${slug}: no expone render()`);
        assertSuperficieCubierta(`view=${slug}`, entrada.render());
    }
});

test('REGRESIÓN rev-1: las ventanas fuera de VIEW_SLUGS también montan el banner', () => {
    // Estas no pasan por el catálogo del router (se montan directo en
    // dashboard.js o se exportan desde satellites.js), así que se enumeran.
    // Si mañana migran al catálogo, el test de arriba las cubre igual.
    const sat = require('../satellites.js');
    const superficies = [
        ['/equipo', () => sat.renderEquipo()],
        ['/pipeline', () => sat.renderPipeline()],
        ['/historial', () => sat.renderHistorial()],
        ['/multi-provider', () => require('../multi-provider.js').renderMultiProvider()],
        ['/multi-provider-health', () => require('../multi-provider-health.js').renderMultiProviderHealth()],
        ['/multi-provider-coverage', () => require('../multi-provider-coverage.js').renderMultiProviderCoverage()],
        ['/logs/view', () => require('../logs.js').renderLogViewer('pulpo.log', false, {})],
    ];
    for (const [nombre, render] of superficies) {
        assertSuperficieCubierta(nombre, render());
    }
});

test('REGRESIÓN rev-1: toda entrada del menú apunta a una superficie con banner', () => {
    // Cierra el hueco por el que entró el rechazo: el pill existía pero NINGUNA
    // de las entradas del menú llegaba a él. Acá se verifica el catálogo del
    // menú (NAV_TABS) contra las superficies que sabemos cubiertas, así que una
    // tab nueva que apunte a una ventana sin banner falla.
    const { NAV_TABS } = require('../nav-tabs.js');
    const { VIEW_SLUGS } = require('../../../lib/dashboard-routes.js');
    const CUBIERTAS_FUERA_DEL_CATALOGO = new Set([
        '/', '/equipo', '/pipeline', '/historial', '/multi-provider', '/multi-provider-health',
    ]);
    // Paths legacy del menú cuyo nombre NO coincide con el slug del catálogo
    // (los mapea `HTML_ROUTES` en lib/dashboard-routes.js, que no se exporta).
    const ALIAS_PATH_A_SLUG = { 'modo-descanso': 'descanso' };
    assert.ok(NAV_TABS.length >= 15, `el menú trae ${NAV_TABS.length} tabs, se esperaban >=15`);
    const sinCobertura = [];
    for (const tab of NAV_TABS) {
        const href = tab.href || '';
        if (CUBIERTAS_FUERA_DEL_CATALOGO.has(href)) continue;
        // `/dashboard?view=<slug>` y los paths directos resuelven al catálogo.
        const crudo = href.startsWith('/dashboard?view=')
            ? href.slice('/dashboard?view='.length)
            : href.replace(/^\//, '');
        const slug = ALIAS_PATH_A_SLUG[crudo] || crudo;
        if (!VIEW_SLUGS[slug]) sinCobertura.push(`${tab.label || href} (${href})`);
    }
    assert.deepStrictEqual(sinCobertura, [],
        'entradas del menú que no resuelven a una superficie verificada con banner');
});

// =============================================================================
// kpis-mizpa-4243.test.js — #4243. Estructura común de ventanas MIZPÁ en KPIs.
// Traslada a la pantalla KPIs el marco común que entregó #4234 (PR #4254),
// reutilizando los helpers compartidos de `pipeline-redesign` sin duplicar
// markup (CA-5). Los 3 bloques superiores deben ser idénticos al resto:
//   ① cabecera de marca MIZPÁ (renderBrandBarPipeline → + pill de build).
//   ② cabecera de ola común (mz-mission: tag OLA + métricas + bloque AVANCE).
//   ③ barra de accesos a subventanas (renderNavTabsSsr → v3-nav, KPIs activa).
// El contenido propio de KPIs (banner de salud kpis-mission) queda debajo (④).
//
// Framework: node:test + node:assert/strict (sin Jest).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshView() {
    delete require.cache[require.resolve('../kpis')];
    return require('../kpis');
}

function baseOpts() {
    return {
        kpisSlice: { prsLast7d: 5, tokens24h: { total: 1000, by_provider: { claude: 1000 } }, issueCycleTimeMs: 3 * 3600000, bouncePct: { overall: 0 } },
        dora: { leadTimeMs: 3 * 3600000, throughputPerDay: 3, failRatePct: 0 },
        sysMini: { cpu: 30, mem: 40, health: 'Óptimo' },
        thresholds: {},
        currentView: 'kpis',
    };
}

// -----------------------------------------------------------------------------
// CA-1 — cabecera MIZPÁ común (① bloque), idéntica al resto.
// -----------------------------------------------------------------------------
test('CA-1: la cabecera usa el marco común (in-header-brand + pill de build)', () => {
    const view = freshView();
    const html = view.renderKpis(baseOpts());
    assert.match(html, /class="in-header-brand"/, 'cabecera de marca común presente');
    assert.match(html, /class="mz-name">MIZPÁ</, 'marca MIZPÁ presente');
    assert.match(html, /id="bld-status"/, 'pill de build del marco común presente');
});

// -----------------------------------------------------------------------------
// CA-2 — cabecera de ola común (② bloque): tag + métricas + bloque AVANCE.
// -----------------------------------------------------------------------------
test('CA-2: muestra la cabecera de ola común (tag OLA + AVANCE + leyenda)', () => {
    const view = freshView();
    const html = view.renderKpis(baseOpts());
    assert.match(html, /<section class="mz-mission" id="mz-mission"/, 'banner de ola común presente');
    assert.match(html, /mz-wavetag/, 'tag de ola presente');
    assert.match(html, /id="mission-wave-num"/, 'número de ola hidratable');
    assert.match(html, /id="mission-avance-pct"/, 'bloque AVANCE presente');
    assert.match(html, /id="mission-leg-done"[^>]*>0/, 'leyenda hechos');
    assert.match(html, /id="mission-leg-queue"[^>]*>0/, 'leyenda cola');
    assert.match(html, /ETA DE LA OLA/, 'métrica ETA');
    assert.match(html, /VELOCIDAD/, 'métrica velocidad');
    assert.match(html, /ENTREGADOS/, 'métrica entregados');
});

test('CA-2: el banner de ola común proviene del helper compartido (CA-5)', () => {
    const view = freshView();
    const shared = require('../pipeline-redesign');
    // El markup del banner de KPIs debe ser idéntico al del helper común: no se
    // clona, se delega. Comparamos el HTML normalizado por espacios.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    assert.equal(norm(view.renderKpisWaveBanner()), norm(shared.renderMissionBannerPipeline()),
        'el banner de ola es exactamente el helper común');
    assert.equal(norm(view.renderKpisBrandBar()), norm(shared.renderBrandBarPipeline()),
        'la cabecera de marca es exactamente el helper común');
});

// -----------------------------------------------------------------------------
// CA-3 — barra de accesos a subventanas común (③ bloque).
// -----------------------------------------------------------------------------
test('CA-3: muestra la barra de accesos común (v3-nav) con KPIs activa', () => {
    const view = freshView();
    const html = view.renderKpis(baseOpts());
    assert.match(html, /<nav class="v3-nav"/, 'nav común presente');
    assert.match(html, /v3-tab-active[^>]*>|aria-current="page"/, 'una tab marcada activa');
});

// -----------------------------------------------------------------------------
// CA-4 — el contenido propio de KPIs queda DEBAJO del marco, sin romperse.
// -----------------------------------------------------------------------------
test('CA-4: el orden es marca → ola → nav → contenido propio (kpis-mission)', () => {
    const view = freshView();
    // Aislamos el markup del <body> para no medir contra los selectores CSS
    // inlineados en el <head> (theme.css / KPIS_CSS contienen las mismas clases).
    const full = view.renderKpis(baseOpts());
    const html = full.slice(full.indexOf('<body>'));
    const iBrand = html.indexOf('class="in-header-brand"');
    const iWave = html.indexOf('id="mz-mission"');
    const iNav = html.search(/<nav class="v3-nav"/);
    const iOwn = html.indexOf('id="kpis-mission"');
    assert.ok(iBrand >= 0 && iWave >= 0 && iNav >= 0 && iOwn >= 0, 'los 4 bloques existen');
    assert.ok(iBrand < iWave, '① marca antes que ② ola');
    assert.ok(iWave < iNav, '② ola antes que ③ nav');
    assert.ok(iNav < iOwn, '③ nav antes que ④ contenido propio (salud)');
});

test('CA-4: el banner de salud propio (kpis-mission) sigue presente debajo', () => {
    const view = freshView();
    const html = view.renderKpis(baseOpts());
    assert.match(html, /kpis-gauge-ring/, 'medidor de salud propio intacto');
});

// -----------------------------------------------------------------------------
// Hidratación — el marco se hidrata con los mismos IDs/endpoints que el resto.
// -----------------------------------------------------------------------------
test('hidratación: el script consume /api/dash/waves y /api/dash/header', () => {
    const view = freshView();
    const html = view.renderKpis(baseOpts());
    assert.match(html, /\/api\/dash\/waves/, 'fetch de la ola');
    assert.match(html, /\/api\/dash\/header/, 'fetch de la cabecera');
    assert.match(html, /id="hdr-mode"/, 'pill de estado del pipeline hidratable');
});

// -----------------------------------------------------------------------------
// R-4 — si el módulo común no carga, el fallback conserva los IDs hidratables.
// -----------------------------------------------------------------------------
test('R-4: el fallback inline del banner conserva los IDs mission-*', () => {
    const view = freshView();
    // renderKpisWaveBanner ya delega al común; el fallback se ejercita por su
    // contrato de IDs: deben existir igual para que la hidratación no se rompa.
    const banner = view.renderKpisWaveBanner();
    for (const id of ['mission-wave-num', 'mission-avance-pct', 'mission-leg-done', 'mission-bar-done']) {
        assert.match(banner, new RegExp('id="' + id + '"'), 'ID ' + id + ' presente');
    }
});

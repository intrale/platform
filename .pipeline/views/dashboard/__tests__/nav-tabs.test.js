// =============================================================================
// Tests de la barra de navegacion unificada V3 (#3726).
//
// Cubre:
//   - NAV_TABS tiene exactamente 12 entradas con el orden esperado y la forma
//     { slug, label, iconId, href, ariaLabel } (CA-1, CA-2).
//   - renderNavTabsSsr('equipo') marca exactamente 1 tab con aria-current="page"
//     y emite los 12 <a class="v3-tab"> (CA-3).
//   - renderNavTabsSsr('<slug-invalido>') NO inyecta el string crudo en el
//     HTML (defensa anti-XSS reclamada por security en #3726, vector A03).
//   - El HTML emitido NO contiene <script>, onclick=, ni javascript: (CA-4).
//   - Cada iconId del catalogo existe como <symbol id="…"> en sprite.svg
//     (anti-desincronizacion al renombrar iconos, CA-6).
//   - opts.badgeForSlug se invoca y su retorno se concatena dentro del <a>
//     manteniendo los <span class="area-pill-badge"> historicos (CA-10).
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/nav-tabs.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    NAV_TABS,
    renderNavTabsSsr,
    loadIconSprite,
    _resetSpriteCacheForTests,
} = require('..' + path.sep + 'nav-tabs.js');

const SPRITE_PATH = path.resolve(__dirname, '..', '..', '..', 'assets', 'icons', 'sprite.svg');

// ---------------------------------------------------------------------------
// NAV_TABS — inventario y forma de cada entrada
// ---------------------------------------------------------------------------

test('NAV_TABS tiene exactamente 12 entradas en el orden esperado (CA-1)', () => {
    assert.equal(NAV_TABS.length, 12, 'NAV_TABS debe tener 12 tabs');
    const expectedOrder = [
        'home', 'equipo', 'pipeline', 'bloqueados', 'issues', 'matriz',
        'ops', 'kpis', 'historial', 'costos', 'descanso', 'providers',
    ];
    assert.deepEqual(NAV_TABS.map(t => t.slug), expectedOrder);
});

test('cada NAV_TABS tiene { slug, label, iconId, href, ariaLabel } no vacios (CA-2)', () => {
    for (const tab of NAV_TABS) {
        for (const field of ['slug', 'label', 'iconId', 'href', 'ariaLabel']) {
            assert.equal(typeof tab[field], 'string', `${tab.slug}.${field} debe ser string`);
            assert.ok(tab[field].length > 0, `${tab.slug}.${field} no debe ser vacio`);
        }
        assert.ok(tab.href.startsWith('/'), `${tab.slug}.href debe empezar con "/"`);
    }
});

test('NAV_TABS preserva href reales para descanso/providers (CA-2)', () => {
    const descanso = NAV_TABS.find(t => t.slug === 'descanso');
    const providers = NAV_TABS.find(t => t.slug === 'providers');
    assert.equal(descanso.href, '/modo-descanso');
    assert.equal(providers.href, '/multi-provider');
});

// ---------------------------------------------------------------------------
// renderNavTabsSsr — marcado SSR
// ---------------------------------------------------------------------------

test('renderNavTabsSsr emite <nav class="v3-nav"> con role=navigation y aria-label', () => {
    const html = renderNavTabsSsr('home');
    assert.match(html, /<nav class="v3-nav" role="navigation" aria-label="Ventanas del dashboard">/);
    assert.match(html, /<\/nav>$/);
});

test('renderNavTabsSsr emite exactamente 12 anchors class="v3-tab" (CA-3)', () => {
    const html = renderNavTabsSsr('equipo');
    const matches = html.match(/<a class="v3-tab(?: v3-tab-active)?"/g) || [];
    assert.equal(matches.length, 12, `Esperaba 12 anchors v3-tab, obtuve ${matches.length}`);
});

test('renderNavTabsSsr marca SOLO la tab activa con aria-current="page" (CA-3)', () => {
    const html = renderNavTabsSsr('equipo');
    const currentMatches = html.match(/aria-current="page"/g) || [];
    assert.equal(currentMatches.length, 1, 'Debe haber exactamente 1 aria-current');
    // La activa lleva tambien la clase v3-tab-active
    assert.match(html, /<a class="v3-tab v3-tab-active" href="\/equipo"[^>]*aria-current="page"/);
});

test('renderNavTabsSsr sin activeSlug no marca ninguna tab', () => {
    const html = renderNavTabsSsr('');
    assert.equal((html.match(/aria-current="page"/g) || []).length, 0);
    assert.equal((html.match(/v3-tab-active/g) || []).length, 0);
});

test('cada anchor tiene aria-label no vacio (CA-4)', () => {
    const html = renderNavTabsSsr('home');
    const ariaMatches = html.match(/aria-label="[^"]+"/g) || [];
    // 12 anchors + 1 del <nav> = 13 aria-labels
    assert.ok(ariaMatches.length >= 13, `Esperaba >=13 aria-labels, obtuve ${ariaMatches.length}`);
    // ninguno puede estar vacio
    for (const m of ariaMatches) {
        assert.doesNotMatch(m, /aria-label=""/);
    }
});

test('cada <svg> del icono lleva aria-hidden="true" y focusable="false" (CA-4)', () => {
    const html = renderNavTabsSsr('home');
    const svgMatches = html.match(/<svg [^>]*>/g) || [];
    assert.equal(svgMatches.length, 12, 'Debe haber 12 <svg> de tab');
    for (const svg of svgMatches) {
        assert.match(svg, /aria-hidden="true"/, `svg sin aria-hidden: ${svg}`);
        assert.match(svg, /focusable="false"/, `svg sin focusable=false: ${svg}`);
    }
});

// ---------------------------------------------------------------------------
// Defensas anti-XSS (vector A03 del security comment)
// ---------------------------------------------------------------------------

test('renderNavTabsSsr no inyecta activeSlug crudo cuando es desconocido (anti-XSS)', () => {
    const html = renderNavTabsSsr('<script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /alert\(1\)/);
});

test('el HTML emitido no contiene <script>, onclick= ni javascript: (CA-4)', () => {
    const html = renderNavTabsSsr('home');
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /\bonclick=/i);
    assert.doesNotMatch(html, /\bjavascript:/i);
    assert.doesNotMatch(html, /<foreignObject\b/i);
});

// ---------------------------------------------------------------------------
// Sincronizacion con sprite.svg (CA-6)
// ---------------------------------------------------------------------------

test('cada iconId de NAV_TABS existe como <symbol id="…"> en sprite.svg (CA-6)', () => {
    const sprite = fs.readFileSync(SPRITE_PATH, 'utf8');
    for (const tab of NAV_TABS) {
        const symbolPattern = new RegExp(`<symbol[^>]*\\bid="${tab.iconId}"`);
        assert.match(sprite, symbolPattern, `Falta <symbol id="${tab.iconId}"> para tab "${tab.slug}"`);
    }
});

test('sprite.svg no contiene patrones de XSS (script/foreignObject/handlers)', () => {
    const raw = fs.readFileSync(SPRITE_PATH, 'utf8');
    // Eliminar comentarios XML/HTML antes de testear (el header del archivo
    // documenta los patrones prohibidos, lo que generaria falsos positivos).
    const sprite = raw.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(sprite, /<script\b/i, 'sprite no debe contener <script>');
    assert.doesNotMatch(sprite, /<foreignObject\b/i, 'sprite no debe contener <foreignObject>');
    assert.doesNotMatch(sprite, /\son[a-z]+\s*=/i, 'sprite no debe contener handlers on*=');
    assert.doesNotMatch(sprite, /href\s*=\s*"(http|https|data|javascript):/i, 'sprite no debe contener hrefs externos');
});

// ---------------------------------------------------------------------------
// loadIconSprite — cache compartido
// ---------------------------------------------------------------------------

test('loadIconSprite devuelve el contenido del sprite y cachea el resultado', () => {
    _resetSpriteCacheForTests();
    const first = loadIconSprite();
    const second = loadIconSprite();
    assert.ok(first.length > 100, 'sprite cargado debe tener contenido real');
    assert.equal(first, second, 'segunda llamada debe devolver el mismo string');
    assert.match(first, /<symbol[^>]*id="ic-tab-home"/, 'sprite debe incluir los iconos nuevos');
});

// ---------------------------------------------------------------------------
// opts.badgeForSlug — interop con tickers existentes (CA-10)
// ---------------------------------------------------------------------------

test('renderNavTabsSsr llama badgeForSlug con cada slug y concatena el resultado', () => {
    const seen = [];
    const html = renderNavTabsSsr('home', {
        badgeForSlug: (slug) => {
            seen.push(slug);
            if (slug === 'equipo') return '<span class="area-pill-badge" id="badge-equipo">7</span>';
            return null;
        },
    });
    assert.deepEqual(seen, NAV_TABS.map(t => t.slug), 'badgeForSlug se llama una vez por tab en orden');
    assert.match(html, /<span class="area-pill-badge" id="badge-equipo">7<\/span>/);
    // Solo equipo recibe badge
    assert.equal((html.match(/area-pill-badge/g) || []).length, 1);
});

test('renderNavTabsSsr sin badgeForSlug no emite area-pill-badge', () => {
    const html = renderNavTabsSsr('home');
    assert.doesNotMatch(html, /area-pill-badge/);
});

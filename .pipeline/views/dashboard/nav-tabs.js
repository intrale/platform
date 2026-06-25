'use strict';

// ============================================================================
// Issue #3726 — Barra de navegacion unificada del Dashboard V3
// ----------------------------------------------------------------------------
// Modulo compartido entre home.js y satellites.js. Centraliza:
//   1. NAV_TABS: catalogo de 12 tabs (orden fijo + slug + label + iconId + href +
//      ariaLabel literal hardcoded).
//   2. renderNavTabsSsr(activeSlug): markup SSR de <nav class="v3-nav"> que se
//      inyecta en home y en cada satelite.
//   3. loadIconSprite(): lectura cacheada del sprite.svg, compartida entre
//      home y satellites para que ambos contextos puedan usar <use href="#id">.
//
// Razon de existir como modulo separado en vez de exportar desde home.js:
//   - satellites.js no requiere a home.js hoy, y home.js no requiere a
//     satellites.js. Exportar renderNavTabsSsr desde home obligaria a uno de
//     los dos a importar al otro, creando un ciclo de require.
//   - nav-tabs.js permanece <100 LOC y cubre una unica responsabilidad.
//
// Politica de slugs (alineada con #3715 — convencion minuscula sin acentos):
//   - "modo-descanso" -> "descanso"
//   - "multi-provider" -> "providers"
//   Los href mantienen las URLs reales registradas en lib/dashboard-routes.js
//   para no romper screenshot-capture.js (ALLOWED_PATHS) ni los enlaces
//   externos. Cuando #3723 (router cliente ?view=) este mergeado, este array
//   puede cambiar los href a "/dashboard?view=<slug>" sin tocar el resto del
//   HTML — el render no depende de la forma del href.
//
// Seguridad (heredado del comment de security en #3726):
//   - aria-label y label son STRINGS LITERALES en el array. Nunca concatenar
//     con datos externos / query params / state.
//   - renderNavTabsSsr nunca refleja activeSlug crudo en el DOM: solo lo
//     compara contra los slugs conocidos para activar una tab.
// ============================================================================

const fs = require('fs');
const path = require('path');

// TODO #3723: cuando el router cliente este mergeado, opcionalmente cambiar
// los href a "/dashboard?view=<slug>" y agregar comentario "// #3723 integrado".
// Verificado al momento del commit: #3723 sigue OPEN -> mantener URLs satelite
// literales (estan en ALLOWED_PATHS de screenshot-capture.js).
const NAV_TABS = [
    { slug: 'home',       label: 'Inicio',     iconId: 'ic-tab-home',           href: '/',               ariaLabel: 'Ir a Inicio' },
    { slug: 'equipo',     label: 'Equipo',     iconId: 'ic-agents-count',       href: '/equipo',         ariaLabel: 'Ir a Equipo - agentes y carga' },
    { slug: 'pipeline',   label: 'Pipeline',   iconId: 'ic-tab-pipeline',       href: '/pipeline',       ariaLabel: 'Ir a Pipeline - issues por fase' },
    { slug: 'bloqueados', label: 'Bloqueados', iconId: 'ic-estado-needs-human', href: '/bloqueados',     ariaLabel: 'Ir a Bloqueados - esperando humano' },
    { slug: 'issues',     label: 'Issues',     iconId: 'ic-issues-count',       href: '/issues',         ariaLabel: 'Ir a Issues - backlog' },
    { slug: 'matriz',     label: 'Matriz',     iconId: 'ic-tab-matriz',         href: '/matriz',         ariaLabel: 'Ir a Matriz - skill por fase' },
    { slug: 'ops',        label: 'Ops',        iconId: 'ic-tab-ops',            href: '/ops',            ariaLabel: 'Ir a Ops - procesos e infra' },
    { slug: 'kpis',       label: 'KPIs',       iconId: 'ic-tab-kpis',           href: '/kpis',           ariaLabel: 'Ir a KPIs - metricas detalladas' },
    { slug: 'historial',  label: 'Historial',  iconId: 'ic-tab-historial',      href: '/historial',      ariaLabel: 'Ir a Historial - eventos del pipeline' },
    { slug: 'costos',     label: 'Costos',     iconId: 'ic-tab-costos',         href: '/costos',         ariaLabel: 'Ir a Costos - tokens y consumo' },
    { slug: 'descanso',   label: 'Descanso',   iconId: 'ic-rest-mode',          href: '/modo-descanso',  ariaLabel: 'Ir a Descanso - ventana horaria' },
    { slug: 'providers',  label: 'Providers',  iconId: 'ic-multi-provider',     href: '/multi-provider', ariaLabel: 'Ir a Providers - proveedores y fallbacks' },
    // EP8-H12 (#3965) — pantalla de salud multi-provider (metricas, matriz, Sherlock).
    { slug: 'mp-health',  label: 'Salud MP',   iconId: 'ic-health-ok',          href: '/multi-provider-health', ariaLabel: 'Ir a Salud Multi-Provider - metricas, matriz y Sherlock' },
];

// renderNavTabsSsr(activeSlug, opts)
//   Devuelve el HTML del <nav class="v3-nav"> con 12 anchors. La tab cuyo
//   slug matchea activeSlug recibe aria-current="page" + clase v3-tab-active.
//   Si activeSlug no matchea ninguno, ninguna tab queda activa pero
//   activeSlug NO se interpola en el HTML — esto es defensa anti-XSS para
//   el patron ?view=<input> (vector A03 del comment de security).
//
//   opts.badgeForSlug (opcional, function(slug) -> string|null|undefined):
//     Permite a home.js inyectar el <span class="area-pill-badge"> con id
//     "badge-<area>" dentro de cada tab para que los tickers existentes
//     (`tickMultiProvider`, hidratacion de counts en el slice) sigan
//     funcionando durante la transicion (CA-10). El string devuelto se
//     concatena ANTES del <svg>. Si el callback no se provee o devuelve
//     null/undefined para un slug, ese tab no lleva badge.
//     IMPORTANTE: el callback es responsable de devolver HTML seguro — el
//     consumidor (home.js) debe garantizar que el badge no introduce XSS.
function renderNavTabsSsr(activeSlug, opts) {
    const badgeForSlug = (opts && typeof opts.badgeForSlug === 'function')
        ? opts.badgeForSlug
        : null;
    const items = NAV_TABS.map((t) => {
        const isActive = t.slug === activeSlug;
        const activeAttr = isActive ? ' aria-current="page"' : '';
        const activeCls = isActive ? ' v3-tab-active' : '';
        const badgeHtml = badgeForSlug ? (badgeForSlug(t.slug) || '') : '';
        // Todos los valores interpolados del array son literales hardcoded.
        // No requieren escape. NO concatenar nunca con activeSlug ni con datos
        // externos en esta plantilla. El badgeHtml es responsabilidad del
        // consumidor (ver doc de opts.badgeForSlug).
        return (
            `<a class="v3-tab${activeCls}" href="${t.href}" aria-label="${t.ariaLabel}"${activeAttr}>` +
                badgeHtml +
                `<svg class="v3-tab-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">` +
                    `<use href="#${t.iconId}"></use>` +
                `</svg>` +
                `<span class="v3-tab-label">${t.label}</span>` +
            `</a>`
        );
    }).join('');
    return `<nav class="v3-nav" role="navigation" aria-label="Ventanas del dashboard">${items}</nav>`;
}

// loadIconSprite()
//   Lee .pipeline/assets/icons/sprite.svg y lo cachea en memoria del proceso.
//   El consumidor lo inyecta inline dentro del <body> (oculto con
//   display:none / overflow:hidden), asi <use href="#ic-tab-*"> resuelve
//   sin pedir el SVG por HTTP.
//
//   Si el archivo no se puede leer, devuelve "" — el render queda sin iconos
//   pero la nav sigue funcional (labels de texto son accesibles solas).
let _spriteCache = null;
function loadIconSprite() {
    if (_spriteCache !== null) return _spriteCache;
    try {
        _spriteCache = fs.readFileSync(
            path.join(__dirname, '..', '..', 'assets', 'icons', 'sprite.svg'),
            'utf8'
        );
    } catch (_) {
        _spriteCache = '';
    }
    return _spriteCache;
}

// Helper para tests: limpia el cache del sprite. NO exportarlo para uso en
// produccion — el cache es intencional para evitar I/O en cada render.
function _resetSpriteCacheForTests() {
    _spriteCache = null;
}

module.exports = {
    NAV_TABS,
    renderNavTabsSsr,
    loadIconSprite,
    _resetSpriteCacheForTests,
};

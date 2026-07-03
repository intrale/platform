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
// #4189 — Nav curada MIZPÁ: tabs esenciales SIEMPRE visibles + el resto
// colapsado en un popover "⋯ Más". El campo `primary` (1..N) define el orden
// fijo de la barra. Las tabs sin `primary` viven en el popover, cada una con su
// `desc` (mini-descripcion).
// #4454 — Orden fijo de la barra actualizado a: Inicio · Pipeline · Roadmap ·
// Providers (4 primarias). Issues, Bloqueados y Costos pasan al popover "⋯ Más"
// (siguen alcanzables, ninguna ruta se pierde).
// El catalogo, hrefs, iconId y ariaLabel se preservan intactos: todas las tabs
// siguen siendo <a class="v3-tab"> alcanzables (no se elimina ninguna ruta ni
// se rompe screenshot-capture / badges / hidratacion de counts).
const NAV_TABS = [
    { slug: 'home',       label: 'Inicio',     iconId: 'ic-tab-home',           href: '/',               ariaLabel: 'Ir a Inicio',                                              primary: 1 },
    { slug: 'equipo',     label: 'Equipo',     iconId: 'ic-agents-count',       href: '/equipo',         ariaLabel: 'Ir a Equipo - agentes y carga',                            desc: 'Roles y agentes del pipeline' },
    { slug: 'pipeline',   label: 'Pipeline',   iconId: 'ic-tab-pipeline',       href: '/pipeline',       ariaLabel: 'Ir a Pipeline - issues por fase',                          primary: 2 },
    { slug: 'bloqueados', label: 'Bloqueados', iconId: 'ic-estado-needs-human', href: '/bloqueados',     ariaLabel: 'Ir a Bloqueados - esperando humano',                       desc: 'Issues frenados esperando humano o dependencias' },
    { slug: 'issues',     label: 'Issues',     iconId: 'ic-issues-count',       href: '/issues',         ariaLabel: 'Ir a Issues - backlog',                                    desc: 'Backlog de issues del pipeline' },
    { slug: 'matriz',     label: 'Matriz',     iconId: 'ic-tab-matriz',         href: '/matriz',         ariaLabel: 'Ir a Matriz - skill por fase',                             desc: 'Heatmap issues × fases' },
    // #4378 — Roadmap de olas (activa / planificadas / archivadas + archivar).
    // #4373 — Vista operativa consolidada (avance · bloqueos · ETA). Ícono dedicado
    // `ic-tab-roadmap` (ruta de hitos ascendente) producido por UX, distinto de
    // `ic-wave` (ondas) para diferenciar la tab del roadmap.
    { slug: 'roadmap',    label: 'Roadmap',    iconId: 'ic-tab-roadmap',        href: '/roadmap',        ariaLabel: 'Ir a Roadmap - olas activa, planificadas, archivadas, avance, bloqueos y ETA', desc: 'Roadmap de olas · avance · bloqueos · ETA · archivar', primary: 3 },
    { slug: 'ops',        label: 'Ops',        iconId: 'ic-tab-ops',            href: '/ops',            ariaLabel: 'Ir a Ops - procesos e infra',                              desc: 'Topología y salud de servicios' },
    { slug: 'kpis',       label: 'KPIs',       iconId: 'ic-tab-kpis',           href: '/kpis',           ariaLabel: 'Ir a KPIs - metricas detalladas',                          desc: 'Métricas de entrega' },
    { slug: 'historial',  label: 'Historial',  iconId: 'ic-tab-historial',      href: '/historial',      ariaLabel: 'Ir a Historial - eventos del pipeline',                    desc: 'Timeline de actividad' },
    { slug: 'costos',     label: 'Costos',     iconId: 'ic-tab-costos',         href: '/costos',         ariaLabel: 'Ir a Costos - tokens y consumo',                           desc: 'Tokens y consumo por sesión y agente' },
    { slug: 'descanso',   label: 'Descanso',   iconId: 'ic-rest-mode',          href: '/modo-descanso',  ariaLabel: 'Ir a Descanso - ventana horaria',                          desc: 'Ventana y modo reposo' },
    { slug: 'providers',  label: 'Providers',  iconId: 'ic-multi-provider',     href: '/providers',      ariaLabel: 'Ir a Providers - proveedores y fallbacks',                 desc: 'Proveedores · salud · cadena de fallback', primary: 4 },
    // EP8-H12 (#3965) — pantalla de salud multi-provider (metricas, matriz, Sherlock).
    { slug: 'mp-health',  label: 'Salud MP',   iconId: 'ic-health-ok',          href: '/multi-provider-health', ariaLabel: 'Ir a Salud Multi-Provider - metricas, matriz y Sherlock', desc: 'Salud multi-provider' },
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
    // #4189 — Una sola pasada en el orden de NAV_TABS para preservar el contrato
    // de `badgeForSlug` (se invoca una vez por slug, en orden — CA-10). Cada
    // anchor mantiene su markup historico (clase `v3-tab`, svg, badge); el
    // reparto primario/secundario es puramente de UBICACION (barra vs popover).
    const bySlug = {};
    let activeIsSecondary = false;
    NAV_TABS.forEach((t) => {
        const isActive = t.slug === activeSlug;
        const activeAttr = isActive ? ' aria-current="page"' : '';
        const activeCls = isActive ? ' v3-tab-active' : '';
        const badgeHtml = badgeForSlug ? (badgeForSlug(t.slug) || '') : '';
        const isSecondary = !t.primary;
        if (isActive && isSecondary) activeIsSecondary = true;
        // Mini-descripcion SOLO para los items del popover (literal hardcoded del
        // catalogo, sin datos externos — no requiere escape). Para las tabs de
        // la barra el CSS la oculta igual; no se emite para no inflar el markup.
        const descHtml = (isSecondary && t.desc)
            ? `<span class="v3-tab-desc">${t.desc}</span>`
            : '';
        // Todos los valores interpolados del array son literales hardcoded.
        // No requieren escape. NO concatenar nunca con activeSlug ni con datos
        // externos en esta plantilla. El badgeHtml es responsabilidad del
        // consumidor (ver doc de opts.badgeForSlug).
        bySlug[t.slug] = (
            `<a class="v3-tab${activeCls}" href="${t.href}" aria-label="${t.ariaLabel}"${activeAttr}>` +
                badgeHtml +
                `<svg class="v3-tab-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">` +
                    `<use href="#${t.iconId}"></use>` +
                `</svg>` +
                `<span class="v3-tab-label">${t.label}</span>` +
                descHtml +
            `</a>`
        );
    });

    // Barra: las primarias en su orden fijo (primary 1..N). Popover: el resto
    // en el orden del catalogo.
    const primaries = NAV_TABS.filter((t) => t.primary)
        .sort((a, b) => a.primary - b.primary)
        .map((t) => bySlug[t.slug])
        .join('');
    const secondaries = NAV_TABS.filter((t) => !t.primary);
    const secondaryItems = secondaries.map((t) => bySlug[t.slug]).join('');
    const moreCount = secondaries.length;

    // Popover nativo con <details>/<summary>: sin JS, accesible por teclado y
    // funciona identico en home y en cada satelite (ambos comparten este modulo).
    // El attr `open` se aplica cuando la vista activa es secundaria, para que la
    // tab activa quede visible sin un click extra.
    const openAttr = activeIsSecondary ? ' open' : '';
    const moreActiveCls = activeIsSecondary ? ' v3-more-active' : '';
    const more =
        `<details class="v3-more${moreActiveCls}"${openAttr}>` +
            `<summary class="v3-more-btn" aria-label="Más secciones del dashboard" ` +
                    `title="Secciones adicionales del dashboard (en evaluación)">` +
                `<span class="v3-more-dots" aria-hidden="true">⋯</span>` +
                `<span class="v3-more-text">Más</span>` +
                `<span class="v3-more-count" aria-hidden="true">${moreCount}</span>` +
            `</summary>` +
            `<div class="v3-more-menu" role="menu" aria-label="Secciones adicionales">` +
                `<div class="v3-more-head">SECCIONES ADICIONALES · EN EVALUACIÓN</div>` +
                secondaryItems +
            `</div>` +
        `</details>`;

    return `<nav class="v3-nav" role="navigation" aria-label="Ventanas del dashboard">${primaries}${more}</nav>`;
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

// #4454 (defecto 3) — Auto-cierre del popover "⋯ Más".
//
// El popover usa <details>/<summary> nativo (degradacion sin JS), pero <details>
// nativo NO se cierra ni al clickear afuera ni al elegir una opcion — de ahi el
// bug del "segundo click". Este script enriquece el comportamiento:
//   - cierra al click fuera del <details>.
//   - cierra al click sobre un <a class="v3-tab"> del menu (navegacion).
//   - cierra con Escape y devuelve el foco al <summary> (a11y — guideline UX).
//
// Idempotente: guard `window.__v3MoreAutoClose` para no registrar el listener
// dos veces en re-render (requisito de security — evita leaks de listeners).
// Delegacion en `document` con `closest()` para acotar el target.
//
// Se retorna como STRING para inyectarse dentro del <script> principal de home.js
// y satellites.js (ambas vistas comparten renderNavTabsSsr). Sin datos externos
// interpolados — es un literal estatico, sin superficie XSS.
function navMoreAutoCloseClientScript() {
    return `
if (!window.__v3MoreAutoClose) {
    window.__v3MoreAutoClose = true;
    document.addEventListener('click', function (ev) {
        document.querySelectorAll('details.v3-more[open]').forEach(function (d) {
            if (!d.contains(ev.target) || ev.target.closest('a.v3-tab')) {
                d.removeAttribute('open');
            }
        });
    });
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            document.querySelectorAll('details.v3-more[open]').forEach(function (d) {
                d.removeAttribute('open');
                var summary = d.querySelector('summary.v3-more-btn');
                if (summary && typeof summary.focus === 'function') summary.focus();
            });
        }
    });
}
`;
}

module.exports = {
    NAV_TABS,
    renderNavTabsSsr,
    loadIconSprite,
    navMoreAutoCloseClientScript,
    _resetSpriteCacheForTests,
};

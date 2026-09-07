// #6498 — Chip visual del estado del sello de evidencia de QA.
//
// POR QUE ESTE MODULO EXISTE
// --------------------------
// La primera pasada de este issue cableo el badge SOLO en `generateHTML()` de
// `dashboard.js`, que se sirve unicamente en `/legacy`. La pantalla que abre el
// operador (V3, servida en `/` y sus pestanas) quedo muda: barrido de QA sobre
// las 6 rutas del operador -> 0 badges, `/legacy` -> 9.
//
// Es EXACTAMENTE el modo de falla que #6459 ya habia corregido para el badge
// del Commander, y esta documentado en `dashboard.js` junto a `badgeCss()`:
// mientras la regla viva en una copia por superficie, agregar un estado deja
// alguna de las superficies muda y nadie lo nota hasta que lo mira un humano.
//
// Por eso el chip vive ACA, en un modulo neutral, y lo consumen las tres
// superficies:
//   - `views/dashboard/issues.js`            -> pestana /issues (SSR + cliente)
//   - `views/dashboard/pipeline-redesign.js` -> pestana /pipeline (cliente)
//   - `lib/dashboard-slices.js`              -> resuelve el estado server-side
// (el badge de `/legacy` conserva su propio renderer en `dashboard-slices.js`,
// con las clases `.lc-state-sello-*` de esa hoja).
//
// SEPARACION DE RESPONSABILIDADES
// -------------------------------
// El QUE (estado, copy, icono, prioridad) es de `lib/sello-evidencia-state.js`,
// fuente unica que tambien consume `decision-card.js`. Este modulo es solo el
// COMO se pinta. No deriva estado ni elige texto: recibe el objeto ya resuelto.

'use strict';

// =============================================================================
// selloChipHTML(sello, esc) -> string
//
// PORTABLE A DOS RUNTIMES. Las vistas serializan esta funcion con
// `String(selloChipHTML)` dentro del script del cliente, asi que el SSR y el
// re-render por polling ejecutan LITERALMENTE el mismo codigo. De ahi las tres
// restricciones de estilo, que son deliberadas y no un descuido:
//   1. `var` y ES5: el bundle del cliente no se transpila.
//   2. Cero closures sobre el scope del modulo: al serializarse pierde el
//      entorno. Por eso `esc` se INYECTA (escapeHtmlAttr en SSR, escapeHtml en
//      el cliente) en vez de importarse.
//   3. Sin backticks ni interpolaciones: el destino es un template literal.
//
// REGLA DURA DEL ISSUE: el rojo (--danger + ic-estado-needs-human) queda
// reservado EXCLUSIVAMENTE a `escalado`. `caduco` y `re-sellando` van en ambar
// de reintento porque son auto-reparacion en curso, no una falla que reclame al
// operador. Pintarlos de rojo arregla el bloqueo tecnico y CONSERVA el defecto
// de experiencia que esta historia declara cerrar.
//
// SEC-2 / CA-9: el id del simbolo sale de un literal por rama del `if`. NUNCA
// se concatena el `estado` (que nace de un YAML escrito por un agente) dentro
// del href del <use>: los helpers de icono interpolan crudo y eso seria un sink
// de inyeccion. Un estado desconocido cae al return vacio y no pinta nada.
//
// CA-5 / UX-2 (WCAG 1.4.1): SIEMPRE icono + etiqueta de texto. En deuteranopia
// --retry y --danger colapsan al mismo color; para ese operador el glifo y la
// palabra no son refuerzo, son la unica senal que existe.
//
// CA-10 / SEC-3: no hay rutas, hashes ni URLs. Todo lo que se pinta viene de
// las constantes congeladas del resolver, ya redactadas a lenguaje de operador.
// =============================================================================
function selloChipHTML(sello, esc) {
    if (!sello || typeof sello !== 'object') return '';
    if (typeof esc !== 'function') return '';
    var estado = sello.estado;
    var icono;
    if (estado === 'sellado') icono = 'ic-info';
    else if (estado === 'caduco') icono = 'ic-estado-stale';
    else if (estado === 're-sellando') icono = 'ic-estado-retrying';
    else if (estado === 'escalado') icono = 'ic-estado-needs-human';
    else return '';
    var cssKey = (estado === 're-sellando') ? 'resellando' : estado;
    var completo = String(sello.copy || '');
    var corto = String(sello.copyCorto || completo);
    if (!corto) return '';
    var detalle = String(sello.detalle || completo);
    var variante = (sello.variante === 'descarte') ? ' data-variant="descarte"' : '';
    var svg = '<svg class="sello-chip-ico" aria-hidden="true" focusable="false" viewBox="0 0 24 24">'
        + '<use href="#' + icono + '"></use></svg>';
    return '<span class="sello-chip sello-chip-' + cssKey + '"' + variante
        + ' title="' + esc(detalle) + '"'
        + ' aria-label="' + esc(completo) + '">'
        + svg + '<span class="sello-chip-txt">' + esc(corto) + '</span></span>';
}

// =============================================================================
// SELLO_CHIP_CSS — hoja del chip, compartida por las pestanas que lo pintan.
//
// CA-7 (cero hardcodeo): no hay un solo color literal. El primer token de cada
// cadena es el canonico de `assets/design-tokens.css`; el segundo es el token
// equivalente del tema V3 (`--in-*`), porque `/issues` inyecta design-tokens y
// el shell de satelites (`/pipeline`) todavia no. La cadena `var(a, var(b))` no
// es un hex: sigue siendo indireccion por token, y evita tener que meterle
// design-tokens al shell de los 12 satelites solo por este chip (R-5: agregar,
// no reestructurar).
//
// Si NINGUNO de los dos tokens resuelve, el chip pierde el fondo pero NO pierde
// legibilidad: icono y etiqueta siguen ahi. Es justo la garantia de CA-5/UX-2.
// =============================================================================
const SELLO_CHIP_CSS = `
.sello-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 600; line-height: 1.6;
    border-radius: 4px; padding: 1px 6px;
    border: 1px solid transparent; cursor: help; white-space: nowrap;
}
.sello-chip-ico { width: 12px; height: 12px; fill: currentColor; flex: 0 0 auto; }
/* Auto-reparacion OK: azul informativo, no verde de "listo" ni rojo de alarma. */
.sello-chip-sellado {
    color: var(--info, var(--in-info));
    background: var(--info-bg, var(--in-info-soft));
    border-color: var(--info-dim, var(--in-info));
}
/* Caduco y re-sellando comparten la triada ambar: el pipeline se esta curando
   solo y el operador NO tiene que intervenir. */
.sello-chip-caduco,
.sello-chip-resellando {
    color: var(--retry, var(--in-warn));
    background: var(--retry-bg, var(--in-warn-soft));
    border-color: var(--retry-dim, var(--in-warn));
}
/* Unico rojo del chip: se agotaron los reintentos automaticos. */
.sello-chip-escalado {
    color: var(--danger, var(--in-bad));
    background: var(--danger-bg, var(--in-bad-soft));
    border-color: var(--danger-dim, var(--in-bad));
}
`;

module.exports = { selloChipHTML, SELLO_CHIP_CSS };

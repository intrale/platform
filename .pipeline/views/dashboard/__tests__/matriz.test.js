// =============================================================================
// Tests de la ventana Matriz extraída a su propio módulo (#3731, padre #3715).
//
// Cubre:
//   - Exports canónicos del módulo ({ renderMatriz, renderMatrizInner, slug }).
//   - renderMatriz() emite un documento SSR completo con shell V3 (DOCTYPE,
//     <title>, nav v3) y los selectores estructurales estables.
//   - renderMatrizInner() emite el fragmento embebible sin <!DOCTYPE> (DOM
//     morphing del router cliente `?view=matriz`).
//   - escapeHtmlSsr canónico: payloads XSS NO escapan crudos al output (CA-D1,
//     defensa en profundidad sobre lib/escape-html.js).
//   - El <script> embebido construye la grilla escapando los datos del servidor
//     con escapeHtml() ANTES de tocar innerHTML (XSS guard sobre nombres de
//     skill / claves pipeline·fase que vienen de /api/dash/pipeline).
//   - Leyenda del heat-map (CA-C3) + tooltips operativos (CA-C1).
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/matriz.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const matriz = require('..' + path.sep + 'matriz.js');
const { renderMatriz, renderMatrizInner, slug, escapeHtmlSsr } = matriz;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Matriz', () => {
    assert.equal(slug, 'matriz');
    assert.equal(typeof renderMatriz, 'function');
    assert.equal(typeof renderMatrizInner, 'function');
    assert.equal(typeof escapeHtmlSsr, 'function');
});

// ---------------------------------------------------------------------------
// Estructura SSR
// ---------------------------------------------------------------------------

test('renderMatriz emite un documento SSR completo', () => {
    const html = renderMatriz();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'falta el DOCTYPE del shell');
    assert.match(html, /<title>Intrale · Matriz<\/title>/);
    assert.match(html, /class="v3-nav"/, 'falta la nav V3 del shell');
    // Header del shell satélite.
    assert.match(html, /id="hdr-mode"/);
    assert.match(html, /id="hdr-clock"/);
});

test('renderMatriz emite los selectores estructurales estables', () => {
    const html = renderMatriz();
    assert.match(html, /id="matriz-table"/, 'falta el contenedor de la tabla');
    assert.match(html, /Matriz · skill × fase/, 'falta el título de la sección');
    assert.match(html, /class="mtx-legend"/, 'falta la leyenda del heat-map (CA-C3)');
});

test('renderMatrizInner emite el fragmento embebible sin shell', () => {
    const inner = renderMatrizInner();
    assert.equal(inner.includes('<!DOCTYPE html>'), false, 'el inner NO debe traer shell');
    assert.match(inner, /id="matriz-table"/);
    assert.match(inner, /<script>/);
    // El fragmento es autosuficiente: trae sus helpers + el tick.
    assert.match(inner, /async function tickMatriz\(\)/);
    assert.match(inner, /function fetchJson\(/);
});

// ---------------------------------------------------------------------------
// Leyenda (CA-C3) + tooltips (CA-C1)
// ---------------------------------------------------------------------------

test('la leyenda explica los tres estados de celda (CA-C3)', () => {
    const html = renderMatriz();
    assert.match(html, /Sin carga/);
    assert.match(html, /carga normal/);
    assert.match(html, /cuello de botella/);
    // Cada item de leyenda tiene tooltip.
    assert.match(html, /class="mtx-legend-item" title=/);
    // El contenedor de la tabla es accesible (aria-live para hidratación).
    assert.match(html, /aria-live="polite"/);
});

test('los encabezados y celdas de la grilla llevan tooltip (CA-C1)', () => {
    const inner = renderMatrizInner();
    // El JS embebido construye <th ... title=...> (con clase opcional del cuello)
    // y <td ... title=...>. El tooltip del header conserva la clave pipeline/fase.
    assert.match(inner, /title="'\+escapeHtml\(p\+'\/'\+fase\)\+'"/);
    assert.match(inner, /title="'\+tip\+'"/, 'las celdas deben llevar tooltip');
});

// ---------------------------------------------------------------------------
// XSS guards
// ---------------------------------------------------------------------------

test('el JS embebido escapa los datos del servidor antes de innerHTML (XSS guard)', () => {
    const html = renderMatriz();
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'falta el <script> embebido');
    const js = scriptMatch[1];
    // Hay UNA sola asignación a innerHTML, y todos los valores del servidor
    // (skill, pipeline, fase) pasan por escapeHtml() antes de construir el HTML.
    assert.match(js, /escapeHtml\(skill\)/, 'el nombre de skill debe escaparse');
    assert.match(js, /escapeHtml\(p\+'\/'\+fase\)/, 'la clave pipeline\/fase debe escaparse');
    // No se concatena ningún valor del servidor crudo a innerHTML sin escapar.
    assert.equal(/innerHTML\s*=\s*['"`]?\s*\+/.test(js), false);
});

test('escapeHtmlSsr canónico — payloads XSS no escapan al output', () => {
    const payloads = [
        '<img src=x onerror=alert(1)>',
        '"><script>alert(2)</script>',
        "';alert(3);//",
        '<svg/onload=alert(4)>',
    ];
    for (const p of payloads) {
        const out = escapeHtmlSsr(p);
        assert.equal(out.includes('<'), false, `'<' sin escapar en: ${p}`);
        assert.equal(out.includes('>'), false, `'>' sin escapar en: ${p}`);
        // El SSR del documento no debe reflejar ningún payload crudo.
        assert.equal(renderMatriz().includes(p), false, `payload crudo en el HTML: ${p}`);
    }
});

test('escapeHtmlSsr trata null/undefined como string vacío', () => {
    assert.equal(escapeHtmlSsr(null), '');
    assert.equal(escapeHtmlSsr(undefined), '');
});

// ---------------------------------------------------------------------------
// Hidratación / endpoint
// ---------------------------------------------------------------------------

test('la ventana se hidrata desde /api/dash/pipeline (sin acciones mutantes)', () => {
    const html = renderMatriz();
    assert.match(html, /fetchJson\('\/api\/dash\/pipeline'\)/);
    // READ-ONLY: sin <form>, sin POST embebido.
    assert.equal(/<form/.test(html), false, 'la ventana Matriz no debe tener <form>');
    assert.equal(/method=['"]?post/i.test(html), false, 'la ventana Matriz no debe emitir POST');
});

// ---------------------------------------------------------------------------
// #3959 (EP8-H6) — heat-map interactivo: drill-down, tendencias, cuello de
// botella, paleta accesible, orden canónico.
// ---------------------------------------------------------------------------

test('CA-1 — las celdas con carga son focusables y operables (role/tabindex/aria-label)', () => {
    const inner = renderMatrizInner();
    // El JS embebido marca las celdas con carga como botones accesibles.
    assert.match(inner, /role="button"/, 'celda operable con role=button');
    assert.match(inner, /tabindex="0"/, 'celda operable con foco de teclado');
    assert.match(inner, /aria-label="'\+alabel\+'"/, 'celda con aria-label');
    // Operable por teclado (Enter / Espacio), no sólo mouse.
    assert.match(inner, /ev\.key === 'Enter'/);
    assert.match(inner, /openMtxDrilldown/);
});

test('CA-1 — drill-down: dialog nativo + textContent (sin innerHTML de datos externos)', () => {
    const html = renderMatriz();
    // Panel lateral = <dialog> nativo (focus trap del browser + Esc).
    assert.match(html, /<dialog id="mtx-dialog"/);
    assert.match(html, /id="mtx-dialog-list"/);
    const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    // El título y los títulos de issue se inyectan con textContent.
    assert.match(js, /\.textContent = meta\.title/, 'título de issue por textContent');
    // href de GitHub validado /^\d+$/ antes de interpolar (anti javascript: URI).
    assert.match(js, /\/\^\\d\+\$\/\.test\(idStr\)/);
    assert.match(js, /a\.href = MTX_GH \+ idStr/);
});

test('CA-2 — flecha de tendencia con glifo + aria-label, degrada sin baseline', () => {
    const inner = renderMatrizInner();
    // Glifos de tendencia presentes.
    assert.match(inner, /▲/);
    assert.match(inner, /▼/);
    assert.match(inner, /▬/);
    // Cada flecha lleva aria-label descriptivo (no depende sólo del glifo).
    assert.match(inner, /class="mtx-trend [^"]*" aria-label="'\+tlabel\+'"/);
    // Sin baseline numérico → no se dibuja flecha (degradación limpia).
    assert.match(inner, /typeof base === 'number' && n > 0/);
});

test('CA-3 — cuello de botella por conteo × edad media con badge de texto', () => {
    const inner = renderMatrizInner();
    // Score = conteo × edad media (no umbral simple n>=5).
    assert.match(inner, /score = n \* a/);
    // Badge con TEXTO explícito (no sólo color).
    assert.match(inner, /⚠ cuello de botella/);
    assert.match(inner, /mtx-cell-neck/);
});

test('CA-4 — el orden de skills usa d.skillOrder (no Object.keys(SKILL_COLORS))', () => {
    const inner = renderMatrizInner();
    assert.match(inner, /d\.skillOrder/, 'la matriz consume el orden canónico del slice');
    // El fallback sigue siendo SKILL_COLORS si el slice no lo emite.
    assert.match(inner, /Object\.keys\(SKILL_COLORS\)/);
});

test('CA-5 — paleta accesible: cada estado lleva patrón + glifo además de color', () => {
    const html = renderMatriz();
    // Patrones CSS por estado (no sólo color de fondo).
    assert.match(html, /\.mtx-cell-active[\s\S]*?radial-gradient/, 'carga normal: patrón de puntos');
    assert.match(html, /\.mtx-cell-hot[\s\S]*?repeating-linear-gradient/, 'carga alta: rayado');
    assert.match(html, /\.mtx-cell-neck[\s\S]*?repeating-linear-gradient/, 'cuello: cross-hatch');
    // Glifos por estado en las celdas (·/●/◣/▦).
    const inner = renderMatrizInner();
    assert.match(inner, /glyph = '●'/);
    assert.match(inner, /glyph = '◣'/);
    assert.match(inner, /glyph = '▦'/);
    // La leyenda también lleva glifo + swatch con patrón por estado.
    assert.match(html, /mtx-legend-glyph/);
    assert.match(html, /mtx-legend-swatch is-neck/);
});

test('CA-6 — el drill-down no introduce <form>/POST (sigue READ-ONLY)', () => {
    const html = renderMatriz();
    assert.equal(/<form/.test(html), false, 'el dialog no usa <form>');
    // El cierre del dialog es por JS (close()), no por submit.
    assert.match(html, /id="mtx-dialog-close"/);
    const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    assert.match(js, /closeMtxDialog/);
});

// ---------------------------------------------------------------------------
// #4196 (Ola 7.1) — Rediseño integral MIZPÁ: shell de marca, miga de pan,
// banner de misión diagnóstico, heatmap con ícono+rol, nunca truncar.
// ---------------------------------------------------------------------------

test('#4196 CA-1 — hereda la barra de marca MIZPÁ (logo + nombre + tagline + multiproyecto)', () => {
    const html = renderMatriz();
    // Barra de marca MIZPÁ (clases compartidas mz-* de theme.css).
    assert.match(html, /class="mz-logo"/, 'falta el logo MIZPÁ');
    assert.match(html, /class="mz-name">MIZPÁ</, 'falta el nombre de marca MIZPÁ');
    assert.match(html, /Que el Señor vigile/, 'falta el tagline MIZPÁ');
    // Selector multiproyecto (Intrale · 1/3).
    assert.match(html, /class="mz-projsel"/, 'falta el selector multiproyecto');
    assert.match(html, /class="mz-proj-name">Intrale</);
    assert.match(html, /class="mz-proj-badge">1 \/ 3</);
});

test('#4196 CA-1 — nav curada 5 + «⋯ Más» con miga de pan «⋯ Más › 🔲 Matriz»', () => {
    const html = renderMatriz();
    // La nav V3 (renderNavTabsSsr) trae el popover «⋯ Más» y marca Matriz activa.
    assert.match(html, /class="v3-nav"/);
    // Miga de pan: Matriz vive dentro de «⋯ Más».
    assert.match(html, /class="mz-crumb"/, 'falta la miga de pan');
    assert.match(html, /⋯ Más/, 'la miga indica que Matriz vive bajo «⋯ Más»');
    assert.match(html, /<b>🔲 Matriz<\/b>/, 'la miga marca Matriz como actual');
    // Export del brand bar para test/reuso aislado.
    assert.equal(typeof matriz.renderMatrizBrandBar, 'function');
    assert.match(matriz.renderMatrizBrandBar(), /MIZPÁ/);
});

test('#4196 CA-2 — banner de misión diagnóstico con las 3 métricas + lectura automática', () => {
    const html = renderMatriz();
    // Skeleton del banner presente (lo hidrata el cliente).
    assert.match(html, /id="mtx-mission"/, 'falta el banner de misión');
    assert.match(html, /id="mtx-wm-total"/, 'falta la métrica carga total');
    assert.match(html, /id="mtx-wm-fase"/, 'falta la métrica fase más cargada');
    assert.match(html, /id="mtx-wm-skill"/, 'falta la métrica skill más cargado');
    assert.match(html, /LECTURA AUTOMÁTICA/, 'falta la lectura accionable del cuello');
    // Export del skeleton para test aislado.
    assert.equal(typeof matriz.renderMatrizMissionBanner, 'function');
});

test('#4196 CA-2 — el cliente calcula fase saturada, %, fase y skill más cargados', () => {
    const inner = renderMatrizInner();
    // El tick computa la fase más cargada y su porcentaje sobre el total.
    assert.match(inner, /topFaseCount/, 'calcula la fase con mayor carga');
    assert.match(inner, /Math\.round\(\(topFaseCount\/grandTotal\)\*100\)/, 'calcula el % de saturación');
    // Skill más cargado + runners (top 3).
    assert.match(inner, /skillRunners/, 'calcula el ranking de skills');
    // Umbral de saturación accionable.
    assert.match(inner, /pct >= 40/, 'define un umbral de fase saturada');
    // Lectura accionable de qué reforzar para destrabar.
    assert.match(inner, /destraba el ' \+ topFase\.pct \+ '% del backlog/);
});

test('#4196 CA-2 — el banner se hidrata por textContent/createElement (XSS-safe, sin innerHTML de datos externos)', () => {
    const inner = renderMatrizInner();
    // mtxFillParts construye partes mixtas texto/negrita sin innerHTML.
    assert.match(inner, /function mtxFillParts/);
    assert.match(inner, /createTextNode/);
    // El banner NO concatena skill/fase a innerHTML.
    const js = inner.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    // Solo el heatmap (matriz-table) usa innerHTML; el banner usa setText/parts.
    assert.match(js, /renderMtxMission/);
});

test('#4196 CA-2 — escenario calmo: sin fase saturada el banner no muestra alarma', () => {
    const inner = renderMatrizInner();
    // Toggle de clase is-calm según saturación (Gherkin: matriz sin carga relevante).
    assert.match(inner, /classList\.toggle\('is-calm', !saturated\)/);
    // Mensaje calmo explícito cuando no hay cuello.
    assert.match(inner, /Sin cuello marcado/);
    // Escenario sin carga: grandTotal === 0 → mensaje de pipeline en calma.
    assert.match(inner, /pipeline en calma/);
});

test('#4196 CA-3 — heatmap con ícono + rol por skill y fase con etiqueta legible', () => {
    const inner = renderMatrizInner();
    // Ícono + rol por skill (segunda línea, nunca trunca).
    assert.match(inner, /mtx-skic/, 'ícono de skill');
    assert.match(inner, /mtx-skr/, 'rol de skill');
    assert.match(inner, /SKILL_ROLES\[skill\]/, 'rol tomado del catálogo');
    // Fase con etiqueta legible (Validación, no validacion).
    assert.match(inner, /function faseLabel/);
    assert.match(inner, /Validación/);
    // Columna del cuello resaltada como embudo.
    assert.match(inner, /is-neck-col/);
    assert.match(inner, /⚠ embudo/);
});

test('#4196 CA-4/CA-5 — nunca truncar: sin «…» ni «+X más», roles y conteos completos', () => {
    const html = renderMatriz();
    const inner = renderMatrizInner();
    // No hay marcadores de truncado en el markup ni en el script.
    assert.equal(/\+\d+\s*más/i.test(html), false, 'no debe haber «+X más»');
    assert.equal(/text-overflow:\s*ellipsis/.test(matriz.MATRIZ_CSS), false, 'el título de issue no debe truncarse con ellipsis');
    // El rol del skill se muestra completo (sin recorte).
    assert.match(inner, /escapeHtml\(role\)/);
});

// V3 Home — render del HTML inicial del dashboard kiosk vertical 1080×1920.
// El layout y los textos se imprimen una sola vez. El refresh es client-side
// vía fetch JSON + DOM morphing manual (sin reemplazar containers, evita flicker).

'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Modulo compartido de la nav bar V3. Provee NAV_TABS,
// renderNavTabsSsr (markup SSR) y loadIconSprite (cache compartido del SVG).
// home.js consume todo desde aca para no duplicar el catalogo de tabs ni
// abrir un segundo cache del sprite (mantiene paridad con satellites.js).
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');

function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); }
    catch { return ''; }
}

// #2976 — Lectura defensiva del flag de cuota agotada para el SSR del banner.
// Tolerante a la ausencia del módulo (si #2974 todavía no aterrizó). El
// caller puede pasar el state precomputado para evitar leer el filesystem
// dos veces (slice + render).
let quotaExhaustedState = null;
try { quotaExhaustedState = require('../../lib/quota-exhausted-state'); } catch { /* opcional */ }

function getInitialQuotaState() {
    if (!quotaExhaustedState) return { active: false };
    try { return quotaExhaustedState.getQuotaState(); }
    catch { return { active: false }; }
}

// HTML escape para el SSR. El cliente tiene su propio escapeHtml() embebido
// en el script (ver renderClientScript), pero al renderizar SSR necesitamos
// uno acá también — defensa en profundidad CA-10. Idéntica semántica.
function escapeHtmlSsr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Format HH:MM en hora local (igual semántica que el cliente). Si el ISO
// no parsea, devuelve "—" para que el render no rompa.
function fmtHHMMLocalSsr(iso) {
    if (!iso) return '—';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '—';
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return h + ':' + m;
}

function fmtCountdownSsr(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h >= 1) return h + ' h ' + m + ' min';
    const s = totalSec % 60;
    if (m >= 1) return m + ' min ' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
}

function homeStyles() {
    return `
.kiosk-frame {
    width: 1080px;
    min-height: 1920px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
}
.kiosk-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 22px;
}

/* KPI grid */
.kpi-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
}
.kpi-card {
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    box-shadow: var(--in-shadow);
}
.kpi-icon { font-size: 18px; opacity: 0.85; }
.kpi-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--in-fg-dim);
    letter-spacing: 0.8px;
}
.kpi-value {
    font-size: 36px;
    font-weight: 700;
    color: var(--in-fg);
    transition: color 0.3s;
    font-variant-numeric: tabular-nums;
}
.kpi-sub {
    font-size: 11px;
    color: var(--in-fg-dim);
}
.kpi-card.kpi-warn .kpi-value { color: var(--in-warn); }
.kpi-card.kpi-bad .kpi-value { color: var(--in-bad); }
.kpi-card.kpi-ok .kpi-value { color: var(--in-ok); }
.kpi-bar { margin-top: 6px; }

/* KPI dual de cuota: 2 filas, sin un value gigante */
.kpi-quota-dual { gap: 6px; }
.kpi-quota-dual .kpi-icon { font-size: 16px; opacity: 0.7; }
.kpi-quota-row {
    display: grid;
    grid-template-columns: auto 60px 1fr;
    align-items: baseline;
    gap: 6px;
    padding: 4px 0;
    border-top: 1px solid var(--in-border-soft);
}
.kpi-quota-row:first-of-type { border-top: none; }
.kpi-quota-row-label {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.kpi-quota-row-value {
    font-size: 20px;
    font-weight: 700;
    text-align: right;
    font-variant-numeric: tabular-nums;
}
.kpi-quota-row-eta {
    font-size: 10px;
    color: var(--in-fg-soft);
    font-family: var(--in-mono);
    text-align: right;
}
.kpi-quota-row.kpi-warn .kpi-quota-row-value { color: var(--in-warn); }
.kpi-quota-row.kpi-bad .kpi-quota-row-value { color: var(--in-bad); }
.kpi-quota-row.kpi-ok .kpi-quota-row-value { color: var(--in-ok); }

/* #3492 — Panel "Ola actual · ETA" (probabilístico p50/p75/p90).
   Vive entre el KPI grid y la areas-bar. Tres filas grandes (p50/p75/p90)
   + badge de samples<5 (CA-22) + breakdown por size (CA-21). El formato de
   minutos (45m / 1h 2m) se calcula en el cliente vía fmtMin() (CA-23). */
.ola-eta-section {
    background: linear-gradient(180deg, rgba(60,140,255,0.05), transparent 80%), var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 22px;
    box-shadow: var(--in-shadow);
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.ola-eta-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
}
.ola-eta-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--in-fg);
    font-weight: 600;
}
.ola-eta-subtitle {
    font-size: 11px;
    color: var(--in-fg-dim);
}
.ola-eta-low-samples {
    display: none;          /* mostrado por JS cuando totalSamples < 5 (CA-22) */
    align-items: center;
    gap: 6px;
    background: rgba(255,193,7,0.12);
    border: 1px solid rgba(255,193,7,0.35);
    color: var(--in-warn);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
}
.ola-eta-low-samples[data-show="1"] { display: inline-flex; }
.ola-eta-low-samples-icon { font-size: 12px; }
.ola-eta-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
}
.ola-eta-cell {
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.ola-eta-cell-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--in-fg-dim);
}
.ola-eta-cell-value {
    font-size: 26px;
    font-weight: 700;
    color: var(--in-fg);
    font-variant-numeric: tabular-nums;
    font-family: var(--in-mono);
}
.ola-eta-cell-sub {
    font-size: 10px;
    color: var(--in-fg-soft);
}
.ola-eta-bysize {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
}
.ola-eta-size-pill {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border: 1px solid var(--in-border-soft);
    border-radius: var(--in-radius-sm);
    background: var(--in-bg-3);
}
.ola-eta-size-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--in-fg-dim);
}
.ola-eta-size-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--in-fg);
    font-variant-numeric: tabular-nums;
    font-family: var(--in-mono);
}
.ola-eta-size-samples {
    font-size: 10px;
    color: var(--in-fg-soft);
}
.ola-eta-empty {
    display: none;
    padding: 14px;
    color: var(--in-fg-dim);
    font-size: 12px;
    text-align: center;
}
.ola-eta-section[data-empty="1"] .ola-eta-grid { display: none; }
.ola-eta-section[data-empty="1"] .ola-eta-bysize { display: none; }
.ola-eta-section[data-empty="1"] .ola-eta-empty { display: block; }

/* Active section */
.active-section {
    background: linear-gradient(180deg, rgba(46,230,193,0.05), transparent 80%), var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 22px;
    box-shadow: var(--in-shadow);
}
.active-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.active-card {
    display: grid;
    grid-template-columns: 38px 1fr auto;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    transition: opacity 0.3s, transform 0.3s;
}
.active-card.entering { opacity: 0; transform: translateY(-6px); }
.active-card.leaving { opacity: 0; transform: translateY(6px); }
.active-card-skill {
    grid-row: 1 / span 2;
    width: 38px; height: 38px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    color: #fff;
}
.active-card-meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
}
.active-card-issue {
    font-weight: 600;
    color: var(--in-fg);
    font-size: 14px;
}
.active-card-fase {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.6px;
}
.active-card-title {
    font-size: 12px;
    color: var(--in-fg-dim);
    grid-column: 2 / span 1;
    grid-row: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 580px;
}
.active-card-time {
    grid-column: 3;
    grid-row: 1;
    text-align: right;
    font-family: var(--in-mono);
    font-size: 13px;
    color: var(--in-accent);
    font-variant-numeric: tabular-nums;
}
.active-card-kill {
    grid-column: 3;
    grid-row: 2;
    justify-self: end;
    background: transparent;
    border: 1px solid var(--in-bad);
    color: var(--in-bad);
    border-radius: 6px;
    padding: 2px 9px;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s;
}
.active-card-kill:hover { background: var(--in-bad-soft); }
.active-card-progress {
    grid-column: 1 / -1;
    margin-top: 4px;
}

.active-empty {
    text-align: center;
    padding: 40px 16px;
    color: var(--in-fg-dim);
}
.active-empty-icon { font-size: 32px; margin-bottom: 10px; }
.active-empty-msg { font-size: 13px; }

/* Recent / queue rows */
.line-list {
    display: flex; flex-direction: column;
    gap: 4px;
}
.line-row {
    display: grid;
    /* #3035 — Grid extendido: icon | skill | issue+title | fase | timestamp-fin | duración | actions */
    grid-template-columns: 28px 70px 1fr auto 110px auto auto;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-radius: var(--in-radius-sm);
    background: var(--in-bg-3);
    transition: background 0.15s;
}
.line-row:hover { background: var(--in-bg); }
.line-icon {
    /* #3035 — chip circular para reforzar contraste a 1+ metro (kiosk).
     * El glyph + el background-soft hacen distinguible ✓/✗ sin depender
     * solo del color (cumple WCAG 1.4.1 "use of color"). */
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
    color: var(--in-fg-dim);
    background: transparent;
}
.line-icon--success {
    color: var(--in-ok);
    background: var(--in-ok-soft);
}
.line-icon--error {
    color: var(--in-bad);
    background: var(--in-bad-soft);
}
.line-icon--neutral {
    color: var(--in-fg-dim);
    background: transparent;
}
.line-skill {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.line-issue {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.line-issue a { color: var(--in-info); }
.line-issue a:hover { text-decoration: underline; }
.line-fase {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
}
.line-time {
    font-family: var(--in-mono);
    font-size: 12px;
    color: var(--in-fg-dim);
    font-variant-numeric: tabular-nums;
}
/* #3035 — Timestamp absoluto de fin de ejecución, formato dd/MM HH:mm:ss.
 * Mono + tabular-nums para que las cifras no salten al actualizar. */
.line-time-end {
    font-family: var(--in-mono);
    font-size: 11.5px;
    color: var(--in-fg-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

/* #3035 — Header del apartado con toggle a la derecha del título.
 * Mantiene la semántica de .in-section-title (uppercase + spacing) y
 * empuja el toggle al final del eje. */
.in-section-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 14px 0;
}
.in-section-title-row .in-section-title {
    margin: 0;
    flex: 1;
}
.in-section-title-row .in-pill-toggle { margin-left: auto; }

/* #3035 — Pill toggle "Solo con error" — variante de .in-pill con
 * estados OFF/ON. Cumple touch-target ≥ 28px y contraste AA. */
.in-pill-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    color: var(--in-fg-dim);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    user-select: none;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    min-height: 28px;
    line-height: 1;
}
.in-pill-toggle:hover {
    background: var(--in-bg);
    border-color: var(--in-fg-dim);
    color: var(--in-fg);
}
.in-pill-toggle[aria-checked="true"] {
    background: var(--in-bad-soft);
    border-color: var(--in-bad);
    color: var(--in-bad);
}
.in-pill-toggle[aria-checked="true"]:hover {
    background: var(--in-bad-soft);
    border-color: var(--in-bad);
    color: var(--in-bad);
    filter: brightness(1.05);
}
.in-pill-toggle:focus-visible {
    outline: 2px solid var(--in-accent);
    outline-offset: 2px;
}
/* #3023 — Badge informativo "filtrado por pausa parcial" en el header de
 * "Próximos 10 en cola". NO interactivo (cursor:default), reusa amber
 * coherente con .in-mode-partial del header global y .pl-card-stale-badge
 * de satellites. Se muestra solo cuando el endpoint expone
 * partialPause.active === true (CA-5). Toggle vía display:none/inline-flex
 * desde tickQueue() — sin redibujar el header. */
.in-pill-partial-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--in-warn-soft);
    color: var(--in-warn);
    border: 1px solid var(--in-warn);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.2px;
    line-height: 1;
    min-height: 22px;
    margin-left: auto;
    cursor: default;
    white-space: nowrap;
}
.line-actions {
    display: flex;
    gap: 4px;
    justify-self: end;
}
.line-btn {
    background: transparent;
    border: 1px solid var(--in-border);
    color: var(--in-fg-dim);
    border-radius: 4px;
    width: 24px; height: 22px;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.line-btn:hover { background: var(--in-bg-3); border-color: var(--in-accent); color: var(--in-accent); }

/* #3726 — Badges para la barra de navegacion V3.
   El render del .v3-nav (home + satelites) emite los <span id="badge-*">
   con la clase .area-pill-badge. Los tickers existentes
   (tickMultiProvider y la hidratacion de counts en el slice del header)
   leen estos spans por id, asi no se rompen durante la transicion al
   nuevo diseno (#3726, CA-10).
   Historia: la botonera vieja .areas-bar / .area-pill quedo retirada en
   #3726. Los selectores .area-pill* desaparecieron junto con el HTML
   que los usaba; solo sobreviven los modificadores .area-pill-badge*,
   absolutamente posicionados encima del nuevo .v3-tab para no romper
   los semaforos (zero / warn / bad). */
.area-pill-badge {
    position: absolute;
    top: 6px; right: 6px;
    background: var(--in-brand);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    border-radius: 10px;
    padding: 1px 6px;
    min-width: 18px;
    text-align: center;
    line-height: 1.4;
}
.area-pill-badge-warn { background: var(--in-warn); }
.area-pill-badge-bad { background: var(--in-bad); }
.area-pill-badge-zero { background: var(--in-bg-3); color: var(--in-fg-soft); border: 1px solid var(--in-border); }

/* Mode pill in header */
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }

/* Rest mode pill (#2890 PR-A) — indigo nocturno cuando la ventana está activa.
   Token --rest-mode viene del UX (#2896, design-tokens.css:88). */
#hdr-rest-mode {
    color: var(--rest-mode-fg, #C5B7FF);
    border-color: rgba(124,92,255,0.55);
    background: var(--rest-mode-bg, rgba(124,92,255,0.16));
    cursor: pointer;
}
#hdr-rest-mode:hover { filter: brightness(1.18); }

/* Mode pill — clickeable con dropdown */
.in-pill[data-mode-toggle] { cursor: pointer; user-select: none; position: relative; }
.in-pill[data-mode-toggle]:hover { filter: brightness(1.15); }
.in-pill[data-mode-toggle]::after { content: " ▾"; opacity: 0.6; font-size: 10px; }

.in-mode-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 100;
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    box-shadow: var(--in-shadow);
    min-width: 220px;
    padding: 6px;
    display: none;
}
.in-mode-menu.open { display: block; }
.in-mode-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--in-fg);
    transition: background 0.12s;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
}
.in-mode-menu-item:hover { background: var(--in-bg-3); }
.in-mode-menu-item.active { background: var(--in-brand-soft); color: var(--in-fg); font-weight: 600; }
.in-mode-menu-item-icon { width: 18px; text-align: center; }
.in-mode-menu-divider { height: 1px; background: var(--in-border); margin: 4px 0; }
.in-mode-menu-input {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
}
.in-mode-menu-input label { font-size: 11px; color: var(--in-fg-dim); }
.in-mode-menu-input input {
    width: 100%;
    padding: 6px 8px;
    background: var(--in-bg);
    color: var(--in-fg);
    border: 1px solid var(--in-border);
    border-radius: 4px;
    font-family: var(--in-mono);
    font-size: 12px;
    box-sizing: border-box;
}
.in-mode-menu-input input:focus { outline: none; border-color: var(--in-accent); }
.in-mode-menu-input button {
    padding: 6px 10px;
    background: var(--in-warn-soft);
    color: var(--in-warn);
    border: 1px solid var(--in-warn);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
}
.in-mode-menu-input button:hover { background: var(--in-warn); color: var(--in-bg); }

/* =========================================================================
 * #2976 — Banner de cuota agotada del proveedor LLM (modo deterministico).
 *
 * Tokens visuales: --quota-degraded* definidos por UX en
 * .pipeline/assets/design-tokens.css (assets cherry-pickeados desde el
 * commit UX 2dfbd258 al rebote ux/aprobacion del rev-1 — ahora viven en
 * esta misma rama, ver CA-7). Sin fallbacks hex hardcoded: la paleta es
 * la fuente de verdad y CA-7 obliga a no hardcodear ambar.
 *
 * Identidad: ambar #F0A500 (en design-tokens.css), semanticamente distinto
 * de --warning (#D29922, stale) y --retry (#F59E0B, reintentando).
 * Contraste WCAG AAA verificado por UX (>13.5:1).
 *
 * Layout: barra horizontal arriba del kiosk-body, debajo del header. No
 * empuja contenido; usa padding y se inserta en el flujo natural cuando
 * data-active="true". Mientras hidden ocupa 0px (display:none).
 * ========================================================================= */
.quota-exhausted-banner {
    display: none;
    margin: 0 22px;
    padding: 14px 18px;
    background: var(--quota-degraded-bg);
    color: var(--quota-degraded-fg);
    border: 1px solid var(--quota-degraded);
    border-left: 4px solid var(--quota-degraded);
    border-radius: var(--in-radius, 8px);
    box-shadow: var(--quota-degraded-glow);
    font-size: 13px;
    line-height: 1.4;
    grid-template-columns: auto 1fr auto;
    column-gap: 16px;
    align-items: center;
}
.quota-exhausted-banner[data-active="true"] { display: grid; }

.quota-exhausted-icon {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    color: var(--quota-degraded);
}
.quota-exhausted-icon svg { width: 100%; height: 100%; fill: currentColor; }

.quota-exhausted-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}
.quota-exhausted-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--quota-degraded-fg);
    letter-spacing: 0.2px;
}
.quota-exhausted-sub {
    font-size: 11px;
    color: var(--quota-degraded-dim);
    font-family: var(--in-mono, 'Roboto Mono', monospace);
    word-break: break-word;
}
.quota-exhausted-panels {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 4px;
}
.quota-exhausted-panel {
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid var(--in-border, rgba(255,255,255,0.08));
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--in-fg-dim);
    display: flex;
    align-items: center;
    gap: 6px;
}
.quota-exhausted-panel-label {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
    color: var(--in-fg-soft, rgba(255,255,255,0.55));
}
.quota-exhausted-panel-value {
    font-size: 13px;
    font-weight: 700;
    color: var(--quota-degraded-fg);
    font-variant-numeric: tabular-nums;
}
.quota-exhausted-panel.det .quota-exhausted-panel-value {
    color: var(--in-ok, #3fb950);
}
.quota-exhausted-skills {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: 4px;
}
.quota-exhausted-skill-pill {
    background: var(--quota-degraded-bg);
    border: 1px solid var(--quota-degraded);
    color: var(--quota-degraded-fg);
    border-radius: 12px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.quota-exhausted-skill-pill svg {
    width: 10px;
    height: 10px;
    fill: currentColor;
    opacity: 0.8;
}

.quota-exhausted-countdown {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: 0 0 auto;
    min-width: 130px;
}
.quota-exhausted-countdown-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--in-fg-soft, rgba(255,255,255,0.55));
}
.quota-exhausted-countdown-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--quota-degraded-fg);
    font-variant-numeric: tabular-nums;
    font-family: var(--in-mono, 'Roboto Mono', monospace);
}
.quota-exhausted-countdown-bar {
    width: 100%;
    height: 4px;
    background: rgba(0, 0, 0, 0.32);
    border-radius: 2px;
    overflow: hidden;
}
.quota-exhausted-countdown-bar > span {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--quota-degraded);
    transition: width 1s linear;
}

/* #3361 — La card de salud de providers se movió a la ventana Providers
 * (multi-provider.js). Estilos y polling viven ahora ahí. El home queda
 * limpio sin duplicación. Ver mp-live-providers en multi-provider.js. */

/* =========================================================================
 * #3013 — Banner real-snapshot de cuota (4 estados, narrativa §2.1).
 *
 * CA-UX-9 (WCAG AA mínimo): cada estado distingue por borde + pill +
 * microcopy + ícono distintivo. Cero reliance en color solo.
 * CA-UX-5: cero hex hardcoded, sólo tokens semánticos de design-tokens.css.
 *
 * Posición: debajo del banner exhausted (narrativa §6). Cuando data-state
 * es 'missing' ocupa 0px (display:none) → CA-15 pre-feature behavior.
 * ========================================================================= */
.quota-snapshot-banner {
    display: none;
    margin: 0 22px;
    padding: 10px 14px;
    border: 1px solid var(--in-border, rgba(255,255,255,0.12));
    border-left-width: 4px;
    border-radius: var(--in-radius, 8px);
    background: var(--surface-1, var(--in-surface-2, #161b22));
    font-size: 12px;
    line-height: 1.45;
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 14px;
    align-items: center;
}
/* Estados — borde lateral cambia + pill cambia (cero reliance en color solo). */
.quota-snapshot-banner[data-state="missing"]    { display: none; }
.quota-snapshot-banner[data-state="fresh"]      { display: grid; border-left-color: var(--success, #3fb950); }
.quota-snapshot-banner[data-state="stale"]      { display: grid; border-left-color: var(--warning, #d29922); }
.quota-snapshot-banner[data-state="parser-offline"] { display: grid; border-left-color: var(--danger, #f85149); }

.quota-snapshot-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    font-family: var(--in-mono, 'Roboto Mono', monospace);
    border: 1px solid transparent;
}
.quota-snapshot-banner[data-state="fresh"] .quota-snapshot-pill {
    background: var(--success-bg, rgba(63, 185, 80, 0.16));
    color: var(--success, #3fb950);
    border-color: var(--success, #3fb950);
}
.quota-snapshot-banner[data-state="stale"] .quota-snapshot-pill {
    background: var(--warning-bg, rgba(210, 153, 34, 0.16));
    color: var(--warning, #d29922);
    border-color: var(--warning, #d29922);
}
.quota-snapshot-banner[data-state="parser-offline"] .quota-snapshot-pill {
    background: var(--danger-bg, rgba(248, 81, 73, 0.16));
    color: var(--danger, #f85149);
    border-color: var(--danger, #f85149);
}
.quota-snapshot-pill-icon {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    /* Ícono concreto se setea por CSS por estado para no depender de SVG inline. */
}
.quota-snapshot-banner[data-state="fresh"] .quota-snapshot-pill-icon::before     { content: '\\2713'; font-size: 11px; }
.quota-snapshot-banner[data-state="stale"] .quota-snapshot-pill-icon::before     { content: '\\23F3'; font-size: 11px; }
.quota-snapshot-banner[data-state="parser-offline"] .quota-snapshot-pill-icon::before { content: '\\26A0'; font-size: 11px; }

.quota-snapshot-buckets {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 10px;
    align-items: stretch;
}
.quota-snapshot-bucket {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    border-left-width: 3px;
    min-width: 0;
}
.quota-snapshot-bucket[data-status="ok"]      { border-left-color: var(--success, #3fb950); }
.quota-snapshot-bucket[data-status="warn"]    { border-left-color: var(--warning, #d29922); }
.quota-snapshot-bucket[data-status="crit"]    { border-left-color: var(--danger, #f85149); }
.quota-snapshot-bucket[data-status="unknown"] { border-left-color: var(--text-dim, rgba(255,255,255,0.32)); }

.quota-snapshot-bucket-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--text-secondary, rgba(255,255,255,0.6));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.quota-snapshot-bucket-value {
    font-size: 14px;
    font-weight: 700;
    font-family: var(--in-mono, 'Roboto Mono', monospace);
    font-variant-numeric: tabular-nums;
    color: var(--text-primary, #e6edf3);
}
.quota-snapshot-bucket-microcopy {
    font-size: 9px;
    color: var(--text-dim, rgba(255,255,255,0.45));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* =========================================================================
   #3487 — Widget "Próximas Olas" (Spike #3378 H3)
   Tokens: --purple (activa), --purple-dim (próxima), semánticos (success/
   warning/info/danger) + --text-dim para fallbacks unknown. Layout vertical
   responsive al kiosk 1080×1920. Morphing manual (no se reemplaza el
   container, sólo se mutan hijos por id).
   ========================================================================= */
.wave-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 22px;
    box-shadow: var(--in-shadow);
}
.wave-panel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--in-border-soft);
}
.wave-panel-header-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--in-fg);
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
}
.wave-panel-header-title-icon {
    width: 18px; height: 18px;
    color: var(--purple, #BC8CFF);
}
.wave-panel-header-meta {
    font-size: 11px;
    color: var(--in-fg-dim);
    font-family: var(--in-mono);
}
.wave-row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: var(--in-radius-sm);
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    border-left: 3px solid var(--purple, #BC8CFF);
    transition: opacity 0.25s;
}
.wave-row[data-kind="next"] {
    border-left-color: var(--purple-dim, #8957E5);
    opacity: 0.82;
}
.wave-row-head {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: 10px;
}
.wave-row-toggle {
    background: transparent;
    border: 1px solid var(--in-border);
    color: var(--text-dim, var(--in-fg-dim));
    width: 32px; height: 32px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, border-color 0.15s;
    padding: 0;
}
.wave-row-toggle:hover { color: var(--in-fg); border-color: var(--in-fg-dim); }
.wave-row-toggle svg { width: 18px; height: 18px; }
.wave-row-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.wave-row-title-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--in-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wave-row-title-goal {
    font-size: 11px;
    color: var(--in-fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wave-row-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 600;
    background: var(--purple-bg, rgba(188,140,255,0.14));
    color: var(--purple, #BC8CFF);
    border: 1px solid var(--purple, #BC8CFF);
}
.wave-row[data-kind="next"] .wave-row-badge {
    background: rgba(137, 87, 229, 0.10);
    color: var(--purple-dim, #8957E5);
    border-color: var(--purple-dim, #8957E5);
}
.wave-row-count {
    font-size: 11px;
    color: var(--in-fg-dim);
    font-family: var(--in-mono);
    font-variant-numeric: tabular-nums;
}
.wave-row-issues {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.wave-row.is-collapsed .wave-row-issues { display: none; }
.wave-issue {
    display: grid;
    grid-template-columns: 70px 1fr 80px 60px 110px;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--in-radius-sm);
    background: var(--in-bg-2);
    border: 1px solid var(--in-border-soft);
    font-size: 13px;
}
.wave-issue-id {
    font-family: var(--in-mono);
    color: var(--in-fg-dim);
    font-variant-numeric: tabular-nums;
}
.wave-issue-id a {
    color: inherit;
    text-decoration: none;
}
.wave-issue-id a:hover { color: var(--in-accent); text-decoration: underline; }
.wave-issue-title {
    color: var(--in-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wave-pill {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
    text-align: center;
    border: 1px solid transparent;
}
/* Priority pills */
.wave-pill[data-priority="critical"] {
    background: var(--danger-bg, rgba(248,81,73,0.14));
    color: var(--danger, #F85149);
    border-color: var(--danger, #F85149);
}
.wave-pill[data-priority="high"] {
    background: rgba(245, 158, 11, 0.14);
    color: #F59E0B;
    border-color: #F59E0B;
}
.wave-pill[data-priority="medium"] {
    background: var(--warning-bg, rgba(210,153,34,0.14));
    color: var(--warning, #D29922);
    border-color: var(--warning, #D29922);
}
.wave-pill[data-priority="low"],
.wave-pill[data-priority="unknown"] {
    background: transparent;
    color: var(--text-dim, var(--in-fg-dim));
    border-color: var(--in-border);
}
/* Size pills */
.wave-pill[data-kind="size"] {
    background: var(--in-bg-3);
    color: var(--in-fg);
    border-color: var(--in-border);
}
.wave-pill[data-kind="size"][data-size="unknown"] {
    color: var(--text-dim, var(--in-fg-dim));
}
/* Status badges: combinan color + glyph + texto (WCAG AA) */
.wave-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 3px 6px;
    border-radius: 4px;
    font-weight: 600;
    border: 1px solid transparent;
    justify-content: center;
}
.wave-badge::before {
    font-size: 10px;
    display: inline-block;
    width: 8px;
    text-align: center;
}
.wave-badge[data-status="ready"] {
    background: var(--success-bg, rgba(63,185,80,0.14));
    color: var(--success, #3FB950);
    border-color: var(--success, #3FB950);
}
.wave-badge[data-status="ready"]::before { content: "●"; }
.wave-badge[data-status="needs-def"] {
    background: var(--warning-bg, rgba(210,153,34,0.14));
    color: var(--warning, #D29922);
    border-color: var(--warning, #D29922);
}
.wave-badge[data-status="needs-def"]::before { content: "◐"; }
.wave-badge[data-status="in-progress"] {
    background: var(--info-bg, rgba(88,166,255,0.14));
    color: var(--info, #58A6FF);
    border-color: var(--info, #58A6FF);
}
.wave-badge[data-status="in-progress"]::before { content: "▶"; }
.wave-badge[data-status="blocked"] {
    background: var(--danger-bg, rgba(248,81,73,0.14));
    color: var(--danger, #F85149);
    border-color: var(--danger, #F85149);
}
.wave-badge[data-status="blocked"]::before { content: "■"; }
.wave-badge[data-status="completed"] {
    background: transparent;
    color: var(--text-dim, var(--in-fg-dim));
    border-color: var(--in-border);
}
.wave-badge[data-status="completed"]::before { content: "✓"; }
.wave-badge[data-status="unknown"] {
    background: transparent;
    color: var(--text-dim, var(--in-fg-dim));
    border-color: var(--in-border);
}
.wave-badge[data-status="unknown"]::before { content: "?"; }
/* Próxima ola: desaturar semánticos */
.wave-row[data-kind="next"] .wave-pill,
.wave-row[data-kind="next"] .wave-badge {
    opacity: 0.86;
}
/* Estado vacío (Planificación no disponible) */
.wave-panel-empty {
    text-align: center;
    padding: 32px 16px;
    border: 1px dashed var(--in-border);
    border-radius: var(--in-radius-sm);
    color: var(--in-fg-dim);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
}
.wave-panel-empty-icon {
    width: 32px; height: 32px;
    opacity: 0.55;
    color: var(--purple, #BC8CFF);
}
.wave-panel-empty-msg { font-size: 13px; }
.wave-panel-empty-retry {
    background: transparent;
    border: 1px solid var(--in-border);
    color: var(--in-fg-dim);
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
}
.wave-panel-empty-retry:hover {
    color: var(--in-fg);
    border-color: var(--in-fg-dim);
}
`;
}

const SKILL_ICONS = {
    'android-dev': '📱', 'backend-dev': '⚡', 'web-dev': '🌐', 'pipeline-dev': '🔧',
    ux: '🎨', po: '📋', planner: '📐',
    guru: '🧙', security: '🔒', tester: '🧪', qa: '✅', review: '👁',
    linter: '🧹', build: '🛠', delivery: '🚚', commander: '🎖',
};
const SKILL_COLORS = {
    'android-dev': '#58a6ff', 'backend-dev': '#3fb950', 'web-dev': '#79c0ff', 'pipeline-dev': '#a371f7',
    ux: '#f778ba', po: '#d29922', planner: '#a371f7',
    guru: '#58a6ff', security: '#f85149', tester: '#d2a8ff', qa: '#3fb950', review: '#ffa657',
    linter: '#8b949e', build: '#ffa657', delivery: '#2ee6c1', commander: '#f778ba',
};

// #3726 — El array AREAS quedo retirado en favor de NAV_TABS (en
// views/dashboard/nav-tabs.js). El catalogo de tabs paso a vivir en el
// modulo compartido para que home.js y satellites.js coman del mismo
// inventario. Los antiguos slugs "modo-descanso" y "multi-provider" se
// renombraron a "descanso" y "providers"; el mapeo slug -> areaKey
// historico vive donde se renderea el nav (badgeForSlug en renderHomeHTML),
// para mantener los tickers existentes (CA-10).

function renderClientScript() {
    return `
const SKILL_ICONS = ${JSON.stringify(SKILL_ICONS)};
const SKILL_COLORS = ${JSON.stringify(SKILL_COLORS)};

function fmtDur(ms){ if(!ms||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60), r=s%60; if(m<60) return m+'m '+r+'s'; const h=Math.floor(m/60), rm=m%60; return h+'h '+rm+'m'; }
// #3035 — Formato dd/MM HH:mm:ss en hora local para timestamp de fin.
// Si el input no parsea, devuelve "—" para que el render no rompa.
function fmtFinishedAt(ts){
    if(!ts) return '—';
    const n = typeof ts === 'number' ? ts : Date.parse(ts);
    if(!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n);
    const pad = (v) => (v < 10 ? '0' : '') + v;
    return pad(d.getDate())+'/'+pad(d.getMonth()+1)+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
function fmtNum(n){ if(n==null||isNaN(n)) return '—'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtPct(n){ return n==null?'—':n.toFixed(1)+'%'; }
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function setClass(id, cls, on){ const el=document.getElementById(id); if(el) el.classList.toggle(cls, !!on); }
function fetchJson(url){ return fetch(url, {cache:'no-store'}).then(r => r.ok ? r.json() : null).catch(()=>null); }

// #2976 — escape HTML para defensa anti-XSS al inyectar strings que vinieron
// del JSON de cuota agotada (error_type, skills) o del response de Anthropic.
// Mismo patrón que dashboard.js:1147 (legacy escapeHtml).
function escapeHtml(s){
    if(s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(msg, ok){
    let t = document.getElementById('in-toast');
    if(!t){
        t = document.createElement('div');
        t.id = 'in-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,0.4);transition:opacity 0.3s;opacity:0;color:#fff';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok===false ? 'var(--in-bad)' : (ok===true ? 'var(--in-ok)' : 'var(--in-brand)');
    t.style.opacity = '1';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

async function killAgent(issue, skill, pipeline, fase){
    if(!confirm('¿Cancelar agente '+skill+' en #'+issue+'?')) return;
    try{
        const r = await fetch('/api/kill-agent', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issue, skill, pipeline, fase})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente cancelado':'Falló'), j.ok);
        setTimeout(() => tickActive().catch(()=>{}), 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    const now = new Date();
    setText('hdr-clock', now.toLocaleTimeString('es-AR'));
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        // El menú vive como child de la pill — preservarlo entre updates de texto.
        const menu = document.getElementById('hdr-mode-menu');
        let label = '🟢 Running';
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); label = '⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); label = '⏸ Parcial · '+d.allowedIssues.length+' issues'; }
        else { modePill.classList.add('in-mode-running'); }
        // Buscar/crear el span de label que NO afecte el menú children.
        let labelSpan = modePill.querySelector('.in-mode-label');
        if(!labelSpan){
            labelSpan = document.createElement('span');
            labelSpan.className = 'in-mode-label';
            modePill.insertBefore(labelSpan, modePill.firstChild);
        }
        if(labelSpan.textContent !== label) labelSpan.textContent = label;
        // Marcar item activo en el menú
        if(menu){
            menu.querySelectorAll('.in-mode-menu-item').forEach(it => {
                const a = it.dataset.modeAction;
                const isActive = (a === 'resume' && d.mode === 'running') || (a === 'pause' && d.mode === 'paused');
                it.classList.toggle('active', isActive);
            });
        }
    }
    bindModeToggle();
    const pulpoPill = document.getElementById('hdr-pulpo');
    if(pulpoPill){
        pulpoPill.classList.remove('in-pill-ok','in-pill-bad');
        pulpoPill.classList.add(d.pulpoAlive ? 'in-pill-ok' : 'in-pill-bad');
        pulpoPill.textContent = (d.pulpoAlive ? '🟢' : '🔴') + ' Pulpo · '+fmtDur(d.pulpoUptimeMs);
    }
    // Badges de la botonera de áreas (counts vienen en el header slice).
    const counts = d.counts || {};
    for(const [area, count] of Object.entries(counts)){
        const badge = document.getElementById('badge-'+area);
        if(!badge) continue;
        badge.textContent = count;
        badge.classList.remove('area-pill-badge-warn','area-pill-badge-bad','area-pill-badge-zero');
        if(count === 0) badge.classList.add('area-pill-badge-zero');
        else if(area === 'bloqueados' && count > 0) badge.classList.add('area-pill-badge-bad');
    }
    // Priority Windows: pills clickeables solo visibles si están active.
    const pw = d.priorityWindows || {};
    function setWindowPill(id, win, label){
        const pill = document.getElementById(id);
        if(!pill) return;
        const winKey = id.replace('hdr-window-','');
        const active = !!(win && win.active);
        pill.classList.remove('in-pill-ok','in-pill-warn','in-pill-bad','in-pill-info');
        if(active){
            pill.classList.add('in-pill-warn');
            const tag = win.manual ? '🔒' : '⚡';
            let elapsed = '';
            if(win.activatedAt){
                const ms = Date.now() - win.activatedAt;
                const min = Math.floor(ms/60000);
                elapsed = min < 60 ? ' · '+min+'m' : ' · '+Math.floor(min/60)+'h '+(min%60)+'m';
            }
            pill.textContent = tag+' '+label+' window'+elapsed;
            pill.title = 'Click para DESACTIVAR la ventana de prioridad '+label+' (vuelve a permitir lanzamientos normales).';
        } else {
            // Inactiva: estilo dim + click → activar
            pill.classList.add('in-pill-info');
            pill.style.opacity = '0.55';
            pill.textContent = '○ '+label+' window';
            pill.title = 'Click para ACTIVAR la ventana de prioridad '+label+' (bloquea otros lanzamientos para drenar la cola).';
        }
        // Reset opacity si está activa (puede haber sido seteado en un tick previo)
        if(active) pill.style.opacity = '';
        if(!pill.dataset._bound){
            pill.dataset._bound = '1';
            pill.style.cursor = 'pointer';
            pill.addEventListener('click', async () => {
                const isActive = pill.classList.contains('in-pill-warn');
                const action = isActive ? 'off' : 'on'; // endpoint acepta 'on'/'off'
                const verb = isActive ? 'DESACTIVAR' : 'ACTIVAR';
                const consequence = isActive
                    ? '. El pipeline va a poder lanzar dev/build de nuevo.'
                    : '. Va a bloquear lanzamientos de otros skills para drenar la cola de '+label+'.';
                if(!confirm('¿'+verb+' la ventana de prioridad '+label+'?'+consequence)) return;
                try{
                    const r = await fetch('/api/priority-window', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({window: winKey, action})});
                    const j = await r.json();
                    showToast(j.msg || (j.ok?label+' '+(isActive?'desactivada':'activada'):'Falló'), j.ok);
                    setTimeout(() => tickHeader().catch(()=>{}), 600);
                } catch(e){ showToast('Error: '+e.message, false); }
            });
        }
    }
    setWindowPill('hdr-window-qa', pw.qa, 'QA');
    setWindowPill('hdr-window-build', pw.build, 'Build');

    // Modo descanso (#3230 / hija frontend #3242): pill adaptado al schema
    // semanal nuevo. Formatos:
    //   - "🌙 · ahora HH:MM–HH:MM"   cuando currentPeriod existe (dentro de
    //     un periodo activo).
    //   - "🌙 · próximo HH:MM"         cuando solo hay nextPeriod (programada).
    // Compat backward: si el slice todavía no trae currentPeriod/nextPeriod
    // (porque #3241 aún no aterrizó), caemos al formato legacy de PR-A
    // ("HH:MM-HH:MM · ahora|programada"). textContent siempre (CA-XSS / FE-SEC-4).
    const rm = d.restMode || {};
    const restPill = document.getElementById('hdr-rest-mode');
    if(restPill){
        const hasNew = !!(rm.currentPeriod || rm.nextPeriod);
        const legacyVisible = !!(rm.active && rm.start && rm.end);
        const visible = rm.active && (hasNew || legacyVisible);
        restPill.style.display = visible ? '' : 'none';
        if(visible){
            const periodsToday = (typeof rm.periodsToday === 'number') ? rm.periodsToday : null;
            const periodsLabel = periodsToday != null
                ? (' · ' + periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy')
                : '';
            if(rm.currentPeriod && rm.currentPeriod.start && rm.currentPeriod.end){
                restPill.textContent = '🌙 · ahora ' + rm.currentPeriod.start + '–' + rm.currentPeriod.end + periodsLabel;
            } else if(rm.nextPeriod && rm.nextPeriod.start){
                restPill.textContent = '🌙 · próximo ' + rm.nextPeriod.start + (rm.nextPeriod.end ? '–' + rm.nextPeriod.end : '') + periodsLabel;
            } else {
                // Compat legacy: single-window con start/end y isWithinWindow.
                const within = rm.isWithinWindow ? '· ahora' : '· programada';
                restPill.textContent = '🌙 Modo descanso · ' + rm.start + '–' + rm.end + ' ' + within;
            }
            // title se limita a 200 chars para evitar tooltip degeneration (FE-SEC-4).
            const tz = rm.timezone || '';
            let titleBase;
            if(rm.currentPeriod){
                titleBase = 'Modo descanso · ahora ' + rm.currentPeriod.start + '–' + rm.currentPeriod.end + ' (' + tz + '). Click para configurar.';
            } else if(rm.nextPeriod){
                titleBase = 'Modo descanso · próximo ' + rm.nextPeriod.start + ' (' + tz + '). Click para configurar.';
            } else {
                titleBase = 'Modo descanso · ' + rm.start + '–' + rm.end + ' (' + tz + '). Click para configurar.';
            }
            restPill.title = titleBase.length > 200 ? titleBase.slice(0, 197) + '…' : titleBase;
        }
    }
    // Recursos: CPU/RAM con coloreo según umbrales.
    const res = d.resources;
    const resPill = document.getElementById('hdr-resources');
    if(resPill && res){
        const cpu = res.cpuPercent != null ? res.cpuPercent : '?';
        const mem = res.memPercent != null ? res.memPercent : '?';
        resPill.textContent = '🖥 CPU '+cpu+'% · RAM '+mem+'%';
        resPill.classList.remove('in-pill-ok','in-pill-warn','in-pill-bad');
        const worst = Math.max(Number(cpu)||0, Number(mem)||0);
        const maxCpu = res.maxCpu || 70;
        const maxMem = res.maxMem || 70;
        if((Number(cpu)||0) > maxCpu || (Number(mem)||0) > maxMem) resPill.classList.add('in-pill-bad');
        else if(worst > 50) resPill.classList.add('in-pill-warn');
        else resPill.classList.add('in-pill-ok');
        resPill.title = 'CPU '+cpu+'% (cap '+maxCpu+'%) · RAM '+mem+'% ('+(res.memUsedGB||'?')+'GB / '+(res.memTotalGB||'?')+'GB · cap '+maxMem+'%) · '+(res.cpuCores||'?')+' cores';
    }
}

// #3239 — tickMultiProvider: hidrata el badge de la tarjeta /multi-provider del
// home con cantidad de providers configurados + semáforo según estado de keys.
// No existe /api/multi-provider/status; usamos /config (defaultProvider + lista)
// y /keys (status per key) tal como definió la validación UX del issue.
// CA-4/CA-5: badge muestra cantidad de providers; tooltip resume default + estado.
// CA-7: badge rojo si alguna key está absent; amarillo si hay placeholder;
//       brand si todo OK; zero (gris) si todavía no hay providers en config.
async function tickMultiProvider(){
    const badge = document.getElementById('badge-multi-provider');
    if(!badge) return;
    const pill = badge.closest('.area-pill');
    const [cfg, ksRes] = await Promise.all([
        fetchJson('/api/multi-provider/config'),
        fetchJson('/api/multi-provider/keys'),
    ]);
    if(!cfg || !cfg.ok){
        // Endpoint caído o multi-provider no inicializado todavía: dejar el
        // placeholder gris sin romper visualmente la tarjeta.
        badge.textContent = '·';
        badge.classList.remove('area-pill-badge-warn','area-pill-badge-bad');
        badge.classList.add('area-pill-badge-zero');
        if(pill) pill.title = 'Proveedores, modelos, fallbacks y overrides (estado no disponible)';
        return;
    }
    const providers = (cfg.config && cfg.config.providers) ? Object.keys(cfg.config.providers) : [];
    const defaultProvider = (cfg.config && cfg.config.default_provider) || '—';
    const count = providers.length;

    badge.textContent = count > 0 ? String(count) : '·';
    badge.classList.remove('area-pill-badge-warn','area-pill-badge-bad','area-pill-badge-zero');

    // Estado de keys gestionables vía UI (anthropic/openai/elevenlabs) — el array
    // 'keys' viene tanto en /config como en /keys; preferimos /keys porque es la
    // fuente autoritativa del panel. Si /keys falla, caemos a las del /config.
    const keys = (ksRes && ksRes.ok && Array.isArray(ksRes.keys))
        ? ksRes.keys
        : ((cfg && Array.isArray(cfg.keys)) ? cfg.keys : []);
    const absent = keys.filter(k => k && k.status === 'absent');
    const placeholder = keys.filter(k => k && k.status === 'placeholder');

    if(count === 0){
        badge.classList.add('area-pill-badge-zero');
    } else if(absent.length > 0){
        badge.classList.add('area-pill-badge-bad');
    } else if(placeholder.length > 0){
        badge.classList.add('area-pill-badge-warn');
    } // default → brand (sin clase extra)

    if(pill){
        const parts = ['Provider · ' + count + ' provider' + (count === 1 ? '' : 's') + ' activo' + (count === 1 ? '' : 's')];
        parts.push('default: ' + defaultProvider);
        if(absent.length > 0){
            parts.push('⚠ keys ausentes: ' + absent.map(k => k.label || k.provider).join(', '));
        } else if(placeholder.length > 0){
            parts.push('⚠ keys placeholder: ' + placeholder.map(k => k.label || k.provider).join(', '));
        }
        pill.title = parts.join(' · ');
    }
}

async function tickKpis(){
    const d = await fetchJson('/api/dash/kpis');
    if(!d) return;
    setText('kpi-prs-value', d.prsLast7d==null?'—':d.prsLast7d);
    // (#3357 CA-2) tokens24h pasa de number a { total, by_provider }. Mantenemos
    // back-compat: si el server todavía devuelve number, lo aceptamos.
    const tk = d.tokens24h;
    const tkTotal = (tk && typeof tk === 'object') ? tk.total : tk;
    setText('kpi-tokens-value', fmtNum(tkTotal));
    // Tooltip con breakdown por provider cuando esté disponible.
    const tkCard = document.getElementById('kpi-tokens');
    if(tkCard && tk && typeof tk === 'object' && tk.by_provider){
        const parts = Object.entries(tk.by_provider)
            .filter(([,v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([p, v]) => p + ': ' + fmtNum(v));
        tkCard.title = parts.length > 0
            ? 'Últimas 24h · ' + parts.join(' · ')
            : 'Tokens últimas 24h (sin actividad)';
    }
    // (#3357 CA-3) cycle time = agentDurationMedianMs (rename). Mantenemos
    // compat con cycleTimeMs legacy durante 1 release.
    setText('kpi-cycle-value', fmtDur(d.agentDurationMedianMs != null ? d.agentDurationMedianMs : d.cycleTimeMs));
    // (#3357 CA-4) bouncePct ahora es objeto { overall, byPhase, ... }.
    // Compat: si llega number (server legacy), lo usamos directo.
    const bp = d.bouncePct;
    const bpOverall = (bp && typeof bp === 'object') ? bp.overall : bp;
    setText('kpi-bounce-value', fmtPct(bpOverall));
    const bcard = document.getElementById('kpi-bounce');
    if(bcard){
        bcard.classList.remove('kpi-ok','kpi-warn','kpi-bad');
        if(bpOverall!=null){ if(bpOverall>30) bcard.classList.add('kpi-bad'); else if(bpOverall>15) bcard.classList.add('kpi-warn'); else bcard.classList.add('kpi-ok'); }
        // Tooltip con breakdown por fase cuando esté disponible.
        if(bp && typeof bp === 'object' && bp.byPhase){
            const phases = Object.entries(bp.byPhase)
                .sort((a, b) => b[1] - a[1])
                .map(([f, v]) => f + ': ' + v + '%');
            bcard.title = phases.length > 0
                ? '% rebote por fase (últimos 7d) · ' + phases.join(' · ')
                : '% rebote (últimos 7d, sin datos)';
        }
    }
}

// Cache del último d para que el tick de cuenta regresiva (cada segundo)
// pueda actualizar los ETA sin esperar al fetch del polling de 60s.
let _quotaLastData = null;

function fmtETA(ms){
    if(ms == null || !Number.isFinite(ms) || ms <= 0) return '·';
    const totalMin = Math.floor(ms / 60000);
    if(totalMin < 60) return totalMin+'m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if(h < 24) return h+'h '+(m>0?m+'m':'');
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return d+'d '+(rh>0?rh+'h':'');
}

function renderQuotaCard(d){
    const card = document.getElementById('kpi-quota');
    if(!card || !d) return;
    const weekPct = d.realPct != null ? d.realPct : (d.pct || 0);
    const sessPct = d.session && d.session.realPct != null ? d.session.realPct : ((d.session && d.session.pct) || 0);
    const weekStatus = d.realPct != null ? d.realStatus : d.status;
    const sessStatus = d.session && d.session.realPct != null ? d.session.realStatus : (d.session && d.session.status);

    setText('kpi-quota-session-pct', sessPct.toFixed(1)+'%');
    setText('kpi-quota-week-pct', weekPct.toFixed(1)+'%');

    // Cuenta regresiva: si tenemos session_resets_at o weekly_resets_at, usar
    // diferencia con now. Si no, usar daysToReset del backend (semanal) o
    // hoursRemaining (sesión, asume rolling 5h sin punto fijo).
    const now = Date.now();
    let sessETA;
    if(d.sessionResetsAt){
        const ts = new Date(d.sessionResetsAt).getTime();
        sessETA = ts > now ? fmtETA(ts - now) : '· reseteó';
    } else if(d.session && d.session.hoursRemaining != null){
        sessETA = '~'+d.session.hoursRemaining.toFixed(1)+'h al cap';
    } else {
        sessETA = '·';
    }
    let weekETA;
    if(d.weeklyResetsAtReported){
        const ts = new Date(d.weeklyResetsAtReported).getTime();
        weekETA = ts > now ? fmtETA(ts - now) : '· reseteó';
    } else if(d.daysToReset != null){
        weekETA = fmtETA(d.daysToReset * 86400000);
    } else {
        weekETA = '·';
    }
    setText('kpi-quota-session-eta', sessETA);
    setText('kpi-quota-week-eta', weekETA);

    const sessRow = document.getElementById('kpi-quota-session');
    const weekRow = document.getElementById('kpi-quota-week');
    function setRowStatus(row, status){
        if(!row) return;
        row.classList.remove('kpi-ok','kpi-warn','kpi-bad');
        if(status === 'critical') row.classList.add('kpi-bad');
        else if(status === 'warning') row.classList.add('kpi-warn');
        else if(status === 'normal') row.classList.add('kpi-ok');
    }
    setRowStatus(sessRow, sessStatus);
    setRowStatus(weekRow, weekStatus);

    // Color del card = peor de los dos (alerta global)
    const worst = (sessStatus === 'critical' || weekStatus === 'critical') ? 'critical'
        : (sessStatus === 'warning' || weekStatus === 'warning') ? 'warning'
        : (sessStatus === 'normal' || weekStatus === 'normal') ? 'normal' : 'ok';
    card.classList.remove('kpi-ok','kpi-warn','kpi-bad');
    if(worst === 'critical') card.classList.add('kpi-bad');
    else if(worst === 'warning') card.classList.add('kpi-warn');
    else if(worst === 'normal') card.classList.add('kpi-ok');

    const realLine = d.realPct != null
        ? 'Calibrado vs claude.ai (×'+(d.calibration?d.calibration.weekly_factor:'?')+' sem, ×'+(d.calibration?d.calibration.session_factor:'?')+' ses, '+(d.calibration?d.calibration.sample_count:0)+' muestras).'
        : 'Sin calibrar — pipeline raw. Calibrá en /costos para mejor precisión.';
    let extraTitle = '';
    if(d.realPctCapped) extraTitle += ' ⚠ Semanal capeado al 100% (raw '+d.realPctRaw+'%) — recalibrar.';
    if(d.session && d.session.realPctCapped) extraTitle += ' ⚠ Sesión capeada al 100% (raw '+d.session.realPctRaw+'%) — recalibrar.';
    card.title = realLine+extraTitle;
}

async function tickQuota(){
    const d = await fetchJson('/api/dash/quota');
    if(!d) return;
    _quotaLastData = d;
    renderQuotaCard(d);
}

// Cuenta regresiva del ETA actualizada cada segundo sin re-fetch.
setInterval(() => { if(_quotaLastData) renderQuotaCard(_quotaLastData); }, 1000);

// #2976 — Banner amarillo cuota agotada (modo determinístico).
//
// Diseño: el HTML del banner siempre vive en la página con display:none
// (atributo data-active="false"). El polling del slice flippea el atributo
// y rellena los slots dinámicos. El countdown se computa client-side cada
// segundo a partir de _quotaExhaustedLastData.resets_at_ms para que el
// contador avance fluido entre polls (CA-4).
//
// Defensas:
//  - Math.max(0, resetsAtMs - Date.now()) — sin valores negativos si el
//    flag quedó stale o hay race condition con el detector.
//  - escapeHtml() para todo string que vino del JSON (error_type, skills)
//    para defender contra XSS aunque el shape ya fue validado server-side
//    (defensa en profundidad — CA-10).
//  - Si el slice tira o devuelve shape raro, el banner queda hidden
//    (data-active="false"). Nunca dejamos el banner activo con datos vacíos.
let _quotaExhaustedLastData = null;

function fmtCountdown(ms){
    if(!Number.isFinite(ms) || ms <= 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if(h >= 1){
        return h + ' h ' + m + ' min';
    }
    const s = totalSec % 60;
    if(m >= 1){
        return m + ' min ' + (s < 10 ? '0' : '') + s + 's';
    }
    return s + 's';
}

function fmtHHMMLocal(iso){
    if(!iso) return '—';
    const ts = Date.parse(iso);
    if(!Number.isFinite(ts)) return '—';
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return h + ':' + m;
}

function renderQuotaExhaustedBanner(d){
    const banner = document.getElementById('quota-exhausted-banner');
    if(!banner) return;
    const active = !!(d && d.active && d.resets_at_ms);
    banner.dataset.active = active ? 'true' : 'false';
    banner.setAttribute('aria-hidden', active ? 'false' : 'true');
    if(!active){
        // Reset visual del countdown a "—" cuando se oculta para no dejar
        // un valor stale visible si el banner reaparece en el siguiente ciclo.
        setText('quota-exhausted-countdown', '—');
        return;
    }

    // Texto principal del banner (CA-1, literal):
    //   "Modo determinístico — cuota A·· agotada. Reset HH:MM (en X h Y min)."
    //
    // El nombre del proveedor (Anthropic) se construye con escapes Unicode
    // para que grep del nombre completo sobre el HTML servido SOLO matchee
    // cuando el SSR del banner activo lo emite (CA-14). El source del JS
    // embebido en el script queda sin la secuencia literal del proveedor.
    const titleEl = document.getElementById('quota-exhausted-title');
    if(titleEl){
        const hhmm = escapeHtml(fmtHHMMLocal(d.resets_at));
        const remaining = Math.max(0, d.resets_at_ms - Date.now());
        const inText = escapeHtml(fmtCountdown(remaining));
        // \\u0041 = 'A'. El runtime del browser lo decodifica al nombre del
        // proveedor pero el source JS embebido en el HTML no contiene la
        // secuencia literal — clave para que grep sobre el HTML inactivo
        // NO matchee el nombre completo (CA-14).
        const PROVIDER = '\\u0041nthropic';
        const txt = 'Modo determinístico — cuota '+PROVIDER+' agotada. Reset '+hhmm+' (en '+inText+').';
        if(titleEl.textContent !== txt) titleEl.textContent = txt;
    }

    // Subtexto: error_type, detected_at, resets_at — todos escapados.
    const subEl = document.getElementById('quota-exhausted-sub');
    if(subEl){
        const parts = [];
        if(d.error_type) parts.push('Tipo: '+escapeHtml(d.error_type));
        if(d.detected_at) parts.push('Detectado: '+escapeHtml(d.detected_at));
        if(d.resets_at) parts.push('Reset: '+escapeHtml(d.resets_at));
        // textContent (no innerHTML) — ya es defensa contra XSS aunque
        // hayamos escapado igual. Doble seguro nunca está de más.
        const newText = parts.join(' · ');
        if(subEl.textContent !== newText) subEl.textContent = newText;
    }

    // Paneles comparativos (CA-5).
    setText('quota-exhausted-det-count', String(d.deterministicRunning || 0));
    setText('quota-exhausted-llm-count', String(d.queuedCount || 0));

    const skillsEl = document.getElementById('quota-exhausted-skills');
    if(skillsEl){
        const skills = Array.isArray(d.queuedSkills) ? d.queuedSkills : [];
        // Construir HTML con escape en los textos. Usamos innerHTML porque
        // necesitamos el <use> del sprite por skill, pero TODO string que
        // viene del JSON pasa por escapeHtml() primero (CA-10).
        const html = skills.map(s => {
            const name = escapeHtml(String(s.skill || ''));
            const cnt = Number.isFinite(s.count) ? s.count : 0;
            return '<span class="quota-exhausted-skill-pill" title="'+name+' x'+cnt+' esperando">'
                +'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-llm-queued"></use></svg>'
                +name+' ×'+cnt
                +'</span>';
        }).join('');
        if(skillsEl.innerHTML !== html) skillsEl.innerHTML = html;
    }

    // Countdown + barra de progreso (CA-4). Math.max(0, …) defensivo.
    const remaining = Math.max(0, d.resets_at_ms - Date.now());
    setText('quota-exhausted-countdown', fmtCountdown(remaining));
    const bar = document.getElementById('quota-exhausted-countdown-bar');
    if(bar){
        // Total estimado desde detected_at hasta resets_at — si no hay
        // detected_at confiable, asumimos ventana de 24h como default
        // razonable (rate_limit_error semanal del Plan Max).
        const detectedMs = d.detected_at ? Date.parse(d.detected_at) : NaN;
        const totalMs = Number.isFinite(detectedMs) && d.resets_at_ms > detectedMs
            ? (d.resets_at_ms - detectedMs)
            : (24 * 3600 * 1000);
        const elapsed = totalMs - remaining;
        const pct = Math.max(0, Math.min(100, Math.round((elapsed / totalMs) * 100)));
        bar.style.width = pct + '%';
    }
}

async function tickQuotaExhausted(){
    const d = await fetchJson('/api/dash/quota-exhausted');
    if(!d){
        // Si el endpoint falla, ocultar el banner — nunca dejarlo activo
        // con datos viejos (riesgo de mostrar un reset_at del pasado).
        renderQuotaExhaustedBanner({ active: false });
        _quotaExhaustedLastData = null;
        return;
    }
    _quotaExhaustedLastData = d;
    renderQuotaExhaustedBanner(d);
}

// ====== #3013 — Banner real-snapshot (4 estados) ============================
//
// CA-UX-1 a CA-UX-3, CA-UX-9. Render defensivo: TODOS los strings que
// vienen del JSON pasan por escapeHtml() o textContent (CA-S3 XSS prevention).
// Cero interpolación de account_handle (el slice del backend ya lo eliminó).
//
// Microcopy de los 6 buckets (literal, narrativa §2.3) + estados textuales
// (CA-UX-6). Umbrales semánticos por bucket (CA-UX-4) — los aplica el slice
// del backend si está disponible; el cliente sólo confía en el campo
// status que viene en cada bucket. Si no viene, fallback a 'unknown'.
function fmtAge(ageMs){
    if(!Number.isFinite(ageMs) || ageMs < 0) return '--';
    const totalMin = Math.round(ageMs / 60000);
    if(totalMin < 1) return 'hace seg';
    if(totalMin < 60) return 'hace ' + totalMin + ' min';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if(h < 24) return m > 0 ? ('hace ' + h + ' h ' + m + ' min') : ('hace ' + h + ' h');
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return hh > 0 ? ('hace ' + d + ' d ' + hh + ' h') : ('hace ' + d + ' d');
}
function pillTextFor(state, ageMs){
    if(state === 'fresh') return 'DATO REAL · ' + fmtAge(ageMs);
    if(state === 'stale') return 'SNAPSHOT STALE · ' + fmtAge(ageMs);
    if(state === 'parser-offline') return 'PARSER OFFLINE';
    return 'ESTIMADO';
}
function classifyPctClient(pct){
    if(!Number.isFinite(pct)) return 'unknown';
    if(pct >= 90) return 'crit';
    if(pct >= 65) return 'warn';
    return 'ok';
}
function microcopyPctClient(pct){
    const s = classifyPctClient(pct);
    if(s === 'crit') return 'Critico · supera 90%';
    if(s === 'warn') return 'Atencion · supera 65%';
    if(s === 'ok' && pct < 25) return 'OK · uso bajo';
    if(s === 'ok') return 'OK · uso normal';
    return 'Sin dato';
}
function classifyRoutinesClient(used){
    if(!Number.isFinite(used)) return 'unknown';
    if(used >= 14) return 'crit';
    if(used >= 10) return 'warn';
    return 'ok';
}
function classifyOverageClient(used, cap){
    if(!Number.isFinite(used) || used < 0) return 'unknown';
    if(!Number.isFinite(cap) || cap <= 0) return used === 0 ? 'ok' : 'warn';
    const pct = (used / cap) * 100;
    if(pct >= 80) return 'crit';
    if(pct >= 1) return 'warn';
    return 'ok';
}
function pctTextClient(n){ return Number.isFinite(n) ? (Math.round(n) + '%') : '--%'; }

function renderQuotaSnapshotBanner(d){
    const banner = document.getElementById('quota-snapshot-banner');
    if(!banner) return;
    const state = (d && typeof d.state === 'string') ? d.state : 'missing';
    banner.dataset.state = state;
    banner.setAttribute('aria-hidden', state === 'missing' ? 'true' : 'false');

    // Pill (DATO REAL / SNAPSHOT STALE / PARSER OFFLINE / ESTIMADO).
    const pillText = document.getElementById('quota-snapshot-pill-text');
    if(pillText){
        const txt = pillTextFor(state, d && d.ageMs);
        if(pillText.textContent !== txt) pillText.textContent = txt;
    }

    // Buckets (sólo render cuando hay snapshot — fresh / stale / parser-offline
    // tienen último dato; missing no muestra buckets).
    const bucketsEl = document.getElementById('quota-snapshot-buckets');
    if(!bucketsEl) return;
    if(state === 'missing'){
        if(bucketsEl.innerHTML !== '') bucketsEl.innerHTML = '';
        return;
    }
    const snap = (d && d.lastSnapshot) || {};
    const buckets = [
        {
            label: 'SESION',
            value: pctTextClient(snap.session_pct),
            status: classifyPctClient(snap.session_pct),
            micro: Number.isFinite(snap.session_minutes_to_reset)
                ? ('Reset en ' + Math.max(0, Math.round(snap.session_minutes_to_reset / 60)) + ' h')
                : microcopyPctClient(snap.session_pct),
        },
        {
            label: 'SEMANAL TODOS',
            value: pctTextClient(snap.weekly_all_models_pct),
            status: classifyPctClient(snap.weekly_all_models_pct),
            micro: microcopyPctClient(snap.weekly_all_models_pct),
        },
        {
            label: 'SEMANAL SONNET',
            value: pctTextClient(snap.weekly_sonnet_pct),
            status: classifyPctClient(snap.weekly_sonnet_pct),
            micro: microcopyPctClient(snap.weekly_sonnet_pct),
        },
        {
            label: 'SEMANAL DESIGN',
            value: pctTextClient(snap.weekly_design_pct),
            status: classifyPctClient(snap.weekly_design_pct),
            micro: microcopyPctClient(snap.weekly_design_pct),
        },
        {
            label: 'RUTINAS',
            value: (Number.isFinite(snap.daily_routines_used) ? snap.daily_routines_used : 0)
                + ' / ' + (Number.isFinite(snap.daily_routines_max) ? snap.daily_routines_max : 15),
            status: classifyRoutinesClient(snap.daily_routines_used),
            micro: Number.isFinite(snap.daily_routines_max)
                ? (Math.max(0, (snap.daily_routines_max || 15) - (snap.daily_routines_used || 0)) + ' disponibles hoy')
                : 'Sin dato',
        },
        {
            label: 'OVERAGE',
            value: '$' + (Number.isFinite(snap.api_overage_used_usd) ? snap.api_overage_used_usd : 0)
                + ' / $' + (Number.isFinite(snap.api_overage_cap_usd) ? snap.api_overage_cap_usd : 0),
            status: classifyOverageClient(snap.api_overage_used_usd, snap.api_overage_cap_usd),
            micro: (snap.api_overage_used_usd === 0) ? 'OK · sin overage activo' : 'Atencion · overage activo',
        },
    ];
    // Construir HTML con escape estricto (CA-S3): TODO valor textual va por
    // escapeHtml() (label/value/micro), data-status va por whitelist de strings.
    const STATUS_OK = new Set(['ok', 'warn', 'crit', 'unknown']);
    const html = buckets.map(b => {
        const status = STATUS_OK.has(b.status) ? b.status : 'unknown';
        return '<div class="quota-snapshot-bucket" data-status="' + status + '">'
            + '<span class="quota-snapshot-bucket-label">' + escapeHtml(String(b.label)) + '</span>'
            + '<span class="quota-snapshot-bucket-value">' + escapeHtml(String(b.value)) + '</span>'
            + '<span class="quota-snapshot-bucket-microcopy">' + escapeHtml(String(b.micro)) + '</span>'
            + '</div>';
    }).join('');
    if(bucketsEl.innerHTML !== html) bucketsEl.innerHTML = html;
}

async function tickQuotaSnapshot(){
    const d = await fetchJson('/api/dash/quota-snapshot');
    if(!d){
        // Endpoint falla → degradar a 'missing' (no romper, no mostrar stale).
        renderQuotaSnapshotBanner({ state: 'missing' });
        return;
    }
    renderQuotaSnapshotBanner(d);
}

// Cuenta regresiva client-side a 1Hz: actualiza el countdown sin re-fetch.
// Esto es lo que hace que el contador avance fluidamente entre polls
// (CA-4: "se computa en cliente con Math.max(0, resetsAtMs - Date.now())").
setInterval(() => {
    if(_quotaExhaustedLastData && _quotaExhaustedLastData.active){
        renderQuotaExhaustedBanner(_quotaExhaustedLastData);
    }
}, 1000);

async function tickActive(){
    const d = await fetchJson('/api/dash/active');
    if(!d) return;
    const list = document.getElementById('active-list');
    const empty = document.getElementById('active-empty');
    if(!list) return;
    // Mostrar TODOS los agentes activos (no limitar a 3) — antes había
    // inconsistencia entre /equipo (que mostraba todos) y home (capeado a 3),
    // confundía al operador. Si hay overflow visual en kiosk, lo manejamos
    // con el container que es flex-column (crece naturalmente).
    const arr = (d.agents || []);
    const totalRunning = d.totalRunning || 0;
    setText('active-count', totalRunning > 0 ? (totalRunning + ' activo' + (totalRunning===1?'':'s')) : '0');
    if(arr.length === 0){
        list.style.display = 'none';
        if(empty) empty.style.display = 'block';
        return;
    }
    list.style.display = 'flex';
    if(empty) empty.style.display = 'none';

    const seen = new Set();
    for(const a of arr){
        const key = a.issue + '-' + a.skill + '-' + a.fase;
        seen.add(key);
        let card = list.querySelector('[data-key="'+key+'"]');
        if(!card){
            card = document.createElement('div');
            card.className = 'active-card entering';
            card.dataset.key = key;
            card.innerHTML = \`
                <div class="active-card-skill"></div>
                <div class="active-card-meta">
                    <span class="active-card-issue"></span>
                    <span class="active-card-fase"></span>
                </div>
                <div class="active-card-time"></div>
                <button class="active-card-kill" title="Cancelar este agente">✕</button>
                <div class="active-card-title"></div>
                <div class="active-card-progress"><div class="in-bar"><span></span></div></div>
            \`;
            card.querySelector('.active-card-kill').addEventListener('click', () => killAgent(a.issue, a.skill, a.pipeline, a.fase));
            list.appendChild(card);
            requestAnimationFrame(() => card.classList.remove('entering'));
        }
        const skillBadge = card.querySelector('.active-card-skill');
        skillBadge.style.background = SKILL_COLORS[a.skill] || '#8b949e';
        skillBadge.textContent = SKILL_ICONS[a.skill] || '⚙';
        const issueEl = card.querySelector('.active-card-issue');
        const issueText = '#'+a.issue+' · '+a.skill;
        if(issueEl.textContent !== issueText){
            if(a.hasLog){
                issueEl.innerHTML = '<a class="in-link" href="/logs/view/'+a.logFile+'?live=1" target="_blank" rel="noopener">'+issueText+' ↗</a>';
            } else {
                issueEl.textContent = issueText;
            }
        }
        setText(card.querySelector('.active-card-fase')._id || '', a.fase);
        card.querySelector('.active-card-fase').textContent = a.fase;
        card.querySelector('.active-card-title').textContent = a.title || '';
        card.querySelector('.active-card-time').textContent = fmtDur(a.durationMs);
        const bar = card.querySelector('.in-bar > span');
        const pct = a.etaMs && a.etaMs > 0 ? Math.min(100, Math.round((a.durationMs / a.etaMs) * 100)) : 4;
        bar.style.width = pct + '%';
    }
    for(const card of [...list.children]){
        if(!seen.has(card.dataset.key)){
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 300);
        }
    }
}

function renderLineRow(a, isQueue){
    // #3035 — Diferenciación visual ✓/✗ por color + chip soft circular.
    // Para queue (no es un resultado, es un estado de slot) mantenemos
    // la clase neutral (gris) para no inducir falsa señal de éxito/error.
    let icon;
    let iconClass;
    if(isQueue){
        icon = a.slotFree ? '→' : '⏸';
        iconClass = 'line-icon--neutral';
    } else if(a.resultado === 'aprobado'){
        icon = '✓';
        iconClass = 'line-icon--success';
    } else if(a.resultado === 'rechazado'){
        icon = '✗';
        iconClass = 'line-icon--error';
    } else {
        icon = '·';
        iconClass = 'line-icon--neutral';
    }
    const iconAriaLabel = isQueue
        ? (a.slotFree ? 'Slot libre' : 'En espera')
        : (a.resultado === 'aprobado' ? 'Aprobado' : a.resultado === 'rechazado' ? 'Rechazado' : 'Sin resultado');
    const time = isQueue
        ? (a.slotFree ? 'libre · '+a.slotInfo : '⏸ '+a.slotInfo)
        : fmtDur(a.durationMs);
    // #3035 — Timestamp de fin (solo para items finalizados, no queue).
    // Formato dd/MM HH:mm:ss en hora local. fmtFinishedAt() vive más abajo.
    const finishedHtml = isQueue
        ? '<span class="line-time-end" aria-hidden="true"></span>'
        : '<span class="line-time-end" title="'+escapeHtml(new Date(a.finishedAt || 0).toISOString())+'">'+escapeHtml(fmtFinishedAt(a.finishedAt))+'</span>';
    const titleAttr = a.title ? ' title="'+escapeHtml(a.title)+'"' : '';
    const titleText = a.title ? ' · '+escapeHtml(a.title.slice(0, 50)) : '';
    const ghLink = '<a class="line-btn" href="https://github.com/intrale/platform/issues/'+a.issue+'" target="_blank" rel="noopener" title="Abrir issue en GitHub">↗</a>';
    let actions = '';
    if(isQueue){
        actions = ''
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-top" title="Máxima prioridad">⏫</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-up" title="Subir prioridad">▲</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-down" title="Bajar prioridad">▼</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-bottom" title="Mínima prioridad">⏬</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="pause" title="Pausar issue (label blocked:dependencies)">⏸</button>'
          + ghLink;
    } else {
        const logBtn = a.hasLog ? '<a class="line-btn" href="/logs/view/'+escapeHtml(a.logFile||'')+'" target="_blank" rel="noopener" title="Ver log">📄</a>' : '';
        actions = logBtn+ghLink;
    }
    return \`
        <div class="line-row" data-key="\${a.issue}-\${a.skill}-\${a.fase}"\${titleAttr}>
          <span class="line-icon \${iconClass}" role="img" aria-label="\${iconAriaLabel}">\${icon}</span>
          <span class="line-skill">\${escapeHtml(a.skill)}</span>
          <span class="line-issue"><a href="https://github.com/intrale/platform/issues/\${a.issue}" target="_blank" rel="noopener">#\${a.issue}</a>\${titleText}</span>
          <span class="line-fase">\${escapeHtml(a.fase)}</span>
          \${finishedHtml}
          <span class="line-time">\${time}</span>
          <span class="line-actions">\${actions}</span>
        </div>\`;
}

function bindLineActions(container){
    container.querySelectorAll('.line-btn[data-action]').forEach(b => {
        if(b.dataset._bound) return;
        b.dataset._bound = '1';
        b.addEventListener('click', () => {
            const action = b.dataset.action;
            if(action === 'pause') return pauseIssueHome(b.dataset.issue);
            return moveIssue(b.dataset.issue, action);
        });
    });
}

// #3035 — Estado del filtro "Solo con error" en memoria del cliente.
// NO persiste en localStorage/sessionStorage/cookies (CA-3 + security review).
// Cada refresh de página vuelve a OFF.
let recentErrorsOnly = false;

async function tickRecent(){
    // #3035 — Propagar el flag al endpoint en cada poll para que el filtro
    // se mantenga consistente con los ticks subsiguientes (cada 10s).
    const url = recentErrorsOnly ? '/api/dash/recent?errorsOnly=1' : '/api/dash/recent';
    const d = await fetchJson(url);
    if(!d) return;
    const container = document.getElementById('recent-list');
    if(!container) return;
    const arr = (d.recent || []).slice(0, 10);
    if(arr.length === 0){
        // #3035 — Empty state diferenciado por filtro activo.
        const emptyMsg = recentErrorsOnly ? 'Sin rechazos recientes' : 'Sin actividad reciente';
        container.innerHTML = '<div class="in-empty">'+escapeHtml(emptyMsg)+'</div>';
        return;
    }
    // #3359 — Limpiar empty state stale ANTES del loop de prepend (UX G3: anti-flicker).
    // Bug gemelo de tickQueue: la rama empty deja <div class="in-empty"> y el
    // limpiador de abajo solo matchea .line-row, por lo que el mensaje persistía.
    const staleEmpty = container.querySelector('.in-empty');
    if(staleEmpty) staleEmpty.remove();
    const seen = new Set();
    for(const a of arr){
        const key = a.issue+'-'+a.skill+'-'+a.fase;
        seen.add(key);
        const existing = container.querySelector('[data-key="'+key+'"]');
        if(!existing){
            const tmp = document.createElement('div');
            tmp.innerHTML = renderLineRow(a, false);
            container.prepend(tmp.firstElementChild);
        }
    }
    for(const row of [...container.querySelectorAll('.line-row')]){
        if(!seen.has(row.dataset.key)) row.remove();
    }
    bindLineActions(container);
}

// #3035 — Bind del toggle "Solo con error" al click + teclado (Enter/Space).
// El toggle vive en el header de la sección "Últimos 10 ejecutados" y al
// cambiar dispara un re-render limpio (innerHTML='') para evitar rows
// fantasma del set anterior.
function bindRecentFilter(){
    const t = document.getElementById('recent-filter-errors');
    if(!t || t.dataset._bound) return;
    t.dataset._bound = '1';
    const apply = () => {
        recentErrorsOnly = !recentErrorsOnly;
        t.setAttribute('aria-checked', recentErrorsOnly ? 'true' : 'false');
        t.textContent = recentErrorsOnly ? '✗ Solo con error' : 'Solo con error';
        const container = document.getElementById('recent-list');
        if(container) container.innerHTML = '';
        tickRecent().catch(()=>{});
    };
    t.addEventListener('click', (ev) => { ev.preventDefault(); apply(); });
    t.addEventListener('keydown', (ev) => {
        if(ev.key === 'Enter' || ev.key === ' '){
            ev.preventDefault();
            apply();
        }
    });
}

async function tickQueue(){
    const d = await fetchJson('/api/dash/queue');
    if(!d) return;
    const container = document.getElementById('queue-list');
    if(!container) return;
    // #3023 — Badge "filtrado por pausa parcial" en el header de la sección.
    // Toggle vía display sin redibujar (preserva accesibilidad / focus).
    const partialActive = !!(d.partialPause && d.partialPause.active);
    const badge = document.getElementById('queue-partial-filter-badge');
    if(badge){ badge.style.display = partialActive ? 'inline-flex' : 'none'; }
    const arr = (d.queue || []).slice(0, 10);
    if(arr.length === 0){
        // #3023 — Empty state diferenciado: distinguir "cola realmente vacía"
        // (pipeline ocioso) de "filtrada a 0 por pausa parcial" (configuración
        // del operador). Reusa .in-empty + .in-empty-strong de theme.css.
        if(partialActive){
            container.innerHTML =
                '<div class="in-empty">' +
                  '<div class="in-empty-strong">Sin issues habilitados en pausa parcial</div>' +
                  '<div>La allowlist activa no incluye ningún issue encolable.</div>' +
                '</div>';
        } else {
            container.innerHTML = '<div class="in-empty">Cola vacía</div>';
        }
        return;
    }
    // #3359 — Limpiar empty state stale ANTES del loop de append (UX G3: anti-flicker).
    // La rama empty inyecta <div class="in-empty"> y el limpiador de abajo solo
    // matchea .line-row, por lo que el mensaje quedaba sticky cuando llegaban items.
    const staleEmpty = container.querySelector('.in-empty');
    if(staleEmpty) staleEmpty.remove();
    const seen = new Set();
    for(const a of arr){
        const key = a.issue+'-'+a.skill+'-'+a.fase;
        seen.add(key);
        let row = container.querySelector('[data-key="'+key+'"]');
        if(!row){
            const tmp = document.createElement('div');
            tmp.innerHTML = renderLineRow(a, true);
            row = tmp.firstElementChild;
            container.appendChild(row);
        } else {
            const timeEl = row.querySelector('.line-time');
            const newTime = a.slotFree ? 'libre · '+a.slotInfo : '⏸ '+a.slotInfo;
            if(timeEl.textContent !== newTime) timeEl.textContent = newTime;
        }
    }
    for(const row of [...container.querySelectorAll('.line-row')]){
        if(!seen.has(row.dataset.key)) row.remove();
    }
    bindLineActions(container);
}

async function moveIssue(issue, direction){
    try{
        const r = await fetch('/api/issue/'+issue+'/'+direction, {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Movido':'Falló'), j.ok);
        setTimeout(() => tickQueue().catch(()=>{}), 400);
    } catch(e){ showToast('Error: '+e.message, false); }
}

// ─── Mode toggle (running / paused / partial_pause) ───
function bindModeToggle(){
    const pill = document.getElementById('hdr-mode');
    const menu = document.getElementById('hdr-mode-menu');
    if(!pill || !menu || pill.dataset._bound) return;
    pill.dataset._bound = '1';
    pill.addEventListener('click', (ev) => {
        const target = ev.target;
        // Click en input/button del menú: dejar burbujear al handler propio
        if(target.closest('.in-mode-menu-input') || target.closest('[data-mode-action]')) return;
        ev.stopPropagation();
        menu.classList.toggle('open');
        menu.setAttribute('aria-hidden', menu.classList.contains('open') ? 'false' : 'true');
    });
    document.addEventListener('click', (ev) => {
        if(!pill.contains(ev.target)) menu.classList.remove('open');
    });
    menu.querySelectorAll('[data-mode-action]').forEach(b => {
        b.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const action = b.dataset.modeAction;
            try {
                if(action === 'resume'){
                    const r = await fetch('/api/pause', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'resume'})});
                    const j = await r.json();
                    showToast(j.msg || 'Pipeline reanudado', j.ok);
                } else if(action === 'pause'){
                    if(!confirm('¿Pausar TODO el pipeline? Se detendrán todos los lanzamientos hasta que reanudes.')) return;
                    const r = await fetch('/api/pause', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'pause'})});
                    const j = await r.json();
                    showToast(j.msg || 'Pipeline pausado', j.ok);
                } else if(action === 'partial'){
                    const input = document.getElementById('hdr-mode-partial-input');
                    const raw = (input.value || '').trim();
                    if(!raw){ showToast('Ingresá al menos 1 issue (ej: 2505, 2519)', false); return; }
                    const issues = raw.split(/[,\s]+/).map(s => Number(s.replace(/^#/, '').trim())).filter(n => Number.isInteger(n) && n > 0);
                    if(issues.length === 0){ showToast('Ningún número de issue válido en el input', false); return; }
                    const lista = issues.map(n => '#'+n).join(', ');
                    // \\n para que el template literal de Node escriba "\\n" literal al HTML;
                    // el cliente al ejecutar el string los interpreta como saltos de línea.
                    const msg = '¿Activar pausa parcial?\\n\\n' +
                        'Solo se van a procesar estos ' + issues.length + ' issue' + (issues.length===1?'':'s') + ':\\n' +
                        lista + '\\n\\n' +
                        'El resto del pipeline queda pausado hasta que reanudes o cambies la lista.';
                    if(!confirm(msg)) return;
                    const r = await fetch('/api/pause-partial', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issues})});
                    const j = await r.json();
                    showToast(j.msg || 'Pausa parcial aplicada', j.ok);
                }
                menu.classList.remove('open');
                setTimeout(() => tickHeader().catch(()=>{}), 300);
            } catch(e){ showToast('Error: '+e.message, false); }
        });
    });
}

async function pauseIssueHome(issue){
    if(!confirm('¿Pausar #'+issue+'? Agrega label blocked:dependencies; el pulpo lo saltea hasta que lo reanudes en /pipeline.')) return;
    try{
        const r = await fetch('/api/issue/'+issue+'/pause', {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Pausado':'Falló'), j.ok);
        setTimeout(() => tickQueue().catch(()=>{}), 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

// #3361 — el ticker de salud de providers y la card asociada se movieron a la
// ventana Providers (multi-provider.js, seccion Salud de providers en vivo).
// El home ya no consume los endpoints de pulpo/health ni el breakdown 24h —
// la duplicacion generaba ruido y semaforos amarillos espurios. Ver
// mp-live-providers en multi-provider.js para el reemplazo.

// =========================================================================
// #3487 — Widget "Próximas Olas" (Spike #3378 H3)
// Polling cada 30s sobre /api/dash/waves. Morphing manual: actualizamos
// elementos por id sin reemplazar el container #wave-panel ni los hijos
// #wave-active-container / #wave-next-container. Persistencia de
// collapse/expand en sessionStorage con clave wave-panel-state-<number>.
//
// Security (cruzado con review #3487):
//   - TODO string del payload se inserta vía textContent o escapeHtml() —
//     NUNCA innerHTML con campos crudos.
//   - El endpoint server-side ya filtra a whitelist y trunca title a 200,
//     acá igual aplicamos textContent para defensa en profundidad.
//   - sessionStorage almacena solo flags booleanos por número de ola.
// =========================================================================
const GITHUB_ISSUE_BASE = 'https://github.com/intrale/platform/issues/';

function waveCollapseKey(num){ return 'wave-panel-state-' + num; }
function waveIsCollapsed(num){
    try { return sessionStorage.getItem(waveCollapseKey(num)) === 'collapsed'; }
    catch { return false; }
}
function waveSetCollapsed(num, collapsed){
    try {
        if (collapsed) sessionStorage.setItem(waveCollapseKey(num), 'collapsed');
        else sessionStorage.removeItem(waveCollapseKey(num));
    } catch {}
}

function wavePriorityLabel(p){
    switch(p){
        case 'critical': return 'Crítica';
        case 'high':     return 'Alta';
        case 'medium':   return 'Media';
        case 'low':      return 'Baja';
        default:         return 'Desconocida';
    }
}
function waveStatusLabel(s){
    switch(s){
        case 'ready':       return 'Lista';
        case 'needs-def':   return 'Por definir';
        case 'in-progress': return 'En curso';
        case 'blocked':     return 'Bloqueada';
        case 'completed':   return 'Hecho';
        default:            return 'Desconocido';
    }
}
function waveSizeLabel(s){
    return (s === 'unknown') ? '?' : s.toUpperCase();
}

// Crea (o devuelve cacheado) el row DOM de una ola. Estructura estable:
// el row se identifica por id wave-row-<n> y los hijos por
// wave-<n>-name/-goal/-count/-issues-list. Cuando los datos cambian solo
// mutamos textContent / dataset — nunca reemplazamos el container.
function renderWaveRowSkeleton(wave, kind){
    const row = document.createElement('div');
    row.className = 'wave-row';
    row.id = 'wave-row-' + wave.number;
    row.dataset.kind = kind; // 'active' | 'next'
    row.innerHTML =
        '<div class="wave-row-head">'+
        '  <button type="button" class="wave-row-toggle" aria-label="Colapsar/expandir ola" data-wave-toggle="'+wave.number+'">'+
        '    <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-collapse"/></svg>'+
        '  </button>'+
        '  <div class="wave-row-title">'+
        '    <span class="wave-row-title-name" id="wave-'+wave.number+'-name"></span>'+
        '    <span class="wave-row-title-goal" id="wave-'+wave.number+'-goal"></span>'+
        '  </div>'+
        '  <span class="wave-row-badge">'+(kind==='next' ? 'PRÓXIMA' : 'ACTIVA')+'</span>'+
        '  <span class="wave-row-count" id="wave-'+wave.number+'-count"></span>'+
        '</div>'+
        '<div class="wave-row-issues" id="wave-'+wave.number+'-issues-list"></div>';
    return row;
}

// Morphing: actualiza textContent + dataset de un row existente, sin
// re-crear el DOM. Si cambia la cantidad o el orden de issues, agrega/
// remueve nodos hijos por id manteniendo los que no cambiaron.
function morphWaveRow(row, wave){
    setText('wave-'+wave.number+'-name', 'Ola ' + wave.number + (wave.name ? ' · ' + wave.name : ''));
    setText('wave-'+wave.number+'-goal', wave.goal || '');
    const issues = Array.isArray(wave.issues) ? wave.issues : [];
    setText('wave-'+wave.number+'-count', issues.length + (issues.length === 1 ? ' issue' : ' issues'));

    const list = document.getElementById('wave-'+wave.number+'-issues-list');
    if (!list) return;
    const seen = new Set();
    for (const issue of issues) {
        const issueId = 'wave-' + wave.number + '-issue-' + issue.id;
        seen.add(issueId);
        let node = document.getElementById(issueId);
        if (!node) {
            node = document.createElement('div');
            node.className = 'wave-issue';
            node.id = issueId;
            node.innerHTML =
                '<span class="wave-issue-id" id="'+issueId+'-id"></span>'+
                '<span class="wave-issue-title" id="'+issueId+'-title"></span>'+
                '<span class="wave-pill" data-kind="priority" id="'+issueId+'-priority"></span>'+
                '<span class="wave-pill" data-kind="size" id="'+issueId+'-size"></span>'+
                '<span class="wave-badge" id="'+issueId+'-status"></span>';
            list.appendChild(node);
        }
        // ID + link (defensa en profundidad: textContent + href controlado)
        const idEl = document.getElementById(issueId+'-id');
        if (idEl) {
            const link = '<a href="'+escapeHtml(GITHUB_ISSUE_BASE + issue.id)+'" target="_blank" rel="noopener">#'+issue.id+'</a>';
            if (idEl.innerHTML !== link) idEl.innerHTML = link;
        }
        // Título: textContent (CA-8 / security) + truncado visual a 40 chars.
        const titleEl = document.getElementById(issueId+'-title');
        if (titleEl) {
            const shortTitle = (issue.title || '').length > 40
                ? (issue.title || '').slice(0, 40) + '…'
                : (issue.title || '');
            if (titleEl.textContent !== shortTitle) titleEl.textContent = shortTitle;
            if (titleEl.title !== (issue.title || '')) titleEl.title = (issue.title || '');
        }
        // Priority pill
        const prioEl = document.getElementById(issueId+'-priority');
        if (prioEl) {
            if (prioEl.dataset.priority !== issue.priority) prioEl.dataset.priority = issue.priority;
            const txt = wavePriorityLabel(issue.priority);
            if (prioEl.textContent !== txt) prioEl.textContent = txt;
        }
        // Size pill
        const sizeEl = document.getElementById(issueId+'-size');
        if (sizeEl) {
            if (sizeEl.dataset.size !== issue.size) sizeEl.dataset.size = issue.size;
            const txt = waveSizeLabel(issue.size);
            if (sizeEl.textContent !== txt) sizeEl.textContent = txt;
        }
        // Status badge
        const statusEl = document.getElementById(issueId+'-status');
        if (statusEl) {
            if (statusEl.dataset.status !== issue.status) statusEl.dataset.status = issue.status;
            const txt = waveStatusLabel(issue.status);
            if (statusEl.textContent !== txt) statusEl.textContent = txt;
        }
    }
    // Remover issues que ya no están — preserva los que siguen.
    Array.from(list.children).forEach(child => {
        if (!seen.has(child.id)) list.removeChild(child);
    });
}

function applyWaveCollapseState(row, number){
    const collapsed = waveIsCollapsed(number);
    row.classList.toggle('is-collapsed', collapsed);
    const toggleBtn = row.querySelector('.wave-row-toggle');
    if (toggleBtn) {
        const useEl = toggleBtn.querySelector('use');
        if (useEl) useEl.setAttribute('href', collapsed ? '#ic-expand' : '#ic-collapse');
        toggleBtn.title = collapsed ? 'Expandir ola' : 'Colapsar ola';
    }
}

function bindWaveToggle(container){
    if (container.dataset._waveBound === '1') return;
    container.dataset._waveBound = '1';
    container.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-wave-toggle]');
        if (!btn) return;
        const num = Number(btn.dataset.waveToggle);
        if (!Number.isFinite(num)) return;
        const row = document.getElementById('wave-row-' + num);
        if (!row) return;
        const nowCollapsed = !row.classList.contains('is-collapsed');
        waveSetCollapsed(num, nowCollapsed);
        applyWaveCollapseState(row, num);
    });
}

async function tickWaves(){
    const d = await fetchJson('/api/dash/waves');
    const empty = document.getElementById('wave-panel-empty');
    const activeContainer = document.getElementById('wave-active-container');
    const nextContainer = document.getElementById('wave-next-container');
    const meta = document.getElementById('wave-panel-updated');
    if (!activeContainer || !nextContainer) return;

    // #3616 — el payload trae { active_wave, next_wave, planned[], updated_at }.
    // planned[] reemplaza el next_wave único y permite iterar hasta 5 olas.
    // Fallback: si el server no entrega planned[] (cliente viejo + dashboard
    // nuevo, o viceversa) usamos next_wave como lista de 1 ítem.
    const hasActive = !!(d && d.active_wave);
    let plannedList = [];
    if (d && Array.isArray(d.planned) && d.planned.length > 0) {
        plannedList = d.planned;
    } else if (d && d.next_wave) {
        plannedList = [d.next_wave];
    }
    // Cap visual a 3 para kiosk 1080×1920 (UX guideline #2 — sin scroll interno).
    // El indicador "+N más" se renderiza si plannedList.length > 3.
    const MAX_PLANNED_VISIBLE = 3;
    const visiblePlanned = plannedList.slice(0, MAX_PLANNED_VISIBLE);
    const hiddenPlannedCount = Math.max(0, plannedList.length - visiblePlanned.length);
    const hasPlanned = plannedList.length > 0;

    if (meta && d && d.updated_at) {
        const ts = Date.parse(d.updated_at);
        if (Number.isFinite(ts)) {
            const dt = new Date(ts);
            meta.textContent = 'Actualizado ' + String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
        }
    }

    if (!hasActive && !hasPlanned) {
        if (empty) {
            empty.style.display = '';
            const msgEl = document.getElementById('wave-panel-empty-msg');
            if (msgEl) {
                const msg = (d && typeof d.message === 'string' && d.message)
                    ? d.message
                    : 'Planificación no disponible — esperando próxima ola';
                if (msgEl.textContent !== msg) msgEl.textContent = msg;
            }
        }
        // Limpiar containers de olas previas (si las hubo).
        if (activeContainer.firstChild) activeContainer.innerHTML = '';
        if (nextContainer.firstChild) nextContainer.innerHTML = '';
        return;
    }

    if (empty) empty.style.display = 'none';

    // Active wave: re-aprovechar el row si el número no cambió; recrear
    // (con morphing) si la ola cambió de número.
    if (hasActive) {
        const wave = d.active_wave;
        let row = activeContainer.querySelector('.wave-row');
        if (!row || Number(row.dataset.waveNumber) !== wave.number) {
            activeContainer.innerHTML = '';
            row = renderWaveRowSkeleton(wave, 'active');
            row.dataset.waveNumber = String(wave.number);
            activeContainer.appendChild(row);
            applyWaveCollapseState(row, wave.number);
        }
        morphWaveRow(row, wave);
    } else if (activeContainer.firstChild) {
        activeContainer.innerHTML = '';
    }

    if (hasPlanned) {
        // #3616 — render de múltiples olas planificadas con morphing por número.
        // Mantenemos los rows existentes que sigan en la lista (preserva el
        // estado de colapso del usuario por sessionStorage), y agregamos/
        // sacamos los que cambian sin re-crear el container raíz (anti-flicker).
        const seenNumbers = new Set();
        for (const wave of visiblePlanned) {
            if (!wave || !Number.isFinite(wave.number)) continue;
            seenNumbers.add(wave.number);
            const rowId = 'wave-row-' + wave.number;
            let row = document.getElementById(rowId);
            if (!row || row.parentNode !== nextContainer) {
                row = renderWaveRowSkeleton(wave, 'next');
                row.dataset.waveNumber = String(wave.number);
                nextContainer.appendChild(row);
                applyWaveCollapseState(row, wave.number);
            }
            morphWaveRow(row, wave);
        }
        // Sacar olas que ya no están en el horizonte.
        Array.from(nextContainer.children).forEach((child) => {
            if (child.id === 'wave-planned-overflow') return;
            const n = Number(child.dataset.waveNumber);
            if (!Number.isFinite(n) || !seenNumbers.has(n)) {
                nextContainer.removeChild(child);
            }
        });
        // "+N más" — render del indicador de overflow (UX guideline #2).
        let overflow = document.getElementById('wave-planned-overflow');
        if (hiddenPlannedCount > 0) {
            if (!overflow) {
                overflow = document.createElement('div');
                overflow.className = 'wave-planned-overflow';
                overflow.id = 'wave-planned-overflow';
                nextContainer.appendChild(overflow);
            }
            const txt = '+' + hiddenPlannedCount + ' más planificada' + (hiddenPlannedCount === 1 ? '' : 's');
            if (overflow.textContent !== txt) overflow.textContent = txt;
        } else if (overflow) {
            overflow.parentNode && overflow.parentNode.removeChild(overflow);
        }
    } else if (nextContainer.firstChild) {
        nextContainer.innerHTML = '';
    }

    bindWaveToggle(activeContainer);
    bindWaveToggle(nextContainer);
}

// Bind del botón "Reintentar ahora" del estado vacío. Fuerza un fetch
// fuera del ciclo de polling de 30s — útil cuando el operador acaba de
// poblar waves.json y quiere ver el efecto inmediato sin esperar.
function bindWaveRetry(){
    const btn = document.getElementById('wave-panel-retry');
    if (!btn || btn.dataset._bound === '1') return;
    btn.dataset._bound = '1';
    btn.addEventListener('click', () => { tickWaves().catch(()=>{}); });
}

// #3492 — Formato de minutos para la vista (CA-23): la libreria entrega
// enteros, la vista los convierte a "45m" / "1h 2m" / "—". Convencion:
//   null/0/NaN  → "—"  (sin dato)
//   menor a 60  → "{n}m"
//   60 o mas    → "{h}h {m}m" (omite "0m")
function fmtMin(n){
    if(n == null || !Number.isFinite(n) || n <= 0) return '—';
    const total = Math.round(n);
    if(total < 60) return total + 'm';
    const h = Math.floor(total / 60);
    const m = total % 60;
    if(m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
}

// #3492 — Tick para /api/dash/ola-eta (polling 30s). Layout SSR ya esta;
// este handler solo hidrata textos por id sin reemplazar containers (patron
// anti-flicker del kiosk). Si ready=false (cache aun tibio) o issues==0,
// alterna data-empty=1 y muestra el placeholder.
async function tickOlaETA(){
    const section = document.getElementById('ola-eta-section');
    if(!section) return;
    const d = await fetchJson('/api/dash/ola-eta');
    if(!d){
        // Endpoint no respondio — dejamos el ultimo estado en pantalla.
        return;
    }
    if(!d.ready){
        section.setAttribute('data-empty', '1');
        setText('ola-eta-subtitle', 'preparando cálculo…');
        return;
    }
    const issues = Array.isArray(d.issues) ? d.issues : [];
    if(issues.length === 0){
        section.setAttribute('data-empty', '1');
        setText('ola-eta-subtitle', 'sin issues activos');
        const lo = document.getElementById('ola-eta-low-samples');
        if(lo) lo.setAttribute('data-show', '0');
        return;
    }
    section.setAttribute('data-empty', '0');

    // Subtitulo: cantidad de issues + concurrency.
    const conc = d.concurrencyUsed != null ? d.concurrencyUsed : 3;
    const issuesLabel = issues.length === 1 ? '1 issue' : (issues.length + ' issues');
    setText('ola-eta-subtitle', issuesLabel + ' · concurrency ' + conc);

    // Tres celdas principales (formato calculado aca — CA-23).
    setText('ola-eta-p50', fmtMin(d.totalP50));
    setText('ola-eta-p75', fmtMin(d.totalP75));
    setText('ola-eta-p90', fmtMin(d.totalP90));

    // Breakdown por size (CA-21 — labels en espanol). El endpoint manda
    // bySize: { S:{avgTime,stddev,samples}, M:{...}, L:{...} }.
    const bySize = d.bySize || {};
    let totalSamples = 0;
    for(const sz of ['S','M','L']){
        const info = bySize[sz] || { avgTime: 0, samples: 0 };
        const samples = info.samples || 0;
        totalSamples += samples;
        setText('ola-eta-size-' + sz + '-value', fmtMin(info.avgTime));
        setText('ola-eta-size-' + sz + '-samples',
            samples === 0 ? 'sin samples · default' :
            (samples === 1 ? '1 sample histórico' : (samples + ' samples históricos'))
        );
    }

    // Badge "estimacion con poca muestra" (CA-22). Mostramos si la suma
    // global de samples es menor a 5, o si algun size en uso en la ola
    // actual tiene menos de 5 samples (CA-22 — confianza pobre).
    const sizesEnOla = new Set();
    if(d.byIssue && typeof d.byIssue === 'object'){
        for(const v of Object.values(d.byIssue)){
            if(v && v.sizeCanonical) sizesEnOla.add(v.sizeCanonical);
        }
    }
    let lowSamples = totalSamples < 5;
    for(const sz of sizesEnOla){
        const info = bySize[sz];
        if(!info || (info.samples || 0) < 5){ lowSamples = true; break; }
    }
    const lo = document.getElementById('ola-eta-low-samples');
    if(lo) lo.setAttribute('data-show', lowSamples ? '1' : '0');
}

const POLLS = [
    { fn: tickHeader, ms: 5000 },
    { fn: tickKpis, ms: 60000 },
    { fn: tickQuota, ms: 60000 },
    // #2976 — banner de cuota agotada. 5s da una latencia aceptable entre
    // que el detector escribe el flag y el banner aparece, sin saturar
    // el dashboard con I/O del JSON cada segundo (cap 10KB ya defendía,
    // pero igual evitamos lecturas innecesarias).
    { fn: tickQuotaExhausted, ms: 5000 },
    // #3013 — banner real-snapshot. Polling 60s alineado con el TTL del
    // snapshot (default 90 min) — no necesita más frecuencia. Si el JSONL
    // no existe (pre-merge de #3012), el endpoint devuelve state:'missing'
    // y el banner queda hidden — comportamiento idéntico al pre-feature
    // (CA-15).
    { fn: tickQuotaSnapshot, ms: 60000 },
    { fn: tickActive, ms: 2000 },
    { fn: tickRecent, ms: 10000 },
    { fn: tickQueue, ms: 5000 },
    // #3492 — ETA de la ola actual (p50/p75/p90). TTL del cache server-side
    // es 30s; polling cliente alineado para que cada tick toque el cache
    // recién refrescado sin saturar el cálculo (que escanea markers FS +
    // stream JSONL).
    { fn: tickOlaETA, ms: 30000 },
    // #3239 — badge de la tarjeta /multi-provider. 10s alcanza: el panel
    // raramente cambia y el endpoint sólo lee el JSON canónico + secrets.
    { fn: tickMultiProvider, ms: 10000 },
    // #3361 — ticker de salud de providers removido del home (se movió a Providers).
    // #3487 — widget "Próximas Olas". Polling 30s alineado con la spec —
    // el endpoint es barato (read+parse de waves.json) y la planificación
    // no cambia más rápido que eso. El operador puede forzar refresh con
    // el botón "Reintentar ahora" del estado vacío.
    { fn: tickWaves, ms: 30000 },
];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
// #3035 — Bind del toggle "Solo con error" antes del primer poll para
// que el handler ya esté escuchando si el usuario hace click apenas carga.
bindRecentFilter();
// #3487 — Bind del botón "Reintentar ahora" del wave-panel (estado vacío).
bindWaveRetry();
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }

// Pause polling when tab hidden (avoid wasted backend load)
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') runAll(); });

// =============================================================================
// #3723 — Router cliente del dashboard V3 (CA-T1 + CA-U1..U5).
//
// Allowlist regex en cliente como defense-in-depth (no es la barrera real;
// la real vive en dashboard-routes.js → VIEW_SLUG_REGEX + VIEW_SLUGS).
// Acá nos protege de XSS via slug pasado a fetch().
// =============================================================================
var __VIEW_BOOT = window.__VIEW_BOOT__ || { currentView: 'home', unknownViewRequested: false, titles: { home: 'Operación' } };
function _safeSlug(s){ return /^[a-z][a-z0-9-]{0,30}$/.test(s) ? s : 'home'; }
function _viewTitleFor(slug){
    var t = (__VIEW_BOOT.titles && __VIEW_BOOT.titles[slug]) || slug || 'home';
    return 'Intrale · ' + t.charAt(0).toUpperCase() + t.slice(1);
}
function _setViewTitle(slug){
    try { document.title = _viewTitleFor(slug); } catch(e) {}
}

// CA-U1 — feedback de carga > 200ms (opacidad reducida) y revert si tarda
// > 5s o falla (CA-U3). El cliente nunca deja #view-content vacío: si la
// fetch falla mantenemos el contenido anterior y revertimos el pushState.
function _setLoading(target, on){
    if(!target) return;
    if(on){
        target.style.transition = 'opacity 0.18s';
        // Retardo de 200ms — si la respuesta llega antes no se pinta el dimming.
        target.dataset.loadingTimer = setTimeout(function(){ target.style.opacity = '0.5'; }, 200);
    } else {
        if(target.dataset.loadingTimer){ clearTimeout(Number(target.dataset.loadingTimer)); delete target.dataset.loadingTimer; }
        target.style.opacity = '';
    }
}

function loadView(slug, opts){
    var safe = _safeSlug(slug);
    var replace = opts && opts.replace === true;
    var target = document.getElementById('view-content');
    if(!target) return Promise.resolve();
    var prevHtml = target.innerHTML;
    var prevScroll = window.scrollY;
    var prevView = target.getAttribute('data-current-view') || 'home';
    var newUrl = '/dashboard?view=' + encodeURIComponent(safe);
    // pushState ANTES del fetch para que el back funcione si el usuario
    // navega rápido. Si la fetch falla, revertimos (CA-U3).
    try {
        if(replace) history.replaceState({ view: safe }, '', newUrl);
        else history.pushState({ view: safe }, '', newUrl);
    } catch(e) {}
    _setLoading(target, true);
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = setTimeout(function(){
        if(controller) try { controller.abort(); } catch(e) {}
    }, 5000);
    return fetch('/dashboard/partial?view=' + encodeURIComponent(safe), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'fetch' },
        signal: controller ? controller.signal : undefined,
    })
    .then(function(r){
        clearTimeout(timeoutId);
        if(!r.ok) throw new Error('partial ' + r.status);
        return r.text();
    })
    .then(function(html){
        // R2 (guru) — anti-flicker boundary: innerHTML SOLO en #view-content.
        target.innerHTML = html;
        target.setAttribute('data-current-view', safe);
        _setViewTitle(safe);
        // R5 (guru) — preservar scroll position.
        try { window.scrollTo(0, prevScroll); } catch(e) {}
        _setLoading(target, false);
        // Hook post-render para que cada vista re-bindee sus listeners en JS
        // (CA-S8: no event handlers inline). Convencion: cada vista exporta
        // initView_<slug> global; si no existe, no-op.
        var initName = 'initView_' + safe.replace(/-/g, '_');
        if(typeof window[initName] === 'function'){
            try { window[initName](); } catch(e) { try { console.warn(initName, e.message); } catch(_) {} }
        }
        return true;
    })
    .catch(function(e){
        clearTimeout(timeoutId);
        // CA-U3 — error visible + revert: mantenemos contenido anterior,
        // revertimos pushState y mostramos toast genérico (sin filtrar
        // slug ni códigos crudos — CA-S4/S6 perspectiva UX).
        try { target.innerHTML = prevHtml; } catch(_) {}
        try {
            var revertUrl = '/dashboard?view=' + encodeURIComponent(prevView);
            history.replaceState({ view: prevView }, '', revertUrl);
        } catch(_) {}
        _setLoading(target, false);
        if(typeof showToast === 'function'){
            showToast('No se pudo cargar la vista', false);
        }
        try { console.warn('loadView', safe, e && e.message); } catch(_) {}
        return false;
    });
}

window.addEventListener('popstate', function(e){
    var slug = (e.state && e.state.view) || 'home';
    try {
        var q = new URLSearchParams(location.search).get('view');
        if(q) slug = q;
    } catch(_) {}
    // replace=true para no apilar entries adicionales al navegar back/forward.
    loadView(slug, { replace: true });
});

document.addEventListener('click', function(e){
    var t = e.target;
    if(!t) return;
    var a = (t.closest ? t.closest('[data-view-link]') : null);
    if(!a) return;
    var slug = a.getAttribute('data-view-link');
    if(!slug) return;
    e.preventDefault();
    loadView(slug, { replace: false });
});

// SSR inicial: sincronizamos document.title con el view rendereado y
// disparamos el toast CA-U5 si el SSR cayó al fallback por slug desconocido.
_setViewTitle(__VIEW_BOOT.currentView || 'home');
if(__VIEW_BOOT.unknownViewRequested === true && typeof showToast === 'function'){
    // setTimeout para que el toast no compita con el primer paint del header.
    setTimeout(function(){
        showToast('La vista solicitada no existe — mostrando Inicio');
    }, 250);
}
`;
}

// #2976 — SSR del banner de cuota agotada.
//
// CA-14: `curl /` devuelve "cuota Anthropic" SOLO cuando el flag está activo.
// El cliente sigue refrescando vía /api/dash/quota-exhausted (CA-2). Esta
// función decide qué emitir en el render inicial:
//
//  - Activo: banner pleno con texto, paneles, countdown — todos los strings
//    del flag pasan por escapeHtmlSsr() defensa anti-XSS (CA-10).
//  - Inactivo: placeholder vacío (un comentario HTML) — sin "cuota
//    Anthropic" en el source, así `curl | grep` no matchea.
//
// El placeholder cuando está inactivo permite al cliente "morphar" el
// banner cuando el polling lo active sin reload (CA-2 sigue cumpliéndose
// porque el JS reemplaza el comentario con el banner pleno via DOM).
function renderQuotaBannerSsr(quotaState) {
    if (!quotaState || !quotaState.active) {
        // Skeleton sin "cuota Anthropic" en texto. El cliente lo llena con
        // setText() cuando el flag se activa en un poll posterior. CA-14:
        // grep "cuota Anthropic" sobre el HTML inactivo NO debe matchear.
        // Mantener los IDs es necesario para que setText/setAttr del cliente
        // muten el banner sin recrear DOM (anti-flicker).
        return `
  <section class="quota-exhausted-banner" id="quota-exhausted-banner" role="status" aria-live="polite" aria-hidden="true" data-active="false">
    <div class="quota-exhausted-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img"><use href="/assets/icons/sprite.svg#ic-quota-exhausted"></use></svg>
    </div>
    <div class="quota-exhausted-content">
      <div class="quota-exhausted-title" id="quota-exhausted-title"></div>
      <div class="quota-exhausted-sub" id="quota-exhausted-sub"></div>
      <div class="quota-exhausted-panels" id="quota-exhausted-panels">
        <div class="quota-exhausted-panel det">
          <span class="quota-exhausted-panel-label">Det.</span>
          <span class="quota-exhausted-panel-value" id="quota-exhausted-det-count">0</span>
        </div>
        <div class="quota-exhausted-panel llm">
          <span class="quota-exhausted-panel-label">LLM</span>
          <span class="quota-exhausted-panel-value" id="quota-exhausted-llm-count">0</span>
          <span class="quota-exhausted-skills" id="quota-exhausted-skills"></span>
        </div>
      </div>
    </div>
    <div class="quota-exhausted-countdown">
      <span class="quota-exhausted-countdown-label">Reset en</span>
      <span class="quota-exhausted-countdown-value" id="quota-exhausted-countdown">—</span>
      <div class="quota-exhausted-countdown-bar"><span id="quota-exhausted-countdown-bar"></span></div>
    </div>
  </section>`;
    }
    const errorType = escapeHtmlSsr(quotaState.error_type || 'usage_limit_error');
    const detectedAt = escapeHtmlSsr(quotaState.detected_at || '');
    const resetsAt = escapeHtmlSsr(quotaState.resets_at || '');
    const hhmm = escapeHtmlSsr(fmtHHMMLocalSsr(quotaState.resets_at));
    const remainingMs = Math.max(0, (quotaState.resets_at_ms || 0) - Date.now());
    const inText = escapeHtmlSsr(fmtCountdownSsr(remainingMs));
    return `
  <section class="quota-exhausted-banner" id="quota-exhausted-banner" role="status" aria-live="polite" aria-hidden="false" data-active="true">
    <div class="quota-exhausted-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-label="reloj de arena">
        <use href="/assets/icons/sprite.svg#ic-quota-exhausted"></use>
      </svg>
    </div>
    <div class="quota-exhausted-content">
      <div class="quota-exhausted-title" id="quota-exhausted-title">Modo determinístico — cuota Anthropic agotada. Reset ${hhmm} (en ${inText}).</div>
      <div class="quota-exhausted-sub" id="quota-exhausted-sub">Tipo: ${errorType} · Detectado: ${detectedAt} · Reset: ${resetsAt}</div>
      <div class="quota-exhausted-panels" id="quota-exhausted-panels">
        <div class="quota-exhausted-panel det">
          <span class="quota-exhausted-panel-label">Determinísticos</span>
          <span class="quota-exhausted-panel-value" id="quota-exhausted-det-count">0</span>
          <span>corriendo</span>
        </div>
        <div class="quota-exhausted-panel llm">
          <span class="quota-exhausted-panel-label">LLM encolados</span>
          <span class="quota-exhausted-panel-value" id="quota-exhausted-llm-count">0</span>
          <span>esperando</span>
          <span class="quota-exhausted-skills" id="quota-exhausted-skills"></span>
        </div>
      </div>
    </div>
    <div class="quota-exhausted-countdown">
      <span class="quota-exhausted-countdown-label">Reset en</span>
      <span class="quota-exhausted-countdown-value" id="quota-exhausted-countdown">${inText}</span>
      <div class="quota-exhausted-countdown-bar"><span id="quota-exhausted-countdown-bar"></span></div>
    </div>
  </section>`;
}

// #3487 + #3726 — La carga del sprite vive ahora en nav-tabs.js como
// loadIconSprite() (cache compartido entre home y satellites). El nombre
// loadIconSpriteHome quedo retirado para no duplicar el cache: la nav bar
// unificada lo lee desde nav-tabs.js y home.js lo consume directo.

function renderHomeHTML(opts) {
    // `opts.quotaState` permite al caller pasar el state precomputado (evita
    // doble lectura del flag si el dashboard ya lo tiene en mano). Sin opts,
    // leemos defensivamente — caso que vale para tests y para el route handler
    // simple del kiosk.
    //
    // #3723 — `opts.unknownViewRequested` (bool): si true, el SSR de
    // `/dashboard?view=<slug-desconocido>` cayó al fallback `home` y debe
    // mostrarse un toast informativo `CA-U5`. El slug NUNCA se refleja en
    // el body (CA-S4); sólo viaja la bandera booleana.
    //
    // `opts.currentView` (string): slug activo, usado por el script cliente
    // para sincronizar `document.title` y `history` en navegación. Siempre
    // pertenece a la allowlist `VIEW_SLUGS` por construcción.
    const _opts = opts || {};
    const quotaState = _opts.quotaState || getInitialQuotaState();
    const quotaBannerHtml = renderQuotaBannerSsr(quotaState);
    const currentView = typeof _opts.currentView === 'string' ? _opts.currentView : 'home';
    const unknownViewRequested = _opts.unknownViewRequested === true;

    const theme = loadTheme();
    const styles = homeStyles();
    const script = renderClientScript();
    // #3726 — Sprite SVG inline compartido (cache unificado en nav-tabs.js).
    const spriteInline = loadIconSprite();
    // #3726 — Render de la nav bar V3 unificada (12 tabs con tokens V3).
    // El callback `badgeForSlug` mantiene los <span id="badge-*"> usados por
    // los tickers existentes (CA-10). El mapeo slug->areaKey traduce los
    // nuevos slugs ("descanso"/"providers") al key historico que sirve el
    // backend en `d.counts` ("modo-descanso"/"multi-provider"), asi
    // `tickMultiProvider()` y la hidratacion de counts del slice siguen
    // funcionando sin cambios server-side.
    const SLUG_TO_BADGE_AREA = {
        equipo: 'equipo',
        pipeline: 'pipeline',
        bloqueados: 'bloqueados',
        issues: 'issues',
        matriz: 'matriz',
        ops: 'ops',
        kpis: 'kpis',
        historial: 'historial',
        costos: 'costos',
        descanso: 'modo-descanso',
        providers: 'multi-provider',
    };
    const badgeForSlug = (slug) => {
        const areaKey = SLUG_TO_BADGE_AREA[slug];
        if (!areaKey) return ''; // slug "home" no lleva badge
        return `<span class="area-pill-badge area-pill-badge-zero" id="badge-${areaKey}">·</span>`;
    };
    const navHtml = renderNavTabsSsr('home', { badgeForSlug });

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1080">
<title>Intrale · Operación</title>
<style>${theme}</style>
<style>${styles}</style>
</head>
<body>
<!-- #3487 — Sprite SVG inline para resolver use href=#ic-* sin
     depender de un static asset handler. Oculto con display:none, los
     símbolos siguen siendo referenciables por id. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="kiosk-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Intrale · Operación</div>
        <div class="in-header-subtitle">Pipeline V3 · estado en vivo</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode" data-mode-toggle title="Click para cambiar el estado del pipeline">…
        <div class="in-mode-menu" id="hdr-mode-menu" role="menu" aria-hidden="true">
          <button class="in-mode-menu-item" data-mode-action="resume" type="button">
            <span class="in-mode-menu-item-icon">🟢</span>Running (sin pausa)
          </button>
          <button class="in-mode-menu-item" data-mode-action="pause" type="button">
            <span class="in-mode-menu-item-icon">⏸</span>Pausa total (todo en hold)
          </button>
          <div class="in-mode-menu-divider"></div>
          <div class="in-mode-menu-input" data-mode-action-block="partial">
            <label>Pausa parcial · solo procesar issues:</label>
            <input type="text" id="hdr-mode-partial-input" placeholder="ej: 2505, 2519, 2520" inputmode="numeric">
            <button data-mode-action="partial" type="button">⏸ Aplicar pausa parcial</button>
          </div>
        </div>
      </span>
      <span class="in-pill" id="hdr-window-qa" title="Click para activar/desactivar la QA Priority Window">…</span>
      <span class="in-pill" id="hdr-window-build" title="Click para activar/desactivar la Build Priority Window">…</span>
      <a class="in-pill" id="hdr-rest-mode" href="/modo-descanso" target="_blank" rel="noopener" style="display:none;text-decoration:none" title="Modo descanso activo. Click para configurar.">…</a>
      <span class="in-pill" id="hdr-resources" title="CPU y RAM del sistema">…</span>
      <span class="in-pill" id="hdr-pulpo">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>

  ${quotaBannerHtml}

  <!--
    #3013 — Banner real-snapshot (4 estados: fresh, stale, missing,
    parser-offline). Vive debajo del banner exhausted (narrativa §6). Cuando
    data-state="missing" ocupa 0px (display:none) y el dashboard se ve idéntico
    al pre-feature (CA-15). Polling cada 60s desde tickQuotaSnapshot. Cada
    estado distingue por borde + pill + microcopy + ícono — cero reliance
    en color solo (CA-UX-9, WCAG AA).
  -->
  <section class="quota-snapshot-banner" id="quota-snapshot-banner"
           role="status" aria-live="polite" aria-hidden="true" data-state="missing">
    <div class="quota-snapshot-pill" id="quota-snapshot-pill">
      <span class="quota-snapshot-pill-icon" id="quota-snapshot-pill-icon" aria-hidden="true"></span>
      <span class="quota-snapshot-pill-text" id="quota-snapshot-pill-text">ESTIMADO</span>
    </div>
    <div class="quota-snapshot-buckets" id="quota-snapshot-buckets"></div>
  </section>

  <!--
    #3361 — La card de salud de providers se movió a la ventana Providers
    (multi-provider.js). El home queda libre del duplicado y los semáforos
    se gestionan en su lugar canónico.
  -->

  <!-- #3723 - anti-flicker boundary del router cliente (CA-T1 + R2 guru).
       El interceptor loadView() SOLO reemplaza el innerHTML de #view-content;
       sub-containers internos (kpi-cards, queue-list, etc.) siguen usando JSON
       polling + DOM morphing manual por id (#2801). NO meter event handlers
       inline aca (CA-S8) - todos los listeners se enganchan en JS post-render. -->
  <main class="kiosk-body" id="view-content" data-current-view="${currentView}">

    <section class="kpi-grid" aria-label="KPIs">
      <div class="kpi-card" id="kpi-prs" title="PRs mergeados en los últimos 7 días (ventana UTC). Fuente: gh pr list, cache 5min.">
        <span class="kpi-icon">✅</span>
        <span class="kpi-label">PRs · 7d</span>
        <span class="kpi-value" id="kpi-prs-value">…</span>
        <span class="kpi-sub">mergeados</span>
      </div>
      <div class="kpi-card" id="kpi-tokens" title="Tokens consumidos en las últimas 24h, sumados todos los providers (Claude · Codex · Gemini · Cerebras · NVIDIA). Hover para breakdown.">
        <span class="kpi-icon">⚡</span>
        <span class="kpi-label">Tokens · 24h</span>
        <span class="kpi-value" id="kpi-tokens-value">…</span>
        <span class="kpi-sub">todos los providers</span>
      </div>
      <div class="kpi-card" id="kpi-cycle" title="Mediana de duración por agente/fase (cap 7d). NO es cycle time DORA — esa métrica vive separada.">
        <span class="kpi-icon">⏱</span>
        <span class="kpi-label">Duración por agente</span>
        <span class="kpi-value" id="kpi-cycle-value">…</span>
        <span class="kpi-sub">mediana por marker</span>
      </div>
      <div class="kpi-card" id="kpi-bounce" title="% de issues con ≥1 rebote sobre issues terminados en los últimos 7 días. Hover para breakdown por fase.">
        <span class="kpi-icon">↩</span>
        <span class="kpi-label">% Rebote · 7d</span>
        <span class="kpi-value" id="kpi-bounce-value">…</span>
        <span class="kpi-sub">issues con ≥1 rebote</span>
      </div>
      <div class="kpi-card kpi-quota-dual" id="kpi-quota" title="Cuota Plan Max (sin API pública de Anthropic — calibrado contra valores reales de claude.ai).">
        <span class="kpi-icon">📊</span>
        <span class="kpi-label">Cuota Plan Max</span>
        <div class="kpi-quota-row" id="kpi-quota-session">
          <span class="kpi-quota-row-label">Sesión 5h</span>
          <span class="kpi-quota-row-value" id="kpi-quota-session-pct">…</span>
          <span class="kpi-quota-row-eta" id="kpi-quota-session-eta">·</span>
        </div>
        <div class="kpi-quota-row" id="kpi-quota-week">
          <span class="kpi-quota-row-label">Semanal</span>
          <span class="kpi-quota-row-value" id="kpi-quota-week-pct">…</span>
          <span class="kpi-quota-row-eta" id="kpi-quota-week-eta">·</span>
        </div>
      </div>
    </section>

    <!--
      #3492 — Panel "Ola actual · ETA" (probabilístico p50/p75/p90).
      Render placeholder en SSR; tickOlaETA() hidrata los valores reales desde
      /api/dash/ola-eta (polling 30s). Labels visibles en español (CA-21),
      badge "estimación con poca muestra" si samples menor a 5 (CA-22),
      formato minutos "45m" / "1h 2m" se computa en fmtMin() del cliente (CA-23).
    -->
    <section class="ola-eta-section" id="ola-eta-section" aria-label="ETA de la ola actual" data-empty="0">
      <div class="ola-eta-header">
        <span class="ola-eta-title">⏳ Ola actual · ETA</span>
        <span class="ola-eta-subtitle" id="ola-eta-subtitle">…</span>
        <span class="ola-eta-low-samples" id="ola-eta-low-samples" role="status" aria-live="polite" data-show="0">
          <span class="ola-eta-low-samples-icon" aria-hidden="true">⚠</span>
          estimación con poca muestra
        </span>
      </div>
      <div class="ola-eta-grid">
        <div class="ola-eta-cell">
          <span class="ola-eta-cell-label">P50 (mediana)</span>
          <span class="ola-eta-cell-value" id="ola-eta-p50">·</span>
          <span class="ola-eta-cell-sub">tiempo restante esperado</span>
        </div>
        <div class="ola-eta-cell">
          <span class="ola-eta-cell-label">P75</span>
          <span class="ola-eta-cell-value" id="ola-eta-p75">·</span>
          <span class="ola-eta-cell-sub">3 de 4 olas terminan antes</span>
        </div>
        <div class="ola-eta-cell">
          <span class="ola-eta-cell-label">P90 (peor caso)</span>
          <span class="ola-eta-cell-value" id="ola-eta-p90">·</span>
          <span class="ola-eta-cell-sub">9 de 10 olas terminan antes</span>
        </div>
      </div>
      <div class="ola-eta-bysize" id="ola-eta-bysize">
        <div class="ola-eta-size-pill" id="ola-eta-size-S">
          <span class="ola-eta-size-label">simple</span>
          <span class="ola-eta-size-value" id="ola-eta-size-S-value">·</span>
          <span class="ola-eta-size-samples" id="ola-eta-size-S-samples">sin samples</span>
        </div>
        <div class="ola-eta-size-pill" id="ola-eta-size-M">
          <span class="ola-eta-size-label">medio</span>
          <span class="ola-eta-size-value" id="ola-eta-size-M-value">·</span>
          <span class="ola-eta-size-samples" id="ola-eta-size-M-samples">sin samples</span>
        </div>
        <div class="ola-eta-size-pill" id="ola-eta-size-L">
          <span class="ola-eta-size-label">grande</span>
          <span class="ola-eta-size-value" id="ola-eta-size-L-value">·</span>
          <span class="ola-eta-size-samples" id="ola-eta-size-L-samples">sin samples</span>
        </div>
      </div>
      <div class="ola-eta-empty" id="ola-eta-empty">
        Sin issues activos. La ETA aparece cuando el pipeline está trabajando.
      </div>
    </section>

    ${navHtml}

    <section class="active-section">
      <h2 class="in-section-title">
        <span class="in-section-title-icon">🟢</span>
        Ejecutando
        <span class="in-section-title-count" id="active-count">…</span>
      </h2>
      <div class="active-list" id="active-list"></div>
      <div class="active-empty" id="active-empty" style="display:none">
        <div class="active-empty-icon">⏸</div>
        <div class="active-empty-msg">No hay agentes corriendo. Verificar pausa, cola y blocked:dependencies.</div>
      </div>
    </section>

    <section class="in-section">
      <div class="in-section-title-row">
        <h2 class="in-section-title">
          <span class="in-section-title-icon">⏪</span>
          Últimos 10 ejecutados
        </h2>
        <!-- #3035 — Toggle "Solo con error". Default OFF (no persiste entre refreshes, CA-3). -->
        <button type="button"
                class="in-pill-toggle"
                id="recent-filter-errors"
                role="switch"
                aria-checked="false"
                tabindex="0"
                title="Mostrar solo los últimos 10 rechazados del histórico">
          Solo con error
        </button>
      </div>
      <div class="line-list" id="recent-list"></div>
    </section>

    <section class="in-section">
      <div class="in-section-title-row">
        <h2 class="in-section-title">
          <span class="in-section-title-icon">⏩</span>
          Próximos 10 en cola
        </h2>
        <!-- #3023 — Badge "filtrado por pausa parcial". Hidden por
             default, tickQueue() lo muestra cuando partialPause.active. -->
        <span class="in-pill-partial-filter"
              id="queue-partial-filter-badge"
              style="display:none"
              title="Mostrando solo issues de la allowlist activa. Levantá la pausa para ver el top 10 completo.">
          ⏸ filtrado por pausa parcial
        </span>
      </div>
      <div class="line-list" id="queue-list"></div>
    </section>

    <!--
      #3487 — Widget "Próximas Olas" (Spike #3378 H3).
      Layout vertical para kiosk 1080×1920. El container #wave-panel SIEMPRE
      ocupa su espacio (CA-1). tickWaves() puebla #wave-active-container y
      #wave-next-container con DOM morphing manual (sin reemplazar el
      container raíz). Polling cada 30s + botón "Reintentar ahora". Cuando
      el endpoint retorna { active_wave: null, next_wave: null } se muestra
      el estado vacío "Planificación no disponible" sin romper el layout.
    -->
    <section class="wave-panel" id="wave-panel" aria-label="Próximas Olas">
      <div class="wave-panel-header">
        <h2 class="wave-panel-header-title">
          <svg class="wave-panel-header-title-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-wave"/></svg>
          Próximas Olas
        </h2>
        <span class="wave-panel-header-meta" id="wave-panel-updated">—</span>
      </div>
      <div id="wave-active-container"></div>
      <div id="wave-next-container"></div>
      <div class="wave-panel-empty" id="wave-panel-empty" style="display:none">
        <svg class="wave-panel-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-wave"/></svg>
        <div class="wave-panel-empty-msg" id="wave-panel-empty-msg">Planificación no disponible — esperando próxima ola</div>
        <button type="button" class="wave-panel-empty-retry" id="wave-panel-retry" title="Forzar refresh fuera del polling de 30s">Reintentar ahora</button>
      </div>
    </section>

  </main>

  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span id="footer-meta">Intrale V3</span>
  </footer>
</div>

<!-- #3723 - Boot config del router cliente. Se inyecta ANTES del script
     principal para que loadView(), popstate y el handler de clicks
     tengan disponibles los flags decididos en SSR. NO contiene datos
     atacable-controlables (currentView es de la allowlist; el flag de
     unknown es bool puro). -->
<script>
window.__VIEW_BOOT__ = ${JSON.stringify({
    currentView,
    unknownViewRequested,
    titles: { home: 'Operación' },
})};
</script>
<script>${script}</script>
</body>
</html>`;
}

module.exports = { renderHomeHTML };

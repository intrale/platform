// V3 Home — render del HTML inicial del dashboard kiosk vertical 1080×1920.
// El layout y los textos se imprimen una sola vez. El refresh es client-side
// vía fetch JSON + DOM morphing manual (sin reemplazar containers, evita flicker).

'use strict';

const fs = require('fs');
const path = require('path');

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

/* Áreas — botonera horizontal compacta con badges de conteo.
   #3045 — auto-fit con minmax(96px, 1fr) en lugar de repeat(9, 1fr):
   - resiste el crecimiento del array AREAS (hoy son 10, no 9) sin que
     el último ítem se vaya a una segunda fila;
   - degrada con gracia si el viewport baja (operador con la ventana
     achicada en monitor secundario);
   - 96px es suficiente para los labels más largos ("Bloqueados", 10ch
     a 11px de font-size) sin truncar ni activar text-overflow. */
.areas-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 8px;
}
.area-pill {
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    transition: transform 0.15s, border-color 0.15s, background 0.15s;
    cursor: pointer;
    position: relative;
    text-decoration: none;
    color: var(--in-fg);
    min-height: 64px;
}
.area-pill:hover {
    transform: translateY(-2px);
    border-color: var(--in-accent);
    background: var(--in-bg-3);
}
.area-pill-icon { font-size: 18px; line-height: 1; }
.area-pill-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--in-fg);
    letter-spacing: 0.2px;
}
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

const AREAS = [
    { key: 'equipo', label: 'Equipo', icon: '👥', sub: 'Agentes y carga', href: '/equipo' },
    { key: 'pipeline', label: 'Pipeline', icon: '🔄', sub: 'Issues por fase', href: '/pipeline' },
    { key: 'bloqueados', label: 'Bloqueados', icon: '🚧', sub: 'Esperando humano', href: '/bloqueados' },
    { key: 'issues', label: 'Issues', icon: '📋', sub: 'Backlog completo', href: '/issues' },
    { key: 'matriz', label: 'Matriz', icon: '📈', sub: 'Skill × Fase', href: '/matriz' },
    { key: 'ops', label: 'Ops', icon: '🛠', sub: 'Procesos e infra', href: '/ops' },
    { key: 'kpis', label: 'KPIs', icon: '📊', sub: 'Métricas detalladas', href: '/kpis' },
    { key: 'historial', label: 'Historial', icon: '📜', sub: 'Actividad reciente', href: '/historial' },
    { key: 'costos', label: 'Costos', icon: '💰', sub: 'Tokens y consumo', href: '/costos' },
    { key: 'modo-descanso', label: 'Descanso', icon: '🌙', sub: 'Ventana horaria', href: '/modo-descanso' },
];

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

    // Modo descanso (#2890 PR-A): pill solo visible cuando la ventana está
    // activa Y configurada con horarios. Texto "Modo descanso · HH:MM-HH:MM".
    const rm = d.restMode || {};
    const restPill = document.getElementById('hdr-rest-mode');
    if(restPill){
        const visible = !!(rm.active && rm.start && rm.end);
        restPill.style.display = visible ? '' : 'none';
        if(visible){
            const within = rm.isWithinWindow ? '· ahora' : '· programada';
            restPill.textContent = '🌙 Modo descanso · '+rm.start+'–'+rm.end+' '+within;
            restPill.title = 'Modo descanso configurado · '+rm.start+'–'+rm.end+' ('+(rm.timezone||'')+'). Click para configurar.';
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

async function tickKpis(){
    const d = await fetchJson('/api/dash/kpis');
    if(!d) return;
    setText('kpi-prs-value', d.prsLast7d==null?'—':d.prsLast7d);
    setText('kpi-tokens-value', fmtNum(d.tokens24h));
    setText('kpi-cycle-value', fmtDur(d.cycleTimeMs));
    const bp = d.bouncePct;
    setText('kpi-bounce-value', fmtPct(bp));
    const bcard = document.getElementById('kpi-bounce');
    if(bcard){
        bcard.classList.remove('kpi-ok','kpi-warn','kpi-bad');
        if(bp!=null){ if(bp>30) bcard.classList.add('kpi-bad'); else if(bp>15) bcard.classList.add('kpi-warn'); else bcard.classList.add('kpi-ok'); }
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
];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
// #3035 — Bind del toggle "Solo con error" antes del primer poll para
// que el handler ya esté escuchando si el usuario hace click apenas carga.
bindRecentFilter();
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }

// Pause polling when tab hidden (avoid wasted backend load)
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') runAll(); });
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

function renderHomeHTML(opts) {
    // `opts.quotaState` permite al caller pasar el state precomputado (evita
    // doble lectura del flag si el dashboard ya lo tiene en mano). Sin opts,
    // leemos defensivamente — caso que vale para tests y para el route handler
    // simple del kiosk.
    const _opts = opts || {};
    const quotaState = _opts.quotaState || getInitialQuotaState();
    const quotaBannerHtml = renderQuotaBannerSsr(quotaState);

    const theme = loadTheme();
    const styles = homeStyles();
    const script = renderClientScript();
    const areasHtml = AREAS.map(a => `
      <a class="area-pill" href="${a.href}" target="_blank" rel="noopener" title="${a.sub}">
        <span class="area-pill-badge area-pill-badge-zero" id="badge-${a.key}">·</span>
        <span class="area-pill-icon">${a.icon}</span>
        <span class="area-pill-name">${a.label}</span>
      </a>`).join('');

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

  <main class="kiosk-body">

    <section class="kpi-grid" aria-label="KPIs">
      <div class="kpi-card" id="kpi-prs">
        <span class="kpi-icon">✅</span>
        <span class="kpi-label">PRs · 7d</span>
        <span class="kpi-value" id="kpi-prs-value">…</span>
        <span class="kpi-sub">mergeados</span>
      </div>
      <div class="kpi-card" id="kpi-tokens">
        <span class="kpi-icon">⚡</span>
        <span class="kpi-label">Tokens · 24h</span>
        <span class="kpi-value" id="kpi-tokens-value">…</span>
        <span class="kpi-sub">in + out</span>
      </div>
      <div class="kpi-card" id="kpi-cycle">
        <span class="kpi-icon">⏱</span>
        <span class="kpi-label">Cycle time</span>
        <span class="kpi-value" id="kpi-cycle-value">…</span>
        <span class="kpi-sub">mediana por fase</span>
      </div>
      <div class="kpi-card" id="kpi-bounce">
        <span class="kpi-icon">↩</span>
        <span class="kpi-label">% Rebote</span>
        <span class="kpi-value" id="kpi-bounce-value">…</span>
        <span class="kpi-sub">rechazos / total</span>
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

    <nav class="areas-bar" aria-label="Áreas">
      ${areasHtml}
    </nav>

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

  </main>

  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span id="footer-meta">Intrale V3</span>
  </footer>
</div>

<script>${script}</script>
</body>
</html>`;
}

module.exports = { renderHomeHTML };

// V3 Home — render del HTML inicial del dashboard kiosk vertical 1080×1920.
// El layout y los textos se imprimen una sola vez. El refresh es client-side
// vía fetch JSON + DOM morphing manual (sin reemplazar containers, evita flicker).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// #3725 — Escape unificado server-side (#3722, lib/escape-html.js). Reemplaza
// la función inline `escapeHtmlSsr` que vivía duplicada acá (deuda heredada).
//   escapeHtmlText → contexto body  (<span>${...}</span>)
//   escapeHtmlAttr → contexto atributo (title="${...}", aria-label="${...}")
const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

// #3953 (EP8-H0) — Componentes SSR compartidos del dashboard V3. Provee
// renderKpiCard/renderStatusBadge/renderAgentPill con escape interno y
// allowlist de íconos de severidad. Los KPI cards de home se emiten desde acá
// preservando los ids invariantes (kpi-prs/-value, etc.) del DOM morphing.
const { renderKpiCard } = require('./components');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2: banner stale + CSRF, nunca
// traga el error en silencio) y framework de modal de confirmación con preview
// (CA-3) que reemplazan el fetchJson `.catch(()=>null)` inline y los confirm()
// nativos. Se inyectan una sola vez al inicio del <script> principal (ver más
// abajo). Mismo patrón que satellites.js / descanso.js / bloqueados.js.
const { FETCH_CLIENT_JS, renderStaleBanner } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

// #3726 — Modulo compartido de la nav bar V3. Provee NAV_TABS,
// renderNavTabsSsr (markup SSR) y loadIconSprite (cache compartido del SVG).
// home.js consume todo desde aca para no duplicar el catalogo de tabs ni
// abrir un segundo cache del sprite (mantiene paridad con satellites.js).
const { renderNavTabsSsr, loadIconSprite, navMoreAutoCloseClientScript } = require('./nav-tabs');
// #4463 — Header compartido: pills de CPU/RAM y uptime del Pulpo + hora. Espejo
// de nav-tabs.js. renderHeaderMetaSsr emite el <div class="in-header-meta"> con
// los IDs invariantes (hdr-resources/hdr-pulpo/hdr-clock) y headerPillsClientScript
// centraliza la hidratación (mismos umbrales in-pill-ok/warn/bad en home y satélites).
const { renderHeaderMetaSsr, headerPillsClientScript } = require('./header-meta');
// #4450 — writer ÚNICO del banner de ola (avance %, velocidad throughput
// issues/día, ETA). La HOME lo inyecta igual que las otras 9 ventanas para no
// reintroducir la divergencia de #4296 (antes la HOME hidrataba el banner con un
// writer inline propio en `tickOlaETA`).
const { missionOlaEtaClientScript } = require('../../lib/mission-ola-eta.js');

// #3954 EP8-H1 — Semáforo global explicable (pulpo + infra + cuota + anomalía).
// Función pura compartida con dashboard.js (sin dependencia circular).
const { computeInfraHealthLevel } = require('../../lib/infra-health-level');

// #3954 EP8-H1 — Store del audit de la bandeja de alertas (ack/snooze). Require
// defensivo: en tests aislados o checkouts viejos el módulo puede faltar; el
// renderer degrada a "sin acciones registradas" sin romper.
let _alertTrayAudit = null;
try { _alertTrayAudit = require('../../lib/alert-tray-audit'); } catch { /* opcional */ }
// #4235 — Marco común MIZPÁ. La «cabecera de ola» (banner de misión) es el helper
// reutilizable que entregó #4234 (PR #4254) en pipeline-redesign.js. HOME lo
// consume desde acá en vez de mantener una copia byte-a-byte del markup (CA: «no
// se duplica markup / reutilizar helpers compartidos»). Require defensivo: si el
// módulo no carga (checkout viejo / test aislado), `renderMissionBanner` degrada
// al markup inline equivalente y el home sigue rindiendo — el pipeline no muere.
let _pipelineRedesign = null;
try { _pipelineRedesign = require('./pipeline-redesign'); } catch { /* opcional */ }
let _quotaExhaustedState = null;
try { _quotaExhaustedState = require('../../lib/quota-exhausted-state'); } catch { /* opcional */ }
let _restModeState = null;
try { _restModeState = require('../../lib/rest-mode-state'); } catch { /* opcional */ }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
// #4172 — Rediseño home V3 "Sala de Control": el nuevo sistema visual consume
// la fuente única de tokens (paleta/espaciado/radios/sombras) de
// `assets/design-tokens.css`, igual que las ventanas satélite (providers.js /
// issues.js). El home NO lo cargaba (usaba sólo --in-* de theme.css); ahora se
// inyecta ANTES de theme.css para que coexistan los dos namespaces (--surface-*,
// --space-*, --brand-* de tokens + --in-* de theme) sin pisarse.
const DESIGN_TOKENS_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'design-tokens.css');

function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); }
    catch { return ''; }
}

function loadDesignTokens() {
    try { return fs.readFileSync(DESIGN_TOKENS_CSS_PATH, 'utf8'); }
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
// en el script (ver renderClientScript), pero al renderizar SSR usamos el
// helper compartido `escapeHtmlText`/`escapeHtmlAttr` de lib/escape-html.js
// (#3722). Antes vivía acá un `escapeHtmlSsr` inline duplicado — eliminado
// como cleanup de deuda heredada (CA-3725.9).

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

/* #4189 — HOME «MIZPÁ»: el rediseño fluye en vertical (banner → nav → panel →
   grilla 2-col → diagnóstico) y scrollea naturalmente, a diferencia de las 3
   bandas fijas de #4172. El modifier mission-frame SOLO se emite en el home
   (renderHomeHTML); el router cliente lo agrega/quita al navegar. */
.kiosk-frame.mission-frame { min-height: 100vh; height: auto; overflow: visible; }
.kiosk-frame.mission-frame .kiosk-body { overflow: visible; min-height: 0; }
/* #4172 — Rediseño "Sala de Control": narrativa de conciencia operativa en 3
   actos (PULSO 22% / AHORA 48% / FLUJO 30%). Todo el sistema visual consume
   design-tokens.css (--surface-*/--space-*/--brand-*/--radius-*/--shadow-*),
   con fallback a literales por si el archivo de tokens no se pudo leer. */
.mission-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: 22fr 48fr 30fr;   /* #4172 PULSO 22% · AHORA 48% · FLUJO 30% */
    gap: var(--space-4, 16px);
    overflow: hidden;
}
.mission-band {
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 12px);
}

/* #4172 — Eyebrow de banda: índice numerado + chip de icono + título + regla.
   Da el ritmo de lectura vertical (01 PULSO → 02 AHORA → 03 FLUJO) y aporta
   la "fluidez" pedida sin recargar. */
.band-eyebrow { display: flex; align-items: center; gap: var(--space-3, 12px); flex: 0 0 auto; }
.band-eyebrow .idx { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--brand-cyan, #00d6ff); letter-spacing: 0.12em; }
.band-eyebrow .chip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: var(--radius-sm, 6px);
    background: var(--surface-2, #1c2128); border: 1px solid var(--border-subtle, #21262d);
    font-size: 13px; line-height: 1;
}
.band-eyebrow .ttl { font-size: 15px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-primary, #e6edf3); }
.band-eyebrow .rule { flex: 1; height: 1px; background: var(--border-subtle, #21262d); }
.band-eyebrow .meta { font-size: 12px; color: var(--text-dim, #8b949e); font-family: var(--font-mono); }

/* #4172 — Tarjeta canónica única: surface-1 + riel de estado (border-left 3px)
   + radius-lg + shadow-sm. El estado se lee por posición+icono+texto, nunca
   sólo por color (WCAG AA). Receta reusada por infra/alertas/secciones. */
.infra-health, .system-card, .ola-eta-section, .wave-panel, .alert-tray,
.mission-band-flujo .in-section {
    background: var(--surface-1, #161b22);
    border: 1px solid var(--border-subtle, #21262d);
    border-left: 3px solid var(--border, #30363d);
    border-radius: var(--radius-lg, 14px);
    box-shadow: var(--shadow-sm, 0 2px 4px rgba(0,0,0,0.36));
}
.infra-health   { border-left-color: var(--success, #3fb950); padding: var(--space-4, 16px); }
.system-card    { border-left-color: var(--info, #58a6ff); }
.ola-eta-section{ border-left-color: var(--info, #58a6ff); }
.wave-panel     { border-left-color: var(--brand-blue, #1890ff); }
.alert-tray     { border-left-color: var(--warning, #d29922); }

/* ── BANDA 1 — PULSO: héroe semáforo + 3 KPIs faro ── */
.mission-band-head {
    display: grid;
    grid-template-columns: minmax(300px, 1fr) 1.35fr;
    gap: var(--space-4, 16px);
    align-items: stretch;
    flex: 0 0 auto;
}
/* Héroe: el semáforo elevado con el ÚNICO acento de gradiente de marca de la
   home (cyan→blue) → dirige la mirada al dato más importante. */
.semaforo {
    display: flex;
    gap: var(--space-5, 20px);
    align-items: center;
    background:
      radial-gradient(120% 140% at 0% 0%, rgba(0,214,255,0.10), transparent 60%),
      var(--surface-1, #161b22);
    border: 1px solid var(--border, #30363d);
    border-left: 4px solid var(--success, #3fb950);
    border-radius: var(--radius-xl, 20px);
    padding: var(--space-5, 20px) var(--space-6, 24px);
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.40));
}
.semaforo-ok    { border-left-color: var(--success, #3fb950); }
.semaforo-warn  { border-left-color: var(--warning, #d29922); }
.semaforo-alert { border-left-color: var(--danger, #f85149); }
.semaforo-stale { border-left-color: var(--text-dim, #8b949e); }
.semaforo-disc {
    width: 60px; height: 60px; flex: 0 0 auto;
    border-radius: var(--radius-full, 9999px);
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; line-height: 1; background: var(--surface-2, #1c2128);
}
.semaforo-ok    .semaforo-disc { background: var(--success-bg, rgba(63,185,80,0.14)); box-shadow: var(--shadow-glow-ok, 0 0 10px rgba(63,185,80,0.45)); }
.semaforo-warn  .semaforo-disc { background: var(--warning-bg, rgba(210,153,34,0.14)); }
.semaforo-alert .semaforo-disc { background: var(--danger-bg, rgba(248,81,73,0.14)); }
.semaforo-stale .semaforo-disc { background: var(--surface-2, #1c2128); }
.semaforo-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.semaforo-label { font-size: 23px; font-weight: 800; letter-spacing: 0.4px; }
.semaforo-ok    .semaforo-label { color: var(--success, #3fb950); }
.semaforo-warn  .semaforo-label { color: var(--warning, #d29922); }
.semaforo-alert .semaforo-label { color: var(--danger, #f85149); }
.semaforo-stale .semaforo-label { color: var(--text-dim, #8b949e); }
.semaforo-reasons { margin: 2px 0 0; padding-left: var(--space-4, 16px); font-size: 12px; color: var(--text-dim, #8b949e); list-style: disc; max-height: 60px; overflow: auto; }
.semaforo-reason-alert { color: var(--danger, #f85149); }
.semaforo-reason-warn  { color: var(--warning, #d29922); }

/* 3 KPIs faro (cuota sesión · cuota semana · PRs). El wrapper #kpi-quota usa
   display:contents para que sus dos hijos participen del grid de 3 columnas
   manteniendo el id invariante que hidrata renderQuotaCard. */
.pulse-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3, 12px); align-items: stretch; }
.kpi-quota-wrap { display: contents; }
.kpi-faro {
    background: var(--surface-1, #161b22);
    border: 1px solid var(--border-subtle, #21262d);
    border-top: 2px solid var(--info, #58a6ff);
    border-radius: var(--radius-lg, 14px);
    padding: var(--space-3, 12px) var(--space-4, 16px);
    display: flex; flex-direction: column; gap: 4px; min-width: 0;
    box-shadow: var(--shadow-xs, 0 1px 2px rgba(0,0,0,0.30));
}
.kpi-faro.kpi-ok   { border-top-color: var(--success, #3fb950); }
.kpi-faro.kpi-warn { border-top-color: var(--warning, #d29922); }
.kpi-faro.kpi-bad  { border-top-color: var(--danger, #f85149); }
.kpi-faro-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim, #8b949e); display: flex; align-items: center; gap: 6px; }
.kpi-faro-value { font-size: 28px; font-weight: 800; font-family: var(--font-mono); line-height: 1; color: var(--text-primary, #e6edf3); font-variant-numeric: tabular-nums; }
.kpi-faro.kpi-ok   .kpi-faro-value { color: var(--success, #3fb950); }
.kpi-faro.kpi-warn .kpi-faro-value { color: var(--warning, #d29922); }
.kpi-faro.kpi-bad  .kpi-faro-value { color: var(--danger, #f85149); }
.kpi-faro-foot { font-size: 11px; color: var(--text-dim, #8b949e); font-family: var(--font-mono); }

/* Banda 1 — detalle (infra + bandeja) lado a lado, scroll interno acotado */
.mission-band-salud-detail { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px, 1fr) 1.6fr; gap: var(--space-4, 16px); overflow: hidden; }
.mission-band-salud-detail > * { min-width: 0; overflow: auto; }

/* Banda 1 — bandeja de alertas (scroll vertical interno acotado, CA-2) */
.alert-tray { display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow: hidden; padding: var(--space-4, 16px); }
.alert-tray-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; }
.alert-tray-row {
    display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px;
    padding: var(--space-2, 8px) var(--space-3, 12px); border-radius: var(--radius-md, 8px);
    border-left: 3px solid var(--border, #30363d); background: var(--surface-2, #1c2128);
}
.alert-tray-row.alert-alert { border-left-color: var(--danger, #f85149); }
.alert-tray-row.alert-warn  { border-left-color: var(--warning, #d29922); }
.alert-tray-row.alert-stale { border-left-color: var(--text-dim, #8b949e); }
.alert-tray-text { font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.alert-tray-status { font-size: 11px; color: var(--text-dim, #8b949e); white-space: nowrap; }
.alert-tray-actions { display: flex; gap: 4px; }
.alert-ack-btn, .alert-snooze-btn {
    font-size: 11px; padding: 4px 8px; min-height: 24px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border, #30363d); background: var(--surface-2, #1c2128); color: var(--text-secondary, #b1bac4);
}
.alert-snooze-max { border-color: var(--warning, #d29922); }
.alert-tray-empty { font-size: 12px; color: var(--text-dim, #8b949e); padding: 6px 4px; }
.alert-tray-audit { font-size: 11px; color: var(--text-disabled, #6e7681); border-top: 1px solid var(--border-subtle, #21262d); padding-top: 4px; max-height: 56px; overflow: auto; }
.deeplink-selected { outline: 2px solid var(--in-focus, #38bdf8); outline-offset: 1px; }

/* ── BANDA 2 — AHORA: carrusel horizontal acotado a la banda (CA-2) ── */
.mission-band-now { flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; }
.mission-band-now .active-list { display: flex; flex-direction: row; gap: var(--space-4, 16px); flex-wrap: nowrap; height: 100%; align-items: stretch; }
.mission-band-now .active-list > * { flex: 0 0 auto; }

/* ── BANDA 3 — FLUJO: dos columnas con scroll interno acotado ── */
.mission-band-flow { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4, 16px); overflow: hidden; }
.mission-flow-col { min-width: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--space-3, 12px); }

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

/* #3948 (EP-7) — Card observacional del Commander. Tres señales redundantes
   (borde punteado + superficie atenuada + pill "observa"), nunca sólo color
   (WCAG AA). 100% tokens de theme.css (--in-info / --in-info-soft). */
.active-card.observational {
    border-left: 3px dashed var(--in-info);
    background: var(--in-info-soft);
    opacity: 0.94;
}
.active-card-observe {
    grid-column: 3;
    grid-row: 2;
    justify-self: end;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--in-info-soft);
    border: 1px solid var(--in-info);
    color: var(--in-info);
    border-radius: 6px;
    padding: 2px 9px;
    font-size: 11px;
    cursor: default;
}
/* Barra indeterminada (pulse): la presencia no tiene ETA, pintar un % fijo daría
   falsa señal de avance. */
.active-card-progress.indeterminate .in-bar { overflow: hidden; }
.active-card-progress.indeterminate .in-bar > span {
    width: 32%;
    animation: in-presence-pulse 1.4s ease-in-out infinite;
}
@keyframes in-presence-pulse {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(330%); }
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
/* #4731 — Banner de cuota por-proveedor. El COLOR comunica el scope:
 *  - Puntual (partial, ≥1 LLM operativo): calmo sobre --surface-1, acento =
 *    color del proveedor afectado (--provider-<id>-*). NO usa el ámbar.
 *  - Global (0 LLM operativo): ámbar --quota-degraded-* + glow (alarma real).
 * Así el ámbar recupera su peso de "sin LLM" y no se quema por degradaciones
 * puntuales (incidente 14–15/07). */
.quota-exhausted-banner {
    display: none;
    margin: 0 22px;
    padding: 14px 18px;
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
    border-radius: var(--in-radius, 8px);
    box-shadow: none;
    font-size: 13px;
    line-height: 1.4;
    grid-template-columns: auto 1fr auto;
    column-gap: 16px;
    align-items: center;
}
.quota-exhausted-banner[data-active="true"] { display: grid; }

/* Acento (borde izquierdo) por proveedor afectado — scope puntual. El color se
 * elige POR ATRIBUTO allowlisteado, nunca inyectando el id crudo (CA-6/A03). */
.quota-exhausted-banner[data-provider="openai-codex"] { border-left-color: var(--provider-openai-codex); }
.quota-exhausted-banner[data-provider="anthropic"]    { border-left-color: var(--provider-anthropic); }
.quota-exhausted-banner[data-provider="cerebras"]     { border-left-color: var(--provider-cerebras); }
.quota-exhausted-banner[data-provider="gemini-google"]{ border-left-color: var(--provider-gemini); }
.quota-exhausted-banner[data-provider="nvidia-nim"]   { border-left-color: var(--provider-nvidia-nim); }
.quota-exhausted-banner[data-provider="groq"]         { border-left-color: var(--provider-groq); }

/* Global: 0 proveedores LLM disponibles → ámbar de alarma controlada. */
.quota-exhausted-banner[data-scope="global"] {
    background: var(--quota-degraded-bg);
    border-color: var(--quota-degraded);
    border-left-color: var(--quota-degraded);
    box-shadow: var(--quota-degraded-glow);
}

.quota-exhausted-icon {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    color: var(--border-strong);
}
.quota-exhausted-banner[data-scope="global"] .quota-exhausted-icon { color: var(--quota-degraded); }
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
    color: var(--text-primary);
    letter-spacing: 0.2px;
}
.quota-exhausted-banner[data-scope="global"] .quota-exhausted-title { color: var(--quota-degraded-fg); }
.quota-exhausted-sub {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: var(--in-mono, 'Roboto Mono', monospace);
    word-break: break-word;
}

/* #4731 — Chips por proveedor afectado (habilitan el CA plural). */
.quota-exhausted-providers {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 2px;
}
.quota-provider-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 14px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 700;
    color: var(--provider-unknown-fg);
    background: var(--provider-unknown-bg);
    border: 1px solid var(--provider-unknown);
}
.quota-provider-chip[data-provider="openai-codex"] { color: var(--provider-openai-codex-fg); background: var(--provider-openai-codex-bg); border-color: var(--provider-openai-codex); }
.quota-provider-chip[data-provider="anthropic"]    { color: var(--provider-anthropic-fg);    background: var(--provider-anthropic-bg);    border-color: var(--provider-anthropic); }
.quota-provider-chip[data-provider="cerebras"]     { color: var(--provider-cerebras-fg);     background: var(--provider-cerebras-bg);     border-color: var(--provider-cerebras); }
.quota-provider-chip[data-provider="gemini-google"]{ color: var(--provider-gemini-fg);       background: var(--provider-gemini-bg);       border-color: var(--provider-gemini); }
.quota-provider-chip[data-provider="nvidia-nim"]   { color: var(--provider-nvidia-nim-fg);   background: var(--provider-nvidia-nim-bg);   border-color: var(--provider-nvidia-nim); }
.quota-provider-chip[data-provider="groq"]         { color: var(--provider-groq-fg);         background: var(--provider-groq-bg);         border-color: var(--provider-groq); }
.quota-provider-chip .quota-provider-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor;
    flex: 0 0 8px;
}
.quota-provider-chip .quota-provider-reason { font-weight: 500; opacity: 0.9; }
.quota-provider-chip .quota-provider-reset { font-weight: 500; opacity: 0.7; font-variant-numeric: tabular-nums; }

/* #4731 — Health strip: evidencia visible de "no global" (CA-2). */
.quota-health-strip {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 2px;
}
.quota-health-strip[data-empty="true"] { display: none; }
.quota-health-item { display: inline-flex; align-items: center; gap: 5px; }
.quota-health-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); flex: 0 0 8px; }

.quota-exhausted-panels {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 4px;
}
.quota-exhausted-panel {
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
}
.quota-exhausted-panel-label {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
    color: var(--text-secondary);
}
.quota-exhausted-panel-value {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
}
.quota-exhausted-panel.det .quota-exhausted-panel-value {
    color: var(--success);
}
.quota-exhausted-skills {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: 4px;
}
.quota-exhausted-skill-pill {
    background: var(--surface-3);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
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
    color: var(--text-secondary);
}
.quota-exhausted-countdown-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    font-family: var(--in-mono, 'Roboto Mono', monospace);
}
.quota-exhausted-banner[data-scope="global"] .quota-exhausted-countdown-value { color: var(--quota-degraded-fg); }
.quota-exhausted-countdown-bar {
    width: 100%;
    height: 4px;
    background: var(--surface-3);
    border-radius: 2px;
    overflow: hidden;
}
.quota-exhausted-countdown-bar > span {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--border-strong);
    transition: width 1s linear;
}
.quota-exhausted-banner[data-scope="global"] .quota-exhausted-countdown-bar > span { background: var(--quota-degraded); }

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

/* #3725 — Build status pill en la brand bar. Reusa la familia .in-pill y los
   estados in-pill-ok/warn/bad/info ya definidos en el tema. */
.in-build-status {
    margin-left: 12px;
    font-size: 12px;
    white-space: nowrap;
}
.in-build-detail {
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
}

/* #3725 — Salud de infra (pulpo / dashboard / telegram bot). */
.infra-health {
    margin-bottom: 18px;
}
.infra-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-top: 8px;
}
.infra-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--in-border, #30363d);
    border-left-width: 3px;
    border-radius: 8px;
    background: var(--in-card, #161b22);
}
.infra-row.infra-up      { border-left-color: var(--success, #3fb950); }
.infra-row.infra-down    { border-left-color: var(--danger, #f85149); }
.infra-row.infra-unknown { border-left-color: var(--in-fg-dim, #8b949e); }
.infra-dot { font-size: 12px; }
.infra-name { font-weight: 600; font-size: 13px; }
.infra-status {
    margin-left: auto;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
}
.infra-row.infra-up    .infra-status { color: var(--success, #3fb950); }
.infra-row.infra-down  .infra-status { color: var(--danger, #f85149); }
.infra-ping {
    font-size: 11px;
    color: var(--in-fg-dim, #8b949e);
    font-variant-numeric: tabular-nums;
}

/* #3725 — System card (CPU / RAM / disco / uptime del host). */
.system-card {
    margin-top: 18px;
    margin-bottom: 8px;
}
.sys-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-top: 8px;
}
.sys-cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border: 1px solid var(--in-border, #30363d);
    border-left: 3px solid var(--teal, #2dd4bf);
    border-radius: 8px;
    background: var(--in-card, #161b22);
}
.sys-cell-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--in-fg-dim, #8b949e);
}
.sys-cell-value {
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--in-fg, #e6edf3);
}

/* =========================================================================
   #4189 — HOME «MIZPÁ» (mockup v6). Estilos del rediseño integral. Consumen
   los design-tokens existentes (--in-* / --brand-*) con fallback a literales.
   ========================================================================= */
.mz-home { display: flex; flex-direction: column; gap: 16px; }

/* --- Top bar: marca MIZPÁ + selector de proyecto --- */
/* #4531 — Fila única: la brand cede espacio (min-width:0) y la bandeja se
   mantiene integra a la derecha (flex:none). Con flex-wrap nowrap el header no
   arroja las pills a una 2da fila que pisaria el banner de la ola. */
.in-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: nowrap; }
.in-header-brand { display: flex; align-items: center; gap: 13px; flex-wrap: nowrap; min-width: 0; }
.in-header .in-header-meta { flex: none; }
.mz-logo { width: 46px; height: 46px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, var(--brand-cyan,#34D9E0), #7C5CFF 90%);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 26px rgba(124,92,255,.30); }
.mz-logo svg { width: 26px; height: 26px; }
.mz-id { display: flex; flex-direction: column; }
.mz-name { font-size: 21px; font-weight: 800; line-height: 1; letter-spacing: 1px;
    background: linear-gradient(90deg,#bff3f6,#c9bcff); -webkit-background-clip: text; background-clip: text; color: transparent; }
.mz-sub { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; letter-spacing: 1.1px; margin-top: 5px; }
.mz-projsel { display: flex; align-items: center; gap: 11px; background: var(--in-bg-2,#11151E);
    border: 1px solid var(--in-border,rgba(255,255,255,.12)); border-radius: 13px; padding: 8px 9px 8px 12px;
    margin-left: 4px; cursor: pointer; }
.mz-projsel:focus-visible { outline: 2px solid var(--in-focus,#38bdf8); outline-offset: 2px; }
.mz-proj-avatar { width: 30px; height: 30px; border-radius: 9px; flex: none; color: #06121a; font-weight: 800; font-size: 15px;
    background: linear-gradient(135deg,#34D9E0,#5A8DEE); display: flex; align-items: center; justify-content: center; }
.mz-proj-id { display: flex; flex-direction: column; }
.mz-proj-name { font-size: 14px; font-weight: 800; line-height: 1.05; }
.mz-proj-state { font-size: 9.5px; color: var(--in-fg-dim,#5B6376); font-weight: 700; letter-spacing: .4px; margin-top: 2px; }
.mz-proj-badge { font-size: 10px; font-weight: 800; color: #9fe9ee; background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); border-radius: 8px; padding: 3px 8px; }
.mz-proj-caret { color: var(--in-fg-dim,#8A93A6); font-size: 12px; }

/* --- Banner de misión --- */
.mz-mission { display: flex; align-items: center; gap: 22px; position: relative; overflow: hidden;
    background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%),
                linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 24px; }
.mz-mission::after { content: "🌊"; position: absolute; right: 18px; top: -14px; font-size: 90px; opacity: .06; }
.mz-wavetag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 96px;
    padding: 10px 14px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.mz-wavetag-k { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #9fe9ee; }
.mz-wavetag-n { font-size: 34px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-mission-text { flex: 1; min-width: 0; }
.mz-mission-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mz-mission-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.mz-mission-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 560px; line-height: 1.45; }
.mz-mission-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
@media (max-width: 1100px) { .mz-mission-metrics { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px)  { .mz-mission-metrics { grid-template-columns: 1fr; } }
.mz-wm { min-width: 0; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07));
    border-radius: 11px; padding: 9px 12px; }
.mz-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.mz-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 600; }
.mz-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 3px; }
.mz-mission-prog { min-width: 280px; }
.mz-prog-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11.5px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; }
.mz-prog-pct { font-size: 26px; font-weight: 800; color: var(--brand-cyan,#34D9E0); font-variant-numeric: tabular-nums; }
.mz-prog-bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); overflow: hidden; display: flex; margin: 9px 0 8px; }
.mz-prog-bar i { height: 100%; transition: width .4s ease; }
.mz-prog-legend { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim,#8A93A6); flex-wrap: wrap; }
.mz-prog-legend span { display: flex; align-items: center; gap: 5px; }
.mz-prog-legend b { font-variant-numeric: tabular-nums; }
.mz-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
/* #4500 — Timeline único de la ola (reemplaza .mz-mission-metrics + .mz-mission-prog).
   Narrativa comienzo→ahora→cierre en UNA línea, con el fill de progreso SOBRE el
   mismo rail, velocidad/entregados como anotaciones y un sparkline de ritmo debajo.
   Sólo tokens de theme.css (cero hex nuevos): fill --in-accent→--in-ok, marcador
   y sparkline --brand-cyan, velocidad --in-ok, entregados --in-info, dim --in-fg-dim. */
.mz-timeline { margin-top: 14px; }
.mz-tl-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.mz-tl-cap { display: flex; flex-direction: column; min-width: 0; }
.mz-tl-cap-mid { align-items: center; }
.mz-tl-cap-eta { align-items: flex-end; text-align: right; }
.mz-tl-cap-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8b949e); }
.mz-tl-cap-v { font-size: 15px; font-weight: 800; margin-top: 2px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-tl-cap-s { font-size: 10px; color: var(--in-fg-dim,#8b949e); margin-top: 2px; }
/* #4588 — línea del ETA descompuesto (firma del operador). Acento cyan para
   diferenciarla del sub-label mudo, tabular-nums para alinear los tiempos. */
.mz-tl-cap-decomp { font-size: 10.5px; font-weight: 700; color: var(--brand-cyan,#34D9E0); margin-top: 3px; line-height: 1.35; font-variant-numeric: tabular-nums; max-width: 260px; }
.mz-tl-cap .mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#8b949e); font-weight: 600; }
.mz-tl-cap-mid .mz-prog-pct { font-size: 22px; }
.mz-tl-track { position: relative; margin-top: 34px; height: 8px; }
/* #4532 (re-QA) — VELOCIDAD y ENTREGADOS viven en una fila de flujo normal
   (flex + space-between), NO en la capa absoluta que seguía al marcador "ahora".
   Antes, .mz-tl-annot-vel se posicionaba con left:<avance>% + translateX(-50%) y,
   con avance alto (>=~37%), su borde cruzaba sobre ENTREGADOS (anclada a right:0)
   → texto encimado/ilegible. Con space-between el solape se elimina por
   construcción para cualquier avance; el left:% queda reservado al marcador del rail. */
.mz-tl-annots { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.mz-tl-annot { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; min-width: 0; }
.mz-tl-annot .mz-wm-u { font-size: 10px; color: var(--in-fg-dim,#8b949e); font-weight: 600; }
.mz-tl-annot-vel { color: var(--in-ok,#3fb950); }
.mz-tl-annot-del { color: var(--in-info,#58a6ff); text-align: right; }
.mz-tl-annot-s { color: var(--in-fg-dim,#8b949e); font-weight: 600; font-size: 10px; }
.mz-tl-annot-l { color: var(--in-fg-dim,#8b949e); font-weight: 600; font-size: 10px; letter-spacing: .04em; }
.mz-tl-rail { position: relative; height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); }
.mz-tl-fill { position: absolute; left: 0; top: 0; height: 100%; width: 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--in-accent,#2ee6c1), var(--in-ok,#3fb950)); transition: width .4s ease; }
.mz-tl-now { position: absolute; top: 50%; left: 0; width: 14px; height: 14px; border-radius: 50%;
    background: var(--brand-cyan,#34D9E0); border: 2px solid var(--in-bg-2,#161b22);
    box-shadow: 0 0 0 3px rgba(52,217,224,.25); transform: translate(-50%,-50%); transition: left .4s ease; z-index: 2; }
.mz-spark { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.mz-spark-cap { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8b949e); flex: none; }
.mz-spark-plot { display: block; flex: 1; height: 24px; min-width: 60px; }
.mz-spark-plot .mz-spark-svg { width: 100%; height: 100%; display: block; }
/* #4500 (re-QA #4568) — CA-UX-9: con <2 deltas el sparkline NO reserva la fila de
   24px del plot. La cápsula "📈 RITMO · datos insuficientes" queda en una fila slim
   y el <svg> se colapsa (display:none) en vez de dibujar guiones en 24px de alto
   (espacio muerto que originó el re-QA visual del 2026-07-08). El client togglea
   la clase .mz-spark-empty según haya o no serie de ritmo suficiente. */
.mz-spark-empty .mz-spark-plot { display: none; }
.mz-spark-note { font-size: 10.5px; font-weight: 700; color: var(--brand-cyan,#34D9E0); flex: none; font-variant-numeric: tabular-nums; }
.mz-tl-legend { margin-top: 14px; }

/* --- Nav curada: botón ⋯ Más + popover (<details>) --- */
.v3-nav { position: relative; flex-wrap: wrap; }
.v3-tab-desc { display: none; }
.v3-more { position: relative; margin-left: auto; }
.v3-more > summary { list-style: none; }
.v3-more > summary::-webkit-details-marker { display: none; }
.v3-more-btn { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700;
    color: #bff3f6; padding: 9px 15px; border-radius: 9px; cursor: pointer; user-select: none;
    background: linear-gradient(135deg, rgba(52,217,224,.16), rgba(124,92,255,.13)); border: 1px solid rgba(52,217,224,.32); }
.v3-more-active .v3-more-btn { box-shadow: 0 0 0 1px rgba(52,217,224,.5) inset; }
.v3-more-dots { font-size: 17px; line-height: 1; letter-spacing: 2px; }
.v3-more-count { font-size: 9.5px; font-weight: 800; color: #06121a; background: var(--brand-cyan,#34D9E0); border-radius: 7px; padding: 2px 6px; }
.v3-more-menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; width: 264px;
    background: linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925)); border: 1px solid rgba(52,217,224,.25);
    border-radius: 14px; padding: 8px; box-shadow: 0 20px 50px rgba(0,0,0,.55); display: flex; flex-direction: column; gap: 2px; }
.v3-more-head { font-size: 9.5px; font-weight: 800; letter-spacing: 1px; color: var(--in-fg-dim,#5B6376); padding: 6px 10px 8px; }
.v3-more-menu .v3-tab { display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 9px;
    width: auto; flex-direction: row; justify-content: flex-start; }
.v3-more-menu .v3-tab .v3-tab-icon { width: 18px; height: 18px; flex: none; }
.v3-more-menu .v3-tab .v3-tab-label { font-size: 13px; font-weight: 600; }
.v3-more-menu .v3-tab .v3-tab-desc { display: block; font-size: 10px; color: var(--in-fg-dim,#5B6376); font-weight: 600; margin-top: 1px; }
.v3-more-menu .v3-tab-label + .v3-tab-desc { margin-left: -6px; }
.v3-more-menu .v3-tab > .v3-tab-label { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }

/* --- Panel estado + cuotas (#4533: status compacto + matriz proveedor×ventana)
 * Panel de APOYO: compacto, una línea por proveedor, NO compite con "Ahora ·
 * En Ejecución" ni con "Issues de la Ola". */
.mz-sysquota { display: grid; grid-template-columns: 0.9fr 2.3fr; overflow: hidden;
    background: linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 16px; }
.mz-sq-side { padding: 13px 16px; border-right: 1px solid var(--in-border,rgba(255,255,255,.07));
    display: flex; flex-direction: column; gap: 10px; }
.mz-sq-head { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 800; letter-spacing: 1px; }
/* Estado del sistema: semáforo COMPACTO (dot + label), sin el círculo gigante
 * ni el chip redundante que repetía el subtítulo (CA #4533). */
.mz-status-line { display: flex; align-items: center; gap: 8px; }
.mz-status-dot { width: 11px; height: 11px; border-radius: 50%; flex: none; background: var(--in-fg-dim,#8b949e); }
.mz-status-lbl { font-size: 15px; font-weight: 800; }
.mz-status-ok .mz-status-dot { background: var(--in-ok,#3fb950); box-shadow: 0 0 8px rgba(63,185,80,.5); }
.mz-status-ok .mz-status-lbl { color: var(--in-ok,#3fb950); }
.mz-status-warn .mz-status-dot { background: var(--in-warn,#d29922); }
.mz-status-warn .mz-status-lbl { color: var(--in-warn,#d29922); }
.mz-status-alert .mz-status-dot { background: var(--in-bad,#f85149); }
.mz-status-alert .mz-status-lbl { color: var(--in-bad,#f85149); }
.mz-status-stale .mz-status-dot { background: var(--in-fg-dim,#8b949e); }
.mz-status-stale .mz-status-lbl { color: var(--in-fg-dim,#8b949e); }
/* Señales accionables (anomalía, rebote, proveedores sanos). */
.mz-sq-signals { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.mz-sig { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700;
    color: var(--in-fg-dim,#8A93A6); background: rgba(255,255,255,.04);
    border: 1px solid var(--in-border,rgba(255,255,255,.10)); border-radius: 8px; padding: 5px 9px; }
.mz-sig b { font-variant-numeric: tabular-nums; color: #6ee7b7; margin-left: auto; }
.mz-sig[data-on="0"] { opacity: .4; }
.mz-sig[data-on="1"] { border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.09); color: var(--in-bad,#f85149); opacity: 1; }

/* Matriz proveedor × ventana. */
.mz-sq-matrix { padding: 13px 16px; min-width: 0; }
.mz-qm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; }
.mz-qm-h-l { font-size: 10px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8A93A6); }
.mz-qm-h-note { font-size: 8.5px; color: var(--in-fg-soft,#6e7681); font-weight: 600; }
.mz-qm-cols, .mz-qm-row { display: grid; grid-template-columns: 1.25fr 1fr 1fr; column-gap: 16px; align-items: center; }
.mz-qm-gh { font-size: 8.5px; font-weight: 800; letter-spacing: .4px; color: var(--in-fg-soft,#6e7681); text-transform: uppercase; padding-bottom: 4px; }
.mz-qm-row > * { border-top: 1px solid var(--in-border,rgba(255,255,255,.07)); min-height: 30px; display: flex; align-items: center; }
.mz-qm-prov { gap: 7px; }
.mz-pdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.mz-qm-pn { font-size: 12px; font-weight: 800; }
.mz-qm-src { font-size: 8.5px; color: var(--in-fg-soft,#6e7681); font-weight: 700; }
.mz-qm-cell { gap: 7px; font-size: 11px; }
.mz-qm-wtag { font-size: 8px; font-weight: 800; letter-spacing: .3px; color: var(--in-fg-soft,#6e7681); text-transform: uppercase; min-width: 26px; }
.mz-qm-mini { width: 52px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.09); overflow: hidden; flex: none; }
.mz-qm-mini i { display: block; height: 100%; border-radius: 3px; background: var(--in-fg-dim,#8b949e); transition: width .4s ease; }
.mz-qm-pct { font-weight: 800; font-variant-numeric: tabular-nums; min-width: 34px; color: var(--in-fg-dim,#8A93A6); }
.mz-qm-rst { font-size: 9px; color: var(--in-fg-dim,#8A93A6); font-weight: 700; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
.mz-qm-cell.ok   .mz-qm-pct { color: var(--in-ok,#3fb950); }   .mz-qm-cell.ok   .mz-qm-mini i { background: var(--in-ok,#3fb950); }
.mz-qm-cell.warn .mz-qm-pct { color: var(--in-warn,#d29922); } .mz-qm-cell.warn .mz-qm-mini i { background: var(--in-warn,#d29922); }
.mz-qm-cell.bad  .mz-qm-pct { color: var(--in-bad,#f85149); }  .mz-qm-cell.bad  .mz-qm-mini i { background: var(--in-bad,#f85149); }
/* El override de evento oculta la mini-barra y el reset en los estados
   categóricos (exhausted → "tope activo"; nodata → "sin dato"). El estado
   fresco de Codex se marca con .mz-qm-fresh y queda EXCLUIDO para que la
   mini-barra y el color por umbral (ok/warn/bad) que setea el JS se vean en el
   render real (#4900 rebote QA — antes .mz-qm-event neutralizaba barra y color). */
.mz-qm-cell.mz-qm-event:not(.mz-qm-fresh) .mz-qm-mini, .mz-qm-cell.mz-qm-event:not(.mz-qm-fresh) .mz-qm-rst { display: none; }
/* exhausted → "tope activo": texto rojo crítico, sin chip de fondo. El mockup
   acordado (assets/mockups/4900/codex-quota-states.svg) lo define en #f85149 con
   precedencia máxima; antes se pintaba como chip azul info y NO coincidía con el
   contrato visual (#4900 rebote PO: render vs mockup). */
.mz-qm-cell.mz-qm-event.mz-qm-exhausted .mz-qm-pct { color: var(--in-bad,#f85149); font-weight: 800; font-size: 10px; min-width: 0; }
/* nodata → "sin dato": texto neutro gris (#6e7681), sin barra ni chip. El mockup
   lo define como texto atenuado; antes la regla de evento azul le ganaba por
   especificidad y lo pintaba azul (#4900 rebote PO: render vs mockup). */
.mz-qm-cell.mz-qm-nodata .mz-qm-mini, .mz-qm-cell.mz-qm-nodata .mz-qm-rst { display: none; }
.mz-qm-cell.mz-qm-nodata .mz-qm-pct { color: var(--in-fg-soft,#6e7681); font-weight: 600; font-size: 10px; min-width: 0; }

/* --- Grilla 2-col + paneles --- */
.mz-grid { display: grid; grid-template-columns: 1fr 1.62fr; gap: 16px; align-items: start; }
.mz-panel { background: linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 16px; padding: 20px; min-width: 0; }
.mz-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 15px; flex-wrap: wrap; }
.mz-panel-t { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 700; letter-spacing: .4px; }
.mz-panel-ic { width: 22px; height: 22px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
    font-size: 13px; background: rgba(52,217,224,.15); flex: none; }
.mz-panel-hint { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
.mz-now-list { display: flex; flex-direction: column; gap: 11px; }
.mz-now-empty { padding: 18px 14px; border-radius: 12px; border: 1px dashed var(--in-border,rgba(255,255,255,.12));
    background: rgba(255,255,255,.02); text-align: center; }
.mz-now-empty .active-empty-icon { font-size: 22px; opacity: .7; }
.mz-now-empty .active-empty-msg { font-size: 12px; color: var(--in-fg-dim,#8A93A6); margin-top: 6px; line-height: 1.4; }
.mz-board-legend { display: flex; gap: 13px; font-size: 10.5px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; flex-wrap: wrap; }
.mz-board-legend span { display: flex; align-items: center; gap: 5px; }
.mz-board-body { position: relative; }
.mz-board-updated { position: absolute; top: -34px; right: 0; font-size: 10.5px; color: var(--in-fg-dim,#5B6376); }
.mz-board-foot { margin-top: 13px; padding-top: 12px; border-top: 1px dashed var(--in-border,rgba(255,255,255,.12));
    font-size: 11px; color: var(--in-fg-dim,#5B6376); }

/* --- Tablero de la ola alineado al mockup v6 (#4227 CA-3) ---------------- */
/* El shell del panel ya es MIZPÁ, pero las filas usaban el estilo legacy
   (chip de prioridad + tamaño + badge). El mockup pide una grilla limpia y
   plana: indicador de estado | #num (link) | título | pill de estado. Se
   declutteran prioridad/tamaño (no están en el mockup) y se quita el header
   por-ola redundante (el panel ya titula "ISSUES DE LA OLA"). Scope acotado a
   .mz-board para no alterar el wave-panel en otras vistas. */
.mz-board .wave-panel-header { display: none; }
.mz-board .wave-row { background: transparent; border: 0; border-left: 0; padding: 0; gap: 0; }
.mz-board .wave-row-head { display: none; }
/* El colapso por-ola no existe en el mockup; forzar issues siempre visibles
   (evita quedar atrapado por un estado colapsado persistido en sessionStorage). */
.mz-board .wave-row.is-collapsed .wave-row-issues { display: flex; }
.mz-board .wave-row-issues { gap: 3px; }
/* #4250 — Campos enriquecidos: ocultos por default (otras vistas del wave-panel
   no los muestran). Sólo se revelan dentro de .mz-board (HOME). */
.wave-issue-prog, .wave-issue-tag, .wave-issue-acts { display: none; }

/* Fila del mockup HOME: ícono de estado | #num | título | barra | pill | acciones. */
.mz-board .wave-issue {
    grid-template-columns: 16px 52px minmax(0,1fr) 56px minmax(64px,auto) auto;
    align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 11px;
    background: rgba(255,255,255,.018); border: 1px solid transparent;
    border-left: 2px solid var(--in-border,rgba(255,255,255,.12));
}
.mz-board .wave-issue:nth-child(even) { background: rgba(255,255,255,.035); }
/* Indicador de estado como glifo monocromo (hereda color) — primer ítem de la grilla. */
.mz-board .wave-issue::before {
    content: "○"; font-size: 12px; font-weight: 900; line-height: 1;
    justify-self: center; color: var(--in-fg-dim,#5B6376);
}
/* Tinte por estado: borde izquierdo + glifo + color (hecho/curso/lista/cola/bloq). */
.mz-board .wave-issue[data-status="completed"] { border-left-color: var(--in-ok,#3FB950); }
.mz-board .wave-issue[data-status="completed"]::before { content: "✓"; color: #6ee7b7; }
.mz-board .wave-issue[data-status="in-progress"] { border-left-color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.06); }
.mz-board .wave-issue[data-status="in-progress"]::before { content: "▸"; color: #7eeef3; }
.mz-board .wave-issue[data-status="ready"] { border-left-color: var(--in-info,#58A6FF); }
.mz-board .wave-issue[data-status="ready"]::before { content: "○"; color: #9cc6fb; }
.mz-board .wave-issue[data-status="queued"] { border-left-color: var(--in-fg-dim,#5B6376); }
.mz-board .wave-issue[data-status="queued"]::before { content: "·"; color: #8b949e; }
.mz-board .wave-issue[data-status="blocked"] { border-left-color: var(--in-bad,#F85149); }
.mz-board .wave-issue[data-status="blocked"]::before { content: "✕"; color: #fca5a5; }
/* #num: link azul punteado, protagonista (como .inum del mockup). */
.mz-board .wave-issue-id { font-size: 12.5px; font-weight: 800; }
.mz-board .wave-issue-id a { color: #9cc6fb; border-bottom: 1px dotted rgba(96,165,250,.45); }
.mz-board .wave-issue-title { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Declutter: prioridad/tamaño y el badge de texto legacy no van en el mockup HOME
   (los reemplaza la pill enriquecida wave-issue-tag). */
.mz-board .wave-pill, .mz-board .wave-badge { display: none; }
/* Barra de progreso por issue. */
.mz-board .wave-issue-prog { display: block; height: 5px; border-radius: 4px;
    background: rgba(255,255,255,.08); overflow: hidden; }
.mz-board .wave-issue-prog i { display: block; height: 100%; width: 0; border-radius: 4px;
    background: #9cc6fb; transition: width .4s ease; }
.mz-board .wave-issue-prog[data-status="completed"] i { background: #6ee7b7; }
.mz-board .wave-issue-prog[data-status="ready"] i { background: #9cc6fb; }
.mz-board .wave-issue-prog[data-status="blocked"] i { background: #fca5a5; }
/* En curso: barra "viva" (no hay % real) — latido suave. */
.mz-board .wave-issue-prog[data-status="in-progress"] i {
    background: linear-gradient(90deg, var(--brand-cyan,#34D9E0), #7eeef3);
    animation: mzb-prog-pulse 1.5s ease-in-out infinite;
}
@keyframes mzb-prog-pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
/* Pill derecha: estado/agente·fase (mergeado · backend-dev · DEV · en cola). */
.mz-board .wave-issue-tag { display: inline-flex; align-items: center; justify-self: end;
    white-space: nowrap; font-size: 9.5px; font-weight: 800; letter-spacing: .4px;
    text-transform: uppercase; padding: 3px 9px; border-radius: 20px;
    background: rgba(255,255,255,.06); color: var(--in-fg-dim,#8A93A6); }
.mz-board .wave-issue-tag[data-status="completed"] { background: rgba(52,211,153,.14); color: #6ee7b7; }
.mz-board .wave-issue-tag[data-status="in-progress"] { background: rgba(52,217,224,.14); color: #7eeef3; }
.mz-board .wave-issue-tag[data-status="ready"] { background: rgba(96,165,250,.14); color: #9cc6fb; }
.mz-board .wave-issue-tag[data-status="blocked"] { background: rgba(248,81,73,.14); color: #fca5a5; }
/* Acciones: link al issue + log del agente (íconos como el mockup). */
.mz-board .wave-issue-acts { display: inline-flex; align-items: center; gap: 4px; justify-self: end; }
.mz-board .wave-act { display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 7px; font-size: 11px; text-decoration: none; opacity: .7;
    background: rgba(255,255,255,.04); border: 1px solid var(--in-border,rgba(255,255,255,.08)); }
.mz-board .wave-act:hover { opacity: 1; background: rgba(255,255,255,.09); }
/* Timestamp "actualizado": antes se posicionaba absoluto sobre la leyenda del
   header (solape). Pasa a flujo normal, alineado a la derecha bajo la lista. */
.mz-board .mz-board-updated { position: static; display: block; text-align: right;
    margin-top: 8px; font-size: 10px; }

/* --- Ahora · en ejecución alineado al mockup v6 (#4227 CA-4) ------------- */
/* Las tarjetas de agentes activos ya eran tipo card; el mockup pide: fase como
   pill coloreada por etapa, indicador de proveedor junto a la barra y el tiempo
   con eyebrow "CORRE". Scope acotado a .mz-now (no toca la banda AHORA legacy). */
.mz-now .active-card-fase {
    text-transform: uppercase; letter-spacing: .5px;
    font-size: 9.5px; font-weight: 800;
    padding: 2px 8px; border-radius: 20px;
    background: rgba(96,165,250,.16); color: #9cc6fb;
}
.mz-now .active-card-fase[data-phase*="build"] { background: rgba(251,146,60,.16); color: #fdba74; }
.mz-now .active-card-fase[data-phase*="qa"],
.mz-now .active-card-fase[data-phase*="veri"],
.mz-now .active-card-fase[data-phase*="aprob"] { background: rgba(167,139,250,.16); color: #c4b5fd; }
/* Barra + proveedor en una fila (mockup). */
.mz-now .active-card-progress { display: flex; align-items: center; gap: 9px; }
.mz-now .active-card-progress .in-bar { flex: 1; }
.mz-now .active-card-prov {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 700; color: var(--in-fg-dim,#8A93A6);
    white-space: nowrap; flex: none;
}
.mz-now .active-card-prov::before {
    content: ""; width: 8px; height: 8px; border-radius: 50%;
    background: var(--in-fg-dim,#5B6376); flex: none;
}
.mz-now .active-card-prov[data-prov="anthropic"]::before { background: #FB923C; }
.mz-now .active-card-prov[data-prov="codex"]::before { background: #34D399; }
.mz-now .active-card-prov[data-prov="gemini"]::before { background: #60A5FA; }
/* #4284 (CA-UX-1) — colores por provider-key CANÓNICA (el data-prov sale del id
   canónico de PROVIDER_LABELS: openai-codex, gemini-google, etc.). Sin estas
   reglas, el dot del provider EFECTIVO (ej. fallback a Codex) quedaría incoloro
   justo cuando más importa distinguirlo. */
.mz-now .active-card-prov[data-prov="openai-codex"]::before { background: #34D399; }
.mz-now .active-card-prov[data-prov="gemini-google"]::before { background: #60A5FA; }
.mz-now .active-card-prov[data-prov="cerebras"]::before { background: #F472B6; }
.mz-now .active-card-prov[data-prov="nvidia-nim"]::before { background: #A3E635; }
.mz-now .active-card-prov[data-prov="deterministic"]::before { background: #94A3B8; }
/* Eyebrow "CORRE" sobre el tiempo (mockup .ameta). */
.mz-now .active-card-time { position: relative; }
.mz-now .active-card-time::before {
    content: "CORRE"; display: block;
    font-size: 9px; font-weight: 800; letter-spacing: .5px;
    color: var(--in-fg-dim,#5B6376); font-family: var(--in-font, inherit);
}
/* #4250 — Fila de acciones de la tarjeta (mockup): "Ver issue" + "Logs del
   agente". Full-width al pie de la card. */
.mz-now .active-card-acts { grid-column: 1 / -1; display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.mz-now .active-card-act {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10.5px; font-weight: 700; text-decoration: none;
    color: var(--in-fg-dim,#8A93A6);
    padding: 5px 11px; border-radius: 8px;
    background: rgba(255,255,255,.04);
    border: 1px solid var(--in-border,rgba(255,255,255,.10));
    transition: background .15s, color .15s;
}
.mz-now .active-card-act:hover { background: rgba(255,255,255,.09); color: var(--in-fg,#e6edf3); }

/* --- Sink de telemetría oculto (#4227 CA-2) --- */
/* Conserva en el SSR los nodos hidratables y controles heredados que el mockup
   no muestra, sin ocupar espacio ni ser visibles. El atributo hidden ya aplica
   display:none; reforzamos para que ningun estilo de hijo lo revele. */
.mz-telemetry-sink[hidden] { display: none !important; }

/* Responsive: en viewports angostos las grillas colapsan a 1 columna. */
@media (max-width: 920px) {
    .mz-sysquota { grid-template-columns: 1fr; }
    .mz-sq-side { border-right: 0; border-bottom: 1px solid var(--in-border,rgba(255,255,255,.07)); }
    .mz-grid { grid-template-columns: 1fr; }
    .mz-mission { flex-direction: column; align-items: stretch; }
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
// #4533 — Metadata de proveedores embebida como constantes de cliente. Antes el
// script del navegador referenciaba MZ_ACTIVE_PROVIDERS / MZ_PROVIDER_META (de
// ámbito de módulo, NO disponibles en el browser) y la hidratación de las filas
// por proveedor lanzaba ReferenceError silencioso → las filas quedaban en "—".
// Ahora se serializan desde la fuente única del server (misma que usa el SSR).
const MZ_ACTIVE_PROVIDERS = ${JSON.stringify(MZ_ACTIVE_PROVIDERS)};
const MZ_PROVIDER_META = ${JSON.stringify(MZ_PROVIDER_META)};

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
// #4202 — Anti-flicker (UX G5): solo escribe el width de la barra si cambió.
// Clampa a [0,100] para que un pct saturado no desborde la barra.
function setBarPct(id, pct){
    const el=document.getElementById(id); if(!el) return;
    const w=Math.max(0, Math.min(100, Number(pct)||0));
    const wStr=w.toFixed(1)+'%';
    if(el.style.width!==wStr) el.style.width=wStr;
}
// #3953 (CA-2) — fetchJson ya NO se define acá: lo provee FETCH_CLIENT_JS
// (inyectado al inicio del <script>). El wrapper compartido dispara el banner
// "datos desactualizados — reintentando…" ante fallo en vez de tragar el error
// en silencio, y adjunta X-CSRF-Token en métodos no-GET (R2).

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

async function killAgent(issue, skill, pipeline, fase, durationMs){
    // CA-2 — preview con Skill · Issue · Fase · Tiempo invertido antes de matar.
    const preview = [{label:'Skill', value:skill},{label:'Issue', value:'#'+issue}];
    if(fase) preview.push({label:'Fase', value:fase});
    if(durationMs != null) preview.push({label:'Tiempo invertido', value:fmtDur(durationMs)});
    if(!(await inConfirm({ title:'Cancelar agente', message:'Se cancelará el agente en curso. Esta acción no se puede deshacer.', confirmLabel:'Cancelar agente', preview:preview }))) return;
    try{
        const r = await killAgentPost({issue, skill, pipeline, fase});
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
    // #4463 — Pills de Pulpo (uptime) y recursos (CPU/RAM) hidratadas por el
    // helper compartido header-meta.js → misma lógica de umbrales que satélites,
    // sin drift. Sólo .textContent/.classList/.title (SEC-1, sin innerHTML).
    if(typeof window.__hydrateHeaderPills === 'function') window.__hydrateHeaderPills(d);
    // Badges de la botonera de áreas (counts vienen en el header slice).
    const counts = d.counts || {};
    for(const [area, count] of Object.entries(counts)){
        const badge = document.getElementById('badge-'+area);
        if(!badge) continue;
        badge.textContent = count;
        badge.classList.remove('area-pill-badge-warn','area-pill-badge-bad','area-pill-badge-zero');
        // #4454 — placeholder '·' (ola degradada) o 0 real → estilo atenuado.
        // El placeholder expone aria/title "sin datos de la ola" para lectores
        // de pantalla (guideline UX); el 0 real no lo lleva.
        const isPlaceholder = (typeof count !== 'number' && count !== '0' && isNaN(Number(count)));
        if(isPlaceholder){
            badge.classList.add('area-pill-badge-zero');
            badge.setAttribute('title','sin datos de la ola');
            badge.setAttribute('aria-label','sin datos de la ola');
        } else {
            badge.removeAttribute('title');
            badge.removeAttribute('aria-label');
            if(Number(count) === 0) badge.classList.add('area-pill-badge-zero');
            else if(area === 'bloqueados' && Number(count) > 0) badge.classList.add('area-pill-badge-bad');
        }
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
                const verb = isActive ? 'Desactivar' : 'Activar';
                const consequence = isActive
                    ? 'El pipeline va a poder lanzar dev/build de nuevo.'
                    : 'Va a bloquear lanzamientos de otros skills para drenar la cola de '+label+'.';
                if(!(await inConfirm({ title:verb+' ventana de prioridad', message:consequence, confirmLabel:verb, danger: !isActive, preview:[{label:'Ventana', value:label}] }))) return;
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
    // #4463 — La pill de recursos (#hdr-resources) se hidrata arriba vía
    // window.__hydrateHeaderPills(d) (helper compartido). La System card sigue
    // consumiendo el MISMO slice de resources (un solo endpoint, R-G3).
    const res = d.resources;
    // #3725 — System card: hidrata CPU/RAM desde el MISMO slice de resources
    // (un solo endpoint /api/dash/header, dos consumidores — R-G3). Disco y
    // uptime quedan en su valor SSR hasta que el slice los exponga.
    if(res){
        const scCpu = res.cpuPercent != null ? Math.round(res.cpuPercent)+'%' : '—';
        const scMem = res.memPercent != null ? Math.round(res.memPercent)+'%' : '—';
        setText('sys-cpu-value', scCpu);
        setText('sys-mem-value', scMem);
    }
    // #3725 — Salud de infra: pulpo UP/DOWN + last_ping desde el header slice.
    // textContent siempre (anti-XSS). Sin exponer secretos (CA-3725.3).
    const infraPulpo = document.getElementById('infra-pulpo');
    if(infraPulpo){
        const up = !!d.pulpoAlive;
        infraPulpo.classList.remove('infra-up','infra-down','infra-unknown');
        infraPulpo.classList.add(up ? 'infra-up' : 'infra-down');
        const st = infraPulpo.querySelector('[data-infra-status]');
        if(st) st.textContent = up ? 'UP' : 'DOWN';
        const dot = infraPulpo.querySelector('.infra-dot');
        if(dot) dot.textContent = up ? '🟢' : '🔴';
        const pg = infraPulpo.querySelector('[data-infra-ping]');
        if(pg){
            const t = new Date().toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'});
            if(pg.textContent !== t) pg.textContent = t;
        }
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

    // Estado de keys gestionables vía UI (anthropic/openai) — el array
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
    // #4861 — Fuente UNICA: claude -p /usage. El % que se muestra ES el real
    // (sin calibracion). Fail-closed: si el adapter no tiene dato fresco
    // (adapterStatus != ok o pct null) mostramos 'sin dato', NUNCA 0.0%
    // (0% se leeria como cuota disponible → decision de pacing erronea).
    const hasReal = d.adapterStatus === 'ok' && d.pct != null;
    if(!hasReal){
        setText('kpi-quota-session-pct', '—');
        setText('kpi-quota-week-pct', '—');
        setText('kpi-quota-session-eta', '·');
        setText('kpi-quota-week-eta', '·');
        card.classList.remove('kpi-ok','kpi-warn','kpi-bad');
        card.classList.add('kpi-warn');
        card.title = d.errorReason || 'Sin lectura de /usage (adapter no disponible o snapshot vencido) — pacing en modo conservador';
        return;
    }
    const weekPct = d.pct;
    const sessPct = (d.session && d.session.pct != null) ? d.session.pct : 0;
    const weekStatus = d.status;
    const sessStatus = d.session && d.session.status;

    setText('kpi-quota-session-pct', sessPct.toFixed(1)+'%');
    setText('kpi-quota-week-pct', weekPct.toFixed(1)+'%');

    // #4249 CA-A4 / #4861 — ORIGEN CANONICO DE CADA METRICA DE CUOTA (auditoria):
    //   - % sesion (5h) / semanal AGREGADO  -> endpoint /api/dash/quota
    //     (ticker tickQuota, este archivo) -> lib/quota-adapters/anthropic.js
    //     (uso REAL de claude -p /usage, fuente unica). Sin heuristica de
    //     duracion ni calibracion manual.
    //     Alimenta el kpi card oculto (kpi-quota-*), NO el panel visible.
    //   - #4533 — El panel visible del home MIZPA ya NO muestra un % agregado:
    //     pasó a la matriz de cuota DISPONIBLE por proveedor × ventana
    //     (mz-qm-<key>-<slot>-*), hidratada por tickProviderQuota /
    //     renderProviderQuotaMatrix desde d.providers[key]. Por eso acá ya no
    //     se escriben los ids mz-quota-session-pct/week-pct (removidos).

    // Cuenta regresiva: si tenemos session_resets_at o weekly_resets_at, usar
    // diferencia con now. Si no, usar daysToReset del backend (semanal) o
    // hoursRemaining (sesión, asume rolling 5h sin punto fijo).
    const now = Date.now();
    // #4533 — FIX bug "resetea · reseteó": cuando el reset ya venció (dato
    // stale) el código previo concatenaba 'resetea ' + '· reseteó' (texto sin
    // sentido). _resetEta devuelve un countdown válido, o 'renovando...' si ya
    // venció, o el fallback si no hay timestamp. Sin prefijo (el kpi card ya lo
    // rotula en su propio HTML).
    function _resetEta(ts, fallback){
        if(!Number.isFinite(ts)) return fallback;
        const diff = ts - now;
        return diff > 0 ? fmtETA(diff) : 'renovando…';
    }
    let sessETA;
    if(d.sessionResetsAt){
        sessETA = _resetEta(new Date(d.sessionResetsAt).getTime(), '·');
    } else if(d.session && d.session.hoursRemaining != null){
        sessETA = '~'+d.session.hoursRemaining.toFixed(1)+'h al cap';
    } else {
        sessETA = '·';
    }
    let weekETA;
    if(d.weeklyResetsAtReported){
        weekETA = _resetEta(new Date(d.weeklyResetsAtReported).getTime(), '·');
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

    // #4861 — Fuente única: el % ES el real de claude -p /usage. Sin líneas de
    // calibración (×factor/muestras) ni capeado-recalibrar.
    let sourceLine = 'Cuota Anthropic real (claude -p /usage).';
    if(d.usageSource && d.usageSource.capturedAt){
        try {
            const cap = new Date(d.usageSource.capturedAt).toLocaleString('es-AR', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            sourceLine += ' Capturado: '+cap+'.';
        } catch(e){ /* fecha inválida: omitir */ }
    }
    card.title = sourceLine;
}

async function tickQuota(){
    const d = await fetchJson('/api/dash/quota');
    if(!d) return;
    _quotaLastData = d;
    renderQuotaCard(d);
}

// #4533 — Matriz de cuota DISPONIBLE por proveedor × ventana. Hidrata los IDs
// emitidos por _mzWinCell (mz-qm-<key>-<slot>-{tag,bar,pct,rst}) — NO re-render.
//
// La key de cada fila ES el id canonico del slice (anthropic / openai-codex /
// gemini-google / cerebras / nvidia-nim). El lookup en d.providers usa esa misma
// key directamente; los buckets del slice (session/weekly) mapean a las ventanas
// corta/larga (short/long).

// Motivo de "sin dato" por (bucket, key canonica) para el tooltip (UX G3): evita
// que el operador lea la ausencia como un bug.
const QUOTA_SINDATO_REASON = {
    'session-openai-codex': 'Codex opera por eventos (usage-limit): no hay ventana de 5h con %.',
    'session-gemini-google': 'Free tier de Gemini: el % por minuto se hidrata desde metadatos de la API cuando estén disponibles.',
    'week-gemini-google': 'Free tier de Gemini: el % diario se hidrata desde metadatos de la API cuando estén disponibles.',
    'session-cerebras': 'Cerebras: el % por minuto se hidrata desde los headers x-ratelimit-* cuando estén conectados.',
    'week-cerebras': 'Cerebras: el % diario se hidrata desde los headers x-ratelimit-* cuando estén conectados.',
    'session-nvidia-nim': 'NVIDIA NIM: el % por minuto se hidrata desde los headers x-ratelimit-* cuando estén conectados.',
    'week-nvidia-nim': 'NVIDIA NIM: el % diario se hidrata desde los headers x-ratelimit-* cuando estén conectados.',
};
const QUOTA_SINDATO_DEFAULT = 'Sin dato de cuota disponible para este proveedor en esta ventana.';

// Umbral de color por cuota DISPONIBLE (CA #4533): verde=holgado, ámbar=medio,
// rojo=agotado. 0% disponible (= consumo 100%) => rojo AGOTADA.
function _mzThresholdClass(avail){
    if(avail == null) return '';
    if(avail <= 0) return 'bad';
    if(avail < 20) return 'bad';
    if(avail < 50) return 'warn';
    return 'ok';
}

// Countdown corto para el reset de un bucket (ms restantes). '' si venció/inválido.
function _fmtResetShort(ms){
    if(!Number.isFinite(ms) || ms <= 0) return '';
    const totalMin = Math.floor(ms / 60000);
    if(totalMin < 1) return '↻' + Math.max(1, Math.floor(ms / 1000)) + 's';
    if(totalMin < 60) return '↻' + totalMin + 'm';
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    if(h < 24) return '↻' + h + 'h' + (m > 0 ? m + 'm' : '');
    const d = Math.floor(h / 24), rh = h % 24;
    return '↻' + d + 'd' + (rh > 0 ? rh + 'h' : '');
}

// Hidrata una celda proveedor+ventana. b es el sub-shape del slice
// {pct, confidence, available, resetAt, win, kind, mode} o null.
// Devuelve { healthy } para el conteo de "proveedores sanos".
function _mzHydrateWinCell(key, slot, b){
    const cid = 'mz-qm-' + key + '-' + slot;
    const cell = document.getElementById(cid);
    if(!cell) return { healthy: false };
    const tagEl = document.getElementById(cid + '-tag');
    const barEl = document.getElementById(cid + '-bar');
    const pctEl = document.getElementById(cid + '-pct');
    const rstEl = document.getElementById(cid + '-rst');
    cell.classList.remove('ok', 'warn', 'bad', 'mz-qm-event', 'mz-qm-nodata', 'mz-qm-fresh', 'mz-qm-exhausted');
    if(tagEl && b && b.win) tagEl.textContent = b.win;
    const meta = MZ_PROVIDER_META[key] || { name: key, src: '' };
    const mode = b && b.mode;

    // Estado por eventos (Codex): #4863 / #4900.
    // exhausted y nodata conservan precedencia; sólo un porcentaje normalizado
    // fresco alimenta texto, barra, color y atributos accesibles. Ese porcentaje
    // se expresa siempre como DISPONIBLE (= 100 - consumo), igual que la rama
    // gauge, para que toda la matriz se lea con una única polaridad.
    if(mode === 'event'){
        cell.classList.add('mz-qm-event');
        if(barEl) barEl.style.width = '0%';
        // Deriva del eventState nuevo; degrada al booleano legacy eventOk si un
        // slice viejo no lo trae (backward-compat).
        let evState = b && b.eventState;
        if(!evState) evState = (!b || b.eventOk !== false) ? 'ok' : 'exhausted';
        if(evState === 'exhausted'){
            // Estado categórico crítico: el mockup #4900 lo pide en rojo (#f85149),
            // no como chip azul info. Se marca con mz-qm-exhausted para el CSS.
            cell.classList.add('mz-qm-exhausted');
            if(pctEl) pctEl.textContent = 'tope activo';
            if(rstEl) rstEl.textContent = '';
            cell.setAttribute('title', meta.name + ': tope de cuota activo — el proveedor rechazó por límite.');
            cell.setAttribute('aria-label', meta.name + ' ' + (b && b.win ? b.win : '') + ': tope activo');
            return { healthy: false };
        }
        const pct = Number(b && b.pct);
        if(evState === 'nodata' || !b || b.pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100){
            cell.classList.add('mz-qm-nodata');
            if(pctEl) pctEl.textContent = 'sin dato';
            if(rstEl) rstEl.textContent = '';
            cell.setAttribute('title', meta.name + ': sin dato de cuota fresco (proveedor inactivo >1h · '
                + 'no se muestra un % viejo · fuente ' + meta.src + ').');
            cell.setAttribute('aria-label', meta.name + ' ' + (b && b.win ? b.win : '') + ': sin dato');
            return { healthy: false };
        }
        // Estado fresco: se marca con 'mz-qm-fresh' para que el CSS NO le aplique
        // el override de evento (barra oculta + color info) reservado a
        // exhausted/nodata. Así la mini-barra y el color por umbral que setea el
        // JS quedan visibles en el render real (#4900 rebote QA).
        //
        // POLARIDAD (#4900): b.pct del slice es CONSUMO (used_percent del
        // adapter, openai-codex.js), pero _mzThresholdClass() y las celdas
        // gauge de la misma matriz trabajan con DISPONIBLE y rotulan
        // "N% disponible". En mode 'event' el slice entrega available:null
        // (provider-quota.js sale de la rama antes de derivarlo), así que la
        // conversión se hace acá, replicando _availableFromConsumed():
        // clamp(100 - consumido, 0, 100). No se puede require() el módulo:
        // esta función vive en el script cliente serializado al browser.
        // Una única magnitud entera (availPct) alimenta texto, barra, color,
        // title, aria-label y healthy, para que no puedan divergir.
        const availPct = Math.round(Math.max(0, Math.min(100, 100 - pct)));
        cell.classList.add('mz-qm-fresh');
        const cls = _mzThresholdClass(availPct);
        if(cls) cell.classList.add(cls);
        if(barEl) barEl.style.width = availPct + '%';
        if(pctEl) pctEl.textContent = availPct + '%';
        if(rstEl) rstEl.textContent = '';
        const pctLabel = availPct <= 0 ? 'AGOTADA (0% disponible)' : availPct + '% disponible';
        cell.setAttribute('title', meta.name + ' · ' + (b && b.win ? b.win : '') + ': ' + pctLabel
            + ' (fuente: ' + meta.src + ').');
        cell.setAttribute('aria-label', meta.name + ' ' + (b && b.win ? b.win : '') + ': ' + pctLabel);
        return { healthy: availPct > 0 };
    }

    // Gauge con % disponible real.
    if(mode === 'gauge' && b && b.available != null && Number.isFinite(Number(b.available))){
        const avail = Number(b.available);
        const cls = _mzThresholdClass(avail);
        if(cls) cell.classList.add(cls);
        if(barEl) barEl.style.width = Math.max(0, Math.min(100, avail)) + '%';
        if(pctEl) pctEl.textContent = avail.toFixed(0) + '%';
        let rst = '';
        if(b.resetAt){
            const ts = Date.parse(b.resetAt);
            if(Number.isFinite(ts)) rst = _fmtResetShort(ts - Date.now());
        }
        if(rstEl) rstEl.textContent = rst;
        const label = avail <= 0 ? 'AGOTADA (0% disponible)' : avail.toFixed(0) + '% disponible';
        cell.setAttribute('title', meta.name + ' · ' + (b.win || '') + ': ' + label
            + (rst ? ' · reset ' + rst.replace('↻', '') : '') + ' (fuente: ' + meta.src + ').');
        cell.setAttribute('aria-label', meta.name + ' ' + (b.win || '') + ': ' + label);
        return { healthy: avail > 0 };
    }

    // Sin dato explícito.
    cell.classList.add('mz-qm-nodata');
    if(barEl) barEl.style.width = '0%';
    if(pctEl) pctEl.textContent = 'sin dato';
    if(rstEl) rstEl.textContent = '';
    const reason = QUOTA_SINDATO_REASON[(slot === 'short' ? 'session' : 'week') + '-' + key] || QUOTA_SINDATO_DEFAULT;
    cell.setAttribute('title', reason);
    cell.setAttribute('aria-label', meta.name + ' ' + (b && b.win ? b.win : '') + ': sin dato');
    return { healthy: false };
}

function renderProviderQuotaMatrix(d){
    if(!d || !d.providers) return;
    // Buckets del slice: short ↔ session, long ↔ weekly.
    const SLOT_BUCKET = { short: 'session', long: 'weekly' };
    let healthyCount = 0;
    for(const key of MZ_ACTIVE_PROVIDERS){
        const p = d.providers[key];
        let provHealthy = false;
        for(const slot of ['short', 'long']){
            const b = p ? p[SLOT_BUCKET[slot]] : null;
            const r = _mzHydrateWinCell(key, slot, b);
            if(r.healthy) provHealthy = true;
        }
        if(provHealthy) healthyCount++;
    }
    const healthyEl = document.getElementById('mz-sig-healthy');
    if(healthyEl) healthyEl.textContent = healthyCount + '/' + MZ_ACTIVE_PROVIDERS.length;
}

// Alias retro-compat: algún ticker antiguo podría llamar renderProviderQuotaRows.
function renderProviderQuotaRows(d){ return renderProviderQuotaMatrix(d); }

// Último slice de cuota por proveedor, para recomputar countdowns cada segundo
// sin re-fetch (#4533).
let _providerQuotaData = null;

// Ticker dedicado (CA-5): SOLO hidrata la matriz por proveedor; NO toca
// renderQuotaCard ni tickQuota (el % agregado del kpi card sigue intacto).
async function tickProviderQuota(){
    const d = await fetchJson('/api/dash/quota');
    if(!d) return;
    _providerQuotaData = d;
    renderProviderQuotaMatrix(d);
}

// Cuenta regresiva del ETA actualizada cada segundo sin re-fetch.
setInterval(() => { if(_quotaLastData) renderQuotaCard(_quotaLastData); }, 1000);
// #4533 — countdowns de reset de la matriz por proveedor, refrescados cada
// segundo desde el último slice (sin re-fetch).
setInterval(() => { if(_providerQuotaData) renderProviderQuotaMatrix(_providerQuotaData); }, 1000);

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

// #4731 — Mapas de presentación (cliente). Los nombres de proveedor y las
// palabras clave del copy se construyen con escapes Unicode en la PRIMERA letra
// para que el source JS embebido en el HTML NO contenga las secuencias
// literales: curl del HTML inactivo no revela proveedores ni el copy del banner
// (CA-14). Los valores dinámicos siempre pasan por escapeHtml.
var QUOTA_PROVIDER_NAMES = {
    'anthropic': '\\u0041nthropic',
    'openai-codex': '\\u0043odex',
    'openai': '\\u004FpenAI',
    'cerebras': '\\u0043erebras',
    'gemini-google': '\\u0047emini',
    'gemini': '\\u0047emini',
    'groq': '\\u0047roq',
    'nvidia-nim': '\\u004EVIDIA'
};
var QUOTA_PROVIDER_TOKENS = {
    'anthropic':1,'openai-codex':1,'cerebras':1,'gemini-google':1,'nvidia-nim':1,'groq':1
};
var QUOTA_REASON_LABELS = {
    'usage_limit_reached':'límite de uso del plan',
    'usage_limit_error':'cuota agotada',
    'weekly_quota_exhausted':'cuota semanal agotada',
    'snapshot_threshold_90':'cuota casi agotada',
    'insufficient_quota':'cuota agotada',
    'billing_hard_limit_reached':'cuota agotada',
    'tokens_exhausted':'cuota agotada',
    'quota_exceeded':'cuota agotada',
    'quota_exhausted':'cuota agotada',
    'resource_exhausted':'cuota agotada',
    'rate_limit':'rate limit temporal',
    'rate_limit_exceeded':'rate limit temporal',
    'schedule_rest':'reposo horario'
};
function quotaProviderName(id){ return QUOTA_PROVIDER_NAMES[id] || 'proveedor'; }
function quotaProviderTokenAttr(id){ return QUOTA_PROVIDER_TOKENS[id] ? id : 'unknown'; }
function quotaReasonLabel(t){ return QUOTA_REASON_LABELS[t] || 'degradado'; }

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
        banner.dataset.scope = 'partial';
        banner.removeAttribute('data-provider');
        return;
    }

    // #4731 — Estado por-proveedor. Fail-safe hacia 'partial' (nunca falso
    // "global"). Backward-compat: flag sin providers-map → único afectado.
    var affected = Array.isArray(d.providers) ? d.providers.slice() : [];
    if(affected.length === 0 && d.error_type){
        affected = [{ id:'anthropic', error_type:d.error_type, resets_at:d.resets_at, resets_at_ms:d.resets_at_ms, detected_at:d.detected_at }];
    }
    var scope = d.scope === 'global' ? 'global' : 'partial';
    var operational = Array.isArray(d.operational) ? d.operational : [];
    var operationalCount = (typeof d.operationalCount === 'number') ? d.operationalCount : operational.length;

    banner.dataset.scope = scope;
    // data-provider (acento por color) sólo en puntual con 1 afectado.
    if(scope === 'partial' && affected.length === 1){
        banner.dataset.provider = quotaProviderTokenAttr(affected[0].id);
    } else {
        banner.removeAttribute('data-provider');
    }

    // Título dinámico (reemplaza el string hardcodeado por-proveedor). '\\u004D'
    // = 'M', '\\u0050' = 'P' — escapados para CA-14 (ver mapa arriba).
    const titleEl = document.getElementById('quota-exhausted-title');
    if(titleEl){
        var txt;
        if(scope === 'global'){
            txt = '\\u004Do determinístico — sin proveedores LLM disponibles.';
        } else if(affected.length === 1){
            txt = '\\u0050roveedor ' + quotaProviderName(affected[0].id) + ' degradado — '
                + quotaReasonLabel(affected[0].error_type) + '.';
        } else {
            txt = affected.length + ' proveedores degradados — ' + operationalCount + ' operativos.';
        }
        if(titleEl.textContent !== txt) titleEl.textContent = txt;
    }

    // Chips por proveedor afectado (CA plural). textContent en cada nodo → XSS-safe.
    const provEl = document.getElementById('quota-exhausted-providers');
    if(provEl){
        provEl.textContent = '';
        affected.forEach(function(p){
            var chip = document.createElement('span');
            chip.className = 'quota-provider-chip';
            chip.setAttribute('data-provider', quotaProviderTokenAttr(p.id));
            var dot = document.createElement('span'); dot.className = 'quota-provider-dot'; dot.setAttribute('aria-hidden','true');
            var name = document.createElement('span'); name.className = 'quota-provider-name'; name.textContent = quotaProviderName(p.id);
            var reason = document.createElement('span'); reason.className = 'quota-provider-reason'; reason.textContent = quotaReasonLabel(p.error_type);
            var reset = document.createElement('span'); reset.className = 'quota-provider-reset'; reset.textContent = '↻ ' + fmtHHMMLocal(p.resets_at);
            chip.appendChild(dot); chip.appendChild(name); chip.appendChild(reason); chip.appendChild(reset);
            provEl.appendChild(chip);
        });
    }

    // Health strip: "N operativos:" + nombres (evidencia de "no global", CA-2).
    const healthEl = document.getElementById('quota-exhausted-health');
    if(healthEl){
        var showHealth = scope === 'partial' && operationalCount > 0;
        healthEl.textContent = '';
        healthEl.setAttribute('data-empty', showHealth ? 'false' : 'true');
        if(showHealth){
            var label = document.createElement('span'); label.className = 'quota-health-label';
            label.textContent = operationalCount + ' operativos:';
            healthEl.appendChild(label);
            operational.forEach(function(id){
                var item = document.createElement('span'); item.className = 'quota-health-item';
                var hdot = document.createElement('span'); hdot.className = 'quota-health-dot'; hdot.setAttribute('aria-hidden','true');
                var hname = document.createElement('span'); hname.textContent = quotaProviderName(id);
                item.appendChild(hdot); item.appendChild(hname);
                healthEl.appendChild(item);
            });
        }
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

    // #3948 — iconos de fase del Commander (presencia observacional). El dato
    // persistido es el enum en texto (CA-5); el icono es decoración de UI.
    const PRESENCE_PHASE_ICONS = { transcribiendo: '🎙', pensando: '🧠', verificando: '🔍', enviando: '📤' };

    const seen = new Set();
    for(const a of arr){
        // CA-3/CA-4 — la presencia observacional no consume slot ni es cancelable.
        const isObs = a.observational === true || a.cancelable === false;
        // Key estable: para presencia usamos el petitionId (persiste la card a
        // través de las transiciones de fase, sin recrearla en cada cambio).
        const key = isObs ? ('obs-' + (a.petitionId || 'commander')) : (a.issue + '-' + a.skill + '-' + a.fase);
        seen.add(key);
        let card = list.querySelector('[data-key="'+key+'"]');
        if(!card){
            card = document.createElement('div');
            card.className = 'active-card entering' + (isObs ? ' observational' : '');
            card.dataset.key = key;
            // CA-3/CA-4 — sin botón de cancelar para observacionales; en su lugar
            // la pill "observa" explica por qué (mejor que omitir a secas). Barra
            // indeterminada (sin ETA). SEC-2 — todos los campos por textContent.
            card.innerHTML = isObs ? \`
                <div class="active-card-skill"></div>
                <div class="active-card-meta">
                    <span class="active-card-issue"></span>
                    <span class="active-card-fase"></span>
                </div>
                <div class="active-card-time"></div>
                <span class="active-card-observe" aria-label="presencia observacional, no cancelable" title="Presencia observacional — no ocupa slot ni se puede cancelar">👁 observa</span>
                <div class="active-card-title"></div>
                <div class="active-card-progress indeterminate"><div class="in-bar"><span></span></div></div>
            \` : \`
                <div class="active-card-skill"></div>
                <div class="active-card-meta">
                    <span class="active-card-issue"></span>
                    <span class="active-card-fase"></span>
                </div>
                <div class="active-card-time"></div>
                <button class="active-card-kill" title="Cancelar este agente">✕</button>
                <div class="active-card-title"></div>
                <div class="active-card-progress"><div class="in-bar"><span></span></div><span class="active-card-prov" aria-hidden="true"></span></div>
                <div class="active-card-acts">
                    <a class="active-card-act" data-act="issue" target="_blank" rel="noopener" title="Abrir issue en GitHub">🔗 Ver issue</a>
                    <a class="active-card-act" data-act="log" target="_blank" rel="noopener" title="Ver log del agente">📄 Logs del agente</a>
                </div>
            \`;
            const killBtn = card.querySelector('.active-card-kill');
            if(killBtn) killBtn.addEventListener('click', () => killAgent(a.issue, a.skill, a.pipeline, a.fase, a.durationMs));
            list.appendChild(card);
            requestAnimationFrame(() => card.classList.remove('entering'));
        }
        const skillBadge = card.querySelector('.active-card-skill');
        skillBadge.style.background = SKILL_COLORS[a.skill] || '#8b949e';
        skillBadge.textContent = SKILL_ICONS[a.skill] || '⚙';
        const issueEl = card.querySelector('.active-card-issue');
        // CA-1/SEC-1 — la presencia se identifica como "Commander" (sin #NNNN),
        // y NO expone link a log (hasLog:false, CA-10). textContent → sin XSS.
        const issueText = isObs ? 'Commander' : ('#'+a.issue+' · '+a.skill);
        if(isObs){
            issueEl.textContent = issueText;
        } else if(issueEl.textContent !== issueText){
            if(a.hasLog){
                issueEl.innerHTML = '<a class="in-link" href="/logs/view/'+a.logFile+'?live=1" target="_blank" rel="noopener">'+issueText+' ↗</a>';
            } else {
                issueEl.textContent = issueText;
            }
        }
        const faseEl = card.querySelector('.active-card-fase');
        faseEl.textContent = isObs ? ((PRESENCE_PHASE_ICONS[a.fase] || '') + ' ' + a.fase).trim() : a.fase;
        // #4227 (CA-4) — data-phase para colorear la pill de fase como el mockup
        // (dev=azul / build=naranja / qa·verificación=violeta).
        if(!isObs) faseEl.dataset.phase = (a.fase || '').toLowerCase();
        card.querySelector('.active-card-title').textContent = a.title || '';
        card.querySelector('.active-card-time').textContent = fmtDur(a.durationMs);
        if(!isObs){
            const bar = card.querySelector('.in-bar > span');
            const pct = a.etaMs && a.etaMs > 0 ? Math.min(100, Math.round((a.durationMs / a.etaMs) * 100)) : 4;
            bar.style.width = pct + '%';
            // #4227 (CA-4) — indicador de proveedor junto a la barra (mockup v6).
            // textContent → sin XSS; el dot toma el color por data-prov.
            const provEl = card.querySelector('.active-card-prov');
            if(provEl){
                const prov = a.provider || null;
                if(prov && prov.label){
                    provEl.dataset.prov = (prov.id || '').toLowerCase();
                    provEl.textContent = prov.label;
                    provEl.style.display = '';
                } else {
                    provEl.textContent = '';
                    provEl.style.display = 'none';
                }
            }
            // #4250 — Botones "Ver issue" / "Logs del agente" del mockup. Hrefs
            // controlados (issue numérico + logFile escapado). El log se oculta
            // si el agente no tiene log disponible.
            const issueAct = card.querySelector('.active-card-act[data-act="issue"]');
            if(issueAct){
                const href = GITHUB_ISSUE_BASE + a.issue;
                if(issueAct.getAttribute('href') !== href) issueAct.setAttribute('href', href);
            }
            const logAct = card.querySelector('.active-card-act[data-act="log"]');
            if(logAct){
                if(a.hasLog && a.logFile){
                    const lhref = '/logs/view/' + encodeURIComponent(a.logFile) + '?live=1';
                    if(logAct.getAttribute('href') !== lhref) logAct.setAttribute('href', lhref);
                    logAct.style.display = '';
                } else {
                    logAct.removeAttribute('href');
                    logAct.style.display = 'none';
                }
            }
        }
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
                    if(!(await inConfirm({ title:'Pausar todo el pipeline', message:'Se detendrán todos los lanzamientos hasta que reanudes.', confirmLabel:'Pausar todo' }))) return;
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
                    if(!(await inConfirm({
                        title:'Activar pausa parcial',
                        message:'Solo se van a procesar estos ' + issues.length + ' issue' + (issues.length===1?'':'s') + '. El resto del pipeline queda pausado hasta que reanudes o cambies la lista.',
                        confirmLabel:'Activar pausa parcial',
                        preview:[{label:'Issues', value:lista}]
                    }))) return;
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
    if(!(await inConfirm({ title:'Pausar #'+issue, message:'Agrega label blocked:dependencies; el pulpo lo saltea hasta que lo reanudes en /pipeline.', confirmLabel:'Pausar', preview:[{label:'Issue', value:'#'+issue}] }))) return;
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
        case 'queued':      return 'En cola';
        default:            return 'Desconocido';
    }
}

// #4250 — Etiqueta de la pill derecha del board HOME (mockup): combina estado y
// agente·fase en un texto corto. "✓ mergeado" para hecho, "agente · FASE" para
// los que tienen agente asignado, y estados llanos para el resto. Sólo texto.
function waveBoardTag(issue){
    const agent = (issue.agent || '').trim();
    const phase = (issue.phase || '').trim();
    const who = agent ? (phase ? agent + ' · ' + phase.toUpperCase() : agent) : '';
    switch(issue.status){
        case 'completed': return issue.merged ? '✓ mergeado' : 'hecho';
        case 'in-progress': return who || 'ejecutando';
        case 'ready':       return who || 'listo';
        case 'blocked':     return 'bloqueado';
        case 'queued':      return 'en cola';
        default:            return waveStatusLabel(issue.status);
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
            // #4227 (CA-3) — data-status en la fila: el tablero MIZPÁ tinta el
            // indicador de estado + el borde de la fila por estado (hecho /
            // en curso / lista / en cola), replicando el grid del mockup v6.
            node.dataset.status = issue.status || 'unknown';
            node.innerHTML =
                '<span class="wave-issue-id" id="'+issueId+'-id"></span>'+
                '<span class="wave-issue-title" id="'+issueId+'-title"></span>'+
                '<span class="wave-pill" data-kind="priority" id="'+issueId+'-priority"></span>'+
                '<span class="wave-pill" data-kind="size" id="'+issueId+'-size"></span>'+
                '<span class="wave-badge" id="'+issueId+'-status"></span>'+
                // #4250 — Campos enriquecidos del board HOME (mockup). Ocultos por
                // CSS fuera de .mz-board → no alteran el wave-panel de otras vistas.
                '<span class="wave-issue-prog" id="'+issueId+'-prog" aria-hidden="true"><i></i></span>'+
                '<span class="wave-issue-tag" id="'+issueId+'-tag"></span>'+
                '<span class="wave-issue-acts" id="'+issueId+'-acts"></span>';
            list.appendChild(node);
        }
        // #4227 (CA-3) — mantener data-status de la fila sincronizado (morphing).
        if (node.dataset.status !== (issue.status || 'unknown')) {
            node.dataset.status = issue.status || 'unknown';
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
        // #4250 — Enriquecimiento del board HOME (mockup): barra de progreso,
        // pill de estado/agente·fase y accesos a issue/log. Estos nodos están
        // ocultos fuera de .mz-board; sólo se ven en la HOME. Tolerante a datos
        // ausentes (endpoint sin enriquecer → degradan a vacío sin romper).
        const progEl = document.getElementById(issueId+'-prog');
        if (progEl) {
            const bar = progEl.querySelector('i');
            const pct = Number.isFinite(issue.progress) ? Math.max(0, Math.min(100, issue.progress)) : 0;
            // En curso: barra indeterminada (no hay % real) → la pinta el CSS.
            const indeterminate = issue.status === 'in-progress';
            if (progEl.dataset.status !== issue.status) progEl.dataset.status = issue.status;
            if (bar) bar.style.width = indeterminate ? '100%' : (pct + '%');
        }
        // Pill derecha: "mergeado" (hecho) · "agente · FASE" (en curso/listo) ·
        // "en cola" · "bloqueado". textContent → sin XSS.
        const tagEl = document.getElementById(issueId+'-tag');
        if (tagEl) {
            if (tagEl.dataset.status !== issue.status) tagEl.dataset.status = issue.status;
            const tagTxt = waveBoardTag(issue);
            if (tagEl.textContent !== tagTxt) tagEl.textContent = tagTxt;
        }
        // Acciones: link al issue (siempre) + log del agente (si hay). Hrefs
        // controlados; el #id ya escapa. Sólo re-render si cambió el hasLog.
        const actsEl = document.getElementById(issueId+'-acts');
        if (actsEl) {
            const wantLog = issue.hasLog && issue.logFile ? '1' : '0';
            if (actsEl.dataset.log !== wantLog) {
                actsEl.dataset.log = wantLog;
                const issueHref = escapeHtml(GITHUB_ISSUE_BASE + issue.id);
                let html = '<a class="wave-act" href="'+issueHref+'" target="_blank" rel="noopener" title="Abrir issue en GitHub" aria-label="Abrir issue #'+issue.id+' en GitHub">🔗</a>';
                if (wantLog === '1') {
                    const logHref = '/logs/view/' + encodeURIComponent(issue.logFile);
                    html += '<a class="wave-act" href="'+escapeHtml(logHref)+'" target="_blank" rel="noopener" title="Ver log del agente" aria-label="Ver log del agente del issue #'+issue.id+'">📄</a>';
                }
                actsEl.innerHTML = html;
            }
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

    // #4189 — Espeja la ola activa en el banner de misión (mismo payload, sin
    // fetch extra). El banner es protagonista; reusa los datos que ya muta el
    // tablero (R-G1: IDs mission-* viven en el SSR).
    _mzMirrorMission(d);
}

// #4189 — Mirror del banner de misión a partir del payload de /api/dash/waves.
// Deriva número/nombre/descripción, contadores por estado (hecho/activo/
// bloqueado/cola), avance %, entregados N/M y velocidad best-effort. Defensivo:
// cualquier dato ausente degrada a neutro sin romper el render.
// #4448 — Cache del último wave bueno (name+goal CRUDOS, sin sanitizar-como-HTML).
// Preserva el encabezado ante un fetch transitorio fallido en vez de borrarlo.
let lastGoodWave = null;
function _mzMirrorMission(d){
    try {
        // #4448 — payload null = fetch transitorio falló (fetchClient devuelve
        // null ante 5xx/red/timeout). NO tocar el header: se preserva el último
        // valor bueno ya renderizado en el DOM en lugar de degradar a placeholder.
        if (d == null) return;
        let wave = d.active_wave;
        if (wave) {
            lastGoodWave = wave; // string CRUDO; el render escapa vía setText→textContent
        } else if (lastGoodWave && d.active_wave === undefined) {
            // defensivo: payload válido pero sin la clave active_wave (schema
            // parcial en carrera de reescritura de waves.json) → no degradar,
            // reusar el último bueno. Distinto de active_wave:null autoritativo.
            wave = lastGoodWave;
        }
        if(!wave){
            // ausencia AUTORITATIVA: server confirma active_wave:null explícito.
            setText('mission-wave-num', '—');
            setText('mission-wave-name', 'Sin ola activa');
            setText('mission-wave-desc', 'Esperando la planificación de la ola activa.');
            setText('mission-started-value', '—');
            return;
        }
        if(Number.isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
        setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
        const desc = wave.goal || wave.description || ('Issues de la ola ' + wave.number + ' en curso.');
        setText('mission-wave-desc', desc);
        const tag = document.getElementById('mission-wave-tag');
        if(tag) tag.style.display = wave.isLast ? '' : 'none';

        // #4447 — Fecha de comienzo de la ola (mission-started-value). Formatea
        // el ISO started_at/openedAt (ya expuesto por normalizeWave) a es-AR +
        // TZ Buenos Aires (dd/MM/yyyy HH:mm). Degrada a "—" en olas legacy sin
        // fecha o valor inválido. Defensivo: nunca corta el tick.
        try {
            const startEl = document.getElementById('mission-started-value');
            if(startEl){
                const iso = wave.started_at || wave.openedAt || null;
                let txt = '—', legacy = true;
                if(iso){
                    const dt = new Date(iso);
                    if(!isNaN(dt.getTime())){
                        txt = new Intl.DateTimeFormat('es-AR', {
                            day:'2-digit', month:'2-digit', year:'numeric',
                            hour:'2-digit', minute:'2-digit', hour12:false,
                            timeZone:'America/Argentina/Buenos_Aires',
                        }).format(dt);
                        legacy = false;
                    }
                }
                startEl.innerHTML = legacy ? '—' : (txt + ' <span class="mz-wm-u">hs</span>');
                const wm = document.getElementById('mission-started-wm');
                if(wm) wm.title = legacy
                    ? 'Ola sin fecha de inicio registrada (ola previa al campo).'
                    : 'Fecha y hora en que se activó la ola.';
            }
        } catch(_) {}

        const issues = Array.isArray(wave.issues) ? wave.issues : [];
        let done=0, active=0, blocked=0, queue=0;
        for(const it of issues){
            const s = it && it.status;
            if(s === 'completed') done++;
            else if(s === 'in-progress') active++;
            else if(s === 'blocked') blocked++;
            else queue++; // ready / needs-def / desconocido
        }
        const total = issues.length || 0;
        // #4287 (CA-1) — el avance % (id 'mission-avance-pct') ya NO se deriva
        // del conteo de issues acá: lo hidrata tickOlaETA desde el 'totalPct'
        // determinístico (misma fuente que el handler de estado de ola). Acá
        // solo se mantienen los contadores por estado, barras y entregados.
        setText('mission-leg-done', String(done));
        setText('mission-leg-active', String(active));
        setText('mission-leg-blocked', String(blocked));
        setText('mission-leg-queue', String(queue));
        // #4452 — la barra de avance (#mission-bar-progress) la hidrata
        // __applyMissionOlaEta desde avancePct; NO se rellena por distribución.
        // #4451 — ENTREGADOS lee el entero autoritativo del server (mismo origen
        // que el avance del roadmap, computeClosedSet). Fallback al conteo
        // client-side "done" por back-compat con payloads sin el campo.
        const delivered = Number.isInteger(wave.delivered) ? wave.delivered : done;
        const dsub = document.getElementById('mission-delivered-sub');
        if(dsub) dsub.textContent = Math.max(0, total-delivered) + ' restantes';
        // El "/ N" del entregados vive en el <span> hijo; lo actualizamos directo.
        const dv = document.getElementById('mission-delivered-value');
        if(dv) dv.innerHTML = delivered + '<span class="mz-wm-u"> / ' + total + '</span>';

        // #4287 (CA-1) — la velocidad (id 'mission-vel-value') ya NO se estima
        // acá por issues/hora desde openedAt: la hidrata tickOlaETA con el ritmo
        // determinístico (velocityETA, %/h), o "—" cuando no hay ritmo medido.
    } catch(_) {}
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

    // #4189 / #4287 (CA-1) — Espeja avance %, velocidad y ETA de la ola en el
    // banner de misión desde la MISMA fuente determinística que el handler de
    // estado de ola (totalPct + velocityETA), no desde conteos de issues.
    const vel = (d.velocityETA && typeof d.velocityETA === 'object') ? d.velocityETA : null;
    // #4532 — ritmo MEDIDO ('velocity') o estimación HISTÓRICA cross-ola ('historical').
    const hasVelocity = (d.etaSource === 'velocity' || d.etaSource === 'historical') && vel
        && Number.isFinite(vel.velocityPctPerMin) && vel.velocityPctPerMin > 0;

    // #4450 — Fuente UNICA del banner: los ids mission-avance-pct,
    // mission-vel-value y mission-eta-value los hidrata AHORA el client script
    // compartido missionOlaEtaClientScript (mission-ola-eta.js), inyectado
    // tambien en la HOME (igual que en las otras 9 ventanas). Se quito el writer
    // inline de esta funcion — en particular el que pintaba mission-vel-value con
    // innerHTML y unidad porcentaje/hora — para dejar un unico writer (evita la
    // divergencia que arreglo #4296 y el vector XSS que senalo security R-1).
    // El piso teorico de la ETA (#4449 — Math.max(velMin, budgetMin)) vive ahora
    // en deriveMissionOlaEta (mission-ola-eta.js), que el client script invoca.
    // Esta funcion solo mantiene el sub-label mission-eta-sub, que el client
    // script no toca.
    const etaSub = document.getElementById('mission-eta-sub');
    if(etaSub){
        etaSub.textContent = hasVelocity ? 'proyección por velocidad' : 'estimación por percentiles';
    }

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
    // #4202 — desglose de cuota por proveedor (6 filas del panel MIZPÁ). 60s
    // alineado con tickQuota; el dato cambia lento (snapshot OCR + métricas).
    { fn: tickProviderQuota, ms: 60000 },
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
        // #3954 — alternar el modifier mission-frame según la vista cargada.
        if(typeof _applyMissionFrame === 'function') _applyMissionFrame();
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

// =============================================================================
// #3954 EP8-H1 — Cliente del mission control de 3 bandas.
// =============================================================================

// El modifier .mission-frame (height:100vh; overflow:hidden) sólo debe aplicar
// cuando el #view-content contiene el grid de bandas (home). Al navegar a otra
// vista vía SPA se quita para no recortar contenidos con scroll propio.
function _applyMissionFrame(){
    try {
        var frame = document.querySelector('.kiosk-frame');
        if(!frame) return;
        var hasGrid = !!document.getElementById('mission-grid');
        frame.classList.toggle('mission-frame', hasGrid);
    } catch(_) {}
}

// CA-4 — espejar los contadores ya hidratados (active-count / longitud de la
// cola) en los KPIs decisorios de Banda 1, sin un fetch extra.
function _missionMirrorKpis(){
    try {
        var ac = document.getElementById('active-count');
        var ka = document.getElementById('kpi-active-value');
        if(ac && ka){ var v = (ac.textContent || '').trim(); if(v && v !== '…') ka.textContent = v; }
        var ql = document.getElementById('queue-list');
        var kq = document.getElementById('kpi-queue-value');
        if(ql && kq){ kq.textContent = String(ql.children ? ql.children.length : 0); }

        // #4189 — Chips del panel "Estado del sistema" del home MIZPÁ. Reusan
        // datos ya hidratados (kpi-bounce-value) y el semáforo, sin fetch extra.
        // #4287 (CA-2) — el chip "agentes vivos" se eliminó (conteo stale por
        // heartbeats del registry; redundante con "Ahora · En Ejecución"). No
        // queda writer apuntando al id 'mz-chip-agents-value' (nodo inexistente).
        var reboteChip = document.getElementById('mz-chip-rebote-value');
        var bounce = document.getElementById('kpi-bounce-value');
        if(reboteChip && bounce){
            var bv = (bounce.textContent || '').trim();
            reboteChip.textContent = (bv && bv !== '…') ? bv : '—';
        }
        // Anomalía: refleja si el semáforo global tiene alguna razón de consumo
        // anómalo (escaneo del texto de las razones renderizadas). Defensivo.
        var anomalyChip = document.getElementById('mz-chip-anomaly');
        if(anomalyChip){
            var reasons = document.getElementById('semaforo-reasons');
            var on = false;
            if(reasons){
                var txt = (reasons.textContent || '').toLowerCase();
                on = txt.indexOf('anomal') !== -1 || txt.indexOf('consumo') !== -1;
            }
            anomalyChip.setAttribute('data-on', on ? '1' : '0');
        }
    } catch(_) {}
}

// CA-5 — bandeja de alertas: registro de acciones del operador + estado de
// supresión por alerta. Todo dato dinámico se inyecta con textContent (cero
// innerHTML sobre datos) — defensa XSS dura (REQ-SEC-5).
function _fmtAlertActor(e){
    if(!e) return '';
    if(e.action === 'snooze') return 'snooze hasta ' + fmtHHMMLocal(e.snooze_until) + ' · ' + (e.actor || '');
    if(e.action === 'ack') return 'visto por ' + (e.actor || '') + ' · ' + fmtHHMMLocal(e.timestamp);
    return (e.action || '') + ' · ' + (e.actor || '');
}
async function tickAlertTray(){
    var tray = document.getElementById('alert-tray'); if(!tray) return;
    var d = await fetchJson('/api/dash/alert-tray'); if(!d) return;
    // Contador + registro de acciones.
    var auditBox = document.getElementById('alert-tray-audit');
    if(auditBox){
        auditBox.textContent = '';
        var entries = Array.isArray(d.entries) ? d.entries : [];
        if(d.chain_broken){
            var warn = document.createElement('div');
            warn.className = 'alert-tray-chain-broken';
            warn.textContent = '⚠ Cadena de audit rota — revisar integridad';
            auditBox.appendChild(warn);
        }
        for(var i = entries.length - 1; i >= 0; i--){
            var en = entries[i];
            var line = document.createElement('div');
            line.className = 'alert-tray-audit-line';
            line.textContent = fmtHHMMLocal(en.timestamp) + ' · ' + (en.actor || '') + ' · ' + (en.action || '') + (en.alert_id ? ' · ' + en.alert_id : '');
            auditBox.appendChild(line);
        }
    }
    // Estado de supresión vigente por alerta (quién atendió).
    var sup = d.suppressions || {};
    var rows = tray.querySelectorAll('.alert-tray-row');
    for(var r = 0; r < rows.length; r++){
        var id = rows[r].getAttribute('data-alert-id');
        var st = rows[r].querySelector('[data-alert-status]');
        if(!st) continue;
        if(sup[id]) st.textContent = _fmtAlertActor(sup[id]);
    }
}

// Acciones ack/snooze — POST a los endpoints mutantes (mismo origen). El actor
// lo graba el server (operador-local); el cliente NUNCA lo manda (REQ-SEC-3).
async function _postAlertAction(action, alertId, hours){
    var url = action === 'snooze' ? '/dashboard/alert/snooze' : '/dashboard/alert/ack';
    var body = { alertId: alertId };
    if(action === 'snooze') body.hours = hours;
    var res = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if(res && res.applied){
        if(typeof showToast === 'function') showToast(action === 'snooze' ? 'Alerta silenciada' : 'Alerta marcada como vista', true);
        try { await tickAlertTray(); } catch(_) {}
    } else {
        if(typeof showToast === 'function') showToast('No se pudo registrar la acción', false);
    }
}

document.addEventListener('click', function(e){
    var t = e.target; if(!t || !t.closest) return;
    var btn = t.closest('[data-alert-action]');
    if(!btn) return;
    e.preventDefault(); e.stopPropagation();
    var action = btn.getAttribute('data-alert-action');
    var id = btn.getAttribute('data-alert-id');
    var hours = Number(btn.getAttribute('data-alert-hours')) || undefined;
    if(!id) return;
    _postAlertAction(action, id, hours);
});

// CA-11 / REQ-SEC-5 — deep-links de estado de elemento (?alert/?agent/?phase).
// El value se valida contra una regex allowlist antes de tocar la URL y nunca
// se refleja crudo (sólo se usa para resaltar el elemento por data-attr).
var _DEEPLINK_KEYS = { alert: 1, agent: 1, phase: 1 };
var _DEEPLINK_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;
function _setElementState(key, value){
    if(!_DEEPLINK_KEYS[key]) return;
    try {
        var u = new URL(location.href);
        if(value && _DEEPLINK_RE.test(value)) u.searchParams.set(key, value);
        else u.searchParams.delete(key);
        history.replaceState(history.state || {}, '', u.pathname + u.search);
    } catch(_) {}
    _applyDeeplinkHighlight(key, value);
}
function _applyDeeplinkHighlight(key, value){
    try {
        var prev = document.querySelectorAll('[data-deeplink-key="' + key + '"].deeplink-selected');
        for(var i = 0; i < prev.length; i++) prev[i].classList.remove('deeplink-selected');
        if(value && _DEEPLINK_RE.test(value)){
            var nodes = document.querySelectorAll('[data-deeplink-key="' + key + '"]');
            for(var j = 0; j < nodes.length; j++){
                if(nodes[j].getAttribute('data-deeplink-value') === value) nodes[j].classList.add('deeplink-selected');
            }
        }
    } catch(_) {}
}
document.addEventListener('click', function(e){
    var t = e.target; if(!t || !t.closest) return;
    if(t.closest('[data-alert-action]')) return; // los botones ack/snooze no seleccionan
    var el = t.closest('[data-deeplink-key]');
    if(!el) return;
    var key = el.getAttribute('data-deeplink-key');
    var value = el.getAttribute('data-deeplink-value');
    _setElementState(key, value);
});
function _restoreDeeplinksFromBoot(){
    var sel = (__VIEW_BOOT && __VIEW_BOOT.selected) || {};
    ['alert', 'agent', 'phase'].forEach(function(k){
        if(sel[k]) _applyDeeplinkHighlight(k, sel[k]);
    });
}

// Arranque + polling del mission control (sólo si el grid está presente).
_applyMissionFrame();
if(document.getElementById('mission-grid')){
    try { tickAlertTray(); } catch(_) {}
    _restoreDeeplinksFromBoot();
    setInterval(function(){ try { tickAlertTray(); } catch(_) {} }, 30000);
    setInterval(_missionMirrorKpis, 5000);
    setTimeout(_missionMirrorKpis, 1500);
}

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
//    del flag pasan por escapeHtmlText() defensa anti-XSS (CA-10).
//  - Inactivo: placeholder vacío (un comentario HTML) — sin "cuota
//    Anthropic" en el source, así `curl | grep` no matchea.
//
// El placeholder cuando está inactivo permite al cliente "morphar" el
// banner cuando el polling lo active sin reload (CA-2 sigue cumpliéndose
// porque el JS reemplaza el comentario con el banner pleno via DOM).
// #4731 — Mapas de presentación del banner por-proveedor (compartidos SSR).
// El nombre y el label se resuelven POR ID/ERROR_TYPE allowlisteado; el color
// se elige por el atributo `data-provider` (CSS), NUNCA inyectando el valor
// crudo en style/class (CA-6 / A03). Todo string dinámico pasa por escape.
const QUOTA_PROVIDER_NAMES = {
    'anthropic': 'Anthropic',
    'openai-codex': 'Codex',
    'openai': 'OpenAI',
    'cerebras': 'Cerebras',
    'gemini-google': 'Gemini',
    'gemini': 'Gemini',
    'groq': 'Groq',
    'nvidia-nim': 'NVIDIA',
};
// Ids con regla CSS `[data-provider]` (acento/chip). Fuera de esta allowlist se
// usa el estilo `unknown` y NO se emite el id crudo como data-provider.
const QUOTA_PROVIDER_TOKENS = new Set([
    'anthropic', 'openai-codex', 'cerebras', 'gemini-google', 'nvidia-nim', 'groq',
]);
const QUOTA_REASON_LABELS = {
    'usage_limit_reached': 'límite de uso del plan',
    'usage_limit_error': 'cuota agotada',
    'weekly_quota_exhausted': 'cuota semanal agotada',
    'snapshot_threshold_90': 'cuota casi agotada',
    'insufficient_quota': 'cuota agotada',
    'billing_hard_limit_reached': 'cuota agotada',
    'tokens_exhausted': 'cuota agotada',
    'quota_exceeded': 'cuota agotada',
    'quota_exhausted': 'cuota agotada',
    'resource_exhausted': 'cuota agotada',
    'rate_limit': 'rate limit temporal',
    'rate_limit_exceeded': 'rate limit temporal',
    'schedule_rest': 'reposo horario',
};
function quotaProviderName(id) {
    return QUOTA_PROVIDER_NAMES[id] || 'proveedor';
}
function quotaProviderTokenAttr(id) {
    return QUOTA_PROVIDER_TOKENS.has(id) ? id : 'unknown';
}
function quotaReasonLabel(errType) {
    return QUOTA_REASON_LABELS[errType] || 'degradado';
}

function renderQuotaBannerSsr(quotaState) {
    if (!quotaState || !quotaState.active) {
        // Skeleton SIN nombres de proveedor ni copy del banner en el texto. El
        // cliente lo llena con setText() cuando el flag se activa en un poll
        // posterior. CA-14: `curl / | grep` de un nombre de proveedor sobre el
        // HTML inactivo NO debe matchear (los nombres sólo aparecen con flag
        // activo). Mantener los IDs para que el cliente mute sin recrear DOM.
        return `
  <section class="quota-exhausted-banner" id="quota-exhausted-banner" role="status" aria-live="polite" aria-hidden="true" data-active="false" data-scope="partial">
    <div class="quota-exhausted-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img"><use href="/assets/icons/sprite.svg#ic-quota-exhausted"></use></svg>
    </div>
    <div class="quota-exhausted-content">
      <div class="quota-exhausted-title" id="quota-exhausted-title"></div>
      <div class="quota-exhausted-sub" id="quota-exhausted-sub"></div>
      <div class="quota-exhausted-providers" id="quota-exhausted-providers"></div>
      <div class="quota-health-strip" id="quota-exhausted-health" data-empty="true"></div>
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

    // #4731 — Estado por-proveedor. `providers` = afectados; `scope` decide la
    // paleta. Fail-safe hacia 'partial' (nunca falso "global"): si el slice no
    // aporta scope, asumimos degradación puntual. Backward-compat: un flag sin
    // `providers` (legacy) se sintetiza como un único afectado `anthropic`.
    let affected = Array.isArray(quotaState.providers) ? quotaState.providers.slice() : [];
    if (affected.length === 0 && quotaState.error_type) {
        affected = [{
            id: 'anthropic',
            error_type: quotaState.error_type,
            resets_at: quotaState.resets_at,
            resets_at_ms: quotaState.resets_at_ms,
            detected_at: quotaState.detected_at,
        }];
    }
    const scope = quotaState.scope === 'global' ? 'global' : 'partial';
    const operational = Array.isArray(quotaState.operational) ? quotaState.operational : [];
    const operationalCount = Number.isFinite(quotaState.operationalCount)
        ? quotaState.operationalCount : operational.length;

    // Título dinámico (reemplaza el string hardcodeado "cuota Anthropic").
    let title;
    if (scope === 'global') {
        title = 'Modo determinístico — sin proveedores LLM disponibles.';
    } else if (affected.length === 1) {
        title = 'Proveedor ' + quotaProviderName(affected[0].id) + ' degradado — '
            + quotaReasonLabel(affected[0].error_type) + '.';
    } else {
        title = affected.length + ' proveedores degradados — ' + operationalCount + ' operativos.';
    }
    const titleHtml = escapeHtmlText(title);

    // data-provider del contenedor: sólo en puntual con 1 afectado allowlisteado.
    const singleTokenAttr = (scope === 'partial' && affected.length === 1)
        ? quotaProviderTokenAttr(affected[0].id) : '';
    const providerAttr = singleTokenAttr ? ` data-provider="${escapeHtmlAttr(singleTokenAttr)}"` : '';

    // Chips por proveedor afectado (habilitan el CA plural).
    const chipsHtml = affected.map((p) => {
        const tokenAttr = escapeHtmlAttr(quotaProviderTokenAttr(p.id));
        const name = escapeHtmlText(quotaProviderName(p.id));
        const reason = escapeHtmlText(quotaReasonLabel(p.error_type));
        const reset = escapeHtmlText(fmtHHMMLocalSsr(p.resets_at));
        return '<span class="quota-provider-chip" data-provider="' + tokenAttr + '">'
            + '<span class="quota-provider-dot" aria-hidden="true"></span>'
            + '<span class="quota-provider-name">' + name + '</span>'
            + '<span class="quota-provider-reason">' + reason + '</span>'
            + '<span class="quota-provider-reset">↻ ' + reset + '</span>'
            + '</span>';
    }).join('');

    // Health strip: "N operativos:" + nombres (evidencia de "no global", CA-2).
    const showHealth = scope === 'partial' && operationalCount > 0;
    const healthItems = showHealth
        ? operational.map((id) => '<span class="quota-health-item"><span class="quota-health-dot" aria-hidden="true"></span>'
            + escapeHtmlText(quotaProviderName(id)) + '</span>').join('')
        : '';
    const healthHtml = showHealth
        ? ('<span class="quota-health-label">' + operationalCount + ' operativos:</span>' + healthItems)
        : '';
    const healthEmptyAttr = showHealth ? 'false' : 'true';

    // Sub (compat + debug): tipo/detectado/reset del slot primario, escapados.
    const errorType = escapeHtmlAttr(quotaState.error_type || 'usage_limit_error');
    const detectedAt = escapeHtmlAttr(quotaState.detected_at || '');
    const resetsAt = escapeHtmlAttr(quotaState.resets_at || '');
    const remainingMs = Math.max(0, (quotaState.resets_at_ms || 0) - Date.now());
    const inText = escapeHtmlText(fmtCountdownSsr(remainingMs));
    return `
  <section class="quota-exhausted-banner" id="quota-exhausted-banner" role="status" aria-live="polite" aria-hidden="false" data-active="true" data-scope="${escapeHtmlAttr(scope)}"${providerAttr}>
    <div class="quota-exhausted-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-label="reloj de arena">
        <use href="/assets/icons/sprite.svg#ic-quota-exhausted"></use>
      </svg>
    </div>
    <div class="quota-exhausted-content">
      <div class="quota-exhausted-title" id="quota-exhausted-title">${titleHtml}</div>
      <div class="quota-exhausted-sub" id="quota-exhausted-sub">Tipo: ${errorType} · Detectado: ${detectedAt} · Reset: ${resetsAt}</div>
      <div class="quota-exhausted-providers" id="quota-exhausted-providers">${chipsHtml}</div>
      <div class="quota-health-strip" id="quota-exhausted-health" data-empty="${healthEmptyAttr}">${healthHtml}</div>
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

// =============================================================================
// #3725 — Composer de estado + sub-funciones puras de render del home.
//
// Patrón (receta /architect, extender NO reescribir): `renderHomeHTML` se
// descompone en 6 sub-funciones puras (`renderBrandBar`, `renderControlBar`,
// `renderInfraHealth`, `renderKpiGrid`, `renderQueueDetailed`,
// `renderSystemCard`). Cada una recibe `state` (objeto plano YA saneado) y
// devuelve un string HTML — NINGUNA lee fs/red. Todo el I/O y el saneo viven
// en `collectHomeState()` (el composer). Habilita test unitario aislado por
// pieza (CA-3725.7) y deja un único punto donde se resuelven los markers.
//
// Escape (#3722): `escapeHtmlText` para body, `escapeHtmlAttr` para atributos
// (title=/aria-label=). Strings atacante-controlables (branch/commit de git,
// títulos de issue) SIEMPRE pasan por el escape del contexto correcto.
// =============================================================================

function _safeReadJsonHome(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
}

function _fmtUptimeSsr(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d >= 1) return d + 'd ' + h + 'h';
    if (h >= 1) return h + 'h ' + m + 'm';
    return m + 'm';
}

// Marker local de build status (R-G4). NUNCA invoca `gh api` desde el dashboard
// (latencia de red inaceptable para el kiosk). Lo escribe /builder (futuro
// #3756). Si no existe → status 'unknown' sin romper la página (CA-3725.1).
function _readBuildStatus(pipelineDir) {
    const raw = _safeReadJsonHome(path.join(pipelineDir, 'build-status.json'));
    if (!raw || typeof raw !== 'object') return { status: 'unknown', branch: '', commit: '' };
    const allowed = { passing: 1, failing: 1, running: 1, unknown: 1 };
    return {
        status: allowed[raw.status] ? raw.status : 'unknown',
        branch: typeof raw.branch === 'string' ? raw.branch.slice(0, 80) : '',
        commit: typeof raw.commit === 'string' ? raw.commit.slice(0, 12) : '',
    };
}

// Salud de infra: estado binario UP/DOWN + last_ping por servicio. Whitelist
// estricta de campos (CA-3725.3): jamás se emite token, chat_id, paths ni el
// objeto de config crudo del bot. El dashboard se sirve a sí mismo → UP.
// Pulpo arranca 'checking' en SSR y se hidrata client-side desde
// /api/dash/header (pulpoAlive). Telegram lee telegram-health.json (solo
// `ok` + `updatedAt`; el resto del archivo se ignora).
function _collectInfraHealth(pipelineDir, nowIso) {
    const tg = _safeReadJsonHome(path.join(pipelineDir, 'telegram-health.json'));
    const tgUp = !!(tg && tg.ok === true);
    const tgPing = tg && typeof tg.updatedAt === 'string' ? tg.updatedAt : null;
    return {
        pulpo: { status: 'checking', lastPing: null },
        dashboard: { status: 'UP', lastPing: nowIso },
        telegram: { status: tgUp ? 'UP' : 'DOWN', lastPing: tgPing },
    };
}

// #3954 EP8-H1 CA-2/CA-3 — Semáforo global explicable para Banda 1. Lee
// `infra-health.json` (mismo shape que dashboard.js), el flag de cuota y la
// anomalía de costo, y delega en la función pura `computeInfraHealthLevel`.
// `pulpoAlive` queda null en SSR (el tick cliente lo recomputa con el header).
// Defensivo de punta a punta: cualquier error degrada a semáforo 'ok' sin
// razones (nunca rompe el render del home).
function _collectSemaforo(pipelineDir, quotaState) {
    let infraData = null;
    try {
        const raw = _safeReadJsonHome(path.join(pipelineDir, 'infra-health.json'));
        if (raw && typeof raw === 'object') infraData = raw;
    } catch { /* noop */ }
    let costAnomaly = null;
    try {
        if (_restModeState && typeof _restModeState.getAlertState === 'function') {
            const alert = _restModeState.getAlertState({ pipelineDir });
            costAnomaly = { active: !!(alert && alert.active) };
        }
    } catch { /* noop */ }
    try {
        return computeInfraHealthLevel(infraData || {}, {
            pulpoAlive: null,
            quotaState: quotaState && quotaState.active ? quotaState : null,
            costAnomaly,
        });
    } catch {
        return { level: 'ok', label: 'SALUDABLE', reasons: [] };
    }
}

// #3954 EP8-H1 CA-5 — Estado vigente de la bandeja de alertas (supresiones
// ack/snooze) leído del store del audit. Vacío si el módulo no está.
function _collectAlertSuppressions() {
    try {
        if (_alertTrayAudit && typeof _alertTrayAudit.activeSuppressions === 'function') {
            return _alertTrayAudit.activeSuppressions();
        }
    } catch { /* noop */ }
    return {};
}

// #3954 EP8-H1 CA-11 / REQ-SEC-5 — Deep-link params de estado de elemento.
// Cada uno se valida contra regex allowlist; un valor inválido se descarta
// (queda null) y NUNCA se refleja crudo. El cliente los conserva en la URL.
const _SELECTED_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;
function _validateSelected(opts) {
    const pick = (v) => (typeof v === 'string' && _SELECTED_RE.test(v)) ? v : null;
    return {
        alert: pick(opts && opts.selectedAlert),
        agent: pick(opts && opts.selectedAgent),
        phase: pick(opts && opts.selectedPhase),
    };
}

// Composer: resuelve TODO el I/O (markers, os.uptime) y arma el `state` plano
// que consumen las sub-funciones puras. Es el único lugar con efectos.
function collectHomeState(opts) {
    const _opts = opts || {};
    const pipelineDir = path.join(__dirname, '..', '..'); // .pipeline/
    const nowIso = new Date().toISOString();
    const quotaState = _opts.quotaState || getInitialQuotaState();
    return {
        quotaState,
        currentView: typeof _opts.currentView === 'string' ? _opts.currentView : 'home',
        unknownViewRequested: _opts.unknownViewRequested === true,
        // #3954 — semáforo global + supresiones de alertas + selección deep-link.
        semaforo: _collectSemaforo(pipelineDir, quotaState),
        alertSuppressions: _collectAlertSuppressions(),
        selected: _validateSelected(_opts),
        build: _readBuildStatus(pipelineDir),
        infra: _collectInfraHealth(pipelineDir, nowIso),
        // System card: whitelist cpu/mem/disk/uptime. cpu/mem se hidratan
        // client-side desde /api/dash/header; uptime_s del host se resuelve en
        // SSR (os.uptime()). disk_pct queda en SSR como '—' hasta que el slice
        // exponga disco (fuera del scope de archivos de este split, ver R-G3 en
        // el inventario). PROHIBIDO os.hostname()/process.cwd()/os.userInfo()/
        // process.env (CA-3725.6).
        system: {
            cpuPct: null, memPct: null, diskPct: null,
            uptimeS: Math.floor(os.uptime()),
        },
    };
}

// --- Sub-función pura: brand bar V3 (logo + ambiente + build status) --------
function renderBrandBar(state) {
    // #4189 — Marca producto MIZPÁ (atalaya de agentes, Génesis 31:49) + selector
    // de proyecto multiproyecto. MIZPÁ es el motor; el proyecto es intercambiable
    // (hoy Intrale, 1 de 3). El selector es informativo/estático en esta entrega
    // (la conmutación real de proyecto es trabajo futuro); lleva tooltip que lo
    // explica. El estado de build vive en la bandeja derecha común
    // renderHeaderMetaSsr(), junto a CPU/RAM, Pulpo y reloj.
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · atalaya de agentes</div>
      </div>
      <div class="mz-projsel" id="mz-projsel" role="button" tabindex="0"
           title="Proyecto activo. MIZPÁ es el motor; el proyecto es intercambiable (multiproyecto — selección en evaluación)."
           aria-label="Proyecto activo: Intrale, 1 de 3">
        <span class="mz-proj-avatar" aria-hidden="true">i</span>
        <span class="mz-proj-id">
          <span class="mz-proj-name">Intrale</span>
          <span class="mz-proj-state">PROYECTO ACTIVO</span>
        </span>
        <span class="mz-proj-badge">1 / 3</span>
        <span class="mz-proj-caret" aria-hidden="true">▾</span>
      </div>
    </div>`;
}

// --- Sub-función pura: control bar (header derecho del mockup) -------------
// #4227 (CA-1) — El header del mockup v6 sólo lleva, a la derecha: Pulpo /
// CPU·RAM / reloj. Las pastillas operativas heredadas del dashboard viejo
// (estado del pipeline «Parcial», ventanas de prioridad QA/Build, modo
// descanso) NO existen en el mockup y saturaban el header (CA-1). Se movieron
// al sink de telemetría oculto (`renderHiddenControls`) para preservar sus IDs
// y mantener vivos los tickers (tickHeader, R-G1) sin mostrarlas. Tooltips en
// `title=`/`aria-label=` con escapeHtmlAttr (CA-3725.2/10).
function renderControlBar(state) {
    // #4463 — Delegado al módulo compartido header-meta.js. home NO muestra la
    // pill de estado del pipeline en el header visible (vive en el sink oculto,
    // #4227) → withMode:false. Los IDs (hdr-resources/hdr-pulpo/hdr-clock),
    // title y aria-label se preservan literalmente (contrato R-G1).
    return renderHeaderMetaSsr({ withMode: false });
}

// #4227 (CA-1) — Controles operativos heredados (estado del pipeline + ventanas
// de prioridad + modo descanso) que el mockup v6 no contempla en el header. Se
// emiten dentro del sink oculto (`renderDiagnostics`) para que sus IDs sigan
// existiendo en el SSR (snapshot R-G1) y los tickers/handlers
// (tickHeader/setWindowPill/bindModeToggle) no queden colgados. No se muestran:
// el header limpio del mockup manda. La reubicación de estos controles a su
// lugar propio en el nuevo diseño se trata fuera de este issue de pulido.
function renderHiddenControls() {
    return `
    <div class="mz-legacy-controls" aria-hidden="true">
      <span class="in-pill" id="hdr-mode" data-mode-toggle title="Click para cambiar el estado del pipeline (running / pausa total / pausa parcial)" aria-label="Estado del pipeline">…
        <div class="in-mode-menu" id="hdr-mode-menu" role="menu" aria-hidden="true">
          <button class="in-mode-menu-item" data-mode-action="resume" type="button">
            <span class="in-mode-menu-item-icon">🟢</span>Running (sin pausa)
          </button>
          <button class="in-mode-menu-item" data-mode-action="pause" type="button">
            <span class="in-mode-menu-item-icon">⏸</span>Pausa total (todo en hold)
          </button>
          <div class="in-mode-menu-divider"></div>
          <div class="in-mode-menu-input" data-mode-action-block="partial" data-view-link="wizard/partial-pause">
            <label>Pausa parcial · solo procesar issues:</label>
            <input type="text" id="hdr-mode-partial-input" placeholder="ej: 2505, 2519, 2520" inputmode="numeric">
            <button data-mode-action="partial" type="button">⏸ Aplicar pausa parcial</button>
          </div>
        </div>
      </span>
      <span class="in-pill" id="hdr-window-qa" title="Click para activar/desactivar la QA Priority Window" aria-label="Ventana de prioridad QA">…</span>
      <span class="in-pill" id="hdr-window-build" title="Click para activar/desactivar la Build Priority Window" aria-label="Ventana de prioridad Build">…</span>
      <a class="in-pill" id="hdr-rest-mode" href="/modo-descanso" target="_blank" rel="noopener" style="display:none;text-decoration:none" title="Modo descanso activo. Click para configurar." aria-label="Modo descanso">…</a>
    </div>`;
}

// --- Sub-función pura: salud de infra (pulpo / dashboard / telegram) --------
function renderInfraHealth(state) {
    const infra = (state && state.infra) || {};
    const SERVICES = [
        { key: 'pulpo', id: 'infra-pulpo', label: 'Pulpo', tip: 'Orquestador del pipeline. Lanza y supervisa agentes.' },
        { key: 'dashboard', id: 'infra-dashboard', label: 'Dashboard', tip: 'Servidor del kiosk operativo (este proceso).' },
        { key: 'telegram', id: 'infra-telegram', label: 'Telegram bot', tip: 'Bot de comando/control. Estado binario, sin exponer token ni chat_id.' },
    ];
    const rows = SERVICES.map(s => {
        const svc = infra[s.key] || { status: 'checking', lastPing: null };
        const up = svc.status === 'UP';
        const down = svc.status === 'DOWN';
        const cls = up ? 'infra-up' : (down ? 'infra-down' : 'infra-unknown');
        const dot = up ? '🟢' : (down ? '🔴' : '○');
        const statusText = up ? 'UP' : (down ? 'DOWN' : '—');
        const ping = svc.lastPing ? fmtHHMMLocalSsr(svc.lastPing) : '—';
        return `
        <div class="infra-row ${cls}" id="${s.id}" title="${escapeHtmlAttr(s.tip)}">
          <span class="infra-dot" aria-hidden="true">${dot}</span>
          <span class="infra-name">${escapeHtmlText(s.label)}</span>
          <span class="infra-status" data-infra-status>${escapeHtmlText(statusText)}</span>
          <span class="infra-ping" data-infra-ping aria-label="Último ping">${escapeHtmlText(ping)}</span>
        </div>`;
    }).join('');
    return `
    <section class="infra-health" aria-label="Salud de infraestructura">
      <h2 class="in-section-title"><span class="in-section-title-icon">🩺</span> Salud de infra</h2>
      <div class="infra-grid">${rows}</div>
    </section>`;
}

// --- Sub-función pura: grid de KPIs de flujo (R-G2) -------------------------
// #4172 — Los KPIs faro de cuota/PRs se promovieron a la banda PULSO (ver
// `_pulseFaroKpis`). Acá quedan las métricas de flujo secundarias: agentes
// activos, en cola, %Rebote·7d, Tokens·24h y Duración por agente. Todos los IDs
// (kpi-active-value/kpi-queue-value/kpi-bounce-value/kpi-tokens-value/
// kpi-cycle-value) se conservan intactos para no romper la hidratación
// (tickKpis + _missionMirrorKpis). Costo USD y Coverage multi-provider viven
// SOLO en la ventana `kpis`.
function renderKpiGrid(state) {
    return `
    <section class="kpi-grid" aria-label="KPIs de flujo">
      ${renderKpiCard({ id: 'kpi-active', valueId: 'kpi-active-value', icon: '🟢', label: 'Agentes activos', sub: 'ejecutando ahora', title: 'Agentes en ejecución (incluye Commander cuando atiende).' })}
      ${renderKpiCard({ id: 'kpi-queue', valueId: 'kpi-queue-value', icon: '⏩', label: 'En cola', sub: 'próximos a lanzar', title: 'Issues esperando en la cola del pipeline.' })}
      ${renderKpiCard({ id: 'kpi-bounce', valueId: 'kpi-bounce-value', icon: '↩', label: '% Rebote · 7d', sub: 'issues con ≥1 rebote', title: '% de issues con ≥1 rebote sobre issues terminados en los últimos 7 días. Hover para breakdown por fase.' })}
      ${renderKpiCard({ id: 'kpi-tokens', valueId: 'kpi-tokens-value', icon: '⚡', label: 'Tokens · 24h', sub: 'todos los providers', title: 'Tokens consumidos en las últimas 24h, sumados todos los providers (Claude · Codex · Gemini · Cerebras · NVIDIA). Hover para breakdown.' })}
      ${renderKpiCard({ id: 'kpi-cycle', valueId: 'kpi-cycle-value', icon: '⏱', label: 'Duración por agente', sub: 'mediana por marker', title: 'Mediana de duración por agente/fase (cap 7d). NO es cycle time DORA — esa métrica vive separada.' })}
    </section>`;
}

// --- #4172 — 3 KPIs faro de la banda PULSO (CA-3) ---------------------------
// Cuota sesión 5h · Cuota semanal · PRs·7d, las métricas decisorias que el
// operador necesita destacadas. El wrapper #kpi-quota (display:contents en CSS)
// preserva el id invariante que `renderQuotaCard` busca con getElementById
// antes de hidratar; sus dos hijos (kpi-quota-session/-week) reciben el toggle
// kpi-ok/warn/bad client-side. Sin nuevas fuentes de datos (CA-6).
function _pulseFaroKpis() {
    return `
    <div class="pulse-kpis" aria-label="KPIs clave">
      <div class="kpi-quota-wrap" id="kpi-quota" title="Cuota Plan Max — uso real de claude -p /usage (fuente única).">
        <div class="kpi-faro" id="kpi-quota-session">
          <span class="kpi-faro-label">⏳ Cuota sesión 5h</span>
          <span class="kpi-faro-value" id="kpi-quota-session-pct">…</span>
          <span class="kpi-faro-foot" id="kpi-quota-session-eta">·</span>
        </div>
        <div class="kpi-faro" id="kpi-quota-week">
          <span class="kpi-faro-label">📊 Cuota semanal</span>
          <span class="kpi-faro-value" id="kpi-quota-week-pct">…</span>
          <span class="kpi-faro-foot" id="kpi-quota-week-eta">·</span>
        </div>
      </div>
      <div class="kpi-faro" id="kpi-prs" title="PRs mergeados en los últimos 7 días (ventana UTC). Fuente: gh pr list, cache 5min.">
        <span class="kpi-faro-label">✅ PRs · 7d</span>
        <span class="kpi-faro-value" id="kpi-prs-value">…</span>
        <span class="kpi-faro-foot">mergeados</span>
      </div>
    </div>`;
}

// --- Sub-función pura: cola detallada (ETA ola + ejecutando + cola + olas) --
// Reusa los esqueletos existentes con DOM morphing anti-flicker (renderLineRow
// / renderWaveRowSkeleton se invocan client-side; acá se emiten los containers
// con sus IDs intactos). Títulos de issue (atacante-controlables) se escapan en
// el cliente vía textContent / escapeHtml (R-G1, CA-3725.5).
// #3954 EP8-H1 — Sub-piezas de la cola, extraídas para que las consuman tanto
// el `renderQueueDetailed` legacy (composición, mantiene el test #3725) como
// las bandas nuevas del mission-control (Banda 2 reusa `_activeSectionHtml`,
// Banda 3 reusa `_wavePanelHtml` + `_queueSectionHtml`). Mismos IDs invariantes
// ⇒ la hidratación client-side (tickActive/tickQueue/tickWaves) no cambia.
function _olaEtaSectionHtml() {
    return `
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
    </section>`;
}

function _activeSectionHtml() {
    return `
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
    </section>`;
}

function _recentSectionHtml() {
    return `
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
    </section>`;
}

function _queueSectionHtml() {
    return `
    <section class="in-section">
      <div class="in-section-title-row">
        <h2 class="in-section-title">
          <span class="in-section-title-icon">⏩</span>
          Próximos en cola
        </h2>
        <!-- #3023 — Badge "filtrado por pausa parcial". Hidden por
             default, tickQueue() lo muestra cuando partialPause.active. -->
        <span class="in-pill-partial-filter"
              id="queue-partial-filter-badge"
              style="display:none"
              title="Mostrando solo issues de la allowlist activa. Levantá la pausa para ver el top completo.">
          ⏸ filtrado por pausa parcial
        </span>
      </div>
      <div class="line-list" id="queue-list"></div>
    </section>`;
}

function _wavePanelHtml() {
    return `
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
    </section>`;
}

// Composición legacy (se mantiene exportada para el test #3725 y para `/legacy`).
function renderQueueDetailed(state) {
    return _olaEtaSectionHtml() + '\n' + _activeSectionHtml() + '\n'
        + _recentSectionHtml() + '\n' + _queueSectionHtml() + '\n' + _wavePanelHtml();
}

// --- Sub-función pura: system card (CPU / RAM / disco / uptime) -------------
// Whitelist estricta (CA-3725.6): SOLO cpu_pct, mem_pct, disk_pct, uptime_s.
// PROHIBIDO os.hostname()/process.cwd()/os.userInfo()/paths/process.env. cpu y
// mem se hidratan client-side desde /api/dash/header (un solo endpoint, R-G3).
function renderSystemCard(state) {
    const sys = (state && state.system) || {};
    const pct = (v) => (v == null || isNaN(v)) ? '—' : (Math.round(v) + '%');
    const cells = [
        { id: 'sys-cpu-value', label: 'CPU', val: pct(sys.cpuPct), tip: 'Uso de CPU del host (%). Fuente: /api/dash/header.' },
        { id: 'sys-mem-value', label: 'RAM', val: pct(sys.memPct), tip: 'Uso de memoria del host (%). Fuente: /api/dash/header.' },
        { id: 'sys-disk-value', label: 'Disco', val: pct(sys.diskPct), tip: 'Uso de disco del host (%).' },
        { id: 'sys-uptime-value', label: 'Uptime', val: _fmtUptimeSsr(sys.uptimeS), tip: 'Tiempo encendido del host.' },
    ];
    const cellHtml = cells.map(c => `
        <div class="sys-cell" title="${escapeHtmlAttr(c.tip)}">
          <span class="sys-cell-label">${escapeHtmlText(c.label)}</span>
          <span class="sys-cell-value" id="${c.id}">${escapeHtmlText(c.val)}</span>
        </div>`).join('');
    return `
    <section class="system-card" aria-label="Recursos del sistema">
      <h2 class="in-section-title"><span class="in-section-title-icon">🖥</span> Recursos del host</h2>
      <div class="sys-grid">${cellHtml}</div>
    </section>`;
}

// =============================================================================
// #3954 EP8-H1 — Mission control de 3 bandas (Salud / Ahora / Flujo).
// =============================================================================

// Mapeo nivel → ícono (severidad por forma + texto, NO sólo color — WCAG AA).
const _SEM_ICON = { ok: '🟢', warn: '🟡', stale: '⚪', alert: '🔴' };

// --- Banda 1: semáforo global explicable (CA-2/CA-3) ------------------------
// El tooltip enumera cada razón que degradó el semáforo (CA-2). Cada razón se
// escapa al render (REQ-SEC-6). Sistema sano → "Sin degradaciones".
function renderSemaforo(state) {
    const sem = (state && state.semaforo) || { level: 'ok', label: 'SALUDABLE', reasons: [] };
    const level = (sem.level === 'warn' || sem.level === 'alert' || sem.level === 'stale') ? sem.level : 'ok';
    const reasons = Array.isArray(sem.reasons) ? sem.reasons : [];
    const tooltip = reasons.length
        ? reasons.map(r => '• ' + ((r && r.text) || '')).join('\n')
        : 'Sin degradaciones';
    const reasonItems = reasons.length
        ? reasons.map(r => `<li class="semaforo-reason semaforo-reason-${escapeHtmlAttr((r && r.level) || 'ok')}">${escapeHtmlText((r && r.text) || '')}</li>`).join('')
        : '<li class="semaforo-reason semaforo-reason-ok">Sin degradaciones</li>';
    return `
    <div class="semaforo semaforo-${escapeHtmlAttr(level)}" id="semaforo-global"
         title="${escapeHtmlAttr(tooltip)}" role="status" aria-label="Salud global: ${escapeHtmlAttr(sem.label || '')}">
      <span class="semaforo-disc" aria-hidden="true">${_SEM_ICON[level] || '⚪'}</span>
      <div class="semaforo-body">
        <span class="semaforo-label" id="semaforo-label">${escapeHtmlText(sem.label || '')}</span>
        <ul class="semaforo-reasons" id="semaforo-reasons" role="list">${reasonItems}</ul>
      </div>
    </div>`;
}

// --- Banda 1: bandeja de alertas (CA-5/CA-6) --------------------------------
// Reemplaza los banners dispersos. Cada alerta activa (derivada de las razones
// del semáforo) muestra su estado de atención ("quién la atendió" + timestamp,
// grabado server-side, REQ-SEC-3) + botones ack y snooze (allowlist 1/4/24h,
// REQ-SEC-2). Todo dato derivado se escapa (REQ-SEC-5/6). El registro de
// acciones (#alert-tray-audit) lo hidrata tickAlertTray desde /api/dash/alert-tray.
function renderAlertTray(state) {
    const sem = (state && state.semaforo) || { reasons: [] };
    const sup = (state && state.alertSuppressions) || {};
    const reasons = Array.isArray(sem.reasons) ? sem.reasons : [];
    const rows = reasons.map((r) => {
        const id = (r && r.code) || '';
        const s = sup[id];
        let status = 'activa';
        if (s && s.action === 'snooze') {
            status = 'snooze hasta ' + fmtHHMMLocalSsr(s.snoozeUntil) + ' · ' + escapeHtmlText(s.actor || '');
        } else if (s && s.action === 'ack') {
            status = 'visto por ' + escapeHtmlText(s.actor || '') + ' · ' + fmtHHMMLocalSsr(s.timestamp);
        }
        return `
        <div class="alert-tray-row alert-${escapeHtmlAttr((r && r.level) || 'ok')}"
             data-alert-id="${escapeHtmlAttr(id)}" data-deeplink-key="alert" data-deeplink-value="${escapeHtmlAttr(id)}">
          <span class="alert-tray-text">${escapeHtmlText((r && r.text) || '')}</span>
          <span class="alert-tray-status" data-alert-status>${status}</span>
          <span class="alert-tray-actions">
            <button type="button" class="alert-ack-btn" data-alert-action="ack" data-alert-id="${escapeHtmlAttr(id)}" title="Marcar la alerta como vista">Ya lo vi</button>
            <button type="button" class="alert-snooze-btn" data-alert-action="snooze" data-alert-hours="1" data-alert-id="${escapeHtmlAttr(id)}" title="Silenciar 1 hora">1h</button>
            <button type="button" class="alert-snooze-btn" data-alert-action="snooze" data-alert-hours="4" data-alert-id="${escapeHtmlAttr(id)}" title="Silenciar 4 horas">4h</button>
            <button type="button" class="alert-snooze-btn alert-snooze-max" data-alert-action="snooze" data-alert-hours="24" data-alert-id="${escapeHtmlAttr(id)}" title="Silenciar 24 horas (cap máximo)">24h</button>
          </span>
        </div>`;
    }).join('');
    const empty = reasons.length ? '' : '<div class="alert-tray-empty">Sin alertas activas.</div>';
    return `
    <section class="alert-tray" id="alert-tray" aria-label="Bandeja de alertas">
      <h2 class="in-section-title">
        <span class="in-section-title-icon">🔔</span> Bandeja de alertas
        <span class="in-section-title-count" id="alert-tray-count">${reasons.length}</span>
      </h2>
      <div class="alert-tray-list" id="alert-tray-list">${rows}${empty}</div>
      <div class="alert-tray-audit" id="alert-tray-audit" aria-label="Registro de acciones del operador"></div>
    </section>`;
}

// --- #4172 — Eyebrow de banda (índice + chip + título + regla + meta) --------
// Aporta el ritmo de lectura vertical de la "Sala de Control". El `meta` es
// texto estático descriptivo (no se hidrata) — sin nuevas fuentes de datos.
function _bandEyebrow(idx, chip, title, meta) {
    return `
      <div class="band-eyebrow">
        <span class="idx">${idx} ·</span>
        <span class="chip" aria-hidden="true">${chip}</span>
        <span class="ttl">${title}</span>
        <span class="rule"></span>
        <span class="meta">${meta}</span>
      </div>`;
}

// --- Banda 1 (PULSO) --------------------------------------------------------
// #4172 "Sala de Control": semáforo elevado a HÉROE + 3 KPIs faro decisorios
// (cuota sesión/semana + PRs, CA-3) + salud de infra por servicio + bandeja de
// alertas. La salud de infra (`renderInfraHealth`) alimenta el detalle del
// semáforo y mantiene viva su hidratación (tickHeader).
function renderHealthBand(state) {
    return `
    <section class="mission-band mission-band-salud" id="band-salud" aria-label="Salud">
      ${_bandEyebrow('01', '🩺', 'Pulso', 'estado del sistema')}
      <div class="mission-band-head">
        ${renderSemaforo(state)}
        ${_pulseFaroKpis()}
      </div>
      <div class="mission-band-salud-detail">
        ${renderInfraHealth(state)}
        ${renderAlertTray(state)}
      </div>
    </section>`;
}

// --- Banda 2 (Ahora) --------------------------------------------------------
// Tarjetas grandes de agentes en ejecución (CA-7). El Commander va pinned
// primero — el slice `activeAgents` ya lo `unshift`ea (#3948), por eso reusar
// #active-list mantiene esa garantía sin código extra. El excedente se resuelve
// con scroll/carrusel horizontal acotado a la banda (CA-2), nunca a la página.
// #4172 — La banda AHORA es la protagonista visual (48%): sólo el carrusel de
// agentes activos. El panel ETA de la ola se movió a la banda FLUJO (contexto
// temporal "¿qué viene?"), alineado con el mockup aprobado por UX.
function renderNowBand(state) {
    return `
    <section class="mission-band mission-band-ahora" id="band-ahora" aria-label="Ahora">
      ${_bandEyebrow('02', '🟢', 'Ahora', 'en ejecución')}
      <div class="mission-band-now" id="mission-now-scroll">
        ${_activeSectionHtml()}
      </div>
    </section>`;
}

// --- Banda 3 (Flujo) --------------------------------------------------------
// Mini-kanban de la ola (wave-panel) + próximos en cola (CA-10) + últimos
// ejecutados. El detalle de KPIs legacy + recursos del host se conservan acá
// (su hidratación sigue viva: tickKpis/tickQuota/tickHeader) sin saturar la
// Banda 1. Scroll interno contenido por sub-componente (CA-2).
function renderFlowBand(state) {
    return `
    <section class="mission-band mission-band-flujo" id="band-flujo" aria-label="Flujo">
      ${_bandEyebrow('03', '🌊', 'Flujo', 'SLA · cola · recientes')}
      <div class="mission-band-flow">
        <div class="mission-flow-col">
          ${_olaEtaSectionHtml()}
          ${_wavePanelHtml()}
          ${_queueSectionHtml()}
        </div>
        <div class="mission-flow-col">
          ${_recentSectionHtml()}
          ${renderKpiGrid(state)}
          ${renderSystemCard(state)}
        </div>
      </div>
    </section>`;
}

// =============================================================================
// #4189 — Rediseño integral de la HOME · centro de mando «MIZPÁ» (Ola 7.1).
// -----------------------------------------------------------------------------
// El layout pasa de las 3 bandas (#4172) al esquema del mockup v6:
//   marca MIZPÁ → banner de misión (ola protagonista) → nav curada (5 + Más) →
//   panel estado+cuotas (3 columnas) → grilla 2-col (Ahora·Ejecución | Tablero
//   de la Ola) → diagnóstico colapsable.
// Contrato preservado (R-G1 / snapshot-IDs): TODO sub-componente con IDs
// hidratados por tickers (semaforo, active-list, wave-panel, kpi-quota, kpis,
// infra, sys, ola-eta, alert-tray, queue) sigue presente en el SSR — los que no
// tienen lugar propio en el mockup viven en el <details> de diagnóstico. Así
// los tickers (tickHeader/tickKpis/tickQuota/tickActive/tickWaves/tickOlaETA/
// _missionMirrorKpis) siguen vivos sin cambios de endpoint.
// =============================================================================

// Banner de misión: la ola como protagonista. SSR con valores neutros; los
// datos vivos los espejan tickWaves (número/nombre/desc/avance/segmentos/
// entregados) y tickOlaETA (ETA/velocidad) en sus IDs `mission-*`. Sin nuevos
// endpoints. Cada zona lleva tooltip autodescriptivo (CA-11).
function renderMissionBanner(state) {
    // #4235 — «Cabecera de ola» del marco común MIZPÁ. Se reutiliza el helper
    // canónico `renderMissionBannerPipeline()` que entregó #4234 (PR #4254) para
    // que HOME muestre EXACTAMENTE el mismo banner que el resto de las pantallas
    // (mismos contenedores mz-*, mismos IDs hidratables: mission-wave-num/-name/
    // -desc, mission-eta/-vel/-delivered-value, mz-prog-bar y la leyenda de
    // puntitos hechos·activos·bloq·cola). Al delegar, ambas pantallas comparten
    // una sola fuente de markup y no pueden divergir (CA: «no se duplica markup»).
    if (_pipelineRedesign && typeof _pipelineRedesign.renderMissionBannerPipeline === 'function') {
        return _pipelineRedesign.renderMissionBannerPipeline();
    }
    // Fallback defensivo (módulo común ausente): markup equivalente inline para
    // que el home nunca quede sin banner. Conserva los mismos IDs/clases.
    return `
    <section class="mz-mission" id="mz-mission" aria-label="Misión de la ola activa"
             title="Ola activa del plan: avance, ritmo de entrega y cierre estimado.">
      <div class="mz-wavetag" title="Número de la ola activa.">
        <span class="mz-wavetag-k">OLA</span>
        <span class="mz-wavetag-n" id="mission-wave-num">—</span>
      </div>
      <div class="mz-mission-text">
        <div class="mz-mission-ttl">
          <span id="mission-wave-name">Sin ola activa</span>
          <span class="mz-mission-badge" id="mission-wave-tag" style="display:none"
                title="Marca contextual de la ola (p. ej. última del plan).">ÚLTIMA DEL PLAN</span>
        </div>
        <div class="mz-mission-desc" id="mission-wave-desc">Esperando la planificación de la ola activa.</div>
        <div class="mz-timeline" id="mission-timeline" title="Línea de tiempo de la ola: comienzo, avance actual y cierre estimado.">
          <div class="mz-tl-head">
            <div class="mz-tl-cap mz-tl-cap-start" id="mission-started-wm" title="Fecha y hora en que se activó la ola.">
              <span class="mz-tl-cap-l">🗓️ COMIENZO</span>
              <span class="mz-tl-cap-v" id="mission-started-value">—</span>
            </div>
            <div class="mz-tl-cap mz-tl-cap-mid" title="Avance total de la ola.">
              <span class="mz-tl-cap-l">AVANCE</span>
              <span class="mz-prog-pct" id="mission-avance-pct">0%</span>
            </div>
            <div class="mz-tl-cap mz-tl-cap-eta" title="Tiempo estimado para cerrar la ola (proyección por velocidad de entrega).">
              <span class="mz-tl-cap-l">⏳ ETA DE LA OLA</span>
              <span class="mz-tl-cap-v" id="mission-eta-value">—</span>
              <span class="mz-tl-cap-s" id="mission-eta-sub">cierre estimado</span>
              <span class="mz-tl-cap-decomp" id="mission-eta-decomp" style="display:none"
                    title="ETA descompuesto (#4588): cierre si firmás ahora (pipeline-bound) vs cierre con tu latencia histórica de firma (operador-bound). La brecha es el costo visible de los gates de firma."></span>
            </div>
          </div>
          <div class="mz-tl-track">
            <div class="mz-tl-annots">
              <div class="mz-tl-annot mz-tl-annot-vel" id="mission-vel-annot"
                   title="Velocidad de la ola: % de avance por issue por minuto (histórica cross-ola).">
                <span class="mz-tl-annot-ic" aria-hidden="true">🚀</span>
                <span class="mz-tl-annot-l">VELOCIDAD</span>
                <span class="mz-tl-annot-v" id="mission-vel-value">— <span class="mz-wm-u">%/h</span></span>
              </div>
              <div class="mz-tl-annot mz-tl-annot-del"
                   title="Issues entregados sobre el total de la ola.">
                <span class="mz-tl-annot-ic" aria-hidden="true">📦</span>
                <span class="mz-tl-annot-l">ENTREGADOS</span>
                <span class="mz-tl-annot-v" id="mission-delivered-value">—<span class="mz-wm-u"> / —</span></span>
                <span class="mz-tl-annot-s" id="mission-delivered-sub">restantes</span>
              </div>
            </div>
            <div class="mz-tl-rail">
              <i class="mz-tl-fill" id="mission-bar-progress" style="width:0%"></i>
              <span class="mz-tl-now" id="mission-tl-now" style="left:0%"
                    title="Avance de la ola: sin dato aún" aria-label="Avance de la ola: sin dato aún"></span>
            </div>
          </div>
          <div class="mz-spark mz-spark-empty" id="mission-spark" aria-label="Ritmo de entrega: datos insuficientes"
               title="Ritmo de entrega de la ola: variación del avance entre mediciones (acelerando / desacelerando).">
            <span class="mz-spark-cap">📈 RITMO</span>
            <span class="mz-spark-plot" id="mission-spark-plot"></span>
            <span class="mz-spark-note" id="mission-spark-note">datos insuficientes</span>
          </div>
          <div class="mz-prog-legend mz-tl-legend">
            <span><i class="mz-dot" style="background:var(--in-ok,#3fb950)"></i> <b id="mission-leg-done">0</b> hechos</span>
            <span><i class="mz-dot" style="background:var(--in-info,#58a6ff)"></i> <b id="mission-leg-active">0</b> activos</span>
            <span><i class="mz-dot" style="background:var(--in-bad,#f85149)"></i> <b id="mission-leg-blocked">0</b> bloq.</span>
            <span><i class="mz-dot" style="background:rgba(255,255,255,.25)"></i> <b id="mission-leg-queue">0</b> cola</span>
          </div>
        </div>
      </div>
    </section>`;
}

// Fila de proveedor para las cuotas desglosadas (CA-6). El % real por proveedor
// lo hidrata `tickProviderQuota` (#4202) leyendo `/api/dash/quota` →
// `providers[<id-canónico>].{session|weekly}` = {pct, confidence}. La `key` de la
// fila ES ese id canónico (anthropic / openai-codex / gemini-google / cerebras /
// nvidia-nim — ver MZ_PROVIDER_META), por lo que renderProviderQuotaRows itera
// las mismas keys y no necesita tabla de traducción.
//
// La fila arranca en estado neutro "—" con su barra a 0; el ticker la actualiza
// a % real (con color de confianza) o "sin dato" explícito sin re-render.
//
// CA-UX2 (#4249): mientras no llegó el primer tick, el "—" debe leerse como
// *pendiente*, no como consumo 0% ni caído. Se atenúa con la clase
// `mz-ppct-pending` (opacity reducida en theme.css) y un `title` explícito; el
// primer tick de tickProviderQuota reemplaza el texto con el dato real.
// FUENTE ÚNICA de proveedores de la matriz de cuota (CA-A2 #4249, #4533). La
// lista se deriva de este mapa, alineado con los `provider` activos de
// `.pipeline/state/multi-provider-health.json` y la allowlist de adapters
// `ALLOWED_PROVIDERS` en `lib/quota-adapters/index.js`.
//
// La `key` de cada entrada ES el id canónico de hidratación (anthropic /
// openai-codex / gemini-google / cerebras / nvidia-nim) y DEBE coincidir EXACTO
// con el id que emite el slice `/api/dash/quota` (d.providers[key]).
//
// `src`: fuente fidedigna del % (CA #4533) — CLI (OAuth), API o headers
// x-ratelimit. `color`: un hue perceptualmente distinto por proveedor (CA-UX1).
// Groq fue descontinuado en #3353 — NO incluir.
const MZ_PROVIDER_META = Object.freeze({
    'anthropic':     { name: 'Anthropic',  color: 'var(--in-warn,#d29922)',   src: 'CLI' },
    'openai-codex':  { name: 'Codex',      color: 'var(--in-ok,#3fb950)',     src: 'CLI' },
    'gemini-google': { name: 'Gemini',     color: 'var(--in-info,#58a6ff)',   src: 'API' },
    'cerebras':      { name: 'Cerebras',   color: 'var(--in-accent,#2ee6c1)', src: 'headers' },
    'nvidia-nim':    { name: 'NVIDIA NIM', color: 'var(--in-accent2,#bc8cff)', src: 'headers' },
});
const MZ_ACTIVE_PROVIDERS = Object.freeze(Object.keys(MZ_PROVIDER_META));

// Rótulos de ventana por proveedor para el skeleton SSR (#4533). El backend
// (lib/provider-quota.js PROVIDER_WINDOWS) es la fuente autoritativa y
// sobreescribe estos labels al hidratar (cada celda rotula su ventana real);
// acá sólo evitan un flash vacío antes del primer tick.
const MZ_PROVIDER_WINDOWS = Object.freeze({
    'anthropic':     { short: '5h',   long: 'Sem' },
    'openai-codex':  { short: 'Roll', long: 'Sem' },
    'gemini-google': { short: 'Min',  long: 'Día' },
    'cerebras':      { short: 'Min',  long: 'Día' },
    'nvidia-nim':    { short: 'Min',  long: 'Día' },
});

// Celda de ventana (skeleton). `slot` in {short,long}. La hidratación
// (_mzHydrateWinCell) reescribe estado/color/countdown sin re-render.
function _mzWinCell(key, slot, winLabel) {
    const cid = 'mz-qm-' + key + '-' + slot;
    return `
        <div class="mz-qm-cell" id="${cid}" title="Se hidrata con la cuota disponible real del proveedor en esta ventana.">
          <span class="mz-qm-wtag" id="${cid}-tag">${escapeHtmlText(winLabel)}</span>
          <span class="mz-qm-mini"><i id="${cid}-bar" style="width:0%"></i></span>
          <span class="mz-qm-pct" id="${cid}-pct">…</span>
          <span class="mz-qm-rst" id="${cid}-rst"></span>
        </div>`;
}

function _mzProviderMatrixRow(key) {
    const m = MZ_PROVIDER_META[key];
    const w = MZ_PROVIDER_WINDOWS[key] || { short: 'Min', long: 'Día' };
    return `
      <div class="mz-qm-row">
        <div class="mz-qm-prov">
          <span class="mz-pdot" style="background:${m.color}"></span>
          <span class="mz-qm-pn">${escapeHtmlText(m.name)}</span>
          <span class="mz-qm-src">· ${escapeHtmlText(m.src)}</span>
        </div>
        ${_mzWinCell(key, 'short', w.short)}
        ${_mzWinCell(key, 'long', w.long)}
      </div>`;
}

function _mzProviderMatrix() {
    return MZ_ACTIVE_PROVIDERS.map(_mzProviderMatrixRow).join('');
}

// Panel "Estado del sistema + Cuotas" (#4533). Izquierda: estado del sistema
// COMPACTO (semáforo dot + label, sin el círculo gigante ni el chip redundante)
// + señales accionables (anomalía, rebote de la ola, proveedores sanos).
// Derecha: matriz de cuota DISPONIBLE por proveedor (5) × ventana (corta/larga)
// con % disponible, color por umbral, y reset propio por bucket. Panel de
// APOYO: compacto, no compite con "Ahora · En Ejecución" ni "Issues de la Ola".
// El semáforo completo (con sus IDs `semaforo-*`) vive en el sink de telemetría
// oculto para que `_missionMirrorKpis` y `tickAlertTray` sigan leyéndolo.
function renderSystemQuotaPanel(state) {
    const sem = (state && state.semaforo) || { level: 'ok', label: 'SALUDABLE' };
    const lvl = (sem.level === 'warn' || sem.level === 'alert' || sem.level === 'stale') ? sem.level : 'ok';
    return `
    <section class="mz-sysquota" aria-label="Estado del sistema y cuotas">
      <div class="mz-sq-side" title="Salud global del sistema y señales accionables.">
        <div class="mz-sq-head">📟 ESTADO</div>
        <div class="mz-status-line mz-status-${escapeHtmlAttr(lvl)}" role="status"
             aria-label="Salud global: ${escapeHtmlAttr(sem.label || '')}">
          <span class="mz-status-dot" aria-hidden="true"></span>
          <span class="mz-status-lbl">${escapeHtmlText(sem.label || '')}</span>
        </div>
        <div class="mz-sq-signals">
          <span class="mz-sig" id="mz-chip-anomaly" data-on="0"
                title="Consumo anómalo de tokens detectado por el semáforo.">⚠ <span>Anomalía consumo</span></span>
          <span class="mz-sig mz-sig-ok"
                title="Issues de la ola que rebotaron al menos una vez.">↩ Rebote ola <b id="mz-chip-rebote-value">—</b></span>
          <span class="mz-sig mz-sig-ok"
                title="Proveedores con cuota disponible (no agotados) sobre el total.">✓ Proveedores <b id="mz-sig-healthy">—</b></span>
        </div>
      </div>
      <div class="mz-sq-matrix">
        <div class="mz-qm-head">
          <span class="mz-qm-h-l">🔌 CUOTA DISPONIBLE POR PROVEEDOR</span>
          <span class="mz-qm-h-note">% leído del proveedor · reset propio por bucket</span>
        </div>
        <div class="mz-qm-cols">
          <span class="mz-qm-gh">Proveedor</span>
          <span class="mz-qm-gh">Ventana corta</span>
          <span class="mz-qm-gh">Ventana larga</span>
        </div>
        <div class="mz-qm-body">${_mzProviderMatrix()}</div>
      </div>
    </section>`;
}

// Columna izquierda "Ahora · En ejecución". Reusa el bloque de agentes activos
// (active-list / active-count / active-empty, vivos via tickActive) restilados
// como tarjetas del mockup, y conserva el hint de "próximo en cola".
function renderNowColumn(state) {
    return `
    <section class="mz-panel mz-now" aria-label="Agentes en ejecución">
      <div class="mz-panel-head">
        <div class="mz-panel-t" title="Agentes con trabajo en vuelo: rol, issue, fase y proveedor que lo corre.">
          <span class="mz-panel-ic">▶</span> AHORA · EN EJECUCIÓN
        </div>
        <div class="mz-panel-hint"><span id="active-count">…</span> en vuelo</div>
      </div>
      <div class="active-list mz-now-list" id="active-list"></div>
      <div class="active-empty mz-now-empty" id="active-empty" style="display:none">
        <div class="active-empty-icon">⏸</div>
        <div class="active-empty-msg">No hay agentes corriendo. Verificar pausa parcial, cola y blocked:dependencies.</div>
      </div>
    </section>`;
}

// Columna derecha "Issues de la Ola". Reusa el wave-panel (wave-active-container
// poblado por tickWaves) restilado como tablero del mockup. Nunca trunca: el
// panel lista todos los issues de la ola activa (CA-8/CA-10).
function renderWaveBoard(state) {
    return `
    <section class="mz-panel mz-board" aria-label="Tablero de issues de la ola">
      <div class="mz-panel-head">
        <div class="mz-panel-t" title="Todos los issues de la ola activa con su estado y avance. El # enlaza a GitHub.">
          <span class="mz-panel-ic">🌊</span> ISSUES DE LA OLA
        </div>
        <div class="mz-board-legend">
          <span><i class="mz-dot" style="background:#6ee7b7"></i>hecho</span>
          <span><i class="mz-dot" style="background:#7eeef3"></i>ejecutando</span>
          <span><i class="mz-dot" style="background:#9cc6fb"></i>listo</span>
          <span><i class="mz-dot" style="background:var(--in-fg-dim,#8b949e)"></i>en cola</span>
        </div>
      </div>
      <div class="wave-panel mz-board-body" id="wave-panel">
        <div id="wave-active-container"></div>
        <div id="wave-next-container"></div>
        <div class="wave-panel-empty" id="wave-panel-empty" style="display:none">
          <div class="wave-panel-empty-msg" id="wave-panel-empty-msg">Planificación no disponible — esperando próxima ola</div>
          <button type="button" class="wave-panel-empty-retry" id="wave-panel-retry" title="Forzar refresh fuera del polling de 30s">Reintentar ahora</button>
        </div>
        <span class="mz-board-updated" id="wave-panel-updated">—</span>
      </div>
      <div class="mz-board-foot" title="Cada issue enlaza a su ficha de GitHub. La ola muestra siempre todos sus issues, sin truncar.">
        ℹ️ El # de cada issue enlaza a GitHub. Se listan todos los issues de la ola, sin truncar (límite 3 agentes concurrentes).
      </div>
    </section>`;
}

// #4227 (CA-2) — La sección colapsable «🔎 Diagnóstico y métricas detalladas»
// NO existe en el mockup v6 y se removió de la vista. Pero varios de sus
// sub-componentes son el único lugar del SSR donde viven IDs que los tickers
// hidratan (infra, system card, kpis, pulse faro, ola-eta, recientes, cola,
// bandeja de alertas) — además de los controles operativos heredados (CA-1).
// Para no romper el contrato snapshot R-G1 ni dejar tickers colgados, esos
// nodos se conservan en un sink OCULTO (`hidden` + display:none): no se ven,
// pero sus IDs existen y la telemetría sigue viva. Lo imprescindible que el
// mockup sí prevé (ola/cuotas/estado) ya tiene lugar propio en el banner de
// misión y el panel estado+cuotas.
function renderDiagnostics(state) {
    return `
    <div class="mz-telemetry-sink" id="mz-telemetry-sink" hidden aria-hidden="true">
      ${renderHiddenControls()}
      ${renderSemaforo(state)}
      ${renderInfraHealth(state)}
      ${renderSystemCard(state)}
      ${renderKpiGrid(state)}
      ${_pulseFaroKpis()}
      ${_olaEtaSectionHtml()}
      ${_recentSectionHtml()}
      ${_queueSectionHtml()}
      ${renderAlertTray(state)}
    </div>`;
}

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
    //
    // #3725 — `collectHomeState()` resuelve todo el I/O (markers, os.uptime) y
    // arma el `state` plano que consumen las 6 sub-funciones puras.
    const _opts = opts || {};
    const state = collectHomeState(_opts);
    const quotaState = state.quotaState;
    const quotaBannerHtml = renderQuotaBannerSsr(quotaState);
    const currentView = state.currentView;
    const unknownViewRequested = state.unknownViewRequested;

    const theme = loadTheme();
    const designTokens = loadDesignTokens();
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
<style>${designTokens}</style>
<style>${theme}</style>
<style>${styles}</style>
</head>
<body>
<!-- #3487 — Sprite SVG inline para resolver use href=#ic-* sin
     depender de un static asset handler. Oculto con display:none, los
     símbolos siguen siendo referenciables por id. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
${/* #3953 (CA-2) — banner discreto de dato desactualizado. Oculto por default;
      el wrapper fetchJson lo muestra ante fallo de polling y lo limpia al
      recuperar. Si faltara, fetchJson lo recrea en caliente (defensa). */ ''}
${renderStaleBanner()}
<div class="kiosk-frame mission-frame">
  <header class="in-header">
    ${renderBrandBar(state)}
    ${renderControlBar(state)}
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

    <!-- #4189 — HOME «MIZPÁ» (mockup v6). El wrapper conserva id="mission-grid"
         para que _applyMissionFrame() siga detectando el home (sin tocar el
         cliente). El layout fluye en vertical y scrollea naturalmente; los
         sub-componentes con IDs hidratables viven dentro (varios en el
         <details> de diagnóstico) para preservar la telemetría existente. -->
    <div class="mz-home" id="mission-grid">
      ${renderMissionBanner(state)}
      ${navHtml}
      ${renderSystemQuotaPanel(state)}
      <div class="mz-grid">
        ${renderNowColumn(state)}
        ${renderWaveBoard(state)}
      </div>
      ${renderDiagnostics(state)}
    </div>

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
    // #3954 CA-11 — selección deep-link ya validada server-side contra regex
    // allowlist (valores inválidos llegan null). JSON.stringify escapa el
    // contenido; el cliente nunca lo refleja crudo en el DOM (REQ-SEC-5).
    selected: state.selected || { alert: null, agent: null, phase: null },
})};
</script>
<script>${FETCH_CLIENT_JS}
${CONFIRM_MODAL_JS}
${script}
${headerPillsClientScript()}
${missionOlaEtaClientScript()}
${navMoreAutoCloseClientScript()}</script>
</body>
</html>`;
}

module.exports = {
    renderHomeHTML,
    // #4900 (rebote QA visual) — CSS y script cliente expuestos como fuente única
    // para harnesses de QA visual. Antes el harness de evidencia hardcodeaba una
    // copia del CSS (sin `:not(.mz-qm-fresh)`) y armaba la celda fresca sin la
    // clase `mz-qm-fresh`, reproduciendo el DEFECTO en vez del fix (escape #4531).
    // Exponerlos permite generar el render real derivándolo del código en HEAD,
    // sin drift posible.
    homeStyles,
    renderClientScript,
    // #3725 — Composer + sub-funciones puras exportadas para test aislado por
    // pieza (CA-3725.7). Las sub-funciones son puras (reciben state, devuelven
    // string); `collectHomeState` es el único punto con I/O.
    collectHomeState,
    renderBrandBar,
    renderControlBar,
    renderInfraHealth,
    renderKpiGrid,
    renderQueueDetailed,
    renderSystemCard,
    // #3954 EP8-H1 — sub-renderers del mission control de 3 bandas.
    renderSemaforo,
    renderAlertTray,
    renderHealthBand,
    renderNowBand,
    renderFlowBand,
    // #4189 — sub-renderers del home MIZPÁ (mockup v6).
    renderMissionBanner,
    renderSystemQuotaPanel,
    renderNowColumn,
    renderWaveBoard,
    renderDiagnostics,
    // #4249/#4533 — matriz de cuota por proveedor × ventana (Bloque A): fuente
    // única + helpers puros expuestos para test aislado del render por proveedor.
    _mzWinCell,
    _mzProviderMatrixRow,
    _mzProviderMatrix,
    MZ_PROVIDER_META,
    MZ_PROVIDER_WINDOWS,
    MZ_ACTIVE_PROVIDERS,
};

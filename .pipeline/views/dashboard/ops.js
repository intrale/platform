'use strict';

// =============================================================================
// ops.js — Vista "Ops" del Dashboard V3.
//
// Origen (issue #3732, padre #3715): extracción de la ventana Ops del monolito
// `satellites.js` a su propio módulo SSR + polling.
//
// Rediseño EP8-H7 (#3960, épica #3952) — "topología de servicios con log inline
// y restart auditado". Reemplaza el grid plano de cards por un PANEL DE CONTROL:
//   CA-1  Topología jerárquica (pulpo → servicios → dashboard) con dual-encoding;
//         cada nodo muestra "desde cuándo" (uptime sano / "caído hace N m") y, al
//         seleccionarlo, el último error completo + historial de transiciones.
//   CA-2  Log inline en vivo (SSE) de solo lectura con follow automático,
//         lazy-open SOLO del nodo seleccionado (no N EventSource simultáneos).
//   CA-3  Botón Restart por servicio: confirma (confirm-modal.js) + audita +
//         stop+start AISLADO (jamás el killAll global de restart.js).
//   CA-4  Reconciler con breakdown por motivo (color + texto) + sparkline 7 d.
//   CA-5  Render como grafo con conectores, fiel al mockup 36-ops-topologia-v3.
//
// Seguridad (REQ-SEC-1..7 de #3732 + REQ-SEC-H7-1..6 de #3960):
//   - Todo texto runtime nuevo (último error, motivo, timestamps, líneas de log)
//     pasa por sanitizeRuntime()/sanitizer.js (redact secrets) y luego por
//     escapeHtmlText/escapeHtmlAttr (anti-XSS log poisoning).
//   - El SSE redacta server-side en dash.js (REQ-SEC-H7-1); el cliente escapa.
//   - Render inerte VISIBLE si el state falla (REQ-SEC-7), nunca string vacío.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');
const { CONFIRM_MODAL_JS } = require('./confirm-modal');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// #4197 (Ola 7.1) — Barra de marca MIZPÁ. Markup idéntico al de las hermanas
// (matriz.js / equipo.js / costos.js): logo atalaya + nombre + tagline + selector
// multiproyecto. Las clases `mz-*` viven en theme.css (compartidas). Todos los
// valores son literales hardcoded (sin datos externos): no requieren escape.
function renderOpsBrandBar() {
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
      <div class="mz-projsel" role="button" tabindex="0"
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

// CA-D3 / REQ-SEC-6 — sanitiza payload runtime ANTES del SSR. Reutiliza el
// sanitizer central del pipeline (redacta JWT, AWS keys, tokens, etc.). El
// truncado se aplica DESPUÉS del sanitize para no cortar a la mitad de un
// placeholder `[REDACTED:...]`.
function sanitizeRuntime(text, maxLen) {
    if (typeof text !== 'string') return '';
    const cap = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 200;
    let cleaned = text;
    try { cleaned = require('../../sanitizer').sanitize(text); }
    catch { /* sanitizer indisponible -> seguimos solo con escape posterior */ }
    return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned;
}

// Procesos del pipeline → colas asociadas (espejo de satellites.js:1071-1077).
const PROC_QUEUES = {
    'listener': ['commander', 'telegram'],
    'svc-telegram': ['telegram'],
    'svc-github': ['github'],
    'svc-drive': ['drive'],
    'svc-emulador': ['emulador'],
};
const TG_PROCS = new Set(['listener', 'svc-telegram']);

// #4197 (Ola 7.1) — Evaluación bloqueante de outbox-drain.
// Conclusión empírica (documentada en el issue): outbox-drain es un FALLBACK,
// no un servicio permanente. Por diseño se auto-mata cuando el Pulpo está vivo
// (pulpo.js drena el outbox en su mainLoop — outbox-drain.js:73-81). El Commander
// NO drena el outbox. Por lo tanto su ausencia con el Pulpo vivo es SALUD, no una
// falla: representarlo siempre como "caído" sería una FALSA ALARMA. Decisión:
// representación CONDICIONAL (opción c) — estado "standby/dormido" neutro cuando
// el Pulpo cubre el drain, "fallback activo" cuando corre, y sólo alarma real
// cuando el Pulpo TAMBIÉN está caído (nadie drena la cola).
const FALLBACK_PROCS = new Set(['outbox-drain']);

// Estado efectivo de un nodo: 'alive' | 'dead' | 'standby'.
// 'standby' aplica sólo a procesos fallback que están caídos PERO cuyo titular
// (el Pulpo) está vivo y cubre su función — no es una caída, es reposo sano.
function nodeStateOf(name, proc, opts) {
    const alive = !!(proc && proc.alive);
    if (alive) return 'alive';
    if (FALLBACK_PROCS.has(name) && opts && opts.pulpoAlive) return 'standby';
    return 'dead';
}

// EP8-H7 (#3960) — topología jerárquica. `root` es el orquestador; `services`
// la capa intermedia; `output` la capa de salida. El render es data-driven:
// sólo se dibujan los nodos presentes en `state.procesos`, pero este orden
// fija la jerarquía y los conectores (CA-5, fiel al mockup 36).
const TOPOLOGY = {
    root: 'pulpo',
    services: ['listener', 'svc-telegram', 'svc-github', 'svc-drive', 'svc-reconciler', 'outbox-drain'],
    output: ['dashboard'],
};

// #4197 — Resumen de salud del entorno para el banner de misión. Cuenta vivos y
// caídos REALES (los fallbacks en reposo/standby NO cuentan como caídos — su
// ausencia con el Pulpo vivo es salud, no falla). Devuelve también el uptime del
// Pulpo (raíz de la topología) para la métrica de estabilidad.
function computeOpsHealth(procesos) {
    const procs = procesos || {};
    const rootName = TOPOLOGY.root;
    const pulpoAlive = !!(procs[rootName] && procs[rootName].alive);
    const nodeOpts = { pulpoAlive };
    let alive = 0, total = 0, standby = 0;
    const down = [];
    for (const [name, p] of Object.entries(procs)) {
        const st = nodeStateOf(name, p, nodeOpts);
        if (st === 'standby') { standby++; continue; }   // reposo sano: ni vivo ni caído
        total++;
        if (st === 'alive') alive++;
        else down.push(name);
    }
    const pulpoUptime = pulpoAlive ? (Number(procs[rootName].uptime) || 0) : 0;
    return { pulpoAlive, alive, total, standby, down, pulpoUptime };
}

// Entornos QA mostrados como pills compactas (CA-5, mockup 36 §2.5).
const QA_ENV_PILLS = [
    { key: 'qaEnv', label: 'emulador' },
    { key: 'qaRemote', label: 'backend' },
    { key: 'infraHealth', label: 'infra' },
    { key: 'telegramHealth', label: 'telegram' },
];

// Deriva el estado de salud ('ok' | 'warn' | 'bad') de un sub-objeto del slice.
function healthOf(data) {
    if (!data || typeof data !== 'object') return 'warn';
    if (data.ok === true) return 'ok';
    if (data.ok === false) return 'bad';
    const s = String(data.status || '').toLowerCase();
    if (s === 'ok' || s === 'healthy' || s === 'up') return 'ok';
    if (s === 'degraded' || s === 'warn' || s === 'warning' || s === 'stale') return 'warn';
    if (s === 'down' || s === 'error' || s === 'bad' || s === 'fail') return 'bad';
    return 'warn';
}

// Formato de duración para uptime (ms → "1h 2m" / "45m" / "12s").
function fmtDurSsr(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return '—';
    const totalSec = Math.floor(n / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d >= 1) return d + 'd ' + h + 'h';
    if (h >= 1) return h + 'h ' + m + 'm';
    if (m >= 1) return m + 'm ' + s + 's';
    return s + 's';
}

const OPS_CSS = `
/* EP8-H7 (#3960) — topología jerárquica de servicios (CA-5). */
.ops-topo { display: flex; flex-direction: column; align-items: center; gap: 0; padding: 6px 0 2px; }
.ops-topo-row { display: flex; justify-content: center; flex-wrap: wrap; gap: 14px; position: relative; }
.ops-topo-bus { width: 2px; height: 16px; background: var(--in-border); }
.ops-topo-services { padding-top: 9px; }
.ops-topo-services::before { content: ''; position: absolute; top: 0; left: 8%; right: 8%; height: 2px; background: var(--in-border); }
.ops-topo-output { padding-top: 9px; }
.ops-topo-output::before { content: ''; position: absolute; top: 0; left: 50%; width: 2px; height: 9px; background: var(--in-border); transform: translateX(-50%); }
.ops-topo-services .ops-node::before { content: ''; position: absolute; top: -9px; left: 50%; width: 2px; height: 9px; background: var(--in-border); transform: translateX(-50%); }

.ops-node { position: relative; min-width: 132px; background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 10px 12px; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; color: var(--in-fg); font: inherit; text-align: center; transition: border-color .12s, background .12s; }
.ops-node:hover { border-color: var(--in-fg-dim); }
.ops-node:focus-visible { outline: 2px solid var(--in-info); outline-offset: 1px; }
.ops-node.is-alive { border-color: var(--in-ok); }
.ops-node.is-dead { border-color: var(--in-bad); background: var(--in-bad-soft); }
/* #4197 — fallback en reposo (outbox-drain con Pulpo vivo): NO es alarma. Borde
   y fondo neutros (dim), punto hueco — se distingue por forma + texto, nunca rojo. */
.ops-node.is-standby { border-color: var(--in-border); border-style: dashed; background: var(--in-bg-3); opacity: .82; }
.ops-node.is-standby:hover { opacity: 1; border-color: var(--in-fg-dim); }
.ops-node.is-bot-down { border-color: var(--in-bad); background: var(--in-bad-soft); }
.ops-node.selected { box-shadow: 0 0 0 2px var(--in-info) inset; }
.ops-node-head { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; }
.ops-node-dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; flex: none; }
.ops-node-dot.alive { background: var(--in-ok); box-shadow: 0 0 0 1px var(--in-ok) inset; }
.ops-node-dot.standby { background: transparent; box-shadow: 0 0 0 2px var(--in-fg-dim) inset; }
.ops-node-ico { width: 13px; height: 13px; flex: none; }
.ops-node-meta { font-size: 10.5px; color: var(--in-fg-dim); font-family: var(--in-mono); }
.ops-node-meta.dead { color: var(--in-bad); font-weight: 600; }
.ops-node-meta.standby { color: var(--in-fg-dim); font-style: italic; }
.ops-topo-root .ops-node { min-width: 150px; }

/* Panel de detalle del nodo seleccionado (CA-1 + CA-2 + CA-3). */
.ops-detail { margin-top: 14px; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 12px 14px; }
.ops-detail-empty { color: var(--in-fg-dim); font-size: 12px; text-align: center; padding: 8px; }
.ops-detail-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 12px; letter-spacing: .4px; color: var(--in-fg-soft, var(--in-fg-dim)); text-transform: uppercase; margin-bottom: 8px; }
.ops-detail-head .ops-node-ico { color: var(--in-info); }
.ops-log { background: var(--in-bg-0, #0D1117); border: 1px solid var(--in-border-subtle, var(--in-border)); border-radius: 6px; font-family: var(--in-mono); font-size: 11px; line-height: 1.45; padding: 8px 10px; max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
.ops-log-line { color: var(--in-fg); }
.ops-log-line .ts { color: var(--in-fg-dim); }
.ops-log-line.err { color: var(--in-bad); }
.ops-log-empty { color: var(--in-fg-dim); }
.ops-detail-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
.ops-hist { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--in-fg-dim); font-family: var(--in-mono); }
.ops-hist .ops-node-ico { color: var(--in-fg-dim); }
.ops-hist strong { color: var(--in-fg); }
.ops-restart-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; background: var(--in-info-soft, rgba(88,166,255,0.14)); color: var(--in-info); border: 1px solid var(--in-info); font-family: inherit; }
.ops-restart-btn:hover { background: var(--in-info-soft, rgba(88,166,255,0.22)); }
.ops-restart-btn:disabled { opacity: .6; cursor: progress; }
.ops-restart-btn .ops-node-ico { width: 12px; height: 12px; }

/* Reconciler (CA-4): número + barras por motivo + sparkline. */
.ops-recon { display: flex; flex-direction: column; gap: 10px; }
.ops-recon-top { display: flex; align-items: baseline; gap: 14px; }
.ops-recon-count { font-family: var(--in-mono); font-size: 34px; font-weight: 800; color: var(--in-fg); font-variant-numeric: tabular-nums; line-height: 1; }
.ops-recon-count.is-zero { color: var(--in-fg-dim); }
.ops-recon-caption { font-size: 11px; color: var(--in-fg-dim); }
.ops-recon-bars { display: flex; flex-direction: column; gap: 6px; }
.ops-recon-bar-row { display: grid; grid-template-columns: 92px 1fr 36px; align-items: center; gap: 10px; font-size: 11px; }
.ops-recon-bar-label { color: var(--in-fg); }
.ops-recon-bar-track { background: var(--in-bg-2); border-radius: 5px; height: 9px; overflow: hidden; }
.ops-recon-bar-fill { height: 9px; border-radius: 5px; background: var(--in-info); }
.ops-recon-bar-fill[data-kind="warn"] { background: var(--in-warn); }
.ops-recon-bar-fill[data-kind="bad"] { background: var(--in-bad); }
.ops-recon-bar-val { text-align: right; color: var(--in-fg-dim); font-family: var(--in-mono); font-variant-numeric: tabular-nums; }
.ops-recon-empty { color: var(--in-fg-dim); font-size: 12px; }
.ops-recon-spark { display: flex; align-items: center; gap: 8px; }
.ops-recon-spark-label { font-size: 10.5px; color: var(--in-fg-dim); }

/* QA environment pills (CA-5, mockup §2.5). */
.ops-qa-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.ops-qa-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid transparent; }
.ops-qa-pill[data-health="ok"] { background: var(--in-ok-soft); color: var(--in-ok); border-color: var(--in-ok); }
.ops-qa-pill[data-health="warn"] { background: var(--in-warn-soft); color: var(--in-warn); border-color: var(--in-warn); }
.ops-qa-pill[data-health="bad"] { background: var(--in-bad-soft); color: var(--in-bad); border-color: var(--in-bad); }
.ops-qa-pill .ops-node-ico { width: 11px; height: 11px; }
.ops-qa-note { font-size: 10.5px; color: var(--in-fg-dim); margin-top: 8px; }

/* Leyenda dual-encoding (franja inferior). */
.ops-legend { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; }
.ops-legend-title { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; color: var(--in-fg-dim); text-transform: uppercase; width: 100%; }
.ops-legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--in-fg-dim); }
.ops-legend-item .ops-node-ico { width: 12px; height: 12px; }

/* Banner Telegram (heredado de #3732). */
.ops-banner-hidden { display: none; }
.ops-banner { display: block; padding: 12px 16px; margin-bottom: 14px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-bad); border-left: 4px solid var(--in-bad); background: var(--in-bad-soft); color: var(--in-bad); font-weight: 600; }
.ops-banner-title { display: flex; align-items: center; gap: 8px; }
.ops-banner-sub { font-weight: 400; font-size: 12px; color: var(--in-fg-dim); margin-top: 4px; font-family: var(--in-mono); word-break: break-word; }

/* #4197 — Banner de misión OPS (variante "salud de servicios"). Hereda el
   patrón MIZPÁ de las hermanas (mtx-mission de matriz.js): tarjeta-tag + texto
   + métricas + recomendación. Modo alarma (rojo/ámbar) cuando hay caídos reales;
   modo calmo (cian) cuando todo el entorno está vivo. */
.ops-mission { display: flex; align-items: stretch; gap: 22px; position: relative; overflow: hidden; flex-wrap: wrap;
  background: linear-gradient(110deg, rgba(248,113,113,.16), rgba(251,146,60,.08) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border: 1px solid rgba(248,113,113,.24); border-radius: 16px; padding: 18px 24px; }
.ops-mission.is-calm { background: linear-gradient(110deg, rgba(52,217,224,.12), rgba(124,92,255,.07) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border-color: rgba(52,217,224,.22); }
.ops-mission::after { content: "🛰"; position: absolute; right: 18px; top: -12px; font-size: 92px; opacity: .05; pointer-events: none; }
.ops-btag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 120px; padding: 12px 14px; border-radius: 14px; flex: none;
  background: linear-gradient(135deg, rgba(248,113,113,.22), rgba(251,146,60,.14)); border: 1px solid rgba(248,113,113,.34); }
.ops-mission.is-calm .ops-btag { background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border-color: rgba(52,217,224,.3); }
.ops-btag-k { font-size: 9.5px; font-weight: 800; letter-spacing: 1.2px; color: #fca5a5; }
.ops-mission.is-calm .ops-btag-k { color: #9fe9ee; }
.ops-btag-n { font-size: 36px; font-weight: 800; color: #ffe0e0; line-height: 1; font-variant-numeric: tabular-nums; }
.ops-mission.is-calm .ops-btag-n { color: #bff3f6; }
.ops-btag-s { font-size: 9px; font-weight: 700; color: #fca5a5; letter-spacing: .5px; margin-top: 3px; text-align: center; }
.ops-mission.is-calm .ops-btag-s { color: #9fe9ee; }
.ops-mtext { flex: 1; min-width: 300px; }
.ops-m-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ops-m-chip { font-size: 11px; color: #fca5a5; background: rgba(248,113,113,.12); border: 1px solid rgba(248,113,113,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.ops-mission.is-calm .ops-m-chip { color: #9fe9ee; background: rgba(52,217,224,.12); border-color: rgba(52,217,224,.3); }
.ops-m-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 640px; line-height: 1.45; }
.ops-m-desc b { color: #fca5a5; font-weight: 700; }
.ops-mission.is-calm .ops-m-desc b { color: #9fe9ee; }
.ops-wmetrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.ops-wm { flex: 1; min-width: 150px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 11px; padding: 9px 12px; }
.ops-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.ops-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.ops-wm-v .u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 700; }
.ops-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 4px; }
.ops-mright { min-width: 240px; flex: 1; display: flex; flex-direction: column; gap: 9px; }
.ops-reco { background: rgba(248,113,113,.08); border: 1px solid rgba(248,113,113,.26); border-radius: 12px; padding: 11px 13px; }
.ops-mission.is-calm .ops-reco { background: rgba(52,217,224,.06); border-color: rgba(52,217,224,.24); }
.ops-reco-l { font-size: 9.5px; font-weight: 800; letter-spacing: .6px; color: #fca5a5; display: flex; align-items: center; gap: 6px; }
.ops-mission.is-calm .ops-reco-l { color: #9fe9ee; }
.ops-reco-t { font-size: 12px; color: var(--in-fg); margin-top: 8px; line-height: 1.45; }
.ops-reco-t b { color: #fecaca; font-weight: 700; }
.ops-mission.is-calm .ops-reco-t b { color: #9fe9ee; }
`;

// ───────────────────────── SVG icon helper ─────────────────────────
function icoSsr(id, cls) {
    const c = cls ? ' ' + cls : '';
    return '<svg class="ops-node-ico' + c + '" aria-hidden="true" focusable="false" viewBox="0 0 24 24">' +
        '<use href="#' + id + '"></use></svg>';
}

// ───────────────────────── SSR helpers (server-side) ─────────────────────────

// Banner Telegram (SSR). Visible solo cuando tgHealth.ok === false.
function renderBannerSsr(tgHealth) {
    const tgDown = tgHealth && tgHealth.ok === false;
    if (!tgDown) {
        return '<div id="ops-tg-banner" class="ops-banner-hidden" role="status" aria-live="polite"' +
            ' title="Estado del bot de Telegram (Pulpo listener)"' +
            ' aria-label="Banner de salud del bot de Telegram"></div>';
    }
    const err = tgHealth.lastError || {};
    const desc = sanitizeRuntime(String(err.description || 'sin detalle'), 200);
    const code = sanitizeRuntime(String(err.code || '—'), 60);
    const src = sanitizeRuntime(String(err.source || '—'), 60);
    const upd = tgHealth.updatedAt ? sanitizeRuntime(String(tgHealth.updatedAt), 40) : '—';
    return '<div id="ops-tg-banner" class="ops-banner" role="status" aria-live="polite"' +
        ' title="El bot de Telegram (Pulpo listener) no responde"' +
        ' aria-label="Alerta: bot de Telegram caído">' +
        '<div class="ops-banner-title"><span aria-hidden="true">⚠</span>Bot de Telegram caído</div>' +
        '<div class="ops-banner-sub">' + escapeHtmlText(desc) +
        ' · code=' + escapeHtmlText(code) + ' · origen=' + escapeHtmlText(src) +
        ' · actualizado ' + escapeHtmlText(upd) + '</div>' +
        '<div class="ops-banner-sub">Acción sugerida: rotar token con BotFather y guardarlo en ' +
        '~/.claude/secrets/telegram-config.json (fuera del repo). Reiniciar listener.</div>' +
        '</div>';
}

// Render de un nodo de la topología (CA-1, dual-encoding). El nodo es un
// <button> (accesible: clickeable + foco por teclado). Nodo caído: borde rojo
// + ícono ic-health-dead + label "caído" — nunca solo color.
function nodeCardSsr(name, p, opts) {
    const proc = p || {};
    const alive = !!proc.alive;
    const state = nodeStateOf(name, proc, opts);   // 'alive' | 'dead' | 'standby'
    const standby = state === 'standby';
    const isTg = TG_PROCS.has(name);
    const botDown = isTg && opts && opts.tgDown;
    let cls = 'ops-node ';
    cls += alive ? 'is-alive' : (standby ? 'is-standby' : 'is-dead');
    if (botDown) cls += ' is-bot-down';
    const stateLabel = alive ? 'vivo' : (standby ? 'en reposo' : 'caído');

    let head, meta;
    if (alive) {
        head = '<span class="ops-node-dot alive" aria-hidden="true"></span>';
        meta = '<div class="ops-node-meta">PID ' + escapeHtmlText(proc.pid != null ? String(proc.pid) : '—') +
            ' · ' + escapeHtmlText(fmtDurSsr(proc.uptime)) + '</div>';
    } else if (standby) {
        // #4197 — fallback en reposo: el Pulpo cubre su función. Dual-encoding
        // neutro (punto hueco + texto), NUNCA borde rojo (no es una caída).
        head = '<span class="ops-node-dot standby" aria-hidden="true"></span>';
        meta = '<div class="ops-node-meta standby">en reposo · el Pulpo drena</div>';
    } else {
        head = icoSsr('ic-health-dead');
        meta = '<div class="ops-node-meta dead" data-deadlabel="1">caído</div>';
    }

    const titleTip = standby
        ? 'Fallback ' + name + ' — en reposo: el Pulpo ya drena el outbox. Sólo se activa si el Pulpo cae. Click para log + historial + restart.'
        : 'Proceso ' + name + ' — ' + stateLabel + ' · click para log + historial + restart';

    return '<button type="button" class="' + cls + '"' +
        ' data-node="' + escapeHtmlAttr(name) + '"' +
        ' data-alive="' + (alive ? '1' : '0') + '"' +
        ' data-state="' + state + '"' +
        ' title="' + escapeHtmlAttr(titleTip) + '"' +
        ' aria-label="' + escapeHtmlAttr('Proceso ' + name + ' ' + stateLabel + ', abrir detalle') + '">' +
        '<span class="ops-node-head">' + head + escapeHtmlText(name) + '</span>' +
        meta +
        '</button>';
}

// Grafo jerárquico completo (CA-5).
function renderTopologySsr(procesos, opts) {
    const procs = procesos || {};
    const rootName = TOPOLOGY.root;
    // #4197 — el estado del Pulpo decide si los fallbacks (outbox-drain) están en
    // reposo sano (standby) o son una alarma real. Se propaga a cada nodeCardSsr.
    const pulpoAlive = !!(procs[rootName] && procs[rootName].alive);
    const nodeOpts = Object.assign({}, opts, { pulpoAlive });
    const present = (names) => names.filter(n => Object.prototype.hasOwnProperty.call(procs, n));
    const services = present(TOPOLOGY.services);
    const output = present(TOPOLOGY.output);

    // Cualquier proceso reportado que no esté en la jerarquía declarada cae en
    // la capa de servicios (degradación defensiva — no perdemos nodos).
    const declared = new Set([rootName, ...TOPOLOGY.services, ...TOPOLOGY.output]);
    for (const n of Object.keys(procs)) if (!declared.has(n)) services.push(n);

    if (!Object.keys(procs).length) {
        return '<div class="ops-detail-empty">Sin procesos reportados todavía.</div>';
    }

    let html = '<div class="ops-topo" role="group" aria-label="Topología de servicios del pipeline">';
    if (Object.prototype.hasOwnProperty.call(procs, rootName)) {
        html += '<div class="ops-topo-row ops-topo-root">' + nodeCardSsr(rootName, procs[rootName], nodeOpts) + '</div>';
        if (services.length || output.length) html += '<div class="ops-topo-bus" aria-hidden="true"></div>';
    }
    if (services.length) {
        html += '<div class="ops-topo-row ops-topo-services">';
        for (const n of services) html += nodeCardSsr(n, procs[n], nodeOpts);
        html += '</div>';
    }
    if (output.length) {
        html += '<div class="ops-topo-row ops-topo-output">';
        for (const n of output) html += nodeCardSsr(n, procs[n], nodeOpts);
        html += '</div>';
    }
    html += '</div>';

    // Panel de detalle (se llena client-side al seleccionar un nodo).
    html += '<div class="ops-detail" id="ops-detail">' +
        '<div class="ops-detail-empty" id="ops-detail-empty">Seleccioná un nodo para ver su log en vivo, su historial de caídas y reiniciarlo.</div>' +
        '<div id="ops-detail-body" hidden></div>' +
        '</div>';
    return html;
}

// Pills QA (CA-5). Dual-encoding: check/cruz + texto, nunca solo color.
function renderQaPillsSsr(state) {
    let html = '';
    for (const c of QA_ENV_PILLS) {
        const h = healthOf(state[c.key]);
        const ico = h === 'ok' ? icoSsr('ic-ok') : (h === 'bad' ? icoSsr('ic-health-dead') : icoSsr('ic-health-warn'));
        html += '<span class="ops-qa-pill" data-health="' + h + '"' +
            ' title="' + escapeHtmlAttr('Entorno ' + c.label + ' — estado ' + h) + '"' +
            ' aria-label="' + escapeHtmlAttr(c.label + ' ' + h) + '">' +
            ico + escapeHtmlText(c.label) + '</span>';
    }
    return html;
}

function renderLegendSsr() {
    return '<div class="ops-legend">' +
        '<div class="ops-legend-title">Leyenda · estado por nodo (color + forma + texto — nunca solo color)</div>' +
        '<span class="ops-legend-item"><span class="ops-node-dot alive" aria-hidden="true"></span>vivo — PID + uptime</span>' +
        '<span class="ops-legend-item">' + icoSsr('ic-health-dead') + 'caído — borde rojo + "desde cuándo" + último error</span>' +
        '<span class="ops-legend-item"><span class="ops-node-dot standby" aria-hidden="true"></span>en reposo — fallback cubierto por el Pulpo (no es una caída)</span>' +
        '<span class="ops-legend-item">' + icoSsr('ic-live-tail') + 'log en vivo (SSE, follow auto, lazy-open del nodo)</span>' +
        '<span class="ops-legend-item">' + icoSsr('ic-transition-history') + 'historial de transiciones con causa</span>' +
        '<span class="ops-legend-item">' + icoSsr('ic-restart') + 'restart aislado (stop+start) · confirma + audita</span>' +
        '</div>';
}

// #4197 — Banner de misión OPS. Lee la salud del entorno (computeOpsHealth) y la
// presenta como diagnóstico accionable, igual que las hermanas MIZPÁ. El SSR ya
// resuelve el texto real (deep-link no queda en blanco); el cliente lo refresca
// por polling. Todo nombre de proceso dinámico se escapa (anti-XSS log poisoning).
function opsMissionTexts(h) {
    // Devuelve { tone:'calm'|'alarm', ttl, chip, desc, reco } con textos PLANOS
    // (sin HTML) — el caller escapa. Mirror exacto en el cliente renderOpsMission.
    const downNames = h.down.join(', ');
    if (h.down.length === 0 && h.pulpoAlive) {
        return {
            tone: 'calm',
            ttl: 'Todos los servicios del entorno están vivos',
            chip: 'ENTORNO SANO',
            desc: 'El Pulpo y sus servicios laten. El outbox-drain está en reposo: su drenado del outbox de Telegram lo cubre el Pulpo, y sólo se activa como fallback si el Pulpo cae.',
            reco: 'Nada que reiniciar. Seguí el latido del Pulpo y los descartes del reconciler; cualquier caída aparece acá y en la bandeja del Inicio.',
        };
    }
    if (!h.pulpoAlive) {
        return {
            tone: 'alarm',
            ttl: 'El Pulpo (orquestador) se cayó',
            chip: 'PULPO CAÍDO',
            desc: 'El orquestador no late: no se promueven issues ni se drena el outbox de Telegram desde el mainLoop. Mientras el Pulpo esté caído, el outbox-drain toma el relevo del drenado como fallback.',
            reco: 'Reiniciá el Pulpo desde su nodo (stop+start aislado, confirma + audita). Verificá que el outbox-drain esté drenando mientras tanto.',
        };
    }
    return {
        tone: 'alarm',
        ttl: h.down.length === 1 ? ('Un servicio se cayó → ' + downNames) : (h.down.length + ' servicios caídos → ' + downNames),
        chip: h.down.length + (h.down.length === 1 ? ' CAÍDO' : ' CAÍDOS'),
        desc: 'El Pulpo sigue vivo y orquestando, pero ' + downNames + ' dejó de latir. Seleccioná el nodo en rojo para ver su último error completo, su historial de caídas y el log en vivo.',
        reco: 'Reiniciá ' + downNames + ' de forma aislada (stop+start) desde su nodo. No toca al resto de la topología; queda auditado.',
    };
}

function renderOpsMissionBanner(state) {
    const h = computeOpsHealth(state.procesos);
    const t = opsMissionTexts(h);
    const calm = t.tone === 'calm';
    const cls = 'ops-mission' + (calm ? ' is-calm' : '');
    const badgeK = calm ? 'VIVOS' : 'CAÍDOS';
    const badgeN = calm ? String(h.alive) : String(h.down.length);
    const badgeS = calm ? ('DE ' + h.total + ' SERVICIOS') : ('DE ' + h.total + ' SERVICIOS');
    const uptimeTxt = h.pulpoAlive ? fmtDurSsr(h.pulpoUptime) : 'caído';
    const standbyNote = h.standby > 0
        ? (h.standby + ' en reposo (fallback cubierto por el Pulpo)')
        : 'sin fallbacks en reposo';
    return `
<div class="${cls}" id="ops-mission" role="region" aria-label="Salud del entorno de servicios">
  <div class="ops-btag">
    <div class="ops-btag-k" id="ops-btag-k">${escapeHtmlText(badgeK)}</div>
    <div class="ops-btag-n" id="ops-btag-n">${escapeHtmlText(badgeN)}</div>
    <div class="ops-btag-s" id="ops-btag-s">${escapeHtmlText(badgeS)}</div>
  </div>
  <div class="ops-mtext">
    <div class="ops-m-ttl"><span id="ops-m-ttl-text">${escapeHtmlText(t.ttl)}</span>
      <span class="ops-m-chip" id="ops-m-chip">${escapeHtmlText(t.chip)}</span>
    </div>
    <div class="ops-m-desc" id="ops-m-desc">${escapeHtmlText(t.desc)}</div>
    <div class="ops-wmetrics">
      <div class="ops-wm">
        <div class="ops-wm-l">🟢 SERVICIOS VIVOS</div>
        <div class="ops-wm-v" id="ops-wm-vivos">${escapeHtmlText(String(h.alive))} <span class="u">de ${escapeHtmlText(String(h.total))}</span></div>
        <div class="ops-wm-s" id="ops-wm-vivos-s">${escapeHtmlText(standbyNote)}</div>
      </div>
      <div class="ops-wm">
        <div class="ops-wm-l">⏱ UPTIME DEL PULPO</div>
        <div class="ops-wm-v" id="ops-wm-uptime">${escapeHtmlText(uptimeTxt)}</div>
        <div class="ops-wm-s" id="ops-wm-uptime-s">${h.pulpoAlive ? 'orquestador estable · latido continuo' : 'sin latido — orquestación detenida'}</div>
      </div>
      <div class="ops-wm">
        <div class="ops-wm-l">♻ DESCARTES RECONCILER</div>
        <div class="ops-wm-v" id="ops-wm-recon">…</div>
        <div class="ops-wm-s" id="ops-wm-recon-s">órdenes stale · últimas 24h</div>
      </div>
    </div>
  </div>
  <div class="ops-mright">
    <div class="ops-reco">
      <div class="ops-reco-l">${calm ? '✓ SIN ACCIÓN PENDIENTE' : '⚠ ACCIÓN SUGERIDA'}</div>
      <div class="ops-reco-t" id="ops-reco-t">${escapeHtmlText(t.reco)}</div>
    </div>
  </div>
</div>`;
}

function opsBodyHtml(state) {
    const tgHealth = state.telegramHealth;
    const tgDown = tgHealth && tgHealth.ok === false;
    return `
${renderBannerSsr(tgHealth)}
${renderOpsMissionBanner(state)}

<section class="in-section" aria-labelledby="ops-topo-h">
  <h2 id="ops-topo-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">🛰</span>Topología de servicios</h2>
  <div id="ops-procesos" aria-label="Topología jerárquica de procesos del pipeline">${renderTopologySsr(state.procesos, { tgDown })}</div>
</section>

<section class="in-section" aria-labelledby="ops-recon-h">
  <h2 id="ops-recon-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">⏳</span>Reconciler · órdenes descartadas (stale)</h2>
  <div class="ops-recon" id="ops-recon">
    <div class="ops-recon-top">
      <div class="ops-recon-count" id="stale-orders-count"
           title="Órdenes que el reconciler descartó en las últimas 24 horas"
           aria-label="total de órdenes descartadas en 24 horas">…</div>
      <div class="ops-recon-caption">últimas 24h</div>
    </div>
    <div class="ops-recon-bars" id="ops-recon-bars"></div>
    <div class="ops-recon-spark">
      <span class="ops-recon-spark-label">serie 7 d:</span>
      <span id="ops-recon-spark" aria-label="tendencia de órdenes descartadas en 7 días"></span>
    </div>
  </div>
</section>

<section class="in-section" id="ops-qaenv" aria-labelledby="ops-qa-h">
  <h2 id="ops-qa-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">📡</span>QA Environment</h2>
  <div id="ops-qa-pills" class="ops-qa-pills" aria-label="Salud de entornos QA y Telegram">${renderQaPillsSsr(state)}</div>
  <div class="ops-qa-note">La alerta de un entorno caído también vive en la bandeja del Home con su "desde cuándo" y último error completo (misma fuente de verdad).</div>
</section>

<section class="in-section" aria-labelledby="ops-legend-h">
  <h2 id="ops-legend-h" class="in-section-title" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Leyenda</h2>
  ${renderLegendSsr()}
</section>`;
}

// ───────────────────────── Client JS (polling + interacción) ─────────────────────────

const OPS_CLIENT_JS = `
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }
async function fetchJson(url){
    try { const r = await fetch(url, { cache: 'no-store' }); if(!r.ok) return null; return await r.json(); }
    catch { return null; }
}
function ico(id){ return '<svg class="ops-node-ico" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="#'+id+'"></use></svg>'; }
function fmtDur(ms){
    const n = Number(ms)||0; if(n<=0) return '—';
    const t = Math.floor(n/1000), d = Math.floor(t/86400), h = Math.floor((t%86400)/3600), m = Math.floor((t%3600)/60), s = t%60;
    if(d>=1) return d+'d '+h+'h'; if(h>=1) return h+'h '+m+'m'; if(m>=1) return m+'m '+s+'s'; return s+'s';
}
function fmtAgo(ms){
    const n = Number(ms)||0; if(n<0) return '';
    const t = Math.floor(n/60000); if(t<1) return 'recién'; if(t<60) return 'hace '+t+' m';
    const h = Math.floor(t/60), m = t%60; if(h<24) return 'hace '+h+' h '+m+' m';
    return 'hace '+Math.floor(h/24)+' d';
}
const TG_PROCS = new Set(${JSON.stringify(Array.from(TG_PROCS))});
const FALLBACK_PROCS = new Set(${JSON.stringify(Array.from(FALLBACK_PROCS))});
const OPS_ROOT = ${JSON.stringify(TOPOLOGY.root)};
// #4197 — espejo cliente de nodeStateOf(): 'alive' | 'dead' | 'standby'.
function nodeState(name, alive, pulpoAlive){
    if(alive) return 'alive';
    if(FALLBACK_PROCS.has(name) && pulpoAlive) return 'standby';
    return 'dead';
}

// Estado de transiciones por servicio (CA-1) — se refresca por polling y
// alimenta el label "caído hace N m" de los nodos y el panel de detalle.
let OPS_TRANS = {};
async function tickTransitions(){
    const d = await fetchJson('/api/dash/ops-transitions');
    if(!d || !Array.isArray(d.transitions)) return;
    // Agrupar por servicio: último 'dead' ts + summary + lastError.
    const by = {};
    for(const ev of d.transitions){
        const s = ev.service; if(!s) continue;
        (by[s] = by[s] || []).push(ev);
    }
    const out = {};
    for(const s in by){
        const evs = by[s].slice().sort((a,b)=> Date.parse(a.ts)-Date.parse(b.ts));
        let deadSince = null, lastError = '', downCount = 0; const reasons = {};
        for(const ev of evs){
            if(ev.to === 'dead'){ deadSince = Date.parse(ev.ts); lastError = ev.lastError || lastError; downCount++; const r = ev.reason||'unknown'; reasons[r]=(reasons[r]||0)+1; }
            else if(ev.to === 'alive'){ /* recuperado: el deadSince deja de aplicar si está vivo */ }
        }
        const reasonStr = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([r,n])=>r+' ×'+n).join(', ');
        out[s] = { deadSince, lastError, downCount, summary: downCount? ('caídas 7 d: '+downCount+(reasonStr?' ('+reasonStr+')':'')):'caídas 7 d: 0' };
    }
    OPS_TRANS = out;
    annotateDeadNodes();
    if(SELECTED) renderDetailMeta(SELECTED);
}
function annotateDeadNodes(){
    document.querySelectorAll('.ops-node[data-alive="0"]').forEach(function(btn){
        const name = btn.getAttribute('data-node');
        const meta = btn.querySelector('[data-deadlabel="1"]');
        if(!meta) return;
        const t = OPS_TRANS[name];
        const txt = (t && t.deadSince) ? ('caído '+fmtAgo(Date.now()-t.deadSince)) : 'caído';
        if(meta.textContent !== txt) meta.textContent = txt;
    });
}

// ── Selección de nodo + log inline lazy-SSE (CA-2) ──
let SELECTED = null;
let LOG_ES = null;       // único EventSource abierto a la vez (lazy-open)
let LOG_FOLLOW = true;
function closeLog(){ if(LOG_ES){ try{ LOG_ES.close(); }catch(e){} LOG_ES = null; } }
function openLog(service){
    closeLog();
    const box = document.getElementById('ops-log-' + cssId(service));
    if(!box) return;
    box.innerHTML = '<div class="ops-log-empty">conectando al stream…</div>';
    let started = false;
    try {
        LOG_ES = new EventSource('/logs/stream/' + encodeURIComponent(service + '.log'));
    } catch(e){ box.innerHTML = '<div class="ops-log-empty">no se pudo abrir el log</div>'; return; }
    LOG_ES.onmessage = function(ev){
        let data; try { data = JSON.parse(ev.data); } catch(e){ return; }
        const lines = Array.isArray(data.lines) ? data.lines : [];
        if(data.type === 'init'){ box.innerHTML = ''; started = true; }
        for(const ln of lines) appendLogLine(box, ln);
        if(LOG_FOLLOW) box.scrollTop = box.scrollHeight;
    };
    LOG_ES.onerror = function(){ if(!started){ box.innerHTML = '<div class="ops-log-empty">stream no disponible</div>'; } };
}
function appendLogLine(box, raw){
    // El server ya redacta secrets (REQ-SEC-H7-1). El cliente SOLO escapa HTML
    // (anti log-poisoning XSS). Resaltado de timestamp y nivel ERROR.
    const text = String(raw == null ? '' : raw);
    const isErr = /\\bERROR\\b|Exception|ECONNRESET|ETIMEDOUT|EPIPE|fatal/i.test(text);
    const m = text.match(/^(\\d{2}:\\d{2}:\\d{2})\\s+([\\s\\S]*)$/);
    const div = document.createElement('div');
    div.className = 'ops-log-line' + (isErr ? ' err' : '');
    if(m){ div.innerHTML = '<span class="ts">'+escapeHtml(m[1])+'</span> '+escapeHtml(m[2]); }
    else { div.textContent = text; }
    box.appendChild(div);
    while(box.children.length > 500) box.removeChild(box.firstChild);
}
function cssId(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'-'); }

function selectNode(name){
    if(SELECTED === name){ return; }
    SELECTED = name;
    document.querySelectorAll('.ops-node').forEach(function(b){ b.classList.toggle('selected', b.getAttribute('data-node')===name); });
    const empty = document.getElementById('ops-detail-empty');
    const body = document.getElementById('ops-detail-body');
    if(empty) empty.hidden = true;
    if(!body) return;
    body.hidden = false;
    body.innerHTML =
        '<div class="ops-detail-head">'+ico('ic-live-tail')+'<span>'+escapeHtml(name.toUpperCase())+' · LOG EN VIVO (SSE) + HISTORIAL</span></div>'+
        '<div class="ops-log" id="ops-log-'+cssId(name)+'" role="log" aria-readonly="true" aria-label="Log en vivo de '+escapeHtml(name)+'" tabindex="0"><div class="ops-log-empty">conectando…</div></div>'+
        '<div class="ops-detail-foot">'+
          '<span class="ops-hist" id="ops-hist-'+cssId(name)+'">'+ico('ic-transition-history')+'<span>cargando historial…</span></span>'+
          '<button type="button" class="ops-restart-btn" id="ops-restart-'+cssId(name)+'" data-svc="'+escapeHtml(name)+'">'+ico('ic-restart')+'Restart (confirma + audita)</button>'+
        '</div>';
    const btn = document.getElementById('ops-restart-'+cssId(name));
    if(btn) btn.addEventListener('click', function(){ doRestart(name, btn); });
    // log box auto-follow: si el usuario scrollea arriba, pausamos el follow.
    const lb = document.getElementById('ops-log-'+cssId(name));
    if(lb) lb.addEventListener('scroll', function(){ LOG_FOLLOW = (lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 8); });
    LOG_FOLLOW = true;
    openLog(name);          // lazy-open SOLO del nodo seleccionado
    renderDetailMeta(name);
}
function renderDetailMeta(name){
    const h = document.getElementById('ops-hist-'+cssId(name));
    if(!h) return;
    const t = OPS_TRANS[name] || { summary: 'caídas 7 d: 0', lastError: '' };
    const tip = t.lastError ? (' · último error: '+t.lastError) : '';
    h.innerHTML = ico('ic-transition-history')+'<span title="'+escapeHtml(t.summary+tip)+'">'+escapeHtml(t.summary)+(t.lastError?' · último error en tooltip':'')+'</span>';
}

// ── Restart con confirmación + audit (CA-3) ──
async function doRestart(service, btn){
    const ok = await inConfirm({
        title: '¿Reiniciar '+service+'?',
        message: 'Se detiene y vuelve a levantar SOLO este servicio (stop+start aislado). Queda registrado en el audit con origen e IP.',
        preview: [{ label: 'servicio', value: service }, { label: 'acción', value: 'restart aislado (no afecta al resto)' }],
        confirmLabel: 'Reiniciar', cancelLabel: 'Cancelar', danger: true,
    });
    if(!ok) return;
    if(btn){ btn.disabled = true; btn.innerHTML = ico('ic-restart')+'reiniciando…'; }
    let res = null;
    try {
        const r = await fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'restart', target: service, source:'dashboard-ui' }) });
        res = await r.json().catch(()=>null);
    } catch(e){ res = { ok:false, msg:'error de red' }; }
    // REQ-SEC-H7-5: mantener el botón deshabilitado ~5s (anti doble-click/bucle).
    setTimeout(function(){
        if(btn){ btn.disabled = false; btn.innerHTML = ico('ic-restart')+'Restart (confirma + audita)'; }
    }, 5200);
    if(res && res.ok === false && btn){ btn.title = String(res.msg||'falló'); }
}

// ── Polling de procesos (refresca la topología sin perder selección) ──
async function tickOps(){
    const d = await fetchJson('/api/dash/ops');
    if(!d) return;
    const tgHealth = d.telegramHealth;
    const tgDown = tgHealth && tgHealth.ok === false;
    const banner = document.getElementById('ops-tg-banner');
    if(banner){
        if(tgDown){
            const err = tgHealth.lastError || {};
            const desc = String(err.description || 'sin detalle').slice(0,200);
            const code = err.code || '—', src = err.source || '—';
            const upd = tgHealth.updatedAt ? new Date(tgHealth.updatedAt).toLocaleString('es-AR') : '—';
            const html = '<div class="ops-banner-title"><span aria-hidden="true">⚠</span>Bot de Telegram caído</div>'
                + '<div class="ops-banner-sub">'+escapeHtml(desc)+' · code='+escapeHtml(String(code))+' · origen='+escapeHtml(String(src))+' · actualizado '+escapeHtml(upd)+'</div>'
                + '<div class="ops-banner-sub">Acción sugerida: rotar token con BotFather y guardarlo en ~/.claude/secrets/telegram-config.json (fuera del repo). Reiniciar listener.</div>';
            if(banner.innerHTML !== html){ banner.className = 'ops-banner'; banner.innerHTML = html; }
        } else if(banner.className !== 'ops-banner-hidden'){
            banner.className = 'ops-banner-hidden'; banner.innerHTML = '';
        }
    }
    // #4197 — el estado del Pulpo decide el reposo (standby) de los fallbacks.
    const pulpoProc = (d.procesos || {})[OPS_ROOT];
    const pulpoAlive = !!(pulpoProc && pulpoProc.alive);
    // Actualizar estado de cada nodo presente sin re-render del grafo (anti-flicker,
    // preserva la selección y el log abierto).
    for(const [name, p] of Object.entries(d.procesos || {})){
        const btn = document.querySelector('.ops-node[data-node="'+cssEsc(name)+'"]');
        if(!btn) continue;
        const proc = p || {};
        const alive = !!proc.alive;
        const st = nodeState(name, alive, pulpoAlive);
        const standby = st === 'standby';
        btn.setAttribute('data-alive', alive ? '1':'0');
        btn.setAttribute('data-state', st);
        const isTg = TG_PROCS.has(name);
        const base = alive ? 'is-alive' : (standby ? 'is-standby' : 'is-dead');
        btn.className = 'ops-node ' + base + ((isTg&&tgDown)?' is-bot-down':'') + (SELECTED===name?' selected':'');
        const head = btn.querySelector('.ops-node-head');
        if(head){
            const dot = alive ? '<span class="ops-node-dot alive" aria-hidden="true"></span>'
                : (standby ? '<span class="ops-node-dot standby" aria-hidden="true"></span>' : ico('ic-health-dead'));
            head.innerHTML = dot + escapeHtml(name);
        }
        let meta = btn.querySelector('.ops-node-meta');
        if(meta){
            if(alive){ meta.className='ops-node-meta'; meta.removeAttribute('data-deadlabel'); meta.textContent = 'PID '+(proc.pid!=null?String(proc.pid):'—')+' · '+fmtDur(proc.uptime); }
            else if(standby){ meta.className='ops-node-meta standby'; meta.removeAttribute('data-deadlabel'); meta.textContent = 'en reposo · el Pulpo drena'; }
            else { meta.className='ops-node-meta dead'; meta.setAttribute('data-deadlabel','1'); }
        }
    }
    annotateDeadNodes();
    renderOpsMission(d);
}
function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }

// #4197 — Banner de misión OPS (cliente). Espejo de computeOpsHealth +
// opsMissionTexts del SSR. Todo dato externo (nombres de proceso) entra por
// textContent → XSS-safe (anti log-poisoning).
function opsSetText(id, val){ const el=document.getElementById(id); if(el && el.textContent!==String(val)) el.textContent=String(val); }
function computeOpsHealthClient(procesos){
    const procs = procesos || {};
    const pulpoProc = procs[OPS_ROOT];
    const pulpoAlive = !!(pulpoProc && pulpoProc.alive);
    let alive=0, total=0, standby=0; const down=[];
    for(const [name,p] of Object.entries(procs)){
        const a = !!(p && p.alive);
        const st = nodeState(name, a, pulpoAlive);
        if(st==='standby'){ standby++; continue; }
        total++;
        if(st==='alive') alive++; else down.push(name);
    }
    const pulpoUptime = pulpoAlive ? (Number(pulpoProc.uptime)||0) : 0;
    return { pulpoAlive, alive, total, standby, down, pulpoUptime };
}
function opsMissionTextsClient(h){
    const downNames = h.down.join(', ');
    if(h.down.length===0 && h.pulpoAlive){
        return { tone:'calm',
            ttl:'Todos los servicios del entorno están vivos',
            chip:'ENTORNO SANO',
            desc:'El Pulpo y sus servicios laten. El outbox-drain está en reposo: su drenado del outbox de Telegram lo cubre el Pulpo, y sólo se activa como fallback si el Pulpo cae.',
            reco:'Nada que reiniciar. Seguí el latido del Pulpo y los descartes del reconciler; cualquier caída aparece acá y en la bandeja del Inicio.' };
    }
    if(!h.pulpoAlive){
        return { tone:'alarm',
            ttl:'El Pulpo (orquestador) se cayó',
            chip:'PULPO CAÍDO',
            desc:'El orquestador no late: no se promueven issues ni se drena el outbox de Telegram desde el mainLoop. Mientras el Pulpo esté caído, el outbox-drain toma el relevo del drenado como fallback.',
            reco:'Reiniciá el Pulpo desde su nodo (stop+start aislado, confirma + audita). Verificá que el outbox-drain esté drenando mientras tanto.' };
    }
    return { tone:'alarm',
        ttl:(h.down.length===1?'Un servicio se cayó → ':(h.down.length+' servicios caídos → '))+downNames,
        chip:h.down.length+(h.down.length===1?' CAÍDO':' CAÍDOS'),
        desc:'El Pulpo sigue vivo y orquestando, pero '+downNames+' dejó de latir. Seleccioná el nodo en rojo para ver su último error completo, su historial de caídas y el log en vivo.',
        reco:'Reiniciá '+downNames+' de forma aislada (stop+start) desde su nodo. No toca al resto de la topología; queda auditado.' };
}
function renderOpsMission(d){
    const mission = document.getElementById('ops-mission');
    if(!mission || !d) return;
    const h = computeOpsHealthClient(d.procesos);
    const t = opsMissionTextsClient(h);
    const calm = t.tone==='calm';
    mission.classList.toggle('is-calm', calm);
    opsSetText('ops-btag-k', calm?'VIVOS':'CAÍDOS');
    opsSetText('ops-btag-n', calm?String(h.alive):String(h.down.length));
    opsSetText('ops-btag-s', 'DE '+h.total+' SERVICIOS');
    opsSetText('ops-m-ttl-text', t.ttl);
    opsSetText('ops-m-chip', t.chip);
    opsSetText('ops-m-desc', t.desc);
    const vv = document.getElementById('ops-wm-vivos');
    if(vv){ vv.textContent=''; vv.appendChild(document.createTextNode(h.alive+' ')); const u=document.createElement('span'); u.className='u'; u.textContent='de '+h.total; vv.appendChild(u); }
    opsSetText('ops-wm-vivos-s', h.standby>0 ? (h.standby+' en reposo (fallback cubierto por el Pulpo)') : 'sin fallbacks en reposo');
    opsSetText('ops-wm-uptime', h.pulpoAlive ? fmtDur(h.pulpoUptime) : 'caído');
    opsSetText('ops-wm-uptime-s', h.pulpoAlive ? 'orquestador estable · latido continuo' : 'sin latido — orquestación detenida');
    const recoL = mission.querySelector('.ops-reco-l');
    if(recoL) recoL.textContent = calm ? '✓ SIN ACCIÓN PENDIENTE' : '⚠ ACCIÓN SUGERIDA';
    opsSetText('ops-reco-t', t.reco);
}

// ── Reconciler: número + barras por motivo (CA-4) ──
function reasonKind(reason){
    const r = String(reason||'').toLowerCase();
    if(/valida|invalid|reject|error/.test(r)) return 'bad';
    if(/timeout|stale|retry|expir/.test(r)) return 'warn';
    return 'info';
}
async function tickReconciler(){
    const d = await fetchJson('/api/dash/reconciler-stale-orders');
    if(!d) return;
    const countEl = document.getElementById('stale-orders-count');
    const barsEl = document.getElementById('ops-recon-bars');
    if(!countEl || !barsEl) return;
    const total = Number(d.total_24h) || 0;
    const txt = String(total);
    if(countEl.textContent !== txt) countEl.textContent = txt;
    countEl.className = total === 0 ? 'ops-recon-count is-zero' : 'ops-recon-count';
    // #4197 — refleja el mismo número en la métrica del banner de misión.
    opsSetText('ops-wm-recon', txt);
    opsSetText('ops-wm-recon-s', total === 0 ? 'sin órdenes stale · saludable' : 'órdenes stale · últimas 24h');
    const reasons = Object.entries(d.by_reason || {}).sort((a,b)=>b[1]-a[1]);
    const max = reasons.length ? reasons[0][1] : 1;
    let html = '';
    if(!reasons.length){
        html = '<div class="ops-recon-empty">Sin descartes en 24h — saludable</div>';
    } else {
        for(const [reason, n] of reasons){
            const pct = Math.max(4, Math.round((Number(n)||0)/max*100));
            const kind = reasonKind(reason);
            html += '<div class="ops-recon-bar-row">'
                + '<span class="ops-recon-bar-label">'+escapeHtml(reason)+'</span>'
                + '<span class="ops-recon-bar-track"><span class="ops-recon-bar-fill" data-kind="'+kind+'" style="width:'+pct+'%"></span></span>'
                + '<span class="ops-recon-bar-val">'+(Number(n)||0)+'</span></div>';
        }
    }
    if(barsEl.innerHTML !== html) barsEl.innerHTML = html;
}
async function tickReconcilerSpark(){
    const d = await fetchJson('/api/dash/reconciler-history');
    const el = document.getElementById('ops-recon-spark');
    if(!el) return;
    const totals = (d && Array.isArray(d.totals)) ? d.totals : [];
    if(totals.length < 2){ el.innerHTML = '<span class="ops-recon-spark-label">sin serie todavía</span>'; return; }
    const W = 160, H = 26, pad = 2;
    const max = Math.max.apply(null, totals), min = Math.min.apply(null, totals);
    const span = (max - min) || 1;
    const pts = totals.map(function(v, i){
        const x = pad + (i/(totals.length-1))*(W-2*pad);
        const y = pad + (1 - (v-min)/span)*(H-2*pad);
        return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    const lastX = (pad + (W-2*pad)).toFixed(1);
    const lastY = (pad + (1 - (totals[totals.length-1]-min)/span)*(H-2*pad)).toFixed(1);
    el.innerHTML = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'
        + '<polyline points="'+pts+'" fill="none" stroke="var(--in-warn)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<circle cx="'+lastX+'" cy="'+lastY+'" r="2.4" fill="var(--in-warn)"/></svg>';
}

// ── QA pills ──
function healthOf(data){
    if(!data || typeof data !== 'object') return 'warn';
    if(data.ok === true) return 'ok';
    if(data.ok === false) return 'bad';
    const s = String(data.status||'').toLowerCase();
    if(s==='ok'||s==='healthy'||s==='up') return 'ok';
    if(s==='degraded'||s==='warn'||s==='warning'||s==='stale') return 'warn';
    if(s==='down'||s==='error'||s==='bad'||s==='fail') return 'bad';
    return 'warn';
}
const QA_PILLS = ${JSON.stringify(QA_ENV_PILLS)};
async function tickQaPills(){
    const d = await fetchJson('/api/dash/ops');
    if(!d) return;
    const wrap = document.getElementById('ops-qa-pills');
    if(!wrap) return;
    let html = '';
    for(const c of QA_PILLS){
        const h = healthOf(d[c.key]);
        const id = h==='ok' ? 'ic-ok' : (h==='bad' ? 'ic-health-dead' : 'ic-health-warn');
        html += '<span class="ops-qa-pill" data-health="'+h+'" title="'+escapeHtml('Entorno '+c.label+' — estado '+h)+'" aria-label="'+escapeHtml(c.label+' '+h)+'">'+ico(id)+escapeHtml(c.label)+'</span>';
    }
    if(wrap.innerHTML !== html) wrap.innerHTML = html;
}

function tickClock(){ const c = document.getElementById('hdr-clock'); if(c) c.textContent = new Date().toLocaleTimeString('es-AR'); }

// Delegación de click en la topología (los nodos pueden re-renderizarse).
document.addEventListener('click', function(ev){
    const node = ev.target.closest && ev.target.closest('.ops-node');
    if(node && node.getAttribute('data-node')){ selectNode(node.getAttribute('data-node')); }
});
// Cerrar el SSE al salir de la página (libera la conexión).
window.addEventListener('beforeunload', closeLog);

const POLLS = [
    { fn: tickOps, ms: 5000 },
    { fn: tickTransitions, ms: 15000 },
    { fn: tickReconciler, ms: 30000 },
    { fn: tickReconcilerSpark, ms: 60000 },
    { fn: tickQaPills, ms: 15000 },
    { fn: tickClock, ms: 1000 },
];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch(e){} } }
runAll();
for(const p of POLLS){ setInterval(() => { Promise.resolve(p.fn()).catch(()=>{}); }, p.ms); }
`;

// ───────────────────────── Render principal ─────────────────────────

/**
 * Render SSR de la ventana Ops.
 * @param {object} state — slice de `lib/dashboard-slices.js` opsSlice(state).
 * @param {object} [opts] — opciones de routing (currentView, etc.). Reservado.
 * @returns {string} HTML completo de la ventana.
 */
function renderOps(state, opts) {
    // CA-A3 / REQ-SEC-7 — sin state, fallback inerte visible (no string vacío).
    if (!state || typeof state !== 'object') {
        return renderInert('opsSlice(state) no fue invocado por el caller');
    }
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('ops');
    const brandHtml = renderOpsBrandBar();
    // #4197 — Miga de pan: Ops vive dentro de «⋯ Más» (tab secundario). La nav ya
    // deja el popover abierto + Ops marcada vía renderNavTabsSsr('ops'); la miga
    // refuerza la ubicación, igual que las hermanas (matriz, kpis…).
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Ops">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>🛰 Ops</b>
    <span class="mz-crumb-desc">· topología de servicios · log en vivo · restart auditado</span>
  </div>`;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Ops</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
${OPS_CSS}
</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${navHtml}
  ${breadcrumb}
  <main class="satellite-body">${opsBodyHtml(state)}</main>
  <footer class="in-footer">
    <span>Solo lectura del estado · acciones (restart) confirmadas y auditadas</span>
    <span>Intrale V3 · MIZPÁ · #4197</span>
  </footer>
</div>
<script>${CONFIRM_MODAL_JS}</script>
<script>${OPS_CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Render inerte (CA-A3 / REQ-SEC-7): visible cuando require()/state fallan.
 * @param {string} reason — motivo (se escapa antes de interpolar).
 * @returns {string} HTML mínimo visible.
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    const theme = loadTheme();
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Ops</title><style>${theme}</style></head>
<body><main style="padding:32px;max-width:800px;margin:0 auto">
<h1>Ventana Ops no disponible</h1>
<p>${safe}</p>
<p>Revisá los logs del dashboard para el detalle. El render no queda en blanco (CA-A3 / REQ-SEC-7).</p>
</main></body></html>`;
}

module.exports = {
    renderOps,
    renderInert,
    sanitizeRuntime,
    healthOf,
    fmtDurSsr,
    renderTopologySsr,
    nodeCardSsr,
    renderQaPillsSsr,
    renderOpsBrandBar,
    renderOpsMissionBanner,
    computeOpsHealth,
    nodeStateOf,
    OPS_CSS,
    TOPOLOGY,
    FALLBACK_PROCS,
    // Alias de compat para callers que esperen el nombre canónico de escape SSR.
    escapeHtmlSsr: escapeHtmlText,
};

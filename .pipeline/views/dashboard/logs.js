'use strict';

// =============================================================================
// logs.js — Pantalla "LOGS + interacción con el agente" del dashboard del
// pipeline. Rediseño integral MIZPÁ (Ola 7.1, issue #4191).
//
// Hereda el lenguaje visual MIZPÁ de las pantallas hermanas mergeadas
// (#4204 Home, #4211 Pipeline, #4217 Providers, …): barra de marca (logo
// atalaya + tagline + selector multiproyecto), nav curada 5 tabs + «⋯ Más»
// (esta pantalla cuelga de Pipeline, con miga de pan), banner de misión con la
// ola protagonista, tooltips autodescriptivos y footer redundante.
//
// La vista vieja vivía como `generateLogViewerHTML()` embebida en el monolito
// dashboard.js: salida cruda + filtros básicos + panel de chat. Acá se rearma
// con el shell MIZPÁ completo y, sobre la consola, una FICHA del agente (rol,
// issue linkeado, fase, proveedor, tiempo en vuelo, rebotes, rama + controles
// Logs/Pausar/Reiniciar) y los SUB-PASOS con avance (N/M · X%).
//
// Contrato con dashboard.js → `generateLogViewerHTML(filename, isLive)`:
//   1. `renderLogViewer(filename, isLive, ctx)` arma el HTML completo.
//   2. `ctx.issueData` = `getPipelineState().issueMatrix[<issue>]` (opcional —
//      la ficha degrada a "sin datos" si falta). dashboard.js lo inyecta porque
//      tiene getPipelineState() en scope; el módulo NO requiere dashboard.js
//      (evita ciclo de require).
//   3. Si este módulo lanza, dashboard.js cae al viewer legacy (el pipeline no
//      puede morir — el render nunca queda en blanco).
//
// SSR 100% server-side salvo: reloj, consola en vivo (SSE a /logs/stream/),
// filtros/buscador/«Seguir», chips de intervención y el panel de chat (#3605).
// Toda interpolación dinámica pasa por escapeHtmlText / escapeHtmlAttr. La
// redacción de secrets del stream la hace el server (_sanitizeLog en
// dashboard.js) — acá sólo presentamos.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');
// Marco común MIZPÁ reutilizable (#4236 sobre #4234): cabecera de marca +
// banner de la ola. Se CONSUME desde el módulo compartido en vez de duplicar
// el markup acá (CA-5). collectWave() también vive ahí (lo usa el banner).
const { collectWave, renderBrandBar, renderMissionBanner, MIZPA_FRAME_CSS } = require('./mizpa-frame');

// chat-panel es best-effort: si el módulo o sus deps fallan, la pantalla sigue
// rindiendo sin el panel de intervención (degradación, no caída).
let chatPanelMod = null;
try { chatPanelMod = require('../log-viewer/chat-panel'); } catch { /* sin chat */ }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const TOKENS_CSS_PATH = path.join(__dirname, '../../assets/design-tokens.css');
const AGENT_MODELS_PATH = path.join(__dirname, '../../agent-models.json');
// waves.json lo lee collectWave() del marco común (./mizpa-frame, #4236).
const SESSIONS_DIR = path.join(__dirname, '../../../.claude/sessions');
const LOG_DIR = path.join(__dirname, '../../logs');

function loadTheme() { try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; } }
function loadDesignTokens() { try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; } }

const GH_ISSUE_BASE = 'https://github.com/intrale/platform/issues/';

// ───────────────────────── Constantes de dominio ─────────────────────────

// Provider key (agent-models.json) → nombre humano para la ficha.
const PROVIDER_DISPLAY = Object.freeze({
    'anthropic': 'Anthropic',
    'openai-codex': 'Codex',
    'openai': 'Codex',
    'gemini-google': 'Gemini',
    'cerebras': 'Cerebras',
    'nvidia-nim': 'NVIDIA NIM',
    'deterministic': 'Determinístico',
});

// Familia de modelo legible para mostrar junto al proveedor (ej. "Opus"). El
// string crudo del modelo va siempre en el tooltip — no se pierde información.
function prettyModel(model) {
    if (!model) return '';
    const m = String(model).toLowerCase();
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
    if (m.startsWith('gpt')) return String(model).toUpperCase();
    // deepseek-ai/deepseek-v4-pro → deepseek-v4-pro
    const seg = String(model).split('/').pop();
    return seg || String(model);
}

// Formatea una duración en ms a un string compacto ("1h 12m", "4m", "38s").
function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? (h + 'h ' + rm + 'm') : (h + 'h');
}

// Última parte de "desarrollo/dev" → "dev". Defensivo.
function shortFase(faseActual) {
    if (!faseActual || typeof faseActual !== 'string') return '';
    const parts = faseActual.split('/');
    return parts[parts.length - 1] || faseActual;
}

// ───────────────────────── Colectores de datos (defensivos) ─────────────────────────

// collectWave() ahora vive en ./mizpa-frame (marco común #4236) — se importa arriba.

/**
 * Resuelve el proveedor + modelo de un skill leyendo agent-models.json.
 * @param {string} skill
 * @returns {{providerKey:string, providerName:string, model:string, modelPretty:string}|null}
 */
function collectProvider(skill) {
    if (!skill) return null;
    try {
        const cfg = JSON.parse(fs.readFileSync(AGENT_MODELS_PATH, 'utf8'));
        const s = cfg.skills && cfg.skills[skill];
        const providerKey = (s && s.provider) || cfg.default_provider || 'anthropic';
        const provEntry = (cfg.providers && cfg.providers[providerKey]) || {};
        const model = (s && s.model_override) || provEntry.model || '';
        return {
            providerKey,
            providerName: PROVIDER_DISPLAY[providerKey] || providerKey,
            model,
            modelPretty: prettyModel(model),
        };
    } catch {
        return null;
    }
}

/**
 * Busca, en .claude/sessions/*.json, la sesión del (issue, skill) y devuelve la
 * tarea in_progress con sus sub-pasos. Degrada a `null` cuando no hay sesiones
 * (estado real del repo) o no matchea. Best-effort: no lanza nunca.
 * @returns {{subject:string, steps:string[], completed:string[], current:number, progress:number}|null}
 */
function collectSubsteps(issue, skill) {
    if (!issue) return null;
    let files;
    try {
        files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        return null; // sin directorio de sesiones
    }
    const wantIssue = String(issue).replace(/^#/, '');
    for (const f of files) {
        let sess;
        try { sess = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); }
        catch { continue; }
        const sIssue = String(sess.issue != null ? sess.issue : '').replace(/^#/, '');
        if (sIssue !== wantIssue) continue;
        // Skill puede venir como "android-dev" o "Agente N"; no es confiable.
        // Si hay match de skill, lo preferimos; si no, igual usamos la sesión
        // del issue (única fuente de sub-pasos disponible).
        const tasks = Array.isArray(sess.tasks) ? sess.tasks : [];
        const task = tasks.find((t) => t && t.status === 'in_progress' && Array.isArray(t.steps) && t.steps.length)
            || tasks.find((t) => t && Array.isArray(t.steps) && t.steps.length);
        if (!task) continue;
        const steps = task.steps.map((x) => String(x));
        const completed = Array.isArray(task.completed_steps) ? task.completed_steps.map((x) => String(x)) : [];
        const current = Number.isFinite(task.current_step) ? Number(task.current_step) : completed.length;
        const progress = Number.isFinite(task.progress)
            ? Number(task.progress)
            : (steps.length ? Math.round((completed.length / steps.length) * 100) : 0);
        return { subject: task.subject || task.activeForm || '', steps, completed, current, progress };
    }
    return null;
}

/**
 * Arma el modelo de la ficha del agente cruzando el filename con el snapshot del
 * pipeline (`ctx.issueData`). Defensivo: cada campo degrada a un placeholder.
 * @param {string} filename
 * @param {boolean} isLive
 * @param {object} ctx  { issueData?: object }
 */
function buildAgentFicha(filename, isLive, ctx) {
    const parsed = (chatPanelMod && chatPanelMod.parseLogFileName)
        ? chatPanelMod.parseLogFileName(filename)
        : null;
    const issue = parsed ? parsed.issue : null;
    const skill = parsed ? parsed.skill : null;
    const issueData = (ctx && ctx.issueData) || null;

    const faseActual = issueData ? issueData.faseActual : null;
    const fase = shortFase(faseActual);
    const estado = issueData ? issueData.estadoActual : null;
    const bounces = issueData && Number.isFinite(issueData.bounces) ? issueData.bounces : 0;
    const rebote = !!(issueData && issueData.rebote);
    const title = (issueData && issueData.title) || '';
    const provider = collectProvider(skill);
    const branch = (issue && skill) ? ('agent/' + issue + '-' + skill) : '—';

    // Tiempo en vuelo: si el snapshot tiene la entrada de la fase activa, usamos
    // su durationMs (el pipeline ya corrige los quirks de ctime en Windows). Si
    // no, lo estimamos del stat del log. Best-effort.
    let durationMs = null;
    if (issueData && issueData.fases && faseActual && issueData.fases[faseActual]) {
        const entry = issueData.fases[faseActual].find((e) => e.estado === 'trabajando')
            || issueData.fases[faseActual].find((e) => e.skill === skill);
        if (entry && Number.isFinite(entry.durationMs)) durationMs = entry.durationMs;
    }
    if (durationMs == null) {
        try {
            const st = fs.statSync(path.join(LOG_DIR, filename));
            const start = Math.min(st.ctimeMs, st.birthtimeMs || st.ctimeMs);
            durationMs = isLive ? Math.max(0, Date.now() - start) : Math.abs(st.mtimeMs - start);
        } catch { /* sin stat */ }
    }

    return {
        issue,
        skill,
        title,
        fase,
        faseActual,
        estado,
        bounces,
        rebote,
        provider,
        branch,
        durationMs,
        isLive,
        ghUrl: issue ? (GH_ISSUE_BASE + encodeURIComponent(issue)) : null,
        logFile: filename,
        substeps: collectSubsteps(issue, skill),
    };
}

// renderBrandBar() y renderMissionBanner() se importan del marco común
// ./mizpa-frame (#4236). LOGS rinde EXACTAMENTE el mismo marco que el resto de
// las pantallas (cabecera MIZPÁ + banner de ola `mz-*`), sin duplicar markup.

// ───────────────────────── Ficha del agente ─────────────────────────

function renderFicha(f) {
    const rol = f.skill || '—';
    const issueLink = f.ghUrl
        ? `<a class="lv-issue-link" href="${escapeHtmlAttr(f.ghUrl)}" target="_blank" rel="noopener noreferrer"
              title="Abrir el issue #${escapeHtmlAttr(f.issue)} en GitHub">#${escapeHtmlText(f.issue)} ↗</a>`
        : '<span class="lv-na">sin issue</span>';
    const fase = f.fase
        ? `<span class="lv-pill" title="Fase actual del pipeline">${escapeHtmlText(f.fase)}</span>`
        : '<span class="lv-na">—</span>';
    const estado = f.estado
        ? `<span class="lv-pill lv-pill-${escapeHtmlAttr(f.estado)}" title="Estado del trabajo en esta fase">${escapeHtmlText(f.estado)}</span>`
        : '';
    const prov = f.provider
        ? `<span title="Proveedor LLM · modelo ${escapeHtmlAttr(f.provider.model || '?')}">${escapeHtmlText(f.provider.providerName)}${f.provider.modelPretty ? ' · ' + escapeHtmlText(f.provider.modelPretty) : ''}</span>`
        : '<span class="lv-na">sin datos</span>';
    const tiempo = f.durationMs != null ? fmtDuration(f.durationMs) : '—';
    const rebotesCls = f.bounces > 0 ? ' lv-val-warn' : '';
    const liveBadge = f.isLive
        ? '<span class="lv-live" title="El agente está ejecutándose ahora">● LIVE</span>'
        : '<span class="lv-done" title="Esta ejecución ya finalizó">✓ Finalizado</span>';

    // Controles. Logs → log crudo. Pausar → /api/needs-human/<i>/block.
    // Reiniciar → /api/needs-human/<i>/reactivate (re-encola al pipeline). Los
    // dos últimos sólo se cablean si hay issue numérico (datos del data-*).
    const issueNum = f.issue && /^\d+$/.test(String(f.issue)) ? f.issue : '';
    const rawLogHref = '/logs/' + encodeURIComponent(f.logFile);
    const controls = `
    <div class="lv-controls" role="group" aria-label="Controles del agente">
      <a class="lv-ctrl" href="${escapeHtmlAttr(rawLogHref)}" target="_blank" rel="noopener noreferrer"
         title="Abrir el log crudo en texto plano (sin formato)">📄 Logs</a>
      <button type="button" class="lv-ctrl lv-ctrl-pause" data-action="pause" data-issue="${escapeHtmlAttr(issueNum)}"
              ${issueNum ? '' : 'disabled'}
              title="Pausar — enviar el issue a «Necesitan humano» (frena el re-intake automático)">⏸ Pausar</button>
      <button type="button" class="lv-ctrl lv-ctrl-restart" data-action="restart" data-issue="${escapeHtmlAttr(issueNum)}"
              ${issueNum ? '' : 'disabled'}
              title="Reiniciar — devolver el issue a la cola del pipeline para que vuelva a ejecutarse">⟳ Reiniciar</button>
    </div>`;

    return `
<section class="in-section lv-ficha-section" aria-labelledby="lv-ficha-title">
  <h2 id="lv-ficha-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">🛰️</span>Ficha del agente
    <span class="lv-section-sub">— rol, issue, fase, proveedor y estado de ejecución</span>
  </h2>
  <div class="lv-ficha" title="Datos del agente que produjo este log">
    <div class="lv-ficha-head">
      <div class="lv-ficha-rol" title="Rol del agente (skill)">
        <span class="lv-ficha-rol-dot" aria-hidden="true"></span>
        <span class="lv-ficha-rol-name">${escapeHtmlText(rol)}</span>
      </div>
      ${liveBadge}
      ${controls}
    </div>
    ${f.title ? `<div class="lv-ficha-issuettl" title="Título del issue">${escapeHtmlText(f.title)}</div>` : ''}
    <div class="lv-ficha-grid">
      <div class="lv-fcell" title="Issue de GitHub asociado"><div class="lv-fk">ISSUE</div><div class="lv-fv">${issueLink}</div></div>
      <div class="lv-fcell" title="Fase actual del pipeline"><div class="lv-fk">FASE</div><div class="lv-fv">${fase} ${estado}</div></div>
      <div class="lv-fcell" title="Proveedor LLM en uso"><div class="lv-fk">PROVEEDOR</div><div class="lv-fv">${prov}</div></div>
      <div class="lv-fcell" title="Tiempo desde que arrancó esta ejecución"><div class="lv-fk">TIEMPO EN VUELO</div><div class="lv-fv">${escapeHtmlText(tiempo)}</div></div>
      <div class="lv-fcell" title="Cantidad de rebotes de fases posteriores"><div class="lv-fk">REBOTES</div><div class="lv-fv${rebotesCls}">${escapeHtmlText(String(f.bounces))}${f.rebote ? ' <span class="lv-rebote-flag" title="El issue volvió a esta fase con motivo de rechazo">↩ rebote activo</span>' : ''}</div></div>
      <div class="lv-fcell" title="Rama de trabajo del agente"><div class="lv-fk">RAMA</div><div class="lv-fv"><code>${escapeHtmlText(f.branch)}</code></div></div>
    </div>
  </div>
</section>`;
}

// ───────────────────────── Sub-pasos con avance ─────────────────────────

function renderSubsteps(sub) {
    if (!sub || !sub.steps || !sub.steps.length) {
        return `
<section class="in-section lv-steps-section" aria-labelledby="lv-steps-title">
  <h2 id="lv-steps-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">📋</span>Sub-pasos
    <span class="lv-section-sub">— avance del plan del agente</span>
  </h2>
  <div class="lv-steps-empty" title="El agente todavía no registró sub-pasos con metadata.steps">
    Sin sub-pasos registrados todavía. Aparecen acá en cuanto el agente publica su plan con avance <code>(N/M · X%)</code>.
  </div>
</section>`;
    }
    const total = sub.steps.length;
    const completedSet = new Set(sub.completed);
    // Mostramos TODOS los sub-pasos (regla transversal: nunca truncar).
    const items = sub.steps.map((s, i) => {
        let mark, cls;
        if (completedSet.has(s) || i < sub.current) { mark = '✓'; cls = 'is-done'; }
        else if (i === sub.current) { mark = '►'; cls = 'is-current'; }
        else { mark = '○'; cls = 'is-todo'; }
        return `<li class="lv-step ${cls}"><span class="lv-step-mark" aria-hidden="true">${mark}</span><span class="lv-step-txt">${escapeHtmlText(s)}</span></li>`;
    }).join('');
    return `
<section class="in-section lv-steps-section" aria-labelledby="lv-steps-title">
  <h2 id="lv-steps-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">📋</span>Sub-pasos
    <span class="lv-section-sub">— avance del plan del agente</span>
  </h2>
  <div class="lv-steps" title="Sub-pasos del agente con avance">
    <div class="lv-steps-head">
      ${sub.subject ? `<span class="lv-steps-subject">${escapeHtmlText(sub.subject)}</span>` : ''}
      <span class="lv-steps-count">(${sub.current}/${total} · ${sub.progress}%)</span>
    </div>
    <div class="lv-steps-bar"><i style="width:${Math.max(0, Math.min(100, sub.progress))}%"></i></div>
    <ul class="lv-steps-list">${items}</ul>
  </div>
</section>`;
}

// ───────────────────────── Consola de logs en vivo ─────────────────────────

function renderConsole(f) {
    const faseTag = f.fase
        ? `<span class="lv-console-fase" title="Fase del agente para este log">${escapeHtmlText(f.fase)}</span>`
        : '';
    return `
<section class="in-section lv-console-section" aria-labelledby="lv-console-title">
  <h2 id="lv-console-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">🖥️</span>Logs en vivo
    ${faseTag}
    <span class="lv-section-sub">— timestamp · nivel · mensaje, sin truncar</span>
  </h2>
  <div class="lv-console" title="Salida del agente en vivo. Las líneas largas se muestran completas con wrap.">
    <div class="lv-toolbar">
      <div class="lv-filters" role="group" aria-label="Filtrar por nivel">
        <button type="button" class="lv-fbtn is-active" data-level="all" title="Mostrar todas las líneas">Todo</button>
        <button type="button" class="lv-fbtn" data-level="INFO" title="Mostrar sólo líneas de nivel INFO">INFO</button>
        <button type="button" class="lv-fbtn" data-level="WARN" title="Mostrar sólo advertencias y errores">WARN</button>
        <button type="button" class="lv-fbtn" data-level="TOOL" title="Mostrar sólo invocaciones y resultados de herramientas">TOOL</button>
      </div>
      <input type="text" id="lv-search" class="lv-search" placeholder="Buscar en el log…"
             aria-label="Buscar texto en el log" title="Resalta y filtra las líneas que contienen el texto">
      <button type="button" id="lv-follow" class="lv-follow is-on"
              title="«Seguir» — auto-scroll al final a medida que llegan líneas nuevas"
              aria-pressed="true">⤓ Seguir</button>
      <span class="lv-stats" id="lv-stats" title="Líneas visibles / totales">0 / 0</span>
    </div>
    <div class="lv-log-body" id="lv-log-body" tabindex="0" aria-live="polite" aria-label="Salida del log"></div>
    <div class="lv-empty" id="lv-empty">Esperando salida del agente…</div>
  </div>
</section>`;
}

// ───────────────────────── Panel de intervención (chips) ─────────────────────────

// Chips de sugerencias rápidas. Al click, rellenan el textarea del chat-panel y
// lo expanden (el chat-panel #3605 es la zona de envío real — CA-4).
const SUGGESTION_CHIPS = Object.freeze([
    'Seguí adelante, vas bien.',
    'Priorizá los criterios de aceptación del issue.',
    'Corré los tests antes de cerrar.',
    'Explicá brevemente qué estás haciendo ahora.',
    'No toques archivos fuera de tu dominio.',
]);

function renderInterventionChips() {
    if (!chatPanelMod) return '';
    const chips = SUGGESTION_CHIPS.map((c) =>
        `<button type="button" class="lv-chip" data-chip="${escapeHtmlAttr(c)}"
                 title="Insertar esta instrucción en el chat con el agente">${escapeHtmlText(c)}</button>`
    ).join('');
    return `
<section class="in-section lv-intervene-section" aria-labelledby="lv-intervene-title">
  <h2 id="lv-intervene-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">💬</span>Intervención
    <span class="lv-section-sub">— inyectá una instrucción al agente vivo sin frenarlo</span>
  </h2>
  <div class="lv-intervene" title="Sugerencias rápidas. El envío real ocurre en el chat con el agente (abajo).">
    <div class="lv-chips" role="group" aria-label="Sugerencias rápidas de instrucciones">${chips}</div>
    <p class="lv-intervene-hint">Tocá una sugerencia o abrí el chat (botón inferior, atajo <kbd>Ctrl</kbd>+<kbd>/</kbd>) para escribirle al agente. La instrucción se le inyecta sin detener su ejecución.</p>
  </div>
</section>`;
}

// ───────────────────────── CSS de la pantalla ─────────────────────────

const PANEL_CSS = `
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
/* padding-bottom deja aire para la barra colapsada del chat (50px) — sin solape */
.satellite-body { padding: 22px 28px 80px; display: flex; flex-direction: column; gap: 18px; }
.lv-section-sub { font-size: 12px; font-weight: 500; color: var(--in-fg-dim); margin-left: 8px; }
.lv-na { color: var(--in-fg-soft); font-style: italic; }

/* Banner de misión (ola): el markup mz-* y su CSS viven en ./mizpa-frame
   (MIZPA_FRAME_CSS, marco común #4236). Aca ya no se duplican esas reglas. */

/* Ficha del agente */
.lv-ficha { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 14px; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
.lv-ficha-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lv-ficha-rol { display: flex; align-items: center; gap: 8px; }
.lv-ficha-rol-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--in-info, #58a6ff); box-shadow: 0 0 0 3px color-mix(in srgb, var(--in-info, #58a6ff) 22%, transparent); }
.lv-ficha-rol-name { font-size: 16px; font-weight: 800; font-family: var(--in-mono); }
.lv-live { font-size: 11px; font-weight: 800; letter-spacing: .5px; padding: 3px 10px; border-radius: 10px;
  background: var(--in-bad-soft, rgba(248,81,73,.12)); color: var(--in-bad, #f85149); border: 1px solid var(--in-bad, #f85149); animation: lvpulse 2s infinite; }
.lv-done { font-size: 11px; font-weight: 800; letter-spacing: .5px; padding: 3px 10px; border-radius: 10px;
  background: var(--in-ok-soft, rgba(63,185,80,.12)); color: var(--in-ok, #3fb950); border: 1px solid var(--in-ok, #3fb950); }
@keyframes lvpulse { 0%,100%{opacity:1} 50%{opacity:.5} }
.lv-controls { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.lv-ctrl { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; padding: 6px 12px;
  border-radius: 9px; border: 1px solid var(--in-border); background: var(--in-bg-2); color: var(--in-fg); cursor: pointer; text-decoration: none; }
.lv-ctrl:hover:not(:disabled) { filter: brightness(1.12); border-color: var(--in-accent, #58a6ff); }
.lv-ctrl:disabled { opacity: .5; cursor: not-allowed; }
.lv-ctrl-pause:hover:not(:disabled) { border-color: var(--in-warn, #d29922); color: var(--in-warn, #d29922); }
.lv-ctrl-restart:hover:not(:disabled) { border-color: var(--in-ok, #3fb950); color: var(--in-ok, #3fb950); }
.lv-ficha-issuettl { font-size: 14px; font-weight: 600; color: var(--in-fg); }
.lv-ficha-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.lv-fcell { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 10px; padding: 10px 12px; min-width: 0; }
.lv-fk { font-size: 9.5px; font-weight: 800; letter-spacing: .6px; color: var(--in-fg-dim); }
.lv-fv { font-size: 14px; font-weight: 700; margin-top: 4px; word-break: break-word; }
.lv-fv code { font-family: var(--in-mono); font-size: 12.5px; }
.lv-val-warn { color: var(--in-warn, #d29922); }
.lv-rebote-flag { font-size: 11px; font-weight: 700; color: var(--in-warn, #d29922); }
.lv-issue-link { color: var(--in-accent, #58a6ff); text-decoration: none; font-weight: 700; }
.lv-issue-link:hover { text-decoration: underline; }
.lv-pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 8px; background: var(--in-bg-3); border: 1px solid var(--in-border); }
.lv-pill-trabajando { color: var(--in-info, #58a6ff); border-color: var(--in-info, #58a6ff); }
.lv-pill-listo { color: var(--in-ok, #3fb950); border-color: var(--in-ok, #3fb950); }

/* Sub-pasos */
.lv-steps, .lv-steps-empty { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 14px; padding: 16px 20px; }
.lv-steps-empty { font-size: 13px; color: var(--in-fg-dim); line-height: 1.5; }
.lv-steps-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.lv-steps-subject { font-size: 14px; font-weight: 700; }
.lv-steps-count { font-size: 12px; font-weight: 800; font-family: var(--in-mono); color: var(--in-accent, #58a6ff); }
.lv-steps-bar { height: 8px; border-radius: 5px; background: var(--in-bg-2); border: 1px solid var(--in-border); overflow: hidden; }
.lv-steps-bar i { display: block; height: 100%; background: var(--in-ok, #3fb950); transition: width .3s; }
.lv-steps-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lv-step { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; }
.lv-step-mark { font-weight: 800; flex: none; width: 16px; text-align: center; }
.lv-step.is-done .lv-step-mark { color: var(--in-ok, #3fb950); }
.lv-step.is-done .lv-step-txt { color: var(--in-fg-dim); text-decoration: line-through; }
.lv-step.is-current .lv-step-mark { color: var(--in-info, #58a6ff); }
.lv-step.is-current .lv-step-txt { font-weight: 700; }
.lv-step.is-todo .lv-step-mark { color: var(--in-fg-soft); }
.lv-step-txt { word-break: break-word; }

/* Consola */
.lv-console { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 14px; overflow: hidden; }
.lv-console-fase { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 8px; background: var(--in-bg-2); border: 1px solid var(--in-border); color: var(--in-fg-dim); margin-left: 8px; }
.lv-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--in-border); flex-wrap: wrap; background: var(--in-bg-2); }
.lv-filters { display: flex; gap: 6px; }
.lv-fbtn { font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--in-border); background: var(--in-bg-3); color: var(--in-fg-dim); cursor: pointer; }
.lv-fbtn:hover { color: var(--in-fg); }
.lv-fbtn.is-active { background: var(--in-accent, #58a6ff); color: #06121a; border-color: var(--in-accent, #58a6ff); }
.lv-search { flex: 1; min-width: 160px; background: var(--in-bg-3); border: 1px solid var(--in-border); color: var(--in-fg); padding: 6px 12px; border-radius: 8px; font-size: 13px; font-family: var(--in-mono); }
.lv-search:focus { outline: none; border-color: var(--in-accent, #58a6ff); }
.lv-follow { font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--in-border); background: var(--in-bg-3); color: var(--in-fg-dim); cursor: pointer; }
.lv-follow.is-on { background: var(--in-ok-soft, rgba(63,185,80,.12)); color: var(--in-ok, #3fb950); border-color: var(--in-ok, #3fb950); }
.lv-stats { font-size: 11px; color: var(--in-fg-dim); font-family: var(--in-mono); white-space: nowrap; }
.lv-log-body { height: 460px; overflow-y: auto; padding: 8px 0; font-family: var(--in-mono); font-size: 12.5px; }
.lv-log-body:focus { outline: none; }
.lv-ll { display: flex; gap: 10px; padding: 2px 16px; line-height: 1.55; }
.lv-ll:hover { background: rgba(255,255,255,.02); }
.lv-ll.is-hidden { display: none; }
.lv-ll-ts { color: var(--in-fg-soft); min-width: 64px; flex: none; opacity: .8; }
.lv-ll-lvl { font-weight: 800; min-width: 42px; flex: none; font-size: 10.5px; padding-top: 1px; letter-spacing: .4px; }
.lv-ll-lvl.is-INFO { color: var(--in-info, #58a6ff); }
.lv-ll-lvl.is-WARN { color: var(--in-warn, #d29922); }
.lv-ll-lvl.is-TOOL { color: var(--in-accent, #34d9e0); }
/* wrap completo: las líneas largas NUNCA se cortan (CA — regla transversal) */
.lv-ll-txt { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.lv-ll.is-err .lv-ll-txt { color: var(--in-bad, #f85149); }
.lv-ll.is-ok .lv-ll-txt { color: var(--in-ok, #3fb950); }
.lv-ll.is-meta .lv-ll-txt { color: var(--in-fg-dim); font-style: italic; }
.lv-hl { background: rgba(210,153,34,.35); border-radius: 2px; }
.lv-empty { padding: 22px 16px; color: var(--in-fg-dim); font-style: italic; font-size: 13px; }
.lv-empty.is-hidden { display: none; }

/* Intervención */
.lv-intervene { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 14px; padding: 16px 20px; }
.lv-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.lv-chip { font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--in-border); background: var(--in-bg-2); color: var(--in-fg); cursor: pointer; }
.lv-chip:hover { border-color: var(--in-accent, #58a6ff); color: var(--in-accent, #58a6ff); }
.lv-intervene-hint { font-size: 12px; color: var(--in-fg-dim); margin-top: 12px; line-height: 1.5; }
.lv-intervene-hint kbd { font-family: var(--in-mono); font-size: 11px; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 4px; padding: 1px 5px; }

@media (max-width: 1100px) {
  .lv-ficha-grid { grid-template-columns: 1fr; }
  .lv-controls { margin-left: 0; }
}
`;

// ───────────────────────── Client JS ─────────────────────────

// Construye el JS del browser. Sin handlers inline. `filename` ya viene
// saneado por la ruta (/logs/view/) pero igual lo embebemos vía JSON.stringify.
function buildClientJs(filename) {
    const fnJs = JSON.stringify(filename);
    return `
(function(){
  // Reloj del header.
  function tickClock(){ var c=document.getElementById('hdr-clock'); if(c) c.textContent=new Date().toLocaleTimeString('es-AR'); }
  tickClock(); setInterval(tickClock,1000);

  var bodyEl=document.getElementById('lv-log-body');
  var statsEl=document.getElementById('lv-stats');
  var emptyEl=document.getElementById('lv-empty');
  var searchEl=document.getElementById('lv-search');
  var followBtn=document.getElementById('lv-follow');
  if(!bodyEl) return;

  var lines=[];            // {ts, level, text, kind}
  var follow=true;
  var filter='all';
  var term='';

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function fmtTs(iso){ try{ if(!iso) return ''; return new Date(iso).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }catch(_){ return ''; } }

  // Clasifica una línea cruda en {ts, level, text, kind}. level ∈ INFO|WARN|TOOL.
  // NO trunca el texto: las líneas largas se muestran completas (wrap en CSS).
  function classifyText(t){
    if(/error|exception|fail|❌|CRASH|panic/i.test(t)) return {level:'WARN',kind:'err'};
    if(/warn|⚠|WARNING/i.test(t)) return {level:'WARN',kind:''};
    if(/✓|passed|success|✔|APROBADO/i.test(t)) return {level:'INFO',kind:'ok'};
    return {level:'INFO',kind:''};
  }

  function parseOne(raw){
    if(raw==null) return null;
    if(typeof raw!=='string'||!raw.trim()) return null;
    if(raw[0]!=='{'){ var c=classifyText(raw); return [{ts:'',level:c.level,text:raw,kind:c.kind}]; }
    var ev; try{ ev=JSON.parse(raw); }catch(_){ return [{ts:'',level:'INFO',text:raw,kind:''}]; }
    var ts=fmtTs(ev.timestamp||(ev.message&&ev.message.timestamp)||'');
    var out=[];
    if(ev.type==='system'){
      if(ev.subtype==='init') out.push({ts:ts,level:'INFO',text:'[init] modelo: '+(ev.model||'?'),kind:'meta'});
      else if(ev.subtype==='task_started') out.push({ts:ts,level:'TOOL',text:'[task] '+(ev.description||''),kind:''});
      else out.push({ts:ts,level:'INFO',text:'[system] '+(ev.subtype||''),kind:'meta'});
    } else if(ev.type==='assistant'){
      var msg=ev.message; if(!msg||!msg.content) return null;
      for(var i=0;i<msg.content.length;i++){
        var cc=msg.content[i];
        if(cc.type==='thinking'&&cc.thinking) out.push({ts:ts,level:'INFO',text:'[pensando] '+cc.thinking,kind:'meta'});
        if(cc.type==='text'&&cc.text) out.push({ts:ts,level:'INFO',text:cc.text,kind:''});
        if(cc.type==='tool_use'){
          var inp=cc.input||{}; var detail=inp.command||inp.pattern||inp.file_path||(inp.skill?(inp.skill+(inp.args?' '+inp.args:'')):'')||inp.query||inp.prompt||'';
          out.push({ts:ts,level:'TOOL',text:'['+(cc.name||'?')+'] '+detail,kind:''});
        }
      }
    } else if(ev.type==='user'){
      var um=ev.message; if(!um||!um.content) return null;
      for(var j=0;j<um.content.length;j++){
        var u=um.content[j];
        if(u.type==='tool_result'){
          var txt=typeof u.content==='string'?u.content:'';
          if(!txt) continue;
          if(u.is_error) out.push({ts:ts,level:'WARN',text:'[error] '+txt,kind:'err'});
          else out.push({ts:ts,level:'TOOL',text:'[resultado] '+txt,kind:''});
        }
      }
    } else if(ev.type==='result'){
      var cost=ev.cost_usd?(' $'+ev.cost_usd.toFixed(4)):''; var dur=ev.duration_ms?(' '+Math.round(ev.duration_ms/1000)+'s'):'';
      out.push({ts:ts,level:'INFO',text:'[fin]'+cost+dur,kind:'ok'});
    } else if(ev.type==='rate_limit_event'){ return null; }
    else { return null; }
    return out.length?out:null;
  }

  function matches(l){
    if(filter!=='all'&&l.level!==filter) return false;
    if(term&&l.text.toLowerCase().indexOf(term)===-1) return false;
    return true;
  }

  function highlight(html){
    if(!term) return html;
    var low=html.toLowerCase(),out='',last=0,idx=low.indexOf(term);
    while(idx!==-1){ out+=html.substring(last,idx)+'<span class="lv-hl">'+html.substring(idx,idx+term.length)+'</span>'; last=idx+term.length; idx=low.indexOf(term,last); }
    return out+html.substring(last);
  }

  function rowHtml(l,i){
    var hidden=matches(l)?'':' is-hidden';
    var kindCls=l.kind==='err'?' is-err':l.kind==='ok'?' is-ok':l.kind==='meta'?' is-meta':'';
    var txt=term?highlight(esc(l.text)):esc(l.text);
    return '<div class="lv-ll'+kindCls+hidden+'" data-i="'+i+'"><span class="lv-ll-ts">'+esc(l.ts)+'</span>'
      +'<span class="lv-ll-lvl is-'+l.level+'">'+l.level+'</span><span class="lv-ll-txt">'+txt+'</span></div>';
  }

  function updateStats(){
    var vis=bodyEl.querySelectorAll('.lv-ll:not(.is-hidden)').length;
    statsEl.textContent=vis+' / '+lines.length+' líneas';
    if(emptyEl) emptyEl.classList.toggle('is-hidden', lines.length>0);
  }

  function scrollBottom(){ bodyEl.scrollTop=bodyEl.scrollHeight; }

  function renderAll(){
    var h=''; for(var i=0;i<lines.length;i++) h+=rowHtml(lines[i],i);
    bodyEl.innerHTML=h; updateStats(); if(follow) scrollBottom();
  }

  function appendRows(newOnes){
    var start=lines.length;
    for(var i=0;i<newOnes.length;i++) lines.push(newOnes[i]);
    var frag=document.createDocumentFragment();
    for(var j=0;j<newOnes.length;j++){
      var d=document.createElement('div'); d.innerHTML=rowHtml(newOnes[j],start+j).trim();
      frag.appendChild(d.firstChild);
    }
    bodyEl.appendChild(frag); updateStats(); if(follow) scrollBottom();
  }

  function process(rawLines){
    var acc=[];
    for(var i=0;i<rawLines.length;i++){ var r=parseOne(rawLines[i]); if(r) for(var k=0;k<r.length;k++) acc.push(r[k]); }
    return acc;
  }

  // Filtros por nivel.
  var fbtns=document.querySelectorAll('.lv-fbtn');
  for(var b=0;b<fbtns.length;b++){ (function(btn){ btn.addEventListener('click',function(){
    filter=btn.getAttribute('data-level');
    for(var x=0;x<fbtns.length;x++) fbtns[x].classList.toggle('is-active',fbtns[x]===btn);
    renderAll();
  }); })(fbtns[b]); }

  // Buscador.
  if(searchEl) searchEl.addEventListener('input',function(){ term=(searchEl.value||'').toLowerCase(); renderAll(); });

  // «Seguir» (auto-scroll).
  if(followBtn) followBtn.addEventListener('click',function(){
    follow=!follow; followBtn.classList.toggle('is-on',follow); followBtn.setAttribute('aria-pressed',follow?'true':'false');
    if(follow) scrollBottom();
  });
  bodyEl.addEventListener('scroll',function(){
    var atBottom=bodyEl.scrollHeight-bodyEl.scrollTop-bodyEl.clientHeight<50;
    if(!atBottom&&follow){ follow=false; followBtn.classList.remove('is-on'); followBtn.setAttribute('aria-pressed','false'); }
  });

  // SSE — tail del log (el server redacta secrets antes de emitir).
  try{
    var sse=new EventSource('/logs/stream/'+encodeURIComponent(${fnJs}));
    sse.onmessage=function(e){
      try{ var m=JSON.parse(e.data);
        if(m.type==='init'){ lines=process(m.lines||[]); renderAll(); }
        else if(m.type==='append'){ appendRows(process(m.lines||[])); }
      }catch(_){}
    };
    sse.onerror=function(){ /* fin de stream: el badge LIVE/Finalizado ya refleja el estado */ };
  }catch(_){ if(emptyEl) emptyEl.textContent='No se pudo abrir el stream del log.'; }

  // Controles de la ficha: Pausar / Reiniciar (endpoints existentes).
  document.addEventListener('click',function(ev){
    var t=ev.target.closest?ev.target.closest('[data-action]'):null; if(!t) return;
    var action=t.getAttribute('data-action'); var issue=t.getAttribute('data-issue'); if(!issue) return;
    if(action==='pause'){
      var reason=prompt('Pausar #'+issue+' — motivo (opcional, Enter para omitir):',''); if(reason===null) return;
      t.disabled=true;
      fetch('/api/needs-human/'+encodeURIComponent(issue)+'/block',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:reason||'',source:'dashboard:log-viewer'})})
        .then(function(r){return r.json();}).then(function(j){ t.disabled=false; if(j&&j.ok){ t.textContent='⏸ Pausado'; } else { alert('Error pausando: '+((j&&j.msg)||'desconocido')); } })
        .catch(function(e){ t.disabled=false; alert('Error pausando: '+e.message); });
    } else if(action==='restart'){
      if(!confirm('Reiniciar #'+issue+'? Volverá a la cola del pipeline.')) return;
      t.disabled=true;
      fetch('/api/needs-human/'+encodeURIComponent(issue)+'/reactivate',{method:'POST'})
        .then(function(r){return r.json();}).then(function(j){ t.disabled=false; if(j&&j.ok){ t.textContent='⟳ Reiniciado'; } else { alert('Error reiniciando: '+((j&&j.msg)||'desconocido')); } })
        .catch(function(e){ t.disabled=false; alert('Error reiniciando: '+e.message); });
    }
  });

  // Chips de intervención → rellenan el textarea del chat-panel y lo expanden.
  document.addEventListener('click',function(ev){
    var chip=ev.target.closest?ev.target.closest('.lv-chip'):null; if(!chip) return;
    var txt=chip.getAttribute('data-chip')||'';
    var input=document.getElementById('chat-input'); var toggle=document.getElementById('chat-toggle'); var panel=document.getElementById('chat-panel');
    if(panel&&panel.classList.contains('is-collapsed')&&toggle) toggle.click();
    if(input){ input.value=txt; input.dispatchEvent(new Event('input',{bubbles:true})); setTimeout(function(){ try{ input.focus(); }catch(_){} },60); }
  });
})();`;
}

// ───────────────────────── Render principal ─────────────────────────

/**
 * @param {string} filename  nombre saneado del log (ya validado por la ruta).
 * @param {boolean} isLive
 * @param {object} [ctx]  { issueData?: object }  inyectado por dashboard.js.
 * @returns {string} HTML completo de la pantalla.
 */
function renderLogViewer(filename, isLive, ctx) {
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('pipeline');
    const brandHtml = renderBrandBar();
    const wave = collectWave();
    const ficha = buildAgentFicha(filename, isLive, ctx || {});

    // Panel de chat (#3605) — best-effort.
    let chatBundle = null;
    if (chatPanelMod && chatPanelMod.buildChatPanel && ficha.issue && ficha.skill) {
        try {
            chatBundle = chatPanelMod.buildChatPanel({
                logFile: filename,
                issue: ficha.issue,
                skill: ficha.skill,
                fase: ficha.fase || '',
            });
        } catch { chatBundle = null; }
    }

    const issueCrumb = ficha.issue ? ('#' + escapeHtmlText(ficha.issue)) : '#—';
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Pipeline › Issues de la ola › este issue">
    <span class="mz-crumb-sep">Pipeline</span>
    <span class="mz-crumb-sep">▸</span>
    <span class="mz-crumb-sep">Issues de la ola</span>
    <span class="mz-crumb-sep">▸</span>
    <b>${issueCrumb}</b>
    <span class="mz-crumb-desc">· logs en vivo e intervención del agente</span>
  </div>`;

    const titleTxt = ficha.issue ? ('#' + ficha.issue + ' · ' + (ficha.skill || 'log')) : (filename || 'log');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Logs ${escapeHtmlText(titleTxt)}</title>
<style>${tokens}</style>
<style>${theme}</style>
<style>${MIZPA_FRAME_CSS}</style>
<style>${PANEL_CSS}</style>
${chatBundle ? `<style>${chatBundle.css}</style>` : ''}
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
${chatBundle ? chatBundle.sprite : ''}
<div class="satellite-frame">
  <header class="in-header">
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${navHtml}
  ${breadcrumb}
  <main class="satellite-body">
    ${renderMissionBanner(wave)}
    ${renderFicha(ficha)}
    ${renderSubsteps(ficha.substeps)}
    ${renderConsole(ficha)}
    ${renderInterventionChips()}
  </main>
  <footer class="in-footer">
    <span>Los logs se redactan server-side (secrets → [REDACTED]) · la intervención no detiene al agente</span>
    <span>Intrale · MIZPÁ · #4191</span>
  </footer>
</div>
${chatBundle ? chatBundle.html : ''}
<script>${buildClientJs(filename)}</script>
${chatBundle ? `<script>${chatBundle.js}</script>` : ''}
</body>
</html>`;
}

/**
 * Render inerte (CA-A3): visible si el render principal falla aguas arriba.
 * dashboard.js además cae al viewer legacy; esto es la segunda red.
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Logs</title><style>${tokens}</style><style>${theme}</style></head>
<body><main style="padding:32px;max-width:800px;margin:0 auto">
<h1>Visor de logs no disponible</h1>
<p>${safe}</p>
<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3).</p>
</main></body></html>`;
}

module.exports = {
    renderLogViewer,
    renderInert,
    // Para tests / reuso.
    buildAgentFicha,
    collectWave,
    collectProvider,
    collectSubsteps,
    renderMissionBanner,
    renderFicha,
    renderSubsteps,
    renderConsole,
    renderInterventionChips,
    prettyModel,
    fmtDuration,
    shortFase,
    slug: 'logs',
};

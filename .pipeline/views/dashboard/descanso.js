// V3 Descanso — calendario semanal de gating de skills LLM.
// Extraído de satellites.js (#3736, padre #3715). Toda la hidratación es
// client-side vía fetch('/api/rest-mode') cada 8s — el SSR sólo emite la
// estructura + textos hardcodeados. No depende del monolito en demolición
// (dashboard.js / satellites.js); replica el shell de pageShell inline,
// siguiendo el patrón ya usado por home.js y multi-provider.js.
//
// Validación cliente de overlap/HH:MM/cap (MAX_PERIODS_PER_DAY) duplicada
// deliberadamente respecto de lib/rest-mode-schedule.js (FE-SEC-1 / SEC-9):
// el cliente NUNCA confía en su validación, siempre hace round-trip a
// POST /api/rest-mode (audit en rest-mode-audit.jsonl, SEC-A03). NO se
// consolida en este split — es decisión arquitectónica del #2890 PR-A.

'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada (renderNavTabsSsr + loadIconSprite del cache
// compartido del sprite.svg). Misma dependencia que home.js / satellites.js.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #4245 (Ola 7.1) — DESCANSO adopta el marco común MIZPÁ. Se reutiliza el
// helper compartido `renderMissionBanner` de la HOME (#4189) — el banner de ola
// común (② del marco: tag OLA + título + métricas + bloque AVANCE) — en vez de
// duplicar su markup (CA-5). Espeja lo que hizo EQUIPO (#4240). Degradación
// defensiva: si el módulo no carga, el slot del banner queda vacío y el resto
// del marco (① marca + ③ nav + ④ contenido) sigue intacto.
let homeView = null;
try { homeView = require('./home'); } catch (_) { /* sin banner de ola común */ }

// #3722 — Escape HTML server-side unificado (lib/escape-html.js, cierra #2901).
// CA-B3: las ventanas extraídas usan el helper compartido en vez de duplicar
// un escapeHtmlSsr inline. escapeHtmlAttr cubre el contexto atributo
// (& < > " ' `), que es donde el SSR de Descanso interpola opts.tz opcional.
const { escapeHtmlAttr } = require('../../lib/escape-html.js');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2, banner stale + CSRF) y
// framework de modal de confirmación con preview (CA-3) que reemplaza confirm().
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

// #3964 (EP8-H11) — Geometría pura del timeline (min↔px, snap, blockRect,
// wouldOverlap), unit-testeable sin DOM. Se inyecta como `RestTimelineGeo`
// (IIFE namespaced) en el script cliente, evitando colisiones de identificadores
// con los helpers ya declarados en este mismo `<script>`.
const { REST_TIMELINE_GEOMETRY_JS } = require('./rest-timeline-geometry.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Defensa en profundidad (CA-D1). El único valor dinámico que el SSR puede
// interpolar es `opts.tz` (deep-link prefill del input de zona horaria); todo
// lo demás se hidrata client-side. Delegamos al helper compartido en contexto
// atributo. Si en el futuro se interpola algún campo más, DEBE pasar por acá.
function escapeHtmlSsr(s) {
    if (s == null) return '';
    return escapeHtmlAttr(s);
}

// Snippet JS compartido por todas las vistas satélite (fmt*, fetchJson,
// setText, escapeHtml cliente, showToast, tickHeader del header pill, etc.).
// Copia verbatim de satellites.commonHelpers() — se prepende al script del
// cliente igual que hacía pageShell, para no depender del monolito.
const COMMON_HELPERS = `
function fmtDur(ms){ if(!ms||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60), r=s%60; if(m<60) return m+'m '+r+'s'; const h=Math.floor(m/60), rm=m%60; return h+'h '+rm+'m'; }
function fmtNum(n){ if(n==null||isNaN(n)) return '—'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtPct(n){ return n==null?'—':n.toFixed(1)+'%'; }
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }

const SKILL_ICONS = {
    'android-dev':'📱','backend-dev':'⚡','web-dev':'🌐','pipeline-dev':'🔧',
    ux:'🎨', po:'📋', planner:'📐',
    guru:'🧙', security:'🔒', tester:'🧪', qa:'✅', review:'👁',
    linter:'🧹', build:'🛠', delivery:'🚚', commander:'🎖'
};
const SKILL_COLORS = {
    'android-dev':'#58a6ff','backend-dev':'#3fb950','web-dev':'#79c0ff','pipeline-dev':'#a371f7',
    ux:'#f778ba', po:'#d29922', planner:'#a371f7',
    guru:'#58a6ff', security:'#f85149', tester:'#d2a8ff', qa:'#3fb950', review:'#ffa657',
    linter:'#8b949e', build:'#ffa657', delivery:'#2ee6c1', commander:'#f778ba'
};

// #3045 — cache compartido entre tickHeader y tickPipeline para evitar un
// segundo round-trip y mantener fuera de localStorage un estado que vive 5s.
// Se sanea acá para que cualquier consumidor reciba ya integers > 0
// (defensa en profundidad sobre lo que enforza headerSlice server-side).
let pipelineModeState = { mode: 'running', allowedIssues: [] };
function _saneAllowedIssues(arr){
    if(!Array.isArray(arr)) return [];
    const out = [];
    for(const v of arr){
        const n = Number(v);
        if(Number.isInteger(n) && n > 0) out.push(n);
    }
    return out;
}

async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
    // #3045 — actualizar el cache compartido ANTES del render del modePill,
    // así el render del próximo tickPipeline (que puede dispararse en paralelo)
    // ya ve el estado fresco.
    pipelineModeState = {
        mode: d.mode || 'running',
        allowedIssues: _saneAllowedIssues(d.allowedIssues),
    };
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial · '+pipelineModeState.allowedIssues.length+' issues'; }
        else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
    }
    // #3045 — Si el filtro de allowlist está montado en la Pipeline view,
    // refrescar su visibilidad cuando cambia el modo (running ⇄ partial_pause).
    if(typeof refreshAllowlistToggleVisibility === 'function'){
        try { refreshAllowlistToggleVisibility(); } catch{}
    }
}

// ─── Acciones (importadas del dashboard legacy) ───
// Los endpoints POST viven en dashboard.js; el cliente solo los invoca.
// Refresh tras la acción: forzar tick inmediato sin recargar la página
// para preservar el patrón anti-flicker.

function showToast(msg, ok){
    let t = document.getElementById('in-toast');
    if(!t){
        t = document.createElement('div');
        t.id = 'in-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,0.4);transition:opacity 0.3s,transform 0.3s;opacity:0;color:#fff';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok===false ? 'var(--in-bad)' : (ok===true ? 'var(--in-ok)' : 'var(--in-brand)');
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(8px)'; }, 3500);
}

async function killAgent(issue, skill, pipeline, fase, durationMs){
    // CA-2 / SEC-2 — preview con fase + tiempo y POST con token CSRF (killAgentPost).
    const preview = [{label:'Skill', value:skill},{label:'Issue', value:'#'+issue}];
    if(fase) preview.push({label:'Fase', value:fase});
    if(durationMs != null) preview.push({label:'Tiempo invertido', value:fmtDur(durationMs)});
    if(!(await inConfirm({ title:'Cancelar agente', message:'Se cancelará el agente en curso. Esta acción no se puede deshacer.', confirmLabel:'Cancelar agente', preview:preview }))) return;
    try{
        const r = await killAgentPost({issue, skill, pipeline, fase});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente cancelado':'Falló la cancelación'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function killSkillGroup(skill, agents){
    if(!agents || !agents.length) return;
    if(!(await inConfirm({ title:'Cancelar todos los agentes', message:'Se cancelarán todos los agentes activos de este skill.', confirmLabel:'Cancelar todos', preview:[{label:'Skill', value:skill},{label:'Activos', value:String(agents.length)}] }))) return;
    let ok=0, fail=0;
    for(const a of agents){
        try{
            const r = await killAgentPost({issue: a.issue, skill: a.skill, pipeline: a.pipeline, fase: a.fase});
            const j = await r.json();
            if(j.ok) ok++; else fail++;
        } catch{ fail++; }
    }
    showToast(skill+': '+ok+' cancelados'+(fail>0?', '+fail+' fallaron':''), fail===0);
    if(typeof runAll === 'function') setTimeout(runAll, 600);
}

async function nhReactivate(issue){
    // Pedir indicaciones para el agente. prompt() permite multi-línea pegando texto.
    // Si el operador acepta sin texto, sigue (compat con el flujo viejo).
    // Si cancela (null), abortar.
    const guidance = prompt(
        '¿Reactivar #'+issue+'?\\n\\n' +
        'Indicaciones para el agente (opcional — se pasan como contexto al prompt y se postean en el issue):\\n' +
        'Ej: "Usar la API REST en vez de gh CLI", "Ignorar el rebase conflict, ya está limpio", etc.',
        ''
    );
    if(guidance === null) return; // cancel
    try{
        const r = await fetch('/api/needs-human/'+issue+'/reactivate', {
            method: 'POST',
            headers: Object.assign({'Content-Type':'application/json'}, nhCsrfHeaders()),
            body: JSON.stringify({ guidance: guidance.trim() }),
        });
        const j = await r.json();
        showToast(j.msg || (j.ok?'Reactivado':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function nhDismiss(issue){
    const reason = prompt('Razón para desestimar #'+issue+' (opcional):') || '';
    if(reason === null) return;
    try{
        const r = await fetch('/api/needs-human/'+issue+'/dismiss', {method:'POST', headers:Object.assign({'Content-Type':'application/json'}, nhCsrfHeaders()), body: JSON.stringify({reason})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Desestimado':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function moveIssue(issue, direction){
    try{
        const r = await fetch('/api/issue/'+issue+'/'+direction, {method:'POST', headers: nhCsrfHeaders()});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Movido':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 400);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function pauseIssue(issue, paused){
    const verb = paused ? 'Reanudar' : 'Pausar';
    if(!(await inConfirm({ title:verb+' issue', message:(paused ? 'Quita el label blocked:dependencies y vuelve a la cola del pipeline.' : 'Agrega el label blocked:dependencies; el pulpo lo saltea hasta reanudar.'), confirmLabel:verb, danger: !paused, preview:[{label:'Issue', value:'#'+issue},{label:'Acción', value:verb}] }))) return;
    try{
        const r = await fetch('/api/issue/'+issue+'/'+(paused?'resume':'pause'), {method:'POST', headers: nhCsrfHeaders()});
        const j = await r.json();
        showToast(j.msg || (j.ok?(paused?'Reanudado':'Pausado'):'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && typeof runAll === 'function') runAll(); });
`;

// Genera las tres piezas estructurales (body HTML + CSS scoped + script
// cliente). Copia directa de satellites.renderModoDescanso() sin el wrapper
// pageShell(). Mantener en sync con lib/rest-mode-schedule.js (ver cabecera).
function buildParts() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🌙</span>Modo descanso · calendario semanal</h2>
  <p class="rm-hint-text">
    Durante los periodos configurados, sólo corren los <strong>skills determinísticos</strong>
    (delivery, builder, linter, tester). El resto se queda en cola y arranca al cerrar el periodo.
    Los issues con label <code>priority:critical</code> hacen bypass del gate.
  </p>
  <!-- CA-4 (#4200) — Banner de misión: diagnostica la ventana actual, las horas
       de descanso/semana, la próxima apertura y qué quedó en cola por descanso.
       Lo hidrata renderStatus() client-side (createElement + textContent). -->
  <div id="rm-status" class="rm-status rm-mission" role="status" aria-live="polite">…</div>
  <form id="rm-form" class="rm-form" novalidate>
    <div class="rm-row">
      <label class="rm-label">
        <input type="checkbox" id="rm-active"
               title="Si destildás, el pipeline opera sin restricciones (CA-1.9)"
               aria-label="Activar modo descanso — si destildás, el pipeline opera sin restricciones"> <strong>Activar modo descanso</strong>
      </label>
      <span class="rm-hint">Si destildás, el pipeline opera sin restricciones (CA-1.9).</span>
    </div>
    <div class="rm-row rm-row-tz">
      <label>
        <span class="rm-label-text">Zona horaria</span>
        <input type="text" id="rm-timezone" placeholder="America/Argentina/Buenos_Aires" list="rm-tz-list">
        <datalist id="rm-tz-list"></datalist>
      </label>
    </div>
    <div class="rm-legend" aria-hidden="false">
      <span class="rm-legend-item"><span class="rm-legend-swatch rm-legend-rest"></span>Descanso</span>
      <span class="rm-legend-item"><span class="rm-legend-swatch rm-legend-ghost"></span>Creando…</span>
      <span class="rm-legend-item"><span class="rm-legend-swatch rm-legend-now"></span>Ahora</span>
      <span class="rm-legend-hint">Arrastrá en una columna para crear · mové o redimensioná un bloque · snap 30 min.</span>
    </div>
    <!-- CA-1/CA-2/CA-10 — Timeline 7 días × 24 h. Conserva id="rm-grid" +
         data-rm-editing para el patrón anti-flicker de tickRestMode. -->
    <section class="rm-timeline" id="rm-grid" data-rm-editing="0" aria-label="Timeline semanal de periodos de descanso — arrastrá para crear o editar bloques">
      <!-- eje + 7 columnas inyectados por buildTimeline() -->
    </section>
    <div class="rm-errors-box" id="rm-errors" hidden></div>
    <!-- CA-9 — Fallback editable por teclado: la grilla de inputs time previa
         se conserva bajo el timeline para no regresar en accesibilidad. -->
    <details class="rm-fallback" id="rm-fallback">
      <summary class="rm-fallback-summary">⌨ Edición precisa por teclado</summary>
      <section class="rm-grid" id="rm-fallback-grid" aria-label="Edición por teclado de periodos de descanso">
        <!-- 7 columnas inyectadas por buildFallbackGrid() -->
      </section>
    </details>
    <div class="rm-row rm-actions">
      <button type="submit" class="in-btn rm-save" id="rm-save"
              title="Hot-reload sin reinicio del pipeline. El backend revalida la grilla."
              aria-label="Guardar configuración — hot-reload sin reinicio del pipeline">💾 Guardar configuración</button>
      <span id="rm-error-count" class="rm-error-count"></span>
      <span id="rm-msg" class="rm-msg"></span>
    </div>
  </form>
  <!-- CA-6 — Preview read-only: próximo descanso + qué skills pausaría.
       Datos computados server-side (wouldPauseSkills); render con textContent. -->
  <section class="rm-preview" id="rm-preview" aria-label="Preview del próximo descanso" hidden>
    <div class="rm-preview-head">
      <span class="rm-preview-icon">🔭</span>
      <span class="rm-preview-title" id="rm-preview-title">Próximo descanso</span>
    </div>
    <div class="rm-preview-body">
      <p class="rm-preview-line"><strong>Cuándo:</strong> <span id="rm-preview-when">—</span></p>
      <p class="rm-preview-line"><strong>Pausaría:</strong></p>
      <div class="rm-preview-skills" id="rm-preview-skills"></div>
    </div>
  </section>
  <div class="rm-meta">
    <p><strong>Bypass labels</strong> (read-only, viven en <code>config.yaml</code>) — estos issues no se pausan:</p>
    <div class="rm-chips" id="rm-bypass" aria-label="Labels de bypass del modo descanso"></div>
    <p><strong>Última actualización:</strong> <span id="rm-updated">—</span></p>
  </div>
</section>`;
    const css = `
/* CA-8.8: todos los colores vienen de design tokens. Cero hardcoded. */
.rm-hint-text { color: var(--in-fg-dim); font-size: 12px; margin: 0 0 14px 0; }
.rm-status { padding: 12px 16px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-border); background: var(--in-bg-3); margin-bottom: 16px; font-size: 13px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rm-status.rm-active { border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); background: var(--rest-mode-bg, rgba(124,92,255,0.16)); }
.rm-status.rm-inactive { color: var(--in-fg-dim); }
.rm-status-icon { font-size: 16px; }
.rm-status-text { display: flex; flex-direction: column; gap: 2px; }
.rm-status-title { font-weight: 600; }
.rm-status-sub { font-size: 11px; color: var(--in-fg-soft); }

/* ===== Banner de misión MIZPÁ (CA-4 #4200) — diagnóstico de ventanas ===== */
/* Hereda los tonos púrpura del modo descanso ya usados por las hermanas; cero
   colores nuevos fuera de las vars --in-* / --rest-mode-*. */
.rm-mission { display: flex; align-items: stretch; gap: 18px; padding: 16px 20px; border-radius: 14px; overflow: hidden; position: relative; flex-wrap: wrap;
  background: linear-gradient(110deg, rgba(124,92,255,.16), rgba(124,92,255,.05) 48%, transparent 78%), var(--in-bg-2, #11151E);
  border: 1px solid rgba(124,92,255,.30); }
.rm-mission.rm-inactive { background: var(--in-bg-3); border-color: var(--in-border); }
.rm-mission-tag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 104px; padding: 12px 14px; border-radius: 13px;
  background: linear-gradient(135deg, rgba(124,92,255,.26), rgba(124,92,255,.12)); border: 1px solid rgba(124,92,255,.40); }
.rm-mission.rm-inactive .rm-mission-tag { background: rgba(255,255,255,.04); border-color: var(--in-border); }
.rm-mission-tag-ico { font-size: 30px; line-height: 1; }
.rm-mission-tag-lbl { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; margin-top: 7px; text-align: center; color: var(--rest-mode-fg, #C5B7FF); text-transform: uppercase; }
.rm-mission.rm-inactive .rm-mission-tag-lbl { color: var(--in-fg-soft); }
.rm-mission-text { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 5px; }
.rm-mission-ttl { font-size: 17px; font-weight: 800; color: var(--in-fg, #e6edf3); line-height: 1.25; }
.rm-mission-desc { font-size: 12.5px; color: var(--in-fg-dim, #8A93A6); line-height: 1.45; max-width: 560px; }
.rm-mission-metrics { display: flex; gap: 10px; flex-wrap: wrap; align-items: stretch; }
.rm-mission-tile { flex: 1 1 130px; min-width: 120px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border, rgba(255,255,255,.08)); border-radius: 11px; padding: 9px 12px; }
.rm-mission-tile-k { font-size: 9px; font-weight: 800; letter-spacing: .6px; color: var(--in-fg-soft, #5B6376); text-transform: uppercase; }
.rm-mission-tile-v { font-size: 16px; font-weight: 800; margin-top: 4px; line-height: 1.15; color: var(--in-fg, #e6edf3); font-variant-numeric: tabular-nums; }
.rm-mission-tile-s { font-size: 10.5px; color: var(--in-fg-dim, #8A93A6); margin-top: 3px; line-height: 1.3; }
@media (max-width: 900px) { .rm-mission { flex-direction: column; } .rm-mission-metrics { width: 100%; } }

.rm-form { display: flex; flex-direction: column; gap: 14px; }
.rm-row { display: flex; flex-direction: column; gap: 6px; }
.rm-row-tz { max-width: 360px; }
.rm-row label { font-size: 12px; color: var(--in-fg); display: flex; flex-direction: column; gap: 4px; }
.rm-label { flex-direction: row !important; align-items: center; gap: 8px !important; }
.rm-label-text { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); letter-spacing: 0.5px; }
.rm-hint { font-size: 11px; color: var(--in-fg-soft); }
.rm-form input[type="time"], .rm-form input[type="text"] { padding: 7px 9px; background: var(--in-bg); color: var(--in-fg); border: 1px solid var(--in-border); border-radius: 4px; font-family: var(--in-mono); font-size: 12px; }
.rm-form input:focus { outline: none; border-color: var(--in-accent); }

/* Grid semanal (CA-8.1). */
.rm-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 6px 0; }
.rm-col { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); background: var(--in-bg-3); min-height: 180px; }
.rm-col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding-bottom: 6px; border-bottom: 1px dashed var(--in-border); }
.rm-col-day { font-size: 12px; font-weight: 600; color: var(--in-fg); text-transform: uppercase; letter-spacing: 0.5px; }
.rm-col-count { font-size: 11px; color: var(--in-fg-soft); font-family: var(--in-mono); }
.rm-col-count.rm-col-count-full { color: var(--warning, #D29922); }
.rm-col-empty { font-size: 11px; color: var(--in-fg-soft); padding: 16px 6px; text-align: center; font-style: italic; }
.rm-period { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--in-border); border-radius: 4px; background: var(--in-bg); }
.rm-period.rm-period-active { border-color: rgba(124,92,255,0.55); background: var(--rest-mode-bg, rgba(124,92,255,0.16)); }
.rm-period.rm-period-error { border-color: var(--danger, #F85149); background: rgba(248,81,73,0.08); }
.rm-period-inputs { display: flex; align-items: center; gap: 4px; }
.rm-period-inputs input[type="time"] { padding: 4px 6px; font-size: 11px; flex: 1; min-width: 0; }
.rm-period-dash { color: var(--in-fg-soft); font-size: 11px; }
.rm-period-remove { background: transparent; border: 1px solid var(--in-border); color: var(--in-fg-dim); padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px; line-height: 1; }
.rm-period-remove:hover { color: var(--danger, #F85149); border-color: var(--danger, #F85149); }
.rm-period-caption { font-size: 10px; color: var(--in-fg-soft); display: flex; align-items: center; gap: 4px; }
.rm-period-caption.rm-period-caption-cross { color: var(--rest-mode-fg, #C5B7FF); }
.rm-period-error-msg { font-size: 10px; color: var(--danger, #F85149); margin-top: 2px; }
.rm-col-add { background: transparent; border: 1px dashed var(--in-border); color: var(--in-fg-dim); padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-family: inherit; margin-top: auto; }
.rm-col-add:hover:not(:disabled) { border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); }
.rm-col-add:disabled { opacity: 0.4; cursor: not-allowed; }

.rm-errors-box { padding: 10px 12px; border-radius: 4px; border: 1px solid var(--danger, #F85149); background: rgba(248,81,73,0.08); color: var(--danger, #F85149); font-size: 12px; }
.rm-errors-box ul { margin: 4px 0 0 0; padding-left: 18px; }
.rm-errors-box li { margin: 2px 0; }
.rm-error-count { font-size: 12px; color: var(--danger, #F85149); }
.rm-error-count:empty { display: none; }

.rm-actions { flex-direction: row !important; align-items: center; gap: 14px; padding-top: 8px; flex-wrap: wrap; }
.rm-save { background: var(--rest-mode-bg, rgba(124,92,255,0.16)); border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); padding: 8px 16px; }
.rm-save:hover:not(:disabled) { filter: brightness(1.18); }
.rm-save:disabled { opacity: 0.4; cursor: not-allowed; }
.rm-msg { font-size: 12px; color: var(--in-fg-dim); }
.rm-msg.rm-ok { color: var(--in-ok); }
.rm-msg.rm-err { color: var(--in-bad); }
.rm-meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--in-border); font-size: 12px; color: var(--in-fg-dim); }
.rm-meta p { margin: 4px 0; }
.rm-meta code { font-family: var(--in-mono); background: var(--in-bg-3); padding: 1px 6px; border-radius: 3px; }

/* ===== Timeline 7×24 (CA-1/CA-2/CA-3/CA-4) — colores 100% desde tokens ===== */
.rm-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--in-fg-dim); margin: 4px 0 8px 0; }
.rm-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.rm-legend-swatch { width: 14px; height: 10px; border-radius: 2px; border: 1px solid var(--in-border); display: inline-block; }
.rm-legend-rest { background: var(--rest-mode-bg, rgba(124,92,255,0.16)); border-color: rgba(124,92,255,0.55); }
.rm-legend-ghost { background: repeating-linear-gradient(45deg, rgba(124,92,255,0.30), rgba(124,92,255,0.30) 3px, transparent 3px, transparent 6px); border-style: dashed; }
.rm-legend-now { background: var(--danger, #F85149); height: 0; border: 0; border-top: 2px dashed var(--danger, #F85149); }
.rm-legend-hint { color: var(--in-fg-soft); }

.rm-timeline { display: grid; grid-template-columns: 40px repeat(7, minmax(0, 1fr)); gap: 0; border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); background: var(--in-bg-3); overflow: hidden; touch-action: none; }
.rm-tl-axis, .rm-tl-col { position: relative; }
.rm-tl-axis { border-right: 1px solid var(--in-border); }
.rm-tl-col { border-right: 1px solid var(--in-border); cursor: crosshair; }
.rm-tl-col:last-child { border-right: 0; }
.rm-tl-head { height: 26px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--in-fg); border-bottom: 1px solid var(--in-border); background: var(--in-bg); }
.rm-tl-head.rm-tl-head-today { color: var(--rest-mode-fg, #C5B7FF); }
.rm-tl-axis .rm-tl-head { background: var(--in-bg); }
.rm-tl-body { position: relative; }
.rm-tl-hourline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--in-border); pointer-events: none; opacity: 0.5; }
.rm-tl-hourlabel { position: absolute; right: 4px; font-size: 9px; font-family: var(--in-mono); color: var(--in-fg-soft); transform: translateY(-50%); pointer-events: none; }
.rm-tl-block { position: absolute; left: 2px; right: 2px; border-radius: 3px; background: var(--rest-mode-bg, rgba(124,92,255,0.16)); border: 1px solid rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); font-size: 9px; overflow: hidden; cursor: grab; box-sizing: border-box; user-select: none; }
.rm-tl-block:active { cursor: grabbing; }
.rm-tl-block.rm-tl-block-error { background: rgba(248,81,73,0.12); border-color: var(--danger, #F85149); color: var(--danger, #F85149); }
.rm-tl-block-label { padding: 2px 4px; font-family: var(--in-mono); line-height: 1.2; pointer-events: none; }
.rm-tl-block-handle { position: absolute; left: 0; right: 0; height: 10px; cursor: ns-resize; }
.rm-tl-block-handle-top { top: -4px; }
.rm-tl-block-handle-bottom { bottom: -4px; }
.rm-tl-ghost { position: absolute; left: 2px; right: 2px; border-radius: 3px; background: repeating-linear-gradient(45deg, rgba(124,92,255,0.30), rgba(124,92,255,0.30) 4px, transparent 4px, transparent 8px); border: 1px dashed rgba(124,92,255,0.75); pointer-events: none; box-sizing: border-box; }
.rm-tl-ghost.rm-tl-ghost-blocked { background: repeating-linear-gradient(45deg, rgba(248,81,73,0.28), rgba(248,81,73,0.28) 4px, transparent 4px, transparent 8px); border-color: var(--danger, #F85149); }
.rm-tl-now { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--danger, #F85149); pointer-events: none; z-index: 3; }
.rm-tl-now-pill { position: absolute; right: 2px; top: -8px; font-size: 8px; font-family: var(--in-mono); background: var(--danger, #F85149); color: #fff; padding: 0 3px; border-radius: 2px; }

/* ===== Preview próximo descanso (CA-6) ===== */
.rm-preview { margin-top: 16px; padding: 12px 14px; border: 1px solid rgba(124,92,255,0.40); border-radius: var(--in-radius-sm); background: var(--rest-mode-bg, rgba(124,92,255,0.10)); }
.rm-preview-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rm-preview-title { font-weight: 600; font-size: 13px; color: var(--rest-mode-fg, #C5B7FF); }
.rm-preview-body { font-size: 12px; color: var(--in-fg); }
.rm-preview-line { margin: 2px 0; }
.rm-preview-skills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }

/* ===== Chips (bypass + preview) — XSS-safe via textContent (CA-7) ===== */
.rm-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.rm-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-family: var(--in-mono); border: 1px solid var(--in-border); background: var(--in-bg-3); color: var(--in-fg-dim); cursor: default; }
.rm-chip-bypass { border-color: rgba(210,153,34,0.55); background: var(--quota-degraded, rgba(210,153,34,0.14)); color: var(--warning, #D29922); }
.rm-chip-pause { border-color: rgba(124,92,255,0.40); }
.rm-chip-empty { font-style: italic; color: var(--in-fg-soft); border-style: dashed; }

/* ===== Fallback de edición por teclado (CA-9) ===== */
.rm-fallback { margin-top: 14px; border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); background: var(--in-bg-3); }
.rm-fallback-summary { cursor: pointer; padding: 8px 12px; font-size: 12px; color: var(--in-fg-dim); user-select: none; }
.rm-fallback[open] .rm-fallback-summary { border-bottom: 1px dashed var(--in-border); }
.rm-fallback .rm-grid { padding: 12px; margin: 0; }

/* Mobile: el grid de 7 columnas se transforma en lista vertical. */
@media (max-width: 900px) {
    .rm-grid { grid-template-columns: 1fr; }
    .rm-col { min-height: 0; }
    .rm-timeline { grid-template-columns: 32px repeat(7, minmax(0, 1fr)); }
}`;
    const script = `
// nota: validacion cliente solo UX, backend revalida en POST /api/rest-mode (FE-SEC-2).
// Este script espeja la logica de .pipeline/lib/rest-mode-schedule.js — si una
// vuelve a cambiar, actualizar la otra. Tests del helper cubren los casos.
const TZ_DEFAULTS = ['America/Argentina/Buenos_Aires','UTC','America/New_York','America/Mexico_City','America/Sao_Paulo','Europe/Madrid','Europe/London'];
const DAY_KEYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_LABELS = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mié', thursday: 'Jue', friday: 'Vie', saturday: 'Sáb', sunday: 'Dom' };
const DAY_KEY_TO_DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DOW_TO_DAY_KEY = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MAX_PERIODS_PER_DAY = 24;  // SEC-2 espejo (backend revalida).
const HHMM_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;
const FULL_DAY_START = '00:00';
const FULL_DAY_END = '23:59';
const MIN_PER_DAY = 1440;
const MIN_PER_WEEK = 10080;

// Estado in-memory del editor. NO se sincroniza con el servidor mientras el
// usuario está editando (CA-8.7). Cada vez que el usuario suelta el último
// input, se setea un debounce de 3s para liberar el "lock" de edición.
let scheduleState = makeEmptySchedule();
let editingTimer = null;
let bypassLabelsState = [];
let updatedAtState = null;

// #3964 (EP8-H11) — estado del timeline. nowLocalState/wouldPauseSkillsState se
// hidratan del slice server-side (CA-4/CA-6); NO se computan con Date() del
// browser (evita mismatch de TZ). tlGesture mantiene el arrastre en curso.
let nowLocalState = null;
let restSliceState = null;
let wouldPauseSkillsState = [];
const TL_PX_PER_HOUR = 28;   // alto de cada hora en px → 24h = 672px.
const TL_SNAP_MIN = 30;      // resolución de snap del arrastre (CA-2).
let tlGesture = null;        // { kind:'create'|'move'|'resize', day, idx, ... }

function makeEmptySchedule(){
    return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
}

function hhmmToMin(hhmm){
    if(typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null;
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

function isFullDay(p){ return p && p.start === FULL_DAY_START && p.end === FULL_DAY_END; }

function crossesMidnight(p){
    if(isFullDay(p)) return false;
    const s = hhmmToMin(p.start);
    const e = hhmmToMin(p.end);
    return s !== null && e !== null && s > e;
}

function expandPeriod(dayKey, p){
    const dow = DAY_KEY_TO_DOW[dayKey];
    if(dow == null) return [];
    const base = ((dow + 6) % 7) * MIN_PER_DAY;
    const sMin = hhmmToMin(p.start);
    const eMin = hhmmToMin(p.end);
    if(sMin === null || eMin === null) return [];
    if(isFullDay(p)) return [{ startAbs: base, endAbs: base + MIN_PER_DAY }];
    if(sMin < eMin) return [{ startAbs: base + sMin, endAbs: base + eMin }];
    return [
        { startAbs: base + sMin, endAbs: base + MIN_PER_DAY },
        { startAbs: (base + MIN_PER_DAY) % MIN_PER_WEEK, endAbs: ((base + MIN_PER_DAY) % MIN_PER_WEEK) + eMin },
    ];
}

function intervalsOverlap(a, b){
    const split = (iv) => iv.endAbs <= MIN_PER_WEEK
        ? [iv]
        : [{ startAbs: iv.startAbs, endAbs: MIN_PER_WEEK }, { startAbs: 0, endAbs: iv.endAbs - MIN_PER_WEEK }];
    const as = split(a);
    const bs = split(b);
    for(const ai of as){
        for(const bi of bs){
            if(ai.startAbs < bi.endAbs && bi.startAbs < ai.endAbs) return true;
        }
    }
    return false;
}

// Devuelve un objeto { errors: string[], perPeriod: Map<dayKey+idx, errMsg[]> }.
// La validación NO bloquea el submit por sí sola — eso lo decide el caller
// (CA-8.4); pero sí pinta los periodos en rojo y deshabilita "Guardar" mientras
// haya errores. nota: solo UX, backend revalida.
function validateScheduleClient(schedule){
    const errors = [];
    const perPeriod = {};
    function tag(day, idx, msg){
        const k = day + ':' + idx;
        if(!perPeriod[k]) perPeriod[k] = [];
        perPeriod[k].push(msg);
    }

    // Validación por-periodo (HH:MM, SEC-4) y cap (SEC-2).
    for(const day of DAY_KEYS){
        const list = schedule[day] || [];
        if(list.length > MAX_PERIODS_PER_DAY){
            errors.push(DAY_LABELS[day] + ': máximo 24 periodos/día (recibidos ' + list.length + ')');
        }
        for(let i = 0; i < list.length; i++){
            const p = list[i];
            if(!p || typeof p !== 'object'){ tag(day, i, 'Periodo inválido'); continue; }
            if(!HHMM_RE.test(p.start || '')) tag(day, i, 'Hora de inicio inválida');
            if(!HHMM_RE.test(p.end || ''))   tag(day, i, 'Hora de fin inválida');
            if(perPeriod[day + ':' + i]) continue;
            if(p.start === p.end && !isFullDay(p)){
                tag(day, i, 'Hora de inicio y fin no pueden ser iguales (salvo 00:00–23:59 = día completo)');
            }
        }
    }

    // Overlap absoluto en la semana (SEC-3).
    const expanded = [];
    for(const day of DAY_KEYS){
        const list = schedule[day] || [];
        for(let i = 0; i < list.length; i++){
            if(perPeriod[day + ':' + i]) continue; // periodos ya rotos no entran al overlap
            const ivs = expandPeriod(day, list[i]);
            for(const iv of ivs) expanded.push({ day, idx: i, period: list[i], iv });
        }
    }
    const seen = {};
    for(let i = 0; i < expanded.length; i++){
        for(let j = i + 1; j < expanded.length; j++){
            const a = expanded[i], b = expanded[j];
            if(a.day === b.day && a.idx === b.idx) continue;
            if(!intervalsOverlap(a.iv, b.iv)) continue;
            const k1 = a.day + ':' + a.idx + '<->' + b.day + ':' + b.idx;
            const k2 = b.day + ':' + b.idx + '<->' + a.day + ':' + a.idx;
            if(seen[k1] || seen[k2]) continue;
            seen[k1] = 1;
            tag(a.day, a.idx, 'Solapa con ' + DAY_LABELS[b.day] + ' ' + b.period.start + '–' + b.period.end);
            tag(b.day, b.idx, 'Solapa con ' + DAY_LABELS[a.day] + ' ' + a.period.start + '–' + a.period.end);
            if(a.day === b.day){
                errors.push(DAY_LABELS[a.day] + ': solapamiento entre ' + a.period.start + '–' + a.period.end + ' y ' + b.period.start + '–' + b.period.end);
            } else {
                errors.push(DAY_LABELS[a.day] + ' ' + a.period.start + '–' + a.period.end + ' solapa con ' + DAY_LABELS[b.day] + ' ' + b.period.start + '–' + b.period.end + ' (cruza medianoche)');
            }
        }
    }

    return { errors, perPeriod };
}

// ----- Render del grid usando createElement + textContent (CA-XSS, FE-SEC-1) -----

function clearChildren(el){ while(el.firstChild) el.removeChild(el.firstChild); }

function makeEl(tag, opts){
    const el = document.createElement(tag);
    if(opts){
        if(opts.cls){ el.className = opts.cls; }
        if(opts.text != null){ el.textContent = String(opts.text); }
        if(opts.attrs){ for(const k in opts.attrs){ el.setAttribute(k, String(opts.attrs[k])); } }
    }
    return el;
}

// CA-9 — Grilla de inputs time como FALLBACK editable por teclado (vive en el
// <details> bajo el timeline). Comparte scheduleState con el timeline.
function buildFallbackGrid(){
    const grid = document.getElementById('rm-fallback-grid');
    if(!grid) return;
    clearChildren(grid);
    const validation = validateScheduleClient(scheduleState);
    for(const day of DAY_KEYS){
        const list = scheduleState[day] || [];
        const col = makeEl('div', { cls: 'rm-col', attrs: { 'data-day': day } });

        const head = makeEl('div', { cls: 'rm-col-head' });
        head.appendChild(makeEl('span', { cls: 'rm-col-day', text: DAY_LABELS[day] }));
        const countCls = list.length >= MAX_PERIODS_PER_DAY ? 'rm-col-count rm-col-count-full' : 'rm-col-count';
        head.appendChild(makeEl('span', { cls: countCls, text: list.length + '/' + MAX_PERIODS_PER_DAY }));
        col.appendChild(head);

        if(list.length === 0){
            col.appendChild(makeEl('div', { cls: 'rm-col-empty', text: '○ Sin descanso' }));
        } else {
            for(let i = 0; i < list.length; i++){
                col.appendChild(buildPeriodRow(day, i, list[i], validation.perPeriod[day + ':' + i] || []));
            }
        }

        const addBtn = makeEl('button', { cls: 'rm-col-add', text: '+ Periodo', attrs: { 'aria-label': 'Agregar periodo (máximo 24 por día)' } });
        addBtn.type = 'button';
        addBtn.title = 'Máximo 24 periodos por día';
        addBtn.disabled = list.length >= MAX_PERIODS_PER_DAY;
        addBtn.addEventListener('click', () => {
            scheduleState[day] = (scheduleState[day] || []).concat([{ start: '22:00', end: '07:00' }]);
            markEditing();
            renderEditor();
        });
        col.appendChild(addBtn);

        grid.appendChild(col);
    }
    refreshErrorsBox(validation.errors);
}

function buildPeriodRow(day, idx, period, periodErrors){
    const row = makeEl('div', { cls: 'rm-period' + (periodErrors.length ? ' rm-period-error' : '') });

    const inputs = makeEl('div', { cls: 'rm-period-inputs' });
    const startIn = document.createElement('input');
    startIn.type = 'time';
    startIn.value = period.start || '';
    startIn.setAttribute('data-rm-input', 'start');
    startIn.addEventListener('input', () => {
        scheduleState[day][idx].start = startIn.value;
        markEditing();
        renderEditor();
    });
    const dash = makeEl('span', { cls: 'rm-period-dash', text: '–' });
    const endIn = document.createElement('input');
    endIn.type = 'time';
    endIn.value = period.end || '';
    endIn.setAttribute('data-rm-input', 'end');
    endIn.addEventListener('input', () => {
        scheduleState[day][idx].end = endIn.value;
        markEditing();
        renderEditor();
    });
    inputs.appendChild(startIn);
    inputs.appendChild(dash);
    inputs.appendChild(endIn);

    const removeBtn = makeEl('button', { cls: 'rm-period-remove', text: '✕', attrs: { 'aria-label': 'Eliminar periodo', 'title': 'Eliminar periodo' } });
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
        scheduleState[day].splice(idx, 1);
        markEditing();
        renderEditor();
    });
    inputs.appendChild(removeBtn);

    row.appendChild(inputs);

    // Caption visual: día completo / cruza medianoche / intra-día normal.
    if(isFullDay(period)){
        row.appendChild(makeEl('div', { cls: 'rm-period-caption', text: '☀ Día completo' }));
    } else if(crossesMidnight(period)){
        row.appendChild(makeEl('div', { cls: 'rm-period-caption rm-period-caption-cross', text: '🌙 Cruza medianoche · +1 día' }));
    }

    // Errores por-periodo (FE-SEC-1: textContent, no innerHTML).
    for(const msg of periodErrors){
        row.appendChild(makeEl('div', { cls: 'rm-period-error-msg', text: '⚠ ' + msg }));
    }

    return row;
}

function refreshErrorsBox(errors){
    const box = document.getElementById('rm-errors');
    const count = document.getElementById('rm-error-count');
    const saveBtn = document.getElementById('rm-save');
    if(!box || !count || !saveBtn) return;
    clearChildren(box);
    if(errors.length === 0){
        box.hidden = true;
        count.textContent = '';
        saveBtn.disabled = false;
        return;
    }
    box.hidden = false;
    box.appendChild(makeEl('div', { text: 'Errores de validación de cliente (nota: el backend revalida igual):' }));
    const ul = makeEl('ul');
    for(const e of errors){ ul.appendChild(makeEl('li', { text: e })); }
    box.appendChild(ul);
    count.textContent = errors.length + ' error' + (errors.length === 1 ? '' : 'es');
    saveBtn.disabled = true;
}

// ----- Marcador data-rm-editing (CA-8.7 + FE-SEC-3) -----
function markEditing(){
    const grid = document.getElementById('rm-grid');
    if(grid) grid.setAttribute('data-rm-editing', '1');
    if(editingTimer) clearTimeout(editingTimer);
    editingTimer = setTimeout(() => {
        const g = document.getElementById('rm-grid');
        if(g) g.setAttribute('data-rm-editing', '0');
        editingTimer = null;
    }, 3000);
}

// ===========================================================================
// Timeline 7×24 (CA-1/CA-2/CA-3/CA-4) — render posicionado + pointer events.
// Toda la geometría (min↔px, snap, blockRect, wouldOverlap) viene de
// RestTimelineGeo (módulo puro inyectado). El overlap del cliente es SOLO UX:
// el backend revalida en setWindow (FE-SEC-2).
// ===========================================================================

function makeChip(text, cls, title){
    const chip = makeEl('span', { cls: cls || 'rm-chip', text: text });
    if(title) chip.title = title;  // tooltip por atributo (textContent-safe, CA-7)
    return chip;
}

function nextPeriodText(np){
    if(!np || !np.start) return '—';
    const whenLabels = { today: 'hoy', tomorrow: 'mañana' };
    const dayLbl = DAY_LABELS[np.when] || whenLabels[np.when] || (np.when || '');
    return (dayLbl ? dayLbl + ' ' : '') + np.start + (np.end ? '–' + np.end : '');
}

function pointerMinInBody(body, clientY){
    const rect = body.getBoundingClientRect();
    let min = RestTimelineGeo.yToMin(clientY - rect.top, TL_PX_PER_HOUR);
    if(min < 0) min = 0;
    if(min > 1440) min = 1440;
    return min;
}

// Resuelve el .rm-tl-body vivo del día desde el DOM actual. CRÍTICO para
// move/resize: buildTimeline() reconstruye la grilla en cada frame (clearChildren
// + nodos nuevos), por lo que la referencia cacheada en tlGesture.body queda
// DESCONECTADA del DOM tras el primer frame y su getBoundingClientRect() pasa a
// devolver top:0 → los minutos se computarían en coordenadas de viewport y el
// bloque saltaría. Re-resolver el body fresco en cada pointermove mantiene la
// geometría relativa correcta (y es robusto ante scroll durante el arrastre).
function liveTimelineBody(day){
    const tl = document.getElementById('rm-grid');
    if(!tl || !tl.querySelector) return null;
    return tl.querySelector('.rm-tl-body[data-day="' + day + '"]');
}

function setPeriodMinutes(day, idx, sMin, eMin){
    const list = scheduleState[day];
    if(!list || !list[idx]) return;
    const s = ((Math.round(sMin) % 1440) + 1440) % 1440;
    const e = ((Math.round(eMin) % 1440) + 1440) % 1440;
    list[idx] = { start: RestTimelineGeo.minToHhmm(s), end: RestTimelineGeo.minToHhmm(e) };
}

function flashTimelineError(msg){
    setMsg('✗ ' + msg, 'err');
    if(typeof showToast === 'function') showToast(msg, false);
}

function buildTimelineBlock(day, idx, period, rect, isError){
    const b = makeEl('div', { cls: 'rm-tl-block' + (isError ? ' rm-tl-block-error' : '') });
    b.style.top = rect.top + 'px';
    b.style.height = Math.max(rect.height, 6) + 'px';
    b.setAttribute('data-day', day);
    b.setAttribute('data-idx', String(idx));
    b.setAttribute('title', period.start + '–' + period.end + (rect.crossesMidnight ? ' (cruza medianoche)' : ''));
    const arrow = rect.crossesMidnight ? (rect.segment === 'head' ? ' ↧' : ' ↥') : '';
    b.appendChild(makeEl('div', { cls: 'rm-tl-block-label', text: period.start + '–' + period.end + arrow }));
    // Handles de resize sólo en el segmento principal (no en la cola del cruce).
    if(rect.segment !== 'tail'){
        b.appendChild(makeEl('div', { cls: 'rm-tl-block-handle rm-tl-block-handle-top', attrs: { 'data-handle': 'top', 'aria-hidden': 'true' } }));
        b.appendChild(makeEl('div', { cls: 'rm-tl-block-handle rm-tl-block-handle-bottom', attrs: { 'data-handle': 'bottom', 'aria-hidden': 'true' } }));
    }
    b.addEventListener('pointerdown', (ev) => onBlockPointerDown(ev, day, idx));
    return b;
}

function attachColumnPointer(body, day){
    body.addEventListener('pointerdown', (ev) => {
        if(ev.target && ev.target.closest && ev.target.closest('.rm-tl-block')) return;
        ev.preventDefault();
        const startMin = RestTimelineGeo.snapMin(pointerMinInBody(body, ev.clientY), TL_SNAP_MIN);
        tlGesture = { kind: 'create', day: day, body: body, anchorMin: startMin, curMin: startMin };
        markEditing();
        startGestureListeners();
        renderGhost();
    });
}

function onBlockPointerDown(ev, day, idx){
    ev.preventDefault();
    ev.stopPropagation();
    const body = ev.currentTarget.parentNode;
    const handle = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-handle') : null;
    const period = (scheduleState[day] || [])[idx];
    if(!period) return;
    const sMin = RestTimelineGeo.hhmmToMin(period.start);
    const eMin = RestTimelineGeo.hhmmToMin(period.end);
    if(sMin === null || eMin === null) return;
    if(handle === 'top' || handle === 'bottom'){
        tlGesture = { kind: 'resize', day: day, idx: idx, body: body, edge: handle, startS: sMin, startE: eMin };
    } else {
        tlGesture = { kind: 'move', day: day, idx: idx, body: body, grabMin: pointerMinInBody(body, ev.clientY), startS: sMin, startE: eMin };
    }
    markEditing();
    startGestureListeners();
}

function startGestureListeners(){
    document.addEventListener('pointermove', onGesturePointerMove);
    document.addEventListener('pointerup', onGesturePointerUp);
    document.addEventListener('pointercancel', onGesturePointerUp);
}
function stopGestureListeners(){
    document.removeEventListener('pointermove', onGesturePointerMove);
    document.removeEventListener('pointerup', onGesturePointerUp);
    document.removeEventListener('pointercancel', onGesturePointerUp);
}

function onGesturePointerMove(ev){
    const g = tlGesture;
    if(!g) return;
    markEditing();
    if(g.kind === 'create'){
        g.curMin = RestTimelineGeo.snapMin(pointerMinInBody(g.body, ev.clientY), TL_SNAP_MIN);
        renderGhost();
        return;
    }
    if(g.kind === 'move'){
        // Body vivo del DOM (no g.body cacheado: queda stale tras buildTimeline).
        const body = liveTimelineBody(g.day) || g.body;
        const cur = pointerMinInBody(body, ev.clientY);
        const delta = RestTimelineGeo.snapMin(cur - g.grabMin, TL_SNAP_MIN);
        const dur = ((g.startE - g.startS) + 1440) % 1440;
        const ns = ((g.startS + delta) % 1440 + 1440) % 1440;
        setPeriodMinutes(g.day, g.idx, ns, ns + dur);
        buildTimeline();
        g.body = liveTimelineBody(g.day) || g.body;  // re-cachear el body fresco
        return;
    }
    if(g.kind === 'resize'){
        const body = liveTimelineBody(g.day) || g.body;
        const cur = RestTimelineGeo.snapMin(pointerMinInBody(body, ev.clientY), TL_SNAP_MIN);
        let ns = g.startS, ne = g.startE;
        if(g.edge === 'top') ns = cur; else ne = cur;
        if(ns === ne) return;  // no permitir duración nula durante el drag
        setPeriodMinutes(g.day, g.idx, ns, ne);
        buildTimeline();
        g.body = liveTimelineBody(g.day) || g.body;  // re-cachear el body fresco
        return;
    }
}

function onGesturePointerUp(){
    const g = tlGesture;
    stopGestureListeners();
    tlGesture = null;
    removeGhost();
    if(!g) return;
    markEditing();
    if(g.kind === 'create'){
        const a = Math.min(g.anchorMin, g.curMin);
        const b = Math.max(g.anchorMin, g.curMin);
        if(b - a < TL_SNAP_MIN){ renderEditor(); return; }  // click sin arrastre real
        if((scheduleState[g.day] || []).length >= MAX_PERIODS_PER_DAY){
            flashTimelineError('Máximo 24 periodos por día'); renderEditor(); return;
        }
        const candidate = { start: RestTimelineGeo.minToHhmm(a), end: RestTimelineGeo.minToHhmm(b === 1440 ? 1439 : b) };
        if(RestTimelineGeo.wouldOverlap(scheduleState, g.day, candidate)){
            flashTimelineError('Se solaparía con otro bloque'); renderEditor(); return;
        }
        scheduleState[g.day] = (scheduleState[g.day] || []).concat([candidate]);
        setMsg('Bloque creado · revisá y guardá.');
        renderEditor();
        return;
    }
    if(g.kind === 'move' || g.kind === 'resize'){
        const cand = (scheduleState[g.day] || [])[g.idx];
        if(cand && RestTimelineGeo.wouldOverlap(scheduleState, g.day, cand, g.idx)){
            setPeriodMinutes(g.day, g.idx, g.startS, g.startE);  // CA-3: revertir overlap
            flashTimelineError('Se solaparía — cambio revertido');
        }
        renderEditor();
        return;
    }
}

function renderGhost(){
    removeGhost();
    const g = tlGesture;
    if(!g || g.kind !== 'create') return;
    const a = Math.min(g.anchorMin, g.curMin);
    const b = Math.max(g.anchorMin, g.curMin);
    const ghost = makeEl('div', { cls: 'rm-tl-ghost' });
    ghost.id = 'rm-tl-ghost';
    ghost.style.top = RestTimelineGeo.minToY(a, TL_PX_PER_HOUR) + 'px';
    ghost.style.height = Math.max(RestTimelineGeo.minToY(b - a, TL_PX_PER_HOUR), 2) + 'px';
    const cand = { start: RestTimelineGeo.minToHhmm(a), end: RestTimelineGeo.minToHhmm(b === 1440 ? 1439 : b) };
    if(b - a >= TL_SNAP_MIN && RestTimelineGeo.wouldOverlap(scheduleState, g.day, cand)){
        ghost.classList.add('rm-tl-ghost-blocked');
    }
    ghost.appendChild(makeEl('div', { cls: 'rm-tl-block-label', text: cand.start + '–' + cand.end }));
    g.body.appendChild(ghost);
}
function removeGhost(){
    const el = document.getElementById('rm-tl-ghost');
    if(el && el.parentNode) el.parentNode.removeChild(el);
}

function buildTimeline(){
    const tl = document.getElementById('rm-grid');
    if(!tl) return;
    clearChildren(tl);
    const validation = validateScheduleClient(scheduleState);
    const colHeight = 24 * TL_PX_PER_HOUR;

    // Columna 0: eje de horas.
    const axis = makeEl('div', { cls: 'rm-tl-axis' });
    axis.appendChild(makeEl('div', { cls: 'rm-tl-head', text: 'h' }));
    const axisBody = makeEl('div', { cls: 'rm-tl-body' });
    axisBody.style.height = colHeight + 'px';
    for(let h = 0; h <= 24; h += 3){
        const lab = makeEl('div', { cls: 'rm-tl-hourlabel', text: (h < 10 ? '0' + h : '' + h) + ':00' });
        lab.style.top = (h * TL_PX_PER_HOUR) + 'px';
        axisBody.appendChild(lab);
    }
    axis.appendChild(axisBody);
    tl.appendChild(axis);

    const todayKey = nowLocalState && nowLocalState.dayKey;
    for(const day of DAY_KEYS){
        const col = makeEl('div', { cls: 'rm-tl-col', attrs: { 'data-day': day } });
        col.appendChild(makeEl('div', { cls: (day === todayKey ? 'rm-tl-head rm-tl-head-today' : 'rm-tl-head'), text: DAY_LABELS[day] }));
        const body = makeEl('div', { cls: 'rm-tl-body', attrs: { 'data-day': day } });
        body.style.height = colHeight + 'px';

        for(let h = 1; h < 24; h++){
            const line = makeEl('div', { cls: 'rm-tl-hourline' });
            line.style.top = (h * TL_PX_PER_HOUR) + 'px';
            body.appendChild(line);
        }

        const list = scheduleState[day] || [];
        for(let i = 0; i < list.length; i++){
            const isErr = (validation.perPeriod[day + ':' + i] || []).length > 0;
            const rects = RestTimelineGeo.blockRect(list[i], TL_PX_PER_HOUR);
            for(const r of rects){
                body.appendChild(buildTimelineBlock(day, i, list[i], r, isErr));
            }
        }

        // Marcador "ahora" (CA-4) — sólo en la columna del día local del server.
        if(day === todayKey && nowLocalState && typeof nowLocalState.minuteOfDay === 'number'){
            const now = makeEl('div', { cls: 'rm-tl-now' });
            now.style.top = RestTimelineGeo.minToY(nowLocalState.minuteOfDay, TL_PX_PER_HOUR) + 'px';
            const within = restSliceState && restSliceState.isWithinNow;
            now.appendChild(makeEl('div', { cls: 'rm-tl-now-pill', text: (within ? '🌙 ' : '') + (nowLocalState.hhmm || '') }));
            body.appendChild(now);
        }

        attachColumnPointer(body, day);
        col.appendChild(body);
        tl.appendChild(col);
    }
}

// CA-6 — Preview read-only del próximo descanso + qué skills pausaría.
function renderPreview(){
    const box = document.getElementById('rm-preview');
    if(!box) return;
    const np = restSliceState && restSliceState.nextPeriod;
    const active = restSliceState && restSliceState.active;
    if(!active || !np){ box.hidden = true; return; }
    box.hidden = false;
    const when = document.getElementById('rm-preview-when');
    if(when) when.textContent = nextPeriodText(np);
    const skillsBox = document.getElementById('rm-preview-skills');
    if(skillsBox){
        clearChildren(skillsBox);
        const skills = Array.isArray(wouldPauseSkillsState) ? wouldPauseSkillsState : [];
        if(!skills.length){
            skillsBox.appendChild(makeChip('(ninguno se pausaría)', 'rm-chip rm-chip-empty'));
        } else {
            for(const s of skills){ skillsBox.appendChild(makeChip(s, 'rm-chip rm-chip-pause')); }
        }
    }
}

// CA-7 — Bypass labels como chips con tooltip del porqué. Read-only desde
// config; tooltip por atributo title (textContent-safe, nunca innerHTML).
function renderBypassChips(labels){
    const box = document.getElementById('rm-bypass');
    if(!box) return;
    clearChildren(box);
    const list = Array.isArray(labels) ? labels : [];
    if(!list.length){
        box.appendChild(makeChip('(ninguno)', 'rm-chip rm-chip-empty'));
        return;
    }
    for(const l of list){
        box.appendChild(makeChip(l, 'rm-chip rm-chip-bypass',
            'Los issues con el label "' + l + '" hacen bypass del gate: siguen corriendo durante los periodos de descanso. Read-only (config.yaml).'));
    }
}

// Render maestro del editor: timeline + fallback por teclado + preview.
function renderEditor(){
    buildTimeline();
    buildFallbackGrid();
    renderPreview();
}

// ----- Banner de misión (#rm-status) y bypass labels -----

// CA-4 (#4200) — horas de descanso por semana, computadas desde scheduleState.
// No hay campo server-side para esto; se deriva de los periodos ya cargados
// usando expandPeriod (mismo cálculo que la validación de overlap). Los periodos
// válidos no se solapan, así que la suma directa no doble-cuenta. Se acota a la
// semana completa (10080 min) por defensa.
function weeklyRestStats(){
    let total = 0;
    for(const day of DAY_KEYS){
        for(const p of (scheduleState[day] || [])){
            for(const iv of expandPeriod(day, p)){
                const dur = iv.endAbs - iv.startAbs;
                if(dur > 0) total += dur;
            }
        }
    }
    if(total > MIN_PER_WEEK) total = MIN_PER_WEEK;
    const pct = Math.round((total / MIN_PER_WEEK) * 1000) / 10;  // 1 decimal
    const h = Math.floor(total / 60);
    const m = total % 60;
    return { totalMin: total, pct: pct, label: (m ? h + 'h ' + m + 'm' : h + 'h') };
}

// Tile de métrica del banner (clave + valor + subtítulo). XSS-safe (textContent).
function missionTile(parent, key, value, sub){
    const tile = makeEl('div', { cls: 'rm-mission-tile' });
    tile.appendChild(makeEl('div', { cls: 'rm-mission-tile-k', text: key }));
    tile.appendChild(makeEl('div', { cls: 'rm-mission-tile-v', text: value }));
    if(sub != null && sub !== '') tile.appendChild(makeEl('div', { cls: 'rm-mission-tile-s', text: sub }));
    parent.appendChild(tile);
}

// CA-4 (#4200) — Banner de misión: lee el estado y lo cuenta en lenguaje natural.
// Diagnostica ventana actual, horas/semana, próxima apertura y cola por descanso
// (skills LLM gateados). Reusa el slice describeRestModeNow (payload.restMode) y
// computa horas/semana desde scheduleState. Todo XSS-safe (createElement +
// textContent, nunca innerHTML — FE-SEC-1). El llamador debe sincronizar
// scheduleState ANTES (ver tickRestMode) para que las horas reflejen el último
// schedule del server.
function renderStatus(payload){
    const status = document.getElementById('rm-status');
    if(!status) return;
    clearChildren(status);
    status.classList.remove('rm-active','rm-inactive');
    const rm = (payload && payload.window) || {};
    const slice = (payload && payload.restMode) || {};
    const cur = slice.currentPeriod;
    const next = slice.nextPeriod;
    const within = !!slice.isWithinNow;
    const wk = weeklyRestStats();
    const gated = Array.isArray(payload && payload.wouldPauseSkills) ? payload.wouldPauseSkills : [];

    // --- Lectura automática del estado: tag + título + descripción ---
    let tagIco, tagLbl, title, desc;
    if(!rm.active){
        status.classList.add('rm-inactive');
        tagIco = '○'; tagLbl = 'Apagado';
        title = 'Modo descanso apagado';
        desc = 'El pipeline opera sin restricciones horarias. Activá el modo descanso y cargá ventanas en el calendario para programar reposo.';
    } else {
        status.classList.add('rm-active');
        if(within && cur && cur.end){
            tagIco = '🌙'; tagLbl = 'Descansando';
            title = 'Estás en una ventana de descanso · termina ' + cur.end;
            desc = 'Sólo corren los skills determinísticos (delivery, builder, linter, tester). '
                 + (gated.length ? gated.length + ' skill' + (gated.length === 1 ? '' : 's') + ' LLM esperan que se cierre la ventana.' : 'Ningún skill LLM quedó en cola.');
        } else if(next && next.start){
            tagIco = '☀'; tagLbl = 'Operativo';
            title = 'Pipeline operativo · próxima ventana ' + nextPeriodText(next);
            desc = 'Todos los skills corren con normalidad. Al abrir la próxima ventana se pausan los skills LLM y siguen sólo los determinísticos.';
        } else {
            tagIco = '☀'; tagLbl = 'Sin ventanas';
            title = 'Modo descanso activo, sin ventanas configuradas';
            desc = 'No hay periodos de descanso cargados todavía. Arrastrá sobre el calendario para crear una ventana (snap 30 min).';
        }
    }

    const tag = makeEl('div', { cls: 'rm-mission-tag' });
    tag.appendChild(makeEl('div', { cls: 'rm-mission-tag-ico', text: tagIco }));
    tag.appendChild(makeEl('div', { cls: 'rm-mission-tag-lbl', text: tagLbl }));
    status.appendChild(tag);

    const textBox = makeEl('div', { cls: 'rm-mission-text' });
    textBox.appendChild(makeEl('div', { cls: 'rm-mission-ttl', text: title }));
    textBox.appendChild(makeEl('div', { cls: 'rm-mission-desc', text: desc }));
    status.appendChild(textBox);

    const metrics = makeEl('div', { cls: 'rm-mission-metrics' });
    // Ventana actual
    if(within && cur && cur.end){
        missionTile(metrics, 'Ventana actual', '🌙 ' + (cur.start || '') + '–' + cur.end, 'en descanso');
    } else if(rm.active){
        missionTile(metrics, 'Ventana actual', '○ Operativo', 'sin ventana activa');
    } else {
        missionTile(metrics, 'Ventana actual', '— Off', 'sin restricciones');
    }
    // Horas de descanso por semana (CA-4)
    missionTile(metrics, 'Descanso / semana', wk.label, wk.pct + '% de la semana');
    // Próxima apertura de ventana (CA-4)
    missionTile(metrics, 'Próxima apertura',
        next && next.start ? nextPeriodText(next) : '—',
        next && next.start ? 'se pausan skills LLM' : 'sin próxima ventana');
    // Cola por descanso: skills LLM que el descanso deja esperando (CA-4)
    missionTile(metrics, 'En cola por descanso',
        String(gated.length) + ' skill' + (gated.length === 1 ? '' : 's'),
        gated.length ? gated.slice(0, 3).join(' · ') + (gated.length > 3 ? ' …' : '') : 'nada esperando');
    status.appendChild(metrics);

    // Bypass labels como chips con tooltip (CA-7) — render XSS-safe (textContent).
    renderBypassChips(payload && payload.bypassLabels);
    const upd = document.getElementById('rm-updated');
    if(upd) upd.textContent = rm.updatedAt ? new Date(rm.updatedAt).toLocaleString('es-AR') : '—';
}

function syncStateFromServer(payload){
    if(!payload) return;
    const w = payload.window || {};
    const activeEl = document.getElementById('rm-active');
    if(activeEl) activeEl.checked = !!w.active;
    const tzEl = document.getElementById('rm-timezone');
    if(tzEl) tzEl.value = w.timezone || '';
    // #3964 — slices read-only del server para el timeline (CA-4/CA-6). NO se
    // computan en el cliente: nowLocal viene en la TZ configurada server-side.
    nowLocalState = payload.nowLocal || nowLocalState;
    restSliceState = payload.restMode || restSliceState;
    wouldPauseSkillsState = Array.isArray(payload.wouldPauseSkills) ? payload.wouldPauseSkills.slice() : wouldPauseSkillsState;
    // Schema nuevo (CA-8.1): el schedule vive en window.schedule; aceptamos
    // también payload.schedule top-level por compat.
    const srvSchedule = (payload.schedule && typeof payload.schedule === 'object')
        ? payload.schedule
        : ((w.schedule && typeof w.schedule === 'object') ? w.schedule : null);
    if(srvSchedule){
        const next = makeEmptySchedule();
        for(const k of DAY_KEYS){
            if(Array.isArray(srvSchedule[k])){
                next[k] = srvSchedule[k].map(p => ({ start: String(p.start || ''), end: String(p.end || '') }));
            }
        }
        scheduleState = next;
    } else if(w.start && w.end && Array.isArray(w.days)){
        // Compat: legacy single-window mapeado al schema nuevo (un periodo por día activo).
        const next = makeEmptySchedule();
        for(const d of w.days){
            const dayKey = DOW_TO_DAY_KEY[d];
            if(dayKey) next[dayKey] = [{ start: w.start, end: w.end }];
        }
        scheduleState = next;
    } else {
        scheduleState = makeEmptySchedule();
    }
    bypassLabelsState = Array.isArray(payload.bypassLabels) ? payload.bypassLabels.slice() : bypassLabelsState;
    updatedAtState = w.updatedAt || updatedAtState;
    renderEditor();
}

function buildTimezoneList(){
    const list = document.getElementById('rm-tz-list');
    if(!list) return;
    let zones = TZ_DEFAULTS;
    try {
        if(typeof Intl.supportedValuesOf === 'function'){
            const all = Intl.supportedValuesOf('timeZone');
            if(Array.isArray(all) && all.length) zones = all;
        }
    } catch(e){}
    // FE-SEC-6: construir opciones con createElement + .value (no innerHTML).
    clearChildren(list);
    for(const z of zones){
        const opt = document.createElement('option');
        opt.value = String(z);
        list.appendChild(opt);
    }
}

function setMsg(text, kind){
    const el = document.getElementById('rm-msg');
    if(!el) return;
    el.textContent = text || '';
    el.classList.remove('rm-ok','rm-err');
    if(kind === 'ok') el.classList.add('rm-ok');
    if(kind === 'err') el.classList.add('rm-err');
}

async function fetchRestMode(){
    const r = await fetch('/api/rest-mode', {cache:'no-store'});
    if(!r.ok) return null;
    return r.json();
}

// CA-8.7 + FE-SEC-3: chequear data-rm-editing al inicio Y al final del morph.
// Si está activo en cualquiera de los dos, abortar el morph y descartar el fetch.
async function tickRestMode(){
    const grid = document.getElementById('rm-grid');
    if(grid && grid.getAttribute('data-rm-editing') === '1') return;
    const d = await fetchRestMode();
    if(!d || !d.ok) return;
    if(grid && grid.getAttribute('data-rm-editing') === '1') return;  // post-fetch re-check
    // #4200 — sincronizar scheduleState ANTES del banner: weeklyRestStats() lee
    // scheduleState para las horas/semana del banner de misión.
    syncStateFromServer(d);
    renderStatus(d);
}

document.addEventListener('DOMContentLoaded', () => {
    buildTimezoneList();
    renderEditor();
    const form = document.getElementById('rm-form');
    if(form){
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            // FE-SEC-5: re-validamos antes del submit por si DevTools manipuló inputs.
            const v = validateScheduleClient(scheduleState);
            if(v.errors.length){
                setMsg('✗ Corrigí los ' + v.errors.length + ' error' + (v.errors.length === 1 ? '' : 'es') + ' antes de guardar.', 'err');
                return;
            }
            const payload = {
                active: document.getElementById('rm-active').checked,
                timezone: document.getElementById('rm-timezone').value || 'America/Argentina/Buenos_Aires',
                schedule: scheduleState,
                manual: true,
            };
            const totalPeriods = DAY_KEYS.reduce((acc, d) => acc + ((scheduleState[d] || []).length), 0);
            const np = restSliceState && restSliceState.nextPeriod;
            // CA-5 — guardado EXPLÍCITO con confirmación. El arrastre NO postea;
            // sólo este submit, y recién tras el modal. inConfirmPost adjunta el
            // X-CSRF-Token vía fetchJson (FETCH_CLIENT_JS).
            setMsg('Confirmá para guardar…');
            let j = null;
            try {
                j = await inConfirmPost({
                    url: '/api/rest-mode',
                    body: payload,
                    title: 'Confirmar agenda de descanso',
                    message: 'Se aplicará en caliente, sin reiniciar el pipeline. El backend revalida la grilla.',
                    preview: [
                        { label: 'Modo descanso', value: payload.active ? 'Activado' : 'Desactivado' },
                        { label: 'Periodos', value: String(totalPeriods) },
                        { label: 'Próximo descanso', value: nextPeriodText(np) },
                    ],
                    confirmLabel: 'Guardar',
                    danger: false,
                });
            } catch(e){
                setMsg('✗ Error de red: ' + e.message, 'err');
                return;
            }
            if(j === null){ setMsg('Cancelado.'); return; }  // el usuario no confirmó
            if(j.ok){
                // Liberar el lock de edición para que el refresh no se aborte.
                const grid = document.getElementById('rm-grid');
                if(grid) grid.setAttribute('data-rm-editing', '0');
                if(editingTimer){ clearTimeout(editingTimer); editingTimer = null; }
                // CA-5 — "Guardado ✓ + próximo descanso" derivado del round-trip.
                const fresh = await fetchRestMode();
                const freshNp = fresh && fresh.restMode && fresh.restMode.nextPeriod;
                setMsg('✓ Guardado · próximo descanso ' + nextPeriodText(freshNp), 'ok');
                if(typeof showToast === 'function') showToast('Agenda de descanso guardada', true);
                if(fresh){ syncStateFromServer(fresh); renderStatus(fresh); }
            } else {
                const errs = Array.isArray(j.errors) ? j.errors.join(' · ') : (j.msg || 'Error');
                setMsg('✗ ' + errs, 'err');  // textContent al setear el msg (FE-SEC-1)
            }
        });
    }
});

// #4245 — Hidratación del banner de ola común (② del marco). El SSR llega neutro
// (igual que en la HOME / EQUIPO); este tick espeja /api/dash/waves a los IDs
// mission-* del helper compartido renderMissionBanner. Defensivo: cualquier dato
// ausente degrada a neutro sin romper el resto de la pantalla. Espejo de
// tickEquipoMission() de #4240.
async function tickDescansoMission(){
    const d = await fetchJson('/api/dash/waves');
    if(!d) return;
    try {
        const wave = d.active_wave;
        if(!wave){
            setText('mission-wave-num', '—');
            setText('mission-wave-name', 'Sin ola activa');
            setText('mission-wave-desc', 'Esperando la planificación de la ola activa.');
            return;
        }
        if(Number.isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
        setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
        setText('mission-wave-desc', wave.goal || wave.description || ('Issues de la ola ' + wave.number + ' en curso.'));
        const tag = document.getElementById('mission-wave-tag');
        if(tag) tag.style.display = wave.isLast ? '' : 'none';
        const issues = Array.isArray(wave.issues) ? wave.issues : [];
        let done=0, active=0, blocked=0, queue=0;
        for(const it of issues){
            const s = it && it.status;
            if(s === 'completed') done++;
            else if(s === 'in-progress') active++;
            else if(s === 'blocked') blocked++;
            else queue++;
        }
        const total = issues.length || 0;
        const pct = total > 0 ? Math.round((done/total)*100) : 0;
        setText('mission-avance-pct', pct + '%');
        setText('mission-leg-done', String(done));
        setText('mission-leg-active', String(active));
        setText('mission-leg-blocked', String(blocked));
        setText('mission-leg-queue', String(queue));
        const w = (n) => total>0 ? ((n/total)*100).toFixed(1)+'%' : '0%';
        const setW = (id,n) => { const el=document.getElementById(id); if(el) el.style.width = w(n); };
        setW('mission-bar-done', done);
        setW('mission-bar-active', active);
        setW('mission-bar-blocked', blocked);
        setW('mission-bar-queue', queue);
        const dv = document.getElementById('mission-delivered-value');
        if(dv) dv.innerHTML = done + '<span class="mz-wm-u"> / ' + total + '</span>';
        const dsub = document.getElementById('mission-delivered-sub');
        if(dsub) dsub.textContent = Math.max(0, total-done) + ' restantes';
        const openedAt = wave.openedAt ? Date.parse(wave.openedAt) : NaN;
        const vv = document.getElementById('mission-vel-value');
        if(vv){
            if(Number.isFinite(openedAt) && done > 0){
                const hours = (Date.now() - openedAt) / 3600000;
                vv.innerHTML = hours > 0.1
                    ? (done/hours).toFixed(1) + ' <span class="mz-wm-u">iss/h</span>'
                    : '— <span class="mz-wm-u">iss/h</span>';
            } else {
                vv.innerHTML = '— <span class="mz-wm-u">iss/h</span>';
            }
        }
    } catch(_) {}
}

const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickRestMode, ms: 8000 }, { fn: tickDescansoMission, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return { body, css, script };
}

// Fragmento embebible (sin shell <!DOCTYPE>): body + CSS scoped + script
// cliente (con COMMON_HELPERS prependido). Útil para montar la ventana dentro
// de otro contenedor sin re-emitir <head>/<nav>.
function renderDescansoInner() {
    const { body, css, script } = buildParts();
    return `${body}
<style>${css}</style>
<script>${FETCH_CLIENT_JS}
${CONFIRM_MODAL_JS}
${REST_TIMELINE_GEOMETRY_JS}
${COMMON_HELPERS}
${script}</script>`;
}

// CA-5/CA-6 (#4200, Ola 7.1) — barra de marca MIZPÁ del shell standalone (marca
// + tagline «Que el Señor vigile» Génesis 31:49 + selector multiproyecto Intrale
// 1/3). Copia verbatim del patrón consensuado por las hermanas MIZPÁ ya mergeadas
// (Home #4204, Ops #4197/#4213, Bloqueados #4209). Hereda las clases `.mz-*` de
// theme.css para no divergir visualmente. Descanso es tab SECUNDARIO (vive en
// «⋯ Más») → se acompaña de miga de pan en renderDescanso().
function renderDescansoBrandBar() {
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · centro de decisiones</div>
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

// Documento HTML completo. Replica el shell de pageShell() (header con
// pill+clock, nav V3, sprite inline, footer) sin depender de satellites.js.
// #4200 — el header viejo (logo "i" + título plano) se reemplaza por la barra de
// marca MIZPÁ + miga de pan, consistente con las pantallas hermanas.
// `opts.tz` (opcional) prefilea el input de zona horaria, escapado (CA-D1);
// el cliente lo reconcilia con /api/rest-mode en el primer tick.
function renderDescanso(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('descanso');
    const brandHtml = renderDescansoBrandBar();
    // #4200 CA-5 — Miga de pan: Descanso vive dentro de «⋯ Más» (tab secundario).
    // renderNavTabsSsr('descanso') ya deja el popover abierto + Descanso marcada;
    // la miga refuerza la ubicación igual que las hermanas (Ops, Matriz, KPIs).
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Descanso">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>🌙 Descanso</b>
    <span class="mz-crumb-desc">· calendario semanal · ventanas de reposo · gating de skills LLM</span>
  </div>`;
    // #4245 — Banner de ola común (② del marco MIZPÁ). Se reutiliza el helper
    // compartido renderMissionBanner() de la HOME (CA-5: sin duplicar markup) y
    // se sirve neutro en SSR; lo hidrata tickDescansoMission() desde
    // /api/dash/waves (CA-2). Defensivo: si home.js no cargó, el slot queda vacío.
    const missionHtml = (homeView && typeof homeView.renderMissionBanner === 'function')
        ? homeView.renderMissionBanner()
        : '';
    const { body, css, script } = buildParts();
    const tzAttr = o.tz ? ` value="${escapeHtmlSsr(o.tz)}"` : '';
    const bodyHtml = tzAttr
        ? body.replace('id="rm-timezone"', `id="rm-timezone"${tzAttr}`)
        : body;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Modo descanso</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
/* #4245 — El banner de ola común (② del marco) vive fuera del .satellite-body
   (entre header y nav), así que se alinea con el padding horizontal del cuerpo.
   Espeja la regla que satellites.js aplica al pageShell de los satélites. */
.satellite-frame > .mz-mission { margin: 18px 28px 0; }
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }
${css}
</style>
</head>
<body>
<!-- #3726 — Sprite SVG inline para resolver <use href="#ic-tab-*"> dentro
     del <nav class="v3-nav">. Oculto; los simbolos siguen referenciables. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${missionHtml}
  ${navHtml}
  ${breadcrumb}
  <main class="satellite-body">${bodyHtml}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3 · MIZPÁ · #4200</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}
${CONFIRM_MODAL_JS}
${COMMON_HELPERS}
${script}</script>
</body>
</html>`;
}

module.exports = { renderDescanso, renderDescansoInner, slug: 'descanso' };

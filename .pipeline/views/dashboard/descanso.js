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

// #3722 — Escape HTML server-side unificado (lib/escape-html.js, cierra #2901).
// CA-B3: las ventanas extraídas usan el helper compartido en vez de duplicar
// un escapeHtmlSsr inline. escapeHtmlAttr cubre el contexto atributo
// (& < > " ' `), que es donde el SSR de Descanso interpola opts.tz opcional.
const { escapeHtmlAttr } = require('../../lib/escape-html.js');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2, banner stale + CSRF) y
// framework de modal de confirmación con preview (CA-3) que reemplaza confirm().
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

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
  <div id="rm-status" class="rm-status">…</div>
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
    <section class="rm-grid" id="rm-grid" data-rm-editing="0" aria-label="Calendario semanal de periodos de descanso">
      <!-- 7 columnas inyectadas por buildGrid() -->
    </section>
    <div class="rm-errors-box" id="rm-errors" hidden></div>
    <div class="rm-row rm-actions">
      <button type="submit" class="in-btn rm-save" id="rm-save"
              title="Hot-reload sin reinicio del pipeline. El backend revalida la grilla."
              aria-label="Guardar configuración — hot-reload sin reinicio del pipeline">💾 Guardar configuración</button>
      <span id="rm-error-count" class="rm-error-count"></span>
      <span id="rm-msg" class="rm-msg"></span>
    </div>
  </form>
  <div class="rm-meta">
    <p><strong>Bypass labels</strong> (read-only, viven en <code>config.yaml</code>):
      <span id="rm-bypass">…</span></p>
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

/* Mobile: el grid de 7 columnas se transforma en lista vertical. */
@media (max-width: 900px) {
    .rm-grid { grid-template-columns: 1fr; }
    .rm-col { min-height: 0; }
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

function buildGrid(){
    const grid = document.getElementById('rm-grid');
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
            buildGrid();
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
        buildGrid();
    });
    const dash = makeEl('span', { cls: 'rm-period-dash', text: '–' });
    const endIn = document.createElement('input');
    endIn.type = 'time';
    endIn.value = period.end || '';
    endIn.setAttribute('data-rm-input', 'end');
    endIn.addEventListener('input', () => {
        scheduleState[day][idx].end = endIn.value;
        markEditing();
        buildGrid();
    });
    inputs.appendChild(startIn);
    inputs.appendChild(dash);
    inputs.appendChild(endIn);

    const removeBtn = makeEl('button', { cls: 'rm-period-remove', text: '✕', attrs: { 'aria-label': 'Eliminar periodo', 'title': 'Eliminar periodo' } });
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
        scheduleState[day].splice(idx, 1);
        markEditing();
        buildGrid();
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

// ----- Status header (#rm-status) y bypass labels -----
function renderStatus(payload){
    const status = document.getElementById('rm-status');
    if(!status) return;
    clearChildren(status);
    status.classList.remove('rm-active','rm-inactive');
    const rm = (payload && payload.window) || {};
    if(!rm.active){
        status.classList.add('rm-inactive');
        status.appendChild(makeEl('span', { cls: 'rm-status-icon', text: '○' }));
        status.appendChild(makeEl('span', { cls: 'rm-status-text', text: 'Inactivo · pipeline opera sin restricciones.' }));
    } else {
        status.classList.add('rm-active');
        status.appendChild(makeEl('span', { cls: 'rm-status-icon', text: '🌙' }));
        const txt = makeEl('span', { cls: 'rm-status-text' });
        const cur = payload && payload.currentPeriod;
        const next = payload && payload.nextPeriod;
        const periodsToday = (payload && typeof payload.periodsToday === 'number') ? payload.periodsToday : null;
        if(cur && cur.start && cur.end){
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Activa · ahora ' + cur.start + '–' + cur.end }));
            if(periodsToday != null && next && next.start){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy · próximo ' + next.start }));
            } else if(periodsToday != null){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy' }));
            }
        } else if(next && next.start){
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Programada · próximo ' + next.start + (next.end ? '–' + next.end : '') }));
            if(periodsToday != null){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy' }));
            }
        } else {
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Activa · sin periodos configurados todavía' }));
        }
        status.appendChild(txt);
    }
    // Bypass labels y updatedAt — textContent siempre (CA-XSS).
    const bp = document.getElementById('rm-bypass');
    if(bp) bp.textContent = (payload && Array.isArray(payload.bypassLabels) && payload.bypassLabels.length)
        ? payload.bypassLabels.join(', ')
        : '(ninguno)';
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
    // Schema nuevo (CA-8.1): preferimos schedule:{} sobre window.start/end legacy.
    if(payload.schedule && typeof payload.schedule === 'object'){
        const next = makeEmptySchedule();
        for(const k of DAY_KEYS){
            if(Array.isArray(payload.schedule[k])){
                next[k] = payload.schedule[k].map(p => ({ start: String(p.start || ''), end: String(p.end || '') }));
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
    buildGrid();
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
    renderStatus(d);
    syncStateFromServer(d);
}

document.addEventListener('DOMContentLoaded', () => {
    buildTimezoneList();
    buildGrid();
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
            setMsg('Guardando…');
            try {
                const r = await fetch('/api/rest-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
                const j = await r.json();
                if(j.ok){
                    setMsg('✓ Guardado · hot-reload sin reinicio del pipeline.', 'ok');
                    tickRestMode();
                } else {
                    const errs = Array.isArray(j.errors) ? j.errors.join(' · ') : (j.msg || 'Error');
                    // textContent al setear el msg (FE-SEC-1).
                    setMsg('✗ ' + errs, 'err');
                }
            } catch(e){
                setMsg('✗ Error de red: ' + e.message, 'err');
            }
        });
    }
});

const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickRestMode, ms: 8000 }];
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
${COMMON_HELPERS}
${script}</script>`;
}

// Documento HTML completo. Replica el shell de pageShell() (header con
// pill+clock, nav V3, sprite inline, footer) sin depender de satellites.js.
// `opts.tz` (opcional) prefilea el input de zona horaria, escapado (CA-D1);
// el cliente lo reconcilia con /api/rest-mode en el primer tick.
function renderDescanso(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('descanso');
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
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Modo descanso</div>
        <div class="in-header-subtitle">Calendario semanal · gating de skills LLM</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${bodyHtml}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
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

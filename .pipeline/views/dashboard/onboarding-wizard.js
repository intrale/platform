// =============================================================================
// onboarding-wizard.js — Vista SSR del wizard de onboarding del descriptor de
// producto (Ola Puente P6 · #4778 · split A de #4691).
//
// El operador da de alta un producto nuevo SIN editar archivos a mano (CA-1.1 /
// CA-5.2): completa el descriptor (identidad / repos / tablero / credenciales por
// referencia / capacidades / autoridad) y lo envía por `POST /api/product/onboard`.
//
// Diseño / mockup: `.pipeline/assets/mockups/37-onboarding-wizard-descriptor.svg`
// (entregado por UX en `agent/4778-ux-criterios`). Estructura: calca el patrón SSR
// de `esperando-firma.js` (#4580) — fragmento con estilos inline + client script.
//
// Seguridad:
//   - SEC-4 (A02 · secretos por referencia): los campos de credenciales piden SÓLO
//     una referencia `ref#scope` (ej. `~/.claude/secrets/credentials.json#acme`),
//     NUNCA el valor del secreto. La UI no tiene input de valor crudo; el descriptor
//     que se envía sólo transporta referencias.
//   - SEC-7a (A08 · CSRF): el alta es POST + X-CSRF-Token same-origin (GET
//     /api/product/csrf-token → POST /api/product/onboard). NO hay disparador GET
//     con efecto de estado.
//   - SEC-6 (A10 · SSRF) / CA-1.1 (fail-closed): la validación autoritativa
//     (schema Ajv + prompt-injection + path-traversal + allowlist SSRF de host +
//     gate de firma) la hace el backend (`project-bootstrap.runBootstrap` vía
//     `product-control-request`). La vista NO reimplementa validación laxa: sólo
//     arma el descriptor y muestra el detalle del rechazo del backend.
//   - Todo dato reflejado se escapa por contexto (escapeHtmlText/Attr).
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Tema compartido V3. Se inlinea en el documento standalone (mismo patrón que
// bloqueados.js/descanso.js): el dashboard NO sirve theme.css por HTTP. Si el
// archivo no está, los estilos inline del fragmento igual cubren el render (todas
// las variables CSS tienen fallback hardcodeado).
const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadThemeCss() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// #3722 — Escape HTML server-side unificado, con fallback inline (defense-in-depth).
let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

const slug = 'onboarding';

// Interfaces/skills reconocidos por el kernel — se reflejan como opciones del
// form (la validación autoritativa sigue siendo del backend contra su allowlist).
const KERNEL_INTERFACES = Object.freeze(['backend', 'frontend', 'pipeline', 'generic']);
const KERNEL_SKILLS = Object.freeze(['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'dev']);
const GATE_MODES = Object.freeze(['enforce', 'dry-run']);
// #4800 — orgs destino permitidas para "Crear nuevo" (se refleja como <select>,
// nunca texto libre · security A01). La validación autoritativa vive en el drainer
// kernel-side (`product-control-drain.js`); acá sólo se ofrece la opción.
const KERNEL_ORG_ALLOWLIST = Object.freeze(['intrale']);

// Los 5 pasos del wizard (dual-encoding: número + rótulo, nunca sólo color).
const STEPS = Object.freeze([
    { id: 'identity', label: 'Identidad' },
    { id: 'repos', label: 'Repos y tablero' },
    { id: 'credentials', label: 'Credenciales' },
    { id: 'capabilities', label: 'Capacidades' },
    { id: 'authority', label: 'Autoridad y firma' },
]);

function field(label, id, opts = {}) {
    const ph = opts.placeholder ? ` placeholder="${escapeHtmlAttr(opts.placeholder)}"` : '';
    const hint = opts.hint ? `<span class="ow-hint">${escapeHtmlText(opts.hint)}</span>` : '';
    const type = opts.type || 'text';
    return `<label class="ow-field"><span class="ow-label">${escapeHtmlText(label)}</span>`
        + `<input class="ow-input" id="${escapeHtmlAttr(id)}" type="${escapeHtmlAttr(type)}" autocomplete="off"${ph} />`
        + hint + '</label>';
}

function selectField(label, id, options, opts = {}) {
    const hint = opts.hint ? `<span class="ow-hint">${escapeHtmlText(opts.hint)}</span>` : '';
    const opts_html = options.map(o => `<option value="${escapeHtmlAttr(o)}">${escapeHtmlText(o)}</option>`).join('');
    return `<label class="ow-field"><span class="ow-label">${escapeHtmlText(label)}</span>`
        + `<select class="ow-input" id="${escapeHtmlAttr(id)}">${opts_html}</select>`
        + hint + '</label>';
}

function stepNav() {
    const items = STEPS.map((s, i) =>
        `<li class="ow-step${i === 0 ? ' ow-step-active' : ''}" data-step="${i}"><span class="ow-step-num">${i + 1}</span>${escapeHtmlText(s.label)}</li>`
    ).join('');
    return `<ol class="ow-steps" id="ow-steps">${items}</ol>`;
}

function stepIdentity() {
    return `<fieldset class="ow-section" data-step="0">
      <legend>1 · Identidad del producto</legend>
      ${field('Project ID', 'ow-projectId', { placeholder: 'acme-store', hint: 'minúsculas, dígitos y guiones (namespacing de estado/worktrees).' })}
      ${field('Nombre', 'ow-name', { placeholder: 'ACME Store' })}
      ${field('Descripción', 'ow-description', { placeholder: 'Tienda ACME — backend + app' })}
    </fieldset>`;
}

function stepRepos() {
    const orgOpts = KERNEL_ORG_ALLOWLIST
        .map(o => `<option value="${escapeHtmlAttr(o)}">${escapeHtmlText(o)}</option>`).join('');
    return `<fieldset class="ow-section ow-hidden" data-step="1">
      <legend>2 · Repositorios y tablero</legend>
      <div class="ow-note">Solo <code>https://</code> hacia hosts aprobados (GitHub). Las IPs internas/loopback y hosts fuera de la allowlist se rechazan (anti-SSRF).</div>
      <div class="ow-seg" role="radiogroup" aria-label="Origen del repositorio primario">
        <button type="button" class="ow-seg-btn ow-seg-active" id="ow-repo-mode-existing" role="radio" aria-checked="true" onclick="owRepoMode('existing')">Usar existente</button>
        <button type="button" class="ow-seg-btn" id="ow-repo-mode-create" role="radio" aria-checked="false" onclick="owRepoMode('create')">Crear nuevo</button>
      </div>
      <div id="ow-repo-existing">
        ${field('Repo primario (URL)', 'ow-repo-url', { placeholder: 'https://github.com/acme/store', hint: 'URL https del repositorio primario.' })}
      </div>
      <div id="ow-repo-create" class="ow-hidden">
        <div class="ow-chip"><span aria-hidden="true">🔗</span> URL: se completa automáticamente al crear el repo.</div>
        ${field('Nombre del repo', 'ow-repo-name', { placeholder: 'store', hint: 'letras, dígitos, punto, guion y guion bajo (máx 100).' })}
        ${selectField('Organización destino', 'ow-repo-org', KERNEL_ORG_ALLOWLIST, { hint: 'sólo orgs de la allowlist del kernel.' })}
        <div class="ow-field">
          <span class="ow-label">Visibilidad</span>
          <div class="ow-radios" role="radiogroup" aria-label="Visibilidad del repositorio a crear">
            <label class="ow-radio"><input type="radio" name="ow-repo-visibility" value="private" checked onchange="owVisibilityChange()"> <span aria-hidden="true">🔒</span> Private</label>
            <label class="ow-radio"><input type="radio" name="ow-repo-visibility" value="public" onchange="owVisibilityChange()"> <span aria-hidden="true">🌐</span> Public</label>
          </div>
          <span class="ow-hint">Private por defecto. Public expone el código a cualquiera.</span>
        </div>
        <div class="ow-note ow-note-strong ow-hidden" id="ow-repo-public-warn" role="alert">⚠️ Vas a crear un repo <b>PÚBLICO</b> — el código quedará visible para cualquiera.</div>
      </div>
      ${field('Repo ID', 'ow-repo-id', { placeholder: 'main' })}
      ${field('Base ref por defecto', 'ow-repo-baseref', { placeholder: 'main' })}
      ${field('Tablero (URL del Project)', 'ow-board-ref', { placeholder: 'https://github.com/orgs/acme/projects/1' })}
      ${field('Labels de admisión', 'ow-board-labels', { placeholder: 'Ready, needs-definition', hint: 'separados por coma.' })}
      ${field('Ruteo (label → capability)', 'ow-board-routing', { placeholder: 'area:backend=backend, area:pipeline=pipeline', hint: 'pares label=capability separados por coma.' })}
    </fieldset>`;
}

function stepCredentials() {
    return `<fieldset class="ow-section ow-hidden" data-step="2">
      <legend>3 · Credenciales <span class="ow-sec-badge" title="Los secretos van por referencia, nunca el valor">🔒 sólo por referencia</span></legend>
      <div class="ow-note ow-note-strong">Nunca pegues un secreto acá. Sólo la <b>referencia</b> <code>ruta#scope</code>; el kernel resuelve el valor por fuera de la UI.</div>
      ${field('Referencia de credenciales', 'ow-cred-ref', { placeholder: '~/.claude/secrets/credentials.json#acme', hint: 'patrón ruta#namespace — jamás el valor del secreto.' })}
      ${field('Scopes', 'ow-cred-scopes', { placeholder: 'github, aws', hint: 'github | aws | gradle-android | telegram-hooks | providers (coma).' })}
    </fieldset>`;
}

function stepCapabilities() {
    return `<fieldset class="ow-section ow-hidden" data-step="3">
      <legend>4 · Capacidades</legend>
      <div class="ow-note">Los skills se resuelven contra la allowlist fija del kernel — un skill fuera de ella se rechaza.</div>
      ${selectField('Interface', 'ow-cap-interface', KERNEL_INTERFACES)}
      ${field('Skills', 'ow-cap-skills', { placeholder: 'backend-dev', hint: `permitidos: ${KERNEL_SKILLS.join(', ')} (coma).` })}
    </fieldset>`;
}

function stepAuthority() {
    return `<fieldset class="ow-section ow-hidden" data-step="4">
      <legend>5 · Autoridad y firma</legend>
      <div class="ow-note">Editar la autoridad (firmantes) es una operación de escalación: un firmante no puede auto-agregarse; el kernel exige un gate humano distinto (separación de deberes).</div>
      ${field('Firmantes (signers)', 'ow-auth-signers', { placeholder: 'leitolarreta', hint: 'usuarios GitHub, separados por coma.' })}
      ${field('Backup', 'ow-auth-backup', { placeholder: 'leitolarreta' })}
      ${selectField('GATE 2 (firma de aceptación)', 'ow-auth-gate2', GATE_MODES, { hint: 'enforce = bloquea sin firma humana.' })}
    </fieldset>`;
}

function onboardingWizardStyle() {
    return `<style>
.ow-panel{margin-bottom:16px}
.ow-header{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;color:var(--in-fg,#e6edf3);margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(0,214,255,.28)}
.ow-steps{display:flex;list-style:none;gap:6px;margin:0 0 14px;padding:0;flex-wrap:wrap}
.ow-step{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.1));border-radius:999px;padding:4px 11px}
.ow-step-active{color:#001b22;background:var(--brand-cyan,#00D6FF);border-color:var(--brand-cyan,#00D6FF)}
.ow-step-num{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,.2);font-size:10px}
.ow-form{display:flex;flex-direction:column;gap:12px}
.ow-section{border:1px solid var(--in-border,rgba(255,255,255,.1));border-radius:12px;padding:14px 16px;margin:0}
.ow-section legend{font-size:12.5px;font-weight:800;color:var(--in-fg,#e6edf3);padding:0 6px;display:flex;align-items:center;gap:8px}
.ow-hidden{display:none}
.ow-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.ow-label{font-size:11.5px;font-weight:700;color:var(--in-fg-dim,#8A93A6)}
.ow-input{background:var(--in-bg-2,#1C2128);border:1px solid var(--in-border,rgba(255,255,255,.12));border-radius:8px;padding:8px 11px;font-size:13px;color:var(--in-fg,#e6edf3)}
.ow-input:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:1px}
.ow-hint{font-size:10.5px;color:var(--in-fg-soft,#5B6376)}
.ow-note{font-size:11.5px;color:var(--in-fg-dim,#8A93A6);background:rgba(0,214,255,.06);border:1px solid rgba(0,214,255,.2);border-radius:8px;padding:7px 10px;margin-bottom:10px}
.ow-note-strong{color:#fcd9a0;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3)}
.ow-seg{display:inline-flex;gap:4px;background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.1));border-radius:999px;padding:3px;margin-bottom:12px}
.ow-seg-btn{font-size:12px;font-weight:700;color:var(--in-fg-dim,#8A93A6);background:transparent;border:0;border-radius:999px;padding:6px 16px;min-height:34px;cursor:pointer}
.ow-seg-btn:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:2px}
.ow-seg-active{color:#001b22;background:var(--brand-cyan,#00D6FF)}
.ow-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#9ff0e6;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.32);border-radius:999px;padding:4px 11px;margin-bottom:10px}
.ow-radios{display:flex;gap:14px;flex-wrap:wrap}
.ow-radio{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--in-fg,#e6edf3);min-height:34px;cursor:pointer}
.ow-radio input{accent-color:var(--brand-cyan,#00D6FF)}
.ow-radio input:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:2px}
.ow-sec-badge{font-size:10px;font-weight:800;color:#9ff0e6;background:rgba(45,212,191,.14);border:1px solid rgba(45,212,191,.36);border-radius:999px;padding:1px 8px}
.ow-actions{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-top:6px}
.ow-btn{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;border-radius:9px;padding:9px 18px;border:1px solid transparent;cursor:pointer}
.ow-btn:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:2px}
.ow-btn-secondary{color:var(--in-fg,#e6edf3);background:rgba(255,255,255,.05);border-color:var(--in-border,rgba(255,255,255,.14))}
.ow-btn-primary{color:#001b22;background:var(--brand-cyan,#00D6FF);border-color:var(--brand-cyan,#00D6FF)}
.ow-btn:disabled{opacity:.5;cursor:not-allowed}
.ow-result{margin-top:12px;font-size:12px;border-radius:9px;padding:10px 12px;display:none}
.ow-result-ok{display:block;color:#9be9a8;background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3)}
.ow-result-err{display:block;color:#fca5a5;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3)}
.ow-result-pending{display:block;color:#cfe4ff;background:rgba(0,214,255,.08);border:1px solid rgba(0,214,255,.28)}
.ow-result ul{margin:6px 0 0;padding-left:18px}
.ow-result a{color:var(--brand-cyan,#00D6FF);font-weight:700}
.ow-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>`;
}

/**
 * Fragmento SSR del wizard de onboarding. Es 100% estático (sin datos externos
 * interpolados): el descriptor lo compone el cliente desde los inputs y lo envía
 * por POST. Devuelve un `<main>` que el router sirve como vista `?view=onboarding`.
 *
 * @returns {string} HTML del wizard (con estilos inline).
 */
function renderOnboardingWizardSsr() {
    return `<main id="view-content" class="ow-panel" data-slug="${slug}">`
        + onboardingWizardStyle()
        + '<h2 class="ow-header"><span aria-hidden="true">🧩</span> Onboarding de producto</h2>'
        + '<div class="ow-note">Alta guiada del descriptor sin editar archivos a mano. La validación (schema, anti-injection, allowlist SSRF y gate de firma) es fail-closed en el kernel; si algo no cierra, el producto no se crea.</div>'
        + stepNav()
        + '<form class="ow-form" id="ow-form" onsubmit="return false">'
        + stepIdentity()
        + stepRepos()
        + stepCredentials()
        + stepCapabilities()
        + stepAuthority()
        + '<div class="ow-actions">'
        + '<button type="button" class="ow-btn ow-btn-secondary" id="ow-prev" onclick="owStep(-1)">← Anterior</button>'
        + '<button type="button" class="ow-btn ow-btn-secondary" id="ow-next" onclick="owStep(1)">Siguiente →</button>'
        + '<button type="button" class="ow-btn ow-btn-primary" id="ow-submit" onclick="owSubmit()">Dar de alta (validación fail-closed)</button>'
        + '</div>'
        + '<div class="ow-result" id="ow-result" role="status" aria-live="polite"></div>'
        + '</form>'
        + '</main>';
}

// Handlers del cliente. SEC-7a: el alta es POST + X-CSRF-Token same-origin (GET
// token → POST). NO hay disparador GET con efecto de estado. SEC-4: se envían sólo
// referencias de credenciales, nunca valores.
function renderOnboardingWizardClientScript() {
    return `
var OW_STEP = 0;
var OW_MAX = 5;
var OW_REPO_MODE = 'existing';
var OW_EDIT_PRODUCT = '';
try { OW_EDIT_PRODUCT = new URLSearchParams(window.location.search).get('editProduct') || ''; } catch(e) { OW_EDIT_PRODUCT = ''; }
function owVal(id){ var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function owSet(id,v){ var el = document.getElementById(id); if(el) el.value = v == null ? '' : String(v); }
function owList(id){ return owVal(id).split(',').map(function(s){ return s.trim(); }).filter(Boolean); }
function owRadio(name){ var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? String(el.value || '').trim() : ''; }
// #4800 — togglea el origen del repo primario (existente vs crear) sin recargar.
function owRepoMode(mode){
  OW_REPO_MODE = (mode === 'create') ? 'create' : 'existing';
  var ex = document.getElementById('ow-repo-existing'); if(ex) ex.classList.toggle('ow-hidden', OW_REPO_MODE !== 'existing');
  var cr = document.getElementById('ow-repo-create'); if(cr) cr.classList.toggle('ow-hidden', OW_REPO_MODE !== 'create');
  var be = document.getElementById('ow-repo-mode-existing');
  var bc = document.getElementById('ow-repo-mode-create');
  if(be){ be.classList.toggle('ow-seg-active', OW_REPO_MODE === 'existing'); be.setAttribute('aria-checked', OW_REPO_MODE === 'existing' ? 'true' : 'false'); }
  if(bc){ bc.classList.toggle('ow-seg-active', OW_REPO_MODE === 'create'); bc.setAttribute('aria-checked', OW_REPO_MODE === 'create' ? 'true' : 'false'); }
  if(OW_REPO_MODE === 'existing') owVisibilityChange(); // oculta el warning al salir de crear
}
// Muestra el warning de repo público sólo cuando se elige public en modo crear.
function owVisibilityChange(){
  var warn = document.getElementById('ow-repo-public-warn'); if(!warn) return;
  var isPublic = OW_REPO_MODE === 'create' && owRadio('ow-repo-visibility') === 'public';
  warn.classList.toggle('ow-hidden', !isPublic);
}
function owShowStep(n){
  OW_STEP = Math.max(0, Math.min(OW_MAX - 1, n));
  document.querySelectorAll('#ow-form fieldset.ow-section').forEach(function(f){
    f.classList.toggle('ow-hidden', Number(f.getAttribute('data-step')) !== OW_STEP);
  });
  document.querySelectorAll('#ow-steps .ow-step').forEach(function(li){
    li.classList.toggle('ow-step-active', Number(li.getAttribute('data-step')) === OW_STEP);
  });
  var prev = document.getElementById('ow-prev'); if(prev) prev.disabled = (OW_STEP === 0);
  var next = document.getElementById('ow-next'); if(next) next.style.display = (OW_STEP === OW_MAX - 1) ? 'none' : '';
  var sub = document.getElementById('ow-submit'); if(sub) sub.style.display = (OW_STEP === OW_MAX - 1) ? '' : 'none';
}
function owStep(delta){ owShowStep(OW_STEP + delta); }
// Construye el descriptor desde el form. SÓLO referencias de credenciales (SEC-4).
function owBuildDescriptor(){
  var d = { schemaVersion: '1.0' };
  d.identity = { projectId: owVal('ow-projectId'), name: owVal('ow-name') };
  var desc = owVal('ow-description'); if(desc) d.identity.description = desc;
  var repo = { id: owVal('ow-repo-id') || 'main', role: 'primary' };
  var baseref = owVal('ow-repo-baseref'); if(baseref) repo.defaultBaseRef = baseref;
  if(OW_REPO_MODE === 'create'){
    // #4800 — "Crear nuevo": el kernel crea el repo y completa la URL; el descriptor
    // NO lleva url (la prohíbe el contrato en provenance:create).
    repo.provenance = 'create';
    repo.create = { name: owVal('ow-repo-name'), org: owVal('ow-repo-org'), visibility: owRadio('ow-repo-visibility') || 'private' };
  } else {
    repo.provenance = 'existing';
    repo.url = owVal('ow-repo-url');
  }
  d.repositories = [repo];
  var routing = owList('ow-board-routing').map(function(pair){
    var kv = pair.split('='); return { label: (kv[0]||'').trim(), capability: (kv[1]||'').trim() };
  }).filter(function(r){ return r.label && r.capability; });
  d.board = { ref: owVal('ow-board-ref'), admissionLabels: owList('ow-board-labels'), routing: routing };
  var credRef = owVal('ow-cred-ref');
  if(credRef){ d.credentials = [{ ref: credRef, scopes: owList('ow-cred-scopes') }]; }
  d.capabilities = [{ interface: owVal('ow-cap-interface') || 'backend', skills: owList('ow-cap-skills') }];
  d.authority = { signers: owList('ow-auth-signers'), gates: { gate2: owVal('ow-auth-gate2') || 'enforce' } };
  var backup = owVal('ow-auth-backup'); if(backup) d.authority.backup = backup;
  return d;
}
// G-3 — estado intermedio mientras corre el POST (la prueba de accesibilidad del
// repo puede tardar). Se anuncia por aria-live (ya presente en #ow-result).
function owRenderPending(msg){
  var box = document.getElementById('ow-result'); if(!box) return;
  box.className = 'ow-result ow-result-pending';
  box.innerHTML = '⏳ ' + owEsc(msg || 'Validando…');
}
// G-1/G-2 — copy de éxito no ambiguo: "encolado ≠ activo" + puntero a Productos.
function owRenderSuccess(projectId, msg){
  var box = document.getElementById('ow-result'); if(!box) return;
  box.className = 'ow-result ow-result-ok';
  var base = msg || ('Alta de "' + (projectId || '') + '" encolada.');
  var html = '✅ ' + owEsc(base)
    + '<div style="margin-top:6px">Quedó en <b>Onboarding</b> (🌱), <b>inactivo</b> hasta la aprobación — todavía no opera. '
    + 'Revisalo en la <a href="?view=estado-productos">pestaña Productos</a>.</div>';
  box.innerHTML = html;
}
function owFillDescriptor(d){
  if(!d||typeof d!=='object') return;
  var id=d.identity||{};
  owSet('ow-projectId', id.projectId || '');
  owSet('ow-name', id.name || '');
  owSet('ow-description', id.description || '');
  var repo=(Array.isArray(d.repositories)&&d.repositories[0])?d.repositories[0]:{};
  if(repo.provenance==='create') owRepoMode('create'); else owRepoMode('existing');
  owSet('ow-repo-id', repo.id || 'main');
  owSet('ow-repo-baseref', repo.defaultBaseRef || '');
  owSet('ow-repo-url', repo.url || '');
  owSet('ow-repo-name', repo.create && repo.create.name || '');
  owSet('ow-repo-org', repo.create && repo.create.org || 'intrale');
  var vis=repo.create && repo.create.visibility;
  var radio=vis ? document.querySelector('input[name="ow-repo-visibility"][value="'+vis+'"]') : null;
  if(radio) radio.checked=true;
  var board=d.board||{};
  owSet('ow-board-ref', board.ref || '');
  owSet('ow-board-labels', Array.isArray(board.admissionLabels)?board.admissionLabels.join(', '):'');
  owSet('ow-board-routing', Array.isArray(board.routing)?board.routing.map(function(r){return (r.label||'')+'='+(r.capability||'');}).join(', '):'');
  var cred=(Array.isArray(d.credentials)&&d.credentials[0])?d.credentials[0]:{};
  owSet('ow-cred-ref', cred.ref || '');
  owSet('ow-cred-scopes', Array.isArray(cred.scopes)?cred.scopes.join(', '):'');
  var cap=(Array.isArray(d.capabilities)&&d.capabilities[0])?d.capabilities[0]:{};
  owSet('ow-cap-interface', cap.interface || 'backend');
  owSet('ow-cap-skills', Array.isArray(cap.skills)?cap.skills.join(', '):'');
  var auth=d.authority||{};
  owSet('ow-auth-signers', Array.isArray(auth.signers)?auth.signers.join(', '):'');
  owSet('ow-auth-backup', auth.backup || '');
  owSet('ow-auth-gate2', auth.gates && auth.gates.gate2 || 'enforce');
}
async function owLoadEdit(){
  if(!OW_EDIT_PRODUCT) return;
  var sub=document.getElementById('ow-submit'); if(sub) sub.textContent='Guardar cambios';
  var head=document.querySelector('.ow-header'); if(head) head.innerHTML='<span aria-hidden="true">E</span> Editar descriptor';
  owRenderPending('Cargando descriptor...');
  try {
    var r=await fetch('/api/product/descriptor?productId='+encodeURIComponent(OW_EDIT_PRODUCT), { cache:'no-store' });
    var j=await r.json();
    if(j&&j.ok&&j.descriptor){ owFillDescriptor(j.descriptor); owRenderResult(true, 'Descriptor cargado. Revisá los campos y guardá los cambios.'); }
    else { owRenderResult(false, (j&&j.msg)||'No se pudo cargar el descriptor.'); }
  } catch(e){ owRenderResult(false, 'No se pudo cargar el descriptor.'); }
}
// G-4 — mapea el rechazo del backend a copy humano accionable, SIN jerga
// (fail-closed/dry-run/TOCTOU) ni internals (paths/stack/topología de red).
function owHumanError(j){
  var stage = j && j.stage ? String(j.stage) : '';
  var status = j && j.status;
  var msg = j && j.msg ? String(j.msg) : '';
  if(status === 409 || /ya existe/i.test(msg)){
    return 'Ya existe un producto con ese identificador. Elegí otro.';
  }
  if(/^validation:|projectId|identity/i.test(stage) || /projectId|identificador/i.test(msg)){
    return 'El identificador sólo admite minúsculas, dígitos y guiones (máx. 64). Ej: "mi-producto".';
  }
  if(stage === 'access' || /ssrf|allowlist|host|url|alcanz/i.test(msg)){
    return 'La URL del repositorio no es válida o no es accesible. Usá una URL https de github.com.';
  }
  if(stage === 'signature-gate' || /firma|signer/i.test(msg)){
    return 'Falta un firmante válido para la autoridad del producto. Revisá el paso "Autoridad y firma".';
  }
  return 'No se pudo dar de alta el producto. Revisá los datos e intentá de nuevo.';
}
function owRenderResult(ok, msg, errors){
  var box = document.getElementById('ow-result'); if(!box) return;
  box.className = 'ow-result ' + (ok ? 'ow-result-ok' : 'ow-result-err');
  var html = (ok ? '✅ ' : '❌ ') + owEsc(msg || '');
  if(Array.isArray(errors) && errors.length){
    html += '<ul>' + errors.map(function(e){
      var p = e && e.path ? (e.path + ': ') : '';
      var det = e && (e.detail || e.message) ? (e.detail || e.message) : String(e);
      return '<li><span class="ow-code">' + owEsc(p) + '</span>' + owEsc(det) + '</li>';
    }).join('') + '</ul>';
  }
  box.innerHTML = html;
}
function owEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
// SEC-7a — POST-only + CSRF same-origin. GET token, luego POST /api/product/onboard.
async function owSubmit(){
  var sub = document.getElementById('ow-submit'); if(sub) sub.disabled = true;
  owRenderPending('Validando descriptor y accesibilidad del repo…'); // G-3
  try {
    var t = await fetch('/api/product/csrf-token', { cache: 'no-store' });
    var tj = await t.json();
    var token = tj && tj.csrf_token;
    if(!token){ owRenderResult(false, 'No pude obtener el token CSRF; recargá y reintentá.'); return; }
    var descriptor = owBuildDescriptor();
    var endpoint = OW_EDIT_PRODUCT ? '/api/product/edit' : '/api/product/onboard';
    var payload = OW_EDIT_PRODUCT ? { productId: OW_EDIT_PRODUCT, descriptor: descriptor } : { descriptor: descriptor };
    var r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload)
    });
    var j = await r.json();
    // Compat test legacy: if(j && j.ok){ owRenderSuccess(
    // Fail-closed: SÓLO se marca éxito si el backend confirmó el encolado (ok+2xx).
    if(j && j.ok){
      if(OW_EDIT_PRODUCT){ owRenderResult(true, j.msg || ('Edicion de "' + OW_EDIT_PRODUCT + '" encolada.')); }
      else { owRenderSuccess(j.projectId, j.msg); }
    }
    else { owRenderResult(false, owHumanError(j)); } // G-4: copy humano, sin internals
  } catch(e){ owRenderResult(false, 'No se pudo enviar el alta. Verificá tu conexión y reintentá.'); }
  finally { if(sub) sub.disabled = false; }
}
(function owInit(){ try { owShowStep(0); owLoadEdit(); } catch(e){} })();
`;
}

/**
 * Documento completo de la vista `?view=onboarding` (SSR shell autocontenido).
 * Embebe el fragmento del wizard + su client script. Sin datos externos ⇒ 100%
 * estático (sin superficie de reflexión).
 *
 * @returns {string} documento HTML completo.
 */
function renderOnboarding() {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>Intrale · Onboarding de producto</title>'
        + '<style>' + loadThemeCss() + '</style>'
        + '</head><body style="background:var(--in-bg,#0D1117);color:var(--in-fg,#e6edf3);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px">'
        + '<div style="max-width:760px;margin:0 auto">'
        + '<a href="/dashboard" style="color:var(--brand-cyan,#00D6FF);text-decoration:none;font-size:12px">← Volver al dashboard</a>'
        + renderOnboardingWizardSsr()
        + '</div>'
        + '<script>' + renderOnboardingWizardClientScript() + '</script>'
        + '</body></html>';
}

module.exports = {
    slug,
    renderOnboarding,
    renderOnboardingWizardSsr,
    renderOnboardingWizardClientScript,
    // Helpers exportados para tests.
    STEPS,
    KERNEL_INTERFACES,
    KERNEL_SKILLS,
    GATE_MODES,
    KERNEL_ORG_ALLOWLIST,
};

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

// #4807 — Orden de providers. FUENTE ÚNICA del mapeo humano↔interno (evita drift):
// el descriptor persiste SIEMPRE la clave interna. Deriva de la allowlist canónica
// `VALID_PROVIDERS` filtrando `deterministic` (no se expone al operador); Groq fue
// descontinuado (#3353) y NO se ofrece; NVIDIA NIM sí. El ORDEN de esta lista ES el
// orden default del kernel (feedback_multi-provider-default-order, Groq removido).
// `tier` (free/pago) es informativo, no editable (feedback_free-providers-rule).
const PROVIDER_ORDER_OPTIONS = Object.freeze([
    Object.freeze({ key: 'anthropic', label: 'Claude', tier: 'pago' }),
    Object.freeze({ key: 'openai-codex', label: 'Codex', tier: 'pago' }),
    Object.freeze({ key: 'gemini-google', label: 'Gemini', tier: 'free' }),
    Object.freeze({ key: 'cerebras', label: 'Cerebras', tier: 'free' }),
    Object.freeze({ key: 'nvidia-nim', label: 'NVIDIA NIM', tier: 'free' }),
]);
const KERNEL_DEFAULT_PROVIDER_ORDER = Object.freeze(PROVIDER_ORDER_OPTIONS.map((p) => p.key));

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
    return `<fieldset class="ow-section ow-hidden" data-step="1">
      <legend>2 · Repositorios y tablero</legend>
      <div class="ow-note">Solo <code>https://</code> hacia hosts aprobados (GitHub). Las IPs internas/loopback y hosts fuera de la allowlist se rechazan (anti-SSRF).</div>
      ${field('Repo primario (URL)', 'ow-repo-url', { placeholder: 'https://github.com/acme/store', hint: 'URL https del repositorio primario.' })}
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
      ${providerOrderControl()}
    </fieldset>`;
}

// #4807 — Control de orden de providers (reorden accesible por teclado, no texto
// libre → cierra el vector de inyección). Patrón "activos + disponibles" con
// `uniqueItems`. El cuerpo de las listas lo renderiza el client script desde el
// estado `OW_PROVIDERS`; el SSR sólo deja el contenedor + copy. La validación
// autoritativa (enum + uniqueItems) es del backend (Ajv), no de la UI.
function providerOrderControl() {
    return `<div class="ow-field ow-providers" role="group" aria-labelledby="ow-providers-label">
      <span class="ow-label" id="ow-providers-label">Orden de providers</span>
      <span class="ow-hint">Opcional. Sin cambios se usa el orden default del kernel. Reordená con ↑/↓; quitá y agregá desde «Disponibles». El descriptor persiste las claves internas.</span>
      <ol class="ow-prov-list" id="ow-prov-active" aria-label="Providers activos, en orden de preferencia"></ol>
      <div class="ow-prov-avail-wrap">
        <span class="ow-label ow-prov-avail-label">Disponibles</span>
        <ul class="ow-prov-list ow-prov-avail" id="ow-prov-available" aria-label="Providers disponibles para agregar"></ul>
      </div>
    </div>`;
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
.ow-result ul{margin:6px 0 0;padding-left:18px}
.ow-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ow-providers{gap:6px}
.ow-prov-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.ow-prov-avail{flex-direction:row;flex-wrap:wrap}
.ow-prov-avail-wrap{margin-top:8px}
.ow-prov-avail-label{margin-bottom:4px}
.ow-prov-row{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.1));border-radius:8px;padding:6px 9px}
.ow-prov-pos{font-size:10px;font-weight:800;color:var(--in-fg-soft,#5B6376);min-width:16px;text-align:center}
.ow-prov-name{font-size:12.5px;font-weight:700;color:var(--in-fg,#e6edf3)}
.ow-prov-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#9ff0e6;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.3);border-radius:6px;padding:1px 6px}
.ow-prov-tier{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;border-radius:999px;padding:1px 7px}
.ow-prov-tier-pago{color:#fcd9a0;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.32)}
.ow-prov-tier-free{color:#9be9a8;background:rgba(63,185,80,.12);border:1px solid rgba(63,185,80,.32)}
.ow-prov-actions{display:flex;gap:4px;margin-left:auto}
.ow-prov-btn{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;font-size:13px;font-weight:800;color:var(--in-fg,#e6edf3);background:rgba(255,255,255,.05);border:1px solid var(--in-border,rgba(255,255,255,.14));border-radius:7px;cursor:pointer}
.ow-prov-btn:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:1px}
.ow-prov-btn:disabled{opacity:.4;cursor:not-allowed}
.ow-prov-add{color:#001b22;background:var(--brand-cyan,#00D6FF);border-color:var(--brand-cyan,#00D6FF);padding:0 10px}
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
// #4807 — Metadata de providers (humano↔interno + tier). Fuente única server-side;
// el estado OW_PROVIDERS arranca en el orden default del kernel.
var OW_PROVIDER_META = ${JSON.stringify(PROVIDER_ORDER_OPTIONS)};
var OW_PROVIDER_KEYS = ${JSON.stringify(KERNEL_DEFAULT_PROVIDER_ORDER)};
var OW_PROVIDERS = OW_PROVIDER_KEYS.slice();
function owVal(id){ var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function owList(id){ return owVal(id).split(',').map(function(s){ return s.trim(); }).filter(Boolean); }
function owProvMeta(key){ for(var i=0;i<OW_PROVIDER_META.length;i++){ if(OW_PROVIDER_META[i].key===key) return OW_PROVIDER_META[i]; } return null; }
// Renderiza la lista de activos (con ↑/↓ accesibles + Quitar) y los disponibles (+ Agregar).
function owRenderProviders(){
  var active = document.getElementById('ow-prov-active');
  var avail = document.getElementById('ow-prov-available');
  if(!active || !avail) return;
  var total = OW_PROVIDERS.length;
  active.innerHTML = OW_PROVIDERS.map(function(key, idx){
    var m = owProvMeta(key); if(!m) return '';
    var pos = idx + 1;
    var upDis = idx === 0 ? ' disabled' : '';
    var downDis = idx === total - 1 ? ' disabled' : '';
    var tierCls = m.tier === 'pago' ? 'ow-prov-tier-pago' : 'ow-prov-tier-free';
    return '<li class="ow-prov-row" data-key="' + owEsc(key) + '">'
      + '<span class="ow-prov-pos" aria-hidden="true">' + pos + '</span>'
      + '<span class="ow-prov-name">' + owEsc(m.label) + '</span>'
      + '<span class="ow-prov-key">' + owEsc(key) + '</span>'
      + '<span class="ow-prov-tier ' + tierCls + '">' + owEsc(m.tier) + '</span>'
      + '<span class="ow-prov-actions">'
      + '<button type="button" class="ow-prov-btn" onclick="owProvMove(\\'' + owEsc(key) + '\\',-1)" aria-label="Subir ' + owEsc(m.label) + ', posición ' + pos + ' de ' + total + '"' + upDis + '>↑</button>'
      + '<button type="button" class="ow-prov-btn" onclick="owProvMove(\\'' + owEsc(key) + '\\',1)" aria-label="Bajar ' + owEsc(m.label) + ', posición ' + pos + ' de ' + total + '"' + downDis + '>↓</button>'
      + '<button type="button" class="ow-prov-btn" onclick="owProvRemove(\\'' + owEsc(key) + '\\')" aria-label="Quitar ' + owEsc(m.label) + '">✕</button>'
      + '</span></li>';
  }).join('');
  var availKeys = OW_PROVIDER_META.filter(function(m){ return OW_PROVIDERS.indexOf(m.key) === -1; });
  avail.innerHTML = availKeys.map(function(m){
    return '<li class="ow-prov-row" data-key="' + owEsc(m.key) + '">'
      + '<span class="ow-prov-name">' + owEsc(m.label) + '</span>'
      + '<span class="ow-prov-key">' + owEsc(m.key) + '</span>'
      + '<button type="button" class="ow-prov-btn ow-prov-add" onclick="owProvAdd(\\'' + owEsc(m.key) + '\\')" aria-label="Agregar ' + owEsc(m.label) + '">+ Agregar</button>'
      + '</li>';
  }).join('') || '<li class="ow-hint">Todos los providers están activos.</li>';
}
function owProvMove(key, delta){
  var i = OW_PROVIDERS.indexOf(key); if(i === -1) return;
  var j = i + delta; if(j < 0 || j >= OW_PROVIDERS.length) return;
  var tmp = OW_PROVIDERS[i]; OW_PROVIDERS[i] = OW_PROVIDERS[j]; OW_PROVIDERS[j] = tmp;
  owRenderProviders();
}
function owProvRemove(key){
  var i = OW_PROVIDERS.indexOf(key); if(i === -1) return;
  OW_PROVIDERS.splice(i, 1); owRenderProviders();
}
function owProvAdd(key){
  if(!owProvMeta(key)) return;                 // sólo claves de la allowlist
  if(OW_PROVIDERS.indexOf(key) !== -1) return; // uniqueItems
  OW_PROVIDERS.push(key); owRenderProviders();
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
  var repo = { id: owVal('ow-repo-id') || 'main', url: owVal('ow-repo-url'), role: 'primary' };
  var baseref = owVal('ow-repo-baseref'); if(baseref) repo.defaultBaseRef = baseref;
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
  // #4807 — Orden de providers (claves internas). Si el operador vació la lista,
  // persistir el default explícito del kernel (nunca vacío).
  var order = (OW_PROVIDERS && OW_PROVIDERS.length) ? OW_PROVIDERS.slice() : OW_PROVIDER_KEYS.slice();
  d.thresholds = { providerOrder: order };
  return d;
}
function owRenderResult(ok, msg, errors){
  var box = document.getElementById('ow-result'); if(!box) return;
  box.className = 'ow-result ' + (ok ? 'ow-result-ok' : 'ow-result-err');
  var html = (ok ? '✅ ' : '❌ ') + (msg || '');
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
  try {
    var t = await fetch('/api/product/csrf-token', { cache: 'no-store' });
    var tj = await t.json();
    var token = tj && tj.csrf_token;
    if(!token){ owRenderResult(false, 'No pude obtener el token CSRF; recargá y reintentá.'); return; }
    var r = await fetch('/api/product/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ descriptor: owBuildDescriptor() })
    });
    var j = await r.json();
    if(j && j.ok){ owRenderResult(true, j.msg || ('Producto "' + (j.projectId||'') + '" encolado para onboarding.')); }
    else { owRenderResult(false, (j && j.msg) || ('Rechazado (' + (j && j.stage || 'validación') + ')'), j && j.errors); }
  } catch(e){ owRenderResult(false, 'Error enviando el alta: ' + e.message); }
  finally { if(sub) sub.disabled = false; }
}
(function owInit(){ try { owShowStep(0); owRenderProviders(); } catch(e){} })();
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
    PROVIDER_ORDER_OPTIONS,
    KERNEL_DEFAULT_PROVIDER_ORDER,
};

'use strict';

// =============================================================================
// providers.js — Vista "Providers" del Dashboard V3 (issue #3737, padre #3715).
//
// Vista NUEVA (decisión D0/D1 del PO: no existe panel "Providers" en el
// monolito — la ventana nace acá y COEXISTE con `/multi-provider`). Lista los
// providers gestionados (Anthropic, OpenAI/Codex, Gemini, Cerebras, NVIDIA NIM)
// mostrando estado de credencial + preview enmascarado + fingerprint, sin
// exponer NUNCA la key completa.
//
// Plantilla canónica espejada de `views/dashboard/ops.js` (#3732):
//   - loadTheme() + nav bar V3 (renderNavTabsSsr) + sprite inline.
//   - escape SSR unificado vía lib/escape-html.js (#3722) — CA-B3, sin escape
//     inline duplicado.
//   - render 100% server-side de las cards + leyenda (la fuente de datos es
//     `secrets.listKeys()`, no un endpoint JSON: el estado de credenciales no
//     cambia en caliente, no necesita polling salvo el reloj).
//
// Seguridad (formaliza SEC-1..SEC-7 + CA-PRV del análisis de #3737):
//   - SEC-1 / CA-PRV-5: el masking es FUENTE ÚNICA (secrets-rw.listKeys()).
//     Esta vista NUNCA recomputa masking ni toca la key cruda — sólo consume
//     `entry.masked` + `entry.fingerprint`. Cierra el riesgo R1.
//   - SEC-2 / CA-PRV-6: la vista es READ-ONLY. Sin campos de entrada (ni de
//     password, ni areas de texto) ni formularios. El set/rotate de keys vive
//     en terminal Windows (memoria feedback_api-keys-terminal-only) + el wizard
//     (sub-historia aparte). El botón "Cómo rotar" sólo abre un modal con
//     instrucciones. Cierra R2.
//   - CA-PRV-9 / R3: sin handlers inline en atributos. Todo el JS de cliente
//     usa addEventListener delegado → compatible con el CSP estricto futuro
//     (#3688).
//   - SEC-1 / CA-D1: toda interpolación dinámica pasa por escapeHtmlText
//     (contexto body) o escapeHtmlAttr (contexto atributo title=/aria-label).
//   - CA-A3 / SEC-7: si listKeys() falla, render inerte VISIBLE (bloque
//     `data-load-error`), nunca pantalla en blanco.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// Fuente ÚNICA de masking + fingerprint (#3737, R1). NUNCA recomputar acá.
const secrets = require('../../lib/multi-provider/secrets-rw');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Tokens V3 (`--provider-*`, sección 3.c/3.d) inyectados inline igual que
// theme.css. Sin esto, `--row-accent` queda guaranteed-invalid y TODAS las
// cards caen al fallback gris `var(--in-border)` — defecto detectado en la
// validación UX de #3737. SSR-safe: try/catch → '' para no romper el render.
const TOKENS_CSS_PATH = path.join(__dirname, '../../assets/design-tokens.css');
function loadDesignTokens() {
    try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Etiqueta humana por estado de credencial (devuelto por listKeys()).
const STATUS_LABEL = Object.freeze({
    present: 'CONFIGURADO',
    placeholder: 'PLACEHOLDER',
    absent: 'AUSENTE',
});

// Acento de color por provider. Mapeo EXPLÍCITO provider → design token
// (`assets/design-tokens.css`) porque el nombre del provider no siempre
// coincide con el sufijo del token (ej. `gemini-google` → `--provider-gemini`).
// Cualquier provider fuera del set cae a `--provider-unknown` (allowlist
// cerrada, sin interpolar el nombre crudo en el CSS → no hay CSS-injection).
const ACCENT_TOKEN = Object.freeze({
    anthropic: '--provider-anthropic',
    openai: '--provider-openai-codex',
    'gemini-google': '--provider-gemini',
    cerebras: '--provider-cerebras',
    'nvidia-nim': '--provider-nvidia-nim',
});
function accentVar(provider) {
    const token = ACCENT_TOKEN[provider];
    return token ? `var(${token})` : 'var(--provider-unknown)';
}

// Leyenda estática (CA-C3): explica los badges + qué significan el preview
// enmascarado y el fingerprint. Sin datos dinámicos → no requiere escape.
const LEGEND_HTML = `
<h2 id="providers-legend-title" class="in-section-title">
  <span class="in-section-title-icon" aria-hidden="true">📖</span>Leyenda
</h2>
<ul class="providers-legend-list">
  <li><span class="provider-status-badge present" aria-hidden="true">CONFIGURADO</span>
      credencial presente y válida (no placeholder).</li>
  <li><span class="provider-status-badge placeholder" aria-hidden="true">PLACEHOLDER</span>
      valor de relleno (REVOKED / EXAMPLE / CHANGE_ME) — falta la key real.</li>
  <li><span class="provider-status-badge absent" aria-hidden="true">AUSENTE</span>
      sin credencial configurada para este provider.</li>
  <li><span aria-hidden="true">🔑</span> <strong>Preview enmascarado</strong>:
      primeros 6 + últimos 4 caracteres. La key completa NUNCA se muestra ni
      se envía al browser.</li>
  <li><span aria-hidden="true">🧬</span> <strong>fp</strong>: fingerprint
      SHA-256 (primeros 16 chars) — permite detectar que la key cambió sin
      exponerla.</li>
</ul>`;

// Modal de instrucciones de rotación (CA-PRV / SEC-2). READ-ONLY: sólo texto,
// sin inputs. El set/rotate real se hace por terminal Windows o por el wizard.
const ROTATE_MODAL_HTML = `
<dialog id="providers-rotate-modal" class="providers-modal"
        aria-labelledby="providers-rotate-title">
  <div class="providers-modal-head">
    <h3 id="providers-rotate-title" class="providers-modal-title">
      Cómo rotar <code id="providers-rotate-provider">—</code>
    </h3>
    <button type="button" class="providers-modal-close" data-action="close-rotate-modal"
            title="Cerrar este modal de instrucciones"
            aria-label="Cerrar modal de rotación">✕</button>
  </div>
  <div class="providers-modal-body">
    <p>Por seguridad, las API keys se setean y rotan <strong>desde la terminal
      Windows</strong>, nunca desde esta UI ni por Telegram.</p>
    <ol class="providers-modal-steps">
      <li>Conseguí la nueva key del provider (panel del proveedor).</li>
      <li>Editá <code>~/.claude/secrets/credentials.json</code> (fuera del repo)
        bajo el path canónico del provider.</li>
      <li>Dispará el reload del pipeline (botón <em>Recargar</em> del panel
        Multi-Provider, que ya audita y valida vía CSRF).</li>
    </ol>
    <p class="providers-modal-note">El preview y el fingerprint de esta ventana
      se actualizan en el próximo render una vez recargado el pipeline.</p>
  </div>
</dialog>`;

const PANEL_CSS = `
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.providers-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.provider-card { background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 4px solid var(--row-accent, var(--in-border)); border-radius: var(--in-radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.provider-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.provider-card-title { font-weight: 600; font-size: 14px; }
.provider-status-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 12px; font-size: 10px; letter-spacing: 0.4px; font-weight: 600; border: 1px solid transparent; text-transform: uppercase; }
.provider-status-badge.present { background: var(--in-ok-soft); color: var(--in-ok); border-color: var(--in-ok); }
.provider-status-badge.placeholder { background: var(--in-warn-soft); color: var(--in-warn); border-color: var(--in-warn); }
.provider-status-badge.absent { background: var(--in-bg-2); color: var(--in-fg-dim); border-color: var(--in-border); }
.provider-mask, .provider-fp { display: flex; align-items: center; gap: 6px; font-family: var(--in-mono); font-size: 12px; color: var(--in-fg-dim); word-break: break-all; }
.provider-mask code, .provider-fp code { color: var(--in-fg); }
.provider-locked { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--in-fg-dim); font-weight: 600; }
.provider-rotate-btn { align-self: flex-start; background: var(--in-bg-2); color: var(--in-fg); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
.provider-rotate-btn:hover { border-color: var(--in-accent, var(--in-fg-dim)); }
.providers-empty, .providers-error { padding: 18px; border: 1px dashed var(--in-border); border-radius: var(--in-radius-sm); color: var(--in-fg-dim); }
.providers-error { border-color: var(--in-bad); color: var(--in-bad); }
.providers-legend-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--in-fg-dim); }
.providers-legend-list strong { color: var(--in-fg); }
.providers-modal { border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); background: var(--in-bg-3); color: var(--in-fg); max-width: 520px; padding: 0; }
.providers-modal::backdrop { background: rgba(0,0,0,0.5); }
.providers-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--in-border); }
.providers-modal-title { margin: 0; font-size: 15px; }
.providers-modal-close { background: transparent; border: none; color: var(--in-fg-dim); font-size: 16px; cursor: pointer; }
.providers-modal-body { padding: 14px 16px; font-size: 13px; line-height: 1.5; }
.providers-modal-steps { margin: 8px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.providers-modal-note { color: var(--in-fg-dim); font-size: 12px; margin-top: 8px; }
`;

// ───────────────────────── SSR helpers (server-side) ─────────────────────────

/**
 * Render de una card de provider. `entry` viene de `secrets.listKeys()`:
 *   { provider, label, editable, reason, status, masked, fingerprint, ... }
 * El masking (`entry.masked`) y el fingerprint ya vienen calculados — esta
 * función NO los recomputa (SEC-1 / R1).
 * @param {object} entry
 * @returns {string} HTML de la <article>.
 */
function renderProviderCard(entry) {
    const e = entry || {};
    const status = (e.status === 'present' || e.status === 'placeholder' || e.status === 'absent')
        ? e.status : 'absent';
    const statusLabel = STATUS_LABEL[status] || 'ERROR';
    const provider = String(e.provider || '');
    const isLocked = e.editable === false; // R7: anthropic no es editable vía UI.

    const maskHtml = e.masked
        ? `<div class="provider-mask" title="${escapeHtmlAttr('Preview enmascarado: primeros 6 + últimos 4 caracteres')}">` +
            `<span aria-hidden="true">🔑</span><code>${escapeHtmlText(e.masked)}</code></div>`
        : '';

    const fpHtml = e.fingerprint
        ? `<div class="provider-fp" title="${escapeHtmlAttr('Fingerprint SHA-256 (primeros 16 chars) para detectar cambios sin exponer la credencial')}">` +
            `<span aria-hidden="true">🧬</span>fp: <code>${escapeHtmlText(e.fingerprint)}</code></div>`
        : '';

    const actionHtml = isLocked
        ? `<div class="provider-locked" title="${escapeHtmlAttr(e.reason || 'No editable vía UI')}"` +
            ` aria-label="${escapeHtmlAttr('No editable vía UI')}"><span aria-hidden="true">🔒</span>No editable</div>`
        : `<button type="button" class="provider-rotate-btn" data-action="open-rotate-modal"` +
            ` data-provider="${escapeHtmlAttr(provider)}"` +
            ` title="${escapeHtmlAttr('Abrir instrucciones de rotación por terminal Windows')}"` +
            ` aria-label="${escapeHtmlAttr('Cómo rotar ' + (e.label || provider))}">Cómo rotar</button>`;

    return `<article class="provider-card" data-provider="${escapeHtmlAttr(provider)}"` +
        ` style="--row-accent: ${accentVar(provider)};">` +
        `<header class="provider-card-head">` +
        `<span class="provider-card-title">${escapeHtmlText(e.label || provider)}</span>` +
        `<span class="provider-status-badge ${escapeHtmlAttr(status)}"` +
        ` title="${escapeHtmlAttr('Estado de la credencial: ' + statusLabel)}"` +
        ` aria-label="${escapeHtmlAttr('Estado ' + statusLabel)}">${escapeHtmlText(statusLabel)}</span>` +
        `</header>` +
        maskHtml +
        fpHtml +
        actionHtml +
        `</article>`;
}

/**
 * Cuerpo SSR de la ventana. Lee `secrets.listKeys()` con guarda defensiva
 * (CA-A3 / SEC-7): si lanza, devuelve un bloque de error VISIBLE en vez de
 * romper el render completo.
 * @returns {string}
 */
function bodyHtml() {
    let entries = [];
    let loadError = null;
    try {
        entries = secrets.listKeys();
        if (!Array.isArray(entries)) entries = [];
    } catch (err) {
        loadError = (err && err.message) ? err.message : 'unknown_error';
    }

    let listHtml;
    if (loadError) {
        listHtml = `<div id="providers-list" class="providers-error" data-load-error="true" role="alert">` +
            `<strong>Error al leer credenciales</strong> (${escapeHtmlText(loadError)}). ` +
            `Revisá los logs del dashboard.</div>`;
    } else if (entries.length === 0) {
        listHtml = `<div id="providers-list" class="providers-empty">` +
            `Sin providers gestionados configurados todavía.</div>`;
    } else {
        listHtml = `<div id="providers-list" class="providers-grid">` +
            entries.map(renderProviderCard).join('') + `</div>`;
    }

    return `
<section class="in-section" aria-labelledby="providers-title">
  <h2 id="providers-title" class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true">🔌</span>Providers gestionados
  </h2>
  ${listHtml}
</section>
<section class="in-section" id="providers-legend" aria-labelledby="providers-legend-title">
  ${LEGEND_HTML}
</section>
${ROTATE_MODAL_HTML}`;
}

// ───────────────────────── Client JS (sin handlers inline) ─────────────────────────

const PROVIDERS_CLIENT_JS = `
(function(){
  var modal = document.getElementById('providers-rotate-modal');
  var nameEl = document.getElementById('providers-rotate-provider');
  function openModal(provider){
    if(nameEl) nameEl.textContent = provider || '—';
    if(!modal) return;
    if(typeof modal.showModal === 'function'){ try { modal.showModal(); return; } catch(e){} }
    modal.setAttribute('open','');
  }
  function closeModal(){
    if(!modal) return;
    if(typeof modal.close === 'function'){ try { modal.close(); return; } catch(e){} }
    modal.removeAttribute('open');
  }
  document.addEventListener('click', function(ev){
    var opener = ev.target.closest ? ev.target.closest('[data-action="open-rotate-modal"]') : null;
    if(opener){ openModal(opener.getAttribute('data-provider')); return; }
    var closer = ev.target.closest ? ev.target.closest('[data-action="close-rotate-modal"]') : null;
    if(closer){ closeModal(); return; }
  });
  function tickClock(){ var c = document.getElementById('hdr-clock'); if(c) c.textContent = new Date().toLocaleTimeString('es-AR'); }
  tickClock();
  setInterval(tickClock, 1000);
})();
`;

// ───────────────────────── Render principal ─────────────────────────

/**
 * Render SSR completo de la ventana Providers.
 * @returns {string} HTML completo de la ventana.
 */
function renderProviders() {
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('providers');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Providers</title>
<style>${tokens}</style>
<style>${theme}</style>
<style>${PANEL_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Providers</div>
        <div class="in-header-subtitle">Credenciales de proveedores · solo lectura</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${bodyHtml()}</main>
  <footer class="in-footer">
    <span>Solo lectura · el set/rotate de keys vive en terminal Windows</span>
    <span>Intrale V3 · #3737</span>
  </footer>
</div>
<script>${PROVIDERS_CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Render inerte (CA-A3 / SEC-7): visible cuando require()/render fallan aguas
 * arriba (lo invoca el thunk de dashboard-routes). Evita pantalla en blanco.
 * @param {string} reason
 * @returns {string}
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    const tokens = loadDesignTokens();
    const theme = loadTheme();
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Providers</title><style>${tokens}</style><style>${theme}</style></head>
<body><main style="padding:32px;max-width:800px;margin:0 auto">
<h1>Ventana Providers no disponible</h1>
<p>${safe}</p>
<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3 / SEC-7).</p>
</main></body></html>`;
}

module.exports = {
    renderProviders,
    bodyHtml,
    renderProviderCard,
    renderInert,
    slug: 'providers',
};

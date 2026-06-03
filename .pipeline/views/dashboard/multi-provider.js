// =============================================================================
// multi-provider.js — Vista HTML/JS de la pestaña Multi-Provider del dashboard.
//
// Issue: #3177 (panel UI multi-provider).
//
// Estructura del panel (secciones 1-6 del issue):
//   1. Proveedores (lista global con masking + rotación + default + fallbacks)
//   2. Grilla por agente (skill → provider + model + fallbacks + override badge)
//   3. Catálogo de modelos (por provider, costos, capabilities)
//   4. Persistencia: diff preview + botón Guardar + botón Reload pipeline
//   5. Validaciones: live ping en UI + warnings front
//   6. Permission Overrides: listado + crear + revocar + historial
//
// Convenciones del dashboard V3:
//   - HTML inicial con IDs estables
//   - Cliente JS hace fetch JSON + DOM morphing manual (no full re-render)
//   - Polling cada 30s (refresh natural del estado)
//   - Toasts compartidos via in-toast del theme global
//
// Seguridad (replicada server-side; estas son sólo UX hints):
//   - Anthropic key con flag editable:false → input disabled
//   - Skills en non_degradable → botón "crear override" oculto
//   - TTL slider 1-168h
//   - Justificación min 30 chars validada antes de enviar
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #3726 — Nav bar V3 unificada (vista satelite "Providers").
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const PANEL_CSS = `
.mp-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--in-border); margin-bottom: 16px; }
.mp-tab { background: transparent; border: none; color: var(--in-fg-dim); padding: 10px 18px; font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s; }
.mp-tab.active { color: var(--in-fg); border-bottom-color: var(--in-accent); }
.mp-tab:hover { color: var(--in-fg); }
.mp-tabpanel { display: none; }
.mp-tabpanel.active { display: block; }

/* Iconografía sprite (UX #3086 + #3177): los SVG <use> heredan currentColor.
   ic-* siguen la convención de viewBox 24x24 / stroke 1.75 del sprite UX. */
.mp-icon { width: 14px; height: 14px; display: inline-block; vertical-align: -2px; flex: 0 0 auto; }
.mp-icon.lg { width: 20px; height: 20px; vertical-align: -4px; }
.mp-icon.xl { width: 22px; height: 22px; vertical-align: -5px; }

.mp-card { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 16px 18px; margin-bottom: 14px; }
.mp-card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; }
.mp-card-title { font-size: 14px; font-weight: 600; }
.mp-card-sub { color: var(--in-fg-dim); font-size: 12px; }

/* Fila base + soporte de paleta por provider (#3086 — tokens --provider-*).
   El --row-accent se setea inline desde el JS: var(--provider-anthropic) etc. */
.mp-row { display: flex; align-items: center; gap: 14px; padding: 10px 12px; border-bottom: 1px dashed var(--in-border); border-left: 3px solid transparent; border-radius: 4px; }
.mp-row:last-child { border-bottom: none; }
.mp-row.has-provider-accent { border-left-color: var(--row-accent, var(--in-border)); background: linear-gradient(90deg, color-mix(in srgb, var(--row-accent, transparent) 6%, transparent) 0%, transparent 40%); }
.mp-row-label { flex: 0 0 160px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.mp-row-label .mp-icon { color: var(--row-accent, var(--in-fg-dim)); }
.mp-row-input { flex: 1; }
.mp-row-actions { flex: 0 0 auto; display: flex; gap: 6px; }

.mp-mask-wrap { display: inline-flex; align-items: center; gap: 6px; }
.mp-mask { font-family: var(--in-mono, monospace); font-size: 12px; padding: 4px 8px; background: var(--in-bg); border-radius: 4px; display: inline-flex; align-items: center; gap: 6px; }
.mp-mask .mp-icon { color: var(--in-fg-dim); }
.mp-status { font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; display: inline-flex; align-items: center; gap: 4px; }
.mp-status .mp-icon { width: 11px; height: 11px; }
.mp-status.present { background: var(--in-ok-soft); color: var(--in-ok); }
.mp-status.absent { background: var(--in-bad-soft); color: var(--in-bad); }
.mp-status.placeholder { background: var(--in-warn-soft); color: var(--in-warn); }

.mp-btn { background: var(--in-accent); color: #fff; border: none; padding: 7px 14px; font-size: 12px; font-weight: 500; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.mp-btn:hover { filter: brightness(1.08); }
.mp-btn:disabled { opacity: .45; cursor: not-allowed; }
.mp-btn.danger { background: var(--in-bad); }
.mp-btn.ghost { background: transparent; color: var(--in-fg); border: 1px solid var(--in-border); }
.mp-btn.small { padding: 4px 9px; font-size: 11px; }
.mp-btn .mp-icon { width: 13px; height: 13px; }

.mp-input, .mp-select, .mp-textarea { width: 100%; background: var(--in-bg); border: 1px solid var(--in-border); color: var(--in-fg); padding: 7px 9px; font-size: 12px; border-radius: 6px; font-family: inherit; }
.mp-textarea { min-height: 60px; resize: vertical; font-family: var(--in-mono, monospace); }
.mp-input:focus, .mp-select:focus, .mp-textarea:focus { outline: none; border-color: var(--in-accent); }

/* Grilla por agente: cada card recibe --row-accent inline (paleta del provider).
   Override → franja naranja var(--in-warn). NON-DEGRADABLE → franja roja var(--in-bad). */
.mp-skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.mp-skill-card { background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 3px solid var(--row-accent, var(--in-border)); border-radius: var(--in-radius-sm); padding: 12px 14px; position: relative; }
.mp-skill-card.has-override { --row-accent: var(--in-warn); border-color: var(--in-warn); }
.mp-skill-card.non-degradable { --row-accent: var(--in-bad); opacity: .92; }
.mp-skill-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.mp-skill-name { font-weight: 600; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.mp-skill-name .mp-icon { color: var(--row-accent, var(--in-fg-dim)); }
.mp-skill-badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; display: inline-flex; align-items: center; gap: 3px; }
.mp-skill-badge .mp-icon { width: 11px; height: 11px; }
.mp-skill-badge.warn { background: var(--in-warn-soft); color: var(--in-warn); }
.mp-skill-badge.locked { background: var(--in-bad-soft); color: var(--in-bad); font-weight: 600; }
.mp-skill-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-top: 6px; }
.mp-skill-row > label { color: var(--in-fg-dim); flex: 0 0 78px; }
.mp-skill-row select { flex: 1; }

.mp-fallback-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--in-bg); border: 1px solid var(--in-border); border-left: 2px solid var(--row-accent, var(--in-border)); padding: 2px 7px; font-size: 11px; border-radius: 4px; margin: 2px; }
.mp-fallback-chip .mp-icon { color: var(--in-fg-dim); cursor: grab; }
.mp-fallback-chip button { background: transparent; border: none; color: var(--in-fg-dim); cursor: pointer; font-size: 13px; padding: 0; line-height: 1; }
.mp-fallback-add { background: transparent; border: 1px dashed var(--in-border); color: var(--in-fg-dim); padding: 2px 7px; font-size: 11px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.mp-fallback-add .mp-icon { width: 11px; height: 11px; }

.mp-catalog-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mp-catalog-table th, .mp-catalog-table td { padding: 6px 10px; border-bottom: 1px solid var(--in-border); text-align: left; }
.mp-catalog-table th { color: var(--in-fg-dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
.mp-cap-pill { display: inline-block; background: var(--in-bg); color: var(--in-fg-dim); padding: 1px 6px; font-size: 10px; border-radius: 3px; margin-right: 3px; }

.mp-override-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mp-override-table th, .mp-override-table td { padding: 7px 10px; border-bottom: 1px solid var(--in-border); text-align: left; vertical-align: top; }
.mp-override-table th { color: var(--in-fg-dim); font-weight: 500; font-size: 11px; text-transform: uppercase; }
.mp-override-table tr { border-left: 3px solid transparent; }
.mp-override-table tr.has-provider-accent td:first-child { border-left: 3px solid var(--row-accent, var(--in-warn)); padding-left: 12px; }
.mp-ttl-countdown { font-variant-numeric: tabular-nums; color: var(--in-warn); font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
/* #3811 — toggle del kill-switch por provider */
.mp-switch { position: relative; display: inline-block; width: 44px; height: 24px; flex: none; }
.mp-switch input { opacity: 0; width: 0; height: 0; }
.mp-switch .mp-slider { position: absolute; cursor: pointer; inset: 0; background: var(--in-ok, #2ea043); border-radius: 24px; transition: background .15s; }
.mp-switch .mp-slider::before { content: ""; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: transform .15s; }
/* checked == provider APAGADO → rojo + knob a la izquierda */
.mp-switch input:checked + .mp-slider { background: var(--in-bad, #d1242f); }
.mp-switch input:checked + .mp-slider::before { transform: translateX(20px); }
.mp-switch input:disabled + .mp-slider { opacity: .5; cursor: not-allowed; }
.mp-ks-state { font-size: 11px; font-weight: 600; letter-spacing: .03em; }
.mp-ks-state.on { color: var(--in-ok); }
.mp-ks-state.off { color: var(--in-bad); }
.mp-ks-ttl { font-variant-numeric: tabular-nums; color: var(--in-fg-dim); font-size: 11px; }
.mp-ttl-countdown .mp-icon { color: currentColor; }
.mp-ttl-countdown.expiring { color: var(--in-bad); }

.mp-diff-preview { background: var(--in-bg); border: 1px solid var(--in-border); border-radius: 6px; padding: 10px 12px; font-family: var(--in-mono, monospace); font-size: 11.5px; line-height: 1.6; max-height: 220px; overflow-y: auto; }
.mp-diff-line.added { color: var(--in-ok); }
.mp-diff-line.removed { color: var(--in-bad); }
.mp-diff-line.changed { color: var(--in-warn); }

.mp-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: none; align-items: center; justify-content: center; z-index: 9000; }
.mp-modal-bg.open { display: flex; }
.mp-modal { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 10px; width: min(520px, 90vw); max-height: 90vh; overflow-y: auto; padding: 22px 26px; }
.mp-modal h3 { margin: 0 0 14px 0; font-size: 16px; }
.mp-modal .mp-row { padding: 8px 0; }
.mp-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }

.mp-toolbar { display: flex; gap: 10px; margin-bottom: 14px; align-items: center; }
.mp-toolbar .mp-msg { flex: 1; color: var(--in-fg-dim); font-size: 12px; }
`;

function bodyHtml() {
    return `
<section class="in-section">
  <h2 class="in-section-title">
    <span class="in-section-title-icon" aria-hidden="true"><svg class="mp-icon xl" viewBox="0 0 24 24"><use href="/assets/icons/sprite.svg#ic-multi-provider"></use></svg></span>
    Multi-Provider — configuración del pipeline
  </h2>

  <div class="mp-toolbar">
    <button class="mp-btn" id="mp-save-btn" disabled><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-diff"></use></svg>Guardar cambios</button>
    <button class="mp-btn ghost" id="mp-preview-btn"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-diff"></use></svg>Previsualizar diff</button>
    <button class="mp-btn ghost" id="mp-reload-btn"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-reset-default"></use></svg>Reload pipeline</button>
    <span class="mp-msg" id="mp-msg">Cargando…</span>
  </div>

  <div class="mp-tabs" role="tablist">
    <button class="mp-tab active" data-tab="providers" role="tab">1 · Proveedores</button>
    <button class="mp-tab" data-tab="skills" role="tab">2 · Por agente</button>
    <button class="mp-tab" data-tab="catalog" role="tab">3 · Catálogo</button>
    <button class="mp-tab" data-tab="health" role="tab">5 · Health</button>
    <button class="mp-tab" data-tab="overrides" role="tab">6 · Permission overrides</button>
  </div>

  <div class="mp-tabpanel active" id="mp-tab-providers">
    <div class="mp-card">
      <div class="mp-card-head"><div><div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-key"></use></svg> Proveedores y API keys</div><div class="mp-card-sub">Rotación con masking. Anthropic se gestiona vía OAuth/MAX — no editable acá.</div></div></div>
      <div id="mp-providers-list"></div>
    </div>

    <!--
      #3361 — Salud de providers en vivo (movido desde el home).
      Fuente: /api/pulpo/provider-health (cache TTL 5min server-side).
      Polling cliente cada 30s con texto auxiliar de staleness para que el
      operador entienda que el cache hace que los semáforos no sean tiempo
      real estricto. Mapeo canónico reason_code → semáforo definido por UX
      en .pipeline/assets/mockups/narrativa-3361-providers-health-unified.md.
    -->
    <div class="mp-card" id="mp-card-live-providers">
      <div class="mp-card-head">
        <div>
          <div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-provider-health"></use></svg> Salud de providers en vivo</div>
          <div class="mp-card-sub">Ping a cada provider con cache server-side (TTL 5min). Anthropic se gestiona por OAuth Max — figura como "NO APLICA".</div>
        </div>
        <span class="mp-card-sub" id="mp-live-providers-stale" style="font-variant-numeric:tabular-nums"></span>
      </div>
      <div id="mp-live-providers"></div>
      <div class="mp-card-sub" id="mp-live-providers-legend" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px 14px;font-size:11px">
        <span>🟢 verde · authenticated</span>
        <span>⚪ neutro · no aplica / sin key</span>
        <span>🔴 rojo · invalid_credentials</span>
        <span>🟡 amarillo · quota_exhausted</span>
        <span>🟠 naranja · forbidden</span>
      </div>
    </div>

    <!--
      #3811 — Kill-switch operacional por provider. Toggle on/off por provider
      que escribe/borra .pipeline/provider-disabled.json (misma fuente de verdad
      que la CLI manage-providers.sh). Apagar dispara el salto a fallback en
      runtime, igual que una caída del provider.
    -->
    <div class="mp-card" id="mp-card-killswitch">
      <div class="mp-card-head">
        <div>
          <div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-provider-health"></use></svg> Apagar / encender providers</div>
          <div class="mp-card-sub">Kill-switch operacional. Apagar un provider hace que el pipeline salte al siguiente eslabón de la cadena del skill, como si el provider estuviera caído. Default 20 min (auto-restaurado por TTL).</div>
        </div>
      </div>
      <div id="mp-killswitch-list"></div>
    </div>

    <div class="mp-card">
      <div class="mp-card-head"><div><div class="mp-card-title">Default provider</div><div class="mp-card-sub">Provider usado cuando un skill no tiene override.</div></div></div>
      <div class="mp-row">
        <div class="mp-row-label">default_provider</div>
        <div class="mp-row-input"><select class="mp-select" id="mp-default-provider"></select></div>
      </div>
    </div>

    <!-- #3258 — CA-6: distribución del Commander por provider (UX-G2). -->
    <div class="mp-card" id="mp-card-commander-dist">
      <div class="mp-card-head">
        <div>
          <div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-fallback-chain"></use></svg> Distribución del Commander por provider</div>
          <div class="mp-card-sub">% de requests del commander resueltos por cada provider — útil para detectar caídas prolongadas.</div>
        </div>
        <div class="mp-tabs" role="tablist" style="border:0;margin:0">
          <button class="mp-tab active" data-cmd-win="7d">7 días</button>
          <button class="mp-tab" data-cmd-win="1d">24 h</button>
          <button class="mp-tab" data-cmd-win="30d">30 días</button>
        </div>
      </div>
      <div id="mp-cmd-dist-chart" style="margin-top:8px"></div>
      <div id="mp-cmd-dist-legend" class="mp-card-sub" style="margin-top:8px"></div>
    </div>
  </div>

  <div class="mp-tabpanel" id="mp-tab-skills">
    <div class="mp-card">
      <div class="mp-card-head"><div><div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-fallback-chain"></use></svg> Configuración por agente</div><div class="mp-card-sub">Provider + model override + fallbacks. Franja naranja = override activo. Franja roja = skill NON-DEGRADABLE.</div></div></div>
      <div class="mp-skill-grid" id="mp-skills-grid"></div>
    </div>
  </div>

  <div class="mp-tabpanel" id="mp-tab-catalog">
    <div class="mp-card">
      <div class="mp-card-head"><div><div class="mp-card-title">Catálogo de modelos</div><div class="mp-card-sub">Costo USD por 1M tokens (input / output). Capabilities a nivel de modelo.</div></div></div>
      <table class="mp-catalog-table" id="mp-catalog-table">
        <thead><tr><th>Provider</th><th>Modelo</th><th>Context</th><th>Capabilities</th><th>Costo input</th><th>Costo output</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="mp-tabpanel" id="mp-tab-health">
    <div class="mp-card">
      <div class="mp-card-head">
        <div>
          <div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-provider-health"></use></svg> Multi-Provider Health (#3260)</div>
          <div class="mp-card-sub">Snapshot del último healthcheck (cron cada 15min ± 60s, lock anti-thundering-herd). Read-only — el panel NO dispara pings sintéticos.</div>
        </div>
        <button class="mp-btn small" id="mp-health-run-btn"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-reset-default"></use></svg>Forzar tick</button>
      </div>
      <div id="mp-health-kpis" style="display:flex;gap:18px;margin-bottom:14px;font-size:13px"></div>
      <div id="mp-health-providers"></div>
      <div id="mp-health-footer" style="margin-top:10px;color:var(--in-fg-dim);font-size:11px"></div>
    </div>
  </div>

  <div class="mp-tabpanel" id="mp-tab-overrides">
    <div class="mp-card">
      <div class="mp-card-head">
        <div><div class="mp-card-title"><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-override-active"></use></svg> Permission Overrides — vigentes</div><div class="mp-card-sub">TTL countdown en vivo. Revocar quita el override inmediatamente (append-only en audit log).</div></div>
        <button class="mp-btn small" id="mp-override-create-btn"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-override-active"></use></svg>Crear override</button>
      </div>
      <table class="mp-override-table" id="mp-overrides-active">
        <thead><tr><th>Skill</th><th>Provider</th><th>Capabilities diff</th><th>TTL</th><th>Justificación</th><th>Autor</th><th></th></tr></thead>
        <tbody><tr><td colspan="7" style="color:var(--in-fg-dim);text-align:center;padding:18px">— sin overrides activos —</td></tr></tbody>
      </table>
    </div>
    <div class="mp-card">
      <div class="mp-card-head"><div><div class="mp-card-title">Historial</div><div class="mp-card-sub">Expirados / revocados — read-only.</div></div></div>
      <table class="mp-override-table" id="mp-overrides-history">
        <thead><tr><th>Skill</th><th>Provider</th><th>Motivo cierre</th><th>Autor</th><th>Creado</th><th>Cerrado</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
</section>

<div class="mp-modal-bg" id="mp-modal-rotate">
  <div class="mp-modal">
    <h3><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-key-rotate"></use></svg> Rotar API key</h3>
    <p style="color:var(--in-fg-dim);font-size:12px;margin:0 0 12px">Provider: <strong id="mp-rotate-provider"></strong>. La key actual será sobreescrita con backup automático.</p>
    <div class="mp-row"><div class="mp-row-label">Nueva API key</div><div class="mp-row-input"><input type="password" class="mp-input" id="mp-rotate-value" autocomplete="off" placeholder="sk-..."></div></div>
    <div class="mp-modal-actions">
      <button class="mp-btn ghost" onclick="closeModal('mp-modal-rotate')">Cancelar</button>
      <button class="mp-btn" id="mp-rotate-submit"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-key-rotate"></use></svg>Rotar key</button>
    </div>
  </div>
</div>

<div class="mp-modal-bg" id="mp-modal-diff">
  <div class="mp-modal" style="width:min(720px,90vw)">
    <h3><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-diff"></use></svg> Preview de cambios</h3>
    <div class="mp-diff-preview" id="mp-diff-content">—</div>
    <div class="mp-modal-actions">
      <button class="mp-btn ghost" onclick="closeModal('mp-modal-diff')">Cerrar</button>
      <button class="mp-btn" id="mp-diff-apply"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-diff"></use></svg>Aplicar y guardar</button>
    </div>
  </div>
</div>

<div class="mp-modal-bg" id="mp-modal-override">
  <div class="mp-modal">
    <h3><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-override-active"></use></svg> Crear permission override</h3>
    <p style="color:var(--in-fg-dim);font-size:12px;margin:0 0 12px">Concede capabilities adicionales a un par (skill, provider). TTL máx 168h. Skills NON_DEGRADABLE no aparecen en la lista.</p>
    <div class="mp-row"><div class="mp-row-label">Skill</div><div class="mp-row-input"><select class="mp-select" id="mp-ov-skill"></select></div></div>
    <div class="mp-row"><div class="mp-row-label">Provider</div><div class="mp-row-input"><select class="mp-select" id="mp-ov-provider"></select></div></div>
    <div class="mp-row"><div class="mp-row-label">TTL (horas)</div><div class="mp-row-input"><input type="number" class="mp-input" id="mp-ov-ttl" min="1" max="168" value="24"></div></div>
    <div class="mp-row"><div class="mp-row-label">Capabilities diff</div><div class="mp-row-input"><input type="text" class="mp-input" id="mp-ov-caps" placeholder="ej: tool_use_gated, long_running_watcher"></div></div>
    <div class="mp-row"><div class="mp-row-label">Justificación (≥30 chars)</div><div class="mp-row-input"><textarea class="mp-textarea" id="mp-ov-justify" placeholder="Motivo concreto — incidente, validación, etc."></textarea></div></div>
    <div class="mp-modal-actions">
      <button class="mp-btn ghost" onclick="closeModal('mp-modal-override')">Cancelar</button>
      <button class="mp-btn" id="mp-ov-submit"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-override-active"></use></svg>Crear</button>
    </div>
  </div>
</div>

<div class="mp-modal-bg" id="mp-modal-revoke">
  <div class="mp-modal">
    <h3><svg class="mp-icon lg" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-revoke"></use></svg> Revocar override</h3>
    <p style="color:var(--in-fg-dim);font-size:12px;margin:0 0 12px">Hash: <code id="mp-revoke-hash"></code></p>
    <div class="mp-row"><div class="mp-row-label">Motivo (≥10 chars)</div><div class="mp-row-input"><textarea class="mp-textarea" id="mp-revoke-motivo" placeholder="Razón por la que cortás el override antes del TTL."></textarea></div></div>
    <div class="mp-modal-actions">
      <button class="mp-btn ghost" onclick="closeModal('mp-modal-revoke')">Cancelar</button>
      <button class="mp-btn danger" id="mp-revoke-submit"><svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-revoke"></use></svg>Revocar</button>
    </div>
  </div>
</div>
`;
}

const CLIENT_JS = `
let mpState = {
    config: null, edits: null, keys: [], catalog: null, skills: null,
    overrides: { active: [], history: [] }, csrfToken: null, dirty: false,
    // #3361 — snapshot del último GET /api/pulpo/provider-health (live).
    liveProviders: null,
    // #3811 — estado del kill-switch por provider (GET providers-disabled).
    killSwitch: null,
};

function showToast(msg, ok) {
    let t = document.getElementById('in-toast');
    if (!t) {
        t = document.createElement('div'); t.id = 'in-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,.4);transition:opacity .3s;opacity:0;color:#fff';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok === false ? 'var(--in-bad)' : (ok === true ? 'var(--in-ok)' : 'var(--in-brand)');
    t.style.opacity = '1';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

async function fetchJson(url, opts) {
    try {
        const r = await fetch(url, { cache: 'no-store', ...opts });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { return { ok: false, status: r.status, ...data }; }
        return data;
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function fetchCsrf() {
    const r = await fetchJson('/api/multi-provider/csrf-token');
    if (r && r.csrf_token) mpState.csrfToken = r.csrf_token;
    else showToast('No pude obtener token CSRF', false);
}

async function authedPost(url, body, method) {
    if (!mpState.csrfToken) await fetchCsrf();
    return fetchJson(url, {
        method: method || 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': mpState.csrfToken || '',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(body || {}),
    });
}

function setMsg(text) { const el = document.getElementById('mp-msg'); if (el) el.textContent = text; }
function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }
function openModal(id) { const m = document.getElementById(id); if (m) m.classList.add('open'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); }

// =====================================================================
// Sistema visual UX (#3086/#3129 + #3177).
//
// Helpers que consumen los assets entregados por UX en
// .pipeline/assets/icons/sprite.svg (55 símbolos, viewBox 24x24).
// El sprite se sirve estáticamente desde GET /assets/icons/sprite.svg
// (server.js). Los SVG <use> heredan currentColor para integrarse con
// la paleta del theme (var(--in-*) y var(--provider-*)).
// =====================================================================

/**
 * Devuelve el HTML de un ícono del sprite UX por nombre (sin prefijo ic-).
 * @param {string} name — ej. 'multi-provider', 'key', 'shield-lock'.
 * @param {string} size — 'sm' (default 14px), 'lg' (20px), 'xl' (22px).
 * @param {string} aria — label opcional; si falta se marca aria-hidden.
 */
function iconSvg(name, size, aria) {
    const cls = size ? 'mp-icon ' + size : 'mp-icon';
    const accessibility = aria
        ? 'role="img" aria-label="' + escapeHtml(aria) + '"'
        : 'aria-hidden="true"';
    return '<svg class="' + cls + '" viewBox="0 0 24 24" ' + accessibility + '><use href="/assets/icons/sprite.svg#ic-' + name + '"></use></svg>';
}

/**
 * Mapping provider -> token CSS de la paleta --provider-* (#3086).
 * Allowlist cerrada — providers fuera del set caen en provider-unknown
 * (regla R6 anti-fallback documentada en design-tokens.css).
 * @returns {string} el nombre del token CSS (sin var()).
 */
function providerToken(provider) {
    const p = String(provider || '').toLowerCase();
    if (p === 'anthropic') return '--provider-anthropic';
    if (p === 'openai') return '--provider-openai';
    if (p === 'openai-codex' || p === 'codex') return '--provider-openai-codex';
    if (p === 'deterministic') return '--provider-deterministic';
    // #3243 — NVIDIA NIM free provider. Token ya entregado por UX en
    // design-tokens.css (#76B900, contraste 7.6:1 AAA Large). Allowlist
    // del dashboard sigue cerrada (regla R6 anti-fallback); el resto de free
    // providers (gemini-google/cerebras) se cubren en #3326. Groq fue
    // descontinuado en #3353.
    if (p === 'nvidia-nim') return '--provider-nvidia-nim';
    return '--provider-unknown';
}

/**
 * Ícono del sprite que representa al provider (#3086 + #3129).
 * @returns {string} HTML del <svg><use>.
 */
function providerIcon(provider, size) {
    const p = String(provider || '').toLowerCase();
    if (p === 'anthropic') return iconSvg('provider-anthropic', size);
    if (p === 'openai') return iconSvg('provider-openai', size);
    if (p === 'openai-codex' || p === 'codex') return iconSvg('provider-openai-codex', size);
    if (p === 'deterministic') return iconSvg('provider-deterministic', size);
    // #3243 — sprite entregado en .pipeline/assets/icons/sprite.svg
    // (ic-provider-nvidia-nim: nodo + 3 satélites = microservice de inferencia).
    if (p === 'nvidia-nim') return iconSvg('provider-nvidia-nim', size);
    return iconSvg('provider-unknown', size);
}

/**
 * Map status string → ícono de conexión live-ping (CA-4).
 */
function connIcon(status) {
    if (status === 'present') return iconSvg('conn-ok');
    if (status === 'placeholder') return iconSvg('conn-warn');
    return iconSvg('conn-err');
}

async function loadAll() {
    setMsg('Cargando configuración…');
    await fetchCsrf();
    const [cfg, cat, sk, ovs, health, ks] = await Promise.all([
        fetchJson('/api/multi-provider/config'),
        fetchJson('/api/multi-provider/catalog'),
        fetchJson('/api/multi-provider/skills'),
        fetchJson('/api/multi-provider/overrides'),
        fetchJson('/api/multi-provider/health'),
        fetchJson('/api/multi-provider/providers-disabled'),
    ]);
    if (!cfg || !cfg.config) { setMsg('Error cargando config'); return; }
    mpState.config = cfg.config;
    mpState.edits = JSON.parse(JSON.stringify(cfg.config));
    mpState.keys = cfg.keys || [];
    mpState.catalog = cat || null;
    mpState.skills = sk || null;
    mpState.overrides = ovs || { active: [], history: [] };
    mpState.health = health || null;
    mpState.killSwitch = (ks && ks.ok) ? ks.providers : [];
    mpState.dirty = false;
    renderAll();
    setMsg('OK');
}

function renderAll() {
    renderProviders();
    renderKillSwitch();
    renderDefaultProvider();
    renderSkillsGrid();
    renderCatalog();
    renderOverrides();
    renderHealth();
    renderLiveProviders();
    updateSaveBtn();
}

// =====================================================================
// #3361 — Salud de providers en vivo (movida desde el home).
//
// Fuente: GET /api/pulpo/provider-health (cache TTL ≥5min server-side).
// Mapeo canónico reason_code → semáforo (definido por UX en la
// narrativa #3361):
//
//   authenticated      → 🟢 verde   (--in-ok)
//   no_key_configured  → ⚪ neutro  (--in-fg-dim)
//   invalid_credentials→ 🔴 rojo   (--in-bad)
//   quota_exhausted    → 🟡 amarillo (--in-warn)
//   forbidden          → 🟠 naranja (--in-warn / acento)
//   rate_limited       → 🟡 amarillo
//   unknown / *        → 🔴 rojo
//
// Anthropic se marca declarativamente como "NO APLICA" cuando el provider
// trae display_in_health='not_applicable' en agent-models.json. El frontend
// NO hardcodea nombres de provider — usa metadata del endpoint (CA-7).
//
// Defensa XSS (A03): TODO campo interpolado pasa por escapeHtml(). Cero
// innerHTML con strings derivados del response sin escapar.
// =====================================================================

function reasonToVisualState(reason) {
    const r = String(reason || '').toLowerCase();
    if (r === 'authenticated') {
        return { color: 'var(--in-ok)', icon: 'conn-ok', label: 'OK', dot: '🟢' };
    }
    if (r === 'no_key_configured' || r === 'no_ping_endpoint') {
        return { color: 'var(--in-fg-dim)', icon: 'conn-warn', label: 'SIN KEY', dot: '⚪' };
    }
    if (r === 'invalid_credentials') {
        return { color: 'var(--in-bad)', icon: 'conn-err', label: 'INVALID', dot: '🔴' };
    }
    if (r === 'quota_exhausted') {
        return { color: 'var(--in-warn)', icon: 'conn-warn', label: 'QUOTA', dot: '🟡' };
    }
    if (r === 'rate_limited') {
        return { color: 'var(--in-warn)', icon: 'conn-warn', label: 'RATE LIMIT', dot: '🟡' };
    }
    if (r === 'forbidden') {
        return { color: 'var(--in-warn)', icon: 'conn-warn', label: 'FORBIDDEN', dot: '🟠' };
    }
    if (r === 'timeout' || r === 'network_error') {
        return { color: 'var(--in-bad)', icon: 'conn-err', label: 'NET ERROR', dot: '🔴' };
    }
    return { color: 'var(--in-bad)', icon: 'conn-err', label: 'UNKNOWN', dot: '🔴' };
}

function renderLiveProviders() {
    const container = document.getElementById('mp-live-providers');
    if (!container) return;
    const data = mpState.liveProviders;
    if (!data || !Array.isArray(data.providers) || data.providers.length === 0) {
        container.innerHTML = '<div style="color:var(--in-fg-dim);font-size:12px;padding:14px 0">Esperando primer ping…</div>';
        return;
    }
    const rows = data.providers.map(p => {
        const pid = String(p.id || '');
        // Anthropic / OAuth managed → render declarativo "NO APLICA"
        // (sin semáforo amarillo). El flag viene del endpoint (CA-7).
        if (p.display_in_health === 'not_applicable' || p.status === 'not_applicable') {
            return [
                '<div class="mp-row" style="border-left-color:var(--in-fg-dim);border-left-style:dashed">',
                  '<div class="mp-row-label">' + providerIcon(pid) + ' ' + escapeHtml(pid) + '</div>',
                  '<div class="mp-row-input">',
                    '<span class="mp-status" style="background:transparent;color:var(--in-fg-dim);font-weight:600">' + iconSvg('conn-warn') + ' NO APLICA</span>',
                    ' · <code>' + escapeHtml(p.reason || 'oauth_managed') + '</code>',
                  '</div>',
                  '<div class="mp-row-actions" style="color:var(--in-fg-dim);font-size:11px">' + escapeHtml(p.auth_mode || 'oauth') + '</div>',
                '</div>',
            ].join('');
        }
        const vs = reasonToVisualState(p.reason || p.status);
        const cacheAge = Number.isFinite(p.cache_age_s) ? (p.cache_age_s | 0) : 0;
        return [
            '<div class="mp-row" style="border-left-color:' + vs.color + '">',
              '<div class="mp-row-label">' + providerIcon(pid) + ' ' + escapeHtml(pid) + '</div>',
              '<div class="mp-row-input">',
                '<span class="mp-status" style="background:transparent;color:' + vs.color + ';font-weight:600">' + iconSvg(vs.icon) + ' ' + escapeHtml(vs.label) + '</span>',
                ' · <code>' + escapeHtml(p.reason || p.status || '—') + '</code>',
              '</div>',
              '<div class="mp-row-actions" style="color:var(--in-fg-dim);font-size:11px">cache ' + cacheAge + 's</div>',
            '</div>',
        ].join('');
    });
    container.innerHTML = rows.join('');

    // Staleness pill: el cache server-side es ≥5min, dejar claro al operador.
    const staleEl = document.getElementById('mp-live-providers-stale');
    if (staleEl) {
        const maxAge = data.providers.reduce((a, p) => Math.max(a, Number(p.cache_age_s) || 0), 0);
        if (maxAge > 0) {
            const mins = Math.round(maxAge / 60);
            staleEl.textContent = 'cache · ' + (mins > 0 ? mins + ' min' : maxAge + ' s');
        } else {
            staleEl.textContent = 'recién pingeado';
        }
    }
}

async function tickLiveProviders() {
    const r = await fetchJson('/api/pulpo/provider-health');
    if (r && Array.isArray(r.providers)) {
        mpState.liveProviders = r;
        renderLiveProviders();
    }
}

// Renderiza la tarjeta Health del Multi-Provider (CA-3 / #3260).
// Lee mpState.health (snapshot persistido por el cron). NO dispara pings
// sintéticos. Si el snapshot no existe (bootstrap), muestra mensaje
// "esperando primer healthcheck" sin error.
function renderHealth() {
    const kpis = document.getElementById('mp-health-kpis');
    const provsEl = document.getElementById('mp-health-providers');
    const footer = document.getElementById('mp-health-footer');
    if (!kpis || !provsEl) return;
    const h = mpState.health || {};
    if (h.bootstrap || !Array.isArray(h.providers) || h.providers.length === 0) {
        kpis.innerHTML = '<span style="color:var(--in-fg-dim)">— sin datos todavía —</span>';
        provsEl.innerHTML = '<div style="color:var(--in-fg-dim);font-size:12px;padding:14px 0">' + escapeHtml(h.note || 'El cron de healthcheck aún no corrió. Esperá ~15 min o forzá un tick.') + '</div>';
        if (footer) footer.textContent = '';
        return;
    }
    kpis.innerHTML = [
        '<span><strong style="color:var(--in-ok);font-size:22px">' + h.green_count + '</strong> verdes</span>',
        '<span><strong style="color:var(--in-warn);font-size:22px">' + h.yellow_count + '</strong> amarillos</span>',
        '<span><strong style="color:var(--in-bad);font-size:22px">' + h.red_count + '</strong> rojos</span>',
    ].join('');
    const rows = h.providers.map(p => {
        const stateLabel = p.state ? p.state.toUpperCase() : 'UNKNOWN';
        const stateColor = p.state === 'green' ? 'var(--in-ok)' : p.state === 'yellow' ? 'var(--in-warn)' : 'var(--in-bad)';
        const icon = p.state === 'green' ? 'conn-ok' : p.state === 'yellow' ? 'conn-warn' : 'conn-err';
        return [
            '<div class="mp-row" style="border-left-color:' + stateColor + '">',
              '<div class="mp-row-label">' + providerIcon(p.provider) + ' ' + escapeHtml(p.label || p.provider) + '</div>',
              '<div class="mp-row-input">',
                '<span class="mp-status" style="background:transparent;color:' + stateColor + ';font-weight:600">' + iconSvg(icon) + ' ' + escapeHtml(stateLabel) + '</span>',
                ' · <code>' + escapeHtml(p.reason_code || '—') + '</code>',
                p.latency_ms != null ? ' · ' + p.latency_ms + 'ms' : '',
                p.rate_limit_hit_24h ? ' · rate-limit hits 24h: <strong>' + p.rate_limit_hit_24h + '</strong>' : '',
              '</div>',
              '<div class="mp-row-actions" style="color:var(--in-fg-dim);font-size:11px">' + escapeHtml(p.key_status || 'absent') + ' · checked ' + (p.last_checked_at || '—') + '</div>',
            '</div>',
        ].join('');
    });
    provsEl.innerHTML = rows.join('');
    if (footer) {
        const cron = h.cron || {};
        footer.textContent = 'Último snapshot: ' + (h.ts || '?') + ' · cron cada ' + Math.round((cron.tick_interval_ms || 0) / 60000) + ' min ± ' + Math.round((cron.jitter_range_ms || 0) / 1000) + 's.';
    }
}

function renderProviders() {
    const c = document.getElementById('mp-providers-list');
    if (!c) return;
    c.innerHTML = '';
    for (const k of mpState.keys) {
        const row = document.createElement('div');
        // Aplica la paleta --provider-* del UX (#3086) al accent de la fila.
        // El --row-accent se hereda en el ::before / borde izquierdo via CSS.
        row.className = 'mp-row has-provider-accent';
        row.style.setProperty('--row-accent', 'var(' + providerToken(k.provider) + ')');
        const statusClass = k.status;
        const statusLabel = k.status === 'present' ? 'configurada' : k.status === 'placeholder' ? 'placeholder' : 'sin key';
        row.innerHTML = \`
            <div class="mp-row-label" title="Provider \${escapeHtml(k.provider||'')}">
                \${providerIcon(k.provider, 'lg')}
                <span>\${escapeHtml(k.label)}</span>
            </div>
            <div class="mp-row-input">
                <span class="mp-mask">\${iconSvg('key')}\${k.masked ? escapeHtml(k.masked) : '—'}</span>
                <span class="mp-status \${statusClass}" aria-label="Estado: \${statusLabel}">\${connIcon(k.status)}\${statusLabel}</span>
                \${k.fingerprint ? '<span class="mp-card-sub" style="margin-left:8px">fp '+escapeHtml(k.fingerprint.slice(0,8))+'</span>' : ''}
            </div>
            <div class="mp-row-actions">
                <button class="mp-btn small ghost" data-act="ping" data-provider="\${escapeHtml(k.provider)}" \${k.status==='absent'?'disabled':''} title="Live-ping al provider">
                    \${iconSvg('test-ping')}Ping
                </button>
                <button class="mp-btn small" data-act="rotate" data-provider="\${escapeHtml(k.provider)}" \${k.editable?'':'disabled title="'+escapeHtml(k.reason||'')+'"'}>
                    \${iconSvg('key-rotate')}Rotar
                </button>
            </div>\`;
        c.appendChild(row);
    }
    c.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
            const provider = btn.dataset.provider;
            if (btn.dataset.act === 'ping') return pingProvider(provider);
            if (btn.dataset.act === 'rotate') return startRotate(provider);
        });
    });
}

// =====================================================================
// #3811 — Kill-switch operacional por provider.
//
// Toggle on/off por provider. ENCENDIDO (verde) = provider activo;
// APAGADO (rojo, checkbox checked) = el pipeline lo trata como caído y
// salta al siguiente eslabón de la cadena del skill. Escribe vía
// POST /api/multi-provider/providers/:p/disable|enable (con CSRF),
// reutilizando lib/provider-disabled.js (misma fuente de verdad que la CLI).
//
// Defensa XSS (A03): todo nombre/valor interpolado pasa por escapeHtml().
// =====================================================================
function ksTtlText(p) {
    if (!p.disabled) return '';
    if (p.ttl_remaining_ms == null) return 'apagado · permanente';
    const mins = Math.max(0, Math.ceil(p.ttl_remaining_ms / 60000));
    return 'apagado · ' + mins + ' min restantes';
}

function renderKillSwitch() {
    const c = document.getElementById('mp-killswitch-list');
    if (!c) return;
    const providers = mpState.killSwitch || [];
    if (providers.length === 0) {
        c.innerHTML = '<div style="color:var(--in-fg-dim);font-size:12px;padding:14px 0">No hay providers disponibles para el kill-switch.</div>';
        return;
    }
    c.innerHTML = '';
    for (const p of providers) {
        const row = document.createElement('div');
        row.className = 'mp-row has-provider-accent';
        row.style.setProperty('--row-accent', 'var(' + providerToken(p.name) + ')');
        const stateCls = p.disabled ? 'off' : 'on';
        const stateTxt = p.disabled ? 'APAGADO' : 'ENCENDIDO';
        // checkbox.checked == provider APAGADO (el switch rojo significa "caído").
        row.innerHTML = \`
            <div class="mp-row-label" title="Provider \${escapeHtml(p.name)}">
                \${providerIcon(p.name, 'lg')}
                <span>\${escapeHtml(p.name)}</span>
            </div>
            <div class="mp-row-input">
                <span class="mp-ks-state \${stateCls}">\${stateTxt}</span>
                <span class="mp-ks-ttl" style="margin-left:10px">\${escapeHtml(ksTtlText(p))}</span>
            </div>
            <div class="mp-row-actions">
                <label class="mp-switch" title="\${p.disabled ? 'Encender' : 'Apagar'} \${escapeHtml(p.name)}">
                    <input type="checkbox" data-ks-provider="\${escapeHtml(p.name)}" \${p.disabled ? 'checked' : ''}>
                    <span class="mp-slider"></span>
                </label>
            </div>\`;
        c.appendChild(row);
    }
    c.querySelectorAll('input[data-ks-provider]').forEach(input => {
        input.addEventListener('change', () => toggleProvider(input.dataset.ksProvider, input.checked, input));
    });
}

async function toggleProvider(provider, disable, inputEl) {
    if (inputEl) inputEl.disabled = true;
    setMsg((disable ? 'Apagando ' : 'Encendiendo ') + provider + '…');
    const action = disable ? 'disable' : 'enable';
    const r = await authedPost('/api/multi-provider/providers/' + provider + '/' + action, {});
    if (r && r.ok) {
        showToast(provider + (disable ? ' APAGADO' : ' ENCENDIDO'), true);
    } else {
        showToast(provider + ': ' + ((r && (r.message || r.error)) || 'falla'), false);
        // Revertir el toggle visual si falló.
        if (inputEl) inputEl.checked = !disable;
    }
    if (inputEl) inputEl.disabled = false;
    // Refrescar el estado real desde el server (TTL, etc).
    await refreshKillSwitch();
    setMsg('OK');
}

async function refreshKillSwitch() {
    const ks = await fetchJson('/api/multi-provider/providers-disabled');
    mpState.killSwitch = (ks && ks.ok) ? ks.providers : (mpState.killSwitch || []);
    renderKillSwitch();
}

async function pingProvider(provider) {
    setMsg('Ping a ' + provider + '…');
    const r = await authedPost('/api/multi-provider/ping/' + provider, {});
    if (r && r.ok) showToast(provider + ': ' + (r.reason || 'ok') + ' (' + (r.latency_ms||0) + 'ms)', true);
    else showToast(provider + ': ' + (r.reason || 'falla'), false);
    setMsg('OK');
}

function startRotate(provider) {
    document.getElementById('mp-rotate-provider').textContent = provider;
    document.getElementById('mp-rotate-value').value = '';
    openModal('mp-modal-rotate');
    document.getElementById('mp-rotate-submit').onclick = async () => {
        const v = document.getElementById('mp-rotate-value').value || '';
        if (!v.trim()) { showToast('Valor vacío', false); return; }
        const r = await authedPost('/api/multi-provider/keys/' + provider, { newValue: v });
        if (r && r.ok) {
            showToast('Key rotada (fp ' + (r.fingerprint||'').slice(0,8) + ')', true);
            closeModal('mp-modal-rotate');
            await loadAll();
        } else {
            showToast(r.message || 'Falla al rotar', false);
        }
    };
}

function renderDefaultProvider() {
    const sel = document.getElementById('mp-default-provider');
    if (!sel || !mpState.edits) return;
    const opts = Object.keys(mpState.edits.providers || {});
    sel.innerHTML = opts.map(p => '<option value="'+escapeHtml(p)+'">'+escapeHtml(p)+'</option>').join('');
    sel.value = mpState.edits.default_provider;
    sel.onchange = () => {
        mpState.edits.default_provider = sel.value;
        mpState.dirty = true;
        updateSaveBtn();
    };
}

function renderSkillsGrid() {
    const grid = document.getElementById('mp-skills-grid');
    if (!grid || !mpState.edits) return;
    grid.innerHTML = '';
    const providers = Object.keys(mpState.edits.providers || {});
    const nonDegradable = new Set((mpState.skills && mpState.skills.non_degradable) || []);
    const overrideBySkill = {};
    for (const ov of mpState.overrides.active) {
        (overrideBySkill[ov.skill] = overrideBySkill[ov.skill] || []).push(ov);
    }
    const skillNames = Object.keys(mpState.edits.skills || {});
    for (const skill of skillNames) {
        const cfg = mpState.edits.skills[skill];
        const activeOv = overrideBySkill[skill] && overrideBySkill[skill][0];
        const card = document.createElement('div');
        card.className = 'mp-skill-card';
        if (activeOv) card.classList.add('has-override');
        if (nonDegradable.has(skill)) card.classList.add('non-degradable');
        // Paleta del provider primario para la franja lateral (UX #3086).
        // Override y NON-DEGRADABLE tienen --row-accent en sus reglas CSS,
        // por lo que NO se pisa el inline si esas clases están activas
        // (mockup: naranja override / rojo non-degradable mandan).
        if (!activeOv && !nonDegradable.has(skill)) {
            card.style.setProperty('--row-accent', 'var(' + providerToken(cfg.provider) + ')');
        }
        const badges = [];
        if (activeOv) {
            const hoursLeft = Math.max(0, Math.round((activeOv.expires_at - Date.now()) / 3600000));
            badges.push('<span class="mp-skill-badge warn" title="Override activo (TTL ' + hoursLeft + 'h)">' + iconSvg('override-active') + 'override · ' + hoursLeft + 'h</span>');
        }
        if (nonDegradable.has(skill)) badges.push('<span class="mp-skill-badge locked" title="No admite override por diseño de seguridad (fail-CLOSED)">' + iconSvg('shield-lock') + 'NON-DEGRADABLE</span>');
        const provOpts = providers.map(p => '<option value="'+escapeHtml(p)+'" '+(cfg.provider===p?'selected':'')+'>'+escapeHtml(p)+'</option>').join('');
        const fbs = Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [];
        const fbChips = fbs.map((f, i) =>
            '<span class="mp-fallback-chip" style="--row-accent: var(' + providerToken(f) + ')">' +
                iconSvg('drag-handle') +
                providerIcon(f) +
                escapeHtml(f) +
                ' <button data-skill="' + escapeHtml(skill) + '" data-idx="' + i + '" data-act="rmfb" aria-label="Quitar fallback ' + escapeHtml(f) + '">×</button>' +
            '</span>'
        ).join('');
        // En NON-DEGRADABLE el botón reset queda disabled para reforzar el mockup
        // (no se oculta — el operador debe ver la protección, no descubrirla).
        const resetDisabled = nonDegradable.has(skill) ? 'disabled title="Skill NON-DEGRADABLE: no admite reset por override"' : '';
        card.innerHTML = \`
            <div class="mp-skill-head">
                <span class="mp-skill-name">\${providerIcon(cfg.provider)}\${escapeHtml(skill)}</span>
                <div style="margin-left:auto">\${badges.join(' ')}</div>
            </div>
            <div class="mp-skill-row"><label>Provider</label><select class="mp-select" data-skill="\${escapeHtml(skill)}" data-field="provider">\${provOpts}</select></div>
            <div class="mp-skill-row"><label>Modelo</label><input type="text" class="mp-input" data-skill="\${escapeHtml(skill)}" data-field="model_override" placeholder="default del provider" value="\${escapeHtml(cfg.model_override||'')}"></div>
            <div class="mp-skill-row"><label>Fallbacks</label><div style="flex:1">\${fbChips} <button class="mp-fallback-add" data-skill="\${escapeHtml(skill)}" data-act="addfb">\${iconSvg('fallback-chain')}agregar</button></div></div>
            <div class="mp-skill-row" style="font-size:11px;color:var(--in-fg-dim)"><label>Reset</label><button class="mp-btn small ghost" data-skill="\${escapeHtml(skill)}" data-act="reset" \${resetDisabled}>\${iconSvg('reset-default')}Volver al default</button></div>
        \`;
        grid.appendChild(card);
    }
    grid.querySelectorAll('select[data-field], input[data-field]').forEach(el => {
        el.addEventListener('change', () => {
            const skill = el.dataset.skill;
            const field = el.dataset.field;
            const v = el.value || '';
            if (field === 'model_override') {
                if (v.trim()) mpState.edits.skills[skill].model_override = v.trim();
                else delete mpState.edits.skills[skill].model_override;
            } else {
                mpState.edits.skills[skill][field] = v;
            }
            mpState.dirty = true;
            updateSaveBtn();
        });
    });
    grid.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
            const skill = btn.dataset.skill;
            const cfg = mpState.edits.skills[skill];
            if (btn.dataset.act === 'addfb') {
                const candidate = prompt('Nombre del provider a agregar como fallback de ' + skill + ':');
                if (!candidate) return;
                if (!mpState.edits.providers[candidate]) { showToast('provider "'+candidate+'" no existe', false); return; }
                if (candidate === cfg.provider) { showToast('No agregar el primario como fallback', false); return; }
                cfg.fallbacks = cfg.fallbacks || [];
                cfg.fallbacks.push(candidate);
            } else if (btn.dataset.act === 'rmfb') {
                cfg.fallbacks.splice(Number(btn.dataset.idx), 1);
                if (cfg.fallbacks.length === 0) delete cfg.fallbacks;
            } else if (btn.dataset.act === 'reset') {
                cfg.provider = mpState.edits.default_provider;
                delete cfg.model_override;
                delete cfg.fallbacks;
            }
            mpState.dirty = true;
            renderSkillsGrid();
            updateSaveBtn();
        });
    });
}

function renderCatalog() {
    const tbody = document.querySelector('#mp-catalog-table tbody');
    if (!tbody || !mpState.catalog || !mpState.catalog.catalog) return;
    tbody.innerHTML = '';
    for (const [provider, list] of Object.entries(mpState.catalog.catalog)) {
        for (const m of list) {
            const tr = document.createElement('tr');
            // Aplica acento de paleta UX al primer td (#3086 anti-fallback).
            tr.style.setProperty('--row-accent', 'var(' + providerToken(provider) + ')');
            const caps = (m.capabilities||[]).map(c => '<span class="mp-cap-pill">'+escapeHtml(c)+'</span>').join('');
            tr.innerHTML = \`
                <td style="color: var(--row-accent); font-weight: 500;">\${providerIcon(provider)} \${escapeHtml(provider)}</td>
                <td><strong>\${escapeHtml(m.id)}</strong><br><span style="color:var(--in-fg-dim);font-size:11px">\${escapeHtml(m.label||'')}</span></td>
                <td>\${m.context_window ? (m.context_window/1000).toFixed(0)+'k' : '—'}</td>
                <td>\${caps}</td>
                <td>\$\${(m.cost_per_1m && m.cost_per_1m.input != null) ? m.cost_per_1m.input.toFixed(2) : '—'}</td>
                <td>\$\${(m.cost_per_1m && m.cost_per_1m.output != null) ? m.cost_per_1m.output.toFixed(2) : '—'}</td>
            \`;
            tbody.appendChild(tr);
        }
    }
}

function renderOverrides() {
    const activeBody = document.querySelector('#mp-overrides-active tbody');
    const histBody = document.querySelector('#mp-overrides-history tbody');
    if (!activeBody || !histBody) return;
    const active = mpState.overrides.active || [];
    const history = mpState.overrides.history || [];

    if (active.length === 0) {
        activeBody.innerHTML = '<tr><td colspan="7" style="color:var(--in-fg-dim);text-align:center;padding:18px">— sin overrides activos —</td></tr>';
    } else {
        activeBody.innerHTML = '';
        for (const o of active) {
            const tr = document.createElement('tr');
            // Acento naranja (override) + paleta por provider en la primera col (UX #3086).
            tr.className = 'has-provider-accent';
            tr.style.setProperty('--row-accent', 'var(' + providerToken(o.provider) + ')');
            const expiresIn = o.expires_at - Date.now();
            const hours = Math.max(0, Math.round(expiresIn/3600000));
            const expiringClass = hours < 2 ? 'expiring' : '';
            tr.innerHTML = \`
                <td><span class="mp-skill-badge warn">\${iconSvg('override-active')}\${escapeHtml(o.skill)}</span></td>
                <td>\${providerIcon(o.provider)} \${escapeHtml(o.provider)}</td>
                <td><span class="mp-cap-pill">\${(o.capabilities_diff||[]).map(escapeHtml).join(', ')||'—'}</span></td>
                <td><span class="mp-ttl-countdown \${expiringClass}" data-expires="\${o.expires_at}" aria-live="polite">\${iconSvg('ttl-countdown')}\${hours}h</span></td>
                <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis" title="\${escapeHtml(o.justificacion)}">\${escapeHtml(o.justificacion)}</td>
                <td>\${escapeHtml(o.autor)}</td>
                <td style="display:flex;gap:4px">
                    <button class="mp-btn small ghost" data-act="renew" data-hash="\${escapeHtml(o.hash_self)}" title="Renovar TTL (placeholder — #3177 P2)" disabled>\${iconSvg('renew')}</button>
                    <button class="mp-btn small danger" data-act="revoke" data-hash="\${escapeHtml(o.hash_self)}">\${iconSvg('revoke')}Revocar</button>
                </td>
            \`;
            activeBody.appendChild(tr);
        }
        activeBody.querySelectorAll('button[data-act="revoke"]').forEach(btn => {
            btn.addEventListener('click', () => startRevoke(btn.dataset.hash));
        });
    }

    histBody.innerHTML = '';
    for (const h of history.slice(-50).reverse()) {
        const tr = document.createElement('tr');
        tr.className = 'has-provider-accent';
        tr.style.setProperty('--row-accent', 'var(' + providerToken(h.provider) + ')');
        tr.innerHTML = \`
            <td>\${escapeHtml(h.skill)}</td>
            <td>\${providerIcon(h.provider)} \${escapeHtml(h.provider)}</td>
            <td><span class="mp-status \${h.end_reason==='revoked'?'absent':'placeholder'}">\${escapeHtml(h.end_reason)}</span></td>
            <td>\${escapeHtml(h.autor)}</td>
            <td>\${new Date(h.created_at).toLocaleString('es-AR')}</td>
            <td>\${new Date(h.expires_at).toLocaleString('es-AR')}</td>
        \`;
        histBody.appendChild(tr);
    }
}

function startCreateOverride() {
    const skSel = document.getElementById('mp-ov-skill');
    const prSel = document.getElementById('mp-ov-provider');
    const nonDeg = new Set((mpState.skills && mpState.skills.non_degradable) || []);
    const skills = Object.keys(mpState.edits.skills || {}).filter(s => !nonDeg.has(s));
    skSel.innerHTML = skills.map(s => '<option value="'+escapeHtml(s)+'">'+escapeHtml(s)+'</option>').join('');
    prSel.innerHTML = Object.keys(mpState.edits.providers).map(p => '<option value="'+escapeHtml(p)+'">'+escapeHtml(p)+'</option>').join('');
    document.getElementById('mp-ov-ttl').value = 24;
    document.getElementById('mp-ov-caps').value = '';
    document.getElementById('mp-ov-justify').value = '';
    openModal('mp-modal-override');
    document.getElementById('mp-ov-submit').onclick = async () => {
        const payload = {
            skill: skSel.value,
            provider: prSel.value,
            ttl_horas: Number(document.getElementById('mp-ov-ttl').value),
            capabilities_diff: document.getElementById('mp-ov-caps').value.split(',').map(s => s.trim()).filter(Boolean),
            justificacion: document.getElementById('mp-ov-justify').value.trim(),
        };
        if (payload.justificacion.length < 30) { showToast('Justificación min 30 chars', false); return; }
        if (!(payload.ttl_horas >= 1 && payload.ttl_horas <= 168)) { showToast('TTL 1-168h', false); return; }
        const r = await authedPost('/api/multi-provider/overrides', payload);
        if (r && r.ok) {
            showToast('Override creado (hash ' + (r.hash_self||'').slice(0,8) + ')', true);
            closeModal('mp-modal-override');
            await loadAll();
        } else {
            showToast(r.message || 'Falla', false);
        }
    };
}

function startRevoke(hash) {
    document.getElementById('mp-revoke-hash').textContent = hash.slice(0,24) + '…';
    document.getElementById('mp-revoke-motivo').value = '';
    openModal('mp-modal-revoke');
    document.getElementById('mp-revoke-submit').onclick = async () => {
        const motivo = document.getElementById('mp-revoke-motivo').value.trim();
        if (motivo.length < 10) { showToast('Motivo min 10 chars', false); return; }
        const r = await authedPost('/api/multi-provider/overrides/revoke', { target_hash: hash, motivo });
        if (r && r.ok) {
            showToast('Override revocado', true);
            closeModal('mp-modal-revoke');
            await loadAll();
        } else {
            showToast(r.message || 'Falla', false);
        }
    };
}

function updateSaveBtn() {
    const btn = document.getElementById('mp-save-btn');
    if (!btn) return;
    btn.disabled = !mpState.dirty;
}

async function previewDiff() {
    const r = await authedPost('/api/multi-provider/config/diff', { config: mpState.edits });
    if (!r || !r.ok) { showToast(r.message || 'No pude calcular diff', false); return; }
    const div = document.getElementById('mp-diff-content');
    div.innerHTML = (r.summary || []).map(l => {
        let cls = 'mp-diff-line';
        if (l.startsWith('+')) cls += ' added';
        else if (l.startsWith('-')) cls += ' removed';
        else if (l.startsWith('~') || l.startsWith('Default')) cls += ' changed';
        return '<div class="'+cls+'">'+escapeHtml(l)+'</div>';
    }).join('');
    openModal('mp-modal-diff');
    document.getElementById('mp-diff-apply').onclick = saveConfig;
}

async function saveConfig() {
    setMsg('Guardando…');
    const r = await authedPost('/api/multi-provider/config', { config: mpState.edits }, 'PUT');
    if (r && r.ok) {
        showToast('Configuración guardada — backup en ' + (r.backupPath || '?'), true);
        closeModal('mp-modal-diff');
        await loadAll();
    } else {
        if (r && r.errors) {
            const lines = r.errors.map(e => '• ' + (e.path||'') + ' ' + e.message);
            alert('Validación falló:\\n\\n' + lines.join('\\n'));
        }
        showToast(r.message || 'Falla al guardar', false);
        setMsg('Error al guardar');
    }
}

async function reloadPipeline() {
    const r = await authedPost('/api/multi-provider/reload', {});
    if (r && r.ok) showToast('Signal de reload escrito. ' + (r.note||''), true);
    else showToast(r.message || 'Falla', false);
}

function wireTabs() {
    // Top-level tabs (data-tab). Filtramos para NO matchear los sub-tabs de la
    // card "commander-distribution" que usan data-cmd-win (#3258 / UX-G2).
    document.querySelectorAll('.mp-tab[data-tab]').forEach(t => {
        t.addEventListener('click', () => {
            const id = t.dataset.tab;
            document.querySelectorAll('.mp-tab[data-tab]').forEach(x => x.classList.toggle('active', x === t));
            document.querySelectorAll('.mp-tabpanel').forEach(p => p.classList.toggle('active', p.id === 'mp-tab-' + id));
        });
    });
}

// #3258 — CA-6 / UX-G2: distribución del Commander por provider. Carga
// /api/multi-provider/commander-distribution con window 7d/1d/30d y renderiza
// una barra apilada horizontal + leyenda. Default 7d.
async function loadCommanderDistribution(window) {
    const win = window || '7d';
    const target = document.getElementById('mp-cmd-dist-chart');
    const legend = document.getElementById('mp-cmd-dist-legend');
    if (!target || !legend) return;
    let resp;
    try {
        resp = await fetchJson('/api/multi-provider/commander-distribution?window=' + encodeURIComponent(win));
    } catch (e) {
        target.innerHTML = '<span class="mp-card-sub">no se pudo cargar (' + e.message + ')</span>';
        legend.innerHTML = '';
        return;
    }
    if (!resp || !resp.ok) {
        target.innerHTML = '<span class="mp-card-sub">no se pudo cargar</span>';
        legend.innerHTML = '';
        return;
    }
    if (!resp.totalRequests) {
        target.innerHTML = '<span class="mp-card-sub">no hay requests del commander en la ventana ' + win + '</span>';
        legend.innerHTML = '';
        return;
    }
    // Colores por provider — reusa tokens existentes si están, fallback inline.
    const colorFor = (p) => {
        // #3353 — groq removido del mapa de colores tras la descontinuación.
        const map = {
            anthropic: '#d97706',
            'openai-codex': '#10a37f',
            'gemini-google': '#4285f4',
            cerebras: '#8b5cf6',
            'nvidia-nim': '#76b900',
        };
        return map[p] || '#6b7280';
    };
    const providers = Object.keys(resp.byProvider).sort((a, b) => resp.byProvider[b].count - resp.byProvider[a].count);
    let chart = '<div style="display:flex;width:100%;height:24px;border-radius:6px;overflow:hidden;border:1px solid var(--in-border)">';
    for (const p of providers) {
        const stat = resp.byProvider[p];
        const w = Math.max(0.5, stat.pct);
        chart += '<div title="' + p + ': ' + stat.count + ' requests (' + stat.pct + '%)" style="background:' + colorFor(p) + ';width:' + w + '%"></div>';
    }
    chart += '</div>';
    target.innerHTML = chart;
    let legendHtml = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">';
    for (const p of providers) {
        const stat = resp.byProvider[p];
        legendHtml += '<span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:10px;height:10px;background:' + colorFor(p) + ';border-radius:2px"></span>' + p + ' — ' + stat.count + ' (' + stat.pct + '%)</span>';
    }
    legendHtml += '</div>';
    legendHtml += '<div class="mp-card-sub" style="margin-top:6px">Total: ' + resp.totalRequests + ' requests · ventana ' + win + '</div>';
    legend.innerHTML = legendHtml;
}

function wireCommanderDistribution() {
    document.querySelectorAll('.mp-tab[data-cmd-win]').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('.mp-tab[data-cmd-win]').forEach(x => x.classList.toggle('active', x === t));
            loadCommanderDistribution(t.dataset.cmdWin);
        });
    });
    loadCommanderDistribution('7d');
}

function wireToolbar() {
    document.getElementById('mp-save-btn').onclick = previewDiff;
    document.getElementById('mp-preview-btn').onclick = previewDiff;
    document.getElementById('mp-reload-btn').onclick = reloadPipeline;
    document.getElementById('mp-override-create-btn').onclick = startCreateOverride;
    const healthBtn = document.getElementById('mp-health-run-btn');
    if (healthBtn) healthBtn.onclick = forceHealthTick;
}

async function forceHealthTick() {
    setMsg('Disparando healthcheck…');
    const r = await authedPost('/api/multi-provider/health/run', {});
    if (r && r.ok) {
        // Recargar el snapshot.
        const fresh = await fetchJson('/api/multi-provider/health');
        if (fresh) {
            mpState.health = fresh;
            renderHealth();
        }
        showToast('Healthcheck ejecutado (' + (r.providers_pinged || 0) + ' providers pinged)', true);
    } else {
        showToast('No pude disparar healthcheck: ' + (r && (r.message || r.error) || 'unknown'), false);
    }
    setMsg('OK');
}

function tickCountdowns() {
    const now = Date.now();
    document.querySelectorAll('.mp-ttl-countdown').forEach(el => {
        const expires = Number(el.dataset.expires) || 0;
        const hours = Math.max(0, Math.round((expires - now) / 3600000));
        // Re-inyecta el ícono del sprite + texto. Mantiene la accesibilidad
        // (aria-live="polite" anuncia el cambio sin interrumpir lectura).
        el.innerHTML = iconSvg('ttl-countdown') + hours + 'h';
        el.classList.toggle('expiring', hours < 2);
    });
}

wireTabs();
wireToolbar();
wireCommanderDistribution();
loadAll();
// #3361 — Salud live de providers: primer tick inmediato + poll 30s.
tickLiveProviders().catch(()=>{});
setInterval(() => { tickLiveProviders().catch(()=>{}); }, 30000);
setInterval(tickCountdowns, 60000);
setInterval(() => { if (!mpState.dirty) loadAll().catch(()=>{}); }, 30000);
`;

function renderMultiProvider() {
    const theme = loadTheme();
    // #3726 — Nav bar V3 + sprite inline (tab activa = "providers").
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('providers');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Multi-Provider</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
${PANEL_CSS}
</style>
</head>
<body>
<!-- #3726 — Sprite SVG inline para <use href="#ic-tab-*"> dentro del .v3-nav -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Multi-Provider</div>
        <div class="in-header-subtitle">Proveedores, modelos por agente, permission overrides</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${new Date().toLocaleTimeString('es-AR')}</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${bodyHtml()}</main>
  <footer class="in-footer">
    <span>Edits viven en memoria del browser hasta Guardar</span>
    <span>Intrale V3 · #3177</span>
  </footer>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

module.exports = {
    renderMultiProvider,
    bodyHtml,
    PANEL_CSS,
    CLIENT_JS,
};

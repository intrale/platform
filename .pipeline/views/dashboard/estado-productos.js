// =============================================================================
// estado-productos.js — Grid "Estado por producto" del dashboard product-aware
// (Ola Puente P6 · #4778 · split A de #4691 · pieza 2 del mockup 36).
//
// Renderiza UNA card por producto con su estado AISLADO (health/phase + resumen
// de pipeline) y los controles de ciclo de vida (Arrancar/Pausar). Es la pieza
// visual dominante del mockup `36-dashboard-product-aware.svg` (panel 2).
//
// Invariantes de seguridad / criterios:
//   - CA-1.4 (aislamiento · A01): cada card lee EXCLUSIVAMENTE su propio
//     `productState[projectId]`. NUNCA se agrega estado cross-product ni se
//     mezclan datos de A en la card de B. Un producto sin entrada en el mapa se
//     renderiza con estado "sin datos" — jamás con el estado de otro producto.
//   - CA-1.4 (switch cambia el estado mostrado): con `activeProductId` la card
//     activa se resalta y se expande su detalle; seleccionar otro producto
//     (navegación GET del switcher, `?productId=`) re-renderiza con OTRO detalle
//     scopeado. El estado mostrado depende del producto activo.
//   - CA-1.5 (arranque/pausa delega en el kernel): los botones NO mutan estado en
//     la vista; disparan `POST /api/product/{start,pause}` con `{ productId }` +
//     X-CSRF-Token same-origin. "El adaptador pide, el kernel ejecuta". Modal de
//     confirmación que muestra el productId objetivo (SEC-7, sin acción silenciosa).
//   - SEC-1 (defensa UX anti cross-product): color de acento estable por producto
//     (chip + borde de card). NO es control de acceso; el authz es server-side y
//     nunca deriva del productId en banda.
//   - CA-5.1 (retro-compat): con 1 producto → una sola card, sin regresión.
//   - WCAG AA: estado NUNCA depende sólo del color (ícono ●/⏸/▶/🌱 + rótulo).
//   - Todo dato reflejado (name/projectId/phase) se escapa por contexto.
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadThemeCss() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

let renderProductSwitcherSsr;
try {
    ({ renderProductSwitcherSsr } = require('./product-switcher.js'));
} catch {
    renderProductSwitcherSsr = () => '';
}

// #5724 CA-4 — Banner "Dispatch suspendido por desync". Esta vista arma su
// propio shell (no pasa por `pageShell`), así que el banner se monta a mano.
// Require defensivo como el resto del módulo: si no carga, la vista renderiza
// igual sin banner en vez de romper.
//
// Nota: este shell no incluye FETCH_CLIENT_JS, así que el poll de refresco no
// tiene `fetchJson` y falla en silencio (el bundle lo contempla). Lo que queda
// es el SSR, que ya es correcto al cargar la página — es justo lo que hace
// falta acá, porque el bloqueo dura horas y esta ventana no es de kiosko.
let _dsbResolve = () => null;
let _dsbRender = () => '';
let _DSB_CSS = '';
let _dsbBundle = () => '';
try {
    ({
        resolveDesyncStatus: _dsbResolve,
        renderDesyncBlockBannerSsr: _dsbRender,
        DESYNC_BLOCK_BANNER_CSS: _DSB_CSS,
        desyncBlockBannerBundleJs: _dsbBundle,
    } = require('./desync-block-banner.js'));
} catch { /* opcional */ }

// El ícono del banner es un `<use href="#ic-pause-lock">`: sin el sprite
// inlineado en el documento no resuelve y el banner queda sin su símbolo de
// alarma (#5724 rev-3). Esta vista no cargaba ningún sprite.
let _loadIconSprite = () => '';
try {
    // eslint-disable-next-line global-require
    const nav = require('./nav-tabs');
    if (typeof nav.loadIconSprite === 'function') _loadIconSprite = nav.loadIconSprite;
} catch { /* opcional */ }

// #4778 · pieza 3 del mockup 36 — bandeja GATE 2 filtrada por producto. Require
// defensivo (fail-open): si el módulo no carga, la vista igual renderiza el grid
// (pieza 2) sin la bandeja. El filtrado por productId es responsabilidad del
// propio módulo (CA-2.1); acá sólo se le pasa el producto activo.
let esperandoFirmaView = null;
try { esperandoFirmaView = require('./esperando-firma.js'); } catch { /* opcional */ }

const slug = 'estado-productos';

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
function isSafeProductId(id) {
    return typeof id === 'string' && SAFE_ID_RE.test(id) && !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

// Paleta de acentos (design tokens V3). El índice es estable por productId (hash
// determinista) para que un producto tenga SIEMPRE el mismo color — awareness
// anti cross-product (SEC-1, defensa UX). No es control de acceso.
const ACCENT_PALETTE = Object.freeze(['#00D6FF', '#BC8CFF', '#2DD4BF', '#E8770D', '#3FB950', '#F778BA', '#D29922', '#1890FF']);
function accentFor(projectId) {
    const s = String(projectId || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff; }
    return ACCENT_PALETTE[h % ACCENT_PALETTE.length];
}

// Metadata de estado (dual-encoding: ícono + rótulo, nunca sólo color · WCAG).
const STATE_META = Object.freeze({
    active: { icon: '●', label: 'Operando', cls: 'ep-state-ok' },
    paused: { icon: '⏸', label: 'Pausado', cls: 'ep-state-paused' },
    onboarding: { icon: '🌱', label: 'Onboarding', cls: 'ep-state-onboarding' },
    inactive: { icon: '○', label: 'Inactivo', cls: 'ep-state-inactive' },
    unknown: { icon: '—', label: 'Sin datos', cls: 'ep-state-unknown' },
    archived: { icon: 'A', label: 'Archivado', cls: 'ep-state-archived' },
});
function stateMeta(st) {
    return STATE_META[st] || STATE_META.unknown;
}

// Normaliza un número no-negativo para las métricas del resumen de pipeline.
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Resumen de pipeline de UN producto desde su estado namespaceado (whitelist).
// Sólo lee `raw.metrics` del PROPIO producto — nunca agrega cross-product.
function pipelineSummary(raw) {
    const m = (raw && typeof raw.metrics === 'object' && raw.metrics) ? raw.metrics : {};
    return {
        activos: num(m.activos),
        pendientes: num(m.pendientes),
        bloqueados: num(m.bloqueados),
        procesados: num(m.procesados),
    };
}

function metricChip(label, value, extraCls) {
    return `<div class="ep-metric${extraCls ? ' ' + extraCls : ''}">`
        + `<span class="ep-metric-val">${escapeHtmlText(String(value))}</span>`
        + `<span class="ep-metric-lbl">${escapeHtmlText(label)}</span>`
        + '</div>';
}

// Botones de ciclo de vida según el estado actual. Delegan en el kernel por POST
// (CA-1.5 · #4805 CA-1/CA-4). Reglas de habilitación (el disable es SÓLO UX; la
// validación real es server-side, CA-2/CA-3):
//   - Activar (#4805): SÓLO en `onboarding` (promueve status onboarding→active).
//   - Arrancar: producto listo para trabajo sin ola en curso — `paused`,
//     `inactive` o `unknown` (activo sin estado de runtime todavía, CA-4).
//   - Pausar: sólo con una ola operando (`active`).
// Glyph `⏻` (Activar) es visualmente distinto de `▶` (Arrancar) y `⏸` (Pausar)
// para no confundir "promover estado" con "arrancar trabajo" (guideline UX).
function lifecycleButtons(projectId, st) {
    const pidAttr = escapeHtmlAttr(projectId);
    const pidText = escapeHtmlText(projectId);
    const canActivate = st === 'onboarding';
    const canStart = st === 'paused' || st === 'inactive' || st === 'unknown';
    const canPause = st === 'active';
    const canEdit = st === 'active' || st === 'onboarding';
    const canDeactivate = st === 'active' || st === 'onboarding';
    const edit = `<button type="button" class="ep-btn ep-btn-edit" ${canEdit ? '' : 'disabled '}`
        + `data-action="edit" data-pid="${pidAttr}" `
        + `aria-label="Editar el descriptor del producto ${pidText}" title="Editar descriptor">`
        + `${waveIco('edit')} Editar</button>`;
    const deactivate = `<button type="button" class="ep-btn ep-btn-deactivate" ${canDeactivate ? '' : 'disabled '}`
        + `data-action="deactivate" data-pid="${pidAttr}" `
        + `aria-label="Desactivar el producto ${pidText}" title="Desactivar (archivar)">`
        + `${waveIco('archive-box')} Desactivar</button>`;
    const activate = `<button type="button" class="ep-btn ep-btn-activate" ${canActivate ? '' : 'disabled '}`
        + `data-action="activate" data-pid="${pidAttr}" `
        + `aria-label="Activar el producto ${pidText}" title="Activar (promueve onboarding→activo)">`
        + '<span aria-hidden="true">⏻</span> Activar</button>';
    const start = `<button type="button" class="ep-btn ep-btn-start" ${canStart ? '' : 'disabled '}`
        + `data-action="start" data-pid="${pidAttr}" `
        + `aria-label="Arrancar el producto ${pidText}" title="Arrancar (delega en el kernel)">`
        + '<span aria-hidden="true">▶</span> Arrancar</button>';
    const pause = `<button type="button" class="ep-btn ep-btn-pause" ${canPause ? '' : 'disabled '}`
        + `data-action="pause" data-pid="${pidAttr}" `
        + `aria-label="Pausar el producto ${pidText}" title="Pausar (delega en el kernel)">`
        + '<span aria-hidden="true">⏸</span> Pausar</button>';
    return `<div class="ep-actions">${edit}${deactivate}${activate}${start}${pause}</div>`;
}

// #4809 · Estado de la PRIMERA ola del producto, derivado EXCLUSIVAMENTE de su
// propio namespace (`raw = productState[projectId]`) — nunca cross-product (CA-4).
// Tres estados visibles (el 4º, la confirmación mutante, lo maneja el client
// script mostrando el productId objetivo · SEC-7):
//   - 'associated' (D): la primera ola ya está asociada (`raw.wave`).
//   - 'gated'      (B): descriptor incompleto ⇒ gate + salida al wizard. El
//                       `disabled` de la CTA es SÓLO cosmético; el gate real es
//                       server-side fail-closed en el drainer (CA-2).
//   - 'ready'      (A): descriptor completo, sin ola ⇒ CTA habilitada + slot vacío.
function waveMeta(raw) {
    const w = (raw && typeof raw.wave === 'object' && raw.wave) ? raw.wave : null;
    const associated = !!(w && (w.associated === true || w.version != null || w.value !== undefined));
    if (associated) return { state: 'associated' };
    // Flag de completitud SÓLO para UX (disabled cosmético). Ausente ⇒ se asume
    // completo (la autoridad es el rechazo server-side, no este flag).
    const descriptorComplete = !(raw && raw.descriptorComplete === false);
    return { state: descriptorComplete ? 'ready' : 'gated' };
}

// Ícono del sprite V3 (`#ic-*`) para los elementos NUEVOS de ola (no emojis del
// SO · guideline UX). Siempre acompañado de rótulo textual (WCAG AA).
function waveIco(id) {
    return `<svg class="ep-ico" aria-hidden="true"><use href="#ic-${id}"/></svg>`;
}

// Fila de la primera ola dentro de la card. Consume tokens/clases existentes
// (`ep-btn`, `ep-badge`-like) + íconos del sprite; sin colores hardcodeados fuera
// de los fallbacks de token ya usados en el resto de la vista.
function waveRow(projectId, wmeta, readOnly) {
    const pidAttr = escapeHtmlAttr(projectId);
    const pidText = escapeHtmlText(projectId);
    if (wmeta.state === 'associated') {
        // D — Ola inicial asociada + nota de aislamiento (store namespaceado, CA-4).
        return '<div class="ep-wave ep-wave-associated">'
            + `<span class="ep-wave-chip">${waveIco('wave')} Ola inicial — Asociada</span>`
            + `<span class="ep-wave-note">${waveIco('allowlist-check')} Estado aislado de este producto</span>`
            + '</div>';
    }
    if (wmeta.state === 'gated') {
        // B — Gate descriptor incompleto (fail-closed server-side) + salida al wizard.
        return '<div class="ep-wave ep-wave-gated">'
            + `<div class="ep-wave-gate">${waveIco('shield-lock')} <span>Falta completar el descriptor</span> `
            + `<a class="ep-wave-wizard" href="/dashboard?view=onboarding" `
            + `aria-label="Completar el descriptor del producto ${pidText} en el wizard">Completar →</a></div>`
            + `<button type="button" class="ep-btn ep-btn-wave" disabled data-action="create-wave" data-pid="${pidAttr}" `
            + `aria-label="Crear la primera ola de ${pidText} (bloqueado: descriptor incompleto)" `
            + 'title="Crear primera ola (bloqueado: completá el descriptor)">'
            + `${waveIco('wave-add')} Crear primera ola</button>`
            + '</div>';
    }
    // A — Descriptor completo, sin ola: CTA habilitada + slot vacío legible.
    return '<div class="ep-wave ep-wave-ready">'
        + `<span class="ep-wave-empty">${waveIco('wave')} Sin ola asociada todavía</span>`
        + `<button type="button" class="ep-btn ep-btn-wave" ${readOnly ? 'disabled ' : ''}data-action="create-wave" data-pid="${pidAttr}" `
        + `aria-label="Crear la primera ola del producto ${pidText}" `
        + 'title="Crear/asociar la primera ola (delega en el kernel)">'
        + `${waveIco('wave-add')} Crear primera ola</button>`
        + '</div>';
}

// Card de UN producto. `raw` es EXCLUSIVAMENTE el estado del propio producto
// (productState[projectId]); nunca se le pasa el mapa agregado (CA-1.4).
function productCard(product, raw, activeProductId) {
    const projectId = product.projectId;
    const accent = accentFor(projectId);
    // El estado efectivo sale del propio namespace; si no hay entrada, mapeamos el
    // status del descriptor (onboarding/inactive) o 'unknown' (sin datos).
    let st = raw && typeof raw.state === 'string' ? raw.state : null;
    if (product.status === 'archived') st = 'archived';
    if (!st) st = (product.status === 'onboarding') ? 'onboarding' : (product.status === 'active' ? 'unknown' : 'inactive');
    const meta = stateMeta(st);
    const phase = raw && typeof raw.phase === 'string' ? raw.phase : '';
    const sum = pipelineSummary(raw);
    const isActive = isSafeProductId(activeProductId) && activeProductId === projectId;

    const head = `<div class="ep-card-head">`
        + `<span class="ep-dot" style="background:${escapeHtmlAttr(accent)}" aria-hidden="true"></span>`
        + `<span class="ep-name">${escapeHtmlText(product.name || projectId)}</span>`
        + `<span class="ep-badge ${meta.cls}"><span aria-hidden="true">${escapeHtmlText(meta.icon)}</span> ${escapeHtmlText(meta.label)}</span>`
        + '</div>';

    const idRow = `<div class="ep-idrow"><span class="ep-pid">${escapeHtmlText(projectId)}</span>`
        + (phase ? `<span class="ep-phase">· ${escapeHtmlText(phase)}</span>` : '')
        + '</div>';

    const metrics = `<div class="ep-metrics">`
        + metricChip('Activos', sum.activos)
        + metricChip('Pendientes', sum.pendientes)
        + metricChip('Bloqueados', sum.bloqueados, sum.bloqueados > 0 ? 'ep-metric-warn' : '')
        + metricChip('Procesados', sum.procesados)
        + '</div>';

    const noData = (st === 'unknown')
        ? '<div class="ep-nodata">Sin estado disponible para este producto todavía.</div>'
        : '';

    return `<article class="ep-card${isActive ? ' ep-card-active' : ''}" `
        + `data-pid="${escapeHtmlAttr(projectId)}" data-state="${escapeHtmlAttr(st)}"`
        + (isActive ? ' aria-current="true"' : '')
        + ` style="--ep-accent:${escapeHtmlAttr(accent)}">`
        + head
        + idRow
        + metrics
        + noData
        + waveRow(projectId, waveMeta(raw), st === 'archived')
        + lifecycleButtons(projectId, st)
        + '</article>';
}

function estadoProductosStyle() {
    return `<style>
.ep-panel{margin-bottom:16px}
.ep-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:16px;font-weight:800;color:var(--in-fg,#e6edf3);margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(0,214,255,.28)}
.ep-header-title{display:flex;align-items:center;gap:8px}
.ep-switch-slot{margin-left:auto}
.ep-note{font-size:11.5px;color:var(--in-fg-dim,#8A93A6);background:rgba(0,214,255,.06);border:1px solid rgba(0,214,255,.2);border-radius:8px;padding:7px 10px;margin-bottom:12px}
.ep-scoped{font-size:12px;color:var(--in-fg,#e6edf3);background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.12));border-left:3px solid var(--brand-cyan,#00D6FF);border-radius:8px;padding:8px 12px;margin-bottom:12px}
.ep-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.ep-card{border:1px solid var(--in-border,rgba(255,255,255,.12));border-top:3px solid var(--ep-accent,#00D6FF);border-radius:12px;padding:14px 16px;background:var(--in-bg-2,#161B22);display:flex;flex-direction:column;gap:10px}
.ep-card[data-state="archived"]{opacity:.78}
.ep-card-active{box-shadow:0 0 0 2px var(--ep-accent,#00D6FF);background:rgba(0,214,255,.04)}
.ep-card-head{display:flex;align-items:center;gap:8px}
.ep-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}
.ep-name{font-size:14px;font-weight:800;color:var(--in-fg,#e6edf3)}
.ep-badge{margin-left:auto;font-size:10.5px;font-weight:800;border-radius:999px;padding:2px 9px;display:inline-flex;align-items:center;gap:4px}
.ep-state-ok{color:#9be9a8;background:rgba(63,185,80,.14);border:1px solid rgba(63,185,80,.32)}
.ep-state-paused{color:#fcd9a0;background:rgba(210,153,34,.14);border:1px solid rgba(210,153,34,.32)}
.ep-state-onboarding{color:#9ff0e6;background:rgba(45,212,191,.14);border:1px solid rgba(45,212,191,.32)}
.ep-state-archived{color:#a9b1c2;background:rgba(138,147,166,.12);border:1px solid rgba(138,147,166,.34)}
.ep-state-inactive{color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.05);border:1px solid var(--in-border,rgba(255,255,255,.14))}
.ep-state-unknown{color:var(--in-fg-soft,#5B6376);background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.1))}
.ep-idrow{font-size:11px;color:var(--in-fg-soft,#5B6376);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ep-phase{color:var(--in-fg-dim,#8A93A6)}
.ep-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.ep-metric{display:flex;flex-direction:column;align-items:center;gap:2px;background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.08));border-radius:8px;padding:6px 4px}
.ep-metric-val{font-size:15px;font-weight:800;color:var(--in-fg,#e6edf3)}
.ep-metric-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--in-fg-soft,#5B6376)}
.ep-metric-warn .ep-metric-val{color:#fcd9a0}
.ep-nodata{font-size:11px;color:var(--in-fg-soft,#5B6376);font-style:italic}
.ep-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:8px;margin-top:2px}
.ep-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:12px;font-weight:800;border-radius:9px;padding:8px 10px;border:1px solid transparent;cursor:pointer}
.ep-btn:focus-visible{outline:2px solid var(--brand-cyan,#00D6FF);outline-offset:2px}
.ep-btn-activate{color:#fff;background:var(--in-brand,#1f6feb);border-color:var(--in-brand,#1f6feb)}
.ep-btn-start{color:#001b22;background:var(--brand-cyan,#00D6FF);border-color:var(--brand-cyan,#00D6FF)}
.ep-btn-pause{color:var(--in-fg,#e6edf3);background:rgba(255,255,255,.05);border-color:var(--in-border,rgba(255,255,255,.16))}
.ep-btn-edit{color:var(--in-fg,#e6edf3);background:rgba(255,255,255,.05);border-color:var(--in-border,rgba(255,255,255,.16))}
.ep-btn-deactivate{color:#fca5a5;background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.32)}
.ep-btn-wave{color:#001b22;background:var(--brand-cyan,#00D6FF);border-color:var(--brand-cyan,#00D6FF)}
.ep-btn:disabled{opacity:.4;cursor:not-allowed}
.ep-ico{width:13px;height:13px;flex:0 0 auto;fill:currentColor}
.ep-wave{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.02);border:1px solid var(--in-border,rgba(255,255,255,.08))}
.ep-wave-empty,.ep-wave-chip,.ep-wave-note,.ep-wave-gate{display:inline-flex;align-items:center;gap:5px;font-size:11.5px}
.ep-wave-empty{color:var(--in-fg-soft,#5B6376)}
.ep-wave-associated{border-color:rgba(45,212,191,.32);background:rgba(45,212,191,.08)}
.ep-wave-chip{color:#9ff0e6;font-weight:800}
.ep-wave-note{color:var(--in-fg-soft,#5B6376)}
.ep-wave-gated{border-color:rgba(210,153,34,.3);background:rgba(210,153,34,.06)}
.ep-wave-gate{color:#fcd9a0;flex-wrap:wrap}
.ep-wave-wizard{color:var(--brand-cyan,#00D6FF);text-decoration:none;font-weight:800}
.ep-btn-new{flex:0 0 auto;text-decoration:none}
.ep-result{margin-top:12px;font-size:12px;border-radius:9px;padding:10px 12px;display:none}
.ep-result-ok{display:block;color:#9be9a8;background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3)}
.ep-result-err{display:block;color:#fca5a5;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3)}
.ep-gate-tray{margin-top:18px;padding-top:14px;border-top:1px solid var(--in-border,rgba(255,255,255,.1))}
.ep-subhead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:var(--in-fg,#e6edf3);margin:0 0 10px}
</style>`;
}

/**
 * #6208 rev3 — Producto efectivo de las filas de la bandeja GATE 2 que el kernel
 * NO tipa por producto (hoy: TODAS las firmables del depósito, que salen con
 * `productId: null`).
 *
 * Sin esto, `esperando-firma.js` las atribuía al literal legacy `'intrale'`, un
 * projectId que NO está en el catálogo (`.pipeline/descriptors/` sólo tiene
 * `intrale-platform`): el filtro por producto activo las descartaba TODAS y la
 * bandeja embebida jamás mostraba una firma real, con cartel verde de "nada
 * esperando tu firma". Falso éxito silencioso — justo lo que el issue mata.
 *
 * Resolución, en orden y sin adivinar:
 *   1. el producto con `role === 'primary'` del catálogo vivo;
 *   2. si el catálogo tiene un único producto, ese;
 *   3. si no se puede resolver (multi-producto sin primario), el producto ACTIVO
 *      ⇒ las filas sin tipar quedan VISIBLES en la bandeja que el operador está
 *      mirando. Fail-open hacia la visibilidad a propósito: una firma sin
 *      producto no puede "filtrarse" a otro producto (no pertenece a ninguno),
 *      pero esconderla en silencio sí sería el bug que estamos matando.
 *
 * @param {Array}  list catálogo efectivo ya filtrado por id seguro.
 * @param {?string} activeProductId producto activo (ya validado).
 * @returns {?string} projectId al que pertenecen las filas sin tipar, o null.
 */
function untypedProductId(list, activeProductId) {
    const rows = Array.isArray(list) ? list.filter(p => p && isSafeProductId(p.projectId)) : [];
    const primary = rows.find(p => p.role === 'primary');
    if (primary) return primary.projectId;
    if (rows.length === 1) return rows[0].projectId;
    return isSafeProductId(activeProductId) ? activeProductId : null;
}

/**
 * Fragmento SSR del grid "estado por producto". Escapa todo dato reflejado.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.products]     catálogo `{projectId,name,status,role}`.
 * @param {object} [opts.productState] mapa `projectId → estado namespaceado`.
 * @param {string} [opts.activeProductId] producto activo (del switcher/URL).
 * @param {string} [opts.basePath]     base para los enlaces del switcher.
 * @param {Array}  [opts.esperandoFirma] filas de la bandeja GATE 2 (read model).
 * @param {object} [opts.esperandoFirmaInbox] #6208 rev3 · metadatos del read model
 *   (`vacio`/`banda`/`degraded`). Sin ellos el componente de firma cae al vacío
 *   VERDE aunque el depósito esté ilegible.
 * @returns {string} HTML del grid.
 */
function renderEstadoProductosSsr(opts = {}) {
    const products = Array.isArray(opts.products) ? opts.products.filter(p => p && isSafeProductId(p.projectId)) : [];
    const productState = (opts.productState && typeof opts.productState === 'object') ? opts.productState : {};
    const activeProductId = isSafeProductId(opts.activeProductId) ? opts.activeProductId : null;
    const basePath = (typeof opts.basePath === 'string' && opts.basePath) ? opts.basePath : '/dashboard?view=estado-productos';

    // Retro-compat: sin productos legibles ⇒ producto único Intrale (CA-5.1).
    const list = products.length ? products : [{ projectId: 'intrale', name: 'Intrale', status: 'active', role: 'primary' }];

    const switcher = renderProductSwitcherSsr({
        products: list,
        activeProductId: activeProductId || undefined,
        basePath,
    });

    // Detalle scopeado: hace explícito "sobre qué producto estás operando" cuando
    // hay un producto activo. Cambiar el switch cambia este encabezado + qué card
    // queda resaltada/expandida (verificable: el switch cambia el estado mostrado).
    let scoped = '';
    if (activeProductId) {
        const active = list.find(p => p.projectId === activeProductId);
        if (active) {
            scoped = `<div class="ep-scoped" role="status">Operando sobre <b>${escapeHtmlText(active.name || active.projectId)}</b> `
                + `(<span class="ep-pid">${escapeHtmlText(active.projectId)}</span>) — el estado de otros productos no se mezcla.</div>`;
        }
    }

    // CA-1.4: cada card recibe SÓLO su propio namespace (nunca el mapa agregado).
    const cards = list.map(p => productCard(p, productState[p.projectId], activeProductId)).join('');

    // Pieza 3 (CA-2.1/CA-2.2): bandeja GATE 2 filtrada por el producto activo. Sólo
    // se muestra con un producto activo (el filtro es explícito); el módulo de firma
    // valida el producto efectivo de cada ítem, nunca el productId en banda sin
    // validar. Fail-open: sin el módulo, la sección no se renderiza.
    let gateTray = '';
    if (activeProductId && esperandoFirmaView && typeof esperandoFirmaView.renderEsperandoFirmaSsr === 'function') {
        try {
            const trayState = {
                esperandoFirma: Array.isArray(opts.esperandoFirma) ? opts.esperandoFirma : [],
                // #6208 rev3 — los metadatos del read model viajan también acá.
                // Sin ellos el componente cae a `renderEmptyStateSsr(null)` ⇒
                // vacío VERDE "leí la lista entera y estaba vacía" incluso con el
                // depósito del kernel ilegible, y la banda de índice incompleto
                // tampoco se repone. Es el falso éxito silencioso que mata #6208.
                esperandoFirmaInbox: (opts.esperandoFirmaInbox && typeof opts.esperandoFirmaInbox === 'object')
                    ? opts.esperandoFirmaInbox
                    : null,
            };
            const trayHtml = esperandoFirmaView.renderEsperandoFirmaSsr(trayState, {
                productId: activeProductId,
                // #6208 rev3 — las filas FIRMABLES del depósito vienen con
                // `productId: null` (el kernel todavía no las tipa por producto).
                // El producto efectivo de esas filas es el producto PRIMARIO REAL
                // del catálogo, no el literal legacy 'intrale' (que no existe en
                // `.pipeline/descriptors/`): con el literal, el filtro las
                // descartaba todas y la bandeja embebida nunca mostraba una firma.
                untypedProductId: untypedProductId(list, activeProductId),
            });
            gateTray = '<div class="ep-gate-tray">'
                + '<h3 class="ep-subhead"><span aria-hidden="true">✍️</span> Firmas pendientes de este producto (GATE 2)</h3>'
                + trayHtml + '</div>';
        } catch { gateTray = ''; }
    }

    return `<main id="view-content" class="ep-panel" data-slug="${slug}">`
        + estadoProductosStyle()
        + '<div class="ep-header">'
        + '<span class="ep-header-title"><span aria-hidden="true">🗂</span> Estado por producto</span>'
        + `<span class="ep-switch-slot">${switcher}</span>`
        + '<a href="/dashboard?view=onboarding" class="ep-btn ep-btn-start ep-btn-new" '
        + 'aria-label="Crear un nuevo producto (abre el wizard de alta)" '
        + 'title="Nuevo producto">'
        + '<span aria-hidden="true">➕</span> Nuevo producto</a>'
        + '</div>'
        + '<div class="ep-note">Cada card muestra el estado <b>aislado</b> de su producto (coordination-store namespaceado por <code>projectId</code>) — nunca datos de otro producto. Arrancar/Pausar delega en el kernel.</div>'
        + scoped
        + `<div class="ep-grid">${cards}</div>`
        + '<div class="ep-result" id="ep-result" role="status" aria-live="polite"></div>'
        + gateTray
        + '</main>';
}

// Client script: Arrancar/Pausar. SEC-7 — confirmación con el productId objetivo +
// POST con X-CSRF-Token same-origin (GET token → POST). Sin GET con efecto.
function renderEstadoProductosClientScript() {
    return `
(function(){
  function epEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }
  function epResult(ok,msg){
    var box=document.getElementById('ep-result'); if(!box) return;
    box.className='ep-result '+(ok?'ep-result-ok':'ep-result-err');
    box.innerHTML=(ok?'✅ ':'❌ ')+epEsc(msg);
  }
  // #4805 — 'activate' promueve onboarding→activo (flip de estado, no spawnea):
  // feedback inline SIN modal destructivo (UX). 'start' SÍ confirma (acción costosa
  // = spawn real de agentes/tokens). 'pause' confirma igual que antes.
  // #4809 — 'create-wave' crea/asocia la primera ola: confirma mostrando el
  // productId objetivo (SEC-7, estado C del mockup, sin acción silenciosa).
  var EP_VERBS={activate:'activar',start:'arrancar',pause:'pausar','create-wave':'crear la primera ola de','deactivate':'desactivar'};
  var EP_NEEDS_CONFIRM={start:true,pause:true,'create-wave':true,'deactivate':true};
  // Endpoint por acción (default: la propia acción). 'create-wave' → /api/product/wave.
  var EP_ENDPOINT={'create-wave':'wave',deactivate:'deactivate'};
  // Mensaje de confirmación por acción — SIEMPRE con el productId objetivo (SEC-7).
  var EP_CONFIRM={
    start:function(pid){return '¿Confirmás arrancar el producto "'+pid+'"? La acción la ejecuta el kernel.';},
    pause:function(pid){return '¿Confirmás pausar el producto "'+pid+'"? La acción la ejecuta el kernel.';},
    'create-wave':function(pid){return '¿Confirmás crear/asociar la primera ola del producto "'+pid+'"? La ejecuta el kernel (create-once, no duplica; gate del descriptor server-side).';}
  };
  EP_CONFIRM.deactivate=function(pid){
    return 'Dar de baja el producto "'+pid+'"?\\n\\n'
      + '- Pasa a estado ARCHIVADO (soft-delete auditable, NO se borra el descriptor).\\n'
      + '- Si tiene una ola en curso: los agentes ya despachados terminan solos, pero no recibira nuevos slots. Otros productos no se ven afectados.\\n'
      + '- La ejecuta el kernel; la confirmacion esta protegida por un nonce single-use.';
  };
  async function epControl(action,pid,btn){
    if(!pid){ epResult(false,'Falta el identificador de producto.'); return; }
    if(action==='edit'){
      window.location.href='/dashboard?view=onboarding&editProduct='+encodeURIComponent(pid);
      return;
    }
    var verb=EP_VERBS[action]||action;
    if(EP_NEEDS_CONFIRM[action]){
      var cmsg=EP_CONFIRM[action]?EP_CONFIRM[action](pid):('¿Confirmás '+verb+' el producto "'+pid+'"? La acción la ejecuta el kernel.');
      if(!window.confirm(cmsg)) return;
    }
    if(btn) btn.disabled=true;
    try {
      var t=await fetch('/api/product/csrf-token',{cache:'no-store'});
      var tj=await t.json();
      var token=tj&&tj.csrf_token;
      if(!token){ epResult(false,'No pude obtener el token CSRF; recargá y reintentá.'); return; }
      var endpoint=EP_ENDPOINT[action]||action;
      var payload={ productId: pid };
      if(action==='deactivate'){
        var nr=await fetch('/api/product/deactivate-nonce',{
          method:'POST',
          headers:{'Content-Type':'application/json','X-CSRF-Token':token},
          body:JSON.stringify({ productId: pid })
        });
        var nj=await nr.json();
        if(!nj||!nj.ok||!nj.nonce){ epResult(false,(nj&&nj.msg)||'No se pudo preparar la confirmacion.'); return; }
        payload.nonce=nj.nonce;
      }
      var r=await fetch('/api/product/'+endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':token},
        body:JSON.stringify(payload)
      });
      var j=await r.json();
      if(j&&j.ok){
        var okMsg=(j.msg)||((action==='activate')
          ? ('Producto "'+pid+'" activado. Ya podés arrancar la primera ola.')
          : (action==='create-wave')
            ? ('Pedido de creación de la primera ola encolado para "'+pid+'".')
            : ('Pedido de '+verb+' encolado para "'+pid+'".'));
        epResult(true,okMsg);
      }
      else { epResult(false,(j&&j.msg)||('Rechazado ('+((j&&j.code)||'error')+')')); }
    } catch(e){ epResult(false,'Error enviando el pedido: '+e.message); }
    finally { if(btn) btn.disabled=false; }
  }
  document.addEventListener('click',function(ev){
    var btn=ev.target.closest && ev.target.closest('.ep-btn[data-action]');
    if(!btn||btn.disabled) return;
    epControl(btn.getAttribute('data-action'), btn.getAttribute('data-pid'), btn);
  });
})();
`;
}

/**
 * Documento completo de la vista `?view=estado-productos` (SSR shell autocontenido).
 */
function renderEstadoProductos(opts = {}) {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>Intrale · Estado por producto</title>'
        + '<style>' + loadThemeCss() + '</style>'
        + '<style>' + _DSB_CSS + '</style>'
        + '</head><body style="background:var(--in-bg,#0D1117);color:var(--in-fg,#e6edf3);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px">'
        + '<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' + _loadIconSprite() + '</div>'
        + '<div style="max-width:1040px;margin:0 auto">'
        + '<a href="/dashboard" style="color:var(--brand-cyan,#00D6FF);text-decoration:none;font-size:12px">← Volver al dashboard</a>'
        // #5724 CA-4 — dispatch suspendido por desync, arriba del estado por
        // producto: si el dispatch está frenado, TODOS los productos están
        // frenados y el grid de abajo muestra un avance que no va a moverse.
        + _dsbRender(_dsbResolve(opts && opts.desyncStatus))
        + renderEstadoProductosSsr(opts)
        + '</div>'
        + '<script>' + renderEstadoProductosClientScript() + '</script>'
        + '<script>' + _dsbBundle() + '</script>'
        // Client script de la bandeja GATE 2 (firma/rechazo con CSRF) — sólo si el
        // módulo cargó. Sin él, la bandeja embebida se ve pero sus botones no operan.
        + ((esperandoFirmaView && typeof esperandoFirmaView.renderEsperandoFirmaClientScript === 'function')
            ? '<script>' + esperandoFirmaView.renderEsperandoFirmaClientScript() + '</script>'
            : '')
        + '</body></html>';
}

module.exports = {
    slug,
    renderEstadoProductos,
    renderEstadoProductosSsr,
    renderEstadoProductosClientScript,
    // Helpers exportados para tests.
    accentFor,
    pipelineSummary,
    stateMeta,
    waveMeta,
    isSafeProductId,
    untypedProductId,
    ACCENT_PALETTE,
    STATE_META,
};

// =============================================================================
// product-switcher.js — Selector de producto del dashboard product-aware
// (Ola Puente P6 · #4778 · split A de #4691).
//
// Switch de producto SOLO-VISTA (CA-1.3 · SEC-1): cambiar de producto sólo cambia
// el `?productId=` de la URL (navegación GET), NUNCA concede permisos. La
// autorización se valida server-side en cada endpoint contra el contexto de la
// instancia (out-of-band) — jamás desde el `productId` en banda. El color de
// acento por producto es una defensa UX anti cross-product, no un control de
// acceso (guidelines UX 4778).
//
// Retro-compat (CA-5.1): con 0 o 1 producto, se renderiza un badge estático
// "Intrale" (sin selector) — mismo comportamiento que hoy, sin regresión.
//
// Seguridad: TODO nombre/id de producto (dato de config) se escapa por contexto.
// El componente no muta estado ni ofrece acciones; sólo enlaces GET.
// =============================================================================
'use strict';

let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

// Mismo patrón de id seguro que el kernel (project-descriptor.isSafeId). Se filtra
// defensivamente: un producto con id inseguro no se ofrece en el selector.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
function isSafeProductId(id) {
    return typeof id === 'string' && SAFE_ID_RE.test(id) && !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

const DEFAULT_PRODUCT = Object.freeze({ projectId: 'intrale', name: 'Intrale' });

/**
 * Normaliza la lista de productos: filtra ids inseguros, deduplica y garantiza
 * al menos el producto único (Intrale) para retro-compat.
 * @param {Array<{projectId:string,name?:string,status?:string}>} products
 * @returns {Array<{projectId:string,name:string,status:string}>}
 */
function normalizeProducts(products) {
    const seen = new Set();
    const out = [];
    for (const p of Array.isArray(products) ? products : []) {
        const id = p && p.projectId;
        if (!isSafeProductId(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ projectId: id, name: (p && p.name) ? String(p.name) : id, status: (p && p.status) ? String(p.status) : 'active' });
    }
    if (out.length === 0) out.push({ ...DEFAULT_PRODUCT, status: 'active' });
    return out;
}

/**
 * Fragmento SSR del selector de producto. Solo-vista: enlaces GET que cambian
 * `?productId=`. Con ≤1 producto ⇒ badge estático (retro-compat CA-5.1).
 *
 * @param {object} [opts]
 * @param {Array}  [opts.products]  productos disponibles (config del kernel).
 * @param {string} [opts.activeProductId]  producto activo actual (de la vista).
 * @param {string} [opts.basePath]  path base para los enlaces (default: '/dashboard').
 * @returns {string} HTML del selector.
 */
function renderProductSwitcherSsr(opts = {}) {
    const products = normalizeProducts(opts.products);
    const activeRaw = opts.activeProductId;
    const active = isSafeProductId(activeRaw) && products.some(p => p.projectId === activeRaw)
        ? activeRaw
        : products[0].projectId;
    const basePath = (typeof opts.basePath === 'string' && opts.basePath) ? opts.basePath : '/dashboard';

    // Retro-compat: 1 solo producto ⇒ badge estático, sin selector.
    if (products.length <= 1) {
        const only = products[0];
        return `<div class="mz-projsel mz-projsel-single" data-single="1" aria-label="${escapeHtmlAttr('Producto activo: ' + only.name)}">`
            + productSwitcherStyle()
            + `<span class="mz-projsel-dot" aria-hidden="true"></span>`
            + `<span class="mz-projsel-name">${escapeHtmlText(only.name)}</span>`
            + `<span class="mz-projsel-hint">producto único</span>`
            + '</div>';
    }

    const activeMeta = products.find(p => p.projectId === active) || products[0];
    const links = products.map(p => {
        const isActive = p.projectId === active;
        // Navegación GET solo-vista — sin efecto de estado (SEC-7a).
        const href = `${escapeHtmlAttr(basePath)}?productId=${escapeHtmlAttr(encodeURIComponent(p.projectId))}`;
        return `<a class="mz-projsel-opt${isActive ? ' mz-projsel-opt-active' : ''}" role="menuitemradio" `
            + `aria-checked="${isActive ? 'true' : 'false'}" href="${href}" `
            + `title="${escapeHtmlAttr('Ver el producto ' + p.name + ' (solo vista, no concede permisos)')}">`
            + `<span class="mz-projsel-optdot" data-pid="${escapeHtmlAttr(p.projectId)}" aria-hidden="true"></span>`
            + `<span>${escapeHtmlText(p.name)}</span>`
            + (p.status !== 'active' ? `<span class="mz-projsel-badge">${escapeHtmlText(p.status)}</span>` : '')
            + '</a>';
    }).join('');

    return `<div class="mz-projsel" data-active="${escapeHtmlAttr(active)}" aria-label="${escapeHtmlAttr('Selector de producto — activo: ' + activeMeta.name)}">`
        + productSwitcherStyle()
        + `<details class="mz-projsel-details">`
        + `<summary class="mz-projsel-summary"><span class="mz-projsel-dot" data-pid="${escapeHtmlAttr(active)}" aria-hidden="true"></span>`
        + `<span class="mz-projsel-name">${escapeHtmlText(activeMeta.name)}</span>`
        + `<span class="mz-projsel-caret" aria-hidden="true">▾</span></summary>`
        + `<div class="mz-projsel-menu" role="menu" aria-label="Cambiar de producto (solo vista)">${links}`
        + `<div class="mz-projsel-note">El switch es solo vista — no concede permisos.</div>`
        + `</div></details>`
        + '</div>';
}

function productSwitcherStyle() {
    return `<style>
.mz-projsel{display:inline-flex;align-items:center;gap:8px;font-size:12px;position:relative}
.mz-projsel-dot,.mz-projsel-optdot{width:9px;height:9px;border-radius:50%;background:var(--brand-cyan,#00D6FF);display:inline-block;flex:0 0 auto}
.mz-projsel-name{font-weight:800;color:var(--in-fg,#e6edf3)}
.mz-projsel-hint{font-size:10px;color:var(--in-fg-soft,#5B6376)}
.mz-projsel-details{position:relative}
.mz-projsel-summary{display:inline-flex;align-items:center;gap:7px;cursor:pointer;list-style:none;background:rgba(255,255,255,.04);border:1px solid var(--in-border,rgba(255,255,255,.12));border-radius:999px;padding:4px 11px}
.mz-projsel-summary::-webkit-details-marker{display:none}
.mz-projsel-caret{font-size:9px;color:var(--in-fg-dim,#8A93A6)}
.mz-projsel-menu{position:absolute;top:110%;left:0;z-index:40;min-width:200px;background:var(--in-bg-2,#1C2128);border:1px solid var(--in-border,rgba(255,255,255,.14));border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.mz-projsel-opt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;text-decoration:none;color:var(--in-fg,#e6edf3);font-weight:600}
.mz-projsel-opt:hover{background:rgba(255,255,255,.06)}
.mz-projsel-opt-active{background:rgba(0,214,255,.1)}
.mz-projsel-badge{font-size:9px;font-weight:800;text-transform:uppercase;color:#fcd9a0;background:rgba(245,158,11,.14);border-radius:999px;padding:1px 6px;margin-left:auto}
.mz-projsel-note{font-size:10px;color:var(--in-fg-soft,#5B6376);padding:6px 9px 3px;border-top:1px solid var(--in-border,rgba(255,255,255,.08));margin-top:4px}
</style>`;
}

module.exports = {
    renderProductSwitcherSsr,
    normalizeProducts,
    isSafeProductId,
    DEFAULT_PRODUCT,
};

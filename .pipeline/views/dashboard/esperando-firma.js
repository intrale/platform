// =============================================================================
// esperando-firma.js — Vista SSR de la bandeja "Esperando tu firma" del
// dashboard V3. Un solo lugar donde el operador ve TODOS los issues que esperan
// su firma (los tres orígenes de `lib/waiting-operator.js`) con evidencia +
// sugerencia inline y las acciones Aprobar/Rechazar.
//
// Issue: #4580 (épico #4570 — gates de firma del operador).
// Diseño / mockup: `.pipeline/assets/mockups/36-esperando-firma-v3.svg` (UX).
// Estructura: calca el panel análogo `bloqueados.js` (#3729).
//
// Seguridad (CA-3 / CA-4 + análisis de `security`):
//   - REQ-SEC-4580-2 (BLOQUEANTE · Stored XSS): TODA evidencia/sugerencia (dato
//     no confiable: bodies de issues, outputs de agentes) se escapa server-side
//     con escapeHtmlText/escapeHtmlAttr (lib/escape-html.js) y se pinta como
//     texto inerte. NUNCA innerHTML crudo (el dashboard ya tuvo XSS en
//     showDotPopup). El payload `<script>` cae como texto.
//   - REQ-SEC-4580-1 (BLOQUEANTE · CSRF): las acciones son POST + X-CSRF-Token
//     same-origin (GET /api/gate-signature/csrf-token → POST
//     /api/gate-signature/decide). La UI NO ofrece ningún disparador GET mutante.
//   - `issue` se coacciona con safeIssueNumber() antes de interpolarse en
//     onclick/aria-label; si falla, la fila se descarta.
//
// El dashboard NO muta `.pipeline/**`: el POST reenvía la decisión al backend de
// firma (#4579) que delega la transición al kernel (`pulpo.js`) de forma
// idempotente (invariante "el adaptador pide, el kernel ejecuta", #4571 §5.1).
// =============================================================================
'use strict';

// #3722 — Escape HTML server-side unificado. escapeHtmlText para contexto
// nodo-texto, escapeHtmlAttr para contexto atributo. Fallback inline
// (defense-in-depth) por si el require fallara en un checkout transitorio.
let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

const slug = 'esperando-firma';

// #4778 · GATE 2 product-aware. Id de producto seguro (mismo patrón que
// project-descriptor.isSafeId). Sirve para filtrar la bandeja por producto
// (CA-2.1) y para atar la firma al productId (CA-2.2 · no repudio).
const SAFE_PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// CA-5.1 — retro-compat: un ítem sin productId pertenece al producto único.
const DEFAULT_PRODUCT_ID = 'intrale';

function safeProductId(raw) {
    const s = String(raw == null ? '' : raw);
    return SAFE_PRODUCT_ID_RE.test(s) ? s : null;
}

// Producto efectivo de un ítem de la bandeja: su productId si es seguro, si no el
// producto único (Intrale). NUNCA cruza productos: un id inseguro NO se propaga.
function productIdOf(p) {
    return safeProductId(p && p.productId) || DEFAULT_PRODUCT_ID;
}

// CA-5 / defensa en profundidad — coerción numérica estricta de `p.issue` antes
// de interpolar en onclick/aria-label. Devuelve el entero positivo o null.
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Dual-encoding del ORIGEN (WCAG AA · nunca solo color): color + icono + etiqueta
// textual. Espeja las guidelines UX del mockup 36-esperando-firma-v3.svg.
const ORIGENES = Object.freeze({
    'waiting-operator-def': { icon: '⚑', label: 'GATE 1 · Definición', cls: 'ef-origen-def' },
    'waiting-operator-acc': { icon: '🛡', label: 'GATE 2 · Aceptación', cls: 'ef-origen-acc' },
    'gate3': { icon: '⚠', label: 'GATE 3 · Acción autónoma', cls: 'ef-origen-gate3' },
});
function origenMeta(origen) {
    return ORIGENES[origen] || { icon: '•', label: String(origen || 'desconocido'), cls: 'ef-origen-otro' };
}

// Edad legible compacta: "47min" / "29h".
function fmtAge(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h) || h < 0) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
    return Math.round(h) + 'h';
}

// Severidad por antigüedad (mismo criterio que Bloqueados): fresh <4h, warning
// 4-24h, danger ≥24h.
function severityOf(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h)) return 'info';
    if (h >= 24) return 'danger';
    if (h >= 4) return 'warning';
    return 'info';
}

// Verbo de la sugerencia → color/etiqueta con TRIPLE encoding (color + forma del
// glifo + verbo). El % nunca comunica solo por color.
const SUGERENCIA_VERBOS = Object.freeze({
    aprobar: { glyph: '▲', label: 'SUGIERE APROBAR', cls: 'ef-sug-aprobar' },
    revisar: { glyph: '◆', label: 'SUGIERE REVISAR', cls: 'ef-sug-revisar' },
    rechazar: { glyph: '▼', label: 'SUGIERE RECHAZAR', cls: 'ef-sug-rechazar' },
});

// REQ-SEC-4580-2 — render de la sugerencia inline (índice de confiabilidad).
// TODO string escapado. Sin sugerencia ⇒ nota neutra (no un score inventado).
function renderSuggestion(sug) {
    if (!sug || typeof sug !== 'object') {
        return '<div class="ef-sug ef-sug-none">Sin sugerencia disponible — decisión 100% del operador</div>';
    }
    const v = SUGERENCIA_VERBOS[sug.verbo] || SUGERENCIA_VERBOS.revisar;
    const total = Number(sug.total) || 0;
    const soloH = Number(sug.solo_humanos) || 0;
    const detalle = soloH > 0
        ? `${soloH}/${total} criterio(s) solo-humano`
        : `${total} criterio(s) máquina-verificable(s)`;
    return `<div class="ef-sug ${v.cls}" role="group" aria-label="${escapeHtmlAttr(v.label + ' · ' + detalle)}">`
        + `<span class="ef-sug-glyph" aria-hidden="true">${escapeHtmlText(v.glyph)}</span>`
        + `<span class="ef-sug-verb">${escapeHtmlText(v.label)}</span>`
        + `<span class="ef-sug-detail">${escapeHtmlText(detalle)}</span>`
        + '</div>';
}

const EVIDENCE_MAX_ROWS = 12;

// REQ-SEC-4580-2 — render de la evidencia inline. La evidencia ya viene redactada
// server-side (REQ-SEC-4580-5, lib/waiting-operator.loadEvidence). Acá TODO se
// escapa por contexto: un payload `<script>` en cualquier campo cae como texto.
function renderEvidence(evidencia) {
    const list = Array.isArray(evidencia) ? evidencia.slice(0, EVIDENCE_MAX_ROWS) : [];
    if (list.length === 0) {
        return '<div class="ef-ev ef-ev-empty">Sin evidencia adjunta</div>';
    }
    const rows = list.map((e) => {
        const agente = escapeHtmlText((e && e.agente) || '?');
        const fase = escapeHtmlText((e && e.fase) || '');
        const tipo = escapeHtmlText((e && e.tipo) || '');
        const artefacto = escapeHtmlText((e && (e.artefacto || e.motivo)) || '');
        const sensible = e && e.sensible
            ? '<span class="ef-ev-sensible" title="Contenido marcado como sensible (redactado)">🔒</span>'
            : '';
        return '<li class="ef-ev-item">'
            + `<span class="ef-ev-agente">${agente}</span>`
            + (fase ? `<span class="ef-ev-fase">${fase}</span>` : '')
            + (tipo ? `<span class="ef-ev-tipo">${tipo}</span>` : '')
            + (artefacto ? `<span class="ef-ev-artefacto">${artefacto}</span>` : '')
            + sensible
            + '</li>';
    }).join('');
    return '<div class="ef-ev"><div class="ef-ev-label">📎 Evidencia</div><ul class="ef-ev-list">' + rows + '</ul></div>';
}

// Una fila de pendiente de firma. Devuelve '' si `p.issue` no coacciona a entero
// positivo (fila descartada). Todo dato externo escapado por contexto.
function renderRowSsr(p) {
    const issueNum = safeIssueNumber(p && p.issue);
    if (issueNum === null) return '';
    const om = origenMeta(p && p.origen);
    const sev = severityOf(p && p.age_hours);
    const ageTxt = fmtAge(p && p.age_hours);
    const skillTxt = (p && p.skill != null) ? String(p.skill) : '';
    const phaseTxt = (p && p.phase != null) ? String(p.phase) : '';
    const pipelineTxt = (p && p.pipeline != null) ? String(p.pipeline) : '';
    const origenAttr = escapeHtmlAttr(String((p && p.origen) || ''));

    // #4778 · productId seguro para atar la firma al producto (CA-2.2). Sólo se
    // pasa como 3er arg del handler si el ítem trae un productId EXPLÍCITO y seguro
    // (retro-compat: los ítems del producto único siguen sin 3er arg).
    const explicitPid = safeProductId(p && p.productId);
    const pidArg = explicitPid ? `, '${explicitPid}'` : '';
    const productAttr = explicitPid ? ` data-product="${escapeHtmlAttr(explicitPid)}"` : '';
    const productChip = explicitPid
        ? `<span class="ef-product" title="${escapeHtmlAttr('Producto ' + explicitPid)}">▣ ${escapeHtmlText(explicitPid)}</span>`
        : '';

    return `<div class="ef-row ef-sev-${sev}" id="esperando-firma-row-${issueNum}" data-issue="${issueNum}" data-origen="${origenAttr}" data-severity="${sev}"${productAttr}>
      <span class="ef-rail" aria-hidden="true"></span>
      <div class="ef-row-head">
        <div class="ef-row-info">
          <span class="ef-origen ${om.cls}" title="${escapeHtmlAttr(om.label)}"><span aria-hidden="true">${escapeHtmlText(om.icon)}</span> ${escapeHtmlText(om.label)}</span>
          ${productChip}
          <a href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer"><b>#${issueNum}</b></a>
          <span class="ef-meta">${escapeHtmlText(skillTxt || '?')} en ${escapeHtmlText(phaseTxt || '?')}${pipelineTxt ? ' · ' + escapeHtmlText(pipelineTxt) : ''}</span>
          <span class="ef-age ef-age-${sev}" title="${escapeHtmlAttr('Esperando hace ' + ageTxt + ' · severidad ' + sev)}" aria-label="${escapeHtmlAttr('Esperando hace ' + ageTxt)}">⏱ hace ${escapeHtmlText(ageTxt)}</span>
        </div>
        <div class="ef-row-actions">
          <button class="ef-btn ef-btn-approve" onclick="gateSignatureDecide(${issueNum}, 'aprobar'${pidArg})" title="${escapeHtmlAttr('Aprobar firma de #' + issueNum)}" aria-label="${escapeHtmlAttr('Aprobar firma del issue #' + issueNum)}">✓ Aprobar</button>
          <button class="ef-btn ef-btn-reject" onclick="gateSignatureDecide(${issueNum}, 'rechazar'${pidArg})" title="${escapeHtmlAttr('Rechazar firma de #' + issueNum)}" aria-label="${escapeHtmlAttr('Rechazar firma del issue #' + issueNum)}">✕ Rechazar</button>
        </div>
      </div>
      ${renderSuggestion(p && p.sugerencia)}
      ${renderEvidence(p && p.evidencia)}
      <div class="ef-secnote" aria-hidden="true">Acción vía POST + X-CSRF-Token · el kernel ejecuta la transición</div>
    </div>`;
}

// Empty-state celebratorio: la ausencia de firmas pendientes es buen estado.
function renderEmptyStateSsr() {
    return '<section class="ef-empty" id="esperando-firma-empty" role="status">'
        + '<div class="ef-empty-icon" aria-hidden="true">✓</div>'
        + '<div class="ef-empty-title">Nada esperando tu firma</div>'
        + '<div class="ef-empty-sub">Ningún gate retiene una promoción a la espera del operador.</div>'
        + '</section>';
}

// CSS inline del panel. Va inline en el fragmento para que funcione tanto
// standalone como embebido en el monolito (la home no carga theme.css). Reusa
// las variables --in-* del tema; los acentos siguen el mockup UX (info/púrpura/
// teal/ámbar/verde/rojo, todos ≥ AA sobre surface-2).
function esperandoFirmaStyle() {
    return `<style>
.ef-panel{margin-bottom:16px}
.ef-header{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:16px;font-weight:800;color:var(--in-fg,#e6edf3);margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(88,166,255,.28)}
.ef-header .ef-pen{font-size:15px}
.ef-badge{font-size:11px;font-weight:800;color:#bcd8ff;background:rgba(88,166,255,.14);border:1px solid rgba(88,166,255,.34);border-radius:999px;padding:1px 9px;font-variant-numeric:tabular-nums}
.ef-row{position:relative;background:var(--in-bg-2,#1C2128);border:1px solid var(--in-border,rgba(255,255,255,.08));border-radius:12px;padding:12px 14px 12px 18px;margin-bottom:10px;overflow:hidden}
.ef-rail{position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--in-info,#58A6FF)}
.ef-sev-warning .ef-rail{background:var(--in-warning,#F59E0B)}
.ef-sev-danger .ef-rail{background:var(--in-danger,#F87171)}
.ef-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ef-row-info{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.ef-row-info a{color:var(--in-info,#58A6FF);text-decoration:none}
.ef-row-info a:hover{text-decoration:underline}
.ef-origen{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:.3px;border-radius:8px;padding:2px 9px;border:1px solid transparent}
.ef-origen-def{color:#d6bcff;background:rgba(188,140,255,.14);border-color:rgba(188,140,255,.36)}
.ef-origen-acc{color:#9ff0e6;background:rgba(45,212,191,.14);border-color:rgba(45,212,191,.36)}
.ef-origen-gate3{color:#fcd9a0;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.36)}
.ef-origen-otro{color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.05);border-color:var(--in-border,rgba(255,255,255,.12))}
.ef-product{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;letter-spacing:.3px;color:#bcd8ff;background:rgba(0,214,255,.12);border:1px solid rgba(0,214,255,.34);border-radius:8px;padding:1px 8px}
.ef-meta{font-size:12px;color:var(--in-fg-dim,#8A93A6)}
.ef-age{font-size:11px;font-weight:700;color:var(--in-fg-dim,#8A93A6)}
.ef-age-warning{color:#fdba74}
.ef-age-danger{color:#fca5a5}
.ef-row-actions{display:flex;gap:8px;flex-wrap:wrap}
.ef-btn{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:800;border-radius:9px;padding:8px 16px;border:1px solid transparent;cursor:pointer}
.ef-btn:focus-visible{outline:2px solid var(--in-accent,#38bdf8);outline-offset:2px}
.ef-btn-approve{color:#0a1f14;background:var(--in-success,#3FB950);border-color:rgba(63,185,80,.6)}
.ef-btn-approve:hover{filter:brightness(1.08)}
.ef-btn-reject{color:#fecaca;background:rgba(248,113,113,.16);border-color:rgba(248,113,113,.5)}
.ef-btn-reject:hover{background:rgba(248,113,113,.26)}
.ef-btn:disabled{opacity:.5;cursor:not-allowed}
.ef-sug{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11.5px;font-weight:700;border-radius:9px;padding:6px 11px;border:1px solid var(--in-border,rgba(255,255,255,.1))}
.ef-sug-glyph{font-size:12px}
.ef-sug-verb{font-weight:800;letter-spacing:.4px}
.ef-sug-detail{color:var(--in-fg-dim,#8A93A6);font-weight:600}
.ef-sug-aprobar{color:#9be9a8;background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.3)}
.ef-sug-revisar{color:#fcd9a0;background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3)}
.ef-sug-rechazar{color:#fca5a5;background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.3)}
.ef-sug-none{color:var(--in-fg-soft,#5B6376);background:rgba(255,255,255,.03)}
.ef-ev{margin-top:10px}
.ef-ev-empty{margin-top:10px;font-size:11.5px;color:var(--in-fg-soft,#5B6376)}
.ef-ev-label{font-size:10px;font-weight:800;letter-spacing:.5px;color:var(--in-fg-soft,#5B6376);text-transform:uppercase;margin-bottom:5px}
.ef-ev-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ef-ev-item{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--in-fg-dim,#8A93A6);flex-wrap:wrap}
.ef-ev-agente{font-weight:800;color:var(--in-fg,#e6edf3)}
.ef-ev-fase,.ef-ev-tipo{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--in-fg-soft,#5B6376);background:rgba(255,255,255,.04);border-radius:6px;padding:1px 6px}
.ef-ev-artefacto{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--in-fg-dim,#8A93A6)}
.ef-secnote{margin-top:9px;font-size:10px;color:var(--in-fg-soft,#5B6376);font-style:italic}
.ef-empty{text-align:center;padding:34px 18px;background:rgba(63,185,80,.05);border:1px solid rgba(63,185,80,.2);border-radius:14px}
.ef-empty-icon{font-size:34px;color:var(--in-success,#3FB950)}
.ef-empty-title{font-size:16px;font-weight:800;color:var(--in-fg,#e6edf3);margin-top:6px}
.ef-empty-sub{font-size:12.5px;color:var(--in-fg-dim,#8A93A6);margin-top:4px}
</style>`;
}

/**
 * Fragmento SSR de la bandeja "Esperando tu firma". Lee `state.esperandoFirma`
 * (array de `lib/waiting-operator.listWaitingOperator`). Devuelve un `<section>`
 * que el monolito embebe junto al panel de Bloqueados. Si no hay pendientes ⇒
 * empty-state claro (no error, no panel roto — CA-1).
 *
 * @param {object} state — snapshot; lee `state.esperandoFirma` (array).
 * @param {object} [opts]
 * @param {string} [opts.productId] — #4778 · CA-2.1: si se pasa un productId seguro,
 *   la bandeja se filtra a los ítems de ESE producto (un firmante de A no ve ítems
 *   de B). Un ítem sin productId cuenta como del producto único (Intrale). Sin
 *   productId (default) ⇒ se muestran todos (retro-compat CA-5.1).
 * @returns {string} HTML del panel (con estilos inline).
 */
function renderEsperandoFirmaSsr(state, opts = {}) {
    const all = Array.isArray(state && state.esperandoFirma) ? state.esperandoFirma : [];

    // CA-2.1 — aislamiento por producto. El filtro compara contra el producto
    // efectivo del ítem (productIdOf), nunca contra el productId en banda sin validar.
    const filterPid = safeProductId(opts && opts.productId);
    const list = filterPid ? all.filter(p => productIdOf(p) === filterPid) : all;

    const rowsHtml = list.map(renderRowSsr).filter(Boolean).join('');
    const count = list.filter(p => safeIssueNumber(p && p.issue) !== null).length;
    const badge = count > 99 ? '99+' : String(count);

    const body = (!rowsHtml)
        ? renderEmptyStateSsr()
        : '<div class="ef-list" id="esperando-firma-list">' + rowsHtml + '</div>';

    return '<section class="matrix-section ef-panel" id="esperando-firma-panel" data-section="esperando-firma">'
        + esperandoFirmaStyle()
        + '<h2 class="ef-header" onclick="toggleEsperandoFirmaPanel()" title="Click para colapsar o expandir el panel">'
        + '<span class="ef-pen" aria-hidden="true">🖋</span>'
        + 'Esperando tu firma'
        + `<span class="ef-badge" aria-label="${escapeHtmlAttr(count + ' pendientes de firma')}">${escapeHtmlText(badge)}</span>`
        + '</h2>'
        + '<div class="ef-body">' + body + '</div>'
        + '</section>';
}

// Handlers del cliente. Se exponen como funciones globales para que los onclick=""
// del SSR funcionen. REQ-SEC-4580-1: la acción es POST-only + X-CSRF-Token
// same-origin (GET token → POST decide). NO hay disparador GET mutante.
function renderEsperandoFirmaClientScript() {
    return `
function toggleEsperandoFirmaPanel(){
  var p = document.getElementById('esperando-firma-panel');
  if(!p) return;
  var collapse = !p.classList.contains('ef-collapsed');
  p.classList.toggle('ef-collapsed');
  try { localStorage.setItem('ef-panel-collapsed', collapse ? '1' : '0'); } catch(e){}
}
(function restoreEsperandoFirmaPanel(){
  try {
    if(localStorage.getItem('ef-panel-collapsed') === '1'){
      var p = document.getElementById('esperando-firma-panel');
      if(p) p.classList.add('ef-collapsed');
    }
  } catch(e){}
})();
function efDisableRow(issueNum){
  var row = document.getElementById('esperando-firma-row-' + issueNum);
  if(row){ row.querySelectorAll('button').forEach(function(b){ b.disabled = true; }); }
}
// REQ-SEC-4580-1 — POST-only + CSRF same-origin. Pide el token (GET), luego POST
// con X-CSRF-Token. El dashboard NO muta estado: reenvía la decisión al backend
// de firma (#4579) que delega la transición al kernel.
async function gateSignatureDecide(issueNum, decision, productId){
  var verbo = decision === 'aprobar' ? 'Aprobar' : 'Rechazar';
  var sufijo = productId ? (' del producto ' + productId) : '';
  if(!window.confirm(verbo + ' la firma del issue #' + issueNum + sufijo + '?')) return;
  efDisableRow(issueNum);
  try {
    var t = await fetch('/api/gate-signature/csrf-token', { cache: 'no-store' });
    var tj = await t.json();
    var token = tj && tj.csrf_token;
    if(!token){ alert('No pude obtener el token CSRF; recargá y reintentá.'); location.reload(); return; }
    // #4778 · CA-2.2 — la firma viaja atada al productId (no repudio) cuando existe.
    var payload = { issue: issueNum, decision: decision };
    if(productId) payload.productId = productId;
    var r = await fetch('/api/gate-signature/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload)
    });
    var j = await r.json();
    if(j && j.ok){ location.reload(); }
    else { alert('Error firmando #' + issueNum + ': ' + ((j && j.msg) || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error firmando #' + issueNum + ': ' + e.message); location.reload(); }
}
`;
}

module.exports = {
    slug,
    renderEsperandoFirmaSsr,
    renderEsperandoFirmaClientScript,
    // Helpers exportados para tests.
    safeIssueNumber,
    safeProductId,
    productIdOf,
    DEFAULT_PRODUCT_ID,
    origenMeta,
    fmtAge,
    severityOf,
    renderSuggestion,
    renderEvidence,
    renderRowSsr,
    renderEmptyStateSsr,
    ORIGENES,
    SUGERENCIA_VERBOS,
};

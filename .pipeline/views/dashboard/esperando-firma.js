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
//
// #6208 — LA BANDEJA MUESTRA LOS PENDIENTES REALES
// ------------------------------------------------
// La fuente pasa a ser `lib/gate-signature-inbox.listInbox()`, que UNE los
// pendientes reales del depósito del kernel (FIRMABLES, con ficha + ancla
// server-derived + opciones) con los markers de `waiting-operator` (GATE 3 y
// compañía, NO firmables desde acá — UX §7).
//
//   - CA-2  : la ficha y la redacción de la antigüedad se CONSUMEN de #6190 vía
//             el inbox. Acá no hay una segunda ficha ni un segundo teclado: los
//             botones salen de `options[]` del kernel, con SU label.
//   - CA-4  : el ancla que se pinta es la que recalculó el servidor. La vista
//             no la deriva del texto del issue ni la acepta del cliente.
//   - CA-15 / REQ-SEC-6208-1 : DOS controles apilados. (1) escape por contexto
//             SIEMPRE, incluso con `presentation_safe === true` — el escape es
//             el control, el aviso es sólo un aviso; (2) la señal de inyección
//             se LEE del depósito (`presentation_safe` / `presentation_alert`),
//             NO se recalcula acá (recalcularla puede divergir del veredicto
//             con el que se emitió el pedido).
//   - REQ-SEC-6208-4 : CERO interpolación dentro de cadenas JS. `escapeHtmlAttr`
//             NO protege adentro del `onclick`: ahí es inyección de JS, no XSS
//             de texto. Los `onclick="gateSignatureDecide(...)"` se eliminaron;
//             ahora es `data-*` + listener delegado + revalidación contra el
//             enum congelado del lado cliente.
//   - UX §5 : los TRES vacíos. Sólo "leí la lista entera y estaba vacía" puede
//             ser verde; un depósito ilegible jamás se pinta como "todo firmado".
//   - D-4   : mientras no haya carrier conectado el copy nombra el ESTADO REAL,
//             nunca un medio que el sistema todavía no puede usar.
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

// #6208 · UX §2 campo 1 — chip del gate para las filas FIRMABLES (las que salen
// del depósito del kernel). La etiqueta sale de la CLAVE del enum congelado; un
// `gate` que no resuelve contra esta tabla hace que la fila no se pinte como
// firmable y no ofrezca botones (fail-closed en la vista, igual que en el
// kernel). Es la tabla de presentación del enum, no una segunda definición de
// gates: la autoridad sigue siendo `approval-channel.resolveGate`.
const GATES_VIEW = Object.freeze({
    definicion: { icon: '⚑', label: 'GATE 1 · Definición', cls: 'ef-origen-def' },
    aceptacion: { icon: '🛡', label: 'GATE 2 · Aceptación', cls: 'ef-origen-acc' },
});
// REQ-SEC-6208-4 — enums congelados que el cliente REVALIDA antes de disparar la
// acción. Espejan el enum del kernel; su única función es cerrar la puerta a que
// un `gate`/`verdict` hostil llegue al handler.
const GATE_KEYS = Object.freeze(Object.keys(GATES_VIEW));
const VERDICT_KEYS = Object.freeze(['signed', 're-definition', 'rejected']);

function gateMeta(gate) {
    return Object.prototype.hasOwnProperty.call(GATES_VIEW, gate) ? GATES_VIEW[gate] : null;
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

// UX §3 — bloque del ancla. Encabezado fijo, línea traducida por el read model
// (CA-4: dato SERVER-DERIVED, la vista sólo lo pinta) y la consecuencia textual
// siempre debajo. Todo escapado: el `value` del ancla es un digest, pero el
// escape no se saltea nunca (REQ-SEC-6208-1, control 1).
function renderAnchorSsr(av) {
    if (!av || typeof av !== 'object') return '';
    return '<div class="ef-anchor">'
        + `<div class="ef-anchor-head"><span class="ef-anchor-title">${escapeHtmlText(av.titulo)}</span>`
        + `<span class="ef-anchor-chip">${escapeHtmlText(av.chip)}</span></div>`
        + `<div class="ef-anchor-line">${escapeHtmlText(av.linea)}</div>`
        + `<div class="ef-anchor-note">${escapeHtmlText(av.consecuencia)}</div>`
        + '</div>';
}

const EVIDENCE_REF_MAX = 12;

// UX §2 campo 6 — evidencia del depósito: REFERENCIAS con su tipo, nunca
// contenido pegado. Vacío ⇒ "Sin evidencia adjunta"; jamás el hueco en blanco.
function renderEvidenceRefsSsr(evidence) {
    const list = Array.isArray(evidence) ? evidence.slice(0, EVIDENCE_REF_MAX) : [];
    if (list.length === 0) {
        return '<div class="ef-ev ef-ev-empty">Sin evidencia adjunta</div>';
    }
    const chips = list.map((e) => {
        const kind = escapeHtmlText((e && e.kind) || '?');
        const rawKind = String((e && e.kind) || '').toLowerCase();
        const rawRef = String((e && e.ref) || '');
        const displayRef = (rawKind === 'issue' || rawKind === 'pr') && rawRef && rawRef.charAt(0) !== '#'
            ? '#' + rawRef
            : rawRef;
        const ref = escapeHtmlText(displayRef);
        return `<span class="ef-ev-chip">${kind} ${ref}</span>`;
    }).join('');
    return '<div class="ef-ev"><div class="ef-ev-label">📎 Evidencia</div><div class="ef-ev-chips">' + chips + '</div></div>';
}

// UX §4 — banner de texto no confiable. La señal se LEE del depósito
// (`presentation_safe:false` / `presentation_alert`): la vista NO re-ejecuta el
// detector (REQ-SEC-6208-1, control 2).
const ALERTA_TEXTO = Object.freeze({
    titulo: 'Ojo: este texto viene del issue y trae marcas raras.',
    cuerpo: 'Leelo con cuidado antes de decidir: puede estar escrito para confundirte. '
        + 'Te lo muestro tal cual, como texto, y el sistema no le hace caso.',
});

// UX §2 campo 7 — texto presentado + aviso de recorte. Escapado por contexto
// SIEMPRE, también cuando el pedido viene marcado como seguro: el escape es el
// control, el aviso es sólo un aviso.
function renderPresentedSsr(p) {
    const pres = p && p.presented;
    const inseguro = p && p.presentation_safe === false;
    const alerta = (p && p.presentation_alert) || null;
    let html = '';
    if (inseguro || alerta) {
        html += '<div class="ef-alert" role="alert">'
            + `<div class="ef-alert-title">⚠ ${escapeHtmlText(ALERTA_TEXTO.titulo)}</div>`
            + `<div class="ef-alert-body">${escapeHtmlText(ALERTA_TEXTO.cuerpo)}</div>`
            + '</div>';
    }
    if (!pres || typeof pres !== 'object') return html;
    const texto = pres.text == null ? '' : String(pres.text);
    if (texto !== '') {
        html += `<pre class="ef-presented">${escapeHtmlText(texto)}</pre>`;
    }
    if (pres.truncated && pres.truncation_notice) {
        html += `<div class="ef-trunc">${escapeHtmlText(String(pres.truncation_notice))}</div>`;
    }
    return html;
}

// UX §2 campo 8 / H-UX-6208-3 — UN BOTÓN POR OPCIÓN, con el `label` del kernel.
// El adaptador no inventa el label ni lo deriva de la clave interna. GATE 1
// tiene TRES veredictos: quien quiere devolver a definición ya no tiene que
// tocar "Rechazar", que es otra decisión con otro efecto.
//
// REQ-SEC-6208-4 — cero interpolación en JS: `data-*` + listener delegado. Un
// `gate`/`verdict` hostil no puede inyectarse en el handler porque (1) acá se
// filtra contra el enum antes de pintar y (2) el listener revalida de nuevo.
function renderOptionsSsr(issueNum, gate, options, deshabilitado, elegido) {
    const list = Array.isArray(options) ? options : [];
    return list.map((o) => {
        const verdict = o && typeof o.value === 'string' ? o.value : '';
        if (VERDICT_KEYS.indexOf(verdict) === -1) return '';
        const label = (o && o.label != null && String(o.label) !== '') ? String(o.label) : verdict;
        const esElegido = elegido === verdict;
        const cls = 'ef-btn ef-btn-decide'
            + (verdict === 'rejected' ? ' ef-btn-reject' : verdict === 'signed' ? ' ef-btn-approve' : ' ef-btn-alt')
            + (esElegido ? ' ef-btn-chosen' : '');
        // Deshabilitados, NO ocultos (UX §6): seguís viendo qué elegiste.
        const dis = deshabilitado ? ' disabled' : '';
        return `<button class="${cls}" type="button" data-issue="${issueNum}" data-gate="${escapeHtmlAttr(gate)}" data-verdict="${escapeHtmlAttr(verdict)}"`
            + ` title="${escapeHtmlAttr(label + ' — #' + issueNum)}" aria-label="${escapeHtmlAttr(label + ' del issue #' + issueNum)}"${dis}>${escapeHtmlText(label)}</button>`;
    }).filter(Boolean).join('');
}

// UX §6 + D-4 — el estado de la decisión. El copy lo redacta el read model; acá
// sólo se pinta. Mientras no haya carrier conectado NO se nombra ningún medio.
function renderEstadoSsr(p) {
    const c = p && p.estado_copy;
    if (!c || typeof c !== 'object') return '';
    const tono = c.tono === 'warn' ? 'warn' : 'info';
    return `<div class="ef-estado ef-estado-${tono}" role="status">`
        + `<span class="ef-estado-title">${escapeHtmlText(c.titulo)}</span>`
        + (c.detalle ? `<span class="ef-estado-detail">${escapeHtmlText(c.detalle)}</span>` : '')
        + '</div>';
}

// Fila FIRMABLE: un pendiente real del depósito del kernel. Los ocho campos de
// la ficha (UX §2) y ninguno más.
function renderFirmaRowSsr(p) {
    const issueNum = safeIssueNumber(p && p.issue);
    if (issueNum === null) return '';
    const gm = gateMeta(p && p.gate);
    // Un `gate` fuera del enum congelado ⇒ la fila NO se pinta como firmable y
    // no ofrece botones (UX §2 campo 1, fail-closed en la vista).
    if (!gm) return renderMarkerRowSsr(Object.assign({}, p, { firmable: false }));

    const sev = (p && p.severity) === 'danger' ? 'danger' : (p && p.severity) === 'warning' ? 'warning' : 'info';
    const edad = (p && p.edad) ? String(p.edad) : '';
    const estado = (p && p.estado) || 'pendiente';
    // CA-10 — con la decisión ya anotada los botones quedan deshabilitados
    // (visibles, no ocultos) hasta que el kernel confirme. La fila NO se marca
    // resuelta ni desaparece: eso lo hace salir del depósito, nada más.
    const decidido = estado === 'encolado' || estado === 'despachado';
    const botones = renderOptionsSsr(issueNum, String(p.gate), p && p.options, decidido, p && p.estado_verdict);

    return `<div class="ef-row ef-row-firma ef-sev-${sev}" id="esperando-firma-row-${issueNum}" data-issue="${issueNum}" data-gate="${escapeHtmlAttr(String(p.gate))}" data-estado="${escapeHtmlAttr(estado)}" data-severity="${sev}">
      <span class="ef-rail" aria-hidden="true"></span>
      <div class="ef-row-head">
        <div class="ef-row-info">
          <span class="ef-origen ${gm.cls}" title="${escapeHtmlAttr(gm.label)}"><span aria-hidden="true">${escapeHtmlText(gm.icon)}</span> ${escapeHtmlText(gm.label)}</span>
          <a href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer"><b>#${issueNum}</b></a>
        </div>
        <div class="ef-row-actions"><span class="ef-age-pill" aria-label="${escapeHtmlAttr('Esperando ' + edad)}">esperando ${escapeHtmlText(edad)}</span>${botones}</div>
      </div>
      <div class="ef-title">${escapeHtmlText(String((p && p.title) || ''))}</div>
      <div class="ef-question">${escapeHtmlText(String((p && p.question) || ''))}</div>
      ${renderAnchorSsr(p && p.anchorView)}
      ${renderEvidenceRefsSsr(p && p.evidence)}
      ${renderPresentedSsr(p)}
      <div class="ef-estado-slot" id="esperando-firma-estado-${issueNum}">${renderEstadoSsr(p)}</div>
      <div class="ef-secnote" aria-hidden="true">El dashboard anota tu decisión · la firma la registra el kernel con tu identidad</div>
    </div>`;
}

// Fila NO firmable (UX §7): markers de `waiting-operator` (GATE 3 y compañía).
// Sin botones de firma — mejor no ofrecer el botón que ofrecerlo y que el
// sistema lo rechace. Chip neutro + link para mirarlo en GitHub.
function renderMarkerRowSsr(p) {
    const issueNum = safeIssueNumber(p && p.issue);
    if (issueNum === null) return '';
    const om = origenMeta(p && p.origen);
    const sev = severityOf(p && p.age_hours);
    const ageTxt = fmtAge(p && p.age_hours);
    const skillTxt = (p && p.skill != null) ? String(p.skill) : '';
    const phaseTxt = (p && p.phase != null) ? String(p.phase) : '';
    const pipelineTxt = (p && p.pipeline != null) ? String(p.pipeline) : '';
    const origenAttr = escapeHtmlAttr(String((p && p.origen) || ''));

    // #4778 · productId seguro (CA-2.1 / CA-2.2). Ya no viaja a ningún handler:
    // estas filas no se firman desde acá. Se conserva como dato de la fila para
    // que el filtro por producto siga funcionando igual.
    const explicitPid = safeProductId(p && p.productId);
    const productAttr = explicitPid ? ` data-product="${escapeHtmlAttr(explicitPid)}"` : '';
    const productChip = explicitPid
        ? `<span class="ef-product" title="${escapeHtmlAttr('Producto ' + explicitPid)}">▣ ${escapeHtmlText(explicitPid)}</span>`
        : '';

    const nf = (p && p.no_firmable_copy) || null;
    const nota = nf
        ? '<div class="ef-nofirma">'
          + `<span class="ef-nofirma-title">${escapeHtmlText(String(nf.titulo || ''))}</span>`
          + (Array.isArray(nf.lineas) ? nf.lineas.map(l => `<span class="ef-nofirma-line">${escapeHtmlText(String(l))}</span>`).join('') : '')
          + '</div>'
        : '';

    return `<div class="ef-row ef-row-marker ef-sev-${sev}" id="esperando-firma-row-${issueNum}" data-issue="${issueNum}" data-origen="${origenAttr}" data-severity="${sev}"${productAttr}>
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
          <a class="ef-btn ef-btn-link" href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtmlAttr('Abrir #' + issueNum + ' en GitHub')}">Abrir #${issueNum} en GitHub</a>
        </div>
      </div>
      ${nota}
      ${renderSuggestion(p && p.sugerencia)}
      ${renderEvidence(p && p.evidencia)}
    </div>`;
}

// Una fila de la bandeja. Devuelve '' si `p.issue` no coacciona a entero positivo
// (fila descartada). Todo dato externo escapado por contexto.
function renderRowSsr(p) {
    return (p && p.firmable === true && p.kind === 'firma')
        ? renderFirmaRowSsr(p)
        : renderMarkerRowSsr(p);
}

// UX §5 — copy por defecto del vacío LIMPIO. Es el único de los tres que puede
// ser verde, y sólo se gana habiendo leído la lista entera.
const VACIO_LIMPIO = Object.freeze({
    tono: 'ok',
    icono: '✓',
    titulo: 'Nada esperando tu firma',
    lineas: Object.freeze(['Ningún gate está reteniendo un trabajo.', 'Leí la lista entera y estaba vacía.']),
    chip: 'LISTA LEÍDA COMPLETA',
});

// UX §5 / H-UX-6208-1 — los tres vacíos. `vacio` lo redacta `gate-signature-inbox`
// (que sabe si la lista se pudo leer); la vista lo pinta. Sin `vacio`
// (retro-compat) cae al limpio.
function renderEmptyStateSsr(vacio) {
    const v = (vacio && typeof vacio === 'object') ? vacio : VACIO_LIMPIO;
    const tono = v.tono === 'warn' ? 'warn' : 'ok';
    const lineas = Array.isArray(v.lineas) ? v.lineas : [];
    return `<section class="ef-empty ef-empty-${tono}" id="esperando-firma-empty" role="status">`
        + `<div class="ef-empty-icon" aria-hidden="true">${escapeHtmlText(String(v.icono || ''))}</div>`
        + `<div class="ef-empty-title">${escapeHtmlText(String(v.titulo || ''))}</div>`
        + lineas.map(l => `<div class="ef-empty-sub">${escapeHtmlText(String(l))}</div>`).join('')
        + (v.chip ? `<div class="ef-empty-chip">${escapeHtmlText(String(v.chip))}</div>` : '')
        + '</section>';
}

// UX §5, tercer caso — banda ARRIBA de la lista. NO reemplaza a las filas: es el
// único de los tres vacíos que convive con ellas.
function renderBandaSsr(banda) {
    if (!banda || typeof banda !== 'object') return '';
    const lineas = Array.isArray(banda.lineas) ? banda.lineas : [];
    return '<div class="ef-banda" role="alert">'
        + `<div class="ef-banda-title">${escapeHtmlText(String(banda.icono || '⚠'))} ${escapeHtmlText(String(banda.titulo || ''))}</div>`
        + lineas.map(l => `<div class="ef-banda-line">${escapeHtmlText(String(l))}</div>`).join('')
        + (banda.chip ? `<div class="ef-banda-chip">${escapeHtmlText(String(banda.chip))}</div>` : '')
        + '</div>';
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
.ef-row-actions{display:flex;align-items:flex-start;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.ef-age-pill{display:inline-flex;align-items:center;min-height:24px;box-sizing:border-box;font-size:11px;font-weight:700;color:#D29922;background:rgba(210,153,34,.14);border:1px solid #9E6A03;border-radius:999px;padding:2px 12px;white-space:nowrap}
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
/* #6208 · UX §5 — sólo el vacío LIMPIO es verde. El degradado es ámbar: un
   depósito que no se pudo leer nunca se pinta como "está todo firmado". */
.ef-empty-warn{background:rgba(245,158,11,.06);border-color:rgba(245,158,11,.34)}
.ef-empty-warn .ef-empty-icon{color:var(--in-warning,#F59E0B)}
.ef-empty-chip{display:inline-block;margin-top:10px;font-size:10px;font-weight:800;letter-spacing:.5px;color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.05);border:1px solid var(--in-border,rgba(255,255,255,.12));border-radius:999px;padding:2px 10px}
/* UX §5, tercer caso: banda ARRIBA de la lista, convive con las filas. */
.ef-banda{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.34);border-radius:12px;padding:10px 14px;margin-bottom:10px}
.ef-banda-title{font-size:13px;font-weight:800;color:#fcd9a0}
.ef-banda-line{font-size:12px;color:var(--in-fg-dim,#8A93A6);margin-top:2px}
.ef-banda-chip{display:inline-block;margin-top:6px;font-size:10px;font-weight:800;letter-spacing:.5px;color:#fcd9a0;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:999px;padding:1px 9px}
/* Ficha de decisión (UX §2): título, pregunta, ancla, texto presentado. */
.ef-title{margin-top:10px;font-size:13.5px;font-weight:800;color:var(--in-fg,#e6edf3)}
.ef-question{margin-top:4px;font-size:12.5px;color:var(--in-fg-dim,#8A93A6)}
.ef-anchor{margin-top:10px;background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.24);border-radius:10px;padding:8px 12px}
.ef-anchor-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ef-anchor-title{font-size:11px;font-weight:800;letter-spacing:.4px;color:#bcd8ff;text-transform:uppercase}
.ef-anchor-chip{font-size:9.5px;font-weight:800;letter-spacing:.4px;color:#bcd8ff;background:rgba(88,166,255,.14);border:1px solid rgba(88,166,255,.3);border-radius:999px;padding:1px 8px}
.ef-anchor-line{margin-top:4px;font-size:12px;color:var(--in-fg,#e6edf3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ef-anchor-note{margin-top:4px;font-size:11.5px;color:var(--in-fg-dim,#8A93A6)}
.ef-ev-chips{display:flex;gap:6px;flex-wrap:wrap}
.ef-ev-chip{font-size:10.5px;font-weight:700;color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.04);border:1px solid var(--in-border,rgba(255,255,255,.1));border-radius:8px;padding:1px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* UX §4 — texto no confiable. La señal se lee del depósito, no se recalcula. */
.ef-alert{margin-top:10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.4);border-radius:10px;padding:8px 12px}
.ef-alert-title{font-size:12.5px;font-weight:800;color:#fcd9a0}
.ef-alert-body{margin-top:3px;font-size:11.5px;color:var(--in-fg-dim,#8A93A6)}
.ef-presented{margin-top:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.5;color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.08));border-radius:10px;padding:8px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ef-trunc{margin-top:4px;font-size:11px;color:var(--in-fg-soft,#5B6376);font-style:italic}
/* UX §6 — los momentos del ciclo. Estados visibles y distintos, no un spinner. */
.ef-estado{display:flex;flex-direction:column;gap:2px;margin-top:10px;border-radius:9px;padding:7px 11px;border:1px solid var(--in-border,rgba(255,255,255,.1))}
.ef-estado-title{font-size:12px;font-weight:800}
.ef-estado-detail{font-size:11.5px;color:var(--in-fg-dim,#8A93A6);font-weight:600}
.ef-estado-info{color:#bcd8ff;background:rgba(88,166,255,.08);border-color:rgba(88,166,255,.26)}
.ef-estado-warn{color:#fcd9a0;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3)}
.ef-estado-err{color:#fca5a5;background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
/* UX §7 — la fila que no se firma desde acá. */
.ef-nofirma{margin-top:9px;display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--in-fg-dim,#8A93A6);background:rgba(255,255,255,.03);border:1px solid var(--in-border,rgba(255,255,255,.08));border-radius:9px;padding:7px 11px}
.ef-nofirma-title{font-weight:800;color:var(--in-fg,#e6edf3)}
.ef-btn-alt{color:#d6bcff;background:rgba(188,140,255,.14);border-color:rgba(188,140,255,.4)}
.ef-btn-alt:hover{background:rgba(188,140,255,.24)}
.ef-btn-link{color:#bcd8ff;background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.3);text-decoration:none}
.ef-btn-link:hover{background:rgba(88,166,255,.18)}
.ef-btn-chosen{outline:2px solid var(--in-accent,#38bdf8);outline-offset:1px}
</style>`;
}

/**
 * Fragmento SSR de la bandeja "Esperando tu firma". Lee `state.esperandoFirma`
 * (los `items` de `lib/gate-signature-inbox.listInbox`: pendientes REALES del
 * depósito del kernel + markers de `waiting-operator`) y, si está,
 * `state.esperandoFirmaInbox` con los metadatos del read model (`vacio`,
 * `banda`, `degraded`). Devuelve un `<section>` que el monolito embebe junto al
 * panel de Bloqueados.
 *
 * #6208 · UX §5 / H-UX-6208-1 — los TRES vacíos. El empty-state ya NO es un
 * literal fijo y celebratorio: sólo se pinta verde cuando la lista se pudo leer
 * entera. Si el depósito quedó ilegible (`degraded`), el vacío es ámbar y dice
 * que NO significa que esté todo firmado. Sin metadatos (retro-compat) se cae al
 * comportamiento anterior.
 *
 * @param {object} state — snapshot; lee `state.esperandoFirma` (array) y
 *   `state.esperandoFirmaInbox` (metadatos del read model, opcional).
 * @param {object} [opts]
 * @param {string} [opts.productId] — #4778 · CA-2.1: si se pasa un productId seguro,
 *   la bandeja se filtra a los ítems de ESE producto (un firmante de A no ve ítems
 *   de B). Un ítem sin productId cuenta como del producto único (Intrale). Sin
 *   productId (default) ⇒ se muestran todos (retro-compat CA-5.1).
 * @returns {string} HTML del panel (con estilos inline).
 */
function renderEsperandoFirmaSsr(state, opts = {}) {
    const all = Array.isArray(state && state.esperandoFirma) ? state.esperandoFirma : [];
    const meta = (state && state.esperandoFirmaInbox && typeof state.esperandoFirmaInbox === 'object')
        ? state.esperandoFirmaInbox
        : null;

    // CA-2.1 — aislamiento por producto. El filtro compara contra el producto
    // efectivo del ítem (productIdOf), nunca contra el productId en banda sin validar.
    const filterPid = safeProductId(opts && opts.productId);
    const list = filterPid ? all.filter(p => productIdOf(p) === filterPid) : all;

    const rowsHtml = list.map(renderRowSsr).filter(Boolean).join('');
    const count = list.filter(p => safeIssueNumber(p && p.issue) !== null).length;
    const badge = count > 99 ? '99+' : String(count);

    // UX §5 — el vacío que corresponde. Con metadatos manda el read model; sin
    // ellos (o filtrando por producto) cae al limpio.
    const vacio = meta && meta.vacio ? meta.vacio : null;
    const banda = meta && meta.banda ? renderBandaSsr(meta.banda) : '';

    const body = (!rowsHtml)
        ? (banda + renderEmptyStateSsr(vacio))
        : (banda + '<div class="ef-list" id="esperando-firma-list">' + rowsHtml + '</div>');

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
// Handlers del cliente. REQ-SEC-4580-1: la acción es POST-only + X-CSRF-Token
// same-origin (GET token → POST decide). NO hay disparador GET mutante.
//
// #6208 · REQ-SEC-6208-4 — CERO interpolación en JS. Los `onclick=` con
// argumentos interpolados se eliminaron: `escapeHtmlAttr` NO protege adentro de
// la cadena JS de un `onclick` (ahí es inyección de JS, no XSS de texto). Ahora
// los botones llevan `data-issue` / `data-gate` / `data-verdict` y un listener
// DELEGADO los lee y los revalida contra el enum congelado antes de disparar.
//
// #6208 · R1 — `gateSignatureDecide` se define UNA SOLA VEZ en todo `.pipeline/`:
// acá. La copia inline de `dashboard.js` (que ya había perdido el `productId` de
// #4778 y nunca supo de `gate`) se borró; la home legacy inyecta este script.
//
// #6208 · H-UX-6208-5 / UX §7 — se terminó el `location.reload()` ciego. Con
// estado intermedio recargar no alcanza: la fila tiene que quedar VISIBLE en el
// estado nuevo, no volver idéntica. El resultado se comunica EN LA FILA y ningún
// `msg` crudo del servidor llega a pantalla.
//
// FUENTE ÚNICA DEL COPY — el texto de los estados lo redacta
// `lib/gate-signature-inbox` (mismo que usa el SSR). Acá se LEE, no se
// reescribe: dos redacciones del mismo estado divergen, y el operador termina
// leyendo una cosa en el render inicial y otra después del click. El require es
// perezoso y con fallback para que la vista siga cargando standalone.
function efEstadoCopy() {
    try {
        const { ESTADOS } = require('../../lib/gate-signature-inbox.js');
        if (ESTADOS && ESTADOS.encolado && ESTADOS.error) {
            return { encolado: ESTADOS.encolado, error: ESTADOS.error };
        }
    } catch { /* checkout transitorio: se degrada, no se rompe */ }
    return {
        encolado: { titulo: 'Anotada tu decisión — falta confirmarla', detalle: 'Todavía no está firmada.' },
        error: { titulo: 'No pude anotar tu decisión', detalle: 'Nada cambió: el gate sigue reteniendo el trabajo.' },
    };
}

function renderEsperandoFirmaClientScript() {
    const copy = efEstadoCopy();
    return `
var EF_GATES = ${JSON.stringify(GATE_KEYS)};
var EF_VERDICTS = ${JSON.stringify(VERDICT_KEYS)};
// D-4 — el copy nombra el ESTADO REAL, no un medio que todavía no está
// conectado. Sale de lib/gate-signature-inbox, el mismo que usa el SSR.
var EF_COPY_ENCOLADO = ${JSON.stringify(copy.encolado)};
var EF_COPY_ERROR = ${JSON.stringify(copy.error)};

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

function efRow(issueNum){ return document.getElementById('esperando-firma-row-' + issueNum); }

function efDisableRow(issueNum){
  var row = efRow(issueNum);
  if(!row) return;
  var bs = row.querySelectorAll('button');
  for(var i=0;i<bs.length;i++){ bs[i].disabled = true; }
}

function efEnableRow(issueNum){
  var row = efRow(issueNum);
  if(!row) return;
  var bs = row.querySelectorAll('button');
  for(var i=0;i<bs.length;i++){ bs[i].disabled = false; }
}

// El resultado se comunica EN LA FILA (UX §7), como texto inerte: se usa
// textContent, nunca innerHTML — el dashboard ya tuvo XSS por innerHTML crudo.
function efSetEstado(issueNum, tono, titulo, detalle){
  var slot = document.getElementById('esperando-firma-estado-' + issueNum);
  if(!slot) return;
  slot.textContent = '';
  var box = document.createElement('div');
  box.className = 'ef-estado ef-estado-' + (tono === 'warn' ? 'warn' : tono === 'err' ? 'err' : 'info');
  box.setAttribute('role','status');
  var t = document.createElement('span');
  t.className = 'ef-estado-title';
  t.textContent = titulo;
  box.appendChild(t);
  if(detalle){
    var d = document.createElement('span');
    d.className = 'ef-estado-detail';
    d.textContent = detalle;
    box.appendChild(d);
  }
  slot.appendChild(box);
}

function efMarkChosen(issueNum, verdict){
  var row = efRow(issueNum);
  if(!row) return;
  row.setAttribute('data-estado','encolado');
  var bs = row.querySelectorAll('.ef-btn-decide');
  for(var i=0;i<bs.length;i++){
    // Deshabilitados, NO ocultos: seguís viendo qué elegiste (UX §6).
    if(bs[i].getAttribute('data-verdict') === verdict) bs[i].classList.add('ef-btn-chosen');
    else bs[i].classList.remove('ef-btn-chosen');
  }
}

// REQ-SEC-4580-1 — POST-only + CSRF same-origin. Pide el token (GET), luego POST
// con X-CSRF-Token. CA-12: el dashboard ENCOLA, no firma. La identidad real la
// aporta el medio con identidad, nunca este navegador.
async function gateSignatureDecide(issueNum, gate, verdict){
  // Revalidación client-side contra el enum congelado (defensa en profundidad;
  // la autoridad sigue siendo resolveGate del lado servidor).
  if(EF_GATES.indexOf(gate) === -1 || EF_VERDICTS.indexOf(verdict) === -1) return;
  var row = efRow(issueNum);
  var btn = row ? row.querySelector('.ef-btn-decide[data-verdict="' + verdict + '"]') : null;
  var etiqueta = btn ? (btn.textContent || '').trim() : verdict;
  if(!window.confirm(etiqueta + ' — #' + issueNum + '?')) return;
  efDisableRow(issueNum);
  try {
    var t = await fetch('/api/gate-signature/csrf-token', { cache: 'no-store' });
    var tj = await t.json();
    var token = tj && tj.csrf_token;
    if(!token){
      efEnableRow(issueNum);
      efSetEstado(issueNum, 'err', EF_COPY_ERROR.titulo, EF_COPY_ERROR.detalle);
      return;
    }
    var r = await fetch('/api/gate-signature/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ issue: issueNum, gate: gate, decision: verdict })
    });
    var j = await r.json();
    if(j && j.ok){
      // CA-10 — NO se marca resuelta ni desaparece: eso lo decide el kernel.
      efMarkChosen(issueNum, verdict);
      efSetEstado(issueNum, 'warn', EF_COPY_ENCOLADO.titulo, EF_COPY_ENCOLADO.detalle);
    } else {
      // UX §7 — ningún \`msg\` del servidor se muestra crudo.
      efEnableRow(issueNum);
      efSetEstado(issueNum, 'err', EF_COPY_ERROR.titulo, EF_COPY_ERROR.detalle);
    }
  } catch(e){
    efEnableRow(issueNum);
    efSetEstado(issueNum, 'err', EF_COPY_ERROR.titulo, EF_COPY_ERROR.detalle);
  }
}

// REQ-SEC-6208-4 — listener DELEGADO, registrado una sola vez. Lee los \`data-*\`
// del botón y revalida contra el enum congelado: un \`gate\`/\`verdict\` hostil
// muere acá sin llegar nunca al handler.
(function efBindDecideDelegate(){
  if(window.__efDecideBound) return;
  window.__efDecideBound = true;
  document.addEventListener('click', function(ev){
    var b = ev.target && ev.target.closest ? ev.target.closest('.ef-btn-decide') : null;
    if(!b || b.disabled) return;
    var gate = b.getAttribute('data-gate');
    var verdict = b.getAttribute('data-verdict');
    var issueNum = Number(b.getAttribute('data-issue'));
    if(!Number.isInteger(issueNum) || issueNum <= 0) return;
    if(EF_GATES.indexOf(gate) === -1 || EF_VERDICTS.indexOf(verdict) === -1) return;
    ev.preventDefault();
    gateSignatureDecide(issueNum, gate, verdict);
  });
})();
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
    gateMeta,
    fmtAge,
    severityOf,
    renderSuggestion,
    renderEvidence,
    renderRowSsr,
    renderFirmaRowSsr,
    renderMarkerRowSsr,
    renderEmptyStateSsr,
    renderBandaSsr,
    renderAnchorSsr,
    renderEvidenceRefsSsr,
    renderPresentedSsr,
    renderOptionsSsr,
    renderEstadoSsr,
    ORIGENES,
    GATES_VIEW,
    GATE_KEYS,
    VERDICT_KEYS,
    VACIO_LIMPIO,
    ALERTA_TEXTO,
    SUGERENCIA_VERBOS,
};

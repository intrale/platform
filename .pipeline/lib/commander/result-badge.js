// =============================================================================
// result-badge.js — Render PURO de los badges de resultado de una petición del
// Commander (#3951 / EP7-H4).
//
// Construye el fragmento HTML (badge de resultado + chip de provider + chip
// cross/same-provider) a partir del sidecar de metadata `commander-<id>.meta.json`.
// Vive en su propio módulo (en vez de inline en `dashboard.js`) porque
// `dashboard.js` arranca un server HTTP al ser `require`-ado y no es
// unit-testeable; este helper es PURO y testeable con `node --test`.
//
// Requisitos de seguridad (security — fase análisis EP7-H4):
//   CA-4 / SEC-1 (stored XSS, A03): TODO campo dinámico pasa por `escapeHtml`
//          (inyectado por el caller para usar la MISMA implementación que el
//          resto del dashboard — fuente única). El enum + provider validado ya
//          acotan los valores, pero el escape es obligatorio igual.
//   CA-5: lectura defensiva — `meta` null/no-objeto → '' (render sin badge).
// =============================================================================
'use strict';

// Glyph + label corto + tooltip por cada valor del enum cerrado de resultado.
// El enum YA está acotado por `request-classify.js`; este mapa es presentacional.
// Un `resultado` fuera del enum cae a `undefined` → no se renderiza badge
// (back-compat con sidecars de otra versión / valores inesperados).
const RESULT_BADGES = Object.freeze({
  ok:       { glyph: '✓', label: 'ok',       title: 'El turno cerró sin ajustes ni fallback' },
  ajustada: { glyph: '✎', label: 'ajustada', title: 'Sherlock reelaboró la respuesta del Commander' },
  fallback: { glyph: '↪', label: 'fallback', title: 'Respondió con un proveedor distinto al primario' },
  error:    { glyph: '✗', label: 'error',    title: 'Error / timeout / sin-provider / respuesta vacía' },
});

// Escape mínimo por defecto. El caller (dashboard.js) DEBE inyectar su propio
// `escapeHtml` para mantener una sola implementación; este default existe sólo
// para que el módulo sea seguro aún si el caller se olvida de inyectarlo.
function defaultEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Construye el HTML de los badges de resultado de una petición.
 *
 * @param {object|null} meta  sidecar parseado:
 *   `{ resultado, provider, sameProviderVerification, crossProviderDispatch }`.
 * @param {(s:any)=>string} [escapeHtml]  escape inyectado (default: interno).
 * @returns {string} fragmento HTML (posiblemente vacío). NUNCA tira.
 */
function buildResultBadges(meta, escapeHtml) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : defaultEscapeHtml;
  if (!meta || typeof meta !== 'object') return '';

  let html = '';

  const badge = RESULT_BADGES[meta.resultado];
  if (badge) {
    html += `<span class="cmd-result cmd-result-${esc(meta.resultado)}" title="${esc(badge.title)}">`
      + `${esc(badge.glyph)} ${esc(badge.label)}</span>`;
  }

  if (meta.provider && typeof meta.provider === 'string') {
    html += `<span class="cmd-provider">${esc(meta.provider)}</span>`;
  }

  // Chip de verificación SÓLO si el sidecar lo declara explícitamente (boolean).
  // Ausencia del campo (petición sin verificación Sherlock) → no se renderiza
  // chip: no inventar estado (guideline UX).
  if (typeof meta.sameProviderVerification === 'boolean') {
    if (meta.sameProviderVerification) {
      html += '<span class="cmd-verif cmd-verif-same" title="verificada por el mismo proveedor">same-provider</span>';
    } else {
      html += '<span class="cmd-verif cmd-verif-cross" title="verificada por un proveedor distinto">cross-provider</span>';
    }
  }

  return html;
}

module.exports = { RESULT_BADGES, buildResultBadges, defaultEscapeHtml };

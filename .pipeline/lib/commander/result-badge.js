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
  // #6459 — el turno se ejecutó entero pero su respuesta nunca se confirmó como
  // entregada. R-7: la CLAVE va sin tilde (de acá sale la clase CSS, abajo);
  // el label y el tooltip sí la llevan, porque son texto para el operador.
  huerfano: { glyph: '∅', label: 'huérfano', title: 'Se ejecutó, pero su respuesta nunca se confirmó como entregada' },
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

// =============================================================================
// #6459 — CSS de los badges, FUENTE ÚNICA.
//
// Antes estas reglas vivían sólo en el template de `generateHTML()` de
// `dashboard.js`, que el dispatch sirve ÚNICAMENTE para `/legacy`. El dashboard
// que abre el operador (`/`, `/v3`, `/dashboard`) lo emite `views/dashboard/
// home.js`, que nunca tuvo las reglas: el badge existía en el código y no se
// veía en ninguna pantalla real — exactamente el escape #4531 y el motivo del
// rebote de QA sobre este issue.
//
// Ahora ambas superficies interpolan esta misma constante: no hay dos copias
// que puedan divergir, y agregar un sexto resultado alcanza con tocar
// `RESULT_BADGES` + esta constante en el mismo archivo.
//
// UX-2 (bloqueante): el token va con FALLBACK HEX LITERAL, no
// `var(--x, var(--legacy))`. `loadDesignTokens()` degrada a cadena vacía si no
// puede leer `design-tokens.css`, y la paleta legacy inline de `dashboard.js`
// NO tiene ningún rosa al que caer (--gn/--yl/--ac/--rd/--or/--pu). Sin el hex
// el badge huérfano renderizaría MUDO. Los hex son los valores resueltos de
// --alert-anomaly / -dim / -bg.
// =============================================================================
const RESULT_BADGE_CSS = [
  '.cmd-result{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:5px;font-size:0.72em;font-weight:600;line-height:1.5;border:1px solid transparent;margin-left:6px}',
  '.cmd-result-ok       {color:var(--success,var(--gn,#3FB950));background:var(--success-bg,rgba(63,185,80,0.14));border-color:var(--success-dim,var(--gn2,#196C2E))}',
  '.cmd-result-ajustada {color:var(--warning,var(--yl,#D29922));background:var(--warning-bg,rgba(210,153,34,0.14));border-color:var(--warning-dim,var(--yl2,#9E6A03))}',
  '.cmd-result-fallback {color:var(--info,var(--ac,#58A6FF));   background:var(--info-bg,rgba(88,166,255,0.14));   border-color:var(--info-dim,var(--ac2,#1F6FEB))}',
  '.cmd-result-error    {color:var(--danger,var(--rd,#F85149)); background:var(--danger-bg,rgba(248,81,73,0.14));  border-color:var(--danger-dim,var(--rd2,#8B1A14))}',
  '.cmd-result-huerfano {color:var(--result-huerfano,#FF6B8A);background:var(--result-huerfano-bg,rgba(255,107,138,0.16));border-color:var(--result-huerfano-dim,#B8254A)}',
  '.cmd-provider{font-size:0.72em;color:var(--dim,var(--in-fg-dim,#7D8590));font-family:inherit;padding:1px 6px;border:1px solid var(--bd,var(--in-border,#30363D));border-radius:5px;margin-left:4px}',
  '.cmd-verif{font-size:0.72em;padding:1px 6px;border:1px solid var(--bd,var(--in-border,#30363D));border-radius:5px;margin-left:4px}',
  '.cmd-verif-cross{color:var(--info,var(--ac,#58A6FF));border-color:var(--info-dim,var(--ac2,#1F6FEB));background:var(--info-bg,rgba(88,166,255,0.14))}',
  '.cmd-verif-same {color:var(--dim,var(--in-fg-dim,#7D8590));border-color:var(--bd,var(--in-border,#30363D))}',
].join('\n');

module.exports = { RESULT_BADGES, RESULT_BADGE_CSS, buildResultBadges, defaultEscapeHtml };

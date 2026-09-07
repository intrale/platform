'use strict';
const { patch } = require('./patch');

// ── result-badge.js ────────────────────────────────────────────────────────
patch('.pipeline/lib/commander/result-badge.js', [
  [
`  error:    { glyph: '✗', label: 'error',    title: 'Error / timeout / sin-provider / respuesta vacía' },
});`,
`  error:    { glyph: '✗', label: 'error',    title: 'Error / timeout / sin-provider / respuesta vacía' },
  // #6459 — el turno se ejecutó entero pero su respuesta nunca se confirmó como
  // entregada. R-7: la CLAVE va sin tilde (de acá sale la clase CSS, abajo);
  // el label y el tooltip sí la llevan, porque son texto para el operador.
  huerfano: { glyph: '∅', label: 'huérfano', title: 'Se ejecutó, pero su respuesta nunca se confirmó como entregada' },
});`],
]);

// ── dashboard.js (CSS del badge) ───────────────────────────────────────────
patch('.pipeline/dashboard.js', [
  [
` *    Mapea el enum cerrado (ok/ajustada/fallback/error) a los 4 tokens`,
` *    Mapea el enum cerrado (ok/ajustada/fallback/error/huerfano) a los 5 tokens`],

  [
`.cmd-result-error    {color:var(--danger,var(--rd)); background:var(--danger-bg,rgba(248,81,73,0.14));  border-color:var(--danger-dim,var(--rd2))}`,
`.cmd-result-error    {color:var(--danger,var(--rd)); background:var(--danger-bg,rgba(248,81,73,0.14));  border-color:var(--danger-dim,var(--rd2))}
/* #6459 / UX-2 — FALLBACK HEX LITERAL, no \`var(--x, var(--legacy))\`.
 * \`loadDesignTokens()\` degrada a cadena vacía si no puede leer
 * design-tokens.css, y la paleta legacy inline de este archivo NO tiene ningún
 * rosa al que caer (--gn/--yl/--ac/--rd/--or/--pu). Con el patrón de las cuatro
 * reglas de arriba, el badge \`huerfano\` renderizaría MUDO — exactamente el
 * escape #4531. Los hex son los valores resueltos de --alert-anomaly*. */
.cmd-result-huerfano {color:var(--result-huerfano,#FF6B8A);background:var(--result-huerfano-bg,rgba(255,107,138,0.16));border-color:var(--result-huerfano-dim,#B8254A)}`],
]);

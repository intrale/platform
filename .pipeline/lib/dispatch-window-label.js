// =============================================================================
// dispatch-window-label.js — Rótulo canónico de la ventana de dispatch (#5176,
// CA-UX-3).
//
// Por qué existe
// --------------
// Desde #3680 CA-A15 el modo `partial_pause` se activa con `allowed_issues`
// **O** `allowed_skills` no vacíos. Toda la superficie que le muestra el modo al
// operador (pill del header del dashboard y el render de `/allowlist` en
// Telegram) lo rotulaba SÓLO por issues, así que una ventana por skill se leía
// como `⏸ Parcial · 0 issues` — que es indistinguible de "pausa parcial sin
// nada autorizado, equivale a running normal". Son lo opuesto: la ventana por
// skill SÍ restringe el dispatch.
//
// Este módulo es la única fuente del rótulo server-side. El equivalente
// client-side vive en `views/dashboard/header-meta.js`
// (`window.__dispatchWindowLabel`), que emite el mismo string para el DOM; los
// dos están cubiertos por tests que fijan las cuatro combinaciones.
//
// Contrato (CA-UX-3):
//   issues > 0, skills = 0  → "N issues"
//   issues = 0, skills > 0  → "M skills"
//   ambos > 0               → "N issues · M skills"
//   ambos = 0               → "0 issues"  (pausa parcial vacía: sí equivale a
//                             running normal, y ese es el único caso donde el
//                             copy de "vacía" es correcto)
// =============================================================================
'use strict';

/**
 * @param {number} issueCount  cantidad de issues autorizados
 * @param {number} skillCount  cantidad de skills autorizados
 * @returns {string} rótulo sin prefijo de modo (ej. "3 issues · 2 skills")
 */
function dispatchWindowLabel(issueCount, skillCount) {
    const issues = Number.isFinite(issueCount) && issueCount > 0 ? Math.trunc(issueCount) : 0;
    const skills = Number.isFinite(skillCount) && skillCount > 0 ? Math.trunc(skillCount) : 0;
    const parts = [];
    if (issues > 0) parts.push(`${issues} issues`);
    if (skills > 0) parts.push(`${skills} skills`);
    // Ventana vacía por los dos ejes: se mantiene el rótulo histórico por
    // issues. Es el único caso en el que "0 issues" no oculta una restricción.
    if (parts.length === 0) return '0 issues';
    return parts.join(' · ');
}

module.exports = { dispatchWindowLabel };

// #3642 — Helpers puros para formatear el badge architect.
//
// Estos helpers viven separados de dashboard-slices.js para test unitario
// aislado. El render del HTML del badge (con `esc()`/`ic()` inyectados) vive
// en `dashboard-slices.js#architectBadgeHTML` con un switch explicito sobre
// los 4 estados — eso permite que el grep CA-2 encuentre las 4 referencias
// a `ic('architect-<state>')` en los archivos exigidos.
//
// Defensa-en-profundidad XSS:
//   - Formato HH:MM manual con padStart (R5): prohibido toLocaleTimeString
//     (locale leak entre clientes).
//   - !isNaN(date.getTime()) antes de formatear; fallback '—' si invalido
//     (R6 — no expone stack del parseo al DOM).

'use strict';

/**
 * Formatea un timestamp en milisegundos como "HH:MM" con padStart de 2.
 * Devuelve '—' si el input es null/undefined/NaN o resulta en una fecha
 * invalida. No usa toLocaleTimeString.
 *
 * @param {number|null|undefined} startedAtMs
 * @returns {string}
 */
function formatArchitectStartedAt(startedAtMs) {
  if (startedAtMs == null) return '—';
  if (typeof startedAtMs !== 'number' || isNaN(startedAtMs)) return '—';
  const d = new Date(startedAtMs);
  if (isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * aria-label / title del badge por estado (español, sin locale leak).
 *
 * @param {{ state: string, startedAt: number|null }|null} info
 * @returns {string}
 */
function architectAriaLabel(info) {
  if (!info || !info.state) return '';
  switch (info.state) {
    case 'pending':  return 'architect pendiente';
    case 'running':  return `architect trabajando desde ${formatArchitectStartedAt(info.startedAt)}`;
    case 'approved': return 'architect aprobado';
    case 'rejected': return 'architect requiere ajustes';
    default:         return '';
  }
}

/**
 * Texto visible del badge. Espejo del patron `stale 12m` (estado · detalle).
 *
 * @param {{ state: string, startedAt: number|null }|null} info
 * @returns {string}
 */
function architectBadgeText(info) {
  if (!info || !info.state) return '';
  switch (info.state) {
    case 'pending':  return 'architect: pendiente';
    case 'running':  return `architect: trabajando · ${formatArchitectStartedAt(info.startedAt)}`;
    case 'approved': return 'architect: aprobado';
    case 'rejected': return 'architect: requiere ajustes';
    default:         return '';
  }
}

module.exports = {
  formatArchitectStartedAt,
  architectAriaLabel,
  architectBadgeText,
};

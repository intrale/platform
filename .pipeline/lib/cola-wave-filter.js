'use strict';

// =============================================================================
// cola-wave-filter.js — Lógica pura para filtrar el panel "Cola" del dashboard
// por la ola activa (issue #4360). Espejo conceptual de
// `lib/pipeline-lane-line.js` (`buildNotEnteredCards`): evita meter lógica
// no-testeable dentro del IIFE gigante del render SSR de `dashboard.js`.
//
// El panel "Cola" listaba TODOS los issues en estado `pendiente` sin filtrar por
// ola, por lo que issues reservados para olas futuras aparecían en la cola de la
// ola activa. Este helper aplica el mismo criterio que la sección
// "No ingresados" (`state.activeWave.issues`, normalizado por
// `lib/wave-resolver.js`).
//
// Fail-safe (Opción A, cerrada por PO en #4360): si `waveIssues` está vacío
// (el resolver de ola activa falló o degradó a `issues: []`), devuelve `[]`
// (cola vacía), NUNCA degrada a "mostrar todos" — eso reintroduciría el bug.
//
// Sin estado, sin I/O: recibe datos ya computados. Testeable con node --test.
// =============================================================================

/**
 * Filtra la lista de pendientes por el set de issues de la ola activa.
 *
 * @param {Array<[(number|string), object]>} pendientesList - entradas
 *   `[num, data]` de la matriz de issues en estado `pendiente`. Las keys pueden
 *   llegar como string o number (waves.json mezcla `{number}` e `int` plano),
 *   por eso se comparan con `Number(num)`.
 * @param {Array<number|string>} waveIssues - ids de issue de la ola activa,
 *   normalizados por `lib/wave-resolver.js`.
 * @returns {Array<[(number|string), object]>} sublista de `pendientesList`
 *   cuyos ids pertenecen a la ola activa. `[]` si `waveIssues` está vacío.
 */
function filterPendientesByWave(pendientesList, waveIssues) {
    const waveSet = new Set((waveIssues || []).map(Number));
    // Fail-safe Opción A: sin ola resuelta → cola vacía, nunca "mostrar todos".
    if (waveSet.size === 0) return [];
    return (pendientesList || []).filter(([num]) => waveSet.has(Number(num)));
}

module.exports = { filterPendientesByWave };

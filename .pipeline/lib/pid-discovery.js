// =============================================================================
// pid-discovery.js — Helper centralizado de detección de PIDs vivos
// (issue #3605 — toma deuda técnica #3609 dentro del scope; el patrón
//  `process.kill(pid, 0)` estaba duplicado en 5 archivos: file-lock.js,
//  waves.js, handoff.js, ready-marker.js, multi-provider/agent-models-rw.js).
//
// **Por qué existe**: cada copia del patrón terminaba con un manejo distinto
// de los códigos `ESRCH` (no existe) y `EPERM` (existe pero sin permisos),
// generando inconsistencias entre módulos. Este helper consolida la semántica
// canónica que vamos a usar de acá en más.
//
// **Semántica acordada**:
//   - PID inválido (NaN, <=0, no entero) → false (NO está vivo).
//   - `process.kill(pid, 0)` exitoso → true.
//   - `ESRCH` → false (el proceso terminó).
//   - `EPERM` → true (el proceso existe en el OS pero no tenemos permisos
//     para señalarlo; conservadoramente lo consideramos vivo para no romper
//     locks ni IPC).
//   - Cualquier otro error → false (defensivo).
//
// **Migración progresiva**: los call-sites existentes se pueden migrar a este
// helper en PRs separados. #3605 lo usa en `lib/agent-ipc.js` (necesidad nueva)
// y deja los call-sites antiguos intactos para no inflar el blast radius del PR.
// =============================================================================
'use strict';

/**
 * Devuelve true si el PID está vivo en el OS.
 *
 * Equivalente a `process.kill(pid, 0)` con manejo defensivo de ESRCH/EPERM.
 * Usar este helper en vez del patrón inline preserva la semántica acordada
 * (EPERM == vivo) cross-módulo.
 *
 * @param {number} pid PID a chequear.
 * @returns {boolean} true si vive, false si no.
 */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && err.code === 'ESRCH') return false;
        if (err && err.code === 'EPERM') return true; // existe pero sin permisos
        return false; // cualquier otro error: conservador
    }
}

/**
 * Versión async-friendly: devuelve una Promise que resuelve true/false.
 * Útil para call-sites que quieren combinar con otros checks en `Promise.all`.
 *
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
function pidAliveAsync(pid) {
    return Promise.resolve(pidAlive(pid));
}

module.exports = {
    pidAlive,
    pidAliveAsync,
};

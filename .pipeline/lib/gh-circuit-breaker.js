// =============================================================================
// gh-circuit-breaker.js — Circuit-breaker de conectividad para llamadas a `gh`
// (GitHub CLI). Incidente #4612: un outage de red a GitHub
// (`error connecting to api.github.com`) hizo que el loop del Pulpo acumulara
// cientos de llamadas `gh` fallidas y quedara demorado, dejando el heartbeat de
// liveness stale → el watchdog lo mató como zombi.
//
// Este breaker evita eso: tras N fallos CONSECUTIVOS de conexión, "abre" el
// circuito y hace que las llamadas siguientes cortocircuiten (retornen rápido
// sin spawnear `gh`) durante un cooldown. Pasado el cooldown, deja pasar UNA
// llamada de prueba (half-open): si funciona, cierra; si falla, reabre.
//
// Efecto: durante un outage, el loop del Pulpo NO se bloquea llamando a `gh` una
// y otra vez — degrada rápido, mantiene el heartbeat fresco, y reanuda solo
// cuando la red vuelve.
//
// PURO / DETERMINÍSTICO: sin IO, sin timers propios. El caller inyecta `now`
// (epoch ms) para test. Un default singleton se expone para el Pulpo.
//
// Semántica de error de conexión (CA): solo los fallos de RED/DNS/conexión
// cuentan para abrir el circuito. Un `gh` que responde 404/permiso/validación
// NO es un problema de conectividad y NO debe abrir el breaker.
// =============================================================================

'use strict';

// Patrones de error que indican problema de CONECTIVIDAD (no de negocio).
// `gh` imprime "error connecting to api.github.com" ante outage; Node/undici
// tiran ENOTFOUND/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/getaddrinfo/fetch failed.
const CONN_ERROR_PATTERNS = [
    /error connecting to/i,
    /\bENOTFOUND\b/,
    /\bECONNREFUSED\b/,
    /\bECONNRESET\b/,
    /\bETIMEDOUT\b/,
    /\bEAI_AGAIN\b/,
    /getaddrinfo/i,
    /fetch failed/i,
    /network is unreachable/i,
    /could not resolve host/i,
    /dial tcp/i,
    /connection refused/i,
    /timeout|timed out/i, // incluye GH_CALL_TIMEOUT del wrapper del Pulpo
];

/**
 * ¿El error/salida indica un problema de conectividad (no de negocio)?
 * @param {Error|string|{code?:string,message?:string,stderr?:string}} err
 * @returns {boolean}
 */
function isConnError(err) {
    if (!err) return false;
    if (err.code === 'GH_CALL_TIMEOUT') return true;
    const parts = [];
    if (typeof err === 'string') parts.push(err);
    else {
        if (err.code) parts.push(String(err.code));
        if (err.message) parts.push(String(err.message));
        if (err.stderr) parts.push(String(err.stderr));
    }
    const hay = parts.join(' \n ');
    return CONN_ERROR_PATTERNS.some((re) => re.test(hay));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.threshold=3]   fallos de conexión consecutivos para abrir.
 * @param {number} [opts.cooldownMs=30000] tiempo abierto antes de permitir un probe.
 * @param {function} [opts.onOpen]  callback(state) al abrir (para loguear una sola vez).
 * @param {function} [opts.onClose] callback(state) al cerrar tras recuperación.
 */
function createGhCircuitBreaker(opts = {}) {
    const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : 3;
    const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : 30000;
    const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
    const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;

    let consecutiveFailures = 0;
    let openUntil = 0;      // epoch ms; 0 = cerrado
    let probing = false;    // true cuando dejamos pasar un probe half-open
    let wasOpen = false;    // para disparar onClose una sola vez

    /**
     * ¿Debe el caller SALTEAR esta llamada a `gh` (cortocircuito)?
     * - Circuito cerrado → false (llamar normal).
     * - Circuito abierto y dentro del cooldown → true (cortar).
     * - Cooldown vencido → false pero marca `probing` (half-open: 1 llamada de prueba).
     * @param {number} now epoch ms
     * @returns {boolean}
     */
    function shouldShortCircuit(now) {
        if (openUntil === 0) return false;            // cerrado
        if (now < openUntil) return true;             // abierto, en cooldown → cortar
        // cooldown vencido → permitir UN probe
        probing = true;
        return false;
    }

    /**
     * Registrar el resultado de una llamada a `gh`.
     * @param {{ok:boolean, error?:*}} result
     * @param {number} now epoch ms
     */
    function record(result, now) {
        const ok = !!(result && result.ok);
        const connFail = !ok && isConnError(result && result.error);

        if (ok) {
            consecutiveFailures = 0;
            if (openUntil !== 0 || wasOpen) {
                openUntil = 0;
                probing = false;
                if (wasOpen && onClose) { try { onClose(getState(now)); } catch { /* no-op */ } }
                wasOpen = false;
            }
            return;
        }

        if (!connFail) {
            // Fallo de NEGOCIO (404/permiso/validación): no cuenta para el breaker.
            // Un probe fallido por negocio NO reabre (la red está bien).
            if (probing) { openUntil = 0; probing = false; wasOpen = false; }
            return;
        }

        // Fallo de conexión.
        consecutiveFailures += 1;
        if (probing) {
            // El probe half-open falló → reabrir el circuito.
            probing = false;
            openUntil = now + cooldownMs;
            return;
        }
        if (consecutiveFailures >= threshold && openUntil === 0) {
            openUntil = now + cooldownMs;
            wasOpen = true;
            if (onOpen) { try { onOpen(getState(now)); } catch { /* no-op */ } }
        } else if (openUntil !== 0) {
            // ya abierto y sigue fallando fuera de probe → extender cooldown
            openUntil = now + cooldownMs;
        }
    }

    function getState(now) {
        return {
            open: openUntil !== 0 && (!Number.isFinite(now) || now < openUntil),
            openUntil,
            consecutiveFailures,
            probing,
            threshold,
            cooldownMs,
        };
    }

    function reset() {
        consecutiveFailures = 0;
        openUntil = 0;
        probing = false;
        wasOpen = false;
    }

    return { shouldShortCircuit, record, getState, reset, isConnError };
}

module.exports = { createGhCircuitBreaker, isConnError, CONN_ERROR_PATTERNS };

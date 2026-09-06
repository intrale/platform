'use strict';

// =============================================================================
// dispatch-cause-kind.js — Traducción del enum de causas de despacho (#4709) al
// vocabulario de `kind` del watchdog de inactividad (#4708 / #5400).
//
// Por qué vive acá y no dentro de pulpo.js
// ----------------------------------------
// Este es el BRAZO DE RECOLECCIÓN del watchdog: si la traducción se equivoca, el
// watchdog silencia una causa que no debería silenciar (o al revés) y nadie se
// entera, porque lo que se ve es "no llegó una alerta". Enterrado en un archivo
// de 19k líneas era, literalmente, la única parte del circuito sin un solo test
// (hallazgo de la review rev-1). Acá es una función pura de 20 líneas, testeable.
//
// Regla fail-closed que manda (SEC-1)
// -----------------------------------
// La ANOMALÍA ("no sé por qué no despacho") NO se mapea a propósito y NUNCA
// puede silenciar la alarma: es el caso en que MÁS hace falta avisar. Una causa
// desconocida (enum nuevo sin mapear) tampoco silencia: sin `kind` no hay causa
// declarada y el watchdog dispara.
// =============================================================================

const dispatchCause = require('./dispatch-cause');

// Mantener alineado con `CAUSE_LABELS` de `lib/wave-stall-watchdog.js`: lo que
// no tenga label sale como slug crudo (preferible a "causa desconocida").
const DISPATCH_CAUSE_TO_WATCHDOG_KIND = Object.freeze({
    [dispatchCause.CAUSAS.HALT_HUMANO]: 'human-halt',
    [dispatchCause.CAUSAS.MODO_OLA]: 'wave-empty',
    [dispatchCause.CAUSAS.SIN_AGENTES]: 'concurrency-limit',
    [dispatchCause.CAUSAS.VENTANA_HORARIA]: 'priority-window',
    [dispatchCause.CAUSAS.REST_MODE]: 'night-window',
    [dispatchCause.CAUSAS.COOLDOWN]: 'cooldown',
    [dispatchCause.CAUSAS.BLOQUEO_DEPENDENCIA]: 'blocked-dependencies',
    [dispatchCause.CAUSAS.DEADLOCK]: 'deadlock',
    [dispatchCause.CAUSAS.CB_INFRA]: 'cb-infra',
    [dispatchCause.CAUSAS.PRESION_RECURSOS]: 'resource-pressure',
    [dispatchCause.CAUSAS.DISCO_LLENO]: 'disk-pressure',
});

/**
 * Traduce el artifact de causa declarada (#4709) al `cause` que consume
 * `wave-stall-watchdog.decide`.
 *
 * @param {object|null} art  artifact leído (`dispatch-cause.readArtifact`).
 * @returns {{declared:true, kind:string, readable:true, sinceTs:number|null,
 *            authorDeclared:null}|null} null = sin causa que declarar (dispara).
 */
function causeFromArtifact(art) {
    if (!art || typeof art !== 'object') return null;
    // Fail-closed: la anomalía nunca silencia.
    if (!art.causa || art.causa === dispatchCause.CAUSAS.ANOMALIA) return null;
    const kind = DISPATCH_CAUSE_TO_WATCHDOG_KIND[art.causa];
    if (!kind) return null; // enum sin mapear ⇒ no hay causa declarada
    return {
        declared: true,
        kind,
        readable: true,
        // `ts` = cuándo EMPEZÓ la causa. Es informativo (el watchdog mide contra
        // la inactividad de despacho, no contra esto — B1), pero sirve para el
        // dashboard y para diagnosticar.
        sinceTs: Number.isFinite(art.ts) ? art.ts : null,
        authorDeclared: null,
    };
}

module.exports = { DISPATCH_CAUSE_TO_WATCHDOG_KIND, causeFromArtifact };

// =============================================================================
// quota-adapters/antigravity.js — "Sin dato" deliberado (#3092 M2a + #3220 + #4202).
//
// #3220 — rename `gemini` → `gemini-google` (sign-off 2026-05-15); #6861 —
// rename final a `antigravity`, el nombre de lo que corre (Antigravity CLI).
//
// Por qué este adapter devuelve SIEMPRE "sin dato" (`not_implemented`,
// `pct: null`) y no se implementa un cálculo real (#4202 CA-4):
//
//   * Antigravity CLI NO expone por API un consumo acumulado del período:
//     la única medición es el % semanal del plan que devuelve `agy /usage`
//     (#6564, lo consume el health en /providers). No hay un endpoint ni un
//     campo equivalente al panel de Anthropic ni al costo mensual de Codex.
//
//   * Inventar un % a partir de RPM/RPD sería un número no confiable que
//     induciría a decisiones equivocadas de rebalanceo multi-provider. Mostrar
//     "sin dato" honesto es preferible (decisión de producto validada por PO,
//     #4202 CA-4). Un "0%" falso haría creer que hay cuota libre cuando en
//     realidad no se puede medir.
//
//   * Invariante de arquitectura (security CA-#6): aunque hubiera una fuente,
//     el adapter computa offline desde datos persistidos — NUNCA hace HTTP a
//     la API de Google. Por eso ni siquiera intentamos derivar consumo en vivo.
//
// El banner/panel del dashboard renderiza `pct: null` como estado "sin dato"
// (dim/neutro, NO ámbar `stale`), distinto de un "0% real" (security CA-#3 +
// UX G1).
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function geminiGoogleAdapter(_sessionData) {
    return emptyResult('antigravity', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota Antigravity CLI: sin dato; disponibilidad determinada por sesión OAuth y licencia/billing');
}

module.exports = geminiGoogleAdapter;

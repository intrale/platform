// =============================================================================
// quota-adapters/gemini-google.js — "Sin dato" deliberado (#3092 M2a + #3220 + #4202).
//
// #3220 — rename `gemini` → `gemini-google` (sign-off 2026-05-15) para
// alinear el naming con el resto del pipeline V3 multi-provider.
//
// Por qué este adapter devuelve SIEMPRE "sin dato" (`not_implemented`,
// `pct: null`) y no se implementa un cálculo real (#4202 CA-4):
//
//   * El **free tier** de Gemini (Google AI Studio) NO expone consumo
//     acumulado por API: solo publica límites de tasa (RPM/RPD — requests por
//     minuto/día) y responde `429` cuando se exceden. No hay un endpoint ni
//     un campo de "uso del período" equivalente al panel de Anthropic ni al
//     costo mensual de Codex.
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
    return emptyResult('gemini-google', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota Gemini (Google): sin dato — el free tier no expone consumo acumulado por API (solo RPM/RPD + 429)');
}

module.exports = geminiGoogleAdapter;

// =============================================================================
// quota-adapters/gemini-google.js — Stub para Google Gemini (#3092 M2a + #3220).
//
// #3220 — rename `gemini` → `gemini-google` (sign-off 2026-05-15) para
// alinear el naming con el resto del pipeline V3 multi-provider. Adapter
// stub mientras no haya un issue específico que implemente el cálculo
// real de cuota. El banner del dashboard renderiza `not_implemented`
// con `pct: null` para mostrar estado degradado, no luz verde silenciosa.
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function geminiGoogleAdapter(_sessionData) {
    return emptyResult('gemini-google', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota Gemini (Google): adapter pendiente de implementar (post-M2)');
}

module.exports = geminiGoogleAdapter;

// =============================================================================
// quota-adapters/gemini.js — Stub para Google Gemini (#3092 M2a).
//
// Stub mientras no haya un issue específico que implemente el adapter. La
// estructura es idéntica al stub de OpenAI/Codex: devuelve `not_implemented`
// con `pct: null` para que el banner muestre estado degradado, no luz verde
// silenciosa.
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function geminiAdapter(_sessionData) {
    return emptyResult('gemini', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota Gemini: adapter pendiente de implementar (post-M2)');
}

module.exports = geminiAdapter;

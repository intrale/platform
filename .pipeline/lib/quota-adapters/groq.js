// =============================================================================
// quota-adapters/groq.js — Stub para Groq (#3092 M2a + #3220).
//
// #3220 — Groq se incorpora al sign-off multi-provider 2026-05-15. API
// drop-in OpenAI-compatible: el detector estructurado de cuota
// (`_detectOpenAI` en lib/quota-exhausted.js) ya cubre los shapes SSE
// que Groq emite — no requiere handler nuevo en este issue.
//
// El cálculo de cuota real (consumo de tokens vs free tier) llega con
// el runtime de fallbacks (#3198). Mientras tanto, el adapter devuelve
// `not_implemented` con `pct: null` para que el banner del dashboard
// renderice estado degradado en lugar de luz verde silenciosa.
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function groqAdapter(_sessionData) {
    return emptyResult('groq', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota Groq: adapter pendiente de implementar — ver #3198 (runtime fallbacks[])');
}

module.exports = groqAdapter;

// =============================================================================
// quota-adapters/nvidia-nim.js — Stub para NVIDIA NIM (#4533).
//
// NVIDIA NIM expone endpoints OpenAI-compatible con límites por minuto y por
// día, y devuelve los headers `x-ratelimit-remaining` / `x-ratelimit-limit` /
// `x-ratelimit-reset` en cada respuesta (idéntico patrón a Cerebras). El
// cálculo de cuota real (available% + reset por ventana) se hidrata desde esos
// headers vía el seam `provider-quota.recordSample()` que puebla la capa de
// dispatch multi-provider — NO desde este adapter offline (security CA-#6 de
// #3092: los adapters no hacen requests HTTP).
//
// Mientras la captura de headers no esté conectada para NVIDIA, el adapter
// devuelve `not_implemented` con `pct: null` para que la celda del dashboard
// caiga a "sin dato" explícito en vez de mostrar luz verde silenciosa
// (security req#4). Esto NO significa "cuota agotada".
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function nvidiaNimAdapter(_sessionData) {
    return emptyResult('nvidia-nim', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota NVIDIA NIM: se hidrata desde headers x-ratelimit-* vía provider-quota.recordSample (#4533).');
}

module.exports = nvidiaNimAdapter;

// =============================================================================
// providers/gemini-google.js — Stub del provider Google Gemini (#3220).
//
// Este archivo existe para que la tabla hardcoded `PROVIDER_HANDLERS` de
// `resolve-provider.js` pueda resolver el provider `gemini-google` sin
// abrir el vector de path-traversal (require dinámico). El runtime real
// (wrapper Node que llama al endpoint REST) llega con #3198.
//
// Si un skill se asigna a este provider antes de #3198, `buildSpawn` tira
// un error accionable en español. NO crashea el pulpo, NO consume tokens
// — el flujo upstream atrapa el throw y rebota el archivo a `pendiente/`
// con motivo claro.
//
// #3220 — rename ex-`gemini` → `gemini-google` (sign-off 2026-05-15).
// =============================================================================
'use strict';

function _notImplemented(operation) {
    throw new Error(
        `[agent-launcher/gemini-google] Provider "gemini-google" no está implementado todavía (operación: ${operation}).\n` +
        `Issue de entrega: #3198 (runtime fallbacks[] multi-provider).\n` +
        `Acción inmediata para destrabar: cambiar el provider del skill afectado en .pipeline/agent-models.json a "anthropic" (o al provider que corresponda)\n` +
        `o esperar a que #3198 entregue el wrapper real.`
    );
}

function detectLauncher() {
    _notImplemented('detectLauncher');
}

function buildSpawn(/* { args, cwd, env } */) {
    _notImplemented('buildSpawn');
}

function parseTokensFromLog(/* logPath */) {
    return { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
}

function detectQuotaExhausted() {
    // Detector estructurado real depende de #3226 (`_detectGemini` en
    // quota-exhausted.js). Por ahora declarativo: no marca cuota agotada.
    return { matched: false };
}

module.exports = {
    name: 'gemini-google',
    detectLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
};

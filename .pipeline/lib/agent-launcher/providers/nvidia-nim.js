// =============================================================================
// providers/nvidia-nim.js — Stub del provider NVIDIA NIM (#3243).
//
// Este archivo existe para que la tabla hardcoded `PROVIDER_HANDLERS` de
// `resolve-provider.js` pueda resolver el provider `nvidia-nim` sin abrir
// el vector de path-traversal (require dinámico). El runtime real (wrapper
// Node que llama al endpoint REST OpenAI-compat de NVIDIA NIM) llega con
// #3198 (dispatch-with-fallback) cuando se materialicen los wrappers reales
// de free providers.
//
// API drop-in OpenAI-compatible (mismo patrón que groq/cerebras) — el
// detector estructurado de cuota (`_detectOpenAI` en quota-exhausted.js) ya
// cubre los shapes SSE que NVIDIA NIM emite, por lo que la detección de
// cuota será automática cuando el wrapper real exista.
//
// Si un skill se asigna a este provider antes de #3198, `buildSpawn` tira
// un error accionable en español. NO crashea el pulpo, NO consume tokens.
// =============================================================================
'use strict';

function _notImplemented(operation) {
    throw new Error(
        `[agent-launcher/nvidia-nim] Provider "nvidia-nim" no está implementado todavía (operación: ${operation}).\n` +
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
    // Detección estructurada: `_detectOpenAI` ya cubre el shape SSE de NVIDIA NIM.
    // Mientras el runtime real (#3198) no spawnee, no aplica.
    return { matched: false };
}

module.exports = {
    name: 'nvidia-nim',
    detectLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
};

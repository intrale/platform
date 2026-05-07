// =============================================================================
// providers/openai-codex.js — Stub del provider OpenAI/Codex (issue #3076 / H3).
//
// Este archivo existe para cumplir CA-1 del issue #3074 (estructura completa
// de providers) sin implementar todavía la lógica real, que la entrega H3
// (issue #3076) cuando agreguemos el binario y los handlers de tokens.
//
// Cuando `agent-models.json` apunta un skill a este provider, `buildSpawn`
// lanza un error accionable en español. NO crashea el pulpo, NO consume
// tokens — el flujo upstream (resolve-provider o el wrapper de
// agent-launcher) atrapa el throw y rebota el archivo a `pendiente/` con
// motivo claro.
// =============================================================================
'use strict';

function _notImplemented(operation) {
    throw new Error(
        `[agent-launcher/openai-codex] Provider "openai-codex" no está implementado todavía (operación: ${operation}).\n` +
        `Issue de entrega: #3076 (H3 multi-provider).\n` +
        `Acción inmediata para destrabar: cambiar el provider del skill afectado en .pipeline/agent-models.json a "anthropic" (o al provider que corresponda)\n` +
        `o esperar a que H3 entregue el handler real.`
    );
}

function detectLauncher() {
    _notImplemented('detectLauncher');
}

function buildSpawn(/* { args, cwd, env } */) {
    _notImplemented('buildSpawn');
}

// Retornamos zeros — si llegamos a parsear es porque hubo un spawn (que ya
// debería haber tirado en buildSpawn). Defensivo: no rompemos el on-exit.
function parseTokensFromLog(/* logPath */) {
    return { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
}

function detectQuotaExhausted() {
    // El detector de cuota Anthropic no aplica a OpenAI/Codex. H3 traerá su
    // propio detector si OpenAI usa un shape de error diferente.
    return { matched: false };
}

module.exports = {
    name: 'openai-codex',
    detectLauncher,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
};

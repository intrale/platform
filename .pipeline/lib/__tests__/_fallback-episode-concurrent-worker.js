// =============================================================================
// _fallback-episode-concurrent-worker.js — Worker forkeado para el test de
// concurrencia REAL de `recordDispatch` (#6179, CA-14 / SEC-6).
//
// Patrón copiado de `_setflag-concurrent-worker.js` (consumido por
// `quota-exhausted-concurrent-setflag.test.js`): argv sintético, sandbox en un
// tmpdir, exit codes discretos, y no escribe fuera del sandbox.
//
// Recibe por argv:
//   [2] stateDir   — sandbox (hace de `.pipeline/state/`)
//   [3] provider    — provider EFECTIVO del despacho (id sintético de la allowlist)
//   [4] now         — epoch ms del despacho (reloj inyectado, determinístico)
//
// Exit codes:
//   0 — corrió y NO notificó
//   1 — excepción inesperada del módulo
//   3 — corrió y SÍ notificó   (el test cuenta cuántos workers salen con 3)
//   4 — argv incompleto
//   5 — provider fuera de la allowlist sintética (fail-closed)
//
// El worker NO toca el estado real del pipeline: todo se resuelve contra
// `stateDir`, que el test crea con `mkdtempSync` y borra en el `finally`.
// =============================================================================
'use strict';

const [, , stateDir, provider, nowRaw] = process.argv;

if (!stateDir || !provider || !nowRaw) {
    console.error('worker: missing args (stateDir/provider/now)');
    process.exit(4);
}

// Fail-closed: sólo providers sintéticos declarados por el test.
const ALLOWED_PROVIDERS = ['openai-codex', 'cerebras', 'gemini-google'];
if (!ALLOWED_PROVIDERS.includes(provider)) {
    console.error(`worker: provider ${provider} no está en la allowlist sintética`);
    process.exit(5);
}

const now = Number(nowRaw);
if (!Number.isFinite(now)) {
    console.error(`worker: now inválido (${nowRaw})`);
    process.exit(4);
}

let episodeState;
try {
    episodeState = require('../fallback-episode-state');
} catch (err) {
    console.error(`worker: failed to load fallback-episode-state: ${err.message}`);
    process.exit(1);
}

try {
    const res = episodeState.recordDispatch({
        stateDir,
        provider,
        crossProvider: true,
        chain: ['anthropic', provider],
        // Models sintéticos: sin esto el módulo iría a buscar `agent-models.json`
        // del repo real, que es justo lo que el sandbox quiere evitar.
        models: {
            providers: {
                'openai-codex': { billing: 'paid', supports_tool_use: true },
                cerebras: { billing: 'free', supports_tool_use: false },
                'gemini-google': { billing: 'free', supports_tool_use: true },
            },
        },
        heartbeatMs: 6 * 60 * 60 * 1000,
        now,
    });
    process.exit(res && res.notify ? 3 : 0);
} catch (err) {
    console.error(`worker: recordDispatch threw: ${err.message}`);
    process.exit(1);
}

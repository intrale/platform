// =============================================================================
// agent-launcher.js — Entry point unificado del lanzamiento de agentes
// (issue #3074 / H2 multi-provider).
//
// Encapsula la decisión "qué binario corre y con qué args para el skill X".
// Reemplaza el bloque inline de spawn de Claude que vivía en `pulpo.js`
// (líneas 4900-4994 antes del refactor) por una sola llamada `launchAgent()`.
//
// **Contrato público**:
//   const result = launchAgent({
//     skill, issue, trabajandoPath, fase, pipeline,
//     args,            // args ya construidos por pulpo (system-prompt-file, etc.)
//     cwd,             // worktree path o ROOT
//     env,             // env completo a pasar al spawn (PIPELINE_*, etc.)
//     PIPELINE,        // ruta al directorio .pipeline/ (para agent-models.json)
//     ROOT,            // ruta al repo (para resolveDeterministicScript)
//     onWorktreeHit,   // callback opcional: invocado si el script determ. viene del worktree
//     onLog,           // callback opcional para warnings (firma compatible con `log`)
//     // inyectables (tests):
//     fsImpl, spawnImpl, execSyncImpl, resolveImpl,
//   });
//   // result = { child, provider, model, source, scriptPath?, handler, warning? }
//
// **Invariantes preservados** (regresión cero corriendo solo Anthropic — CA-4):
//   I1: skills determinísticos siempre con shell:false.
//   I2: env del spawn idéntico al previo (PIPELINE_* + extraEnv).
//   I3: stdio = ['ignore', 'pipe', 'pipe'], detached:false, windowsHide:true.
//   I4: defensa de path-traversal — los providers se resuelven contra una
//       tabla hardcoded (resolve-provider.js), nunca por require dinámico.
//   I5: el caller (pulpo) sigue siendo dueño del watchdog, child.unref(),
//       on-exit handler, emit traceability, fast-fail/cooldown, mover archivo.
//   I6: detector de quota agotada y parseo de tokens delega al `handler`
//       devuelto, así que cada provider trae su propia implementación.
//
// **Rollout reversible**: si un skill determinístico no tiene script en disco
// (caso "borré builder.js para volver al LLM" #2476), launchAgent cae al
// provider Anthropic con el `args` original — comportamiento idéntico al del
// pulpo previo al refactor.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolveProviderForSkill } = require('./agent-launcher/resolve-provider');
const PROVIDERS = {
    anthropic: require('./agent-launcher/providers/anthropic'),
    deterministic: require('./agent-launcher/providers/deterministic'),
    'openai-codex': require('./agent-launcher/providers/openai-codex'),
};

// -----------------------------------------------------------------------------
// launchAgent — única función pública. Resuelve provider, arma el spawn y
// devuelve el handle del proceso + metadata (provider, model, handler).
//
// El llamador (pulpo) se queda con `result.child` y conecta watchdog, stdio
// pipes y el on-exit handler como antes. La metadata (`provider`, `model`,
// `source`) se usa para logging y trazabilidad (#3072 ya consume `model`).
// -----------------------------------------------------------------------------
function launchAgent({
    skill,
    issue,
    trabajandoPath,
    fase,
    pipeline,
    args,
    cwd,
    env,
    PIPELINE,
    ROOT,
    onWorktreeHit,
    onLog,
    // inyectables para tests
    fsImpl,
    spawnImpl,
    execSyncImpl,
    resolveImpl,
} = {}) {
    if (!skill || typeof skill !== 'string') {
        throw new Error('[agent-launcher] launchAgent: parámetro "skill" es requerido y debe ser string.');
    }
    const _fs = fsImpl || fs;
    const _spawn = spawnImpl || spawn;
    const _resolve = resolveImpl || resolveProviderForSkill;
    const log = (typeof onLog === 'function') ? onLog : () => {};

    // 1. Resolver provider para el skill (usa agent-models.json o default).
    const resolution = _resolve(skill, { pipelineDir: PIPELINE, fsImpl: _fs });
    if (resolution.warning) {
        log('agent-launcher', `⚠️ ${resolution.warning}`);
    }

    // 2. Provider determinístico: si el script no existe, fallback a Anthropic
    //    (rollout reversible — invariante histórica del pulpo previo, #2476).
    let effective = resolution;
    if (resolution.provider === 'deterministic') {
        const determ = resolution.handler;
        const scriptPath = determ.resolveDeterministicScript({
            skill, issue, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl: _fs,
        });
        if (!_fs.existsSync(scriptPath)) {
            log('agent-launcher', `↩️ ${skill}:#${issue} script determinístico no existe (${scriptPath}), fallback a Anthropic LLM.`);
            effective = {
                provider: 'anthropic',
                model: resolution.model || null,
                handler: PROVIDERS.anthropic,
                source: 'fallback-deterministic-script-missing',
            };
        } else {
            // El script existe → delegamos al handler determinístico.
            // `buildSpawn` vuelve a resolver el script internamente (es barato
            // y mantiene el contrato del handler consistente). El scriptPath
            // del return permite al caller loggear "ejecutado en modo determinístico".
            const spawnDef = determ.buildSpawn({
                skill, issue, trabajandoPath, cwd, env, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl: _fs,
            });
            const child = _spawn(spawnDef.cmd, spawnDef.args, spawnDef.spawnOpts);
            return {
                child,
                provider: 'deterministic',
                model: null,
                source: resolution.source,
                scriptPath: spawnDef.scriptPath || scriptPath,
                handler: determ,
            };
        }
    }

    // 3. Provider LLM (anthropic o openai-codex): arma el spawn con el handler.
    //    Los providers LLM reciben `args` ya construidos por el caller (pulpo
    //    arma --system-prompt-file, --output-format, etc.).
    const handler = effective.handler;
    const spawnDef = handler.buildSpawn({ args, cwd, env });
    const child = _spawn(spawnDef.cmd, spawnDef.args, spawnDef.spawnOpts);
    return {
        child,
        provider: effective.provider,
        model: effective.model,
        source: effective.source,
        scriptPath: null,
        handler,
    };
}

module.exports = {
    launchAgent,
    // re-exports para que el caller pueda parsear tokens / detectar quota
    // sin tener que volver a resolver el provider.
    PROVIDERS,
    resolveProviderForSkill,
};

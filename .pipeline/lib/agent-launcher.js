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

const { resolveProviderForSkill, resolvePermissionMode, readAgentModels } = require('./agent-launcher/resolve-provider');
const permissionValidator = require('./permission-validator');
const skillsMetadata = require('./skills-metadata');
const PROVIDERS = {
    anthropic: require('./agent-launcher/providers/anthropic'),
    deterministic: require('./agent-launcher/providers/deterministic'),
    'openai-codex': require('./agent-launcher/providers/openai-codex'),
    'gemini-google': require('./agent-launcher/providers/gemini-google'),
    'nvidia-nim': require('./agent-launcher/providers/nvidia-nim'),
    'cerebras': require('./agent-launcher/providers/cerebras'),
};

// #3082 (CA-S3 / CA-8): cache liviano de required_permissions por skill,
// invalidado por mtime del archivo. Se puede desactivar via
// PIPELINE_PERMISSION_VALIDATOR_NO_CACHE=1 (tests).
const _skillPermissionsCache = new Map(); // skill → { mtime, required }

function getRequiredPermissionsForSkill(skill, fsImpl) {
    const _fs = fsImpl || fs;
    const skillsRoot = path.join(
        process.env.PIPELINE_REPO_ROOT || process.cwd(),
        '.claude', 'skills'
    );
    const skillFile = path.join(skillsRoot, skill, 'SKILL.md');
    if (!_fs.existsSync(skillFile)) {
        return { ok: false, error: `SKILL.md de '${skill}' no existe (${skillFile}).` };
    }
    const stat = _fs.statSync(skillFile);
    const cached = _skillPermissionsCache.get(skill);
    if (cached && cached.mtime === stat.mtimeMs && process.env.PIPELINE_PERMISSION_VALIDATOR_NO_CACHE !== '1') {
        return { ok: true, required_permissions: cached.required };
    }
    try {
        const loaded = skillsMetadata.loadSkillMetadata(skill, { skillsRoot, fsImpl: _fs });
        const required = Array.isArray(loaded.meta.required_permissions) ? loaded.meta.required_permissions : [];
        _skillPermissionsCache.set(skill, { mtime: stat.mtimeMs, required });
        return { ok: true, required_permissions: required };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Reset del cache — útil para tests o si el operador edita un SKILL.md hot.
function _resetPermissionsCacheForTesting() {
    _skillPermissionsCache.clear();
}

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

    // 1.5 (#3082 CA-S3 / CA-8 / CA-9): validación capability-level at-spawn-time.
    // Hacemos la validación ANTES de spawn — fail-CLOSED si:
    //   - el SKILL.md no declara required_permissions (modo legacy: warn solo)
    //   - capability fuera del catálogo (fail-fast, mensaje accionable)
    //   - capabilities requeridas no son subset de las concedidas por
    //     (provider, mode) según la matriz canónica.
    //
    // Para skills determinísticos NO aplicamos el gate: son Node puro auditado
    // que corre con permisos del usuario del pulpo (matriz `deterministic/native`).
    // Pero igualmente loggemos si declararon required_permissions, así nadie
    // queda con la falsa idea de que el gate los cubre.
    if (resolution.provider !== 'deterministic') {
        const permCheck = getRequiredPermissionsForSkill(skill, _fs);
        if (!permCheck.ok) {
            // Skill sin SKILL.md o sin frontmatter parseable.
            // Fail-CLOSED si el strict flag está activo, warning + permitir si no.
            // Default: warning para no romper rollout. Activar strict con env var.
            const strict = process.env.PIPELINE_PERMISSION_VALIDATOR_STRICT === '1';
            if (strict) {
                throw new Error(
                    `[FAIL-CLOSED] Skill '${skill}' no tiene required_permissions cargable.\n` +
                    `  ${permCheck.error}\n` +
                    `  Activá el flag strict (PIPELINE_PERMISSION_VALIDATOR_STRICT=1) ya es 1: fail-fast.\n` +
                    `  Doc: docs/pipeline-multi-provider/permission-mapping.md`
                );
            }
            log('agent-launcher', `⚠️ ${skill}: required_permissions no cargable — ${permCheck.error}. Avanzo en modo legacy.`);
        } else {
            // #4274 (CA-3 / SR-1) — eliminado el default fail-OPEN
            // `mode: resolution.mode || 'bypassPermissions'`. Un `mode` ausente
            // se resuelve EXPLÍCITAMENTE por provider; si aun así no se puede
            // resolver (provider desconocido), se hace fail-fast accionable.
            // NUNCA se asume el modo más privilegiado ante ausencia de dato.
            const resolvedMode = resolution.mode
                || resolvePermissionMode(readAgentModels(PIPELINE, _fs), resolution.provider);
            if (!resolvedMode) {
                throw new Error(
                    `[FAIL-CLOSED] mode no resoluble para provider '${resolution.provider}' (skill '${skill}'). ` +
                    `Declarar providers.${resolution.provider}.permissions_mode en agent-models.json ` +
                    `o agregar un default por provider en resolvePermissionMode (resolve-provider.js).`
                );
            }
            const validation = permissionValidator.validateSpawn({
                skill,
                provider: resolution.provider,
                mode: resolvedMode,
                requiredCapabilities: permCheck.required_permissions,
            });
            // #4274 (CA-8 / SR-5) — auditabilidad de la concesión: cuando el
            // spawn se autoriza, logueamos provider + mode + capabilities
            // concedidas (no solo el rechazo).
            if (validation.ok && validation.granted) {
                const grantedList = Array.from(validation.granted).sort().join(', ');
                log('agent-launcher', `🔓 ${skill}: spawn autorizado en ${resolution.provider}/${resolvedMode} — capabilities: ${grantedList}.`);
            }
            if (!validation.ok) {
                // CA-9 fail-CLOSED: throw para que pulpo lo trate como infra failure
                // y rebote el archivo al pendiente con motivo claro. El mensaje viaja
                // tal cual al log; CA-10 valida formato.
                log('agent-launcher', `🛑 ${validation.message}`);
                throw new Error(validation.message);
            }
            if (validation.source === 'override') {
                log('agent-launcher', `🛂 ${skill}: spawn autorizado por override activo (hash ${String(validation.override_hash).slice(0, 16)}).`);
            }
        }
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
                // #3605 — En fallback NO heredamos el flag deterministic; el
                // skill original era deterministic y la decisión de soporte
                // interactive aplica al provider que realmente termina corriendo.
                // Default false: anthropic recibe `'ignore'` salvo que el skill
                // tenga config explícita para anthropic (que en este caso no
                // tiene, porque era deterministic). Es decisión conservadora.
                interactive_supported: false,
            };
        } else {
            // El script existe → delegamos al handler determinístico.
            // `buildSpawn` vuelve a resolver el script internamente (es barato
            // y mantiene el contrato del handler consistente). El scriptPath
            // del return permite al caller loggear "ejecutado en modo determinístico".
            const spawnDef = determ.buildSpawn({
                skill, issue, trabajandoPath, cwd, env, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl: _fs,
                // #3605 — Opt-in. Solo si agent-models.json marca el skill como interactive_supported.
                interactive_supported: resolution.interactive_supported === true,
            });
            const child = _spawn(spawnDef.cmd, spawnDef.args, spawnDef.spawnOpts);
            return {
                child,
                provider: 'deterministic',
                model: null,
                source: resolution.source,
                scriptPath: spawnDef.scriptPath || scriptPath,
                handler: determ,
                // #3605 — Propagamos el flag al caller (pulpo) para que decida
                // si invocar agent-ipc.registerAgent. Default false.
                interactive_supported: resolution.interactive_supported === true,
            };
        }
    }

    // 3. Provider LLM (anthropic o openai-codex): arma el spawn con el handler.
    //    Los providers LLM reciben `args` ya construidos por el caller (pulpo
    //    arma --system-prompt-file, --output-format, etc.).
    const handler = effective.handler;

    // #4052 CA-2 — Pre-flight health-check de Codex (gated, default OFF para
    // rollout seguro: PIPELINE_CODEX_HEALTHCHECK_ENABLED=1). Valida que el
    // binario de Codex levanta sano ANTES de asignarle la fase. Si falla, marca
    // el provider disabled con TTL (lo hace probeCodexHealth) y tira un error de
    // infra para que el pulpo rebote el archivo a pendiente/ y el próximo
    // despacho elija otro provider de la cadena — evitando los 3 reintentos en
    // seco que queman el circuit breaker.
    if (effective.provider === 'openai-codex'
        && process.env.PIPELINE_CODEX_HEALTHCHECK_ENABLED === '1'
        && typeof handler.probeCodexHealth === 'function') {
        try {
            const probe = handler.probeCodexHealth({});
            if (!probe.ok) {
                log('agent-launcher', `🩺 ${skill}:#${issue} codex health-probe FALLÓ (kind=${probe.launcherKind}, status=${probe.status}, error=${probe.error}) — provider deshabilitado con TTL.`);
                throw new Error(`[provider-spawn-failure] codex health-probe falló (kind=${probe.launcherKind}, status=${probe.status}, error=${probe.error})`);
            }
        } catch (e) {
            // Si el throw vino del probe fallido, propagarlo (pulpo lo rebota).
            // Si vino un error inesperado del propio probe, fail-open: seguimos
            // al spawn normal (no bloqueamos por un bug del health-check).
            if (e && /provider-spawn-failure/.test(e.message || '')) throw e;
            log('agent-launcher', `⚠️ ${skill}:#${issue} codex health-probe lanzó excepción inesperada (fail-open, sigo al spawn): ${e && e.message}`);
        }
    }

    const spawnDef = handler.buildSpawn({
        args, cwd, env,
        // #3605 — Opt-in por skill+provider. Default false preserva I3.
        interactive_supported: effective.interactive_supported === true,
    });
    const child = _spawn(spawnDef.cmd, spawnDef.args, spawnDef.spawnOpts);

    // #4052 CA-1 — Instrumentación de la muerte temprana de Codex. SOLO para
    // openai-codex (no toca el path determinístico ni anthropic). Observacional:
    // captura exit/error + firstByte + stderr acotado, clasifica vía onSpawnExit
    // y registra un marker de spawn-failure para que el brazoHuerfanos (CA-3) no
    // penalice el retry del issue. NUNCA rompe el lifecycle (pulpo sigue siendo
    // dueño de su propio on-exit handler — invariante I5).
    if (effective.provider === 'openai-codex') {
        try {
            instrumentCodexSpawn({
                child,
                skill,
                issue,
                pipelineDir: PIPELINE,
                launcherKind: spawnDef.kind || null,
                onLog: log,
            });
        } catch (e) {
            log('agent-launcher', `⚠️ ${skill}:#${issue} no se pudo instrumentar el spawn de codex (best-effort): ${e && e.message}`);
        }
    }

    return {
        child,
        provider: effective.provider,
        model: effective.model,
        source: effective.source,
        scriptPath: null,
        handler,
        interactive_supported: effective.interactive_supported === true,
    };
}

// -----------------------------------------------------------------------------
// instrumentCodexSpawn — #4052 CA-1. Adjunta listeners observacionales al child
// de Codex para detectar y registrar la "muerte al spawnear".
//
// Diseño:
//  - Listeners ADICIONALES (no exclusivos): pulpo conserva sus propios
//    on('exit')/pipe(stdout) (invariante I5). Los eventos 'data'/'exit' se
//    transmiten a todos los listeners; no robamos bytes del pipe del pulpo.
//    Como launchAgent es síncrono y retorna antes de que el event loop ceda,
//    nuestros listeners y los de pulpo quedan registrados antes del primer byte.
//  - firstByteAt: primer dato de stdout/stderr. Si nunca llega, el clasificador
//    usa la firma "exit antes del primer byte".
//  - stderr acotado (8KB) SOLO para el excerpt del audit (pasa por
//    sanitizeRawExcerpt dentro de onSpawnExit). NO logueamos env (SEC-1).
//  - child.on('error'): evita además que un 'error' sin listener tumbe el
//    proceso (ENOENT de tiers shell:false).
// -----------------------------------------------------------------------------
function instrumentCodexSpawn({ child, skill, issue, pipelineDir, launcherKind, onLog }) {
    if (!child) return;
    const log = (typeof onLog === 'function') ? onLog : () => {};
    const startedAt = Date.now();
    let firstByteAt = null;
    let stderrBuf = '';
    const STDERR_CAP = 8192;
    let settled = false;

    const onFirstByte = () => { if (firstByteAt == null) firstByteAt = Date.now(); };
    try {
        if (child.stdout) child.stdout.on('data', onFirstByte);
        if (child.stderr) {
            child.stderr.on('data', (d) => {
                onFirstByte();
                if (stderrBuf.length < STDERR_CAP) {
                    stderrBuf += d.toString('utf8');
                    if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(0, STDERR_CAP);
                }
            });
        }
    } catch { /* best-effort */ }

    const settle = ({ exitCode, signal, errorCode }) => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - startedAt;
        try {
            const dispatcher = require('./agent-launcher/dispatch-with-fallback');
            const verdict = dispatcher.onSpawnExit({
                skill,
                issue,
                provider: 'openai-codex',
                transport: 'cli',
                rawOutput: stderrBuf,
                exitCode: (exitCode === undefined) ? null : exitCode,
                errorCode: errorCode || null,
                timedOut: false,
                durationMs,
                firstByteAt,
                // #4052 — opt-in de la firma 3 (exit antes del primer byte): acá
                // sí rastreamos el primer byte de stdout/stderr de verdad.
                spawnInstrumented: true,
                pipelineDir,
                onLog: log,
            });
            if (verdict && verdict.decision === 'provider-spawn-failure') {
                try {
                    const sfState = require('./agent-launcher/spawn-failure-state');
                    sfState.recordSpawnFailure({
                        pipelineDir,
                        provider: 'openai-codex',
                        skill,
                        issue,
                        signature: verdict.signature || null,
                        launcherKind,
                    });
                } catch { /* fail-open */ }
                log('agent-launcher', `💥 ${skill}:#${issue} codex spawn-failure detectado (kind=${launcherKind}, sig=${verdict.signature}) — marker registrado, no penaliza retry del issue.`);
            }
        } catch (e) {
            try { log('agent-launcher', `⚠️ ${skill}:#${issue} onSpawnExit (codex) tiró (best-effort): ${e && e.message}`); } catch {}
        }
    };

    try {
        child.once('error', (err) => settle({ exitCode: null, signal: null, errorCode: err && err.code }));
        child.once('exit', (code, signal) => settle({ exitCode: code, signal }));
    } catch { /* best-effort */ }
}

module.exports = {
    launchAgent,
    // re-exports para que el caller pueda parsear tokens / detectar quota
    // sin tener que volver a resolver el provider.
    PROVIDERS,
    resolveProviderForSkill,
    // #3082: exportados para tests y para validateAllSkillsAtBoot()
    getRequiredPermissionsForSkill,
    _resetPermissionsCacheForTesting,
};

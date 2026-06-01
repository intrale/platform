#!/usr/bin/env node
// =============================================================================
// Pulpo V2 — Proceso central del pipeline
// Brazos: barrido, lanzamiento, huérfanos, desbloqueo (+ intake en F5)
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// #3311 — Hidratar process.env desde ~/.claude/secrets/credentials.json antes
// de cualquier require que pueda leer credenciales (telegram-secrets,
// validateOrExit con checkEnv, etc). El cargador degrada silenciosamente si
// el archivo no existe; sólo loggea warnings al stderr en casos anómalos.
require('./lib/credentials').loadIntoEnv({
  logger: (m) => process.stderr.write(m + '\n'),
});

const yaml = require('js-yaml');
const dedupLib = require('./dedup-lib');
const precheck = require('./connectivity-precheck');
// #2333: sanitizador write-time para comentarios a GitHub y motivos de
// rebote persistidos en YAML. Protege contra leak de secretos en logs y
// comentarios automáticos que quedan públicos en el issue.
const { sanitize: sanitizePipelineText } = require('./sanitizer');
const connectivityState = require('./connectivity-state'); // #2335
const retryingState = require('./retrying-state');         // #2337 CA7/CA8
const uxMetrics = require('./ux-metrics');                 // #2337 CA10
let notifierInfraRecovered = null;                         // #2336 (lazy require)
try { notifierInfraRecovered = require('./notifier-infra-recovered'); } catch { /* opcional */ }
const { classifyRoutingMismatch } = require('./lib/routing-classifier');
const cbInfra = require('./circuit-breaker-infra');
const { redact } = require('./redact');
// #2404 — Detección de logs stale + reset seguro del circuit breaker.
// Evita rebotar al developer con contexto obsoleto (log del build de hace >24h)
// y en su lugar re-encola el issue a `build` con YAML limpio.
const staleness = require('./build-log-staleness');
const qaEvidenceGate = require('./lib/qa-evidence-gate');
// #3383 — Gate visual pre-promoción build→verificacion. Default OFF
// (PIPELINE_VISUAL_GATE_ENABLED=0). Activación gradual cuando #3381 esté en main.
const visualGate = require('./lib/visual-gate');
// #2549 — Detección de bloqueo humano en motivos de rechazo + helpers de marker.
// Evita relanzar al infinito skills cuyo rechazo es "esperando merge humano".
const humanBlock = require('./lib/human-block');
// #2490 — Pausa parcial con allowlist explícita de issues
const partialPause = require('./lib/partial-pause');
// #3518 CA-6 — Detector de desync waves.json ↔ .partial-pause.json
const desyncDetector = require('./lib/desync-detector');

const quotaExhausted = require('./lib/quota-exhausted'); // #2974
// #3508 — feature flag + ciclo de vida del workaround Anthropic CLI 1M (#3506).
// Expone isWorkaroundEnabled, recordHit, checkTtlAlert, formatStartupLogLine,
// formatHitExtension, formatTtlAlertMessage, sanitizeHitLog.
const oneMWorkaround = require('./lib/commander/anthropic-1m-workaround');
// #3258 — Multi-provider fallback chain para el Commander de Telegram. Reusa
// el runtime de dispatch-with-fallback (#3198) con `skill: 'telegram-commander'`.
// Sanitiza input del usuario, deduplica avisos de fallback (SR-6), emite audit
// log con hash-chain (CA-4 / SR-3) y formatea las notificaciones a Leo según
// UX-G1 (lenguaje natural, no log operativo).
const commanderMP = require('./lib/commander/multi-provider');
// #3577 — Detectores in-stream del Commander en modo SHADOW (parte 1/2 del
// split de #3472). Observan first-byte/stream-gap/eof-premature/transient-5xx
// y los emiten al audit log SIN matar el primario ni spawnear secundario.
// Wire-up real va en #3578.
const inflightShadow = require('./lib/commander/inflight-shadow-detectors');
// #3577 — generateRequestId para correlación cross-event (CA-S6): el mismo
// requestId se propaga a TODOS los `auditCommanderRequest` del turn.
const inflightFallback = require('./lib/commander/inflight-fallback');
// #3343 — Sherlock verifier adversarial. Corre IN-PROCESS entre
// `ejecutarClaude` y `sendTelegram` del flujo texto-libre. Refuta el análisis
// con un provider distinto al del Commander. Bypass total si
// config.yaml.sherlock_enabled=false. Ver lib/sherlock-verifier.js.
const sherlockVerifier = require('./lib/sherlock-verifier');
// #3343 — Sherlock necesita generar `turnId` para correlación cross-event
// del audit log (sherlock_verification ↔ commander_response). Usamos
// crypto.randomBytes(8) → 16 hex; bastante para forenses cruzados.
const crypto = require('node:crypto');
// #3250 — Delegación de creación de issues a /doc y /planner. Detección de
// intent + sanitización + audit log JSONL + provider gate + allowlist de
// sender. La invocación real del Skill tool sigue corriendo en la sesión
// Claude del Commander (`ejecutarClaude`); este módulo cierra el cinturón
// pre/post LLM para que el resultado sea indistinguible de un /doc por consola.
const commanderIssueCreation = require('./lib/commander/issue-creation');
// #3002 — Parser robusto del marker "Dependencias detectadas por el pipeline".
// Reemplaza la regex inline rota que extraía deps fantasma del body+comments.
const { parseDependencyComment } = require('./lib/dep-comment-parser');
const {
  resolveDependencies,
  buildAutoPromoteComment,
  sanitizeForLog,
} = require('./lib/dep-resolver');
// #3167 — Clasificador unificado de rebotes (cross_phase / dependency_block /
// human_block / infra / code). El brazo de barrido invoca `classifyRebote`
// ANTES de la rama de bloqueo humano: si detecta `dependency_block` no se
// crea marker en `bloqueado-humano/`, se aplica label `blocked:dependencies`
// y el brazoDesbloqueo (ya existente) destraba cuando todas las deps cierren.
const reboteClassifier = require('./lib/rebote-classifier');
// #2374 — Destino del rebote (faseRechazo para código, misma fase para infra)
const { resolveReboteDestino } = require('./lib/rebote-destino');
// #2893 — Detección de dependencias del allowlist en pausa parcial
const partialPauseDeps = require('./lib/partial-pause-deps');
// #2801 — emit session:start/end por cada lanzamiento de agente Claude (LLM)
// para que el aggregator pueda contabilizar tokens consumidos. Los skills
// determinísticos (delivery, builder, linter, tester) ya emiten por su cuenta.
const trace = require('./lib/traceability');
// #3072 / #3077 — modelo por skill desde .pipeline/agent-models.json
// (multi-provider H1 + H5). La validación canónica al boot vive en
// lib/agent-models-validate.js (#3081 S3). Acá hacemos un parseo defensivo
// post-validación para resolver provider/model/providerDef en runtime sin
// reabrir el archivo en cada gate. La carga real ocurre tras el bloque de
// validación (loadAgentModelsRuntime, ver más abajo) — required acá sólo
// para mantener el orden de imports en cabecera.
const fsForAgentModels = require('node:fs');
// #2993 — handoff cross-agente por issue. Lectura inyectada al userPrompt del
// próximo agente; escritura post-exit reusa el mismo mecanismo. Default OFF
// (rollout gradual via config.yaml → handoff.enabled).
const handoff = require('./lib/handoff');
// #3414 — Notificación Telegram de entregables del pipeline (human-in-the-loop
// opcional). Se invoca desde `brazoBarrido` cuando un skill notificable cierra
// fase OK. Default OFF (rollout gradual via config.yaml → deliverable_notifications.enabled).
const deliverableNotify = require('./lib/deliverable-notify');
const skillDeliverableAttachments = require('./lib/skill-deliverable-attachments');
// #3481 — Evaluación de completitud de fases paralelas que considera
// artefactos varados en `procesado/` (con whitelist estricta + anti-race
// contra pendiente/trabajando). Resuelve el deadlock cuando un skill cerró
// OK en un ciclo previo y los demás vuelven a entrar por desbloqueo de deps.
const phaseCompletion = require('./lib/phase-completion');
// #2891 PR-B — Detector de anomalías de consumo (cron interno).
const { AnomalyDetector } = require('./anomaly-detector');
// #2892 PR-C — Canal Telegram + estado del banner de alerta.
const costAnomalyAlert = require('./lib/cost-anomaly-alert');
const restModeState = require('./lib/rest-mode-state');
// #2890 PR-A — Gating horario del modo descanso (ventana + bypass labels).
const restModeWindow = require('./lib/rest-mode-window');
// #2975 — Notificador Telegram del modo cuota Anthropic agotada (lifecycle:
// inicial + recordatorios A→B→C→D rotando + cierre + canned a texto libre).
// Depende del flag .pipeline/quota-exhausted.json producido por #2974.
const { createQuotaNotifier, DEFAULT_REMINDER_INTERVAL_MIN } = require('./lib/quota-notifier');
// #3074 / H2 multi-provider: dispatcher de spawn por provider (anthropic /
// deterministic / openai-codex). Reemplaza el bloque inline de spawn de Claude
// que vivía acá pre-refactor (~líneas 4900-4994 de la versión previa).
const { launchAgent } = require('./lib/agent-launcher');
// #3257 — Commander determinístico: router + audit-log + rate-limit + redact.
// Reemplaza el parser de comandos inline por un módulo aislado y testable.
// La pista determinística (status/listado/snapshot/tail/etc) responde SIEMPRE
// sin invocar a Claude, incluso con cuota agotada o multi-provider caído.
const commanderDet = require('./lib/commander-deterministic');
// #3198 — consumer runtime de skill.fallbacks[]. Cuando el provider primario
// queda gateado por cuota, el dispatcher itera el array y devuelve la primera
// resolución no-gated en lugar de devolver el archivo a pendiente/. Mantiene
// hash-chain SHA-256 en logs/cross-provider-dispatch-*.jsonl + notify Telegram.
const { resolveSpawnWithFallback } = require('./lib/agent-launcher/dispatch-with-fallback');
// #3259 — provider-exhaustion-pause: cuando primary + todos los fallbacks
// de un skill quedan gated, este módulo aplica label, encola Telegram,
// persiste marker (dedupe 2h) y auditea con hash-chain. El brazo de retry
// (más abajo) llama a tryResume() periódicamente para destrabar issues
// cuando un provider se libera. Lectura defensiva: si el módulo no carga
// por bug, el pulpo sigue gateando como antes (CA-4/CA-9/CA-10 degradan a
// "label-less" sin tumbar el barrido).
let providerExhaustionPause = null;
try { providerExhaustionPause = require('./lib/provider-exhaustion-pause'); } catch { /* opcional */ }
// #3155: creación de worktree con recovery de branches huérfanas. Reemplaza
// el bloque inline previo (`git worktree add -b ... origin/main`) que fallaba
// cada vez que una iteración anterior dejaba la branch `agent/<n>-<skill>`
// huérfana en local — el `-b` rebotaba con "branch already exists" y el
// issue quedaba dando vueltas en cola sin avanzar.
const { ensureLaunchWorktree, WorktreeLaunchError } = require('./lib/worktree-launcher');
// #2591 — Resolver fast-fail del worktree para fases `useExistingWorktree`.
// Reemplaza el fallback inline a ROOT que producía commits cruzados entre
// agentes cuando el worktree del issue desaparecía (cleanup, restart, etc).
const { resolveExistingWorktree } = require('./lib/worktree-resolver');
const { appendWorktreeAudit } = require('./lib/worktree-audit');
const worktreeNotifDedup = require('./lib/worktree-notif-dedup');
// #3085 / S7 multi-provider: aislamiento de credenciales por proceso. Filtra
// `process.env` con allowlist mínima + scope del skill antes de pasarlo al
// child. Eliminar `OPENAI_API_KEY` del env de un agente Anthropic (y viceversa)
// reduce blast radius si el CLI third-party hace panic dump del env.
// Activación por flag `pipeline.env_isolation_enabled` en config.yaml (default
// false durante el rollout — ver CA-11 del issue #3085).
const buildChildEnvLib = require('./lib/build-child-env');
// #2334 / CA6: log stream sanitizer para stdout/stderr del agente.
const { createLogFileWriter } = require('./lib/sanitize-log-stream');
// #2334 / CA6: patch global de console.* para que nada pase al log de pulpo
// (archivo `logs/pulpo.log` que hereda stdout/stderr vía fd).
require('./lib/sanitize-console').install();
// Saneado global de JAVA_HOME — si el pulpo heredó una ruta stale (ej. JBR de
// una versión vieja de IntelliJ), la corregimos acá antes de spawnear agentes,
// así todos los hijos (builder, tester, qa, etc.) reciben un JDK válido.
// Incidente 2026-04-21: gradlew abortaba con "JAVA_HOME is set to an invalid
// directory" y el log quedaba sin error real, confundiendo al rebote como si
// fuera falla de código.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => {
    try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
    console.error(msg);
  },
});

// #3075 — Hidratación de API keys de providers desde el JSON único de secretos.
// El dispatcher de child procesos (`lib/build-child-env.js`) filtra `process.env`
// con allowlist mínima: para que el child de `openai-codex` reciba
// `OPENAI_API_KEY`, el padre tiene que tenerla en `process.env`. La fuente única
// de verdad es `~/.claude/secrets/telegram-config.json` (la misma key que ya usan
// TTS/Whisper vía `multimedia.js`). Mantener una sola fuente evita divergencias
// al rotar la key. Idempotente y no sobreescribe si el operador setea la var
// explícitamente en el SO.
require('./lib/hydrate-provider-env').hydrateProviderEnv({
  legacyConfigPath: path.join(__dirname, '..', '.claude', 'hooks', 'telegram-config.json'),
  log: (msg) => {
    try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
    console.error(msg);
  },
});

// #2337 CA10: cleanup perezoso + startup de metricas UX (REQ-SEC-5)
try { uxMetrics.cleanup({ force: true }); } catch { /* best-effort */ }

// Crash handlers — loguear y seguir vivo
process.on('uncaughtException', (err) => {
  // #2334: sanitizar antes de persistir stack del crash.
  const msg = sanitizePipelineText(`[${new Date().toISOString()}] [pulpo] CRASH uncaughtException: ${err.stack || err.message}\n`);
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), msg); } catch {}
  console.error(msg);
});
process.on('unhandledRejection', (reason) => {
  const msg = sanitizePipelineText(`[${new Date().toISOString()}] [pulpo] CRASH unhandledRejection: ${reason}\n`);
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), msg); } catch {}
  console.error(msg);
});

const ROOT = path.resolve(__dirname, '..');
const PIPELINE = path.resolve(__dirname);
const CONFIG_PATH = path.join(PIPELINE, 'config.yaml');
const LOG_DIR = path.join(PIPELINE, 'logs');
// Detector multi-capa del launcher de Claude Code.
// La estructura del paquete cambió entre versiones (2.1.114 eliminó cli.js
// y lo reemplazó con bin/claude.exe nativo + cli-wrapper.cjs fallback).
// Probamos opciones de más a menos preferida; todas evitan cmd.exe cuando es posible.
function detectClaudeLauncher() {
  const pkgDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
  const cliJsLegacy = path.join(pkgDir, 'cli.js');
  const binExe = path.join(pkgDir, 'bin', 'claude.exe');
  const wrapperCjs = path.join(pkgDir, 'cli-wrapper.cjs');
  const cmdShim = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');

  // 1. Legacy cli.js → node directo (compatibilidad con versiones viejas)
  if (fs.existsSync(cliJsLegacy)) {
    return { kind: 'node-cli-js', cmd: process.execPath, prefixArgs: [cliJsLegacy], shell: false };
  }
  // 2. Binario nativo (Claude Code ≥2.1.114) → ruta absoluta, sin shell
  if (fs.existsSync(binExe)) {
    return { kind: 'native-exe', cmd: binExe, prefixArgs: [], shell: false };
  }
  // 3. cli-wrapper.cjs → node directo (fallback JS del propio paquete)
  if (fs.existsSync(wrapperCjs)) {
    return { kind: 'node-wrapper-cjs', cmd: process.execPath, prefixArgs: [wrapperCjs], shell: false };
  }
  // 4. .cmd shim con ruta absoluta → shell:true (shims .cmd requieren shell en spawn)
  if (fs.existsSync(cmdShim)) {
    return { kind: 'cmd-shim', cmd: cmdShim, prefixArgs: [], shell: true };
  }
  // 5. Último recurso: 'claude' en PATH con shell
  return { kind: 'path-fallback', cmd: process.env.CLAUDE_BIN || 'claude', prefixArgs: [], shell: true };
}

const CLAUDE_LAUNCHER = detectClaudeLauncher();
const GH_BIN = 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';

// #3072 / #3077 — Singleton runtime de agent-models. La VALIDACIÓN del JSON
// se hace más abajo en el boot (validateOrExit del módulo agent-models-validate
// — #3081 S3). Acá hacemos un parseo defensivo post-validación: si falla, se
// degrada a {} para que las resoluciones devuelvan defaults seguros y no maten
// el proceso (validateOrExit ya cubre el fail-fast). Las funciones resuelven
// `provider`, `model` y `providerDef` para el quota gate multi-provider sin
// reabrir el archivo en cada llamada.
let AGENT_MODELS = null;
function loadAgentModelsRuntime() {
  try {
    const p = path.join(__dirname, 'agent-models.json');
    AGENT_MODELS = JSON.parse(fsForAgentModels.readFileSync(p, 'utf8'));
  } catch (e) {
    AGENT_MODELS = null;
    try { fsForAgentModels.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'),
      `[${new Date().toISOString()}] [pulpo] WARN agent-models.json no se pudo parsear en runtime: ${e.message}\n`); } catch {}
  }
}
loadAgentModelsRuntime();

// =============================================================================
// #3082 (CA-S3 / CA-8): validación capability-level de TODOS los skills al boot.
//
// Estrategia de rollout:
//   - Por default, este check corre con `mode: warn` y solo emite logs.
//   - Si `PIPELINE_PERMISSION_VALIDATOR_STRICT=1`, los failures terminan el boot
//     (fail-fast) — pensado para CI / smoke tests / staging.
//
// La validación at-spawn-time (en agent-launcher.js) sí es fail-CLOSED siempre.
// El check at-boot tiene rol distinto: alerta temprano si la config de
// agent-models.json + frontmatters de skills es inconsistente.
// =============================================================================
try {
    const permissionValidatorBoot = require('./lib/permission-validator');
    const skillsMetadataBoot = require('./lib/skills-metadata');
    const { resolveProviderForSkill, resolvePermissionMode } = require('./lib/agent-launcher/resolve-provider');
    const skillsRootBoot = path.join(__dirname, '..', '.claude', 'skills');
    const { registry: bootSkillsRegistry, failures: bootSkillsFailures } = skillsMetadataBoot.loadAllSkillsMetadata({
        skillsRoot: skillsRootBoot,
    });
    if (bootSkillsFailures && bootSkillsFailures.length > 0) {
        for (const f of bootSkillsFailures) {
            try { fsForAgentModels.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'),
                `[${new Date().toISOString()}] [pulpo] WARN skill '${f.skill}' falló parseo de metadata: ${f.error}\n`); } catch {}
        }
    }
    const bootResolveSkill = (skill) => {
        const r = resolveProviderForSkill(skill, { pipelineDir: __dirname, fsImpl: fsForAgentModels });
        if (!r) return null;
        return { provider: r.provider, mode: r.mode || 'bypassPermissions' };
    };
    const bootFailures = permissionValidatorBoot.validateAllSkillsAtBoot({
        skillsRegistry: bootSkillsRegistry,
        resolveSkill: bootResolveSkill,
    });
    if (bootFailures.length > 0) {
        const strict = process.env.PIPELINE_PERMISSION_VALIDATOR_STRICT === '1';
        for (const f of bootFailures) {
            try { fsForAgentModels.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'),
                `[${new Date().toISOString()}] [pulpo] WARN permission gate boot — ${f.skill}: ${f.reason || 'unknown'} — ${(f.message || '').split('\n')[0]}\n`); } catch {}
        }
        if (strict) {
            try { fsForAgentModels.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'),
                `[${new Date().toISOString()}] [pulpo] FATAL ${bootFailures.length} skill(s) no pasaron el permission gate at-boot — strict mode activo. Abortando boot.\n`); } catch {}
            process.exit(78); // EX_CONFIG (config issue)
        }
    }
} catch (e) {
    // Defensivo: el check de boot no puede tirar el pulpo. Si algo explota
    // (require falla, fs error), loggemos y seguimos — at-spawn-time igual
    // valida y atajan el bug en cada lanzamiento.
    try { fsForAgentModels.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'),
        `[${new Date().toISOString()}] [pulpo] WARN permission validator at-boot falló (no bloqueante): ${e.message}\n`); } catch {}
}

// Resolvers locales para evitar reabrir el JSON en cada gate. NULL-safe:
// si AGENT_MODELS no está disponible (pre-boot, error de IO), devuelven null
// y el caller cae al gate global / config legacy.
function resolveSkillProvider(skill) {
  if (!AGENT_MODELS) return null;
  const skillCfg = AGENT_MODELS.skills && AGENT_MODELS.skills[skill];
  if (!skillCfg) return null;
  return skillCfg.provider || AGENT_MODELS.default_provider || 'anthropic';
}
function resolveSkillModel(skill) {
  if (!AGENT_MODELS) return null;
  const skillCfg = AGENT_MODELS.skills && AGENT_MODELS.skills[skill];
  if (!skillCfg) return null;
  if (skillCfg.model_override) return skillCfg.model_override;
  const providerName = resolveSkillProvider(skill);
  if (!providerName) return null;
  const providerDef = AGENT_MODELS.providers && AGENT_MODELS.providers[providerName];
  return (providerDef && providerDef.model) || null;
}
function getSkillProviderDef(providerName) {
  if (!AGENT_MODELS || !providerName) return null;
  return (AGENT_MODELS.providers && AGENT_MODELS.providers[providerName]) || null;
}

// Rate limiting para GitHub API (máx 1 call cada 2 segundos)
let lastGhCallTime = 0;
function ghThrottle() {
  const now = Date.now();
  const wait = 2000 - (now - lastGhCallTime);
  if (wait > 0) {
    // Busy-wait síncrono (las alternativas requieren async y esto es llamado desde contextos sync)
    const end = Date.now() + wait;
    while (Date.now() < end) { /* throttle */ }
  }
  lastGhCallTime = Date.now();
}

/**
 * Agregar un comentario a un issue de GitHub (fire-and-forget).
 */
function ghCommentOnIssue(issueNumber, body) {
  try {
    // #2333: sanitizar write-time — NUNCA publicar un comentario público
    // con secretos crudos (tokens, JWT, PEM, headers con Authorization).
    const safeBody = sanitizePipelineText(body);
    ghThrottle();
    execSync(`"${GH_BIN}" issue comment ${issueNumber} --body "${safeBody.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      cwd: path.resolve(__dirname, '..')
    });
    log('github', `Comentario en #${issueNumber}: ${safeBody.slice(0, 80)}`);
  } catch (e) {
    log('github', `Error comentando #${issueNumber}: ${e.message}`);
  }
}

// =============================================================================
// CONNECTIVITY PRE-CHECK (#2317) — cache + driver
//
// El precheck corre async al inicio de cada ciclo del mainLoop. Su resultado
// se cachea en `lastPrecheckResult` y lo consumen las fases que requieren red
// (qa, build, tester, verificacion, entrega) ANTES de spawnear un agente.
//
// Si falla, NO se lanza el agente; en su lugar el pulpo marca el archivo de
// trabajo con `rebote_tipo: infra` y escribe un motivo accionable. Ese tipo
// de rebote NO cuenta contra el circuit breaker del issue (criterio #2 de #2317).
//
// Cuando el precheck vuelve a estar OK después de un fallo, el pulpo detecta
// los archivos con `rebote_tipo: infra` y los reencola limpios (criterio #7).
// =============================================================================

// Fases cuyo agente requiere conectividad de red para trabajar.
// Dev también la usa (git + gh + gradle download), pero dev genera worktree
// antes del spawn y un fallo de red suele manifestarse mejor como rebote de
// build/tester que como precheck. Por ahora solo gateamos fases post-dev.
const NETWORK_REQUIRED_PHASES = new Set(['build', 'verificacion', 'linteo', 'aprobacion', 'entrega']);

// Intervalo mínimo entre prechecks ejecutados (ms). Evita spammear DNS en
// cada ciclo del pulpo cuando el poll_interval es corto.
const PRECHECK_MIN_INTERVAL_MS = 30 * 1000;

let lastPrecheckResult = null; // { ok, results, timestamp, durationMs }
let lastPrecheckAt = 0;
let lastPrecheckOkStreak = 0;  // Ciclos consecutivos con precheck OK
let lastInfraBlockedIssues = new Set(); // Issues notificados como bloqueados por infra

/**
 * Ejecuta el precheck si el cache está vencido. Siempre retorna el último
 * resultado conocido. Error-tolerante: si falla, asume `ok:false` conservador.
 */
async function ejecutarPrecheck(config) {
  const now = Date.now();
  if (lastPrecheckResult && (now - lastPrecheckAt) < PRECHECK_MIN_INTERVAL_MS) {
    return lastPrecheckResult;
  }

  const precheckCfg = (config && config.precheck) || {};
  const opts = {
    timeoutMs: precheckCfg.timeout_ms || 5000,
    maxRetries: precheckCfg.max_retries || 3,
  };
  if (Array.isArray(precheckCfg.endpoints) && precheckCfg.endpoints.length > 0) {
    opts.endpoints = precheckCfg.endpoints;
  }

  try {
    const result = await precheck.runPrecheck(opts);
    const previousOk = lastPrecheckResult ? lastPrecheckResult.ok : null;
    lastPrecheckResult = result;
    lastPrecheckAt = now;

    if (result.ok) {
      lastPrecheckOkStreak++;
    } else {
      lastPrecheckOkStreak = 0;
    }

    // Persistir infra-health.json para el dashboard
    try {
      precheck.writeInfraHealth(result, path.join(PIPELINE, 'infra-health.json'));
    } catch (e) {
      log('precheck', `No se pudo escribir infra-health.json: ${e.message}`);
    }

    // #2335 — registrar resultado del probe en connectivity-state, detectar
    // transicion FAIL→OK y emitir evento `connectivity_restored` unicamente
    // como consecuencia del probe real (anti-spoofing CA2).
    try {
      const transitionInfo = connectivityState.recordProbeResult(result);
      if (transitionInfo.transition === 'fail-to-ok') {
        log('precheck', `📡 connectivity_restored emitido (blocked_duration_ms=${transitionInfo.event && transitionInfo.event.blocked_duration_ms})`);
      }
    } catch (e) {
      log('precheck', `No se pudo actualizar connectivity-state: ${connectivityState.sanitizeForLog(e.message)}`);
    }

    if (!result.ok) {
      const failed = precheck.failedEndpoints(result);
      const summary = failed.map(f => `${f.phase}:${f.host}(${f.code})`).join(', ');
      log('precheck', `🔴 precheck FAIL — ${connectivityState.sanitizeForLog(summary)}`);
      // Solo notificamos a Telegram cuando transiciona de OK→FAIL para no spamear
      if (previousOk === true) {
        try { sendTelegram(`🔴 Pipeline bloqueado por infra — ${summary}. Agentes en pausa hasta recuperar red.`); } catch {}
      }
    } else if (previousOk === false) {
      log('precheck', `🟢 precheck OK — infra recuperada (durationMs=${result.durationMs})`);
      // #2337 CA7: NO enviar Telegram aqui — la choreografia FS-first exige que
      // el estado `reintentando` se escriba en disco ANTES de encolar cualquier
      // cmd.json de Telegram. Eso lo hace `reencolarInfraBloqueados` unas lineas
      // mas abajo en el mismo tick, con orden estricto: FS -> Telegram.
    }

    return result;
  } catch (err) {
    log('precheck', `⚠️ Error ejecutando precheck: ${err.message}`);
    // En caso de error desconocido del precheck mismo, asumimos OK para no
    // trabar el pipeline por un bug nuestro. Mejor falso negativo que deadlock.
    const fallback = { ok: true, results: [], timestamp: new Date().toISOString(), durationMs: 0, error: err.message };
    lastPrecheckResult = fallback;
    lastPrecheckAt = now;
    return fallback;
  }
}

/** Devuelve true si la última corrida del precheck está OK (o no corrió todavía). */
function precheckOk() {
  if (!lastPrecheckResult) return true; // Primer ciclo: no bloquear
  return lastPrecheckResult.ok === true;
}

/**
 * #2335 — mapea un resultado de precheck fallido a una categoria del enum
 * `REASON_CATEGORIES` de connectivity-state. La clasificacion se hace aqui
 * (pulpo), sobre señales internas verificables, NUNCA confiando en el campo
 * que un agente haya podido escribir (defensa A01 del analisis de security).
 */
function mapPrecheckFailureToReason(precheckResult) {
  const R = connectivityState.REASON_CATEGORIES;
  if (!precheckResult) return R.UNKNOWN;
  const failed = precheck.failedEndpoints(precheckResult) || [];
  if (failed.length === 0) return R.UNKNOWN;
  const codes = failed.map(f => String(f.code || '').toUpperCase());
  if (codes.some(c => c === 'ENOTFOUND' || c === 'ENETUNREACH' || c === 'EHOSTUNREACH' || c === 'EAI_AGAIN')) {
    return R.NETWORK_UNREACHABLE;
  }
  if (codes.some(c => c === 'ETIMEDOUT' || c.includes('TIMEOUT'))) {
    return R.BACKEND_TIMEOUT;
  }
  if (codes.some(c => c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EPIPE')) {
    return R.BACKEND_5XX;
  }
  return R.UNKNOWN;
}

/**
 * Marca un archivo de trabajo como bloqueado por infra (no mover a trabajando/,
 * no lanzar agente). Agrega metadatos de diagnóstico al YAML para que la
 * próxima pasada — o el operador — entiendan por qué.
 *
 * @param {string} workFilePath ruta al archivo en pendiente/
 * @param {number} issue número de issue
 * @param {string} skill skill
 * @param {string} fase fase actual
 * @param {object} precheckResult resultado del precheck con los endpoints fallidos
 */
function marcarBloqueoInfra(workFilePath, issue, skill, fase, precheckResult) {
  try {
    const data = readYaml(workFilePath);
    const motivo = precheck.buildInfraReboteMotivo(precheckResult) || '[infra] bloqueo sin detalle';
    const updated = {
      ...data,
      rebote_tipo: 'infra',
      bloqueado_por_infra: true,
      infra_ultimo_check: precheckResult.timestamp,
      infra_motivo: motivo,
      infra_endpoints_fallidos: precheck.failedEndpoints(precheckResult),
    };
    writeYaml(workFilePath, updated);

    // #2335 — registrar issue en blocked-by-infra.json con categoria
    // normalizada (UX-1: enum cerrado para que hijas 2/3 mappeen consistente).
    try {
      const reason = mapPrecheckFailureToReason(precheckResult);
      connectivityState.addBlockedIssue({
        number: parseInt(issue),
        reason,
        detail: precheck.failedEndpoints(precheckResult).map(f => `${f.phase}:${f.host}(${f.code})`).join(', '),
      });
    } catch (e) {
      log('precheck', `No se pudo registrar #${issue} en blocked-by-infra: ${connectivityState.sanitizeForLog(e.message)}`);
    }

    log('precheck', `🚫 #${issue} (${skill}/${fase}) NO lanzado — bloqueo infra (${precheck.failedEndpoints(precheckResult).length} endpoints)`);

    // Comentar en GitHub solo una vez por corrida (evita spam).
    // lastInfraBlockedIssues se resetea cuando precheck vuelve a OK.
    if (!lastInfraBlockedIssues.has(String(issue))) {
      lastInfraBlockedIssues.add(String(issue));
      const firstFail = precheck.failedEndpoints(precheckResult)[0];
      const detalle = firstFail ? `${firstFail.phase.toUpperCase()} ${firstFail.host} (${firstFail.code})` : 'red/DNS';
      ghCommentOnIssue(
        issue,
        `🚫 Bloqueado por infra #2314 — ${detalle} — se reintentará automáticamente al restaurar conectividad.`,
      );
    }
  } catch (e) {
    log('precheck', `Error marcando bloqueo infra #${issue}: ${e.message}`);
  }
}

/**
 * Cuando el precheck vuelve a estar OK después de un fallo, recorre las
 * carpetas pendiente/ de todas las fases y re-habilita los archivos marcados
 * con `rebote_tipo: infra`. Criterio #7 del issue #2317.
 *
 * #2337 CA7 — Choreografia temporal FS-first:
 *
 *   Orden estricto en el MISMO tick (sin async yield entre fases):
 *     1. Scan: recolectar issues bloqueados por infra (sin side-effects).
 *     2. FS-FIRST: escribir `retryingUntil` en `retrying-state.json` (state
 *        sync visible para el dashboard con ventana anti-parpadeo de 2s).
 *     3. YAML: limpiar markers de infra en los work files (issues launchable).
 *     4. Telegram: encolar cmd.json via `notifier-infra-recovered` (fallback
 *        a `sendTelegram` directo si el notifier no esta disponible).
 *     5. Cleanup: limpiar `blocked-by-infra.json` + set en memoria.
 *     6. Metricas: persistir entrada append-only en `.pipeline/metrics/`.
 *
 *   Si el proceso crashea entre (2) y (4): el dashboard ya muestra `reintentando`,
 *   el Telegram no se envio; el siguiente ciclo (tras restart) re-detecta los
 *   issues con rebote_tipo=infra persistidos y vuelve a correr (REQ-SEC-6).
 *
 *   Si crashea entre (4) y (6): metrica perdida pero el efecto ya aplico,
 *   aceptable porque la captura es best-effort (no afecta la experiencia).
 */
function reencolarInfraBloqueados(config) {
  if (!precheckOk()) return;
  if (lastInfraBlockedIssues.size === 0) return; // Nada que reencolar

  const tickStartMs = Date.now();
  const pipelines = Object.keys(config.pipelines || {});

  // ── Fase 1 — Scan: recolectar archivos candidatos SIN escribir ────────
  const candidatos = []; // [{ path, data, issue, cleaned }]
  for (const pipelineName of pipelines) {
    const pipelineConfig = config.pipelines[pipelineName];
    for (const fase of pipelineConfig.fases || []) {
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      let archivos;
      try { archivos = listWorkFiles(pendienteDir); } catch { continue; }
      for (const a of archivos) {
        let data;
        try { data = readYaml(a.path); } catch { continue; }
        if (data && data.rebote_tipo === 'infra') {
          const issue = issueFromFile(a.name);
          const cleaned = { ...data };
          delete cleaned.rebote_tipo;
          delete cleaned.bloqueado_por_infra;
          delete cleaned.infra_ultimo_check;
          delete cleaned.infra_motivo;
          delete cleaned.infra_endpoints_fallidos;
          cleaned.infra_reencolado_en = new Date().toISOString();
          candidatos.push({ path: a.path, cleaned, issue });
        }
      }
    }
  }

  if (candidatos.length === 0) {
    // Aun asi limpiar el set en memoria y blocked-by-infra.json
    lastInfraBlockedIssues.clear();
    try {
      connectivityState.clearBlockedIssues({
        type: 'connectivity_restored',
        ts: new Date().toISOString(),
      });
    } catch (e) {
      log('precheck', `No se pudo limpiar blocked-by-infra.json: ${connectivityState.sanitizeForLog(e.message)}`);
    }
    return;
  }

  const issueNumbers = Array.from(new Set(candidatos.map((c) => parseInt(c.issue, 10))))
    .filter((n) => Number.isFinite(n) && n > 0);

  // ── Fase 2 — FS-FIRST: marcar estado `reintentando` antes que cualquier Telegram ──
  let tsDashboardUpdate = tickStartMs;
  let retryingUntil = tickStartMs + retryingState.DEFAULT_MIN_RETRY_MS;
  try {
    const result = retryingState.markRetrying(issueNumbers, {
      now: tickStartMs,
      reason: 'connectivity_restored',
      previousState: 'blocked:infra',
    });
    retryingUntil = result.retryingUntil;
    tsDashboardUpdate = Date.now();
    log('precheck', `🟡 retrying-state escrito (issues=${issueNumbers.length}, until=+${retryingUntil - tickStartMs}ms) [FS-first]`);
  } catch (e) {
    log('precheck', `No se pudo escribir retrying-state: ${connectivityState.sanitizeForLog(e.message)}`);
  }

  // ── Fase 3 — YAML: limpiar markers de infra en cada archivo ───────────
  const reencolados = [];
  for (const c of candidatos) {
    try {
      // Anotar la ventana `reintentando` en el propio work file para que otros
      // consumidores (dashboard, diagnosticos) puedan leerlo sin consultar el
      // state global. Campo no obligatorio, solo metadata.
      c.cleaned.retrying_until_ms = retryingUntil;
      c.cleaned.retrying_since_ms = tickStartMs;
      writeYaml(c.path, c.cleaned);
      reencolados.push(c.issue);
    } catch (e) {
      log('precheck', `Error reencolando #${c.issue}: ${e.message}`);
    }
  }

  const unicos = Array.from(new Set(reencolados));
  log('precheck', `🟢 Reencolados por infra recuperada: ${unicos.map((i) => `#${i}`).join(', ')}`);

  // ── Fase 4 — Telegram: encolar cmd.json DESPUES del FS ────────────────
  //
  // Prioridad:
  //   a) notifier-infra-recovered (#2336): mensaje unico consolidado con
  //      variante rotable, MarkdownV2 escapado, dedup y rate-limit TTS.
  //   b) sendTelegram simple como fallback (si #2336 no esta disponible).
  let varianteMensaje = null;
  let tsTelegramDelivered = null;
  let rateLimitAlcanzado = null;
  (async () => {
    const recoveredEvent = {
      type: 'connectivity_restored',
      ts: new Date(tickStartMs).toISOString(),
      requeued: { count: unicos.length, issues: unicos.map((n) => parseInt(n, 10)) },
    };
    try {
      if (notifierInfraRecovered && typeof notifierInfraRecovered.notify === 'function') {
        const res = await notifierInfraRecovered.notify(recoveredEvent, {
          botToken: getTelegramToken(),
          chatId: getTelegramChatId(),
        });
        tsTelegramDelivered = Date.now();
        if (res && res.sent) {
          // Extraer id corto del mensaje para la metrica (REQ-SEC-3: nunca el texto).
          varianteMensaje = res.dedupHash ? `hash:${String(res.dedupHash).slice(0, 8)}` : 'variant:unknown';
          if (res.rateLimitReason === 'per-issue' || res.rateLimitReason === 'global') {
            rateLimitAlcanzado = res.rateLimitReason === 'per-issue' ? 'issue' : 'global';
          }
        }
      } else {
        sendTelegram('🟢 Infra recuperada. Reencolando issues bloqueados por red.');
        tsTelegramDelivered = Date.now();
        varianteMensaje = 'fallback:simple';
      }
    } catch (e) {
      log('precheck', `Error notificando recuperacion de infra: ${connectivityState.sanitizeForLog(e.message)}`);
    }

    // Comentarios por issue via gh CLI (idempotente — solo la 1ra vez por run).
    for (const issue of unicos) {
      try { ghCommentOnIssue(issue, `🟢 Infra #2314 restaurada — reintentando automáticamente.`); } catch { /* best-effort */ }
    }

    // ── Fase 6 — Metricas UX (CA10) append-only ────────────────────────
    try {
      uxMetrics.appendMetric({
        event: 'connectivity_restored',
        timestamp_event: tickStartMs,
        timestamp_dashboard_update: tsDashboardUpdate,
        timestamp_telegram_delivered: tsTelegramDelivered,
        variante_mensaje: varianteMensaje,
        issues_reencolados: unicos.length,
        rate_limit_alcanzado: rateLimitAlcanzado,
        previous_state: 'blocked:infra',
        retrying_window_ms: retryingState.DEFAULT_MIN_RETRY_MS,
      });
    } catch (e) {
      log('precheck', `No se pudo escribir metrica UX: ${connectivityState.sanitizeForLog(e.message)}`);
    }
  })().catch((err) => log('precheck', `async notify/metrics error: ${err.message}`));

  // ── Fase 5 — Cleanup: memoria + blocked-by-infra.json ─────────────────
  lastInfraBlockedIssues.clear();
  try {
    connectivityState.clearBlockedIssues({
      type: 'connectivity_restored',
      ts: new Date().toISOString(),
    });
  } catch (e) {
    log('precheck', `No se pudo limpiar blocked-by-infra.json: ${connectivityState.sanitizeForLog(e.message)}`);
  }
}

// --- Utilidades ---

// Nota: `splitTextForTTSChunks` vive en `./multimedia` (módulo dueño de TTS).
// Issue #3515 consolidó el algoritmo allí; los scopes que lo usan importan la
// función vía destructuring del `require('./multimedia')` local.

function log(brazo, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${brazo}] ${msg}`);
}

/**
 * #2893 — Resolver el path del script determinístico (tester/builder/linter/
 * delivery) preferiendo la copia del worktree del issue cuando existe, con
 * fallback al script de ROOT (main).
 *
 * Motivación (chicken-and-egg): la fase verificacion corre desde ROOT (main),
 * que tiene la versión vieja del script. Si un agente pipeline-dev modifica
 * el propio script determinístico (ej: tester.js), su fix vive en la rama
 * agent/<issue>-<skill> dentro del worktree y nunca toma efecto antes del
 * merge → el issue se traba en rebote eterno hasta circuit breaker.
 *
 * Este resolver usa la copia del worktree cuando existe, así el agente puede
 * verificar su propio fix antes del merge. Seguridad: el worktree pertenece
 * a un agente que pasó validacion+dev del pipeline; PR review humano
 * (CODEOWNERS @leitolarreta) sigue siendo gate antes del merge.
 *
 * Argumentos:
 *   - skill: nombre del skill ("tester", "builder", "linter", "delivery").
 *   - issue: número del issue.
 *   - ROOT: path absoluto del repo principal.
 *   - PIPELINE: path absoluto de .pipeline/ en ROOT.
 *   - onWorktreeHit (opcional): callback(worktreePath) que se invoca cuando
 *     se decide usar el script del worktree. Útil para logging.
 *   - execSyncImpl (opcional): inyectable para tests.
 *   - fsImpl (opcional): inyectable para tests (necesita existsSync).
 *
 * Retorna el path absoluto del script a ejecutar.
 */
function resolveDeterministicScript({ skill, issue, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl } = {}) {
  const _execSync = execSyncImpl || execSync;
  const _fs = fsImpl || fs;
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', `${skill}.js`);
  if (!issue || !ROOT) return rootScript;
  let issueWorktree = null;
  try {
    const needle = `platform.agent-${issue}-`;
    const worktrees = _execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true });
    for (const line of String(worktrees).split('\n')) {
      if (line.startsWith('worktree ') && line.includes(needle)) {
        issueWorktree = line.replace('worktree ', '').trim();
        break;
      }
    }
  } catch { /* sin worktree, fallback a ROOT */ }
  if (issueWorktree) {
    const wtScript = path.join(issueWorktree, '.pipeline', 'skills-deterministicos', `${skill}.js`);
    if (_fs.existsSync(wtScript)) {
      if (typeof onWorktreeHit === 'function') {
        try { onWorktreeHit(issueWorktree); } catch { /* ignore */ }
      }
      return wtScript;
    }
  }
  return rootScript;
}

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readYaml(filepath) {
  try {
    return yaml.load(fs.readFileSync(filepath, 'utf8')) || {};
  } catch { return {}; }
}

function writeYaml(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, yaml.dump(data, { lineWidth: -1 }));
}

// Artifacts auxiliares: detección centralizada en `lib/marker-artifact.js`
// (#3638 CA-F-1). Sin este filtro el pulpo levantaba
// `<issue>.<skill>.guidance.txt` como si fuera un marker de agente,
// alcanzaba el invariante "skill no autorizado para esa fase" y mandaba
// alerta Telegram falsa (incidente 2026-05-11 con #3073.pipeline-dev.guidance.txt).
const { isMarkerArtifact: isMarkerArtifactPulpo } = require('./lib/marker-artifact');

/** Listar archivos de trabajo (no .gitkeep, ni artifacts auxiliares) en una carpeta */
function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep') && !isMarkerArtifactPulpo(f))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

/** Extraer issue number del nombre de archivo (ej: "1732.po" → "1732") */
function issueFromFile(filename) {
  return filename.split('.')[0];
}

/** Extraer skill del nombre de archivo (ej: "1732.po" → "po") */
function skillFromFile(filename) {
  return filename.split('.').slice(1).join('.');
}

/** Mover archivo entre carpetas (atómico en filesystem) */
function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.renameSync(src, dest);
  return dest;
}

/** Obtener path de fase dentro de un pipeline */
function fasePath(pipelineName, faseName) {
  return path.join(PIPELINE, pipelineName, faseName);
}

// ---------------------------------------------------------------------------
// CROSS-PHASE REBOTE — permite a un agente solicitar rebote a otra fase/skill
// upstream cuando detecta que necesita re-ejecución de trabajo previo.
//
// Ejemplo: android-dev detecta que faltan assets del UX → emite YAML con
//   rebote_destino: { pipeline: desarrollo, fase: validacion, skill: ux }
// El pulpo rutea el issue a esa fase en vez del default `fase_rechazo`.
//
// Escalada automática por cantidad de rebotes cross-phase del mismo issue:
//   - 1er rebote → destino declarado por el agente.
//   - 2do rebote → escala a fase previa del mismo skill (ej. validacion/ux → criterios/ux).
//   - 3er rebote → escalado a humano (label needs-human).
// ---------------------------------------------------------------------------

const MAX_CROSSPHASE_REBOTES = 2;

/** Orden global de fases considerando todos los pipelines en el orden de config. */
function getFaseGlobalOrder(config) {
  const order = [];
  for (const [pName, pCfg] of Object.entries(config.pipelines || {})) {
    for (const fase of (pCfg.fases || [])) {
      order.push({ pipeline: pName, fase });
    }
  }
  return order;
}

function faseGlobalIndex(pipelineName, fase, config) {
  const order = getFaseGlobalOrder(config);
  return order.findIndex(e => e.pipeline === pipelineName && e.fase === fase);
}

/** Busca la fase anterior (en orden global) donde el skill dado participa. */
function findPreviousFaseForSkill(skill, fromPipeline, fromFase, config) {
  const order = getFaseGlobalOrder(config);
  const currentIdx = order.findIndex(e => e.pipeline === fromPipeline && e.fase === fromFase);
  if (currentIdx <= 0) return null;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const { pipeline: p, fase: f } = order[i];
    const skills = (config.pipelines?.[p]?.skills_por_fase?.[f]) || [];
    if (skills.includes(skill)) {
      return { pipeline: p, fase: f, skill };
    }
  }
  return null;
}

/** Valida que un rebote_destino declarado por agente sea utilizable. */
function validateRebotedDestino(destino, faseOriginPipeline, faseOrigin, config) {
  if (!destino || typeof destino !== 'object') return { ok: false, reason: 'no-destino' };
  const { pipeline: p, fase: f, skill: s } = destino;
  if (!p || !f || !s) return { ok: false, reason: 'campos-incompletos' };
  if (!config.pipelines?.[p]) return { ok: false, reason: `pipeline-no-existe:${p}` };
  if (!(config.pipelines[p].fases || []).includes(f)) return { ok: false, reason: `fase-no-existe:${p}/${f}` };
  const skillsFase = (config.pipelines[p].skills_por_fase?.[f]) || [];
  if (!skillsFase.includes(s)) return { ok: false, reason: `skill-no-en-fase:${s}@${p}/${f}` };
  const destIdx = faseGlobalIndex(p, f, config);
  const origIdx = faseGlobalIndex(faseOriginPipeline, faseOrigin, config);
  if (destIdx < 0 || origIdx < 0) return { ok: false, reason: 'fase-no-resoluble' };
  if (destIdx >= origIdx) return { ok: false, reason: `destino-no-upstream:${p}/${f}>=${faseOriginPipeline}/${faseOrigin}` };
  return { ok: true };
}

/** Cuenta rebotes cross-phase existentes del issue buscando en todos los YAML. */
function contarCrossPhaseRebotes(issue, config) {
  let maxCount = 0;
  for (const pName of Object.keys(config.pipelines || {})) {
    for (const fase of (config.pipelines[pName].fases || [])) {
      for (const estado of ['pendiente', 'trabajando', 'procesado']) {
        const dir = path.join(fasePath(pName, fase), estado);
        try {
          for (const f of fs.readdirSync(dir)) {
            if (!f.startsWith(String(issue) + '.')) continue;
            const data = readYaml(path.join(dir, f));
            if (data?.rebote_tipo === 'crossphase' && (data.rebote_numero_crossphase || 0) > maxCount) {
              maxCount = data.rebote_numero_crossphase;
            }
          }
        } catch {}
      }
    }
  }
  return maxCount;
}

/**
 * Resuelve un cross-phase rebote a partir de los archivos rechazados.
 * Devuelve null si ningún archivo emitió `rebote_destino` o si el destino es inválido.
 * Si hay múltiples destinos, elige el MÁS UPSTREAM (menor índice global).
 */
function resolveRebotedCrossPhase(resultados, pipelineOrigin, faseOrigin, config) {
  const candidatos = [];
  for (const r of resultados) {
    if (r.resultado !== 'rechazado' || !r.rebote_destino) continue;
    const validacion = validateRebotedDestino(r.rebote_destino, pipelineOrigin, faseOrigin, config);
    if (!validacion.ok) {
      log('barrido', `⚠️ #${r.issue || '?'} rebote_destino inválido (${validacion.reason}) — ignorando, cae a default`);
      continue;
    }
    candidatos.push({
      destino: r.rebote_destino,
      skillOrigen: skillFromFile(r.file.name),
      motivo: r.motivo || '',
      index: faseGlobalIndex(r.rebote_destino.pipeline, r.rebote_destino.fase, config),
    });
  }
  if (candidatos.length === 0) return null;
  candidatos.sort((a, b) => a.index - b.index);
  return candidatos[0];
}

/** Obtener el mtime de un archivo en minutos */
function fileAgeMinutes(filepath) {
  try {
    const stat = fs.statSync(filepath);
    return (Date.now() - stat.mtimeMs) / 60000;
  } catch { return 0; }
}

/** Buscar si un issue ya existe en alguna carpeta del pipeline */
/** Verificar si un issue ya está ACTIVO en un pipeline (pendiente/trabajando/listo, NO procesado) */
function issueExistsInPipeline(issueNum, pipelineName) {
  const config = loadConfig();
  const pipelines = pipelineName ? { [pipelineName]: config.pipelines[pipelineName] } : config.pipelines;
  const prefix = issueNum + '.';

  for (const [pName, pConfig] of Object.entries(pipelines)) {
    if (!pConfig) continue;
    for (const fase of pConfig.fases) {
      // Solo buscar en estados activos — procesado significa que ya terminó esa fase
      // bloqueado-humano cuenta como activo: el issue está pausado pero ocupando slot conceptual,
      // no debe re-intakearse ni relanzarse hasta que /unblock lo desbloquee (issue #2478)
      // bloqueado-dependencias (issue #3229) idem: el brazoDesbloqueo lo libera cuando
      // todas las deps cierren — mientras tanto, no debe re-intakearse ni relanzarse.
      for (const estado of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano', 'bloqueado-dependencias']) {
        const dir = path.join(PIPELINE, pName, fase, estado);
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(prefix) && f !== '.gitkeep') return true;
          }
        } catch {}
      }
    }
  }
  return false;
}

// --- Circuit Breaker + Cooldown ---
// Penalización exponencial: si un agente muere rápido, esperar antes de relanzar.
// Base: 5 min, duplica en cada fallo consecutivo. Max: 60 min.
const COOLDOWN_BASE_MS = 5 * 60 * 1000;    // 5 minutos
const COOLDOWN_MAX_MS = 60 * 60 * 1000;    // 60 minutos
const COOLDOWN_FILE = path.join(PIPELINE, 'cooldowns.json');

function loadCooldowns() {
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch { return {}; }
}

function saveCooldowns(cd) {
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cd, null, 2));
}

/** Registrar un fallo rápido para un issue+skill. Incrementa el contador y calcula el cooldown. */
function registerFastFail(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (!cd[key]) cd[key] = { failures: 0, cooldownUntil: null };
  cd[key].failures++;
  const delay = Math.min(COOLDOWN_BASE_MS * Math.pow(2, cd[key].failures - 1), COOLDOWN_MAX_MS);
  cd[key].cooldownUntil = new Date(Date.now() + delay).toISOString();
  cd[key].lastFailure = new Date().toISOString();
  saveCooldowns(cd);
  return { failures: cd[key].failures, delayMin: Math.round(delay / 60000) };
}

/** Verificar si un issue+skill está en cooldown. */
function isInCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (!cd[key] || !cd[key].cooldownUntil) return false;
  return new Date(cd[key].cooldownUntil) > new Date();
}

/** Limpiar cooldown de un issue+skill (cuando un agente termina exitosamente). */
function clearCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (cd[key]) { delete cd[key]; saveCooldowns(cd); }
}

// --- Perfiles de consumo de recursos por skill ---
// Promedios históricos de CPU/RAM que consume cada tipo de agente.
// Se actualizan al terminar cada agente usando los snapshots de metrics-history.
const SKILL_PROFILES_FILE = path.join(PIPELINE, 'skill-profiles.json');

// Versión del schema de skill-profiles. Incrementar cada vez que cambie la fórmula
// de aprendizaje de `avgMem` / `avgCpu` — al hacerlo, los perfiles viejos se invalidan
// automáticamente en el próximo arranque de pulpo. v2 = aprendizaje por DELTA vs baseline.
const SKILL_PROFILES_SCHEMA_VERSION = 2;

function loadSkillProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(SKILL_PROFILES_FILE, 'utf8'));
    // Compatibilidad: si el archivo viejo no tiene _schemaVersion (v1), devolver vacío
    // al próximo save se escribirá con la versión nueva.
    if (!raw || raw._schemaVersion !== SKILL_PROFILES_SCHEMA_VERSION) return {};
    const { _schemaVersion, ...profiles } = raw;
    return profiles;
  } catch { return {}; }
}

function saveSkillProfiles(profiles) {
  const payload = { _schemaVersion: SKILL_PROFILES_SCHEMA_VERSION, ...profiles };
  fs.writeFileSync(SKILL_PROFILES_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Migración one-shot: si skill-profiles.json existe pero tiene un schema viejo
 * (o no tiene schema version), renombrarlo a .bak y empezar de cero con la fórmula
 * nueva. Se ejecuta una sola vez al arrancar pulpo.
 */
function migrateSkillProfilesIfNeeded() {
  try {
    if (!fs.existsSync(SKILL_PROFILES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SKILL_PROFILES_FILE, 'utf8'));
    if (raw && raw._schemaVersion === SKILL_PROFILES_SCHEMA_VERSION) return; // ya migrado

    const bakPath = SKILL_PROFILES_FILE + '.v1.bak';
    fs.renameSync(SKILL_PROFILES_FILE, bakPath);
    log('pulpo', `📦 skill-profiles.json migrado a v${SKILL_PROFILES_SCHEMA_VERSION}: backup en ${path.basename(bakPath)}. Los perfiles se reaprenden con la fórmula DELTA.`);
  } catch (e) {
    log('pulpo', `Error migrando skill-profiles: ${e.message}`);
  }
}

/**
 * Registrar el consumo de recursos de un agente que terminó.
 *
 * Estrategia DELTA (v2): aprender el INCREMENTO que el agente introdujo respecto
 * a la baseline inmediatamente previa a su lanzamiento, no el promedio absoluto
 * del sistema durante su vida. Sin esto, infra pesada coexistente (emulador,
 * Edge, Gradle daemons) se cuela en el perfil y el gate predictivo lo vuelve
 * a sumar al usage actual → doble conteo → livelock.
 *
 * Ver pulpo.js comentario de predictResourceImpact y docs/pipeline/gate-predictivo.md
 */
const BASELINE_WINDOW_MS = 60_000; // Ventana de muestras pre-lanzamiento para estimar baseline

function recordSkillResourceUsage(skill, startTime, endTime) {
  try {
    const metricsFile = path.join(PIPELINE, 'metrics-history.jsonl');
    if (!fs.existsSync(metricsFile)) return;

    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }

    // Baseline: muestras inmediatamente PREVIAS al lanzamiento (ventana de 60s).
    // Filtramos por presencia de cpu numérico para excluir entries de
    // anomaly-detector (#2891 PR-B) que comparten el mismo archivo pero con
    // shape distinta `{ type: 'anomaly', ts ISO, ... }` y sin cpu/mem.
    const isPulse = (s) => typeof s.cpu === 'number' && typeof s.mem === 'number' && typeof s.ts === 'number';
    const baseline = parsed.filter(s => isPulse(s) && s.ts >= startTime - BASELINE_WINDOW_MS && s.ts < startTime);
    // Durante: muestras mientras el agente estuvo vivo
    const during = parsed.filter(s => isPulse(s) && s.ts >= startTime && s.ts <= endTime);

    if (baseline.length === 0 || during.length < 2) {
      // Sin baseline confiable o muy pocas muestras — no aprender (evita corromper el perfil)
      return;
    }

    const avgBaselineCpu = baseline.reduce((sum, s) => sum + s.cpu, 0) / baseline.length;
    const avgBaselineMem = baseline.reduce((sum, s) => sum + s.mem, 0) / baseline.length;
    const avgDuringCpu = during.reduce((sum, s) => sum + s.cpu, 0) / during.length;
    const avgDuringMem = during.reduce((sum, s) => sum + s.mem, 0) / during.length;

    // Delta bruto: cuánto subió el sistema respecto al instante previo a lanzarlo
    const deltaCpu = Math.max(0, avgDuringCpu - avgBaselineCpu);
    const deltaMem = Math.max(0, avgDuringMem - avgBaselineMem);

    // Si había otros agentes Claude corriendo durante la ventana, atribuirles
    // parcialmente el delta (50% de atribución conservadora). Así no inflamos
    // el perfil de este skill con el consumo de los vecinos.
    const avgDuringAgents = during.reduce((sum, s) => sum + Math.max(1, s.agents || 1), 0) / during.length;
    const otherAgents = Math.max(0, avgDuringAgents - 1);
    const shareDenominator = 1 + otherAgents * 0.5;
    const estCpuPerAgent = deltaCpu / shareDenominator;
    const estMemPerAgent = deltaMem / shareDenominator;

    const profiles = loadSkillProfiles();
    const existing = profiles[skill] || { avgCpu: estCpuPerAgent, avgMem: estMemPerAgent, samples: 0 };

    // Rolling average ponderado: más peso a la historia acumulada
    const n = existing.samples;
    const weight = Math.min(n, 20); // Cap en 20 para que samples nuevos sigan teniendo efecto
    profiles[skill] = {
      avgCpu: Math.round(((existing.avgCpu * weight + estCpuPerAgent) / (weight + 1)) * 10) / 10,
      avgMem: Math.round(((existing.avgMem * weight + estMemPerAgent) / (weight + 1)) * 10) / 10,
      samples: n + 1,
      lastUpdated: new Date().toISOString()
    };

    saveSkillProfiles(profiles);
    log('recursos', `📊 Perfil ${skill}: CPU ~${profiles[skill].avgCpu}% MEM ~${profiles[skill].avgMem}% (${profiles[skill].samples} muestras)`);
  } catch (e) {
    log('recursos', `Error registrando perfil de ${skill}: ${e.message}`);
  }
}

/**
 * Gate predictivo: verificar si lanzar un agente de este skill
 * llevaría al sistema por encima de los umbrales seguros.
 * Retorna { safe: bool, reason: string, predicted: { cpu, mem } }
 *
 * Confianza de profiles:
 * - < MIN_RELIABLE_SAMPLES: blend progresivo hacia defaults (pocas muestras = ruido)
 * - Cap máximo por agente: ningún proceso Claude usa >25% CPU o >20% MEM realmente
 * - Profiles >24h sin actualizar: reducir confianza (el sistema puede haber cambiado)
 */
const MIN_RELIABLE_SAMPLES = 5;
const MAX_EST_CPU = 25;  // Cap: ningún agente Claude usa más que esto
const MAX_EST_MEM = 5;   // Cap: un proceso claude.exe real usa ~250-500MB (~1.6-3% en 16GB).
                         // Defensa en profundidad contra perfiles mal aprendidos — ver doc
                         // docs/pipeline/gate-predictivo.md
const PROFILE_STALE_HOURS = 24;

// Skills cuya infra reservada (emulador Android) debe restarse del baseline del gate.
// Razón: el emulador existe PORQUE estos skills lo necesitan; cobrarle su RAM al propio
// skill que lo consume es doble conteo y lleva a livelock (la baseline + el delta del
// agente nunca cierran bajo el umbral porque el emulador ya está presente en la baseline).
const QA_INFRA_SKILLS = new Set(['qa', 'security', 'tester']);

// Skills que DISPARAN el arranque del emulador en el pre-flight de fase `verificacion`.
// Sólo `qa` necesita realmente el AVD (tests E2E); `tester` y `security` son
// determinísticos (JVM tests, análisis estático) y no requieren emulador.
// Esta whitelist evita que el modo descanso levante el emulador innecesariamente
// cuando solo corren skills determinísticos en la ventana 22:00-07:00 ART.
// Ver issue #3140.
const SKILLS_THAT_NEED_EMULATOR = new Set(['qa']);

// Helper único para decidir si un (skill, fase) dispara `preflightQaChecks` y por
// extensión `requestEmulator`/`reboteVerificacionABuild`. Vive como función pura
// para tener una sola fuente de verdad — la condición se aplica en el preflight
// regular del bucle de lanzamiento y también en el deadlock breaker.
// Ver issue #3140 (whitelist explícita) y CA-4/CA-6 del PO.
function shouldRunQaPreflight(skill, fase) {
  return fase === 'verificacion' && SKILLS_THAT_NEED_EMULATOR.has(skill);
}

function getEstimatedImpact(profile) {
  const DEFAULT_CPU = 12;
  const DEFAULT_MEM = 3;  // Proceso claude.exe real ~ 250-500 MB en 16 GB

  if (!profile) return { cpu: DEFAULT_CPU, mem: DEFAULT_MEM };

  const samples = profile.samples || 0;
  const hoursOld = (Date.now() - new Date(profile.lastUpdated || 0).getTime()) / 3600000;

  // Cap absoluto: nunca estimar más que el máximo razonable
  let cpu = Math.min(profile.avgCpu, MAX_EST_CPU);
  let mem = Math.min(profile.avgMem, MAX_EST_MEM);

  // Blend hacia defaults si pocas muestras (confianza progresiva)
  if (samples < MIN_RELIABLE_SAMPLES) {
    const confidence = samples / MIN_RELIABLE_SAMPLES; // 0.0 a 1.0
    cpu = DEFAULT_CPU * (1 - confidence) + cpu * confidence;
    mem = DEFAULT_MEM * (1 - confidence) + mem * confidence;
  }

  // Decay si el profile es viejo (>24h sin actualizar)
  if (hoursOld > PROFILE_STALE_HOURS) {
    const decayFactor = Math.max(0.5, 1 - (hoursOld - PROFILE_STALE_HOURS) / 72); // decay gradual
    cpu = DEFAULT_CPU * (1 - decayFactor) + cpu * decayFactor;
    mem = DEFAULT_MEM * (1 - decayFactor) + mem * decayFactor;
  }

  return { cpu: Math.round(cpu * 10) / 10, mem: Math.round(mem * 10) / 10 };
}

/**
 * Lee la RAM ocupada por qemu-system-x86_64-headless.exe como porcentaje del total
 * del sistema. Cacheado por 5 segundos para no pagar un `tasklist` en cada llamada.
 * Devuelve 0 si el emulador no está corriendo o si la medición falla.
 */
let _emulatorMemCache = { ts: 0, percent: 0, running: false };
const EMULATOR_MEM_CACHE_MS = 5000;

function measureEmulatorMemPercent() {
  const now = Date.now();
  if (now - _emulatorMemCache.ts < EMULATOR_MEM_CACHE_MS) return _emulatorMemCache;

  let running = false;
  let percent = 0;
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    // Formato CSV: "qemu-system-x86_64-headless.exe","1234","Console","1","234,567 KB"
    const line = out.split('\n').find(l => l.toLowerCase().includes('qemu-system'));
    if (line) {
      running = true;
      const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
      const memKbStr = (cols[4] || '').replace(/[^\d]/g, '');
      const memKb = parseInt(memKbStr, 10);
      if (!isNaN(memKb) && memKb > 0) {
        const totalBytes = os.totalmem();
        const usedBytes = memKb * 1024;
        percent = Math.round((usedBytes / totalBytes) * 1000) / 10; // 1 decimal
      }
    }
  } catch { /* sin tasklist o sin qemu — degradar silencioso */ }

  _emulatorMemCache = { ts: now, percent, running };
  return _emulatorMemCache;
}

function predictResourceImpact(skill, config, ctx = {}) {
  const profiles = loadSkillProfiles();
  const profile = profiles[skill];
  const usage = getSystemResourceUsage();
  const limits = config.resource_limits || {};
  const maxCpu = limits.orange_max_percent || 80;
  const maxMem = limits.orange_max_percent || 80;

  const est = getEstimatedImpact(profile);

  // Reserva de infra del propio skill: si este skill es QA y el emulador está
  // corriendo, restarlo del baseline — su RAM es un costo de la ventana QA, no
  // del agente individual. Ver QA_INFRA_SKILLS arriba.
  let reservedMem = 0;
  let reservedReason = null;
  if (QA_INFRA_SKILLS.has(skill)) {
    const emu = ctx.emulator || measureEmulatorMemPercent();
    if (emu.running && emu.percent > 0) {
      reservedMem = emu.percent;
      reservedReason = `emulador ${emu.percent}%`;
    }
  }

  const effectiveMemBase = Math.max(0, usage.memPercent - reservedMem);
  const predictedCpu = usage.cpuPercent + est.cpu;
  const predictedMem = effectiveMemBase + est.mem;

  const cpuSafe = predictedCpu < maxCpu;
  const memSafe = predictedMem < maxMem;

  if (cpuSafe && memSafe) {
    return { safe: true, reason: null, predicted: { cpu: predictedCpu, mem: predictedMem }, reserved: reservedMem };
  }

  const reasons = [];
  if (!cpuSafe) reasons.push(`CPU ${usage.cpuPercent}% + ~${est.cpu}% = ${Math.round(predictedCpu)}% (max ${maxCpu}%)`);
  if (!memSafe) {
    const memDetail = reservedReason
      ? `MEM ${usage.memPercent}% − ${reservedReason} + ~${est.mem}% = ${Math.round(predictedMem)}% (max ${maxMem}%)`
      : `MEM ${usage.memPercent}% + ~${est.mem}% = ${Math.round(predictedMem)}% (max ${maxMem}%)`;
    reasons.push(memDetail);
  }

  return {
    safe: false,
    reason: reasons.join(' | '),
    predicted: { cpu: Math.round(predictedCpu), mem: Math.round(predictedMem) },
    reserved: reservedMem
  };
}

// --- Limpieza de Gradle daemons post-agente ---

/**
 * Limpieza de Gradle daemons — DESACTIVADA en ciclo automatico.
 * Ahora es no-op. La limpieza real se hace bajo demanda via limpiarDaemonsOnDemand().
 */
function killGradleDaemonsForCwd(cwd, label) {
  // No-op: el taskkill automatico fue eliminado por causar race conditions fatales
  return 0;
}

/**
 * Limpieza bajo demanda de daemons Gradle/Kotlin huerfanos.
 * Se invoca SOLO desde el comando /limpiar (via Telegram o skill).
 * Protege daemons de worktrees activos.
 * Retorna un resumen de lo que hizo.
 */
function limpiarDaemonsOnDemand() {
  const results = [];
  let totalKilled = 0;

  // Recolectar worktree paths de agentes activos para protegerlos
  const activeWorktreePaths = new Set();
  for (const [, info] of activeProcesses) {
    if (info.worktreePath) {
      activeWorktreePaths.add(info.worktreePath.replace(/\\/g, '/').toLowerCase());
    }
  }
  activeWorktreePaths.add(ROOT.replace(/\\/g, '/').toLowerCase());

  // 1. Buscar Gradle daemons
  try {
    const wmicOut = execSync(
      'wmic process get Name,ProcessId,ParentProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    for (const line of wmicOut.split('\n')) {
      if (!line.includes('java.exe')) continue;
      if (!line.includes('GradleDaemon') && !line.includes('gradle-launcher')) continue;
      const parts = line.split(',');
      const pid = parts[parts.length - 2]?.trim();
      if (!pid) continue;

      // Proteger por worktree activo
      const lineLower = line.replace(/\\/g, '/').toLowerCase();
      let isActive = false;
      for (const wtPath of activeWorktreePaths) {
        if (lineLower.includes(wtPath)) { isActive = true; break; }
      }
      if (isActive) {
        results.push('Gradle PID ' + pid + ' PROTEGIDO (worktree activo)');
        continue;
      }

      try {
        execSync('taskkill /PID ' + pid + ' /F /T', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        totalKilled++;
        results.push('Gradle PID ' + pid + ' eliminado');
      } catch {}
    }
  } catch (e) { results.push('Error buscando Gradle: ' + e.message); }

  // 2. Buscar Kotlin compile daemons
  try {
    const wmicOut2 = execSync(
      'wmic process get Name,ProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    for (const line of wmicOut2.split('\n')) {
      if (!line.includes('java.exe')) continue;
      if (!line.includes('kotlin-compiler') && !line.includes('KotlinCompileDaemon')) continue;
      const match = line.match(/,(\d+)\s*$/);
      if (!match) continue;

      const lineLower = line.replace(/\\/g, '/').toLowerCase();
      let isActive = false;
      for (const wtPath of activeWorktreePaths) {
        if (lineLower.includes(wtPath)) { isActive = true; break; }
      }
      if (isActive) {
        results.push('Kotlin PID ' + match[1] + ' PROTEGIDO (worktree activo)');
        continue;
      }

      try {
        execSync('taskkill /PID ' + match[1] + ' /F /T', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        totalKilled++;
        results.push('Kotlin PID ' + match[1] + ' eliminado');
      } catch {}
    }
  } catch (e) { results.push('Error buscando Kotlin: ' + e.message); }

  log('limpiar', 'Limpieza bajo demanda: ' + totalKilled + ' proceso(s) eliminados');
  return { totalKilled, results };
}

// --- Estado de procesos activos (PIDs lanzados por el Pulpo) ---

const activeProcesses = new Map(); // key: "skill:issue" → { pid, startTime }

// Cache en memoria del qaMode resuelto por el preflight para cada issue.
// Issue #2351 — R1: el `modo` que emite el agente en el YAML no es fuente de
// verdad (puede sobrescribirlo). La fuente de verdad es la clasificación del
// preflight (`preflightQaChecks`). Este cache vive mientras corre el pulpo;
// si se reinicia, caemos al YAML como fallback (comportamiento antiguo).
const qaModeByIssue = new Map(); // key: issueNumber → 'android' | 'api' | 'structural'

function processKey(skill, issue) { return `${skill}:${issue}`; }

function isProcessAlive(pid) {
  try {
    // En Windows, process.kill(pid, 0) no es confiable — usar tasklist
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process');
      const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true
      });
      return (result.stdout || '').includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function countRunningBySkill(skill) {
  // Contar archivos en trabajando/ de TODAS las fases — fuente de verdad real
  // No depender del Map de PIDs (se pierde al reiniciar)
  const config = loadConfig();
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (f.startsWith('.') || isMarkerArtifactPulpo(f)) continue;
          if (f.endsWith(`.${skill}`)) count++;
        }
      } catch {}
    }
  }
  return count;
}

/** Skills que cuentan como "desarrolladores" para el límite global */
const DEV_SKILLS = ['backend-dev', 'android-dev', 'web-dev'];

/** Contar total de devs corriendo en TODAS las fases de TODOS los pipelines */
function countRunningDevs() {
  const config = loadConfig();
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (f.startsWith('.') || isMarkerArtifactPulpo(f)) continue;
          const s = f.split('.').pop();
          if (DEV_SKILLS.includes(s)) count++;
        }
      } catch {}
    }
  }
  return count;
}

// --- Resource Monitor: CPU y Memoria del sistema ---

/** Snapshot de CPU para cálculo diferencial (os.cpus() da totales acumulados) */
let lastCpuSnapshot = null;

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Obtener uso de recursos del sistema.
 * CPU se calcula como delta entre dos snapshots (requiere al menos 2 ciclos).
 * Memoria usa os.freemem / os.totalmem.
 */
function getSystemResourceUsage() {
  // Memoria
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  // CPU (diferencial entre snapshots)
  const current = cpuSnapshot();
  let cpuPercent = 0;
  if (lastCpuSnapshot) {
    const idleDelta = current.idle - lastCpuSnapshot.idle;
    const totalDelta = current.total - lastCpuSnapshot.total;
    cpuPercent = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  }
  lastCpuSnapshot = current;

  return { cpuPercent, memPercent };
}

// =============================================================================
// SISTEMA DE PRESIÓN DE RECURSOS — Graduado (green/yellow/orange/red)
// En vez de binario "sobrecargado sí/no", responde proporcionalmente.
// =============================================================================

const PRESSURE_LEVELS = { GREEN: 'green', YELLOW: 'yellow', ORANGE: 'orange', RED: 'red' };
let lastResourceLog = 0;
let lastPressureLevel = PRESSURE_LEVELS.GREEN;
let lastEmergencyTelegramTs = 0;       // Cooldown para NO spamear Telegram en RED
let consecutiveRedCycles = 0;           // Cuántos ciclos seguidos en RED (solo para logging)

// --- Deadlock breaker: detecta cuando TODOS los candidatos son bloqueados por el gate predictivo ---
let consecutiveAllBlockedCycles = 0;    // Ciclos consecutivos donde el gate bloqueó TODO
let lastDeadlockTelegramTs = 0;
const DEADLOCK_TELEGRAM_COOLDOWN = 600000; // 10 min entre notificaciones de deadlock
const DEADLOCK_TIER1_CYCLES = 3;        // ~1.5 min: intentar liberar emulador idle
const DEADLOCK_TIER2_CYCLES = 6;        // ~3 min: forzar lanzamiento del más liviano
const EMERGENCY_TELEGRAM_COOLDOWN = 300000; // 5 minutos entre mensajes de RED
let proactiveCycleCounter = 0;

/**
 * Determinar el nivel de presión del sistema basado en CPU y RAM.
 * Retorna { level, cpuPercent, memPercent, maxOfBoth }
 */
function getResourcePressure(config) {
  const limits = config.resource_limits || {};
  const greenMax  = limits.green_max_percent  || 50;
  const yellowMax = limits.yellow_max_percent || 65;
  const orangeMax = limits.orange_max_percent || 80;
  // red = todo lo que esté por encima de orange

  const { cpuPercent, memPercent } = getSystemResourceUsage();
  const maxOfBoth = Math.max(cpuPercent, memPercent);

  let level;
  if (maxOfBoth < greenMax)       level = PRESSURE_LEVELS.GREEN;
  else if (maxOfBoth < yellowMax) level = PRESSURE_LEVELS.YELLOW;
  else if (maxOfBoth < orangeMax) level = PRESSURE_LEVELS.ORANGE;
  else                            level = PRESSURE_LEVELS.RED;

  return { level, cpuPercent, memPercent, maxOfBoth };
}

/**
 * Obtener el multiplicador de concurrencia según la presión.
 * GREEN=1.0, YELLOW=0.5, ORANGE=solo 1 agente, RED=0
 */
function concurrencyMultiplier(level) {
  switch (level) {
    case PRESSURE_LEVELS.GREEN:  return 1.0;
    case PRESSURE_LEVELS.YELLOW: return 0.5;
    case PRESSURE_LEVELS.ORANGE: return 0;   // Se maneja especial: max 1 total
    case PRESSURE_LEVELS.RED:    return 0;
    default: return 1.0;
  }
}

/**
 * Verificar si el sistema permite lanzar un nuevo agente.
 * Reemplaza isSystemOverloaded() con lógica graduada:
 * - GREEN: todo OK, capacidad completa
 * - YELLOW: limpieza suave + concurrencia reducida al 50%
 * - ORANGE: limpieza agresiva + máximo 1 agente total
 * - RED: bloqueo total + kill de emergencia
 */
function isSystemOverloaded(config) {
  const pressure = getResourcePressure(config);
  const { level, cpuPercent, memPercent } = pressure;

  // Transición de nivel → logear y actuar
  const levelChanged = level !== lastPressureLevel;
  if (levelChanged) {
    const emoji = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' }[level];
    log('recursos', `${emoji} Presión cambió: ${lastPressureLevel} → ${level} — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
    lastPressureLevel = level;
  }

  // Acciones según nivel
  if (level === PRESSURE_LEVELS.GREEN) {
    consecutiveRedCycles = 0; // Reset si bajamos a green
    // Loguear cada 60s
    const now = Date.now();
    if (now - lastResourceLog > 60000) {
      log('recursos', `🟢 OK — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
      lastResourceLog = now;
    }
    return false;
  }

  if (level === PRESSURE_LEVELS.YELLOW) {
    consecutiveRedCycles = 0; // Reset si bajamos a yellow
    // Limpieza suave: solo Gradle daemons huérfanos
    const { freed, killed } = tryFreeResources('soft');
    if (freed) log('recursos', `🟡 Limpieza suave: ${killed.join(', ')}`);
    // Re-evaluar — si bajó a green, permitir
    const after = getResourcePressure(config);
    if (after.level === PRESSURE_LEVELS.GREEN) return false;
    // Yellow permite lanzar pero con concurrencia reducida (se aplica en brazoLanzamiento)
    log('recursos', `🟡 YELLOW — CPU: ${cpuPercent}% | RAM: ${memPercent}% — concurrencia reducida`);
    lastResourceLog = Date.now();
    return false; // No bloquea, pero brazoLanzamiento reduce slots
  }

  if (level === PRESSURE_LEVELS.ORANGE) {
    consecutiveRedCycles = 0; // Reset si bajamos a orange
    // Diagnóstico: ¿qué está consumiendo?
    if (config.resource_limits?.diagnostic_on_orange !== false) {
      logTopConsumers();
    }
    // Limpieza agresiva: daemons + kotlin daemons
    const { freed, killed } = tryFreeResources('aggressive');
    if (freed) {
      log('recursos', `🟠 Limpieza agresiva: ${killed.join(', ')}`);
      // Re-evaluar
      const after = getResourcePressure(config);
      if (after.level === PRESSURE_LEVELS.GREEN || after.level === PRESSURE_LEVELS.YELLOW) {
        return false;
      }
    }
    // Orange: permitir solo si hay menos de 1 agente total
    const totalRunning = countTotalRunningAgents(config);
    if (totalRunning >= 1) {
      log('recursos', `🟠 ORANGE — ${totalRunning} agente(s) corriendo, bloqueando nuevos — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
      lastResourceLog = Date.now();
      return true;
    }
    return false; // Dejar pasar 1 agente
  }

  // RED: bloqueo total + limpieza de daemons (SIN kill de agentes/procesos Claude)
  // Estrategia: solo limpiar Gradle/Kotlin huérfanos y esperar a que los procesos
  // terminen naturalmente. NUNCA matar agentes ni builds en curso.
  consecutiveRedCycles++;

  // Limpieza agresiva de daemons (NO mata procesos Claude — solo Gradle/Kotlin sin worktree)
  const { freed, killed } = tryFreeResources('aggressive');
  if (freed) {
    log('recursos', `🔴 Limpieza de daemons en RED: ${killed.join(', ')}`);
  }

  // Loguear cada 60s
  const now = Date.now();
  if (now - lastResourceLog > 60000) {
    log('recursos', `🔴 RED — BLOQUEADO (ciclo ${consecutiveRedCycles}) — CPU: ${cpuPercent}% | RAM: ${memPercent}% — esperando que procesos terminen`);
    lastResourceLog = now;
  }

  // Notificar por Telegram UNA vez cada 5 minutos
  if (now - lastEmergencyTelegramTs > EMERGENCY_TELEGRAM_COOLDOWN) {
    logTopConsumers();
    sendTelegram(`🔴 Recursos críticos — CPU: ${cpuPercent}% | RAM: ${memPercent}% — bloqueando nuevos lanzamientos, esperando que los activos terminen (sin kill de emergencia)`);
    lastEmergencyTelegramTs = now;
  }

  // Re-evaluar por si la limpieza de daemons bajó la presión
  if (freed) {
    const after = getResourcePressure(config);
    if (after.level !== PRESSURE_LEVELS.RED) {
      return isSystemOverloaded(config);
    }
  }

  return true;
}

/**
 * Contar total de agentes corriendo en todas las fases (filesystem = fuente de verdad)
 */
function countTotalRunningAgents(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (f.startsWith('.') || isMarkerArtifactPulpo(f)) continue;
          count++;
        }
      } catch {}
    }
  }
  return count;
}

// =============================================================================
// GATE DE EVIDENCIA QA — Validación automática de evidencia antes de promover
// Si QA dice "aprobado" pero no hay video real con audio, se fuerza rechazo.
// =============================================================================

const QA_VIDEO_MIN_SIZE_BYTES = 51200;  // 50KB — swiftshader genera mp4s de ~150-200KB; antes usábamos 200KB y rechazaba falsamente.
const QA_MIN_FRAME_PNGS = 3;             // Mínimo de frames PNG del agente QA para considerar evidencia alternativa válida.

/**
 * Validar que el resultado del QA tiene evidencia real.
 * Retorna array de problemas encontrados (vacío = OK).
 *
 * Política: aceptar como evidencia válida CUALQUIERA de estas:
 *   a) Un .mp4 en qa/evidence/{issue}/ o qa/recordings/ con tamaño ≥ 50KB.
 *   b) Al menos N frames PNG del agente en qa/evidence/{issue}/ (fallback cuando
 *      el screenrecord del emulador queda chico por swiftshader).
 * El campo `video_size_kb` del YAML es solo informativo; si el archivo en disco
 * cumple el umbral, se acepta.
 */
function validateQaEvidence(issue, qaData, authoritativeQaMode = null) {
  // El preflight clasifica cada issue en uno de tres modos (qaMode):
  //   - 'android'    → requiere emulador + APK → debe haber video/frames
  //   - 'api'        → testing via HTTP, sin UI → no produce video
  //   - 'structural' → validación syntax+tests → no produce video
  //
  // R1 (auditoría seguridad #2351): NUNCA inferimos el modo por ausencia de
  // labels `app:*`. Exigimos whitelist explícita: sólo 'api' o 'structural'
  // saltean la evidencia. El modo autoritativo viene del preflight del Pulpo
  // (parámetro `authoritativeQaMode`); si falta, caemos al YAML del agente
  // como fallback defensivo. Un agente QA no puede bypassear el gate
  // inventando un `modo` falso si el preflight ya determinó 'android'.
  //
  // R3 (CA-3): cada bypass emite un log estructurado para auditoría.
  const resolution = qaEvidenceGate.resolveQaMode({
    authoritative: authoritativeQaMode,
    yamlMode: qaData && qaData.modo,
  });
  if (qaEvidenceGate.shouldSkipVisualEvidence(resolution.mode)) {
    const evt = qaEvidenceGate.buildBypassEvent({
      issue,
      qaMode: resolution.mode,
      source: resolution.source,
      labels: Array.isArray(qaData && qaData.labels) ? qaData.labels : [],
    });
    log('gate-bypass', qaEvidenceGate.formatBypassLogLine(evt));
    return [];
  }

  const ROOT = path.resolve(PIPELINE, '..');
  const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
  const recordingsDir = path.join(ROOT, 'qa', 'recordings');

  let bestVideoKb = 0;
  let pngFrames = 0;

  for (const dir of [evidenceDir, recordingsDir]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        if (f.endsWith('.mp4') && stat.size > bestVideoKb * 1024) {
          bestVideoKb = Math.round(stat.size / 1024);
        } else if (f.endsWith('.png') && dir === evidenceDir && /qa-|frame|nav-/i.test(f)) {
          pngFrames++;
        }
      }
    } catch { /* dir no existe */ }
  }

  const videoOk = bestVideoKb * 1024 >= QA_VIDEO_MIN_SIZE_BYTES;
  const framesOk = pngFrames >= QA_MIN_FRAME_PNGS;

  if (videoOk || framesOk) return [];

  const issues = [];
  if (bestVideoKb > 0) {
    issues.push(`video más grande encontrado es ${bestVideoKb}KB (<${Math.round(QA_VIDEO_MIN_SIZE_BYTES/1024)}KB) y solo ${pngFrames} frame(s) PNG (mínimo ${QA_MIN_FRAME_PNGS})`);
  } else {
    issues.push(`sin evidencia: no hay .mp4 en qa/evidence/${issue}/ ni qa/recordings/, ni frames PNG suficientes (${pngFrames}/${QA_MIN_FRAME_PNGS})`);
  }
  return issues;
}

// =============================================================================
// QA PRIORITY WINDOW — Cuando se acumulan issues de verificación sin poder correr,
// bloquea nuevos lanzamientos dev para liberar recursos y dar prioridad a QA.
// Puntos 1-3 de la propuesta conversada con Leo (2026-04-02).
// =============================================================================

let qaPriorityActive = false;
let qaPriorityActivatedAt = 0;
let qaFirstBlockedAt = 0;           // Momento en que se detectó acumulación QA sin poder lanzar
let qaPriorityNotifiedTelegram = false;
let qaPriorityManual = false;       // true si fue activada manualmente desde el dashboard
let qaPrioritySafetyNotified = false; // true si ya se envió notificación de safety timeout
// #2651 — cierre por no-progreso + cooldown.
// Cuando la ventana queda abierta y nadie corre, marca timestamp.
// Si pasan N min sin que arranque ningún agente QA → cierra y arma cooldown
// para que la cola pendiente no la reabra inmediatamente (loop infinito).
let qaNoProgressSince = 0;          // Primer tick con runningQa=0 y ventana abierta. 0 si arrancó alguien.
let qaCooldownUntil = 0;            // Timestamp hasta el cual no se reabre por cola pendiente.

// =============================================================================
// BUILD PRIORITY WINDOW — Protección de builds contra kill de emergencia y
// priorización de recursos cuando hay builds en cola.
// Cuando se acumulan issues esperando build, el Pulpo bloquea nuevos
// lanzamientos dev para liberar recursos y dar prioridad al build.
// =============================================================================
let buildPriorityActive = false;
let buildPriorityActivatedAt = 0;
let buildFirstBlockedAt = 0;
let buildPriorityNotifiedTelegram = false;
let buildPriorityManual = false;    // true si fue activada manualmente desde el dashboard
let buildPrioritySafetyNotified = false; // true si ya se envió notificación de safety timeout

const PRIORITY_WINDOWS_FILE = path.join(PIPELINE, 'priority-windows.json');

/**
 * Restaurar el estado de priority windows desde disco al iniciar.
 * Sin esto, un restart del pulpo pierde la ventana activa y lanza dev
 * aunque QA/Build estuviera bloqueando.
 */
function restorePriorityWindows() {
  try {
    if (!fs.existsSync(PRIORITY_WINDOWS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PRIORITY_WINDOWS_FILE, 'utf8'));
    if (data.qa?.active) {
      qaPriorityActive = true;
      qaPriorityActivatedAt = data.qa.activatedAt || Date.now();
      qaPriorityManual = data.qa.manual || false;
      qaPriorityNotifiedTelegram = true; // Ya se notificó antes del restart
      log('qa-priority', `♻️ QA Priority Window restaurada desde disco (activada ${new Date(qaPriorityActivatedAt).toISOString()})`);
    }
    // #2651 — restaurar cooldown si está vigente; si ya venció, ignorar.
    if (data.qa?.cooldownUntil && data.qa.cooldownUntil > Date.now()) {
      qaCooldownUntil = data.qa.cooldownUntil;
      log('qa-priority', `♻️ QA cooldown restaurado: vigente hasta ${new Date(qaCooldownUntil).toISOString()}`);
    }
    if (data.build?.active) {
      buildPriorityActive = true;
      buildPriorityActivatedAt = data.build.activatedAt || Date.now();
      buildPriorityManual = data.build.manual || false;
      buildPriorityNotifiedTelegram = true;
      log('build-priority', `♻️ Build Priority Window restaurada desde disco (activada ${new Date(buildPriorityActivatedAt).toISOString()})`);
    }
  } catch (e) {
    log('priority', `⚠️ Error restaurando priority windows: ${e.message}`);
  }
}

// Restaurar al cargar el módulo
restorePriorityWindows();

/**
 * Persistir el estado actual de las priority windows a disco.
 * El dashboard lee este archivo para mostrar estado y el usuario puede
 * activar/desactivar ventanas manualmente escribiendo en él.
 */
function persistPriorityWindows() {
  const state = {
    qa: {
      active: qaPriorityActive,
      activatedAt: qaPriorityActivatedAt || null,
      manual: qaPriorityManual,
      cooldownUntil: qaCooldownUntil || null
    },
    build: {
      active: buildPriorityActive,
      activatedAt: buildPriorityActivatedAt || null,
      manual: buildPriorityManual
    },
    updatedAt: Date.now()
  };
  try { fs.writeFileSync(PRIORITY_WINDOWS_FILE, JSON.stringify(state, null, 2)); } catch {}
}

/**
 * Leer activaciones/desactivaciones manuales desde el archivo.
 * El dashboard escribe { qa: { manualOverride: true/false }, build: { manualOverride: true/false } }
 * y el Pulpo las consume acá.
 */
function readManualPriorityOverrides() {
  try {
    const data = JSON.parse(fs.readFileSync(PRIORITY_WINDOWS_FILE, 'utf8'));

    // QA manual override — al activar manual, AUTOEXCLUIR Build (las ventanas son
    // mutuamente exclusivas; QA > Build > Dev). Sin esto quedaban las dos activas
    // a la vez cuando se activaba una manualmente y la otra cruzaba el umbral.
    if (data.qa?.manualOverride === true && !qaPriorityActive) {
      qaPriorityActive = true;
      qaPriorityManual = true;
      qaPriorityActivatedAt = Date.now();
      qaPriorityNotifiedTelegram = false;
      log('qa-priority', '🔧 QA Priority Window ACTIVADA MANUALMENTE desde dashboard');
      sendTelegram('🔧 QA Priority Window activada manualmente desde el dashboard. Dev y build bloqueados hasta desactivación.');
      // Autoexcluir Build (incluso si era manual — el último override gana)
      if (buildPriorityActive) {
        log('build-priority', '🔄 Build Priority desactivada por activación manual de QA (autoexcluyentes)');
        buildPriorityActive = false;
        buildPriorityManual = false;
        buildPriorityActivatedAt = 0;
        buildFirstBlockedAt = 0;
        buildPriorityNotifiedTelegram = false;
        buildPrioritySafetyNotified = false;
      }
      persistPriorityWindows();
    } else if (data.qa?.manualOverride === false && qaPriorityActive) {
      qaPriorityActive = false;
      qaPriorityManual = false;
      qaPriorityActivatedAt = 0;
      qaFirstBlockedAt = 0;
      log('qa-priority', '🔧 QA Priority Window DESACTIVADA MANUALMENTE desde dashboard');
      persistPriorityWindows();
    }

    // Build manual override — autoexclusión simétrica con QA
    if (data.build?.manualOverride === true && !buildPriorityActive) {
      buildPriorityActive = true;
      buildPriorityManual = true;
      buildPriorityActivatedAt = Date.now();
      buildPriorityNotifiedTelegram = false;
      log('build-priority', '🔧 Build Priority Window ACTIVADA MANUALMENTE desde dashboard');
      sendTelegram('🔧 Build Priority Window activada manualmente desde el dashboard. Dev bloqueado hasta desactivación.');
      // Autoexcluir QA (incluso si era manual — el último override gana)
      if (qaPriorityActive) {
        log('qa-priority', '🔄 QA Priority desactivada por activación manual de Build (autoexcluyentes)');
        qaPriorityActive = false;
        qaPriorityManual = false;
        qaPriorityActivatedAt = 0;
        qaFirstBlockedAt = 0;
        qaPriorityNotifiedTelegram = false;
        qaPrioritySafetyNotified = false;
      }
      persistPriorityWindows();
    } else if (data.build?.manualOverride === false && buildPriorityActive) {
      buildPriorityActive = false;
      buildPriorityManual = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      log('build-priority', '🔧 Build Priority Window DESACTIVADA MANUALMENTE desde dashboard');
      persistPriorityWindows();
    }

    // Limpiar overrides consumidos
    if (data.qa?.manualOverride !== undefined || data.build?.manualOverride !== undefined) {
      delete data.qa?.manualOverride;
      delete data.build?.manualOverride;
      fs.writeFileSync(PRIORITY_WINDOWS_FILE, JSON.stringify(data, null, 2));
    }
  } catch {}
}

/**
 * Contar issues pendientes en fase verificación (todas las pipelines).
 *
 * En modo `partial_pause`, filtra los issues fuera del allowlist: la cola
 * "lógica" excluye lo que la pausa parcial nunca va a dejar lanzar (#2957).
 * Acepta `pipelineState` por override para tests.
 */
function countPendingVerificacion(config, overrides = {}) {
  const state = overrides.pipelineState || partialPause.getPipelineMode();
  const filterByAllowlist = state && state.mode === 'partial_pause';
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('verificacion')) continue;
    const pendDir = path.join(PIPELINE, pName, 'verificacion', 'pendiente');
    const files = listWorkFiles(pendDir);
    for (const f of files) {
      const issue = issueFromFile(f.name);
      if (filterByAllowlist && !partialPause.isIssueAllowedInState(issue, state)) continue;
      const labels = getIssueLabels(issue);
      if (!labels.includes('blocked:dependencies')) count++;
    }
  }
  return count;
}

/**
 * Contar agentes de verificación actualmente corriendo (tokens en trabajando/).
 */
function countRunningVerificacion(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('verificacion')) continue;
    const trabajandoDir = path.join(PIPELINE, pName, 'verificacion', 'trabajando');
    count += listWorkFiles(trabajandoDir).length;
  }
  return count;
}

/**
 * Detectar si hay agentes de dev corriendo (archivos en trabajando/ de fase dev).
 */
function countRunningDev(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('dev')) continue;
    const trabajandoDir = path.join(PIPELINE, pName, 'dev', 'trabajando');
    count += listWorkFiles(trabajandoDir).length;
  }
  return count;
}

/**
 * Evaluar si debe activarse/desactivarse la QA Priority Window.
 * Modelo V2 #2651 — balance entre cola y agentes:
 * - Activación: cola pendiente ≥ umbral (la cola dispara la ventana, igual que Build).
 * - Cierre normal: cola pendiente = 0 y runningQa = 0 → vaciaje completo.
 * - Cierre por no-progreso: ventana activa con runningQa = 0 sostenido N min → cierre + cooldown.
 *   (Significa que el sistema no logra arrancar agentes QA — rate limit, slot lleno, etc.
 *   Mantener la ventana abierta penaliza otras fases sin aporte.)
 * - Cooldown post-cierre: tras cierre por no-progreso, durante M min no se reabre por cola.
 *   Si llega un evento nuevo (runningQa pasa a ≥1 por otra vía), se cancela el cooldown.
 * - Pulpo en paused/partial_pause: cierre inmediato, sin cooldown.
 * - Safety timeout: notifica por Telegram si lleva muchas horas sin completar (no cierra).
 * Retorna true si QA Priority está activa (dev y build deben bloquearse).
 */
function evaluateQaPriority(config, overrides = {}) {
  const limits = config.resource_limits || {};
  const threshold = limits.priority_windows_activation_threshold || 3;
  const safetyTimeoutHours = limits.priority_windows_safety_timeout_hours || 2;
  const noProgressMs = (limits.qa_priority_no_progress_minutes || 3) * 60 * 1000;
  const cooldownMs = (limits.qa_priority_cooldown_minutes || 15) * 60 * 1000;
  const now = overrides.now !== undefined ? overrides.now : Date.now();

  const pipelineMode = overrides.pipelineMode || partialPause.getPipelineMode().mode;
  if (pipelineMode === 'paused' || pipelineMode === 'partial_pause') {
    if (qaPriorityActive) {
      log('qa-priority', `🟢 QA Priority Window desactivada — pipeline en modo ${pipelineMode}`);
      qaPriorityActive = false;
      qaPriorityActivatedAt = 0;
      qaFirstBlockedAt = 0;
      qaPriorityManual = false;
      qaPriorityNotifiedTelegram = false;
      qaPrioritySafetyNotified = false;
      qaNoProgressSince = 0;
      // No tocamos cooldown: si la pausa se reanuda y la cola sigue, respetamos cooldown previo.
      persistPriorityWindows();
    }
    return false;
  }

  const runningQa = overrides.runningQa !== undefined ? overrides.runningQa : countRunningVerificacion(config);
  const pendingQa = overrides.pendingQa !== undefined ? overrides.pendingQa : countPendingVerificacion(config);

  // Si hay agentes corriendo, cancelar cooldown anticipado: el sistema está sano.
  if (runningQa >= 1 && qaCooldownUntil > 0) {
    log('qa-priority', `✅ QA cooldown cancelado — ${runningQa} agente(s) arrancaron por otra vía`);
    qaCooldownUntil = 0;
    persistPriorityWindows();
  }

  // ---- Ventana activa: evaluar cierre ----
  if (qaPriorityActive) {
    // Cierre normal: cola y running en cero (verificación completada).
    if (!qaPriorityManual && runningQa === 0 && pendingQa === 0) {
      log('qa-priority', '🟢 QA Priority Window desactivada — sin agentes de verificación corriendo ni pendientes');
      if (qaPriorityNotifiedTelegram) {
        sendTelegram('✅ QA Priority Window terminó — verificación completada. Pipeline en modo normal.');
      }
      qaPriorityActive = false;
      qaPriorityActivatedAt = 0;
      qaFirstBlockedAt = 0;
      qaPriorityNotifiedTelegram = false;
      qaNoProgressSince = 0;
      persistPriorityWindows();
      return false;
    }

    // Cierre por no-progreso: 0 corriendo durante > N min con cola pendiente.
    // Sólo aplica cuando NO es manual (manual la mantiene siempre).
    if (!qaPriorityManual && runningQa === 0 && pendingQa > 0) {
      if (qaNoProgressSince === 0) {
        qaNoProgressSince = now;
        log('qa-priority', `⏳ Sin agentes QA corriendo (${pendingQa} pendientes) — arrancando ventana de no-progreso (${noProgressMs / 60000}min)`);
      } else if (now - qaNoProgressSince >= noProgressMs) {
        const elapsedMin = Math.round((now - qaNoProgressSince) / 60000);
        qaCooldownUntil = now + cooldownMs;
        log('qa-priority', `🟡 QA Priority Window cerrada por no-progreso (${elapsedMin}min sin agentes corriendo). Cooldown ${cooldownMs / 60000}min hasta ${new Date(qaCooldownUntil).toISOString()}.`);
        sendTelegram(`⚠️ Ventana QA cerrada por inactividad (${elapsedMin}min sin agentes corriendo, ${pendingQa} pendientes). Cooldown ${cooldownMs / 60000}min — revisar si hay rate limits o slots bloqueados.`);
        qaPriorityActive = false;
        qaPriorityActivatedAt = 0;
        qaFirstBlockedAt = 0;
        qaPriorityNotifiedTelegram = false;
        qaNoProgressSince = 0;
        persistPriorityWindows();
        return false;
      }
    } else if (runningQa >= 1 && qaNoProgressSince !== 0) {
      // Volvió a haber agentes corriendo → reset de la ventana de no-progreso.
      qaNoProgressSince = 0;
    }

    // Timeout de seguridad: notificar si lleva mucho sin completar (pero NO cerrar)
    const elapsedHours = (now - qaPriorityActivatedAt) / (3600 * 1000);
    if (elapsedHours >= safetyTimeoutHours && !qaPrioritySafetyNotified) {
      qaPrioritySafetyNotified = true;
      log('qa-priority', `⚠️ QA Priority Window lleva ${Math.round(elapsedHours)}h activa sin completar — notificando`);
      sendTelegram(`⚠️ QA Priority Window lleva ${Math.round(elapsedHours)}h activa con ${runningQa} corriendo y ${pendingQa} pendientes. Verificá desde el dashboard si hay un problema.`);
    }
    return true;
  }

  // ---- Ventana inactiva: evaluar activación ----
  // Cooldown vigente: no reabrir por cola pendiente (evita loop abrir/cerrar).
  if (qaCooldownUntil > now) {
    if (pendingQa >= threshold) {
      const remainingMin = Math.ceil((qaCooldownUntil - now) / 60000);
      log('qa-priority', `🧊 QA cooldown activo (${remainingMin}min restantes) — cola ${pendingQa} ≥ ${threshold} pero NO se reabre`);
    }
    return false;
  }
  // Cooldown vencido: limpiar timestamp.
  if (qaCooldownUntil > 0 && qaCooldownUntil <= now) {
    log('qa-priority', `🧊 QA cooldown vencido — listo para reactivar si cola lo requiere`);
    qaCooldownUntil = 0;
    persistPriorityWindows();
  }

  // Activación: cola pendiente ≥ umbral (igual que Build).
  if (pendingQa >= threshold) {
    if (buildPriorityActive && buildPriorityManual) {
      if (qaFirstBlockedAt === 0) {
        qaFirstBlockedAt = now;
        log('qa-priority', `⏳ QA Priority en espera (cola ${pendingQa} ≥ ${threshold}) — Build manual activa, autoexcluyentes`);
      }
      return false;
    }
    if (buildPriorityActive && !buildPriorityManual) {
      log('qa-priority', `🔄 QA Priority desplaza Build Priority (QA > Build) — cola QA ${pendingQa} ≥ ${threshold}`);
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
    }
    qaPriorityActive = true;
    qaPriorityActivatedAt = now;
    qaPriorityNotifiedTelegram = true;
    qaPrioritySafetyNotified = false;
    qaNoProgressSince = runningQa === 0 ? now : 0;
    log('qa-priority', `🚨 QA PRIORITY WINDOW ACTIVADA — cola ${pendingQa} ≥ ${threshold} (umbral). Bloqueando dev y build.`);
    sendTelegram(`🚨 QA Priority Window activada — ${pendingQa} issue(s) de verificación pendientes (umbral ${threshold}). Dev y build bloqueados hasta drenar cola.`);
    persistPriorityWindows();
    return true;
  } else {
    if (qaFirstBlockedAt !== 0) {
      log('qa-priority', `✅ Cola QA por debajo del umbral — modo normal`);
      qaFirstBlockedAt = 0;
    }
  }

  return false;
}

/**
 * Contar issues pendientes en fase build (todas las pipelines).
 *
 * En modo `partial_pause`, filtra los issues fuera del allowlist (#2957).
 * Acepta `pipelineState` por override para tests.
 */
function countPendingBuild(config, overrides = {}) {
  const state = overrides.pipelineState || partialPause.getPipelineMode();
  const filterByAllowlist = state && state.mode === 'partial_pause';
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('build')) continue;
    const pendDir = path.join(PIPELINE, pName, 'build', 'pendiente');
    const files = listWorkFiles(pendDir);
    for (const f of files) {
      const issue = issueFromFile(f.name);
      if (filterByAllowlist && !partialPause.isIssueAllowedInState(issue, state)) continue;
      const labels = getIssueLabels(issue);
      if (!labels.includes('blocked:dependencies')) count++;
    }
  }
  return count;
}

/**
 * Contar builds actualmente en ejecución (archivos en trabajando/ de fase build).
 */
function countRunningBuild(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('build')) continue;
    const trabajandoDir = path.join(PIPELINE, pName, 'build', 'trabajando');
    count += listWorkFiles(trabajandoDir).length;
  }
  return count;
}

/**
 * Evaluar si debe activarse/desactivarse la Build Priority Window.
 * Modelo V2: ventanas autoexcluyentes, QA > Build > Dev.
 * - Activación inmediata cuando cola >= umbral configurable
 * - Sin timeout fijo (corre hasta vaciar cola)
 * - NO se activa si QA Priority ya está activa (QA > Build)
 * Retorna true si Build Priority está activa (dev debe bloquearse).
 */
function evaluateBuildPriority(config) {
  const limits = config.resource_limits || {};
  const threshold = limits.priority_windows_activation_threshold || 3;
  const safetyTimeoutHours = limits.priority_windows_safety_timeout_hours || 2;
  const now = Date.now();

  // Diseño: las ventanas no tienen sentido cuando el pipeline está
  // detenido (`paused`) o restringido a una allowlist (`partial_pause`).
  const pipelineMode = partialPause.getPipelineMode().mode;
  if (pipelineMode === 'paused' || pipelineMode === 'partial_pause') {
    if (buildPriorityActive) {
      log('build-priority', `🟢 Build Priority Window desactivada — pipeline en modo ${pipelineMode}`);
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityManual = false;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
      persistPriorityWindows();
    }
    return false;
  }

  const pendingBuild = countPendingBuild(config);
  const runningBuild = countRunningBuild(config);

  // ---- Desactivación ----
  if (buildPriorityActive) {
    // Si QA Priority se activó, Build cede (QA > Build) — excepto si fue manual
    if (qaPriorityActive && !buildPriorityManual) {
      log('build-priority', '🔄 Build Priority cede ante QA Priority (QA > Build)');
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
      persistPriorityWindows();
      return false;
    }
    // Si fue activada manualmente, solo desactivar por override manual (no por cola vacía)
    if (!buildPriorityManual && pendingBuild === 0 && runningBuild === 0) {
      log('build-priority', '🟢 Build Priority Window desactivada — cola de build vacía');
      if (buildPriorityNotifiedTelegram) {
        sendTelegram('✅ Build Priority Window terminó — builds completados. Pipeline en modo normal.');
      }
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
      persistPriorityWindows();
      return false;
    }
    // Timeout de seguridad: notificar si lleva mucho sin completar (pero NO cerrar)
    const elapsedHours = (now - buildPriorityActivatedAt) / (3600 * 1000);
    if (elapsedHours >= safetyTimeoutHours && !buildPrioritySafetyNotified) {
      buildPrioritySafetyNotified = true;
      log('build-priority', `⚠️ Build Priority Window lleva ${Math.round(elapsedHours)}h activa sin completar — notificando`);
      sendTelegram(`⚠️ Build Priority Window lleva ${Math.round(elapsedHours)}h activa con ${pendingBuild} builds pendientes. Verificá desde el dashboard.`);
    }
    return true; // Sigue activa — sin timeout fijo
  }

  // ---- Activación ----
  // NO activar si QA Priority ya está activa (QA > Build, autoexcluyentes)
  if (qaPriorityActive) return false;

  // Activación inmediata cuando cola >= umbral
  if (pendingBuild >= threshold) {
    buildPriorityActive = true;
    buildPriorityActivatedAt = now;
    buildPriorityNotifiedTelegram = true;
    buildPrioritySafetyNotified = false;
    log('build-priority', `🔨 BUILD PRIORITY WINDOW ACTIVADA — ${pendingBuild} issues esperando build (umbral: ${threshold}). Bloqueando dev.`);
    sendTelegram(`🔨 Build Priority Window activada — ${pendingBuild} issues esperando build (umbral: ${threshold}). Dev bloqueado hasta vaciar cola.`);
    persistPriorityWindows();
    return true;
  } else {
    if (buildFirstBlockedAt !== 0) {
      log('build-priority', `✅ Cola build bajó a ${pendingBuild} (< ${threshold}) — modo normal`);
      buildFirstBlockedAt = 0;
    }
  }

  return false;
}

/**
 * Logear los top 5 procesos por consumo de RAM.
 * Esto ayuda a diagnosticar QUÉ está consumiendo antes de actuar a ciegas.
 */
function logTopConsumers() {
  try {
    const wmicOut = execSync(
      'wmic process get Name,ProcessId,WorkingSetSize /FORMAT:CSV',
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const processes = [];
    for (const line of wmicOut.split('\n')) {
      const parts = line.trim().split(',');
      if (parts.length < 4) continue;
      const name = parts[1];
      const pid = parts[2];
      const memBytes = parseInt(parts[3], 10);
      if (!name || !memBytes || isNaN(memBytes)) continue;
      processes.push({ name, pid, memMB: Math.round(memBytes / 1048576) });
    }
    processes.sort((a, b) => b.memMB - a.memMB);
    const top5 = processes.slice(0, 5);
    const lines = top5.map((p, i) => `  ${i + 1}. ${p.name} (PID ${p.pid}): ${p.memMB}MB`);
    log('diagnostico', `Top 5 procesos por RAM:\n${lines.join('\n')}`);
  } catch (e) {
    log('diagnostico', `Error obteniendo top consumers: ${e.message}`);
  }
}

/**
 * Liberar recursos: solo limpieza del mapa interno de activeProcesses.
 * El taskkill de Gradle/Kotlin daemons fue ELIMINADO del ciclo automatico.
 * Motivo: bajo carga alta, las heuristicas (wmic, worktree path, PID tree) fallan
 * y matan builds/agentes legitimos, causando loops infinitos de rebotes.
 * La limpieza de daemons ahora es SOLO bajo demanda via comando /limpiar.
 */
function tryFreeResources(mode = 'soft') {
  const killed = [];

  try {
    // Limpieza de agentes stale del mapa interno (no mata procesos)
    let staleAgents = 0;
    for (const [key, info] of activeProcesses) {
      // Grace period: nunca limpiar agentes registrados hace menos de 30 min
      const ageMs = Date.now() - (info.startTime || 0);
      if (ageMs < 30 * 60 * 1000) continue;
      if (!isProcessAlive(info.pid)) {
        activeProcesses.delete(key);
        staleAgents++;
      }
    }
    if (staleAgents > 0) killed.push(staleAgents + ' agente(s) stale');

  } catch (e) {
    log('free-resources', 'Error durante limpieza (' + mode + '): ' + e.message);
  }

  if (killed.length > 0) {
    log('free-resources', '[' + mode + '] Recursos liberados: ' + killed.join(', '));
  }

  return { freed: killed.length > 0, killed };
}

/**
 * Solicitar apagado del emulador QA si no hay nada en fase verificacion/trabajando.
 * Delega al servicio-emulador via cola (no ejecuta directamente).
 * Retorna true si encoló el pedido de stop.
 */
// Grace period: después de levantar el emulador (boot_completed), no apagarlo
// durante este tiempo. Evita el loop preflight→start→idle→stop→preflight que
// corrompía el quickboot. Anclado a qa-env-state.lastStartedAt, que qa-environment.js
// escribe recién DESPUÉS de confirmar sys.boot_completed=1.
const EMULATOR_IDLE_GRACE_MS = 3 * 60 * 1000; // 3 minutos de warm-up protegido

function shutdownIdleEmulator(config) {
  try {
    // ¿Hay algo en verificacion/trabajando O pendiente?
    // Si hay QA pendiente encolada, el emulador va a ser necesario inmediatamente.
    for (const [pName, pConfig] of Object.entries(config.pipelines)) {
      if (!pConfig.fases.includes('verificacion')) continue;
      const verifDir = fasePath(pName, 'verificacion');
      const trabajando = listWorkFiles(path.join(verifDir, 'trabajando'));
      if (trabajando.length > 0) return false; // Hay agentes QA corriendo
      const pendiente = listWorkFiles(path.join(verifDir, 'pendiente'));
      if (pendiente.length > 0) return false; // Hay QA pendiente en cola
    }

    // ¿Está corriendo el emulador? Verificar state file Y por nombre de proceso
    let emulatorRunning = false;
    let lastStartedAt = 0;

    // Check 1: state file
    const stateFile = path.join(PIPELINE, 'qa-env-state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const emulatorPid = state.emulator || state.emulador;
        if (emulatorPid && isProcessAlive(emulatorPid)) emulatorRunning = true;
        lastStartedAt = state.lastStartedAt || 0;
      } catch {}
    }

    // Check 2: buscar proceso QEMU por nombre (el state puede perder track del PID)
    if (!emulatorRunning) {
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
          { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        if (out.includes('qemu-system')) emulatorRunning = true;
      } catch {}
    }

    if (!emulatorRunning) return false;

    // Grace period: no apagar si estamos dentro de la ventana post-boot.
    // lastStartedAt se actualiza en qa-environment.js DESPUÉS de boot_completed.
    const ageMs = Date.now() - lastStartedAt;
    if (lastStartedAt > 0 && ageMs < EMULATOR_IDLE_GRACE_MS) {
      const remaining = Math.round((EMULATOR_IDLE_GRACE_MS - ageMs) / 1000);
      log('recursos', `⏳ Emulador dentro de grace period post-boot (${remaining}s restantes) — no apagar`);
      return false;
    }

    // Encolar stop al servicio-emulador (no ejecutar directo)
    log('recursos', '🔌 Encolando stop de emulador idle para liberar ~2.5GB RAM');
    requestEmulator('stop', 'pulpo-idle', null, 'Cola de verificación vacía, sin agentes QA activos');
    return true;
  } catch (e) {
    log('recursos', `Error verificando emulador idle: ${e.message}`);
    return false;
  }
}

/**
 * Deadlock breaker: cuando el gate predictivo bloquea TODOS los candidatos durante
 * varios ciclos consecutivos, escalar progresivamente para salir del deadlock.
 *
 * Tier 1 (3 ciclos / ~1.5min): Apagar emulador idle + resetear profiles poco confiables
 * Tier 2 (6 ciclos / ~3min): Forzar lanzamiento del candidato más liviano con threshold relajado
 */
function handleDeadlock(candidates, config) {
  if (consecutiveAllBlockedCycles < DEADLOCK_TIER1_CYCLES) return null;

  const now = Date.now();

  // --- TIER 1: liberar recursos pasivos ---
  if (consecutiveAllBlockedCycles === DEADLOCK_TIER1_CYCLES) {
    log('deadlock', `⚠️ Deadlock detectado: ${consecutiveAllBlockedCycles} ciclos con TODOS los candidatos bloqueados. Tier 1: liberando recursos pasivos.`);

    // Apagar emulador si está idle
    const emulatorKilled = shutdownIdleEmulator(config);
    if (emulatorKilled) {
      log('deadlock', '🔌 Emulador idle apagado — re-evaluando en el próximo ciclo');
      if (now - lastDeadlockTelegramTs > DEADLOCK_TELEGRAM_COOLDOWN) {
        sendTelegram('⚠️ Pipeline deadlocked — apagué el emulador idle para liberar RAM. Se re-levanta solo cuando haga falta.');
        lastDeadlockTelegramTs = now;
      }
    }

    // Resetear profiles con pocas muestras (no son confiables)
    const profiles = loadSkillProfiles();
    let resetCount = 0;
    for (const [skill, profile] of Object.entries(profiles)) {
      if ((profile.samples || 0) < MIN_RELIABLE_SAMPLES) {
        delete profiles[skill];
        resetCount++;
      }
    }
    if (resetCount > 0) {
      saveSkillProfiles(profiles);
      log('deadlock', `🗑️ Reseteados ${resetCount} profiles con < ${MIN_RELIABLE_SAMPLES} muestras (poco confiables)`);
    }

    return null; // Dar un ciclo más para que surta efecto
  }

  // --- TIER 2: forzar lanzamiento del más liviano ---
  if (consecutiveAllBlockedCycles >= DEADLOCK_TIER2_CYCLES) {
    // Encontrar el candidato con menor impacto estimado
    const profiles = loadSkillProfiles();
    let lightest = null;
    let lightestImpact = Infinity;

    for (const candidate of candidates) {
      const skill = skillFromFile(candidate.archivo.name);
      const est = getEstimatedImpact(profiles[skill]);
      const impact = est.cpu + est.mem;
      if (impact < lightestImpact) {
        lightestImpact = impact;
        lightest = candidate;
      }
    }

    if (lightest) {
      const skill = skillFromFile(lightest.archivo.name);
      const issue = issueFromFile(lightest.archivo.name);
      log('deadlock', `🚀 Tier 2: forzando lanzamiento de ${skill}:#${issue} (el más liviano, impacto estimado: ${Math.round(lightestImpact)}%) tras ${consecutiveAllBlockedCycles} ciclos bloqueados`);
      if (now - lastDeadlockTelegramTs > DEADLOCK_TELEGRAM_COOLDOWN) {
        sendTelegram(`🔓 Pipeline deadlocked ${consecutiveAllBlockedCycles} ciclos — forzando ${skill}:#${issue} para desbloquear. El gate predictivo tenía profiles inflados o el sistema tiene procesos externos pesados.`);
        lastDeadlockTelegramTs = now;
      }
      consecutiveAllBlockedCycles = 0; // Reset — le damos tiempo al agente lanzado
      return lightest;
    }
  }

  return null;
}

/**
 * Limpieza proactiva — se ejecuta cada N ciclos aunque no haya presión.
 * Mata daemons huérfanos que se acumulan silenciosamente.
 */
function proactiveCleanup(config) {
  const interval = config.resource_limits?.proactive_cleanup_cycles || 10;
  proactiveCycleCounter++;
  if (proactiveCycleCounter < interval) return;
  proactiveCycleCounter = 0;

  const { freed, killed } = tryFreeResources('soft');
  if (freed) {
    log('proactivo', `Limpieza periódica: ${killed.join(', ')}`);
  }

  // Auto-shutdown del emulador si no hay verificación activa — libera ~2.5GB RAM
  const emulatorKilled = shutdownIdleEmulator(config);
  if (emulatorKilled) {
    sendTelegram('🔌 Emulador QA apagado automáticamente (sin verificación activa). Se re-levanta solo cuando haga falta.');
  }
}

// Tomar snapshot inicial de CPU al arrancar (el primer delta necesita dos puntos)
lastCpuSnapshot = cpuSnapshot();

// =============================================================================
// BRAZO 1: BARRIDO — Conecta fases, promueve o rechaza
// =============================================================================

function brazoBarrido(config) {
  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    const fases = pipelineConfig.fases;
    const faseRechazo = pipelineConfig.fase_rechazo;

    for (let i = 0; i < fases.length; i++) {
      const fase = fases[i];
      const listoDir = path.join(fasePath(pipelineName, fase), 'listo');
      const procesadoDir = path.join(fasePath(pipelineName, fase), 'procesado');
      const archivosListo = listWorkFiles(listoDir);

      if (archivosListo.length === 0) continue;

      // Agrupar por issue
      const porIssue = {};
      for (const f of archivosListo) {
        const issue = issueFromFile(f.name);
        if (!porIssue[issue]) porIssue[issue] = [];
        porIssue[issue].push(f);
      }

      // Para cada issue, verificar si todos los skills completaron
      const skillsRequeridos = pipelineConfig.skills_por_fase[fase] || [];

      for (const [issue, archivos] of Object.entries(porIssue)) {
        // Para fase "dev" solo se necesita 1 skill (el que corresponda)
        const skillsEnListo = archivos.map(a => skillFromFile(a.name));

        let todosCompletos;
        let origenPorSkill = null; // #3481 — para log estructurado en fases paralelas
        if (fase === 'dev' || fase === 'build' || fase === 'entrega') {
          // Fases de un solo skill: con 1 archivo alcanza
          todosCompletos = archivos.length >= 1;
        } else {
          // Fases paralelas: todos los skills requeridos deben estar.
          //
          // #3481 — Considerar también artefactos `aprobado` varados en
          // `procesado/` de ciclos previos (caso: un skill cerró OK, los
          // demás fueron rebloqueados por deps y vuelven a entrar). El
          // módulo aplica whitelist estricta y excluye skills con
          // artefactos vivos en pendiente/trabajando (anti-race).
          const listoInputs = archivos.map(a => ({
            skill: skillFromFile(a.name),
            yaml: readYaml(a.path),
          }));
          const procesadoFasePath = path.join(fasePath(pipelineName, fase), 'procesado');
          const pendienteFasePath = path.join(fasePath(pipelineName, fase), 'pendiente');
          const trabajandoFasePath = path.join(fasePath(pipelineName, fase), 'trabajando');

          // Solo archivos del mismo issue (filtra por prefijo "<issue>.").
          const issuePrefix = issue + '.';
          const procesadoInputs = listWorkFiles(procesadoFasePath)
            .filter(a => a.name.startsWith(issuePrefix))
            .map(a => ({
              skill: skillFromFile(a.name),
              yaml: readYaml(a.path), // readYaml ya es defensivo (try/catch → {})
            }));
          const pendienteSkills = listWorkFiles(pendienteFasePath)
            .filter(a => a.name.startsWith(issuePrefix))
            .map(a => skillFromFile(a.name));
          const trabajandoSkills = listWorkFiles(trabajandoFasePath)
            .filter(a => a.name.startsWith(issuePrefix))
            .map(a => skillFromFile(a.name));

          const evalResult = phaseCompletion.evaluateParallelPhaseCompletion({
            skillsRequeridos,
            listo: listoInputs,
            procesado: procesadoInputs,
            pendienteSkills,
            trabajandoSkills,
          });
          todosCompletos = evalResult.todosCompletos;
          origenPorSkill = evalResult.origenPorSkill;
        }

        // Leer resultados
        const resultados = archivos.map(a => ({
          ...readYaml(a.path),
          file: a
        }));

        // FAST-FAIL: si al menos un skill rechazó, disparar el rebote sin esperar
        // al resto. Los skills pendientes/en cooldown no cambian el veredicto
        // (el issue va a rebotear igual) y esperarlos produce deadlocks cuando
        // algún skill queda atascado. Incidente 2026-04-24: tester:#2505 en
        // cooldown bloqueaba el rebote de qa:#2505 que ya había rechazado.
        const hayRechazoConfirmado = resultados.some(r => r.resultado === 'rechazado');
        if (!todosCompletos && !hayRechazoConfirmado) continue;

        // Si el rebote va a dispararse por fast-fail (todosCompletos=false pero hay rechazo),
        // cancelar los archivos residuales del mismo issue en pendiente/ y trabajando/
        // de la fase actual para que no queden huérfanos tras el rebote.
        //
        // #3373 — EXCEPCIÓN dependency_block: si alguno de los rechazos viene con
        // `rebote_categoria: dependency_block` (hint YAML del agente) o el classifier
        // detecta dep_block sobre el motivo, NO drenar. El handler dep-block más abajo
        // (línea ~2906, moveIssueFilesToDependencyBlock) barre TODOS los archivos del
        // issue (pendiente + trabajando + listo) a `bloqueado-dependencias/`. Drenar
        // acá a `procesado/` con `cancelado_por: fast-fail-rebote` rompía el destrabe
        // automático: el brazoDesbloqueo solo lee `bloqueado-dependencias/` y dejaba
        // los .po/.ux varados en procesado/. Incidente #3361 — issue trabado ~10h.
        let hayDepBlockEnRechazos = false;
        if (!todosCompletos && hayRechazoConfirmado) {
          for (const r of resultados) {
            if (r.resultado !== 'rechazado') continue;
            // (a) hint explícito en YAML del agente — gana sobre regex
            if (r.rebote_categoria === 'dependency_block') {
              hayDepBlockEnRechazos = true;
              break;
            }
            // (b) fallback: classifier identifica dep_block por motivo
            try {
              const cl = reboteClassifier.classifyRebote({
                motivo: r.motivo || '',
                rebote_categoria: r.rebote_categoria || null,
                dependsOn: Array.isArray(r.depende_de) ? r.depende_de : null,
              });
              if (cl && cl.category === 'dependency_block') {
                hayDepBlockEnRechazos = true;
                break;
              }
            } catch {
              // classifier defensivo — si tira, seguimos con el drain normal
            }
          }
        }

        if (!todosCompletos && hayRechazoConfirmado && !hayDepBlockEnRechazos) {
          const procesadoFaseActual = path.join(fasePath(pipelineName, fase), 'procesado');
          for (const estado of ['pendiente', 'trabajando']) {
            const dir = path.join(fasePath(pipelineName, fase), estado);
            try {
              for (const f of fs.readdirSync(dir)) {
                if (f.startsWith('.')) continue; // flags internos
                if (!f.startsWith(issue + '.')) continue;
                const src = path.join(dir, f);
                const dst = path.join(procesadoFaseActual, f);
                try {
                  const prev = readYaml(src) || {};
                  writeYaml(dst, { ...prev, cancelado_por: 'fast-fail-rebote', cancelado_ts: new Date().toISOString() });
                  fs.unlinkSync(src);
                } catch {}
              }
            } catch {}
          }
          log('barrido', `⚡ #${issue} fast-fail en ${fase} — rebote temprano, cancelados skills pendientes/en cooldown`);
        } else if (!todosCompletos && hayRechazoConfirmado && hayDepBlockEnRechazos) {
          // #3373 — skip drain. Los archivos pendiente/trabajando se quedan
          // donde están, el handler dep-block los barre a bloqueado-dependencias/
          // junto con los de listo/. Así el brazoDesbloqueo encuentra todo
          // junto y los reingresa cuando las deps cierren.
          log('barrido', `⚡⏸ #${issue} fast-fail con dependency_block — skip drain. Handler dep-block barre todo a bloqueado-dependencias/.`);
        }

        // --- GATE DE EVIDENCIA QA (fase verificacion) ---
        // Si el QA dice "aprobado" pero no tiene evidencia real, forzar rechazo automático.
        // Esto evita que issues pasen a aprobación sin video con audio narrado.
        // R1 (#2351): el qaMode autoritativo viene del cache del preflight, no del YAML.
        if (fase === 'verificacion') {
          const qaResult = resultados.find(r => skillFromFile(r.file.name) === 'qa');
          if (qaResult && qaResult.resultado === 'aprobado') {
            const authoritativeQaMode = qaModeByIssue.get(String(issue)) || null;
            const issues = validateQaEvidence(issue, qaResult, authoritativeQaMode);
            if (issues.length > 0) {
              log('barrido', `⛔ #${issue} QA aprobó SIN evidencia válida: ${issues.join(', ')}`);
              qaResult.resultado = 'rechazado';
              qaResult.motivo = `Evidencia QA incompleta: ${issues.join('; ')}`;
              // Sobrescribir el archivo con el rechazo
              writeYaml(qaResult.file.path, {
                ...qaResult,
                file: undefined,  // No persistir el campo 'file'
                resultado: 'rechazado',
                motivo: qaResult.motivo,
                rechazado_por: 'gate-evidencia-automatico'
              });
              sendTelegram(`⛔ #${issue} — QA aprobó sin evidencia válida. Rechazo automático: ${issues.join('; ')}`);
            }
          }
        }

        const rechazados = resultados.filter(r => r.resultado === 'rechazado');

        // CROSS-PHASE REBOTE: si algún archivo rechazado declara `rebote_destino`
        // válido, rutear el issue a esa fase/skill upstream en lugar del default.
        // Interceptado ANTES del flujo de rebote normal a `fase_rechazo`.
        if (rechazados.length > 0) {
          const cross = resolveRebotedCrossPhase(resultados, pipelineName, fase, loadConfig());
          if (cross) {
            const cfg = loadConfig();
            const crossCount = contarCrossPhaseRebotes(issue, cfg);
            const nuevoCrossCount = crossCount + 1;

            let destinoEfectivo = null;
            let escalaAHumano = false;
            if (nuevoCrossCount > MAX_CROSSPHASE_REBOTES) {
              escalaAHumano = true;
            } else if (nuevoCrossCount === 1) {
              destinoEfectivo = cross.destino;
            } else {
              // 2do intento: escalar a fase previa del mismo skill.
              const previa = findPreviousFaseForSkill(
                cross.destino.skill, cross.destino.pipeline, cross.destino.fase, cfg,
              );
              if (!previa) {
                escalaAHumano = true;
                log('barrido', `⛔ #${issue} cross-phase rev-${nuevoCrossCount}: sin fase previa para skill ${cross.destino.skill} — escalando a humano`);
              } else {
                destinoEfectivo = previa;
                log('barrido', `↑ #${issue} cross-phase rev-${nuevoCrossCount}: escala a ${previa.pipeline}/${previa.fase}/${previa.skill}`);
              }
            }

            if (escalaAHumano) {
              log('barrido', `⛔ #${issue} CIRCUIT BREAKER CROSSPHASE — ${nuevoCrossCount} rebotes cross-phase (cap ${MAX_CROSSPHASE_REBOTES}). Escalando.`);
              sendTelegram(`⛔ Issue #${issue} — ${nuevoCrossCount} rebotes cross-phase solicitados por agentes. Requiere intervención manual.`);
              try {
                const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                fs.mkdirSync(ghQueueDir, { recursive: true });
                const labelFile = path.join(ghQueueDir, `${issue}-needs-human-crossphase-${Date.now()}.json`);
                fs.writeFileSync(labelFile, JSON.stringify({ action: 'label', issue: parseInt(issue), label: 'needs-human' }));
              } catch (e) { log('barrido', `error encolando label needs-human: ${e.message}`); }
              for (const a of archivos) {
                const dest = path.join(fasePath(pipelineName, fase), 'procesado');
                try { moveFile(a.path, dest); } catch {}
              }
              continue;
            }

            // Cleanup: mover a procesado/ archivos del issue en todas las fases
            // entre el destino (inclusivo) y la fase origen (inclusivo), para
            // que el nuevo ciclo arranque limpio sin conflicto con residuos.
            const destIdx = faseGlobalIndex(destinoEfectivo.pipeline, destinoEfectivo.fase, cfg);
            const origIdx = faseGlobalIndex(pipelineName, fase, cfg);
            const orderGlobal = getFaseGlobalOrder(cfg);
            for (let i = destIdx; i <= origIdx; i++) {
              const { pipeline: p, fase: f } = orderGlobal[i];
              for (const estado of ['pendiente', 'trabajando', 'listo']) {
                const dir = path.join(fasePath(p, f), estado);
                try {
                  for (const fname of fs.readdirSync(dir)) {
                    if (fname.startsWith('.')) continue;
                    if (!fname.startsWith(String(issue) + '.')) continue;
                    const src = path.join(dir, fname);
                    const dst = path.join(fasePath(p, f), 'procesado', fname);
                    try {
                      const prev = readYaml(src) || {};
                      writeYaml(dst, { ...prev, cancelado_por: 'cross-phase-rebote', cancelado_ts: new Date().toISOString() });
                      fs.unlinkSync(src);
                    } catch {}
                  }
                } catch {}
              }
            }

            // Crear archivo en destino efectivo
            const destPendiente = path.join(fasePath(destinoEfectivo.pipeline, destinoEfectivo.fase), 'pendiente');
            try { fs.mkdirSync(destPendiente, { recursive: true }); } catch {}
            const destFile = path.join(destPendiente, `${issue}.${destinoEfectivo.skill}`);
            const yamlOut = {
              issue: parseInt(issue),
              fase: destinoEfectivo.fase,
              pipeline: destinoEfectivo.pipeline,
              rebote: true,
              rebote_tipo: 'crossphase',
              rebote_numero_crossphase: nuevoCrossCount,
              rebote_destino_solicitado: cross.destino,
              rebote_destino_efectivo: destinoEfectivo,
              motivo_rechazo: sanitizePipelineText(cross.motivo),
              rechazado_en_fase: fase,
              rechazado_por_skill: cross.skillOrigen,
            };
            writeYaml(destFile, yamlOut);

            log('barrido', `↪ #${issue} CROSS-PHASE rev-${nuevoCrossCount} — ${pipelineName}/${fase}/${cross.skillOrigen} → ${destinoEfectivo.pipeline}/${destinoEfectivo.fase}/${destinoEfectivo.skill}`);
            ghCommentOnIssue(
              issue,
              `🔁 Pipeline: **${cross.skillOrigen}** (fase \`${pipelineName}/${fase}\`) solicitó re-ejecución de **${destinoEfectivo.skill}** (fase \`${destinoEfectivo.pipeline}/${destinoEfectivo.fase}\`).\n\nCross-phase rebote rev-${nuevoCrossCount}/${MAX_CROSSPHASE_REBOTES}.\n\nMotivo:\n> ${cross.motivo.slice(0, 500)}`
            );
            continue;
          }
        }

        if (rechazados.length > 0 && faseRechazo) {
          // #2317: clasificar los rechazos por tipo. Si TODOS los motivos
          // apuntan a infra (ENOTFOUND/ETIMEDOUT/etc) marcamos el rebote como
          // `rebote_tipo: infra` para que NO cuente contra el circuit breaker.
          //
          // #3229 — pasamos también los campos YAML estructurados que el
          // agente pudo haber emitido (rebote_categoria, depende_de). Antes
          // se construía solo con `motivo` y el classifier no veía la
          // categoría declarativa cuando el agente la emitía como YAML
          // top-level (resultaba en `human_block` por fallback).
          const motivosClasificados = rechazados.map(r => ({
            skill: skillFromFile(r.file.name),
            motivo: r.motivo || '',
            clasificacion: precheck.classifyError(r.motivo || '') || 'codigo',
            // Hints estructurados del YAML del agente (pueden ser undefined)
            rebote_categoria: r.rebote_categoria || null,
            depende_de: Array.isArray(r.depende_de) ? r.depende_de : null,
          }));
          const esReboteDeInfra = motivosClasificados.length > 0
            && motivosClasificados.every(m => m.clasificacion === 'infra');

          // #3167 — DEPENDENCY_BLOCK: ANTES de evaluar bloqueo humano, le damos al
          // clasificador unificado la chance de capturar rebotes donde el agente
          // dice "depende de #N todavía OPEN" o "asset UX no en main". Si calza,
          // NO creamos marker en `bloqueado-humano/` y NO incrementamos rev:
          // aplicamos label `blocked:dependencies` y dejamos que el brazoDesbloqueo
          // (que ya existe — ~línea 7813) destrabe cuando todas las deps cierren
          // en GitHub. Cero tokens consumidos mientras espera + cero intervención
          // humana cuando las deps cierren. Defense-in-depth: TODO el resto del
          // flujo de humanBlock queda intacto abajo (sigue siendo dueño cuando
          // el motivo no clasifica como dep).
          //
          // #3774 — El handler dep-block corre SIEMPRE (ya no gated por
          // !esReboteDeInfra). El hint YAML estructurado del agente
          // (`rebote_categoria: dependency_block`) gana sobre la heurística
          // textual de `classifyError`, que podía falsamente clasificar como
          // 'infra' un motivo que mencionaba palabras como "timeout"
          // (ej: "timeout 15min" describiendo idempotencia del wizard, no un
          // timeout de red). El loop infinito de #3741 (~$80–100/h) surgía de
          // este falso positivo: cada ciclo veía `esReboteDeInfra=true`,
          // salteaba el handler dep-block, y reencolaba con `rebote_numero_infra=1`
          // (el contador no se persistía en `listo/` así que nunca acumulaba
          // hacia el cap de 20). El handler ya filtra internamente por
          // `result.category === 'dependency_block'`; si ningún motivo califica,
          // `depBlockHandled` queda en false y el flow infra/humano normal sigue.
          let depBlockHandled = false;
          for (const m of motivosClasificados) {
              const result = reboteClassifier.classifyRebote({
                motivo: m.motivo,
                classifyErrorResult: m.clasificacion,
                isRoutingMismatch: false, // routing se evalúa más abajo, mantener orden
                // #3229 — hints estructurados del YAML del agente. Cierra el
                // puente roto entre guru (clasifica) y barrido (consumer).
                rebote_categoria: m.rebote_categoria,
                dependsOn: m.depende_de,
              });
              if (result.category !== 'dependency_block') continue;

              const skillDep = m.skill || skillFromFile(rechazados[0].file.name);
              const motivoSanitized = sanitizePipelineText(m.motivo).slice(0, 1500);

              // #3079 — Pre-validar deps en GitHub: si todas las dependencias
              // numéricas que el clasificador identificó ya están CLOSED, NO
              // pegar `blocked:dependencies` y NO archivar. El agente trabajó
              // sobre estado stale (worktree viejo o cache de contexto) y el
              // bloqueo nacería zombi — el brazoDesbloqueo después lo destrabaría
              // pero entre medio el issue queda pegado al label, el reconciler
              // lo escalaría con marker fantasma, y el operador ve "needs-human"
              // sobre una dep ya resuelta. Fail-open: si NO hay deps numéricas
              // (assets puros) o el state es UNKNOWN, comportamiento previo.
              if (Array.isArray(result.dependsOn) && result.dependsOn.length > 0) {
                let todasCerradas = true;
                const stateLog = [];
                for (const depNum of result.dependsOn) {
                  // Invalidar cache antes de chequear: el dep pudo haber cerrado
                  // hace minutos y el cache de 10min nos daría un estado stale.
                  issueLabelsCache.delete(depNum);
                  const info = getIssueInfo(depNum);
                  stateLog.push(`#${depNum}=${info.state}`);
                  if (info.state !== 'CLOSED') {
                    todasCerradas = false;
                    break;
                  }
                }
                if (todasCerradas) {
                  log('barrido', `🪢⏭ #${issue} dependency_block IGNORADO — todas las deps ya CLOSED (${stateLog.join(',')}). No se pega label, no se archiva. El motivo era stale.`);
                  // No archivar, no pegar label. El issue cae al flujo normal
                  // de rebote (humanBlock → rev++) que lo destraba o lo escala.
                  continue;
                }
              }

              try {
                reboteClassifier.reportDependencyBlock({
                  issue: parseInt(issue),
                  dependsOn: result.dependsOn,
                  reason: motivoSanitized,
                  skill: skillDep,
                  phase: fase,
                });
              } catch (e) {
                log('barrido', `❌ #${issue} reportDependencyBlock falló: ${e.message}`);
                // Fail-open: si reportDependencyBlock falla NO caemos a humanBlock
                // — el motivo SÍ es dep, simplemente la cola GitHub no aceptó el
                // marker. Mejor dejar el issue en pendiente/ para el próximo ciclo
                // que crear un marker humano espurio. Rompemos el for sin set de
                // depBlockHandled para que el flujo siga (rebote_numero, etc).
                break;
              }

              // #3229 — Mover archivos a `bloqueado-dependencias/` (NO a
              // `archivado/`). La segregación física hace que:
              //   - dashboards/auditoría distingan needs-human de blocked-deps,
              //   - el brazoDesbloqueo pueda reingresar los archivos a
              //     `pendiente/` cuando cierren todas las deps,
              //   - los motivos no se confundan ("archivado" implicaba
              //     descartado/manual).
              try {
                reboteClassifier.writeDependencyBlockMarker({
                  issue: parseInt(issue),
                  skill: skillDep,
                  phase: fase,
                  pipeline: pipelineName,
                  dependsOn: result.dependsOn,
                  reason: motivoSanitized,
                });
              } catch (e) {
                log('barrido', `[WARN] #${issue} writeDependencyBlockMarker falló (no bloqueante): ${e.message}`);
              }

              try {
                const movResult = reboteClassifier.moveIssueFilesToDependencyBlock({
                  issue: parseInt(issue),
                  pipeline: pipelineName,
                  phase: fase,
                });
                log('barrido', `📦 #${issue} archivos movidos a bloqueado-dependencias/ (count=${movResult.moved})`);
              } catch (e) {
                log('barrido', `[WARN] #${issue} moveIssueFilesToDependencyBlock falló: ${e.message}`);
              }

              const depsLabel = result.dependsOn.length > 0
                ? result.dependsOn.map(n => '#' + n).join(',')
                : '(asset)';
              log('barrido', `🪢 #${issue} → blocked:dependencies (skill=${skillDep}, deps=${depsLabel}) — bloqueado-dependencias/, label blocked:dependencies. Sin needs-human, esperando brazoDesbloqueo.`);
              try {
                sendTelegram(`🪢 Issue #${issue} bloqueado por dependencias — esperando ${depsLabel}. El pipeline destraba automáticamente al cerrar.`);
              } catch {}

              depBlockHandled = true;
              break;
          }
          if (depBlockHandled) continue;

          // #2549 — BLOQUEO HUMANO: si AL MENOS UN motivo indica que el avance
          // depende de una intervención humana (PR esperando merge, CODEOWNERS,
          // etc), marcar el issue como `bloqueado-humano/` y NO incrementar rev.
          // Sin esto el pulpo relanza el skill cada ciclo y rebota infinitamente
          // (caso #2519 → 41 rebotes contra PR #2547 mergeable).
          const motivosHumanos = motivosClasificados.filter(m => humanBlock.isHumanBlockReason(m.motivo));
          if (motivosHumanos.length > 0 && !esReboteDeInfra) {
            const principal = motivosHumanos[0];
            const skillBloq = principal.skill || skillFromFile(rechazados[0].file.name);
            const motivoTxt = sanitizePipelineText(
              motivosHumanos.map(m => `[${m.skill}] ${m.motivo}`).join('\n'),
            ).slice(0, 1500);
            const question = humanBlock.inferHumanBlockQuestion(principal.motivo, { skill: skillBloq });

            // Dedup: si ya hay marker activo en bloqueado-humano/ no spamear.
            const yaBloqueado = humanBlock.findBlockedMarker(issue);

            // Mover archivos actuales (rechazados + residuales del issue en la fase)
            // a archivado/ para sacar el token del flujo. El reportHumanBlock crea
            // marker fresco en bloqueado-humano/ del propio fase.
            for (const a of archivos) {
              const dest = path.join(fasePath(pipelineName, fase), 'archivado');
              try { fs.mkdirSync(dest, { recursive: true }); moveFile(a.path, dest); } catch {}
            }
            for (const estado of ['pendiente', 'trabajando']) {
              const dir = path.join(fasePath(pipelineName, fase), estado);
              try {
                for (const f of fs.readdirSync(dir)) {
                  if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                    const archDir = path.join(fasePath(pipelineName, fase), 'archivado');
                    fs.mkdirSync(archDir, { recursive: true });
                    try { moveFile(path.join(dir, f), archDir); } catch {}
                  }
                }
              } catch {}
            }

            if (!yaBloqueado) {
              try {
                humanBlock.reportHumanBlock({
                  issue: parseInt(issue),
                  skill: skillBloq,
                  phase: fase,
                  pipeline: pipelineName,
                  reason: motivoTxt,
                  question,
                  moveFromActive: false,
                });
              } catch (e) {
                log('barrido', `❌ #${issue} reportHumanBlock falló: ${e.message}`);
              }

              // #2880 — Label needs-human: lo encola humanBlock.reportHumanBlock() arriba.
              // Acá solo encolamos el comentario explicativo en el issue.
              try {
                const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                fs.mkdirSync(ghQueueDir, { recursive: true });
                const body = [
                  `## Pipeline pausó este issue: requiere intervención humana`,
                  '',
                  `El agente \`${skillBloq}\` (fase \`${pipelineName}/${fase}\`) detectó que el avance depende de una acción humana — no es un bug del código ni un fallo de infra.`,
                  '',
                  `### Motivo`,
                  '```',
                  motivoTxt,
                  '```',
                  '',
                  `### Qué necesitamos`,
                  question,
                  '',
                  `Mientras el label \`needs-human\` esté presente, el pipeline NO va a relanzar el skill (cero rebotes, cero tokens consumidos).`,
                  '',
                  `Una vez resuelto, remové el label o usá \`/unblock ${issue} <orientación>\` desde Telegram para reentrar en la cola.`,
                ].join('\n');
                fs.writeFileSync(
                  path.join(ghQueueDir, `${issue}-needs-human-comment-${Date.now()}.json`),
                  JSON.stringify({ action: 'comment', issue: parseInt(issue), body }),
                );
              } catch (e) {
                log('barrido', `Error encolando comentario needs-human para #${issue}: ${e.message}`);
              }

              // Notificación Telegram con listado completo de incidentes.
              try {
                const summary = humanBlock.buildBlockedSummaryMarkdown({
                  highlight: { issue: parseInt(issue), skill: skillBloq, reason: motivoTxt, question },
                });
                sendTelegram(summary);
              } catch (e) {
                log('barrido', `Error enviando resumen Telegram needs-human #${issue}: ${e.message}`);
              }

              log('barrido', `🚧 #${issue} → bloqueado-humano (skill=${skillBloq}, fase=${fase}). NO incrementa rev. Esperando humano.`);
            } else {
              log('barrido', `🔁 #${issue} ya estaba en bloqueado-humano (skill=${yaBloqueado.skill}). Cleanup de residuales sin re-notificar.`);
            }
            continue;
          }

          // Routing mismatch: si el agente rechazó por "fuera de alcance",
          // devolver el issue a definición con observaciones — el ruteo se
          // reevalúa allá (Guru/PO/UX clasifican y aplican labels). NO consume
          // budget del circuit breaker de dev (el defecto está en la clasificación
          // inicial, no en el código). Usa budget separado `max_routing_bounces`.
          const routingAnalisis = motivosClasificados
            .map(m => ({ skill: m.skill, motivo: m.motivo, ...classifyRoutingMismatch(m.motivo) }))
            .filter(m => m.isRouting);
          const esRoutingMismatch = !esReboteDeInfra && routingAnalisis.length > 0;

          // Circuit breaker: leer rebote_numero del archivo que originó este ciclo
          // (puede estar en trabajando/ o pendiente/ de la fase de rechazo, o en el propio resultado)
          // Buscar el máximo rebote_numero entre los archivos del issue en dev
          // IMPORTANTE: solo contamos rebotes de tipo 'codigo'. Los de infra
          // no consumen el budget de 3 rebotes (criterio #2 de #2317).
          //
          // #2335 (CA5-CA6) — rebote_numero_infra se lleva en contador separado
          // con cap duro `MAX_REBOTES_INFRA` (defense-in-depth contra loops
          // infinitos si la clasificacion infra se rompiera).
          let reboteCount = 0;
          let reboteInfraCount = 0;
          for (const estado of ['pendiente', 'trabajando', 'procesado']) {
            const dir = path.join(fasePath(pipelineName, faseRechazo), estado);
            try {
              for (const f of fs.readdirSync(dir)) {
                if (f.startsWith(issue + '.')) {
                  const data = readYaml(path.join(dir, f));
                  const tipoPrevio = data.rebote_tipo || 'codigo';
                  if (tipoPrevio === 'infra') {
                    if (data.rebote_numero_infra && data.rebote_numero_infra > reboteInfraCount) {
                      reboteInfraCount = data.rebote_numero_infra;
                    }
                    continue; // NO contar contra el breaker generico
                  }
                  if (data.rebote_numero && data.rebote_numero > reboteCount) {
                    reboteCount = data.rebote_numero;
                  }
                }
              }
            } catch {}
          }

          const MAX_REBOTES = 3;
          const MAX_REBOTES_INFRA = connectivityState.MAX_REBOTES_INFRA || 20;

          // #2405 CA-4: threshold blando que escala a humano con label `needs-human`
          // ANTES de alcanzar el cap duro. Arranca en 5, configurable vía config.yaml.
          const INFRA_ESCALATE_THRESHOLD = Math.max(
            1,
            (config.circuit_breaker && config.circuit_breaker.infra_escalate_threshold) || 5,
          );

          // #2405 CA-4 — escalado a humano cuando se acumulan N rebotes infra
          // consecutivos sin recuperación. Aplica label `needs-human`, comenta
          // en GitHub con estructura UX, y mueve los archivos a procesado/ para
          // sacarlo de la cola hasta que un humano quite el label.
          if (esReboteDeInfra
              && reboteInfraCount + 1 >= INFRA_ESCALATE_THRESHOLD
              && reboteInfraCount < MAX_REBOTES_INFRA) {
            // Deduplicar: sólo escalamos una vez por issue (archivo flag).
            const needsHumanFlag = path.join(
              fasePath(pipelineName, fase),
              'procesado',
              `.${issue}.needs-human-notified`,
            );
            const yaEscalado = fs.existsSync(needsHumanFlag);
            if (!yaEscalado) {
              log('barrido', `⚠️ #${issue} ESCALANDO a needs-human — ${reboteInfraCount + 1} rebotes infra (threshold ${INFRA_ESCALATE_THRESHOLD})`);
              // Motivo sanitizado (redact → sin paths internos, sin tokens).
              const motivoRedactado = sanitizePipelineText(
                rechazados.map(r => `[${skillFromFile(r.file.name)}] ${r.motivo || ''}`).join('\n'),
              ).slice(0, 1500);
              // Encolar creación de label + add-label + comentario en servicio-github.
              try {
                const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                fs.mkdirSync(ghQueueDir, { recursive: true });
                // Aplicar label `needs-human`. El servicio-github auto-crea el
                // label si no existe (ver LABEL_COLORS, color #B60205).
                fs.writeFileSync(
                  path.join(ghQueueDir, `${issue}-needs-human-apply-${Date.now()}.json`),
                  JSON.stringify({ action: 'label', issue: parseInt(issue), label: 'needs-human' }),
                );
                // 3) comentario estructurado (plantilla UX — una frase + <details> + 3 acciones)
                const body = [
                  `## Pipeline escaló este issue a intervención humana`,
                  '',
                  `El pipeline intentó procesar este issue ${reboteInfraCount + 1} veces y falló por un problema de infraestructura que no puede resolver automáticamente.`,
                  '',
                  `### Qué pasó`,
                  `El agente \`${rechazados[0] ? skillFromFile(rechazados[0].file.name) : 'desconocido'}\` falló en la fase \`${fase}\` por una causa clasificada como infra persistente (threshold: ${INFRA_ESCALATE_THRESHOLD} rebotes).`,
                  '',
                  `### Causa raíz`,
                  `<details><summary>Motivo del último rechazo (redactado)</summary>`,
                  '',
                  '```',
                  motivoRedactado,
                  '```',
                  '',
                  `</details>`,
                  '',
                  `### Qué podés hacer`,
                  `1. **Si es un problema del entorno** — revisá \`.pipeline/logs/${issue}-*.log\` y confirmá que el JDK/dependencia/variable esté presente en el host.`,
                  `2. **Si es un problema del issue** — reabrí la definición o dividilo en partes más chicas; al quitar el label \`needs-human\` el issue reentra a la cola.`,
                  `3. **Si no estás seguro** — preguntá antes de quitar el label; el contador de rebotes infra se resetea al removerlo.`,
                  '',
                  `Al quitar el label \`needs-human\`, el issue reentra a la cola automáticamente en el próximo ciclo de intake (~5 min) y el contador de rebotes se resetea.`,
                  '',
                  `📎 Log del agente: \`.pipeline/logs/${issue}-${rechazados[0] ? skillFromFile(rechazados[0].file.name) : 'skill'}.log\``,
                  `📎 Audit trail: \`.pipeline/logs/audit-${issue}.log\``,
                ].join('\n');
                fs.writeFileSync(
                  path.join(ghQueueDir, `${issue}-needs-human-comment-${Date.now()}.json`),
                  JSON.stringify({ action: 'comment', issue: parseInt(issue), body }),
                );
              } catch (e) {
                log('barrido', `Error encolando needs-human para #${issue}: ${e.message}`);
              }
              sendTelegram(`🚨 Issue #${issue} escalado a needs-human — ${reboteInfraCount + 1} rebotes por infra. Requiere intervención humana (quitá el label para reintentar).`);
              // Flag de dedup
              try {
                fs.mkdirSync(path.dirname(needsHumanFlag), { recursive: true });
                fs.writeFileSync(needsHumanFlag, new Date().toISOString());
              } catch {}
            }
            // #2405 CA-4 — Mover archivos actuales a `archivado/` (no procesado/).
            // Al quitar el label `needs-human`, el intake crea un archivo fresco
            // en pendiente/ y el contador de rebotes infra se resetea naturalmente
            // (no hay archivos en pendiente/trabajando/procesado para sumar).
            for (const a of archivos) {
              const dest = path.join(fasePath(pipelineName, fase), 'archivado');
              try { fs.mkdirSync(dest, { recursive: true }); moveFile(a.path, dest); } catch {}
            }
            // Archivar también los archivos acumulados en la fase de rechazo
            // para que el próximo ciclo no los lea como rebote previo.
            for (const estado of ['pendiente', 'trabajando', 'procesado']) {
              const dir = path.join(fasePath(pipelineName, faseRechazo), estado);
              try {
                for (const f of fs.readdirSync(dir)) {
                  if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                    const src = path.join(dir, f);
                    const archDir = path.join(fasePath(pipelineName, faseRechazo), 'archivado');
                    fs.mkdirSync(archDir, { recursive: true });
                    try { moveFile(src, archDir); } catch {}
                  }
                }
              } catch {}
            }
            continue;
          }

          // #2335 CA5 — cap duro sobre infra. Si se supera, el circuit breaker
          // generico aplica igual (defense-in-depth: si la clasificacion infra
          // fuera saboteada, el pipeline no queda en loop infinito).
          if (esReboteDeInfra && reboteInfraCount >= MAX_REBOTES_INFRA) {
            log('barrido', `⛔ #${issue} CIRCUIT BREAKER INFRA — ${reboteInfraCount} rebotes infra en ${faseRechazo}, se alcanzo cap duro (${MAX_REBOTES_INFRA}). Escalando.`);
            sendTelegram(`⛔ Issue #${issue} — ${reboteInfraCount} rebotes por infra (cap ${MAX_REBOTES_INFRA}). Requiere intervención manual.`);
            for (const a of archivos) {
              const dest = path.join(fasePath(pipelineName, fase), 'procesado');
              try { moveFile(a.path, dest); } catch {}
            }
            continue;
          }

          if (reboteCount >= MAX_REBOTES) {
            log('barrido', `⛔ #${issue} CIRCUIT BREAKER — ${reboteCount} rebotes en ${faseRechazo}, no devolver más. Requiere intervención manual.`);
            sendTelegram(`⛔ Issue #${issue} atascado — ${reboteCount} rebotes entre ${fase} y ${faseRechazo}. Requiere intervención manual.`);
            // Mover todo a procesado para sacarlo del loop
            for (const a of archivos) {
              const dest = path.join(fasePath(pipelineName, fase), 'procesado');
              try { moveFile(a.path, dest); } catch {}
            }
            continue;
          }

          // --- ROUTING MISMATCH: devolver a definición en vez de reencolar aquí ---
          if (esRoutingMismatch) {
            // Contar rebotes previos de routing (separados del contador de código)
            let routingBounces = 0;
            const defFases = (config.pipelines && config.pipelines.definicion && config.pipelines.definicion.fases) || [];
            for (const dFase of defFases) {
              for (const estado of ['pendiente', 'trabajando', 'procesado']) {
                const dir = path.join(fasePath('definicion', dFase), estado);
                try {
                  for (const f of fs.readdirSync(dir)) {
                    if (isMarkerArtifactPulpo(f)) continue;
                    if (f.startsWith(issue + '.')) {
                      const data = readYaml(path.join(dir, f));
                      if (data && data.rebote_tipo === 'routing' && data.rebote_routing_numero > routingBounces) {
                        routingBounces = data.rebote_routing_numero;
                      }
                    }
                  }
                } catch {}
              }
            }

            const MAX_ROUTING_BOUNCES = (config.routing && config.routing.max_bounces) || 2;
            const nuevoRoutingBounces = routingBounces + 1;

            // Consolidar motivo + sugerencias del agente
            const motivosRouting = routingAnalisis.map(m => `[${m.skill}] ${m.motivo}`).join('\n');
            const skillSugerido = routingAnalisis.find(m => m.skillSugerido)?.skillSugerido || null;
            const labelSugerido = routingAnalisis.find(m => m.labelSugerido)?.labelSugerido || null;

            if (nuevoRoutingBounces > MAX_ROUTING_BOUNCES) {
              // Deduplicación: sólo loguear/notificar una vez por issue.
              // Sin esto, cada ciclo del Pulpo (~30s) volvía a leer los archivos rechazados
              // y re-disparaba el log + sendTelegram → spam infinito en Telegram.
              const manualFlag = path.join(fasePath(pipelineName, fase), 'procesado', `.${issue}.routing-manual-notified`);
              const yaNotificado = fs.existsSync(manualFlag);
              if (!yaNotificado) {
                log('routing', `⛔ #${issue} BUDGET AGOTADO — ${nuevoRoutingBounces}/${MAX_ROUTING_BOUNCES} rebotes por routing. Escalando a humano.`);
                sendTelegram(`⛔ Issue #${issue} — ${nuevoRoutingBounces} rebotes por routing mismatch. Ningún agente encuentra su alcance. Requiere reclasificación manual.\n\nÚltimo motivo:\n${motivosRouting.slice(0, 500)}`);
                // Encolar en servicio-github: label blocked:routing-manual
                try {
                  const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                  fs.mkdirSync(ghQueueDir, { recursive: true });
                  const labelFile = path.join(ghQueueDir, `${issue}-blocked-routing-${Date.now()}.json`);
                  fs.writeFileSync(labelFile, JSON.stringify({ action: 'label', issue: parseInt(issue), label: 'blocked:routing-manual' }));
                } catch (e) {
                  log('routing', `Error encolando label blocked:routing-manual: ${e.message}`);
                }
                try { fs.mkdirSync(path.dirname(manualFlag), { recursive: true }); fs.writeFileSync(manualFlag, new Date().toISOString()); } catch {}
              }
              // Mover archivos actuales a procesado/ para sacarlos del loop (antes sólo se hacía
              // en el circuit breaker de código — faltaba acá y causaba re-detección continua)
              for (const a of archivos) {
                const dest = path.join(fasePath(pipelineName, fase), 'procesado');
                try { moveFile(a.path, dest); } catch {}
              }
              continue;
            }

            // Mover issue a definicion/analisis/pendiente para que Guru/Security reanalicen.
            // Los skills de la fase `analisis` los define config.yaml.
            const analisisPendiente = path.join(fasePath('definicion', 'analisis'), 'pendiente');
            fs.mkdirSync(analisisPendiente, { recursive: true });
            const analisisSkills = (config.pipelines.definicion.skills_por_fase || {}).analisis || ['guru'];
            for (const skill of analisisSkills) {
              const dst = path.join(analisisPendiente, `${issue}.${skill}`);
              writeYaml(dst, {
                issue: parseInt(issue),
                fase: 'analisis',
                pipeline: 'definicion',
                rebote: true,
                rebote_tipo: 'routing',
                rebote_routing_numero: nuevoRoutingBounces,
                motivo_rechazo: motivosRouting,
                skill_sugerido: skillSugerido,
                label_sugerido: labelSugerido,
                rechazado_desde_pipeline: pipelineName,
                rechazado_desde_fase: fase,
                rechazado_por: routingAnalisis.map(m => m.skill).join(','),
              });
            }

            log('routing', `#${issue} RECHAZO por routing mismatch en ${pipelineName}/${fase} → devuelto a definicion/analisis (bounce ${nuevoRoutingBounces}/${MAX_ROUTING_BOUNCES}${skillSugerido ? `, skill sugerido: ${skillSugerido}` : ''}${labelSugerido ? `, label sugerido: ${labelSugerido}` : ''})`);

            // Cleanup: archivar archivos del issue en TODAS las fases del pipeline origen
            // (no solo las posteriores — también las anteriores, porque el issue ya no pertenece a este pipeline).
            for (const otraFase of fases) {
              if (otraFase === fase) continue; // los de la fase actual los mueve el loop al final
              for (const estado of ['pendiente', 'trabajando', 'listo']) {
                const dir = path.join(fasePath(pipelineName, otraFase), estado);
                try {
                  for (const f of fs.readdirSync(dir)) {
                    if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                      const src = path.join(dir, f);
                      const archDir = path.join(fasePath(pipelineName, otraFase), 'archivado');
                      fs.mkdirSync(archDir, { recursive: true });
                      moveFile(src, archDir);
                      log('routing', `#${issue} cleanup: ${otraFase}/${estado}/${f} → archivado/`);
                    }
                  }
                } catch {}
              }
            }

            // Comentario en GitHub para auditoría
            const bodyAuditoria = [
              `🔀 **Reclasificación automática** — ${routingAnalisis[0].skill} en \`${pipelineName}/${fase}\` reportó que este issue está fuera de su alcance.`,
              '',
              `Se devolvió a \`definicion/analisis\` para re-triaje por Guru${analisisSkills.includes('security') ? '/Security' : ''} (bounce ${nuevoRoutingBounces}/${MAX_ROUTING_BOUNCES}).`,
              '',
              skillSugerido ? `**Skill sugerido por el agente:** \`${skillSugerido}\`` : null,
              labelSugerido ? `**Label sugerido:** \`${labelSugerido}\`` : null,
              '',
              '<details><summary>Motivo completo del rechazo</summary>',
              '',
              '```',
              motivosRouting.slice(0, 1500),
              '```',
              '</details>',
              '',
              `_Este rebote NO consume budget del circuit breaker de código._`,
            ].filter(x => x !== null).join('\n');
            ghCommentOnIssue(issue, bodyAuditoria);

            continue;
          }

          // Hay rechazo → devolver a fase de rechazo
          const motivos = rechazados.map(r => `[${skillFromFile(r.file.name)}] ${r.motivo || 'sin motivo'}`).join('\n');

          // #2404 — Stale-log interception: si el motivo de rechazo referencia
          // el build-log del issue y ese log tiene mtime > umbral (default 24h),
          // NO rebotar al developer con contexto obsoleto. En su lugar:
          //   1) Limpiar `motivo_rechazo` + `rebote*` del YAML.
          //   2) Resetear el contador del circuit breaker (el error pudo haber
          //      sido de un ciclo anterior ya corregido — ej. JAVA_HOME stale).
          //   3) Re-encolar a `build` para que el builder re-ejecute con
          //      entorno actualizado.
          //   4) Auditar en JSONL + notificar a Telegram.
          //   5) Tope duro `max_resets_per_issue` (default 5) para evitar bypass
          //      del breaker por logs que se mantienen stale indefinidamente.
          //
          // El flujo clase `codigo` con log fresco (<=24h) sigue idéntico.
          // El flujo `infra` (bloqueo por red) tiene su propio circuit breaker
          // y NO es afectado por esta lógica (la clasificación stale depende
          // solo del build-log, no del tipo de rebote).
          const pipelineFases = ((config.pipelines || {})[pipelineName] || {}).fases || fases;
          const pipelineTieneBuild = Array.isArray(pipelineFases) && pipelineFases.includes('build');
          const puedeHaceStale = pipelineTieneBuild
            && staleness.isValidIssueNumber(issue)
            && staleness.motivoReferencesBuildLog(motivos, issue);

          if (puedeHaceStale) {
            const { ms: stalenessMs, hours: stalenessHrsEffective, clamped }
              = staleness.getStalenessThresholdMs(config);
            if (clamped) {
              log('barrido', `⚠️ #${issue} staleness threshold inválido en config — elevado a mínimo (5min). Valor efectivo: ${stalenessHrsEffective}h`);
            }
            const info = staleness.inspectBuildLog(issue, stalenessMs);
            if (info.exists && info.stale) {
              const resetsPrev = staleness.getStaleResetCount(issue);
              const maxResets = staleness.getMaxResetsPerIssue(config);

              if (resetsPrev >= maxResets) {
                // Tope duro superado — NO seguir reseteando. Escalar.
                log('barrido', `⛔ #${issue} STALE-LOG: ya tuvo ${resetsPrev} resets por log stale (tope ${maxResets}). Escalando — requiere intervención manual.`);
                staleness.appendAuditReset({
                  ts: new Date().toISOString(),
                  event: 'circuit_breaker_reset_refused',
                  issue: parseInt(issue),
                  reason: 'stale_log_cap_exceeded',
                  log_mtime: new Date(info.mtimeMs).toISOString(),
                  log_age_hours: Number(info.ageHours.toFixed(2)),
                  threshold_hours: Number(stalenessHrsEffective.toFixed(2)),
                  resets_count: resetsPrev,
                  max_resets: maxResets,
                });
                sendTelegram(staleness.buildTelegramEscalationMessage(issue, resetsPrev, maxResets, info.path));
                // Mover archivos actuales a procesado/ para sacarlos del loop.
                for (const a of archivos) {
                  const dest = path.join(fasePath(pipelineName, fase), 'procesado');
                  try { moveFile(a.path, dest); } catch {}
                }
                continue;
              }

              // STALE confirmado dentro del tope → reset + re-encolar a build.
              const resetsNuevo = resetsPrev + 1;
              const buildPendiente = path.join(fasePath(pipelineName, 'build'), 'pendiente');
              const buildSkills = pipelineConfig.skills_por_fase?.build || ['build'];
              const buildSkill = buildSkills[0] || 'build';

              // Tomar el YAML del primer archivo del issue (todos los skills de
              // la fase actual reciben el mismo contenido) y limpiarlo.
              let baseYaml = { issue: parseInt(issue), pipeline: pipelineName };
              try {
                if (archivos.length > 0) {
                  baseYaml = readYaml(archivos[0].path);
                }
              } catch {}
              const cleanYaml = staleness.cleanYamlForRebuild(baseYaml);
              cleanYaml.issue = parseInt(issue);
              cleanYaml.pipeline = pipelineName;
              cleanYaml.fase = 'build';

              const buildFile = path.join(buildPendiente, `${issue}.${buildSkill}`);
              writeYaml(buildFile, cleanYaml);

              // Audit estructurado (UX §3).
              staleness.appendAuditReset({
                ts: new Date().toISOString(),
                event: 'circuit_breaker_reset',
                issue: parseInt(issue),
                reason: 'stale_log',
                log_mtime: new Date(info.mtimeMs).toISOString(),
                log_age_hours: Number(info.ageHours.toFixed(2)),
                threshold_hours: Number(stalenessHrsEffective.toFixed(2)),
                resets_count: resetsNuevo,
                max_resets: maxResets,
                rechazado_en_fase: fase,
              });

              // Telegram natural (UX §2).
              sendTelegram(staleness.buildTelegramStaleMessage(
                issue, info.ageHours, info.path, resetsNuevo, maxResets,
              ));

              log('barrido', `♻️ #${issue} STALE-LOG: build-log ${info.ageHours.toFixed(1)}h (umbral ${stalenessHrsEffective.toFixed(1)}h). Reset circuit breaker + re-encolado a build (reset ${resetsNuevo}/${maxResets}). YAML limpio sin motivo_rechazo.`);

              // Cleanup: limpiar archivos residuales del issue en fases posteriores a la actual.
              for (let downstream = i + 1; downstream < fases.length; downstream++) {
                const downFase = fases[downstream];
                for (const estado of ['pendiente', 'trabajando', 'listo']) {
                  const dir = path.join(fasePath(pipelineName, downFase), estado);
                  try {
                    for (const f of fs.readdirSync(dir)) {
                      if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                        const src = path.join(dir, f);
                        const archDir = path.join(fasePath(pipelineName, downFase), 'archivado');
                        fs.mkdirSync(archDir, { recursive: true });
                        moveFile(src, archDir);
                      }
                    }
                  } catch {}
                }
              }

              // Archivos actuales (que disparaban el rebote) → procesado
              for (const a of archivos) {
                const dest = path.join(fasePath(pipelineName, fase), 'procesado');
                try { moveFile(a.path, dest); } catch {}
              }
              continue;
            }
          }

          // #2317: clasificar el rebote. Si el motivo apunta a infra,
          // marcarlo como `rebote_tipo: infra` y NO incrementar el contador
          // efectivo del circuit breaker (se preserva el reboteCount anterior).
          //
          // #2335 CA5-CA6 — la clasificacion se hace aca (sobre `motivosClasificados`
          // derivados del pre-check y/o motivo del agente via `precheck.classifyError`),
          // NO se lee `rebote_tipo` escrito por el agente. El contador separado
          // `rebote_numero_infra` se incrementa solo cuando la clasificacion fue infra.
          const reboteTipo = esReboteDeInfra ? 'infra' : 'codigo';
          const nuevoReboteNumero = esReboteDeInfra ? reboteCount : (reboteCount + 1);
          const nuevoReboteInfraNumero = esReboteDeInfra ? (reboteInfraCount + 1) : reboteInfraCount;

          // #2374 — diferenciar destino del rebote según tipo:
          //   - codigo:  faseRechazo (dev) — el dev tiene que corregir el código.
          //   - infra:   MISMA fase — el watchdog/timeout/crash es transitorio,
          //              no hay defecto de código que corregir, sólo reintentar.
          //
          // Incidente que motivó esta separación: delivery de #2159 murió por
          // timeout esperando CI (OWASP ~28min). PR ya estaba creado con
          // checks pass, pero el pipeline devolvió el issue a dev como si
          // backend-dev hubiera fallado → re-run completo (horas de cómputo
          // duplicado: backend-dev + builder + tester + qa + review + delivery).
          //
          // Estrategia de skills destino (ver .pipeline/lib/rebote-destino.js
          // para el contrato puro testeable):
          //   - dev/build/entrega: fases mono-skill. Re-encolamos ese único skill.
          //     Para `dev`, determinarDevSkill resuelve por labels del issue.
          //   - validación/verificación/aprobación: fases paralelas multi-skill.
          //     Re-encolamos TODOS los skills_por_fase porque los archivos en
          //     listo/ de skills que aprobaron se mueven a procesado/ al final
          //     del barrido (línea 3547). Si re-encoláramos solo el skill que
          //     falló por infra, la próxima evaluación quedaría incompleta para
          //     siempre (faltarían los listo/ de los demás skills_requeridos).
          const { faseDestino, skillsDestino } = resolveReboteDestino({
            esReboteDeInfra,
            fase,
            faseRechazo,
            skillsPorFase: pipelineConfig.skills_por_fase || {},
            determinarDevSkill,
            rechazados,
            issue,
            config,
            skillFromFile,
          });

          const destinoPendiente = path.join(fasePath(pipelineName, faseDestino), 'pendiente');

          // #2333: sanitizar el motivo de rechazo antes de persistirlo en
          // el YAML del archivo de trabajo. Esto evita que un log con
          // tokens/JWT/PEM termine en el próximo archivo que se lee y
          // potencialmente viaja a comentarios del issue.
          // #2335: contador separado `rebote_numero_infra` se escribe solo
          // cuando hubo al menos un rebote infra clasificado.
          const yamlOut = {
            issue: parseInt(issue),
            fase: faseDestino,
            pipeline: pipelineName,
            rebote: true,
            rebote_numero: nuevoReboteNumero,
            rebote_tipo: reboteTipo,
            motivo_rechazo: sanitizePipelineText(motivos),
            rechazado_en_fase: fase,
          };
          if (nuevoReboteInfraNumero > 0) {
            yamlOut.rebote_numero_infra = nuevoReboteInfraNumero;
          }
          for (const skill of skillsDestino) {
            const destinoFile = path.join(destinoPendiente, `${issue}.${skill}`);
            writeYaml(destinoFile, yamlOut);
          }

          if (esReboteDeInfra) {
            const skillsStr = skillsDestino.join(',') || '(ninguno)';
            log('barrido', `#${issue} RECHAZADO en ${fase} por INFRA → REENCOLADO en MISMA fase '${faseDestino}' [${skillsStr}] (rebote_numero_infra=${nuevoReboteInfraNumero}/${MAX_REBOTES_INFRA} — NO cuenta contra circuit breaker generico, NO devuelto a dev)`);
            ghCommentOnIssue(
              issue,
              `🚫 Rebote clasificado como infra (#2374) — reintentando en \`${faseDestino}\` sin devolver a \`dev\` (el código no falló, sólo timeout/crash/watchdog). No cuenta contra el circuit breaker de código.`,
            );
          } else {
            log('barrido', `#${issue} RECHAZADO en ${fase} → devuelto a ${faseDestino} (rebote ${nuevoReboteNumero}/${MAX_REBOTES})`);
          }

          // CLEANUP DOWNSTREAM: limpiar archivos residuales del issue en fases posteriores.
          // Sin esto, archivos de aprobacion/listo/ de un ciclo anterior sobreviven al rechazo
          // y el barrido los promueve a entrega — el issue sale a delivery sin QA pasado.
          // (Incidente #2043: delivery se lanzó con QA rechazado.)
          for (let downstream = i + 1; downstream < fases.length; downstream++) {
            const downFase = fases[downstream];
            for (const estado of ['pendiente', 'trabajando', 'listo']) {
              const dir = path.join(fasePath(pipelineName, downFase), estado);
              try {
                for (const f of fs.readdirSync(dir)) {
                  if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                    const src = path.join(dir, f);
                    const archDir = path.join(fasePath(pipelineName, downFase), 'archivado');
                    fs.mkdirSync(archDir, { recursive: true });
                    moveFile(src, archDir);
                    log('barrido', `#${issue} cleanup downstream: ${downFase}/${estado}/${f} → archivado/`);
                  }
                }
              } catch {}
            }
          }
        } else if (i < fases.length - 1) {
          // Todos aprobaron → promover a siguiente fase
          // (#2305) Cualquier éxito = la red funciona: resetear contador del CB de infra.
          resetInfraCounterOnSuccess();
          const siguienteFase = fases[i + 1];
          const siguientePendiente = path.join(fasePath(pipelineName, siguienteFase), 'pendiente');
          const siguienteSkills = pipelineConfig.skills_por_fase[siguienteFase] || [];

          // #3383 — Gate visual pre-promoción build → verificacion.
          // Si el flag PIPELINE_VISUAL_GATE_ENABLED=1 y el issue tiene labels
          // app:* sin sección "Screenshots & Mockups" con 2+ imágenes:
          //   - NO se promueve a verificacion.
          //   - Se postea (idempotentemente) el comment de bloqueo en GitHub.
          //   - Se aplica el label needs:visual-baseline.
          //   - Los archivos de build/listo/ se archivan (no reintenta el loop).
          // Default OFF: el flag está en 0 mientras #3381 no esté en main.
          if (visualGate.shouldEvaluateVisualGate({
            pipelineName,
            fromFase: fase,
            toFase: siguienteFase,
            labels: getIssueInfo(issue).labels,
          })) {
            // Refetch body+comments con caller sync. Usamos el helper local
            // execSync de gh para no acoplar el barrido a callsAsync.
            let issueBodyVG = '';
            let issueLabelsVG = getIssueInfo(issue).labels;
            let issueCommentsVG = [];
            try {
              ghThrottle();
              const rawVG = execSync(
                `"${GH_BIN}" issue view ${issue} --json body,labels,comments`,
                { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
              );
              const parsedVG = JSON.parse(rawVG || '{}');
              issueBodyVG = typeof parsedVG.body === 'string' ? parsedVG.body : '';
              issueLabelsVG = Array.isArray(parsedVG.labels) ? parsedVG.labels : issueLabelsVG;
              issueCommentsVG = Array.isArray(parsedVG.comments) ? parsedVG.comments : [];
            } catch (e) {
              log('barrido', `#${issue} visual-gate: fetch falló (${e.message}) — fail-OPEN, sigue promoción normal`);
            }
            if (issueBodyVG) {
              const decision = visualGate.evaluateVisualGate({
                body: issueBodyVG,
                labels: issueLabelsVG,
              });
              if (!decision.ok) {
                const ev = visualGate.buildGateBlockEvent({
                  issue,
                  reason: decision.reason,
                  images: decision.images,
                });
                log('barrido', `🔴 visual-gate-block #${issue} reason=${ev.reason} images=${ev.images} ${JSON.stringify(ev)}`);

                // Idempotencia (CA-UX-2): no duplicar comment si ya está posteado.
                if (!visualGate.commentMarkerPresent(issueCommentsVG)) {
                  try {
                    const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                    fs.mkdirSync(ghQueueDir, { recursive: true });
                    fs.writeFileSync(
                      path.join(ghQueueDir, `${issue}-visual-gate-comment-${Date.now()}.json`),
                      JSON.stringify({
                        action: 'comment',
                        issue: parseInt(issue),
                        body: visualGate.buildBlockComment(),
                      }),
                    );
                  } catch (e) {
                    log('barrido', `Error encolando visual-gate comment #${issue}: ${e.message}`);
                  }
                } else {
                  log('barrido', `#${issue} visual-gate-block — marker ya presente, skip duplicado`);
                }

                // Aplicar label needs:visual-baseline (idempotente desde GH side).
                try {
                  const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
                  fs.mkdirSync(ghQueueDir, { recursive: true });
                  fs.writeFileSync(
                    path.join(ghQueueDir, `${issue}-visual-gate-label-${Date.now()}.json`),
                    JSON.stringify({
                      action: 'label',
                      issue: parseInt(issue),
                      label: visualGate.NEEDS_VISUAL_BASELINE_LABEL,
                    }),
                  );
                } catch (e) {
                  log('barrido', `Error encolando visual-gate label #${issue}: ${e.message}`);
                }

                // Archivar archivos evaluados (build/listo/<issue>.*) — no se promueve.
                for (const a of archivos) {
                  try { moveFile(a.path, procesadoDir); } catch {}
                }
                // Skip el resto del bloque de promoción: continuar con el próximo issue.
                continue;
              } else if (decision.reason === 'qa-skipped') {
                log('barrido', `#${issue} visual-gate bypass (qa:skipped)`);
              } else {
                log('barrido', `#${issue} visual-gate ✓ images=${decision.images} — promueve a verificacion`);
              }
            }
          }

          if (siguienteFase === 'dev' || siguienteFase === 'build' || siguienteFase === 'entrega') {
            // Fase de un solo skill
            const skill = siguienteFase === 'dev'
              ? determinarDevSkill(issue, config)
              : siguienteSkills[0];
            const newFile = path.join(siguientePendiente, `${issue}.${skill}`);
            writeYaml(newFile, {
              issue: parseInt(issue),
              fase: siguienteFase,
              pipeline: pipelineName
            });
          } else {
            // Fase paralela: crear archivo por cada skill
            for (const skill of siguienteSkills) {
              const newFile = path.join(siguientePendiente, `${issue}.${skill}`);
              writeYaml(newFile, {
                issue: parseInt(issue),
                fase: siguienteFase,
                pipeline: pipelineName
              });
            }
          }

          // #3481 — Si la promoción consideró artefactos varados en procesado/,
          // logueamos el origen por skill para facilitar forensics futuras (CA-8).
          const origenInfo = phaseCompletion.formatOrigenLog(origenPorSkill);
          if (origenInfo) {
            log('barrido', `#${issue} ${fase} ✓ → promovido a ${siguienteFase} (mezcla listo/+procesado/: ${origenInfo})`);
          } else {
            log('barrido', `#${issue} ${fase} ✓ → promovido a ${siguienteFase}`);
          }
        } else {
          // Última fase completada — historia terminada
          // (#2305) Éxito end-to-end: resetear contador del CB de infra.
          resetInfraCounterOnSuccess();
          log('barrido', `#${issue} COMPLETADO — salió del pipeline ${pipelineName}`);

          // Si es pipeline de definición → agregar label "Ready" para que desarrollo lo tome.
          // Case-sensitive: el repo usa "Ready" (uppercase). Si se escribe "ready",
          // el intake de desarrollo no lo va a encontrar (gh issue list es
          // case-sensitive en --label). Ver fix #2801 / PR #2827.
          if (pipelineName === 'definicion') {
            // #3614 — Gate architect-signoff (B3 del paraguas #3559).
            // Se invoca JUSTO antes del enqueueing del label "Ready"
            // (hallazgo R1 del análisis guru: NO en servicio-github.js, que
            // es worker downstream). Cuando `architect.enabled !== true` el
            // módulo cortocircuita (kill switch R6 / CA-14) y devuelve
            // approve sin escribir nada en JSONL.
            //
            // En modo dry-run el gate logguea pero NUNCA bloquea (CA-5);
            // sólo en `enforce` un veredicto block impide el enqueueing.
            let architectGateBlocked = false;
            try {
              const architectCfg = (config && config.architect) || {};
              if (architectCfg.enabled === true) {
                const architectGate = require('./lib/architect-signoff-gate');
                // Cargar body + comments del issue. Reutilizamos `gh` con
                // timeout corto: el barrido no debe quedar colgado por red.
                let issueJson = null;
                try {
                  const raw = execSync(`${GH_BIN} issue view ${issue} --json number,body,createdAt,comments`,
                    { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true });
                  issueJson = JSON.parse(raw);
                } catch (e) {
                  log('barrido', `#${issue} architect-gate: ERROR cargando issue (${e.message}) — gate mode=${architectCfg.gate_mode}`);
                  if (architectCfg.gate_mode === 'enforce') {
                    architectGateBlocked = true;
                    sendTelegram(`🛑 #${issue} architect-gate (enforce) bloqueó promoción por error de carga: ${e.message}`);
                  }
                }
                if (issueJson) {
                  const gateResult = architectGate.evaluate({
                    issue: { number: issueJson.number, createdAt: issueJson.createdAt },
                    body: issueJson.body,
                    comments: issueJson.comments || [],
                    config: architectCfg,
                  });
                  // En `enforce`, un block efectivo paraliza la promoción.
                  // En `dry-run`, decision siempre llega como 'approve' (R3).
                  if (gateResult.decision === 'block') {
                    architectGateBlocked = true;
                    log('barrido', `#${issue} architect-gate BLOQUEÓ promoción (mode=${gateResult.gate_mode}): ${gateResult.reason}`);
                    sendTelegram(`🛑 #${issue} architect-gate bloqueó promoción a Ready: ${gateResult.reason}`);
                  } else {
                    log('barrido', `#${issue} architect-gate ${gateResult.gate_mode}: ${gateResult.original_decision} (efectivo=${gateResult.decision}) — ${gateResult.reason}`);
                  }
                }
              }
            } catch (e) {
              // Defensa última: si el gate revienta con un bug, NO debe
              // tumbar al pulpo. En enforce avisamos por Telegram y
              // bloqueamos (fail-cerrado); en dry-run logueamos y seguimos.
              const archMode = (config && config.architect && config.architect.gate_mode) || 'dry-run';
              log('barrido', `#${issue} architect-gate ERROR inesperado: ${e.message} (mode=${archMode})`);
              if (archMode === 'enforce') {
                architectGateBlocked = true;
                sendTelegram(`🛑 #${issue} architect-gate ERROR inesperado (enforce → bloquea): ${e.message}`);
              }
            }

            if (architectGateBlocked) {
              // Saltamos el enqueueing del label Ready. El issue queda en
              // estado completado del pipeline definicion pero sin promoción
              // efectiva. La nueva pasada del architect (re-firma con marker
              // + signoff en tokens.jsonl) destraba en barridos posteriores.
              continue;
            }

            const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
            const labelFile = path.join(ghQueueDir, `${issue}-ready-${Date.now()}.json`);
            fs.writeFileSync(labelFile, JSON.stringify({ action: 'label', issue: parseInt(issue), label: 'Ready' }));
            log('barrido', `#${issue} → encolado label "Ready" en servicio-github`);

            // También remover label needs-definition
            const rmLabelFile = path.join(ghQueueDir, `${issue}-rm-ndef-${Date.now()}.json`);
            fs.writeFileSync(rmLabelFile, JSON.stringify({ action: 'remove-label', issue: parseInt(issue), label: 'needs-definition' }));
          }

          // Si es pipeline de desarrollo → notificar por telegram con estado
          // real del PR (#3030). Antes mandaba siempre "Listo para merge" sin
          // verificar — confuso porque muchos PRs ya estaban mergeados, otros
          // tenían checks pendientes o estaban cerrados sin merge.
          if (pipelineName === 'desarrollo') {
            try {
              const { fetchPrInfoForIssue } = require('./lib/pr-info-fetcher');
              const { buildCompletionMessage, summarizePrInfoForLog } = require('./lib/pr-status-message');
              const prInfo = fetchPrInfoForIssue(issue, { ghBin: GH_BIN, cwd: ROOT, timeoutMs: 5000 });
              const { text, replyMarkup } = buildCompletionMessage(issue, prInfo);
              if (replyMarkup) sendTelegramWithMarkup(text, replyMarkup);
              else sendTelegram(text);
              const sum = summarizePrInfoForLog(prInfo);
              log('barrido', `#${issue} notificación cierre — prState=${sum.prState} rollupState=${sum.rollupState} prUrl=${sum.prUrl || '-'}`);
            } catch (e) {
              // Defensa última: si algo falla en el helper, mandamos el texto
              // legacy + sufijo. Nunca dejar al issue sin notificación.
              log('barrido', `#${issue} ERROR resolviendo prState: ${e.message}`);
              sendTelegram(`✅ #${issue} completó el pipeline de desarrollo. (estado del PR no verificable)`);
            }
          }

          // Cleanup: eliminar worktree del issue si existe
          try {
            const wtList = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true });
            const wtPattern = `platform.agent-${issue}-`;
            for (const line of wtList.split('\n')) {
              if (line.startsWith('worktree ') && line.includes(wtPattern)) {
                const wtPath = line.replace('worktree ', '').trim();
                execSync(`git worktree remove "${wtPath}" --force`, { cwd: ROOT, timeout: 30000, windowsHide: true });
                log('barrido', `Worktree eliminado: ${wtPath}`);
              }
            }
          } catch (e) {
            log('barrido', `Error limpiando worktree de #${issue}: ${e.message}`);
          }
        }

        // #3414 — Notificación Telegram de entregables del pipeline.
        // Se invoca SOLO en el camino "todos aprobaron" — los caminos de rebote
        // hacen `continue` mucho antes y nunca llegan acá. Default OFF en
        // config.yaml. try/catch defensivo: cualquier fallo se loguea pero NUNCA
        // bloquea el `moveFile` a procesado/ (CA-FN-8 zero-blocking).
        try {
          const notifyCfg = (config && config.deliverable_notifications) || {};
          if (notifyCfg.enabled === true && notifyCfg.kill_switch !== true) {
            const telegramQueueDir = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');
            const titleCached = getIssueTitleCached(issue);
            for (const r of resultados) {
              if (r.resultado !== 'aprobado') continue;
              // skill viene del NOMBRE DEL ARCHIVO, no del YAML editable (CA-SEC-2)
              const notifySkill = skillFromFile(r.file.name);

              // #3647 — CA-2: barrer disco buscando entregables por skill y
              // fusionarlos en `yaml.attachments` antes de notificar. El helper
              // es issue-scoped (CA-1.4) y nunca tira; si no encuentra nada
              // devuelve []. La validación final (path traversal, magic bytes,
              // allowlist) la hace `deliverable-notify.resolveAttachments`.
              try {
                const fsAttachments = skillDeliverableAttachments.collectAttachmentsForSkill(
                  notifySkill, issue, fase, { pipelineRoot: ROOT },
                );
                if (Array.isArray(fsAttachments) && fsAttachments.length > 0) {
                  const existing = Array.isArray(r.attachments) ? r.attachments.slice() : [];
                  const seenPaths = new Set(existing.map((a) => (a && a.path) || ''));
                  for (const a of fsAttachments) {
                    if (a && !seenPaths.has(a.path)) {
                      existing.push(a);
                      seenPaths.add(a.path);
                    }
                  }
                  r.attachments = existing;
                  log('barrido', `📎 #${issue} attachments por skill ${notifySkill}: ${fsAttachments.length} (helper)`);
                }
              } catch (e) {
                // Nunca bloquear notify por un fallo del helper.
                log('barrido', `📎 #${issue} helper attachments error (${notifySkill}): ${e.message}`);
              }

              const result = deliverableNotify.notify({
                issue,
                skill: notifySkill,
                fase,
                pipeline: pipelineName,
                yaml: r,
                title: titleCached,
                config: notifyCfg,
                pipelineRoot: ROOT,
                telegramQueueDir,
              });
              if (result.ok) {
                log('barrido', `📨 #${issue} notify deliverable → ${notifySkill}/${fase}`);
                // #3539 (CA-UX-9 / CA-FN-3) — audio TTS fire-and-forget.
                // `audioTask` es una Promise<auditPatch|null> que ya tiene
                // .catch interno; la enganchamos para loguear, pero NO la
                // awaitamos (mantiene non-blocking real del barrido).
                if (result.audioTask && typeof result.audioTask.then === 'function') {
                  result.audioTask.then((patch) => {
                    if (patch && patch.audio_error) {
                      const code = patch.audio_error.code || 'ERR';
                      log('barrido', `🎙️ #${issue} audio TTS falló (${notifySkill}): ${code}`);
                    } else if (patch && Array.isArray(patch.audio_file_paths)) {
                      const n = patch.audio_file_paths.length;
                      const trunc = patch.audio_truncated ? ' (truncado a 3)' : '';
                      log('barrido', `🎙️ #${issue} audio TTS enviado → ${notifySkill} (${n} chunk${n === 1 ? '' : 's'}${trunc})`);
                    }
                  }).catch(() => {/* ya capturado dentro del módulo */});
                }
              } else if (result.action === 'skipped' && result.reason !== 'skill_not_notifiable' && result.reason !== 'disabled') {
                // dedup, kill_switch, etc → log de visibilidad operacional
                log('barrido', `📨 #${issue} notify skipped (${notifySkill}/${fase}): ${result.reason}`);
              } else if (result.action === 'error') {
                log('barrido', `📨 notify falló #${issue}/${notifySkill}: ${result.reason}`);
              }
            }
          }
        } catch (e) {
          // Defensa última: zero impact en happy path del barrido (CA-FN-8).
          log('barrido', `📨 notify excepción #${issue}/${fase}: ${e.message}`);
        }

        // Mover todos los archivos evaluados a procesado/
        for (const a of archivos) {
          moveFile(a.path, procesadoDir);
        }
      }
    }
  }
}

/** Determinar qué skill de dev corresponde a un issue (por labels de GitHub).
 *
 * Cuando el issue tiene múltiples labels de dominio (ej. `area:infra` + `app:client`),
 * se usa `dev_routing_priority` del config para elegir determinísticamente. Sin esto,
 * el orden dependía del orden en que GitHub devolvía los labels, y un `app:client`
 * mal puesto ruteaba issues 100% de infra del pipeline a android-dev (ej. #2328).
 *
 * Además, issues etiquetados `area:infra` cuyo título/body mencione archivos del
 * pipeline Node.js se re-rutean a `pipeline-dev` (stack correcto). Así evitamos
 * que cambios del pulpo/dashboard caigan en backend-dev (Kotlin/Gradle) que no
 * puede validarlos.
 */
function determinarDevSkill(issue, config) {
  const mapping = config.dev_skill_mapping || {};
  const labels = getIssueLabels(issue);
  const priority = config.dev_routing_priority || [];

  // 0) Override por contenido: area:infra + keywords del pipeline → pipeline-dev
  if (labels.includes('area:infra') && !labels.includes('area:pipeline') && mapping['area:pipeline']) {
    if (issueMentionsPipelineScope(issue, config)) {
      log('routing', `#${issue}: area:infra + contenido del pipeline → pipeline-dev (override)`);
      return mapping['area:pipeline'];
    }
  }

  // 1) Prioridad explícita de dominio: `area:pipeline`/`area:*` gana sobre `app:*` cuando coexisten.
  for (const priorityLabel of priority) {
    if (labels.includes(priorityLabel) && mapping[priorityLabel]) {
      return mapping[priorityLabel];
    }
  }

  // 2) Fallback: primer match directo (orden de labels de GitHub)
  for (const label of labels) {
    if (mapping[label]) return mapping[label];
  }

  return mapping.default || 'backend-dev';
}

// Cache de títulos/bodies para no golpear GitHub por cada ruteo (TTL corto)
const issueTextCache = new Map(); // issueNum → { text: string, fetchedAt: timestamp }
const ISSUE_TEXT_CACHE_TTL_MS = 10 * 60 * 1000;

function getIssueText(issueNum) {
  const cached = issueTextCache.get(issueNum);
  if (cached && (Date.now() - cached.fetchedAt) < ISSUE_TEXT_CACHE_TTL_MS) {
    return cached.text;
  }
  try {
    ghThrottle();
    const raw = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json title,body`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const { title = '', body = '' } = JSON.parse(raw);
    const text = `${title}\n${body}`.toLowerCase();
    issueTextCache.set(issueNum, { text, fetchedAt: Date.now() });
    return text;
  } catch {
    return '';
  }
}

// #3414 — Cache de títulos de issues para deliverable-notify. Reusa el patrón
// del `issueTextCache` pero guarda el título crudo (no lowercased). TTL 10min.
const issueTitleCache = new Map(); // issueNum → { title: string, fetchedAt: timestamp }
const ISSUE_TITLE_CACHE_TTL_MS = 10 * 60 * 1000;

function getIssueTitleCached(issueNum) {
  const key = String(issueNum);
  const cached = issueTitleCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < ISSUE_TITLE_CACHE_TTL_MS) {
    return cached.title;
  }
  try {
    ghThrottle();
    const raw = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json title`,
      { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const { title = '' } = JSON.parse(raw);
    issueTitleCache.set(key, { title, fetchedAt: Date.now() });
    return title;
  } catch {
    // Fallback silencioso — la notificación funciona igual sin título
    // (el helper degrada a header sin subtítulo).
    return '';
  }
}

function issueMentionsPipelineScope(issueNum, config) {
  const keywords = config.pipeline_scope_keywords || [];
  if (keywords.length === 0) return false;
  const text = getIssueText(issueNum);
  if (!text) return false;
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

// =============================================================================
// BRAZO 2: LANZAMIENTO — Detecta trabajo pendiente, lanza agentes
// =============================================================================

// Cache de labels+estado de issues (evita llamadas repetidas a GitHub API)
const issueLabelsCache = new Map(); // issueNum → { labels: [...], state: string, fetchedAt: timestamp }
const LABELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function getIssueInfo(issueNum) {
  const cached = issueLabelsCache.get(issueNum);
  if (cached && (Date.now() - cached.fetchedAt) < LABELS_CACHE_TTL_MS) {
    return cached;
  }
  try {
    ghThrottle();
    const result = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json labels,state`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    const parsed = JSON.parse(result);
    const info = {
      labels: (parsed.labels || []).map(l => l.name),
      state: parsed.state || 'UNKNOWN',
      fetchedAt: Date.now()
    };
    issueLabelsCache.set(issueNum, info);
    return info;
  } catch {
    return { labels: [], state: 'UNKNOWN', fetchedAt: Date.now() };
  }
}

function getIssueLabels(issueNum) {
  return getIssueInfo(issueNum).labels;
}

/** Verifica si un issue está cerrado en GitHub (usa cache) */
function isIssueClosed(issueNum) {
  return getIssueInfo(issueNum).state === 'CLOSED';
}

/** Calcular score de prioridad para un issue (menor = más prioritario) */
function calcularPrioridad(issueNum, config) {
  const labels = getIssueLabels(issueNum);
  const prioLabels = config.prioridad_labels || [];
  const featurePrio = config.feature_priority || {};

  // Score base: prioridad directa del label (0=critical, 1=high, 2=medium, 3=low)
  // Default: priority:medium si no tiene label explícito
  let prioScore = prioLabels.indexOf('priority:medium');
  if (prioScore === -1) prioScore = 999;
  for (let i = 0; i < prioLabels.length; i++) {
    if (labels.includes(prioLabels[i])) { prioScore = i; break; }
  }

  // Score de feature: hereda nivel de prioridad según config (critical=0, high=1, etc.)
  let featureScore = 999;
  for (const [nivel, featureLabels] of Object.entries(featurePrio)) {
    const nivelIdx = prioLabels.indexOf(`priority:${nivel}`);
    if (nivelIdx === -1) continue;
    for (const fl of featureLabels) {
      if (labels.includes(fl)) { featureScore = Math.min(featureScore, nivelIdx); break; }
    }
  }

  // Feature priority PUEDE subir la prioridad efectiva (tomar el menor de ambos)
  const effectivePrio = Math.min(prioScore, featureScore);

  // Desempate: si empatan en prioridad efectiva, preferir el que tiene feature explícita
  const tiebreaker = featureScore < 999 ? 0 : 1;

  return effectivePrio * 10 + tiebreaker;
}

/** Ordenar archivos pendientes por prioridad del issue.
 *  Fuente única de verdad: orden manual del Issue Tracker
 *  (.pipeline/issue-manual-order.json). Si un issue no tiene entrada en el orden
 *  manual, cae al cálculo legacy por labels (calcularPrioridad).
 */
function sortByPriority(archivos, config) {
  if (archivos.length <= 1) return archivos;
  let manualOrderIndex = null;
  try {
    const issueOrder = require('./lib/issue-order');
    const state = issueOrder.load();
    manualOrderIndex = new Map(state.order.map((n, i) => [String(n), i]));
  } catch {}
  return archivos.sort((a, b) => {
    const issueA = String(issueFromFile(a.name));
    const issueB = String(issueFromFile(b.name));
    if (manualOrderIndex && manualOrderIndex.size > 0) {
      const ia = manualOrderIndex.has(issueA) ? manualOrderIndex.get(issueA) : Infinity;
      const ib = manualOrderIndex.has(issueB) ? manualOrderIndex.get(issueB) : Infinity;
      if (ia !== ib) return ia - ib; // index menor = prioritario primero
    }
    return calcularPrioridad(issueA, config) - calcularPrioridad(issueB, config);
  });
}

/**
 * Rebotar verificación→build cuando preflight detecta APK faltante.
 *
 * Patrón genérico: archiva todos los hermanos de verificacion/pendiente/<issue>.* a
 * procesado/ con resultado: rechazado, y encola un <issue>.build fresco en build/pendiente/.
 * Idempotente: si ya hay un build en curso/encolado para el issue, no duplica.
 * Circuit breaker MAX_REBOTES_APK protege contra loops verificacion↔build.
 *
 * Esta función fue extraída del dispatcher para que también la pueda invocar el
 * deadlock breaker — sin esto, cuando el gate predictivo bloquea preflight (path
 * normal) o cuando el deadlock breaker fuerza preflight, el rebote no corría y el
 * issue quedaba atascado eternamente en verificacion/pendiente/.
 *
 * Llamada por:
 *   - dispatcher normal en brazoLanzamiento (path verificacion + apk_missing)
 *   - deadlock breaker (Tier 2 forzado + apk_missing)
 *
 * @returns {boolean} true si rebote ejecutado, false si circuit breaker disparado
 *                    (en cuyo caso los archivos quedan archivados pero NO se encola build)
 */
function reboteVerificacionABuild(issue, pipelineName, preflightResult) {
  const MAX_REBOTES_APK = 3;

  try {
    const verPendDir = path.join(fasePath(pipelineName, 'verificacion'), 'pendiente');
    const verProcDir = path.join(fasePath(pipelineName, 'verificacion'), 'procesado');
    const buildPendDir = path.join(fasePath(pipelineName, 'build'), 'pendiente');
    const buildTrabDir = path.join(fasePath(pipelineName, 'build'), 'trabajando');
    const buildListoDir = path.join(fasePath(pipelineName, 'build'), 'listo');
    const buildProcDir = path.join(fasePath(pipelineName, 'build'), 'procesado');
    const buildFileName = `${issue}.build`;

    // Recolectar TODOS los archivos del issue en verificacion/pendiente/
    const archivosVerificacion = listWorkFiles(verPendDir).filter(f => issueFromFile(f.name) === issue);

    // Calcular rebote_numero: máximo entre archivos actuales y builds previos del issue
    let reboteCount = 0;
    for (const f of archivosVerificacion) {
      const data = readYaml(f.path);
      if (data.rebote_numero && data.rebote_numero > reboteCount) reboteCount = data.rebote_numero;
    }
    for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
      const prevBuild = path.join(fasePath(pipelineName, 'build'), estado, buildFileName);
      if (fs.existsSync(prevBuild)) {
        const data = readYaml(prevBuild);
        if (data.rebote_numero && data.rebote_numero > reboteCount) reboteCount = data.rebote_numero;
      }
    }

    if (reboteCount >= MAX_REBOTES_APK) {
      log('lanzamiento', `⛔ #${issue} CIRCUIT BREAKER APK — ${reboteCount} rebotes verificacion↔build. Archivando a procesado.`);
      sendTelegram(`⛔ #${issue} atascado — ${reboteCount} rebotes por APK faltante entre verificacion y build. Requiere intervención manual.`);
      for (const f of archivosVerificacion) {
        try { moveFile(f.path, verProcDir); } catch {}
      }
      return false;
    }

    // 1. Marcar rechazados y archivar a procesado/
    const motivoRechazo = `APK faltante: ${preflightResult?.reason || 'preflight QA no encontró APK del build'}`;
    for (const f of archivosVerificacion) {
      try {
        const data = readYaml(f.path);
        writeYaml(f.path, {
          ...data,
          resultado: 'rechazado',
          motivo: motivoRechazo,
          rechazado_en_fase: 'verificacion',
          rechazado_por: 'preflight-apk',
          rebote_a: 'build',
          rebote_numero: reboteCount + 1,
          rechazado_ts: new Date().toISOString(),
        });
        moveFile(f.path, verProcDir);
      } catch (moverErr) {
        log('lanzamiento', `⚠️ #${issue}: no se pudo archivar ${f.name}: ${moverErr.message}`);
      }
    }

    // 2. Encolar build (idempotente — si ya hay uno en vuelo/encolado, no duplicar)
    const yaEncolado =
      fs.existsSync(path.join(buildPendDir, buildFileName)) ||
      fs.existsSync(path.join(buildTrabDir, buildFileName)) ||
      fs.existsSync(path.join(buildListoDir, buildFileName));

    if (!yaEncolado) {
      const payload = {
        issue: parseInt(issue),
        fase: 'build',
        pipeline: pipelineName,
        motivo: 'APK faltante detectado por preflight QA',
        rebote: true,
        rebote_numero: reboteCount + 1,
        rechazado_en_fase: 'verificacion',
      };
      const procFile = path.join(buildProcDir, buildFileName);
      if (fs.existsSync(procFile)) {
        writeYaml(procFile, payload);
        moveFile(procFile, buildPendDir);
        log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build re-encolado desde procesado (rebote ${reboteCount + 1}/${MAX_REBOTES_APK})`);
      } else {
        writeYaml(path.join(buildPendDir, buildFileName), payload);
        log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build nuevo encolado (rebote ${reboteCount + 1}/${MAX_REBOTES_APK})`);
      }
      ghCommentOnIssue(issue, `⏪ La verificación detectó APK faltante. Issue devuelto automáticamente a la fase build para re-generar el APK.`);
    } else {
      log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build ya en curso/encolado`);
    }
    return true;
  } catch (reencolarErr) {
    log('lanzamiento', `⚠️ #${issue}: no se pudo rebotar verificación→build — ${reencolarErr.message}`);
    return false;
  }
}

function brazoLanzamiento(config) {
  // Circuit breaker de infra (#2305): si está abierto, no tomar nuevos issues.
  // Se reabre manualmente con `node .pipeline/resume.js` una vez validada la red.
  if (cbInfra.isOpen()) {
    return;
  }

  // Limpieza proactiva periódica (cada N ciclos, sin importar presión)
  proactiveCleanup(config);

  // Priority windows ya evaluadas en mainLoop (corren incluso pausado).
  // Leer estado actual desde variables de módulo.
  const qaPriority = qaPriorityActive;
  const buildPriority = buildPriorityActive;

  // GATE DE RECURSOS: presión graduada (green/yellow/orange/red)
  if (isSystemOverloaded(config)) return;

  // Calcular multiplicador de concurrencia según presión actual
  const pressure = getResourcePressure(config);
  const multiplier = concurrencyMultiplier(pressure.level);

  // Fases bloqueadas según ventana activa (autoexcluyentes: QA > Build > Dev)
  // QA Priority: bloquea dev + validacion + build (QA necesita recursos exclusivos)
  // Build Priority: bloquea dev + validacion (build corre, QA sigue si hay)
  const DEV_PHASES = ['dev', 'validacion'];
  const QA_BLOCKED_PHASES = ['dev', 'validacion', 'build']; // QA bloquea también build

  // --- PIEZA 2+3: Recolectar TODOS los pendientes de TODAS las fases ---
  // En vez de iterar fase por fase (que prioriza fases avanzadas),
  // juntamos todo y ordenamos por: feature priority > fase inversa.
  const candidates = [];

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    const fases = pipelineConfig.fases;
    for (let faseIdx = 0; faseIdx < fases.length; faseIdx++) {
      const fase = fases[faseIdx];

      // PRIORITY WINDOWS (autoexcluyentes): QA bloquea dev+build, Build bloquea solo dev
      if (qaPriority && QA_BLOCKED_PHASES.includes(fase)) continue;
      if (buildPriority && !qaPriority && DEV_PHASES.includes(fase)) continue;

      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const archivos = listWorkFiles(pendienteDir);

      for (const archivo of archivos) {
        candidates.push({
          archivo,
          pipelineName,
          fase,
          faseIdx,  // Índice original de la fase (para orden inverso)
          totalFases: fases.length,
        });
      }
    }
  }

  // Ordenar candidatos: feature priority (menor=mejor) > fase inversa (mayor idx=más avanzada=primero)
  candidates.sort((a, b) => {
    const issueA = issueFromFile(a.archivo.name);
    const issueB = issueFromFile(b.archivo.name);
    const prioA = calcularPrioridad(issueA, config);
    const prioB = calcularPrioridad(issueB, config);

    // Primer criterio: prioridad de feature (menor = más prioritario)
    if (prioA !== prioB) return prioA - prioB;

    // Segundo criterio (desempate): fase inversa — fases más avanzadas primero
    // faseIdx mayor = fase más avanzada = debe procesarse antes
    return b.faseIdx - a.faseIdx;
  });

  // --- Procesar candidatos en orden unificado ---
  let anyLaunched = false;
  let gateBlockedCount = 0;       // Candidatos bloqueados específicamente por el gate predictivo
  let eligibleForGateCount = 0;   // Candidatos que llegaron hasta el gate (pasaron dedup/cooldown/concurrencia)
  const gateBlockedCandidates = []; // Para el deadlock breaker

  for (const candidate of candidates) {
    const { archivo, pipelineName, fase } = candidate;
    const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
    const skill = skillFromFile(archivo.name);
    const issue = issueFromFile(archivo.name);
    const key = processKey(skill, issue);

    // 0. Defensa contra archivos evaporados — el procesamiento previo de otro candidate
    //    del mismo issue (p.ej. rebote por APK faltante que archiva todos los hermanos
    //    de verificacion/pendiente/ en el primer match) pudo haber movido este archivo.
    //    Sin este check el siguiente iteration explota al intentar moverlo.
    if (!fs.existsSync(archivo.path)) continue;

    // 0a. PARTIAL PAUSE (#2490): si hay allowlist activa, saltar issues fuera de ella.
    // El archivo se queda en pendiente/ — no se archiva ni penaliza.
    if (!partialPause.isIssueAllowed(issue)) {
      const mode = partialPause.getPipelineMode();
      if (mode.mode === 'partial_pause') {
        log('lanzamiento', `#${issue} skipped by partial_pause (allowed: ${mode.allowedIssues.map(i => `#${i}`).join(', ')})`);
      }
      continue;
    }

    // Labels del issue: se consumen en el gate de modo descanso (#2890) y
    // luego en BLOCKED / NEEDS-HUMAN. Una sola lectura por iteración.
    const issueLbls = getIssueLabels(issue);

    // 0a-bis. MODO DESCANSO (#2890 PR-A): si la ventana horaria está activa y
    // el skill no es determinístico ni el issue tiene bypass label, saltar.
    // El archivo se queda en pendiente/ sin penalizar (CA-1.5). Cuando la
    // ventana cierre, el siguiente tick del pulpo lo lanza respetando
    // concurrencia (CA-1.8).
    try {
      const restCfg = (loadConfig() || {}).rest_mode || {};
      const verdict = restModeWindow.isSkillAllowedNow(skill, Date.now(), {
        cfg: restCfg,
        bypassLabels: issueLbls,
        pipelineDir: PIPELINE,
      });
      if (!verdict.allowed) {
        log('lanzamiento', `#${issue} skipped by rest-mode (skill=${skill}, reason=${verdict.reason})`);
        continue;
      }
    } catch (e) {
      // Fail-open: si el gate falla, no bloqueamos el pipeline. El pipeline
      // no puede morir por un bug en este módulo.
      log('lanzamiento', `rest-mode gate error (fail-open): ${e.message}`);
    }

    // 0b. BLOCKED: no lanzar issues con blocked:dependencies
    //
    // #3229 — Simetría con la rama needs-human de más abajo: si el label se
    // aplicó DESPUÉS de que el archivo entró a pendiente/ (ej. label puesto
    // a mano o por servicio-github post-intake), movemos el archivo a
    // `bloqueado-dependencias/` para que el dashboard lo vea segregado y
    // el brazoDesbloqueo pueda devolverlo a pendiente/ al destrabar.
    if (issueLbls.includes('blocked:dependencies')) {
      try {
        const blockedDepDir = path.join(fasePath(pipelineName, fase), 'bloqueado-dependencias');
        fs.mkdirSync(blockedDepDir, { recursive: true });
        const targetFile = path.join(blockedDepDir, archivo.name);
        if (!fs.existsSync(targetFile)) {
          try { fs.renameSync(archivo.path, targetFile); }
          catch {
            try { fs.copyFileSync(archivo.path, targetFile); fs.unlinkSync(archivo.path); } catch {}
          }
          // Dejar .reason.json mínimo si no existía — el brazoDesbloqueo lo
          // necesita para saber a qué fase devolver el archivo al destrabar.
          const reasonFile = targetFile + '.reason.json';
          if (!fs.existsSync(reasonFile)) {
            try {
              fs.writeFileSync(reasonFile, JSON.stringify({
                issue: parseInt(issue),
                skill: skillFromFile(archivo.name),
                phase: fase,
                pipeline: pipelineName,
                depends_on: [],
                reason: 'Label blocked:dependencies aplicado en GitHub — pipeline pausa hasta que el brazoDesbloqueo verifique que todas las deps cerraron.',
                blocked_at: new Date().toISOString(),
              }, null, 2));
            } catch {}
          }
          log('lanzamiento', `🪢 #${issue} movido a bloqueado-dependencias/ (label blocked:dependencies aplicado post-intake)`);
        }
      } catch (e) {
        log('lanzamiento', `[WARN] #${issue} no se pudo mover a bloqueado-dependencias/: ${e.message}`);
      }
      log('lanzamiento', `#${issue} omitido — blocked:dependencies`);
      continue;
    }

    // 0b-bis. NEEDS-HUMAN (#2549): si el issue tiene label needs-human, no
    // lanzar el skill. El intake ya excluye con `-label:needs-human`, pero el
    // label puede aplicarse después de que el archivo entró a pendiente/.
    // Movemos el archivo a `bloqueado-humano/` (mismo subdir que reportHumanBlock)
    // para que el dashboard lo vea como bloqueado y NO lo retomamos hasta que
    // un humano remueva el label (entonces el intake genera un archivo fresco).
    if (issueLbls.includes('needs-human') || issueLbls.includes('needs:human')) {
      const blockedDir = path.join(fasePath(pipelineName, fase), 'bloqueado-humano');
      try { fs.mkdirSync(blockedDir, { recursive: true }); } catch {}
      const targetFile = path.join(blockedDir, archivo.name);
      const reasonFile = targetFile + '.reason.json';
      const yaTeniaReason = fs.existsSync(reasonFile);
      // Persistir reason mínima para que listBlockedIssues() lo muestre con contexto.
      const reasonTxt = 'Label needs-human aplicado en GitHub — pipeline pausa el skill hasta que un humano remueva el label.';
      const questionTxt = `¿Podés revisar #${issue} y quitar el label \`needs-human\` cuando esté listo para reentrar?`;
      if (!yaTeniaReason) {
        try {
          fs.writeFileSync(reasonFile, JSON.stringify({
            issue: parseInt(issue),
            skill,
            phase: fase,
            pipeline: pipelineName,
            reason: reasonTxt,
            question: questionTxt,
            blocked_at: new Date().toISOString(),
          }, null, 2));
        } catch {}
      }
      try { moveFile(archivo.path, blockedDir); } catch {}
      log('lanzamiento', `🚧 #${issue} omitido — label needs-human. Movido a ${pipelineName}/${fase}/bloqueado-humano/`);
      // Notificar Telegram solo la primera vez (dedup por reasonFile pre-existente).
      if (!yaTeniaReason) {
        try {
          const summary = humanBlock.buildBlockedSummaryMarkdown({
            highlight: { issue: parseInt(issue), skill, reason: reasonTxt, question: questionTxt },
          });
          sendTelegram(summary);
        } catch (e) {
          log('lanzamiento', `Error enviando resumen Telegram needs-human #${issue}: ${e.message}`);
        }
      }
      continue;
    }

    // 0c. CLOSED: no lanzar issues cerrados en GitHub — archivar y seguir
    if (isIssueClosed(issue)) {
      log('lanzamiento', `#${issue} omitido — issue cerrado en GitHub, archivando`);
      const archDir = path.join(fasePath(pipelineName, fase), 'archivado');
      fs.mkdirSync(archDir, { recursive: true });
      moveFile(archivo.path, archDir);
      continue;
    }

    // 1. DEDUP: ¿ya hay un agente activo para este ISSUE (cualquier skill) en trabajando/?
    const issueAlreadyWorking = listWorkFiles(trabajandoDir).some(f => issueFromFile(f.name) === issue);
    if (issueAlreadyWorking) continue;

    // 2. COOLDOWN: ¿este issue+skill está penalizado por fallos previos?
    if (isInCooldown(skill, issue)) continue;

    // 3. Ya hay un proceso activo para este skill+issue en memoria?
    if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
      continue;
    }

    // 4. Verificar concurrencia del rol — ADAPTATIVA según presión de recursos
    const baseMax = (config.concurrencia || {})[skill] || 1;
    const maxConcurrencia = Math.max(1, Math.floor(baseMax * multiplier));
    const running = countRunningBySkill(skill);
    if (running >= maxConcurrencia) continue;

    // 5a. Límite de builds bajo presión — en YELLOW solo 1 build simultáneo
    // Esto previene que múltiples builds saturen la RAM y lleven al sistema a RED
    if (fase === 'build' && (pressure.level === PRESSURE_LEVELS.YELLOW || pressure.level === PRESSURE_LEVELS.ORANGE)) {
      const runningBuilds = countRunningBuild(config);
      if (runningBuilds >= 1) {
        log('lanzamiento', `⚠️ ${pressure.level.toUpperCase()} — ${runningBuilds} build(s) en curso, postergando build de #${issue} para no saturar`);
        continue;
      }
    }

    // 5b. PIEZA 1: Límite global de devs — si este skill es de desarrollo,
    // verificar que no se exceda el máximo total de devs simultáneos
    if (DEV_SKILLS.includes(skill)) {
      const maxDevs = (config.resource_limits || {}).max_concurrent_devs;
      if (maxDevs != null) {
        const totalDevs = countRunningDevs();
        if (totalDevs >= maxDevs) {
          log('lanzamiento', `Límite global de devs alcanzado (${totalDevs}/${maxDevs}). Postergando ${archivo.name}`);
          continue;
        }
      }
    }

    // 6. PRE-FLIGHT CHECKS PARA FASE VERIFICACIÓN — DEBE ir ANTES del gate predictivo.
    //
    // Razón: si el gate predictivo bloquea por memoria, hace continue antes de llegar
    // al preflight, y el rebote APK→build nunca se ejecuta. El issue queda atascado
    // eternamente en verificacion/pendiente/, pendingQa nunca baja a 0, la ventana QA
    // no se auto-desactiva y el build (que podría regenerar el APK) está bloqueado por
    // la propia ventana QA. Deadlock duro.
    //
    // El preflight y el rebote son barato (no consumen RAM ni CPU significativos),
    // así que tiene sentido ejecutarlos ANTES del gate de recursos.
    let preflightResult = null;
    // Filtramos por skill: sólo los skills declarados en SKILLS_THAT_NEED_EMULATOR
    // disparan el preflight QA (que puede arrancar el emulador). Skills determinísticos
    // como `tester` y `security` no requieren AVD y no deben pagar el overhead del
    // preflight ni levantar el emulador (#3140).
    if (shouldRunQaPreflight(skill, fase)) {
      preflightResult = preflightQaChecks(issue);
      if (!preflightResult.ok) {
        if (preflightResult.result === 'apk_missing') {
          reboteVerificacionABuild(issue, pipelineName, preflightResult);
        } else if (preflightResult.result === 'waiting:emulator') {
          // Encolar start del emulador al servicio-emulador
          requestEmulator('start', 'pulpo-preflight', issue, 'QA_MODE=android, emulador necesario para verificación');
          log('lanzamiento', `⏸️ #${issue}: pre-flight → esperando emulador (encolado start al servicio-emulador)`);
        } else {
          // blocked:infra — mantener en cola, reintentar en próximo ciclo
          log('lanzamiento', `🚫 #${issue}: pre-flight → ${preflightResult.result}: ${preflightResult.reason}`);
        }
        continue; // No mover a trabajando/, no lanzar
      }
      // Capa 3: loguear el qaMode asignado
      log('lanzamiento', `#${issue}: qaMode=${preflightResult.qaMode} (Capa 3 ruteo)`);
    }

    // 7. GATE PREDICTIVO DE RECURSOS: ¿lanzar este agente saturaría el sistema?
    //    (corre DESPUÉS del preflight para que las verificaciones que serían rebotadas
    //    no inflen el contador de candidatos bloqueados ni paren el deadlock breaker)
    //
    //    Pasamos el estado del emulador para que los skills QA puedan restar su RAM
    //    del baseline — el emulador es infra reservada por la propia ventana QA, no
    //    un costo del agente individual. Sin esto el cálculo cuenta dos veces el
    //    emulador y lleva a livelock cuando la baseline ya lo incluye.
    eligibleForGateCount++;
    const gateCtx = { emulator: measureEmulatorMemPercent() };
    const impact = predictResourceImpact(skill, config, gateCtx);
    if (!impact.safe) {
      log('lanzamiento', `🛑 Gate predictivo bloqueó ${skill}:#${issue} — ${impact.reason}`);
      gateBlockedCount++;
      gateBlockedCandidates.push(candidate);
      continue;
    }

    // 7b. PRE-CHECK DE CONECTIVIDAD (#2317) — fases que requieren red no se
    //     lanzan si la infra está caída. El archivo queda en pendiente/
    //     marcado como `rebote_tipo: infra` para que el reencolado automático
    //     lo tome cuando se restaure la conectividad. NO cuenta contra el
    //     circuit breaker del issue (criterio #2).
    if (NETWORK_REQUIRED_PHASES.has(fase) && !precheckOk()) {
      marcarBloqueoInfra(archivo.path, issue, skill, fase, lastPrecheckResult);
      continue;
    }

    // Mover a trabajando/ (atómico)
    try {
      const trabajandoPath = moveFile(archivo.path, trabajandoDir);

      // Lanzar agente (todas las fases, incluyendo build)
      // Capa 3: pasar qaMode al agente QA via extraEnv
      const extraEnv = {};
      if (preflightResult && preflightResult.qaMode) {
        extraEnv.QA_MODE = preflightResult.qaMode;
        extraEnv.QA_ISSUE = String(issue);
        extraEnv.QA_BASE_URL = 'https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev';
        if (preflightResult.flavors && preflightResult.flavors.length > 0) {
          extraEnv.QA_FLAVOR = preflightResult.flavors[0];
        }
        if (preflightResult.emulatorSerial) {
          extraEnv.QA_EMULATOR_SERIAL = preflightResult.emulatorSerial;
        }

        // Inyectar `modo` al archivo YAML para que gate-evidencia-on-exit lo
        // respete sin depender de que el agente lo escriba. El preflight ya
        // sabe el qaMode correcto — esa es la fuente de verdad. Si el agente
        // QA aprueba pero omite el campo (ocurrió con #2159 structural y
        // disparó falso rechazo aunque el fix #2345 estuviera activo), el
        // gate igual lee `modo: structural` desde acá.
        if (skill === 'qa') {
          try {
            const data = readYaml(trabajandoPath) || {};
            data.modo = preflightResult.qaMode;
            writeYaml(trabajandoPath, data);
          } catch (e) {
            log('lanzamiento', `⚠️ No pude inyectar modo al YAML de ${archivo.name}: ${e.message.slice(0, 80)}`);
          }
        }
      }
      lanzarAgenteClaude(skill, issue, trabajandoPath, pipelineName, fase, config, extraEnv);
      anyLaunched = true;
    } catch (e) {
      log('lanzamiento', `Error moviendo/lanzando ${archivo.name}: ${e.message}`);
    }
  }

  // --- DEADLOCK BREAKER ---
  // Si había candidatos elegibles pero TODOS fueron bloqueados por el gate predictivo
  if (eligibleForGateCount > 0 && gateBlockedCount === eligibleForGateCount && !anyLaunched) {
    consecutiveAllBlockedCycles++;

    const forced = handleDeadlock(gateBlockedCandidates, config);
    if (forced) {
      // Forzar lanzamiento del candidato elegido por el breaker
      const { archivo, pipelineName, fase } = forced;
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      try {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        // Pre-flight para verificación incluso en deadlock breaker.
        // Si detecta APK faltante, REBOTAR a build (no abandonar) — sin esto, el
        // deadlock breaker se queda atascado para siempre haciendo return ciclo tras
        // ciclo mientras los archivos siguen en verificacion/pendiente/.
        // Filtramos por skill por la misma razón que el preflight regular (#3140):
        // skills determinísticos no deben disparar arranque del emulador.
        if (shouldRunQaPreflight(skill, fase)) {
          const preflight = preflightQaChecks(issue);
          if (!preflight.ok) {
            if (preflight.result === 'apk_missing') {
              log('deadlock', `#${issue}: pre-flight forzado detectó APK faltante → rebote a build`);
              reboteVerificacionABuild(issue, pipelineName, preflight);
              consecutiveAllBlockedCycles = 0; // El rebote es progreso real, resetear contador
            } else {
              log('deadlock', `#${issue}: pre-flight bloqueó lanzamiento forzado → ${preflight.result}`);
            }
            return; // No lanzar — el deadlock breaker no puede forzar sin infra
          }
        }
        // #3790 — El deadlock breaker NO debe agotar Claude durante la ventana
        // de descanso. Antes bypaseaba el gate del rest-mode (línea 4429) y
        // forzaba lanzamientos aunque estuviéramos en ventana, lo que rompía
        // la garantía de Leo de que rebotes/forzados también esperan a que la
        // ventana cierre. Aplicamos el mismo `isSkillAllowedNow` que el loop
        // regular — si no permite, no forzamos y el breaker espera al próximo
        // ciclo (no se incrementa consecutiveAllBlockedCycles porque el "no
        // lanzar" acá es decisión intencional, no un deadlock real).
        try {
          const restCfg = (loadConfig() || {}).rest_mode || {};
          const issueLbls = getIssueLabels(issue);
          const verdict = restModeWindow.isSkillAllowedNow(skill, Date.now(), {
            cfg: restCfg,
            bypassLabels: issueLbls,
            pipelineDir: PIPELINE,
          });
          if (!verdict.allowed) {
            log('deadlock', `#${issue}: forzado bloqueado por rest-mode (skill=${skill}, reason=${verdict.reason}) — espera fin de ventana`);
            return;
          }
        } catch (e) {
          // Fail-open: si el gate falla, no bloqueamos el deadlock breaker.
          log('deadlock', `rest-mode gate error en deadlock breaker (fail-open): ${e.message}`);
        }
        const trabajandoPath = moveFile(archivo.path, trabajandoDir);
        lanzarAgenteClaude(skill, issue, trabajandoPath, pipelineName, fase, config);
      } catch (e) {
        log('deadlock', `Error en lanzamiento forzado de ${archivo.name}: ${e.message}`);
      }
    }
  } else {
    // Se lanzó algo o no había candidatos elegibles → reset deadlock counter
    if (anyLaunched || eligibleForGateCount === 0) {
      consecutiveAllBlockedCycles = 0;
    }
  }
}

// =============================================================================
// PRE-FLIGHT CHECKS — Capa 2 + Capa 3 de la estrategia QA
// Capa 2: Verifica infraestructura ANTES de lanzar agente QA
// Capa 3: Clasifica qaMode (android/api/structural) para rutear al script correcto
// =============================================================================

const APP_LABELS = ['app:client', 'app:business', 'app:delivery'];
const LABEL_TO_FLAVOR = { 'app:client': 'client', 'app:business': 'business', 'app:delivery': 'delivery' };
const ROUTING_LABELS = [...APP_LABELS, 'area:backend', 'area:infra', 'area:pipeline', 'tipo:infra', 'docs'];

// Keywords para auto-clasificación inteligente de issues sin labels de ruteo
const AUTO_CLASSIFY_RULES = [
  // UI / Android — palabras que indican impacto en la interfaz del usuario
  { keywords: ['pantalla', 'screen', 'ui', 'ux', 'botón', 'button', 'formulario', 'form', 'dialog',
    'compose', 'viewmodel', 'navegación', 'navigation', 'diseño', 'layout', 'color', 'tema', 'theme',
    'carrito', 'cart', 'pedido', 'order', 'producto', 'product', 'menú', 'menu', 'login', 'registro',
    'perfil', 'profile', 'notificación', 'notification', 'lista', 'list', 'detalle', 'detail',
    'imagen', 'image', 'ícono', 'icon', 'toast', 'snackbar', 'repetir pedido', 'checkout',
    'splash', 'onboarding', 'search', 'buscar', 'filtro', 'filter', 'animación', 'animation'],
    label: 'app:client' },
  // Backend / API
  { keywords: ['endpoint', 'api', 'lambda', 'cognito', 'dynamodb', 'serverless', 'función backend',
    'backend function', 'signin', 'signup', 'token', 'jwt', 'cors', 'http', 'request', 'response',
    'ktor', 'route', 'ruta backend', 'status code', 'migration', 'tabla', 'table', 'index',
    'secretsmanager', 'ses', 'email', 'sms', 'otp', '2fa', 'mfa', 'auth'],
    label: 'area:backend' },
  // Infra / pipeline / hooks
  { keywords: ['pipeline', 'hook', 'infra', 'ci/cd', 'github action', 'gradle', 'build', 'deploy',
    'worktree', 'pulpo', 'restart', 'dashboard', 'monitor', 'agent', 'agente', 'config',
    'yaml', 'json config', 'script', '.pipeline', 'cron', 'scheduler'],
    label: 'area:infra' },
  // Documentación
  { keywords: ['documentación', 'documentation', 'docs/', 'readme', 'spec', 'arquitectura',
    'architecture', 'manual', 'guía', 'guide', 'changelog'],
    label: 'docs' }
];

/**
 * Auto-clasificar un issue sin labels de ruteo.
 * Lee título y body del issue, matchea contra keywords, asigna el label en GitHub.
 * Retorna el label asignado o null si no pudo determinar.
 */
function autoClassifyIssue(issueNum) {
  try {
    ghThrottle();
    const issueJson = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json title,body`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const { title = '', body = '' } = JSON.parse(issueJson);
    const text = `${title}\n${body}`.toLowerCase();

    // Contar matches por regla
    const scores = AUTO_CLASSIFY_RULES.map(rule => {
      const hits = rule.keywords.filter(kw => text.includes(kw.toLowerCase()));
      return { label: rule.label, hits: hits.length, matched: hits };
    }).filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits);

    if (scores.length === 0) {
      log('auto-classify', `#${issueNum}: sin matches — no se puede clasificar automáticamente`);
      return null;
    }

    const winner = scores[0];
    log('auto-classify', `#${issueNum}: clasificado como "${winner.label}" (${winner.hits} hits: ${winner.matched.slice(0, 5).join(', ')})`);

    // Asignar label en GitHub
    try {
      ghThrottle();
      execSync(
        `"${GH_BIN}" issue edit ${issueNum} --add-label "${winner.label}"`,
        { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
      );
      log('auto-classify', `#${issueNum}: label "${winner.label}" asignado en GitHub ✓`);

      // Invalidar cache de labels para que el ruteo use el label nuevo
      issueLabelsCache.delete(issueNum);
    } catch (e) {
      log('auto-classify', `#${issueNum}: error asignando label — ${e.message.slice(0, 80)}`);
    }

    return winner.label;
  } catch (e) {
    log('auto-classify', `#${issueNum}: error leyendo issue — ${e.message.slice(0, 80)}`);
    return null;
  }
}
const QA_ARTIFACTS_DIR = path.join(ROOT, 'qa', 'artifacts');
const PREFLIGHT_LOG_FILE = path.join(LOG_DIR, 'qa-preflight-log.jsonl');

// --- Warm-up + retry para backend Lambda (evita falsos blocked:infra por cold start) ---
const BACKEND_BASE_URL = 'https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev/intrale';
const WARMUP_RETRIES = 3;       // Intentos totales (1 warm-up + 2 retries)
const WARMUP_WAIT_MS = 5000;    // Espera entre intentos (5 segundos)
// Deduplicación de notificaciones blocked:infra — evita spam en Telegram
const _lastBlockedNotif = {};   // { issueNumber: timestampMs }
const BLOCKED_NOTIF_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos entre notificaciones del mismo issue

/**
 * Hace un request al backend con warm-up automático.
 * Si el primer intento falla por timeout/error, espera y reintenta.
 * Retorna { ok: boolean, httpCode: number|null, error: string|null }
 */
function checkBackendWithWarmup(issue) {
  const backendUrl = `${BACKEND_BASE_URL}/signin`;
  // NUL en Windows, /dev/null en Unix — execSync usa cmd.exe en Windows
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';

  let lastStderr = '';
  let lastHttpCode = null;

  for (let attempt = 1; attempt <= WARMUP_RETRIES; attempt++) {
    try {
      const curlResult = execSync(
        `curl -s -o ${devNull} -w "%{http_code}" -X POST "${backendUrl}" -H "Content-Type: application/json" -d "{}" --connect-timeout 10 --max-time 20`,
        { encoding: 'utf8', timeout: 25000, windowsHide: true }
      ).trim();
      const httpCode = parseInt(curlResult, 10);
      lastHttpCode = httpCode;

      if (httpCode >= 400 && httpCode < 500) {
        if (attempt > 1) {
          log('preflight', `#${issue}: backend respondió OK en intento ${attempt}/${WARMUP_RETRIES} (cold start resuelto)`);
        }
        // El backend respondió algo → la red está bien. Cualquier contador acumulado se resetea.
        resetInfraCounterOnSuccess();
        return { ok: true, httpCode, error: null };
      }

      // Respuesta inesperada (5xx, etc) — reintentar
      log('preflight', `#${issue}: backend HTTP ${httpCode} en intento ${attempt}/${WARMUP_RETRIES} — ${attempt < WARMUP_RETRIES ? `esperando ${WARMUP_WAIT_MS/1000}s...` : 'agotados reintentos'}`);
    } catch (e) {
      lastStderr = (e && (e.stderr || e.message)) || '';
      log('preflight', `#${issue}: backend timeout/error en intento ${attempt}/${WARMUP_RETRIES}: ${String(lastStderr).slice(0, 60)} — ${attempt < WARMUP_RETRIES ? `esperando ${WARMUP_WAIT_MS/1000}s (probable cold start)...` : 'agotados reintentos'}`);
    }

    // Esperar antes del siguiente intento (excepto en el último)
    // Usamos Atomics.wait como sleep sincrónico portable (funciona en Windows sin shell hacks)
    if (attempt < WARMUP_RETRIES) {
      const sharedBuf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sharedBuf), 0, 0, WARMUP_WAIT_MS);
    }
  }

  // Todos los intentos fallaron — determinar si es red (infra) o backend con 5xx.
  // Si nunca obtuvimos httpCode → fallo de red puro → contar hacia el circuit breaker.
  // Si httpCode venía en 5xx → backend responde pero mal → NO contar (AC-1: sólo códigos de red).
  if (lastHttpCode === null) {
    const code = classifyNetworkError(lastStderr) || 'ETIMEDOUT';
    const host = hostnameFromUrl(BACKEND_BASE_URL);
    registerInfraFailureAndMaybeAlert(issue, code, host);
  }

  return { ok: false, httpCode: lastHttpCode, error: `No respondió tras ${WARMUP_RETRIES} intentos (cold start persistente)` };
}

/**
 * Envía notificación de blocked:infra con deduplicación (máximo 1 cada 5 min por issue).
 */
function sendBlockedInfraNotif(issue, message) {
  const now = Date.now();
  const lastSent = _lastBlockedNotif[issue] || 0;
  if (now - lastSent < BLOCKED_NOTIF_COOLDOWN_MS) {
    log('preflight', `#${issue}: blocked:infra notificación suprimida (cooldown ${Math.round((BLOCKED_NOTIF_COOLDOWN_MS - (now - lastSent)) / 1000)}s restantes)`);
    return;
  }
  _lastBlockedNotif[issue] = now;
  sendTelegram(message);
}

// =============================================================================
// CIRCUIT BREAKER DE INFRA (issue #2305)
// Cuenta fallos de red consecutivos entre issues. A la 3ra falla seguida,
// abre el CB, pausa el pipeline y notifica a Leo vía Telegram.
// Un éxito de CUALQUIER issue resetea el contador (la red volvió a andar).
// =============================================================================

/**
 * Extrae el código de error de red a partir de un mensaje arbitrario
 * (stderr de curl, e.message de fetch, etc). Si no reconoce ninguno,
 * devuelve `TIMEOUT` como fallback conservador (todavía cuenta como infra).
 */
function classifyNetworkError(errMessage) {
  if (!errMessage) return null;
  const msg = String(errMessage);

  // Tokens explícitos que aparecen en stack traces de Node y mensajes de error
  const codeMatch = msg.match(/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/);
  if (codeMatch) return codeMatch[1];

  // Traducción de mensajes curl/friendly a códigos canónicos
  if (/could not resolve host|name or service not known|dns/i.test(msg)) return 'ENOTFOUND';
  if (/connection refused/i.test(msg)) return 'ECONNREFUSED';
  if (/timed out|timeout|operation timed out/i.test(msg)) return 'ETIMEDOUT';
  if (/connection reset/i.test(msg)) return 'ECONNRESET';

  return null;
}

/**
 * Extrae el hostname de una URL (para mostrar `ENOTFOUND api.amazonaws.com`
 * en lugar de sólo el código, como pide la UX).
 */
function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Encolar mensaje Telegram de apertura del circuit breaker.
 * Formato fijo siguiendo la UX del issue #2305 (copy natural en español,
 * comando en code-block copiable, emoji 🔴 de estado).
 *
 * Pasa por redact() para eliminar tokens, paths absolutos y stack traces.
 */
function notifyInfraCircuitBreakerOpen(issue, errorCode, hostname) {
  const code = redact(errorCode || 'ETIMEDOUT');
  const host = hostname ? ` ${redact(hostname)}` : '';
  const issueRef = issue ? `#${parseInt(issue, 10)}` : 'desconocido';

  const msg = [
    '🔴 Pipeline pausado por infra',
    '',
    'Se agotaron 3 intentos consecutivos por problemas de red.',
    '',
    `Último issue afectado: ${issueRef}`,
    `Error: ${code}${host}`,
    '',
    'Para reanudar, una vez verificada la red:',
    '`node .pipeline/resume.js`',
  ].join('\n');

  sendTelegram(msg);
}

/**
 * Registrar una falla de infra detectada por el pipeline.
 * Si el CB pasa a `open` en esta llamada, envía UN SOLO mensaje Telegram
 * (rate-limit via flag `alert_sent` del archivo de estado).
 *
 * @param {number|string} issue
 * @param {string} errorCode — ENOTFOUND, ETIMEDOUT, etc
 * @param {string|null} hostname — opcional, para enriquecer el mensaje
 */
function registerInfraFailureAndMaybeAlert(issue, errorCode, hostname = null) {
  try {
    const code = errorCode || 'ETIMEDOUT';
    const { opened, state } = cbInfra.registerInfraFailure(issue, code);
    log('circuit-breaker-infra',
      `fallo de red #${issue} ${code}${hostname ? ` (${hostname})` : ''} — contador ${state.consecutive_failures}/${cbInfra.CONSECUTIVE_THRESHOLD}${opened ? ' → CB OPEN' : ''}`);
    if (opened && !state.alert_sent) {
      notifyInfraCircuitBreakerOpen(issue, code, hostname);
      cbInfra.markAlertSent();
    }
  } catch (e) {
    // Nunca propagar errores del CB — el pipeline debe seguir vivo.
    log('circuit-breaker-infra', `error registrando fallo: ${redact(e.message || String(e))}`);
  }
}

/**
 * Cualquier éxito del pipeline indica que la red funciona: resetear contador.
 * Llamado desde brazoBarrido cuando una fase completa OK.
 */
function resetInfraCounterOnSuccess() {
  try {
    const next = cbInfra.resetOnSuccess();
    if (next) {
      log('circuit-breaker-infra', 'éxito detectado → contador reseteado a 0');
    }
  } catch (e) {
    log('circuit-breaker-infra', `error reseteando contador: ${redact(e.message || String(e))}`);
  }
}

/**
 * Pre-flight checks para agentes QA (Capa 2 + Capa 3 ruteo).
 * Retorna { ok, result, reason, flavors, requiresEmulator, qaMode }
 *   ok=true  → lanzar agente
 *   qaMode: 'android' | 'api' | 'structural' (Capa 3)
 *   ok=false → no lanzar, result indica la acción a tomar
 */
// --- Check DynamoDB remoto: verifica que no hay overrides locales ---
function checkDynamoDbRemote(issue) {
  const checks = {};
  let ok = true;

  // 1. Verificar env vars que apuntan a DynamoDB local
  const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT || '';
  if (dynamoEndpoint && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(dynamoEndpoint)) {
    checks.dynamodb_env = `local:${dynamoEndpoint}`;
    log('preflight', `#${issue}: FAIL — DYNAMODB_ENDPOINT apunta a local: ${dynamoEndpoint}`);
    ok = false;
  } else {
    checks.dynamodb_env = dynamoEndpoint ? `remote:${dynamoEndpoint}` : 'not-set:aws-default';
  }

  // 2. Verificar LOCAL_MODE
  if ((process.env.LOCAL_MODE || '').toLowerCase() === 'true') {
    checks.local_mode = 'true';
    log('preflight', `#${issue}: FAIL — LOCAL_MODE=true activo, DynamoDB/Cognito apuntarían a localhost`);
    ok = false;
  } else {
    checks.local_mode = 'off';
  }

  // 3. Verificar .env.qa no tiene overrides locales
  const envQaPath = path.join(ROOT, '.env.qa');
  if (fs.existsSync(envQaPath)) {
    try {
      const envContent = fs.readFileSync(envQaPath, 'utf8');
      if (/DYNAMODB_ENDPOINT=.*localhost|DYNAMODB_ENDPOINT=.*127\.0\.0\.1/.test(envContent)) {
        checks.env_qa = 'dynamodb-local';
        log('preflight', `#${issue}: FAIL — .env.qa contiene DYNAMODB_ENDPOINT local`);
        ok = false;
      } else if (/LOCAL_MODE=true/.test(envContent)) {
        checks.env_qa = 'local-mode-true';
        log('preflight', `#${issue}: FAIL — .env.qa contiene LOCAL_MODE=true`);
        ok = false;
      } else {
        checks.env_qa = 'ok';
      }
    } catch (e) {
      checks.env_qa = `read-error:${e.message.slice(0, 40)}`;
    }
  } else {
    checks.env_qa = 'not-exists';
  }

  // 4. Verificar que searchBusinesses devuelve datos reales (DynamoDB remoto con data)
  // Timeouts más generosos para tolerar cold start (el warm-up de signin puede no calentar esta ruta)
  try {
    const searchUrl = `${BACKEND_BASE_URL}/searchBusinesses`;
    const result = execSync(
      `curl -s -X POST "${searchUrl}" -H "Content-Type: application/json" -d "{}" --connect-timeout 10 --max-time 20`,
      { encoding: 'utf8', timeout: 25000, windowsHide: true }
    ).trim();
    if (result.includes('"businesses":[') && !result.includes('"businesses":[]')) {
      checks.dynamodb_data = 'ok:has-data';
      log('preflight', `#${issue}: DynamoDB remoto OK — searchBusinesses devuelve datos reales`);
    } else if (result.includes('"businesses":[]')) {
      checks.dynamodb_data = 'empty';
      log('preflight', `#${issue}: WARN — DynamoDB remoto vacío (searchBusinesses sin resultados)`);
      // No bloquear por datos vacíos, solo advertir
    } else {
      checks.dynamodb_data = `unexpected:${result.slice(0, 60)}`;
      log('preflight', `#${issue}: WARN — DynamoDB respuesta inesperada: ${result.slice(0, 60)}`);
    }
  } catch (e) {
    checks.dynamodb_data = `error:${e.message.slice(0, 60)}`;
    log('preflight', `#${issue}: FAIL — DynamoDB check falló: ${e.message.slice(0, 60)}`);
    ok = false;
  }

  return { ok, checks };
}

function preflightQaChecks(issue) {
  const startMs = Date.now();
  const checks = {};

  // --- Check 1: Clasificar issue (requiere emulador o no) ---
  let labels = getIssueLabels(issue);

  // Auto-clasificación: si el issue no tiene ningún label de ruteo, inferir y asignar
  const hasRoutingLabel = labels.some(l => ROUTING_LABELS.includes(l));
  if (!hasRoutingLabel) {
    log('preflight', `#${issue}: sin labels de ruteo — intentando auto-clasificar...`);
    const assignedLabel = autoClassifyIssue(issue);
    if (assignedLabel) {
      // Re-leer labels después de la asignación
      labels = getIssueLabels(issue);
      sendTelegram(`🏷️ Issue #${issue} auto-clasificado como \`${assignedLabel}\` (no tenía label de ruteo QA).`);
    } else {
      log('preflight', `#${issue}: auto-clasificación falló — cae en structural por defecto`);
    }
  }

  const appLabels = labels.filter(l => APP_LABELS.includes(l));
  const requiresEmulator = appLabels.length > 0;
  const flavors = appLabels.map(l => LABEL_TO_FLAVOR[l]);

  // Capa 3: Clasificación extendida — qaMode determina el ruteo QA
  // 'android' = necesita emulador + APK + Maestro
  // 'api'     = necesita backend, NO emulador ni APK
  // 'structural' = no necesita infra externa (docs, hooks, infra)
  const hasBackendLabel = labels.includes('area:backend');
  const qaMode = requiresEmulator ? 'android'
    : hasBackendLabel ? 'api'
    : 'structural';

  // R1 (#2351): cachear la clasificación autoritativa para que el gate
  // de evidencia no tenga que depender del `modo` del YAML (manipulable
  // por el agente). Se setea ni bien determinamos el modo, sin importar
  // si los checks posteriores pasan o fallan — el modo se conoce desde
  // el primer momento.
  qaModeByIssue.set(String(issue), qaMode);

  checks.classify = requiresEmulator ? `ui:${flavors.join(',')}` : `no-ui:${qaMode}`;
  log('preflight', `#${issue}: check 1 OK (qaMode=${qaMode}${requiresEmulator ? `, flavors: ${flavors.join(', ')}` : ''})`);

  // Si no requiere emulador, verificar backend para QA-API antes de aprobar
  if (!requiresEmulator) {
    if (qaMode === 'api') {
      // QA-API necesita backend vivo — check 3 con warm-up (tolera cold start de Lambda)
      const warmup = checkBackendWithWarmup(issue);
      if (warmup.ok) {
        checks.backend = `ok:${warmup.httpCode}`;
        log('preflight', `#${issue}: check 3 (QA-API) OK — backend responde HTTP ${warmup.httpCode}`);
      } else {
        checks.backend = `error:${warmup.error}`;
        log('preflight', `#${issue}: check 3 (QA-API) FAIL — ${warmup.error} → blocked:infra`);
      }

      if (!warmup.ok) {
        logPreflight(issue, checks, 'blocked:infra', startMs);
        sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA-API #${issue}: backend no responde tras ${WARMUP_RETRIES} intentos (cold start). Issue bloqueado hasta que se recupere.`);
        return { ok: false, result: 'blocked:infra', reason: `Backend no responde (${checks.backend})`, flavors: [], requiresEmulator: false, qaMode };
      }

      // Check DynamoDB remoto (no overrides locales)
      const dynamoCheck = checkDynamoDbRemote(issue);
      checks.dynamodb = dynamoCheck.checks;
      if (!dynamoCheck.ok) {
        logPreflight(issue, checks, 'blocked:infra', startMs);
        sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA-API #${issue}: DynamoDB apunta a local o no responde. Verificar .env.qa y env vars.`);
        return { ok: false, result: 'blocked:infra', reason: 'DynamoDB no es remoto — overrides locales detectados', flavors: [], requiresEmulator: false, qaMode };
      }
      log('preflight', `#${issue}: check DynamoDB remoto OK`);

      // Capa 3: Verificar/generar test cases para QA-API
      const testCasesFile = path.join(ROOT, 'qa', 'test-cases', `${issue}.json`);
      if (fs.existsSync(testCasesFile)) {
        checks.testCases = 'exists';
        log('preflight', `#${issue}: check 5 (test cases) OK — encontrado ${testCasesFile}`);
      } else {
        // Fallback: generar test cases automáticamente desde criterios del issue
        log('preflight', `#${issue}: check 5 (test cases) — no existe, generando fallback...`);
        try {
          const genScript = path.join(ROOT, 'qa', 'scripts', 'qa-generate-test-cases.js');
          const ghPath = fs.existsSync(GH_BIN) ? GH_BIN : 'gh';
          execSync(`node "${genScript}"`, {
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
            env: { ...process.env, QA_ISSUE: String(issue), GH_PATH: ghPath }
          });
          checks.testCases = 'generated-fallback';
          log('preflight', `#${issue}: check 5 (test cases) OK — generados como fallback`);
        } catch (genErr) {
          // No bloquear si falla la generación — el agente QA puede generar manualmente
          checks.testCases = `gen-failed:${genErr.message.slice(0, 60)}`;
          log('preflight', `#${issue}: check 5 (test cases) WARN — generación fallback falló, el agente QA los generará`);
        }
      }
    }

    logPreflight(issue, checks, 'pass', startMs);
    return { ok: true, result: 'pass', reason: `Issue ${qaMode} — no requiere emulador ni APK`, flavors: [], requiresEmulator: false, qaMode };
  }

  // --- Check 2: APK disponible (solo si requiere emulador) ---
  fs.mkdirSync(QA_ARTIFACTS_DIR, { recursive: true });
  const missingApks = [];
  for (const flavor of flavors) {
    const apkName = `${issue}-composeApp-${flavor}-debug.apk`;
    const apkPath = path.join(QA_ARTIFACTS_DIR, apkName);
    if (!fs.existsSync(apkPath)) {
      missingApks.push(apkName);
    }
  }

  if (missingApks.length > 0) {
    checks.apk = `missing:${missingApks.join(',')}`;
    log('preflight', `#${issue}: check 2 FAIL — APK faltante: ${missingApks.join(', ')} → re-encolar para build`);
    logPreflight(issue, checks, 'apk_missing', startMs);
    return { ok: false, result: 'apk_missing', reason: `APK faltante: ${missingApks.join(', ')}`, flavors, requiresEmulator: true, qaMode: 'android' };
  }
  checks.apk = 'ok';
  log('preflight', `#${issue}: check 2 OK (APK encontrado para ${flavors.join(', ')})`);

  // --- Check 3: Backend responde (con warm-up para tolerar cold start de Lambda) ---
  const warmupAndroid = checkBackendWithWarmup(issue);
  if (warmupAndroid.ok) {
    checks.backend = `ok:${warmupAndroid.httpCode}`;
    log('preflight', `#${issue}: check 3 OK (backend responde HTTP ${warmupAndroid.httpCode})`);
  } else {
    checks.backend = `error:${warmupAndroid.error}`;
    log('preflight', `#${issue}: check 3 FAIL — ${warmupAndroid.error} → blocked:infra`);
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: backend no responde tras ${WARMUP_RETRIES} intentos (cold start). Issue bloqueado hasta que se recupere.`);
    return { ok: false, result: 'blocked:infra', reason: `Backend no responde (${checks.backend})`, flavors, requiresEmulator: true, qaMode: 'android' };
  }

  // --- Check 3b: DynamoDB remoto (no overrides locales) ---
  const dynamoCheckAndroid = checkDynamoDbRemote(issue);
  checks.dynamodb = dynamoCheckAndroid.checks;
  if (!dynamoCheckAndroid.ok) {
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: DynamoDB apunta a local o no responde. Verificar .env.qa y env vars.`);
    return { ok: false, result: 'blocked:infra', reason: 'DynamoDB no es remoto — overrides locales detectados', flavors, requiresEmulator: true, qaMode: 'android' };
  }
  log('preflight', `#${issue}: check DynamoDB remoto OK`);

  // --- Check 4: Emulador disponible via ADB + test de screenrecord (Blindaje 2) ---
  let emulatorReady = false;
  let emulatorSerial = '';
  try {
    const adbOutput = execSync('adb devices', {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }).trim();
    // Buscar linea con "emulator" y estado "device" (no "offline")
    const lines = adbOutput.split('\n').filter(l => l.includes('emulator') && l.includes('device'));
    emulatorReady = lines.length > 0;
    if (emulatorReady) {
      emulatorSerial = lines[0].split('\t')[0].trim();
    }
  } catch {}

  if (!emulatorReady) {
    checks.emulator = 'waiting';
    log('preflight', `#${issue}: check 4 FAIL (emulador no disponible) → waiting:emulator — señalizando ventana QA`);
    logPreflight(issue, checks, 'waiting:emulator', startMs);
    return { ok: false, result: 'waiting:emulator', reason: 'Emulador no disponible — requiere activación de ventana QA', flavors, requiresEmulator: true, qaMode: 'android' };
  }

  // Blindaje 2: Mini screenrecord de prueba (2s) para verificar que ADB puede grabar.
  // Con el gating de boot real en qa-environment.waitBootCompleted(), el framework
  // ya está listo antes de llegar acá, así que un solo intento es suficiente.
  // Si falla, es ADB realmente inestable y conviene abortar el preflight rápido.
  let screenrecordOk = false;
  try {
    execSync(
      `adb -s ${emulatorSerial} shell "screenrecord --time-limit 2 /sdcard/qa-preflight-test.mp4 && ls -l /sdcard/qa-preflight-test.mp4 && rm -f /sdcard/qa-preflight-test.mp4"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    screenrecordOk = true;
    log('preflight', `#${issue}: check 4b OK — screenrecord test passed`);
  } catch (e) {
    log('preflight', `#${issue}: check 4b FAIL — screenrecord: ${e.message.slice(0, 80)}`);
  }

  if (!screenrecordOk) {
    checks.emulator = 'screenrecord-fail';
    log('preflight', `#${issue}: check 4b FAIL — screenrecord no funciona → blocked:infra`);
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: emulador disponible pero screenrecord no funciona. Posible ADB inestable — reintentando en proxima ventana.`);
    return { ok: false, result: 'blocked:infra', reason: 'Screenrecord no funciona — ADB inestable', flavors, requiresEmulator: true, qaMode: 'android' };
  }

  checks.emulator = 'ok+screenrecord';
  log('preflight', `#${issue}: check 4 OK (emulador disponible + screenrecord verificado)`);

  // --- Check 5: Pre-warm — instalar APK, abrir app, cerrar diálogos ---
  // El agente QA pierde minutos valiosos lidiando con ANR dialogs, onboarding,
  // y permisos del sistema. Este paso deja la app en estado limpio para testear.
  try {
    const flavor = flavors[0] || 'client';
    const apkName = `${issue}-composeApp-${flavor}-debug.apk`;
    const apkPath = path.join(QA_ARTIFACTS_DIR, apkName);

    // 5a. Instalar APK (replace si ya existía)
    execSync(`adb -s ${emulatorSerial} install -r -t "${apkPath}"`, {
      encoding: 'utf8', timeout: 60000, windowsHide: true
    });
    log('preflight', `#${issue}: check 5a OK — APK instalado (${flavor})`);

    // 5b. Determinar package name del flavor
    const FLAVOR_PACKAGES = {
      client: 'com.intrale.app.client',
      business: 'com.intrale.app.business',
      delivery: 'com.intrale.app.delivery',
    };
    const pkg = FLAVOR_PACKAGES[flavor] || FLAVOR_PACKAGES.client;

    // 5c. Forzar stop (estado limpio) y lanzar la app
    execSync(`adb -s ${emulatorSerial} shell am force-stop ${pkg}`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    execSync(`adb -s ${emulatorSerial} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });

    // 5d. Esperar que la app arranque y cerrar diálogos del sistema (ANR, permisos, etc.)
    // Screenrecord tarda ~3s en estabilizarse, la app ~5s en cold start.
    const waitMs = 8000;
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitMs) {
      try {
        // Buscar y cerrar diálogos ANR ("Wait" / "Close app")
        const uiDump = execSync(
          `adb -s ${emulatorSerial} shell "uiautomator dump /dev/tty 2>/dev/null"`,
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        if (uiDump.includes('android:id/aerr_wait') || uiDump.includes("Wait")) {
          // Tap "Wait" para descartar ANR dialog
          execSync(`adb -s ${emulatorSerial} shell input keyevent KEYCODE_ENTER`, {
            encoding: 'utf8', timeout: 3000, windowsHide: true
          });
          log('preflight', `#${issue}: check 5d — cerrado diálogo ANR`);
        } else if (uiDump.includes('Saltar') || uiDump.includes('saltar') || uiDump.includes('Skip')) {
          // Tap "Saltar" en onboarding — buscar coordenadas del botón
          execSync(`adb -s ${emulatorSerial} shell input keyevent KEYCODE_TAB && adb -s ${emulatorSerial} shell input keyevent KEYCODE_ENTER`, {
            encoding: 'utf8', timeout: 3000, windowsHide: true
          });
          log('preflight', `#${issue}: check 5d — saltado onboarding`);
        } else {
          // Sin diálogos, app cargando normalmente
          break;
        }
      } catch { /* UI dump puede fallar si la app aún no renderizó */ }
      // Pausa corta entre intentos
      execSync('ping -n 2 127.0.0.1 > NUL', { timeout: 3000, windowsHide: true });
    }

    checks.prewarm = 'ok';
    log('preflight', `#${issue}: check 5 OK — app pre-warmed (${flavor}, pkg: ${pkg})`);
  } catch (e) {
    // Pre-warm no es bloqueante — si falla, el agente QA puede hacer el setup él mismo
    checks.prewarm = `warn:${e.message.slice(0, 60)}`;
    log('preflight', `#${issue}: check 5 WARN — pre-warm falló (no bloqueante): ${e.message.slice(0, 80)}`);
  }

  // --- Todos los checks pasaron ---
  logPreflight(issue, checks, 'pass', startMs);
  return { ok: true, result: 'pass', reason: 'Todos los pre-flight checks OK', flavors, requiresEmulator: true, qaMode: 'android', emulatorSerial };
}

/** Persistir resultado de pre-flight en log JSONL para análisis */
function logPreflight(issue, checks, result, startMs) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      issue: String(issue),
      checks,
      result,
      duration_ms: Date.now() - startMs
    };
    fs.appendFileSync(PREFLIGHT_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

/**
 * Encolar un pedido de start/stop del emulador al servicio-emulador.
 * El servicio procesa la cola con coalescencia last-write-wins.
 * Diseño: docs/pipeline/diseno-servicio-emulador.md
 */
function requestEmulator(action, requester, issue, reason) {
  const ts = Date.now();
  const msg = { action, requester, issue: issue || null, reason: reason || '', timestamp: Math.floor(ts / 1000) };
  const svcDir = path.join(PIPELINE, 'servicios', 'emulador', 'pendiente');
  try {
    fs.mkdirSync(svcDir, { recursive: true });
    const file = path.join(svcDir, `${ts}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    log('qa-env', `Encolado ${action} emulador (requester: ${requester}, issue: #${issue || '-'})`);
  } catch (e) {
    log('qa-env', `Error encolando ${action} emulador: ${e.message}`);
  }
}

function lanzarAgenteClaude(skill, issue, trabajandoPath, pipeline, fase, config, extraEnv = {}) {
  // #2974 — GATE DETERMINÍSTICO PRE-SPAWN: si la cuota Anthropic está agotada
  // (flag persistido en `.pipeline/quota-exhausted.json` con `resets_at` futuro),
  // NO spawneamos claude.exe para skills LLM. Skills determinísticos
  // (builder/tester/linter/delivery) siguen corriendo en Node puro sin tokens.
  // El archivo de trabajo permanece en `trabajando/` — el orphan-timeout lo
  // devuelve a `pendiente/` naturalmente, y cuando el flag se borre (drenado
  // post-reset o spawn exitoso), el filesystem-como-cola los recoge sin lógica
  // adicional. CA-1/CA-2 del issue.
  // #3198 — consumer runtime de skill.fallbacks[]: si el primary queda gateado
  // por cuota, intentamos los providers declarados como fallback antes de
  // devolver el archivo a pendiente/. Devuelve `{ provider, model, source,
  // gated, fallbackUsed }`. Cuando `source === 'fallback'`, el spawn arranca
  // con el provider del fallback (cross-provider switch) y el archivo NO vuelve
  // a pendiente/. Cuando `gated === true` (primary + todos los fallbacks
  // gated), el comportamiento es idéntico al gate clásico (#3077).
  let dispatchResolution = null;
  try {
    dispatchResolution = resolveSpawnWithFallback({
      skill,
      issue,
      pipelineDir: PIPELINE,
      quotaModule: quotaExhausted,
      onLog: log,
    });

    if (dispatchResolution.gated) {
      log('lanzamiento', `🚫 ${skill}:#${issue} bloqueado por quota-exhausted (LLM, primary=${dispatchResolution.primaryProvider || 'unknown'} y ${(dispatchResolution.chainTried || []).length - 1} fallback(s) gated) — devuelvo a pendiente/`);
      try {
        const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
        moveFile(trabajandoPath, pendienteDir);
      } catch {}
      try {
        quotaExhausted.appendAudit({
          event: 'gate_blocked_spawn',
          agent: skill,
          provider: dispatchResolution.primaryProvider,
          model: dispatchResolution.model || null,
          error_type: null,
          raw_excerpt: `issue=${issue} fase=${fase} pipeline=${pipeline} chain=${(dispatchResolution.chainTried || []).join('->')}`,
          flag_set: true,
        });
      } catch {}
      // #3259 / CA-4 + CA-9: aplicar label `provider-exhaustion-pause` al
      // issue + encolar Telegram con detalle sanitizado + persistir marker
      // de dedupe (2h o cambio de chain) + audit hash-chained. Idempotente.
      // Best-effort: si el módulo no cargó o gh no está disponible, el
      // gate clásico (mover a pendiente + appendAudit arriba) sigue
      // funcionando — el operador queda sin label/Telegram, no se rompe el
      // pulpo.
      try {
        if (providerExhaustionPause) {
          const retryMs = providerExhaustionPause.clampRetryIntervalMs(
            ((loadConfig() || {}).pulpo_continuidad || {}).retry_interval_ms
          );
          providerExhaustionPause.reportExhaustion({
            skill,
            issue,
            primary_provider: dispatchResolution.primaryProvider || 'unknown',
            chain_tried: dispatchResolution.chainTried || [],
            retry_interval_ms: retryMs,
          });
        }
      } catch (perr) {
        log('lanzamiento', `[WARN] provider-exhaustion-pause report falló (no bloqueante): ${perr.message}`);
      }
      return;
    }

    if (dispatchResolution.source === 'fallback' && dispatchResolution.fallbackUsed) {
      log('lanzamiento', `↪️ ${skill}:#${issue} primary=${dispatchResolution.primaryProvider} gated, spawn con fallback="${dispatchResolution.fallbackUsed.provider}" (índice ${dispatchResolution.fallbackUsed.index}).`);
    }
  } catch (gateErr) {
    // Best-effort: si el dispatcher falla por bug, NO bloqueamos el spawn — preferimos
    // que el pipeline siga operativo aún con detector roto. El siguiente result
    // event con is_error=true volverá a setear el flag.
    log('lanzamiento', `⚠️ dispatcher de fallback falló para ${skill}:#${issue}: ${gateErr.message} — continúo con spawn`);
  }

  // INVARIANTE CRÍTICO: el skill debe pertenecer a skills_por_fase[fase] de este pipeline.
  // Ningún agente puede correr en una fase que no es la suya, ni siquiera por excepción
  // (incidentes previos: project_apk-builder-responsibility, project_build-bypass-agent).
  // Si esto falla, el archivo se devuelve a pendiente/ y se alerta — NO se lanza.
  try {
    const skillsValidos = ((config.pipelines || {})[pipeline] || {}).skills_por_fase || {};
    const permitidos = skillsValidos[fase] || [];
    if (!permitidos.includes(skill)) {
      log('lanzamiento', `⛔ INVARIANTE: skill "${skill}" no pertenece a fase "${fase}" (permitidos: ${permitidos.join(', ') || '∅'}). Archivo: ${path.basename(trabajandoPath)}`);
      sendTelegram(`⛔ Pipeline bloqueó lanzamiento de ${skill}:#${issue} en fase "${fase}" — skill no autorizado para esa fase. Revisar inmediatamente.`);
      try {
        const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
        moveFile(trabajandoPath, pendienteDir);
      } catch {}
      return;
    }
  } catch (invErr) {
    log('lanzamiento', `⚠️ No se pudo validar invariante skill∈fase para ${skill}:#${issue}: ${invErr.message}`);
    return;
  }

  const basePrompt = path.join(PIPELINE, 'roles', '_base.md');
  const rolPrompt = path.join(PIPELINE, 'roles', `${skill}.md`);

  // Verificar que los prompts existen
  if (!fs.existsSync(basePrompt) || !fs.existsSync(rolPrompt)) {
    log('lanzamiento', `SKIP ${skill}:#${issue} — falta prompt (${!fs.existsSync(basePrompt) ? '_base.md' : skill + '.md'})`);
    return;
  }

  const base = fs.readFileSync(basePrompt, 'utf8');
  const rol = fs.readFileSync(rolPrompt, 'utf8');
  const workData = readYaml(trabajandoPath);

  // Escribir system prompt (rol) a archivo y user prompt corto como argumento
  const systemFile = path.join(LOG_DIR, `agent-${issue}-${skill}-system.txt`);
  fs.writeFileSync(systemFile, `${base}\n\n${rol}`);

  // Construir user prompt — enriquecer si es un rebote con contexto del rechazo
  let userPrompt = `Archivo de trabajo: ${path.basename(trabajandoPath)}\nPath: ${trabajandoPath}\nContenido:\n${yaml.dump(workData, { lineWidth: -1 })}`;

  // #2993 — Inyectar handoff cross-agente al userPrompt. Solo si:
  //   1) `handoff.enabled: true` y `kill_switch: false` en config.yaml, y
  //   2) la fase actual está en `handoff.inject_in_phases`.
  // Default OFF (rollout gradual). El bloque va envuelto en
  // `<handoff_externo>` con instructivo de no-autoritatividad (CA-A2/CA-A4 + CA-B1).
  // Las CAs de seguridad (sanitización, redacción) se aplican en `lib/handoff.js`
  // tanto al leer como al escribir.
  let handoffStats = { total_sections: 0, total_bytes: 0, in_tokens: 0 };
  try {
    const cfgRaw = (loadConfig() || {}).handoff;
    const cfg = handoff.resolveConfig(cfgRaw);
    if (handoff.shouldInject(fase, cfg)) {
      const built = handoff.buildPromptBlock(issue, {
        retentionDays: cfg.retention_days,
      });
      if (built.block) {
        userPrompt += built.block;
        handoffStats = {
          total_sections: built.stats.total_sections || 0,
          total_bytes: built.stats.total_bytes || 0,
          in_tokens: handoff.estimateTokens(built.block),
        };
        log('lanzamiento', `📎 ${skill}:#${issue} handoff inyectado (${handoffStats.total_sections} secciones, ${handoffStats.total_bytes}B, ~${handoffStats.in_tokens} tokens)`);
      }
    }
  } catch (e) {
    // Handoff es best-effort: NUNCA bloquear el spawn por bugs en el módulo.
    log('lanzamiento', `⚠️ ${skill}:#${issue} handoff inject falló (best-effort): ${e.message}`);
  }

  // #2801 — Si el issue fue desbloqueado manualmente con orientación humana,
  // human-block deja un archivo `<marker>.guidance.txt` junto al archivo de
  // trabajo. Lo inyectamos al prompt como bloque destacado para que el
  // agente sepa qué hacer ANTES de retomar el flujo normal. El archivo se
  // borra después de leerlo (one-shot) para no contaminar reintentos.
  try {
    const guidancePath = trabajandoPath + '.guidance.txt';
    if (fs.existsSync(guidancePath)) {
      const guidance = fs.readFileSync(guidancePath, 'utf8').trim();
      if (guidance) {
        userPrompt += `\n\n📋 INDICACIONES HUMANAS — Este issue venía bloqueado y fue reactivado por un operador con guía explícita. Tenelo en cuenta antes de actuar:\n\n${guidance}\n\nUsá esta orientación para informar tus decisiones — NO la ignores.`;
      }
      try { fs.unlinkSync(guidancePath); } catch {}
    }
  } catch (e) { log('lanzamiento', `⚠️ ${skill}:#${issue} no se pudo leer guidance: ${e.message}`); }

  if (workData.rebote) {
    const rechazadoEn = workData.rechazado_en_fase || 'desconocida';
    const motivo = workData.motivo_rechazo || 'sin motivo especificado';
    const buildLog = path.join(LOG_DIR, `build-${issue}.log`);
    const buildLogExists = fs.existsSync(buildLog);

    // #2404 — Defense-in-depth: si el YAML del pendiente llegó acá con un
    // motivo_rechazo que referencia el build-log y ese log es stale, no
    // queremos inyectarlo al prompt del developer (context pollution). En
    // ese caso redirigimos el issue a `build` y NO lanzamos al agente.
    // Esto cubre el caso donde el barrido no alcanzó a hacer el reset
    // (ej. restart del pulpo entre ciclos).
    try {
      const pipelineFases = ((loadConfig().pipelines || {})[pipeline] || {}).fases || [];
      if (pipelineFases.includes('build')
        && staleness.isValidIssueNumber(issue)
        && staleness.motivoReferencesBuildLog(motivo, issue)) {
        const cfg = loadConfig();
        const { ms: stalenessMs, hours: stalenessHrsEff } = staleness.getStalenessThresholdMs(cfg);
        const info = staleness.inspectBuildLog(issue, stalenessMs);
        if (info.exists && info.stale) {
          const resetsPrev = staleness.getStaleResetCount(issue);
          const maxResets = staleness.getMaxResetsPerIssue(cfg);
          if (resetsPrev < maxResets) {
            const resetsNuevo = resetsPrev + 1;
            const buildPendiente = path.join(fasePath(pipeline, 'build'), 'pendiente');
            const buildSkill = ((cfg.pipelines || {})[pipeline] || {}).skills_por_fase?.build?.[0] || 'build';
            const cleanYaml = staleness.cleanYamlForRebuild(workData);
            cleanYaml.issue = parseInt(issue);
            cleanYaml.pipeline = pipeline;
            cleanYaml.fase = 'build';
            const buildFile = path.join(buildPendiente, `${issue}.${buildSkill}`);
            writeYaml(buildFile, cleanYaml);

            staleness.appendAuditReset({
              ts: new Date().toISOString(),
              event: 'circuit_breaker_reset',
              issue: parseInt(issue),
              reason: 'stale_log',
              log_mtime: new Date(info.mtimeMs).toISOString(),
              log_age_hours: Number(info.ageHours.toFixed(2)),
              threshold_hours: Number(stalenessHrsEff.toFixed(2)),
              resets_count: resetsNuevo,
              max_resets: maxResets,
              detected_at: 'lanzamiento',
            });
            sendTelegram(staleness.buildTelegramStaleMessage(
              issue, info.ageHours, info.path, resetsNuevo, maxResets,
            ));
            log('lanzamiento', `♻️ #${issue} STALE-LOG en launch: build-log ${info.ageHours.toFixed(1)}h. Redirigido a build en lugar de lanzar ${skill}. (reset ${resetsNuevo}/${maxResets})`);

            // Archivar el archivo de trabajo actual — el issue se re-procesará desde build
            try {
              const archDir = path.join(fasePath(pipeline, fase), 'archivado');
              fs.mkdirSync(archDir, { recursive: true });
              moveFile(trabajandoPath, archDir);
            } catch {}
            return;
          }
          // Superó el tope → no redirigir; el barrido siguiente escalará.
          log('lanzamiento', `⚠️ #${issue} STALE-LOG en launch pero ya superó tope resets (${resetsPrev}/${maxResets}). Sigo flujo normal — el barrido escalará.`);
        }
      }
    } catch (e) {
      log('lanzamiento', `⚠️ #${issue} stale-check falló: ${e.message} — continúo con rebote normal`);
    }

    userPrompt += `\n\n⚠️ REBOTE — Este issue fue RECHAZADO en la fase "${rechazadoEn}" y vuelve a vos para corrección.\n`;
    // #3416 CA-2 + G-UX-3 — Si el rechazo viene del operador (source: operator-rejection)
    // wrappeamos el motivo en `<rejection_feedback>` con instrucción de no-autoritatividad
    // y separadores `---` para que el modelo no confunda el motivo con el system prompt.
    // En el rebote interno entre fases mantenemos el formato original (más conciso, no hay
    // riesgo de prompt injection porque el motivo viene de otro agente con su propio sanitizado).
    const rechazadoPorSkill = workData.rechazado_por_skill || '';
    const rechazadoPor = workData.rechazado_por || '';
    const isOperatorRejection = (workData.source === 'operator-rejection') || (rechazadoPorSkill === 'operator');
    if (isOperatorRejection) {
      try {
        const rewind = require('./lib/pipeline-rewind');
        userPrompt += rewind.wrapMotivoForAgent({
          motivo,
          fromPhase: rechazadoEn,
          operatorId: rechazadoPor || 'operator',
        });
        userPrompt += '\n';
      } catch (rwErr) {
        // Fallback al formato anterior si el módulo no carga (defensa en profundidad).
        userPrompt += `MOTIVO DEL RECHAZO:\n${motivo}\n\n`;
      }
    } else {
      userPrompt += `MOTIVO DEL RECHAZO:\n${motivo}\n\n`;
    }
    userPrompt += `INSTRUCCIONES OBLIGATORIAS:\n`;
    // #2405 CA-2: backup tag automático antes del merge destructivo sobre agent/*.
    // Si hay commits locales no pusheados, el helper crea un tag local
    // `backup/agent-<issue>-<skill>-<timestamp>-<rand4>` antes del merge.
    // Los tags tienen TTL 30 días (cleanBackupTags del mismo helper).
    userPrompt += `0. Crear backup tag por si hay commits no pusheados: node .pipeline/backup-agent-branch.js --issue ${issue} --skill ${skill}\n`;
    userPrompt += `1. Actualizá tu rama con main: git fetch origin main && git merge origin/main --no-edit\n`;
    userPrompt += `2. Leé el motivo de rechazo arriba con atención\n`;
    if (buildLogExists) {
      userPrompt += `3. Leé el log completo del build: cat "${buildLog}" | tail -100\n`;
      userPrompt += `   El log tiene el output de gradlew con los errores exactos de compilación o tests\n`;
    }
    userPrompt += `4. Diagnosticá la causa raíz del fallo\n`;
    userPrompt += `5. Corregí el código en tu worktree\n`;
    userPrompt += `6. Verificá que compila: ./gradlew check --no-daemon\n`;
    userPrompt += `7. Commiteá y pusheá los fixes\n`;
    userPrompt += `\nNO reimplementes desde cero. Focalizá solo en corregir los errores del rechazo.\n`;
  }

  // Determinar si necesita worktree (solo fases que modifican código)
  const needsWorktree = (fase === 'dev');
  // #2526: fases que LEEN código del issue (no generan commits) deben correr
  // en el worktree del dev, no en ROOT. Si corren en ROOT, leen la rama
  // arbitraria del repo principal (puede estar checkout en la rama de OTRO
  // agente) y producen resultados incorrectos. Incidente 2026-04-24: linter
  // de #2505 corrió en ROOT (checkout en agent/2450), reportó 'no-commits'
  // aunque el worktree del #2505 tenía 3 commits legítimos.
  //
  // #2519 (rev-1, 2026-04-24): además se incluye `entrega`. El fix original
  // (#2526) explicitó "entrega no toca git local, usa PR de GitHub" pero eso
  // es FALSO: skills-deterministicos/delivery.js hace git add/commit/rebase/push
  // en local antes del gh pr create. Si corre en ROOT, usa la rama y árbol del
  // repo principal (rama ajena + cambios sucios de heartbeats/registry) y
  // produce: rebase conflicts, commits a la rama equivocada, push a otra
  // branch. Incidente real: delivery del #2519 corrió en ROOT con branch
  // agent/2523-... y 66 archivos sucios, falló rebase con "unstaged changes".
  const useExistingWorktree = (fase === 'build' || fase === 'linteo' || fase === 'aprobacion' || fase === 'entrega');
  // #2591 — Inicializamos en `null` para que cualquier rama olvidada que use
  // `worktreePath` sin resolverlo falle ruidosamente en vez de degradar
  // silenciosamente a ROOT (que producía commits cruzados entre agentes).
  let worktreePath = null;
  let worktreeBranch = null;

  if (needsWorktree) {
    try {
      const result = ensureLaunchWorktree({
        ROOT,
        issue,
        skill,
        log: (msg) => log('lanzamiento', msg),
      });
      worktreePath = result.worktreePath;
      worktreeBranch = result.worktreeBranch;
      if (result.recovered) {
        log('lanzamiento', `♻️ Branch huérfana recuperada para #${issue} antes de crear el worktree`);
      }
    } catch (e) {
      const code = (e instanceof WorktreeLaunchError) ? e.code : 'UNKNOWN';
      log('lanzamiento', `Error creando worktree para #${issue} [${code}]: ${e.message}`);
      const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
      moveFile(trabajandoPath, pendienteDir);
      return;
    }
  } else if (useExistingWorktree) {
    // #2591 — Fast-fail con auto-recovery validado. Eliminamos el fallback a
    // ROOT que existía antes: si no podemos resolver el worktree del issue,
    // abortamos ANTES del spawn y rebotamos a `pendiente/` con
    // `rebote_tipo: 'infra'` (no consume budget de circuit breaker).
    //
    // El resolver hace:
    //   1. Validación dura de issue (`/^\d+$/`) y skill (regex segura).
    //   2. `git worktree list --porcelain` vía spawnSync (sin shell parsing).
    //   3. Si no encuentra → intenta auto-recovery desde `origin/agent/<n>-<skill>`
    //      validando procedencia de la branch remota (autor allowlisted o
    //      marker `pipeline-v2` en commits).
    //   4. Si recovery falla → retorna `{ found: false, reason, branchOriginVerified }`.
    let resolution;
    try {
      resolution = resolveExistingWorktree({
        ROOT,
        issue,
        skill,
        log: (msg) => log('lanzamiento', msg),
      });
    } catch (e) {
      // Validación falló (issue/skill malformado) — defense-in-depth.
      log('lanzamiento', `⛔ #${issue}: input inválido en resolución de worktree (${e.code || 'UNKNOWN'}): ${e.message.slice(0, 120)}`);
      resolution = { found: false, reason: `invalid-input:${e.code || 'UNKNOWN'}`, branchOriginVerified: null };
    }

    if (resolution.found) {
      worktreePath = resolution.worktreePath;
      const tag = resolution.recovered ? 'recovered' : 'existing';
      log('lanzamiento', `${skill}:#${issue} (fase ${fase}): worktree ${tag} ${worktreePath}`);
    } else {
      // ── ABORTO LIMPIO — no spawneamos al agente ─────────────────────────
      const motivoMsg = (
        `Worktree del issue no encontrado — pulpo no puede ejecutar fase ${fase} sin worktree dedicado. ` +
        `Detalle: ${resolution.reason || 'desconocido'}`
      );
      log('lanzamiento',
        `⛔ #${issue}: NO se encontró worktree platform.agent-${issue}-* para fase ${fase} — abortando spawn (evita commit en rama ajena). Motivo: ${resolution.reason || 'desconocido'}`);

      // Audit trail persistente (CA-8).
      try {
        appendWorktreeAudit({
          event: 'abort',
          issue,
          fase,
          skill,
          motivo: resolution.reason || 'no-worktree-found',
          recovery_attempted: true,
          recovery_succeeded: false,
          branch_origin_verified: resolution.branchOriginVerified,
        });
      } catch {}

      // Notificación Telegram dedupeada (CA-4). Cambia el copy si la
      // verificación de procedencia falló (UX CA-5): es señal potencial de
      // adversario, no de cleanup normal.
      try {
        if (worktreeNotifDedup.shouldNotify(issue, fase)) {
          const unverified = resolution.branchOriginVerified === false;
          const msg = unverified
            ? [
                `🚨 #${issue}: branch remota origin/agent/${issue}-${skill} no verificada.`,
                'Auto-recovery rechazado. Inspeccionar autor del primer commit antes de re-encolar.',
              ].join('\n')
            : [
                `⛔ Aborté #${issue} en fase ${fase}: no encontré el worktree platform.agent-${issue}-*.`,
                `Motivo: ${resolution.reason || 'sin detalle'}`,
                'Cómo resolverlo: re-encolá el issue al inicio del pipeline para que el dev cree el worktree limpio.',
              ].join('\n');
          try { sendTelegram(msg); } catch {}
          worktreeNotifDedup.markNotified(issue, fase);
        }
      } catch {}

      // Rebote a pendiente/ con rebote_tipo:'infra' para que el sweep
      // `reencolarInfraBloqueados` lo procese sin consumir budget del CB.
      try {
        const data = readYaml(trabajandoPath) || {};
        const updated = {
          ...data,
          rebote_tipo: 'infra',
          rebote: true,
          motivo_rechazo: motivoMsg,
          rechazado_en_fase: fase,
          rechazado_por_skill: skill,
          bloqueado_por_infra: true,
          infra_motivo: motivoMsg,
          infra_ultimo_check: new Date().toISOString(),
          worktree_missing: true,
          worktree_recovery_attempted: true,
          worktree_recovery_succeeded: false,
          worktree_branch_origin_verified: resolution.branchOriginVerified,
        };
        writeYaml(trabajandoPath, updated);
      } catch (e) {
        log('lanzamiento', `⚠️ #${issue}: no se pudo actualizar YAML con motivo de aborto: ${e.message.slice(0, 120)}`);
      }
      try {
        const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
        moveFile(trabajandoPath, pendienteDir);
      } catch (e) {
        log('lanzamiento', `⚠️ #${issue}: no se pudo mover a pendiente tras aborto: ${e.message.slice(0, 120)}`);
      }
      return;
    }
  }

  const args = ['-p', userPrompt, '--system-prompt-file', systemFile, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];

  log('lanzamiento', `Lanzando ${skill}:#${issue} (fase: ${fase}, pipeline: ${pipeline})`);

  // Log de agente: stdout/stderr pasan por un `createSanitizeStream`
  // antes de escribirse a disco (#2334 / CA6). El contenido original
  // NUNCA llega al archivo, ni siquiera transitoriamente.
  //
  // Nota: el header "--- skill:#issue ... ---" es texto controlado por el
  // pulpo (no viene del agente), así que lo escribimos directo antes de
  // abrir el stream sanitizado; igualmente pasa por `sanitizePipelineText`
  // por consistencia.
  const agentLogPath = path.join(LOG_DIR, `${issue}-${skill}.log`);
  fs.writeFileSync(agentLogPath, sanitizePipelineText(`--- ${skill}:#${issue} fase:${fase} pipeline:${pipeline} ${new Date().toISOString()} ---\n`));
  const agentLogWriter = createLogFileWriter(agentLogPath);

  // --- RECORDING AUTOMÁTICO: iniciar screenrecord en background para QA android ---
  // El pipeline graba, no el agente. Así garantizamos que siempre hay video.
  let qaRecordingProc = null;
  let qaRecordingPath = null;
  const qaSerial = extraEnv.QA_EMULATOR_SERIAL;
  if (skill === 'qa' && fase === 'verificacion' && qaSerial) {
    try {
      const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
      fs.mkdirSync(evidenceDir, { recursive: true });
      qaRecordingPath = `/sdcard/qa-${issue}-pipeline.mp4`;
      // screenrecord tiene límite de 3 minutos por defecto. Usamos --time-limit 180
      // y --bit-rate 6M para balance calidad/tamaño. Si el agente dura más, el video
      // captura los primeros 3 minutos que es donde ocurre el flujo principal.
      qaRecordingProc = spawn('adb', [
        '-s', qaSerial, 'shell',
        `screenrecord --time-limit 180 --bit-rate 6000000 ${qaRecordingPath}`
      ], { stdio: 'ignore', detached: true, windowsHide: true });
      qaRecordingProc.unref();
      log('lanzamiento', `🎬 Recording iniciado para qa:#${issue} (serial: ${qaSerial})`);
    } catch (e) {
      log('lanzamiento', `⚠️ Error iniciando recording para qa:#${issue}: ${e.message.slice(0, 80)}`);
      qaRecordingProc = null;
    }
  }

  // #3074 / H2 multi-provider — el spawn del agente (LLM o determinístico) se
  // delega al wrapper `launchAgent` (`lib/agent-launcher.js`). El dispatcher
  // resuelve el provider según `agent-models.json` (skill → provider+modelo);
  // si el archivo no existe, defaultea a Anthropic con modelo legacy
  // ("claude-opus-4-7") preservando regresión cero corriendo solo Anthropic.
  //
  // Skills determinísticos (allowlist hardcoded: builder/tester/delivery/linter)
  // siempre van por provider="deterministic" y corren `skills-deterministicos/<skill>.js`
  // con Node puro. Si el script fue removido (rollout reversible #2476), el
  // wrapper cae a Anthropic LLM automáticamente.
  //
  // PIPELINE_WORKTREE: refuerzo defensivo del cwd. Algunos skills determinísticos
  // (linter.js #2523 rev-1) precomputan rutas absolutas en tiempo de carga y no
  // respetan el cwd del spawn salvo que se les diga explícitamente. Pasarlo como
  // env evita que vuelvan a leer la rama del checkout principal por accidente.
  const spawnCwd = (needsWorktree || useExistingWorktree) ? worktreePath : ROOT;

  // #3085 / S7 multi-provider — aislamiento de credenciales por proceso.
  //
  // pipelineExtras = vars de contexto del child (PIPELINE_*, handoff, extras
  // específicos del skill). Se pasan SIEMPRE — son inocuas y necesarias para
  // que el agente sepa qué issue/fase/skill está procesando.
  const pipelineExtras = {
    PIPELINE_ISSUE: issue,
    PIPELINE_SKILL: skill,
    PIPELINE_FASE: fase,
    PIPELINE_PIPELINE: pipeline,
    PIPELINE_TRABAJANDO: trabajandoPath,
    PIPELINE_WORKTREE: spawnCwd,
    PIPELINE_REPO_ROOT: ROOT,
    // #2993 — el agente usa estos para escribir su sección de handoff antes
    // de salir (paso 7.5 de roles/_base.md). Si `ENABLED=0`, el agente NO
    // escribe — kill-switch global desde config.yaml → handoff.enabled.
    PIPELINE_HANDOFF_PATH: handoff.handoffPathFor(issue),
    PIPELINE_HANDOFF_ENABLED: (() => {
      try {
        const cfg = handoff.resolveConfig((loadConfig() || {}).handoff);
        return cfg.enabled ? '1' : '0';
      } catch { return '0'; }
    })(),
    ...extraEnv,
  };

  // Resolver env del child:
  //   - Flag `pipeline.env_isolation_enabled: true` → filtrado por
  //     buildChildEnv (allowlist mínima + scope del skill + provider key).
  //   - Flag false (default rollout) → comportamiento previo: heredar TODO
  //     `process.env`. Preserva regresión cero hasta que validemos en
  //     producción que ningún hook/skill rompa por falta de credencial.
  let childEnv;
  let envIsolationEnabled = false;
  try {
    const cfgRoot = loadConfig() || {};
    envIsolationEnabled = !!(cfgRoot.pipeline && cfgRoot.pipeline.env_isolation_enabled);
  } catch { /* sin config legible: default false (preserva legacy) */ }
  if (envIsolationEnabled) {
    try {
      // #3198 / S-2: cuando el dispatcher eligió un fallback, construimos el
      // env con el PROVIDER DEL FALLBACK — no el primary. Eso garantiza que
      // un child Anthropic→OpenAI reciba sólo OPENAI_API_KEY (S-2 isolation).
      // El override se pasa vía `skillConfigOverride`, que tiene precedencia
      // sobre la lectura de agent-models.json.
      const skillConfigOverride = (
        dispatchResolution &&
        dispatchResolution.source === 'fallback' &&
        dispatchResolution.provider
      )
        ? { provider: dispatchResolution.provider }
        : undefined;
      childEnv = buildChildEnvLib.buildChildEnv({
        skill,
        pipelineDir: PIPELINE,
        processEnv: process.env,
        pipelineExtras,
        skillConfigOverride,
      });
    } catch (e) {
      // Fail-fast: si la API key del provider falta, NO arrancar el child.
      // Loguear con mensaje accionable y propagar el error para que el caller
      // (lanzarAgenteClaude) marque el archivo como fallo de infra.
      log('lanzamiento', `❌ env-isolation rechazó spawn de ${skill}:#${issue}: ${e.message}`);
      throw e;
    }
  } else {
    childEnv = { ...process.env, ...pipelineExtras };
  }

  // #3198 — si el dispatcher resolvió un fallback, pasamos un `resolveImpl`
  // que devuelve esa resolución completa para que `launchAgent` use el handler
  // y el modelo del fallback (no del primary). Sin esta línea, el launcher
  // re-resolvería desde agent-models.json y volvería al primary.
  const launchResolveImpl = (
    dispatchResolution &&
    dispatchResolution.source === 'fallback' &&
    dispatchResolution.handler
  )
    ? () => ({
        provider: dispatchResolution.provider,
        model: dispatchResolution.model,
        handler: dispatchResolution.handler,
        source: 'dispatch-fallback',
      })
    : undefined;

  const launchResult = launchAgent({
    skill, issue, trabajandoPath, fase, pipeline,
    args,
    cwd: spawnCwd,
    env: childEnv,
    PIPELINE,
    ROOT,
    onWorktreeHit: (wt) => log('lanzamiento', `⚡ ${skill}:#${issue} usa script del worktree (${wt})`),
    onLog: log,
    resolveImpl: launchResolveImpl,
  });
  const child = launchResult.child;
  const useDeterministicSkill = (launchResult.provider === 'deterministic');
  if (useDeterministicSkill) {
    log('lanzamiento', `⚡ ${skill}:#${issue} ejecutado en modo determinístico (sin tokens LLM)`);
  }

  // #3605 — Registrar stdin del child en agent-ipc si el skill opt-in
  // (`interactive_supported: true` en agent-models.json). Solo así el endpoint
  // /api/agent-chat del dashboard puede canalizar mensajes operador→agente.
  // Default OFF: si el skill no opt-in, NO se registra y el endpoint responde
  // 412 Precondition Failed con motivo claro. Preserva I3 del launcher.
  //
  // El `unregisterAgent` lo hace el `child.on('exit')` más abajo.
  if (launchResult.interactive_supported === true && child && child.stdin) {
    try {
      const agentIpc = require('./lib/agent-ipc');
      agentIpc.getRegistry().registerAgent(
        String(issue), String(skill), String(fase || ''), child.stdin, { pid: child.pid }
      );
      log('lanzamiento', `💬 ${skill}:#${issue} registrado en agent-ipc (interactive_supported=true, PID ${child.pid})`);
    } catch (e) {
      // Best-effort: si el registro falla, el agente sigue corriendo
      // normalmente; solo se pierde la capacidad de chat operador→agente.
      log('lanzamiento', `agent-ipc.registerAgent falló para ${skill}:#${issue}: ${e.message}`);
    }
  }

  // #2801 — parseTokensFromLog delega ahora al handler del provider resuelto
  // por `launchAgent`. Cada provider trae su propia implementación (Anthropic
  // parsea stream-json; deterministic devuelve zeros — no consume LLM tokens).
  function parseTokensFromLog(logPath) {
    return launchResult.handler.parseTokensFromLog(logPath);
  }

  // #2801 — emit session:start para agentes Claude (LLM). Los skills
  // determinísticos emiten su propio par session:start/end internamente,
  // así que solo cubrimos el path LLM acá. El handle se usa luego en
  // child.on('exit') para emitir session:end con tokens parseados del log.
  //
  // #3083 (S5 multi-provider — audit trail dinámico):
  //   - Eliminado fallback `|| 'claude-opus-4-7'` (CA-1): el caller no puede
  //     inventar un modelo; si `agent-models.json` no resolvió, el resolver
  //     dejó `launchResult.model = null` y el campo aparece como `unknown`
  //     en el log (señal forense legítima de bug del resolver, no falsa claim).
  //   - `provider` viene explícito del launchResult (CA-9, SEC-8).
  //   - `cli_version` y `git_sha_provider_adapter` se resuelven empíricamente
  //     acá (no via env vars — SEC-2/SEC-3).
  //   - `prompt_hash` se calcula con `hashPromptPair(systemContent, userContent)`
  //     ANTES del spawn — el módulo de traceability NUNCA recibe el contenido
  //     (SEC-1 / defensa en profundidad).
  let traceHandle = null;
  if (!useDeterministicSkill) {
    // (#3083 / CA-2) Resolver cli_version desde el launcher del provider.
    // El provider Anthropic expone `detectLauncher()` → `{cmd, ...}`. Otros
    // providers que no tienen launcher externo (deterministic, openai-codex
    // stub) caen al default 'n/a' o 'unknown' del propio traceability.
    let cliVersion = 'unknown';
    try {
      const handler = launchResult && launchResult.handler;
      if (handler && typeof handler.detectLauncher === 'function') {
        const launcher = handler.detectLauncher();
        if (launcher && launcher.cmd) {
          cliVersion = trace.resolveCliVersion(launcher.cmd);
        }
      }
    } catch (e) {
      log('lanzamiento', `traceability resolveCliVersion falló: ${e.message}`);
    }
    // (#3083 / CA-2 / SEC-2) git_sha del adaptador en uso. NUNCA inferir de
    // env vars — un atacante con control de spawn args podría spoofear el SHA.
    let adapterSha = null;
    try {
      const providerName = (launchResult && launchResult.provider) || 'anthropic';
      const adapterPath = path.join(PIPELINE, 'lib', 'agent-launcher', 'providers', `${providerName}.js`);
      adapterSha = trace.resolveProviderAdapterSha(adapterPath);
    } catch (e) {
      log('lanzamiento', `traceability resolveProviderAdapterSha falló: ${e.message}`);
    }
    // (#3083 / CA-3 / SEC-1) Hash del par system+user prompt. ANTES del spawn,
    // descartamos cualquier referencia al contenido — solo el digest viaja.
    // El systemFile ya está escrito a disco (línea ~4833); leerlo de vuelta
    // para hashear es cheap y garantiza paridad con lo que el agente verá.
    let promptHash = null;
    try {
      let systemContent = '';
      try { systemContent = fs.readFileSync(systemFile, 'utf8'); } catch (_) {}
      promptHash = trace.hashPromptPair(systemContent, userPrompt);
    } catch (e) {
      log('lanzamiento', `traceability hashPromptPair falló: ${e.message}`);
    }
    try {
      traceHandle = trace.emitSessionStart({
        skill, issue: parseInt(issue), phase: fase,
        // (#3083 / CA-1) NO MÁS `|| 'claude-opus-4-7'`. Si el resolver no
        // entregó un modelo, dejamos que `emitSessionStart` use su default
        // ('deterministic'). El audit trail tiene que reflejar la realidad.
        model: launchResult.model,
        // (#3078 / #3083-CA-9) provider explícito desde agent-models.json.
        // No inferir por substring del model name (SEC-8).
        provider: launchResult.provider || 'anthropic',
        // (#3083 / CA-2)
        cli_version: cliVersion,
        git_sha_provider_adapter: adapterSha,
        // (#3083 / CA-3) prompt_hash viaja por el handle hasta emitSessionEnd.
        prompt_hash: promptHash,
      });
    } catch (e) {
      log('lanzamiento', `traceability emitSessionStart falló: ${e.message}`);
    }
  }

  // #2334 / CA6: piping stdout/stderr → sanitizeStream → file.
  // Montamos un único writer compartido para preservar el orden
  // aproximado entre stdout y stderr (mismo archivo, mismo stream).
  // Si el spawn falló (child.stdout null), el try/catch evita tirar
  // el pulpo; en ese caso la salida del hijo se descarta (el exit code
  // sigue llegando vía child.on('exit')).
  try {
    if (child.stdout) child.stdout.pipe(agentLogWriter.writable, { end: false });
    if (child.stderr) child.stderr.pipe(agentLogWriter.writable, { end: false });
  } catch (e) {
    log('lanzamiento', `⚠️ No se pudo pipear stdio del agente ${skill}:#${issue}: ${e.message}`);
  }
  child.unref();

  // Watchdog de timeout por skill: mata al hijo si excede el límite configurado.
  // Razón: sin enforcement, un /builder con OOM repetido puede quedar 1h+ en loop
  // (incidente #2218). El tope de 30m del rol no se aplica solo — hay que forzarlo.
  const timeoutOverrides = config.timeouts?.agent_timeout_overrides || {};
  const timeoutDefault = config.timeouts?.agent_timeout_default_minutes || 30;
  const timeoutMin = timeoutOverrides[skill] ?? timeoutDefault;
  const timeoutMs = timeoutMin * 60 * 1000;
  // #2400: log del origen del timeout (override vs default) para debug de DevEx.
  const timeoutOrigin = (skill in timeoutOverrides) ? 'override' : 'default';
  const watchdog = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      log('lanzamiento', `⏱️ ${skill}:#${issue} excedió ${timeoutMin}min (${timeoutOrigin}) — matando (watchdog)`);
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000);
      // #2400: paridad con fast-fail — limpiar Gradle daemons huérfanos tras el kill.
      // Delay 15s para dejar que SIGTERM→SIGKILL cierren el proceso primero.
      const cleanupCwd = (needsWorktree || useExistingWorktree) ? worktreePath : ROOT;
      setTimeout(() => {
        try {
          const killed = killGradleDaemonsForCwd(cleanupCwd, `${skill}:#${issue} (watchdog)`);
          log('lanzamiento', `🧹 cleanup post-watchdog ${skill}:#${issue}: ${killed || 0} daemons Gradle terminados`);
        } catch (e) {
          log('lanzamiento', `⚠️ cleanup post-watchdog ${skill}:#${issue} falló: ${e.message}`);
        }
      }, 15000);
      try {
        const data = readYaml(trabajandoPath);
        data.resultado = 'rechazado';
        data.motivo = `Timeout de watchdog: excedió ${timeoutMin} minutos sin terminar`;
        data.rechazado_por = 'watchdog-timeout';
        writeYaml(trabajandoPath, data);
      } catch {}
      sendTelegram(`⏱️ ${skill}:#${issue} matado por watchdog (${timeoutMin}min). Rebote a pendiente.`);
    }
  }, timeoutMs);
  watchdog.unref?.();

  activeProcesses.set(processKey(skill, issue), {
    pid: child.pid,
    startTime: Date.now(),
    trabajandoPath,
    pipeline,
    fase,
    worktreePath: (needsWorktree || useExistingWorktree) ? worktreePath : null,
    watchdog
  });

  // Crear canal de contexto para el agente (auto-join)
  let contextChannelId = null;
  try {
    const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
    const channelId = 'agent-' + issue;
    let channel = cm.getChannel(channelId);
    if (!channel) {
      channel = cm.createChannel(channelId, skill + ' #' + issue, {
        type: 'agent', issue: '#' + issue, skill: skill,
        branch: worktreeBranch || null, worktree: needsWorktree ? worktreePath : null,
      });
    }
    cm.joinChannel(channelId, {
      type: 'agent', session_id: String(child.pid),
      label: skill + ' #' + issue,
    });
    contextChannelId = channelId;
    log('lanzamiento', `Canal de contexto creado: ${channelId}`);
  } catch (e) {
    log('lanzamiento', `Error creando canal de contexto: ${e.message}`);
  }

  // Cuando el proceso termina, mover de trabajando → listo
  const launchTime = Date.now();
  child.on('exit', (code) => {
    // #2334: cerrar el writer sanitizado del log (flush + close).
    // Lo hacemos async pero no bloqueamos el resto del handler.
    try { agentLogWriter.close().catch(() => {}); } catch {}
    // Cancelar watchdog de timeout (ya terminó, por el motivo que sea)
    clearTimeout(watchdog);

    // #3605 — Desregistrar del agent-ipc registry. Idempotente: si nunca se
    // registró (interactive_supported=false), unregister es no-op. Drena
    // promesas pendientes en la cola con AGENT_DEAD para no dejar callers
    // colgados del endpoint /api/agent-chat.
    if (launchResult.interactive_supported === true) {
      try {
        const agentIpc = require('./lib/agent-ipc');
        agentIpc.getRegistry().unregisterAgent(String(issue), String(skill), String(fase || ''));
      } catch (e) {
        log('lanzamiento', `agent-ipc.unregisterAgent falló para ${skill}:#${issue}: ${e.message}`);
      }
    }

    const elapsedSec = (Date.now() - launchTime) / 1000;

    // #2974 — Detector de cuota agotada sobre el log del agente. Buscamos un
    // result event con shape estructurado (CA-1) y, si match, seteamos el flag
    // para gatear futuros spawns LLM. Si el spawn fue exitoso (exit 0 sin
    // result is_error), drenado proactivo del flag (CA-3 del padre).
    // SIEMPRE best-effort: el detector NUNCA puede romper el lifecycle del agente.
    //
    // #3576 CA-3 — Feature flag PIPELINE_GENERALIZED_PARSER_ENABLED (default OFF):
    //   - OFF (legacy): código inline de abajo — preserva comportamiento
    //     pre-#3576 byte-identical hasta que el rollout 3-olas valide paridad.
    //   - ON  (generalized): delega al hook `onSpawnExit` del dispatcher
    //     que reusa `lib/agent-launcher/provider-error-parser` para
    //     clasificación cross-skill unificada (#3576 CA-2 + CA-8).
    //
    // Ambos paths emiten un log estructurado `{codepath, skill, provider,
    // error_class}` con emojis 🛡️/🆕 SOLO en el log textual (NO en JSON)
    // para diff manual de paridad (refinación R3 guru + R2 ux).
    if (!useDeterministicSkill) {
      try {
        const dispatcher = require('./lib/agent-launcher/dispatch-with-fallback');
        const cfg = (loadConfig() || {}).quota_detector || {};
        const auditEnabled = cfg.audit_log_enabled !== false;
        const logPath = path.join(LOG_DIR, `${issue}-${skill}.log`);
        let raw = '';
        try { raw = fs.readFileSync(logPath, 'utf8'); } catch {}

        // Resolución provider/model del skill — necesaria en ambos paths.
        let skillProvider = null;
        let skillModel = null;
        let providerDef = null;
        try {
          skillProvider = resolveSkillProvider(skill);
          skillModel = resolveSkillModel(skill);
          providerDef = getSkillProviderDef(skillProvider);
        } catch { /* defensa */ }

        const generalizedEnabled = dispatcher.isGeneralizedParserEnabled();

        if (generalizedEnabled) {
          // -----------------------------------------------------------------
          // #3576 path generalizado — delegación al hook cross-skill.
          // -----------------------------------------------------------------
          const result = dispatcher.onSpawnExit({
            skill,
            issue,
            provider: skillProvider,
            // El log del agente Claude es shape stream-json — tratamos
            // como transport 'cli' (mismo shape estructural).
            transport: 'cli',
            rawOutput: raw,
            exitCode: code,
            timedOut: false,
            durationMs: Math.round(elapsedSec * 1000),
            pipelineDir: PIPELINE,
            onLog: log,
          });
          log('lanzamiento',
            `${dispatcher.CODEPATH_EMOJI.generalized} codepath=generalized skill=${skill} ` +
            `provider=${skillProvider || 'unknown'} error_class=${result.errorClass} ` +
            `flag_set=${result.flagSet} decision=${result.decision}`);
          if (result.errorClass === 'quota_exhausted' && result.flagSet) {
            log('lanzamiento', `🚫 ${skill}:#${issue} reportó cuota agotada (provider=${skillProvider || 'unknown'}) — flag seteado por hook generalizado`);
          } else if (code === 0) {
            // Drenado proactivo — mantiene CA-3 padre + #3077 CA-8 scope per-provider.
            try {
              quotaExhausted.clearFlag({
                event: 'success_spawn',
                reason: `${skill}:#${issue}`,
                provider: skillProvider,
                model: skillModel,
              });
            } catch {}
          }
        } else {
          // -----------------------------------------------------------------
          // Legacy path (default en main) — comportamiento previo a #3576.
          // -----------------------------------------------------------------
          let matched = false;
          let matchedLine = '';
          let matchedDetail = null;
          if (raw) {
            for (const line of raw.split('\n')) {
              if (!line.startsWith('{')) continue;
              let evt;
              try { evt = JSON.parse(line); } catch { continue; }
              // Si tenemos providerDef, dispatcher por provider; sino legacy.
              const det = providerDef
                ? quotaExhausted.detectQuotaError(evt, providerDef)
                : quotaExhausted.detectFromResultEvent(evt, cfg);
              if (det.matched) {
                matched = true;
                matchedLine = line;
                matchedDetail = { evt, errorType: det.errorType };
                break;
              }
            }
          }
          const legacyErrorClass = matched ? 'quota_exhausted' : (code === 0 ? 'success' : 'unknown');
          log('lanzamiento',
            `${dispatcher.CODEPATH_EMOJI.legacy} codepath=legacy skill=${skill} ` +
            `provider=${skillProvider || 'unknown'} error_class=${legacyErrorClass} ` +
            `matched=${matched}`);
          if (matched) {
            log('lanzamiento', `🚫 ${skill}:#${issue} reportó cuota agotada (provider=${skillProvider || 'unknown'}, error_type="${matchedDetail.errorType}") — seteando flag`);
            quotaExhausted.setFlag({
              errorType: matchedDetail.errorType,
              // #3077 SEC-1 / SEC-7: provider/model del skill que disparó.
              provider: skillProvider,
              model: skillModel,
              resetsAt: matchedDetail.evt.resets_at,
              // #3077 SEC-6: cap configurable por provider (Anthropic 7d,
              // OpenAI 31d). Si providerDef define resets_at_cap_max_days, se
              // usa; sino caemos al cfg legacy de config.yaml.
              maxDays: (providerDef && providerDef.resets_at_cap_max_days) || cfg.resets_at_cap_max_days,
              agent: skill,
              rawExcerpt: matchedLine,
              auditLogEnabled: auditEnabled,
            });
          } else if (code === 0) {
            // CA-3 del padre: spawn exitoso → drenado proactivo del flag.
            // #3077 CA-8: scope por provider — si el flag activo es de otro
            // provider, NO se limpia.
            try {
              quotaExhausted.clearFlag({
                event: 'success_spawn',
                reason: `${skill}:#${issue}`,
                provider: skillProvider,
                model: skillModel,
              });
            } catch {}
          }
        }
      } catch (qErr) {
        log('lanzamiento', `quota_detector (agent log) falló (best-effort) para ${skill}:#${issue}: ${qErr.message}`);
      }
    }

    // #2801 — emit session:end para agentes Claude. Damos un pequeño delay
    // para que el writer termine de flushear el último chunk del log antes
    // de parsearlo. No bloqueamos el resto del handler.
    if (traceHandle) {
      setTimeout(() => {
        try {
          const logPath = path.join(LOG_DIR, `${issue}-${skill}.log`);
          const tk = parseTokensFromLog(logPath);
          // #2993 — telemetría de handoff sin contenido (CA-C1):
          //   handoff_in_tokens: tokens estimados del bloque inyectado al prompt.
          //   handoff_out_bytes: bytes de la sección que escribió este skill,
          //                       leídos del archivo post-exit.
          let handoffOutBytes = 0;
          try {
            const ho = handoff.readHandoff(issue);
            const mine = ho.sections.find(s => s.skill === skill);
            if (mine) handoffOutBytes = mine.byteLength || 0;
          } catch {}
          trace.emitSessionEnd(traceHandle, {
            tokens_in: tk.input,
            tokens_out: tk.output,
            cache_read: tk.cache_read,
            cache_write: tk.cache_create,
            tool_calls: tk.tool_calls,
            exit_code: code == null ? -1 : code,
            duration_ms: Math.round(elapsedSec * 1000),
            handoff_in_tokens: handoffStats.in_tokens || 0,
            handoff_out_bytes: handoffOutBytes,
            handoff_sections_in: handoffStats.total_sections || 0,
          });
        } catch (e) {
          log('lanzamiento', `traceability emitSessionEnd falló para ${skill}:#${issue}: ${e.message}`);
        }
      }, 500);
    }

    // Si murió en menos de 15 segundos con error → fallo de infra + COOLDOWN
    //
    // Excepción (#2524): si el agente alcanzó a escribir un YAML con veredicto
    // válido (`resultado: aprobado | rechazado`), NO es muerte prematura — es
    // terminación legítima. Aplica principalmente a skills determinísticos
    // (linter, builder, delivery, tester en modo no-LLM) que terminan rápido
    // por diseño y emiten veredicto explícito antes del exit.
    if (code !== 0 && elapsedSec < 15) {
      let hasVerdict = false;
      try {
        const quickYaml = readYaml(trabajandoPath) || {};
        hasVerdict = quickYaml.resultado === 'aprobado' || quickYaml.resultado === 'rechazado';
      } catch {}

      if (!hasVerdict) {
        const { failures, delayMin } = registerFastFail(skill, issue);
        log('lanzamiento', `⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s (code=${code}) — fallo #${failures}, cooldown ${delayMin}min`);
        const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
        try { moveFile(trabajandoPath, pendienteDir); } catch {}
        activeProcesses.delete(processKey(skill, issue));
        // Matar Gradle daemons incluso en fast-fail
        killGradleDaemonsForCwd((needsWorktree || useExistingWorktree) ? worktreePath : ROOT, `${skill}:#${issue} (fast-fail)`);
        // Salir del canal de contexto
        if (contextChannelId) {
          try {
            const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
            cm.leaveChannelByType(contextChannelId, 'agent');
          } catch (e) {}
        }
        sendTelegram(`⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s — fallo #${failures}. Cooldown ${delayMin}min antes de reintentar.`);
        // Reporte PDF de muerte prematura (background)
        try {
          const reportScript = path.join(PIPELINE, 'rejection-report.js');
          // (#3088 / CA-1 + CA-6 + CA-9) provider/model resueltos por
          // agent-models.json al lanzar; viajan al rejection-report como
          // single source of truth (no se infiere por substring del model).
          // Si launchResult no entregó el campo, omitimos el flag — el
          // rejection-report hace lookup al audit-log y, si falla, cae a
          // literal "unknown".
          const reportArgs = [
            reportScript,
            '--issue', String(issue), '--skill', skill, '--fase', fase,
            '--code', String(code), '--elapsed', String(Math.round(elapsedSec)),
            '--motivo', `Muerte prematura (${elapsedSec.toFixed(0)}s, fallo #${failures})`,
            '--log', `${issue}-${skill}.log`, '--pipeline', pipeline,
          ];
          if (launchResult && launchResult.provider) {
            reportArgs.push('--provider', String(launchResult.provider));
          }
          if (launchResult && launchResult.model) {
            reportArgs.push('--model', String(launchResult.model));
          }
          const reportChild = spawn(process.execPath, reportArgs,
            { cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true });
          reportChild.unref();
        } catch {}
        return;
      }

      // Hay veredicto: tratamos como terminación normal. Limpiamos cooldown
      // stale de fast-fails previos (el skill demostró que está OK emitiendo
      // veredicto válido, aunque exit ≠ 0 por convención de rechazo).
      log('lanzamiento', `✓ ${skill}:#${issue} terminó en ${elapsedSec.toFixed(0)}s con veredicto válido (code=${code}) — no es muerte prematura`);
      clearCooldown(skill, issue);
      // Cae al flujo normal de abajo que mueve trabajando → listo y dispara rejection-report si corresponde.
    }

    // Éxito o finalización normal → limpiar cooldown
    if (code === 0) clearCooldown(skill, issue);

    // Registrar consumo de recursos del agente para perfiles predictivos
    if (elapsedSec > 30) { // Solo si corrió suficiente para tener snapshots
      recordSkillResourceUsage(skill, launchTime, Date.now());
    }

    const listoDir = path.join(fasePath(pipeline, fase), 'listo');
    try {
      // Single source of truth del lifecycle: el Pulpo es el único que mueve el
      // archivo de trabajando/ a listo/. Si un agente (contrato viejo o custom)
      // todavía lo movió él mismo, caemos sobre listo/ para no perder su YAML.
      // Ese caso dispara la carrera que rechazaba falsamente como
      // "Evidencia QA incompleta" (el readYaml de trabajando/ devolvía {},
      // el gate perdía `modo: api/structural` y rebotaba con video faltante).
      const listoPath = path.join(listoDir, path.basename(trabajandoPath));
      let workingPath;
      if (fs.existsSync(trabajandoPath)) {
        workingPath = trabajandoPath;
      } else if (fs.existsSync(listoPath)) {
        workingPath = listoPath;
        log('lanzamiento', `⚠️ ${skill}:#${issue} movió el archivo a listo/ por su cuenta — leyendo desde allí (contrato viejo, debería solo escribir el YAML)`);
      } else {
        log('lanzamiento', `⚠️ ${skill}:#${issue} terminó pero el archivo no está en trabajando/ ni en listo/`);
        activeProcesses.delete(processKey(skill, issue));
        return;
      }

      const data = readYaml(workingPath);
      if (!data.resultado) {
        data.resultado = code === 0 ? 'aprobado' : 'rechazado';
        data.motivo = code !== 0 ? `Agente terminó con código ${code}` : undefined;
        writeYaml(workingPath, data);
      }

      // #3746 — Auto-promoción de hijas a allowlist en el camino autónomo del Planner.
      // Hermano del camino Commander en L9462-9496 (firmado por security en #3625).
      // Determinístico: el padre es el `issue` que activó la fase, NO se infiere
      // de texto libre del LLM (cierra A03 Injection). Los IDs de las hijas vienen
      // del JSON estructurado de `gh issue create --json number,url` que el
      // Planner declara en su YAML resultado bajo `hijas_creadas`.
      // El try/catch envolvente garantiza que un error en allowlist NO bloquee
      // el `moveFile` del lifecycle (best-effort, idéntico patrón al Commander).
      if (
        skill === 'planner' &&
        fase === 'sizing' &&
        data.resultado === 'aprobado' &&
        data.dividido === true &&
        Array.isArray(data.hijas_creadas) &&
        data.hijas_creadas.length > 0
      ) {
        try {
          const recursivePromote = require('./lib/allowlist-recursive-promote');
          const childrenIssues = data.hijas_creadas
            .map(Number)
            .filter(n => Number.isInteger(n) && n > 0);
          const promoteResult = recursivePromote.autoPromoteSplitChildren({
            parentIssue: Number(issue),
            childrenIssues,
          });
          if (promoteResult.promoted && Array.isArray(promoteResult.added) && promoteResult.added.length > 0) {
            log('lanzamiento',
              `🧩 Auto-promote (planner-sizing): hijos de #${issue} agregados a allowlist (TTL 48h): ${promoteResult.added.join(',')}`);
            try {
              sendTelegram(
                `🧩 Planner agregó ${promoteResult.added.length} hijas a la ola por split de #${issue} (TTL 48h):\n` +
                promoteResult.added.map(n => `• #${n}`).join('\n')
              );
            } catch { /* best-effort */ }
          } else if (promoteResult.gateRejected) {
            log('lanzamiento',
              `⚠️ Auto-promote (planner-sizing) bloqueado por gate. Promover manualmente.`);
          }
        } catch (autoPromoteErr) {
          log('lanzamiento',
            `Auto-promote (planner-sizing) falló (best-effort, no bloquea): ${autoPromoteErr.message}`);
        }
      }

      // --- STOP RECORDING + PULL VIDEO ---
      // Parar screenrecord del pipeline y bajar el video al evidence dir
      if (skill === 'qa' && fase === 'verificacion' && qaRecordingPath && qaSerial) {
        // pkill puede fallar si screenrecord ya autoterminó por --time-limit;
        // no debe abortar el pull. Sin sintaxis bash (2>/dev/null || true)
        // porque execSync usa cmd.exe en Windows.
        try {
          execSync(`adb -s ${qaSerial} shell pkill -f screenrecord`, {
            encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'ignore'
          });
        } catch {
          // Sin proceso vivo: screenrecord ya cerró el mp4 por timeout. OK.
        }
        try {
          // Esperar a que el archivo se cierre (screenrecord tarda ~1s en flush)
          execSync('ping -n 3 127.0.0.1 > NUL', { timeout: 5000, windowsHide: true });
          // Pull del video
          const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
          fs.mkdirSync(evidenceDir, { recursive: true });
          const localVideo = path.join(evidenceDir, `qa-${issue}-raw.mp4`);
          // Fix #2281: MSYS_NO_PATHCONV evita que Git Bash convierta "/sdcard/..."
          // a "C:/Program Files/Git/sdcard/..." cuando lo pasa como argumento top-level
          // a adb.exe. MSYS2_ARG_CONV_EXCL=* desactiva toda conversión de argumentos.
          // En entornos no-MSYS (Linux/macOS/CI) estas vars se ignoran silenciosamente.
          const adbEnv = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
          execSync(`adb -s ${qaSerial} pull "${qaRecordingPath}" "${localVideo}"`, {
            encoding: 'utf8', timeout: 30000, windowsHide: true, env: adbEnv
          });
          // Limpiar del emulador
          try {
            execSync(`adb -s ${qaSerial} shell rm -f "${qaRecordingPath}"`, {
              encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'ignore', env: adbEnv
            });
          } catch {
            // Cleanup best-effort
          }
          const videoStat = fs.statSync(localVideo);
          const videoSizeKb = Math.round(videoStat.size / 1024);
          log('lanzamiento', `🎬 Recording parado para qa:#${issue} — video: ${videoSizeKb}KB → ${localVideo}`);
          // Inyectar metadata de evidencia en el YAML (50KB es suficiente con swiftshader).
          if (videoSizeKb >= 50) {
            data.evidencia = localVideo;
            data.video_size_kb = videoSizeKb;
            // Audio narrado no se genera acá (el agente QA lo hace), pero el video crudo sí
            writeYaml(workingPath, data);
          }
        } catch (e) {
          log('lanzamiento', `⚠️ Error bajando recording qa:#${issue}: ${e.message.slice(0, 80)}`);
        }
        // Matar el proceso local si sigue vivo
        if (qaRecordingProc && qaRecordingProc.exitCode === null) {
          try { qaRecordingProc.kill(); } catch {}
        }
      }

      // --- VALIDACIÓN ON-EXIT QA ---
      // Si el agente QA terminó diciendo "aprobado" pero sin evidencia, forzar rechazo.
      // R1 (issue #2351): pasamos `extraEnv.QA_MODE` como fuente de verdad autoritativa
      // (lo inyectó el preflight del Pulpo antes de lanzar al agente). El agente no
      // puede bypassear el gate inventando un `modo: api` falso en el YAML si el
      // preflight había determinado 'android'.
      if (skill === 'qa' && fase === 'verificacion' && data.resultado === 'aprobado') {
        const authoritativeQaMode = extraEnv && extraEnv.QA_MODE ? extraEnv.QA_MODE : null;
        const evidenceIssues = validateQaEvidence(issue, data, authoritativeQaMode);
        if (evidenceIssues.length > 0) {
          log('lanzamiento', `⛔ QA:#${issue} aprobó sin evidencia válida on-exit: ${evidenceIssues.join(', ')}`);
          data.resultado = 'rechazado';
          data.motivo = `Evidencia QA incompleta (gate on-exit): ${evidenceIssues.join('; ')}`;
          data.rechazado_por = 'gate-evidencia-on-exit';
          writeYaml(workingPath, data);
          sendTelegram(`⛔ QA:#${issue} — evidencia incompleta al terminar. Rechazo automático: ${evidenceIssues.join('; ')}`);
        }
      }

      // Solo movemos si el archivo sigue en trabajando/. Si ya estaba en listo/
      // (contrato viejo), el move lo completó el agente.
      if (workingPath === trabajandoPath) {
        moveFile(trabajandoPath, listoDir);
      }
      log('lanzamiento', `${skill}:#${issue} terminó (code=${code}, ${elapsedSec.toFixed(0)}s) → listo/`);

      // Generar reporte PDF de rechazo y enviar a Telegram (background, no bloquea)
      if (data.resultado === 'rechazado') {
        try {
          const reportScript = path.join(PIPELINE, 'rejection-report.js');
          // (#3088 / CA-1 + CA-6 + CA-9) provider/model resueltos por
          // agent-models.json. El rejection-report los inyecta en el header
          // del PDF y los usa para la regla determinística del audio. Si por
          // alguna razón no están resueltos (launchResult vacío), omitimos
          // el flag y el reporte hace lookup al audit-log → fallback "unknown".
          const reportArgs = [
            reportScript,
            '--issue', String(issue), '--skill', skill, '--fase', fase,
            '--code', String(code), '--elapsed', String(Math.round(elapsedSec)),
            '--motivo', String(data.motivo || 'Sin motivo'),
            '--log', `${issue}-${skill}.log`, '--pipeline', pipeline,
          ];
          if (launchResult && launchResult.provider) {
            reportArgs.push('--provider', String(launchResult.provider));
          }
          if (launchResult && launchResult.model) {
            reportArgs.push('--model', String(launchResult.model));
          }
          const reportChild = spawn(process.execPath, reportArgs, {
            cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
          });
          reportChild.unref();
          log('lanzamiento', `📄 Reporte de rechazo lanzado para ${skill}:#${issue}`);
        } catch (reportErr) {
          log('lanzamiento', `⚠️ Error lanzando reporte de rechazo: ${reportErr.message}`);
        }
      }
    } catch (e) {
      log('lanzamiento', `Error post-proceso ${skill}:#${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey(skill, issue));

    // Matar Gradle daemons del worktree para liberar RAM (cada daemon usa hasta 4GB)
    // Delay de 10s para evitar race condition: si el barrido ya lanzó un build en este
    // worktree, el guard dentro de killGradleDaemonsForCwd lo protegerá.
    const cleanupCwd = (needsWorktree || useExistingWorktree) ? worktreePath : ROOT;
    const cleanupLabel = `${skill}:#${issue}`;
    setTimeout(() => killGradleDaemonsForCwd(cleanupCwd, cleanupLabel), 10000);

    // Salir del canal de contexto (el canal queda para que otros lo consulten)
    if (contextChannelId) {
      try {
        const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
        cm.leaveChannelByType(contextChannelId, 'agent');
        cm.postMessage(contextChannelId, {
          from: 'system', from_label: 'Pipeline',
          type: 'system',
          content: skill + ' #' + issue + ' finalizó (code=' + code + ')',
        });
      } catch (e) {}
    }
  });

  // stdout/stderr redirigidos al archivo de log via stdio fd
}

// =============================================================================
// BRAZO 3: HUÉRFANOS — Detecta archivos trabados en trabajando/
// =============================================================================

const orphanRetries = new Map(); // key: "pipeline/fase/filename" → count
const MAX_ORPHAN_RETRIES = 3;

function brazoHuerfanos(config) {
  const timeoutMinutes = config.timeouts?.orphan_timeout_minutes || 10;

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    for (const fase of pipelineConfig.fases) {
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const listoDir = path.join(fasePath(pipelineName, fase), 'listo');
      const archivos = listWorkFiles(trabajandoDir);

      for (const archivo of archivos) {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        const key = processKey(skill, issue);
        const age = fileAgeMinutes(archivo.path);

        if (age < timeoutMinutes) continue;

        // Verificar si el proceso sigue vivo
        const info = activeProcesses.get(key);
        if (info && isProcessAlive(info.pid)) continue;

        const retryKey = `${pipelineName}/${fase}/${archivo.name}`;
        const retries = (orphanRetries.get(retryKey) || 0) + 1;
        orphanRetries.set(retryKey, retries);

        if (retries > MAX_ORPHAN_RETRIES) {
          // Demasiados reintentos → marcar como rechazado y mover a listo
          log('huerfanos', `${archivo.name} excedió ${MAX_ORPHAN_RETRIES} reintentos → rechazado`);
          try {
            const data = readYaml(archivo.path);
            data.resultado = 'rechazado';
            data.motivo = `Huérfano tras ${MAX_ORPHAN_RETRIES} reintentos — proceso muere repetidamente`;
            writeYaml(archivo.path, data);
            moveFile(archivo.path, listoDir);
            orphanRetries.delete(retryKey);
            sendTelegram(`⛔ ${skill}:#${issue} rechazado tras ${MAX_ORPHAN_RETRIES} reintentos huérfanos. Requiere intervención manual.`);
          } catch (e) {
            log('huerfanos', `Error rechazando ${archivo.name}: ${e.message}`);
          }
        } else {
          // Devolver a pendiente con cooldown para evitar loop inmediato
          const { failures, delayMin } = registerFastFail(skill, issue);
          log('huerfanos', `${archivo.name} lleva ${Math.round(age)}min sin proceso → pendiente/ (intento ${retries}/${MAX_ORPHAN_RETRIES}, cooldown ${delayMin}min)`);
          try {
            moveFile(archivo.path, pendienteDir);
          } catch (e) {
            log('huerfanos', `Error devolviendo ${archivo.name}: ${e.message}`);
          }
        }
        activeProcesses.delete(key);
      }
    }
  }
}

// =============================================================================
// BRAZO 4.5: REWIND — Procesa eventos `pipeline.rejection` del Commander (#3416)
// =============================================================================
//
// Bus filesystem: `.pipeline/rejections/<issue>-<unix-ts>.json` (escrito por
// el productor del Commander, #3441 / `lib/commander/rechazar-handler.js`).
// Cada archivo trae `{issue, fase, fase_resolved, motivo, ts, source, chat_id, audit_ref}`.
// El adapter `lib/rewind-event-adapter.js` traduce ese shape al que consume
// `rewindIssueToPhase` (`{issue, alias, motivo, operatorId, source}`).
//
// Después de procesar, este brazo:
//   1. Hace sweep de stale in-flight markers.
//   2. Lee los `.json` del root del directorio (NO subcarpetas).
//   3. Normaliza el evento con el adapter.
//   4. Llama a `rewindIssueToPhase` con `activeProcesses` + control de procesos.
//   5. Postea comentario en GitHub (CA-3).
//   6. Manda mensaje al operador por Telegram (G-UX-1..7).
//   7. Mueve el archivo del evento a `listo/` subcarpeta (mantiene root limpio).
// =============================================================================

let _pipelineRewindMod = null;
function getRewindModule() {
  if (_pipelineRewindMod) return _pipelineRewindMod;
  try { _pipelineRewindMod = require('./lib/pipeline-rewind'); } catch (e) {
    log('rewind', `[ERROR] no se pudo cargar lib/pipeline-rewind: ${e.message}`);
    return null;
  }
  return _pipelineRewindMod;
}

let _rewindMessagesMod = null;
function getRewindMessagesModule() {
  if (_rewindMessagesMod) return _rewindMessagesMod;
  try { _rewindMessagesMod = require('./lib/rewind-messages'); } catch (e) {
    log('rewind', `[ERROR] no se pudo cargar lib/rewind-messages: ${e.message}`);
    return null;
  }
  return _rewindMessagesMod;
}

let _rewindAdapterMod = null;
function getRewindAdapterModule() {
  if (_rewindAdapterMod) return _rewindAdapterMod;
  try { _rewindAdapterMod = require('./lib/rewind-event-adapter'); } catch (e) {
    log('rewind', `[ERROR] no se pudo cargar lib/rewind-event-adapter: ${e.message}`);
    return null;
  }
  return _rewindAdapterMod;
}

// El producer de eventos `pipeline.rejection` es `lib/commander/rechazar-handler.js`
// (#3441, mergeado en main). Escribe en `.pipeline/rejections/<issue>-<unixTs>.json`
// como bus filesystem flat. Después de procesar, el consumer mueve a `listo/`
// subdir (mantiene el directorio raíz limpio para que el producer detecte
// fácilmente eventos nuevos por inspección visual / scripts auxiliares).
const REWIND_EVENTS_DIR = path.join(PIPELINE, 'rejections');

async function brazoRewind(config) {
  const rewindMod = getRewindModule();
  const msgs = getRewindMessagesModule();
  const adapter = getRewindAdapterModule();
  if (!rewindMod || !msgs || !adapter) return; // Módulo no disponible — best-effort.

  // Sweep stale in-flight markers (CA-9 recovery post-crash).
  try {
    const stale = rewindMod.sweepStaleInFlight(PIPELINE);
    for (const s of stale) {
      log('rewind', `♻️ marker stale limpiado: ${path.basename(s.file)} (step=${s.marker.step})`);
    }
  } catch (e) { log('rewind', `[WARN] sweep in-flight falló: ${e.message}`); }

  // Producer escribe los .json directamente en `REWIND_EVENTS_DIR/` (sin
  // subcarpeta `pendiente/`). Después de procesar movemos a `listo/`.
  const pendDir = REWIND_EVENTS_DIR;
  const listoDir = path.join(REWIND_EVENTS_DIR, 'listo');
  let entries;
  try { entries = fs.readdirSync(pendDir); }
  catch { return; }

  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const filePath = path.join(pendDir, name);
    // Saltear subdirs (listo/, etc.) — solo procesamos archivos del root.
    try {
      if (fs.statSync(filePath).isDirectory()) continue;
    } catch { continue; }

    let rawEvent;
    try {
      rawEvent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      log('rewind', `[ERROR] evento corrupto ${name}: ${e.message} — moviendo a listo/`);
      try { fs.mkdirSync(listoDir, { recursive: true }); moveFile(filePath, listoDir); } catch {}
      continue;
    }

    // Traducir el shape del producer (#3441) al shape del consumer (#3416).
    // Ver `lib/rewind-event-adapter.js` para el contrato detallado.
    const event = adapter.normalizeProducerEvent(rawEvent);
    const { issue, alias, motivo, operatorId, source } = event;
    const transcribe = event._envelope && event._envelope.transcribe_source;
    log('rewind', `📥 evento ${name} → #${issue} alias=${alias} source=${source}${transcribe ? ` (transcribe=${transcribe})` : ''}`);

    let result;
    try {
      result = await rewindMod.rewindIssueToPhase({
        issue,
        alias,
        motivo,
        operatorId,
        source,
        config,
        pipelineRoot: PIPELINE,
        yaml,
        activeProcesses,
        options: {
          killGraceMs: (config.rewind && config.rewind.kill_grace_seconds)
            ? config.rewind.kill_grace_seconds * 1000
            : rewindMod.DEFAULT_KILL_GRACE_MS,
        },
      });
    } catch (e) {
      log('rewind', `[ERROR] rewindIssueToPhase tiró excepción: ${e.message}`);
      result = { ok: false, code: 'UNEXPECTED_ERROR', message: e.message };
    }

    // --- Reportar resultado al operador (G-UX-1..7) ---
    try {
      if (result.ok) {
        // Postear comentario en GitHub (CA-3).
        try {
          const tmp = path.join(LOG_DIR, `rewind-comment-${issue}-${Date.now()}.md`);
          fs.writeFileSync(tmp, result.commentBody);
          execSync(`gh issue comment ${issue} --body-file "${tmp}"`, { stdio: 'pipe' });
          try { fs.unlinkSync(tmp); } catch {}
        } catch (e) {
          log('rewind', `[WARN] no pude postear comentario en GitHub #${issue}: ${e.message}`);
        }

        // Mensaje principal de éxito.
        sendTelegram(msgs.buildSuccessMessage({
          issue,
          target: result.target,
          fromPipeline: result.fromPipeline,
          fromFase: result.fromFase,
        }));

        // G-UX-4: aviso por truncate.
        if (result.sanitization && result.sanitization.truncated) {
          sendTelegram(msgs.buildTruncateMessage({
            issue,
            originalBytes: result.sanitization.originalBytes,
          }));
        }

        // G-UX-6: alerta por rate limit suave (no bloqueo).
        if (result.rateLimitTriggered) {
          sendTelegram(msgs.buildRateLimitWarning({
            issue,
            recentCount: result.recentRewindCount,
            target: result.target,
          }));
        }

        log('rewind', `✅ #${issue} rebobinado a ${result.target.pipeline}/${result.target.fase}/${result.target.skill} (action=${result.moveAction}, killed=${!!(result.killResult && result.killResult.killed)})`);
      } else {
        const code = result.code;
        let txt;
        if (code === 'INJECTION_DETECTED') {
          txt = msgs.buildInjectionBlockedMessage({
            issue,
            matchedDescription: result.sanitization && result.sanitization.matchedDescription,
          });
        } else {
          txt = msgs.buildErrorMessage(code, {
            issue,
            alias,
            normalizedAlias: alias,
            source,
            target: result.target,
            fromPipeline: result.fromPipeline,
            fromFase: result.fromFase,
            error: result.message,
            killGraceMs: rewindMod.DEFAULT_KILL_GRACE_MS,
          });
        }
        sendTelegram(txt);
        log('rewind', `⛔ #${issue} rewind bloqueado (${code}): ${result.message || ''}`);
      }
    } catch (e) {
      log('rewind', `[WARN] reporte al operador falló: ${e.message}`);
    }

    // Mover evento a listo/.
    try {
      fs.mkdirSync(listoDir, { recursive: true });
      moveFile(filePath, listoDir);
    } catch (e) {
      log('rewind', `[ERROR] no se pudo mover evento ${name} a listo/: ${e.message}`);
    }
  }
}

// =============================================================================
// BRAZO 5: COMMANDER — Procesa mensajes de Telegram con handlers nativos
// =============================================================================

// --- Sesión conversacional persistente ---

const SESSION_FILE = path.join(PIPELINE, 'commander-session.json');

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return { context: null, lastCommand: null, lastTimestamp: null, pendingAction: null };
  }
}

function saveSession(session) {
  // Issue #3310 CA-4: sanitizar `session.context` antes de persistir. El
  // context se arma con respuestas de Claude (lineas 7764, 8092) y puede
  // citar de vuelta input del usuario. Si el commander hace eco de una key,
  // queda redacted en disco. Idempotente: re-aplicar sanitize sobre un
  // placeholder no lo altera (los patrones no matchean `[REDACTED:...]`).
  try {
    if (session && typeof session.context === 'string') {
      session = { ...session, context: sanitizePipelineText(session.context) };
    }
  } catch { /* fail-closed via sanitizePipelineText, no debería tirar */ }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

// Issue #3310 CA-1.5: chokepoint único para appendear al
// `commander-history.jsonl`. Sanitiza el campo `text` (y `reason` en caso de
// gates) ANTES del JSON.stringify para que un secreto que se cuele en una
// respuesta outbound o en input procesado no quede en plaintext en disco.
//
// Reemplaza los 6 `fs.appendFileSync(historyFile, ...)` dispersos por
// pulpo.js. Cualquier append nuevo al historial DEBE pasar por este helper.
//
// #3418 CA-9 — Acepta campo opcional `intent` (string corto). Los
// consumidores externos que no lo entienden lo ignoran (campos desconocidos
// se descartan en lectura). Habilita el `prevContext` para SEC-B.
function appendCommanderHistory(historyFile, entry) {
  try {
    const safe = { ...entry };
    if (typeof safe.text === 'string') safe.text = sanitizePipelineText(safe.text);
    if (typeof safe.reason === 'string') safe.reason = sanitizePipelineText(safe.reason);
    // Default timestamp si el caller no lo trajo (los appends viejos lo
    // declaran inline; mantenemos el comportamiento previo).
    if (!safe.timestamp) safe.timestamp = new Date().toISOString();
    fs.appendFileSync(historyFile, JSON.stringify(safe) + '\n');
  } catch (e) {
    // Fail-closed: si algo rompe, NO escribimos el entry crudo (que podría
    // tener un secreto). Solo registramos el error con marker explícito.
    try {
      fs.appendFileSync(
        historyFile,
        JSON.stringify({ direction: 'error', text: `[HISTORY_APPEND_ERROR:${(e && e.message) || 'unknown'}]`, timestamp: new Date().toISOString() }) + '\n',
      );
    } catch { /* best-effort, no podemos hacer más */ }
  }
}

// #3418 SEC-B / CA-9 — Lee las últimas N entradas del historial conversacional
// para reconstruir el `prevContext` necesario por
// `detectIssueCreationIntent`. Sólo devuelve `{ intent }` si encuentra una
// entrada `direction: 'in_intent'` reciente. Si no encuentra, retorna `null`
// (y los patterns continuativos del detector quedan desactivados → cero
// falsos positivos).
//
// Política: solo miramos las últimas 5 entradas para que el contexto se
// "olvide" si el operador cambió de tema (no quiero arrastrar un intent de
// hace 30 mensajes). Si la entrada `in_intent` está separada por un `out`
// del bot que NO sea una creación de issue exitosa, también la ignoramos —
// el bot habiendo respondido algo no relacionado rompe el hilo.
function readPrevIssueCreationContext(historyFile, opts = {}) {
  const lookback = Number.isFinite(opts.lookback) ? opts.lookback : 5;
  try {
    if (!fs.existsSync(historyFile)) return null;
    // Leemos el final del archivo y nos quedamos con las últimas `lookback`
    // entradas válidas. Usamos slice negativo para evitar parsear todo el
    // archivo en cada turno.
    const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n').slice(-lookback);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && entry.direction === 'in_intent' && typeof entry.intent === 'string' && entry.intent !== 'none') {
          // SEC-B: validez 5 minutos. Si el último intent matched fue hace
          // más de 5 minutos, ya no califica como "turno previo" — el
          // operador probablemente está en otra conversación.
          const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
          if (ts && (Date.now() - ts) > 5 * 60 * 1000) return null;
          return { intent: entry.intent, ts };
        }
      } catch { /* línea inválida, seguir */ }
    }
  } catch { /* best-effort */ }
  return null;
}

// --- Handlers nativos de comandos (cero tokens, ejecución instantánea) ---

async function cmdStatus(config) {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const lines = ['📊 *Estado del Pipeline*\n'];
  lines.push(`🟢 Online · ${hours}h ${mins}m`);
  lines.push('');

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    lines.push(`*${pipelineName.toUpperCase()}*`);
    for (const fase of pipelineConfig.fases) {
      const base = fasePath(pipelineName, fase);
      const p = listWorkFiles(path.join(base, 'pendiente')).length;
      const t = listWorkFiles(path.join(base, 'trabajando')).length;
      const l = listWorkFiles(path.join(base, 'listo')).length;
      if (p + t + l === 0) continue;
      lines.push(`  ${fase}: 📋${p} ⚙️${t} ✅${l}`);

      // Detalle por issue
      const allFiles = [
        ...listWorkFiles(path.join(base, 'pendiente')).map(f => ({ ...f, estado: '📋' })),
        ...listWorkFiles(path.join(base, 'trabajando')).map(f => ({ ...f, estado: '⚙️' })),
        ...listWorkFiles(path.join(base, 'listo')).map(f => ({ ...f, estado: '✅' }))
      ];
      const byIssue = {};
      for (const f of allFiles) {
        const iss = issueFromFile(f.name);
        if (!byIssue[iss]) byIssue[iss] = [];
        byIssue[iss].push(`${skillFromFile(f.name)}${f.estado}`);
      }
      for (const [iss, skills] of Object.entries(byIssue)) {
        lines.push(`    #${iss}: ${skills.join(' ')}`);
      }
    }
    lines.push('');
  }

  // Agentes activos
  const agentes = [];
  for (const [key, info] of activeProcesses) {
    if (isProcessAlive(info.pid)) {
      const age = Math.round((Date.now() - info.startTime) / 60000);
      agentes.push(`  ${key} (${age}min, pid:${info.pid})`);
    }
  }
  if (agentes.length > 0) {
    lines.push('*Agentes activos*');
    lines.push(...agentes);
  } else {
    lines.push('*Agentes activos:* ninguno');
  }

  // Servicios
  lines.push('\n*Servicios*');
  for (const svc of ['telegram', 'github', 'drive', 'commander']) {
    const svcDir = path.join(PIPELINE, 'servicios', svc, 'pendiente');
    const count = listWorkFiles(svcDir).length;
    if (count > 0) lines.push(`  ${svc}: ${count} pendientes`);
  }

  // Recursos del sistema
  const { cpuPercent, memPercent } = getSystemResourceUsage();
  const thresholds = config.resource_limits || {};
  const maxCpu = thresholds.max_cpu_percent || 80;
  const maxMem = thresholds.max_mem_percent || 80;
  const cpuIcon = cpuPercent >= maxCpu ? '🔴' : cpuPercent >= maxCpu * 0.8 ? '🟡' : '🟢';
  const memIcon = memPercent >= maxMem ? '🔴' : memPercent >= maxMem * 0.8 ? '🟡' : '🟢';
  lines.push(`\n*Recursos del sistema*`);
  lines.push(`  ${cpuIcon} CPU: ${cpuPercent}% (max ${maxCpu}%)`);
  lines.push(`  ${memIcon} RAM: ${memPercent}% (max ${maxMem}%)`);
  if (cpuPercent >= maxCpu || memPercent >= maxMem) {
    lines.push(`  ⛔ Lanzamiento bloqueado por sobrecarga`);
  }

  // #3625 CA-5 — Métrica de mutaciones de la allowlist en las últimas 24h.
  // Si statsSince() falla (módulo no disponible, audit log corrupto, etc.) se
  // omite sin romper el resto del /status (best-effort, mismo criterio que el
  // snapshot block).
  let auditStats = null;
  try {
    const ppa = require('./lib/partial-pause-audit');
    auditStats = ppa.statsSince({});
    if (auditStats && Number.isFinite(auditStats.total) && auditStats.total >= 0) {
      lines.push(`\n*Auditoría allowlist (últimas 24h)*`);
      lines.push(`  📜 Mutaciones: ${auditStats.total} (${auditStats.authorized} autorizadas / ${auditStats.rejected} rejected / ${auditStats.unknown} sin autoría)`);
      // Verificación del hash-chain (best-effort, no bloquea si falla)
      try {
        const chain = ppa.verifyChain();
        if (chain && chain.ok === false) {
          lines.push(`  🛑 Hash-chain ROTO en entry #${chain.brokenAt || '?'} — escrituras nuevas bloqueadas`);
        }
      } catch {}
    }
  } catch (e) {
    log('commander', `[status] Auditoría allowlist no disponible: ${e.message}`);
  }

  // #3013 — bloque de snapshot fresco (narrativa §3, CA-UX-8). Sólo se
  // agrega si hay snapshot real fresco; sin él, el `/status` queda
  // idéntico al pre-feature (CA-15).
  try {
    const snapshotIntegration = require('./lib/quota-snapshot-integration');
    const snapBlock = snapshotIntegration.buildStatusSnapshotBlock();
    if (snapBlock) {
      lines.push('\n' + snapBlock);
    }
  } catch (e) {
    // Módulo no disponible o error de IO → silently skip (CA-15).
  }

  // PRs mergeados hoy
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ghOut = execSync(`"${GH_BIN}" pr list --state merged --search "merged:>=${today}" --limit 20 --json number,title`, { encoding: 'utf8', timeout: 15000, cwd: ROOT });
    const prs = JSON.parse(ghOut);
    if (prs.length > 0) {
      lines.push(`\n*Entregado hoy (${prs.length} PRs)*`);
      for (const pr of prs.slice(0, 10)) {
        lines.push(`  #${pr.number} ${pr.title}`);
      }
      if (prs.length > 10) lines.push(`  +${prs.length - 10} más`);
    }
  } catch (e) {
    log('commander', `[status] Error obteniendo PRs del día: ${e.message}`);
  }

  // Estado pausa (completa o parcial — #2490)
  if (paused) {
    lines.push('\n⏸️ *PULPO PAUSADO*');
  } else {
    const ppMode = partialPause.getPipelineMode();
    if (ppMode.mode === 'partial_pause') {
      const list = ppMode.allowedIssues.map(i => `#${i}`).join(', ');
      lines.push(`\n⏸️ *PULPO EN PAUSA PARCIAL*\nIssues permitidos: ${list}`);
    }
  }

  const text = lines.join('\n');

  // Audio TTS de la narración
  try {
    const { textToSpeechWithMeta, sendVoiceTelegram, loadTtsState, saveTtsState, getTransitionIntro, splitTextForTTSChunks } = require('./multimedia');
    const botToken = getTelegramToken();
    const chatId = getTelegramChatId();
    if (botToken && chatId) {
      let narration = `Estado del pipeline. Llevo ${hours} horas y ${mins} minutos online. `;
      // Agentes activos
      const aliveCount = [...activeProcesses.values()].filter(i => isProcessAlive(i.pid)).length;
      narration += aliveCount > 0 ? `${aliveCount} agentes activos. ` : 'Sin agentes activos. ';
      // Recursos
      const { cpuPercent: cpu, memPercent: mem } = getSystemResourceUsage();
      narration += `CPU al ${cpu} por ciento, RAM al ${mem} por ciento. `;
      if (paused) {
        narration += 'El pulpo está pausado. ';
      } else {
        const ppMode = partialPause.getPipelineMode();
        if (ppMode.mode === 'partial_pause') {
          narration += `Pipeline en pausa parcial, procesando solo ${ppMode.allowedIssues.length} ${ppMode.allowedIssues.length === 1 ? 'issue' : 'issues'}. `;
        }
      }
      // #3625 CA-5 — Métrica de auditoría de la allowlist en la narración TTS.
      // Sólo se incluye si hubo mutaciones en las últimas 24h y la estadística
      // está disponible (auditStats se calculó arriba para el bloque textual).
      if (auditStats && Number(auditStats.total) > 0) {
        narration += `Hubo ${auditStats.total} ${auditStats.total === 1 ? 'mutación' : 'mutaciones'} en la allowlist en las últimas 24 horas`;
        const parts = [];
        if (auditStats.authorized > 0) parts.push(`${auditStats.authorized} ${auditStats.authorized === 1 ? 'autorizada' : 'autorizadas'}`);
        if (auditStats.rejected > 0) parts.push(`${auditStats.rejected} ${auditStats.rejected === 1 ? 'rechazada' : 'rechazadas'}`);
        if (auditStats.unknown > 0) parts.push(`${auditStats.unknown} sin autoría`);
        if (parts.length) narration += `, de las cuales ${parts.join(', ')}`;
        narration += '. ';
      }
      // PRs del día
      try {
        const today = new Date().toISOString().slice(0, 10);
        const ghOut = execSync(`"${GH_BIN}" pr list --state merged --search "merged:>=${today}" --limit 20 --json number,title`, { encoding: 'utf8', timeout: 15000, cwd: ROOT });
        const prs = JSON.parse(ghOut);
        if (prs.length > 0) {
          narration += `Hoy se entregaron ${prs.length} PRs. `;
          for (const pr of prs.slice(0, 5)) {
            narration += `PR ${pr.number}, ${pr.title}. `;
          }
        }
      } catch {}

      // Cap a 1500 chars para evitar truncado interno de Edge TTS en español (#3485).
      const statusChunks = splitTextForTTSChunks(narration, 1500);
      log('commander', `[status] TTS chunks generados: total_parts=${statusChunks.length} (texto=${narration.length} chars, cap=1500)`);
      let prevProviderStatus = loadTtsState().lastProvider;
      for (let i = 0; i < statusChunks.length; i++) {
        let chunkText = statusChunks.length > 1
          ? `Parte ${i + 1} de ${statusChunks.length}. ${statusChunks[i]}`
          : statusChunks[i];
        const ttsOpts = { chunkInfo: { index: i, total: statusChunks.length } };
        const meta = await textToSpeechWithMeta(chunkText, ttsOpts);
        if (meta && meta.buffer) {
          const intro = i === 0 ? getTransitionIntro(meta.provider, prevProviderStatus) : null;
          if (intro) {
            // Reenviar el primer chunk con el preámbulo de transición
            const reMeta = await textToSpeechWithMeta(`${intro} ${chunkText}`, ttsOpts);
            if (reMeta && reMeta.buffer) {
              await sendVoiceTelegram(reMeta.buffer, botToken, chatId);
              log('commander', `[status] Audio TTS parte 1/${statusChunks.length} enviado con intro (provider=${reMeta.provider})`);
              saveTtsState({ lastProvider: reMeta.provider });
              prevProviderStatus = reMeta.provider;
              continue;
            }
          }
          await sendVoiceTelegram(meta.buffer, botToken, chatId);
          log('commander', `[status] Audio TTS parte ${i + 1}/${statusChunks.length} enviado (provider=${meta.provider})`);
          saveTtsState({ lastProvider: meta.provider });
          prevProviderStatus = meta.provider;
        }
      }
    }
  } catch (audioErr) {
    log('commander', `[status] Error TTS (no fatal): ${audioErr.message}`);
  }

  return text;
}

function cmdGhostbusters() {
  try {
    const gb = require('./ghostbusters');
    const report = gb.run();
    return gb.fmtReport(report);
  } catch (e) {
    return `⚠️ Ghostbusters falló: ${e.message.slice(0, 200)}`;
  }
}

function cmdActividad(args) {
  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  } catch { return '📭 Sin historial de actividad'; }

  // Parsear filtro
  let filtro = 10;
  let issueFilter = null;

  if (args) {
    const minuteMatch = args.match(/(\d+)m/);
    const issueMatch = args.match(/#?(\d+)/);
    if (minuteMatch) {
      const mins = parseInt(minuteMatch[1]);
      const cutoff = new Date(Date.now() - mins * 60000).toISOString();
      lines = lines.filter(l => {
        try { return JSON.parse(l).timestamp >= cutoff; } catch { return false; }
      });
      filtro = lines.length;
    } else if (issueMatch) {
      issueFilter = issueMatch[1];
      lines = lines.filter(l => l.includes(issueFilter));
      filtro = lines.length;
    }
  }

  const recientes = lines.slice(-filtro);
  if (recientes.length === 0) return '📭 Sin actividad reciente';

  const result = ['📋 *Actividad reciente*\n'];
  for (const line of recientes) {
    try {
      const entry = JSON.parse(line);
      const dir = entry.direction === 'in' ? '→' : '←';
      const ts = entry.timestamp?.slice(11, 16) || '??:??';
      const from = entry.from ? `[${entry.from}]` : '';
      const text = (entry.text || '').slice(0, 80);
      result.push(`${ts} ${dir} ${from} ${text}`);
    } catch {}
  }
  return result.join('\n');
}

function cmdIntake(args, config) {
  if (args) {
    // Intake de un issue específico
    const issueNum = args.replace('#', '').trim();
    if (isIssueClosed(issueNum)) {
      return `⚠️ #${issueNum} está cerrado en GitHub — no se puede ingresar al pipeline`;
    }
    if (issueExistsInPipeline(issueNum, 'desarrollo')) {
      return `⚠️ #${issueNum} ya está activo en el pipeline de desarrollo`;
    }

    // Determinar pipeline de entrada (por defecto desarrollo/validacion)
    const pendienteDir = path.join(fasePath('desarrollo', 'validacion'), 'pendiente');
    const skills = config.pipelines.desarrollo.skills_por_fase.validacion || [];
    for (const skill of skills) {
      const filePath = path.join(pendienteDir, `${issueNum}.${skill}`);
      writeYaml(filePath, { issue: parseInt(issueNum), fase: 'validacion', pipeline: 'desarrollo' });
    }
    log('intake', `#${issueNum} ingresado manualmente vía /intake`);
    return `✅ #${issueNum} ingresado al pipeline → desarrollo/validacion (${skills.join(', ')})`;
  }

  // Forzar intake inmediato (resetear timer)
  lastIntakeTime = 0;
  brazoIntake(config);
  return '✅ Intake ejecutado — revisé GitHub por issues pendientes';
}

function cmdPausar() {
  fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
  paused = true;
  return '⏸️ Pulpo PAUSADO. Usar /reanudar para continuar.';
}

function cmdReanudar() {
  // #2490 — /reanudar limpia tanto pausa completa como parcial.
  // #3625 — pasar authorizedBy: 'resume:operator' para que el gate acepte
  // el removal de toda la allowlist con autoría trazable.
  const { removedFull, removedPartial } = partialPause.resumeAll({
    source: 'telegram',
    authorizedBy: 'resume:operator',
    justification: '/reanudar desde Telegram Commander',
  });
  paused = false;
  const parts = [];
  if (removedFull) parts.push('pausa completa');
  if (removedPartial) parts.push('pausa parcial');
  const cleared = parts.length > 0 ? ` (${parts.join(' + ')} eliminada)` : '';
  return `▶️ Pulpo REANUDADO${cleared}. Procesamiento activo.`;
}

// #2490 — Pausa parcial con allowlist de issues.
// Uso: /pause-partial 2490 2491  → procesa solo esos issues, pausa el resto.
function cmdPausaParcial(args) {
  const nums = String(args || '').match(/\d+/g) || [];
  if (nums.length === 0) {
    const state = partialPause.getPipelineMode();
    if (state.mode === 'partial_pause') {
      return `⏸️ *Pausa parcial activa*\nIssues permitidos: ${state.allowedIssues.map(i => `#${i}`).join(', ')}\nDesde: ${state.createdAt || '?'}\n\n_Usar /reanudar para desactivar._`;
    }
    return '⚠️ Uso: `/pause-partial 2490 2491`\n\nActiva pausa parcial con los issues indicados. El pipeline sigue corriendo solo para esos números, el resto queda pausado.';
  }
  const issues = nums.map(n => parseInt(n, 10));
  // #3625 — gate: comando del operador desde Telegram → commander:leo.
  const result = partialPause.setPartialPause(issues, {
    source: 'telegram',
    authorizedBy: 'commander:leo',
    justification: `/pause-partial ${nums.join(' ')} desde Telegram`,
  });
  if (result.rejected) {
    return `🛑 Mutación rechazada por gate: ${result.msg}`;
  }
  const list = result.allowedIssues.map(i => `#${i}`).join(', ');
  return `⏸️ *Pausa parcial activa*\nIssues permitidos: ${list}\n\n_Todo el resto del pipeline queda pausado hasta que hagas /reanudar._`;
}

function cmdCostos() {
  // Leer logs de agentes para estimar actividad
  const logFiles = [];
  try {
    logFiles.push(...fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log') && !f.startsWith('.')));
  } catch {}

  if (logFiles.length === 0) return '📊 Sin datos de costos disponibles';

  const lines = ['💰 *Resumen de actividad (por logs)*\n'];
  const skillStats = {};

  for (const f of logFiles) {
    const match = f.match(/^(\d+)-(.+)\.log$/);
    if (!match) continue;
    const [, issue, skill] = match;
    const stat = fs.statSync(path.join(LOG_DIR, f));
    const sizeKb = Math.round(stat.size / 1024);
    if (!skillStats[skill]) skillStats[skill] = { count: 0, totalKb: 0 };
    skillStats[skill].count++;
    skillStats[skill].totalKb += sizeKb;
  }

  for (const [skill, stats] of Object.entries(skillStats).sort((a, b) => b[1].totalKb - a[1].totalKb)) {
    lines.push(`  ${skill}: ${stats.count} ejecuciones, ${stats.totalKb}KB output`);
  }

  lines.push(`\n*Total:* ${logFiles.length} logs en .pipeline/logs/`);
  return lines.join('\n');
}

async function cmdProponer(args, config) {
  const count = parseInt(args) || 3;

  const propositorPrompt = `Analizá el backlog de GitHub, el estado actual del código y la deuda técnica del proyecto Intrale.
Generá ${count} propuestas de historias nuevas. Para cada una incluí:
- Título conciso
- Descripción de 2-3 oraciones
- Área (backend/app/web)
- Tamaño estimado (simple/medio/grande)
- Justificación (por qué es importante)

Usá: gh issue list --state open --json number,title,labels,body --limit 50
Y: git log --oneline -20 para ver actividad reciente.

Formato de respuesta: lista numerada, una propuesta por item.`;

  sendTelegram('🔄 Analizando backlog para generar propuestas...');

  try {
    const resultado = await ejecutarClaude(propositorPrompt, 'proponer historias');

    if (resultado) {
      const proposalFile = path.join(PIPELINE, 'commander-proposals.json');
      const proposals = { timestamp: new Date().toISOString(), count, text: resultado };
      fs.writeFileSync(proposalFile, JSON.stringify(proposals, null, 2));

      return `💡 *Propuestas de historias nuevas*\n\n${resultado}\n\n_Respondé "crear N" para crear una como issue, o "descartar" para ignorar._`;
    }
    return '⚠️ No pude generar propuestas. Intentá de nuevo.';
  } catch (e) {
    log('commander', `Error en proponer: ${e.message}`);
    return '⚠️ Error generando propuestas: ' + e.message.slice(0, 100);
  }
}

/** Ejecutar Claude async con spawn + stream-json (patrón V1). Retorna el texto de respuesta. */
/**
 * Genera un acknowledgment contextual basado en lo que el usuario pidió.
 * @param {string} texto - El mensaje del usuario
 * @param {boolean} esAudio - Si el mensaje vino de un audio
 * @returns {string}
 */
function generarAck(texto, esAudio = false) {
  const t = (texto || '').toLowerCase();
  const icon = esAudio ? '🎙️' : '💬';

  // Detectar intención específica
  if (/reinici|restart|levant|arranc/.test(t)) return `${icon} Dale, arranco con el reinicio...`;
  if (/status|estado|tablero|dashboard/.test(t)) return `${icon} Revisando el tablero...`;
  if (/recurs|cpu|ram|memoria|saturad/.test(t)) return `${icon} Mirando los recursos del sistema...`;
  if (/error|fall[oó]|roto|crash|bug/.test(t)) return `${icon} Voy a investigar qué pasó...`;
  if (/test|prueba|verificar|check/.test(t)) return `${icon} Verificando, dame un momento...`;
  if (/deploy|entreg|merge|push|pr\b/.test(t)) return `${icon} Revisando el delivery...`;
  if (/propuesta|propon|diseñ|implement|rediseñ/.test(t)) return `${icon} Lo estoy pensando, ya te cuento...`;
  if (/limpi|clean|kill|mat[aá]/.test(t)) return `${icon} Encargándome de la limpieza...`;
  if (/\?|terminaste|pudiste|hiciste|cómo|cuánto|qué pas/.test(t)) return `${icon} Buena pregunta, ya te respondo...`;

  // Variantes genéricas (no repetir)
  const genericas = [
    `${icon} Ya lo vi, dame un momento...`,
    `${icon} Recibido, estoy en eso...`,
    `${icon} Dale, ya me pongo...`,
    `${icon} Un toque que lo proceso...`,
    `${icon} Enterado, ya laburo en eso...`,
  ];
  return genericas[Math.floor(Math.random() * genericas.length)];
}

/**
 * Genera mensajes de progreso contextuales que evolucionan con el tiempo.
 * Amplio pool (~200 mensajes) para evitar repeticiones, con tono argentino.
 * En vez de stats de operaciones, muestra porcentaje estimado y ETA cuando corresponde.
 * @param {number} count - Número de mensaje de progreso (0, 1, 2, ...)
 * @param {number} elapsedSec - Segundos transcurridos
 * @param {number} tools - Cantidad de herramientas usadas
 * @param {string} lastTool - Descripción de la última herramienta
 * @param {string} textoOriginal - El pedido original del usuario
 * @returns {string}
 */
function generarMensajeProgreso(count, elapsedSec, tools, lastTool, textoOriginal) {
  const ctx = lastTool ? lastTool.slice(0, 50) : '';
  const t = (textoOriginal || '').toLowerCase();

  // Detectar categoría del pedido para contextualizar
  let categoria = 'general';
  if (/reinici|restart|levantar/.test(t)) categoria = 'restart';
  else if (/recurs|cpu|ram|memoria|disco/.test(t)) categoria = 'recursos';
  else if (/error|fall|crash|bug|romp/.test(t)) categoria = 'diagnostico';
  else if (/implement|rediseñ|cambi|agreg|nuev|código|codigo/.test(t)) categoria = 'implementacion';
  else if (/revis|analiz|investig|fij|cheque/.test(t)) categoria = 'investigacion';
  else if (/deploy|merge|pr |pull|entreg|push/.test(t)) categoria = 'delivery';
  else if (/test|qa|calidad|verificar/.test(t)) categoria = 'testing';
  else if (/log|monitor|estado|status|dashboard/.test(t)) categoria = 'monitoreo';
  else if (/clean|limp|orden|borra|elimin/.test(t)) categoria = 'limpieza';
  else if (/issue|backlog|historia|ticket|label/.test(t)) categoria = 'gestion';
  else if (/config|setting|hook|permiso/.test(t)) categoria = 'config';
  else if (/video|drive|subir|upload|archivo/.test(t)) categoria = 'archivos';

  // Pool amplio de mensajes por categoría — argentinizados y variados
  const pools = {
    restart: [
      'Reiniciando los servicios, que a veces se ponen caprichosos',
      'Levantando todo de nuevo, en un toque te confirmo',
      'Tirando abajo y volviendo a armar, que es la que va',
      'Re-arrancando servicios, dame un momentito que termine de levantar todo',
      'Matando procesos y volviendo a lanzar, enseguida',
      'Bajando y subiendo servicios, los que se cuelgan los reinicio de cero',
      'Haciendo el restart limpio, no quiero dejar nada zombie',
      'Arrancando todo fresh, un toque y te confirmo que levantó',
      'El reinicio va bien, estoy esperando que los servicios respondan',
      'Reiniciando con paciencia, que si apuro se traban más',
      'Ahí va levantando todo, algunos servicios tardan un cachito',
      'Ya maté lo que había que matar, ahora estoy levantando de nuevo',
      'Va el restart, verificando que cada servicio arranque como corresponde',
      'Reinicio en marcha, chequeando uno por uno que respondan',
      'Haciendo el ciclo completo de restart, dame unos minutos',
    ],
    recursos: [
      'Mirando cómo anda la máquina, chequeando CPU y memoria',
      'Revisando los consumos del sistema, a ver qué está chupando recursos',
      'Analizando procesos y memoria, enseguida te cuento el panorama',
      'Midiendo cómo andan los recursos, que a veces algún proceso se zarpa',
      'Escaneando el estado del sistema en detalle, ya te armo el reporte',
      'Chequeando qué procesos están comiendo más, dame un toque',
      'Juntando métricas de CPU, RAM y disco para darte el panorama',
      'Revisando la salud del sistema, quiero ver si hay algo que se pasó de rosca',
      'Viendo los consumos en tiempo real, enseguida te reporto qué encontré',
      'Investigando si hay algún proceso desbocado que esté jodiendo',
      'Monitoreando la carga del sistema, un toque y te cuento',
      'Analizando la performance general, quiero darte data precisa',
      'Chequeando si la máquina anda holgada o apretada de recursos',
      'Midiendo tiempos de respuesta y consumo, para ver si hay cuello de botella',
      'Revisando los picos de consumo, dame un ratito que lo proceso',
    ],
    diagnostico: [
      'Revisando los logs a ver qué pasó, bancame un toque',
      'Investigando el problema, leyendo trazas y estado de los servicios',
      'Buscando la causa raíz del quilombo, un ratito más',
      'Metiéndome en los logs para entender qué se rompió',
      'Analizando el error en detalle, quiero darte un diagnóstico posta',
      'Siguiendo el rastro del bug, hay varias pistas a chequear',
      'Leyendo trazas de error para armar la línea de tiempo del problema',
      'Cruzando datos entre los logs, a ver dónde arrancó el despelote',
      'Desenredando el error, que a veces uno tapa al otro',
      'Buscando el punto exacto donde se rompió, ya estoy cerca',
      'Analizando el stack trace y el contexto, quiero darte la posta',
      'Revisando qué cambió para que esto falle, no quiero tirar diagnóstico a medias',
      'Chequeando si el error es puntual o si hay algo de fondo',
      'Rastreando el bug paso a paso, enseguida te cuento qué encontré',
      'Investigando si es un error nuevo o algo que ya venía de antes',
      'Mirando los logs con lupa, quiero entender bien el escenario del fallo',
    ],
    implementacion: [
      'Metido en el código haciendo los cambios, viene bien',
      'Laburando en la implementación, son varios archivos pero avanzo',
      'Escribiendo código y testeando, no quiero mandarte cualquier cosa',
      'Armando los cambios, quiero que quede bien antes de mostrártelo',
      'La implementación tiene sus vueltas pero sale',
      'Haciendo las modificaciones, chequeando que cada parte funcione',
      'Escribiendo el código, me estoy asegurando de no romper nada existente',
      'Avanzando con los cambios, tocando los archivos que corresponden',
      'Codeando y probando sobre la marcha, va tomando forma',
      'Implementando la solución, estoy en la parte más tricky',
      'Armando todo prolijo, que después no quiero volver a tocar esto',
      'En pleno desarrollo, ya hice la parte más pesada',
      'Ajustando los detalles de la implementación, lo grueso ya está',
      'Picando código, enseguida te cuento qué armé',
      'Haciendo las modificaciones paso a paso, sin apurar para no meter la pata',
      'Metiéndole al código, quiero que quede sólido de entrada',
    ],
    investigacion: [
      'Investigando a fondo, leyendo código y logs',
      'Revisando todo lo relacionado al tema, quiero darte data completa',
      'Metiéndome en los archivos para entender bien qué pasa',
      'Analizando el tema en detalle, enseguida te cuento',
      'Ya tengo algunas pistas pero quiero confirmar antes de hablar',
      'Leyendo código fuente para entender cómo funciona esto hoy',
      'Cruzando info de varios archivos, quiero darte un panorama claro',
      'Revisando el historial de cambios para entender el contexto',
      'Investigando a fondo, prefiero tardar un poco más y darte la posta',
      'Siguiendo varias pistas en paralelo, enseguida te cuento',
      'Chequeando cómo se conectan las piezas, esto tiene varias capas',
      'Leyendo documentación y código para darte una respuesta completa',
      'Analizando el tema desde varios ángulos, no quiero dejar nada afuera',
      'Haciendo la investigación como corresponde, sin atajo',
      'Juntando toda la info relevante, un ratito más y te cuento',
      'Rastreando el tema en el código y la config, ya voy entendiendo',
    ],
    delivery: [
      'Preparando todo para entregar, revisando que esté prolijo',
      'Armando el PR con los cambios, un ratito más',
      'Verificando que todo compile y pase los checks antes de pushear',
      'En el proceso de delivery, quiero que salga limpio',
      'Empaquetando los cambios para el merge, ya casi',
      'Haciendo el commit y preparando el push, quiero que el PR quede claro',
      'Revisando el diff final antes de crear el PR',
      'Armando la descripción del PR con los detalles técnicos',
      'Pusheando y creando el PR, dame un toque',
      'Verificando que no falte nada antes del merge',
      'En la recta final de la entrega, revisando todo una vez más',
      'Preparando el delivery, quiero que esté todo documentado',
      'Haciendo las últimas verificaciones antes de entregar',
      'Armando todo para que el merge sea limpio, sin sorpresas',
      'Ya estoy en la parte de delivery, falta poco',
    ],
    testing: [
      'Corriendo tests y verificando calidad, esto lleva su rato',
      'En la fase de testing, quiero asegurarme que no se rompa nada',
      'Ejecutando las verificaciones, bancame que termine de correr todo',
      'Testeando los cambios a fondo, mejor prevenir que curar',
      'Validando que todo funcione como corresponde, un toque más',
      'Pasando los tests uno por uno, hasta ahora vienen bien',
      'Corriendo la suite de tests, enseguida te cuento el resultado',
      'En plena verificación, quiero darte el resultado con confianza',
      'Testeando edge cases, no quiero que algo raro se cuele',
      'Ejecutando validaciones, si pasa todo te confirmo al toque',
      'Revisando que los tests cubran bien los escenarios importantes',
      'En la etapa de verificación, esto es lo que más vale la pena esperar',
      'Corriendo checks de calidad, dame unos minutos',
      'Validando el comportamiento esperado, va bien hasta ahora',
      'Testeando en todas las configuraciones que corresponden',
    ],
    monitoreo: [
      'Revisando el estado de todo, juntando métricas y datos',
      'Chequeando cómo andan los servicios, enseguida te reporto',
      'Mirando el estado del pipeline y los agentes, un momento',
      'Recopilando info del sistema para darte el panorama completo',
      'Monitoreando los servicios, en un toque te armo el resumen',
      'Juntando data de todos los procesos para el reporte',
      'Consultando el estado de cada servicio, ya te armo el status',
      'Chequeando qué está corriendo y qué no, enseguida te cuento',
      'Relevando el estado actual del pipeline, dame un momentito',
      'Armando el panorama general, quiero que sea preciso',
      'Mirando las métricas actualizadas, ya te paso el resumen',
      'Revisando logs recientes y estado de procesos',
      'Verificando la salud de cada componente del pipeline',
      'Recopilando el estado de agentes y servicios, un toque',
      'Consultando todo para darte una foto completa del sistema',
    ],
    limpieza: [
      'Limpiando lo que hay que limpiar, con cuidado de no volar nada importante',
      'Ordenando el workspace, identificando qué se puede borrar tranqui',
      'En la limpieza, revisando qué queda y qué sobra',
      'Haciendo espacio y ordenando, dame un ratito',
      'Barriendo archivos temporales y procesos huérfanos',
      'Identificando basura para eliminar sin tocar lo que importa',
      'Limpiando logs viejos y archivos temporales, con cuidado',
      'Ordenando la casa, que después se acumula y se complica',
      'Revisando qué se puede limpiar de forma segura',
      'Haciendo la limpieza con criterio, no quiero borrar algo que se necesite',
      'Borrando lo que corresponde, dejando todo prolijo',
      'En modo limpieza, ya identifiqué lo que sobra',
      'Sacando la basura digital, dame un toque que termino',
      'Liberando espacio y matando procesos que ya no sirven',
      'Haciendo espacio en el disco, limpiando con precaución',
    ],
    gestion: [
      'Revisando los issues y el backlog, organizando prioridades',
      'Trabajando con los issues en GitHub, acomodando todo',
      'Analizando el estado del backlog, enseguida te reporto',
      'Gestionando issues y dependencias, un ratito más',
      'Ordenando el tablero, quiero darte el panorama limpio',
      'Revisando labels y asignaciones en GitHub',
      'Actualizando el estado de los issues, dame un toque',
      'Cruzando info del backlog para darte un resumen claro',
      'Organizando las prioridades del tablero, enseguida te cuento',
      'Chequeando bloqueos y dependencias entre issues',
      'Gestionando el flujo de trabajo en GitHub, un momento',
      'Repasando los tickets para ver qué está al día y qué no',
      'Actualizando el estado de cada issue, quiero que el tablero refleje la realidad',
      'Ordenando prioridades y moviendo issues donde corresponde',
      'Revisando el panorama del backlog completo, un ratito',
    ],
    config: [
      'Revisando la configuración, chequeando que todo esté en orden',
      'Tocando settings, con cuidado de no romper nada',
      'Ajustando la config, enseguida te confirmo el cambio',
      'Modificando la configuración pedida, dame un toque',
      'Revisando hooks y permisos, quiero asegurarme de que esté correcto',
      'En los archivos de config, haciendo los ajustes necesarios',
      'Actualizando la configuración del pipeline, un momento',
      'Chequeando y ajustando settings, ya casi',
      'Tocando los archivos de configuración, con precaución',
      'Revisando que la config nueva no genere conflictos',
      'Haciendo el cambio de configuración, verificando que tome efecto',
      'Ajustando parámetros, enseguida te confirmo',
    ],
    archivos: [
      'Procesando los archivos, verificando que estén completos',
      'Preparando el upload, chequeando que todo esté en orden',
      'Trabajando con los archivos, dame un toque',
      'Subiendo lo que hay que subir, verificando que llegue bien',
      'Procesando la tarea de archivos, enseguida te confirmo',
      'Moviendo archivos y verificando integridad, un ratito',
      'En el proceso de upload, chequeando que no falle nada',
      'Revisando y procesando archivos, ya casi termino',
      'Manejando los archivos necesarios, dame un momento',
      'Trabajando con el almacenamiento, quiero que quede todo en su lugar',
      'Procesando uploads pendientes, verificando uno por uno',
      'Preparando y subiendo archivos, con paciencia para que salga bien',
    ],
    general: [
      'Estoy en eso, bancame un toque que ya te cuento',
      'Laburando en tu pedido, viene avanzando bien',
      'Metiéndole pata a esto, enseguida te tengo la respuesta',
      'Trabajando en lo que me pediste, un ratito más',
      'Avanzando con esto, ya te tengo novedades en un toque',
      'Dale que va, estoy terminando de procesar todo',
      'Sigo en la misma, pero avanzando bien',
      'En un momento te paso el resultado, viene encaminado',
      'Acá ando metiéndole, enseguida te cuento',
      'Dándole forma a lo que me pediste, ya falta menos',
      'Procesando tu pedido, quiero darte algo concreto',
      'Laburando con ganas, un toque más y te paso la data',
      'Avanzando firme, ya te tengo algo en un ratito',
      'En eso estoy, tranqui que no me olvidé',
      'Metiéndole, viene saliendo bien la cosa',
      'Ya estoy bastante avanzado, un poquito más',
      'No aflojo, estoy en el tema y enseguida te cuento',
      'Trabajando concentrado en esto, ya te tengo novedades pronto',
      'Va tomando forma lo que me pediste, dame un toque más',
      'Sigo en la misma, no te preocupes que viene bien',
    ],
  };

  // Frases de progreso/avance con porcentaje y ETA (variadas para no repetir)
  const progresoConEstimacion = [
    (pct, eta) => `Voy por el ${pct}% aprox, calculo que en ${eta} te tengo el resultado`,
    (pct, eta) => `Llevo como un ${pct}% del laburo, en ${eta} más o menos termino`,
    (pct, eta) => `Estoy en un ${pct}% de avance, dame ${eta} más y te cuento`,
    (pct, eta) => `Avancé bastante, ando por el ${pct}%, calculo ${eta} más`,
    (pct, eta) => `Viene bien, estoy en un ${pct}% — unos ${eta} y lo cierro`,
    (pct, eta) => `Ya hice como el ${pct}% de lo que necesito, en ${eta} te paso resultado`,
    (pct, eta) => `Progreso: ${pct}% aprox. Calculo que en ${eta} te tengo todo`,
    (pct, eta) => `Falta menos de lo que parece, ando en ${pct}% — ${eta} más calculo`,
    (pct, eta) => `Más de la mitad lista, estoy en ${pct}% — unos ${eta} y listo`,
    (pct, eta) => `Avanzando al ${pct}%, si todo sale bien en ${eta} te cuento`,
  ];

  // Frases de progreso SIN porcentaje (para variedad, no siempre tirar número)
  const progresoGenerico = [
    'La verdad que viene bastante bien, ya le queda poco',
    'Estoy más cerca del final que del principio, tranqui',
    'Avancé un montón, en un ratito te cuento el resultado',
    'Ya pasé la parte más jodida, lo que queda es más sencillo',
    'Falta poco para cerrar, estoy en los detalles finales',
    'Viene encaminado, no debería tardar mucho más',
    'Ya hice lo más pesado, ahora estoy redondeando',
    'Estoy terminando, en breve te paso la novedad',
    'El grueso ya está, me quedan los últimos ajustes',
    'Esto ya está tomando forma, enseguida te cuento',
    'Casi listo, dame un toquecito más y te confirmo',
    'Ya estoy cerrando, no me falta nada',
  ];

  const pool = pools[categoria] || pools.general;

  // Selección pseudo-aleatoria usando múltiples semillas para mejor distribución
  const seed1 = count + (textoOriginal || '').length;
  const seed2 = count * 7 + (textoOriginal || '').charCodeAt(0) || 0;
  const seed3 = count * 13 + elapsedSec;
  const idx = (seed1 + seed2) % pool.length;
  let msg = pool[idx];

  // Para mensajes 2+, agregar info de progreso (porcentaje/ETA o genérico)
  if (count >= 2) {
    // Estimar progreso: heurística basada en tiempo y herramientas usadas
    // Tareas simples ~2min, complejas ~10min
    const estimatedTotal = tools > 15 ? 600 : tools > 8 ? 420 : tools > 3 ? 240 : 180;
    const pct = Math.min(95, Math.round((elapsedSec / estimatedTotal) * 100));
    const remainSec = Math.max(30, estimatedTotal - elapsedSec);
    const eta = remainSec >= 120 ? `${Math.round(remainSec / 60)} minutos` :
                remainSec >= 60  ? 'un minuto' : 'unos segundos';

    // Alternar entre: solo mensaje base, con porcentaje, o con progreso genérico
    const variant = (seed3 + count) % 5;
    if (variant <= 1 && pct >= 20) {
      // Con porcentaje y ETA
      const progIdx = (seed2 + count) % progresoConEstimacion.length;
      msg = progresoConEstimacion[progIdx](pct, eta);
    } else if (variant === 2) {
      // Con progreso genérico (sin número)
      const genIdx = (seed1 + count) % progresoGenerico.length;
      msg = `${msg}. ${progresoGenerico[genIdx]}`;
    }
    // variant 3-4: solo el mensaje base de categoría (sin aditivos, para variedad)
  }

  // Si hay contexto de herramienta y es categoría general, inyectar referencia sutil
  if (ctx && categoria === 'general' && count > 0 && count % 3 === 0) {
    const referencias = [
      `Ahora estoy con: ${ctx}`,
      `En este momento: ${ctx}`,
      `Metido en: ${ctx}`,
      `Trabajando sobre: ${ctx}`,
      `Ahora ando con: ${ctx}`,
    ];
    const refIdx = (seed2 + count) % referencias.length;
    const cierre = progresoGenerico[(seed1 + count) % progresoGenerico.length];
    msg = `${referencias[refIdx]} — ${cierre.charAt(0).toLowerCase() + cierre.slice(1)}`;
  }

  return msg;
}

// #3587 CA-1 — Instrumentación opcional del subprocess Claude para que el
// caller pueda armar audit log con tool_use_sequence, tool_results_summary
// y subprocess metadata. El parámetro `trace` es un objeto que se llena por
// referencia; si el caller no lo pasa, el comportamiento es exactamente el
// previo (back-compat con los 3 callsites existentes que no necesitan trace).
//
// Forma del trace post-call:
//   trace.toolUseSequence — [{name, input, id, tsMs}]
//   trace.toolResultsSummary — [{tool_use_id, content, isError, tsMs}]
//   trace.subprocess — {cmd, args, exitCode, durationMs, killedByWatchdog}
//
// Los previews NO se redactan ni truncan en ejecutarClaude — esa
// responsabilidad la toma `logSkillInvocation` (`_sanitize*` helpers en
// `issue-creation.js`). Centralizar la redacción evita duplicarla en cada
// callsite y mantiene el `trace` útil también para debugging local.
function ejecutarClaude(prompt, textoOriginal, trace) {
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    const startTimeForAudit = Date.now();
    // #3587 CA-1 — colector opcional de trace. Inicializamos siempre las
    // listas para evitar checks defensivos en cada push.
    const _trace = trace && typeof trace === 'object' ? trace : null;
    if (_trace) {
      _trace.toolUseSequence = [];
      _trace.toolResultsSummary = [];
      _trace.subprocess = {
        cmd: null,
        args: null,
        exitCode: null,
        durationMs: 0,
        killedByWatchdog: false,
      };
    }

    // #3577 CA-S6 — generar UN requestId al inicio del turn y propagarlo
    // a TODOS los `auditCommanderRequest` (prompt_injection_attempt, gated_all,
    // fallback_used, dispatch, inflight_signal_observed). Sin esto no hay
    // correlación cross-event al revisar el audit log.
    const turnRequestId = inflightFallback.generateRequestId({
      chatId: getTelegramChatId(),
      now: startTimeForAudit,
    });

    // #3258 — SR-4: sanitizar el input del usuario ANTES de cualquier dispatch.
    // Si detecta patrones de prompt-injection, recorta al primer match y
    // dejamos constancia en el audit log (best-effort). El prompt efectivo que
    // pasamos al LLM es el sanitizado, no el original.
    const sanRes = commanderMP.sanitizeUserPrompt(prompt);
    const promptForLLM = sanRes.sanitized;
    if (sanRes.hits.length > 0) {
      log('commander', `🛡️ Patrones de prompt-injection detectados (${sanRes.hits.length}) — input recortado.`);
      try {
        commanderMP.auditCommanderRequest({
          pipelineDir: PIPELINE,
          event: 'prompt_injection_attempt',
          providerIntended: 'anthropic',
          providerEffective: null,
          chatId: getTelegramChatId(),
          prompt: prompt,
          injectionHits: sanRes.hits,
          requestId: turnRequestId, // #3577 CA-S6
        });
      } catch { /* best-effort */ }
    }

    // #3258 — CA-3 / CA-1 / CA-2: resolución del provider efectivo con fallback
    // chain. Si Anthropic está gateado por cuota (#2974/#3077), el dispatcher
    // resuelve al próximo provider declarado en `agent-models.json::skills.
    // telegram-commander.fallbacks[]`. Si toda la chain está gateada, devuelve
    // `gated: true` y respondemos canned sin spawnear nada.
    let resolution;
    try {
      resolution = commanderMP.resolveCommanderProvider({
        pipelineDir: PIPELINE,
        log: (l, m) => log(l || 'commander', m),
      });
    } catch (e) {
      log('commander', `⚠️ resolveCommanderProvider falló: ${e.message} — degradando a Anthropic por compatibilidad.`);
      resolution = { provider: 'anthropic', model: null, gated: false, crossProvider: false, primaryProvider: 'anthropic', chainTried: ['anthropic'], fallbackUsed: null, handler: null, source: 'fallback-resolver-error' };
    }

    if (resolution.gated) {
      // Toda la chain está sin cuota. Canned response al usuario.
      log('commander', `🚫 Chain de fallback agotada (chain_tried=${(resolution.chainTried || []).join('->')})`);
      try {
        commanderMP.auditCommanderRequest({
          pipelineDir: PIPELINE,
          event: 'gated_all',
          providerIntended: 'anthropic',
          providerEffective: null,
          chainTried: resolution.chainTried,
          chatId: getTelegramChatId(),
          prompt: prompt,
          errorCode: 'quota_exhausted',
          requestId: turnRequestId, // #3577 CA-S6
        });
      } catch { /* best-effort */ }
      return resolve(commanderMP.cannedAllGatedResponse());
    }

    // CA-5 + SR-6 — Si el dispatcher resolvió a un fallback distinto del
    // primary, emitimos aviso a Leo en formato UX-G1 (lenguaje natural,
    // sin jerga operativa). El runtime ya encoló un mensaje genérico
    // operacional vía `dispatch-with-fallback.js:enqueueTelegramNotice`, pero
    // ese formato es para humanos técnicos. Acá agregamos uno conversacional
    // específico del Commander.
    if (resolution.crossProvider) {
      try {
        const fbHandler = resolution.handler || {};
        // Si el provider efectivo no soporta tool use (Cerebras/Gemini/NVIDIA),
        // SR-8 obliga a avisar la degradación de capacidad en línea separada.
        // Leemos el flag del JSON config para no asumirlo en runtime.
        const supportsToolUse = (() => {
          try {
            const models = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'agent-models.json'), 'utf8'));
            const def = models.providers && models.providers[resolution.provider];
            return def && typeof def.supports_tool_use === 'boolean' ? def.supports_tool_use : true;
          } catch { return true; }
        })();
        const shouldEmit = commanderMP.shouldEmitFallbackNotice({
          pipelineDir: PIPELINE,
          chatId: getTelegramChatId(),
          fallbackProvider: resolution.provider,
        });
        if (shouldEmit) {
          const notice = commanderMP.formatFallbackNotice({
            primaryProvider: resolution.primaryProvider || 'anthropic',
            fallbackProvider: resolution.provider,
            errorCode: 'quota_exhausted',
            supportsToolUse,
          });
          sendTelegramPlain(notice);
          log('commander', `↪️ Cross-provider notice emitido (fallback=${resolution.provider})`);
        } else {
          log('commander', `↪️ Cross-provider fallback activo (fallback=${resolution.provider}) — notice dedupeado por ventana 5min`);
        }
      } catch (notifErr) {
        log('commander', `⚠️ Error formando notice de fallback (best-effort): ${notifErr.message}`);
      }
    }

    // #3258 — args dependen del provider efectivo. Para Anthropic mantenemos
    // los args legacy (`--output-format stream-json`). Para otros providers,
    // dejamos que `buildSpawn` del handler arme sus propios args desde
    // `spawn_args_template` de agent-models.json.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions'
    ];

    // #3085 / S7 multi-provider — aislamiento de credenciales también para
    // el commander singleton. SR-2 #3258: el env del child filtra por el
    // PROVIDER EFECTIVO, no por anthropic hardcoded. Cuando fallbackeamos a
    // openai-codex, el child recibe `OPENAI_API_KEY` y NO `ANTHROPIC_API_KEY`.
    let cleanEnv;
    let commanderEnvIsolation = false;
    try {
      const cfgRoot = loadConfig() || {};
      commanderEnvIsolation = !!(cfgRoot.pipeline && cfgRoot.pipeline.env_isolation_enabled);
    } catch { /* default false */ }
    if (commanderEnvIsolation) {
      try {
        // SR-2 — provider efectivo dinámico. `skillConfigOverride.provider`
        // shape (partial, #3198): el merge interno hace lookup correcto del
        // `credentials_env` del fallback en `agent-models.json::providers`.
        // Si el primary respondió OK, `resolution.provider === 'anthropic'`
        // y el comportamiento es idéntico al previo.
        cleanEnv = buildChildEnvLib.buildChildEnv({
          skill: commanderMP.COMMANDER_SKILL,
          pipelineDir: PIPELINE,
          processEnv: process.env,
          pipelineExtras: { CLAUDE_PROJECT_DIR: ROOT },
          skillConfigOverride: { provider: resolution.provider },
        });
      } catch (e) {
        log('commander', `❌ env-isolation rechazó spawn del commander (provider=${resolution.provider}): ${e.message}`);
        return reject(e);
      }
    } else {
      cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
    }
    // CLAUDECODE se borra siempre — Claude Code lo setea internamente y heredarlo
    // confunde al child sobre si ya está en una sesión activa.
    delete cleanEnv.CLAUDECODE;

    // #3258 — SR-1: data-residency-filter gate antes del spawn. Sólo aplica
    // a providers no-Anthropic; para Anthropic es passthrough explícito.
    // Hoy `paths: []` porque el commander no extrae paths declarativos del
    // prompt; cuando #3198 implemente adapters reales que SÍ procesen
    // contexto del usuario (ej: "leeme X.kt"), este caller pasará la lista
    // detectada. Fail-closed: si el sidecar no carga, el spawn no-Anthropic
    // se aborta y se responde canned.
    const drCheck = commanderMP.enforceDataResidency({
      pipelineDir: PIPELINE,
      provider: resolution.provider,
      paths: [], // commander pre-spawn: sin paths declarativos hoy (ver #3198)
      chatId: getTelegramChatId(),
      prompt: prompt,
      log: (l, m) => log(l || 'commander', m),
    });
    if (!drCheck.ok) {
      log('commander', `🚫 SR-1: data-residency bloqueó spawn ${resolution.provider} (${drCheck.reason}). Respondiendo canned sin spawnear.`);
      try {
        sendTelegramPlain(commanderMP.cannedDataResidencyResponse({
          provider: resolution.provider,
          blocked: drCheck.blocked,
        }));
      } catch { /* best-effort */ }
      return resolve(commanderMP.cannedDataResidencyResponse({
        provider: resolution.provider,
        blocked: drCheck.blocked,
      }));
    }

    // #3258 — Si el provider efectivo NO es Anthropic, tratamos de invocar el
    // handler real vía `safeBuildSpawn`. Los providers no-Anthropic son stubs
    // hasta #3198 — `buildSpawn` tira `_notImplemented`. En ese caso, audit
    // log + respondemos canned al usuario sin matar el flow.
    if (resolution.provider !== 'anthropic') {
      const safe = commanderMP.safeBuildSpawn({
        handler: resolution.handler,
        args,
        cwd: ROOT,
        env: cleanEnv,
      });
      try {
        commanderMP.auditCommanderRequest({
          pipelineDir: PIPELINE,
          event: safe.ok ? 'fallback_used' : 'fallback_unavailable',
          providerIntended: resolution.primaryProvider || 'anthropic',
          providerEffective: resolution.provider,
          chainTried: resolution.chainTried,
          chatId: getTelegramChatId(),
          prompt: prompt,
          latencyMs: Date.now() - startTimeForAudit,
          errorCode: safe.ok ? null : 'not_implemented',
          injectionHits: sanRes.hits,
          requestId: turnRequestId, // #3577 CA-S6
        });
      } catch { /* best-effort */ }
      if (!safe.ok) {
        log('commander', `⚠️ Fallback provider "${resolution.provider}" no implementado (${safe.reason}). Respondiendo canned.`);
        return resolve(commanderMP.cannedFallbackUnavailableResponse({ provider: resolution.provider }));
      }
      // Si #3198 está deployed y el handler real funciona, llegamos acá. La
      // parsing de output stream-json de Anthropic NO aplica directamente a
      // otros providers (cada uno tiene su `output_parser`). Esta es la
      // observación G1/G2 que dejamos para una iteración futura — por ahora
      // si el handler responde con buildSpawn pero el output no es
      // stream-json, capturamos stdout crudo y lo devolvemos al usuario.
      const proc = spawn(safe.spawnDef.cmd, safe.spawnDef.args, safe.spawnDef.spawnOpts);
      proc.stdin && proc.stdin.write && proc.stdin.write(promptForLLM);
      proc.stdin && proc.stdin.end && proc.stdin.end();
      let stdout = '';
      let stderr = '';
      const startNon = Date.now();
      const HARD_NON_ANTH_MS = 90 * 1000; // SR-5 — budget 90s para providers no-stream-json
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        log('commander', `Provider ${resolution.provider} timeout 90s — abortando`);
      }, HARD_NON_ANTH_MS);
      proc.stdout && proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr && proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', () => {
        clearTimeout(timer);
        const elapsed = Date.now() - startNon;
        log('commander', `Provider ${resolution.provider} terminó (${elapsed}ms, stdout=${stdout.length}c, stderr=${stderr.length}c)`);
        try {
          commanderMP.auditCommanderRequest({
            pipelineDir: PIPELINE,
            event: 'fallback_used',
            providerIntended: resolution.primaryProvider || 'anthropic',
            providerEffective: resolution.provider,
            chainTried: resolution.chainTried,
            chatId: getTelegramChatId(),
            prompt: prompt,
            latencyMs: elapsed,
            errorCode: stdout ? null : 'empty_output',
            requestId: turnRequestId, // #3577 CA-S6
          });
        } catch { /* best-effort */ }
        resolve(stdout || `No pude completar tu pedido vía ${resolution.provider}. Intentá de nuevo.`);
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        log('commander', `Error spawning ${resolution.provider}: ${e.message}`);
        resolve(commanderMP.cannedFallbackUnavailableResponse({ provider: resolution.provider }));
      });
      return;
    }

    // Path por default: Anthropic. Comportamiento byte-equivalente al previo.
    const cmdSpawn = CLAUDE_LAUNCHER.cmd;
    const cmdArgs = [...CLAUDE_LAUNCHER.prefixArgs, ...args];

    const proc = spawn(cmdSpawn, cmdArgs, {
      cwd: ROOT,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: CLAUDE_LAUNCHER.shell,
      windowsHide: true
    });

    // #3587 CA-1 — registrar metadata del spawn en el trace (Anthropic path).
    if (_trace) {
      _trace.subprocess.cmd = cmdSpawn;
      _trace.subprocess.args = Array.isArray(cmdArgs) ? cmdArgs.slice(0, 16) : [];
    }

    // #3258 — SR-4: pasamos el prompt SANITIZADO al LLM, no el original.
    proc.stdin.write(promptForLLM);
    proc.stdin.end();

    let lastText = '';
    let finalResult = null;
    let toolCount = 0;
    let lastToolDesc = '';
    let progressCount = 0;
    let resolved = false;
    const startTime = Date.now();

    // Límite absoluto: 10 minutos — si Claude no terminó, matar y resolver
    const HARD_TIMEOUT_MS = 10 * 60 * 1000;

    // #3418 CA-3 — watchdog específico para Skill /doc y /planner. Trackeamos
    // cada `tool_use` cuyo `name === 'Skill'` y limpiamos cuando llega el
    // `tool_result` correspondiente (matcheado por `tool_use_id`). Si pasan
    // 60s sin result, killProc + flag de skillTimeout para que el caller en
    // procesarTextoLibre clasifique como SKILL_RESULT_TIMEOUT en el audit log
    // y envíe el mensaje de timeout a Telegram.
    const SKILL_WATCHDOG_MS = 60 * 1000;
    const pendingSkillCalls = new Map(); // tool_use_id → { startedAt, skillName }
    let skillTimedOut = false; // flag que finish() expone al caller
    let skillTimedOutInfo = null; // { skillName, durationMs }

    // =============================================================================
    // #3577 — Detectores in-stream SHADOW (parte 1/2 del split de #3472).
    //
    // Observan first-byte/stream-gap/eof-premature/transient-5xx y emiten al
    // audit log SIN matar el primario ni spawnear secundario. Wire-up real va
    // en #3578. Ver `lib/commander/inflight-shadow-detectors.js` y el CA del PO.
    //
    // CA-A5: HARD_TIMEOUT 10min intocado.
    // CA-A6: SKILL_WATCHDOG_MS intocado; pendingSkillCalls NUNCA se muta acá.
    // CA-S7: PROHIBIDO invocar decideInflightFallback/acquireInflightLock/etc.
    // =============================================================================
    let lastLineAt = 0;            // CA-A2: timestamp del último line recibido del rl
    let firstByteFired = false;    // CA-A1: flag — solo emitir UNA vez por turn
    let streamGapFired = false;    // CA-A2: flag — solo emitir UNA vez por turn
    let eofPrematureFired = false; // CA-A3: flag — solo emitir UNA vez por turn
    let transient5xxFired = false; // CA-A4: flag — solo emitir UNA vez por turn

    // _emitShadowSignal — helper único de write al audit log (SR-S1 → appendChained).
    // Allowlist garantizada por `buildInflightSignalEntry` (SR-S2).
    function _emitShadowSignal(errorClass) {
      try {
        const entry = inflightShadow.buildInflightSignalEntry({
          errorClass,
          chatId: getTelegramChatId(),
          requestId: turnRequestId,
          primaryProvider: resolution.primaryProvider || 'anthropic',
          providerEffective: resolution.provider,
          startTime,
          now: Date.now(),
          partialOutput: lastText, // se hashea, NUNCA se guarda contenido (SR-S2)
        });
        inflightShadow.emitInflightSignal({ pipelineDir: PIPELINE, entry });
        log('commander', `🔎 [shadow] inflight_signal_observed{error_class=${errorClass}, request_id=${turnRequestId.slice(0, 20)}…}`);
      } catch (e) {
        log('commander', `⚠️ shadow detector emit falló (best-effort): ${e.message}`);
      }
    }

    function finish(code, reason) {
      if (resolved) return;
      resolved = true;
      clearInterval(progressTimer);
      clearTimeout(hardTimer);
      clearInterval(skillWatchdogTimer);
      // #3577 CA-S3 — cleanup determinístico de los timers shadow para evitar
      // handle leak en el Commander (proceso de larga vida, días).
      clearTimeout(firstByteShadowTimer);
      clearInterval(streamGapShadowTimer);
      rl.close();

      // #3577 CA-A3 / R-3 — eof_premature shadow.
      // Emitir si exit con code != 0, sin result event ni texto.
      // R-3 guard: si finalResult está seteado, el code != 0 puede ser por
      // el workaround #25629 (result OK + killProc 3s); no es eof prematuro.
      if (inflightShadow.shouldFireEofPremature({
        code,
        finalResult,
        lastText,
        alreadyFired: eofPrematureFired,
      })) {
        eofPrematureFired = true;
        _emitShadowSignal('eof_premature');
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      // #3587 CA-1 — finalizar subprocess metadata en el trace antes de resolver.
      if (_trace && _trace.subprocess) {
        _trace.subprocess.exitCode = (code === null || code === undefined) ? null : Number(code);
        _trace.subprocess.durationMs = Date.now() - startTime;
        // killedByWatchdog ya se setea desde el skillWatchdogTimer.
      }
      log('commander', `Claude terminó (${reason}, code=${code}, tools=${toolCount}, ${elapsed}s, lastText=${(lastText||'').length}chars)`);
      // #3418 CA-3 — si el watchdog detectó timeout de Skill, anexamos
      // marcador al texto final para que el caller pueda distinguir el caso
      // y mapear a SKILL_RESULT_TIMEOUT en el audit log + enviar mensaje
      // específico a Telegram. NO modificamos la respuesta visible si el
      // proceso terminó por otra razón.
      if (skillTimedOut && skillTimedOutInfo) {
        const marker = `[SKILL_TIMEOUT:${skillTimedOutInfo.skillName}:${skillTimedOutInfo.durationMs}ms]`;
        log('commander', `🚨 SKILL_TIMEOUT propagado al caller: ${marker}`);
        if (!lastText) lastText = marker;
      }
      // #3258 — CA-4 / SR-3: audit log con hash-chain del request del commander.
      // Métadata mínima (prov, tokens si los hay, latencia, hashes). NO se
      // loguea prompt ni respuesta literales — solo hashes.
      try {
        const usage = finalResult && finalResult.usage ? finalResult.usage : (finalResult && finalResult.message && finalResult.message.usage) || null;
        const tokensSummary = usage ? {
          input: Number(usage.input_tokens || 0),
          output: Number(usage.output_tokens || 0),
          cache_read: Number(usage.cache_read_input_tokens || 0),
          cache_create: Number(usage.cache_creation_input_tokens || 0),
          tool_calls: toolCount,
        } : { tool_calls: toolCount };
        commanderMP.auditCommanderRequest({
          pipelineDir: PIPELINE,
          event: 'dispatch',
          providerIntended: resolution.primaryProvider || 'anthropic',
          providerEffective: resolution.provider,
          chainTried: resolution.chainTried,
          chatId: getTelegramChatId(),
          prompt: prompt,
          tokens: tokensSummary,
          latencyMs: Date.now() - startTime,
          errorCode: (finalResult && finalResult.result) || lastText ? null : 'no_result',
          injectionHits: sanRes.hits,
          supportsToolUse: true,
          requestId: turnRequestId, // #3577 CA-S6
        });
      } catch { /* best-effort */ }
      if (finalResult?.result) {
        resolve(finalResult.result);
      } else if (lastText) {
        resolve(lastText);
      } else {
        log('commander', `stderr: ${stderr.slice(0, 300)}`);
        resolve(`No pude completar tu pedido (${toolCount} operaciones en ${elapsed}s). Intentá de nuevo o con algo más puntual.`);
      }
    }

    function killProc() {
      try { proc.kill('SIGTERM'); } catch {}
      // En Windows SIGTERM no siempre funciona — forzar con taskkill /T (tree kill)
      try {
        if (proc.pid) execSync(`taskkill /PID ${proc.pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      } catch {}
    }

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      // #3577 CA-A2 / R-6 — actualizar timestamp del último line ANTES del
      // filtro de empty lines. La métrica de gap se mide sobre lines del
      // JSON-stream, no sobre bytes crudos de `proc.stdout.on('data')`.
      lastLineAt = Date.now();
      if (!line.trim()) return;
      try {
        const evt = JSON.parse(line);

        // #3577 CA-A4 / SR-S4 / R-7 — transient_5xx shadow detector.
        // Match estructurado por shape (NO substring). Excluye cli_1m_context_glitch
        // (R-7) usando el detector dedicado de `quotaExhausted`.
        if (!transient5xxFired) {
          const cliGlitchDetector = (e) => {
            try {
              let providerDef = null;
              try { providerDef = getSkillProviderDef('anthropic'); } catch { /* defensa */ }
              if (!providerDef) return false;
              const det = quotaExhausted.detectQuotaError(e, providerDef);
              return !!(det && det.cliGlitch);
            } catch { return false; }
          };
          if (inflightShadow.detectTransient5xx(evt, { cliGlitchDetector })) {
            transient5xxFired = true;
            _emitShadowSignal('transient_5xx');
          }
        }

        if (evt.type === 'assistant' && evt.message?.content) {
          const blocks = Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content];
          for (const b of blocks) {
            if (b.type === 'text' && b.text) lastText = b.text;
            if (b.type === 'tool_use') {
              toolCount++;
              lastToolDesc = b.input?.description || b.input?.command?.slice(0, 50) || b.name || '';
              log('commander', `  [tool ${toolCount}] ${b.name}: ${lastToolDesc.slice(0, 80)}`);
              // #3587 CA-1 — registrar el tool_use en el trace. Guardamos
              // `input` RAW: la redacción + truncado los aplica el sanitizer
              // del audit log cuando se escribe el JSONL.
              if (_trace) {
                _trace.toolUseSequence.push({
                  name: typeof b.name === 'string' ? b.name : 'unknown',
                  input: b.input,
                  id: typeof b.id === 'string' ? b.id : null,
                  tsMs: Date.now() - startTime,
                });
              }
              // #3418 CA-3 — arrancar reloj del watchdog SOLO para
              // tool_use cuyo `name === 'Skill'` Y el `input.skill` esté
              // en la allowlist (`doc`/`planner`). Para otras tools
              // (Bash, Read, Edit, etc.) el HARD_TIMEOUT de 10min sigue
              // siendo el único límite.
              if (b.name === 'Skill' && b.id) {
                const skillName = b.input && typeof b.input.skill === 'string' ? b.input.skill : null;
                const watched = skillName && (skillName === 'doc' || skillName === 'planner');
                if (watched) {
                  pendingSkillCalls.set(b.id, {
                    startedAt: Date.now(),
                    skillName,
                  });
                  log('commander', `  ⏱️ Skill watchdog armado para ${skillName} (tool_use_id=${b.id.slice(0, 12)}…, deadline=${SKILL_WATCHDOG_MS/1000}s)`);
                }
              }
            }
          }
        } else if (evt.type === 'user' && evt.message?.content) {
          // #3418 CA-3 — Claude Code SDK envía los `tool_result` como mensajes
          // tipo `user` con content que incluye bloques `tool_result` con el
          // `tool_use_id` matcheando el `tool_use` original. Limpiamos el
          // tracker para esos IDs.
          const blocks = Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content];
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              // #3587 CA-1 — registrar TODOS los tool_result en el trace
              // (no solo los de Skill). El sanitizer del audit log se encarga
              // del redact + truncate. `content` puede ser string o array de
              // bloques — normalizamos a string para el trace.
              if (_trace) {
                let contentStr = '';
                if (typeof b.content === 'string') {
                  contentStr = b.content;
                } else if (Array.isArray(b.content)) {
                  contentStr = b.content
                    .map((c) => (c && c.type === 'text' && typeof c.text === 'string') ? c.text : '')
                    .filter(Boolean)
                    .join('\n');
                }
                _trace.toolResultsSummary.push({
                  tool_use_id: b.tool_use_id,
                  content: contentStr,
                  isError: b.is_error === true,
                  tsMs: Date.now() - startTime,
                });
              }
              // #3418 CA-3 — bookkeeping del watchdog (sólo para Skill).
              if (pendingSkillCalls.has(b.tool_use_id)) {
                const pending = pendingSkillCalls.get(b.tool_use_id);
                const dur = Date.now() - pending.startedAt;
                pendingSkillCalls.delete(b.tool_use_id);
                log('commander', `  ✓ Skill ${pending.skillName} completó en ${dur}ms (tool_use_id=${b.tool_use_id.slice(0, 12)}…)`);
              }
            }
          }
        } else if (evt.type === 'result') {
          finalResult = evt;
          // #2974 — Detector de cuota agotada (CA-1, anti-prompt-injection).
          // Match estructurado por shape del JSON stream — NUNCA por substring
          // sobre texto libre. Si match, setear flag y dejar que pulpo gatee
          // futuros spawns LLM. Skills determinísticos siguen corriendo.
          try {
            const cfg = (loadConfig() || {}).quota_detector || {};
            // #3077 CA-4 / CA-5: el commander corre siempre como provider
            // anthropic (Claude Desktop), así que resolvemos su providerDef
            // explícito para usar el dispatcher correcto.
            let cmdProviderDef = null;
            let cmdProvider = 'anthropic';
            let cmdModel = null;
            try {
              cmdProviderDef = getSkillProviderDef('anthropic');
              cmdModel = cmdProviderDef ? cmdProviderDef.model : null;
            } catch { /* defensa */ }

            // #3576 CA-3 — Feature flag PIPELINE_GENERALIZED_PARSER_ENABLED.
            //   - OFF (legacy): código abajo — preserva comportamiento
            //     pre-#3576 (cliGlitch detection inline + setFlag).
            //   - ON  (generalized): delega a onSpawnExit. El hook clasifica
            //     `cli_1m_context_glitch` como categoría aparte (matriz docu).
            const dispatcher = require('./lib/agent-launcher/dispatch-with-fallback');
            const generalizedEnabled = dispatcher.isGeneralizedParserEnabled();

            // Veredicto generalizado (solo se usa si el flag está ON).
            let generalizedVerdict = null;
            if (generalizedEnabled) {
              try {
                generalizedVerdict = dispatcher.onSpawnExit({
                  skill: 'commander',
                  provider: cmdProvider,
                  transport: 'cli',
                  rawOutput: line, // JSON line del stream-json
                  exitCode: 0,     // result event llegó, todavía no hubo exit
                  timedOut: false,
                  durationMs: Date.now() - startTime,
                  pipelineDir: PIPELINE,
                  onLog: (lvl, msg) => log('commander', msg),
                });
                log('commander',
                  `${dispatcher.CODEPATH_EMOJI.generalized} codepath=generalized ` +
                  `skill=commander provider=${cmdProvider} ` +
                  `error_class=${generalizedVerdict.errorClass} ` +
                  `flag_set=${generalizedVerdict.flagSet} ` +
                  `decision=${generalizedVerdict.decision}`);
              } catch (e) {
                log('commander', `[#3576] onSpawnExit tiró (best-effort): ${e && e.message}`);
              }
            }

            const det = cmdProviderDef
              ? quotaExhausted.detectQuotaError(evt, cmdProviderDef)
              : quotaExhausted.detectFromResultEvent(evt, cfg);
            if (!generalizedEnabled) {
              log('commander',
                `${dispatcher.CODEPATH_EMOJI.legacy} codepath=legacy ` +
                `skill=commander provider=${cmdProvider} ` +
                `error_class=${det.cliGlitch ? 'cli_1m_context_glitch' : det.matched ? 'quota_exhausted' : 'unknown'} ` +
                `matched=${det.matched === true}`);
            }
            if (det.cliGlitch) {
              // #3506: bug del CLI Anthropic Claude Code — "Usage credits required
              // for 1M context" pese a que el plan Claude Max 20x SÍ incluye 1M
              // para Opus 4.7. NO seteamos flag de quota (Anthropic está sano)
              // ni saltamos provider. Avisamos al usuario para que reintente.
              log('commander', `🐞 cli_1m_context_glitch detectado (provider=${cmdProvider}, glitchType="${det.glitchType}") — Anthropic sano, bug upstream del CLI con Opus 4.7 1M. NO seteando flag de quota.`);
              // #3508 CA-3 / SEC-5: registrar hit en commander-session.json
              // (contador + last_hit_at) y loggear con shape sanitizado (sin
              // prompt del usuario, sin context del agente).
              let hitState = null;
              try {
                const hit = oneMWorkaround.recordHit({ sessionFile: SESSION_FILE });
                hitState = hit.state;
                if (hit.corrupt && hit.corrupt.length > 0) {
                  // SEC-4: corrupciones del JSON se loggean pero no crashean.
                  log('commander', `[anthropic-1m] session_corrupt: ${JSON.stringify(hit.corrupt)}`);
                }
                const hitLog = oneMWorkaround.sanitizeHitLog({
                  timestamp: new Date().toISOString(),
                  provider: cmdProvider,
                  evidence: quotaExhausted.sanitizeRawExcerpt ? quotaExhausted.sanitizeRawExcerpt(line) : '',
                });
                log('commander', `[anthropic-1m] hit registrado: ${JSON.stringify(hitLog)} (total=${hitState.hits_total})`);
              } catch (e) { log('commander', `[anthropic-1m] recordHit falló (best-effort): ${e.message}`); }
              try {
                // #3508 UX-1 / CA-5: extender el mensaje con el estado actual del
                // workaround (hits y último hit) y la sugerencia operativa.
                const baseMsg =
                  `🐞 Bug intermitente del CLI de Anthropic Claude Code: pidió 1M context y devolvió ` +
                  `"Usage credits required" aunque el plan Claude Max 20x sí lo cubra. ` +
                  `Estoy preservando Anthropic como activo (no salto a otro proveedor). ` +
                  `Reintentá tu pedido en unos segundos.`;
                let extension = '';
                try { extension = oneMWorkaround.formatHitExtension({ sessionFile: SESSION_FILE }); } catch {}
                sendTelegramPlain(baseMsg + extension);
              } catch { /* best-effort */ }
            } else if (det.matched) {
              // #3576 CA-3: en modo generalizado el hook ya invocó setFlag
              // (con audit log unificado + hash-chain). En legacy seguimos
              // setFlag inline para no romper la fast-path histórica.
              if (generalizedEnabled && generalizedVerdict && generalizedVerdict.flagSet) {
                log('commander', `🚫 quota_detector (generalized): provider=${cmdProvider}, error_class=${generalizedVerdict.errorClass} — flag ya seteado por hook`);
              } else {
                log('commander', `🚫 quota_detector: provider=${cmdProvider}, error_type="${det.errorType}" detectado — seteando flag`);
                quotaExhausted.setFlag({
                  errorType: det.errorType,
                  provider: cmdProvider,
                  model: cmdModel,
                  resetsAt: evt.resets_at,
                  maxDays: (cmdProviderDef && cmdProviderDef.resets_at_cap_max_days) || cfg.resets_at_cap_max_days,
                  agent: 'commander',
                  rawExcerpt: line,
                  auditLogEnabled: cfg.audit_log_enabled !== false,
                });
              }
            } else if (evt.is_error !== true) {
              // CA-3 (issue padre): un spawn exitoso prueba que la cuota volvió
              // antes del resets_at calculado → drenado proactivo.
              // #3077 CA-8: scope por provider — solo limpia flag de anthropic.
              try {
                quotaExhausted.clearFlag({
                  event: 'success_spawn',
                  reason: 'commander_success',
                  provider: cmdProvider,
                  model: cmdModel,
                });
              } catch {}
            }
          } catch (qErr) {
            log('commander', `quota_detector falló (best-effort): ${qErr.message}`);
          }
          // WORKAROUND para bug claude-code#25629: CLI no termina después del result event.
          // Dar 3s de gracia para que el proceso salga solo, si no: matarlo.
          log('commander', 'Result event recibido — esperando 3s para exit limpio...');
          setTimeout(() => {
            if (!resolved) {
              log('commander', 'Claude no salió tras result — matando proceso (workaround #25629)');
              killProc();
              finish(null, 'result+kill');
            }
          }, 3000);
        }
      } catch {}
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Mensajes de progreso contextuales cada 2 minutos
    const progressTimer = setInterval(() => {
      if (resolved) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const msg = generarMensajeProgreso(progressCount, elapsed, toolCount, lastToolDesc, textoOriginal);
      progressCount++;
      sendTelegram(msg);
      log('commander', `Progreso: ${msg}`);
    }, 120000);

    // Hard timeout: si nada resolvió en 10 min, forzar finalización
    const hardTimer = setTimeout(() => {
      if (!resolved) {
        log('commander', `HARD TIMEOUT (${HARD_TIMEOUT_MS / 60000}min) — matando Claude`);
        killProc();
        finish(null, 'hard-timeout');
      }
    }, HARD_TIMEOUT_MS);

    // #3418 CA-3 — Skill watchdog: revisa cada 5s si hay algún Skill
    // (`/doc` o `/planner`) cuya emisión de `tool_use` excede los 60s sin
    // `tool_result`. Si lo hay, mata el proceso (tree-kill en Windows),
    // setea flag de timeout y deja que `finish()` propague el marcador al
    // caller (procesarTextoLibre) para audit log + mensaje a Telegram.
    // SEC-E (cleanup determinístico): killProc ya garantiza taskkill /T.
    const skillWatchdogTimer = setInterval(() => {
      if (resolved || pendingSkillCalls.size === 0) return;
      const now = Date.now();
      for (const [toolUseId, info] of pendingSkillCalls) {
        const dur = now - info.startedAt;
        if (dur >= SKILL_WATCHDOG_MS) {
          skillTimedOut = true;
          skillTimedOutInfo = { skillName: info.skillName, durationMs: dur, toolUseId };
          pendingSkillCalls.clear();
          // #3587 CA-1 — marcar el trace para que el caller sepa que el
          // subprocess murió por el watchdog (vs HARD_TIMEOUT vs exit normal).
          if (_trace && _trace.subprocess) _trace.subprocess.killedByWatchdog = true;
          log('commander', `🚨 SKILL_WATCHDOG: ${info.skillName} no completó en ${SKILL_WATCHDOG_MS/1000}s (esperado ${dur}ms) — killProc`);
          killProc();
          finish(null, 'skill-watchdog-timeout');
          return;
        }
      }
    }, 5000);

    // #3577 CA-A1 — first-byte timer (15s sin recibir el primer line).
    // Modo shadow: solo emite al audit, NO mata el primario.
    const firstByteShadowTimer = setTimeout(() => {
      if (resolved) return;
      if (inflightShadow.shouldFireFirstByte({
        startTime,
        now: Date.now(),
        lastLineAt,
        alreadyFired: firstByteFired,
      })) {
        firstByteFired = true;
        _emitShadowSignal('timeout_first_byte');
      }
    }, inflightShadow.FIRST_BYTE_THRESHOLD_MS);

    // #3577 CA-A2 / R-1 / SR-S5 — stream-gap detector (30s sin nuevos lines).
    // Implementado con setInterval(5000), NO busy-wait. Pausado mientras hay
    // Skill in-flight (el SKILL_WATCHDOG_MS=60s cubre Skills con semántica propia).
    // Modo shadow: solo emite al audit.
    const streamGapShadowTimer = setInterval(() => {
      if (resolved) return;
      if (inflightShadow.shouldFireStreamGap({
        lastLineAt,
        now: Date.now(),
        pendingSkillCallsSize: pendingSkillCalls.size,
        alreadyFired: streamGapFired,
      })) {
        streamGapFired = true;
        _emitShadowSignal('timeout_no_new_bytes_30s');
      }
    }, 5000);

    proc.on('exit', (code) => finish(code, 'exit'));
    proc.on('close', (code) => finish(code, 'close'));
    proc.stdout.on('end', () => { if (!resolved) finish(proc.exitCode, 'stdout-end'); });

    proc.on('error', (e) => {
      if (resolved) return;
      log('commander', `Error spawning Claude: ${e.message}`);
      finish(null, 'error');
    });
  });
}

function cmdLimpiar() {
  const { totalKilled, results } = limpiarDaemonsOnDemand();
  if (totalKilled === 0 && results.length === 0) {
    return '✅ No hay daemons Gradle/Kotlin para limpiar.';
  }
  const lines = results.map(r => `  • ${r}`).join('\n');
  return `🧹 *Limpieza de daemons*\n\n${lines}\n\n*Total eliminados:* ${totalKilled}`;
}

function cmdRestart(args) {
  const paused = /pausado|--paused/i.test(args || '');
  const mode = paused ? 'pausado' : 'completo';

  log('commander', `Restart ${mode} solicitado via Telegram`);

  // Registrar marker para que el nuevo pulpo al arrancar detecte el restart
  // solicitado desde Telegram y envíe la confirmación — el pulpo actual morirá
  // a mitad del restart.js (es descendiente y el taskkill /T lo alcanza), así
  // que el callback de exec() nunca retornaba. El mensaje de confirmación lo
  // emite el nuevo pulpo desde sí mismo al arrancar.
  try {
    fs.writeFileSync(path.join(PIPELINE, 'last-restart.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        mode, source: 'telegram', paused, notified: false,
      }));
  } catch {}

  // Lanzar restart.js como proceso COMPLETAMENTE desvinculado del árbol del
  // pulpo. En Windows, taskkill /T sigue la jerarquía de PPID — un spawn
  // normal queda como descendiente y muere cuando el pulpo se mata a sí mismo.
  // `start` reasigna el parent a conhost.exe, rompiendo la cadena PPID. Así
  // el restart.js sobrevive al kill del pulpo y completa launchAll.
  //
  // Iteración: el intento previo con `spawn('cmd.exe', ['/c', cadena])` falló
  // silenciosamente porque cmd.exe trata `""` (título vacío de `start`) como
  // fin prematuro del string cuando está dentro del `/c`. Ahora:
  //   - shell:true → Node arma `cmd.exe /d /s /c "..."` escapando bien.
  //   - Título "restart-bg" (no vacío) → evita el edge case de `""`.
  //   - stdio redirigido a archivo → si el spawn vuelve a fallar, hay
  //     evidencia en logs/restart-spawn.log en vez de silencio.
  const { spawn } = require('child_process');
  const fsMod = require('fs');
  const pausedArg = paused ? ' --paused' : '';
  const spawnLogPath = path.join(PIPELINE, 'logs', 'restart-spawn.log');
  try {
    fsMod.writeFileSync(spawnLogPath,
      `--- restart spawn ${new Date().toISOString()} mode=${mode} ---\n`);
    const logFd = fsMod.openSync(spawnLogPath, 'a');
    const child = spawn(`start "restart-bg" /MIN cmd.exe /c restart${pausedArg}`, [], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: true,
      windowsHide: true,
      env: { ...process.env, PATH: 'C:\\Workspaces\\bin;' + process.env.PATH },
    });
    child.unref();
    try { fsMod.closeSync(logFd); } catch {}
    log('commander', `restart spawneado (cmd.exe /d /s /c ... start restart-bg)`);
  } catch (e) {
    log('commander', `Error lanzando restart: ${e.message}`);
    return `❌ No pude lanzar el restart: ${e.message.slice(0, 200)}`;
  }

  return `🔄 Reinicio ${mode} del pipeline en progreso...\n_Te aviso cuando termine (~15-30s)._${paused ? '\n_Modo pausado: Telegram + dashboard activos, sin intake ni agentes._' : ''}`;
}

function cmdBloqueados() {
  let humanBlock;
  try { humanBlock = require('./lib/human-block'); }
  catch (e) { return `⚠️ No pude cargar el módulo de bloqueos: ${e.message}`; }

  const list = humanBlock.listBlockedIssues();
  if (!list.length) return '✅ No hay issues bloqueados esperando intervención humana.';

  const lines = [`🚧 *Issues bloqueados esperando humano* (${list.length})\n`];
  for (const b of list) {
    const ageStr = b.age_hours < 1
      ? `${Math.round(b.age_hours * 60)}min`
      : `${b.age_hours}h`;
    lines.push(`*#${b.issue}* — ${b.skill} en ${b.phase} _(hace ${ageStr})_`);
    if (b.question) lines.push(`  ❓ ${b.question}`);
    else if (b.reason) lines.push(`  📝 ${b.reason.slice(0, 140)}`);
    lines.push('');
  }
  lines.push('_Usá_ `/unblock <issue> <orientación>` _para desbloquear._');
  return lines.join('\n');
}

function cmdUnblock(args) {
  const trimmed = (args || '').trim();
  if (!trimmed) {
    return '❌ Uso: `/unblock <issue> <orientación>`\nEj: `/unblock 2480 usar la API REST en lugar de gRPC`';
  }

  const m = trimmed.match(/^#?(\d+)\s+(.+)$/s);
  if (!m) {
    return '❌ Formato inválido. Usá: `/unblock <número de issue> <orientación>`';
  }
  const issue = Number(m[1]);
  const guidance = m[2].trim();
  if (!guidance) return '❌ La orientación no puede estar vacía.';

  let humanBlock;
  try { humanBlock = require('./lib/human-block'); }
  catch (e) { return `⚠️ No pude cargar el módulo de bloqueos: ${e.message}`; }

  let result;
  try { result = humanBlock.unblockIssue({ issue, guidance, unlocker: 'commander:telegram' }); }
  catch (e) { return `❌ Error desbloqueando #${issue}: ${e.message}`; }

  if (!result.ok) return `⚠️ ${result.error}`;

  // Best-effort: quitar label needs:human del issue en GitHub
  try {
    const ghBin = process.env.GH_BIN || 'gh';
    require('child_process').execSync(
      `"${ghBin}" issue edit ${issue} --remove-label "needs:human" --repo intrale/platform`,
      { stdio: 'ignore', timeout: 15000 }
    );
  } catch {}

  // Best-effort: comentar en el issue con la orientación
  try {
    const ghBin = process.env.GH_BIN || 'gh';
    const body = `## ✅ Desbloqueado por humano\n\n**Skill:** \`${result.skill}\` · **Fase:** \`${result.from_phase}\` → \`${result.to_phase}\`\n\n**Orientación:**\n\n> ${guidance.replace(/\n/g, '\n> ')}\n\n_Vuelve a la cola del pipeline._`;
    const tmpFile = path.join(PIPELINE, `.unblock-comment-${issue}-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, body);
    require('child_process').execSync(
      `"${ghBin}" issue comment ${issue} --body-file "${tmpFile}" --repo intrale/platform`,
      { stdio: 'ignore', timeout: 15000 }
    );
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch {}

  return `✅ Issue *#${issue}* desbloqueado.\n*Skill:* \`${result.skill}\` · *Fase:* \`${result.from_phase}\` → \`${result.to_phase}\`\n*Orientación guardada* para que el próximo agente la lea al arrancar.`;
}

function cmdHelp() {
  return `🤖 *Comandos del Pipeline V2*

*Sin LLM (siempre disponibles, incluso con Claude caído):*
/status — Tablero completo del pipeline
/quota — Estado de cuota Claude (read-only, sin LLM)
/snapshot — Snapshot de la ola actual
/listado [filtro] — Listar issues del pipeline
/allowlist — Pausa parcial actual
/tail <archivo> — Últimas líneas de un log permitido
/dashboard-up — Levantar el dashboard
/dashboard-down — Bajar el dashboard
/salud — Salud del pulpo
/procesos — Procesos Node del pipeline
/descanso — Modo descanso (ventana)
/actividad [filtro] — Timeline (ej: /actividad 30m, /actividad #732)
/pausar — Pausar el Pulpo (completo)
/pause-partial 2490 2491 — Pausa parcial: solo esos issues siguen activos
/reanudar — Reanudar el Pulpo (levanta pausa completa o parcial)
/costos — Resumen de actividad/costos
/bloqueados — Listar issues bloqueados esperando intervención humana
/unblock <issue> <orientación> — Desbloquear un issue con orientación
/help — Esta ayuda

*Destructivos (cooldown 60s):*
/restart — Reiniciar pipeline completo
/restart pausado — Reiniciar en modo pausado (solo Telegram + dashboard)
/limpiar — Matar daemons Gradle/Kotlin huérfanos
/ghostbusters — Matar fantasmas (gradle zombies + worktrees abandonados + emus no sync)

*Con LLM (texto libre y comandos especiales):*
/intake [issue] — Meter trabajo al pipeline
/proponer — Proponer historias nuevas
/stop — Apagar el Commander

_Texto libre: si Claude está disponible, responde el LLM. Si no, respuesta canned + lista de comandos sin LLM._`;
}

/** Detectar si un mensaje es un comando y extraer nombre + argumentos */
function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Comando explícito /xxx (admite guiones para /pause-partial, /chat-gpt, etc.)
  const match = trimmed.match(/^\/([\w-]+)\s*(.*)?$/s);
  if (match) return { cmd: match[1].toLowerCase(), args: (match[2] || '').trim() };

  // Detección de intención por lenguaje natural (solo para mensajes cortos tipo comando)
  // Si el texto es largo (>80 chars), es conversación libre — delegar a Claude
  const lower = trimmed.toLowerCase();
  const isShortMessage = trimmed.length <= 80;

  if (isShortMessage) {
    // Patrones estrictos: solo matchean intenciones claras de comando, no menciones casuales
    const intentPatterns = [
      { pattern: /\b(status|estado del pipeline|tablero|que hay en el pipeline)\b/i, cmd: 'status' },
      { pattern: /\b(pausar|paus[áa] el|fren[áa] el|par[áa] el pulpo)\b/i, cmd: 'pausar' },
      { pattern: /\b(reanudar|reanud[áa] el|arranc[áa] el pulpo)\b/i, cmd: 'reanudar' },
      { pattern: /\b(mostrame la actividad|qué pas[óo] en el pipeline|timeline)\b/i, cmd: 'actividad' },
      { pattern: /\b(mostrame los costos|cuánto gastamos|reporte de costos)\b/i, cmd: 'costos' },
      { pattern: /\b(ayuda|help|comandos disponibles)\b/i, cmd: 'help' },
      { pattern: /\b(intake|met[eé] .* issue|tra[eé] .* issue|ingres[áa] issue)\b/i, cmd: 'intake' },
      { pattern: /\b(proponer historias|propon[eé] historias|historias nuevas)\b/i, cmd: 'proponer' },
      { pattern: /\b(stop|apag[áa] el commander|cerr[áa] el commander)\b/i, cmd: 'stop' },
      { pattern: /\b(limpi[áa]|limpiar daemons|matar gradle|matar daemons|kill gradle)\b/i, cmd: 'limpiar' },
      { pattern: /\b(bloqueados|qu[eé] est[áa] bloqueado|que necesita humano|necesitan intervenci[óo]n)\b/i, cmd: 'bloqueados' },
    ];

    for (const { pattern, cmd } of intentPatterns) {
      if (pattern.test(lower)) {
        const args = lower.replace(pattern, '').trim();
        log('commander', `Intención detectada: "${trimmed.slice(0, 50)}" → /${cmd}`);
        return { cmd, args };
      }
    }
  } else {
    log('commander', `Texto largo (${trimmed.length} chars) — delegando a Claude como texto libre`);
  }

  return null; // Texto libre — delegar a Claude
}

// #3257 — Singleton del dispatcher determinístico. Vive en module scope para
// que audit-log + rate-limit (token bucket) persistan entre invocaciones del
// brazo Commander. Lazy init para no leer FS hasta que llegue el primer mensaje.
let _commanderDispatcher = null;
function getCommanderDispatcher() {
  if (_commanderDispatcher) return _commanderDispatcher;

  // Issue #3541 — bloque `cua` del config.yaml. Si no existe, queda objeto
  // vacío y el dispatcher resuelve `enabled=false` por inercia (rollout OFF).
  // El operador activa el feature seteando `cua.enabled: true` en config.yaml
  // — sin este wiring, el flag se ignora aunque exista (gap reportado por PO).
  const _cfgRoot = (() => {
    try { return loadConfig() || {}; } catch (_) { return {}; }
  })();
  const _cuaCfg = (_cfgRoot && typeof _cfgRoot.cua === 'object' && _cfgRoot.cua) || {};

  _commanderDispatcher = commanderDet.createDispatcher({
    pipelineRoot: PIPELINE,
    logsDir: LOG_DIR,
    expectedChatId: getTelegramChatId(),
    rateLimit: { burst: 10, ratePerMin: 30 },
    // Issue #3253 — CA-4: cooldown destructivo de 60s para restart/limpiar/
    // ghostbusters/reset. Mitiga pulsado accidental en mobile + restart
    // encadenado por loops upstream. Layer adicional al rate-limit.
    destructiveCooldown: { cooldownMs: 60 * 1000 },
    // Issue #3541 — cua emitter wiring. `config` viaja completo al
    // createCuaEmitter (resuelve `enabled` + `kill_switch` + `notifiable_stages`
    // + `allowed_commands`). `telegramQueueDir` es donde el commander deposita
    // el .json + .ogg para que `servicio-telegram` los entregue.
    cua: {
      config: _cuaCfg,
      pipelineRoot: PIPELINE,
      telegramQueueDir: path.join(PIPELINE, 'servicios', 'telegram', 'pendiente'),
      log: (...args) => log('cua', ...args),
    },
    // Issue #3541 — CA-SEC-6: el handler de `/rechazar` necesita la allowlist
    // de operadores autorizados a rebobinar entregables CUA + la whitelist de
    // comandos. Sin esto, todo `/rechazar <cua>` cae fail-closed con
    // `unauthorized_rebobinar`/`invalid_cua_command` aunque el operador
    // legítimo esté wireado en `cua.operator_chat_ids`.
    rechazarDeps: {
      cuaOperatorChatIds: Array.isArray(_cuaCfg.operator_chat_ids)
        ? _cuaCfg.operator_chat_ids
        : [],
      allowedCuaCommands: Array.isArray(_cuaCfg.allowed_commands)
        ? _cuaCfg.allowed_commands
        : [],
    },
  });
  return _commanderDispatcher;
}

async function brazoCommander(config) {
  const commanderPendiente = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
  const commanderTrabajando = path.join(PIPELINE, 'servicios', 'commander', 'trabajando');
  const commanderListo = path.join(PIPELINE, 'servicios', 'commander', 'listo');

  let archivos = listWorkFiles(commanderPendiente);
  log('commander', `${archivos.length} mensaje(s) pendiente(s)`);
  if (archivos.length === 0) return;

  // Commander es singleton — verificar si ya hay uno corriendo
  const key = processKey('commander', 'telegram');
  if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
    log('commander', 'Ya hay un commander corriendo — skip');
    return;
  }
  activeProcesses.set(key, { pid: process.pid, startTime: Date.now() });

  try {
    await _brazoCommanderInner(config, archivos, commanderPendiente, commanderTrabajando, commanderListo, key);
  } finally {
    activeProcesses.delete(key);
  }
}

/**
 * Recoger mensajes nuevos de la cola pendiente y moverlos a trabajando.
 * @returns {Array} mensajes leídos y movidos
 */
function recogerMensajes(commanderPendiente, commanderTrabajando) {
  const archivos = listWorkFiles(commanderPendiente);
  const mensajes = [];
  for (const archivo of archivos) {
    try {
      const trabajandoPath = moveFile(archivo.path, commanderTrabajando);
      const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      mensajes.push({ ...data, _path: trabajandoPath });
      log('commander', `Tomado: ${archivo.name} → trabajando/`);
    } catch (e) {
      log('commander', `Error moviendo ${archivo.name}: ${e.message}`);
    }
  }
  return mensajes;
}

async function _brazoCommanderInner(config, archivosIniciales, commanderPendiente, commanderTrabajando, commanderListo, key) {
  // --- VENTANA DE CONSOLIDACIÓN (5s) ---
  // Esperar brevemente para capturar mensajes que llegan juntos
  // (ej: audio 1 + audio 2 enviados con segundos de diferencia)
  const CONSOLIDATION_MS = 5000;
  log('commander', `Ventana de consolidación (${CONSOLIDATION_MS}ms)...`);
  await new Promise(r => setTimeout(r, CONSOLIDATION_MS));

  // Tomar TODOS los mensajes (iniciales + los que llegaron en la ventana)
  const mensajes = recogerMensajes(commanderPendiente, commanderTrabajando);

  // También mover los iniciales si aún están en pendiente
  for (const archivo of archivosIniciales) {
    try {
      if (fs.existsSync(archivo.path)) {
        const trabajandoPath = moveFile(archivo.path, commanderTrabajando);
        const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
        mensajes.push({ ...data, _path: trabajandoPath });
        log('commander', `Tomado (inicial): ${archivo.name} → trabajando/`);
      }
    } catch (e) {}
  }

  if (mensajes.length === 0) return;
  log('commander', `Total mensajes consolidados: ${mensajes.length}`);

  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  const botToken = getTelegramToken();
  const chatId = getTelegramChatId();
  log('commander', `Token: ${botToken ? 'OK' : 'FALTA'}, ChatId: ${chatId || 'FALTA'}`);

  const { preprocessMessage, textToSpeechWithMeta, sendVoiceTelegram, loadTtsState, saveTtsState, getTransitionIntro, transcriptionFailureMessage, splitTextForTTSChunks } = require('./multimedia');
  const session = loadSession();

  // --- PREPROCESAR TODOS los mensajes (transcribir audios, etc.) ---
  for (const m of mensajes) {
    log('commander', `Preprocesando msg de ${m.from}: "${(m.text || '').slice(0, 50)}"`);
    const processed = await preprocessMessage(m, botToken);
    m._textoFinal = processed.text + (processed.extras.length > 0 ? ' ' + processed.extras.join(' ') : '');
    m._esAudio = !!(m.voice || m.voice_path);
    m._audio = processed.audio || null;
    m._audioFailed = !!(processed.audio && processed.audio.ok === false);
    log('commander', `Preprocesado: "${m._textoFinal.slice(0, 80)}"${m._audioFailed ? ' [audio fallido: ' + processed.audio.errorKind + ']' : ''}`);

    // Registrar entrada en historial (sanitizado por appendCommanderHistory).
    appendCommanderHistory(historyFile, { direction: 'in', from: m.from, text: m._textoFinal });
  }

  // --- CLASIFICAR cada mensaje con el router determinístico (#3257 CA-1) ---
  // El router decide deterministic / llm / unknown ANTES de invocar a Claude.
  // TODOS los mensajes pasan por `dispatcher.dispatch` — incluyendo los `llm` —
  // para que el audit-log (commander-audit-YYYY-MM-DD.jsonl, CA-10) registre
  // SIEMPRE una fila con `intent_class`. Sin esto, la métrica CA-4
  // "% determinístico vs LLM" del dashboard quedaba ~100% determinístico
  // permanentemente porque el productor del lado LLM nunca emitía filas.
  //
  // El dispatcher devuelve `{ reply, status }`:
  //   - status='ok' + reply!=null  → respuesta determinística lista
  //   - status='delegated_to_llm'  → audit ya hecho, caller debe llamar a Claude
  //   - status='no_handler'        → comando determinístico sin handler default
  //                                  → fallback al switch legacy de pulpo.js
  //   - status='rate_limited'/'invalid_args'/'unauthorized' → reply listo
  const dispatcher = getCommanderDispatcher();
  const comandos = [];
  const textoLibre = [];

  for (const m of mensajes) {
    const intent = commanderDet.classify(m._textoFinal);
    m._intent = intent;
    if (intent.class === 'deterministic' || intent.class === 'unknown') {
      comandos.push({ m, intent });
    } else {
      // class === 'llm' → emitimos audit-log explícitamente (camino que
      // antes saltaba dispatch entero). Usar `auditLog.record` para no
      // pagar el costo del rate-limit + reply nulo de dispatch (el llm
      // tiene su propio camino, ejecutarClaude, más abajo).
      try {
        dispatcher.auditLog.record({
          from: m.from,
          chat_id: m.chat_id || getTelegramChatId(),
          raw_command: intent.rawTruncated,
          intent_class: 'llm',
          handler: intent.command || null,
          args: intent.args,
          result_status: 'ok',
          duration_ms: 0,
        });
      } catch (e) {
        log('commander', `[audit-llm] error: ${e.message}`);
      }
      textoLibre.push(m);
    }
  }

  // --- PROCESAR COMANDOS DETERMINÍSTICOS (rápidos, uno a uno) ---
  for (const { m, intent } of comandos) {
    log('commander', `[${intent.class}] /${intent.command || '(none)'} args="${intent.args}"`);
    let respuesta = null;
    let result = null;

    // 1. Dispatch al router: maneja rate-limit, args inválidos, unknown,
    //    y los handlers NUEVOS del CA-2 (tail / salud / descanso). Para los
    //    comandos legacy devuelve { status: 'no_handler' } y caemos al switch.
    try {
      // Issue #3415 — pasar metadata adicional al dispatcher para que el
      // handler de `/rechazar` aplique CA-9/CA-13/CA-14 (whisper-local,
      // límites de audio, replay protection). Los handlers que no usan
      // estos campos los ignoran (shape backward-compatible).
      result = await dispatcher.dispatch({
        from: m.from,
        chat_id: m.chat_id || getTelegramChatId(),
        text: m._textoFinal,
        date: m.date,
        voice: m.voice,
        voice_path: m.voice_path,
        voice_file_size: m.voice_file_size,
        voice_duration: m.voice_duration,
        _esAudio: m._esAudio,
        _audio: m._audio,
        _textoFinal: m._textoFinal,
      });
      if (result && result.reply !== null) {
        respuesta = result.reply;
      }
    } catch (e) {
      log('commander', `[dispatcher] error: ${e.message}`);
    }

    // 2. Fallback al switch case legacy si el router no resolvió (handlers
    //    históricos siguen viviendo en pulpo.js: cmdStatus, cmdActividad, ...).
    if (respuesta === null && intent.class === 'deterministic' && intent.command) {
      const cmd = intent.command;
      const args = intent.args;

      // Issue #3253 — CA-4: cooldown destructivo para handlers legacy. El
      // dispatcher YA hace cooldown para handlers default, pero restart/
      // limpiar/ghostbusters viven en pulpo.js y necesitan pre-check explícito
      // antes de ejecutarse. Si está en cooldown, no entramos al switch.
      const chatIdForCooldown = m.chat_id || getTelegramChatId();
      const cdCheck = dispatcher.checkDestructiveCooldown(chatIdForCooldown, cmd);
      if (!cdCheck.allowed) {
        const { humanizeRetryAfter } = require('./lib/commander/destructive-cooldown');
        const { fillTemplate } = require('./lib/commander/fill-template');
        respuesta = fillTemplate('error-destructive-cooldown', {
          command: cmd,
          'retry-after-ms': cdCheck.retryAfterMs,
          'retry-after-human': humanizeRetryAfter(cdCheck.retryAfterMs),
          'cooldown-seconds': 60,
        });
        log('commander', `cooldown destructivo (legacy): /${cmd} bloqueado ${cdCheck.retryAfterMs}ms`);
      } else {
        switch (cmd) {
          case 'status': respuesta = await cmdStatus(config); break;
          case 'actividad': respuesta = cmdActividad(args); break;
          case 'ghostbusters': respuesta = cmdGhostbusters(); break;
          case 'intake': respuesta = cmdIntake(args, config); break;
          case 'pausar': case 'pause': respuesta = cmdPausar(); break;
          case 'reanudar': case 'resume': respuesta = cmdReanudar(); break;
          case 'pause-partial': case 'pause_partial': case 'pausarparcial':
            respuesta = cmdPausaParcial(args); break;
          case 'costos': respuesta = cmdCostos(); break;
          case 'help': case 'start': respuesta = cmdHelp(); break;
          case 'stop':
            respuesta = '🛑 Commander apagándose...';
            sendTelegram(respuesta);
            running = false;
            break;
          case 'proponer': respuesta = await cmdProponer(args, config); break;
          case 'limpiar': respuesta = cmdLimpiar(); break;
          case 'restart': respuesta = cmdRestart(args); break;
          case 'bloqueados': respuesta = cmdBloqueados(); break;
          case 'unblock': respuesta = cmdUnblock(args); break;
          // snapshot/listado/allowlist/dashboard-up/dashboard-down/screenshot/procesos
          // se resuelven en `dispatcher.dispatch` arriba (buildDefaultHandlers en
          // commander-deterministic.js). Si llegaran acá significa que el dispatcher
          // devolvió `no_handler` → caemos a `default` y eventualmente a texto libre,
          // garantizando que el usuario reciba ALGUNA respuesta.
          default: respuesta = null; break;
        }
        // Issue #3253 — CA-4: marcar success post-handler para que el cooldown
        // aplique en la próxima invocación. Solo si efectivamente respondió.
        if (respuesta !== null) {
          try { dispatcher.markDestructiveSuccess(chatIdForCooldown, cmd); } catch {}
        }
      }
    }

    if (respuesta !== null) {
      session.lastCommand = intent.command || 'unknown';
      session.lastTimestamp = new Date().toISOString();
      session.context = `Último comando: /${intent.command}. Respuesta: ${(respuesta || '').slice(0, 200)}`;
      sendTelegram(respuesta);
      appendCommanderHistory(historyFile, {
        direction: 'out',
        text: respuesta.slice(0, 1000),
        routing: { class: intent.class, handler: intent.command || null, status: result ? result.status : 'legacy' },
      });

      // #3262 CA-9 — TTS opt-in: si el handler devolvió audioText (ej. `/wave --audio`),
      // generar mp3 con multimedia.textToSpeechWithMeta y enviar como voice.
      // Fail-safe: si la cuota TTS o la red están caídas, NO afectamos el reply
      // principal (que ya se envió a Telegram justo arriba).
      const audioText = result && result.audioText;
      if (audioText && typeof audioText === 'string' && audioText.trim().length > 0) {
        try {
          if (botToken && chatId && typeof textToSpeechWithMeta === 'function' && typeof sendVoiceTelegram === 'function') {
            const ttsMeta = await textToSpeechWithMeta(audioText);
            if (ttsMeta && ttsMeta.buffer) {
              await sendVoiceTelegram(ttsMeta.buffer, botToken, chatId);
              log('commander', `[tts-opt-in] audio enviado para /${intent.command} (provider=${ttsMeta.provider})`);
            }
          }
        } catch (e) {
          log('commander', `[tts-opt-in] fallo generar/enviar audio: ${e.message} — reply principal ya entregado`);
        }
      }
    } else {
      // Comando no reconocido por ningún handler → cae a texto libre (LLM)
      textoLibre.push(m);
    }

    try { moveFile(m._path, commanderListo); } catch {}
    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] /${intent.command || '(unknown)'}\n${respuesta || '(sin respuesta)'}\n---\n`);
  }

  // --- FALLBACK: si TODOS los mensajes libres son audios fallidos (whisper
  // sin cuota, key inválida, timeout, etc.), no malgastamos una sesión de
  // Claude para procesar un error. Respondemos directo a Telegram con un
  // mensaje accionable y movemos los mensajes a listo. ---
  if (textoLibre.length > 0 && textoLibre.every(m => m._audioFailed && !(m._textoFinal || '').replace(/\(.*?\)/g, '').trim())) {
    const errorKinds = [...new Set(textoLibre.map(m => m._audio && m._audio.errorKind).filter(Boolean))];
    const dominant = errorKinds[0] || 'unknown';
    const fallback = (textoLibre[0]._audio && textoLibre[0]._audio.fallbackMessage) || transcriptionFailureMessage(dominant);
    log('commander', `Audio(s) sin transcribir [${errorKinds.join(',')}] — fallback directo a Telegram, sin invocar a Claude`);
    sendTelegram(fallback);
    appendCommanderHistory(historyFile, { direction: 'out', text: fallback, reason: `audio_fallback:${dominant}` });
    for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
    return;
  }

  // --- #2975 — GATE DE CUOTA ANTHROPIC AGOTADA (CA-9/CA-10/CA-11) ---
  // Si el flag está activo, los comandos nativos del switch case YA respondieron
  // arriba (sin pasar por LLM, garantizado por construcción — CA-3 hereditario).
  // Acá interceptamos texto libre ANTES de `ejecutarClaude` y respondemos canned
  // con debounce 2 min, sin interpolar input del usuario (CA-S7).
  if (textoLibre.length > 0 && quotaNotifier.getState().active) {
    const gate = quotaNotifier.handleCommanderFreeText();
    if (gate.gated) {
      log('commander', `Gate de cuota activo — ${gate.debounced ? 'debounced' : 'canned response enviada'}`);
      // Loguear input del usuario (REDACTADO) para auditoría sin echo en respuesta.
      try {
        const audit = textoLibre.map((m, i) => {
          const safe = redact(m._textoFinal || '');
          return `[Mensaje ${i + 1}${m._esAudio ? ' (audio)' : ''}]: ${safe}`;
        }).join('\n\n');
        appendCommanderHistory(historyFile, {
          direction: 'in_quota_blocked',
          text: audit,
          debounced: gate.debounced,
        });
      } catch {}
      // Mover mensajes a listo y abortar el flujo de Claude.
      for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
      saveSession(session);
      return;
    }
  }

  // --- PROCESAR TEXTO LIBRE CONSOLIDADO (una sola llamada a Claude) ---
  if (textoLibre.length > 0) {
    const esAudio = textoLibre.some(m => m._esAudio);

    // Consolidar mensajes en un solo texto para Claude
    let mensajeConsolidado;
    if (textoLibre.length === 1) {
      mensajeConsolidado = textoLibre[0]._textoFinal;
    } else {
      // Múltiples mensajes → contexto unificado
      mensajeConsolidado = textoLibre.map((m, i) =>
        `[Mensaje ${i + 1}${m._esAudio ? ' (audio)' : ''}]: ${m._textoFinal}`
      ).join('\n\n');
      log('commander', `Mensajes consolidados: ${textoLibre.length} → 1 prompt`);
    }

    // --- #3250 — SEC-2: validación de sender Telegram contra allowlist hardcoded.
    // Defensa en profundidad ante leak de bot token. Por default permite todo
    // (allowlist vacía); si está configurada via `TELEGRAM_ALLOWED_USER_IDS`,
    // descarta mensajes de IDs no autorizados.
    const senderAllowlist = commanderIssueCreation.getAllowedSenderIds();
    if (senderAllowlist.length > 0) {
      const firstFromId = textoLibre[0].from && textoLibre[0].from.id;
      const allowed = commanderIssueCreation.isSenderAllowed(firstFromId, senderAllowlist);
      if (!allowed) {
        log('commander', `🚫 SEC-2: sender Telegram id=${firstFromId} no autorizado — descartando ${textoLibre.length} msg(s)`);
        try {
          commanderIssueCreation.logSkillInvocation({
            pipelineDir: PIPELINE,
            from: textoLibre[0].from || null,
            inputText: mensajeConsolidado,
            skillResult: 'blocked',
            error: 'sender_not_allowed',
            senderAllowed: false,
          }, { log });
        } catch { /* best-effort */ }
        for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
        saveSession(session);
        return;
      }
    }

    // --- #3250 — Detección de intent de creación de issues (CA-1). El LLM
    // decide la invocación real del Skill; acá usamos la heurística para
    // gatear SEC-5 (provider activo ≠ anthropic) y enriquecer el audit log.
    //
    // #3418 SEC-B / CA-9: leemos el `prevContext` desde commander-history.jsonl
    // para habilitar CONTINUATION_PATTERNS. Sin contexto previo (ej: primer
    // mensaje del operador, o último intent matched fue hace >5min), los
    // continuativos NO matchean — backward-compat exacto con el comportamiento
    // pre-#3418.
    const prevContext = readPrevIssueCreationContext(historyFile);
    const issueIntent = commanderIssueCreation.detectIssueCreationIntent(mensajeConsolidado, prevContext);
    const wantsIssueCreation = issueIntent.intent !== commanderIssueCreation.INTENT_NONE;

    // #3418 CA-9: persistir el intent clasificado en el historial para que
    // el próximo turno tenga `prevContext`. Solo si la detección fue
    // positiva (no inflamos el JSONL para mensajes neutros).
    if (wantsIssueCreation) {
      appendCommanderHistory(historyFile, {
        direction: 'in_intent',
        intent: issueIntent.intent,
        matched: issueIntent.matched,
        continuation: !!issueIntent.continuation,
      });
    }

    // --- #3250 — SEC-5: bloqueo cuando el provider efectivo NO es Anthropic.
    // Los providers no-Anthropic (Cerebras/Gemini/NVIDIA/Codex) no tienen Skill
    // tool habilitado en el harness; intentar /doc o /planner allí caería en
    // un fallback silencioso de calidad degradada. Mejor responder canned y
    // pedir al usuario que reintente cuando Claude vuelva.
    if (wantsIssueCreation) {
      let activeProvider = 'anthropic';
      try {
        const probe = commanderMP.resolveCommanderProvider({
          pipelineDir: PIPELINE,
          log: (l, m) => log(l || 'commander', m),
        });
        if (probe && probe.provider) activeProvider = probe.provider;
      } catch (e) {
        log('commander', `SEC-5: no pude resolver provider activo (${e.message}) — asumiendo anthropic.`);
      }
      if (activeProvider !== 'anthropic') {
        const blocked = commanderIssueCreation.formatBlockedByProviderResponse({ provider: activeProvider });
        log('commander', `🚫 SEC-5: provider activo=${activeProvider} ≠ anthropic — bloqueando creación de issue`);
        sendTelegram(blocked);
        try {
          commanderIssueCreation.logSkillInvocation({
            pipelineDir: PIPELINE,
            from: textoLibre[0].from || null,
            inputText: mensajeConsolidado,
            skillInvoked: issueIntent.intent === commanderIssueCreation.INTENT_CREATE_SPLIT ? 'planner' : 'doc',
            skillResult: 'blocked',
            error: 'provider_not_anthropic',
            provider: activeProvider,
            intent: issueIntent.intent,
          }, { log });
        } catch { /* best-effort */ }
        appendCommanderHistory(historyFile, { direction: 'out', text: blocked, reason: `issue_creation_blocked:${activeProvider}` });
        for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
        saveSession(session);
        return;
      }
    }

    // --- #3250 — SEC-3: sanitización del input antes de pasarlo al Skill tool
    // (vía Claude). Trunca a 4000 chars y strip de caracteres de control/ANSI.
    // Sólo aplica cuando hay intent de creación de issue — para texto libre
    // genérico mantenemos el comportamiento previo (ya pasa por
    // `commanderMP.sanitizeUserPrompt` dentro de `ejecutarClaude`).
    let inputSanitized = mensajeConsolidado;
    let inputWasTruncated = false;
    if (wantsIssueCreation) {
      const san = commanderIssueCreation.sanitizeIssueCreationInput(mensajeConsolidado);
      inputSanitized = san.sanitized;
      inputWasTruncated = san.truncated;
      if (san.truncated || san.strippedControls > 0) {
        log('commander', `🛡️ SEC-3: input sanitizado (truncated=${san.truncated}, stripped=${san.strippedControls}) para issue-creation`);
      }
      mensajeConsolidado = inputSanitized;
    }

    // Protección anti-restart encadenado: si el mensaje pide restart y ya hubo
    // uno reciente (< 2 min), responder directamente sin delegar a Claude
    const restartPattern = /\b(reinici|restart|levant[aá]|arranc[aá])\b/i;
    if (restartPattern.test(mensajeConsolidado)) {
      try {
        const lastRestart = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'last-restart.json'), 'utf8'));
        const ageSec = (Date.now() - new Date(lastRestart.timestamp).getTime()) / 1000;
        if (ageSec < 120) {
          log('commander', `Restart solicitado pero ya hubo uno hace ${Math.round(ageSec)}s — skip`);
          sendTelegram(`✅ Ya reinicié hace ${Math.round(ageSec)}s, todo debería estar andando. Usá /status para verificar.`);
          for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
          return;
        }
      } catch {}
    }

    // ACK contextual
    sendTelegram(generarAck(mensajeConsolidado, esAudio));

    // #3250 — declarado fuera del try para que el catch pueda calcular
    // durationMs en caso de error (timeout/quota/etc.).
    let skillInvocationStartedAt = Date.now();

    try {
      // Construir prompt
      let historial = '';
      try {
        const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n')
          .filter(l => { try { return JSON.parse(l).timestamp >= cutoff24h; } catch { return false; } })
          .slice(-50);
        historial = '\nHistorial reciente (24hs):\n' + lines.join('\n');
      } catch {}

      let sessionCtx = '';
      if (session.context && session.lastTimestamp) {
        const ageMin = (Date.now() - new Date(session.lastTimestamp).getTime()) / 60000;
        if (ageMin < 30) {
          sessionCtx = `\n\nContexto de sesión: ${session.context}`;
        }
      }

      const from = textoLibre[0].from || 'Leo';
      // #3250 — Bloque de routing a /doc y /planner (CA-1, CA-2, CA-3, CA-4,
      // CA-5 + SEC-1). Se inyecta SIEMPRE: la heurística pre-LLM puede no
      // detectar el intent pero el LLM sí, y la regla es genérica suficiente
      // para que no dispare invocaciones espurias cuando el usuario no pide
      // crear nada.
      const issueCreationBlock = commanderIssueCreation.buildIssueCreationPromptBlock();
      const userPrompt = `Sos el Commander del pipeline V2 de Intrale. Respondés por Telegram.

REGLAS:
1. Si el usuario pide una ACCIÓN (revisar, arreglar, validar, verificar, levantar, etc): EJECUTALA primero con las herramientas que tengas, y después reportá qué hiciste y el resultado.
2. Si el usuario hace una PREGUNTA: respondé directamente.
3. Tu respuesta final (el texto que se envía a Telegram) debe ser SOLO el reporte al usuario. Conciso, en español argentino.
4. NO menciones paths internos del pipeline (pendiente/, listo/, etc).
5. Contexto del entorno:
   - Pipeline dir: ${PIPELINE}
   - Dashboard: node .pipeline/dashboard.js (puerto 3200)
   - PIDs: .pipeline/*.pid
   - Logs: .pipeline/logs/
   - Procesos: tasklist | grep node
${issueCreationBlock}
Mensaje de ${from}: ${mensajeConsolidado}${sessionCtx}${historial}`;

      // #3250 — SEC-4: audit log. Pre-LLM marcamos el start time; post-LLM
      // escribimos una línea por intento de creación de issue con el resultado
      // (skill invocado, issue creado, duración, error). Sólo si la heurística
      // detectó intent — para texto libre genérico no inflamos el log.
      //
      // #3587 CA-1 — pasamos `trace = {}` para que ejecutarClaude registre
      // tool_use_sequence + tool_results_summary + subprocess metadata. Solo
      // lo aprovechamos para audit log + clasificación cuando
      // `wantsIssueCreation` (no inflamos audit para texto libre genérico).
      const claudeTrace = wantsIssueCreation ? {} : undefined;
      skillInvocationStartedAt = Date.now();
      let respuesta = await ejecutarClaude(userPrompt, mensajeConsolidado, claudeTrace);
      log('commander', `Claude respondió: ${(respuesta || '').length} chars`);

      if (wantsIssueCreation) {
        try {
          // #3418 CA-3: detectar marcador de SKILL_TIMEOUT emitido por
          // ejecutarClaude cuando el watchdog mató el proceso. Si está
          // presente, mapear a SKILL_RESULT_TIMEOUT + telemetría con
          // timeout_ms, y enviar mensaje específico a Telegram. Si no,
          // seguimos el flow normal de inspección de outcome.
          const timeoutMatch = /\[SKILL_TIMEOUT:(\w+):(\d+)ms\]/.exec(respuesta || '');
          const expectedSkill = issueIntent.intent === commanderIssueCreation.INTENT_CREATE_SPLIT ? 'planner' : 'doc';
          if (timeoutMatch) {
            const timedOutSkill = timeoutMatch[1];
            const timeoutDuration = Number(timeoutMatch[2]);
            commanderIssueCreation.logSkillInvocation({
              pipelineDir: PIPELINE,
              from: textoLibre[0].from || null,
              inputText: mensajeConsolidado,
              inputTextTruncated: inputWasTruncated,
              skillInvoked: timedOutSkill || expectedSkill,
              skillResult: commanderIssueCreation.SKILL_RESULT_TIMEOUT,
              durationMs: Date.now() - skillInvocationStartedAt,
              timeoutMs: timeoutDuration,
              provider: 'anthropic',
              intent: issueIntent.intent,
              error: 'skill_watchdog_timeout_60s',
              senderAllowed: true,
              // #3587 CA-1 — instrumentación (trace ya cerrado por finish()).
              toolUseSequence: claudeTrace && claudeTrace.toolUseSequence,
              toolResultsSummary: claudeTrace && claudeTrace.toolResultsSummary,
              subprocess: claudeTrace && claudeTrace.subprocess,
            }, { log });
            try {
              const msg = commanderIssueCreation.formatSkillFailureResponse({ kind: 'timeout', durationMs: timeoutDuration });
              sendTelegram(msg);
            } catch { /* best-effort */ }
            // Reemplazamos `respuesta` por el mensaje al operador (sin
            // marcador) para que no termine viajando como texto literal.
            respuesta = commanderIssueCreation.formatSkillFailureResponse({ kind: 'timeout', durationMs: timeoutDuration });
          } else {
            // #3587 CA-2/CA-3 — fix de causa raíz. Antes pasábamos
            // toolUseEmitted=false hardcoded porque no teníamos los eventos
            // estructurados acá. Con `claudeTrace` populado por ejecutarClaude,
            // `inferSkillResult` puede distinguir entre:
            //   - El LLM eligió Bash gh issue create (skill_not_invoked, con
            //     `tool_used_instead='Bash'`)
            //   - El Skill se invocó y falló (skill_failed)
            //   - El Skill creó issue OK (success)
            const outcome = commanderIssueCreation.inspectResponseForOutcome(respuesta || '');
            const skillResult = commanderIssueCreation.inferSkillResult({
              outcome,
              toolUseSequence: claudeTrace && claudeTrace.toolUseSequence,
              toolResultsSummary: claudeTrace && claudeTrace.toolResultsSummary,
              timedOut: false,
            });
            const toolUsedInstead = commanderIssueCreation.inferToolUsedInstead(
              claudeTrace && claudeTrace.toolUseSequence
            );
            // #3587 CA-3 — error string específico por categoría. NO usar
            // el string opaco antiguo (removido); usar etiquetas accionables.
            let auditError;
            if (skillResult === commanderIssueCreation.SKILL_RESULT_SKILL_NOT_INVOKED) {
              auditError = toolUsedInstead
                ? `skill_not_invoked:llm_used_${toolUsedInstead}_instead`
                : 'skill_not_invoked:llm_emitted_no_tool';
            } else if (skillResult === commanderIssueCreation.SKILL_RESULT_SKILL_FAILED) {
              auditError = 'skill_failed:invoked_but_no_issue_created';
            } else if (skillResult === commanderIssueCreation.SKILL_RESULT_LAUNCHING_NO_COMPLETE) {
              auditError = 'launching_marker_without_tool_use';
            }
            commanderIssueCreation.logSkillInvocation({
              pipelineDir: PIPELINE,
              from: textoLibre[0].from || null,
              inputText: mensajeConsolidado,
              inputTextTruncated: inputWasTruncated,
              skillInvoked: outcome.skillsMentioned[0] || expectedSkill,
              skillResult,
              issueCreated: outcome.issuesCreated.length === 1 ? outcome.issuesCreated[0] : (outcome.issuesCreated.length > 1 ? outcome.issuesCreated : undefined),
              durationMs: Date.now() - skillInvocationStartedAt,
              provider: 'anthropic',
              intent: issueIntent.intent,
              error: auditError,
              senderAllowed: true,
              // #3587 CA-1 — instrumentación completa al audit log.
              toolUseSequence: claudeTrace && claudeTrace.toolUseSequence,
              toolResultsSummary: claudeTrace && claudeTrace.toolResultsSummary,
              subprocess: claudeTrace && claudeTrace.subprocess,
              toolUsedInstead,
            }, { log });
            // #3587 CA-4 — reporte preciso a Telegram con UX guidelines
            // (símbolos + tono natural + mención de tool usado).
            if (skillResult === commanderIssueCreation.SKILL_RESULT_LAUNCHING_NO_COMPLETE) {
              log('commander', `🚨 CA-3: Commander anunció Skill pero no lo invocó (launching_no_complete) — enviando mensaje específico a Telegram`);
              try { sendTelegram(commanderIssueCreation.formatSkillFailureResponse({ kind: 'launching_no_complete' })); } catch { /* best-effort */ }
            } else if (skillResult === commanderIssueCreation.SKILL_RESULT_SKILL_NOT_INVOKED) {
              log('commander', `⚠️ CA-2/CA-4: LLM no invocó Skill — tool_used_instead=${toolUsedInstead || 'none'} — enviando mensaje específico a Telegram`);
              try {
                sendTelegram(commanderIssueCreation.formatSkillFailureResponse({
                  kind: 'skill_not_invoked',
                  toolUsedInstead,
                }));
              } catch { /* best-effort */ }
            } else if (skillResult === commanderIssueCreation.SKILL_RESULT_SKILL_FAILED) {
              log('commander', `⚠️ CA-4: Skill se invocó pero no creó issue — enviando mensaje específico a Telegram`);
              try { sendTelegram(commanderIssueCreation.formatSkillFailureResponse({ kind: 'skill_failed' })); } catch { /* best-effort */ }
            }

            // #3625 CA-3 — Auto-promoción de hijos a allowlist cuando hubo split exitoso.
            // El padre se infiere del mensaje original: si menciona exactamente un #N,
            // ese es el padre del split. Multi-#N → no inferimos (operador debe promover
            // manualmente — más seguro que adivinar).
            if (
              skillResult === commanderIssueCreation.SKILL_RESULT_SUCCESS &&
              issueIntent.intent === commanderIssueCreation.INTENT_CREATE_SPLIT &&
              Array.isArray(outcome.issuesCreated) &&
              outcome.issuesCreated.length > 0
            ) {
              try {
                const parentMatches = mensajeConsolidado.match(/#(\d{2,6})/g) || [];
                const parentCandidates = [...new Set(parentMatches.map(m => Number(m.slice(1))))]
                  .filter(n => !outcome.issuesCreated.includes(n));
                if (parentCandidates.length === 1) {
                  const parentIssue = parentCandidates[0];
                  const recursivePromote = require('./lib/allowlist-recursive-promote');
                  const promoteResult = recursivePromote.autoPromoteSplitChildren({
                    parentIssue,
                    childrenIssues: outcome.issuesCreated,
                  });
                  if (promoteResult.promoted && Array.isArray(promoteResult.added) && promoteResult.added.length > 0) {
                    log('commander', `🧩 Auto-promote: hijos de #${parentIssue} agregados a allowlist (TTL 48h): ${promoteResult.added.join(',')}`);
                    try {
                      sendTelegram(
                        `🧩 Auto-promoted a allowlist (TTL 48h, herencia de #${parentIssue}):\n` +
                        promoteResult.added.map(n => `• #${n}`).join('\n')
                      );
                    } catch { /* best-effort */ }
                  } else if (promoteResult.gateRejected) {
                    log('commander', `⚠️ Auto-promote bloqueado por gate. Promover manualmente.`);
                  }
                } else if (parentCandidates.length > 1) {
                  log('commander', `🧩 Auto-promote: padre ambiguo (${parentCandidates.length} #N en el mensaje), skip — operador debe promover manualmente`);
                }
              } catch (autoPromoteErr) {
                log('commander', `Auto-promote falló (best-effort, no bloquea): ${autoPromoteErr.message}`);
              }
            }
          }
        } catch (auditErr) {
          log('commander', `audit log de issue-creation falló (best-effort): ${auditErr.message}`);
        }
      }

      // --- CHECK DE SUPLEMENTOS ---
      // Mensajes que llegaron MIENTRAS Claude procesaba (ej: segundo audio complementario)
      const suplementosRaw = recogerMensajes(commanderPendiente, commanderTrabajando);
      if (suplementosRaw.length > 0) {
        log('commander', `${suplementosRaw.length} suplemento(s) llegaron durante procesamiento — integrando`);

        // Preprocesar suplementos
        const suplementosTexto = [];
        for (const s of suplementosRaw) {
          const proc = await preprocessMessage(s, botToken);
          const txt = proc.text + (proc.extras.length > 0 ? ' ' + proc.extras.join(' ') : '');
          suplementosTexto.push(txt);
          s._textoFinal = txt;
          s._esAudio = !!(s.voice || s.voice_path);
          appendCommanderHistory(historyFile, { direction: 'in', from: s.from, text: txt });
        }

        sendTelegram('💬 Vi tu mensaje adicional, lo integro a la respuesta...');

        // Re-llamar a Claude con contexto completo + suplementos
        const supplementPrompt = `${userPrompt}

RESPUESTA ANTERIOR (borrador, NO enviada al usuario todavía):
${respuesta}

Mientras generabas esa respuesta, el usuario envió mensaje(s) complementario(s):
${suplementosTexto.map((t, i) => `[Complemento ${i + 1}]: ${t}`).join('\n')}

INSTRUCCIÓN: Integrá los complementos del usuario en tu respuesta. Generá UNA respuesta final unificada que contemple tanto el pedido original como los complementos. No menciones que hubo múltiples mensajes ni que reprocessaste.`;

        respuesta = await ejecutarClaude(supplementPrompt, 'complemento integrado');
        log('commander', `Claude (suplemento) respondió: ${(respuesta || '').length} chars`);

        // Mover suplementos a listo
        for (const s of suplementosRaw) {
          try { moveFile(s._path, commanderListo); } catch {}
        }
      }

      // --- SHERLOCK VERIFIER (#3343, modificado por #3484) ---
      // Verificación adversarial pre-`sendTelegram`. Corre con el provider de
      // mejor calidad disponible (chain `telegram-sherlock`, Anthropic Haiku
      // primero) y refuta el análisis con evidencia del estado actual. Si
      // encuentra inconsistencias, dispara 1 reelaboración (cap hardcoded).
      // Si timeout/error/sin-provider, agrega disclaimer F-6. Bypass total si
      // `sherlock_enabled=false`.
      //
      // #3484: Sherlock ya NO se restringe a un provider distinto al del
      // Commander — la decisión arquitectónica documentada en
      // docs/pipeline/multi-provider.md acepta el riesgo de adversariality
      // reducida a cambio de tener Sherlock funcionando consistentemente.
      // El audit log registra `same_provider`/`same_model` para monitoreo.
      //
      // CA-UX-1 (#3484): mientras Sherlock corre, refrescamos el indicador
      // "escribiendo..." de Telegram cada 4s. Sin este loop, el usuario ve
      // el indicador fadear a los ~5s y siente que el bot se colgó (peor UX
      // que el problema que estamos resolviendo).
      //
      // CA-UX-2 (#3484): un soft-timeout de 120s envuelve TODO el bloque
      // (Sherlock + posible reelaboración + 2da Sherlock). Si dispara antes
      // de tener verdict, mandamos un mensaje honesto al usuario en lugar
      // de bloquear el chat indefinidamente.
      //
      // turnId se genera acá (no dentro del verifier) para que los turnos
      // bypaseados también queden correlacionables vía `commander_response`.
      const turnId = crypto.randomBytes(8).toString('hex');
      let sherlockInvoked = false;
      let sherlockDisclaimerType = null;
      let sherlockSoftTimedOut = false;

      // CA-UX-1: typing refresh loop. Se arranca antes y se limpia en finally.
      let typingTimer = null;
      const startTypingLoop = () => {
        try { sendChatActionTyping(); } catch {}
        typingTimer = setInterval(() => {
          try { sendChatActionTyping(); } catch {}
        }, 4000);
      };
      const stopTypingLoop = () => {
        if (typingTimer) { try { clearInterval(typingTimer); } catch {} typingTimer = null; }
      };

      // CA-UX-2: soft-timeout 120s. Promise.race contra el bloque completo de
      // verificación. Si gana el timeout, marcamos sherlockSoftTimedOut y
      // forzamos disclaimer F-6 + mensaje específico al usuario.
      const SHERLOCK_SOFT_TIMEOUT_MS = 120_000;

      const sherlockBlock = (async () => {
        // Snapshot mínimo del estado del sistema. No incluimos paths sensibles
        // — sólo contadores que el Commander pudo haber observado para que
        // Sherlock cruce el claim "hay N issues pendientes" vs realidad.
        let pendingCount = 0;
        let trabajandoCount = 0;
        try {
          pendingCount = fs.readdirSync(commanderPendiente).length;
        } catch {}
        try {
          trabajandoCount = fs.readdirSync(commanderTrabajando).length;
        } catch {}
        const systemStateSnapshot =
          `commander_pendiente_files=${pendingCount}\n` +
          `commander_trabajando_files=${trabajandoCount}\n` +
          `timestamp_iso=${new Date().toISOString()}\n` +
          `pipeline_dir=${PIPELINE}`;

        // El provider del Commander hoy es siempre `anthropic` (ejecutarClaude
        // hace spawn de claude CLI). Cuando #3258 introduzca cross-provider
        // fallback al Commander, este valor vendrá del dispatcher.
        //
        // #3766 — `commanderModel` ya NO se calcula ni se pasa: la contradicción
        // adversarial de Sherlock nace del rol (prompt fiscal), no de la
        // diferencia de modelo/provider. El verifier sigue aceptando el
        // parámetro en su signature por back-compat (ignorado).
        const commanderProvider = 'anthropic';

        const verdict = await sherlockVerifier.verify({
          analysis: respuesta || '',
          originalRequest: mensajeConsolidado,
          systemState: systemStateSnapshot,
          lastHourLogs: '', // por ahora vacío — extracción de logs queda para iteración futura
          commanderProvider,
          pipelineDir: PIPELINE,
          configLoader: loadConfig,
          log,
          cwd: ROOT,
        });
        sherlockInvoked = verdict.verdict !== 'skipped';

        if (verdict.verdict === 'rechazado' && verdict.inconsistencies.length >= 1) {
          // CA-F-3 — reelaborar UNA vez (cap hardcoded en verifier).
          log('commander', `🔍 Sherlock rechazó respuesta (provider=${verdict.sherlockProvider}, transport=${verdict.transport}, same_provider=${verdict.sameProvider}, inconsistencies=${verdict.inconsistencies.length}). Reelaborando...`);
          const inconsistenciesBlock = verdict.inconsistencies
            .map((it, i) => `${i + 1}. CLAIM: ${it.claim}\n   CONTRADICCIÓN: ${it.contradiction}`)
            .join('\n\n');
          const reelaboratePrompt = `${userPrompt}

RESPUESTA ANTERIOR (borrador, NO enviada al usuario todavía):
${respuesta}

El verificador Sherlock encontró ${verdict.inconsistencies.length} inconsistencia(s) entre tu análisis y el estado real del sistema:

${inconsistenciesBlock}

INSTRUCCIÓN: Reelaborá tu respuesta tomando en cuenta las contradicciones detectadas. NO menciones que hubo verificación previa ni que reelaboraste — entregá una respuesta final natural.`;
          try {
            const reelaborada = await ejecutarClaude(reelaboratePrompt, 'reelaboración Sherlock');
            if (typeof reelaborada === 'string' && reelaborada.trim()) {
              respuesta = reelaborada;
              // 2da pasada de verificación con el mismo commanderProvider.
              const verdict2 = await sherlockVerifier.verify({
                analysis: respuesta || '',
                originalRequest: mensajeConsolidado,
                systemState: systemStateSnapshot,
                lastHourLogs: '',
                commanderProvider,
                pipelineDir: PIPELINE,
                configLoader: loadConfig,
                log,
                cwd: ROOT,
              });
              if (verdict2.verdict === 'rechazado' && verdict2.inconsistencies.length >= 1) {
                // CA-F-5 — disclaimer "rechazado persistente".
                sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.PERSISTENT_INCONSISTENCY;
                log('commander', `🔍 Sherlock rechazó la reelaboración también — disclaimer F-5 aplicado`);
              } else if (verdict2.verdict === 'aborted') {
                sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER;
                log('commander', `🔍 Sherlock aborted en 2da pasada (${verdict2.errorCode}) — disclaimer F-6 aplicado`);
              }
            }
          } catch (re) {
            log('commander', `⚠️ Reelaboración Sherlock falló: ${re.message}. Manteniendo respuesta original.`);
            sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER;
          }
        } else if (verdict.verdict === 'aborted') {
          // CA-F-6 — timeout/schema-fail/sin-provider.
          sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER;
          log('commander', `🔍 Sherlock aborted (${verdict.errorCode}: ${verdict.reason}) — disclaimer F-6 aplicado`);
        } else if (verdict.verdict === 'ok') {
          // CA-F-7 — silencio total cuando todo concuerda.
          log('commander', `🔍 Sherlock OK (provider=${verdict.sherlockProvider}, transport=${verdict.transport}, same_provider=${verdict.sameProvider}, ${verdict.durationMs}ms)`);
        }
      })();

      try {
        startTypingLoop();
        await Promise.race([
          sherlockBlock,
          new Promise((resolve) => setTimeout(() => {
            sherlockSoftTimedOut = true;
            resolve();
          }, SHERLOCK_SOFT_TIMEOUT_MS)),
        ]);
      } catch (sherlockErr) {
        // Defensa: un fallo de Sherlock NUNCA debe tirar el turno. Degradamos
        // a respuesta original con disclaimer F-6 y seguimos.
        log('commander', `⚠️ Sherlock excepción no manejada: ${sherlockErr.message} — degradando a F-6`);
        sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER;
      } finally {
        stopTypingLoop();
      }

      if (sherlockSoftTimedOut) {
        // CA-UX-2 — soft-timeout del turn handler. Avisamos al usuario sin
        // jerga técnica y degradamos a F-6. La respuesta original (sin
        // reelaboración garantizada) se envía igual debajo. El audit
        // post-turn registra el outcome para telemetría.
        log('commander', `⏱️ Sherlock soft-timeout ${SHERLOCK_SOFT_TIMEOUT_MS}ms disparó — liberando chat con mensaje UX-2`);
        try {
          sendTelegramPlain(
            'Esta respuesta me está tomando más tiempo de lo normal. ' +
            'Te muestro la versión sin verificar — si querés, podemos ' +
            'revisarla juntos cuando me confirmes.'
          );
        } catch { /* best-effort */ }
        sherlockDisclaimerType = sherlockVerifier.DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER;
      }

      if (sherlockDisclaimerType && respuesta) {
        respuesta = sherlockVerifier.applyDisclaimer(respuesta, sherlockDisclaimerType);
      }

      // Audit de correlación turn-level (CA-A-3).
      try {
        commanderMP.auditCommanderRequest({
          pipelineDir: PIPELINE,
          event: 'commander_response',
          providerEffective: 'anthropic',
          chatId,
          prompt: '', // no prompt crudo
          errorCode: sherlockDisclaimerType,
          requestId: turnId,
        });
      } catch { /* best-effort */ }

      // Actualizar sesión
      session.lastCommand = 'chat';
      session.lastTimestamp = new Date().toISOString();
      session.context = `Conversación libre. Último mensaje: "${mensajeConsolidado.slice(0, 100)}". Respuesta: "${(respuesta || '').slice(0, 100)}"`;

      // --- ENVIAR RESPUESTA ---
      if (respuesta) {
        let enviado = false;

        // Si hubo audio → intentar TTS
        if (esAudio) {
          try {
            // Cap a 1500 chars para evitar truncado interno de Edge TTS en español (#3485).
            const chatChunks = splitTextForTTSChunks(respuesta, 1500);
            log('commander', `[chat] TTS chunks generados: total_parts=${chatChunks.length} (texto=${respuesta.length} chars, cap=1500)`);
            let prevProvider = loadTtsState().lastProvider;
            for (let i = 0; i < chatChunks.length; i++) {
              const baseChunk = chatChunks.length > 1
                ? `Parte ${i + 1} de ${chatChunks.length}. ${chatChunks[i]}`
                : chatChunks[i];
              const ttsOpts = { chunkInfo: { index: i, total: chatChunks.length } };
              // Primero probamos a ver qué provider gana para este chunk
              const meta = await textToSpeechWithMeta(baseChunk, ttsOpts);
              if (!meta || !meta.buffer) continue;

              const intro = i === 0 ? getTransitionIntro(meta.provider, prevProvider) : null;
              let finalBuffer = meta.buffer;
              let finalProvider = meta.provider;
              if (intro) {
                const reMeta = await textToSpeechWithMeta(`${intro} ${baseChunk}`, ttsOpts);
                if (reMeta && reMeta.buffer) {
                  finalBuffer = reMeta.buffer;
                  finalProvider = reMeta.provider;
                }
              }

              const audioPath = path.join(LOG_DIR, 'media', `tts-${Date.now()}-${i}.ogg`);
              fs.writeFileSync(audioPath, finalBuffer);
              enviado = await sendVoiceTelegram(finalBuffer, botToken, chatId);
              if (enviado) log('telegram', `Audio TTS parte ${i + 1}/${chatChunks.length} enviado (${finalBuffer.length} bytes, provider=${finalProvider}${intro ? ', con intro' : ''})`);
              saveTtsState({ lastProvider: finalProvider });
              prevProvider = finalProvider;
            }
          } catch (e) {
            log('commander', `TTS error: ${e.message}`);
          }
        }

        sendTelegram(respuesta);
        log('telegram', `Texto encolado como ${enviado ? 'backup' : 'principal'} (${respuesta.length} chars)`);
        appendCommanderHistory(historyFile, { direction: 'out', text: respuesta.slice(0, 1000) });
      }
    } catch (e) {
      log('commander', `Error Claude: ${e.message}`);
      // #3250 — Si el flow venía de un intent de creación de issue (CA-5),
      // usamos copy variado por causa para no dar el genérico "Error procesando".
      // SIEMPRE registramos en el audit log el fallo para forense (SEC-4).
      if (wantsIssueCreation) {
        const kind = /timeout|HARD_TIMEOUT|killed/i.test(e.message) ? 'timeout'
          : /quota|rate.?limit|usage_limit/i.test(e.message) ? 'quota'
          : /gh\s|github|gh:\s/i.test(e.message) ? 'gh_error'
          : 'generic';
        try { sendTelegram(commanderIssueCreation.formatSkillFailureResponse({ kind, error: e.message })); } catch {}
        try {
          commanderIssueCreation.logSkillInvocation({
            pipelineDir: PIPELINE,
            from: textoLibre[0].from || null,
            inputText: mensajeConsolidado,
            inputTextTruncated: inputWasTruncated,
            skillInvoked: issueIntent.intent === commanderIssueCreation.INTENT_CREATE_SPLIT ? 'planner' : 'doc',
            skillResult: 'error',
            error: `${kind}:${(e.message || '').slice(0, 200)}`,
            durationMs: Date.now() - skillInvocationStartedAt,
            provider: 'anthropic',
            intent: issueIntent.intent,
          }, { log });
        } catch { /* best-effort */ }
      } else {
        sendTelegram('⚠️ Error procesando tu mensaje. Intentá de nuevo.');
      }
    }

    // Mover todos los mensajes texto-libre a listo
    for (const m of textoLibre) {
      try { moveFile(m._path, commanderListo); } catch {}
    }

    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] TEXT (${textoLibre.length} msgs consolidados)\n---\n`);
  }

  // Persistir sesión
  saveSession(session);
}

function sendTelegram(text) {
  return sendTelegramWithMarkup(text, null);
}

// #2975 — Variante texto plano (CA-13): omite `parse_mode: 'Markdown'` para
// que la respuesta canned de cuota agotada NO interprete caracteres
// potencialmente injectados. Defensa en profundidad — el canned es texto fijo
// y NO interpola input usuario, pero si por bug futuro entrara, no se renderiza.
function sendTelegramPlain(text) {
  return sendTelegramWithMarkup(text, null, { plain: true });
}

// #2893 — Variante que pasa reply_markup (inline_keyboard con url buttons).
// El servicio-telegram hace passthrough del campo reply_markup al API.
// #2975 — Tercer arg `opts.plain=true` desactiva `parse_mode: 'Markdown'`.
function sendTelegramWithMarkup(text, replyMarkup, opts) {
  const token = getTelegramToken();
  const chatId = getTelegramChatId();
  if (!token || !chatId) { log('telegram', 'Sin token/chatId'); return; }

  const msg = text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  const plain = !!(opts && opts.plain);

  // Encolar en el servicio de telegram (fire-and-forget via filesystem)
  const svcDir = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');
  const filename = `${Date.now()}-cmd.json`;
  try {
    const payload = plain ? { text: msg } : { text: msg, parse_mode: 'Markdown' };
    if (replyMarkup && typeof replyMarkup === 'object') payload.reply_markup = replyMarkup;
    fs.writeFileSync(path.join(svcDir, filename), JSON.stringify(payload));
    log('telegram', `Encolado (${msg.length} chars${replyMarkup ? ', con reply_markup' : ''}) → ${filename}`);
  } catch (e) {
    // Fallback: envío directo con https (sin subproceso)
    const https = require('https');
    const data = JSON.stringify({ chat_id: chatId, text: msg });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (err) => log('telegram', `Error directo: ${err.message}`));
    req.write(data);
    req.end();
    log('telegram', `Enviado directo (${msg.length} chars)`);
  }
}

// #3484 CA-UX-1 — sendChatActionTyping: refresca el indicador "escribiendo..."
// de Telegram durante operaciones largas (Sherlock + Claude). El indicador
// nativo dura ~5s, por eso el caller debe llamar esto cada 4s en loop.
// Best-effort, fire-and-forget — no bloquea el turn handler. POST directo
// (no encolado vía svc-telegram) porque el servicio no maneja sendChatAction
// y el indicador pierde valor si se atrasa por la cola.
function sendChatActionTyping() {
  const token = getTelegramToken();
  const chatId = getTelegramChatId();
  if (!token || !chatId) return;
  try {
    const https = require('https');
    const data = JSON.stringify({ chat_id: chatId, action: 'typing' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendChatAction`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    });
    req.on('error', () => { /* best-effort, sin log para no spammear */ });
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.write(data);
    req.end();
  } catch { /* swallow — no debe interrumpir el flow */ }
}

function _loadTgSecrets() {
  try {
    const { loadTelegramSecrets } = require('./lib/telegram-secrets');
    return loadTelegramSecrets({
      legacyConfigPath: path.join(ROOT, '.claude', 'hooks', 'telegram-config.json'),
    });
  } catch { return null; }
}

function getTelegramToken() { return _loadTgSecrets()?.bot_token || ''; }
function getTelegramChatId() { return _loadTgSecrets()?.chat_id || ''; }

// =============================================================================
// BRAZO 4: INTAKE — Lee issues de GitHub y los mete al pipeline
// =============================================================================

let lastIntakeTime = 0;

// Cache de issues qa:dependency abiertos para dedup por contenido
let depIssuesCache = { issues: [], fetchedAt: 0 };

/**
 * Dedup por contenido para issues qa:dependency.
 * Compara el título del issue contra los ya existentes con el mismo label.
 * Si encuentra un duplicado (similitud alta), cierra el nuevo y retorna true.
 */
function dedupDependencyIssue(issue, allIssuesInBatch) {
  const issueLabels = (issue.labels || []).map(l => l.name);
  if (!issueLabels.includes('qa:dependency')) return false;

  // Refrescar cache de issues qa:dependency si tiene más de 10 minutos
  if (Date.now() - depIssuesCache.fetchedAt > 600000) {
    try {
      ghThrottle();
      const raw = execSync(
        `"${GH_BIN}" issue list --label "qa:dependency" --state open --json number,title --limit 100`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
      );
      depIssuesCache = { issues: JSON.parse(raw || '[]'), fetchedAt: Date.now() };
    } catch (e) {
      log('intake', `Error cargando cache qa:dependency: ${e.message}`);
      return false;  // si falla, no bloquear el intake
    }
  }

  // Buscar duplicado entre issues existentes (no el mismo issue).
  // La heurística de matching vive en .pipeline/dedup-lib.js — misma fuente
  // para intake (acá) y rejection-report (findExistingDepIssue).
  for (const existing of depIssuesCache.issues) {
    if (existing.number === issue.number) continue;
    if (allIssuesInBatch.some(i => i.number === existing.number)) continue;
    if (dedupLib.isDuplicateTitle(issue.title, existing.title)) {
      closeDuplicateIssue(issue.number, existing.number, issue.title);
      return true;
    }
  }

  // Agregar a cache para dedup dentro del mismo batch de intake
  depIssuesCache.issues.push({ number: issue.number, title: issue.title });
  return false;
}

function closeDuplicateIssue(dupNum, existingNum, dupTitle) {
  try {
    const body = `Duplicado de #${existingNum}. Cerrado automáticamente por el pipeline de definición (dedup por contenido).`;
    ghThrottle();
    execSync(
      `"${GH_BIN}" issue close ${dupNum} --comment "${body.replace(/"/g, '\\"')}" --reason "not planned"`,
      { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    log('intake', `#${dupNum} cerrado como duplicado de #${existingNum} — "${dupTitle}"`);
  } catch (e) {
    log('intake', `Error cerrando duplicado #${dupNum}: ${e.message}`);
  }
}

/**
 * Busca el último rechazo del issue en `<pipeline>/<fase>/procesado/<issue>.*`.
 * Devuelve `{motivo, fase, skill, at}` del archivo más reciente con
 * `resultado: rechazado` o `null` si no encuentra ninguno.
 *
 * Caso de uso (#2801): el intake re-toma un issue que ya pasó por el pipeline
 * (post circuit breaker o cleanup downstream). El agente que reciba el
 * re-intake necesita saber por qué falló la corrida anterior — sin eso,
 * arranca a ciegas y vuelve a fallar por la misma razón.
 */
function findLastRejection(pipelineName, issueNum, config) {
    const pipelineConfig = (config.pipelines || {})[pipelineName];
    if (!pipelineConfig) return null;
    const fases = pipelineConfig.fases || [];
    let best = null;
    for (const fase of fases) {
        const dir = path.join(fasePath(pipelineName, fase), 'procesado');
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.startsWith(issueNum + '.') || f.startsWith('.')) continue;
                if (isMarkerArtifactPulpo(f)) continue;
                const filepath = path.join(dir, f);
                let data;
                try { data = readYaml(filepath); } catch { continue; }
                if (!data || data.resultado !== 'rechazado') continue;
                let at = 0;
                try { at = fs.statSync(filepath).mtimeMs; } catch {}
                if (!best || at > best.at) {
                    const skill = f.split('.').slice(1).join('.');
                    best = {
                        motivo: data.motivo || data.motivo_rechazo || 'sin motivo registrado',
                        fase,
                        skill,
                        at: at ? new Date(at).toISOString() : null,
                    };
                }
            }
        } catch { /* dir no existe */ }
    }
    return best;
}

function brazoIntake(config) {
  const intakeInterval = (config.timeouts?.intake_interval_seconds || 300) * 1000;
  if (Date.now() - lastIntakeTime < intakeInterval) return;
  lastIntakeTime = Date.now();

  // #2506: respetar pausa parcial — si está activa, solo procesar issues del allowlist.
  // Si es pausa completa, no hacer intake.
  const pipelineMode = partialPause.getPipelineMode();
  if (pipelineMode.mode === 'paused') return;
  const allowlistSet = pipelineMode.mode === 'partial_pause'
    ? new Set(pipelineMode.allowedIssues.map(String))
    : null;

  const intakeConfig = config.intake || {};

  for (const [pipelineName, pipeIntake] of Object.entries(intakeConfig)) {
    const label = pipeIntake.label;
    const faseEntrada = pipeIntake.fase_entrada;
    const pipelineConfig = config.pipelines[pipelineName];
    if (!pipelineConfig || !label || !faseEntrada) continue;

    try {
      // Consultar GitHub por issues con el label
      // #2405 CA-4: excluir issues con label `needs-human` — el circuit breaker
      // de infra los saca de la cola de intake hasta que un humano quite el label.
      ghThrottle();
      const result = execSync(
        `"${GH_BIN}" issue list --label "${label}" --state open --json number,title,labels --limit 50 --search "-label:needs-human"`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
      );
      let issues = JSON.parse(result || '[]');

      if (issues.length === 0) continue;

      // #2506: si partial_pause, filtrar antes del loop principal para no hacer trabajo inútil.
      if (allowlistSet) {
        const before = issues.length;
        issues = issues.filter(i => allowlistSet.has(String(i.number)));
        if (issues.length === 0) {
          log('intake', `${pipelineName}: partial_pause filtró ${before} issues fuera del allowlist — sin candidatos`);
          continue;
        }
        if (before > issues.length) {
          log('intake', `${pipelineName}: partial_pause filtró ${before - issues.length} issues fuera del allowlist (${issues.length} candidatos restantes)`);
        }
      }

      // Cachear labels+estado de los issues recién traídos de GitHub
      for (const issue of issues) {
        const labelNames = (issue.labels || []).map(l => l.name);
        issueLabelsCache.set(String(issue.number), { labels: labelNames, state: 'OPEN', fetchedAt: Date.now() });
      }

      // Ordenar por prioridad combinada (priority label + feature priority)
      issues.sort((a, b) => {
        return calcularPrioridad(String(a.number), config) - calcularPrioridad(String(b.number), config);
      });

      for (const issue of issues) {
        const issueNum = String(issue.number);

        // BLOCKED: no procesar issues con label blocked:dependencies
        const issueLabels = (issue.labels || []).map(l => l.name);
        if (issueLabels.includes('blocked:dependencies')) {
          log('intake', `#${issueNum} omitido — tiene label blocked:dependencies`);
          continue;
        }

        // RECOMENDACION (#2653): no procesar issues con label tipo:recomendacion
        // hasta que un humano apruebe (recommendation:approved). Defensa en
        // profundidad: el search ya filtra needs-human, pero si alguien quita
        // needs-human por error sin agregar recommendation:approved, el issue
        // sigue siendo una recomendación pendiente y NO debe entrar al flujo.
        if (issueLabels.includes('tipo:recomendacion') && !issueLabels.includes('recommendation:approved')) {
          log('intake', `#${issueNum} omitido — recomendación pendiente de aprobación humana (tipo:recomendacion sin recommendation:approved)`);
          continue;
        }

        // Dedup por contenido para issues qa:dependency (cierra duplicados automáticamente)
        if (dedupDependencyIssue(issue, issues)) continue;

        // Deduplicación: verificar que el issue no esté ya activo en este pipeline
        if (issueExistsInPipeline(issueNum, pipelineName)) continue;

        // Crear archivos en pendiente/ de la fase de entrada
        const skills = pipelineConfig.skills_por_fase[faseEntrada] || [];
        const pendienteDir = path.join(fasePath(pipelineName, faseEntrada), 'pendiente');

        // #2801 — Si el issue ya pasó por el pipeline antes (circuit breaker
        // o intake repetido), buscamos el último rechazo en `*/procesado/`
        // para propagar el contexto al nuevo archivo. Sin esto, el agente
        // que recibe el re-intake arranca a ciegas y vuelve a fallar igual.
        const previousRejection = findLastRejection(pipelineName, issueNum, config);
        const baseYaml = { issue: parseInt(issueNum), fase: faseEntrada, pipeline: pipelineName };
        if (previousRejection) {
          baseYaml.rebote = true;
          baseYaml.rebote_tipo = 're-intake';
          baseYaml.rebote_re_intake = true;
          baseYaml.motivo_rechazo = previousRejection.motivo;
          baseYaml.rechazado_en_fase = previousRejection.fase;
          baseYaml.rechazado_skill_previo = previousRejection.skill;
          baseYaml.rechazado_at = previousRejection.at;
        }

        if (faseEntrada === 'dev') {
          // Fase dev: un solo skill según labels
          const devSkill = determinarDevSkill(issueNum, config);
          const filePath = path.join(pendienteDir, `${issueNum}.${devSkill}`);
          if (!fs.existsSync(filePath)) {
            writeYaml(filePath, baseYaml);
            const tag = previousRejection ? ` ↩ con contexto de rechazo previo (${previousRejection.fase}/${previousRejection.skill})` : '';
            log('intake', `#${issueNum} "${issue.title}" → ${pipelineName}/${faseEntrada} (${devSkill})${tag}`);
          }
        } else {
          // Fase paralela: un archivo por skill
          let created = false;
          for (const skill of skills) {
            const filePath = path.join(pendienteDir, `${issueNum}.${skill}`);
            if (!fs.existsSync(filePath)) {
              writeYaml(filePath, baseYaml);
              created = true;
            }
          }
          if (created) {
            const tag = previousRejection ? ` ↩ con contexto de rechazo previo (${previousRejection.fase}/${previousRejection.skill})` : '';
            log('intake', `#${issueNum} "${issue.title}" → ${pipelineName}/${faseEntrada} (${skills.join(', ')})${tag}`);
          }
        }
      }
    } catch (e) {
      log('intake', `Error consultando GitHub para ${pipelineName}: ${e.message}`);
    }
  }
}

// =============================================================================
// MAIN LOOP
// =============================================================================

let running = true;
let paused = false;
// #3518 CA-6 — bloqueo por desync entre waves.json y .partial-pause.json.
// El detector crea/borra `.desync-detected.flag`; mientras exista, los brazos
// que dispatchan trabajo (intake/desbloqueo/barrido/lanzamiento) quedan inertes.
// Mirror del patrón `paused`: el ciclo igual gira (priority windows, commander,
// telegram drain, multi-provider health), pero NO arranca agentes nuevos hasta
// que un humano audite y borre el flag.
let desyncBlocked = false;
let desyncBlockedNotifiedTick = 0;

// Archivo de control para pausar/reanudar desde fuera
const PAUSE_FILE = path.join(PIPELINE, '.paused');

function checkPauseFile() {
  paused = fs.existsSync(PAUSE_FILE);
}

function checkDesyncFlag() {
  desyncBlocked = desyncDetector.isDesyncFlagSet();
}

// =============================================================================
// #2975 — Notifier de cuota Anthropic agotada (lifecycle Telegram)
//
// El flag `.pipeline/quota-exhausted.json` lo escribe/borra el detector de
// #2974. Acá poleamos por transición y delegamos al notifier (lib/quota-
// notifier.js) que maneja inicial + recordatorios A→B→C→D + cierre + canned.
// =============================================================================
const QUOTA_FLAG_PATH = path.join(PIPELINE, 'quota-exhausted.json');

function readQuotaFlag() {
  try {
    if (!fs.existsSync(QUOTA_FLAG_PATH)) return null;
    return JSON.parse(fs.readFileSync(QUOTA_FLAG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Cuenta archivos LLM encolados en `pendiente/` de fases que llaman a Claude.
 * Aproximación buena para el copy "Drenando cola de N agentes encolados" sin
 * tener que tocar el writer del flag (#2974). Si el filesystem cambia, la
 * cuenta puede subir/bajar entre lecturas — aceptable para un mensaje informativo.
 */
function countQueuedLlmAgents() {
  const llmFases = ['validacion', 'dev', 'verificacion', 'aprobacion'];
  let total = 0;
  for (const fase of llmFases) {
    const dir = path.join(PIPELINE, 'desarrollo', fase, 'pendiente');
    try {
      const files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep') && !isMarkerArtifactPulpo(f));
      total += files.length;
    } catch { /* dir no existe — sumar 0 */ }
  }
  return total;
}

const quotaNotifier = createQuotaNotifier({
  sendMessage: (text, opts) => {
    if (opts && opts.plain) sendTelegramPlain(text);
    else sendTelegram(text);
  },
  log: (msg) => log('quota', msg),
  getReminderIntervalMin: () => {
    try {
      const cfg = loadConfig();
      const v = cfg && cfg.quota_detector && Number(cfg.quota_detector.reminder_interval_minutes);
      if (Number.isFinite(v) && v > 0) return v;
    } catch {}
    return DEFAULT_REMINDER_INTERVAL_MIN;
  },
  getQueuedAgentsCount: () => countQueuedLlmAgents(),
});

let lastQuotaFlagPresent = false;

/**
 * Tick de poll del flag de cuota — llamado desde el loop principal del pulpo.
 * Detecta transiciones ausente↔presente y dispara los lifecycle del notifier.
 */
function pollQuotaFlag() {
  const flag = readQuotaFlag();
  const present = flag !== null;
  if (present && !lastQuotaFlagPresent) {
    quotaNotifier.onFlagSet(flag);
  } else if (!present && lastQuotaFlagPresent) {
    quotaNotifier.onFlagCleared();
  }
  lastQuotaFlagPresent = present;
}

// Rotación del historial del commander (descartar > 24hs)
let lastHistoryRotation = 0;
function rotateHistory() {
  if (Date.now() - lastHistoryRotation < 3600000) return; // Rotar máx cada hora
  lastHistoryRotation = Date.now();

  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
    const kept = lines.filter(l => {
      try { return JSON.parse(l).timestamp >= cutoff; } catch { return false; }
    });
    if (kept.length < lines.length) {
      fs.writeFileSync(historyFile, kept.join('\n') + '\n');
      log('pulpo', `Historial rotado: ${lines.length} → ${kept.length} entries`);
    }
  } catch {}
}

// --- MÉTRICAS HISTÓRICAS ---
// Persiste snapshot cada ciclo (30s) a metrics-history.jsonl.
// El dashboard lee este archivo para /metrics.
const METRICS_FILE = path.join(PIPELINE, 'metrics-history.jsonl');
const METRICS_MAX_ENTRIES = 2880; // ~24h a 30s/ciclo
let metricsLastRotation = 0;

function persistMetricsSnapshot(config) {
  try {
    const pressure = getResourcePressure(config);
    const totalRunning = countTotalRunningAgents(config);

    // Contar por fase
    const byFase = {};
    for (const [pName, pConfig] of Object.entries(config.pipelines)) {
      for (const fase of pConfig.fases) {
        const tDir = path.join(PIPELINE, pName, fase, 'trabajando');
        const pDir = path.join(PIPELINE, pName, fase, 'pendiente');
        byFase[fase] = {
          working: (byFase[fase]?.working || 0) + listWorkFiles(tDir).length,
          pending: (byFase[fase]?.pending || 0) + listWorkFiles(pDir).length
        };
      }
    }

    // Contar por skill (para perfiles de consumo)
    const bySkill = {};
    for (const [key] of activeProcesses) {
      const sk = key.split(':')[0];
      bySkill[sk] = (bySkill[sk] || 0) + 1;
    }

    const snapshot = {
      ts: Date.now(),
      cpu: pressure.cpuPercent,
      mem: pressure.memPercent,
      level: pressure.level,
      agents: totalRunning,
      byFase,
      bySkill,
      qaPriority: qaPriorityActive,
      buildPriority: buildPriorityActive
    };

    fs.appendFileSync(METRICS_FILE, JSON.stringify(snapshot) + '\n');

    // Rotar cada 10min para no crecer indefinidamente
    const now = Date.now();
    if (now - metricsLastRotation > 600000) {
      metricsLastRotation = now;
      try {
        const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
        if (lines.length > METRICS_MAX_ENTRIES) {
          fs.writeFileSync(METRICS_FILE, lines.slice(-METRICS_MAX_ENTRIES).join('\n') + '\n');
        }
      } catch {}
    }
  } catch {}
}

// =============================================================================
// BRAZO DESBLOQUEO — Revisa issues con blocked:dependencies y desbloquea
// cuando todas sus dependencias están cerradas.
// Frecuencia: cada 30 minutos. Basado en datos reales del pipeline:
//   - P10 de duración de issues: 1.2h, P25: 2.7h, mediana: 141h
//   - 30 min es generoso (cubre issues rápidos) sin ser innecesariamente frecuente
// =============================================================================
let lastUnblockTime = 0;
const UNBLOCK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

// #3059 — Watchdog del guard: si la ejecución previa nunca terminó (ej. gh.exe
// wedged en una syscall de Windows que el `timeout` de child_process no logra
// matar), el `_unblockRunning` queda en true para siempre y el brazo se vuelve
// silencioso. Liberamos a la fuerza pasados 10 min y matamos el pid wedged.
const UNBLOCK_WEDGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const REENTRY_LOG_COOLDOWN_MS = 10 * 60 * 1000;  // log skip cada 10 min, no spam

// #2801 — `brazoDesbloqueo` se hizo async para no bloquear el event loop.
// Antes: 5 execSync (gh issue list/view/edit/comment/close) que con 46 issues
// y ~6 calls cada uno = ~30 min de pulpo bloqueado consultando GitHub. Mientras
// tanto los brazos siguientes (barrido, lanzamiento) NO corrían y el pipeline
// se atascaba.
//
// Ahora: execFileAsync + await — el event loop sigue atendiendo otras tareas
// (HTTP, timers, signals) mientras gh está en vuelo. El loop principal del
// pulpo invoca este brazo sin await ('fire and forget') así que el lanzamiento
// no se atrasa por el desbloqueo. El guard `lastUnblockTime` y `_unblockRunning`
// previenen entrar dos veces a la vez.
//
// #3059 — El estado del guard pasa a un objeto de módulo-level con tres campos:
//   - running: true mientras `brazoDesbloqueoImpl` está en vuelo.
//   - startedAt: ts en que se entró a la ejecución (para watchdog).
//   - activePid: pid del child `gh.exe` actualmente activo (para taskkill).
// El watchdog inspecciona estos tres campos al inicio de cada tick.
let _unblockRunning = false;
let _unblockStartedAt = 0;
let _unblockActivePid = null;
let _unblockReentryLastWarn = 0;

/**
 * #3059 — Sanitización de args sensibles antes de loguearlos.
 * El gh-cli actual no recibe tokens por flag, pero un cambio futuro
 * que agregue --token / --auth / --password no debe filtrar el secreto
 * en `logs/pulpo.log` cuando el wrapper logea el comando wedged.
 * Recomendación de security en el análisis de #3059.
 */
function _sanitizeGhArgs(args) {
  const DENY = new Set(['--token', '--auth', '--password', '-p', '--api-token']);
  const out = [];
  let redactNext = false;
  for (const a of args) {
    if (redactNext) { out.push('***'); redactNext = false; continue; }
    out.push(a);
    if (DENY.has(a)) redactNext = true;
  }
  return out.join(' ');
}

/**
 * #3059 — Wrapper robusto de `execFile` con timeout que SÍ rechaza la promise
 * y mata al proceso hijo en Windows con `taskkill /F /T /PID <pid>`.
 *
 * Por qué: `child_process.execFile({ timeout })` en Windows no garantiza
 * matar al binario si éste quedó wedged en una syscall (DNS lento, named
 * pipe colgado, gh-cli sin cerrar stdout). La promise queda pendiente
 * para siempre y el caller nunca libera su guard de re-entry.
 *
 * Garantías:
 *   - Si el proceso resuelve antes del timeout → resolve normal, timer
 *     cancelado con clearTimeout (sin leak).
 *   - Si excede timeout → reject con error.code = 'GH_CALL_TIMEOUT' Y
 *     `taskkill /F /T /PID` sobre el pid (idempotente, log distingue
 *     "matado por timeout" vs "ya había muerto solo").
 *   - PID validado con `Number.isInteger(pid) && pid > 0` antes de
 *     ejecutar taskkill (defense-in-depth recomendado por security).
 *   - Mientras el proceso está vivo, su pid queda registrado en
 *     `_unblockActivePid` para que el watchdog del brazo pueda matarlo
 *     si el race promise/timer mismo se cuelga.
 */
function _ghCallWithTimeout(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let pid = null;

    const proc = execFile(bin, args, {
      cwd: ROOT,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (_unblockActivePid === pid) _unblockActivePid = null;
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });

    pid = proc && Number.isInteger(proc.pid) ? proc.pid : null;
    if (pid && pid > 0) _unblockActivePid = pid;

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = null;

      let killStatus = 'sin pid registrado';
      if (Number.isInteger(pid) && pid > 0) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
          killStatus = `matado por timeout (pid ${pid})`;
        } catch {
          // taskkill sobre pid muerto retorna no-zero pero es benigno: el
          // proceso ya había terminado por su cuenta entre el race y el kill.
          killStatus = `pid ${pid} ya había muerto solo`;
        }
      }
      if (_unblockActivePid === pid) _unblockActivePid = null;

      log('desbloqueo', `[WARN] gh-call-timeout (${timeoutMs}ms) — args: ${_sanitizeGhArgs(args)} — ${killStatus}`);

      const err = new Error(`gh-call-timeout: ${timeoutMs}ms`);
      err.code = 'GH_CALL_TIMEOUT';
      err.pid = pid;
      err.killStatus = killStatus;
      err.args = args.slice();
      reject(err);
    }, timeoutMs);
    // No queremos que el timer mantenga vivo el proceso del pulpo.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

async function ghDesbloqueoCall(args, timeout = 15000) {
  return _ghCallWithTimeout(GH_BIN, args, timeout);
}

/**
 * #3059 — Watchdog del guard `_unblockRunning`.
 *
 * Si la ejecución previa lleva > UNBLOCK_WEDGE_TIMEOUT_MS sin terminar:
 *   - mata el `gh.exe` activo (si existe) con taskkill /F /T
 *   - libera _unblockRunning + resetea _unblockStartedAt + _unblockActivePid
 *   - resetea lastUnblockTime = 0 para que el próximo tick arranque INMEDIATO
 *     (sin tener que esperar otros 30 min adicionales después del wedge —
 *     observación crítica de guru en el análisis técnico de #3059)
 *   - logea un warning explícito que un humano puede grepear.
 *
 * Devuelve null si no hay wedge, o un objeto descriptivo si lo había.
 */
function _checkAndResetUnblockWedge() {
  if (!_unblockRunning || _unblockStartedAt === 0) return null;
  const wedgeMs = Date.now() - _unblockStartedAt;
  if (wedgeMs <= UNBLOCK_WEDGE_TIMEOUT_MS) return null;

  let killMsg = 'sin pid activo';
  let killedPid = null;
  if (Number.isInteger(_unblockActivePid) && _unblockActivePid > 0) {
    killedPid = _unblockActivePid;
    try {
      execSync(`taskkill /F /T /PID ${_unblockActivePid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      killMsg = `mato pid ${_unblockActivePid}`;
    } catch {
      killMsg = `pid ${_unblockActivePid} ya estaba muerto solo`;
    }
  }
  log('desbloqueo', `[WARN] brazo desbloqueo wedged > ${Math.round(wedgeMs / 60000)}min — forzando reset del guard, ${killMsg}`);
  _unblockRunning = false;
  _unblockStartedAt = 0;
  _unblockActivePid = null;
  lastUnblockTime = 0;
  return { wedgeMs, killedPid, killMsg };
}

/**
 * #3059 — Log observable del re-entry skip, con cooldown de 10 min para
 * no spamear el log cuando el ciclo anterior sigue corriendo dentro de
 * los límites razonables.
 *
 * Devuelve true si logueó, false si fue silenciado por cooldown.
 */
function _maybeLogReentrySkip() {
  const now = Date.now();
  if (now - _unblockReentryLastWarn <= REENTRY_LOG_COOLDOWN_MS) return false;
  _unblockReentryLastWarn = now;
  const ageMs = _unblockStartedAt > 0 ? now - _unblockStartedAt : 0;
  log('desbloqueo', `[INFO] brazo desbloqueo skip — ciclo anterior sigue activo desde hace ${Math.round(ageMs / 60000)} min`);
  return true;
}

// #3259 / CA-4 + CA-10 — brazo de retry de provider-exhaustion-pause.
// Estado:
//   - `_exhaustionLastTickAt`: ms del último tick exitoso (default 0 — primer
//     tick corre apenas el loop arranca).
//   - El brazo es síncrono y rápido (gh issue list con --limit 50 + un
//     gh issue edit por cada issue destrabable). No usa guard de re-entrada
//     porque el intervalo mínimo de 60s lo previene naturalmente.
let _exhaustionLastTickAt = 0;

function brazoProviderExhaustionRetry(config) {
  // Lectura defensiva: si el módulo no cargó, no hay nada que hacer.
  if (!providerExhaustionPause) return;

  // Intervalo configurable con piso hardcoded 60s (anti-DoS providers free).
  const cfgInterval = ((config && config.pulpo_continuidad) || {}).retry_interval_ms;
  const intervalMs = providerExhaustionPause.clampRetryIntervalMs(cfgInterval);
  const now = Date.now();
  if (now - _exhaustionLastTickAt < intervalMs) return;
  _exhaustionLastTickAt = now;

  try {
    const result = providerExhaustionPause.tryResume({});
    if (result.resumed.length > 0) {
      log('exhaustion-retry', `🟩 destrabados ${result.resumed.length} issue(s): ${result.resumed.map(r => `#${r.issue}→${r.provider_recovered}`).join(', ')}`);
    }
    if (result.skipped.length > 0) {
      // Solo loguear si hubo skip por motivo no-trivial (gh error, etc).
      const meaningfulSkips = result.skipped.filter(s => s.reason !== 'still_gated_same_provider');
      if (meaningfulSkips.length > 0) {
        log('exhaustion-retry', `⚠️ saltados ${meaningfulSkips.length} issue(s): ${meaningfulSkips.map(s => `#${s.issue}:${s.reason}`).join(', ')}`);
      }
    }
  } catch (e) {
    log('exhaustion-retry', `[WARN] brazo retry falló (no bloqueante): ${e.message}`);
  }
}

async function brazoDesbloqueo(config) {
  // #3059 — Watchdog ANTES del guard: si la ejecución anterior nunca
  // terminó (gh.exe wedged en Windows con timeout que no garantiza kill),
  // liberamos el guard a la fuerza, matamos el pid y reseteamos
  // lastUnblockTime para arrancar inmediato en este mismo tick.
  _checkAndResetUnblockWedge();

  if (_unblockRunning) {
    // #3059 — el guard NO es silencioso: logueamos que estamos salteando
    // (con cooldown de 10 min para no spamear).
    _maybeLogReentrySkip();
    return;
  }
  if (Date.now() - lastUnblockTime < UNBLOCK_INTERVAL_MS) return;
  lastUnblockTime = Date.now();
  _unblockRunning = true;
  _unblockStartedAt = Date.now();
  try { await brazoDesbloqueoImpl(config); }
  finally {
    _unblockRunning = false;
    _unblockStartedAt = 0;
    _unblockActivePid = null;
  }
}

async function brazoDesbloqueoImpl(config) {
  // #2506: respetar pausa parcial — los bloqueados fuera del allowlist no se van
  // a ejecutar aunque se desbloqueen ahora, así que no tiene sentido gastar el
  // ciclo consultando sus dependencias en GitHub.
  const pipelineMode = partialPause.getPipelineMode();
  if (pipelineMode.mode === 'paused') return;
  const allowlistSet = pipelineMode.mode === 'partial_pause'
    ? new Set(pipelineMode.allowedIssues.map(String))
    : null;

  try {
    // 1. Buscar issues abiertos con label blocked:dependencies
    ghThrottle();
    const { stdout: result } = await ghDesbloqueoCall(
      ['issue', 'list', '--label', 'blocked:dependencies', '--state', 'open', '--json', 'number,title,labels', '--limit', '50'],
      30000
    );
    let blockedIssues = JSON.parse(result || '[]');
    if (blockedIssues.length === 0) {
      // Limpiar datos stale — si ya no hay bloqueados, el dashboard debe saberlo
      try { fs.writeFileSync(path.join(PIPELINE, 'blocked-issues.json'), JSON.stringify({ blockedBy: {}, blocks: {} }, null, 2)); } catch {}
      return;
    }

    // #2506: filtrar por allowlist si pausa parcial activa.
    if (allowlistSet) {
      const before = blockedIssues.length;
      blockedIssues = blockedIssues.filter(i => allowlistSet.has(String(i.number)));
      if (blockedIssues.length === 0) {
        log('desbloqueo', `partial_pause: ninguno de los ${before} issues bloqueados está en el allowlist — skip ciclo`);
        return;
      }
      log('desbloqueo', `partial_pause: filtrados ${before - blockedIssues.length} issues fuera del allowlist (${blockedIssues.length} candidatos)`);
    }

    log('desbloqueo', `Revisando ${blockedIssues.length} issues bloqueados por dependencias`);

    // Mapeos bidireccionales para el dashboard
    const blockedBy = {};  // issue → [dependencias]
    const blocks = {};     // dependencia → [issues que bloquea]

    for (const issue of blockedIssues) {
      try {
        // 2. Leer body + comentarios del issue.
        //
        // #3002 — JSON estructurado por comentario, NO `--jq .comments[].body`:
        // el parser line-based necesita `createdAt` (CA-7 del marker, escoge el
        // más reciente) y `body` separado por comentario.
        //
        // #3193 — Sumamos `body` al fetch para detectar deps escritas
        // directamente en el body del issue (caso #3176/#3177 — deps en body,
        // sin marker en comentario). El campo `body` es un add-on a la MISMA
        // llamada → cero requests adicionales a GitHub API por ciclo (CA-18).
        ghThrottle();
        const { stdout: rawComments } = await ghDesbloqueoCall(
          ['issue', 'view', String(issue.number), '--json', 'body,comments', '--repo', 'intrale/platform']
        );
        let commentsArray = [];
        let issueBody = '';
        try {
          const parsed = JSON.parse(rawComments || '{}');
          commentsArray = Array.isArray(parsed.comments) ? parsed.comments : [];
          issueBody = typeof parsed.body === 'string' ? parsed.body : '';
        } catch (e) {
          // Si gh devolvió algo que no es JSON, fail-closed: no podemos
          // garantizar que las deps estén bien parseadas → no tocar labels.
          log('desbloqueo', `#${issue.number}: respuesta de gh no parseable como JSON — skip ciclo`);
          continue;
        }

        // #3193 — Resolver multi-fuente: comentario canónico + body con 3
        // patrones (sección canónica, sección genérica con bullets puros,
        // verbos GitHub-nativos `Depends on`/`Blocked by`). Unión de fuentes
        // con cap MAX_DEPS=20. Fail-closed semántica preservada (CA-5).
        const resolved = resolveDependencies({
          body: issueBody,
          comments: commentsArray,
          selfIssue: issue.number,
        });
        if (resolved.deps === null) {
          // CA-5/CA-6: NO desbloquear, NO auto-cerrar. Ninguna de las 3
          // fuentes produjo un marker válido → mantener label puesto y
          // dejar el issue para revisión humana en próxima iteración.
          log('desbloqueo', `#${issue.number}: sin marker canónico ni patrones detectables en body — fail-closed, skip ciclo`);
          continue;
        }
        const depIssueNumbers = resolved.deps.map(String);
        // CA-17 — Observabilidad: registrar fuente detectada por ciclo.
        log('desbloqueo', `#${issue.number}: fuente=${resolved.source} deps=${depIssueNumbers.length} (${sanitizeForLog(depIssueNumbers.join(','), 200)})`);
        if (depIssueNumbers.length === 0) {
          log('desbloqueo', `#${issue.number}: marker presente pero sin issue numbers reconocibles — registrado sin deps`);
          blockedBy[issue.number] = [];
          continue;
        }

        // Registrar mapeos bidireccionales
        blockedBy[issue.number] = depIssueNumbers;
        for (const dep of depIssueNumbers) {
          if (!blocks[dep]) blocks[dep] = [];
          if (!blocks[dep].includes(String(issue.number))) blocks[dep].push(String(issue.number));
        }

        // #3193 — Auto-promote del marker canónico cuando las deps vienen
        // SOLO del body (caso #3176/#3177). Una vez promovido, el comentario
        // canónico pasa a ser la fuente de verdad y los próximos ciclos no
        // re-parsean el body (CA-13/CA-14/CA-15).
        //
        // Idempotencia: re-fetcheamos comments JUSTO antes de postear y
        // verificamos que no exista ya un marker canónico (ej: otro ciclo del
        // pulpo lo posteó en paralelo, o el agente humano agregó uno mientras
        // este ciclo procesaba). Si ya existe → skip silencioso con log.
        if (resolved.source === 'body') {
          try {
            ghThrottle();
            const { stdout: rawFresh } = await ghDesbloqueoCall(
              ['issue', 'view', String(issue.number), '--json', 'comments', '--repo', 'intrale/platform'],
              10000
            );
            let freshComments = [];
            try {
              const freshParsed = JSON.parse(rawFresh || '{}');
              freshComments = Array.isArray(freshParsed.comments) ? freshParsed.comments : [];
            } catch {
              freshComments = [];
            }
            if (parseDependencyComment(freshComments, issue.number) !== null) {
              log('desbloqueo', `#${issue.number}: marker canónico ya presente — skip auto-promote (idempotente)`);
            } else {
              const promoteComment = buildAutoPromoteComment(resolved.deps);
              ghThrottle();
              await ghDesbloqueoCall(
                ['issue', 'comment', String(issue.number), '--body', promoteComment, '--repo', 'intrale/platform'],
                10000
              );
              log('desbloqueo', `#${issue.number}: marker canónico auto-promovido desde body (deps: ${depIssueNumbers.join(',')})`);
            }
          } catch (e) {
            // Fallar el auto-promote NO debe romper el flujo de desbloqueo.
            // Lo logueamos y seguimos — el ciclo siguiente reintenta.
            log('desbloqueo', `#${issue.number}: error en auto-promote (no bloqueante): ${e.message}`);
          }
        }

        // 3. Verificar si todas las dependencias están cerradas
        let allClosed = true;
        const openDeps = [];
        for (const depNum of depIssueNumbers) {
          ghThrottle();
          try {
            const { stdout: depState } = await ghDesbloqueoCall(
              ['issue', 'view', String(depNum), '--json', 'state', '--jq', '.state', '--repo', 'intrale/platform'],
              10000
            );
            if (depState.trim() !== 'CLOSED') {
              allClosed = false;
              openDeps.push(depNum);
            }
          } catch (e) {
            // Si no se puede leer el estado, asumir que está abierto
            allClosed = false;
            openDeps.push(depNum);
          }
        }

        if (allClosed) {
          // 4. Todas cerradas → desbloquear (o auto-cerrar si es paraguas `split`)
          const issueLabelNames = (issue.labels || []).map(l => l.name);
          const isSplitParent = issueLabelNames.includes('split');

          // Quitar de los mapeos (ya no está bloqueado)
          delete blockedBy[issue.number];
          for (const dep of depIssueNumbers) {
            if (blocks[dep]) blocks[dep] = blocks[dep].filter(n => n !== String(issue.number));
            if (blocks[dep] && blocks[dep].length === 0) delete blocks[dep];
          }

          if (isSplitParent) {
            // Paraguas: las hijas cubren el scope, se cierra el padre sin reingresar al pipeline
            log('desbloqueo', `#${issue.number}: paraguas split con todas las hijas cerradas (${depIssueNumbers.join(', ')}) → auto-cerrando`);
            const closeComment = `## ✅ Paraguas resuelto\n\nEste issue era un paraguas (label \`split\`) y todas sus historias hijas fueron cerradas (${depIssueNumbers.map(n => '#' + n).join(', ')}). El scope queda cubierto por las hijas, no requiere desarrollo adicional.\n\n_Cerrado automáticamente por el brazo de desbloqueo del pipeline._`;
            ghThrottle();
            try {
              await ghDesbloqueoCall(
                ['issue', 'close', String(issue.number), '--reason', 'completed', '--comment', closeComment, '--repo', 'intrale/platform'],
                10000
              );
              sendTelegram(`🟢 Paraguas #${issue.number} cerrado automáticamente — todas las hijas del split (${depIssueNumbers.map(n => '#' + n).join(', ')}) resueltas.`);
              log('desbloqueo', `#${issue.number} paraguas cerrado exitosamente`);
            } catch (e) {
              log('desbloqueo', `Error cerrando paraguas #${issue.number}: ${e.message}`);
            }
          } else {
            log('desbloqueo', `🪢→🟢 #${issue.number} destrabado (deps cerradas: ${depIssueNumbers.map(n => '#' + n).join(',')})`);

            // Quitar label blocked:dependencies
            ghThrottle();
            await ghDesbloqueoCall(
              ['issue', 'edit', String(issue.number), '--remove-label', 'blocked:dependencies', '--repo', 'intrale/platform'],
              10000
            );

            // #3229 — Reingresar archivos del filesystem: si el barrido movió
            // el issue a `bloqueado-dependencias/` (post-#3229), liberarlo a
            // `pendiente/` de la fase original. Idempotente: si no hay
            // marker (caso pre-#3229 o issue label-only sin filesystem move),
            // moved=0 y seguimos.
            try {
              const releaseRes = reboteClassifier.releaseDependencyBlockToPendiente({
                issue: issue.number,
              });
              if (releaseRes.moved > 0) {
                log('desbloqueo', `🟢 #${issue.number}: ${releaseRes.moved} archivo(s) movido(s) de bloqueado-dependencias/ a ${releaseRes.pipeline}/${releaseRes.phase}/pendiente/`);
                // #3373 — sweep defensivo: si recuperó archivos legacy de procesado/,
                // log explícito con prefijo distintivo para forensics.
                if (releaseRes.swept && releaseRes.swept > 0) {
                  log('desbloqueo-sweep', `🧹 #${issue.number}: ${releaseRes.swept} archivo(s) legacy recuperado(s) de procesado/ (cancelado_por: fast-fail-rebote)`);
                }
              } else {
                log('desbloqueo', `🟢 #${issue.number}: sin archivos en bloqueado-dependencias/ (issue label-only, pipeline arrancará via intake)`);
              }
            } catch (e) {
              log('desbloqueo', `[WARN] #${issue.number}: releaseDependencyBlockToPendiente falló (no bloqueante): ${e.message}`);
            }

            // Agregar comentario de desbloqueo
            const unblockComment = `## Dependencias resueltas 🟢\n\nLas siguientes dependencias cerraron: ${depIssueNumbers.map(n => '#' + n).join(', ')}.\n\nEl pipeline reentra a este issue automáticamente.`;
            ghThrottle();
            await ghDesbloqueoCall(
              ['issue', 'comment', String(issue.number), '--body', unblockComment, '--repo', 'intrale/platform'],
              10000
            );

            sendTelegram(`🪢→🟢 #${issue.number} destrabado automáticamente (deps cerradas: ${depIssueNumbers.map(n => '#' + n).join(',')})`);
            log('desbloqueo', `#${issue.number} desbloqueado exitosamente`);
          }
        } else {
          log('desbloqueo', `🪢⏳ #${issue.number} sigue esperando ${openDeps.map(n => '#' + n).join(',')}`);
        }
      } catch (e) {
        log('desbloqueo', `Error procesando #${issue.number}: ${e.message}`);
      }
    }

    // Persistir mapeos para el dashboard
    try {
      fs.writeFileSync(path.join(PIPELINE, 'blocked-issues.json'), JSON.stringify({ blockedBy, blocks }, null, 2));
    } catch (e) {
      log('desbloqueo', `Error persistiendo blocked-issues.json: ${e.message}`);
    }
  } catch (e) {
    log('desbloqueo', `Error en brazo de desbloqueo: ${e.message}`);
  }
}

// =============================================================================
// #2893 — Brazo de detección de deps faltantes en pausa parcial
// =============================================================================
//
// Cuando el pipeline está en partial_pause, escaneamos el allowlist y
// detectamos issues habilitados que tienen dependencias abiertas FUERA del
// allowlist. Si encontramos:
//   - Log structured a logs/partial-pause-deps.log (auditoría)
//   - Alerta Telegram con cooldown 30 min por (issue, deps-set)
//   - Marker JSON en .pipeline/partial-pause-deps-state.json para que el
//     dashboard pueda mostrar el banner amarillo.
//
// Corre cada N=5 ciclos del Pulpo (config: partial_pause_deps.check_every_n_ticks).
// Cooldown evita spamear cuando el operador "acepta el riesgo" y deja la pausa
// activa con deps faltantes durante horas.

const PARTIAL_PAUSE_DEPS_DEFAULTS = {
  checkEveryNTicks: 5,
  alertCooldownMs: 30 * 60 * 1000,  // 30 min
  logFile: 'logs/partial-pause-deps.log',
  stateFile: 'partial-pause-deps-state.json',
};

let partialPauseDepsTickCount = 0;
const partialPauseDepsAlertCache = new Map();  // signature → ts
let partialPauseDepsRunning = false;             // re-entry guard

function partialPauseDepsConfig(config) {
  const c = (config && config.partial_pause_deps) || {};
  return {
    checkEveryNTicks: Math.max(1, Number(c.check_every_n_ticks) || PARTIAL_PAUSE_DEPS_DEFAULTS.checkEveryNTicks),
    alertCooldownMs: Math.max(60_000, Number(c.alert_cooldown_ms) || PARTIAL_PAUSE_DEPS_DEFAULTS.alertCooldownMs),
  };
}

function appendPartialPauseDepsLog(entry) {
  try {
    const file = path.join(PIPELINE, PARTIAL_PAUSE_DEPS_DEFAULTS.logFile);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(file, line);
  } catch (e) {
    log('pulpo', `[partial-pause-deps] Warning: append log failed: ${e.message}`);
  }
}

function writePartialPauseDepsState(state) {
  try {
    const file = path.join(PIPELINE, PARTIAL_PAUSE_DEPS_DEFAULTS.stateFile);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    log('pulpo', `[partial-pause-deps] Warning: write state failed: ${e.message}`);
  }
}

function clearPartialPauseDepsState() {
  try {
    const file = path.join(PIPELINE, PARTIAL_PAUSE_DEPS_DEFAULTS.stateFile);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

async function brazoPartialPauseDeps(config) {
  // Re-entrada: si la corrida anterior aún está in-flight (gh lento), saltar.
  if (partialPauseDepsRunning) return;

  const ppCfg = partialPauseDepsConfig(config);
  partialPauseDepsTickCount = (partialPauseDepsTickCount + 1) % 1_000_000;

  // Solo cuando estamos en partial_pause.
  const mode = partialPause.getPipelineMode();
  if (mode.mode !== 'partial_pause') {
    // Limpiar state si quedó de un partial_pause anterior.
    clearPartialPauseDepsState();
    return;
  }

  // Evaluar cada N ticks.
  if ((partialPauseDepsTickCount % ppCfg.checkEveryNTicks) !== 0) return;

  partialPauseDepsRunning = true;
  try {
    const result = partialPauseDeps.findMissingDeps(mode.allowedIssues);
    const missingByIssue = result.missing || {};
    const issuesWithMissing = Object.keys(missingByIssue);

    if (issuesWithMissing.length === 0) {
      // Todo OK — limpiar state si existía.
      clearPartialPauseDepsState();
      return;
    }

    // Persistir state para el banner del dashboard.
    writePartialPauseDepsState({
      detectedAt: new Date().toISOString(),
      allowedIssues: mode.allowedIssues,
      missing: missingByIssue,
      chains: result.chains || {},
      truncated: !!result.truncated,
      acceptedDepRisk: !!mode.acceptedDepRisk,
    });

    // Alertar con cooldown por (issue, deps-set).
    for (const [issueKey, deps] of Object.entries(missingByIssue)) {
      const sig = partialPauseDeps.alertSignature(issueKey, deps);
      const lastTs = partialPauseDepsAlertCache.get(sig) || 0;
      const now = Date.now();
      if (now - lastTs < ppCfg.alertCooldownMs) {
        appendPartialPauseDepsLog({
          issue: Number(issueKey),
          missing_deps: deps,
          action: 'detected_within_cooldown',
        });
        continue;
      }
      partialPauseDepsAlertCache.set(sig, now);
      appendPartialPauseDepsLog({
        issue: Number(issueKey),
        missing_deps: deps,
        action: 'alert_sent',
      });
      // Mensaje de Telegram (CA-2): texto + URL buttons al dashboard.
      // No usamos callback_query para no acoplar al listener — los botones
      // tipo "url" son handle del cliente Telegram → abre el dashboard.
      const depList = deps.map(d => `#${d}`).join(', ');
      const msg = `⚠️ *Pausa parcial trabada*\n\nEl issue *#${issueKey}* está habilitado pero depende de issues abiertas que NO están en el allowlist:\n\n  ${depList}\n\nElegí abajo cómo resolverlo (los botones abren el dashboard).`;
      const dashUrl = process.env.DASHBOARD_URL || 'http://localhost:3200';
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Sí, incluir todas', url: `${dashUrl}/?action=include-deps&issue=${issueKey}` },
            { text: `🎯 Solo #${issueKey}`, url: `${dashUrl}/?action=keep-original&issue=${issueKey}` },
          ],
          [
            { text: '✕ Cancelar pausa parcial', url: `${dashUrl}/?action=cancel-partial-pause` },
          ],
        ],
      };
      try { sendTelegramWithMarkup(msg, replyMarkup); } catch (e) {
        log('pulpo', `[partial-pause-deps] Error enviando Telegram: ${e.message}`);
        // Fallback a texto plano sin markup.
        try { sendTelegram(msg); } catch {}
      }
    }
  } catch (e) {
    log('pulpo', `[partial-pause-deps] ERROR: ${e.message}`);
  } finally {
    partialPauseDepsRunning = false;
  }
}

async function mainLoop() {
  log('pulpo', `Pulpo V2 iniciado — poll cada ${loadConfig().timeouts?.poll_interval_seconds || 30}s`);
  log('pulpo', `Pipeline: ${PIPELINE}`);
  log('pulpo', `Claude launcher: ${CLAUDE_LAUNCHER.kind} → ${CLAUDE_LAUNCHER.cmd}`);

  // #3520 — Boot hook: recovery automático si /wave promote crasheó mid-transaction.
  // Si encuentra marker stale (>TTL), restaura ambos archivos desde el snapshot
  // y pushea un Telegram proactivo a Leo (CA-D2). Si la recovery falla
  // (SHA mismatch, .bak corrupto), escribe wave-promote.failed.<ts>.json y deja
  // bloqueado /wave promote hasta intervención manual (CA-C2 + CA-D3).
  //
  // Best-effort: si la lib falla por algo inesperado, NO matamos el pulpo —
  // el boot debe ser robusto, y el operador se entera por logs si algo raro
  // pasó. La transacción próxima la frena el gate del Commander si quedó .failed.
  try {
    const waves = require('./lib/waves');
    const promoteRecovery = waves.recoverIncompletePromote();
    if (promoteRecovery && promoteRecovery.action === 'recovered') {
      const m = promoteRecovery.originalMarker || {};
      const startedAt = m.started_at || 'desconocido';
      const from = m.wave_number_from != null ? `#${m.wave_number_from}` : 'sin previa';
      const to = m.wave_number_to != null ? `#${m.wave_number_to}` : 'desconocida';
      // #3520 CA-D5 — log WARN visible (no info/debug).
      log('pulpo', `WARN [wave-recovery] /wave promote crashed at ${startedAt}, restaurado desde snapshot (de ola ${from} → ${to}).`);
      // #3520 CA-D2 — push Telegram proactivo a Leo. Best-effort: si sendTelegram
      // no está listo todavía o falla, NO bloqueamos el boot.
      try {
        sendTelegram(
          `⚠️ *Recovery automático detectado al boot del pulpo*\n\n` +
          `\`/wave promote\` ejecutado el _${startedAt}_ NO completó (crash mid\\-transaction).\n` +
          `Estado restaurado a pre\\-promote desde snapshot en \`archived/\`.\n\n` +
          `• waves.json: revertido a ola ${from}\n` +
          `• .partial\\-pause.json: revertido a allowlist de ola ${from}\n\n` +
          `_Sugerencia:_ revisá logs del crash anterior antes de reintentar \`/wave promote\`.`
        );
      } catch (e) {
        log('pulpo', `WARN [wave-recovery] no pude enviar push proactivo: ${e.message}`);
      }
    } else if (promoteRecovery && promoteRecovery.action === 'failed') {
      // #3520 CA-D3 — fail-closed: push con instrucciones accionables.
      const reason = promoteRecovery.reason || 'razón desconocida';
      const failedPath = promoteRecovery.failedMarkerPath || '(desconocido)';
      log('pulpo', `WARN [wave-recovery] FAIL-CLOSED: ${reason}. Marker .failed escrito en ${failedPath}.`);
      try {
        sendTelegram(
          `🚫 *Recovery automática FALLÓ tras crash de /wave promote*\n\n` +
          `Razón: \`${reason.replace(/[`*_\[\]()]/g, '')}\`\n\n` +
          `El sistema está en estado consistente actual pero NO se puede garantizar qué configuración estaba antes del crash original.\n\n` +
          `*Acción manual requerida:*\n` +
          `1. Inspeccionar \`.pipeline/archived/partial-pause-rollback-*.json\` y \`.pipeline/archived/waves-rollback-*.json\`.\n` +
          `2. Decidir si restaurar manualmente o aceptar el estado actual.\n` +
          `3. Borrar \`.pipeline/wave-promote.failed.*.json\` cuando esté resuelto.\n\n` +
          `_Hasta entonces, \`/wave promote\` queda inhabilitado._`
        );
      } catch (e) {
        log('pulpo', `WARN [wave-recovery] no pude enviar alerta fail-closed: ${e.message}`);
      }
    } else if (promoteRecovery && promoteRecovery.action === 'in_progress') {
      log('pulpo', `[wave-recovery] marker fresco — transacción potencialmente activa, no actúo: ${promoteRecovery.reason}`);
    } else if (promoteRecovery && promoteRecovery.action === 'lock_lost') {
      log('pulpo', `[wave-recovery] otro proceso capturó el marker primero: ${promoteRecovery.reason}`);
    }
    // action='noop' → caso normal, sin log.
  } catch (e) {
    log('pulpo', `WARN [wave-recovery] boot hook falló: ${e.message}`);
  }

  // #3616 — Boot hook: seed inicial de waves.json desde .partial-pause.json.
  // CORRE ANTES del desync-detector (línea ~10855) para evitar el falso
  // positivo que generaría comparar `waves.allowlist=[]` (vacío) contra
  // `partial.allowlist=[3616, ...]` (operativo) — el desync-detector hoy lo
  // tolera con `no_waves_yet`, pero apenas el init complete, la canónica
  // queda poblada y la comparación pasa a ser estricta.
  //
  // Idempotente: si waves.json ya tiene active_wave, el init es no-op.
  // Fail-closed: si .partial-pause.json está malformado, NO toca waves.json.
  // Best-effort sobre el boot: si la lib falla por algo inesperado, NO
  // matamos el pulpo — preferimos arrancar con allowlist vacía que dejar
  // el pipeline fuera de servicio.
  try {
    const { initWavesFromPartial } = require('./scripts/init-waves-from-partial');
    const initResult = initWavesFromPartial();
    if (initResult.action === 'seeded') {
      log('pulpo', `[init-waves] waves.json sembrado: ola #${initResult.waveNumber} con ${initResult.allowlist.length} issue(s).`);
    } else if (initResult.action === 'aborted_invalid_partial') {
      log('pulpo', `WARN [init-waves] fail-closed: .partial-pause.json malformado. ${(initResult.errors || []).slice(0, 3).join('; ')}`);
    } else if (initResult.action === 'aborted_waves_corrupt') {
      log('pulpo', `WARN [init-waves] fail-closed: waves.json corrupto. ${(initResult.errors || []).slice(0, 3).join('; ')}`);
    } else if (initResult.action === 'noop_already_seeded') {
      log('pulpo', `[init-waves] noop — active_wave #${initResult.waveNumber} ya existente.`);
    } else {
      log('pulpo', `[init-waves] noop — ${initResult.reason || initResult.action}.`);
    }
  } catch (e) {
    log('pulpo', `WARN [init-waves] boot hook falló: ${e.message}`);
  }

  // #3518 CA-6 — Chequeo de desync al boot: compara waves.json contra
  // .partial-pause.json. Si hay mismatch, crea flag + alerta Telegram. El
  // human-block existente lo levanta y pausa los skills hasta intervención.
  // Si crashea por cualquier razón, NO mata al pulpo (best-effort).
  try {
    const desync = desyncDetector.detectDesync();
    if (desync.desync) {
      log('pulpo', `WARN desync-detector: ${desync.reason} added=${JSON.stringify(desync.added)} removed=${JSON.stringify(desync.removed)} flag=${desync.flag_path || 'no'}`);
    } else {
      log('pulpo', `desync-detector OK (${desync.reason || 'in_sync'})`);
    }
  } catch (e) {
    log('pulpo', `WARN desync-detector falló: ${e.message}`);
  }

  // #3508 CA-7 / UX-4 — Log de startup informativo del workaround Anthropic 1M.
  // Una sola línea que confirma al operador el estado del flag y los hits
  // acumulados. Si el JSON de session está corrupto, formatStartupLogLine cae
  // al estado vacío sin tirar (readState defensivo).
  try {
    const startupLine = oneMWorkaround.formatStartupLogLine({ sessionFile: SESSION_FILE });
    log('pulpo', startupLine);
  } catch (e) {
    log('pulpo', `WARN anthropic-1m startup log falló: ${e.message}`);
  }

  // #3085 / S7 — audit trail one-shot al boot: registrar qué env vars del
  // operador NO entraron en allowlist/scopes. Sin valores, solo nombre + hash
  // truncado SHA-256-12 para forensia (CA-10). Se escribe SIEMPRE (incluso
  // con env_isolation_enabled=false) — sirve como baseline para comparar
  // antes/después del flip a true.
  try {
    const dropped = buildChildEnvLib.auditDroppedEnvVars(process.env);
    const entry = buildChildEnvLib.formatAuditLogEntry({
      pid: process.pid,
      nodeVersion: process.version,
      osInfo: `${process.platform}-${process.arch}`,
      dropped,
    });
    const auditPath = path.join(LOG_DIR, 'env-allowlist-audit.log');
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    fs.appendFileSync(auditPath, entry);
    log('pulpo', `env-allowlist-audit: ${dropped.length} vars descartadas registradas en ${auditPath}`);
  } catch (e) {
    // Best-effort: si falla el audit, NO matar al pulpo. Es accesorio.
    log('pulpo', `WARN env-allowlist-audit falló: ${e.message}`);
  }

  // Confirmar restart solicitado desde Telegram. El pulpo anterior murió a
  // mitad del restart.js (cadena: pulpo → cmd → node restart.js, matada por
  // /T sobre el pulpo), así que el callback de exec() nunca enviaba el
  // mensaje de confirmación. Lo emite este nuevo pulpo al arrancar.
  try {
    const lastRestartPath = path.join(PIPELINE, 'last-restart.json');
    if (fs.existsSync(lastRestartPath)) {
      const data = JSON.parse(fs.readFileSync(lastRestartPath, 'utf8'));
      const ageMs = Date.now() - new Date(data.timestamp).getTime();
      const TWO_MINUTES = 2 * 60 * 1000;
      if (data.source === 'telegram' && !data.notified && ageMs < TWO_MINUTES) {
        const mode = data.mode || (data.paused ? 'pausado' : 'completo');
        sendTelegram(`✅ *Pipeline reiniciado* (modo ${mode})\n_Listo para recibir comandos._`);
        fs.writeFileSync(lastRestartPath, JSON.stringify({ ...data, notified: true }, null, 2));
        log('pulpo', `Restart ${mode} confirmado via Telegram (solicitado hace ${Math.round(ageMs / 1000)}s)`);
      }
    }
  } catch (e) {
    log('pulpo', `Warning: no pude verificar last-restart: ${e.message.slice(0, 100)}`);
  }

  // Migración one-shot del schema de skill-profiles (v1 → v2 delta)
  migrateSkillProfilesIfNeeded();

  // #2891 PR-B + #2892 PR-C — Arranque del detector de anomalías.
  // Lee `anomaly_detector` de config.yaml y dispara un setInterval interno
  // que persiste cada evaluación a `metrics-history.jsonl`. PR-C engancha
  // canales de alerta:
  //   - on 'anomaly' → raiseAlert() en rest-mode.json + sendTelegramAlert()
  //     (solo la primera vez de la racha; raiseAlert detecta wasAlreadyActive
  //      y devuelve shouldNotify=false en evaluaciones consecutivas).
  //   - on 'evaluation' (sin alerted) → recordBaselineCheck() para auto-clear
  //     cuando el consumo vuelve a baseline durante 2 chequeos consecutivos.
  // Si el constructor tira (ej. require fallido), el pulpo sigue corriendo:
  // el detector es accesorio, NO debe matar el loop.
  let anomalyDetector = null;
  try {
    const cfgRoot = loadConfig();
    const detectorCfg = (cfgRoot && cfgRoot.anomaly_detector) || {};
    anomalyDetector = new AnomalyDetector({ config: detectorCfg });
    for (const w of anomalyDetector.warnings) log('anomaly', `WARN: ${w}`);
    anomalyDetector.on('evaluation', (e) => {
      log('anomaly', `eval hour=${e.hour} actual=$${e.actual_usd} baseline=$${e.baseline_usd} ratio=${e.ratio} alerted=${e.alerted} reason=${e.reason}`);
      // CA-2.7 — auto-clear: si el chequeo NO está alertando y hay una
      // alerta activa, incrementamos el contador. A los 2 baseline checks
      // consecutivos, recordBaselineCheck() limpia la alerta solo.
      if (!e.alerted) {
        try {
          const result = restModeState.recordBaselineCheck({ pipelineDir: PIPELINE });
          if (result.cleared) {
            log('anomaly', `Auto-clear: alerta resuelta tras 2 chequeos consecutivos en baseline.`);
          }
        } catch (err) {
          log('anomaly', `recordBaselineCheck error: ${err.message}`);
        }
      }
    });
    anomalyDetector.on('anomaly', (e) => {
      // CA-2.6 + CA-2.7 — anomalía detectada. Persistimos el banner state
      // y, si es la primera vez de la racha (no estaba activo y no está
      // snoozed), encolamos un Telegram. Las re-emisiones de la MISMA
      // anomalía (cron sigue tickeando cada 10min) NO renotifican: queda
      // a cargo del operador acuse o silenciar.
      let snapshot = {};
      try {
        snapshot = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'metrics', 'snapshot.json'), 'utf8')) || {};
      } catch (_e) { /* snapshot ausente: top_skills vacío, alerta sigue */ }
      try {
        const { state, shouldNotify } = restModeState.raiseAlert(e, snapshot, { pipelineDir: PIPELINE });
        log('anomaly', `Banner activo (raised_at=${state.raised_at}, snoozed=${state.snoozed_until || 'no'}). shouldNotify=${shouldNotify}`);
        if (shouldNotify) {
          const result = costAnomalyAlert.sendTelegramAlert(e, snapshot, { pipelineDir: PIPELINE });
          if (result.ok) {
            log('anomaly', `Telegram alert encolado: ${path.basename(result.file)} (${result.text.length} chars)`);
          } else {
            log('anomaly', `Telegram alert NO encolado: ${result.reason}`);
          }
        }
      } catch (err) {
        log('anomaly', `raiseAlert/send error: ${err.message}`);
      }
    });
    anomalyDetector.on('error', (e) => log('anomaly', `ERROR: ${e.message}`));
    anomalyDetector.start();
    log('anomaly', `Detector iniciado: cada ${anomalyDetector.config.intervalMin}min, threshold +${Math.round(anomalyDetector.config.pctThreshold * 100)}%, warmup ${anomalyDetector.config.warmupDays}d`);
  } catch (e) {
    log('anomaly', `No se pudo iniciar el detector: ${e.message}`);
  }

  // #3080 / S1 multi-provider — Cron de rotación de credenciales.
  // Tick interno cada `credential_rotation.tick_ms` (default 1h). Lee
  // `docs/secrets-inventory.md`, calcula T-14/T-7/T-3/T-1/T-0 contra
  // `expires_at` (UTC), notifica al owner por Telegram. Idempotente:
  // estado en `.pipeline/credential-reminder-state.json`.
  // Si la primera evaluación falla (ej: inventory no existe en main aún),
  // NO matamos el pulpo — el cron es accesorio.
  try {
    const credentialRotationCron = require('./lib/credential-rotation-cron');
    const cfgRoot = loadConfig() || {};
    const tickMs = (cfgRoot.credential_rotation && cfgRoot.credential_rotation.tick_ms)
      || (60 * 60 * 1000);  // 1h default
    const runTick = () => {
      try {
        const result = credentialRotationCron.runRotationTick({
          pipelineDir: PIPELINE,
          now: new Date(),
          sendTelegramFn: sendTelegram,
          log: (msg) => log('credential-rotation', msg.replace(/^\[rotation-cron\] /, '')),
        });
        if (result.alerts && result.alerts.length > 0) {
          log('credential-rotation', `Tick generó ${result.alerts.length} alerta(s)`);
        }
        for (const e of result.errors || []) {
          log('credential-rotation', `WARN ${e.stage}: ${e.message}`);
        }
      } catch (err) {
        log('credential-rotation', `Tick excepción no capturada: ${err.message}`);
      }
    };
    // Primera evaluación al arrancar — útil cuando el pulpo restartea cerca
    // de un threshold y el operador no espera 1h por el aviso.
    runTick();
    setInterval(runTick, tickMs);
    log('credential-rotation', `Cron iniciado: tick cada ${Math.round(tickMs / 60000)}min`);
  } catch (e) {
    log('credential-rotation', `No se pudo iniciar el cron: ${e.message}`);
  }

  // #3087 — Cron interno autoritativo para alertas de cambios en agent-models.json.
  // Tickea cada AGENT_MODELS_CHECK_INTERVAL_MIN minutos. La idempotencia se basa
  // en el cursor `agent-models-last-notified.json` que el módulo persiste solo:
  // si HEAD == last_notified_sha → no re-emite. Sobrevive a reinicios sin perder
  // ni duplicar avisos (CA-A-1 / CA-A-2 / CA-S6).
  //
  // El módulo es accesorio: si tira excepción, el pulpo SIGUE corriendo. La
  // alerta es no-crítica para el funcionamiento del pipeline.
  const AGENT_MODELS_CHECK_INTERVAL_MIN = 5;
  let agentModelsTimer = null;
  try {
    const agentModelsAlert = require('./lib/agent-models-change-alert');
    const tickAgentModels = () => {
      try {
        const prev = agentModelsAlert.readLastNotifiedSha(PIPELINE);
        // CA-H-10 (post-rebote review #2): leer origin/main, NO HEAD local.
        // Si el pulpo arranca en una feature branch (caso real: agent/<n>-...),
        // HEAD apunta a commits que NUNCA llegaron a main y emitiríamos
        // alertas espurias. La rama protegida es origin/main por convención.
        //
        // Si origin/main no es resolvible (clones shallow, fetch fallido, repo
        // sin remote), salimos del tick — el cron es accesorio, mejor silenciar
        // que arriesgar falso positivo o falso negativo. El próximo tick reintenta.
        let headSha = null;
        try {
          headSha = require('child_process').execFileSync(
            'git',
            ['rev-parse', 'origin/main'],
            { cwd: ROOT, encoding: 'utf8', windowsHide: true }
          ).trim();
        } catch (e) {
          log('agent-models', `tick skip: no pude resolver origin/main (${e.message})`);
          return;
        }
        if (!headSha || headSha === prev) return;
        const result = agentModelsAlert.sendAlert(prev, headSha, { pipelineDir: PIPELINE, cwd: ROOT });
        if (result && result.alerts && result.alerts.length > 0) {
          for (const a of result.alerts) {
            // skills_affected viene del alertResult (review #3 / contrato sendAlert↔caller).
            const skills = Array.isArray(a.skills_affected) ? a.skills_affected.join(',') : '';
            log('agent-models', `Alerta encolada: from=${a.firstSha?.slice(0,7)} to=${a.lastSha?.slice(0,7)} commits=${a.commitCount} skills=[${skills}] coCommit=${a.coCommitSensitive}`);
          }
        }
      } catch (err) {
        log('agent-models', `tick error: ${err.message}`);
      }
    };
    // Primer tick post-arranque (delay corto), después intervalo regular.
    setTimeout(tickAgentModels, 30 * 1000);
    agentModelsTimer = setInterval(tickAgentModels, AGENT_MODELS_CHECK_INTERVAL_MIN * 60 * 1000);
    log('agent-models', `Cron iniciado: cada ${AGENT_MODELS_CHECK_INTERVAL_MIN}min, cursor en .pipeline/agent-models-last-notified.json`);
  } catch (e) {
    log('agent-models', `No se pudo iniciar el cron: ${e.message}`);
  }

  // #3508 CA-4 — Tick periódico del TTL del workaround Anthropic 1M.
  // Cada hora chequea si pasaron >14 días sin hits y el flag sigue activo →
  // emite alerta Telegram con cooldown 7 días. Reusa el módulo
  // anthropic-1m-workaround (decisión centralizada, sin lógica de fechas acá).
  // Si tira, NO mata el pulpo (es accesorio, igual que agent-models).
  const ANTHROPIC_1M_TTL_CHECK_INTERVAL_MIN = 60;
  try {
    const tickAnthropic1mTtl = () => {
      try {
        const decision = oneMWorkaround.checkTtlAlert({ sessionFile: SESSION_FILE });
        if (decision.corrupt && decision.corrupt.length > 0) {
          // SEC-4: si la corrupción fue en last_alert_sent_at, readState ya lo
          // reseteó a null, así que el tick puede continuar y emitir.
          log('commander', `[anthropic-1m] session_corrupt en tick TTL: ${JSON.stringify(decision.corrupt)}`);
        }
        if (!decision.shouldEmit) {
          return; // razones: flag_disabled | no_hits_ever | ttl_not_reached | cooldown_active.
        }
        // CA-6 + UX-2: mensaje canónico construido por el módulo.
        const body = oneMWorkaround.formatTtlAlertMessage({ sessionFile: SESSION_FILE });
        try { sendTelegramPlain(body); } catch { /* best-effort */ }
        // CA-4 / SEC-6: persistir last_alert_sent_at para activar el cooldown.
        oneMWorkaround.recordAlertSent({ sessionFile: SESSION_FILE });
        log('commander', `[anthropic-1m] alerta TTL emitida (último hit=${decision.state.last_hit_at}, hits=${decision.state.hits_total}). Cooldown ${oneMWorkaround.COOLDOWN_DAYS}d activo.`);
      } catch (e) {
        log('commander', `[anthropic-1m] tick TTL error (best-effort): ${e.message}`);
      }
    };
    // Primer tick a los 5min post-arranque, después cada hora.
    setTimeout(tickAnthropic1mTtl, 5 * 60 * 1000);
    setInterval(tickAnthropic1mTtl, ANTHROPIC_1M_TTL_CHECK_INTERVAL_MIN * 60 * 1000);
    log('commander', `[anthropic-1m] cron TTL iniciado: cada ${ANTHROPIC_1M_TTL_CHECK_INTERVAL_MIN}min`);
  } catch (e) {
    log('commander', `[anthropic-1m] no pude iniciar cron TTL: ${e.message}`);
  }

  // #3638 CA-F-7 — Ghost-artifact cleaner: barre carpetas operacionales en
  // busca de artifacts huérfanos (.comment.md/.guidance.txt/.reason.json de
  // issues CERRADOS sin marker activo) y los archiva en
  // .pipeline/archivado/ghost-<ts>/. Audit log JSONL en
  // .pipeline/audit/ghost-artifacts-cleanup.jsonl.
  //
  // Best-effort: si falla, NO mata el pulpo (el cleaner ya hace fail-safe
  // interno por gh down, lock busy, etc.). Primer tick a los 2min post-arranque
  // para no competir con el resto del boot; reintervalo cada 6h.
  try {
    const ghostCleaner = require('./lib/ghost-artifact-cleaner');
    const GHOST_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas
    const runGhostTick = async () => {
      try {
        const result = await ghostCleaner.runWithLock({
          mode: 'execute',
          repoRoot: ROOT,
          pipelineRoot: PIPELINE,
        });
        if (result.lockSkip) {
          log('pulpo', `[ghost-artifact] tick skip — lock busy`);
        } else if (result.aborted) {
          log('pulpo', `[ghost-artifact] tick abort — ${result.errors} errores`);
        } else {
          log('pulpo', `[ghost-artifact] tick OK — scanned=${result.scanned} archived=${result.archived} skipped=${result.skipped} errors=${result.errors} duration=${result.durationMs}ms`);
        }
      } catch (e) {
        log('pulpo', `WARN [ghost-artifact] tick exception: ${e.message}`);
      }
    };
    setTimeout(runGhostTick, 2 * 60 * 1000);
    setInterval(runGhostTick, GHOST_INTERVAL_MS);
    log('pulpo', `[ghost-artifact] cron iniciado: cada ${GHOST_INTERVAL_MS / (60 * 60 * 1000)}h`);
  } catch (e) {
    log('pulpo', `WARN [ghost-artifact] no pude iniciar cron: ${e.message}`);
  }

  // #3625 CA-3 — Cron de cleanup de TTLs de autoría heredada
  // (recursive-deps:from-N). Cada hora chequea si hay issues en la allowlist
  // cuya autorización heredada venció (48h por default) y los remueve con
  // authorizedBy: 'pulpo:cleanup'. Si tira, no mata el pulpo (accesorio).
  const RECURSIVE_TTL_CHECK_INTERVAL_MIN = 60;
  try {
    const tickRecursiveTtl = () => {
      try {
        const recursivePromote = require('./lib/allowlist-recursive-promote');
        const result = recursivePromote.expireRecursiveAuthorizations();
        if (result.expired && result.expired.length > 0) {
          log('commander', `[recursive-ttl] removidos por TTL expirado: ${result.expired.join(',')}`);
        }
      } catch (e) {
        log('commander', `[recursive-ttl] tick error (best-effort): ${e.message}`);
      }
    };
    // Primer tick 10min post-arranque, después cada hora.
    setTimeout(tickRecursiveTtl, 10 * 60 * 1000);
    setInterval(tickRecursiveTtl, RECURSIVE_TTL_CHECK_INTERVAL_MIN * 60 * 1000);
    log('commander', `[recursive-ttl] cron iniciado: cada ${RECURSIVE_TTL_CHECK_INTERVAL_MIN}min`);
  } catch (e) {
    log('commander', `[recursive-ttl] no pude iniciar cron: ${e.message}`);
  }

  // #3625 CA-1 — Cron de verificación de hash-chain del audit log de
  // mutaciones a allowlist. Cada 30min ejecuta verifyChain(); si rompe,
  // alerta Telegram con severidad alta. NO bloquea writes (eso lo hace el
  // verifyChain on-startup más arriba — acá es defense-in-depth periódica).
  const PARTIAL_PAUSE_AUDIT_VERIFY_INTERVAL_MIN = 30;
  try {
    const tickAuditVerify = () => {
      try {
        const ppa = require('./lib/partial-pause-audit');
        const result = ppa.verifyChain();
        if (!result.ok) {
          const msg = `🚨 [audit-chain-broken] El hash-chain de partial-pause-mutations.jsonl está roto en entry ${result.brokenAt}.\n` +
                      `Razón: ${result.reason}\n` +
                      `Esto indica corrupción o tampering. Investigar de inmediato.`;
          try { sendTelegramPlain(msg); } catch { /* best-effort */ }
          log('audit', msg);
        }
      } catch (e) {
        log('audit', `[partial-pause-audit] verifyChain falló (best-effort): ${e.message}`);
      }
    };
    // Primer tick a los 2min post-arranque (boot), después cada 30min.
    setTimeout(tickAuditVerify, 2 * 60 * 1000);
    setInterval(tickAuditVerify, PARTIAL_PAUSE_AUDIT_VERIFY_INTERVAL_MIN * 60 * 1000);
    log('audit', `[partial-pause-audit] verifyChain cron iniciado: cada ${PARTIAL_PAUSE_AUDIT_VERIFY_INTERVAL_MIN}min`);
  } catch (e) {
    log('audit', `[partial-pause-audit] no pude iniciar cron de verifyChain: ${e.message}`);
  }

  while (running) {
    try {
      checkPauseFile();
      checkDesyncFlag();

      const config = loadConfig(); // Reload cada ciclo para hot-reload

      // Commander corre ASYNC — no bloquea el loop principal
      // El singleton check dentro de brazoCommander evita ejecuciones concurrentes
      brazoCommander(config).catch(e => log('commander', `Error async: ${e.message}`));

      // Drain outbox de Telegram (context-relay, notificaciones, etc.)
      try {
        const outbox = require(path.join(ROOT, '.claude', 'hooks', 'telegram-outbox'));
        await outbox.drainQueue();
      } catch (e) {}

      // Context bridge tick (sync preguntas pendientes, relay, cleanup)
      try {
        const bridge = require(path.join(ROOT, '.claude', 'hooks', 'context-bridge'));
        bridge.tick();
      } catch (e) {}

      // Priority windows: evaluar SIEMPRE, incluso pausado.
      // Sin esto, una ventana activa queda "pegada" cuando se pausa el pipeline
      // porque brazoLanzamiento (que antes evaluaba) no corre en modo pausado.
      readManualPriorityOverrides();
      evaluateQaPriority(config);
      evaluateBuildPriority(config);

      // #2975 — Poll del flag de cuota Anthropic. Corre SIEMPRE (incluso
      // pausado) para que el notifier dispare cierre cuando se borra el flag,
      // independiente del estado de pausa del pipeline.
      try { pollQuotaFlag(); } catch (e) { log('quota', `pollQuotaFlag error: ${e.message}`); }

      // #3260 — Healthcheck multi-provider. Corre SIEMPRE (idempotente, con
      // lock + jitter ±60s anti-thundering-herd). El módulo decide internamente
      // si toca tickear (cada 15min) y si toca check semanal de keys. No
      // dispara LLM ni completion — solo /v1/models. Fire-and-forget.
      try {
        const healthCron = require(path.join(PIPELINE, 'lib', 'multi-provider', 'health-cron'));
        healthCron.tickIfDue({}).catch(e => log('mp-health', `tickIfDue error: ${e.message}`));
      } catch (e) {
        // require puede fallar si el módulo no existe (build viejo); no es fatal.
      }

      if (!paused && !desyncBlocked) {
        rotateHistory();          // Housekeeping: rotar historial > 24hs
        persistMetricsSnapshot(config); // Métricas históricas para /metrics

        // #2317: precheck de conectividad ANTES de cualquier lanzamiento.
        // Corre con cache (PRECHECK_MIN_INTERVAL_MS) así no spamea DNS en
        // cada ciclo. Si transiciona de fail→ok, reencolamos issues
        // bloqueados por infra inmediatamente.
        const wasFailing = lastPrecheckResult ? !lastPrecheckResult.ok : false;
        await ejecutarPrecheck(config);
        if (wasFailing && precheckOk()) {
          reencolarInfraBloqueados(config);
        }

        brazoIntake(config);      // Segundo: traer trabajo nuevo de GitHub
        // #2801 — desbloqueo en background (fire-and-forget). Antes era síncrono
        // y bloqueaba el loop por ~30 min cuando había muchas dependencias
        // fantasma que tiraban GraphQL errors. Ahora corre async sin frenar
        // barrido ni lanzamiento; el guard interno previene re-entrada.
        brazoDesbloqueo(config).catch(e => log('desbloqueo', `error en brazo async: ${e.message}`));
        brazoBarrido(config);     // Cuarto: promover entre fases
        brazoLanzamiento(config); // Quinto: asignar trabajo a agentes
        brazoHuerfanos(config);   // Sexto: recuperar trabajo trabado
        // #3416 — rewind del operador (fire-and-forget). Procesa eventos en
        // `.pipeline/rejections/<issue>-<unix-ts>.json` (escritos por el
        // Commander #3441) y rebobina el issue a la fase indicada. No bloquea
        // el loop.
        brazoRewind(config).catch(e => log('rewind', `error en brazo async: ${e.message}`));
        // #2893: detección periódica de deps faltantes en pausa parcial (cada N ticks).
        // Fire-and-forget: consulta gh con cache TTL 5min, no bloquea el loop.
        brazoPartialPauseDeps(config).catch(e => log('pulpo', `[partial-pause-deps] error async: ${e.message}`));
        // #3259 / CA-4 + CA-10: brazo de retry de provider-exhaustion-pause.
        // Cada `retry_interval_ms` (clampeado a piso 60s) revisa issues con
        // label `provider-exhaustion-pause` y los destraba si algún provider
        // de su chain se liberó. Fire-and-forget — no bloquea el loop.
        brazoProviderExhaustionRetry(config);
      } else if (paused) {
        log('pulpo', 'PAUSADO — esperando reanudación (borrar .pipeline/.paused)');
      } else {
        // #3518 CA-6 — desync detectado. Loop alive pero NO se dispatcha.
        // Solo logueamos cada N ticks (1 cada ~5min) para no inundar.
        desyncBlockedNotifiedTick = (desyncBlockedNotifiedTick + 1) % 10;
        if (desyncBlockedNotifiedTick === 1) {
          log('pulpo', 'BLOQUEADO POR DESYNC — dispatch suspendido. Auditar y borrar .pipeline/.desync-detected.flag para reanudar.');
        }
      }
    } catch (e) {
      log('pulpo', `ERROR en ciclo: ${e.message}`);
    }

    // Sleep
    const sleepMs = (loadConfig().timeouts?.poll_interval_seconds || 30) * 1000;
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('pulpo', 'SIGINT recibido — cerrando');
  try { quotaNotifier.dispose(); } catch {}
  running = false;
});
process.on('SIGTERM', () => {
  log('pulpo', 'SIGTERM recibido — cerrando');
  try { quotaNotifier.dispose(); } catch {}
  running = false;
});
// El timer del AnomalyDetector está `unref`'d → muere con el proceso.

// --- MODO TEST: permitir require() del archivo sin arrancar el pulpo ---
// Uso: PULPO_NO_AUTOSTART=1 node -e "require('./pulpo.js').predictResourceImpact(...)"
// Útil para tests unitarios y scripts de evidencia del gate predictivo.
if (process.env.PULPO_NO_AUTOSTART === '1') {
  module.exports = {
    predictResourceImpact,
    getEstimatedImpact,
    measureEmulatorMemPercent,
    recordSkillResourceUsage,
    loadSkillProfiles,
    saveSkillProfiles,
    migrateSkillProfilesIfNeeded,
    SKILL_PROFILES_SCHEMA_VERSION,
    QA_INFRA_SKILLS,
    // #3140 — whitelist de skills que disparan preflight QA / emulador en verificacion.
    SKILLS_THAT_NEED_EMULATOR,
    shouldRunQaPreflight,
    MAX_EST_MEM,
    MAX_EST_CPU,
    // #2317 — precheck de conectividad
    NETWORK_REQUIRED_PHASES,
    ejecutarPrecheck,
    precheckOk,
    marcarBloqueoInfra,
    reencolarInfraBloqueados,
    // #2335 — connectivity-state + clasificacion de reason
    mapPrecheckFailureToReason,
    connectivityState,
    // #2404 — exponer utilidades de staleness al test de integración.
    staleness,
    _precheckState: () => ({ lastPrecheckResult, lastPrecheckAt, lastInfraBlockedIssues: Array.from(lastInfraBlockedIssues) }),
    _setPrecheckState: (r) => { lastPrecheckResult = r; lastPrecheckAt = Date.now(); },
    _resetPrecheckState: () => { lastPrecheckResult = null; lastPrecheckAt = 0; lastPrecheckOkStreak = 0; lastInfraBlockedIssues = new Set(); },
    // #2516 — cross-phase rebote: utilidades para tests.
    MAX_CROSSPHASE_REBOTES,
    getFaseGlobalOrder,
    faseGlobalIndex,
    findPreviousFaseForSkill,
    validateRebotedDestino,
    resolveRebotedCrossPhase,
    // #2651 — QA priority window: cola dispara activación, no-progreso + cooldown.
    evaluateQaPriority,
    countRunningVerificacion,
    countPendingVerificacion,
    persistPriorityWindows,
    _getQaPriorityState: () => ({ qaPriorityActive, qaPriorityActivatedAt, qaFirstBlockedAt, qaPriorityManual, qaPriorityNotifiedTelegram, qaPrioritySafetyNotified, qaNoProgressSince, qaCooldownUntil }),
    _resetQaPriorityState: () => { qaPriorityActive = false; qaPriorityActivatedAt = 0; qaFirstBlockedAt = 0; qaPriorityManual = false; qaPriorityNotifiedTelegram = false; qaPrioritySafetyNotified = false; qaNoProgressSince = 0; qaCooldownUntil = 0; },
    _setQaNoProgressSince: (ts) => { qaNoProgressSince = ts; },
    _setQaCooldownUntil: (ts) => { qaCooldownUntil = ts; },
    _setQaPriorityActive: (active, activatedAt) => { qaPriorityActive = active; qaPriorityActivatedAt = activatedAt || (active ? Date.now() : 0); qaPriorityNotifiedTelegram = active; },
    _setBuildPriorityState: (active, manual) => { buildPriorityActive = active; buildPriorityManual = manual || false; },
    // #2893 — resolver de script determinístico (preferencia worktree-first).
    resolveDeterministicScript,
    // #2957 — counter de fase build expuesto para tests del filtro por allowlist.
    countPendingBuild,
    // #3059 — wrapper robusto + watchdog del brazo de desbloqueo (testing).
    _ghCallWithTimeout,
    _sanitizeGhArgs,
    _checkAndResetUnblockWedge,
    _maybeLogReentrySkip,
    UNBLOCK_WEDGE_TIMEOUT_MS,
    REENTRY_LOG_COOLDOWN_MS,
    _getUnblockState: () => ({
      running: _unblockRunning,
      startedAt: _unblockStartedAt,
      activePid: _unblockActivePid,
      reentryLastWarn: _unblockReentryLastWarn,
    }),
    _setUnblockState: (s) => {
      if ('running' in s) _unblockRunning = !!s.running;
      if ('startedAt' in s) _unblockStartedAt = Number(s.startedAt) || 0;
      if ('activePid' in s) _unblockActivePid = s.activePid === null ? null : (Number.isInteger(s.activePid) ? s.activePid : null);
      if ('reentryLastWarn' in s) _unblockReentryLastWarn = Number(s.reentryLastWarn) || 0;
    },
    _getLastUnblockTime: () => lastUnblockTime,
    _setLastUnblockTime: (ts) => { lastUnblockTime = Number(ts) || 0; },
  };
  return; // No arrancar singleton ni mainLoop
}

// --- VALIDACIÓN agent-models.json (#3081, multi-provider §6.6/§6.9/§6.10) ---
// Boot fail-fast antes de adquirir el singleton: si agent-models.json no parsea,
// no valida contra el schema, o tiene cross-references rotas (default_provider,
// skill→provider, placeholders, denylist de flags), abortar con exit code 2 y
// mensaje accionable de 4 líneas. El operador corrige el JSON y reintenta.
//
// Escape hatch: PULPO_SKIP_AGENT_MODELS_VALIDATE=1 salta la validación. Sólo
// para recuperación de emergencia — registra un warning visible para que
// nadie lo use de default.
if (process.env.PULPO_SKIP_AGENT_MODELS_VALIDATE !== '1') {
  try {
    const agentModelsValidate = require('./lib/agent-models-validate');
    agentModelsValidate.validateOrExit({
      contextLabel: 'boot abortado',
      // checkEnv:true (re-activado en #3154 después del fix temporal de #3153).
      // validateCredentialsEnvPresence hace bypass de providers con
      // `launcher: "claude"` (auth OAuth vía CLI, no env var). Cualquier
      // otro launcher (codex/gemini/ollama/node) que declare credentials_env
      // sigue exigiendo presencia de la env var al boot. Esto gateá la
      // activación de openai-codex (OPENAI_API_KEY) sin romper el setup
      // actual donde todos los skills usan launcher=claude.
      checkEnv: true,
    });
  } catch (err) {
    // Si el módulo de validación mismo crasha (no debería: ajv/loadSchema están
    // todos try/catch internos), abortar con exit 1 (excepción no controlada)
    // antes que dejar el pulpo corriendo con config no validada.
    process.stderr.write(`[validate] FATAL excepción cargando agent-models-validate: ${err.stack || err.message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('[validate] WARN agent-models validation SKIPPED via PULPO_SKIP_AGENT_MODELS_VALIDATE=1\n');
}

// --- VALIDACIÓN FORCE_PROVIDER_OVERRIDE (#3680 CA-A9) ---
// Boot fail-fast: este flag es exclusivo del harness multi-provider-smoke-test
// (per-spawn env del child). Si está presente en process.env del pulpo padre,
// es bug operativo (export accidental por el operador) o intento de bypass
// productivo. Cualquiera de los dos rompe la disciplina de routing — abortar
// con exit 2 + mensaje accionable de 1 línea. Coherente con el resto de
// validators (agent-models, data-residency) que ya usan exit 2.
//
// Escape hatch: PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 acepta el flag igual.
// SÓLO para emergencias de operación documentadas (rollback, debugging
// excepcional). Loguea warning visible para que nadie lo use de default.
if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE !== '1') {
  process.stderr.write(
    '[boot] FATAL FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo — ' +
    'uso exclusivo del harness multi-provider-smoke-test via env override del ' +
    'spawn child. Unset la variable (`set FORCE_PROVIDER_OVERRIDE=` en Windows, ' +
    '`unset FORCE_PROVIDER_OVERRIDE` en bash) y reintentar.\n'
  );
  process.exit(2);
} else if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE === '1') {
  process.stderr.write(
    '[boot] WARN FORCE_PROVIDER_OVERRIDE presente con PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 — ' +
    'pipeline corre en modo override forzado. Sólo para emergencias documentadas.\n'
  );
}

// --- VALIDACIÓN data-residency-exclusions.json (#3084, multi-provider §6.4) ---
// Boot fail-closed antes de adquirir el singleton: si el sidecar de exclusiones
// data-residency no carga, no parsea o no valida contra el schema, abortar con
// exit code 2 y mensaje accionable. Coherente con la disciplina del filtro
// (data-residency-filter.js): el adapter no-Anthropic NUNCA arranca con sidecar
// inválido — política de fail-closed para evitar leaks silenciosos.
//
// Escape hatch: PULPO_SKIP_DATA_RESIDENCY_VALIDATE=1 salta la validación. Sólo
// para recuperación de emergencia.
if (process.env.PULPO_SKIP_DATA_RESIDENCY_VALIDATE !== '1') {
  try {
    const dataResidencyFilter = require('./lib/data-residency-filter');
    dataResidencyFilter.validateOrExit({
      contextLabel: 'boot abortado',
    });
  } catch (err) {
    process.stderr.write(`[data-residency] FATAL excepción cargando data-residency-filter: ${err.stack || err.message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('[data-residency] WARN data-residency validation SKIPPED via PULPO_SKIP_DATA_RESIDENCY_VALIDATE=1\n');
}

// --- SINGLETON ---
require('./singleton')('pulpo');

// Signal ready — singleton adquirido, mainLoop arranca
try { require('./lib/ready-marker').signalReady('pulpo'); } catch {}

mainLoop().then(() => {
  log('pulpo', 'Pulpo finalizado');
  process.exit(0);
});

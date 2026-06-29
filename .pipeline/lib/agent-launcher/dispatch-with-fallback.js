// =============================================================================
// dispatch-with-fallback.js — Consumer runtime del array `skill.fallbacks[]`.
//
// Issue: #3198 (consumer runtime de skill.fallbacks).
//
// Hasta este módulo, el campo `skills.<name>.fallbacks: []` de
// `agent-models.json` estaba **soportado en schema + validado + editable
// desde UI + diffeable** (PR #3177 entregó la cadena) pero NO había consumer
// en runtime. Si el provider primario quedaba gateado por cuota agotada,
// el archivo de trabajo volvía a `pendiente/` y se quedaba esperando reset,
// sin intentar con los providers declarados como fallback.
//
// Este módulo cierra esa promesa: cuando `shouldGateSpawn(skill, {provider})`
// bloquearía al primario, iteramos `fallbacks[]` y devolvemos la primera
// resolución no-gated.
//
// ARQUITECTURA
// -----------
// El dispatcher corre **pre-spawn**, en el mismo punto del flow que el gate
// global (pulpo.js → bloque `shouldGateSpawn`). Es pasivo: NO cambia el
// flow del happy path (primario disponible) — sólo entra en juego cuando
// hay flag de cuota activo para el provider primario del skill.
//
// El gate del pulpo evoluciona de:
//   if (shouldGateSpawn(skill, { provider: primary })) → mover a pendiente/.
// a:
//   const r = resolveSpawnWithFallback({...});
//   if (r.gated) → mover a pendiente/, sino spawn con r.provider/r.model.
//
// POLÍTICA DUAL (§4.1 doc canónico)
// ---------------------------------
// - **Cross-MODELO** (mismo provider, distinto modelo): N/A en este PR. El
//   array `fallbacks[]` lista provider names — no soporta cross-modelo
//   per-skill. Cross-modelo se hace via `model_override` + selector
//   autónomo (`docs/pipeline-multi-provider.md` §4.3, fuera del scope #3198).
// - **Cross-PROVIDER** (provider distinto del primario): EL OPT-IN HUMANO ES
//   LA DECLARACIÓN DEL ARRAY EN AGENT-MODELS.JSON. La UI dashboard #3177
//   permite agregar/quitar fallbacks con confirmación humana — esa edición
//   ES la aprobación. No agregamos doble barrera porque rompería la promesa
//   "configurá fallbacks y el pipeline sigue funcionando" del issue.
//
//   La defensa adicional (S-6 del análisis de security) es:
//     1) audit log con hash-chain SHA-256 (`logs/cross-provider-dispatch-*.jsonl`)
//     2) notificación Telegram via queue de archivos (sin LLM en el camino)
//     3) cap de profundidad MAX_FALLBACK_DEPTH (5)
//     4) anti-cycle con `Set<providerName>` ya intentados
//     5) skip si el fallback comparte el provider gated (mismo flag scope).
//
// DEFENSAS DE SEGURIDAD (S-1 a S-9 del análisis security en el issue)
// -------------------------------------------------------------------
// S-1: Detección de cuota delegada a `quotaModule.shouldGateSpawn` —
//      reutilizamos shape estructural, NUNCA matcheamos por substring.
// S-2: Aislamiento de credenciales — este módulo NO arma env del child. El
//      caller (pulpo.js) ya invoca `env-isolation` con el provider resuelto,
//      así que cuando devolvemos un fallback el env queda construido a
//      partir del handler del fallback, no del primario.
// S-3: Validación del nombre del provider — invocamos `getProviderHandler`
//      contra la tabla hardcoded; el boot-time validator ya garantiza que
//      cada item del array está en `providers`.
// S-4: Path traversal en flag de pending — N/A acá (no escribimos pending
//      flag por skill: el opt-in es la presencia del array en config).
// S-5: Cycle/depth limit — MAX_FALLBACK_DEPTH=5 + Set<providerName> ya intentados.
// S-6: Sanitización del audit log — passthrough a `audit-log.appendChained`,
//      que ya redacta con hash-chain. raw_excerpt pasa por
//      `quotaModule.sanitizeRawExcerpt` antes de ir al log.
// S-7: Política dual — opt-in vía presencia del array (decisión PO).
// S-8: Quota flag scoping — el fallback NO limpia el flag del primario.
//      `clearFlag` ya respeta scope per-provider (#3077 CA-8).
// S-9: Telegram via filesystem queue — escribimos a
//      `.pipeline/servicios/telegram/pendiente/<ts>.json`, NO curl directo.
//
// SIN dependencias externas (Node puro: fs, path, crypto via audit-log).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #4052 — clasificador puro de "muerte al spawnear del provider". Distingue una
// muerte de spawn-failure (infra del provider) de un fallo legítimo del issue,
// para que onSpawnExit emita `decision: 'provider-spawn-failure'` y el caller no
// penalice el retry del issue (CA-3 / SEC-3).
const { classifySpawnFailure } = require('./spawn-failure-classifier');

// #4274 — `resolvePermissionMode` se suma al destructuring existente para
// resolver el modo canónico del provider de FALLBACK en su return (codex →
// 'full-auto', free providers → 'bypassPermissions'). Sin esto el fallback
// perdía el `mode` y el launcher caía a un default fail-open peligroso.
// `resolve-provider` ya se importa acá sin ciclo de require — solo sumamos un símbolo.
const { resolveProviderForSkill, getProviderHandler, resolvePermissionMode } = require('./resolve-provider');
// MP-05 (#3803) — reutilizamos la validación de credenciales del precheck del
// Commander para hacer pre-check de credenciales también en los skills antes de
// elegir un fallback (no solo el Commander la tenía).
const { _validateProviderCredentials: validateProviderCredentials } = require('../commander/credentials-precheck');

// #3811 — Kill-switch operacional por provider. Apagar un provider acá ordena
// el salto a fallback (semántica de "caída en runtime"), distinto del gate de
// cuota (semántica de "esperar reset"). Carga perezosa vía default param para
// poder inyectar un fake en los tests sin require cruzado.
const providerDisabledModule = require('../provider-disabled');

// #3871 — Horarios de actividad por provider. Si "ahora" cae en una ventana OFF
// del provider, se salta al siguiente eslabón igual que el kill-switch, pero con
// semántica de "fuera de horario" (no es una caída ni una cuota agotada).
// Inyectable en tests vía opts.scheduleModule.
const providerScheduleModule = require('../provider-schedule');

// #4282 — Degradación preventiva por cuota (soft-gate). Si el guard marcó un
// provider para degradación preventiva y el marker está vigente, el primary se
// trata como "soft-gated": preferimos el primer fallback resoluble. A diferencia
// del hard gate (cuota agotada / kill-switch / horario), el soft NUNCA vacía la
// chain ni pausa: si no hay fallback resoluble, se usa el primary igual
// (REQ-SEC-3). Inyectable en tests vía opts.softGateModule.
const providerQuotaGuardModule = require('../provider-quota-guard');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// S-5: cap de profundidad de la chain para evitar recursión patológica.
// 5 es generoso para la mayoría de configs (Anthropic → OpenAI → Gemini → ...).
const MAX_FALLBACK_DEPTH = 5;

// =============================================================================
// #3576 — Hook `onSpawnExit` cross-skill
// =============================================================================
//
// Centraliza el parseo del raw output post-spawn y la decisión de set/clear
// flag de cuota. Antes de #3576 había dos call sites inline en pulpo.js
// (skills + commander) con shapes distintos. Esta función unifica el wire.
//
// CONTRATO PÚBLICO (#3576 CA-2)
// -----------------------------
//   onSpawnExit({
//     skill,                  // nombre del skill (string, requerido)
//     provider,               // provider efectivo del spawn (string, requerido)
//     transport,              // 'api' | 'cli' (string, requerido)
//     rawOutput,              // string con stderr / output del child
//     exitCode,               // number | null
//     timedOut,               // boolean
//     durationMs,             // number ms desde spawn hasta exit
//     firstByteAt,            // (opt) timestamp del primer byte SSE recibido
//     issue,                  // (opt) número de issue para audit
//     pipelineDir,            // (opt) override para tests
//     parserModule,           // (opt) override para tests
//     quotaModule,            // (opt) override para tests
//     auditLog,               // (opt) override require('../audit-log')
//     fsImpl,                 // (opt) override fs
//     onLog,                  // (opt) callback(level, msg) — best-effort logging
//     now,                    // (opt) Date.now() override
//   }) → {
//     errorClass,             // 'quota_exhausted' | 'rate_limit' | 'transient_5xx' |
//                             // 'auth' | 'permanent_failure' | 'cli_1m_context_glitch' |
//                             // 'unknown'
//     shouldFallback,         // bool — política de fallback recomendada
//     retriable,              // bool — si reintentar el mismo provider tiene sentido
//     raw,                    // string saneado por sanitizeRawExcerpt (max 200c)
//     evidence,               // string saneado de la línea/frame que disparó
//     flagSet,                // bool — si invocamos setFlag (quota_exhausted / rate_limit)
//     auditLogged,            // bool — si emitimos audit entry
//     decision,               // 'flag_set' | 'fallback' | 'ignore'
//     codepath,               // 'generalized' (siempre acá; el legacy mantiene 'legacy')
//   }
//
// GARANTÍAS DE SEGURIDAD (#3576 NEW-1 + SR-1..SR-9)
// -------------------------------------------------
// - **Never throws**: cualquier excepción del parser/setFlag/audit se atrapa
//   y se devuelve un veredicto neutro (`errorClass: 'unknown'`). El
//   `child.on('exit')` lifecycle del caller NO se rompe.
// - **Sanitización**: el `raw` y `evidence` que se devuelven al caller ya
//   pasaron por `quotaModule.sanitizeRawExcerpt`. AKIA/JWT/sk-* nunca llegan
//   a logs ni Telegram.
// - **Audit log unificado** (#3576 CA-8): shape `{ ts, skill, provider,
//   transport, errorClass, evidence, shouldFallback }` con hash-chain SHA-256
//   via `appendChained`. Mismo shape para skills y commander.
// - **SIN escritura a `.pipeline/handoff/`**: el hook NO toca el canal
//   cross-agente. Si el caller quiere narrarlo, lo hace por separado.
// - **SR-6**: el parser NO llama setFlag; el hook SÍ, pero SOLO si
//   `errorClass ∈ {quota_exhausted, rate_limit}` y el errorType extraído
//   está en `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider]`.
// =============================================================================

// Feature flag operativo (#3576 CA-9): controla el wire desde pulpo.js. El
// hook en sí siempre está disponible para tests y rollouts manuales — la
// variable solo influye en pulpo.js#postSpawn (legacy vs generalized).
// Default '0' (OFF) en `main` para minimizar blast-radius hasta que la
// paridad esté validada por ola (ver docs/pipeline/multi-provider.md).
const FEATURE_FLAG_NAME = 'PIPELINE_GENERALIZED_PARSER_ENABLED';
function isGeneralizedParserEnabled(envOverride) {
    const env = envOverride || process.env || {};
    return env[FEATURE_FLAG_NAME] === '1';
}

// Discriminadores visuales (#3576 CA-3 + UX). Reservados para logs TEXTUALES
// (`onLog`/`log('lanzamiento', ...)`) — NUNCA escribimos estos glyphs en
// campos JSON del audit log para no romper consumers que parsean línea por
// línea.
const CODEPATH_EMOJI = Object.freeze({
    legacy: '🛡️',
    generalized: '🆕',
});

// Audit log dedicado a la decisión post-spawn unificada (#3576 CA-8).
// Convención: archivo dedicado distinto del `cross-provider-dispatch-*`
// para separar "decisión pre-spawn de fallback" (CA-1 del dispatcher) de
// "clasificación post-spawn del error real" (CA-2 del hook). Mismo
// directorio `.pipeline/logs/`, rotación diaria.
function spawnExitAuditFile(pipelineDir, now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir, 'logs', `spawn-exit-${yyyy}-${mm}-${dd}.jsonl`);
}

// #4052 SEC-1 — el spawn-exit JSONL puede contener excerpts de stderr (ya
// sanitizados). Garantizamos que el archivo se cree con permisos 0o600, ya que
// `audit-log.appendChained` usa `appendFileSync` sin mode explícito. Best-effort
// e idempotente: en Windows el mode es nominal, pero en POSIX cierra el archivo
// a solo-dueño. Nunca tira.
function ensureSecureAuditFile(file, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        _fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = _fs.openSync(file, 'a', 0o600);
        _fs.closeSync(fd);
        try { _fs.chmodSync(file, 0o600); } catch { /* best-effort (Windows) */ }
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// _selectErrorTypeForFlag — réplica del helper del Commander
// (lib/commander/multi-provider.js:820). Lo duplicamos acá para evitar
// require cruzado agent-launcher ↔ commander (acoplamiento que el split
// #3575 deliberadamente eliminó).
//
// SR-7: NUNCA persistir un errorType fuera de
// KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider]. Si no podemos extraer un
// valor de la allowlist, devolvemos null y el caller omite setFlag.
// -----------------------------------------------------------------------------
function _selectErrorTypeForFlag(provider, verdict, quotaModule) {
    const allowlist =
        (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
    if (allowlist.length === 0) return null;

    try {
        const trimmed = (verdict.evidence || '').trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('data:')) {
            const jsonStr = trimmed.startsWith('data:')
                ? trimmed.replace(/^data:\s*/, '')
                : trimmed;
            const parsed = JSON.parse(jsonStr);
            const candidates = [
                parsed.error_type,
                parsed.error && parsed.error.type,
                parsed.error && parsed.error.code,
                parsed.data && parsed.data.error && parsed.data.error.type,
                parsed.data && parsed.data.error && parsed.data.error.code,
                (parsed.type && parsed.type !== 'response.error' && parsed.type !== 'result')
                    ? parsed.type
                    : null,
            ];
            for (const candidate of candidates) {
                if (candidate && allowlist.includes(candidate)) {
                    return candidate;
                }
            }
        }
    } catch { /* fallthrough */ }

    // Default safe = primer elemento de la allowlist del provider.
    return allowlist[0];
}

// -----------------------------------------------------------------------------
// onSpawnExit — hook centralizado post-spawn (#3576 CA-2).
//
// **Never throws**: cualquier error interno se atrapa y devuelve un veredicto
// neutro. El caller puede usar el retorno para decidir log/telegram, pero la
// vida del child.on('exit') NO depende de que esto funcione.
// -----------------------------------------------------------------------------
function onSpawnExit(opts = {}) {
    // Defensive defaults — NUNCA throw por inputs mal formados.
    const neutral = {
        errorClass: 'unknown',
        shouldFallback: false,
        retriable: false,
        raw: '',
        evidence: '',
        flagSet: false,
        auditLogged: false,
        decision: 'ignore',
        codepath: 'generalized',
    };

    let verdict = null;
    let flagSet = false;
    let auditLogged = false;

    try {
        const {
            skill,
            provider,
            transport,
            rawOutput,
            exitCode,
            timedOut,
            durationMs,
            firstByteAt,
            // #4052 — código de `child.on('error')` (ej ENOENT) cuando el proceso
            // NUNCA llegó a arrancar. Opcional; ausente en el path post-exit normal.
            errorCode,
            // #4052 — true SOLO desde la instrumentación CA-1 del launcher (que
            // rastrea de verdad el primer byte). Habilita la firma 3 del
            // clasificador sin afectar a los callers post-exit legacy.
            spawnInstrumented,
            issue,
            pipelineDir,
            parserModule,
            quotaModule,
            auditLog,
            fsImpl,
            onLog,
            now,
        } = opts;

        const log = typeof onLog === 'function' ? onLog : () => {};
        const _parser = parserModule || require('./provider-error-parser');
        const _quota = quotaModule || require('../quota-exhausted');
        const _now = Number.isFinite(now) ? now : Date.now();

        // ---------------------------------------------------------------------
        // #4052 CA-1/CA-3 — Clasificación de spawn-failure ANTES del parser.
        //
        // Si la muerte tiene firma inequívoca de "el proceso del provider no
        // arrancó" (ENOENT/EACCES, exit 127, o exit antes del primer byte muy
        // temprano), la atribuimos al provider, NO al issue. Devolvemos
        // `decision: 'provider-spawn-failure'` para que el caller (instrumentación
        // del launcher) registre el marker y el brazoHuerfanos no penalice el
        // retry del issue. NO seteamos flag de cuota (esto no es cuota).
        //
        // Fail-closed: si la firma no es inequívoca, seguimos al parser normal
        // (la muerte se trata como fallo-del-issue, consume retry como hoy).
        // ---------------------------------------------------------------------
        let spawnFailure = { isSpawnFailure: false, signature: null };
        try {
            spawnFailure = classifySpawnFailure({ errorCode, exitCode, firstByteAt, durationMs, spawnInstrumented });
        } catch { spawnFailure = { isSpawnFailure: false, signature: null }; }

        if (spawnFailure.isSpawnFailure) {
            const sanitize = (_quota && typeof _quota.sanitizeRawExcerpt === 'function')
                ? _quota.sanitizeRawExcerpt
                : ((s) => String(s == null ? '' : s).slice(0, 200));
            const safeRaw = sanitize(rawOutput || '');
            const evidence = `spawn-failure:${spawnFailure.signature}`;
            // Audit hash-chained (igual que el resto del hook), con error_class
            // dedicado. Best-effort: nunca rompe el lifecycle.
            if (pipelineDir) {
                try {
                    const _audit = auditLog || require('../audit-log');
                    const file = spawnExitAuditFile(pipelineDir, new Date(_now));
                    ensureSecureAuditFile(file, fsImpl);
                    _audit.appendChained({
                        file,
                        entry: {
                            ts: new Date(_now).toISOString(),
                            skill: skill || null,
                            issue: (issue == null) ? null : Number(issue) || String(issue),
                            provider: provider || null,
                            transport: transport || null,
                            error_class: 'provider_spawn_failure',
                            evidence,
                            raw_excerpt: safeRaw,
                            should_fallback: true,
                            retriable: false,
                            flag_set: false,
                            exit_code: (exitCode === null || exitCode === undefined) ? null : Number(exitCode),
                            error_code: errorCode || null,
                            timed_out: timedOut === true,
                            duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
                            first_byte_at: Number.isFinite(firstByteAt) ? Math.round(firstByteAt) : null,
                            codepath: 'generalized',
                        },
                        fsImpl,
                    });
                } catch (e) {
                    try { log('lanzamiento', `${CODEPATH_EMOJI.generalized} onSpawnExit: audit spawn-failure tiró (best-effort): ${e && e.message}`); } catch {}
                }
            }
            return {
                errorClass: 'provider_spawn_failure',
                shouldFallback: true,
                retriable: false,
                raw: safeRaw,
                evidence,
                flagSet: false,
                auditLogged: !!pipelineDir,
                decision: 'provider-spawn-failure',
                signature: spawnFailure.signature,
                codepath: 'generalized',
            };
        }

        // 1. Clasificar via parser generalizado. El parser ya es defensivo y
        // NUNCA tira — pero envolvemos por defense in depth.
        try {
            verdict = _parser.parseProviderError(rawOutput, {
                provider,
                transport,
                timedOut,
                exitCode,
                durationMs,
                _quotaModule: _quota,
            });
        } catch (e) {
            // Cualquier throw del parser → veredicto neutro + log best-effort.
            try { log('lanzamiento', `${CODEPATH_EMOJI.generalized} onSpawnExit: parser tiró ${e && e.message}`); } catch {}
            return { ...neutral, codepath: 'generalized' };
        }

        // Sanitizamos el evidence/raw que devolvemos (defense in depth — el
        // parser ya los sanea, pero re-aplicamos por si vino con shape raro).
        const sanitize = (_quota && typeof _quota.sanitizeRawExcerpt === 'function')
            ? _quota.sanitizeRawExcerpt
            : ((s) => String(s == null ? '' : s).slice(0, 200));
        const safeEvidence = sanitize(verdict.evidence || '');
        const safeRaw = sanitize(verdict.raw || '');

        // 2. setFlag SOLO para quota_exhausted/rate_limit y SOLO si hay errorType
        // válido contra la allowlist. NEW-2 (atomic setFlag) ya está garantizado
        // por #3575 → este hook puede ser invocado desde múltiples skills sin
        // race conditions.
        if (verdict.errorClass === 'quota_exhausted' || verdict.errorClass === 'rate_limit') {
            try {
                const errorType = _selectErrorTypeForFlag(provider, verdict, _quota);
                if (errorType && typeof _quota.setFlag === 'function') {
                    _quota.setFlag({
                        provider,
                        errorType,
                        rawExcerpt: safeEvidence,
                        agent: skill || null,
                    });
                    flagSet = true;
                }
            } catch (e) {
                try { log('lanzamiento', `${CODEPATH_EMOJI.generalized} onSpawnExit: setFlag tiró (best-effort): ${e && e.message}`); } catch {}
            }
        }

        // 3. Audit log unificado (#3576 CA-8). Shape común para skills/commander.
        //    Hash-chain via appendChained. Sin emojis dentro del JSON (UX R2).
        if (pipelineDir) {
            try {
                const _audit = auditLog || require('../audit-log');
                const file = spawnExitAuditFile(pipelineDir, new Date(_now));
                ensureSecureAuditFile(file, fsImpl);
                const auditEntry = {
                    ts: new Date(_now).toISOString(),
                    skill: skill || null,
                    issue: (issue == null) ? null : Number(issue) || String(issue),
                    provider: provider || null,
                    transport: transport || null,
                    error_class: verdict.errorClass,
                    evidence: safeEvidence,
                    raw_excerpt: safeRaw,
                    should_fallback: !!verdict.shouldFallback,
                    retriable: !!verdict.retriable,
                    flag_set: flagSet,
                    exit_code: (exitCode === null || exitCode === undefined) ? null : Number(exitCode),
                    timed_out: timedOut === true,
                    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
                    // Signal C — first-byte ts (opcional, puede ser undefined si
                    // el transport no lo expone).
                    first_byte_at: Number.isFinite(firstByteAt) ? Math.round(firstByteAt) : null,
                    codepath: 'generalized',
                };
                _audit.appendChained({ file, entry: auditEntry, fsImpl });
                auditLogged = true;
            } catch (e) {
                try { log('lanzamiento', `${CODEPATH_EMOJI.generalized} onSpawnExit: audit tiró (best-effort): ${e && e.message}`); } catch {}
            }
        }

        const decision =
            verdict.errorClass === 'unknown' ? 'ignore' :
            flagSet ? 'flag_set' :
            verdict.shouldFallback ? 'fallback' :
            'ignore';

        return {
            errorClass: verdict.errorClass,
            shouldFallback: !!verdict.shouldFallback,
            retriable: !!verdict.retriable,
            raw: safeRaw,
            evidence: safeEvidence,
            flagSet,
            auditLogged,
            decision,
            codepath: 'generalized',
        };
    } catch (e) {
        // Catch-all defense in depth — NUNCA debemos romper child.on('exit').
        return { ...neutral, codepath: 'generalized' };
    }
}

// Sub-directorio donde se encola la notificación Telegram (servicio drainer
// la procesa fuera del path crítico del pulpo).
const TELEGRAM_QUEUE_SUBDIR = path.join('servicios', 'telegram', 'pendiente');

// Audit log dedicado al dispatch con fallback. Día rotación natural para
// trazabilidad por fecha de incidente.
function dispatchAuditFile(pipelineDir, now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir, 'logs', `cross-provider-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

// -----------------------------------------------------------------------------
// readAgentModelsRaw — lectura defensiva idéntica a resolve-provider.js pero
// exportable, porque acá necesitamos el `skills.<name>.fallbacks` además del
// resolved primary.
// -----------------------------------------------------------------------------
function readAgentModelsRaw(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(modelsPath)) return null;
        return JSON.parse(_fs.readFileSync(modelsPath, 'utf8'));
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// MP-09 (#3809) — Health-gate FAIL-OPEN sobre la cascada de fallbacks.
//
// El health-cron pinguea providers cada ~15min y persiste su estado en
// `.pipeline/state/multi-provider-health.json`. Hasta #3809 ese estado se
// observaba pero NO influía en la decisión de spawn: un provider conocido-rojo
// igual se intentaba como fallback, gastando un eslabón de la cascada en un
// spawn condenado.
//
// POLÍTICA — FAIL-OPEN ante incertidumbre (OPUESTA, a propósito, al fail-closed
// de la validación de modelos at-boot en completion-client.js, REQ-SEC-4):
//   - Solo gateamos un provider si tiene una señal de rojo **fresca y confiable**
//     (`state === "red"` + `last_checked_at` dentro de la ventana de frescura).
//   - Ante CUALQUIER duda — sin entrada en el snapshot, sin timestamp parseable,
//     rojo viejo, snapshot ilegible o reloj desfasado — NO gateamos. Preservar
//     la cobertura de la cascada vale más que ahorrar un spawn: un rojo
//     transitorio no debe sacar a un provider sano de la cadena (riesgo inverso
//     al deseado, ver doc auditoria-3809).
//
// Se aplica SOLO a los **candidatos de fallback**, nunca al provider primario:
// gatear el primario cambiaría el happy path (Anthropic es primario en todos
// los skills LLM) y un falso rojo dejaría al pipeline sin arranque. El primario
// degrada por su propio camino (retry MP-12 + cuota), no por health-gate.
// -----------------------------------------------------------------------------

// Ventana de frescura: el cron corre ~15min, dejamos 20min de margen. Un rojo
// más viejo que esto se considera no-confiable → fail-open (no gatea).
const HEALTH_FRESHNESS_MS = 20 * 60 * 1000;

// Refinamiento del fail-open (incidente Gemini timeout 2026-06-05): un rojo
// FRESCO sólo debe gatear si su causa es DURABLE — el provider seguirá caído
// hasta intervención (credencial inválida, sin key, binario CLI ausente,
// provider mal declarado). Un rojo TRANSITORIO (timeout, network blip, 5xx,
// rate-limit puntual) es exactamente la incertidumbre que la política fail-open
// quiere preservar: el provider pudo recuperarse entre el ping del cron y este
// spawn. Gatearlo por un timeout lo saca de la cascada hasta 20min aunque ya
// esté sano (Gemini quedó rojo por un timeout y la cascada saltó a Cerebras
// aunque Gemini ya respondía 200). Ante causa NO-durable → fail-open.
//
// Los reason_code provienen de `health-alerts.sanitizeReasonCode` (allowlist
// cerrada en live-ping/health-alerts). Sólo estos justifican gatear:
const DURABLE_RED_REASONS = Object.freeze(new Set([
    'invalid_credentials',     // key incorrecta — no se arregla sola
    'forbidden',               // 403 persistente
    'no_key_configured',       // sin credencial declarada
    'unknown_provider',        // misconfig
    'cli_unavailable',         // binario CLI ausente del PATH
    'cli_binary_undeclared',   // provider CLI sin binario declarado
    'quota_exhausted',         // sin cuota — el flag de cuota ya lo cubre, doble defensa
    'quota_exhausted_real',    // #4283 — cuota REAL agotada (≥90%, #4202): logueado pero sin cuota usable
]));

// El health-cron nombra a OpenAI/Codex como 'openai', pero la config de skills
// (agent-models.json) usa la key 'openai-codex'. Mapeamos provider-key → nombre
// en el snapshot de health. Si no hay alias, se busca por la key tal cual.
const HEALTH_PROVIDER_ALIAS = Object.freeze({
    'openai-codex': 'openai',
});

// Lee el snapshot de health. Best-effort: cualquier error → null (fail-open).
function readProviderHealth(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const healthPath = path.join(pipelineDir, 'state', 'multi-provider-health.json');
    try {
        if (!_fs.existsSync(healthPath)) return null;
        const parsed = JSON.parse(_fs.readFileSync(healthPath, 'utf8'));
        if (!parsed || !Array.isArray(parsed.providers)) return null;
        return parsed;
    } catch {
        return null;
    }
}

// Evalúa el health-gate para un provider-key concreto.
// Devuelve { gated:boolean, reason:string|null, state:string|null, ageMs:number|null }.
// gated === true SOLO con rojo fresco y confiable; en todo otro caso fail-open.
function evaluateHealthGate(providerKey, healthSnapshot, now) {
    const result = { gated: false, reason: null, state: null, ageMs: null };
    if (!healthSnapshot || !Array.isArray(healthSnapshot.providers)) return result;
    const healthName = HEALTH_PROVIDER_ALIAS[providerKey] || providerKey;
    const entry = healthSnapshot.providers.find(
        (p) => p && (p.provider === healthName || p.provider === providerKey),
    );
    if (!entry) return result;                  // sin señal → fail-open
    result.state = entry.state || null;
    if (entry.state !== 'red') return result;   // verde/amarillo/desconocido → no gatear
    // state === 'red' → exigir frescura confiable para gatear.
    const checkedAt = entry.last_checked_at ? Date.parse(entry.last_checked_at) : NaN;
    if (!Number.isFinite(checkedAt)) {
        result.reason = 'red_no_timestamp';     // rojo sin timestamp confiable → fail-open
        return result;
    }
    const ageMs = now - checkedAt;
    result.ageMs = ageMs;
    if (ageMs < 0 || ageMs > HEALTH_FRESHNESS_MS) {
        result.reason = 'red_stale';            // rojo viejo o reloj desfasado → fail-open
        return result;
    }
    // Rojo fresco PERO la causa decide: sólo gateamos si es durable. Un rojo
    // transitorio (timeout/network/5xx) no debe sacar a un provider que pudo
    // recuperarse de la cascada — fail-open preservando cobertura.
    const reasonCode = entry.reason_code || null;
    if (!DURABLE_RED_REASONS.has(reasonCode)) {
        result.reason = 'red_transient';        // rojo fresco pero causa no-durable → fail-open
        return result;
    }
    result.gated = true;                        // rojo fresco, confiable y durable → gatear
    result.reason = reasonCode || 'red_fresh';
    return result;
}

// -----------------------------------------------------------------------------
// enqueueTelegramNotice — encola un mensaje en la queue de archivos del
// servicio Telegram (S-9). NUNCA hace fetch/curl directo: el drainer fuera
// del path crítico lo procesa.
//
// Best-effort: errores de IO se silencian para no romper el pipeline (el
// dispatcher NUNCA debe ser causa de crash).
// -----------------------------------------------------------------------------
function enqueueTelegramNotice({ pipelineDir, fsImpl, text, meta }) {
    const _fs = fsImpl || fs;
    if (!pipelineDir || !text) return false;
    try {
        const queueDir = path.join(pipelineDir, TELEGRAM_QUEUE_SUBDIR);
        _fs.mkdirSync(queueDir, { recursive: true });
        // Nombre con timestamp + pid para evitar colisiones entre procesos
        // concurrentes (caller puede ser pulpo + un script de mantenimiento).
        const fname = `cross-provider-${Date.now()}-${process.pid}.json`;
        const payload = JSON.stringify({
            type: 'cross-provider-fallback',
            text,
            meta: meta || {},
            queued_at: new Date().toISOString(),
        }, null, 2);
        _fs.writeFileSync(path.join(queueDir, fname), payload, { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// auditAppend — append-only entry al audit log dedicado con hash-chain.
//
// El módulo `lib/audit-log.js` (#3082) ya provee `appendChained` con SHA-256
// chain. Lo reusamos para no duplicar el patrón. Sanitización del
// raw_excerpt se delega a `quotaModule.sanitizeRawExcerpt` (S-6).
//
// Best-effort: errores de IO se silencian (S-6 / best-effort idéntico al
// detector de cuota).
// -----------------------------------------------------------------------------
function auditAppend({ pipelineDir, fsImpl, entry, sanitize, auditLog, now }) {
    if (!pipelineDir || !entry) return false;
    try {
        const _audit = auditLog || require('../audit-log');
        const file = dispatchAuditFile(pipelineDir, now ? new Date(now) : undefined);
        const safe = {
            ...entry,
            raw_excerpt: typeof sanitize === 'function'
                ? sanitize(entry.raw_excerpt)
                : (entry.raw_excerpt || ''),
        };
        _audit.appendChained({ file, entry: safe, fsImpl });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// resolveSpawnWithFallback — resuelve el provider efectivo para el spawn,
// consultando el primary y, si está gated, iterando `fallbacks[]`.
//
// Contrato:
//   input: {
//     skill,                     // nombre del skill (string)
//     issue,                     // número del issue (informativo, para audit)
//     pipelineDir,               // .pipeline path (para leer agent-models.json y escribir audit)
//     fsImpl,                    // override fs (tests)
//     quotaModule,               // require('../quota-exhausted')
//     primaryResolver,           // override resolveProviderForSkill (tests)
//     providerHandlerResolver,   // override getProviderHandler (tests)
//     auditLog,                  // override require('../audit-log') (tests)
//     notify,                    // override enqueueTelegramNotice (tests)
//     onLog,                     // callback(level, message) — logging del caller (best-effort)
//     now,                       // Date.now() override (tests)
//   }
//
//   output: {
//     provider,               // provider efectivo a usar para el spawn
//     model,                  // model resolvido (puede ser null si N/A)
//     handler,                // handler del provider efectivo
//     source,                 // 'primary' | 'fallback' | 'all-gated'
//     gated,                  // true si NO se puede spawnear (primary y todos los fallbacks gated)
//     fallbackUsed,           // { index, provider } si source === 'fallback', sino null
//     primaryProvider,        // provider primario originalmente resuelto
//     chainTried,             // [providerName, ...] orden de intentos
//     crossProvider,          // true si el fallback elegido es de otro provider que el primary
//     depthExceeded,          // true si la chain superó MAX_FALLBACK_DEPTH
//   }
//
// REGLAS
// ------
// 1. Si el primario NO está gateado → devolver primary (source: 'primary').
// 2. Si está gateado y el skill no tiene `fallbacks[]` → devolver primary +
//    gated:true (caller mueve a pendiente/).
// 3. Iterar `fallbacks[]` en orden, hasta MAX_FALLBACK_DEPTH:
//    a. Si el fallback se repite (cycle) → skip + audit.
//    b. Si el fallback no está en la tabla hardcoded de handlers → skip + audit.
//    c. Si el fallback == primary → skip (defense in depth, validator ya
//       lo prohíbe pero blindamos).
//    d. Si el fallback también está gateado (mismo provider o flag scoped
//       a ese provider) → skip + audit.
//    e. Si está libre → devolver fallback (source: 'fallback') + audit +
//       notificar Telegram.
// 4. Si la chain se agota sin candidato → source: 'all-gated' + gated:true.
// 5. Si la chain supera MAX_FALLBACK_DEPTH → cortar + audit "depth_exceeded"
//    + tratar como all-gated.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// #3680 CA-A10 — Allowlist hardcoded de skills que pueden activar
// FORCE_PROVIDER_OVERRIDE. La defensa en profundidad es:
//   1. Boot validator del pulpo padre aborta si process.env.FORCE_PROVIDER_OVERRIDE
//      está seteada al arrancar (CA-A9).
//   2. La rama de bypass acá lee el flag SÓLO desde opts.env (env del spawn
//      child), nunca de process.env. El caller (harness) tiene que pasarlo
//      explícito en el env del child.
//   3. Sólo skills en esta lista pueden activar el bypass. Cualquier otro
//      skill con el flag → audit warning + ignorar (no bypass).
// -----------------------------------------------------------------------------
const FORCED_OVERRIDE_ALLOWED_SKILLS = Object.freeze(['multi-provider-smoke-test']);

// =============================================================================
// #3823 — Trazabilidad observable de la resolución de provider.
//
// Hasta este issue, las razones por las que se descartaba cada candidato de la
// cadena de fallback vivían SOLO en el audit log JSONL (hash-chain). El operador
// no veía en tiempo real qué provider se eligió ni por qué fallaron los
// anteriores. Este bloque expone esa trazabilidad como `skipReasons[]` en el
// retorno de `resolveSpawnWithFallback` + un formateador de log multilinea.
//
// CONTRATO 100% backward-compatible: la lógica de DECISIÓN no cambia. Sólo se
// acumula trazabilidad (un array de `{ provider, reason, details }`) en paralelo
// a los `auditAppend` ya existentes y se agrega el campo a cada return path.
// -----------------------------------------------------------------------------

// Catálogo cerrado de códigos de razón de descarte (#3823). Cada código mapea a
// un gate/skip YA implementado en el dispatcher. Se documentan acá como SoT.
const SKIP_REASON_CODES = Object.freeze({
    PROVIDER_DISABLED: 'provider_disabled',   // kill-switch operacional (#3811)
    PROVIDER_INACTIVE_BY_SCHEDULE: 'provider_inactive_by_schedule', // fuera de horario (#3871)
    QUOTA_EXHAUSTED: 'quota_exhausted',       // flag de cuota activo (#3077/#3576)
    HEALTH_GATE: 'health_gate',               // health rojo fresco (#3809 MP-09)
    PERMISSION_MATRIX: 'permission_matrix',   // credencial/permiso incompatible (MP-05)
    DUPLICATE_IN_CHAIN: 'duplicate_in_chain', // cycle detection (#3198 S-5)
    INVALID_HANDLER: 'invalid_handler',       // provider no registrado / shape inválido
    SAME_AS_PRIMARY: 'same_as_primary',       // defensa in-depth (fallback == primary)
    PREVENTIVE_SOFT_GATE: 'preventive_soft_gate', // degradación preventiva por cuota (#4282)
});

// Etiquetas legibles (español) para el log textual. NO se escriben en el JSON
// del audit log — sólo en los logs de `log('lanzamiento', ...)` y en la env var
// PROVIDER_RESOLUTION_LOG (UX, no consumido por parsers).
const SKIP_REASON_LABELS = Object.freeze({
    provider_disabled: 'kill-switch operativo',
    provider_inactive_by_schedule: 'fuera de horario',
    quota_exhausted: 'sin cuota',
    health_gate: 'health rojo reciente',
    permission_matrix: 'credenciales/permisos incompatibles',
    duplicate_in_chain: 'duplicado en la cadena',
    invalid_handler: 'provider no registrado',
    same_as_primary: 'igual al primario',
    preventive_soft_gate: 'degradación preventiva por cuota',
});

// -----------------------------------------------------------------------------
// formatProviderResolutionLog — arma el bloque de log legible (#3823 CA-2).
//
// Recibe el resultado de `resolveSpawnWithFallback` + contexto {skill, issue}.
// Devuelve un string multilinea apto para `log('lanzamiento', ...)` y para la
// env var PROVIDER_RESOLUTION_LOG del child. NUNCA tira (best-effort): ante un
// input mal formado devuelve un string mínimo en vez de romper el spawn.
// -----------------------------------------------------------------------------
function formatProviderResolutionLog(resolution = {}, ctx = {}) {
    try {
        const skill = ctx.skill != null ? String(ctx.skill) : '?';
        const issue = ctx.issue != null ? String(ctx.issue) : '?';
        const r = resolution || {};
        const skips = Array.isArray(r.skipReasons) ? r.skipReasons : [];
        const chain = Array.isArray(r.chainTried) ? r.chainTried : [];

        // Happy path: primary elegido sin descartes → una sola línea.
        if (!r.gated && skips.length === 0) {
            return `✓ ${skill}:#${issue} provider=${r.provider} (${r.source || 'primary'}, sin fallback necesario)`;
        }

        const lines = [];
        lines.push(r.gated
            ? `🚫 ${skill}:#${issue} — Cadena completa exhausted:`
            : `🔄 ${skill}:#${issue} — Resolución de provider:`);

        for (const s of skips) {
            const provider = s && s.provider ? s.provider : '(desconocido)';
            const reason = s && s.reason ? s.reason : 'desconocido';
            const label = SKIP_REASON_LABELS[reason] || reason;
            const details = s && s.details ? ` — ${s.details}` : '';
            lines.push(`  → ${provider} (DESCARTADO: ${reason} (${label})${details})`);
        }

        if (!r.gated && r.provider) {
            const pos = r.fallbackUsed
                ? `fallback[${r.fallbackUsed.index}]`
                : 'primary';
            const model = r.model ? `, model=${r.model}` : '';
            lines.push(`  ✓ ${r.provider} (ELEGIDO — ${pos}${model})`);
        } else {
            lines.push(`  RESULTADO: all-gated, devuelvo a pendiente/ para retry`);
        }

        if (chain.length) {
            const total = chain.length;
            lines.push(`  Chain evaluada: ${chain.join(' → ')} (${total} eslabón${total === 1 ? '' : 'es'} evaluado${total === 1 ? '' : 's'})`);
        }

        return lines.join('\n');
    } catch {
        // Defense in depth: nunca romper el caller por un error de formateo.
        const skill = ctx && ctx.skill != null ? String(ctx.skill) : '?';
        const issue = ctx && ctx.issue != null ? String(ctx.issue) : '?';
        return `🔄 ${skill}:#${issue} — Resolución de provider (log no disponible)`;
    }
}

function resolveSpawnWithFallback(opts = {}) {
    const {
        skill,
        issue,
        pipelineDir,
        fsImpl,
        quotaModule,
        primaryResolver,
        providerHandlerResolver,
        auditLog,
        notify,
        onLog,
        now,
        processEnv,
    } = opts;

    const log = typeof onLog === 'function' ? onLog : () => {};
    const _env = processEnv || process.env;
    const _resolveProvider = primaryResolver || resolveProviderForSkill;
    const _resolveHandler = providerHandlerResolver || getProviderHandler;
    const _notify = notify || enqueueTelegramNotice;
    const _now = Number.isFinite(now) ? now : Date.now();
    // #3811 — módulo del kill-switch. Inyectable para tests (opts.disabledModule).
    const _disabled = opts.disabledModule || providerDisabledModule;
    const _isProviderDisabled = (p) => {
        try {
            return typeof _disabled.isProviderDisabled === 'function'
                && _disabled.isProviderDisabled(p, { now: _now });
        } catch {
            return false; // fail-open: el kill-switch nunca bloquea por bug propio.
        }
    };
    // #3871 — módulo del scheduler horario. Inyectable para tests (opts.scheduleModule).
    const _schedule = opts.scheduleModule || providerScheduleModule;
    const _isProviderInactive = (p) => {
        try {
            // isProviderActiveNow es fail-open (true ante cualquier error). El gate
            // se activa solo cuando el provider está EXPLÍCITAMENTE fuera de horario.
            return typeof _schedule.isProviderActiveNow === 'function'
                && _schedule.isProviderActiveNow(p, _now) === false;
        } catch {
            return false; // fail-open: el scheduler nunca bloquea por bug propio.
        }
    };
    // #4282 — soft-gate preventivo. Marker vigente ⇒ preferir fallback, pero
    // NUNCA vaciar la chain (si no hay fallback resoluble, se usa el primary).
    const _softGate = opts.softGateModule || providerQuotaGuardModule;
    const _isProviderSoftGated = (p) => {
        try {
            return typeof _softGate.isPreventivelyDegraded === 'function'
                && _softGate.isPreventivelyDegraded(p, { now: _now, pipelineDir, fsImpl }) === true;
        } catch {
            return false; // fail-open: el soft gate nunca bloquea por bug propio.
        }
    };

    // #3823 — acumulador de trazabilidad observable. Se llena en paralelo a los
    // auditAppend ya existentes (sin tocar la lógica de decisión) y se adjunta a
    // cada return path. Helper local para empujar de forma consistente.
    const skipReasons = [];
    const pushSkip = (provider, reason, details) => {
        skipReasons.push({
            provider: provider || null,
            reason,
            details: details == null ? null : String(details),
        });
    };

    // #3871 — trazas para distinguir "chain agotada por horario" del resto.
    //   scheduleGatedCount: cuántos providers se saltaron por estar fuera de horario.
    //   nonScheduleAvailabilityGate: ¿algún provider se saltó por una causa de
    //     disponibilidad distinta del horario (cuota, kill-switch, health, creds)?
    //   Si scheduleGatedCount>0 y NO hubo gate no-horario ⇒ todos_inactivos_por_horario.
    let scheduleGatedCount = 0;
    let nonScheduleAvailabilityGate = false;

    // -------------------------------------------------------------------------
    // #3680 CA-A8 — FORCE_PROVIDER_OVERRIDE branch.
    //
    // Punto de inyección al inicio de resolveSpawnWithFallback, ANTES del
    // resolveProvider primario y de cualquier gate de cuota. Bypass total
    // (no consulta cuota, no consulta fallbacks) — el harness pide un
    // provider específico y lo obtiene siempre que (a) el skill esté en la
    // allowlist y (b) el provider sea válido en la tabla hardcoded de
    // handlers.
    //
    // El flag se lee desde opts.env (env del spawn child), NUNCA de
    // process.env del padre. El validator boot-time en pulpo.js aborta si
    // process.env.FORCE_PROVIDER_OVERRIDE está presente al arrancar (CA-A9).
    // -------------------------------------------------------------------------
    const forcedProvider = (opts.env && typeof opts.env === 'object' && opts.env.FORCE_PROVIDER_OVERRIDE)
        ? String(opts.env.FORCE_PROVIDER_OVERRIDE)
        : null;
    if (forcedProvider) {
        if (!FORCED_OVERRIDE_ALLOWED_SKILLS.includes(skill)) {
            // CA-A10: skill no autorizado → audit + IGNORAR (sigue flow normal).
            auditAppend({
                pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
                auditLog, now: _now,
                entry: {
                    event: 'forced_provider_override_ignored',
                    skill,
                    issue: issue || null,
                    forced_provider: forcedProvider,
                    reason: 'skill_not_in_allowlist',
                    allowed_skills: FORCED_OVERRIDE_ALLOWED_SKILLS.slice(),
                    raw_excerpt: `skill=${skill} forced=${forcedProvider} not_in_allowlist`,
                },
            });
            log('lanzamiento', `⚠️ ${skill}:#${issue || '?'} FORCE_PROVIDER_OVERRIDE='${forcedProvider}' ignorado (skill no en allowlist).`);
            // Sigue al flow normal — NO bypass.
        } else {
            // CA-A8 + CA-A11: bypass del gate + audit dedicado.
            // Resolvemos el handler para validar que el provider existe
            // (la tabla hardcoded en resolve-provider.js es la SoT de
            // providers válidos — defense in depth contra typos del harness).
            let resolvedHandler;
            try {
                resolvedHandler = _resolveHandler(forcedProvider);
            } catch (e) {
                auditAppend({
                    pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
                    auditLog, now: _now,
                    entry: {
                        event: 'forced_provider_override_invalid_provider',
                        skill,
                        issue: issue || null,
                        forced_provider: forcedProvider,
                        reason: e.message,
                        raw_excerpt: `skill=${skill} forced=${forcedProvider} invalid_provider`,
                    },
                });
                // Sigue al flow normal — provider inválido no bypass.
                resolvedHandler = null;
            }
            if (resolvedHandler) {
                // Resolvemos el primary "natural" sólo para reportar qué
                // estamos bypaseando (audit informativo, no afecta el spawn).
                let primaryBypassed = null;
                try {
                    const p = _resolveProvider(skill, { pipelineDir, fsImpl });
                    primaryBypassed = p && p.provider;
                } catch { /* best-effort */ }

                // Modelo efectivo del forced provider: el agent-models.json
                // declara `providers.<x>.model` como default. Si querés
                // modelo distinto, pasalo en opts.env.FORCE_PROVIDER_MODEL.
                let forcedModel = (opts.env && opts.env.FORCE_PROVIDER_MODEL) || null;
                if (!forcedModel) {
                    try {
                        const models = readAgentModelsRaw(pipelineDir, fsImpl);
                        const pdef = models && models.providers && models.providers[forcedProvider];
                        if (pdef && pdef.model) forcedModel = pdef.model;
                    } catch { /* best-effort */ }
                }

                auditAppend({
                    pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
                    auditLog, now: _now,
                    entry: {
                        event: 'forced_provider_override',
                        skill,
                        issue: issue || null,
                        forced_provider: forcedProvider,
                        primary_provider_bypassed: primaryBypassed,
                        source: 'smoke-test',
                        raw_excerpt: `skill=${skill} forced=${forcedProvider} bypass_primary=${primaryBypassed}`,
                    },
                });
                log('lanzamiento', `🔬 ${skill}:#${issue || '?'} FORCE_PROVIDER_OVERRIDE='${forcedProvider}' (bypass de '${primaryBypassed}').`);
                return {
                    provider: forcedProvider,
                    model: forcedModel,
                    handler: resolvedHandler,
                    source: 'forced-override',
                    gated: false,
                    fallbackUsed: null,
                    primaryProvider: forcedProvider,
                    chainTried: [forcedProvider],
                    crossProvider: false,
                    depthExceeded: false,
                    skipReasons,
                };
            }
        }
    }

    // -------------------------------------------------------------------------
    // 1. Resolver el provider primario.
    // -------------------------------------------------------------------------
    const primary = _resolveProvider(skill, { pipelineDir, fsImpl });
    const primaryProvider = primary && primary.provider;

    // Si no hay quotaModule, devolvemos el primary sin gate (modo legacy).
    if (!quotaModule || typeof quotaModule.shouldGateSpawn !== 'function') {
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
            skipReasons,
        };
    }

    // Skills determinísticos no se gatean — devolvemos el primary tal cual.
    if (primary.provider === 'deterministic') {
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
            skipReasons,
        };
    }

    // #3811 — el primario salta a fallback por dos causas independientes:
    //   (a) gate de cuota (shouldGateSpawn) — "esperar reset".
    //   (b) kill-switch operacional (isProviderDisabled) — "caída en runtime".
    // Ambas se OR-ean: cualquiera fuerza la cascada a fallbacks. El audit
    // distingue la causa con el evento `provider_disabled`.
    const primaryQuotaGated = quotaModule.shouldGateSpawn(skill, {
        provider: primaryProvider,
        now: _now,
    });
    const primaryDisabled = _isProviderDisabled(primaryProvider);
    // #3871 — el primario también salta si está fuera de su horario de actividad.
    const primaryInactiveBySchedule = _isProviderInactive(primaryProvider);
    const primaryGated = primaryQuotaGated || primaryDisabled || primaryInactiveBySchedule;
    // #4282 — soft-gate preventivo: SOLO aplica si el primary NO está hard-gated
    // (precedencia explícita: el hard manda sobre el soft — REQ-SEC-3 / CA-7).
    const primarySoftGated = !primaryGated && _isProviderSoftGated(primaryProvider);

    if (primaryInactiveBySchedule) {
        // Audit dedicado del salto por horario (distinto del kill-switch).
        auditAppend({
            pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
            auditLog, now: _now,
            entry: {
                event: 'primary_inactive_by_schedule',
                skill,
                issue: issue || null,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                raw_excerpt: `primary=${primaryProvider} inactive_by_schedule -> salto a fallbacks`,
            },
        });
        log('lanzamiento', `🕒 ${skill}:#${issue || '?'} provider primario "${primaryProvider}" FUERA DE HORARIO — saltando a fallbacks.`);
    }

    if (primaryDisabled) {
        // Audit dedicado del salto por deshabilitación (CA: audit log registra
        // saltos por deshabilitación con event 'provider_disabled').
        auditAppend({
            pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
            auditLog, now: _now,
            entry: {
                event: 'provider_disabled',
                skill,
                issue: issue || null,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                quota_gated: primaryQuotaGated,
                raw_excerpt: `primary=${primaryProvider} disabled_by_killswitch -> salto a fallbacks`,
            },
        });
        log('lanzamiento', `🔌 ${skill}:#${issue || '?'} provider primario "${primaryProvider}" APAGADO (kill-switch) — saltando a fallbacks.`);
    }

    // #3823 — registrar la razón por la que se descarta el primario. El
    // kill-switch tiene precedencia semántica sobre la cuota: si el provider está
    // apagado, esa es la causa raíz del salto (la cuota es secundaria).
    if (primaryGated) {
        // Precedencia de atribución: kill-switch > horario > cuota.
        let reasonCode;
        let reasonDetail;
        if (primaryDisabled) {
            reasonCode = SKIP_REASON_CODES.PROVIDER_DISABLED;
            reasonDetail = 'kill-switch operativo activo';
            nonScheduleAvailabilityGate = true;
        } else if (primaryInactiveBySchedule) {
            reasonCode = SKIP_REASON_CODES.PROVIDER_INACTIVE_BY_SCHEDULE;
            reasonDetail = 'fuera de horario de actividad';
        } else {
            reasonCode = SKIP_REASON_CODES.QUOTA_EXHAUSTED;
            reasonDetail = 'flag de cuota activo';
            nonScheduleAvailabilityGate = true;
        }
        if (primaryInactiveBySchedule) scheduleGatedCount++;
        pushSkip(primaryProvider, reasonCode, reasonDetail);
    }

    // #4282 — soft-gate preventivo (solo si NO hubo hard gate). Registra la
    // razón y audita la degradación (REQ-SEC-5). NO marca
    // `nonScheduleAvailabilityGate` (no es indisponibilidad real: el primary
    // sigue siendo usable si no hay fallback).
    if (primarySoftGated) {
        auditAppend({
            pipelineDir, fsImpl, sanitize: (s) => String(s || ''),
            auditLog, now: _now,
            entry: {
                event: 'preventive_soft_gate',
                skill,
                issue: issue || null,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                raw_excerpt: `primary=${primaryProvider} soft_degraded -> prefiere fallback (sin vaciar chain)`,
            },
        });
        log('lanzamiento', `🟡 ${skill}:#${issue || '?'} provider primario "${primaryProvider}" en degradación preventiva — prefiriendo fallback (no vacía la chain).`);
        pushSkip(primaryProvider, SKIP_REASON_CODES.PREVENTIVE_SOFT_GATE, 'degradación preventiva por cuota');
    }

    if (!primaryGated && !primarySoftGated) {
        // Happy path: primary disponible.
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            fallbackUsed: null,
            primaryProvider,
            chainTried: [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
            skipReasons,
        };
    }

    // #4282 — helper para devolver el primary cuando el soft-gate no encontró
    // fallback resoluble: el soft NUNCA pausa ni vacía la chain (REQ-SEC-3).
    const _returnPrimarySoftFallthrough = (chainSoFar) => {
        log('lanzamiento', `🟡 ${skill}:#${issue || '?'} degradación preventiva sin fallback resoluble — uso el primary "${primaryProvider}" (chain no se vacía).`);
        return {
            ...primary,
            source: primary.source || 'primary',
            gated: false,
            softGatedPrimaryUsed: true,
            fallbackUsed: null,
            primaryProvider,
            chainTried: Array.isArray(chainSoFar) && chainSoFar.length ? chainSoFar : [primaryProvider],
            crossProvider: false,
            depthExceeded: false,
            skipReasons,
        };
    };

    // -------------------------------------------------------------------------
    // 2. Primary gateado → consultar fallbacks[] del skill.
    // -------------------------------------------------------------------------
    const models = readAgentModelsRaw(pipelineDir, fsImpl);
    const skillCfg = (models && models.skills && models.skills[skill]) || null;
    const fallbacks = skillCfg && Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];

    // MP-09 (#3809) — snapshot de health para el gate fail-open de fallbacks.
    // Se lee una sola vez por resolución (no por candidato). Inyectable en tests
    // vía opts.healthReader; default lee state/multi-provider-health.json.
    const _readHealth = (typeof opts.healthReader === 'function') ? opts.healthReader : readProviderHealth;
    let healthSnapshot = null;
    try { healthSnapshot = _readHealth(pipelineDir, fsImpl); } catch { healthSnapshot = null; }

    const chainTried = [primaryProvider];
    const sanitize = quotaModule.sanitizeRawExcerpt || ((s) => String(s || ''));

    if (fallbacks.length === 0) {
        // #4282 — soft-gate sin fallbacks declarados: el primary es usable, no
        // se pausa (el soft NUNCA vacía la chain). Solo aplica si NO hubo hard gate.
        if (primarySoftGated) {
            return _returnPrimarySoftFallthrough([primaryProvider]);
        }
        // Sin fallbacks declarados → comportamiento previo (gate clásico).
        auditAppend({
            pipelineDir, fsImpl, sanitize, auditLog, now: _now,
            entry: {
                event: 'gated_no_fallbacks',
                skill,
                issue: issue || null,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                fallbacks_declared: 0,
                reason: (scheduleGatedCount > 0 && !nonScheduleAvailabilityGate)
                    ? 'todos_inactivos_por_horario' : 'all_gated',
                raw_excerpt: `skill=${skill} provider=${primaryProvider} no_fallbacks`,
            },
        });
        const noFbAllSchedule = scheduleGatedCount > 0 && !nonScheduleAvailabilityGate;
        if (noFbAllSchedule) {
            log('lanzamiento', `🕒🚫 ${skill}:#${issue || '?'} provider primario fuera de horario y sin fallbacks — spawn en pausa (todos_inactivos_por_horario).`);
            try {
                _notify({
                    pipelineDir,
                    fsImpl,
                    text:
                        `🕒 *Pipeline en pausa por horario*\n` +
                        `Skill \`${skill}\` (issue #${issue || '?'}): el provider primario \`${primaryProvider}\` ` +
                        `está fuera de horario y no hay fallbacks declarados. El spawn queda en pausa hasta entrar en horario.`,
                    meta: { skill, issue: issue || null, event: 'todos_inactivos_por_horario', chain_tried: chainTried },
                });
            } catch { /* best-effort */ }
        }
        return {
            ...primary,
            source: 'all-gated',
            gated: true,
            reason: noFbAllSchedule ? 'todos_inactivos_por_horario' : 'all_gated',
            allInactiveBySchedule: noFbAllSchedule,
            fallbackUsed: null,
            primaryProvider,
            chainTried,
            crossProvider: false,
            depthExceeded: false,
            skipReasons,
        };
    }

    // -------------------------------------------------------------------------
    // 3. Iterar fallbacks en orden.
    // -------------------------------------------------------------------------
    const tried = new Set([primaryProvider]);
    let depthExceeded = false;

    for (let i = 0; i < fallbacks.length; i++) {
        if (i >= MAX_FALLBACK_DEPTH) {
            depthExceeded = true;
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'depth_exceeded',
                    skill,
                    issue: issue || null,
                    primary_provider: primaryProvider,
                    max_depth: MAX_FALLBACK_DEPTH,
                    declared_length: fallbacks.length,
                    raw_excerpt: `chain_length=${fallbacks.length} max=${MAX_FALLBACK_DEPTH}`,
                },
            });
            log('lanzamiento', `⚠️ ${skill}:#${issue} chain de fallbacks superó MAX_FALLBACK_DEPTH=${MAX_FALLBACK_DEPTH}, corto.`);
            break;
        }

        // #3221 — el item de fallbacks puede ser string (legacy) o
        // {provider, model_override}. Normalizamos a `fbName` (provider key)
        // y `fbModelOverride` (modelo pin-eado o null). La resolución del
        // shape vive en lib/agent-models-validate.js para una sola fuente
        // de verdad — si llega null acá es porque el item del JSON está
        // mal formado (validator ya lo emite como error, defense in depth
        // adicional: skipear con audit).
        const fbEntry = fallbacks[i];
        let fbName, fbModelOverride;
        if (typeof fbEntry === 'string') {
            fbName = fbEntry;
            fbModelOverride = null;
        } else if (fbEntry && typeof fbEntry === 'object' && !Array.isArray(fbEntry)
                   && typeof fbEntry.provider === 'string') {
            fbName = fbEntry.provider;
            fbModelOverride = typeof fbEntry.model_override === 'string' ? fbEntry.model_override : null;
        } else {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_invalid_shape',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    raw_excerpt: `entry_type=${typeof fbEntry}`,
                },
            });
            pushSkip(null, SKIP_REASON_CODES.INVALID_HANDLER, `shape inválido (entry_type=${typeof fbEntry}) en índice ${i}`);
            continue;
        }

        // 3.a — cycle/anti-duplicate
        if (tried.has(fbName)) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_cycle_skipped',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    raw_excerpt: `already_tried=${Array.from(tried).join(',')}`,
                },
            });
            pushSkip(fbName, SKIP_REASON_CODES.DUPLICATE_IN_CHAIN, `ya evaluado en la cadena (índice ${i})`);
            continue;
        }
        tried.add(fbName);
        chainTried.push(fbName);

        // 3.b — handler debe existir (defense in depth; validator ya lo
        // chequea al boot pero blindamos en runtime para que un agent-models.json
        // editado a mano con nombre inválido NO crashee el dispatcher).
        let fbHandler;
        try {
            fbHandler = _resolveHandler(fbName);
        } catch (e) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_unknown_provider',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    raw_excerpt: `error=${e.message}`,
                },
            });
            log('lanzamiento', `⚠️ ${skill}:#${issue} fallback "${fbName}" desconocido (índice ${i}), salto.`);
            pushSkip(fbName, SKIP_REASON_CODES.INVALID_HANDLER, `provider no registrado en la tabla de handlers`);
            continue;
        }

        // 3.c — defense in depth: fallback == primary (validator lo prohíbe).
        if (fbName === primaryProvider) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_duplicates_primary',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: 'duplicate_primary',
                },
            });
            pushSkip(fbName, SKIP_REASON_CODES.SAME_AS_PRIMARY, `coincide con el provider primario`);
            continue;
        }

        // 3.d — el fallback también puede estar gateado (otro flag activo).
        const fbGated = quotaModule.shouldGateSpawn(skill, {
            provider: fbName,
            now: _now,
        });
        if (fbGated) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_also_gated',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: `fallback_${fbName}_gated_too`,
                },
            });
            nonScheduleAvailabilityGate = true;
            pushSkip(fbName, SKIP_REASON_CODES.QUOTA_EXHAUSTED, `flag de cuota activo`);
            continue;
        }

        // 3.d.killswitch (#3811) — el fallback también puede estar APAGADO por
        // el kill-switch operacional. Lo saltamos igual que un fallback gateado
        // por cuota, con audit dedicado para distinguir la causa.
        if (_isProviderDisabled(fbName)) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_provider_disabled',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: `fallback_${fbName}_disabled_by_killswitch`,
                },
            });
            log('lanzamiento', `🔌 ${skill}:#${issue || '?'} fallback "${fbName}" APAGADO (kill-switch) — salto al siguiente.`);
            nonScheduleAvailabilityGate = true;
            pushSkip(fbName, SKIP_REASON_CODES.PROVIDER_DISABLED, `kill-switch operativo activo`);
            continue;
        }

        // 3.d.schedule (#3871) — el fallback también puede estar FUERA DE HORARIO.
        // Lo saltamos igual que un fallback apagado, con audit dedicado para
        // distinguir la causa (fuera de horario ≠ kill-switch ≠ cuota).
        if (_isProviderInactive(fbName)) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_provider_inactive_by_schedule',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: `fallback_${fbName}_inactive_by_schedule`,
                },
            });
            log('lanzamiento', `🕒 ${skill}:#${issue || '?'} fallback "${fbName}" FUERA DE HORARIO — salto al siguiente.`);
            scheduleGatedCount++;
            pushSkip(fbName, SKIP_REASON_CODES.PROVIDER_INACTIVE_BY_SCHEDULE, `fuera de horario de actividad`);
            continue;
        }

        // 3.d.bis — MP-05: pre-check de credenciales del fallback. Antes solo el
        // Commander validaba credenciales pre-spawn; en los skills, un fallback
        // sin key se intentaba igual y fallaba recién en runtime como
        // `no_key_configured` (indistinguible de un error de red). Acá lo
        // detectamos antes y saltamos limpio al siguiente candidato.
        const fbDefForCreds = (models && models.providers && models.providers[fbName]) || null;
        const credCheck = validateProviderCredentials(fbName, fbDefForCreds, _env);
        if (!credCheck.ok) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_no_credentials',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    raw_excerpt: `fallback_${fbName}_${credCheck.reason || 'no_credentials'}`,
                },
            });
            log('lanzamiento', `↪️ ${skill}:#${issue || '?'} fallback="${fbName}" sin credencial (${credCheck.reason || 'no_credentials'}) — salto al siguiente.`);
            nonScheduleAvailabilityGate = true;
            pushSkip(fbName, SKIP_REASON_CODES.PERMISSION_MATRIX, `credencial/permiso incompatible (${credCheck.reason || 'no_credentials'})`);
            continue;
        }

        // 3.d.ter — MP-09 (#3809): health-gate FAIL-OPEN. Si el provider del
        // fallback tiene un rojo FRESCO y confiable en multi-provider-health.json
        // lo salteamos (spawn condenado: ya sabemos que está caído). Ante
        // incertidumbre (sin dato, rojo viejo, sin timestamp) NO gateamos —
        // preservamos la cobertura de la cascada. Solo aplica a fallbacks, nunca
        // al primario (ver nota de política arriba).
        const fbHealth = evaluateHealthGate(fbName, healthSnapshot, _now);
        if (fbHealth.gated) {
            auditAppend({
                pipelineDir, fsImpl, sanitize, auditLog, now: _now,
                entry: {
                    event: 'fallback_health_gated',
                    skill,
                    issue: issue || null,
                    fallback_index: i,
                    fallback_provider: fbName,
                    primary_provider: primaryProvider,
                    health_state: fbHealth.state,
                    health_reason: fbHealth.reason,
                    health_age_ms: fbHealth.ageMs,
                    raw_excerpt: `fallback_${fbName}_red_fresh_${fbHealth.reason}`,
                },
            });
            log('lanzamiento', `🩺 ${skill}:#${issue || '?'} fallback="${fbName}" salteado: health=red fresco (${fbHealth.reason}).`);
            nonScheduleAvailabilityGate = true;
            pushSkip(fbName, SKIP_REASON_CODES.HEALTH_GATE, `health=red fresco (${fbHealth.reason})`);
            continue;
        }

        // 3.e — candidato libre. Resolver model para el fallback.
        // #3221 — orden de precedencia para `fbModel`:
        //   1. `fbModelOverride` del entry de fallback (string|{provider,model_override}).
        //      Es lo que pin-ea el modelo concreto del provider (ej. qa quiere
        //      gpt-5 en lugar del gpt-5-codex default de openai-codex).
        //   2. `provider.model` default declarado en la sección providers.
        //   3. `models.defaults.model` (fallback histórico).
        //   4. null.
        //
        // OJO: pre-#3221 el código usaba `skillCfg.model_override` acá, lo cual
        // era incorrecto — ese override aplica al provider PRIMARIO, no al
        // fallback (cada fallback puede correr un modelo distinto del provider
        // distinto). Si todavía hay configs legacy con `fallbacks: [string]`,
        // `fbModelOverride` queda null y el fallback usa el `model` default
        // del provider (comportamiento previo preservado).
        const fbProviderDef = (models && models.providers && models.providers[fbName]) || null;
        const fbModel = fbModelOverride
            || (fbProviderDef && fbProviderDef.model)
            || (models && models.defaults && models.defaults.model)
            || null;

        // Audit + notify (S-6 / S-9).
        auditAppend({
            pipelineDir, fsImpl, sanitize, auditLog, now: _now,
            entry: {
                event: 'fallback_selected',
                skill,
                issue: issue || null,
                fallback_index: i,
                fallback_provider: fbName,
                fallback_model: fbModel,
                primary_provider: primaryProvider,
                primary_model: primary.model || null,
                cross_provider: true,
                chain_tried: chainTried,
                raw_excerpt: `primary=${primaryProvider} gated, fallback=${fbName} libre`,
            },
        });

        const notice =
            `⚠️ Cross-provider fallback activo\n` +
            `skill=${skill} issue=${issue || '?'}\n` +
            `primary=${primaryProvider} (gated)\n` +
            `fallback=${fbName} (índice ${i})\n` +
            `model=${fbModel || 'n/a'}`;
        try {
            _notify({
                pipelineDir,
                fsImpl,
                text: notice,
                meta: {
                    skill,
                    issue: issue || null,
                    primary_provider: primaryProvider,
                    fallback_provider: fbName,
                    fallback_index: i,
                    fallback_model: fbModel,
                },
            });
        } catch { /* best-effort */ }

        log('lanzamiento', `↪️ ${skill}:#${issue} primary=${primaryProvider} gated, usando fallback="${fbName}" (índice ${i})`);

        // #4274 (CA-2 / causa raíz) — resolver el `permission mode` canónico del
        // provider de DESTINO. Antes el return omitía `mode`, el launcher lo
        // rellenaba con `|| 'bypassPermissions'` y, como codex no tiene celda
        // `bypassPermissions` en la matriz, todo salto a codex caía `mode_unknown`
        // (FAIL-CLOSED). `models` ya está en scope (L1157, readAgentModelsRaw).
        const fbMode = resolvePermissionMode(models, fbName);

        // #4274 (CA-8 / SR-5) — auditabilidad de la concesión: el path de fallback
        // loguea provider + mode resuelto (no solo el rechazo), con vocabulario
        // coherente con el log de salto de fallback (↪️).
        log('lanzamiento', `🔓 ${skill}:#${issue} fallback="${fbName}" → mode resuelto="${fbMode || 'null'}"`);

        return {
            provider: fbName,
            model: fbModel,
            handler: fbHandler,
            mode: fbMode, // #4274 — modo canónico por provider (NUEVO)
            source: 'fallback',
            gated: false,
            fallbackUsed: { index: i, provider: fbName },
            primaryProvider,
            chainTried,
            crossProvider: true,
            depthExceeded: false,
            skipReasons,
        };
    }

    // -------------------------------------------------------------------------
    // 4. Chain agotada sin candidato libre.
    // -------------------------------------------------------------------------
    // #4282 — soft-gate sin fallback resoluble: el primary sigue usable, no se
    // pausa (REQ-SEC-3, CA-6). Solo aplica si el único motivo del salto fue el
    // soft preventivo (sin hard gate). El primary en degradación preventiva
    // todavía tiene cuota — solo preferíamos un fallback que no apareció.
    if (primarySoftGated) {
        return _returnPrimarySoftFallthrough(chainTried);
    }
    // #3871 — ¿toda la cadena quedó gateada EXCLUSIVAMENTE por horario? Ese caso
    // tiene semántica propia (`todos_inactivos_por_horario`): el issue vuelve a
    // `pendiente/` esperando que algún provider entre en horario, y se emite una
    // alerta OBLIGATORIA (riesgo de DoS lógico: pipeline congelado en silencio).
    const allInactiveBySchedule = scheduleGatedCount > 0 && !nonScheduleAvailabilityGate;
    const exhaustReason = allInactiveBySchedule ? 'todos_inactivos_por_horario' : 'all_gated';

    auditAppend({
        pipelineDir, fsImpl, sanitize, auditLog, now: _now,
        entry: {
            event: 'chain_exhausted',
            skill,
            issue: issue || null,
            primary_provider: primaryProvider,
            chain_tried: chainTried,
            depth_exceeded: depthExceeded,
            reason: exhaustReason,
            schedule_gated_count: scheduleGatedCount,
            raw_excerpt: `${exhaustReason} chain=${chainTried.join('->')}`,
        },
    });

    if (allInactiveBySchedule) {
        // Alerta obligatoria (SEC #4): nunca congelar el pipeline en silencio.
        log('lanzamiento', `🕒🚫 ${skill}:#${issue} TODOS los providers fuera de horario — spawn en pausa (todos_inactivos_por_horario).`);
        try {
            _notify({
                pipelineDir,
                fsImpl,
                text:
                    `🕒 *Pipeline en pausa por horario*\n` +
                    `Skill \`${skill}\` (issue #${issue || '?'}): el provider primario y todos los fallbacks ` +
                    `están fuera de su ventana de actividad. El spawn queda en pausa hasta que alguno entre en horario.\n` +
                    `Cadena evaluada: ${chainTried.join(' → ')}`,
                meta: { skill, issue: issue || null, event: 'todos_inactivos_por_horario', chain_tried: chainTried },
            });
        } catch { /* best-effort: la alerta nunca debe romper el dispatch */ }
    } else {
        log('lanzamiento', `🚫 ${skill}:#${issue} chain de fallbacks agotada (primario + ${fallbacks.length} fallbacks gated o inválidos).`);
    }

    return {
        ...primary,
        source: 'all-gated',
        gated: true,
        reason: exhaustReason,
        allInactiveBySchedule,
        fallbackUsed: null,
        primaryProvider,
        chainTried,
        crossProvider: false,
        depthExceeded,
        skipReasons,
    };
}

module.exports = {
    resolveSpawnWithFallback,
    enqueueTelegramNotice,
    dispatchAuditFile,
    MAX_FALLBACK_DEPTH,
    TELEGRAM_QUEUE_SUBDIR,
    // #3680 CA-A10 — allowlist hardcoded de skills que pueden activar
    // FORCE_PROVIDER_OVERRIDE. Exportada para inspección/tests.
    FORCED_OVERRIDE_ALLOWED_SKILLS,

    // #3809 MP-09 — health-gate fail-open. Exportados para tests/inspección.
    readProviderHealth,
    evaluateHealthGate,
    HEALTH_FRESHNESS_MS,
    HEALTH_PROVIDER_ALIAS,
    DURABLE_RED_REASONS,

    // #3576 — Hook generalizado post-spawn cross-skill.
    onSpawnExit,
    isGeneralizedParserEnabled,
    spawnExitAuditFile,
    FEATURE_FLAG_NAME,
    CODEPATH_EMOJI,

    // #3823 — Trazabilidad observable de la resolución de provider.
    formatProviderResolutionLog,
    SKIP_REASON_CODES,
    SKIP_REASON_LABELS,

    // exposed for tests
    _readAgentModelsRaw: readAgentModelsRaw,
    _auditAppend: auditAppend,
    _selectErrorTypeForFlag,
};

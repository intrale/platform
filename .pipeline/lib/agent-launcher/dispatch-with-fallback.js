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

const { resolveProviderForSkill, getProviderHandler } = require('./resolve-provider');
// MP-05 (#3803) — reutilizamos la validación de credenciales del precheck del
// Commander para hacer pre-check de credenciales también en los skills antes de
// elegir un fallback (no solo el Commander la tenía).
const { _validateProviderCredentials: validateProviderCredentials } = require('../commander/credentials-precheck');

// #3811 — Kill-switch operacional por provider. Apagar un provider acá ordena
// el salto a fallback (semántica de "caída en runtime"), distinto del gate de
// cuota (semántica de "esperar reset"). Carga perezosa vía default param para
// poder inyectar un fake en los tests sin require cruzado.
const providerDisabledModule = require('../provider-disabled');

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
    const primaryGated = primaryQuotaGated || primaryDisabled;

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

    if (!primaryGated) {
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
        };
    }

    // -------------------------------------------------------------------------
    // 2. Primary gateado → consultar fallbacks[] del skill.
    // -------------------------------------------------------------------------
    const models = readAgentModelsRaw(pipelineDir, fsImpl);
    const skillCfg = (models && models.skills && models.skills[skill]) || null;
    const fallbacks = skillCfg && Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];

    const chainTried = [primaryProvider];
    const sanitize = quotaModule.sanitizeRawExcerpt || ((s) => String(s || ''));

    if (fallbacks.length === 0) {
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
                raw_excerpt: `skill=${skill} provider=${primaryProvider} no_fallbacks`,
            },
        });
        return {
            ...primary,
            source: 'all-gated',
            gated: true,
            fallbackUsed: null,
            primaryProvider,
            chainTried,
            crossProvider: false,
            depthExceeded: false,
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

        return {
            provider: fbName,
            model: fbModel,
            handler: fbHandler,
            source: 'fallback',
            gated: false,
            fallbackUsed: { index: i, provider: fbName },
            primaryProvider,
            chainTried,
            crossProvider: true,
            depthExceeded: false,
        };
    }

    // -------------------------------------------------------------------------
    // 4. Chain agotada sin candidato libre.
    // -------------------------------------------------------------------------
    auditAppend({
        pipelineDir, fsImpl, sanitize, auditLog, now: _now,
        entry: {
            event: 'chain_exhausted',
            skill,
            issue: issue || null,
            primary_provider: primaryProvider,
            chain_tried: chainTried,
            depth_exceeded: depthExceeded,
            raw_excerpt: `all_gated chain=${chainTried.join('->')}`,
        },
    });
    log('lanzamiento', `🚫 ${skill}:#${issue} chain de fallbacks agotada (primario + ${fallbacks.length} fallbacks gated o inválidos).`);

    return {
        ...primary,
        source: 'all-gated',
        gated: true,
        fallbackUsed: null,
        primaryProvider,
        chainTried,
        crossProvider: false,
        depthExceeded,
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

    // #3576 — Hook generalizado post-spawn cross-skill.
    onSpawnExit,
    isGeneralizedParserEnabled,
    spawnExitAuditFile,
    FEATURE_FLAG_NAME,
    CODEPATH_EMOJI,

    // exposed for tests
    _readAgentModelsRaw: readAgentModelsRaw,
    _auditAppend: auditAppend,
    _selectErrorTypeForFlag,
};

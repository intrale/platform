// =============================================================================
// commander/inflight-fallback.js — Fallback in-flight del Commander (#3275).
//
// CONTEXTO
// --------
// #3258 cerró el fallback **pre-spawn**: si Anthropic está marcada como
// cuota agotada antes de spawnear, el dispatcher resuelve al próximo provider
// del array `skill.fallbacks[]`. Lo que quedó sin cubrir:
//
//   - Provider primario disponible al boot pero **cae in-flight** (5xx,
//     timeout sin nuevo byte por 30s, EOF prematuro del stream).
//   - Spawn del primario aceptó el child pero el endpoint devuelve 503 al
//     primer turn.
//
// Este módulo expone la **decisión** de in-flight fallback como función pura:
// el caller (pulpo.js → ejecutarClaude) le pasa el resultado del intento
// primario (errorClass, durationMs, partial output, etc.) y el módulo
// devuelve:
//
//   1. **Cap=1**: máximo 1 fallback in-flight por turn (2 intentos totales).
//   2. **Descarte total** del output parcial (CA-3, no-negociable security):
//      hash SHA-256 del parcial al audit log, contenido NO se entrega ni
//      se concatena.
//   3. **Re-ejecución de policies** (SR-1 / CA-6) por intento: el caller
//      debe llamar a `enforceDataResidency()` ANTES de spawnear el
//      secundario; nosotros emitimos el evento de audit.
//   4. **Late-response lock** (CA-4): mapa atómico por `chat_id+request_id`
//      en memoria. El que llega segundo (primario tardío) se descarta con
//      evento `late_response_discarded`.
//   5. **Budget global SR-5** (CA-7): 90s total desde el inicio del primario.
//      Si la suma de tiempos excede el budget, el secundario NO se intenta
//      y el caller debe entregar canned error.
//   6. **Audit log unificado** (CA-8): eventos `inflight_fallback_initiated`,
//      `inflight_fallback_completed`, `inflight_fallback_exhausted`,
//      `inflight_fallback_global_timeout`, `late_response_discarded` —
//      todos en la misma cadena hash-chain SHA-256 vía `lib/audit-log.js`.
//
// CONTRATO PÚBLICO
// ----------------
//   const decision = decideInflightFallback({
//     primaryProvider,       // string — provider del intento que falló
//     primaryErrorClass,     // 'transient_5xx' | 'timeout_no_new_bytes_30s' | 'eof_premature' | etc.
//     primaryDurationMs,     // ms acumulados del intento primario
//     primaryPartialOutput,  // string — output recibido del primario antes del fallo (puede ser '')
//     attemptIndex,          // 0 = primer intento (era el primario), 1 = secundario, 2+ = exceeded cap
//     budgetMs,              // budget global (default 90_000)
//     pipelineDir,           // para audit log + state file de credentials
//     skill,                 // 'telegram-commander' default
//     chatId,                // chat_id del usuario (hasheado para audit)
//     requestId,             // ID del turn (atómico, para late-response lock)
//     // inyectables tests
//     dispatchModule,
//     quotaModule,
//     auditLog,
//     credentialsPrecheck,
//     fsImpl,
//     now,
//   })
//   →
//   {
//     shouldRetry,           // boolean — si el caller debe spawnear el secundario
//     secondaryProvider,     // string — provider a usar; null si shouldRetry=false
//     secondaryHandler,      // handler del provider efectivo (de getProviderHandler)
//     secondaryModel,        // string — modelo a usar; puede ser null
//     reason,                // string — 'cap_exhausted' | 'global_budget_exceeded' |
//                            //          'all_gated' | 'all_invalid_credentials' | 'ok'
//     noticeText,            // string — copy verbose UX-G1 a enviar a Telegram (null si shouldRetry=false)
//     budgetRemainingMs,     // ms restantes del budget global; 0 si vencido
//     partialOutputHash,     // SHA-256 truncado a 12 hex del partial (para audit/log)
//   }
//
// Y EFECTOS LATERALES:
//   - Append al audit log de los eventos correspondientes (initiated / exhausted / timeout).
//   - NO spawnea, NO envía Telegram (eso lo hace el caller).
//   - NO toca el lock de chat_id+request_id; eso es responsabilidad de
//     `acquireInflightLock` / `releaseInflightLock` exportados aparte.
//
// SEGURIDAD
// ---------
//   S-1: Re-ejecución de `enforceDataResidency` es responsabilidad del caller;
//        nosotros emitimos el audit pero NO bypaseamos el gate.
//   S-2: `partial output` JAMÁS se devuelve ni se concatena. Sólo hash.
//   S-3: cap=1 hardcoded — sin opt-in dinámico. Anti cost-amplification.
//   S-4: budget global 90s hardcoded (configurable via opcional `budgetMs`
//        SOLO para tests; runtime usa default).
//   S-5: fail-closed: si `dispatchModule` o `auditLog` lanzan, retornamos
//        `shouldRetry:false` con `reason: 'internal_error'`.
// =============================================================================
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const COMMANDER_SKILL = 'telegram-commander';
// #4329 — budget global del turno del Commander. Subido de 90s → 600s (10 min)
// para no cortar investigación en vivo. Configurable por env
// `COMMANDER_TURN_BUDGET_MS`, fail-closed (SR-1) + clamp superior (SR-2).
const DEFAULT_BUDGET_MS = 600 * 1000;        // 600s / 10 min (era 90s)
const MAX_BUDGET_MS = 30 * 60 * 1000;        // techo duro: 30 min (SR-2, no eliminar el breaker)
const MAX_INFLIGHT_FALLBACKS = 1;   // 1 fallback in-flight + el intento primario = 2 totales

// resolveTurnBudgetMs — resuelve el budget del turno desde el env, una sola vez
// a nivel módulo. SR-1 fail-closed: no numérico / NaN / <=0 / vacío → default
// 600s (nunca desactiva el corte). SR-2 clamp: por encima del techo → clamp al
// techo, no al valor crudo (un env mal configurado no reintroduce el cuelgue).
function resolveTurnBudgetMs(env = process.env) {
    const v = Number(env && env.COMMANDER_TURN_BUDGET_MS);
    const base = (Number.isFinite(v) && v > 0) ? v : DEFAULT_BUDGET_MS;
    return Math.min(base, MAX_BUDGET_MS);
}
// Budget efectivo del turno (env-resuelto + clampeado). Lo derivan tanto el
// ciclo lógico como el kill duro de `pulpo.js` (SR-4: un único valor).
const TURN_BUDGET_MS = resolveTurnBudgetMs();

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado a 12 hex. Mismo helper que el módulo padre.
// -----------------------------------------------------------------------------
function hashFor(s) {
    return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex').slice(0, 12);
}

// -----------------------------------------------------------------------------
// auditFile — mismo path que `commander/multi-provider.js#auditFile` para
// que todos los eventos del Commander vivan en la misma cadena hash-chain
// del día. NO usamos un archivo separado para no fragmentar la auditoría.
// -----------------------------------------------------------------------------
function auditFile(pipelineDir, now) {
    const d = now ? new Date(now) : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir || '.', 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

function _appendAudit({ pipelineDir, entry, auditLog, fsImpl, now }) {
    if (!pipelineDir || !entry) return false;
    try {
        const _audit = auditLog || require('../audit-log');
        const file = auditFile(pipelineDir, now);
        _audit.appendChained({ file, entry, fsImpl });
        return true;
    } catch { return false; }
}

// -----------------------------------------------------------------------------
// formatInflightFallbackNotice — copy UX-G1 alineado con
// `commander/multi-provider.js#formatFallbackNotice` (mismo formato, pero el
// motivo viene del errorClass del intento in-flight en vez del flag de cuota
// pre-spawn). UX-G2 / G7: solo ⚠️ y ℹ️, sin stack ni request_id.
//
// errorClass → copy en español natural (voseo argentino, feedback_telegram-messages-natural.md).
// -----------------------------------------------------------------------------
function formatInflightFallbackNotice({ primaryProvider, secondaryProvider, errorClass, supportsToolUse }) {
    const lines = [];
    const motive = (() => {
        switch (errorClass) {
            case 'transient_5xx':
            case '5xx':
                return `${primaryProvider} tuvo un error del servidor en medio de la respuesta`;
            case 'timeout_no_new_bytes_30s':
            case 'timeout':
                return `${primaryProvider} se quedó en silencio (sin nueva respuesta hace 30s)`;
            case 'eof_premature':
                return `${primaryProvider} cortó la respuesta antes de tiempo`;
            case 'rate_limit':
                return `${primaryProvider} pegó contra el rate-limit a mitad del turno`;
            default:
                return `${primaryProvider} falló mid-flight (${errorClass || 'sin clasificar'})`;
        }
    })();

    lines.push(`⚠️ ${motive} — reintentando con ${secondaryProvider}.`);

    if (supportsToolUse === false) {
        lines.push(
            `ℹ️ Modo conversacional: el commander no puede ejecutar comandos del pipeline en este request.`
        );
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// cannedInflightExhaustedResponse — Mensaje al usuario cuando los 2 intentos
// (primario + 1 fallback in-flight) fallaron. Varía entre 3 opciones para
// no sonar a bot que repite (feedback_telegram-messages-natural.md), usando
// `requestId` como semilla determinística (mismo turn → mismo mensaje;
// turnos distintos → variación natural).
// -----------------------------------------------------------------------------
const _EXHAUSTED_VARIANTS = Object.freeze([
    '❌ Tuve dos intentos fallidos seguidos — probá de nuevo en unos minutos.',
    '❌ No pude procesar tu pedido en este momento. Intentá de nuevo en unos minutos.',
    '❌ Los providers no respondieron ni en primer intento ni en el fallback — esperá unos minutos y reintentá.',
]);
function cannedInflightExhaustedResponse({ requestId }) {
    if (!requestId) return _EXHAUSTED_VARIANTS[1];
    const idx = parseInt(hashFor(requestId).slice(0, 4), 16) % _EXHAUSTED_VARIANTS.length;
    return _EXHAUSTED_VARIANTS[idx];
}

// -----------------------------------------------------------------------------
// cannedInflightBudgetTimeoutResponse — Mensaje cuando el budget global SR-5
// se agotó antes de poder completar el ciclo. Distinto de exhausted porque
// puede haber sido un primario lento, no necesariamente fallido.
// #4329 (CA-3): el umbral se deriva del budget efectivo, sin literal "90s".
// Para budgets < 60s (posible vía env) se expresa en segundos, para no mostrar
// "más de 0 min" (guideline UX).
// -----------------------------------------------------------------------------
function cannedInflightBudgetTimeoutResponse(budgetMs = TURN_BUDGET_MS) {
    const ms = (Number.isFinite(budgetMs) && budgetMs > 0) ? budgetMs : DEFAULT_BUDGET_MS;
    const umbral = ms >= 60000
        ? `${Math.round(ms / 60000)} min`
        : `${Math.round(ms / 1000)}s`;
    return (
        `⏱️ Tu pedido tardó más de ${umbral} en completarse y corté para no dejarte esperando. ` +
        'Reformulá con algo más puntual o probá de nuevo en un momento.'
    );
}

// -----------------------------------------------------------------------------
// Late-response lock manager (CA-4)
//
// Estructura: Map<`${chatId}|${requestId}`, { closedAt, secondaryProvider }>.
// - `acquireInflightLock` registra el lock al ABRIR el turn (cuando se entrega
//   al usuario).
// - `isLateResponseDuplicate(chatId, requestId)` devuelve true si el lock
//   ya está cerrado para ese par → el caller descarta la respuesta tardía
//   con audit `late_response_discarded`.
//
// TTL (#4329 / SR-3): estrictamente mayor que el peor caso de budget
// (2 × MAX_BUDGET_MS = 60 min). Con el budget nuevo de 600s, un TTL == budget
// dejaría una ventana donde un primario tardío en el borde se trata como turno
// nuevo y su parcial podría llegar al usuario (viola la garantía de no entregar
// parciales). El margen amplio evita esa ventana para cualquier budget efectivo.
//
// **In-process only**: el lock vive en memoria del pulpo. Si pulpo se
// reinicia, el lock se pierde — pero también lo hace el contexto del
// primario tardío (su socket muere con el padre). No hay race cross-process.
// -----------------------------------------------------------------------------
const LATE_RESPONSE_TTL_MS = 2 * MAX_BUDGET_MS;   // estrictamente > cualquier budget efectivo
const _inflightLocks = new Map();

function _lockKey(chatId, requestId) {
    return `${hashFor(chatId || 'unknown')}|${requestId || 'no-request-id'}`;
}

function _gcInflightLocks(now) {
    const _now = Number.isFinite(now) ? now : Date.now();
    for (const [k, v] of _inflightLocks.entries()) {
        if (_now - Number(v.closedAt || 0) > LATE_RESPONSE_TTL_MS) {
            _inflightLocks.delete(k);
        }
    }
}

/**
 * acquireInflightLock — registra que el turn fue entregado al usuario.
 * Llamar DESPUÉS de enviar la respuesta. Cualquier respuesta posterior del
 * primario (late-response) se considera duplicada.
 *
 * Idempotente: si ya hay lock, se respeta el primero (closedAt original).
 */
function acquireInflightLock({ chatId, requestId, secondaryProvider, now } = {}) {
    if (!requestId) return false;
    const k = _lockKey(chatId, requestId);
    if (_inflightLocks.has(k)) return false;
    _inflightLocks.set(k, {
        closedAt: Number.isFinite(now) ? now : Date.now(),
        secondaryProvider: secondaryProvider || null,
    });
    _gcInflightLocks(now);
    return true;
}

/**
 * isLateResponseDuplicate — true si el lock para `(chatId, requestId)` ya
 * fue adquirido. El caller usa esto al recibir output tardío del primario
 * después de haber resuelto con el secundario.
 */
function isLateResponseDuplicate({ chatId, requestId } = {}) {
    if (!requestId) return false;
    return _inflightLocks.has(_lockKey(chatId, requestId));
}

/**
 * releaseInflightLock — libera el lock manualmente (caso edge: el primario
 * respondió OK después de todo y queremos abrir el slot para el próximo
 * turn). En la práctica el GC por TTL es suficiente.
 */
function releaseInflightLock({ chatId, requestId } = {}) {
    if (!requestId) return false;
    return _inflightLocks.delete(_lockKey(chatId, requestId));
}

/**
 * _resetInflightLocks — sólo para tests. NO usar en runtime.
 */
function _resetInflightLocks() {
    _inflightLocks.clear();
}

// -----------------------------------------------------------------------------
// decideInflightFallback — núcleo del módulo.
//
// El caller pasa el estado del intento primario y los inyectables; nosotros:
//   1. Validamos cap (CA-2): si attemptIndex >= MAX_INFLIGHT_FALLBACKS → exhausted.
//   2. Validamos budget (CA-7): si primaryDurationMs >= budgetMs → timeout.
//   3. Calculamos hash del partial output (CA-3) y emitimos
//      `inflight_fallback_initiated` con el hash, nunca el contenido.
//   4. Llamamos al resolver con `excludedProvider=primaryProvider` (mismo
//      patrón que #3343 → `resolveCommanderProviderExcluding`).
//   5. Si todos los providers quedan gateados o sin credencial válida →
//      `all_gated` o `all_invalid_credentials`.
//   6. Si hay candidato, devolvemos shape con noticeText UX-G1.
// -----------------------------------------------------------------------------
function decideInflightFallback(opts = {}) {
    const {
        primaryProvider,
        primaryErrorClass,
        primaryDurationMs,
        primaryPartialOutput,
        attemptIndex,
        budgetMs,
        pipelineDir,
        skill,
        chatId,
        requestId,
        // inyectables tests
        dispatchModule,
        quotaModule,
        auditLog,
        credentialsPrecheck,
        fsImpl,
        now,
        log,
    } = opts;

    const _now = Number.isFinite(now) ? now : Date.now();
    const _log = typeof log === 'function' ? log : () => {};
    const _budget = Number.isFinite(budgetMs) ? budgetMs : DEFAULT_BUDGET_MS;
    const _attempt = Number.isFinite(attemptIndex) ? attemptIndex : 0;
    const _skill = skill || COMMANDER_SKILL;
    const _primaryDur = Number.isFinite(primaryDurationMs) ? primaryDurationMs : 0;
    const partialHash = hashFor(primaryPartialOutput);

    // 1. Cap (CA-2).
    if (_attempt >= MAX_INFLIGHT_FALLBACKS) {
        _appendAudit({
            pipelineDir, auditLog, fsImpl, now: _now,
            entry: {
                event: 'inflight_fallback_exhausted',
                skill: _skill,
                primary_provider: primaryProvider || null,
                primary_error_class: primaryErrorClass || null,
                primary_duration_ms: _primaryDur,
                attempt_index: _attempt,
                request_id: requestId || null,
                chat_id_hash: hashFor(chatId || 'unknown'),
                partial_output_hash: partialHash,
                cap: MAX_INFLIGHT_FALLBACKS,
            },
        });
        _log('commander', `🚫 inflight: cap de ${MAX_INFLIGHT_FALLBACKS} fallback alcanzado para request_id=${requestId || '?'}`);
        return {
            shouldRetry: false,
            secondaryProvider: null,
            secondaryHandler: null,
            secondaryModel: null,
            reason: 'cap_exhausted',
            noticeText: null,
            budgetRemainingMs: Math.max(0, _budget - _primaryDur),
            partialOutputHash: partialHash,
            cannedResponse: cannedInflightExhaustedResponse({ requestId }),
        };
    }

    // 2. Budget global (CA-7).
    if (_primaryDur >= _budget) {
        _appendAudit({
            pipelineDir, auditLog, fsImpl, now: _now,
            entry: {
                event: 'inflight_fallback_global_timeout',
                skill: _skill,
                primary_provider: primaryProvider || null,
                primary_duration_ms: _primaryDur,
                budget_ms: _budget,
                attempt_index: _attempt,
                request_id: requestId || null,
                chat_id_hash: hashFor(chatId || 'unknown'),
                partial_output_hash: partialHash,
            },
        });
        _log('commander', `⏱️ inflight: budget global ${_budget}ms agotado (${_primaryDur}ms en primario)`);
        return {
            shouldRetry: false,
            secondaryProvider: null,
            secondaryHandler: null,
            secondaryModel: null,
            reason: 'global_budget_exceeded',
            noticeText: null,
            budgetRemainingMs: 0,
            partialOutputHash: partialHash,
            cannedResponse: cannedInflightBudgetTimeoutResponse(_budget),
        };
    }

    // 3. Emitir `inflight_fallback_initiated` con hash del parcial. NO contenido.
    _appendAudit({
        pipelineDir, auditLog, fsImpl, now: _now,
        entry: {
            event: 'inflight_fallback_initiated',
            skill: _skill,
            primary_provider: primaryProvider || null,
            primary_error_class: primaryErrorClass || null,
            primary_duration_ms: _primaryDur,
            attempt_index: _attempt,
            request_id: requestId || null,
            chat_id_hash: hashFor(chatId || 'unknown'),
            partial_output_hash: partialHash,
        },
    });

    // 4. Resolver al siguiente provider excluyendo al primario.
    let resolution;
    try {
        const mpModule = require('./multi-provider');
        resolution = mpModule.resolveCommanderProviderExcluding(primaryProvider, {
            pipelineDir,
            log: (l, m) => _log(l || 'commander', m),
            skill: _skill,
            // El skill default `telegram-sherlock` invierte la cadena (free-first).
            // Para el in-flight queremos la chain estándar del commander excluyendo
            // el primario, no la chain invertida. Forzamos el skill original.
            // (`resolveCommanderProviderExcluding` honra el `skill` opcional.)
            dispatchModule,
            quotaModule,
            fsImpl,
            now: _now,
        });
    } catch (e) {
        _log('commander', `❌ inflight: resolver lanzó (${e.message}). Fail-closed.`);
        _appendAudit({
            pipelineDir, auditLog, fsImpl, now: _now,
            entry: {
                event: 'inflight_fallback_resolver_error',
                skill: _skill,
                primary_provider: primaryProvider || null,
                request_id: requestId || null,
                chat_id_hash: hashFor(chatId || 'unknown'),
                error_message: String(e.message || e).slice(0, 200),
            },
        });
        return {
            shouldRetry: false,
            secondaryProvider: null,
            secondaryHandler: null,
            secondaryModel: null,
            reason: 'internal_error',
            noticeText: null,
            budgetRemainingMs: Math.max(0, _budget - _primaryDur),
            partialOutputHash: partialHash,
            cannedResponse: cannedInflightExhaustedResponse({ requestId }),
        };
    }

    if (!resolution || resolution.gated || !resolution.provider || resolution.provider === primaryProvider) {
        _appendAudit({
            pipelineDir, auditLog, fsImpl, now: _now,
            entry: {
                event: 'inflight_fallback_all_gated',
                skill: _skill,
                primary_provider: primaryProvider || null,
                primary_error_class: primaryErrorClass || null,
                request_id: requestId || null,
                chat_id_hash: hashFor(chatId || 'unknown'),
                chain_tried: (resolution && resolution.chainTried) || [primaryProvider],
            },
        });
        _log('commander', `🚫 inflight: todos los providers fallbacks están gateados o no hay candidato`);
        return {
            shouldRetry: false,
            secondaryProvider: null,
            secondaryHandler: null,
            secondaryModel: null,
            reason: 'all_gated',
            noticeText: null,
            budgetRemainingMs: Math.max(0, _budget - _primaryDur),
            partialOutputHash: partialHash,
            cannedResponse: cannedInflightExhaustedResponse({ requestId }),
        };
    }

    // 5. Validar credencial del secundario via precheck (CA-9). Si el
    //    precheck reporta `degraded`, NO usamos ese provider.
    if (credentialsPrecheck && typeof credentialsPrecheck.isProviderDegraded === 'function') {
        if (credentialsPrecheck.isProviderDegraded(resolution.provider)) {
            _appendAudit({
                pipelineDir, auditLog, fsImpl, now: _now,
                entry: {
                    event: 'inflight_fallback_invalid_credentials',
                    skill: _skill,
                    primary_provider: primaryProvider || null,
                    candidate_provider: resolution.provider,
                    request_id: requestId || null,
                    chat_id_hash: hashFor(chatId || 'unknown'),
                },
            });
            _log('commander', `🚫 inflight: secundario ${resolution.provider} sin credencial válida (degradado al boot)`);
            return {
                shouldRetry: false,
                secondaryProvider: null,
                secondaryHandler: null,
                secondaryModel: null,
                reason: 'all_invalid_credentials',
                noticeText: null,
                budgetRemainingMs: Math.max(0, _budget - _primaryDur),
                partialOutputHash: partialHash,
                cannedResponse: cannedInflightExhaustedResponse({ requestId }),
            };
        }
    }

    // 6. Determinar supportsToolUse del provider efectivo (para UX-G3).
    let supportsToolUse = true;
    try {
        const handler = resolution.handler || {};
        if (typeof handler.supportsToolUse === 'boolean') {
            supportsToolUse = handler.supportsToolUse;
        } else if (handler.providerDef && typeof handler.providerDef.supports_tool_use === 'boolean') {
            supportsToolUse = handler.providerDef.supports_tool_use;
        }
    } catch { /* default true */ }

    // 7. Armar copy UX-G1 (verbose, voseo argentino).
    const noticeText = formatInflightFallbackNotice({
        primaryProvider: primaryProvider || '?',
        secondaryProvider: resolution.provider,
        errorClass: primaryErrorClass || 'unknown',
        supportsToolUse,
    });

    _log('commander', `↪️ inflight: ${primaryProvider} (${primaryErrorClass}) → ${resolution.provider} (request_id=${requestId || '?'})`);

    return {
        shouldRetry: true,
        secondaryProvider: resolution.provider,
        secondaryHandler: resolution.handler || null,
        secondaryModel: resolution.model || null,
        reason: 'ok',
        noticeText,
        budgetRemainingMs: Math.max(0, _budget - _primaryDur),
        partialOutputHash: partialHash,
        supportsToolUse,
        chainTried: resolution.chainTried || null,
    };
}

// -----------------------------------------------------------------------------
// noteInflightCompleted — el caller llama acá DESPUÉS de entregar la respuesta
// del secundario al usuario (sea exitosa o no). Emite `inflight_fallback_completed`
// con el shape final para que el audit log refleje el outcome real.
//
// Conviene llamarlo desde el callback final del spawn secundario,
// independientemente del éxito (success: bool).
// -----------------------------------------------------------------------------
function noteInflightCompleted(opts = {}) {
    const {
        pipelineDir,
        primaryProvider,
        secondaryProvider,
        success,
        secondaryDurationMs,
        secondaryTokens,
        chatId,
        requestId,
        cacheMissDueToProviderChange,
        // #4309 — skill del agente que ejecutó el fallback. Default COMMANDER_SKILL
        // por backward-compat: el camino del Commander no lo pasa y sigue
        // registrando `telegram-commander`. Los agentes de pipeline pasan su
        // propio skill para que el audit refleje quién cayó al secundario (CA-3).
        skill,
        // inyectables
        auditLog,
        fsImpl,
        now,
    } = opts;

    const ok = _appendAudit({
        pipelineDir, auditLog, fsImpl, now,
        entry: {
            event: 'inflight_fallback_completed',
            skill: skill || COMMANDER_SKILL,
            primary_provider: primaryProvider || null,
            secondary_provider: secondaryProvider || null,
            success: !!success,
            secondary_duration_ms: Number.isFinite(secondaryDurationMs) ? Math.round(secondaryDurationMs) : null,
            secondary_tokens: secondaryTokens || null,
            request_id: requestId || null,
            chat_id_hash: hashFor(chatId || 'unknown'),
            cache_miss_due_to_provider_change: !!cacheMissDueToProviderChange,
        },
    });
    return ok;
}

// -----------------------------------------------------------------------------
// noteLateResponseDiscarded — el caller llama acá cuando el primario
// respondió DESPUÉS de que el secundario ya entregó. Idempotente: registra
// el descarte sin re-entregar al usuario.
//
// Importante: el caller debe llamar `isLateResponseDuplicate` PRIMERO para
// distinguir entre primer arribo y arribo tardío. Sólo si la respuesta es
// tardía, llama a este helper.
// -----------------------------------------------------------------------------
function noteLateResponseDiscarded(opts = {}) {
    const {
        pipelineDir,
        primaryProvider,
        partialOutput,
        chatId,
        requestId,
        // #4309 — ver noteInflightCompleted: default COMMANDER_SKILL.
        skill,
        auditLog,
        fsImpl,
        now,
    } = opts;

    return _appendAudit({
        pipelineDir, auditLog, fsImpl, now,
        entry: {
            event: 'late_response_discarded',
            skill: skill || COMMANDER_SKILL,
            primary_provider: primaryProvider || null,
            request_id: requestId || null,
            chat_id_hash: hashFor(chatId || 'unknown'),
            partial_output_hash: hashFor(partialOutput),
        },
    });
}

// -----------------------------------------------------------------------------
// generateRequestId — genera un identificador único determinista por turn.
// Formato: `tg-<chatIdHash>-<unixMs>-<rand4>`. Atomicidad garantizada por
// la combinación timestamp + random (suficiente para evitar colisiones
// dentro del proceso del pulpo en un turno único).
// -----------------------------------------------------------------------------
function generateRequestId({ chatId, now } = {}) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `tg-${hashFor(chatId || 'unknown')}-${ts}-${rand}`;
}

module.exports = {
    // Constantes
    COMMANDER_SKILL,
    DEFAULT_BUDGET_MS,
    MAX_BUDGET_MS,
    TURN_BUDGET_MS,
    resolveTurnBudgetMs,
    MAX_INFLIGHT_FALLBACKS,
    LATE_RESPONSE_TTL_MS,

    // Core decision
    decideInflightFallback,
    noteInflightCompleted,
    noteLateResponseDiscarded,

    // UX copy
    formatInflightFallbackNotice,
    cannedInflightExhaustedResponse,
    cannedInflightBudgetTimeoutResponse,

    // Lock manager
    acquireInflightLock,
    isLateResponseDuplicate,
    releaseInflightLock,

    // Helpers
    generateRequestId,

    // Exports para tests del propio módulo
    _hashFor: hashFor,
    _auditFile: auditFile,
    _resetInflightLocks,
};

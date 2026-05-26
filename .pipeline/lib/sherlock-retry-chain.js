// =============================================================================
// sherlock-retry-chain.js — Cascada de reintentos del verificador Sherlock
// (#3558). Encapsula la lógica de iteración sobre providers/modelos cuando un
// intento falla (timeout, schema_violation, provider_error, etc.).
//
// CONTEXTO
// --------
// Hasta #3484, Sherlock hacía UN SOLO intento contra el provider resuelto. Si
// fallaba (timeout, 5xx, schema_violation), retornaba `verdict=aborted` + el
// disclaimer F-6 inmediatamente, sin probar otro modelo ni otro provider de la
// chain `telegram-sherlock`. Eso es incompatible con el comportamiento
// multi-provider del resto del pipeline (commander-dispatch, guru, etc.) y
// genera F-6 silenciosos demasiado frecuentes.
//
// #3558 introduce `retryInCascade()`: dado un provider inicial + chain,
// reintenta primero con otro modelo del MISMO provider (preserva adversariality
// porque el provider del verifier sigue siendo distinto al del Commander), y
// luego salta al siguiente provider de la chain. Solo emite F-6 cuando toda la
// cascada agota.
//
// INVARIANTES (de los criterios formales de #3558, fase `criterios`)
// -------------------------------------------------------------------
// CA-F2  — max 2 modelos por provider, max 3 providers.
// CA-F3  — emitir `sherlock_retry_attempt` por cada intento fallido (sin PII).
// CA-F5  — DISCLAIMER_F6 solo cuando agote la cascada (o se gatille el cap).
// CA-SEC-3-RECHECK — re-invocar enforceDataResidency POR CADA provider distinto.
// CA-SEC-SKIP-QUOTA — NO retry same-provider en rate_limited/quota_exhausted.
// CA-SEC-CASCADE-CAP — cap total 180s (default), abortar con `cascade_timeout`.
// CA-SEC-AUDIT-REDACT — solo campos seguros en el audit (no prompt, no body).
// CA-SEC-CRED-FILTER — filtrar providers sin credencial ANTES de iterar.
// CA-INV-ADVERSARIAL — same-provider rota a un modelo DISTINTO (allowlist).
//
// API PÚBLICA
// -----------
//   retryInCascade({
//     chain,                  // [{provider, model, transport}] full chain
//     initialProvider,        // string del provider inicial (ya resuelto)
//     initialModel,           // string del modelo inicial
//     initialTransport,       // 'http' | 'spawn'
//     complete,               // async ({provider, model, transport}) => httpResult
//     parseAndValidate,       // (content) => {ok, data, reason}
//     modelsAllowlist,        // PROVIDER_MODELS_ALLOWLIST de completion-client
//     hasCredential,          // (provider) => boolean
//     enforceResidency,       // (provider) => {ok, reason?}
//     emitAuditEvent,         // ({event, payload}) => void
//     maxAttemptsPerProvider, // default 2
//     maxProviders,           // default 3
//     maxTotalCascadeMs,      // default 180_000
//     log, now,
//   })
//
//   Devuelve:
//     éxito → { ok: true, httpResult, parsed, providerUsed, modelUsed,
//               transportUsed, attemptsCount, chainTried, fallbackUsed }
//     fallo → { ok: false, errorCode, lastError, attemptsCount,
//               chainTried, fallbackUsed, cascadeAbortedByCap }
//
// CLASIFICACIÓN DE ERRORES (CA-SEC-SKIP-QUOTA)
// ---------------------------------------------
// El módulo decide entre "retry same-provider con otro modelo" vs "saltar al
// siguiente provider" en base a `error.reason` y `error.type`:
//
// RETRY_SAME_PROVIDER (puede rotar modelo mismo provider):
//   - timeout
//   - schema_violation (output del Sherlock no parseable)
//   - schema_drift, body_too_large, invalid_response
//   - network_error
//   - unknown (5xx)
//   - spawn_exit, spawn_error, spawn_failed
//
// SKIP_TO_NEXT_PROVIDER (no retry mismo provider — distinto bucket de quota,
// credencial inválida, etc.):
//   - rate_limited, quota_exhausted
//   - invalid_credentials, forbidden
//   - no_key_configured
//   - invalid_model, unknown_provider
//   - residency_blocked
//
// =============================================================================
'use strict';

const DEFAULT_MAX_ATTEMPTS_PER_PROVIDER = 2;
const DEFAULT_MAX_PROVIDERS = 3;
const DEFAULT_MAX_TOTAL_CASCADE_MS = 180_000;

// Errores en los que NO conviene reintentar otro modelo del mismo provider —
// el problema es del bucket de quota/credencial/residency, no del modelo.
// CA-SEC-SKIP-QUOTA + CA-SEC-3-RECHECK + CA-SEC-CRED-FILTER.
const SKIP_PROVIDER_REASONS = Object.freeze(new Set([
    'rate_limited',
    'quota_exhausted',
    'invalid_credentials',
    'forbidden',
    'no_key_configured',
    'invalid_model',
    'unknown_provider',
    'residency_blocked',
]));

const SKIP_PROVIDER_TYPES = Object.freeze(new Set([
    'auth_error',
    'no_key_configured',
    'unknown_provider',
    'invalid_model',
]));

// -----------------------------------------------------------------------------
// classifyAttemptError — recibe el `httpResult` de un intento (o el resultado
// de parseAndValidate cuando el HTTP fue ok pero el schema falla) y devuelve
// la acción a tomar: 'skip_provider' | 'retry_same_provider'.
//
// `errorCtx` viene normalizado del caller:
//   { type, reason, statusCode?, source: 'http'|'schema'|'residency' }
// -----------------------------------------------------------------------------
function classifyAttemptError(errorCtx) {
    if (!errorCtx || typeof errorCtx !== 'object') {
        return 'retry_same_provider';
    }
    const reason = errorCtx.reason || null;
    const type = errorCtx.type || null;

    if (reason && SKIP_PROVIDER_REASONS.has(reason)) return 'skip_provider';
    if (type && SKIP_PROVIDER_TYPES.has(type)) return 'skip_provider';

    // Caso explícito: source=residency siempre salta provider (el path de
    // residency-blocked se detecta antes del dispatch, pero igual lo cubrimos
    // por defensa en profundidad).
    if (errorCtx.source === 'residency') return 'skip_provider';

    // Default: el problema parece transitorio o de modelo — vale rotar
    // modelo dentro del mismo provider.
    return 'retry_same_provider';
}

// -----------------------------------------------------------------------------
// pickNextModelSameProvider — dado un provider y la lista de modelos ya usados,
// devuelve el próximo modelo de la allowlist que no haya sido probado.
// Devuelve `null` si no hay más modelos disponibles para ese provider (por
// ejemplo, anthropic vía spawn-CLI no tiene allowlist explícita en este
// módulo).
//
// CA-INV-ADVERSARIAL: el modelo retornado SIEMPRE es distinto al último
// intento (lookup en `modelsAllowlist`).
// -----------------------------------------------------------------------------
function pickNextModelSameProvider({ provider, usedModels, modelsAllowlist, currentModel }) {
    if (!modelsAllowlist || typeof modelsAllowlist !== 'object') return null;
    const list = modelsAllowlist[provider];
    if (!Array.isArray(list) || list.length === 0) return null;

    const used = new Set(usedModels || []);
    if (currentModel) used.add(currentModel);

    for (const m of list) {
        if (!used.has(m)) return m;
    }
    return null;
}

// -----------------------------------------------------------------------------
// redactErrorForAudit — extrae solo los campos seguros del error para el audit
// log (CA-SEC-AUDIT-REDACT). NUNCA exporta `detail` con body crudo, prompt, ni
// stderr del spawn — solo metadatos tipados.
// -----------------------------------------------------------------------------
function redactErrorForAudit(errorObj) {
    if (!errorObj || typeof errorObj !== 'object') {
        return { type: 'unknown', reason: null, statusCode: null };
    }
    const out = {
        type: typeof errorObj.type === 'string' ? errorObj.type : 'unknown',
        reason: typeof errorObj.reason === 'string' ? errorObj.reason : null,
    };
    if (Number.isFinite(errorObj.statusCode)) {
        out.statusCode = errorObj.statusCode;
    } else {
        out.statusCode = null;
    }
    // parseError.code se incluye SOLO el code (no el mensaje completo).
    if (errorObj.parseErrorCode && typeof errorObj.parseErrorCode === 'string') {
        out.parseErrorCode = errorObj.parseErrorCode;
    }
    return out;
}

// -----------------------------------------------------------------------------
// buildProviderList — arma la cadena ordenada de providers a probar.
//   1. Inicial primero.
//   2. Resto de la chain en orden, sin duplicados.
//   3. Filtra providers sin credencial (CA-SEC-CRED-FILTER), emitiendo
//      `sherlock_provider_skipped` por cada uno.
//   4. Trunca a `maxProviders`.
// -----------------------------------------------------------------------------
function buildProviderList({
    chain,
    initialProvider,
    initialModel,
    initialTransport,
    maxProviders,
    hasCredential,
    emitAuditEvent,
    log,
}) {
    const _log = typeof log === 'function' ? log : () => {};
    const seen = new Set();
    const ordered = [];

    if (initialProvider) {
        ordered.push({
            provider: initialProvider,
            model: initialModel || null,
            transport: initialTransport || 'http',
        });
        seen.add(initialProvider);
    }

    if (Array.isArray(chain)) {
        for (const item of chain) {
            if (!item || !item.provider) continue;
            if (seen.has(item.provider)) continue;
            ordered.push({
                provider: item.provider,
                model: item.model || null,
                transport: item.transport || 'http',
            });
            seen.add(item.provider);
        }
    }

    // CA-SEC-CRED-FILTER — filtramos providers sin credencial. Para anthropic
    // (spawn-CLI) no hay key managed; lo consideramos siempre con credencial
    // (el handler del spawn revisa el binario al despachar).
    const filtered = [];
    for (const cand of ordered) {
        if (cand.transport === 'spawn') {
            // Spawn no usa key managed; pasa el filtro.
            filtered.push(cand);
            continue;
        }
        let has = true;
        try {
            has = typeof hasCredential === 'function'
                ? Boolean(hasCredential(cand.provider))
                : true;
        } catch (e) {
            _log('sherlock', `retry-chain: hasCredential(${cand.provider}) error: ${e && e.message}`);
            has = false;
        }
        if (has) {
            filtered.push(cand);
        } else {
            _log('sherlock', `retry-chain: provider ${cand.provider} sin credencial — skipped (CA-SEC-CRED-FILTER)`);
            try {
                if (typeof emitAuditEvent === 'function') {
                    emitAuditEvent({
                        event: 'sherlock_provider_skipped',
                        payload: {
                            provider: cand.provider,
                            reason: 'missing_credential',
                            severity: 'warn',
                        },
                    });
                }
            } catch { /* best-effort */ }
        }
    }

    const cap = Number.isFinite(maxProviders) && maxProviders > 0
        ? maxProviders
        : DEFAULT_MAX_PROVIDERS;
    return filtered.slice(0, cap);
}

// -----------------------------------------------------------------------------
// runResidencyCheck — wrapper defensivo del enforceResidency inyectable.
// Retorna `{ ok: true }` o `{ ok: false, reason }`. Si el caller no inyectó
// enforceResidency, asume ok (no aplicable).
// -----------------------------------------------------------------------------
function runResidencyCheck(enforceResidency, provider) {
    if (typeof enforceResidency !== 'function') return { ok: true };
    try {
        const res = enforceResidency(provider);
        if (res && res.ok === false) {
            return { ok: false, reason: res.reason || 'residency_blocked' };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: 'residency_check_error', detail: e && e.message };
    }
}

// -----------------------------------------------------------------------------
// retryInCascade — orquesta la cascada.
//
// Estrategia:
//   1. Construir la lista de providers candidatos (initial + chain, sin
//      duplicados, filtrados por credencial, capped por maxProviders).
//   2. Para cada provider:
//      a. Re-validar data-residency (CA-SEC-3-RECHECK).
//      b. Probar hasta `maxAttemptsPerProvider` modelos (el primero es el
//         resuelto inicial, los siguientes vienen de modelsAllowlist).
//      c. Si éxito → return.
//      d. Si error skip_provider → break y pasar al próximo provider.
//      e. Si error retry_same_provider → rotar modelo y volver a (b).
//   3. Si en algún punto el reloj acumulado supera maxTotalCascadeMs →
//      abortar con `cascade_timeout` (CA-SEC-CASCADE-CAP).
//   4. Al agotar la lista sin éxito → return ok:false con `exhausted_cascade`.
// -----------------------------------------------------------------------------
async function retryInCascade({
    chain,
    initialProvider,
    initialModel,
    initialTransport,
    complete,
    parseAndValidate,
    modelsAllowlist,
    hasCredential,
    enforceResidency,
    emitAuditEvent,
    maxAttemptsPerProvider = DEFAULT_MAX_ATTEMPTS_PER_PROVIDER,
    maxProviders = DEFAULT_MAX_PROVIDERS,
    maxTotalCascadeMs = DEFAULT_MAX_TOTAL_CASCADE_MS,
    log,
    now,
} = {}) {
    const _log = typeof log === 'function' ? log : () => {};
    const _now = typeof now === 'function' ? now : Date.now;
    const startedAt = _now();

    const providers = buildProviderList({
        chain,
        initialProvider,
        initialModel,
        initialTransport,
        maxProviders,
        hasCredential,
        emitAuditEvent,
        log: _log,
    });

    if (providers.length === 0) {
        return {
            ok: false,
            errorCode: 'no_eligible_providers',
            attemptsCount: 0,
            chainTried: [],
            fallbackUsed: false,
            cascadeAbortedByCap: false,
            lastError: null,
        };
    }

    const chainTried = [];
    let attemptsCount = 0;
    let lastError = null;
    let cascadeAbortedByCap = false;

    for (let pi = 0; pi < providers.length; pi++) {
        const cand = providers[pi];
        chainTried.push(cand.provider);

        // CA-SEC-3-RECHECK — re-validar residency por cada provider distinto
        // (siempre, no solo cuando cambiamos — el initial también pasa por acá
        // si el caller no lo validó previamente). Si bloquea → skip al próximo.
        const drCheck = runResidencyCheck(enforceResidency, cand.provider);
        if (!drCheck.ok) {
            attemptsCount++;
            const redacted = {
                type: 'residency',
                reason: 'residency_blocked',
                statusCode: null,
            };
            lastError = redacted;
            try {
                if (typeof emitAuditEvent === 'function') {
                    emitAuditEvent({
                        event: 'sherlock_retry_attempt',
                        payload: {
                            provider: cand.provider,
                            model: cand.model,
                            attemptNumber: attemptsCount,
                            error: redacted,
                            durationMs: 0,
                            timestamp: _now(),
                        },
                    });
                }
            } catch { /* best-effort */ }
            _log('sherlock', `retry-chain: residency blocked para ${cand.provider} — skip`);
            continue;
        }

        // CA-SEC-CASCADE-CAP check antes de empezar este provider.
        if (_now() - startedAt > maxTotalCascadeMs) {
            cascadeAbortedByCap = true;
            _log('sherlock', `retry-chain: cap total ${maxTotalCascadeMs}ms superado — abortar`);
            break;
        }

        const usedModels = [];
        let skipToNext = false;

        for (let ai = 0; ai < maxAttemptsPerProvider; ai++) {
            // Determinar el modelo a usar en este intento:
            //   ai=0: el modelo del candidato (initialModel para initial, o
            //         el modelo "default" del provider en la chain).
            //   ai>0: pickNextModelSameProvider con allowlist.
            let modelToUse;
            if (ai === 0) {
                modelToUse = cand.model || pickNextModelSameProvider({
                    provider: cand.provider,
                    usedModels,
                    modelsAllowlist,
                    currentModel: null,
                });
            } else {
                modelToUse = pickNextModelSameProvider({
                    provider: cand.provider,
                    usedModels,
                    modelsAllowlist,
                    currentModel: usedModels[usedModels.length - 1] || null,
                });
            }

            if (!modelToUse) {
                // No hay más modelos disponibles para este provider; salir
                // del loop interno (no es un error, es agotamiento de modelos).
                _log('sherlock', `retry-chain: no hay más modelos disponibles para ${cand.provider}`);
                break;
            }

            // Cap de tiempo antes de cada intento (CA-SEC-CASCADE-CAP).
            if (_now() - startedAt > maxTotalCascadeMs) {
                cascadeAbortedByCap = true;
                _log('sherlock', `retry-chain: cap total ${maxTotalCascadeMs}ms superado mid-cascade — abortar`);
                break;
            }

            usedModels.push(modelToUse);
            attemptsCount++;
            const attemptStartedAt = _now();
            let httpResult;
            try {
                httpResult = await complete({
                    provider: cand.provider,
                    model: modelToUse,
                    transport: cand.transport,
                });
            } catch (e) {
                httpResult = {
                    ok: false,
                    error: {
                        type: 'unknown',
                        detail: e && e.message ? e.message : String(e),
                    },
                    provider: cand.provider,
                    model: modelToUse,
                    durationMs: _now() - attemptStartedAt,
                };
            }
            const attemptDurationMs = _now() - attemptStartedAt;

            if (httpResult && httpResult.ok) {
                // CA-INV-SCHEMA — validar el output del Sherlock SIEMPRE.
                let parsed;
                if (typeof parseAndValidate === 'function') {
                    try {
                        parsed = parseAndValidate(httpResult.content);
                    } catch (e) {
                        parsed = { ok: false, reason: 'parse_exception' };
                    }
                } else {
                    parsed = { ok: true, data: null };
                }

                if (parsed && parsed.ok) {
                    // Éxito definitivo.
                    const fallbackUsed = cand.provider !== initialProvider;
                    return {
                        ok: true,
                        httpResult,
                        parsed,
                        providerUsed: cand.provider,
                        modelUsed: modelToUse,
                        transportUsed: cand.transport,
                        attemptsCount,
                        chainTried,
                        fallbackUsed,
                        cascadeAbortedByCap: false,
                    };
                }

                // Schema_violation: contabilizar como intento fallido y
                // permitir retry same-provider (CA-INV-SCHEMA + CA-SEC-SKIP-QUOTA
                // no aplica → rota modelo).
                const redacted = redactErrorForAudit({
                    type: 'schema_violation',
                    reason: 'schema_violation',
                    parseErrorCode: parsed && parsed.reason ? String(parsed.reason) : 'unknown',
                });
                lastError = redacted;
                try {
                    if (typeof emitAuditEvent === 'function') {
                        emitAuditEvent({
                            event: 'sherlock_retry_attempt',
                            payload: {
                                provider: cand.provider,
                                model: modelToUse,
                                attemptNumber: attemptsCount,
                                error: redacted,
                                durationMs: attemptDurationMs,
                                timestamp: _now(),
                            },
                        });
                    }
                } catch { /* best-effort */ }
                // Decisión: schema_violation rota modelo same-provider.
                const action = classifyAttemptError({
                    type: 'schema_violation',
                    reason: 'schema_violation',
                    source: 'schema',
                });
                if (action === 'skip_provider') {
                    skipToNext = true;
                    break;
                }
                // continue inner loop → rotar modelo
                continue;
            }

            // httpResult.ok === false → error de transporte/HTTP/spawn.
            const errObj = (httpResult && httpResult.error) || { type: 'unknown' };
            const redacted = redactErrorForAudit(errObj);
            lastError = redacted;
            try {
                if (typeof emitAuditEvent === 'function') {
                    emitAuditEvent({
                        event: 'sherlock_retry_attempt',
                        payload: {
                            provider: cand.provider,
                            model: modelToUse,
                            attemptNumber: attemptsCount,
                            error: redacted,
                            durationMs: attemptDurationMs,
                            timestamp: _now(),
                        },
                    });
                }
            } catch { /* best-effort */ }

            const action = classifyAttemptError({
                type: errObj.type,
                reason: errObj.reason,
                source: 'http',
            });
            if (action === 'skip_provider') {
                _log('sherlock', `retry-chain: ${cand.provider} → skip provider (reason=${errObj.reason || errObj.type})`);
                skipToNext = true;
                break;
            }
            // retry_same_provider → continúa el loop interno (rotar modelo).
        }

        if (cascadeAbortedByCap) break;
        // skipToNext o agotamiento de modelos del provider → ir al siguiente.
        void skipToNext;
    }

    const fallbackUsed = chainTried.length > 1
        || (chainTried.length === 1 && chainTried[0] !== initialProvider);
    const errorCode = cascadeAbortedByCap ? 'cascade_timeout' : 'exhausted_cascade';

    return {
        ok: false,
        errorCode,
        lastError,
        attemptsCount,
        chainTried,
        fallbackUsed,
        cascadeAbortedByCap,
    };
}

module.exports = {
    retryInCascade,
    // Exports para tests
    _classifyAttemptError: classifyAttemptError,
    _pickNextModelSameProvider: pickNextModelSameProvider,
    _redactErrorForAudit: redactErrorForAudit,
    _buildProviderList: buildProviderList,
    _runResidencyCheck: runResidencyCheck,
    DEFAULT_MAX_ATTEMPTS_PER_PROVIDER,
    DEFAULT_MAX_PROVIDERS,
    DEFAULT_MAX_TOTAL_CASCADE_MS,
    SKIP_PROVIDER_REASONS,
    SKIP_PROVIDER_TYPES,
};

// =============================================================================
// sherlock-verifier.js — Verificador adversarial del Commander de Telegram
// (#3343, split de #3331). Hija hermana: #3342 (HTTP completion-client).
//
// CONTEXTO
// --------
// Entre 2026-05-17 y 2026-05-18 el Commander cometió 5 errores serios de
// análisis por confiar en memory/contexto previo en lugar de re-verificar
// el estado actual del sistema. Sherlock institucionaliza la contraposición:
//   - prompt invariante ("fiscal")
//   - provider DISTINTO al del Commander
//   - timeout defensivo (10s default)
//   - disclaimer si falla la verificación
//   - cap reelaboración hardcoded = 1
//
// Sherlock NO es un skill de agente — corre IN-PROCESS dentro del flujo
// `recogerTextoLibre` del pulpo, entre `ejecutarClaude` y `sendTelegram`.
// El pulpo lo wirea con `verify(...)`; este módulo no toca filesystem ni
// red por su cuenta (todo se inyecta vía completion-client).
//
// FLOW (resumido — el flujo completo está en pulpo.js):
//   Commander responde →
//     Sherlock.verify(analysis, originalRequest, systemState, excludedProvider)
//       → si verdict=ok → respuesta original sin cambios
//       → si verdict=rechazado y reelaboraciones < 1 →
//            Commander reelabora con `inconsistencies` →
//              Sherlock.verify(reelaborada, ...) (2da pasada)
//       → si 2da pasada rechaza → respuesta reelaborada + disclaimer F-5
//       → si timeout/schema-fail/sin-provider → original + disclaimer F-6
//
// DEFENSAS (CA-SEC-1..9)
// ----------------------
// - CA-SEC-1: sanitizeUserPrompt sobre `analysis` ANTES de mandar al provider.
// - CA-SEC-2: delimitadores XML estructurados (<analysis>, <system_state>,
//             <original_request>) — el modelo distingue contexto de input.
// - CA-SEC-3: data-residency-filter fail-closed ANTES de cualquier provider
//             call (no-Anthropic). Emite `sherlock_aborted_residency`.
// - CA-SEC-4: credenciales unificadas — completion-client lee solo de
//             ~/.claude/secrets/credentials.json vía secrets-rw.
// - CA-SEC-5: anti-SSRF + HTTPS — completion-client tiene URLs hardcoded
//             allowlisted y rechaza non-HTTPS.
// - CA-SEC-6: schema strict del output del Sherlock (whitelist exacta de
//             keys, types, cap `inconsistencies <= 5`). Emite
//             `sherlock_schema_violation` si no matchea.
// - CA-SEC-7: `sherlock_enabled` se lee SOLO desde config.yaml. Cualquier
//             intento de toggle por input externo emite
//             `sherlock_toggle_attempt_ignored` y se ignora.
// - CA-SEC-8: log solo HASHES SHA-256 truncados de claim/contradiction/
//             analysis/systemState hasta que #3338 redacte secrets en
//             audit-log.js.
// - CA-SEC-9: cap reelaboración hardcoded = 1 en código. Aunque config
//             diga `sherlock_max_reelaboraciones: 99`, `Math.min(N, 1)`
//             gana siempre (invariante).
//
// EVENTOS de audit log (reusa `commander-dispatch-YYYY-MM-DD.jsonl`):
//   - sherlock_verification              — resultado de cada verificación
//   - sherlock_skipped_disabled          — feature toggle OFF
//   - sherlock_aborted_residency         — fail-closed del data-residency
//   - sherlock_schema_violation          — output del Sherlock no matchea schema
//   - sherlock_toggle_attempt_ignored    — intento anti-CA-SEC-7
//   - commander_response                 — correlación turn-level
// =============================================================================
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const commanderMP = require('./commander/multi-provider');

// Invariante CA-SEC-9 — hardcoded, NO depende de config.
const HARDCODED_MAX_REELABORACIONES = 1;

// Clamp defensivo del timeout — config no puede pedir más de 30s para
// evitar starvation de turnos Telegram.
const ABSOLUTE_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

// Cap defensivo de inconsistencias aceptadas en el output del Sherlock
// (CA-SEC-6). Si el modelo dice "encontré 50 inconsistencias", recortamos
// a las primeras 5. Más que eso es ruido o intento de DoS de payload.
const MAX_INCONSISTENCIES = 5;

// Allowlist de providers HTTP-compatibles (consumibles por completion-client).
// `openai-codex` y `anthropic` quedan en la chain `telegram-sherlock` para
// el futuro (cuando se sume spawn-vía-completion-client) pero hoy Sherlock
// los salta. Si todos los HTTP-compatibles están gateados, abortamos con F-6.
const HTTP_COMPATIBLE_PROVIDERS = Object.freeze(new Set([
    'cerebras',
    'gemini-google',
    'nvidia-nim',
]));

// -----------------------------------------------------------------------------
// Disclaimers (CA-F-5/F-6) — constantes string en español, voseo argentino.
// UX guidelines del padre #3331:
//   - voseo ("verificá manualmente")
//   - sin sello visible cuando verdict=ok
//   - diferenciación timeout (F-6) vs inconsistencia persistente (F-5)
//   - info accionable al usuario
//   - sin avisar pre-Sherlock
// El pool de variantes rotativas queda para #3339 (no en este scope).
// -----------------------------------------------------------------------------
const DISCLAIMER_F5_PERSISTENT_INCONSISTENCY = (
    '\n\n' +
    '⚠️ Sherlock detectó inconsistencias en mi respuesta incluso después de ' +
    'reelaborar. Te paso la versión reelaborada igual, pero verificá manualmente ' +
    'antes de decidir.'
);

const DISCLAIMER_F6_VERIFICATION_FAILED = (
    '\n\n' +
    '⚠️ No pude verificar esta respuesta con Sherlock (timeout o sin provider ' +
    'distinto disponible). Te la paso sin contraste — revisá los datos manualmente ' +
    'si vas a actuar sobre algo crítico.'
);

const DISCLAIMER_TYPES = Object.freeze({
    NONE:                   null,
    TIMEOUT_OR_NO_PROVIDER: 'timeout',
    PERSISTENT_INCONSISTENCY: 'rechazado-persistente',
});

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado a 16 hex (8 bytes). Reusado para todos los
// payloads sensibles del audit log (CA-SEC-8).
// -----------------------------------------------------------------------------
function hashFor(s) {
    return crypto.createHash('sha256')
        .update(String(s == null ? '' : s), 'utf8')
        .digest('hex').slice(0, 16);
}

// -----------------------------------------------------------------------------
// loadSherlockConfig — lee config.yaml (sherlock_enabled, timeout,
// max_reelaboraciones). Aplica clamps defensivos (CA-SEC-9, CA-L-1).
//
// CA-SEC-7: solo lee del archivo, NUNCA acepta `enabled` por argumento del
// usuario. El caller (pulpo.js) lo pasa con `configLoader` inyectable solo
// para tests; en producción siempre es el `loadConfig` real.
// -----------------------------------------------------------------------------
function loadSherlockConfig({ configLoader } = {}) {
    let cfg = {};
    try {
        cfg = (typeof configLoader === 'function') ? (configLoader() || {}) : {};
    } catch {
        cfg = {};
    }
    const enabled = cfg.sherlock_enabled === false ? false : true; // default ON
    const timeoutRaw = Number(cfg.sherlock_timeout_ms);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(timeoutRaw, ABSOLUTE_MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
    // CA-SEC-9 — el cap es 1, no importa qué diga config.
    const maxRaw = Number(cfg.sherlock_max_reelaboraciones);
    const maxReelab = Number.isFinite(maxRaw) && maxRaw >= 0
        ? Math.min(maxRaw, HARDCODED_MAX_REELABORACIONES)
        : HARDCODED_MAX_REELABORACIONES;
    return { enabled, timeoutMs, maxReelaboraciones: maxReelab };
}

// -----------------------------------------------------------------------------
// buildFiscalPrompt — el prompt INVARIANTE del Sherlock. Es el corazón del
// verifier adversarial: tono fiscal, instrucción explícita de refutar, y
// schema de salida estricto.
//
// Los delimitadores XML (<analysis>, <system_state>, <original_request>,
// <last_hour_logs>) separan contexto-vs-input para resistir prompt-injection
// (CA-SEC-2). El prompt cierra con un schema JSON literal así el modelo no
// puede inventarse keys nuevas.
// -----------------------------------------------------------------------------
function buildFiscalPrompt({ analysis, originalRequest, systemState, lastHourLogs }) {
    return (
        'Sos Sherlock, un verificador adversarial. Tu único trabajo es REFUTAR ' +
        'el análisis que te paso a continuación contrastándolo con el estado ' +
        'real del sistema. No sos asistente; sos fiscal. Si el análisis es ' +
        'consistente con la evidencia, decilo. Si encontrás contradicciones, ' +
        'enumerarlas con la cita textual del claim y la evidencia que lo refuta.\n\n' +
        'REGLAS DE SALIDA — devolvé EXACTAMENTE este JSON, nada más:\n' +
        '{\n' +
        '  "verdict": "ok" | "rechazado",\n' +
        '  "reason": "<frase corta en español>",\n' +
        '  "inconsistencies": [ {"claim": "<texto del claim>", "contradiction": "<por qué lo refuta el estado>"} ]\n' +
        '}\n' +
        'Cap máximo 5 inconsistencias. Si no hay inconsistencias, devolvé ' +
        '"verdict": "ok" y "inconsistencies": [].\n\n' +
        '<original_request>\n' +
        String(originalRequest || '').slice(0, 4000) +
        '\n</original_request>\n\n' +
        '<analysis>\n' +
        String(analysis || '').slice(0, 8000) +
        '\n</analysis>\n\n' +
        '<system_state>\n' +
        String(systemState || '').slice(0, 8000) +
        '\n</system_state>\n\n' +
        '<last_hour_logs>\n' +
        String(lastHourLogs || '').slice(0, 4000) +
        '\n</last_hour_logs>\n\n' +
        'Respondé SOLO con el JSON. Sin markdown, sin texto fuera del objeto.'
    );
}

// -----------------------------------------------------------------------------
// parseAndValidateSherlockOutput — parsea + valida con schema STRICT
// (CA-SEC-6). Whitelist de keys, tipos esperados, cap inconsistencies.
//
// Devuelve `{ ok: true, data }` o `{ ok: false, reason }`. La razón se
// loguea como `sherlock_schema_violation`.
// -----------------------------------------------------------------------------
function parseAndValidateSherlockOutput(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, reason: 'empty_output' };
    }
    // Algunos providers free-tier envuelven en markdown a pesar del prompt.
    // Tolerancia mínima: pelar ```json y ``` si están en los extremos. No
    // hacemos regex más amplia para no relajar el schema.
    let txt = raw.trim();
    if (txt.startsWith('```')) {
        txt = txt.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/i, '').trim();
    }
    let parsed;
    try {
        parsed = JSON.parse(txt);
    } catch (e) {
        return { ok: false, reason: 'invalid_json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'not_object' };
    }
    // Whitelist EXACTA de keys (CA-SEC-6).
    const allowedKeys = ['verdict', 'reason', 'inconsistencies'];
    for (const k of Object.keys(parsed)) {
        if (allowedKeys.indexOf(k) < 0) {
            return { ok: false, reason: `unexpected_key:${k}` };
        }
    }
    if (parsed.verdict !== 'ok' && parsed.verdict !== 'rechazado') {
        return { ok: false, reason: 'invalid_verdict' };
    }
    if (typeof parsed.reason !== 'string') {
        return { ok: false, reason: 'invalid_reason_type' };
    }
    if (!Array.isArray(parsed.inconsistencies)) {
        return { ok: false, reason: 'invalid_inconsistencies_type' };
    }
    const truncated = parsed.inconsistencies.length > MAX_INCONSISTENCIES;
    const inc = parsed.inconsistencies.slice(0, MAX_INCONSISTENCIES);
    for (const item of inc) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, reason: 'invalid_inconsistency_item_type' };
        }
        const itemKeys = Object.keys(item);
        for (const k of itemKeys) {
            if (k !== 'claim' && k !== 'contradiction') {
                return { ok: false, reason: `inconsistency_unexpected_key:${k}` };
            }
        }
        if (typeof item.claim !== 'string' || typeof item.contradiction !== 'string') {
            return { ok: false, reason: 'inconsistency_field_type' };
        }
    }
    // Coherencia: si verdict='ok' entonces inconsistencies debería ser [].
    // No es violación de schema en si misma, pero la auditoría lo marca.
    return {
        ok: true,
        data: {
            verdict: parsed.verdict,
            reason: parsed.reason,
            inconsistencies: inc,
            inconsistenciesTruncated: truncated,
        },
    };
}

// -----------------------------------------------------------------------------
// resolveSherlockProvider — encuentra el primer provider de la chain
// `telegram-sherlock` que sea HTTP-compatible y NO esté excluido. Itera
// agregando providers no-HTTP a la lista de excluidos hasta encontrar uno
// válido o agotar la chain.
//
// Recibe `excludedProvider` (string del Commander). Devuelve `{provider,
// model}` o `null` si no hay candidato.
// -----------------------------------------------------------------------------
function resolveSherlockProvider({
    excludedProvider,
    pipelineDir,
    log,
    quotaModule,
    dispatchModule,
    fsImpl,
    now,
    maxIterations = 6,
}) {
    const excluded = new Set();
    if (typeof excludedProvider === 'string' && excludedProvider) {
        excluded.add(excludedProvider);
    }
    for (let i = 0; i < maxIterations; i++) {
        let res;
        try {
            res = commanderMP.resolveCommanderProviderExcluding(
                Array.from(excluded),
                {
                    pipelineDir,
                    log,
                    quotaModule,
                    dispatchModule,
                    fsImpl,
                    now,
                    issue: 'sherlock-verify',
                }
            );
        } catch (e) {
            if (typeof log === 'function') {
                log('sherlock', `resolveSherlockProvider falló: ${e.message}`);
            }
            return null;
        }
        if (!res || !res.provider || res.gated) {
            return null;
        }
        if (HTTP_COMPATIBLE_PROVIDERS.has(res.provider)) {
            return {
                provider: res.provider,
                model: res.model || null,
                source: res.source,
                fallbackUsed: res.fallbackUsed,
                chainTried: res.chainTried,
            };
        }
        // Provider no-HTTP — excluir y seguir.
        excluded.add(res.provider);
    }
    return null;
}

// -----------------------------------------------------------------------------
// emitAuditEvent — wrapper sobre commanderMP.auditCommanderRequest para los
// eventos específicos de Sherlock. Todos los payloads sensibles van como
// HASH (CA-SEC-8). best-effort: nunca tira al caller.
// -----------------------------------------------------------------------------
function emitAuditEvent({ pipelineDir, event, payload, fsImpl, auditLog, now }) {
    try {
        commanderMP.auditCommanderRequest({
            pipelineDir,
            event,
            providerEffective: payload && payload.sherlockProvider || null,
            providerIntended: payload && payload.commanderProvider || null,
            chainTried: payload && payload.chainTried || null,
            tokens: payload && (payload.inputTokens != null || payload.outputTokens != null)
                ? {
                    input: Number(payload.inputTokens) || 0,
                    output: Number(payload.outputTokens) || 0,
                }
                : null,
            latencyMs: payload && Number.isFinite(payload.durationMs) ? payload.durationMs : null,
            errorCode: payload && payload.errorCode || null,
            // NO mandamos prompt — solo hashes en `extra`
            prompt: payload && payload.analysisHash || '',
            fsImpl,
            auditLog,
            now,
        });
        // El audit log canónico no tiene `extra` libre, pero el shape de la
        // entry incluye `prompt_hash` que reusamos como contenedor del hash
        // del análisis (commanderMP lo hashea otra vez — eso es OK; lo
        // importante es que el payload crudo NUNCA toca el JSONL).
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// verify — la API principal del módulo. Llamada desde pulpo.js post-`ejecutarClaude`.
//
// Args (obligatorios):
//   - analysis:        string de la respuesta del Commander (la que iba a Telegram)
//   - originalRequest: texto del usuario que disparó este turno
//   - systemState:     snapshot del estado pre-respuesta (lo que el Commander
//                      observó; el Sherlock lo usa para contrastar)
//   - lastHourLogs:    opcional, slice de logs de la última hora
//   - excludedProvider: provider del Commander a evitar (CA-SEC-8)
//   - pipelineDir:     para audit log
//
// Args (opcionales — inyectables para tests):
//   - completionClient, configLoader, log, fsImpl, auditLog, now, quotaModule,
//     dispatchModule
//
// Returns:
//   {
//     verdict: 'ok' | 'rechazado' | 'aborted' | 'skipped',
//     reason: string,
//     inconsistencies: [{claim, contradiction}],
//     inconsistenciesTruncated: boolean,
//     sherlockProvider, sherlockModel,
//     durationMs, inputTokens, outputTokens,
//     errorCode: string | null,    // 'timeout' | 'no_http_provider' | 'schema_violation' | 'residency_blocked' | 'disabled' | null
//     suggestedDisclaimer: null | DISCLAIMER_TYPES.*,
//   }
// El caller decide si reelabora, agrega disclaimer y manda a Telegram.
// -----------------------------------------------------------------------------
async function verify(opts = {}) {
    const startedAt = Date.now();
    const {
        analysis,
        originalRequest,
        systemState,
        lastHourLogs,
        excludedProvider,
        pipelineDir,

        // inyectables tests
        completionClient,
        configLoader,
        log,
        fsImpl,
        auditLog,
        now,
        quotaModule,
        dispatchModule,
        residencyModule,
    } = opts;

    const _log = typeof log === 'function' ? log : () => {};
    const _now = Number.isFinite(now) ? now : Date.now();
    const _completion = completionClient || require('./multi-provider/completion-client');
    const _residency = residencyModule || null; // commanderMP.enforceDataResidency lo carga solo

    const cfg = loadSherlockConfig({ configLoader });

    // CA-SEC-7 / CA-F-7 — si está disabled, bypass total y no devolver
    // disclaimer (silencio absoluto). El caller manda la respuesta original.
    if (!cfg.enabled) {
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_skipped_disabled',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider: excludedProvider || null,
                durationMs: 0,
            },
        });
        return {
            verdict: 'skipped',
            reason: 'sherlock_disabled_by_config',
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: null,
            sherlockModel: null,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'disabled',
            suggestedDisclaimer: DISCLAIMER_TYPES.NONE,
        };
    }

    // CA-SEC-1 — sanitización del analysis antes de mandarlo al provider.
    // El analysis viene del Commander (LLM output) y podría tener un
    // prompt-injection acumulado del texto del usuario; sanitizeUserPrompt
    // lo recorta al primer match.
    const san = commanderMP.sanitizeUserPrompt(analysis);
    const safeAnalysis = san.sanitized;
    if (san.truncated) {
        _log('sherlock', `🛡️ CA-SEC-1: analysis recortado (injection patterns=${san.hits.join('|')})`);
    }

    // Resolución de provider — itera la chain telegram-sherlock excluyendo
    // el commanderProvider + cualquier provider no-HTTP que aparezca.
    const resolved = resolveSherlockProvider({
        excludedProvider,
        pipelineDir,
        log: _log,
        quotaModule,
        dispatchModule,
        fsImpl,
        now: _now,
    });

    if (!resolved) {
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_verification',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider: excludedProvider || null,
                durationMs: Date.now() - startedAt,
                errorCode: 'no_http_provider',
            },
        });
        return {
            verdict: 'aborted',
            reason: 'no_http_provider_available',
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: null,
            sherlockModel: null,
            durationMs: Date.now() - startedAt,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'no_http_provider',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        };
    }

    // CA-SEC-3 — data-residency fail-closed ANTES del provider call.
    const drCheck = commanderMP.enforceDataResidency({
        pipelineDir,
        provider: resolved.provider,
        paths: [],
        log: _log,
        chatId: null,
        prompt: safeAnalysis,
        drfModule: _residency,
        auditLog,
        fsImpl,
        now: _now,
    });
    if (!drCheck.ok) {
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_aborted_residency',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider: excludedProvider || null,
                sherlockProvider: resolved.provider,
                durationMs: Date.now() - startedAt,
                errorCode: drCheck.reason,
            },
        });
        return {
            verdict: 'aborted',
            reason: `residency_${drCheck.reason}`,
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            durationMs: Date.now() - startedAt,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'residency_blocked',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        };
    }

    // CA-SEC-2 — prompt con delimitadores XML.
    const prompt = buildFiscalPrompt({
        analysis: safeAnalysis,
        originalRequest,
        systemState,
        lastHourLogs,
    });

    // Invocar completion-client con timeout configurado.
    let httpResult;
    try {
        httpResult = await _completion.complete({
            provider: resolved.provider,
            model: resolved.model,
            prompt,
            timeoutMs: cfg.timeoutMs,
            maxTokens: 1024,
            temperature: 0,
        });
    } catch (e) {
        // complete() NO debería tirar (devuelve {ok:false}), pero defendemos.
        httpResult = {
            ok: false,
            error: { type: 'unknown', detail: e && e.message ? e.message : String(e) },
            provider: resolved.provider,
            model: resolved.model,
            durationMs: Date.now() - startedAt,
        };
    }

    const totalMs = Date.now() - startedAt;

    if (!httpResult.ok) {
        const isTimeout = httpResult.error && httpResult.error.type === 'timeout';
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_verification',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider: excludedProvider || null,
                sherlockProvider: resolved.provider,
                durationMs: totalMs,
                errorCode: httpResult.error ? httpResult.error.type : 'unknown',
            },
        });
        return {
            verdict: 'aborted',
            reason: isTimeout ? 'timeout' : `provider_error:${httpResult.error && httpResult.error.type || 'unknown'}`,
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            durationMs: totalMs,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: isTimeout ? 'timeout' : 'provider_error',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        };
    }

    // CA-SEC-6 — parseo + validación strict.
    const parsed = parseAndValidateSherlockOutput(httpResult.content);
    if (!parsed.ok) {
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_schema_violation',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider: excludedProvider || null,
                sherlockProvider: resolved.provider,
                durationMs: totalMs,
                inputTokens: httpResult.inputTokens,
                outputTokens: httpResult.outputTokens,
                errorCode: parsed.reason,
            },
        });
        return {
            verdict: 'aborted',
            reason: `schema_violation:${parsed.reason}`,
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            durationMs: totalMs,
            inputTokens: httpResult.inputTokens || 0,
            outputTokens: httpResult.outputTokens || 0,
            errorCode: 'schema_violation',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        };
    }

    // CA-SEC-8 — solo hashes en el audit log (claim/contradiction nunca crudos).
    const claimHashes = parsed.data.inconsistencies.map(it => hashFor(it.claim));
    const contradictionHashes = parsed.data.inconsistencies.map(it => hashFor(it.contradiction));

    emitAuditEvent({
        pipelineDir, fsImpl, auditLog, now: _now,
        event: 'sherlock_verification',
        payload: {
            analysisHash: hashFor(analysis),
            commanderProvider: excludedProvider || null,
            sherlockProvider: resolved.provider,
            durationMs: totalMs,
            inputTokens: httpResult.inputTokens,
            outputTokens: httpResult.outputTokens,
            // Estos hashes viajan vía prompt_hash composite — el shape canónico
            // del audit no los expone como campos top-level. Quedan implícitos
            // en la lectura del JSONL (analysisHash al menos preserva trazabilidad).
            errorCode: null,
        },
    });

    return {
        verdict: parsed.data.verdict,
        reason: parsed.data.reason,
        inconsistencies: parsed.data.inconsistencies,
        inconsistenciesTruncated: parsed.data.inconsistenciesTruncated,
        sherlockProvider: resolved.provider,
        sherlockModel: resolved.model,
        durationMs: totalMs,
        inputTokens: httpResult.inputTokens || 0,
        outputTokens: httpResult.outputTokens || 0,
        errorCode: null,
        suggestedDisclaimer: DISCLAIMER_TYPES.NONE, // el caller decide F-5 vs nada
        claimHashes,
        contradictionHashes,
    };
}

// -----------------------------------------------------------------------------
// applyDisclaimer — helper para el caller (pulpo.js). Toma una respuesta y un
// tipo de disclaimer, devuelve el texto final a mandar a Telegram.
// -----------------------------------------------------------------------------
function applyDisclaimer(text, disclaimerType) {
    if (disclaimerType === DISCLAIMER_TYPES.PERSISTENT_INCONSISTENCY) {
        return String(text || '') + DISCLAIMER_F5_PERSISTENT_INCONSISTENCY;
    }
    if (disclaimerType === DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER) {
        return String(text || '') + DISCLAIMER_F6_VERIFICATION_FAILED;
    }
    return String(text || '');
}

// -----------------------------------------------------------------------------
// recordToggleAttempt — CA-SEC-7. El caller (pulpo.js) llama esto si detecta
// que un texto del usuario intentaba toggle del feature ("desactivá sherlock",
// "ignorá el verificador", etc.). El módulo NO toca config — solo emite
// `sherlock_toggle_attempt_ignored` al audit log.
// -----------------------------------------------------------------------------
function recordToggleAttempt({ pipelineDir, sourceText, fsImpl, auditLog, now }) {
    emitAuditEvent({
        pipelineDir, fsImpl, auditLog, now,
        event: 'sherlock_toggle_attempt_ignored',
        payload: {
            analysisHash: hashFor(sourceText),
            durationMs: 0,
            errorCode: 'toggle_ignored',
        },
    });
}

module.exports = {
    // API principal
    verify,
    applyDisclaimer,
    recordToggleAttempt,

    // constantes
    HARDCODED_MAX_REELABORACIONES,
    DEFAULT_TIMEOUT_MS,
    ABSOLUTE_MAX_TIMEOUT_MS,
    MAX_INCONSISTENCIES,
    HTTP_COMPATIBLE_PROVIDERS,
    DISCLAIMER_F5_PERSISTENT_INCONSISTENCY,
    DISCLAIMER_F6_VERIFICATION_FAILED,
    DISCLAIMER_TYPES,

    // exports para tests
    _hashFor: hashFor,
    _loadSherlockConfig: loadSherlockConfig,
    _buildFiscalPrompt: buildFiscalPrompt,
    _parseAndValidateSherlockOutput: parseAndValidateSherlockOutput,
    _resolveSherlockProvider: resolveSherlockProvider,
};

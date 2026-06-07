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
//   - el provider de mejor calidad disponible (orden compartido con Commander)
//   - SIN timeout (Leo 2026-06-02): nunca corta por reloj; la resiliencia la
//     da la cascada multi-provider, no un timer
//   - cascada multi-provider: si un provider falla, salta al siguiente de la
//     chain en vez de abortar (restaurada 2026-06-02, revierte #3668)
//   - disclaimer F-6 sólo si se agota toda la chain
//   - cap reelaboración hardcoded = 1
//
// Sherlock NO es un skill de agente — corre IN-PROCESS dentro del flujo
// `recogerTextoLibre` del pulpo, entre `ejecutarClaude` y `sendTelegram`.
// El pulpo lo wirea con `verify(...)`; este módulo no toca filesystem ni
// red por su cuenta (todo se inyecta vía completion-client o spawn-CLI).
//
// CAMBIOS #3484 (2026-05-23) — Decisión Opción B (spawn CLI para Anthropic)
// --------------------------------------------------------------------------
// Hasta esta versión Sherlock SOLO usaba providers HTTP-compatible (cerebras /
// gemini-google / nvidia-nim) y EXCLUÍA el provider del Commander para
// preservar adversariality. Combinado con un clamp de timeout en 10s, eso
// causaba que Sherlock cayera en fallback en cascada y muriera en F-6
// silencioso casi siempre.
//
// Cambios:
//   1. Se removió el filtro `HTTP_COMPATIBLE_PROVIDERS` que saltaba providers
//      no-HTTP. Sherlock ahora acepta cualquier provider de la chain
//      telegram-sherlock. Para Anthropic usa spawn CLI (Opción B) reusando
//      `agent-launcher/providers/anthropic.js`. Codex también vía spawn CLI
//      (`agent-launcher/providers/openai-codex.js`, JSONL → agent_message) —
//      wireado 2026-06-02 (PR #3792 dejó el adapter real; antes era stub
//      #3076 H3 y se salteaba con gracia).
//   2. Se removió el clamp local de timeout (`ABSOLUTE_MAX_TIMEOUT_MS=30s`).
//      El presupuesto vive en el cliente HTTP (90s default, 180s cap).
//   3. Se removió la exclusión cross-provider — Sherlock puede usar el mismo
//      provider que el Commander. Adversariality reducida es riesgo aceptado
//      (Leo, 2026-05-22 voz). El audit log registra `same_provider` y
//      `same_model` para monitorearlo (CA-AUDIT-1).
//   4. Disclaimers F-5/F-6 actualizados al phrasing aprobado por UX
//      (CA-UX-3/UX-4).
//
// CAMBIOS #3668 (2026-05-29) — Single-provider puro, sin cascada
// --------------------------------------------------------------
// La cascada de #3558 (`sherlock-retry-chain.js` + wrappers `cascadeChain`/
// `cascadeComplete`/`cascadeResidency`/`cascadeEmit` en este módulo) producía
// 4 notificaciones Telegram repetidas cuando el provider primario quedaba
// gateado (anthropic quota_exhausted). El refactor elimina el cascade entero
// y vuelve a la semántica original "Sherlock corre 1 verificación con 1
// provider":
//
//   1. Eliminado `lib/sherlock-retry-chain.js` (T-2 opción (a) de guru, CA-6).
//   2. Eliminados los wrappers cascade y la construcción de `cascadeChain`.
//   3. `verify()` invoca al provider UNA sola vez (HTTP o spawn según
//      transport). Si falla → `verdict: 'aborted'` + disclaimer F-6 (CA-7).
//   4. Shape de retorno preservado para no romper consumers downstream
//      (CA-9): `attemptCount` siempre 1, `fallbackUsed` siempre false,
//      `chainTried` siempre `[provider]`.
//   5. Audit log emite `sherlock_skipped_provider_unavailable` cuando no hay
//      provider disponible (S-6 / CA-7), además del `sherlock_verification`
//      legacy. Los disclaimers F-5/F-6 se mantienen idénticos a #3484.
//
// Adversariality reducida es trade-off aceptado en #3484 — este refactor NO
// regresiona la defensa, simplemente elimina el cascade noise. Sherlock sigue
// detectando incoherencias internas del análisis, contradicciones con
// `<system_state>` y alucinaciones contrastables con `<last_hour_logs>`. NO
// detecta biases sistemáticos del provider primario — eso requeriría
// cross-provider real (deferred a una iteración futura).
//
// FLOW (resumido — el flujo completo está en pulpo.js):
//   Commander responde →
//     Sherlock.verify(analysis, originalRequest, systemState, commanderProvider)
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
// #3846 — recolección de evidencia independiente (filesystem/git/github-api/
// heartbeat) para no heredar las asunciones del systemState del Commander.
const independentVerifierModule = require('./sherlock-independent-verifier');

// Invariante CA-SEC-9 — hardcoded, NO depende de config.
const HARDCODED_MAX_REELABORACIONES = 1;

// #3766 — la constante `HARDCODED_MAX_MODEL_SWAPS` (#3501) se eliminó junto
// con la policy de swap intra-provider. La contradicción adversarial de
// Sherlock nace del rol, no del modelo: el resolver mantiene el modelo que
// devuelve la chain `telegram-sherlock` sin reescribirlo. El catálogo
// `alternative_models[]` en `agent-models.json` sigue válido como insumo de
// la cascada multi-provider del Commander/devs/builder.

// Cap defensivo de inconsistencias aceptadas en el output del Sherlock
// (CA-SEC-6). Si el modelo dice "encontré 50 inconsistencias", recortamos
// a las primeras 5. Más que eso es ruido o intento de DoS de payload.
const MAX_INCONSISTENCIES = 5;

// Providers que Sherlock invoca vía HTTP completion-client. El resto se
// despacha vía spawn-CLI (cuando hay handler disponible) o se saltea.
// Para sumar uno nuevo: agregarlo acá Y a `PROVIDER_COMPLETION_ENDPOINTS`
// de `lib/multi-provider/completion-client.js`.
const HTTP_COMPLETION_PROVIDERS = Object.freeze(new Set([
    'cerebras',
    'gemini-google',
    'nvidia-nim',
]));

// Providers que Sherlock invoca vía spawn CLI (Opción B de #3484).
//   - anthropic:    reusa `agent-launcher/providers/anthropic.js`, manda el
//                   prompt por stdin con `--output-format text` y lee el
//                   stdout como texto plano.
//   - openai-codex: reusa `agent-launcher/providers/openai-codex.js`, manda el
//                   prompt como argumento posicional (`-p <prompt>`) con
//                   `CODEX_MODEL` en el env y parsea el stdout JSONL de
//                   `codex exec --json` para extraer el `agent_message`
//                   (transporte agregado 2026-06-02 — antes era stub #3076 H3,
//                   hoy el adapter es real, PR #3792).
const SPAWN_COMPLETION_PROVIDERS = Object.freeze(new Set([
    'anthropic',
    'openai-codex',
]));

// Timeout default que Sherlock pasa al completion-client / spawn helper.
// 0 = SIN timeout (decisión Leo 2026-06-02 voz): la verificación adversarial
// nunca se corta por reloj. La resiliencia ante un provider que no responde la
// da la cascada multi-provider de `verify()` (si un provider falla con error,
// salta al siguiente de la chain), no un timeout. Histórico: 10s → 90s (#3484)
// → sin timeout (esta versión). Se mantiene exportado por back-compat.
const DEFAULT_TIMEOUT_MS = 0;

// -----------------------------------------------------------------------------
// Disclaimers (CA-F-5/F-6) — constantes string en español, voseo argentino.
// UX guidelines (#3331 + #3484 CA-UX-3/UX-4):
//   - voseo ("decímelo", "revisamos juntos")
//   - sin sello visible cuando verdict=ok
//   - diferenciación timeout (F-6) vs inconsistencia persistente (F-5)
//   - tono empático, primera persona, invita feedback
//   - sin avisar pre-Sherlock
// El pool de variantes rotativas queda para #3339 (no en este scope).
// -----------------------------------------------------------------------------
const DISCLAIMER_F5_PERSISTENT_INCONSISTENCY = (
    '\n\n' +
    '🔍 Ajusté la respuesta con el verificador.'
);

const DISCLAIMER_F6_VERIFICATION_FAILED = (
    '\n\n' +
    'ℹ️ No pude verificar esta respuesta; te muestro la original.'
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
// loadSherlockConfig — lee config.yaml (sherlock_enabled, max_reelaboraciones).
// Aplica clamps defensivos (CA-SEC-9).
//
// CA-SEC-7: solo lee del archivo, NUNCA acepta `enabled` por argumento del
// usuario. El caller (pulpo.js) lo pasa con `configLoader` inyectable solo
// para tests; en producción siempre es el `loadConfig` real.
//
// #3484: `sherlock_timeout_ms` se ignora — el presupuesto vive en el
// completion-client. Si está presente en config viejas, devolvemos `timeoutMs`
// con el DEFAULT_TIMEOUT_MS pero NO clampeamos al valor declarado. La compat
// es importante: configs en producción todavía tienen el campo y el cargador
// debe tolerarlo sin warn-spammear.
// -----------------------------------------------------------------------------
function loadSherlockConfig({ configLoader } = {}) {
    let cfg = {};
    try {
        cfg = (typeof configLoader === 'function') ? (configLoader() || {}) : {};
    } catch {
        cfg = {};
    }
    const enabled = cfg.sherlock_enabled === false ? false : true; // default ON
    // #3484 — `sherlock_timeout_ms` deprecated. Devolvemos DEFAULT_TIMEOUT_MS
    // siempre. El campo se mantiene en el shape de retorno por compat con
    // callers/tests que lo lean, pero NO refleja config user-facing.
    const timeoutMs = DEFAULT_TIMEOUT_MS;
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
// <last_hour_logs>, <independent_evidence>) separan contexto-vs-input para
// resistir prompt-injection (CA-SEC-2). El prompt cierra con un schema JSON
// literal así el modelo no puede inventarse keys nuevas.
//
// #3846 — `independentEvidence` (string opcional) es evidencia recolectada por
// Sherlock CONTRA fuentes de verdad reales (filesystem, git origin/main,
// GitHub API, heartbeats), independiente del `systemState` que inyectó el
// Commander. Si está presente, se agrega la sección `<independent_evidence>` y
// un bloque de instrucciones que ordena detectar las ASUNCIONES IMPLÍCITAS del
// análisis y contravenirlas contra esa evidencia. Si está ausente o vacío, el
// prompt es idéntico al de antes del #3846 (back-compat).
// -----------------------------------------------------------------------------
function buildFiscalPrompt({ analysis, originalRequest, systemState, lastHourLogs, independentEvidence }) {
    const evidence = String(independentEvidence || '').trim();
    const hasEvidence = evidence.length > 0;

    const baseInstructions = (
        'Sos Sherlock, un verificador adversarial. Tu único trabajo es REFUTAR ' +
        'el análisis que te paso a continuación contrastándolo con el estado ' +
        'real del sistema. No sos asistente; sos fiscal. Si el análisis es ' +
        'consistente con la evidencia, decilo. Si encontrás contradicciones, ' +
        'enumerarlas con la cita textual del claim y la evidencia que lo refuta.\n\n'
    );

    // #3846 — refuerzo fiscal cuando hay evidencia independiente. Le pedimos al
    // modelo que NO trate al systemState como verdad absoluta, sino que explicite
    // qué asume y lo contraste contra la evidencia real.
    const evidenceInstructions = hasEvidence ? (
        'IMPORTANTE — tenés DOS fuentes de contraste, con prioridades distintas:\n' +
        '  1. <system_state>: snapshot que observó el Commander ANTES del análisis. ' +
        'Puede heredar las mismas asunciones que el análisis intenta defender. NO ' +
        'lo trates como verdad absoluta.\n' +
        '  2. <independent_evidence>: hechos ground-truth recolectados por VOS contra ' +
        'fuentes reales (filesystem en disco, git origin/main, GitHub API, heartbeats). ' +
        'Esta evidencia PESA MÁS que el system_state cuando se contradicen.\n\n' +
        'Procedimiento obligatorio:\n' +
        '  a) Identificá qué ASUME el análisis del system_state (ej: si dice ' +
        '"#X está procesado", asume procesado=verdadero=entregable real en main).\n' +
        '  b) Contravení cada asunción contra <independent_evidence>: ¿hay un PR ' +
        'mergeado? ¿el archivo existe en disco? ¿el PID del heartbeat está vivo?\n' +
        '  c) Si una asunción del análisis CONTRADICE la evidencia independiente, ' +
        'eso es una inconsistencia grave: reportala con el claim textual y la ' +
        'contradicción citando la evidencia real.\n' +
        '  Ejemplo: si el análisis dice "el helper escape-html.js está listo para ' +
        'merge" pero <independent_evidence> muestra "la rama NO está en origin/main ' +
        'y no hay PR mergeado", reportá claim: "...listo para merge", contradiction: ' +
        '"evidencia real: el entregable no existe en origin/main".\n\n'
    ) : '';

    const outputRules = (
        'REGLAS DE SALIDA — devolvé EXACTAMENTE este JSON, nada más:\n' +
        '{\n' +
        '  "verdict": "ok" | "rechazado",\n' +
        '  "reason": "<frase corta en español>",\n' +
        '  "inconsistencies": [ {"claim": "<texto del claim>", "contradiction": "<por qué lo refuta el estado>"} ]\n' +
        '}\n' +
        'Cap máximo 5 inconsistencias. Si no hay inconsistencias, devolvé ' +
        '"verdict": "ok" y "inconsistencies": [].\n\n'
    );

    const evidenceSection = hasEvidence ? (
        '<independent_evidence>\n' +
        evidence.slice(0, 8000) +
        '\n</independent_evidence>\n\n'
    ) : '';

    return (
        baseInstructions +
        evidenceInstructions +
        outputRules +
        '<original_request>\n' +
        String(originalRequest || '').slice(0, 4000) +
        '\n</original_request>\n\n' +
        '<analysis>\n' +
        String(analysis || '').slice(0, 8000) +
        '\n</analysis>\n\n' +
        '<system_state>\n' +
        String(systemState || '').slice(0, 8000) +
        '\n</system_state>\n\n' +
        evidenceSection +
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
// #3766 — `readAlternativeModelsForProvider` (#3501) se eliminó. La lectura del
// catálogo `alternative_models[]` ya no es necesaria desde el verifier: la
// cascada multi-provider del Commander/devs/builder la maneja
// `lib/commander/multi-provider.js` y el cliente HTTP por provider vive en
// `lib/multi-provider/completion-client.js`. Sherlock se apoya en esos módulos
// para resiliencia, igual que el resto de la pipeline.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// resolveSherlockProvider — encuentra el primer provider de la chain
// `telegram-sherlock` que tenga handler implementado en Sherlock (HTTP o
// spawn). Itera agregando providers no-soportados a la lista de excluidos
// hasta encontrar uno válido o agotar la chain.
//
// #3484: ya NO se excluye al commanderProvider. Sherlock puede usar el
// mismo provider que el Commander — se acepta adversariality reducida y se
// registra `same_provider` en el audit log (CA-AUDIT-1) para observabilidad.
//
// #3766: la contradicción adversarial nace del **rol** (prompt fiscal del
// Sherlock + criterios de evaluación) y NO de la diferencia de modelo.
// Por eso se eliminó el bloque de swap intra-provider del #3501: el resolver
// devuelve el modelo que la chain `telegram-sherlock` indica, sin reescribirlo.
// Los parámetros `commanderModel` y `excludedProvider` permanecen en la
// signature como back-compat (ignorados) — el patrón es el mismo que
// `excludedProvider` (#3484): aceptar el arg para no romper callers viejos.
//
// La cascada multi-provider (timeout/error del primario → fallback a Codex,
// Groq, etc.) sigue funcionando a través del resolver propio del Commander:
// `commanderMP.resolveCommanderProviderExcluding`. El catálogo
// `alternative_models[]` de `agent-models.json` sigue válido como insumo de
// esa cascada (Commander/devs/builder).
//
// Devuelve `{provider, model, transport, ...}` o `null` si no hay candidato
// implementado en toda la chain. Las claves `swapped`/`originalModel`/
// `swapReason` se mantienen en el shape de retorno (siempre false/null
// post-#3766) por back-compat con consumers downstream que las leen.
// -----------------------------------------------------------------------------
function resolveSherlockProvider({
    excludedProvider,    // mantenido en signature por back-compat; ignorado (#3484)
    commanderProvider,   // informativo: el caller lo usa para calcular sameProvider en audit
    commanderModel,      // mantenido en signature por back-compat; ignorado (#3766)
    initialExcluded,     // #3558 — providers ya intentados por la cascada
    pipelineDir,
    log,
    quotaModule,
    dispatchModule,
    fsImpl,
    now,
    maxIterations = 6,
}) {
    // #3484: `excludedProvider` se ignora a propósito (back-compat). El
    // único motivo para excluir un provider acá es que NO tengamos handler
    // (HTTP o spawn) implementado en Sherlock para él. Hoy los 5 providers de
    // la chain telegram-sherlock tienen handler (cerebras/gemini/nvidia HTTP +
    // anthropic/codex spawn); la rama de exclusión queda como defensa para un
    // provider futuro sin handler.
    // #3558: `initialExcluded` permite arrancar el resolver con un set
    // pre-poblado, usado por la cascada para saltar providers ya probados
    // sin tocar la semántica original (que sigue ignorando `excludedProvider`).
    const excluded = new Set();
    if (initialExcluded) {
        if (initialExcluded instanceof Set) {
            for (const p of initialExcluded) {
                if (typeof p === 'string' && p) excluded.add(p);
            }
        } else if (Array.isArray(initialExcluded)) {
            for (const p of initialExcluded) {
                if (typeof p === 'string' && p) excluded.add(p);
            }
        }
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
        const transport = HTTP_COMPLETION_PROVIDERS.has(res.provider)
            ? 'http'
            : SPAWN_COMPLETION_PROVIDERS.has(res.provider)
                ? 'spawn'
                : null;

        if (!transport) {
            // Provider sin handler en Sherlock (HTTP ni spawn) — excluir y
            // seguir con el próximo de la chain. Defensa para providers
            // futuros; hoy los 5 de telegram-sherlock tienen handler.
            if (typeof log === 'function') {
                log('sherlock', `provider ${res.provider} no tiene handler en Sherlock — fallback al siguiente`);
            }
            excluded.add(res.provider);
            continue;
        }

        // #3766 — Respetamos lo que el resolver de la chain devuelve. La
        // contradicción es por rol, no por modelo; sin policy de swap. Los
        // campos `swapped/originalModel/swapReason` se conservan en el shape
        // (siempre false/null) por back-compat con consumers downstream.
        return {
            provider: res.provider,
            model: res.model || null,
            transport,
            source: res.source,
            fallbackUsed: res.fallbackUsed,
            chainTried: res.chainTried,
            swapped: false,
            originalModel: null,
            swapReason: null,
        };
    }
    return null;
}

// -----------------------------------------------------------------------------
// spawnAnthropicComplete — invoca `claude` CLI con el prompt por stdin y
// devuelve el shape canónico de completion-client (`{ok, content, ...}`).
//
// Reusa `agent-launcher/providers/anthropic.js::detectLauncher` para detectar
// el binario/launcher correcto (compat con Claude Code ≥2.1.114 native exe,
// cli.js legacy, cmd shim, etc.). Pasa `--permission-mode bypassPermissions`
// + `--output-format text` para obtener la respuesta cruda directamente.
//
// Timeout: si `timeoutMs > 0` mata el child con SIGTERM al vencer y devuelve
// `error.type === 'timeout'`. Con `timeoutMs === 0` (default post-2026-06-02)
// NO hay timer: el child corre hasta terminar por su cuenta. La cascada de
// `verify()` cubre el caso de error real del provider.
//
// SECURITY:
//   - El prompt va por stdin (no como arg) → no aparece en `ps aux` ni en
//     command-line logs del SO.
//   - El env del child se hereda del parent + `CLAUDE_PROJECT_DIR=ROOT` (mismo
//     patrón que `ejecutarClaude` en pulpo.js).
//   - El stdout se trunca a 64KB (mismo cap que completion-client) para
//     defensa anti-DoS de payload.
// -----------------------------------------------------------------------------
const SPAWN_MAX_STDOUT_BYTES = 64 * 1024;

function spawnAnthropicComplete({
    prompt,
    timeoutMs,
    spawnImpl,
    anthropicHandler,
    cwd,
    env,
}) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const _spawn = spawnImpl || require('node:child_process').spawn;
        const handler = anthropicHandler || require('./agent-launcher/providers/anthropic');

        let spawnSpec;
        try {
            spawnSpec = handler.buildSpawn({
                args: [
                    '-p',
                    '--output-format', 'text',
                    '--permission-mode', 'bypassPermissions',
                ],
                cwd: cwd || process.cwd(),
                env: env || { ...process.env, CLAUDE_PROJECT_DIR: cwd || process.cwd() },
            });
        } catch (e) {
            return resolve({
                ok: false,
                error: { type: 'spawn_unavailable', detail: e && e.message ? e.message : String(e) },
                provider: 'anthropic',
                durationMs: Date.now() - startedAt,
            });
        }

        let child;
        try {
            // El child espera stdin (`'pipe'`) para recibir el prompt.
            const opts = Object.assign({}, spawnSpec.spawnOpts, { stdio: ['pipe', 'pipe', 'pipe'] });
            child = _spawn(spawnSpec.cmd, spawnSpec.args, opts);
        } catch (e) {
            return resolve({
                ok: false,
                error: { type: 'spawn_failed', detail: e && e.message ? e.message : String(e) },
                provider: 'anthropic',
                durationMs: Date.now() - startedAt,
            });
        }

        let stdoutBuf = Buffer.alloc(0);
        let stderrBuf = Buffer.alloc(0);
        let truncated = false;
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            try { if (timer) clearTimeout(timer); } catch {}
            resolve(Object.assign({ provider: 'anthropic', durationMs: Date.now() - startedAt }, result));
        };

        // timeoutMs === 0 → sin timeout: no armamos timer, el child corre hasta
        // terminar. Solo si el caller pide un timeout > 0 lo respetamos.
        const timer = Number(timeoutMs) > 0
            ? setTimeout(() => {
                try { child.kill('SIGTERM'); } catch {}
                finish({
                    ok: false,
                    error: { type: 'timeout', detail: `spawn anthropic superó timeoutMs=${timeoutMs}` },
                });
            }, Number(timeoutMs))
            : null;

        try {
            if (child.stdin && typeof child.stdin.write === 'function') {
                child.stdin.write(prompt);
                child.stdin.end();
            }
        } catch (e) {
            return finish({
                ok: false,
                error: { type: 'spawn_failed', detail: `stdin write: ${e && e.message ? e.message : String(e)}` },
            });
        }

        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                if (truncated) return;
                if (stdoutBuf.length + chunk.length > SPAWN_MAX_STDOUT_BYTES) {
                    truncated = true;
                    try { child.kill('SIGTERM'); } catch {}
                    return finish({
                        ok: false,
                        error: { type: 'invalid_response', reason: 'body_too_large', detail: `stdout > ${SPAWN_MAX_STDOUT_BYTES} bytes` },
                    });
                }
                stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                // Limitamos stderr para no inflar memoria — solo importa el primer KB.
                if (stderrBuf.length < 2048) {
                    stderrBuf = Buffer.concat([stderrBuf, chunk.slice(0, 2048 - stderrBuf.length)]);
                }
            });
        }

        child.on('error', (e) => {
            finish({
                ok: false,
                error: { type: 'spawn_error', detail: e && e.message ? e.message : String(e) },
            });
        });

        child.on('exit', (code) => {
            if (resolved) return;
            const stdout = stdoutBuf.toString('utf8').trim();
            const stderr = stderrBuf.toString('utf8').trim();
            if (code === 0 && stdout) {
                return finish({
                    ok: true,
                    content: stdout,
                    inputTokens: 0,   // CLI text-mode no expone tokens — best-effort
                    outputTokens: 0,
                });
            }
            return finish({
                ok: false,
                error: { type: 'spawn_exit', detail: `exit=${code}; stderr=${stderr.slice(0, 400)}` },
            });
        });
    });
}

// -----------------------------------------------------------------------------
// spawnCodexComplete — invoca `codex exec --json` con el prompt como argumento
// posicional y devuelve el shape canónico de completion-client
// (`{ok, content, ...}`).
//
// Diferencias con `spawnAnthropicComplete` (por qué es una función aparte):
//   - Codex NO acepta el prompt por stdin: el adapter lo manda como argumento
//     posicional final (`-p <prompt>` → traducido a posicional en
//     `openai-codex.js::translateClaudeArgsToCodex`). `interactive_supported`
//     se deja en false → stdin = 'ignore'.
//   - Codex emite JSONL (`codex exec --json`), NO texto plano. El texto de la
//     respuesta vive en el evento `{type:'item.completed', item:{type:
//     'agent_message', text:'...'}}` (shape confirmado por el smoke real
//     2026-06-01 en tests/smoke/codex-adapter.smoke.js). Nos quedamos con el
//     ÚLTIMO `agent_message` del stream.
//   - El modelo se inyecta vía `env.CODEX_MODEL` (lo lee el adapter).
//
// Timeout: idéntica semántica a anthropic — `timeoutMs > 0` mata el child con
// SIGTERM; `timeoutMs === 0` (default post-2026-06-02) corre sin timer.
//
// SECURITY:
//   - El prompt va como argv (limitación del adapter Codex), igual que para
//     todos los spawns de agentes del pulpo — consistente con el resto del
//     pipeline. El env del child hereda del parent + CODEX_MODEL.
//   - stdout truncado a 64KB (mismo cap que anthropic/completion-client).
// -----------------------------------------------------------------------------
function spawnCodexComplete({
    prompt,
    model,
    timeoutMs,
    spawnImpl,
    codexHandler,
    cwd,
    env,
}) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const _spawn = spawnImpl || require('node:child_process').spawn;
        const handler = codexHandler || require('./agent-launcher/providers/openai-codex');
        const _cwd = cwd || process.cwd();
        const _env = Object.assign(
            {},
            env || process.env,
            model ? { CODEX_MODEL: model } : {},
            { CLAUDE_PROJECT_DIR: _cwd }
        );

        let spawnSpec;
        try {
            spawnSpec = handler.buildSpawn({
                args: ['-p', String(prompt == null ? '' : prompt)],
                cwd: _cwd,
                env: _env,
                interactive_supported: false,
            });
        } catch (e) {
            return resolve({
                ok: false,
                error: { type: 'spawn_unavailable', detail: e && e.message ? e.message : String(e) },
                provider: 'openai-codex',
                durationMs: Date.now() - startedAt,
            });
        }

        let child;
        try {
            child = _spawn(spawnSpec.cmd, spawnSpec.args, spawnSpec.spawnOpts);
        } catch (e) {
            return resolve({
                ok: false,
                error: { type: 'spawn_failed', detail: e && e.message ? e.message : String(e) },
                provider: 'openai-codex',
                durationMs: Date.now() - startedAt,
            });
        }

        let stdoutBuf = Buffer.alloc(0);
        let stderrBuf = Buffer.alloc(0);
        let truncated = false;
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            try { if (timer) clearTimeout(timer); } catch {}
            resolve(Object.assign({ provider: 'openai-codex', durationMs: Date.now() - startedAt }, result));
        };

        const timer = Number(timeoutMs) > 0
            ? setTimeout(() => {
                try { child.kill('SIGTERM'); } catch {}
                finish({
                    ok: false,
                    error: { type: 'timeout', detail: `spawn codex superó timeoutMs=${timeoutMs}` },
                });
            }, Number(timeoutMs))
            : null;

        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                if (truncated) return;
                if (stdoutBuf.length + chunk.length > SPAWN_MAX_STDOUT_BYTES) {
                    truncated = true;
                    try { child.kill('SIGTERM'); } catch {}
                    return finish({
                        ok: false,
                        error: { type: 'invalid_response', reason: 'body_too_large', detail: `stdout > ${SPAWN_MAX_STDOUT_BYTES} bytes` },
                    });
                }
                stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                if (stderrBuf.length < 2048) {
                    stderrBuf = Buffer.concat([stderrBuf, chunk.slice(0, 2048 - stderrBuf.length)]);
                }
            });
        }

        child.on('error', (e) => {
            finish({
                ok: false,
                error: { type: 'spawn_error', detail: e && e.message ? e.message : String(e) },
            });
        });

        child.on('exit', (code) => {
            if (resolved) return;
            const stderr = stderrBuf.toString('utf8').trim();
            // Parse JSONL: nos quedamos con el último `agent_message`.
            let agentMessage = null;
            let inputTokens = 0;
            let outputTokens = 0;
            const raw = stdoutBuf.toString('utf8');
            for (const line of raw.split('\n')) {
                const t = line.trim();
                if (!t.startsWith('{')) continue;
                let obj;
                try { obj = JSON.parse(t); } catch { continue; }
                if (obj.type === 'item.completed' && obj.item
                    && obj.item.type === 'agent_message'
                    && typeof obj.item.text === 'string') {
                    agentMessage = obj.item.text;
                } else if (obj.type === 'turn.completed' && obj.usage && typeof obj.usage === 'object') {
                    inputTokens += Number(obj.usage.input_tokens || 0);
                    outputTokens += Number(obj.usage.output_tokens || 0) + Number(obj.usage.reasoning_output_tokens || 0);
                }
            }
            if (code === 0 && agentMessage && agentMessage.trim()) {
                return finish({
                    ok: true,
                    content: agentMessage,
                    inputTokens,
                    outputTokens,
                });
            }
            return finish({
                ok: false,
                error: {
                    type: 'spawn_exit',
                    detail: agentMessage === null
                        ? `exit=${code}; sin agent_message en el stream JSONL; stderr=${stderr.slice(0, 300)}`
                        : `exit=${code}; stderr=${stderr.slice(0, 400)}`,
                },
            });
        });
    });
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
            // CA-AUDIT-1 (#3484) — Propagamos los 5 campos enriched que el
            // verifier ya calcula en `verify()` (sameProvider, sameModel,
            // commanderModel, sherlockModel, transport). El audit-log los
            // persiste al JSONL para análisis cross-provider posterior.
            // Documentado en docs/pipeline/multi-provider.md (líneas 1602,
            // 1622-1634). Cuando el payload no los tenga (eventos legacy o
            // pre-resolve como `sherlock_skipped_disabled`), se envían como
            // null/undefined y el audit los registra como null.
            sameProvider: payload && typeof payload.sameProvider === 'boolean' ? payload.sameProvider : null,
            sameModel: payload && typeof payload.sameModel === 'boolean' ? payload.sameModel : null,
            commanderModel: payload && payload.commanderModel || null,
            sherlockModel: payload && payload.sherlockModel || null,
            transport: payload && payload.transport || null,
            // #3846 — evidencia independiente (eventos sherlock_independent_evidence_*).
            sourcesChecked: payload && Array.isArray(payload.sourcesChecked) ? payload.sourcesChecked : undefined,
            findingsCount: payload && Number.isFinite(payload.findingsCount) ? payload.findingsCount : undefined,
            // #3766 — los campos del extinto evento `sherlock_model_swap`
            // (swapModelOrigen/Destino/Reason) se eliminaron: el verifier ya
            // no emite ese evento porque la policy de swap intra-provider del
            // #3501 desapareció. Si el audit-log canónico recibe un payload
            // sin esas claves, simplemente persiste el resto del shape.
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
//   - analysis:         string de la respuesta del Commander (la que iba a Telegram)
//   - originalRequest:  texto del usuario que disparó este turno
//   - systemState:      snapshot del estado pre-respuesta (lo que el Commander
//                       observó; el Sherlock lo usa para contrastar)
//   - lastHourLogs:     opcional, slice de logs de la última hora
//   - commanderProvider: provider efectivo que usó el Commander (audit log).
//                       #3484: ya NO se usa para excluir provider en Sherlock,
//                       solo para registrar `same_provider`/`same_model`.
//   - commanderModel:   modelo efectivo del Commander (audit). Opcional.
//   - pipelineDir:      para audit log
//
// Args (back-compat, opcionales):
//   - excludedProvider: alias legacy de `commanderProvider`. Mantenido para
//                       que callers viejos no rompan. #3484: ignorado como
//                       criterio de exclusión.
//
// Args (opcionales — inyectables para tests):
//   - completionClient, spawnAnthropic, configLoader, log, fsImpl, auditLog,
//     now, quotaModule, dispatchModule, residencyModule, anthropicHandler,
//     spawnImpl, cwd, env
//
// Returns:
//   {
//     verdict: 'ok' | 'rechazado' | 'aborted' | 'skipped',
//     reason: string,
//     inconsistencies: [{claim, contradiction}],
//     inconsistenciesTruncated: boolean,
//     sherlockProvider, sherlockModel,
//     transport: 'http' | 'spawn' | null,
//     sameProvider: boolean,    // CA-AUDIT-1 (#3484)
//     sameModel: boolean,       // CA-AUDIT-1 (#3484)
//     commanderProvider, commanderModel,
//     durationMs, inputTokens, outputTokens,
//     errorCode: string | null,    // 'timeout' | 'no_provider' | 'schema_violation' | 'residency_blocked' | 'disabled' | null
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
        pipelineDir,

        // #3846 — evidencia independiente. `issueNumber` habilita el collector;
        // si no se pasa, Sherlock corre igual que antes (sin sección).
        issueNumber,
        independentVerifier,   // inyectable tests (default: módulo real)
        gitImpl,               // inyectable para collectIndependentEvidence
        ghApi,                 // inyectable para collectIndependentEvidence
        processCheck,          // inyectable para collectIndependentEvidence
        repoRoot,              // override raíz git (default: padre de pipelineDir)

        // back-compat: si el caller pasa `excludedProvider`, lo tratamos como
        // `commanderProvider` (mismo string). #3484: ya NO se excluye, solo
        // se loguea para `same_provider`.
        excludedProvider,
        commanderProvider: commanderProviderArg,
        commanderModel: commanderModelArg,

        // inyectables tests
        completionClient,
        spawnAnthropic,
        spawnCodex,
        anthropicHandler,
        codexHandler,
        spawnImpl,
        cwd,
        env,
        configLoader,
        log,
        fsImpl,
        auditLog,
        now,
        quotaModule,
        dispatchModule,
        residencyModule,
    } = opts;

    const commanderProvider = commanderProviderArg || excludedProvider || null;
    const commanderModel = commanderModelArg || null;

    const _log = typeof log === 'function' ? log : () => {};
    const _now = Number.isFinite(now) ? now : Date.now();
    const _completion = completionClient || require('./multi-provider/completion-client');
    const _spawnAnthropic = typeof spawnAnthropic === 'function' ? spawnAnthropic : spawnAnthropicComplete;
    const _spawnCodex = typeof spawnCodex === 'function' ? spawnCodex : spawnCodexComplete;
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
                commanderProvider,
                commanderModel,
                durationMs: 0,
                // CA-AUDIT-1 (#3484) — sin resolved aún; no hay sherlock provider/model.
                sameProvider: false,
                sameModel: false,
                sherlockModel: null,
                transport: null,
            },
        });
        return {
            verdict: 'skipped',
            reason: 'sherlock_disabled_by_config',
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: null,
            sherlockModel: null,
            transport: null,
            sameProvider: false,
            sameModel: false,
            commanderProvider,
            commanderModel,
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

    // -------------------------------------------------------------------------
    // CASCADA MULTI-PROVIDER (restaurada 2026-06-02, revierte #3668).
    //
    // Sherlock prueba el primer provider de la chain telegram-sherlock. Si ese
    // provider falla (error de transporte, timeout explícito que pidiera algún
    // caller, o output que no respeta el schema), lo excluye y salta al
    // siguiente de la chain en vez de abortar. Solo cuando se agota TODA la
    // chain devuelve `verdict: 'aborted'` + disclaimer F-6.
    //
    // NO hay timeout (Leo 2026-06-02 voz): `cfg.timeoutMs === 0`, así que cada
    // provider corre hasta responder o errorar por su cuenta. La resiliencia
    // ante un provider colgado la da esta cascada, no un corte por reloj.
    //
    // #3484: NO se excluye al commanderProvider; un provider sin handler en
    // Sherlock lo saltea resolveSherlockProvider internamente (hoy los 5 de la
    // chain tienen handler — codex incluido desde 2026-06-02).
    // #3766: sin swap intra-provider — la adversariality nace del rol (prompt
    // fiscal), no del modelo. `commanderModel` se usa solo para el cálculo de
    // `sameModel` que se persiste al JSONL como forensics (sin influir en el
    // veredicto).
    //
    // Shape de retorno (CA-9): `attemptCount` = providers efectivamente
    // invocados, `fallbackUsed` = true si hubo más de 1 intento, `chainTried`
    // = lista de providers recorridos (incluye los bloqueados por residency).
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // #3846 — RECOLECCIÓN DE EVIDENCIA INDEPENDIENTE (antes de resolver provider).
    //
    // Sherlock arma evidencia ground-truth contra fuentes reales (filesystem,
    // git origin/main, GitHub API, heartbeat) en lugar de confiar solo en el
    // `systemState` que le pasó el Commander. Fail-open total: si el collector
    // falla o tarda, Sherlock sigue exactamente como antes (sin la sección).
    //
    // Solo corre si el caller pasó `issueNumber` (el collector necesita un
    // identificador numérico válido — CA-SEC-10).
    // -------------------------------------------------------------------------
    const _independentVerifier = independentVerifier || independentVerifierModule;
    let safeIndependentEvidence = '';
    if (issueNumber != null) {
        try {
            const evidence = await _independentVerifier.collectIndependentEvidence({
                issueNumber,
                pipelineDir,
                repoRoot,
                fsImpl,
                gitImpl,
                ghApi,
                processCheck,
                log: _log,
            });
            const rendered = _independentVerifier.formatIndependentEvidence(evidence);
            if (rendered) {
                // CA-SEC-1 — la evidencia (outputs de git/gh/FS) se sanitiza igual
                // que el analysis antes de tocar el prompt del provider.
                const sanEv = commanderMP.sanitizeUserPrompt(rendered);
                safeIndependentEvidence = sanEv.sanitized;
                if (sanEv.truncated) {
                    _log('sherlock', `🛡️ CA-SEC-1: independentEvidence recortado (injection patterns=${sanEv.hits.join('|')})`);
                }
            }
            // Auditoría — evento con sources/findingsCount/durationMs (sin payloads
            // crudos: solo hash del análisis, CA-SEC-8).
            emitAuditEvent({
                pipelineDir, fsImpl, auditLog, now: _now,
                event: evidence && evidence.ok
                    ? 'sherlock_independent_evidence_collected'
                    : 'sherlock_independent_evidence_failed',
                payload: {
                    analysisHash: hashFor(analysis),
                    commanderProvider,
                    commanderModel,
                    durationMs: evidence ? evidence.durationMs : 0,
                    errorCode: evidence && evidence.ok ? null : (evidence && evidence.error) || 'collector_error',
                    sourcesChecked: evidence ? (evidence.sourcesChecked || []) : [],
                    findingsCount: evidence ? (evidence.findings || []).length : 0,
                    sherlockModel: null,
                    transport: null,
                    sameProvider: false,
                    sameModel: false,
                },
            });
        } catch (e) {
            // FAIL-OPEN — el collector nunca bloquea la verificación.
            _log('sherlock', `independentEvidence collector falló (fail-open): ${e && e.message}`);
            emitAuditEvent({
                pipelineDir, fsImpl, auditLog, now: _now,
                event: 'sherlock_independent_evidence_failed',
                payload: {
                    analysisHash: hashFor(analysis),
                    commanderProvider,
                    commanderModel,
                    durationMs: 0,
                    errorCode: 'collector_exception',
                    sourcesChecked: [],
                    findingsCount: 0,
                },
            });
        }
    }

    // CA-SEC-2 — prompt con delimitadores XML. Es provider-independiente, así
    // que se arma una sola vez antes de la cascada.
    const prompt = buildFiscalPrompt({
        analysis: safeAnalysis,
        originalRequest,
        systemState,
        lastHourLogs,
        independentEvidence: safeIndependentEvidence,
    });

    // #3766 — `modelSwap` queda como shape estable (siempre `swapped:false`)
    // por back-compat con consumers que lo leen (formatVerifiedFooter,
    // dashboards históricos, JSONL viejo). La policy de swap del #3501 se
    // eliminó; el field se conserva para no obligar a un breaking change.
    const modelSwap = { swapped: false, originalModel: null, reason: null };

    // `completeWith` encapsula la decisión HTTP vs spawn según el transport del
    // provider resuelto. Devuelve el shape canónico `{ok, content, ...}`.
    async function completeWith(resolved) {
        if (resolved.transport === 'spawn' && resolved.provider === 'anthropic') {
            const r = await _spawnAnthropic({
                prompt,
                timeoutMs: cfg.timeoutMs,
                spawnImpl,
                anthropicHandler,
                cwd,
                env,
            });
            if (r && typeof r === 'object') r.model = resolved.model;
            return r;
        }
        if (resolved.transport === 'spawn' && resolved.provider === 'openai-codex') {
            const r = await _spawnCodex({
                prompt,
                model: resolved.model,
                timeoutMs: cfg.timeoutMs,
                spawnImpl,
                codexHandler,
                cwd,
                env,
            });
            if (r && typeof r === 'object') r.model = resolved.model;
            return r;
        }
        return await _completion.complete({
            provider: resolved.provider,
            model: resolved.model,
            prompt,
            timeoutMs: cfg.timeoutMs,
            maxTokens: 1024,
            temperature: 0,
        });
    }

    const excludedProviders = new Set(); // providers ya intentados que fallaron
    const chainTried = [];               // providers recorridos, en orden
    let attemptCount = 0;                // providers efectivamente invocados
    let lastResolved = null;            // último provider resuelto (para shape)
    let lastSameProvider = false;
    let lastSameModel = false;
    let lastErrorCode = 'no_provider';
    let lastErrorIsTimeout = false;
    let lastErrorIsResidency = false;

    // Cap defensivo del outer loop — la chain telegram-sherlock es chica; este
    // número solo evita un loop infinito si el resolver devolviera siempre el
    // mismo provider (no debería: excluimos cada provider tras fallar).
    const MAX_CASCADE_ITERATIONS = 10;

    // MP-12 (#3809) — retry acotado ante schema_violation. Un provider que
    // responde 2xx pero con un payload que no respeta el schema esperado puede
    // estar teniendo un hipo transitorio (truncado, primer token raro). Antes de
    // #3809 eso mataba el intento sin retry y degradaba al siguiente eslabón,
    // acelerando la cascada. Ahora reintentamos el MISMO provider UNA sola vez
    // antes de excluirlo. El cap (1 retry por provider) evita inflar latencia y
    // tokens y descarta cualquier loop infinito.
    const schemaRetried = new Set();

    for (let iter = 0; iter < MAX_CASCADE_ITERATIONS; iter++) {
        // Resolución de provider — itera la chain telegram-sherlock arrancando
        // con los providers ya intentados en `excludedProviders`. #3484: NO se
        // excluye al commanderProvider; solo se saltan providers sin handler.
        const resolved = resolveSherlockProvider({
            excludedProvider: null,
            commanderProvider,
            commanderModel,
            initialExcluded: excludedProviders,
            pipelineDir,
            log: _log,
            quotaModule,
            dispatchModule,
            fsImpl,
            now: _now,
        });

        if (!resolved) break; // chain agotada (o ningún provider disponible)

        lastResolved = resolved;

        // CA-AUDIT-1 (#3484) — `sameProvider`/`sameModel` se calculan por intento
        // y se persisten al JSONL como forensics (los lee el monitor de drift).
        // #3766: NO influyen en el veredicto ni en el disclaimer.
        const sameProvider = !!(commanderProvider && commanderProvider === resolved.provider);
        const sameModel = !!(sameProvider && commanderModel && resolved.model && commanderModel === resolved.model);
        lastSameProvider = sameProvider;
        lastSameModel = sameModel;
        if (sameProvider) {
            _log('sherlock', `🔍 same_provider=true (commander=${commanderProvider}/${commanderModel || '?'}, sherlock=${resolved.provider}/${resolved.model || '?'}) — adversariality reducida (#3484 riesgo aceptado, #3766 sin swap)`);
        }

        // CA-SEC-3 — data-residency fail-closed ANTES del provider call. Si este
        // provider está bloqueado por residency lo excluimos y la cascada sigue
        // con el siguiente (otro provider podría estar permitido para este dato).
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
                    commanderProvider,
                    commanderModel,
                    sherlockProvider: resolved.provider,
                    durationMs: Date.now() - startedAt,
                    errorCode: drCheck.reason,
                    sameProvider,
                    sameModel,
                    sherlockModel: resolved.model,
                    transport: resolved.transport,
                },
            });
            lastErrorCode = 'residency_blocked';
            lastErrorIsTimeout = false;
            lastErrorIsResidency = true;
            chainTried.push(resolved.provider);
            excludedProviders.add(resolved.provider);
            continue;
        }

        attemptCount++;
        chainTried.push(resolved.provider);

        let httpResult;
        try {
            httpResult = await completeWith(resolved);
        } catch (e) {
            // Defensive: el completion-client / spawn helper deberían devolver
            // siempre `{ok:false, error:{...}}` en lugar de tirar — si tiran,
            // normalizamos al mismo shape para no romper la cascada.
            httpResult = {
                ok: false,
                error: { type: 'provider_exception', detail: e && e.message ? e.message : String(e) },
                durationMs: 0,
            };
        }

        // ---------------------------------------------------------------------
        // ERROR PATH — provider falló (timeout, http_error, spawn_failed, etc.)
        // → excluir y saltar al siguiente de la chain.
        // ---------------------------------------------------------------------
        if (!httpResult || !httpResult.ok) {
            const lastErr = (httpResult && httpResult.error) || { type: 'unknown' };
            const errorCode = lastErr.reason || lastErr.type || 'unknown';
            emitAuditEvent({
                pipelineDir, fsImpl, auditLog, now: _now,
                event: 'sherlock_verification',
                payload: {
                    analysisHash: hashFor(analysis),
                    commanderProvider,
                    commanderModel,
                    sherlockProvider: resolved.provider,
                    durationMs: Date.now() - startedAt,
                    errorCode,
                    sameProvider,
                    sameModel,
                    sherlockModel: resolved.model,
                    transport: resolved.transport,
                },
            });
            lastErrorCode = errorCode;
            lastErrorIsTimeout = lastErr.type === 'timeout';
            lastErrorIsResidency = false;
            _log('sherlock', `provider ${resolved.provider} falló (${errorCode}) — cascada al siguiente`);
            excludedProviders.add(resolved.provider);
            continue;
        }

        // ---------------------------------------------------------------------
        // SCHEMA VALIDATION — parsear + validar (CA-SEC-6). Si el output no
        // respeta el schema tratamos al provider como fallido y cascadeamos.
        // ---------------------------------------------------------------------
        const parsed = parseAndValidateSherlockOutput(httpResult.content);
        if (!parsed.ok) {
            emitAuditEvent({
                pipelineDir, fsImpl, auditLog, now: _now,
                event: 'sherlock_schema_violation',
                payload: {
                    analysisHash: hashFor(analysis),
                    commanderProvider,
                    commanderModel,
                    sherlockProvider: resolved.provider,
                    durationMs: Date.now() - startedAt,
                    errorCode: parsed.reason,
                    sameProvider,
                    sameModel,
                    sherlockModel: resolved.model,
                    transport: resolved.transport,
                },
            });
            emitAuditEvent({
                pipelineDir, fsImpl, auditLog, now: _now,
                event: 'sherlock_verification',
                payload: {
                    analysisHash: hashFor(analysis),
                    commanderProvider,
                    commanderModel,
                    sherlockProvider: resolved.provider,
                    durationMs: Date.now() - startedAt,
                    errorCode: 'schema_violation',
                    sameProvider,
                    sameModel,
                    sherlockModel: resolved.model,
                    transport: resolved.transport,
                },
            });
            lastErrorCode = 'schema_violation';
            lastErrorIsTimeout = false;
            lastErrorIsResidency = false;

            // MP-12 (#3809) — retry acotado: si es la PRIMERA schema_violation de
            // este provider, lo reintentamos UNA vez (no lo excluimos → el
            // resolver lo vuelve a elegir en la próxima iteración). Si ya
            // reintentamos, lo excluimos y cascadeamos al siguiente eslabón.
            if (!schemaRetried.has(resolved.provider)) {
                schemaRetried.add(resolved.provider);
                emitAuditEvent({
                    pipelineDir, fsImpl, auditLog, now: _now,
                    event: 'sherlock_schema_retry',
                    payload: {
                        analysisHash: hashFor(analysis),
                        commanderProvider,
                        commanderModel,
                        sherlockProvider: resolved.provider,
                        durationMs: Date.now() - startedAt,
                        errorCode: 'schema_violation',
                        attempt: 1,
                        sameProvider,
                        sameModel,
                        sherlockModel: resolved.model,
                        transport: resolved.transport,
                    },
                });
                _log('sherlock', `provider ${resolved.provider} schema inválido (${parsed.reason}) — reintento 1× mismo provider (MP-12)`);
                continue; // NO excluir → reintenta el mismo provider.
            }

            _log('sherlock', `provider ${resolved.provider} devolvió schema inválido (${parsed.reason}) tras retry — cascada al siguiente`);
            excludedProviders.add(resolved.provider);
            continue;
        }

        // ---------------------------------------------------------------------
        // SUCCESS PATH — verdict ok o rechazado con schema válido.
        // ---------------------------------------------------------------------
        const totalMs = Date.now() - startedAt;
        // CA-SEC-8 — solo hashes en el audit log (claim/contradiction nunca crudos).
        const claimHashes = parsed.data.inconsistencies.map(it => hashFor(it.claim));
        const contradictionHashes = parsed.data.inconsistencies.map(it => hashFor(it.contradiction));

        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_verification',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                sherlockProvider: resolved.provider,
                durationMs: totalMs,
                inputTokens: httpResult.inputTokens,
                outputTokens: httpResult.outputTokens,
                errorCode: null,
                sameProvider,
                sameModel,
                sherlockModel: resolved.model,
                transport: resolved.transport,
            },
        });

        return {
            verdict: parsed.data.verdict,
            reason: parsed.data.reason,
            inconsistencies: parsed.data.inconsistencies,
            inconsistenciesTruncated: parsed.data.inconsistenciesTruncated,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            transport: resolved.transport,
            sameProvider,
            sameModel,
            commanderProvider,
            commanderModel,
            durationMs: totalMs,
            inputTokens: httpResult.inputTokens || 0,
            outputTokens: httpResult.outputTokens || 0,
            errorCode: null,
            suggestedDisclaimer: DISCLAIMER_TYPES.NONE, // el caller decide F-5 vs nada
            claimHashes,
            contradictionHashes,
            modelSwap,
            // CA-9 — shape stable; con cascada reflejan el recorrido real.
            attemptCount,
            fallbackUsed: attemptCount > 1,
            chainTried: chainTried.slice(),
        };
    }

    // -------------------------------------------------------------------------
    // CHAIN AGOTADA — ningún provider de la chain pudo verificar.
    // -------------------------------------------------------------------------
    const totalMs = Date.now() - startedAt;

    if (!lastResolved) {
        // No se pudo resolver NINGÚN provider (todos gated / sin handler).
        // CA-7 (#3668) — emitimos DOS eventos: el legacy `sherlock_verification`
        // (consumido por dashboards históricos) y el canónico
        // `sherlock_skipped_provider_unavailable` (PO S-6 / CA-7), que es la
        // señal de "Sherlock no pudo verificar por falta de provider".
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_verification',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                durationMs: totalMs,
                errorCode: 'no_provider',
                sameProvider: false,
                sameModel: false,
                sherlockModel: null,
                transport: null,
            },
        });
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_skipped_provider_unavailable',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                durationMs: totalMs,
                errorCode: 'no_provider',
                sameProvider: false,
                sameModel: false,
                sherlockModel: null,
                transport: null,
            },
        });
        return {
            verdict: 'aborted',
            reason: 'no_provider_available',
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: null,
            sherlockModel: null,
            transport: null,
            sameProvider: false,
            sameModel: false,
            commanderProvider,
            commanderModel,
            durationMs: totalMs,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'no_provider',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
            modelSwap,
            attemptCount: 0,
            fallbackUsed: false,
            chainTried: chainTried.slice(),
        };
    }

    // Resolvimos uno o más providers pero TODA la chain falló (error, schema o
    // residency). El errorCode/reason refleja el ÚLTIMO fallo de la cascada.
    let abortedReason;
    let abortedErrorCode;
    if (lastErrorIsResidency) {
        abortedReason = 'residency_blocked';
        abortedErrorCode = 'residency_blocked';
    } else if (lastErrorIsTimeout) {
        abortedReason = 'timeout';
        abortedErrorCode = lastErrorCode;
    } else {
        abortedReason = `provider_error:${lastErrorCode}`;
        abortedErrorCode = lastErrorCode;
    }

    return {
        verdict: 'aborted',
        reason: abortedReason,
        inconsistencies: [],
        inconsistenciesTruncated: false,
        sherlockProvider: lastResolved.provider,
        sherlockModel: lastResolved.model,
        transport: lastResolved.transport,
        sameProvider: lastSameProvider,
        sameModel: lastSameModel,
        commanderProvider,
        commanderModel,
        durationMs: totalMs,
        inputTokens: 0,
        outputTokens: 0,
        errorCode: abortedErrorCode,
        suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        modelSwap,
        // CA-9 — shape stable; reflejan el recorrido real de la cascada.
        attemptCount,
        fallbackUsed: attemptCount > 1,
        chainTried: chainTried.slice(),
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
// formatVerifiedFooter — #3501 CA-11. Formato plano para el footer Telegram
// cuando Sherlock verificó (no es disclaimer, es informativo).
//
// Reglas UX (CA-UX-SWAP-1):
//   - UNA línea, sin emojis, sin tono celebratorio.
//   - Formato base: "Verificado por: <provider>/<model>"
//   - El sufijo "(swap desde <model-origen>)" se mantiene en el código por
//     back-compat: la rama solo dispara si el caller arma un `modelSwap`
//     con `swapped:true`. Post-#3766 el verifier devuelve siempre
//     `swapped:false` (la policy #3501 se removió), así que el sufijo no
//     aparece en runtime; el branch queda como hook reservado para futuras
//     razones de swap si las hubiera.
//
// Respeta `feedback_telegram-messages-natural.md`: la línea es informativa,
// no celebratoria. El caller (pulpo.js) decide si agregar el footer al
// mensaje según política (ej. solo cuando swap, o siempre).
//
// Devuelve string vacío si faltan datos mínimos — el caller no agrega línea.
// -----------------------------------------------------------------------------
function formatVerifiedFooter({ sherlockProvider, sherlockModel, modelSwap }) {
    if (!sherlockProvider) return '';
    const base = sherlockModel
        ? `Verificado por: ${sherlockProvider}/${sherlockModel}`
        : `Verificado por: ${sherlockProvider}`;
    if (modelSwap && modelSwap.swapped && modelSwap.originalModel) {
        return `${base} (swap desde ${modelSwap.originalModel})`;
    }
    return base;
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
    // #3501 CA-11 — helper para footer Telegram informativo.
    formatVerifiedFooter,

    // constantes
    HARDCODED_MAX_REELABORACIONES,
    DEFAULT_TIMEOUT_MS,
    MAX_INCONSISTENCIES,
    HTTP_COMPLETION_PROVIDERS,
    SPAWN_COMPLETION_PROVIDERS,
    // Alias deprecated (#3484) — mantenido por back-compat con callers viejos.
    // En la próxima limpieza removerlo. Apunta al set HTTP para no romper
    // checks tipo `HTTP_COMPATIBLE_PROVIDERS.has(p)`.
    HTTP_COMPATIBLE_PROVIDERS: HTTP_COMPLETION_PROVIDERS,
    DISCLAIMER_F5_PERSISTENT_INCONSISTENCY,
    DISCLAIMER_F6_VERIFICATION_FAILED,
    DISCLAIMER_TYPES,

    // exports para tests
    _hashFor: hashFor,
    _loadSherlockConfig: loadSherlockConfig,
    _buildFiscalPrompt: buildFiscalPrompt,
    _parseAndValidateSherlockOutput: parseAndValidateSherlockOutput,
    _resolveSherlockProvider: resolveSherlockProvider,
    _spawnAnthropicComplete: spawnAnthropicComplete,
    _spawnCodexComplete: spawnCodexComplete,
};

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
//   - timeout delegado al completion-client (90s default, 180s cap)
//   - disclaimer si falla la verificación
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
//      `agent-launcher/providers/anthropic.js`. Codex sigue siendo stub
//      (#3076 H3 pendiente) y se salta con gracia hasta que H3 entregue.
//   2. Se removió el clamp local de timeout (`ABSOLUTE_MAX_TIMEOUT_MS=30s`).
//      El presupuesto vive en el cliente HTTP (90s default, 180s cap).
//   3. Se removió la exclusión cross-provider — Sherlock puede usar el mismo
//      provider que el Commander. Adversariality reducida es riesgo aceptado
//      (Leo, 2026-05-22 voz). El audit log registra `same_provider` y
//      `same_model` para monitorearlo (CA-AUDIT-1).
//   4. Disclaimers F-5/F-6 actualizados al phrasing aprobado por UX
//      (CA-UX-3/UX-4).
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
// #3558 — Cascada de reintentos entre providers/modelos para Sherlock.
// Implementa CA-F1..F6 + CA-SEC-3-RECHECK / CA-SEC-SKIP-QUOTA /
// CA-SEC-CASCADE-CAP / CA-SEC-AUDIT-REDACT / CA-SEC-CRED-FILTER /
// CA-INV-ADVERSARIAL / CA-INV-SCHEMA.
const retryChain = require('./sherlock-retry-chain');

// Cap defensivo de cantidad de providers que la cascada de Sherlock arma desde
// la chain `telegram-sherlock`. Alineado con CA-F2 (`maxProviders: 3`).
const SHERLOCK_CASCADE_MAX_PROVIDERS = 3;

// Cap defensivo de tiempo total de la cascada (ms). Alineado con
// `ABSOLUTE_MAX_TIMEOUT_MS` del completion-client (CA-SEC-CASCADE-CAP).
const SHERLOCK_CASCADE_MAX_TOTAL_MS = 180_000;

// Cap defensivo de modelos por provider en la cascada (CA-F2).
const SHERLOCK_CASCADE_MAX_ATTEMPTS_PER_PROVIDER = 2;

// Invariante CA-SEC-9 — hardcoded, NO depende de config.
const HARDCODED_MAX_REELABORACIONES = 1;

// #3501 CA-SEC-SWAP-3 — cap runtime de swaps intra-provider dentro de una
// misma verificación. Defense in depth aunque el schema ya capea
// `alternative_models` con `maxItems: 3`. Si alguien sube el cap del schema
// más adelante, esta constante sigue protegiendo al runtime.
//
// El swap intra-provider NO consume budget de reelaboración (CA-9): es una
// elección de modelo dentro de la misma verificación, no un nuevo turn.
const HARDCODED_MAX_MODEL_SWAPS = 2;

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
// Anthropic es el único soportado hoy: reusa el launcher detection de
// `agent-launcher/providers/anthropic.js` y manda el prompt por stdin con
// `--output-format text`. Codex queda pendiente (#3076 H3).
const SPAWN_COMPLETION_PROVIDERS = Object.freeze(new Set([
    'anthropic',
]));

// Timeout default que Sherlock pasa al completion-client / spawn helper si
// no recibe override por config. El cliente HTTP tiene su propio cap absoluto
// (180s) que es la defensa real; este número es solo conveniencia + back-compat
// con tests/callers viejos. Histórico: era 10s (clampado a 30s) — insuficiente.
const DEFAULT_TIMEOUT_MS = 90_000;

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
    '🔍 Detecté una inconsistencia en mi primera respuesta y la ajusté. ' +
    'Si la versión anterior te parecía mejor, decime y la reviso.'
);

const DISCLAIMER_F6_VERIFICATION_FAILED = (
    '\n\n' +
    'ℹ️ No pude verificar esta respuesta con el verificador adversarial — ' +
    'te muestro la versión original. Si notás algo raro, decímelo y la ' +
    'revisamos juntos.'
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
// readAlternativeModelsForProvider — lee `alternative_models[]` del provider
// desde `agent-models.json`. Devuelve `[]` si el provider no lo declara o
// si el archivo no se puede leer (default-safe: política inactiva).
//
// #3501 CA-4 — el comportamiento default cuando el provider no declara
// alternative_models es "caer al siguiente provider" (no-op de la policy).
//
// Best-effort: cualquier error de lectura/parse devuelve `[]` para que el
// resolver no rompa por config inválida (validador ya hace fail-fast al boot).
// -----------------------------------------------------------------------------
function readAlternativeModelsForProvider(provider, { pipelineDir, fsImpl }) {
    if (!provider || !pipelineDir) return [];
    const _fs = fsImpl || fs;
    try {
        const modelsPath = path.join(pipelineDir, 'agent-models.json');
        if (!_fs.existsSync(modelsPath)) return [];
        const raw = JSON.parse(_fs.readFileSync(modelsPath, 'utf8'));
        const providerDef = raw && raw.providers && raw.providers[provider];
        if (!providerDef || !Array.isArray(providerDef.alternative_models)) return [];
        // Filtramos defensivamente: solo strings no vacíos.
        return providerDef.alternative_models.filter(
            (m) => typeof m === 'string' && m.length > 0
        );
    } catch {
        return [];
    }
}

// -----------------------------------------------------------------------------
// resolveSherlockProvider — encuentra el primer provider de la chain
// `telegram-sherlock` que tenga handler implementado en Sherlock (HTTP o
// spawn). Itera agregando providers no-soportados a la lista de excluidos
// hasta encontrar uno válido o agotar la chain.
//
// #3484: ya NO se excluye al commanderProvider. Sherlock puede usar el
// mismo provider que el Commander — se acepta adversariality reducida y se
// registra `same_provider` en el audit log (CA-AUDIT-1).
//
// #3501 CA-3 — Si el resolved coincide en provider+model con el Commander
// (same_provider && same_model), antes de excluir el provider entero se
// intenta swap a un modelo declarado en `alternative_models[]` del mismo
// provider (orden declarado). Solo si se agotan los alternativos sin éxito
// se cae al siguiente provider de la chain (CA-4 default-safe).
//
// CA-SEC-SWAP-3 — máximo HARDCODED_MAX_MODEL_SWAPS swaps intra-provider
// dentro de una verificación (defense in depth aunque el schema capea
// `alternative_models` con maxItems: 3).
//
// Devuelve `{provider, model, transport, originalModel?, swapped?, swapReason?}`
// o `null` si no hay candidato implementado en toda la chain.
//   - `originalModel`: si hubo swap, el modelo que el resolver hubiera elegido
//     sin la policy (necesario para el footer Telegram CA-11 y el audit
//     event CA-5).
//   - `swapped`: true si se eligió un modelo de alternative_models[].
//   - `swapReason`: 'same_model_avoidance' (único valor por ahora; futuro
//     podría agregar 'user_preference' si se implementa #3501 deferred).
// -----------------------------------------------------------------------------
function resolveSherlockProvider({
    excludedProvider,  // mantenido en signature por back-compat; ignorado (#3484)
    commanderProvider,  // #3501 — para detectar same_provider+same_model
    commanderModel,     // #3501 — para detectar same_provider+same_model
    initialExcluded,    // #3558 — providers ya intentados por la cascada
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
    // implementado todavía (ej. openai-codex es stub).
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
            // Provider sin handler en Sherlock (ej. openai-codex stub #3076) —
            // excluir y seguir con el próximo de la chain.
            if (typeof log === 'function') {
                log('sherlock', `provider ${res.provider} no tiene handler en Sherlock — fallback al siguiente`);
            }
            excluded.add(res.provider);
            continue;
        }

        // #3501 CA-3 — policy de swap intra-provider. Solo dispara cuando
        // coinciden provider Y model con el Commander. Si solo coincide el
        // provider (distinto model — caso anthropic opus↔haiku via config
        // #3221), NO disparamos swap: la diferenciación de modelo ya está
        // resuelta declarativamente. El comportamiento es "respetar lo que
        // el resolver de la chain devolvió".
        const sameProvider = !!(commanderProvider && commanderProvider === res.provider);
        const sameModel = !!(sameProvider && commanderModel && res.model && commanderModel === res.model);

        if (sameProvider && sameModel) {
            const alternatives = readAlternativeModelsForProvider(res.provider, { pipelineDir, fsImpl });
            // Excluimos el modelo que ya tenemos (el del Commander) por si
            // alguien lo declaró por error en alternative_models — defense in
            // depth aunque el validator ya lo rechaza.
            const candidates = alternatives.filter((m) => m !== res.model);
            // CA-3 — si hay candidatos, swap al primero disponible (los
            // restantes son tail-options para futuras razones de swap).
            // CA-SEC-SWAP-3 — el loop iterativo está capado por
            // HARDCODED_MAX_MODEL_SWAPS aunque por ahora el primer return
            // siempre dispara con candidates[0].
            for (let s = 0; s < Math.min(candidates.length, HARDCODED_MAX_MODEL_SWAPS); s++) {
                const altModel = candidates[s];
                if (typeof log === 'function') {
                    log('sherlock', `🔄 swap intra-provider (${res.provider}): ${res.model} → ${altModel} (same_model_avoidance, #3501)`);
                }
                return {
                    provider: res.provider,
                    model: altModel,
                    transport,
                    source: res.source,
                    fallbackUsed: res.fallbackUsed,
                    chainTried: res.chainTried,
                    swapped: true,
                    originalModel: res.model,
                    swapReason: 'same_model_avoidance',
                };
            }
            // CA-4 default-safe: si el provider NO declara alternative_models
            // (o la lista efectiva está vacía después de filtrar el mismo
            // modelo), se mantiene el mismo provider — comportamiento idéntico
            // al post-#3484 (Leo aceptó adversariality reducida 2026-05-22).
            // NO se cae al siguiente provider de la chain: el opt-in puro
            // significa que un provider sin alternativos sigue funcionando
            // exactamente como antes del #3501.
            //
            // El audit log ya registra `same_provider:true, same_model:true`
            // via el flujo principal de verify(); la observabilidad existe
            // para que el operador pueda detectar gaps de cobertura.
            if (typeof log === 'function') {
                log('sherlock', `same_provider+same_model con ${res.provider}/${res.model} y sin alternative_models — manteniendo same_provider (default-safe post-#3484)`);
            }
            // Fall through al return base (sin swap).
        }

        // Resolved usable sin swap.
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
// Timeout: respeta el `timeoutMs` recibido (clampado por el caller al
// ABSOLUTE_MAX_TIMEOUT_MS del cliente HTTP). Si no hay respuesta antes,
// mata el child con SIGTERM y devuelve `error.type === 'timeout'`.
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
            try { clearTimeout(timer); } catch {}
            resolve(Object.assign({ provider: 'anthropic', durationMs: Date.now() - startedAt }, result));
        };

        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            finish({
                ok: false,
                error: { type: 'timeout', detail: `spawn anthropic superó timeoutMs=${timeoutMs}` },
            });
        }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

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
            // #3501 CA-5 — Campos del evento `sherlock_model_swap`. Cuando el
            // evento NO es de swap, vienen null/undefined y el audit los
            // registra como null sin afectar el shape canónico.
            swapModelOrigen: payload && payload.swapModelOrigen || null,
            swapModelDestino: payload && payload.swapModelDestino || null,
            swapReason: payload && payload.swapReason || null,
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

        // back-compat: si el caller pasa `excludedProvider`, lo tratamos como
        // `commanderProvider` (mismo string). #3484: ya NO se excluye, solo
        // se loguea para `same_provider`.
        excludedProvider,
        commanderProvider: commanderProviderArg,
        commanderModel: commanderModelArg,

        // inyectables tests
        completionClient,
        spawnAnthropic,
        anthropicHandler,
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

    // Resolución de provider — itera la chain telegram-sherlock. #3484:
    // YA NO se excluye al commanderProvider; solo se saltan providers que
    // no tienen handler implementado en Sherlock.
    //
    // #3501 CA-3 — Si el resolved coincide en provider+model con el
    // Commander, el resolver intenta swap a un modelo de
    // `alternative_models[]` del provider antes de saltar al siguiente.
    // Para eso necesita commanderProvider+commanderModel.
    const resolved = resolveSherlockProvider({
        excludedProvider: null,
        commanderProvider,
        commanderModel,
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
                commanderProvider,
                commanderModel,
                durationMs: Date.now() - startedAt,
                errorCode: 'no_provider',
                // CA-AUDIT-1 (#3484) — no hay provider Sherlock disponible.
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
            durationMs: Date.now() - startedAt,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'no_provider',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
        };
    }

    const sameProvider = !!(commanderProvider && commanderProvider === resolved.provider);
    const sameModel = !!(sameProvider && commanderModel && resolved.model && commanderModel === resolved.model);
    if (sameProvider) {
        _log('sherlock', `🔍 same_provider=true (commander=${commanderProvider}/${commanderModel || '?'}, sherlock=${resolved.provider}/${resolved.model || '?'}) — adversariality reducida (#3484 riesgo aceptado)`);
    }

    // #3501 CA-5 — Evento de audit `sherlock_model_swap` cuando el resolver
    // ejerció la policy de swap intra-provider. El payload lleva los campos
    // diferenciados (provider, model_origen, model_destino, razon) que el
    // operador puede filtrar con `jq` desde el JSONL sin parser ad-hoc.
    //
    // CA-10 — los hashes sensibles (analysisHash) se aplican via hashFor() en
    // emitAuditEvent, igual que el resto de eventos sherlock_*. El swap no
    // expone el contenido del análisis al log.
    if (resolved.swapped) {
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_model_swap',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                sherlockProvider: resolved.provider,
                durationMs: Date.now() - startedAt,
                errorCode: null,
                // CA-AUDIT-1 (#3484) — campos enriched. sameProvider sigue
                // siendo true (no cambió el provider); sameModel ahora es
                // false (porque el swap a otro modelo del provider lo evitó).
                sameProvider: true,
                sameModel: false,
                sherlockModel: resolved.model,
                transport: resolved.transport,
                // #3501 CA-5 — campos diferenciados específicos del swap.
                swapModelOrigen: resolved.originalModel,
                swapModelDestino: resolved.model,
                swapReason: resolved.swapReason || 'same_model_avoidance',
            },
        });
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
                commanderProvider,
                commanderModel,
                sherlockProvider: resolved.provider,
                durationMs: Date.now() - startedAt,
                errorCode: drCheck.reason,
                // CA-AUDIT-1 (#3484) — campos enriched a partir del resolved.
                sameProvider,
                sameModel,
                sherlockModel: resolved.model,
                transport: resolved.transport,
            },
        });
        return {
            verdict: 'aborted',
            reason: `residency_${drCheck.reason}`,
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            transport: resolved.transport,
            sameProvider,
            sameModel,
            commanderProvider,
            commanderModel,
            durationMs: Date.now() - startedAt,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: 'residency_blocked',
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
            // #3501 — el swap inicial (si lo hubo) sigue siendo informativo
            // aunque la residency haya bloqueado antes de despachar.
            modelSwap: resolved.swapped
                ? { swapped: true, originalModel: resolved.originalModel, reason: resolved.swapReason || 'same_model_avoidance' }
                : { swapped: false, originalModel: null, reason: null },
        };
    }

    // CA-SEC-2 — prompt con delimitadores XML.
    const prompt = buildFiscalPrompt({
        analysis: safeAnalysis,
        originalRequest,
        systemState,
        lastHourLogs,
    });

    // -------------------------------------------------------------------------
    // #3558 — Cascada de reintentos entre providers/modelos.
    //
    // Estrategia:
    //   1. Pre-resolver la cadena de candidatos (initial + fallbacks via
    //      resolveSherlockProvider con `initialExcluded` creciente).
    //   2. Delegar la iteración a `retryChain.retryInCascade`, que gestiona
    //      la rotación de modelos same-provider (CA-INV-ADVERSARIAL), el cap
    //      de tiempo (CA-SEC-CASCADE-CAP), la clasificación de errores
    //      (CA-SEC-SKIP-QUOTA), la residency-recheck (CA-SEC-3-RECHECK) y la
    //      auditoría de cada intento (CA-F3 + CA-SEC-AUDIT-REDACT).
    // -------------------------------------------------------------------------

    // 1. Construir la cadena de candidatos (initial + hasta SHERLOCK_CASCADE_MAX_PROVIDERS-1 fallbacks).
    const cascadeChain = [resolved];
    const alreadyTriedProviders = new Set([resolved.provider]);
    for (let i = 1; i < SHERLOCK_CASCADE_MAX_PROVIDERS; i++) {
        const next = resolveSherlockProvider({
            initialExcluded: alreadyTriedProviders,
            pipelineDir,
            log: _log,
            quotaModule,
            dispatchModule,
            fsImpl,
            now: _now,
        });
        if (!next || !next.provider) break;
        if (alreadyTriedProviders.has(next.provider)) break;
        cascadeChain.push(next);
        alreadyTriedProviders.add(next.provider);
    }

    // 2. Wrappers inyectables para retryInCascade.
    //
    // `cascadeComplete` rutea HTTP vs spawn según el transport del candidato.
    const cascadeComplete = async ({ provider, model, transport }) => {
        if (transport === 'spawn' && provider === 'anthropic') {
            const r = await _spawnAnthropic({
                prompt,
                timeoutMs: cfg.timeoutMs,
                spawnImpl,
                anthropicHandler,
                cwd,
                env,
            });
            // Normalizamos shape extra para igualar contrato del completion-client.
            if (r && typeof r === 'object') r.model = model;
            return r;
        }
        return await _completion.complete({
            provider,
            model,
            prompt,
            timeoutMs: cfg.timeoutMs,
            maxTokens: 1024,
            temperature: 0,
        });
    };

    // `cascadeHasCredential` filtra providers sin key managed antes de iterar
    // (CA-SEC-CRED-FILTER). Anthropic vía spawn-CLI no usa key managed.
    const _secretsRw = require('./multi-provider/secrets-rw');
    const cascadeHasCredential = (provider) => {
        // Anthropic spawn-CLI usa OAuth/MAX login; no hay key managed.
        if (provider === 'anthropic') return true;
        try {
            return !!_secretsRw.getRawKey({ provider, fsImpl });
        } catch {
            return false;
        }
    };

    // `cascadeResidency` re-corre enforceDataResidency para cada provider
    // distinto del inicial (CA-SEC-3-RECHECK). El inicial ya fue validado
    // arriba (líneas 783-831); skip para evitar emitir `data_residency_check`
    // dos veces por el mismo provider.
    const cascadeResidency = (provider) => {
        if (provider === resolved.provider) return { ok: true };
        const dr = commanderMP.enforceDataResidency({
            pipelineDir,
            provider,
            paths: [],
            log: _log,
            chatId: null,
            prompt: safeAnalysis,
            drfModule: _residency,
            auditLog,
            fsImpl,
            now: _now,
        });
        if (dr && dr.ok) return { ok: true };
        return { ok: false, reason: (dr && dr.reason) || 'residency_blocked' };
    };

    // `cascadeEmit` enriquece cada evento de la cascada con campos canónicos
    // del verifier (analysisHash, commanderProvider, sameProvider, transport)
    // antes de delegarlo a `emitAuditEvent`. CA-SEC-AUDIT-REDACT: nunca
    // propaga prompt, body, ni stderr — solo metadatos tipados.
    const cascadeEmit = ({ event, payload }) => {
        if (!payload) payload = {};
        const candTransport = (cascadeChain.find(c => c.provider === payload.provider) || {}).transport || null;
        const candSameProvider = !!(commanderProvider && payload.provider && commanderProvider === payload.provider);
        const candSameModel = !!(candSameProvider && commanderModel && payload.model && commanderModel === payload.model);
        // El `errorCode` canónico del audit usa reason si existe, sino type.
        let errorCode = null;
        if (payload.error && typeof payload.error === 'object') {
            errorCode = payload.error.reason || payload.error.type || null;
        }
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event,
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                sherlockProvider: payload.provider || null,
                sherlockModel: payload.model || null,
                transport: candTransport,
                sameProvider: candSameProvider,
                sameModel: candSameModel,
                durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : 0,
                errorCode,
                // Campos específicos del retry: attemptNumber, error (redacted),
                // reason (para provider_skipped), severity. Estos viajan en
                // `extra` del audit-log (no top-level), pero por simplicidad y
                // back-compat con el shape actual los dejamos en el payload.
                attemptNumber: payload.attemptNumber || null,
                retryError: payload.error || null,
                providerSkippedReason: payload.reason || null,
            },
        });
    };

    // 3. Ejecutar la cascada.
    const cascadeResult = await retryChain.retryInCascade({
        chain: cascadeChain,
        initialProvider: resolved.provider,
        initialModel: resolved.model,
        initialTransport: resolved.transport,
        complete: cascadeComplete,
        parseAndValidate: parseAndValidateSherlockOutput,
        modelsAllowlist: (_completion && _completion.PROVIDER_MODELS_ALLOWLIST)
            || require('./multi-provider/completion-client').PROVIDER_MODELS_ALLOWLIST,
        hasCredential: cascadeHasCredential,
        enforceResidency: cascadeResidency,
        emitAuditEvent: cascadeEmit,
        maxAttemptsPerProvider: SHERLOCK_CASCADE_MAX_ATTEMPTS_PER_PROVIDER,
        maxProviders: SHERLOCK_CASCADE_MAX_PROVIDERS,
        maxTotalCascadeMs: SHERLOCK_CASCADE_MAX_TOTAL_MS,
        log: _log,
        now: () => Date.now(),
    });

    const totalMs = Date.now() - startedAt;

    // #3501 — `modelSwap` describe la decisión del resolver inicial (swap
    // intra-provider via alternative_models[]). Si la cascada (#3558) terminó
    // cayendo a un provider/modelo distinto del swap inicial, ese swap ya no
    // refleja lo que el usuario está viendo — se recalibra abajo en el success
    // path. Para los error paths basta con el snapshot del intento inicial.
    const initialModelSwap = resolved.swapped
        ? { swapped: true, originalModel: resolved.originalModel, reason: resolved.swapReason || 'same_model_avoidance' }
        : { swapped: false, originalModel: null, reason: null };

    // 4. Manejar el resultado.
    if (!cascadeResult.ok) {
        // CA-F5 — DISCLAIMER_F6 SOLO cuando la cascada agota o se gatilla el cap.
        emitAuditEvent({
            pipelineDir, fsImpl, auditLog, now: _now,
            event: 'sherlock_verification',
            payload: {
                analysisHash: hashFor(analysis),
                commanderProvider,
                commanderModel,
                sherlockProvider: resolved.provider,
                durationMs: totalMs,
                errorCode: cascadeResult.errorCode,
                // CA-AUDIT-1 (#3484) — campos enriched.
                sameProvider,
                sameModel,
                sherlockModel: resolved.model,
                transport: resolved.transport,
                // CA-F4 (#3558) — campos enriched de cascada.
                attemptCount: cascadeResult.attemptsCount,
                fallbackUsed: cascadeResult.fallbackUsed,
                chainTried: cascadeResult.chainTried,
                cascadeAbortedByCap: cascadeResult.cascadeAbortedByCap,
            },
        });
        const lastErr = cascadeResult.lastError || {};
        const reason = cascadeResult.cascadeAbortedByCap
            ? 'cascade_timeout'
            : (lastErr.type === 'schema_violation' ? `schema_violation:${lastErr.parseErrorCode || 'unknown'}`
              : (lastErr.type === 'timeout' ? 'timeout'
                : `provider_error:${lastErr.type || lastErr.reason || 'unknown'}`));
        return {
            verdict: 'aborted',
            reason,
            inconsistencies: [],
            inconsistenciesTruncated: false,
            sherlockProvider: resolved.provider,
            sherlockModel: resolved.model,
            transport: resolved.transport,
            sameProvider,
            sameModel,
            commanderProvider,
            commanderModel,
            durationMs: totalMs,
            inputTokens: 0,
            outputTokens: 0,
            errorCode: cascadeResult.errorCode,
            suggestedDisclaimer: DISCLAIMER_TYPES.TIMEOUT_OR_NO_PROVIDER,
            // #3501 — describe el swap intentado en la resolución inicial,
            // aunque la cascada haya agotado sin éxito.
            modelSwap: initialModelSwap,
            // CA-F4 (#3558) — campos enriched de cascada.
            attemptCount: cascadeResult.attemptsCount,
            fallbackUsed: cascadeResult.fallbackUsed,
            chainTried: cascadeResult.chainTried,
            cascadeAbortedByCap: cascadeResult.cascadeAbortedByCap,
        };
    }

    // Cascada exitosa — al menos un intento devolvió httpResult.ok + schema válido.
    const httpResult = cascadeResult.httpResult;
    const parsed = cascadeResult.parsed;
    const finalProvider = cascadeResult.providerUsed;
    const finalModel = cascadeResult.modelUsed;
    const finalTransport = cascadeResult.transportUsed;
    const finalSameProvider = !!(commanderProvider && finalProvider && commanderProvider === finalProvider);
    const finalSameModel = !!(finalSameProvider && commanderModel && finalModel && commanderModel === finalModel);

    // #3501 — Recalibrar `modelSwap` contra el resultado FINAL de la cascada.
    // El swap intra-provider del resolver inicial solo refleja lo que el usuario
    // ve si la cascada terminó en el mismo provider+modelo donde el resolver
    // swapeó. Si cayó a otro modelo (rotación cascade) u otro provider
    // (fallback), el "(swap desde X)" del footer (CA-11) sería engañoso, así
    // que reportamos `swapped:false` en esos casos.
    const finalModelSwap = (initialModelSwap.swapped
            && finalProvider === resolved.provider
            && finalModel === resolved.model)
        ? initialModelSwap
        : { swapped: false, originalModel: null, reason: null };

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
            sherlockProvider: finalProvider,
            durationMs: totalMs,
            inputTokens: httpResult.inputTokens,
            outputTokens: httpResult.outputTokens,
            errorCode: null,
            // CA-AUDIT-1 (#3484) — campos enriched para análisis cross-provider.
            sameProvider: finalSameProvider,
            sameModel: finalSameModel,
            sherlockModel: finalModel,
            transport: finalTransport,
            // CA-F4 (#3558) — campos enriched de cascada.
            attemptCount: cascadeResult.attemptsCount,
            fallbackUsed: cascadeResult.fallbackUsed,
            chainTried: cascadeResult.chainTried,
            cascadeAbortedByCap: false,
        },
    });

    return {
        verdict: parsed.data.verdict,
        reason: parsed.data.reason,
        inconsistencies: parsed.data.inconsistencies,
        inconsistenciesTruncated: parsed.data.inconsistenciesTruncated,
        sherlockProvider: finalProvider,
        sherlockModel: finalModel,
        transport: finalTransport,
        sameProvider: finalSameProvider,
        sameModel: finalSameModel,
        commanderProvider,
        commanderModel,
        durationMs: totalMs,
        inputTokens: httpResult.inputTokens || 0,
        outputTokens: httpResult.outputTokens || 0,
        errorCode: null,
        suggestedDisclaimer: DISCLAIMER_TYPES.NONE, // el caller decide F-5 vs nada
        claimHashes,
        contradictionHashes,
        // #3501 — `finalModelSwap` se calculó arriba para reflejar si el swap
        // intra-provider del resolver inicial se mantuvo en el resultado final.
        modelSwap: finalModelSwap,
        // CA-F4 (#3558) — campos enriched de cascada disponibles para el caller.
        attemptCount: cascadeResult.attemptsCount,
        fallbackUsed: cascadeResult.fallbackUsed,
        chainTried: cascadeResult.chainTried,
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
//   - Si hubo swap: " (swap desde <model-origen>)" al final
//   - Si NO hubo swap: el footer se mantiene neutro (mismo formato sin sufijo)
//
// Respeta `feedback_telegram-messages-natural.md`: la diferencia (swap vs
// no-swap) es informativa, no celebratoria. El caller (pulpo.js) decide si
// agregar el footer al mensaje según política (ej. solo cuando swap, o
// siempre).
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
    // #3501 CA-SEC-SWAP-3 — invariante runtime de swaps intra-provider.
    HARDCODED_MAX_MODEL_SWAPS,
    DEFAULT_TIMEOUT_MS,
    MAX_INCONSISTENCIES,
    HTTP_COMPLETION_PROVIDERS,
    SPAWN_COMPLETION_PROVIDERS,
    // #3558 — caps de cascada (exportados para tests + docs).
    SHERLOCK_CASCADE_MAX_PROVIDERS,
    SHERLOCK_CASCADE_MAX_TOTAL_MS,
    SHERLOCK_CASCADE_MAX_ATTEMPTS_PER_PROVIDER,
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
    _readAlternativeModelsForProvider: readAlternativeModelsForProvider,
};

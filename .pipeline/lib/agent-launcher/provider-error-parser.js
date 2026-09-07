// =============================================================================
// agent-launcher/provider-error-parser.js — Parser robusto de errores
// in-flight de spawns LLM para fallback multi-provider (issue #3434).
//
// MIGRACIÓN #3575
// ---------------
// Este archivo era `lib/commander/provider-error-parser.js`. Se movió a
// `lib/agent-launcher/` para que la generalización del hook (historia hija 2,
// #3576) pueda hookear el parser desde el orquestador sin acoplarse al
// Commander. El path legacy queda como shim estático (`module.exports =
// require('../agent-launcher/provider-error-parser')`) por compatibilidad
// con los callers existentes (`multi-provider.js:713` + tests).
//
// SCOPE DE ESTA HISTORIA: no-op funcional. El código del parser es idéntico
// al pre-migración salvo por el require de `anthropic-1m-workaround` que
// ahora vive en `../commander/` (sigue allí, este scope no lo mueve).
//
// CONTEXTO
// --------
// Issue del incidente 2026-05-20: Anthropic agotó cuota durante una ventana,
// pero el audit log `commander-dispatch-2026-05-20.jsonl` reportó
// `chain_tried: ["anthropic"]` en todos los dispatches — nunca se intentó
// saltar de provider. El gap es de **señal**: cuando el child process devolvió
// `no_result` (timeout) o el stream se truncó sin shape conocido, ningún
// handler tradujo eso a "fallback a próximo provider".
//
// Este módulo cierra el gap. Es una superficie estructurada que delega a los
// detectores existentes (`lib/quota-exhausted.js#_detectAnthropic`,
// `_detectOpenAI`, `detectQuotaError`) cuando aplica, y agrega heurísticas
// para señales que esos detectores NO cubren: timeouts, exit codes ≠ 0, 429
// HTTP de API directa, errores transitorios 5xx, errores de auth.
//
// CONTRATO PÚBLICO
// ----------------
//   parseProviderError(rawOutput, ctx) → {
//     errorClass: 'quota_exhausted' | 'rate_limit' | 'transient_5xx' |
//                 'auth' | 'permanent_failure' | 'cli_1m_context_glitch' |
//                 'unknown',
//     retriable: boolean,
//     shouldFallback: boolean,
//     raw: string,        // saneado (max 200 chars, sin secrets, sin CR/LF)
//     evidence: string,   // línea/json que disparó la clasificación (saneado)
//   }
//
//   ctx = {
//     provider: 'anthropic' | 'openai-codex' | 'gemini-google' | 'cerebras' | 'nvidia-nim',
//     transport: 'api' | 'cli',
//     timedOut?: boolean,        // wrapper de spawn detectó timeout
//     exitCode?: number | null,  // exit code del child process (null si timedOut)
//     durationMs?: number,       // duración total del spawn
//   }
//
// MATRIZ errorClass × shouldFallback × ¿caller llama setFlag?
//   | errorClass              | shouldFallback | setFlag? |
//   | quota_exhausted         | true           | sí       |
//   | rate_limit              | true           | sí       |
//   | transient_5xx           | true           | NO       |
//   | auth                    | true           | NO       |
//   | permanent_failure       | true           | NO       |  ← cubre context_length, model_not_found
//   | cli_1m_context_glitch   | false          | NO       |  ← #3506: bug del CLI Anthropic con Opus 4.7 1M, NO contaminar el flag de quota ni saltar provider
//   | authentication_rejected | false          | NO       |  ← #5795: credencial inválida/expirada. Esta capa SOLO clasifica y transporta; el presupuesto de re-resolución es del coordinador (#5794)
//   | unknown                 | false          | NO       |
//
// #5795 — authentication_rejected vs auth
// ---------------------------------------
// Son DOS clases distintas y conviven:
//   * `auth` nace de regex sobre texto libre (`CLI_AUTH_PATTERNS`) o de un
//     401/403 pelado. Es ruidosa a propósito: sirve para decidir fallback
//     grueso. Queda EXACTAMENTE como estaba.
//   * `authentication_rejected` nace SÓLO de combinaciones estructuradas
//     documentadas por provider (tabla cerrada por adapter, despacho por
//     `ctx.provider`). Es la única que puede sostener una política de
//     invalidación de credencial.
// Un 403 de permisos, un timeout, un 5xx, un 429 o una credencial ausente NO
// producen `authentication_rejected` — siguen cayendo donde siempre.
//
// #3506 — cli_1m_context_glitch
// -----------------------------
// El CLI de Anthropic Claude Code tira intermitentemente
// `"Usage credits required for 1M context"` aunque el plan Claude Max 20x
// SÍ incluya 1M context para Opus 4.7. Antes de #3506, el patrón genérico
// `Usage credits required` clasificaba el caso como `quota_exhausted`,
// disparando setFlag y fallback a Codex/Gemini — desperdiciando Anthropic
// estando sano. Este errorClass aísla el subcaso: `retriable: true`,
// `shouldFallback: false`. El caller (pulpo.js / ejecutarClaude) decide la
// política de retry/backoff y la eventual degradación a 200K. Si los retries
// fallan, el caller puede escalar a fallback explícito.
//
// SCOPE DE SEGURIDAD (SR-1..SR-9 del issue)
// -----------------------------------------
// SR-1 Separación content vs control channel:
//      * Anthropic CLI: SOLO líneas que parsean como JSON con shape
//        `type === 'result' && is_error === true && error_type ∈ allowlist`.
//      * Codex/Gemini CLI: SOLO stderr (que el caller debe pasar separado).
//        PROHIBIDO matchear contra stdout. Si el caller pasa stdout, el parser
//        falla cerrado (`unknown`).
//      * API directa: SOLO objeto `error` top-level o último frame SSE.
// SR-2 Sanitización: reusa `quota-exhausted.sanitizeRawExcerpt` antes de
//      exponer `raw` y `evidence` al caller.
// SR-3 Cap input 64KB antes de cualquier match (anti-DoS).
// SR-4 Regex ReDoS-safe: cuantificadores acotados explícitos. PROHIBIDO `.*`
//      libre. Tests adversariales 1MB <50ms.
// SR-5 `provider` y `transport` son inputs autoritativos del caller. Si
//      faltan o el `provider` no está en la allowlist → fail-closed
//      (`errorClass: 'unknown'`).
// SR-6 El parser NO llama `setFlag`. Solo retorna `shouldFallback`. El
//      caller decide si persiste.
// SR-7 El `errorType` que el caller persiste vía `setFlag` DEBE existir en
//      `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider]`. Si el parser detecta
//      algo fuera de esa allowlist → emite `unknown` para no contaminar el
//      flag con valores no canónicos.
// SR-8 Audit log unificado con hash-chain — lo hace el caller con
//      `appendChained` desde `lib/audit-log.js`.
// SR-9 Bounded SSE parser: lectura línea por línea con cap 16KB por línea.
//
// Sin dependencias externas (Node puro: nada nuevo en node_modules).
//
// #3486 — Integración con clasificador HTTP universal
// ----------------------------------------------------
// El parser sigue siendo el especialista en errores ESTRUCTURADOS (JSON shape
// del body: error.type, error.code, error.status). Eso cubre el canal CLI y
// gran parte del canal API. Donde delega al clasificador HTTP universal
// (`lib/http-error-classifier.js`) es en el path `transport: 'api'` cuando:
//   1. Extrajimos un `status` numérico del body parseado.
//   2. Ninguno de los checks específicos del parser matcheó.
// En ese fallback, el clasificador agrega cobertura uniforme para 402, 5xx,
// 4xx misceláneos sin que el parser tenga que duplicar la matriz. Para el
// resto (CLI stderr, shape estructural, classifyByContext) el parser mantiene
// su lógica — el canal CLI no tiene HTTP status visible y el clasificador no
// aporta.
// =============================================================================
'use strict';

// #3486: clasificador HTTP universal para fallback de clasificación cuando el
// parser estructural no matchea pero hay statusCode extraído del body.
const httpClassifier = require('../http-error-classifier');

// #3508 — feature flag operativo del workaround #3506. Lo chequeamos ANTES de
// `CLI_1M_CONTEXT_GLITCH_PATTERN` para permitir kill-switch sin redeploy.
// Con flag OFF el error cae al path genérico `quota_exhausted` (comportamiento
// pre-#3506). Default = enabled (SEC-3).
// #3575: tras la migración a lib/agent-launcher/, el workaround sigue
// viviendo en lib/commander/ (fuera de scope de este split). El require es
// un string literal estático para preservar NEW-5 (no path traversal).
const oneMWorkaround = require('../commander/anthropic-1m-workaround');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// SR-3: cap de input. 64KB es generoso para cualquier shape de error real
// (Anthropic stream-json events ~2KB, SSE frames ~4KB), pero corta al
// vuelo si un child process colgado escupe MB de stdout.
const MAX_RAW_INPUT_BYTES = 65536;

// SR-9: cap por línea para parser SSE/JSON.
const MAX_LINE_BYTES = 16384;

// SR-3: timeout que justifica clasificar como transient_5xx. El incidente
// del 2026-05-20 reportó `latency_ms: 600156` (10 min) para un `no_result`.
const TIMEOUT_THRESHOLD_MS = 30000;

// Cap textual sobre `raw`/`evidence` (ya impuesto por sanitizeRawExcerpt
// vía RAW_EXCERPT_MAX_CHARS, pero documentamos el contrato).
const EVIDENCE_MAX_CHARS = 200;

// SR-5: providers conocidos. Si el caller pasa algo fuera de este set, el
// parser falla cerrado (`unknown`). NO inferimos `provider` desde rawOutput.
const KNOWN_PROVIDERS = Object.freeze(new Set([
    'anthropic',
    'anthropic-claude',     // alias usado en agent-models.json fallbacks
    'openai-codex',
    'gemini-google',
    'cerebras',
    'nvidia-nim',
    // #4880 — Kimi (Moonshot), drop-in Anthropic-compatible. Provider conocido
    // para que el parser NO falle cerrado al detectar su cuota (usa
    // `_detectAnthropic` con la allowlist de kimi-moonshot).
    'kimi-moonshot',
]));

// Transports válidos.
const KNOWN_TRANSPORTS = Object.freeze(new Set(['api', 'cli']));

// #5795 — contrato compartido de la clase cerrada `authentication_rejected`.
// El módulo es puro (sin I/O, sin requires pesados), así que se carga arriba.
const authRejection = require('./auth-rejection');

// #5795 — mapa provider → adapter que expone `detectAuthenticationRejected`.
//
// Se resuelve PEREZOSAMENTE y se cachea: `resolve-provider.js` requiere los
// siete adapters, y el de Anthropic requiere de vuelta a este parser (dentro de
// su `detectQuotaExhausted`). Cargarlo arriba ataría el orden de inicialización
// de ese ciclo a la suerte. Lazy + try/catch = fail-closed sin ciclo.
let _authDetectorCache = null;
function getAuthDetector(provider) {
    const canonical = authRejection.canonicalProvider(provider);
    if (!canonical) return null;
    if (_authDetectorCache === null) {
        try {
            const { PROVIDER_HANDLERS } = require('./resolve-provider');
            _authDetectorCache = PROVIDER_HANDLERS || {};
        } catch {
            _authDetectorCache = {};
        }
    }
    const handler = Object.prototype.hasOwnProperty.call(_authDetectorCache, canonical)
        ? _authDetectorCache[canonical]
        : null;
    const detector = handler && handler.detectAuthenticationRejected;
    return typeof detector === 'function' ? detector : null;
}

// Sólo para tests: limpia el caché del mapa de adapters.
function _resetAuthDetectorCache() { _authDetectorCache = null; }

// -----------------------------------------------------------------------------
// SR-4: Regex ReDoS-safe.
//
// Reglas:
//   - Cuantificadores acotados explícitos (`{0,80}` en vez de `.*`).
//   - Anclados a clases de carácter restringidas (`[^\n]` en vez de `.`).
//   - Sin alternancia anidada con backtracking exponencial.
//
// Cada patrón clasifica una señal concreta. El orden de evaluación importa:
// los más específicos van primero (quota_exhausted antes que rate_limit
// genérico).
// -----------------------------------------------------------------------------

// #3506 — Pattern específico del bug del CLI Anthropic Claude Code con
// Opus 4.7 1M context. DEBE evaluarse ANTES de los CLI_QUOTA_PATTERNS
// porque su texto solapa con el genérico "Usage credits required".
// Sin esta separación, el caso del 1M glitch (que NO es cuota real) se
// clasifica como quota_exhausted y dispara fallback innecesario.
const CLI_1M_CONTEXT_GLITCH_PATTERN =
    /\bUsage\s+credits?\s+required\s+for\s+1M\s+context\b/i;

// Errores CLI que indican cuota agotada (Anthropic claude-code, codex).
// Estos textos vienen del stderr o del último frame del stream cuando el
// shape estructural no llegó (provider degradado). Los validamos como
// fallback al detector estructural — NO los aplicamos sobre stdout.
const CLI_QUOTA_PATTERNS = Object.freeze([
    // "API Error: Usage credits required" — Anthropic OAuth Max sin créditos.
    /\bUsage\s+credits?\s+required\b/i,
    // "You've hit your session limit" — Anthropic CLI cuando la sesión OAuth
    // del usuario tocó el techo semanal.
    /\bhit\s+your\s+session\s+limit\b/i,
    // #5454 — "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)"
    // Aviso semanal real del CLI Anthropic (OAuth Max). El sufijo con horario y
    // zona NO forma parte del patrón a propósito: el match por substring ya lo
    // tolera y evita `.*`, cuantificadores anidados o grupos opcionales
    // glotones (SR-4 ReDoS budget). Sólo matcheamos las palabras estables, que
    // no dependen del separador `·` ni del locale del reset.
    /\bhit\s+your\s+weekly\s+limit\b/i,
    // "You've hit your usage limit" — Codex CLI con cuenta ChatGPT (OAuth)
    // cuando el cap rolling de uso se agota. Viene por el canal de control del
    // CLI (turn.failed/error), no por el contenido del modelo.
    /\bhit\s+your\s+usage\s+limit\b/i,
    // "weekly quota exhausted" o "quota exhausted" — texto genérico.
    /\bweekly\s+quota\s+exhausted\b/i,
    /\bquota\s+exhausted\b/i,
    // OpenAI/Codex "insufficient_quota" cuando el wrapper escupe el code.
    /\binsufficient_quota\b/i,
    // OpenAI "billing hard limit reached".
    /\bbilling\s+hard\s+limit\s+reached\b/i,
]);

// Errores CLI que indican rate-limit transitorio (debería resolverse con
// backoff, pero también justifica fallback inmediato).
const CLI_RATE_LIMIT_PATTERNS = Object.freeze([
    // "rate_limit_error" — Anthropic CLI.
    /\brate_limit_error\b/i,
    // "rate limit exceeded" — texto genérico.
    /\brate\s+limit\s+exceeded\b/i,
    /\bToo\s+Many\s+Requests\b/i,
    // HTTP 429 status.
    /\b429\b[^\n]{0,40}\b(?:rate|limit|too\s+many)\b/i,
]);

// Errores CLI de autenticación (no fallback útil — todos los providers
// requieren auth válida; rotar no resuelve).
const CLI_AUTH_PATTERNS = Object.freeze([
    /\bauthentication_error\b/i,
    /\bInvalid\s+API\s+key\b/i,
    /\bUnauthorized\b/i,
    /\b401\b[^\n]{0,40}\b(?:unauthorized|auth)/i,
    /\bauth\s+failed\b/i,
]);

// Errores CLI permanentes (context_length, model_not_found): fallback NO
// resuelve, pero conviene rotar para no romper UX (otro provider PUEDE
// soportar el request con context mayor).
const CLI_PERMANENT_PATTERNS = Object.freeze([
    /\bcontext_length_exceeded\b/i,
    /\bmodel_not_found\b/i,
    /\bmaximum\s+context\s+length\b/i,
    /\binvalid_request_error\b/i,
]);

// Errores CLI transitorios (5xx, overloaded).
const CLI_TRANSIENT_PATTERNS = Object.freeze([
    /\boverloaded_error\b/i,
    /\b5\d{2}\b[^\n]{0,40}\b(?:server|error|overload)\b/i,
    /\bInternal\s+Server\s+Error\b/i,
    /\bService\s+Unavailable\b/i,
    /\bBad\s+Gateway\b/i,
]);

// -----------------------------------------------------------------------------
// Helpers de delegación al detector existente (`lib/quota-exhausted.js`).
//
// CARGA PEREZOSA: para no acoplar el require al boot del módulo y permitir
// inyectar fakes en tests. Cache local — primera llamada paga, resto barato.
// -----------------------------------------------------------------------------
let _quotaModuleCache = null;
function getQuotaModule(override) {
    if (override) return override;
    if (_quotaModuleCache) return _quotaModuleCache;
    _quotaModuleCache = require('../quota-exhausted');
    return _quotaModuleCache;
}

// -----------------------------------------------------------------------------
// truncateInput — SR-3 (anti-DoS).
//
// El caller puede pasar `rawOutput` con MB de stdout/stderr de un child
// colgado. Truncamos a `MAX_RAW_INPUT_BYTES` antes de tocar regex. La
// clasificación se hace sobre el prefijo, que es suficiente porque los
// errores reales (JSON shape, SSE frame, stderr line) caben en los primeros
// 64KB sin excepción documentada.
// -----------------------------------------------------------------------------
function truncateInput(raw) {
    if (raw == null) return '';
    const str = typeof raw === 'string' ? raw : String(raw);
    if (str.length <= MAX_RAW_INPUT_BYTES) return str;
    return str.slice(0, MAX_RAW_INPUT_BYTES);
}

// -----------------------------------------------------------------------------
// splitBoundedLines — SR-9. Divide en líneas con cap por línea.
//
// Si una línea excede MAX_LINE_BYTES (caso patológico: SSE frame sin
// newline o stream binario), la trunca en lugar de descartarla — el match
// estructural sobre el prefijo es suficiente porque el shape vive en el
// inicio del JSON.
// -----------------------------------------------------------------------------
// #4865 — variante con metadata de truncación. Necesitamos saber QUÉ líneas
// fueron cortadas por el cap para no clasificarlas como texto libre más abajo
// (ver `detectFromCliStderr`). Devuelve `{ text, truncated }` por línea.
function splitBoundedLinesMeta(input) {
    if (!input) return [];
    const lines = input.split(/\r\n|\r|\n/);
    return lines.map(l => l.length > MAX_LINE_BYTES
        ? { text: l.slice(0, MAX_LINE_BYTES), truncated: true }
        : { text: l, truncated: false });
}

function splitBoundedLines(input) {
    return splitBoundedLinesMeta(input).map((m) => m.text);
}

// #4865 — ¿la línea ARRANCA como un frame estructurado (JSON stream-json / SSE)?
// Se usa para distinguir un frame truncado por el cap (que NO parsea pero
// tampoco es stderr de texto libre) de una línea de stderr genuina. Un frame
// estructurado empieza con `{`, `[` o el prefijo SSE `data: {`/`data: [`.
function startsWithStructuredFramePrefix(line) {
    const t = (line || '').replace(/^\s+/, '');
    if (!t) return false;
    if (t[0] === '{' || t[0] === '[') return true;
    if (/^data:\s*[\{\[]/.test(t)) return true;
    return false;
}

// -----------------------------------------------------------------------------
// tryParseJson — parsea JSON con manejo defensivo. Devuelve `null` si falla.
// SR-3: no asume tamaño del input (ya truncado por truncateInput).
// -----------------------------------------------------------------------------
function tryParseJson(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return null;
    // Optimización: solo intentar JSON.parse si arranca con `{` o `[`.
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// detectFromCliStderr — match estructural y regex sobre stderr de un CLI.
//
// Estrategia híbrida:
//   1. Si alguna línea es JSON válido con shape Anthropic estructural
//      (`type === 'result' && is_error === true`) → delegamos a
//      `_detectAnthropic` del módulo legacy. Esa función ya respeta
//      `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider]`.
//   2. Si NO hay shape estructural → aplicamos regex acotados sobre las
//      líneas de stderr. SR-1: PROHIBIDO aplicar regex sobre el campo
//      `content` del modelo. El caller pasa stderr (no stdout), y stderr
//      no contiene texto del modelo.
//
// Devuelve `{ errorClass, evidence }` o `null` si no hay match.
// -----------------------------------------------------------------------------
function detectFromCliStderr(input, provider, quotaModule) {
    const linesMeta = splitBoundedLinesMeta(input);
    const lines = linesMeta.map((m) => m.text);
    // Helper local: strip prefijo SSE `data: ` para que JSON.parse vea el JSON.
    // SR-9: cap por línea aplicado upstream en splitBoundedLines.
    const parseJsonOrSSE = (line) => {
        const direct = tryParseJson(line);
        if (direct) return direct;
        const sseMatch = /^data:\s*(\{[^]*\}|\[[^]*\])\s*$/.exec(line);
        if (sseMatch) return tryParseJson(sseMatch[1]);
        return null;
    };

    // #3508 SEC-2: short-circuit del feature flag ANTES de los regex pesados.
    // Cuando el operador desactiva el workaround (`ANTHROPIC_1M_WORKAROUND_ENABLED=0`),
    // saltamos la rama `cli_1m_context_glitch` y dejamos que el error caiga al
    // path genérico `quota_exhausted` (comportamiento pre-#3506). Preserva las
    // garantías ReDoS de #3506 (tests 1MB <50ms) en ambos modos.
    const workaroundEnabled = oneMWorkaround.isWorkaroundEnabled();

    // 1. Shape estructural (Anthropic stream-json).
    const allowlist = (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
    if (allowlist.length > 0 && typeof quotaModule._detectAnthropic === 'function') {
        for (const line of lines) {
            const parsed = parseJsonOrSSE(line);
            if (!parsed) continue;
            // #3506: subcaso del glitch del CLI Anthropic con 1M context. Hay que
            // verificarlo ANTES de delegar a _detectAnthropic porque el shape suele
            // venir con `error_type: 'usage_limit_error'` y matchearía como quota.
            // #3508 SEC-2: solo evaluamos el regex si el workaround está activo.
            if (workaroundEnabled) {
                const textChunks = [parsed.result, parsed.error, parsed.message, parsed.error_message]
                    .filter(s => typeof s === 'string')
                    .join(' ');
                if (textChunks && CLI_1M_CONTEXT_GLITCH_PATTERN.test(textChunks)) {
                    return {
                        errorClass: 'cli_1m_context_glitch',
                        evidence: line,
                    };
                }
            }
            const r = quotaModule._detectAnthropic(parsed, allowlist);
            if (r && r.matched) {
                return {
                    errorClass: 'quota_exhausted',
                    evidence: line,
                };
            }
        }
    }

    // 2. Shape estructural (OpenAI/Codex SSE).
    if (allowlist.length > 0 && typeof quotaModule._detectOpenAI === 'function') {
        for (const line of lines) {
            const parsed = parseJsonOrSSE(line);
            if (!parsed) continue;
            const r = quotaModule._detectOpenAI(parsed, allowlist);
            if (r && r.matched) {
                return {
                    errorClass: 'quota_exhausted',
                    evidence: line,
                };
            }
        }
    }

    // 3. Heurística regex (CLI stderr de texto libre).
    //
    // #4541 (Bug 2 — falso positivo sobre contenido normal): SOLO aplicamos los
    // regex de texto libre sobre líneas que NO son frames estructurados del
    // stream (stream-json / SSE). Un frame JSON del stream —incluyendo el
    // `tool_result` y el contenido del modelo (`type:user`/`assistant`/`item.*`)—
    // NUNCA debe clasificarse por substring: ya tuvo su chance en los pasos 1
    // (`_detectAnthropic`) y 2 (`_detectOpenAI`), que matchean sólo el payload de
    // ERROR estructurado del provider correcto. Durante el incidente 2026-07-07 el
    // caller (pulpo onSpawnExit) pasaba el stdout stream-json COMPLETO del agente
    // como `rawOutput`; un `tool_result` cuyo contenido mencionaba "usage limit"
    // (p.ej. el propio log del detector, o un frame de error de Codex embebido)
    // matcheaba `CLI_QUOTA_PATTERNS` y disparaba un flag espurio. Acotar el regex
    // a texto plano (stderr real degradado, sin shape JSON) elimina la clase
    // entera de falsos positivos sin perder los errores genuinos de CLI que sí
    // llegan como texto libre (crash del CLI antes del JSON, "Usage credits
    // required", etc.). Alineado con SR-1 ("PROHIBIDO substring sobre el content
    // del modelo").
    // #4865 (Bug 1 — falso positivo por truncación 16KB): un frame stream-json/
    // SSE cuyo `tool_result` supera MAX_LINE_BYTES se corta en `splitBoundedLines`
    // → deja de parsear como JSON → caería en `plainTextLines` y el body del
    // issue (que puede mencionar "quota exhausted"/"insufficient_quota") matchea
    // CLI_QUOTA_PATTERNS y dispara un `setFlag` espurio. #4541 blindó el substring
    // contra frames estructurados, pero la truncación convierte un frame en
    // "texto plano" y reabre la clase para frames grandes. Defensa: una línea que
    // (a) NO parsea como JSON/SSE Y (b) fue truncada por el cap Y (c) ARRANCA como
    // frame estructurado, NO es stderr — la excluimos del scan de texto libre.
    const plainTextLines = linesMeta
        .filter(({ text, truncated }) => {
            if (parseJsonOrSSE(text) != null) return false;
            if (truncated && startsWithStructuredFramePrefix(text)) return false;
            return true;
        })
        .map(({ text }) => text);

    // #3506: el subcaso "Usage credits required for 1M context" se evalúa
    // ANTES del genérico para evitar misclassification a quota_exhausted.
    // #3508 SEC-2: short-circuit del flag para preservar ReDoS budget con OFF.
    if (workaroundEnabled) {
        for (const line of plainTextLines) {
            if (CLI_1M_CONTEXT_GLITCH_PATTERN.test(line)) {
                return { errorClass: 'cli_1m_context_glitch', evidence: line };
            }
        }
    }
    for (const line of plainTextLines) {
        // Cuota
        for (const re of CLI_QUOTA_PATTERNS) {
            if (re.test(line)) return { errorClass: 'quota_exhausted', evidence: line };
        }
    }
    for (const line of plainTextLines) {
        // Rate limit
        for (const re of CLI_RATE_LIMIT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'rate_limit', evidence: line };
        }
    }
    for (const line of plainTextLines) {
        // Auth
        for (const re of CLI_AUTH_PATTERNS) {
            if (re.test(line)) return { errorClass: 'auth', evidence: line };
        }
    }
    for (const line of plainTextLines) {
        // Permanente
        for (const re of CLI_PERMANENT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'permanent_failure', evidence: line };
        }
    }
    for (const line of plainTextLines) {
        // Transitorio (5xx)
        for (const re of CLI_TRANSIENT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'transient_5xx', evidence: line };
        }
    }

    // 4. Red de salvataje sobre FRAMES ESTRUCTURADOS (#6190).
    //
    // AGUJERO QUE CIERRA: un CLI puede emitir un error HTTP genérico como frame
    // JSON —p.ej. `{"error":{"status":402,"code":"insufficient_quota",...}}`—
    // que NO tiene el shape propietario que esperan `_detectAnthropic` (paso 1)
    // ni `_detectOpenAI` (paso 2), y que además queda EXCLUIDO del scan de
    // texto libre (paso 3) porque `plainTextLines` filtra a propósito todo lo
    // que parsea como JSON/SSE (defensa #4541/#4865 contra substring sobre el
    // content del modelo). Resultado pre-fix: `detectFromCliStderr` devolvía
    // `null` y `classifyByContext` lo degradaba a `transient_5xx` por
    // `exitCode!=0 + stderr_present`. Un 402 `insufficient_quota` —evidencia
    // DURA de cuota agotada— terminaba clasificado como error transitorio:
    // nunca se seteaba el flag de cuota, nunca se apagaba el provider, y el
    // pipeline seguía martillando un provider exhausto hasta agotar los
    // reintentos del ISSUE y rebotarlo como si el código estuviera roto
    // (incidente #6190: architect/ux murieron con 402 y el issue fue rechazado
    // con "Huérfano tras 3 reintentos — proceso muere repetidamente").
    //
    // El path de API directa YA tenía esta red (#3486). Acá la replicamos para
    // el path CLI, que era el único desprotegido.
    //
    // POR QUÉ NO REABRE #4541 NI #4865: operamos EXCLUSIVAMENTE sobre frames
    // que parsean como JSON/SSE y SÓLO leemos el objeto `error` top-level
    // (campos `status`/`code`/`type`). Cero substring sobre `content`,
    // `result` o `tool_result`. Una línea truncada por el cap NO parsea como
    // JSON, así que jamás entra acá.
    //
    // ORDEN: va al final, justo antes del `return null`. Todas las
    // clasificaciones previas (pasos 1-3) mantienen exactamente la precedencia
    // que tenían — este paso sólo rescata lo que ANTES caía a `null`.
    for (const line of lines) {
        const parsed = parseJsonOrSSE(line);
        if (!parsed || typeof parsed !== 'object') continue;

        const errObj = parsed.error || (parsed.data && parsed.data.error);
        if (!errObj || typeof errObj !== 'object') continue;

        const type = typeof errObj.type === 'string' ? errObj.type : '';
        const code = typeof errObj.code === 'string' ? errObj.code : '';
        const message = typeof errObj.message === 'string' ? errObj.message : '';
        const status = Number(errObj.status) || Number(parsed.status) || 0;

        // #3506/#3508: el glitch del CLI con 1M context puede venir con shape de
        // error y NO debe contaminar el flag de cuota. Se chequea primero, igual
        // que en el path de API directa.
        if (workaroundEnabled && message && CLI_1M_CONTEXT_GLITCH_PATTERN.test(message)) {
            return {
                errorClass: 'cli_1m_context_glitch',
                evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
            };
        }

        // Cuota por marcador estructurado del PROPIO provider (CA-5 #3077: el
        // allowlist es scope-por-provider, nunca cross-provider).
        if (allowlist.includes(type) || allowlist.includes(code)) {
            return {
                errorClass: 'quota_exhausted',
                evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
            };
        }

        // Salvataje por status HTTP numérico vía el clasificador universal
        // (402 → billing/quota, 429 → rate_limit o billing según body,
        //  401/403 → auth, 5xx → transient).
        if (status >= 100 && status <= 599) {
            const c = httpClassifier.classifyHttpError(status, line, provider);
            const mapped = mapClassifierToErrorClass(c);
            if (mapped) {
                return {
                    errorClass: mapped,
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }
        }
    }

    return null;
}

// -----------------------------------------------------------------------------
// detectFromApiResponse — parsea respuesta JSON o último frame SSE de API
// directa (Gemini, Groq histórico, Cerebras, NVIDIA NIM).
//
// SR-1: matcheamos SOLO contra el objeto `error` top-level o el campo
// estructural `error.type`. PROHIBIDO substring sobre `content`.
// SR-9: parseo SSE línea por línea con cap.
// -----------------------------------------------------------------------------
function detectFromApiResponse(input, provider, quotaModule) {
    // Caso 1: respuesta JSON entera (no SSE).
    const fullParsed = tryParseJson(input);
    if (fullParsed) {
        const errObj = fullParsed.error || (fullParsed.data && fullParsed.data.error);
        if (errObj && typeof errObj === 'object') {
            const type = typeof errObj.type === 'string' ? errObj.type : '';
            const code = typeof errObj.code === 'string' ? errObj.code : '';
            const status = Number(errObj.status) || Number(fullParsed.status) || 0;
            const message = typeof errObj.message === 'string' ? errObj.message : '';

            // #3506: subcaso del glitch CLI con 1M context (puede venir tambien
            // por API directa con mismo texto en `message`).
            // #3508 SEC-2: short-circuit del feature flag antes del regex.
            if (oneMWorkaround.isWorkaroundEnabled() && message && CLI_1M_CONTEXT_GLITCH_PATTERN.test(message)) {
                return {
                    errorClass: 'cli_1m_context_glitch',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // Quota / billing.
            const allowlist = (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
            if (allowlist.includes(type) || allowlist.includes(code)) {
                return {
                    errorClass: 'quota_exhausted',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // 429 (rate limit).
            if (status === 429 || type === 'rate_limit_error' || code === 'rate_limit_exceeded') {
                return {
                    errorClass: 'rate_limit',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // 401/403 (auth).
            if (status === 401 || status === 403 ||
                type === 'authentication_error' || code === 'unauthorized') {
                return {
                    errorClass: 'auth',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // Permanent: context length, model not found, invalid request.
            if (code === 'context_length_exceeded' ||
                type === 'invalid_request_error' ||
                code === 'model_not_found' ||
                type === 'model_not_found') {
                return {
                    errorClass: 'permanent_failure',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // 5xx transitorio.
            if ((status >= 500 && status <= 599) ||
                type === 'overloaded_error' ||
                code === 'service_unavailable') {
                return {
                    errorClass: 'transient_5xx',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }

            // #3486: fallback al clasificador HTTP universal. Si extrajimos
            // un status numérico válido pero ninguno de los checks específicos
            // matcheó, el clasificador puede mapear códigos no cubiertos
            // (típicamente 402 Payment Required, o un 5xx con shape genérico).
            // El parser sigue mandando para shapes estructurados — esto es
            // solo "última red de salvataje" antes del permanent_failure.
            if (status >= 100 && status <= 599) {
                const c = httpClassifier.classifyHttpError(status, input, provider);
                const mapped = mapClassifierToErrorClass(c);
                if (mapped) {
                    return {
                        errorClass: mapped,
                        evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                    };
                }
            }

            // Algún error reportado pero sin clase clara → permanent_failure
            // por defensa (fallback no va a empeorar; el caller no setFlaguea
            // así que no contamina el flag).
            if (type || code || message) {
                return {
                    errorClass: 'permanent_failure',
                    evidence: JSON.stringify(errObj).slice(0, MAX_LINE_BYTES),
                };
            }
        }
    }

    // Caso 2: stream SSE — leer última línea `data: {...}` con `error`.
    const lines = splitBoundedLines(input);
    // Iteramos de atrás hacia adelante: el frame final es el más informativo.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // SR-1: solo líneas con prefijo `data:` (canal de control SSE).
        const m = /^data:\s*(\{[^]*\})\s*$/.exec(line);
        if (!m) continue;
        const json = tryParseJson(m[1]);
        if (!json) continue;
        const errObj = json.error || (json.data && json.data.error) || null;
        if (!errObj || typeof errObj !== 'object') continue;
        const type = typeof errObj.type === 'string' ? errObj.type : '';
        const code = typeof errObj.code === 'string' ? errObj.code : '';
        const status = Number(errObj.status) || Number(json.status) || 0;

        const allowlist = (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
        if (allowlist.includes(type) || allowlist.includes(code)) {
            return { errorClass: 'quota_exhausted', evidence: line };
        }
        if (status === 429 || type === 'rate_limit_error' || code === 'rate_limit_exceeded') {
            return { errorClass: 'rate_limit', evidence: line };
        }
        if (status === 401 || status === 403 || type === 'authentication_error') {
            return { errorClass: 'auth', evidence: line };
        }
        if (code === 'context_length_exceeded' || type === 'invalid_request_error') {
            return { errorClass: 'permanent_failure', evidence: line };
        }
        if ((status >= 500 && status <= 599) || type === 'overloaded_error') {
            return { errorClass: 'transient_5xx', evidence: line };
        }
        // Tiene `error` pero sin clase reconocida.
        return { errorClass: 'permanent_failure', evidence: line };
    }

    return null;
}

// -----------------------------------------------------------------------------
// mapClassifierToErrorClass — adapta el output del clasificador HTTP universal
// (#3486) al enum `errorClass` del parser. Es un mapeo conservador: solo
// devuelve errorClass cuando el clasificador da una categoría accionable.
//   billing/quota_exhausted    → 'quota_exhausted'
//   rate_limit/rate_limited    → 'rate_limit'
//   auth/*                     → 'auth'
//   transient/server_error     → 'transient_5xx'
//   success / unknown          → null (el caller decide; típicamente cae a
//                                permanent_failure por defensa de fallback).
// -----------------------------------------------------------------------------
function mapClassifierToErrorClass(c) {
    if (!c || typeof c !== 'object') return null;
    switch (c.category) {
        case 'billing':   return 'quota_exhausted';
        case 'rate_limit': return 'rate_limit';
        case 'auth':      return 'auth';
        case 'transient': return 'transient_5xx';
        case 'success':
        case 'unknown':
        default:
            return null;
    }
}

// -----------------------------------------------------------------------------
// classifyByContext — decisiones por signals del wrapper de spawn cuando el
// rawOutput no entrega shape claro. Cubre el caso `no_result` del incidente
// 2026-05-20: child colgado, sin output útil, `latency_ms: 600156`.
//
// Reglas:
//   - timedOut === true OR durationMs >= TIMEOUT_THRESHOLD_MS sin
//     clasificación previa → transient_5xx (el provider colgó; rotar puede
//     funcionar).
//   - exitCode !== 0 sin clasificación previa + stderr no-vacío → permanent
//     o transient según el contenido (sin shape, lo conservamos como
//     `transient_5xx`).
//   - exitCode === 0 y rawOutput vacío → permanent_failure (caso extraño
//     pero documentable; el provider devolvió "OK" sin contenido).
//   - exit code 0, sin signals, output vacío sin contexto → unknown.
// -----------------------------------------------------------------------------
function classifyByContext(ctx, hasStderr) {
    const { timedOut, exitCode, durationMs } = ctx;

    if (timedOut === true || (Number.isFinite(durationMs) && durationMs >= TIMEOUT_THRESHOLD_MS)) {
        return {
            errorClass: 'transient_5xx',
            evidence: `timedOut=${timedOut === true} durationMs=${Number.isFinite(durationMs) ? Math.round(durationMs) : 'n/a'}`,
        };
    }

    if (Number.isFinite(exitCode) && exitCode !== 0 && hasStderr) {
        return {
            errorClass: 'transient_5xx',
            evidence: `exitCode=${exitCode} stderr_present=true`,
        };
    }

    return null;
}

// -----------------------------------------------------------------------------
// classifyShouldFallback — política de fallback por errorClass.
//
// Matriz documentada en el header. Aislada en función para que el caller
// pueda introspectar (no hardcodea la matriz en cada call site).
// -----------------------------------------------------------------------------
function classifyShouldFallback(errorClass) {
    switch (errorClass) {
        case 'quota_exhausted':
        case 'rate_limit':
        case 'transient_5xx':
        case 'auth':
        case 'permanent_failure':
            return true;
        // #3506: el glitch del CLI con 1M context NO debe rotar provider en el
        // primer intento. El caller hace retry en mismo provider; si los retries
        // fallan, escala explícitamente.
        case 'cli_1m_context_glitch':
        // #5795: un rechazo de credencial NO dispara fallback desde esta capa.
        // Se declara explícito (en vez de caer al default) para que quede
        // asentado que es una decisión, no un olvido: quien resuelve qué hacer
        // con la credencial es el coordinador de #5794.
        case 'authentication_rejected':
        case 'unknown':
        default:
            return false;
    }
}

// retriable: si reintenta el MISMO provider podría resolverse en seg/min.
// quota_exhausted/auth/permanent_failure son NO retriable; rate_limit,
// transient_5xx y cli_1m_context_glitch sí (este último con degradación
// opcional 1M→200K en el último intento).
// #5795: `authentication_rejected` tampoco es retriable — reintentar con la
// misma credencial rechazada sólo quema intentos. La re-resolución (rotar la
// credencial y recién ahí reintentar) es del coordinador de #5794.
function classifyRetriable(errorClass) {
    return errorClass === 'rate_limit'
        || errorClass === 'transient_5xx'
        || errorClass === 'cli_1m_context_glitch';
}

// -----------------------------------------------------------------------------
// detectAuthenticationRejected (#5795) — clase cerrada, previa a todo lo demás.
//
// QUÉ HACE
//   Recorre SÓLO frames estructurados (JSON por línea, `data: {...}` de SSE, o
//   el body JSON entero) y se los pasa al detector del adapter que corresponde
//   a `ctx.provider`. Si el adapter clasifica, devolvemos su rechazo tipado.
//
// QUÉ NO HACE
//   * No mira texto libre. Una línea que no parsea como JSON/SSE se saltea; no
//     hay regex, ni substring, ni `message`. Las ramas de `auth` por regex
//     (`CLI_AUTH_PATTERNS`) quedan intactas y separadas: siguen produciendo
//     `errorClass: 'auth'` como siempre.
//   * No infiere el provider del contenido. El adapter sale exclusivamente de
//     `ctx.provider` (SR-5), y el propio detector revalida el aislamiento.
//   * No decide retry, fallback ni presupuesto. Sólo clasifica.
//
// PRECEDENCIA
//   Corre ANTES de la detección de cuota/rate-limit/auth-regex. Es seguro
//   porque las tablas positivas de autenticación son disjuntas de las
//   allowlists de cuota, y la guardia de ambigüedad de cada adapter se abstiene
//   ante evidencia contradictoria. Un frame de cuota nunca cae acá.
//
// EVIDENCIA SIN PAYLOAD
//   El `evidence` que devolvemos se construye con NUESTROS tokens (los que
//   matchearon contra la tabla cerrada) más el status HTTP. Nunca es la línea
//   del provider. Es la razón por la que esta clase no puede filtrar un secreto
//   por el canal de evidencia, ni siquiera si el `message` viniera con la API
//   key adentro.
// -----------------------------------------------------------------------------
function detectAuthenticationRejected(input, provider, transport) {
    const detect = getAuthDetector(provider);
    if (!detect) return null;

    // Un frame por línea; el body JSON entero se prueba aparte más abajo.
    const evaluate = (frame, source) => {
        if (!frame) return null;
        const rejection = detect(frame, { provider, transport, source });
        if (!rejection) return null;
        return { errorClass: authRejection.AUTH_REJECTED_CLASS, rejection };
    };

    // 1. Body JSON completo (típico de los runners REST: cerebras, nvidia,
    //    gemini con `-o json`). `transport: 'api'` lo trata como api-json.
    const whole = tryParseJson(input);
    if (whole) {
        const hit = evaluate(whole, transport === 'api' ? 'api-json' : 'cli-stream-json');
        if (hit) return hit;
    }

    // 2. Frames línea por línea: JSONL del stream (`{...}`) o SSE (`data: {...}`).
    for (const line of splitBoundedLines(input)) {
        const direct = tryParseJson(line);
        if (direct) {
            const hit = evaluate(direct, transport === 'api' ? 'api-json' : 'cli-stream-json');
            if (hit) return hit;
            continue;
        }
        const sse = /^data:\s*(\{[^]*\})\s*$/.exec(line);
        if (!sse) continue;
        const parsed = tryParseJson(sse[1]);
        if (!parsed) continue;
        const hit = evaluate(parsed, 'api-sse');
        if (hit) return hit;
    }

    return null;
}

// Arma el `evidence` de un rechazo de autenticación SIN tocar el payload.
function authRejectionEvidence(rejection) {
    const s = (rejection && rejection.signal) || {};
    const token = s.type || s.code || 'sin-token';
    const status = s.status === null || s.status === undefined ? 'n/a' : String(s.status);
    return `${authRejection.AUTH_REJECTED_CLASS} source=${s.source || 'n/a'} token=${token} status=${status}`;
}

// -----------------------------------------------------------------------------
// API pública — parseProviderError(rawOutput, ctx)
// -----------------------------------------------------------------------------
function parseProviderError(rawOutput, ctx = {}) {
    const quotaModule = getQuotaModule(ctx._quotaModule);
    const sanitize = quotaModule && typeof quotaModule.sanitizeRawExcerpt === 'function'
        ? quotaModule.sanitizeRawExcerpt
        : (s) => String(s == null ? '' : s).slice(0, EVIDENCE_MAX_CHARS);

    const provider = typeof ctx.provider === 'string' ? ctx.provider : '';
    const transport = typeof ctx.transport === 'string' ? ctx.transport : '';

    // SR-5: fail-closed sin provider o transport válidos.
    if (!provider || !KNOWN_PROVIDERS.has(provider) || !KNOWN_TRANSPORTS.has(transport)) {
        return {
            errorClass: 'unknown',
            retriable: false,
            shouldFallback: false,
            raw: sanitize(rawOutput),
            evidence: '',
        };
    }

    // SR-3: cap input antes de cualquier procesamiento.
    const truncated = truncateInput(rawOutput);
    // Sanitizamos SOLO el extracto que devolvemos al caller (max ~256 chars).
    // sanitize() de quota-exhausted termina truncando a 200 chars de todos
    // modos; correr regex multi-key sobre 64KB completos sería waste y
    // potencial ReDoS. Sanitize sobre prefijo acotado mantiene el contrato.
    const rawPreview = truncated.length > EVIDENCE_MAX_CHARS + 56
        ? truncated.slice(0, EVIDENCE_MAX_CHARS + 56)
        : truncated;
    const sanitizedRaw = sanitize(rawPreview);
    const hasContent = truncated.length > 0;

    // 0. #5795 — clase cerrada `authentication_rejected`, ANTES que todo.
    //
    // Esta capa SÓLO transporta la señal: `retriable: false` y
    // `shouldFallback: false` para que ni el parser ni el hook conviertan un
    // rechazo de credencial en retry de cuota, retry de issue o reinicio de
    // fallback. El dueño del presupuesto de re-resolución es el coordinador de
    // #5794; acá no se decide nada.
    //
    // `raw: ''` es deliberado. Para el resto de las clases devolvemos un
    // extracto saneado del output, pero un rechazo de credencial es justo el
    // error que más chance tiene de traer la clave en el `message`. No hay
    // sanitizador perfecto: la garantía fuerte es no copiar NADA del payload.
    if (hasContent) {
        let authHit = null;
        try {
            authHit = detectAuthenticationRejected(truncated, provider, transport);
        } catch {
            authHit = null; // fail-closed: nunca rompe la clasificación normal.
        }
        if (authHit) {
            return {
                errorClass: authHit.errorClass,
                retriable: false,
                shouldFallback: false,
                raw: '',
                evidence: authRejectionEvidence(authHit.rejection),
                authRejection: authHit.rejection,
            };
        }
    }

    // 1. Match estructural / regex sobre el rawOutput.
    let detection = null;
    if (hasContent) {
        if (transport === 'cli') {
            detection = detectFromCliStderr(truncated, provider, quotaModule);
        } else if (transport === 'api') {
            detection = detectFromApiResponse(truncated, provider, quotaModule);
        }
    }

    // 2. Si no hubo match, clasificar por contexto (timeouts, exit codes).
    if (!detection) {
        detection = classifyByContext(ctx, hasContent);
    }

    if (!detection) {
        return {
            errorClass: 'unknown',
            retriable: false,
            shouldFallback: false,
            raw: sanitizedRaw,
            evidence: '',
        };
    }

    // SR-7: si el caller va a persistir errorType vía setFlag, valida contra
    // la allowlist. Acá ya entregamos el errorClass canónico; el caller hace
    // la persistencia. Para mantenerlo simple, el contrato del parser es:
    // `quota_exhausted` significa "encontré un error_type que existe en la
    // allowlist del provider". Otros errorClass NO disparan setFlag por
    // política (ver matriz).
    const { errorClass, evidence } = detection;
    return {
        errorClass,
        retriable: classifyRetriable(errorClass),
        shouldFallback: classifyShouldFallback(errorClass),
        raw: sanitizedRaw,
        evidence: sanitize(evidence || ''),
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    parseProviderError,
    classifyShouldFallback,
    classifyRetriable,

    // #5795 — clase cerrada de rechazo de credencial.
    AUTH_REJECTED_CLASS: authRejection.AUTH_REJECTED_CLASS,

    // Constantes públicas (útiles para callers y tests).
    MAX_RAW_INPUT_BYTES,
    MAX_LINE_BYTES,
    TIMEOUT_THRESHOLD_MS,
    KNOWN_PROVIDERS,
    KNOWN_TRANSPORTS,

    // Internos expuestos para tests (prefijo _).
    _truncateInput: truncateInput,
    _splitBoundedLines: splitBoundedLines,
    _splitBoundedLinesMeta: splitBoundedLinesMeta,
    _startsWithStructuredFramePrefix: startsWithStructuredFramePrefix,
    _tryParseJson: tryParseJson,
    _detectAuthenticationRejected: detectAuthenticationRejected,
    _authRejectionEvidence: authRejectionEvidence,
    _getAuthDetector: getAuthDetector,
    _resetAuthDetectorCache,
    _detectFromCliStderr: detectFromCliStderr,
    _detectFromApiResponse: detectFromApiResponse,
    _classifyByContext: classifyByContext,
    _mapClassifierToErrorClass: mapClassifierToErrorClass,
    _CLI_QUOTA_PATTERNS: CLI_QUOTA_PATTERNS,
    _CLI_RATE_LIMIT_PATTERNS: CLI_RATE_LIMIT_PATTERNS,
    _CLI_AUTH_PATTERNS: CLI_AUTH_PATTERNS,
    _CLI_PERMANENT_PATTERNS: CLI_PERMANENT_PATTERNS,
    _CLI_TRANSIENT_PATTERNS: CLI_TRANSIENT_PATTERNS,
    _CLI_1M_CONTEXT_GLITCH_PATTERN: CLI_1M_CONTEXT_GLITCH_PATTERN,
};

// =============================================================================
// commander/provider-error-parser.js — Parser robusto de errores in-flight del
// Commander para fallback multi-provider (issue #3434).
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
//                 'auth' | 'permanent_failure' | 'unknown',
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
//   | errorClass         | shouldFallback | setFlag? |
//   | quota_exhausted    | true           | sí       |
//   | rate_limit         | true           | sí       |
//   | transient_5xx      | true           | NO       |
//   | auth               | true           | NO       |
//   | permanent_failure  | true           | NO       |  ← cubre context_length, model_not_found
//   | unknown            | false          | NO       |
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
// =============================================================================
'use strict';

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
]));

// Transports válidos.
const KNOWN_TRANSPORTS = Object.freeze(new Set(['api', 'cli']));

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
function splitBoundedLines(input) {
    if (!input) return [];
    const lines = input.split(/\r\n|\r|\n/);
    return lines.map(l => l.length > MAX_LINE_BYTES ? l.slice(0, MAX_LINE_BYTES) : l);
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
    const lines = splitBoundedLines(input);
    // Helper local: strip prefijo SSE `data: ` para que JSON.parse vea el JSON.
    // SR-9: cap por línea aplicado upstream en splitBoundedLines.
    const parseJsonOrSSE = (line) => {
        const direct = tryParseJson(line);
        if (direct) return direct;
        const sseMatch = /^data:\s*(\{[^]*\}|\[[^]*\])\s*$/.exec(line);
        if (sseMatch) return tryParseJson(sseMatch[1]);
        return null;
    };

    // 1. Shape estructural (Anthropic stream-json).
    const allowlist = (quotaModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider] || [];
    if (allowlist.length > 0 && typeof quotaModule._detectAnthropic === 'function') {
        for (const line of lines) {
            const parsed = parseJsonOrSSE(line);
            if (!parsed) continue;
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
    for (const line of lines) {
        // Cuota
        for (const re of CLI_QUOTA_PATTERNS) {
            if (re.test(line)) return { errorClass: 'quota_exhausted', evidence: line };
        }
    }
    for (const line of lines) {
        // Rate limit
        for (const re of CLI_RATE_LIMIT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'rate_limit', evidence: line };
        }
    }
    for (const line of lines) {
        // Auth
        for (const re of CLI_AUTH_PATTERNS) {
            if (re.test(line)) return { errorClass: 'auth', evidence: line };
        }
    }
    for (const line of lines) {
        // Permanente
        for (const re of CLI_PERMANENT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'permanent_failure', evidence: line };
        }
    }
    for (const line of lines) {
        // Transitorio (5xx)
        for (const re of CLI_TRANSIENT_PATTERNS) {
            if (re.test(line)) return { errorClass: 'transient_5xx', evidence: line };
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
        case 'unknown':
        default:
            return false;
    }
}

// retriable: si reintenta el MISMO provider podría resolverse en seg/min.
// quota_exhausted/auth/permanent_failure son NO retriable; rate_limit y
// transient_5xx sí (idealmente con backoff exponencial, fuera de scope acá).
function classifyRetriable(errorClass) {
    return errorClass === 'rate_limit' || errorClass === 'transient_5xx';
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

    // Constantes públicas (útiles para callers y tests).
    MAX_RAW_INPUT_BYTES,
    MAX_LINE_BYTES,
    TIMEOUT_THRESHOLD_MS,
    KNOWN_PROVIDERS,
    KNOWN_TRANSPORTS,

    // Internos expuestos para tests (prefijo _).
    _truncateInput: truncateInput,
    _splitBoundedLines: splitBoundedLines,
    _tryParseJson: tryParseJson,
    _detectFromCliStderr: detectFromCliStderr,
    _detectFromApiResponse: detectFromApiResponse,
    _classifyByContext: classifyByContext,
    _CLI_QUOTA_PATTERNS: CLI_QUOTA_PATTERNS,
    _CLI_RATE_LIMIT_PATTERNS: CLI_RATE_LIMIT_PATTERNS,
    _CLI_AUTH_PATTERNS: CLI_AUTH_PATTERNS,
    _CLI_PERMANENT_PATTERNS: CLI_PERMANENT_PATTERNS,
    _CLI_TRANSIENT_PATTERNS: CLI_TRANSIENT_PATTERNS,
};

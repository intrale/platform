// =============================================================================
// http-error-classifier.js — Clasificador HTTP universal cross-provider (#3486)
//
// Función pura que traduce un par `(statusCode, responseBody)` a una categoría
// operativa estructurada, sin tocar I/O, sin spawn, sin red. Es la fuente
// única de verdad para "¿este código HTTP del provider debería disparar
// fallback?".
//
// POR QUÉ EXISTE
// --------------
// La lógica de clasificación HTTP estaba duplicada en:
//   - lib/multi-provider/completion-client.js (líneas 296-333)
//   - lib/multi-provider/live-ping.js (cada `interpret()` por provider)
//   - lib/commander/provider-error-parser.js (path `transport: 'api'`)
//
// Cualquier cambio sutil en la matriz (ej. agregar 402 como billing) requería
// modificar tres archivos en sincronía. Este módulo consolida la matriz en un
// solo lugar — los tres consumidores delegan acá manteniendo su shape externo.
//
// COMO AGREGAR UN PROVIDER NUEVO
// ------------------------------
// NO se modifica este módulo. El clasificador trabaja **solo** sobre
// `statusCode` + heurística de `responseBody` (regex ReDoS-safe acotado).
// El parámetro `provider` es informativo (logging/hints) y NO altera la
// matriz HTTP base. Esa es la defensa SR-5 contra config envenenada
// (issue #3486 CA-10): un atacante que manipule el string `provider` no
// puede forzar que un 401 se reclasifique como 200.
//
// QUÉ NO ES ESTE MÓDULO
// ---------------------
// - NO reemplaza `quota_error_types` en `agent-models.json`: esa allowlist
//   cubre el canal CLI (claude-code/codex via stream-json o stderr), donde NO
//   hay HTTP status visible al wrapper. Este clasificador cubre el canal API.
// - NO reemplaza `getQuotaHint(provider)` en `provider-exhaustion-pause.js`:
//   ese helper humaniza el detalle del mensaje Telegram derivando de
//   `agent-models.json#quota_error_types` (#3498) — no es clasificación. El
//   consumer puede combinar la `category` de acá con el hint humano de allá.
//
// MATRIZ
// ------
//   2xx                    → { success, ok, isQuotaError: false }
//   401                    → { auth, invalid_credentials, isQuotaError: false }
//   403                    → { auth, forbidden, isQuotaError: false }
//   402                    → { billing, quota_exhausted, isQuotaError: true }
//   429 + body matches Q   → { billing, quota_exhausted, isQuotaError: true }
//   429 (sin match)        → { rate_limit, rate_limited, isQuotaError: true }
//   5xx                    → { transient, server_error, isQuotaError: false }
//   400 + body matches K   → { auth, invalid_credentials, isQuotaError: false }
//                            (caso Gemini: 400 con "API key not valid")
//   otros / null / NaN     → { unknown, unclassified, isQuotaError: false }
//
//   Q = regex ReDoS-safe que matchea marcadores de cuota agotada.
//   K = regex que matchea API key inválida en 400 (caso Gemini AI Studio).
//
// CONTRATO DEL OUTPUT
// -------------------
//   {
//     category: 'success' | 'billing' | 'rate_limit' | 'auth' | 'transient'
//               | 'unknown',
//     reason:   'ok' | 'quota_exhausted' | 'rate_limited'
//               | 'invalid_credentials' | 'forbidden' | 'server_error'
//               | 'unclassified',
//     isQuotaError: boolean,
//     httpStatus: number | null,
//     classifierVersion: '1.0',
//     // Opcional: snippet del body redactado (sólo si caller pasó body).
//     detail?: string,
//   }
//
// DEFENSAS DE SEGURIDAD (SR-1..SR-7 del análisis de seguridad)
// ------------------------------------------------------------
// SR-1 (CWE-1333 ReDoS): truncamos body a MAX_BODY_BYTES (16KB) ANTES de
//      cualquier regex. Patrones con alternation literal, sin `.*` libre,
//      sin nested quantifiers. Auditable por grep.
// SR-2 (CWE-117 + CWE-532): el `detail` opcional pasa por `redact.js` antes
//      de salir. Capeado a DETAIL_MAX_BYTES (512 bytes). Output NO incluye
//      raw body completo.
// SR-4 (CWE-285): 401/403 → siempre `isQuotaError: false`. No hay excepción
//      por provider. El parámetro provider solo se usa como hint informativo
//      para logging.
// SR-5 (CWE-20): inputs null/no-numéricos caen a `unknown` sin lanzar.
//      Provider desconocido cae al default HTTP puro.
// SR-7: cero npm nuevas. Solo `node:` stdlib (path/require interno).
//
// =============================================================================
'use strict';

// Carga perezosa de redact: si no está disponible (entorno mínimo / tests),
// degradamos a un slice puro. NO bloqueamos el clasificador por esto.
let _redactModule = null;
function getRedact() {
    if (_redactModule !== null) return _redactModule;
    try {
        _redactModule = require('./redact');
    } catch {
        _redactModule = false; // marca como "intentado, no disponible"
    }
    return _redactModule;
}

// SR-1: cap del body antes de aplicar regex. 16KB cubre cualquier error
// real (los errores estructurados de los providers caben en <2KB) y corta
// payloads patológicos antes de exponer regex a backtracking.
const MAX_BODY_BYTES = 16 * 1024;

// SR-2: cap del snippet de body que devolvemos como `detail`. 512 bytes da
// contexto humano sin exponer payloads completos. El snippet pasa por
// redactSensitive antes de salir del clasificador.
const DETAIL_MAX_BYTES = 512;

// Versión del clasificador — se incluye en cada audit entry para que el log
// sea trazable si la matriz evoluciona (#3486 CA-8).
const CLASSIFIER_VERSION = '1.0';

// SR-4 / SR-1: regex ReDoS-safe con alternation literal y \b word boundaries.
// Cubre los marcadores cross-provider:
//   - "quota" y derivados (insufficient_quota, monthly_limit, day_limit)
//   - Anthropic: usage_limit_error, weekly_quota
//   - OpenAI/Codex: insufficient_quota, billing_hard_limit
//   - Gemini: resource_exhausted, quota_exceeded
//   - Cerebras: quota / monthly_limit
// PROHIBIDO ampliar este regex con cuantificadores no-acotados o `.*` libre.
const QUOTA_BODY_PATTERN = /\b(?:quota|insufficient_quota|monthly_limit|day_limit|tokens_per_day|usage_limit|usage_limit_error|weekly_quota|weekly_quota_exhausted|billing_hard_limit_reached|resource_exhausted|quota_exceeded)\b/i;

// Caso Gemini: 400 con body que indica API key inválida (no es validación de
// schema del request — es auth). Mantenemos el match acotado al texto literal
// que Google AI Studio devuelve en `error.message`.
const GEMINI_API_KEY_INVALID_PATTERN = /\b(?:API\s+key\s+not\s+valid|API_KEY_INVALID)\b/i;

// -----------------------------------------------------------------------------
// truncateBody — SR-1 (anti-ReDoS / anti-DoS).
//
// Caller-agnostic: no asumimos que el caller ya truncó. Defense in depth.
// Aceptamos string, Buffer o null. Si el valor no es string/Buffer
// (objeto malformado), devolvemos cadena vacía para no exponer regex a
// shapes no-string.
// -----------------------------------------------------------------------------
function truncateBody(body) {
    if (body == null) return '';
    let str;
    if (typeof body === 'string') {
        str = body;
    } else if (Buffer.isBuffer(body)) {
        // toString('utf8') sobre Buffer también puede ser grande; truncamos
        // primero a bytes y luego decodificamos.
        str = body.length > MAX_BODY_BYTES
            ? body.slice(0, MAX_BODY_BYTES).toString('utf8')
            : body.toString('utf8');
    } else {
        // Object o número: no clasificamos sobre eso. El caller serializa si
        // quiere matchear.
        return '';
    }
    if (str.length > MAX_BODY_BYTES) {
        str = str.slice(0, MAX_BODY_BYTES);
    }
    return str;
}

// -----------------------------------------------------------------------------
// buildDetail — SR-2 (sin info-leak en el output).
//
// Devuelve un snippet del body, redactado y capeado. Si el body está vacío o
// el redact module no está disponible, devolvemos snippet sin redacción
// (mejor visibilidad que silencio total, pero igualmente capeado).
// -----------------------------------------------------------------------------
function buildDetail(truncatedBody) {
    if (!truncatedBody) return undefined;
    let snippet = truncatedBody.length > DETAIL_MAX_BYTES
        ? truncatedBody.slice(0, DETAIL_MAX_BYTES)
        : truncatedBody;
    const redact = getRedact();
    if (redact && typeof redact.redactSensitive === 'function') {
        try {
            snippet = String(redact.redactSensitive(snippet));
        } catch {
            // best-effort: si redact tira, devolvemos snippet plano capeado.
        }
    }
    // Re-cap por si redact agregó marker que infló el string (defensa de
    // contrato — el output del clasificador NUNCA excede DETAIL_MAX_BYTES).
    if (snippet.length > DETAIL_MAX_BYTES) {
        snippet = snippet.slice(0, DETAIL_MAX_BYTES);
    }
    return snippet;
}

// -----------------------------------------------------------------------------
// buildResult — helper para armar el shape uniforme. Garantiza que TODO
// retorno del clasificador tenga los mismos campos en el mismo orden, y que
// `classifierVersion` siempre esté presente.
// -----------------------------------------------------------------------------
function buildResult(category, reason, isQuotaError, httpStatus, detail) {
    const r = {
        category,
        reason,
        isQuotaError,
        httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
        classifierVersion: CLASSIFIER_VERSION,
    };
    if (typeof detail === 'string' && detail.length > 0) {
        r.detail = detail;
    }
    return r;
}

// -----------------------------------------------------------------------------
// classifyHttpError(statusCode, responseBody, provider)
//
// API pública. Pura, sin side-effects.
//
// Args:
//   - statusCode:   number | null | undefined | string. Cualquier valor que no
//                   sea entero finito en rango [100, 599] cae a `unknown`.
//   - responseBody: string | Buffer | null | undefined. Truncado a MAX_BODY_BYTES.
//                   Cualquier otro tipo se trata como sin body (no rompe).
//   - provider:     string | undefined. Informativo (logging). NO altera la
//                   matriz base (SR-5). Aceptado tal cual, sin allowlist —
//                   provider desconocido no rompe la clasificación.
//
// Returns: ver "CONTRATO DEL OUTPUT" en el header del módulo.
//
// NO LANZA EXCEPCIONES. Inputs adversariales (body de 100KB, statusCode
// "abc", provider null) caen al default `unknown` con isQuotaError: false.
// -----------------------------------------------------------------------------
function classifyHttpError(statusCode, responseBody, provider) {
    // SR-5 / CWE-20: validar statusCode antes de cualquier branch numérico.
    // Aceptamos number entero o string que parsea a entero (algunos drivers
    // HTTP devuelven `statusCode` como string). El rango HTTP válido es
    // [100, 599] (RFC 9110). Fuera de eso es ruido y va a unknown.
    let status;
    if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
        status = statusCode;
    } else if (typeof statusCode === 'string' && /^[1-5]\d{2}$/.test(statusCode)) {
        status = Number(statusCode);
    } else {
        // null, undefined, NaN, "abc", objeto, boolean → unknown.
        return buildResult('unknown', 'unclassified', false, null);
    }
    if (status < 100 || status > 599) {
        return buildResult('unknown', 'unclassified', false, null);
    }

    // SR-1: truncar body antes de tocar regex. Si el body no es string/Buffer
    // el truncator devuelve '' (no rompemos clasificación por shape no-string).
    const body = truncateBody(responseBody);
    const detail = buildDetail(body);

    // Provider es informativo. NO lo usamos como key de allowlist mutable
    // (SR-5: prohibido). Solo lo coercionamos a string si vino algo raro y lo
    // dejamos pasar al detail si conviene. La clasificación NO depende del
    // valor de provider.
    // (variable retenida para futura extensión de logging — eslint-no-unused-vars
    //  se silencia con uso explícito acá abajo)
    void provider;

    // 2xx: success.
    if (status >= 200 && status < 300) {
        return buildResult('success', 'ok', false, status);
    }

    // 401: auth/credentials inválidas.
    if (status === 401) {
        return buildResult('auth', 'invalid_credentials', false, status, detail);
    }

    // 403: auth/forbidden (key correcta pero sin permisos).
    if (status === 403) {
        return buildResult('auth', 'forbidden', false, status, detail);
    }

    // 402: Payment Required → cuota agotada (caso Anthropic OAuth Max sin
    // créditos, OpenAI insufficient_quota servido como 402).
    if (status === 402) {
        return buildResult('billing', 'quota_exhausted', true, status, detail);
    }

    // 429: rate limit O cuota agotada. Discriminamos por body.
    if (status === 429) {
        if (body && QUOTA_BODY_PATTERN.test(body)) {
            return buildResult('billing', 'quota_exhausted', true, status, detail);
        }
        return buildResult('rate_limit', 'rate_limited', true, status, detail);
    }

    // 400 con marcador Gemini API_KEY_INVALID → auth, no schema/validación.
    // Esto preserva la semántica especial de Google AI Studio (devuelve 400
    // cuando la key tiene formato inválido).
    if (status === 400 && body && GEMINI_API_KEY_INVALID_PATTERN.test(body)) {
        return buildResult('auth', 'invalid_credentials', false, status, detail);
    }

    // 5xx: transitorio. El pipeline reintenta sin marcar al provider como
    // exhausted (SR-4: no enmascarar 5xx como cuota).
    if (status >= 500 && status <= 599) {
        return buildResult('transient', 'server_error', false, status, detail);
    }

    // Cualquier otro 4xx no reconocido (404, 405, 422, etc.) → unknown.
    // No clasificamos como `transient` para evitar reintentos infinitos sobre
    // errores estructurales del request.
    return buildResult('unknown', 'unclassified', false, status, detail);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    classifyHttpError,
    // Constantes públicas para que callers/tests puedan introspectar sin
    // hardcodear.
    CLASSIFIER_VERSION,
    MAX_BODY_BYTES,
    DETAIL_MAX_BYTES,
    // Patrones exportados como read-only para inspección/tests (no
    // freezeamos porque RegExp es inmutable en uso normal).
    QUOTA_BODY_PATTERN,
    GEMINI_API_KEY_INVALID_PATTERN,
    // Helpers internos expuestos para tests con prefijo _.
    _truncateBody: truncateBody,
    _buildDetail: buildDetail,
};

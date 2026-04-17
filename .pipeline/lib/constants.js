// =============================================================================
// constants.js — Constantes auto-descriptivas para el cliente HTTP seguro
// Issue #2307 (CA-UX-5): nombres con unidades visibles para evitar ambigüedad
// =============================================================================
'use strict';

// --- Retry / backoff (CA-3) --------------------------------------------------
// Reintenta hasta N veces con delays exponenciales 2s -> 4s -> 8s + jitter ±20%.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 2000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_PERCENT = 0.2; // ±20% → base * (0.8 + random*0.4)

// Errores de red que califican para retry (CA-3). 4xx/5xx NO reintentan.
const RETRYABLE_ERROR_CODES = Object.freeze([
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNRESET',
]);

// Métodos HTTP idempotentes (CA-4). POST NO reintenta salvo flag explícito.
const IDEMPOTENT_METHODS = Object.freeze([
    'GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE',
]);

// --- Timeouts escalonados en ms (CA-5) ---------------------------------------
const TIMEOUT_TOTAL_DEFAULT_MS = 60000;
const TIMEOUT_DNS_MS = 3000;
const TIMEOUT_TCP_MS = 5000;
const TIMEOUT_TLS_MS = 5000;
const TIMEOUT_RESPONSE_HEADERS_MS = 10000;
const TIMEOUT_BODY_READ_MS = 30000;

// --- Response size cap (CA-19) -----------------------------------------------
const MAX_RESPONSE_BODY_BYTES_DEFAULT = 10 * 1024 * 1024; // 10 MB

// --- Redirects (CA-14) -------------------------------------------------------
const FOLLOW_REDIRECTS_DEFAULT = false;
const MAX_REDIRECTS_DEFAULT = 0; // si followRedirects=true, sugerimos 3
const MAX_REDIRECTS_WHEN_ENABLED = 3;

// --- TLS estricto (CA-7, CA-20) ----------------------------------------------
const TLS_MIN_VERSION = 'TLSv1.2';

// --- Redacción (CA-6, CA-17) -------------------------------------------------
const REDACTION_MARKER = '[REDACTED]';

// Headers sensibles (case-insensitive match). Incluye wildcard X-Amz-*.
const SENSITIVE_HEADER_NAMES = Object.freeze([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'proxy-authorization',
]);
const SENSITIVE_HEADER_PREFIXES = Object.freeze([
    'x-amz-',
]);

// Claves sensibles en JSON body.
const SENSITIVE_JSON_KEYS = Object.freeze([
    'password',
    'code2fa',
    'otp',
    'refresh_token',
    'id_token',
    'access_token',
    'secret',
    'apikey',
    'api_key',
    'token',
]);

// Claves sensibles en query string (CA-17).
const SENSITIVE_QUERY_KEYS = Object.freeze([
    'token',
    'access_token',
    'refresh_token',
    'api_key',
    'apikey',
    'password',
    'code',
    'otp',
    'secret',
    'sig',
    'signature',
]);

// --- User agent fijo (SEC-11 no bloqueante pero recomendado) -----------------
const DEFAULT_USER_AGENT = 'intrale-pipeline/1.0';

// --- Códigos de error internos (CA-UX-10) ------------------------------------
const ERROR_CODES = Object.freeze({
    SSRF_BLOCKED: 'ERR_SSRF_BLOCKED',
    PROXY_NOT_WHITELISTED: 'ERR_PROXY_NOT_WHITELISTED',
    RESPONSE_TOO_LARGE: 'ERR_RESPONSE_TOO_LARGE',
    CRLF_INJECTION: 'ERR_CRLF_INJECTION',
    USERINFO_BLOCKED: 'ERR_USERINFO_BLOCKED',
    REDIRECT_DISABLED: 'ERR_REDIRECT_DISABLED',
    REDIRECT_LIMIT: 'ERR_REDIRECT_LIMIT',
    TIMEOUT_TOTAL: 'ERR_TIMEOUT_TOTAL',
    TIMEOUT_DNS: 'ERR_TIMEOUT_DNS',
    TIMEOUT_TCP: 'ERR_TIMEOUT_TCP',
    TIMEOUT_TLS: 'ERR_TIMEOUT_TLS',
    TIMEOUT_HEADERS: 'ERR_TIMEOUT_HEADERS',
    TIMEOUT_BODY: 'ERR_TIMEOUT_BODY',
    TLS_INVALID: 'ERR_TLS_INVALID',
    RETRY_EXHAUSTED: 'ERR_RETRY_EXHAUSTED',
});

// Mensajes traducidos para errores de red (CA-UX-7, CA-UX-10).
const ERROR_MESSAGES_ES = Object.freeze({
    ECONNREFUSED: 'conexión rechazada por el host (ECONNREFUSED)',
    ETIMEDOUT: 'timeout de conexión (ETIMEDOUT)',
    ENOTFOUND: 'no se pudo resolver el hostname (ENOTFOUND)',
    ECONNRESET: 'la conexión fue cerrada por el host remoto (ECONNRESET)',
    EHOSTUNREACH: 'host inalcanzable (EHOSTUNREACH)',
    ENETUNREACH: 'red inalcanzable (ENETUNREACH)',
    CERT_HAS_EXPIRED: 'certificado TLS vencido',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado TLS self-signed rechazado',
    SELF_SIGNED_CERT_IN_CHAIN: 'certificado TLS self-signed en la cadena',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'no se pudo verificar la firma del certificado',
    ERR_TLS_CERT_ALTNAME_INVALID: 'hostname del certificado no coincide',
});

module.exports = {
    RETRY_MAX_ATTEMPTS,
    RETRY_BASE_BACKOFF_MS,
    RETRY_BACKOFF_FACTOR,
    RETRY_JITTER_PERCENT,
    RETRYABLE_ERROR_CODES,
    IDEMPOTENT_METHODS,
    TIMEOUT_TOTAL_DEFAULT_MS,
    TIMEOUT_DNS_MS,
    TIMEOUT_TCP_MS,
    TIMEOUT_TLS_MS,
    TIMEOUT_RESPONSE_HEADERS_MS,
    TIMEOUT_BODY_READ_MS,
    MAX_RESPONSE_BODY_BYTES_DEFAULT,
    FOLLOW_REDIRECTS_DEFAULT,
    MAX_REDIRECTS_DEFAULT,
    MAX_REDIRECTS_WHEN_ENABLED,
    TLS_MIN_VERSION,
    REDACTION_MARKER,
    SENSITIVE_HEADER_NAMES,
    SENSITIVE_HEADER_PREFIXES,
    SENSITIVE_JSON_KEYS,
    SENSITIVE_QUERY_KEYS,
    DEFAULT_USER_AGENT,
    ERROR_CODES,
    ERROR_MESSAGES_ES,
};

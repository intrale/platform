// =============================================================================
// redact.js — Helper único del pipeline para enmascarar datos sensibles
// Issue #2307 · CA-6 / CA-17 / CA-18
//
// Cubre:
//  - Headers sensibles (Authorization, Cookie, Set-Cookie, X-Api-Key,
//    X-Amz-*, Proxy-Authorization)
//  - Claves JSON sensibles (password, code2FA, otp, refresh_token, id_token,
//    access_token, secret, apiKey, token)
//  - Emails → us***@dom***.com
//  - Query strings con keys sensibles (CA-17)
//  - error.message / error.stack / rutas absolutas (CA-18)
//  - URLs con userinfo (strip antes de loguear)
//
// Marker visible: "Authorization: [REDACTED]" (CA-6).
// =============================================================================
'use strict';

const {
    REDACTION_MARKER,
    SENSITIVE_HEADER_NAMES,
    SENSITIVE_HEADER_PREFIXES,
    SENSITIVE_JSON_KEYS,
    SENSITIVE_QUERY_KEYS,
} = require('./constants');

// Normalización de claves para match case-insensitive.
function normalizeKey(k) {
    return String(k || '').toLowerCase().replace(/[_-]/g, '');
}

const NORMALIZED_JSON_KEYS = new Set(SENSITIVE_JSON_KEYS.map(normalizeKey));
const NORMALIZED_QUERY_KEYS = new Set(SENSITIVE_QUERY_KEYS.map(normalizeKey));

/**
 * ¿El nombre de header coincide con la lista sensible (CA-6)?
 * @param {string} name
 * @returns {boolean}
 */
function isSensitiveHeader(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.includes(lower)) return true;
    return SENSITIVE_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Redacta un objeto de headers (estilo node:http: claves en lowercase,
 * valores string o array). Devuelve copia, no muta.
 * @param {object} headers
 * @returns {object}
 */
function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (isSensitiveHeader(k)) {
            out[k] = Array.isArray(v) ? v.map(() => REDACTION_MARKER) : REDACTION_MARKER;
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Enmascara un email: "leito.larreta@gmail.com" → "le***@gm***.com"
 * Preserva TLD para que el log siga siendo contextual.
 * @param {string} email
 * @returns {string}
 */
function redactEmail(email) {
    if (typeof email !== 'string') return email;
    const m = email.match(/^([^@\s]+)@([^@\s]+)$/);
    if (!m) return email;
    const [, user, domain] = m;
    const userMasked = (user.length <= 2 ? user[0] || '' : user.slice(0, 2)) + '***';
    const dotIdx = domain.lastIndexOf('.');
    if (dotIdx < 0) {
        return `${userMasked}@${(domain.slice(0, 2) || domain)}***`;
    }
    const host = domain.slice(0, dotIdx);
    const tld = domain.slice(dotIdx); // incluye el punto
    const hostMasked = (host.length <= 2 ? host[0] || '' : host.slice(0, 2)) + '***';
    return `${userMasked}@${hostMasked}${tld}`;
}

// Regex conservadora (evita matchear cosas como "a@b").
const EMAIL_REGEX = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]{2,}\.[A-Za-z]{2,}/g;

/**
 * Enmascara todos los emails que aparezcan en un texto libre.
 * @param {string} text
 * @returns {string}
 */
function redactEmailsInText(text) {
    if (typeof text !== 'string') return text;
    return text.replace(EMAIL_REGEX, (m) => redactEmail(m));
}

/**
 * Enmascara query strings sensibles dentro de una URL como texto plano
 * (CA-17). Mantiene el resto de los params intactos. También strippea
 * userinfo (user:pass@host) antes de loguear (CA-18 / SEC-3) y redacta
 * secretos embebidos en el path (ej: `/bot<TOKEN>/sendMessage` del
 * API de Telegram — CA-11.1 / #2332).
 *
 * No usa `URL` para evitar excepciones con strings inválidos (URLs en
 * error.message pueden estar truncadas).
 *
 * @param {string} urlText
 * @returns {string}
 */
function redactUrlLike(urlText) {
    if (typeof urlText !== 'string') return urlText;
    let out = urlText;

    // 1) Strippear userinfo: "scheme://user:pass@host" → "scheme://[REDACTED]@host"
    out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, (_m, scheme) => {
        return `${scheme}${REDACTION_MARKER}@`;
    });

    // 2) Redactar query params sensibles, preservando el separador.
    out = out.replace(/([?&#])([^=&\s#]+)=([^&\s#]*)/g, (m, sep, key, _val) => {
        if (NORMALIZED_QUERY_KEYS.has(normalizeKey(key))) {
            return `${sep}${key}=${REDACTION_MARKER}`;
        }
        return m;
    });

    // 3) Redactar secretos embebidos como path segments (CA-11.1 / #2332).
    //    El API de Telegram usa /bot<TOKEN>/metodo — si este path se loggea
    //    dentro de un DENIAL (SSRF guard rechazando por DNS rebind o proxy
    //    mal configurado) el BOT_TOKEN se filtra a stderr. Redactamos todo
    //    segmento que empieza con `/bot` seguido de 20+ chars opacos.
    out = out.replace(/\/bot[^\/?#\s]{20,}/gi, `/bot${REDACTION_MARKER}`);

    return out;
}

/**
 * Walk recursivo que redacta:
 *  - Claves sensibles de JSON (CA-6)
 *  - Emails en strings (CA-6)
 *  - Query strings sensibles en strings que parecen URL (CA-17)
 *
 * Detecta ciclos vía WeakSet para evitar stack overflow con estructuras
 * auto-referenciadas.
 *
 * @param {any} value
 * @param {WeakSet} [seen]
 * @returns {any}
 */
function redactValue(value, seen) {
    if (value == null) return value;
    if (typeof value === 'string') {
        let out = value;
        // Si parece URL, redactar query + userinfo primero.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(out) || /\?[^=]+=/.test(out)) {
            out = redactUrlLike(out);
        }
        out = redactEmailsInText(out);
        return out;
    }
    if (typeof value !== 'object') return value;

    seen = seen || new WeakSet();
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((v) => redactValue(v, seen));
    }

    // Buffer, Date, etc. no los tocamos.
    if (Buffer.isBuffer(value) || value instanceof Date) return value;

    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (NORMALIZED_JSON_KEYS.has(normalizeKey(k))) {
            out[k] = REDACTION_MARKER;
        } else if (k.toLowerCase() === 'headers' && v && typeof v === 'object') {
            out[k] = redactHeaders(v);
        } else {
            out[k] = redactValue(v, seen);
        }
    }
    return out;
}

/**
 * Trunca paths absolutos en stack traces (CA-6 / CA-18).
 * Reemplaza "C:\Workspaces\Intrale\platform\foo\bar.js" → "…/bar.js"
 * y rutas POSIX "/home/user/project/foo/bar.js" → "…/bar.js"
 * @param {string} stack
 * @returns {string}
 */
function redactStack(stack) {
    if (typeof stack !== 'string') return stack;
    let out = stack;
    // Windows absolute paths ej: C:\...\file.ext
    out = out.replace(/[A-Za-z]:[\\/](?:[^\s()[\]:]*[\\/])+([^\s()[\]:]+)/g, '…/$1');
    // POSIX absolute paths ej: /foo/bar/file.ext
    out = out.replace(/(?:^|\s|\()(\/(?:[^\s()[\]:/]+\/)+)([^\s()[\]:/]+)/g, (_m, _dirs, file) => `…/${file}`);
    // Emails + URLs que puedan aparecer en el stack.
    out = redactEmailsInText(out);
    out = redactUrlLike(out);
    return out;
}

/**
 * Redacta un Error completo: message, stack y campos anexos típicos de
 * libs HTTP (config.url, request.host, etc.) — CA-18.
 *
 * Devuelve un objeto plano listo para loguear, NO el Error original.
 *
 * @param {Error|any} err
 * @returns {object}
 */
function redactError(err) {
    if (!err || typeof err !== 'object') return err;
    const plain = {
        name: err.name,
        code: err.code,
        message: typeof err.message === 'string'
            ? redactUrlLike(redactEmailsInText(err.message))
            : err.message,
    };
    if (err.stack) plain.stack = redactStack(err.stack);
    // Libs estilo axios/node-fetch exponen estos campos.
    for (const fld of ['config', 'request', 'response', 'cause']) {
        if (err[fld] != null) plain[fld] = redactValue(err[fld]);
    }
    return plain;
}

/**
 * Punto de entrada polimórfico: recibe header-obj, JSON-obj, string, Error,
 * y devuelve versión redactada.
 *
 * @param {any} input
 * @param {object} [opts]
 * @param {boolean} [opts.isHeaders=false] - tratarlo como headers puros
 * @returns {any}
 */
function redactSensitive(input, opts) {
    const options = opts || {};
    if (input instanceof Error || (input && typeof input === 'object' && typeof input.stack === 'string' && typeof input.message === 'string')) {
        return redactError(input);
    }
    if (options.isHeaders) return redactHeaders(input);
    if (typeof input === 'string') {
        return redactEmailsInText(redactUrlLike(input));
    }
    return redactValue(input);
}

// =============================================================================
// #3724 — Patrones de VALOR de secretos (no de clave) + heurística de entropía.
//
// `SENSITIVE_JSON_KEYS` (arriba) redacta por NOMBRE de clave. El audit log de
// los wizards (#3715) puede recibir params con secretos embebidos en valores
// bajo claves NO sensibles (ej. un texto libre que contiene una API key). Para
// cerrar A09 del análisis de `/security` agregamos un escaneo por VALOR:
//   - Tabla de regex específicas por proveedor (Object.freeze, exportada para
//     reuso de tests — NO se mezcla con SENSITIVE_JSON_KEYS).
//   - Heurística Shannon ≥ 4.5 sobre tokens >40 chars sin espacios → cubre
//     secretos opacos sin formato conocido.
//
// Cero-regresión sobre #2307: estas funciones son NUEVAS, no tocan
// `redactValue`/`redactSensitive`. El walk vive en `redactObject`, que es el
// único punto de entrada que aplica el escaneo por valor.
// =============================================================================

const HIGH_ENTROPY_MARKER = '[REDACTED:high-entropy]';
const HIGH_ENTROPY_MIN_LEN = 40;
const HIGH_ENTROPY_THRESHOLD = 4.5;

// Cada patrón matchea el VALOR de un secreto conocido. El orden importa:
// `sk-ant-` antes que el genérico `sk-` (aunque no se solapan porque el
// genérico exige 20+ alfanuméricos pegados y `sk-ant-` corta con guiones).
const SECRET_VALUE_PATTERNS = Object.freeze([
    { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]+/g },
    { name: 'openai', re: /sk-[A-Za-z0-9]{20,}/g },
    { name: 'groq', re: /gsk_[A-Za-z0-9]+/g },
    { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
    { name: 'jwt', re: /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
]);

/**
 * Entropía de Shannon (bits por carácter) de un string.
 * @param {string} str
 * @returns {number}
 */
function shannonEntropy(str) {
    if (typeof str !== 'string' || str.length === 0) return 0;
    const freq = new Map();
    for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
    let entropy = 0;
    const len = str.length;
    for (const count of freq.values()) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

/**
 * Redacta secretos embebidos en un string-valor:
 *   1. Aplica cada patrón de SECRET_VALUE_PATTERNS.
 *   2. Si NINGÚN patrón matcheó y el string es un token opaco (>40 chars, sin
 *      espacios) con entropía ≥ 4.5 → `[REDACTED:high-entropy]`.
 *
 * No toca emails/URLs (eso lo hace el walk con las funciones existentes).
 * @param {string} str
 * @returns {string}
 */
function redactSecretValue(str) {
    if (typeof str !== 'string' || str.length === 0) return str;
    let out = str;
    for (const { re } of SECRET_VALUE_PATTERNS) {
        out = out.replace(re, REDACTION_MARKER);
    }
    if (out === str) {
        const trimmed = str.trim();
        if (
            trimmed.length > HIGH_ENTROPY_MIN_LEN &&
            !/\s/.test(trimmed) &&
            shannonEntropy(trimmed) >= HIGH_ENTROPY_THRESHOLD
        ) {
            return HIGH_ENTROPY_MARKER;
        }
    }
    return out;
}

/**
 * Walk recursivo para AUDIT LOG (#3724). Combina:
 *   - Redacción por clave sensible (igual que `redactValue`).
 *   - Redacción de headers.
 *   - Escaneo por VALOR (`redactSecretValue`) + emails/URLs sobre cada string.
 *
 * Detecta ciclos con WeakSet. Devuelve copia, no muta.
 * @param {any} value
 * @param {WeakSet} [seen]
 * @returns {any}
 */
function redactObject(value, seen) {
    if (value == null) return value;
    if (typeof value === 'string') {
        let out = value;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(out) || /\?[^=]+=/.test(out)) {
            out = redactUrlLike(out);
        }
        out = redactEmailsInText(out);
        out = redactSecretValue(out);
        return out;
    }
    if (typeof value !== 'object') return value;

    seen = seen || new WeakSet();
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((v) => redactObject(v, seen));
    }
    if (Buffer.isBuffer(value) || value instanceof Date) return value;

    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (NORMALIZED_JSON_KEYS.has(normalizeKey(k))) {
            out[k] = REDACTION_MARKER;
        } else if (k.toLowerCase() === 'headers' && v && typeof v === 'object') {
            out[k] = redactHeaders(v);
        } else {
            out[k] = redactObject(v, seen);
        }
    }
    return out;
}

module.exports = {
    redactSensitive,
    redactHeaders,
    redactValue,
    redactEmail,
    redactEmailsInText,
    redactUrlLike,
    redactStack,
    redactError,
    isSensitiveHeader,
    REDACTION_MARKER,
    // #3724 — escaneo por valor para audit log de wizards.
    redactObject,
    redactSecretValue,
    shannonEntropy,
    SECRET_VALUE_PATTERNS,
    HIGH_ENTROPY_MARKER,
    HIGH_ENTROPY_THRESHOLD,
};

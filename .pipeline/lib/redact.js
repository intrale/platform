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
};

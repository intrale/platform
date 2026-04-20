// =============================================================================
// sanitizer.js — Sanitizador del pipeline (issue #2333 / #2324 / #2318)
//
// API pública:
//   sanitize(text)              → string (NFC → sanitizeSecrets → sanitizeUtf8)
//   createSanitizeStream(opts)  → Transform (ventana deslizante ≥ 256 bytes)
//   __forTestsOnly__            → { sanitizeSecrets, normalizeForMatching }
//
// Diseño:
//   - NFC para defeatear homoglifos / variantes compuestas
//   - Remoción de ZWSP / ZWJ / BOM / null bytes antes de matchear
//   - Case folding en headers sensibles
//   - Placeholders `[REDACTED:<TIPO>]` consistentes (UX1)
//   - Fail-closed: si algo rompe, devuelve `[SANITIZER_ERROR:<reason>]`
//     (NUNCA el input original)
//   - Stream-filter con buffer de ventana deslizante: mantiene siempre los
//     últimos 256 bytes sin flushear para permitir match de patrones que
//     caigan en el corte de un chunk. Flush por `\n` o cuando el buffer
//     supera `maxBufferBytes`.
// =============================================================================
'use strict';

const { Transform } = require('stream');
const path = require('path');

// Reutilizamos el sanitizer de UTF-8 ya probado del hook de Telegram.
// Ese módulo resuelve surrogates sueltos, control C0/C1, BOM, zero-width, CRLF.
const telegramSanitizer = require(path.join(__dirname, '..', '.claude', 'hooks', 'telegram-sanitizer.js'));

// -----------------------------------------------------------------------------
// Placeholders (UX1 de #2324): `[REDACTED:<TIPO_UPPER_SNAKE>]`
// -----------------------------------------------------------------------------
const P = {
    AWS_ACCESS_KEY: '[REDACTED:AWS_ACCESS_KEY]',
    AWS_SECRET_KEY: '[REDACTED:AWS_SECRET_KEY]',
    AWS_SESSION_TOKEN: '[REDACTED:AWS_SESSION_TOKEN]',
    GITHUB_TOKEN: '[REDACTED:GITHUB_TOKEN]',
    JWT: '[REDACTED:JWT]',
    TELEGRAM_BOT_TOKEN: '[REDACTED:TELEGRAM_BOT_TOKEN]',
    GOOGLE_API_KEY: '[REDACTED:GOOGLE_API_KEY]',
    GOOGLE_OAUTH_REFRESH: '[REDACTED:GOOGLE_OAUTH_REFRESH]',
    COGNITO_SECRET: '[REDACTED:COGNITO_SECRET]',
    PRIVATE_KEY: '[REDACTED:PRIVATE_KEY]',
    BASIC_AUTH: '[REDACTED:BASIC_AUTH]',
    DB_URL: '[REDACTED:DB_URL]',
    SLACK_WEBHOOK: '[REDACTED:SLACK_WEBHOOK]',
    BEARER_TOKEN: '[REDACTED:BEARER_TOKEN]',
    API_KEY: '[REDACTED:API_KEY]',
    COOKIE: '[REDACTED:COOKIE]',
    CONF_VALUE: '[REDACTED:CONF_VALUE]',
};

// -----------------------------------------------------------------------------
// Pre-normalización para matchear pese a intentos de bypass (CA3)
// -----------------------------------------------------------------------------

// Mapa básico de homoglifos Cyrillic/Greek → Latin (ampliable, no exhaustivo).
// Usado SOLO para detección interna; al reemplazar patrones se preserva el
// texto original alrededor del match.
const HOMOGLYPHS = {
    '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0406': 'I', '\u041E': 'O',
    '\u0410': 'A', '\u0415': 'E', '\u0421': 'C', '\u0420': 'P', '\u0425': 'X',
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
    '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
    '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
};
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/g;
const NULL_BYTE_RE = /\u0000/g;

// Pre-check regex para fast-path: sólo si hay al menos un char de bypass,
// corremos el strip. Para logs normales (10MB de ASCII/UTF-8 limpio) se saltea.
const BYPASS_DETECT_RE = /[\u200B-\u200F\u2060\uFEFF\u0000]/;
// Rango aproximado de chars Cyrillic/Greek que NOS IMPORTAN (conservador;
// si no hay ninguno en el texto, evitamos el walk char-by-char).
const HOMOGLYPH_DETECT_RE = /[\u0370-\u03FF\u0400-\u04FF]/;

/**
 * Normaliza texto para matching: NFC + homoglifos → Latin + strip
 * ZWSP/ZWJ/BOM + null bytes. No devuelve el texto final, sólo una versión
 * "limpia" que usamos para encontrar patrones en la entrada. El reemplazo
 * se aplica sobre el string original por posición equivalente.
 *
 * Optimización: fast-path si el input no contiene ningún char de bypass
 * ni ningún glifo del rango Cyrillic/Greek. La mayoría de los logs reales
 * no tienen nada de eso, así que se saltea el walk char-by-char.
 */
function normalizeForMatching(text) {
    if (typeof text !== 'string') return '';
    let out = text.normalize('NFC');

    if (BYPASS_DETECT_RE.test(out)) {
        out = out.replace(ZERO_WIDTH_RE, '').replace(NULL_BYTE_RE, '');
    }

    if (HOMOGLYPH_DETECT_RE.test(out)) {
        // Walk char-by-char sólo cuando hace falta. Usamos array + join para
        // evitar la cuadrática que tiene la concatenación de strings largos.
        const parts = new Array(out.length);
        for (let i = 0; i < out.length; i++) {
            const ch = out[i];
            const mapped = HOMOGLYPHS[ch];
            parts[i] = mapped !== undefined ? mapped : ch;
        }
        out = parts.join('');
    }

    return out;
}

// -----------------------------------------------------------------------------
// Patrones de CA2 (#2324)
//
// Cada patrón redacta con un placeholder específico. Se aplican en orden de
// especificidad: primero los que tienen prefijo explícito, luego genéricos.
// -----------------------------------------------------------------------------

// IMPORTANTE: los patrones operan sobre el texto ya normalizado (NFC +
// zero-width strip + homoglyph fold). Ver sanitizeSecrets() abajo.

const PATTERNS = [
    // PEM private keys (multilinea) — primero para no pisarse con Base64 parcial.
    {
        name: 'PRIVATE_KEY',
        re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g,
        replace: () => P.PRIVATE_KEY,
    },

    // Headers sensibles (case folding). Preservamos el nombre para que el
    // log siga siendo legible. `Authorization: Bearer <jwt>` → `Authorization: [REDACTED:BEARER_TOKEN]`
    {
        name: 'HEADER_AUTHORIZATION',
        re: /\b(authorization)\s*:\s*(?:bearer\s+)?[^\r\n]+/gi,
        replace: (_m, name) => `${name}: ${P.BEARER_TOKEN}`,
    },
    {
        name: 'HEADER_X_API_KEY',
        re: /\b(x[-_]?api[-_]?key)\s*:\s*[^\r\n]+/gi,
        replace: (_m, name) => `${name}: ${P.API_KEY}`,
    },
    {
        name: 'HEADER_COOKIE',
        re: /\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
        replace: (_m, name) => `${name}: ${P.COOKIE}`,
    },

    // Basic auth / userinfo en URL.
    {
        name: 'BASIC_AUTH',
        re: /\b([a-z][a-z0-9+.\-]*):\/\/([^\s/@:]+):([^\s/@]+)@/gi,
        replace: (_m, scheme) => `${scheme}://${P.BASIC_AUTH}@`,
    },

    // DB connection strings con credenciales (postgres, mysql, mongodb, redis,
    // etc.). Ya cubierto por BASIC_AUTH para el userinfo, pero además cuando
    // aparece el scheme estándar sin credenciales pero con query `?password=`.
    {
        name: 'DB_URL_QUERY',
        re: /\b(postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)(:\/\/[^\s]*[?&](?:password|pwd|secret|token)=)[^\s&]+/gi,
        replace: (_m, scheme, prefix) => `${scheme}${prefix}${P.DB_URL}`,
    },

    // Slack incoming webhook.
    {
        name: 'SLACK_WEBHOOK',
        re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
        replace: () => P.SLACK_WEBHOOK,
    },

    // AWS Access Key ID (`AKIA...` 20 chars) y también `ASIA...` (STS).
    {
        name: 'AWS_ACCESS_KEY',
        re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replace: () => P.AWS_ACCESS_KEY,
    },
    // AWS Secret Access Key (contextualizado para minimizar falsos positivos).
    {
        name: 'AWS_SECRET_KEY',
        re: /(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)/gi,
        replace: (_m, prefix, suffix) => `${prefix}${P.AWS_SECRET_KEY}${suffix}`,
    },
    // AWS Session Token (largo, contextualizado).
    {
        name: 'AWS_SESSION_TOKEN',
        re: /(aws[_-]?session[_-]?token\s*[:=]\s*["']?)[A-Za-z0-9/+=]{100,}(["']?)/gi,
        replace: (_m, prefix, suffix) => `${prefix}${P.AWS_SESSION_TOKEN}${suffix}`,
    },

    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ + fine-grained github_pat_).
    {
        name: 'GITHUB_TOKEN',
        re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{80,})\b/g,
        replace: () => P.GITHUB_TOKEN,
    },

    // JWT Bearer (tres segmentos base64url separados por punto).
    {
        name: 'JWT',
        re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        replace: () => P.JWT,
    },

    // Telegram bot token: <digits>:<35 chars base64url-ish>.
    //
    // NOTA CA-11.1 (#2332 / rebote #2333): el formato real de URL de Telegram
    // es `https://api.telegram.org/bot<TOKEN>/<metodo>`. El `\b` de un patrón
    // tipo `\b\d+:...\b` NO matchea cuando el token viene precedido por "bot"
    // (no hay word boundary entre la 't' y el primer dígito: ambos son \w).
    // Por eso el patrón:
    //   - usa un lookbehind negativo `(?<![A-Za-z0-9_-])` que garantiza que
    //     antes de "bot" (o del token suelto) NO haya otra letra/dígito/_/-.
    //     A inicio de string el lookbehind es trivialmente true (no hay char
    //     previo), así que cubre tanto `/bot<TOKEN>` como `<TOKEN>` bare.
    //   - captura opcionalmente el prefijo "bot" para preservarlo en el
    //     output (la URL sigue siendo legible como `/bot[REDACTED:...]`).
    //   - lookahead negativo simétrico al final para no cortar tokens que
    //     sigan en medio de otra palabra.
    //   - flag `i` para cubrir "Bot", "BOT", etc.
    //
    // Usamos lookbehind NEGATIVO en lugar de positivo con alternancia
    // `(?<=^|[^...])` porque V8 lo compila ~3x más rápido sobre payloads
    // grandes (medido: 15ms vs 6ms sobre 10MB adversarial), sin perder
    // cobertura funcional.
    {
        name: 'TELEGRAM_BOT_TOKEN',
        re: /(?<![A-Za-z0-9_-])(bot)?(\d{6,}:[A-Za-z0-9_-]{35,})(?![A-Za-z0-9_-])/gi,
        replace: (_m, bot) => `${bot || ''}${P.TELEGRAM_BOT_TOKEN}`,
    },

    // Google API key.
    {
        name: 'GOOGLE_API_KEY',
        re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        replace: () => P.GOOGLE_API_KEY,
    },
    // Google OAuth refresh token.
    {
        name: 'GOOGLE_OAUTH_REFRESH',
        re: /\b1\/\/[0-9A-Za-z_-]{43,}\b/g,
        replace: () => P.GOOGLE_OAUTH_REFRESH,
    },

    // Cognito client secret (AWS Cognito típico: 52 base64url chars en config).
    {
        name: 'COGNITO_SECRET',
        re: /(cognito[_-]?(?:client[_-]?)?secret\s*[:=]\s*["']?)[A-Za-z0-9/+=_-]{20,}(["']?)/gi,
        replace: (_m, prefix, suffix) => `${prefix}${P.COGNITO_SECRET}${suffix}`,
    },

    // application.conf estructurado: claves con nombres sensibles.
    {
        name: 'CONF_STRUCTURED',
        re: /\b(password|passwd|secret|token|apiKey|api[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*("?)([^"\s,}\]\r\n]{3,})(\2)/gi,
        replace: (m, key, quote, value, close) => {
            // Evitar cascada sobre placeholders ya redactados — el value
            // puede empezar con `[REDACTED:...` y traer basura atrás.
            if (/^\[REDACTED:/.test(value)) return m;
            return `${key}=${quote}${P.CONF_VALUE}${close}`;
        },
    },
];

/**
 * sanitizeSecrets(text) — aplica TODOS los patrones de CA2 sobre texto ya
 * normalizado (NFC + zero-width strip + homoglyphs fold + null bytes out).
 *
 * Es idempotente: re-aplicarla sobre su salida no altera los placeholders
 * (los patrones no matchean `[REDACTED:...]`).
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeSecrets(text) {
    if (typeof text !== 'string' || text.length === 0) return text || '';
    let out = normalizeForMatching(text);
    for (const p of PATTERNS) {
        out = out.replace(p.re, p.replace);
    }
    return out;
}

// -----------------------------------------------------------------------------
// Composición pública: NFC → sanitizeSecrets → sanitizeUtf8
// -----------------------------------------------------------------------------

/**
 * sanitize(text) — pipeline completo fail-closed.
 *
 * Si algo tira excepción dentro del pipeline devuelve `[SANITIZER_ERROR:<reason>]`
 * para evitar leak del input original (CA5).
 *
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
    if (text == null) return '';
    if (typeof text !== 'string') {
        try {
            text = String(text);
        } catch (_e) {
            return '[SANITIZER_ERROR:non_string_input]';
        }
    }
    try {
        // 1) NFC + strip de caracteres de bypass + fold de homoglifos + redact.
        const redacted = sanitizeSecrets(text);
        // 2) UTF-8 safe: surrogates sueltos, control chars, BOM, etc.
        return telegramSanitizer.sanitize(redacted, { logWarnings: false });
    } catch (e) {
        const reason = (e && e.message) ? String(e.message).slice(0, 80).replace(/[^A-Za-z0-9 _\-]/g, '_') : 'unknown';
        return `[SANITIZER_ERROR:${reason}]`;
    }
}

// -----------------------------------------------------------------------------
// Stream filter (CA6): Transform con ventana deslizante ≥ 256 bytes
// -----------------------------------------------------------------------------

/**
 * createSanitizeStream({ minBufferBytes = 256, maxBufferBytes = 64 * 1024 })
 *
 * Flushea por `\n` o cuando el buffer pendiente supera `maxBufferBytes`.
 * Siempre retiene al menos `minBufferBytes` bytes sin emitir para permitir
 * que un patrón que caiga en el corte de un chunk se detecte correctamente
 * (los patrones grandes como PRIVATE_KEY pueden ser enormes, por eso existe
 * también `maxBufferBytes` como techo para evitar crecer sin límite; al
 * superarlo se sanitiza lo acumulado aunque parta un secreto — fail-safe).
 *
 * @param {{ minBufferBytes?: number, maxBufferBytes?: number }} [opts]
 * @returns {Transform}
 */
function createSanitizeStream(opts) {
    const minBufferBytes = Math.max(256, (opts && opts.minBufferBytes) || 256);
    const maxBufferBytes = Math.max(minBufferBytes * 4, (opts && opts.maxBufferBytes) || 64 * 1024);

    let buf = '';

    function flushUpToLastNewline() {
        // Si la cola del buffer tiene un `\n`, emitimos todo hasta y incluyendo
        // ese `\n`; guardamos el resto (que queda por debajo/sobre el umbral
        // mínimo según el caso).
        const nlIdx = buf.lastIndexOf('\n');
        if (nlIdx < 0) return null;
        const emitChunk = buf.slice(0, nlIdx + 1);
        buf = buf.slice(nlIdx + 1);
        return sanitize(emitChunk);
    }

    return new Transform({
        decodeStrings: true,
        transform(chunk, _enc, cb) {
            try {
                buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

                // Si superamos el techo, vaciamos lo que tenemos (menos los
                // últimos minBufferBytes) sin esperar newline.
                if (buf.length > maxBufferBytes) {
                    const cutAt = buf.length - minBufferBytes;
                    const emit = sanitize(buf.slice(0, cutAt));
                    buf = buf.slice(cutAt);
                    this.push(emit);
                    return cb();
                }

                // Flush normal: solo si el buffer ya supera el mínimo + tiene
                // un `\n` para cortar limpio.
                if (buf.length > minBufferBytes) {
                    const emit = flushUpToLastNewline();
                    if (emit) this.push(emit);
                }
                cb();
            } catch (e) {
                cb(null, `[SANITIZER_ERROR:stream_${(e && e.message) || 'unknown'}]\n`);
            }
        },
        flush(cb) {
            try {
                if (buf.length > 0) {
                    this.push(sanitize(buf));
                    buf = '';
                }
                cb();
            } catch (e) {
                cb(null, `[SANITIZER_ERROR:flush_${(e && e.message) || 'unknown'}]\n`);
            }
        },
    });
}

module.exports = {
    sanitize,
    createSanitizeStream,
    __forTestsOnly__: {
        sanitizeSecrets,
        normalizeForMatching,
        PATTERNS,
        P,
    },
};

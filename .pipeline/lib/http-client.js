// =============================================================================
// http-client.js — Cliente HTTP(S) seguro del pipeline Intrale
// Issue #2307 · cubre CA-3 / CA-4 / CA-5 / CA-6 / CA-7 / CA-14 / CA-16 /
//              CA-17 / CA-18 / CA-19 / CA-20 + guidelines UX
//
// API pública (CA-UX-8):
//   - request(url, options) → Promise<{ statusCode, headers, body }>
//   - get(url, opts), post(url, body, opts), postJson(url, obj, opts)
//
// Seguridad:
//   - SSRF guard (CA-9/CA-13): resuelve DNS manualmente, valida IPs,
//     inyecta lookup custom y setea servername para preservar SNI (CA-20).
//   - TLS estricto (CA-7): minVersion=TLSv1.2, checkServerIdentity default,
//     NO rejectUnauthorized=false.
//   - Redirects OFF por default (CA-14). Si se habilitan, cada hop se
//     revalida por SSRF + se drop de headers sensibles cross-origin.
//   - Header CRLF injection (CA-16) explícitamente rechazado.
//   - Body cap (CA-19) con abort antes del JSON.parse.
//   - redactSensitive en logs (CA-6/CA-17/CA-18).
//
// Retry (CA-3 / CA-4):
//   - Exponencial 2s → 4s → 8s ± jitter 20%.
//   - Solo ECONNREFUSED/ETIMEDOUT/ENOTFOUND/ECONNRESET.
//   - POST requiere retryable=true o Idempotency-Key.
//
// Logging (CA-UX-4 / CA-UX-11):
//   [HH:MM:SS] [NIVEL] [http-client/agente] mensaje
// =============================================================================
'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');

const {
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
    MAX_REDIRECTS_WHEN_ENABLED,
    TLS_MIN_VERSION,
    DEFAULT_USER_AGENT,
    ERROR_CODES,
    ERROR_MESSAGES_ES,
} = require('./constants');

// Importamos el módulo (no destructuramos) para que los tests puedan
// monkey-patch validateHostname cuando montan servers locales en 127.0.0.1.
const ssrfGuard = require('./ssrf-guard');
const { redactSensitive, redactUrlLike } = require('./redact');

// --- Logger minimal -----------------------------------------------------------
// Formato: [HH:MM:SS] [NIVEL] [http-client/agente] mensaje
function formatTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeLogger(agent) {
    const tag = `http-client/${agent || 'pipeline'}`;
    function emit(level, msg) {
        const line = `[${formatTime(new Date())}] [${level.padEnd(5)}] [${tag}] ${msg}`;
        if (level === 'ERROR' || level === 'WARN') {
            process.stderr.write(line + '\n');
        } else {
            process.stdout.write(line + '\n');
        }
    }
    return {
        info: (m) => emit('INFO', m),
        warn: (m) => emit('WARN', m),
        error: (m) => emit('ERROR', m),
        debug: (m) => { if (process.env.HTTP_CLIENT_DEBUG) emit('DEBUG', m); },
    };
}

// --- Utilidades ---------------------------------------------------------------

function isPlainObject(v) {
    return v && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v);
}

function hasHeader(headers, name) {
    if (!headers) return false;
    const lc = name.toLowerCase();
    return Object.keys(headers).some((k) => k.toLowerCase() === lc);
}

/**
 * Validación CRLF / NUL en headers (CA-16).
 * Levanta Error con code ERR_CRLF_INJECTION si detecta inyección.
 */
function assertNoCRLFInjection(headers) {
    if (!headers) return;
    for (const [k, v] of Object.entries(headers)) {
        if (typeof k !== 'string' || /[\r\n\0]/.test(k)) {
            const err = new Error(`[HTTP_CRLF_INJECTION]: nombre de header contiene CR/LF/NUL: ${JSON.stringify(k)} → prohibido por CA-16`);
            err.code = ERROR_CODES.CRLF_INJECTION;
            throw err;
        }
        const vals = Array.isArray(v) ? v : [v];
        for (const vv of vals) {
            if (typeof vv !== 'string' && typeof vv !== 'number' && typeof vv !== 'boolean') continue;
            if (/[\r\n\0]/.test(String(vv))) {
                const err = new Error(`[HTTP_CRLF_INJECTION]: valor de header "${k}" contiene CR/LF/NUL → prohibido por CA-16`);
                err.code = ERROR_CODES.CRLF_INJECTION;
                throw err;
            }
        }
    }
}

/**
 * Calcula el delay del intento `n` con backoff exponencial + jitter ±20%.
 * n comienza en 1. Devuelve ms.
 */
function computeBackoffMs(attemptIndex) {
    const base = RETRY_BASE_BACKOFF_MS * Math.pow(RETRY_BACKOFF_FACTOR, attemptIndex - 1);
    const jitterMultiplier = (1 - RETRY_JITTER_PERCENT) + Math.random() * (RETRY_JITTER_PERCENT * 2);
    return Math.round(base * jitterMultiplier);
}

function isRetryableError(err) {
    return err && typeof err.code === 'string' && RETRYABLE_ERROR_CODES.includes(err.code);
}

function translateErrorMessage(err) {
    if (!err) return 'error desconocido';
    const native = err.code;
    if (native && ERROR_MESSAGES_ES[native]) return ERROR_MESSAGES_ES[native];
    if (err.message) return err.message;
    return String(err);
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(t);
            reject(signal.reason || new Error('aborted'));
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Parsea el body de entrada: auto-serializa JSON, deja Buffer/string pasar.
 * @returns {{ body: Buffer|string|null, contentType: string|null }}
 */
function prepareBody(input) {
    if (input == null) return { body: null, contentType: null };
    if (Buffer.isBuffer(input)) return { body: input, contentType: null };
    if (typeof input === 'string') return { body: input, contentType: null };
    if (isPlainObject(input) || Array.isArray(input)) {
        return { body: JSON.stringify(input), contentType: 'application/json; charset=utf-8' };
    }
    return { body: String(input), contentType: null };
}

function parseResponseBody(buf, contentType, opts) {
    if (opts && opts.raw) return buf;
    const ct = (contentType || '').toLowerCase();
    if (ct.startsWith('application/json')) {
        try { return JSON.parse(buf.toString('utf8')); } catch (_) { return buf.toString('utf8'); }
    }
    if (ct.startsWith('text/') || ct.includes('charset=')) {
        return buf.toString('utf8');
    }
    return buf;
}

function isCrossOrigin(a, b) {
    try {
        return a.protocol !== b.protocol || a.hostname.toLowerCase() !== b.hostname.toLowerCase() || (a.port || '') !== (b.port || '');
    } catch (_) {
        return true;
    }
}

// Headers considerados "sensibles" y que no cruzan cross-origin (CA-14).
const CROSS_ORIGIN_DROP_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

// --- Core: request single attempt --------------------------------------------

/**
 * Ejecuta UN intento HTTP (sin retry, sin redirects). Usa AbortController
 * interno para todos los timeouts escalonados.
 *
 * @returns {Promise<{statusCode, headers, bodyBuffer, finalUrl}>}
 */
async function doSingleRequest(parsedUrl, options, logger) {
    // Validar SSRF antes de abrir socket (CA-9 + CA-13).
    const ipList = await Promise.race([
        ssrfGuard.validateHostname(parsedUrl.hostname, { dnsResolver: options._dnsResolver }),
        rejectAfter(TIMEOUT_DNS_MS, ERROR_CODES.TIMEOUT_DNS, 'timeout de resolución DNS'),
    ]);

    const pickedIp = ipList[0];
    const isHttps = parsedUrl.protocol === 'https:';

    // --- Construcción de opciones de node:http(s).request --------------------
    const headers = { ...(options.headers || {}) };
    // User-Agent fijo si no lo setearon (SEC-11 recomendado).
    if (!hasHeader(headers, 'user-agent')) {
        headers['User-Agent'] = DEFAULT_USER_AGENT;
    }
    if (!hasHeader(headers, 'host')) {
        // Node lo setea automático, pero lo dejamos explícito para claridad.
        headers.Host = parsedUrl.host;
    }

    const requestOptions = {
        method: options.method || 'GET',
        protocol: parsedUrl.protocol,
        host: parsedUrl.hostname, // para logs
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
        headers,
        // DNS rebinding mitigation (CA-9): inyectamos lookup que devuelve
        // UNA IP ya validada. Si el socket re-resuelve, no hay backdoor.
        // Soporta ambas formas del callback: single (err, address, family)
        // y all ({all:true} → err, [{address, family}]).
        lookup: (hostname, opts, cb) => {
            if (hostname === parsedUrl.hostname && pickedIp) {
                if (opts && opts.all) {
                    return cb(null, [{ address: pickedIp.address, family: pickedIp.family }]);
                }
                return cb(null, pickedIp.address, pickedIp.family);
            }
            // Fallback (no debería ocurrir dentro de este módulo).
            return require('node:dns').lookup(hostname, opts, cb);
        },
    };

    if (isHttps) {
        // TLS estricto — CA-7 / CA-20.
        requestOptions.minVersion = TLS_MIN_VERSION;
        requestOptions.servername = parsedUrl.hostname; // SNI al hostname original.
        requestOptions.checkServerIdentity = tls.checkServerIdentity; // default explícito.
        // NUNCA rejectUnauthorized:false — no lo seteamos acá, y la API pública
        // no provee forma de setearlo.
        if (options._ca) requestOptions.ca = options._ca; // hook para tests (self-signed confiado)
    }

    const agentTag = options._agentTag || 'pipeline';
    const redactedUrl = redactUrlLike(parsedUrl.toString());
    logger.info(`${requestOptions.method} ${redactedUrl} → ${pickedIp.address}`);

    const requester = isHttps ? https.request : http.request;

    return new Promise((resolve, reject) => {
        const ac = options._requestAbort || new AbortController();
        requestOptions.signal = ac.signal;
        let tcpTimer, tlsTimer, headersTimer, bodyTimer;
        // Error custom que originó el abort. Si se setea, lo propagamos en
        // vez del genérico ABORT_ERR de Node.
        let abortCause = null;
        const triggerAbort = (code, msg) => {
            if (!abortCause) {
                abortCause = new Error(`[HTTP_TIMEOUT]: ${msg}`);
                abortCause.code = code;
            }
            try { ac.abort(abortCause); } catch (_) { /* noop */ }
        };

        const req = requester(requestOptions, (res) => {
            clearTimeout(headersTimer);
            // Timeout de lectura de body.
            bodyTimer = setTimeout(() => {
                triggerAbort(ERROR_CODES.TIMEOUT_BODY, `timeout leyendo body (${TIMEOUT_BODY_READ_MS}ms)`);
            }, TIMEOUT_BODY_READ_MS);

            const chunks = [];
            let received = 0;
            const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BODY_BYTES_DEFAULT;

            res.on('data', (chunk) => {
                received += chunk.length;
                if (Number.isFinite(maxBytes) && received > maxBytes) {
                    const err = new Error(`[HTTP_BODY_CAP]: response excede cap de ${maxBytes} bytes → revisar paginación o aumentar maxResponseBytes (CA-19)`);
                    err.code = ERROR_CODES.RESPONSE_TOO_LARGE;
                    clearTimeout(bodyTimer);
                    req.destroy(err);
                    reject(err);
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                clearTimeout(bodyTimer);
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    bodyBuffer: Buffer.concat(chunks),
                    finalUrl: parsedUrl,
                });
            });
            res.on('error', (err) => {
                clearTimeout(bodyTimer);
                reject(err);
            });
        });

        // Timeouts escalonados (CA-5)
        tcpTimer = setTimeout(() => {
            triggerAbort(ERROR_CODES.TIMEOUT_TCP, `timeout de conexión TCP (${TIMEOUT_TCP_MS}ms)`);
        }, TIMEOUT_TCP_MS);

        if (isHttps) {
            tlsTimer = setTimeout(() => {
                triggerAbort(ERROR_CODES.TIMEOUT_TLS, `timeout de handshake TLS (${TIMEOUT_TLS_MS}ms)`);
            }, TIMEOUT_TCP_MS + TIMEOUT_TLS_MS);
        }

        headersTimer = setTimeout(() => {
            triggerAbort(ERROR_CODES.TIMEOUT_HEADERS, `timeout esperando headers (${TIMEOUT_RESPONSE_HEADERS_MS}ms)`);
        }, TIMEOUT_TCP_MS + (isHttps ? TIMEOUT_TLS_MS : 0) + TIMEOUT_RESPONSE_HEADERS_MS);

        // Timeout total (CA-5 cap): agregamos un watchdog global si el caller pasó timeout total.
        if (options._totalTimeoutMs != null && Number.isFinite(options._totalTimeoutMs)) {
            setTimeout(() => {
                triggerAbort(ERROR_CODES.TIMEOUT_TOTAL, `cap de timeout total excedido (${options._totalTimeoutMs}ms)`);
            }, options._totalTimeoutMs);
        }

        req.on('socket', (socket) => {
            socket.on('connect', () => {
                clearTimeout(tcpTimer);
            });
            socket.on('secureConnect', () => {
                clearTimeout(tlsTimer);
            });
        });

        req.on('error', (err) => {
            clearTimeout(tcpTimer);
            clearTimeout(tlsTimer);
            clearTimeout(headersTimer);
            clearTimeout(bodyTimer);
            // Si abortamos con una causa custom (timeout), propagar esa y no ABORT_ERR.
            if (abortCause) return reject(abortCause);
            // Traducir códigos TLS conocidos.
            if (err && err.code && ERROR_MESSAGES_ES[err.code] && !err.code.startsWith('ERR_TIMEOUT') && !err.code.startsWith('ERR_SSRF')) {
                err.translated = `[HTTP_TLS_INVALID]: ${ERROR_MESSAGES_ES[err.code]} → verificar fecha del sistema y renovación del cert`;
            }
            reject(err);
        });

        // Enviar body si corresponde.
        if (options._bodyBuffer != null) {
            req.write(options._bodyBuffer);
        }
        req.end();
    });
}

function abortWith(ac, code, msg) {
    const err = new Error(`[HTTP_TIMEOUT]: ${msg}`);
    err.code = code;
    try { ac.abort(err); } catch (_) { /* noop */ }
}

function rejectAfter(ms, code, msg) {
    return new Promise((_, reject) => {
        setTimeout(() => {
            const err = new Error(`[HTTP_TIMEOUT]: ${msg} (${ms}ms)`);
            err.code = code;
            reject(err);
        }, ms);
    });
}

// --- Core: request con retry + redirects --------------------------------------

/**
 * Ejecuta una request HTTPS con retry, TLS estricto y protección SSRF.
 *
 * @param {string|URL} url - URL de destino. Rechaza IPs privadas (CA-9/CA-13).
 * @param {object} [options] - Opciones de la request.
 * @param {string} [options.method='GET'] - Método HTTP.
 * @param {object} [options.headers={}] - Headers custom (CA-16 valida CRLF).
 * @param {any} [options.body] - Body. Objeto → JSON auto. String/Buffer pasan directo.
 * @param {number} [options.timeout=60000] - Timeout total ms (CA-5).
 * @param {number} [options.maxResponseBytes=10485760] - Cap body en bytes (CA-19).
 * @param {boolean} [options.followRedirects=false] - Seguir redirects (CA-14).
 * @param {number} [options.maxRedirects=3] - Máx redirects si habilitados (CA-14).
 * @param {boolean} [options.retryable=false] - Para POST, habilita retry (CA-4).
 * @param {boolean} [options.raw=false] - Devolver body como Buffer sin parsear.
 * @param {string} [options.agentTag] - Tag para logs.
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 * @throws {Error} Con `code` en: ERR_SSRF_BLOCKED, ERR_PROXY_NOT_WHITELISTED,
 *   ERR_RESPONSE_TOO_LARGE, ERR_CRLF_INJECTION, ERR_REDIRECT_DISABLED,
 *   ERR_REDIRECT_LIMIT, ERR_TIMEOUT_*, ERR_RETRY_EXHAUSTED.
 * @example
 *   const { body } = await request('https://api.telegram.org/botXXX/sendMessage', {
 *     method: 'POST',
 *     body: { chat_id: 123, text: 'hola' }
 *   });
 */
async function request(url, options = {}) {
    const logger = options._logger || makeLogger(options.agentTag);
    const method = String(options.method || 'GET').toUpperCase();

    // Validar headers (CA-16) ANTES de tocar red.
    assertNoCRLFInjection(options.headers);

    // Parsear URL inicial.
    let parsedUrl;
    try {
        parsedUrl = url instanceof URL ? url : new URL(String(url));
    } catch (_) {
        const err = new Error('[HTTP_URL_INVALID]: URL no parseable → verificar el formato');
        err.code = 'ERR_URL_INVALID';
        throw err;
    }

    // URL con userinfo NO se permite en la API pública (CA-15).
    if (parsedUrl.username || parsedUrl.password) {
        const err = new Error('[HTTP_USERINFO_BLOCKED]: URL con userinfo (user:pass@host) no permitida → usar un proxy de la whitelist para auth embebida (CA-15)');
        err.code = ERROR_CODES.USERINFO_BLOCKED;
        throw err;
    }

    // Preparar body.
    const { body: preparedBody, contentType } = prepareBody(options.body);
    const mergedHeaders = { ...(options.headers || {}) };
    if (preparedBody != null) {
        if (contentType && !hasHeader(mergedHeaders, 'content-type')) {
            mergedHeaders['Content-Type'] = contentType;
        }
        if (!hasHeader(mergedHeaders, 'content-length')) {
            mergedHeaders['Content-Length'] = Buffer.byteLength(preparedBody);
        }
    }

    // Retry policy (CA-4)
    const idempotent = IDEMPOTENT_METHODS.includes(method);
    const hasIdempotencyKey = hasHeader(mergedHeaders, 'idempotency-key');
    const canRetry = idempotent || options.retryable === true || hasIdempotencyKey;

    // Timeout total (CA-5).
    const totalTimeoutMs = options.timeout != null ? options.timeout : TIMEOUT_TOTAL_DEFAULT_MS;
    const totalDeadline = Number.isFinite(totalTimeoutMs) ? Date.now() + totalTimeoutMs : Infinity;

    // Redirects (CA-14).
    const followRedirects = options.followRedirects ?? FOLLOW_REDIRECTS_DEFAULT;
    const maxRedirects = followRedirects
        ? (options.maxRedirects ?? MAX_REDIRECTS_WHEN_ENABLED)
        : 0;

    let currentUrl = parsedUrl;
    let currentHeaders = mergedHeaders;
    let currentMethod = method;
    let currentBody = preparedBody;
    let redirectCount = 0;
    const visited = new Set();

    // Bucle de redirects.
    while (true) {
        // Retry loop (CA-3)
        const maxAttempts = canRetry ? RETRY_MAX_ATTEMPTS : 1;
        let lastErr;
        let result;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const remaining = totalDeadline - Date.now();
            if (remaining <= 0) {
                const err = new Error(`[HTTP_TIMEOUT]: cap de timeout total excedido (${totalTimeoutMs}ms)`);
                err.code = ERROR_CODES.TIMEOUT_TOTAL;
                throw err;
            }

            try {
                result = await doSingleRequest(currentUrl, {
                    method: currentMethod,
                    headers: currentHeaders,
                    _bodyBuffer: currentBody != null ? Buffer.from(currentBody) : null,
                    maxResponseBytes: options.maxResponseBytes,
                    _agentTag: options.agentTag,
                    _dnsResolver: options._dnsResolver,
                    _ca: options._ca,
                    _totalTimeoutMs: remaining,
                }, logger);
                break; // éxito, salir del retry loop
            } catch (err) {
                lastErr = err;
                const retryable = isRetryableError(err) && canRetry && attempt < maxAttempts;
                if (!retryable) {
                    throw decorateFinalError(err, attempt, maxAttempts);
                }
                const delay = computeBackoffMs(attempt);
                logger.warn(
                    `intento ${attempt}/${maxAttempts} falló: ${translateErrorMessage(err)} → reintentando en ${(delay / 1000).toFixed(1)}s`
                );
                await sleep(delay);
            }
        }

        if (!result) {
            throw decorateFinalError(lastErr, maxAttempts, maxAttempts);
        }

        // ¿Redirect?
        const status = result.statusCode;
        const loc = result.headers && result.headers.location;
        if (status >= 300 && status < 400 && loc) {
            if (!followRedirects) {
                const err = new Error(
                    `[HTTP_REDIRECT_DISABLED]: respuesta ${status} con Location pero followRedirects=false → habilitar explícitamente si es intencional (CA-14)`
                );
                err.code = ERROR_CODES.REDIRECT_DISABLED;
                err.statusCode = status;
                err.response = { statusCode: status, headers: result.headers };
                throw err;
            }
            redirectCount++;
            if (redirectCount > maxRedirects) {
                const err = new Error(`[HTTP_REDIRECT_LIMIT]: superó máximo de ${maxRedirects} redirects (CA-14)`);
                err.code = ERROR_CODES.REDIRECT_LIMIT;
                throw err;
            }
            const nextUrl = new URL(loc, currentUrl);

            // Re-validar SSRF implícitamente en la próxima iteración (doSingleRequest lo hace).
            if (visited.has(nextUrl.toString())) {
                const err = new Error(`[HTTP_REDIRECT_LOOP]: loop de redirects detectado → ${redactUrlLike(nextUrl.toString())}`);
                err.code = ERROR_CODES.REDIRECT_LIMIT;
                throw err;
            }
            visited.add(nextUrl.toString());

            // Cross-origin: dropear headers sensibles (CA-14).
            let nextHeaders = currentHeaders;
            if (isCrossOrigin(currentUrl, nextUrl)) {
                nextHeaders = {};
                for (const [k, v] of Object.entries(currentHeaders)) {
                    if (!CROSS_ORIGIN_DROP_HEADERS.includes(k.toLowerCase())) {
                        nextHeaders[k] = v;
                    }
                }
                logger.info(`redirect cross-origin → drop de headers sensibles`);
            }

            // 303 o (301/302 con método no-idempotente) → GET sin body.
            let nextMethod = currentMethod;
            let nextBody = currentBody;
            if (status === 303 || ((status === 301 || status === 302) && !IDEMPOTENT_METHODS.includes(currentMethod))) {
                nextMethod = 'GET';
                nextBody = null;
                delete nextHeaders['Content-Type'];
                delete nextHeaders['content-type'];
                delete nextHeaders['Content-Length'];
                delete nextHeaders['content-length'];
            }

            currentUrl = nextUrl;
            currentHeaders = nextHeaders;
            currentMethod = nextMethod;
            currentBody = nextBody;
            continue; // siguiente iteración del bucle de redirects
        }

        // No hay redirect: devolver resultado.
        const body = parseResponseBody(
            result.bodyBuffer,
            result.headers && result.headers['content-type'],
            { raw: options.raw === true }
        );
        return {
            statusCode: result.statusCode,
            headers: result.headers,
            body,
        };
    }
}

function decorateFinalError(err, attempts, maxAttempts) {
    if (!err) {
        const wrap = new Error('[HTTP_UNKNOWN]: error desconocido sin detalle');
        wrap.code = 'ERR_UNKNOWN';
        return wrap;
    }
    // Si fue un retry exhausto, wrappear.
    if (isRetryableError(err) && attempts >= maxAttempts && maxAttempts > 1) {
        const wrap = new Error(
            `[HTTP_RETRY_EXHAUSTED]: ${translateErrorMessage(err)} tras ${attempts}/${maxAttempts} intentos → verificar conectividad y disponibilidad del host`
        );
        wrap.code = ERROR_CODES.RETRY_EXHAUSTED;
        wrap.cause = err;
        return wrap;
    }
    return err;
}

// --- Helpers ergonómicos (CA-UX-8) --------------------------------------------

/**
 * GET helper. Retry habilitado por default (idempotente).
 */
function get(url, opts) {
    return request(url, { ...(opts || {}), method: 'GET' });
}

/**
 * POST helper. NO reintenta salvo retryable:true o Idempotency-Key (CA-4).
 * Acepta body string/Buffer/objeto (JSON auto).
 */
function post(url, body, opts) {
    return request(url, { ...(opts || {}), method: 'POST', body });
}

/**
 * POST con body JSON. Setea Content-Type: application/json automáticamente.
 */
function postJson(url, obj, opts) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...((opts && opts.headers) || {}) };
    return request(url, { ...(opts || {}), method: 'POST', body: obj, headers });
}

module.exports = {
    request,
    get,
    post,
    postJson,
    // Internals expuestos para tests
    _computeBackoffMs: computeBackoffMs,
    _assertNoCRLFInjection: assertNoCRLFInjection,
    _makeLogger: makeLogger,
};

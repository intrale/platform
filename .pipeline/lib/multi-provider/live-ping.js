// =============================================================================
// live-ping.js — Valida una API key contra el provider en vivo (#3177 CA-1).
//
// Defensa SSRF (OWASP A10):
//   - URLs hardcoded por provider en `PROVIDER_PING_ENDPOINTS`.
//   - El cliente envía solo el `provider` ID, NUNCA una URL.
//   - Si el provider no está en la allowlist → reject inmediato.
//
// Defensa info leak (OWASP A02):
//   - La respuesta del provider se sanitiza: NO devolvemos el body al cliente,
//     solo `{ ok, statusCode, reason }`.
//   - Si la API key falla, devolvemos el código HTTP + reason genérica
//     ('invalid_credentials' / 'quota_exhausted' / 'rate_limited' / 'unknown').
//
// Timeout obligatorio: 8s. Sin timeout, un provider colgado bloquea el dashboard.
// =============================================================================
'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const secretsRw = require('./secrets-rw');

const PROVIDER_PING_ENDPOINTS = Object.freeze({
    anthropic: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        body: () => JSON.stringify({
            model: 'claude-haiku-4',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
        }),
        headers: (key) => ({
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        }),
        interpret: (status, bodyExcerpt) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 401) return { ok: false, reason: 'invalid_credentials' };
            if (status === 403) return { ok: false, reason: 'forbidden' };
            if (status === 429) {
                if (/usage_limit|weekly_quota|insufficient_quota/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'quota_exhausted' };
                }
                return { ok: false, reason: 'rate_limited' };
            }
            return { ok: false, reason: 'unknown' };
        },
    },
    openai: {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({
            'authorization': `Bearer ${key}`,
        }),
        interpret: (status) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 401) return { ok: false, reason: 'invalid_credentials' };
            if (status === 429) return { ok: false, reason: 'quota_exhausted' };
            return { ok: false, reason: 'unknown' };
        },
    },
    elevenlabs: {
        url: 'https://api.elevenlabs.io/v1/voices',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'xi-api-key': key }),
        interpret: (status) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 401) return { ok: false, reason: 'invalid_credentials' };
            if (status === 429) return { ok: false, reason: 'quota_exhausted' };
            return { ok: false, reason: 'unknown' };
        },
    },
    // ─── Free providers — red de salvataje del pipeline (#3260 SR-2 / SR-7).
    //
    // Reglas para sumar uno:
    //   - URL **literal hardcoded** (anti-SSRF). Prohibido leer de
    //     `agent-models.json`, env vars o body de request.
    //   - Endpoint de **listado de modelos** (no completion) — los pings del
    //     cron de CA-1 corren cada 15min y la validación semanal de keys (CA-2).
    //     Un completion consume cuota, `/models` no.
    //   - Header de auth en `Authorization` / `x-api-key` / `x-goog-api-key`,
    //     **nunca en query string** (defense-in-depth contra leaks en logs;
    //     `key` ya está en `SENSITIVE_QUERY_KEYS` para protegerlo igualmente).
    //   - Reason codes genéricos: `authenticated` / `invalid_credentials` /
    //     `forbidden` / `quota_exhausted` / `rate_limited` / `unknown`. Nunca
    //     códigos provider-specific (filtran detalle al panel).
    //
    // NVIDIA-NIM se suma cuando mergee #3243 con su propio handler.
    groq: {
        url: 'https://api.groq.com/openai/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'authorization': `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 401) return { ok: false, reason: 'invalid_credentials' };
            if (status === 403) return { ok: false, reason: 'forbidden' };
            if (status === 429) {
                // Groq mezcla 'quota' y 'rate limit' en el mismo HTTP; el body
                // discrimina con `insufficient_quota` vs `rate_limit_exceeded`.
                if (/insufficient_quota|tokens_per_day|day_limit/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'quota_exhausted' };
                }
                return { ok: false, reason: 'rate_limited' };
            }
            return { ok: false, reason: 'unknown' };
        },
    },
    'gemini-google': {
        // Google AI Studio v1beta. La key viaja en el header `x-goog-api-key`,
        // no en query (SR-2). Lo llamamos 'gemini-google' (no 'gemini' a
        // secas) porque Vertex AI tiene OAuth distinto y se sumaría aparte.
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'x-goog-api-key': key }),
        interpret: (status, bodyExcerpt) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 400) {
                // Gemini devuelve 400 cuando la API key tiene formato inválido
                // (ej. demasiado corta). Lo tratamos como invalid_credentials.
                if (/API key not valid|API_KEY_INVALID/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'invalid_credentials' };
                }
                return { ok: false, reason: 'unknown' };
            }
            if (status === 401 || status === 403) {
                if (/permission|forbidden|insufficient/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'forbidden' };
                }
                return { ok: false, reason: 'invalid_credentials' };
            }
            if (status === 429) {
                if (/quota|exceeded/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'quota_exhausted' };
                }
                return { ok: false, reason: 'rate_limited' };
            }
            return { ok: false, reason: 'unknown' };
        },
    },
    cerebras: {
        url: 'https://api.cerebras.ai/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'authorization': `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) => {
            if (status >= 200 && status < 300) return { ok: true, reason: 'authenticated' };
            if (status === 401) return { ok: false, reason: 'invalid_credentials' };
            if (status === 403) return { ok: false, reason: 'forbidden' };
            if (status === 429) {
                if (/quota|exceeded|insufficient/i.test(bodyExcerpt)) {
                    return { ok: false, reason: 'quota_exhausted' };
                }
                return { ok: false, reason: 'rate_limited' };
            }
            return { ok: false, reason: 'unknown' };
        },
    },
});

const TIMEOUT_MS = 8_000;
const MAX_BODY_EXCERPT = 512;

function isAllowedProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_PING_ENDPOINTS, provider);
}

async function ping({ provider, secretsPath, fsImpl, httpImpl } = {}) {
    if (!isAllowedProvider(provider)) {
        return { ok: false, reason: 'unknown_provider', provider };
    }
    const key = secretsRw.getRawKey({ provider, secretsPath, fsImpl });
    if (!key) {
        return { ok: false, reason: 'no_key_configured', provider };
    }
    const spec = PROVIDER_PING_ENDPOINTS[provider];
    const startedAt = Date.now();
    let result;
    try {
        result = await doRequest(spec, key, httpImpl);
    } catch (e) {
        return {
            ok: false,
            reason: e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT'
                ? 'timeout'
                : 'network_error',
            provider,
            latency_ms: Date.now() - startedAt,
        };
    }
    const interpretation = spec.interpret(result.statusCode, result.bodyExcerpt || '');
    return {
        ...interpretation,
        provider,
        statusCode: result.statusCode,
        latency_ms: Date.now() - startedAt,
    };
}

function doRequest(spec, key, httpImpl) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(spec.url); }
        catch (e) { return reject(new Error(`URL inválida: ${e.message}`)); }
        if (url.protocol !== 'https:') {
            return reject(new Error(`Solo HTTPS permitido. Recibido: ${url.protocol}`));
        }
        const headers = spec.headers(key);
        const body = spec.body();
        if (body !== null) {
            headers['content-length'] = Buffer.byteLength(body);
        }
        const lib = httpImpl || https;
        const req = lib.request({
            method: spec.method,
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            headers,
            timeout: TIMEOUT_MS,
        }, (res) => {
            let chunks = [];
            let received = 0;
            res.on('data', c => {
                if (received < MAX_BODY_EXCERPT) {
                    chunks.push(c);
                    received += c.length;
                }
            });
            res.on('end', () => {
                const bodyExcerpt = Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_EXCERPT);
                resolve({ statusCode: res.statusCode, bodyExcerpt });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
        });
        if (body !== null) req.write(body);
        req.end();
    });
}

module.exports = {
    ping,
    isAllowedProvider,
    PROVIDER_PING_ENDPOINTS,
    TIMEOUT_MS,
};

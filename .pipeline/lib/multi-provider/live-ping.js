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
//
// #3486 — Clasificación HTTP delegada
// ------------------------------------
// La matriz statusCode → reason de cada provider ahora delega al clasificador
// universal (`lib/http-error-classifier.js`). Cada provider mantiene su
// `interpret()` por compatibilidad con el shape `{ ok, reason }` exigido por
// tests/consumers, pero internamente todos llaman al mismo helper. Los regex
// literales que vivían en este archivo (alternation de 'usage_limit',
// 'insufficient_quota', etc.) se eliminaron — la fuente única ahora es el
// clasificador. Los OVERRIDES por provider (ej. openai trata 429 plain como
// quota históricamente) se aplican post-clasificación para no romper consumers.
// =============================================================================
'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const secretsRw = require('./secrets-rw');
const httpClassifier = require('../http-error-classifier');

// -----------------------------------------------------------------------------
// classifyForLivePing — adapta el output del clasificador al shape histórico
// de live-ping `{ ok, reason }`. Aplica overrides por provider donde el
// pipeline tenía una semántica específica que debemos preservar.
//
// Mapeo base (clasificador → live-ping reason):
//   success/ok                 → { ok: true,  reason: 'authenticated' }
//   auth/invalid_credentials   → { ok: false, reason: 'invalid_credentials' }
//   auth/forbidden             → { ok: false, reason: 'forbidden' }
//   billing/quota_exhausted    → { ok: false, reason: 'quota_exhausted' }
//   rate_limit/rate_limited    → { ok: false, reason: 'rate_limited' }
//   transient/server_error     → { ok: false, reason: 'unknown' }   (legacy)
//   unknown/unclassified       → { ok: false, reason: 'unknown' }
//
// Overrides documentados:
//   - openai: 429 SIN body matchable se reportaba históricamente
//     como 'quota_exhausted' (su interpret() no recibía bodyExcerpt). Lo
//     mantenemos para no romper consumers del dashboard / health alerts.
//   - openai: no tenía branch 403 — mapeamos 403 a 'invalid_credentials' (más
//     suave que 'forbidden' para preservar el comportamiento previo que caía
//     a 'unknown'). Pero como 'forbidden' es estrictamente más informativo y
//     ningún consumer hardcodea 'unknown' para 403, dejamos el default.
// -----------------------------------------------------------------------------
function classifyForLivePing(provider, status, bodyExcerpt) {
    const c = httpClassifier.classifyHttpError(status, bodyExcerpt, provider);
    let ok, reason;
    switch (c.category) {
        case 'success':
            ok = true;
            reason = 'authenticated';
            break;
        case 'auth':
            ok = false;
            reason = c.reason; // invalid_credentials | forbidden
            break;
        case 'billing':
            ok = false;
            reason = 'quota_exhausted';
            break;
        case 'rate_limit':
            ok = false;
            reason = 'rate_limited';
            break;
        case 'transient':
        case 'unknown':
        default:
            ok = false;
            reason = 'unknown';
    }
    // Overrides por provider que preservan semántica legacy.
    if (provider === 'openai' && reason === 'rate_limited') {
        // El interpret legacy de openai trataba 429 como quota
        // siempre (sin discriminar por body). Preservar comportamiento.
        reason = 'quota_exhausted';
    }
    return { ok, reason };
}

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
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('anthropic', status, bodyExcerpt),
    },
    openai: {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({
            'authorization': `Bearer ${key}`,
        }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('openai', status, bodyExcerpt),
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
    //   - El `interpret()` delega al clasificador HTTP universal (#3486). NO
    //     duplicar regex de cuota acá — agregar marcadores al clasificador.
    //
    // NVIDIA NIM (#3243): API OpenAI-compatible, key viaja en `Authorization:
    // Bearer`. Endpoint de listado `/v1/models`. Reason codes alineados al set
    // genérico (SR-4 del análisis de seguridad).
    'nvidia-nim': {
        url: 'https://integrate.api.nvidia.com/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'authorization': `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('nvidia-nim', status, bodyExcerpt),
    },
    // Groq fue descontinuado (#3353, mayo 2026): la organización dueña de las
    // keys fue bloqueada por Groq sin aviso ("organization_restricted") y la
    // política de soporte era "desbloqueo único" — inaceptable para producción.
    // Si en algún momento se reintegra, copiar el bloque desde git history
    // (último commit con groq: 7dba2169).
    'gemini-google': {
        // Google AI Studio v1beta. La key viaja en el header `x-goog-api-key`,
        // no en query (SR-2). Lo llamamos 'gemini-google' (no 'gemini' a
        // secas) porque Vertex AI tiene OAuth distinto y se sumaría aparte.
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'x-goog-api-key': key }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('gemini-google', status, bodyExcerpt),
    },
    cerebras: {
        url: 'https://api.cerebras.ai/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'authorization': `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('cerebras', status, bodyExcerpt),
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
    // Exportado para tests del refactor #3486.
    _classifyForLivePing: classifyForLivePing,
};

// =============================================================================
// completion-client.js — Cliente HTTP completion-aware para free providers
// OpenAI-compatible (#3342, split de #3331 Sherlock).
//
// Por qué existe:
//   - El spawn de CLI (`claude`/`codex`/etc.) agrega 2-5s de overhead de arranque.
//   - El Sherlock verifier (#3331) requiere latencia <1s → necesita invocar el
//     provider directamente vía API HTTP, sin pasar por CLI.
//   - #3198 (adapters runtime) sigue pendiente, así que `safeBuildSpawn` tira
//     `_notImplemented` para `openai-codex`, `gemini-google`, `cerebras`,
//     `nvidia-nim`. Este módulo es el **habilitador genérico** para futuras
//     integraciones in-process (dispatcher Commander cuando se valide latencia,
//     etc.).
//
// Providers cubiertos (alineados con FREE_PROVIDERS en health-alerts.js):
//   - cerebras       (Llama 3.x / Llama 4 scout, OpenAI-compat)
//   - gemini-google  (Gemini 1.5/2.0, shim OpenAI-compat de v1beta)
//   - nvidia-nim     (DeepSeek / Llama / Mistral / Kimi, OpenAI-compat)
//
// Nota: Groq fue removido del pipeline en #3368 (mayo 2026) por política
// inestable de restricciones del provider. El issue #3342 fue escrito antes de
// esa remoción y mencionaba Groq — alineamos con el estado actual de main para
// no reintroducir el provider.
//
// Defensa SSRF (OWASP A10):
//   - URLs hardcoded por provider en `PROVIDER_COMPLETION_ENDPOINTS` (frozen).
//   - El caller envía solo el `provider` ID, NUNCA una URL.
//   - `isAllowedProvider(provider)` gatekeeper antes de cualquier `new URL(...)`.
//   - Validación `url.protocol === 'https:'` antes de despachar (defensa en
//     profundidad).
//
// Defensa TLS (OWASP A02 — Cryptographic Failures):
//   - HTTPS obligatorio. La validación TLS estándar de Node NO se desactiva en
//     este módulo. El test `completion-client.test.js` corre un linter sobre
//     este archivo y falla si aparecen anti-patrones de TLS-disable.
//     No tocar sin discutir con security.
//
// Defensa secrets (OWASP A02):
//   - API keys leídas exclusivamente vía `secrets-rw.getRawKey({provider})`,
//     que consulta `~/.claude/secrets/credentials.json` con fallback legacy
//     read-only. PROHIBIDO leer API keys de variables de entorno directamente
//     — el test `completion-client.test.js` falla si aparece esa lectura.
//   - La respuesta del cliente NO incluye la key cruda ni el body completo del
//     provider (sólo `content`/`inputTokens`/`outputTokens`).
//
// DoS / resource exhaustion:
//   - Timeout configurable (default 10s) en `req.setTimeout` + handler que
//     destruye con `code: 'ETIMEDOUT'`.
//   - Body cap 64KB (`MAX_BODY_BYTES`). Si el provider devuelve más, abortamos
//     con `error: {type: 'invalid_response', reason: 'body_too_large'}`.
//
// Errores tipados (alineados con `live-ping.js` para consistencia del ecosistema):
//   - `{ok: false, error: {type, reason?, statusCode?, detail?}, provider, model, durationMs}`
//   - `type`: 'timeout' | 'http_error' | 'auth_error' | 'invalid_response' | 'unknown_provider' | 'no_key_configured' | 'invalid_model'
//   - `reason` (cuando aplica): 'invalid_credentials' | 'quota_exhausted' | 'rate_limited' | 'forbidden' | 'schema_drift' | 'body_too_large' | 'network_error'
//
// IMPORTANTE — Rate limiting:
//   Este cliente NO implementa rate-limiter ni retries con backoff. Es
//   responsabilidad del caller (ej. Sherlock #3331) respetar los free-tier
//   límites publicados:
//     - Gemini Google: RPM 15 / RPD 1500 / TPM 1M (free)
//     - Cerebras:      RPM 30 / TPM 60K (free)
//     - NVIDIA NIM:    RPM/RPD sin documentar públicamente
//   Ver `docs/pipeline/multi-provider.md` §8.
//
// IMPORTANTE — Gemini OpenAI-compat es BETA:
//   `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
//   es un shim OpenAI-compatible que Google expone en v1beta. Riesgo bajo de
//   breaking changes pero documentado como dependencia externa. Si Google rompe
//   el shim, el test `caso: schema drift de Gemini → invalid_response` debería
//   pegar primero en el cron de health.
// =============================================================================
'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const secretsRw = require('./secrets-rw');

// ---------------------------------------------------------------------------
// Endpoints hardcoded — anti-SSRF. Solo proveedores OpenAI-compatible.
// Para sumar uno nuevo:
//   1. Agregarlo acá con URL literal HTTPS.
//   2. Agregarlo a PROVIDER_MODELS_ALLOWLIST (si querés gate a modelos
//      conocidos) o dejarlo abierto.
//   3. Agregar test de éxito + auth error + schema drift en
//      .pipeline/lib/__tests__/completion-client.test.js.
// ---------------------------------------------------------------------------
const PROVIDER_COMPLETION_ENDPOINTS = Object.freeze({
    cerebras: Object.freeze({
        url: 'https://api.cerebras.ai/v1/chat/completions',
        method: 'POST',
        // OpenAI-compat: key en Authorization Bearer.
        authHeader: 'authorization',
        authFormat: 'bearer',
    }),
    'gemini-google': Object.freeze({
        // BETA shim. Documentado en el header del módulo. Riesgo aceptable
        // porque normaliza el body al schema OpenAI y nos evita maintain dos
        // mapeos distintos (`:generateContent` devuelve `usageMetadata`).
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        method: 'POST',
        // El shim OpenAI-compat de Google acepta Authorization Bearer.
        authHeader: 'authorization',
        authFormat: 'bearer',
    }),
    'nvidia-nim': Object.freeze({
        // NVIDIA NIM expone OpenAI-compat en `/v1/chat/completions` (mismo
        // hostname que el ping a `/v1/models` en live-ping.js). Confirmado en
        // agent-launcher/providers/nvidia-nim.js + agent-models.json#nvidia-nim.
        url: 'https://integrate.api.nvidia.com/v1/chat/completions',
        method: 'POST',
        authHeader: 'authorization',
        authFormat: 'bearer',
    }),
});

// Allowlist de modelos por provider — defensa-en-profundidad contra `model`
// arbitrario que provoque 400 ruidosos con eco en el body (info leak menor).
// El `model` viaja como field del body JSON (no en la URL) → NO abre SSRF, pero
// igual filtramos. Los modelos en producción salen de `.pipeline/agent-models.json`
// (snapshot 2026-05-19): cerebras=llama-3.3-70b, gemini-google=gemini-2.0-flash,
// nvidia-nim=deepseek-ai/deepseek-v4-pro. Si la lista se queda corta, agregar
// acá + test.
const PROVIDER_MODELS_ALLOWLIST = Object.freeze({
    cerebras: Object.freeze([
        'llama3.1-8b',
        'llama3.1-70b',
        'llama-3.3-70b',
        'llama-4-scout-17b-16e-instruct',
    ]),
    'gemini-google': Object.freeze([
        'gemini-1.5-flash',
        'gemini-1.5-flash-8b',
        'gemini-1.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-exp',
    ]),
    'nvidia-nim': Object.freeze([
        'deepseek-ai/deepseek-v4-pro',
        'deepseek-ai/deepseek-r1',
        'meta/llama-3.1-8b-instruct',
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.3-70b-instruct',
        'mistralai/mixtral-8x7b-instruct-v0.1',
        'moonshotai/kimi-k2-6',
    ]),
});

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024; // 64KB — cap defensivo contra DoS.

function isAllowedProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_COMPLETION_ENDPOINTS, provider);
}

function isAllowedModel(provider, model) {
    const list = PROVIDER_MODELS_ALLOWLIST[provider];
    if (!list) return false;
    return list.indexOf(model) >= 0;
}

// ---------------------------------------------------------------------------
// complete — invoca una completion contra el provider OpenAI-compatible.
//
// Args:
//   - provider:    'cerebras' | 'gemini-google' | 'nvidia-nim' (allowlisted).
//   - model:       string en PROVIDER_MODELS_ALLOWLIST[provider].
//   - prompt:      string del prompt (se envía como user message).
//   - messages:    opcional, array de {role, content}; si no se pasa, se
//                  construye desde `prompt`.
//   - maxTokens:   opcional, default 1024.
//   - temperature: opcional, default 0.
//   - timeoutMs:   opcional, default DEFAULT_TIMEOUT_MS.
//   - secretsPath: opcional, override del path de credentials (tests).
//   - fsImpl:      opcional, override de fs (tests).
//   - httpImpl:    opcional, override de https (tests).
//
// Returns (success):
//   {
//     ok: true,
//     content:      string del completion,
//     inputTokens:  number,
//     outputTokens: number,
//     durationMs:   number,
//     provider, model
//   }
//
// Returns (failure — NO tira excepciones):
//   {
//     ok: false,
//     error: { type, reason?, statusCode?, detail? },
//     provider, model, durationMs
//   }
// ---------------------------------------------------------------------------
async function complete({
    provider,
    model,
    prompt,
    messages,
    maxTokens = 1024,
    temperature = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    secretsPath,
    fsImpl,
    httpImpl,
} = {}) {
    const startedAt = Date.now();
    const baseResult = { provider, model };

    if (!isAllowedProvider(provider)) {
        return {
            ok: false,
            error: { type: 'unknown_provider', detail: `provider '${provider}' no está allowlisted` },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }
    if (typeof model !== 'string' || !model.trim()) {
        return {
            ok: false,
            error: { type: 'invalid_model', detail: 'model requerido (string no vacío)' },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }
    if (!isAllowedModel(provider, model)) {
        return {
            ok: false,
            error: { type: 'invalid_model', detail: `model '${model}' no está en allowlist de '${provider}'` },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    // Construcción de messages — el caller puede pasar messages preformado
    // (multi-turn) o solo prompt (single-turn).
    let finalMessages;
    if (Array.isArray(messages) && messages.length > 0) {
        finalMessages = messages;
    } else if (typeof prompt === 'string' && prompt.trim()) {
        finalMessages = [{ role: 'user', content: prompt }];
    } else {
        return {
            ok: false,
            error: { type: 'invalid_response', detail: 'prompt o messages requeridos' },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    const key = secretsRw.getRawKey({ provider, secretsPath, fsImpl });
    if (!key) {
        return {
            ok: false,
            error: { type: 'no_key_configured', detail: `no hay API key configurada para '${provider}'` },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    const spec = PROVIDER_COMPLETION_ENDPOINTS[provider];
    const body = JSON.stringify({
        model,
        messages: finalMessages,
        max_tokens: maxTokens,
        temperature,
    });

    let httpResult;
    try {
        httpResult = await doRequest({ spec, key, body, timeoutMs, httpImpl });
    } catch (e) {
        const isTimeout = e && (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT');
        return {
            ok: false,
            error: isTimeout
                ? { type: 'timeout', detail: `request superó timeoutMs=${timeoutMs}` }
                : { type: 'http_error', reason: 'network_error', detail: e && e.message ? e.message : String(e) },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    const { statusCode, bodyText, truncated } = httpResult;

    if (truncated) {
        return {
            ok: false,
            error: { type: 'invalid_response', reason: 'body_too_large', statusCode, detail: `response > ${MAX_BODY_BYTES} bytes` },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    if (statusCode === 401) {
        return {
            ok: false,
            error: { type: 'auth_error', reason: 'invalid_credentials', statusCode },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }
    if (statusCode === 403) {
        return {
            ok: false,
            error: { type: 'auth_error', reason: 'forbidden', statusCode },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }
    if (statusCode === 429) {
        // Discriminamos quota (consumido el cupo) vs rate (RPM puntual). El
        // body del provider típicamente contiene 'insufficient_quota' /
        // 'monthly_limit' para quota y 'rate_limit_exceeded' a secas para rate.
        const reason = /\b(quota|insufficient_quota|monthly_limit|tokens_per_day|day_limit)\b/i.test(bodyText)
            ? 'quota_exhausted'
            : 'rate_limited';
        return {
            ok: false,
            error: { type: 'http_error', reason, statusCode },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }
    if (statusCode < 200 || statusCode >= 300) {
        return {
            ok: false,
            error: { type: 'http_error', reason: 'unknown', statusCode, detail: bodyText.slice(0, 512) },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    // Status 2xx — parse y normalize OpenAI-compat schema.
    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    } catch (e) {
        return {
            ok: false,
            error: { type: 'invalid_response', reason: 'schema_drift', statusCode, detail: 'JSON parse error' },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    const content = parsed
        && Array.isArray(parsed.choices)
        && parsed.choices[0]
        && parsed.choices[0].message
        && typeof parsed.choices[0].message.content === 'string'
        ? parsed.choices[0].message.content
        : null;

    if (content === null) {
        return {
            ok: false,
            error: { type: 'invalid_response', reason: 'schema_drift', statusCode, detail: 'choices[0].message.content faltante' },
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    return {
        ok: true,
        content,
        inputTokens:  (parsed.usage && typeof parsed.usage.prompt_tokens === 'number')     ? parsed.usage.prompt_tokens     : 0,
        outputTokens: (parsed.usage && typeof parsed.usage.completion_tokens === 'number') ? parsed.usage.completion_tokens : 0,
        provider,
        model: (typeof parsed.model === 'string' && parsed.model) ? parsed.model : model,
        durationMs: Date.now() - startedAt,
    };
}

function doRequest({ spec, key, body, timeoutMs, httpImpl }) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(spec.url); }
        catch (e) { return reject(new Error(`URL inválida: ${e.message}`)); }
        if (url.protocol !== 'https:') {
            return reject(new Error(`Solo HTTPS permitido. Recibido: ${url.protocol}`));
        }

        const headers = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'accept': 'application/json',
        };
        // OpenAI-compat: todos los providers actuales usan Authorization Bearer.
        // Si en el futuro alguno usa x-api-key, switch sobre spec.authFormat.
        if (spec.authFormat === 'bearer') {
            headers[spec.authHeader] = `Bearer ${key}`;
        } else {
            headers[spec.authHeader] = key;
        }

        const lib = httpImpl || https;
        const req = lib.request({
            method: spec.method,
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            headers,
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            let received = 0;
            let truncated = false;
            res.on('data', (c) => {
                if (truncated) return;
                received += c.length;
                if (received > MAX_BODY_BYTES) {
                    truncated = true;
                    try { req.destroy(); } catch {}
                    return resolve({ statusCode: res.statusCode, bodyText: '', truncated: true });
                }
                chunks.push(c);
            });
            res.on('end', () => {
                if (truncated) return; // ya resolvimos
                const bodyText = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: res.statusCode, bodyText, truncated: false });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
        });
        req.write(body);
        req.end();
    });
}

module.exports = {
    complete,
    isAllowedProvider,
    isAllowedModel,
    PROVIDER_COMPLETION_ENDPOINTS,
    PROVIDER_MODELS_ALLOWLIST,
    DEFAULT_TIMEOUT_MS,
    MAX_BODY_BYTES,
};

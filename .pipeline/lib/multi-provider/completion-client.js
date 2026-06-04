// =============================================================================
// completion-client.js — Cliente HTTP completion-aware para free providers
// OpenAI-compatible (#3342, split de #3331 Sherlock).
//
// Por qué existe:
//   - El spawn de CLI (`claude`/`codex`/etc.) agrega 2-5s de overhead de arranque.
//   - El Sherlock verifier (#3331) requiere latencia <1s → necesita invocar el
//     provider directamente vía API HTTP, sin pasar por CLI.
//   - Los adapters de spawn (`openai-codex`, `gemini-google`, `cerebras`,
//     `nvidia-nim`, `anthropic`) ya son reales (histórico #3198, cerrado por
//     PRs #3792/#3793/#3794). Este módulo sigue siendo el camino HTTP
//     in-process para los providers OpenAI-compat (sin overhead de spawn),
//     usado por Sherlock; los providers OAuth (anthropic/codex) van por spawn.
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
//   - SIN timeout (decisión Leo 2026-06-02 voz). El cliente espera la respuesta
//     del provider el tiempo que haga falta — la verificación adversarial nunca
//     se corta por reloj. Histórico: 10s (default original) → 90s+cap180s (#3484)
//     → sin timeout (esta versión). La resiliencia ante un provider que no
//     responde se delega a la **cascada multi-provider** del verifier (Sherlock):
//     si un provider falla con error, se salta al siguiente de la chain en vez
//     de cortar por tiempo. `timeoutMs` se mantiene en la signature por
//     back-compat: si un caller pasa un valor > 0 se respeta (sin cap), pero el
//     default (0 / inválido / ausente) significa "sin timeout".
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
const fs = require('node:fs');
const path = require('node:path');

const secretsRw = require('./secrets-rw');
// #3486: clasificador HTTP universal. Delegamos la matriz statusCode→reason
// para que la lógica viva en un solo módulo cross-provider. Mantiene el shape
// de error tipado `{type, reason, statusCode, detail?}` exigido por el cron de
// Sherlock y los tests existentes — solo cambia la fuente del `reason`.
const httpClassifier = require('../http-error-classifier');

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
        // 2026-06-04 — `gemini-1.5-flash` fue retirado del catálogo de Google;
        // el modelo alternativo de Sherlock pasa a `gemini-2.5-flash` (free tier
        // vigente). Se suma a la allowlist para que el config nuevo pase el filtro.
        'gemini-2.5-flash',
        'gemini-2.5-pro',
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

// Timeout default — 0 = SIN timeout (decisión Leo 2026-06-02 voz). El cliente
// espera lo que tarde el provider; la resiliencia ante un provider colgado la
// da la cascada multi-provider del verifier, no un corte por reloj. Histórico:
// 10s → 90s + cap 180s (#3484) → sin timeout (esta versión). Se mantiene
// exportado por back-compat; un caller que pase un `timeoutMs > 0` lo conserva
// (ya NO hay cap), pero el default es no cortar nunca.
const DEFAULT_TIMEOUT_MS = 0;

const MAX_BODY_BYTES = 64 * 1024; // 64KB — cap defensivo contra DoS.

// ---------------------------------------------------------------------------
// MP-04 (#3803) — allowlist config-aware. La allowlist hardcoded de arriba es
// la línea de base de defensa, pero quedaba ESTÁTICA: un modelo configurado en
// `agent-models.json` (p.ej. cerebras=gpt-oss-120b) que no figurara como string
// literal acá hacía fallar al provider con `invalid_model` ANTES del request
// HTTP → cortaba la cascada en un eslabón sano. Ahora derivamos también los
// modelos efectivamente declarados en la config (provider.model default +
// todos los `model_override` por skill) y los unimos a la allowlist. Así un
// modelo legítimamente configurado nunca se rechaza por drift de la lista, sin
// abrir la puerta a `model` arbitrario (solo lo que un humano puso en config).
//
// Caché por mtime para no leer el JSON en cada `complete()`.
let _configuredModelsCache = { mtimeMs: -1, pipelineDir: null, byProvider: null };

function defaultPipelineDir() {
    // completion-client.js vive en .pipeline/lib/multi-provider/
    return path.join(__dirname, '..', '..');
}

function getConfiguredModels(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const dir = pipelineDir || defaultPipelineDir();
    const modelsPath = path.join(dir, 'agent-models.json');
    let mtimeMs;
    try {
        mtimeMs = _fs.statSync(modelsPath).mtimeMs;
    } catch {
        return Object.create(null);
    }
    if (_configuredModelsCache.byProvider
        && _configuredModelsCache.pipelineDir === dir
        && _configuredModelsCache.mtimeMs === mtimeMs) {
        return _configuredModelsCache.byProvider;
    }
    const byProvider = Object.create(null);
    const add = (prov, model) => {
        if (typeof prov !== 'string' || typeof model !== 'string' || !model) return;
        (byProvider[prov] || (byProvider[prov] = new Set())).add(model);
    };
    try {
        const models = JSON.parse(_fs.readFileSync(modelsPath, 'utf8'));
        const providers = (models && models.providers) || {};
        for (const [prov, def] of Object.entries(providers)) {
            if (def && typeof def.model === 'string') add(prov, def.model);
        }
        const skills = (models && models.skills) || {};
        for (const cfg of Object.values(skills)) {
            const fbs = Array.isArray(cfg && cfg.fallbacks) ? cfg.fallbacks : [];
            for (const fb of fbs) {
                if (fb && typeof fb === 'object' && typeof fb.provider === 'string') {
                    if (typeof fb.model_override === 'string') add(fb.provider, fb.model_override);
                }
            }
        }
    } catch {
        return Object.create(null);
    }
    _configuredModelsCache = { mtimeMs, pipelineDir: dir, byProvider };
    return byProvider;
}

function isAllowedProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_COMPLETION_ENDPOINTS, provider);
}

function isAllowedModel(provider, model, configuredByProvider) {
    const list = PROVIDER_MODELS_ALLOWLIST[provider];
    if (list && list.indexOf(model) >= 0) return true;
    // Config-aware: aceptar modelos declarados por un humano en agent-models.json.
    const cfgSet = configuredByProvider && configuredByProvider[provider];
    if (cfgSet && cfgSet.has(model)) return true;
    return false;
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
    pipelineDir,
    fsImpl,
    httpImpl,
} = {}) {
    const startedAt = Date.now();
    const baseResult = { provider, model };

    // SIN timeout por default (Leo 2026-06-02). `effectiveTimeoutMs === 0`
    // significa "no cortar nunca". Si el caller pasa un valor > 0 se respeta
    // tal cual (ya no hay cap absoluto): es solo un opt-in explícito.
    const rawTimeout = Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? rawTimeout
        : 0;

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
    const configuredByProvider = getConfiguredModels(pipelineDir, fsImpl);
    if (!isAllowedModel(provider, model, configuredByProvider)) {
        return {
            ok: false,
            error: { type: 'invalid_model', detail: `model '${model}' no está en allowlist ni configurado para '${provider}'` },
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

    // MP-12 (#3803) — retry único ante schema_drift en respuestas 2xx. Un
    // provider que responde 200 con un body malformado (JSON roto o
    // `choices[0].message.content` ausente) mataba el intento sin reintentar,
    // y combinado con la cascada degradaba un eslabón por un blip transitorio
    // del shim OpenAI-compat. Ahora reintentamos UNA vez la misma request
    // (misma key/body) antes de declarar `invalid_response`. Solo el 2xx
    // malformado reintenta: errores de red, timeout, auth, cuota y 4xx/5xx NO
    // (esos cascadean igual que antes, sin gastar un segundo intento).
    const SCHEMA_DRIFT_MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= SCHEMA_DRIFT_MAX_ATTEMPTS; attempt++) {
    const retriesLeft = attempt < SCHEMA_DRIFT_MAX_ATTEMPTS;
    let httpResult;
    try {
        httpResult = await doRequest({ spec, key, body, timeoutMs: effectiveTimeoutMs, httpImpl });
    } catch (e) {
        const isTimeout = e && (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT');
        return {
            ok: false,
            error: isTimeout
                ? { type: 'timeout', detail: `request superó timeoutMs=${effectiveTimeoutMs}` }
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

    // #3486: clasificación HTTP delegada al módulo único. El shape externo
    // del error tipado se mantiene 1:1 con el contrato previo (Sherlock + tests):
    //   - 401 → { type: 'auth_error', reason: 'invalid_credentials', statusCode }
    //   - 403 → { type: 'auth_error', reason: 'forbidden', statusCode }
    //   - 429 + body quota → { type: 'http_error', reason: 'quota_exhausted', statusCode }
    //   - 429 sin quota → { type: 'http_error', reason: 'rate_limited', statusCode }
    //   - 5xx / 4xx unknown → { type: 'http_error', reason: 'unknown', statusCode, detail }
    if (statusCode < 200 || statusCode >= 300) {
        const classification = httpClassifier.classifyHttpError(statusCode, bodyText, provider);
        // Mapeo de category → type tipado de este cliente. El `reason` del
        // clasificador es canónico; lo reusamos tal cual salvo `server_error`
        // que históricamente reportamos como `unknown` para no tocar consumers.
        let type;
        let reason = classification.reason;
        if (classification.category === 'auth') {
            type = 'auth_error';
            // reason ya es invalid_credentials | forbidden
        } else {
            type = 'http_error';
            if (classification.category === 'unknown' || classification.category === 'transient') {
                // Preservar contrato previo: cualquier 5xx o 4xx no-tipado
                // se reportaba como reason: 'unknown' al consumer.
                reason = 'unknown';
            }
        }
        const errorObj = { type, reason, statusCode };
        // 5xx / 4xx unknown históricamente incluían detail con snippet del body.
        // Mantenemos ese comportamiento delegando al snippet redactado del
        // clasificador cuando aplique.
        if ((classification.category === 'unknown' || classification.category === 'transient')
            && bodyText) {
            errorObj.detail = bodyText.slice(0, 512);
        }
        return {
            ok: false,
            error: errorObj,
            ...baseResult,
            durationMs: Date.now() - startedAt,
        };
    }

    // Status 2xx — parse y normalize OpenAI-compat schema.
    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    } catch (e) {
        if (retriesLeft) continue; // MP-12: reintentar una vez antes de claudicar.
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
        if (retriesLeft) continue; // MP-12: reintentar una vez antes de claudicar.
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
    } // fin loop MP-12

    // Inalcanzable en la práctica (el loop retorna en cada rama salvo el
    // `continue` de schema_drift, que en la última vuelta cae a su return).
    return {
        ok: false,
        error: { type: 'invalid_response', reason: 'schema_drift', detail: 'agotados reintentos de schema_drift' },
        ...baseResult,
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
        // timeoutMs === 0 → sin timeout (no seteamos la opción ni el handler).
        const reqOpts = {
            method: spec.method,
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            headers,
        };
        if (Number(timeoutMs) > 0) {
            reqOpts.timeout = timeoutMs;
        }
        const req = lib.request(reqOpts, (res) => {
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
        // Solo registramos el handler de timeout si hay timeout configurado.
        if (Number(timeoutMs) > 0) {
            req.on('timeout', () => {
                req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
            });
        }
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

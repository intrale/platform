// =============================================================================
// completion-client.test.js — Tests del cliente HTTP completion-aware (#3342).
//
// No hacemos requests reales: stubeamos `httpImpl` para verificar el
// comportamiento del cliente. Modelado sobre `multi-provider-live-ping.test.js`.
//
// Cobertura:
//   - Allowlist anti-SSRF (providers + modelos).
//   - Schema OpenAI-compat parseado correctamente para los 3 providers.
//   - Errores tipados: timeout, 401, 429+quota vs rate, 5xx, schema drift,
//     body cap 64KB.
//   - Linter tests (CA seguridad): el módulo NO desactiva TLS y NO lee
//     API keys de variables de entorno.
//   - URLs hardcoded HTTPS, sin interpolación.
//   - La API key cruda NO se filtra en la respuesta serializada.
//
// Nota: el issue #3342 original listaba Groq como provider, pero #3368 lo
// removió del pipeline antes del desarrollo. El cliente cubre los 3 free
// providers actualmente soportados: cerebras, gemini-google, nvidia-nim.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const completion = require('../multi-provider/completion-client');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-comp-')); }
function writeKeys(file, keys) { fs.writeFileSync(file, JSON.stringify(keys)); }

// fakeHttp — simula `https.request` con configurabilidad por status, body,
// timeout, o body en chunks (para el caso body cap). Patrón calcado de
// multi-provider-live-ping.test.js.
function fakeHttp({ status = 200, body = '', simulateTimeout = false, chunks } = {}) {
    return {
        request(opts, cb) {
            const req = {
                _writes: [],
                _destroyed: false,
                on(ev, fn) { this[`_${ev}`] = fn; return this; },
                write(chunk) { this._writes.push(chunk); },
                end() {
                    const self = this;
                    if (simulateTimeout) {
                        process.nextTick(() => {
                            if (self._timeout) self._timeout();
                        });
                        return;
                    }
                    process.nextTick(() => {
                        const dataChunks = chunks || [Buffer.from(body, 'utf8')];
                        const res = {
                            statusCode: status,
                            on(ev, fn) {
                                if (ev === 'data') {
                                    for (const c of dataChunks) {
                                        if (self._destroyed) break;
                                        fn(c);
                                    }
                                }
                                if (ev === 'end' && !self._destroyed) fn();
                            },
                        };
                        cb(res);
                    });
                },
                destroy(err) {
                    this._destroyed = true;
                    if (err && this._error) this._error(err);
                },
            };
            return req;
        },
    };
}

// ─── Allowlist anti-SSRF ────────────────────────────────────────────────────

test('isAllowedProvider acepta solo cerebras, gemini-google, nvidia-nim', () => {
    assert.equal(completion.isAllowedProvider('cerebras'), true);
    assert.equal(completion.isAllowedProvider('gemini-google'), true);
    assert.equal(completion.isAllowedProvider('nvidia-nim'), true);
    // Groq fue removido del pipeline en #3368 — no debe estar acá.
    assert.equal(completion.isAllowedProvider('groq'), false, 'groq removido del pipeline (#3368)');
    assert.equal(completion.isAllowedProvider('anthropic'), false, 'anthropic usa OAuth/Claude Code, NO completion-client');
    assert.equal(completion.isAllowedProvider('attacker.com'), false);
    assert.equal(completion.isAllowedProvider('file://etc/passwd'), false);
    assert.equal(completion.isAllowedProvider(''), false);
});

test('complete devuelve unknown_provider para providers fuera de allowlist', async () => {
    const r = await completion.complete({ provider: 'attacker.com', model: 'x', prompt: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'unknown_provider');
});

test('complete devuelve invalid_model si el model no está en allowlist del provider', async () => {
    const r = await completion.complete({ provider: 'cerebras', model: 'gpt-4', prompt: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model');
});

test('complete devuelve invalid_model si model está vacío', async () => {
    const r = await completion.complete({ provider: 'cerebras', model: '', prompt: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model');
});

test('complete devuelve invalid_response si falta prompt y messages', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        secretsPath: f,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_response');
});

test('complete devuelve no_key_configured cuando falta la key', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'hi',
        secretsPath: f,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'no_key_configured');
});

// ─── Caso éxito por provider ────────────────────────────────────────────────

test('complete Cerebras éxito devuelve schema normalizado', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'pong cerebras' } }],
                usage: { prompt_tokens: 5, completion_tokens: 3 },
                model: 'llama-3.3-70b',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'pong cerebras');
    assert.equal(r.inputTokens, 5);
    assert.equal(r.outputTokens, 3);
    assert.equal(r.provider, 'cerebras');
    assert.equal(r.model, 'llama-3.3-70b');
    assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
});

test('complete Gemini-Google éxito devuelve schema normalizado (shim OpenAI-compat)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-2.0-flash',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'pong gemini' } }],
                usage: { prompt_tokens: 7, completion_tokens: 4 },
                model: 'gemini-2.0-flash',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'pong gemini');
    assert.equal(r.inputTokens, 7);
    assert.equal(r.outputTokens, 4);
});

test('complete NVIDIA NIM éxito devuelve schema normalizado', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'nvidia-nim',
        model: 'deepseek-ai/deepseek-v4-pro',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'pong nvidia' } }],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
                model: 'deepseek-ai/deepseek-v4-pro',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'pong nvidia');
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 2);
});

test('complete con messages preformado (multi-turn) en lugar de prompt funciona', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        messages: [
            { role: 'system', content: 'sos murble' },
            { role: 'user', content: 'hola' },
        ],
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'hola humano' } }],
                usage: { prompt_tokens: 12, completion_tokens: 2 },
                model: 'llama-3.3-70b',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'hola humano');
});

test('complete tolera usage faltante — devuelve 0 tokens en vez de fallar', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'sin usage' } }],
                // sin usage
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.inputTokens, 0);
    assert.equal(r.outputTokens, 0);
});

// ─── Errores tipados ────────────────────────────────────────────────────────

test('complete con timeout → error.type = timeout', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        timeoutMs: 50,
        secretsPath: f,
        httpImpl: fakeHttp({ simulateTimeout: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'timeout');
});

test('complete con 401 → error.type=auth_error, reason=invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 401, body: '{"error":{"message":"Invalid API Key"}}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'auth_error');
    assert.equal(r.error.reason, 'invalid_credentials');
    assert.equal(r.error.statusCode, 401);
});

test('complete con 403 → error.type=auth_error, reason=forbidden', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 403, body: '{"error":{"message":"Forbidden"}}' }),
    });
    assert.equal(r.error.type, 'auth_error');
    assert.equal(r.error.reason, 'forbidden');
});

test('complete con 429 + insufficient_quota → http_error reason=quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }),
    });
    assert.equal(r.error.type, 'http_error');
    assert.equal(r.error.reason, 'quota_exhausted');
});

test('complete con 429 plain rate_limit_exceeded → http_error reason=rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }),
    });
    assert.equal(r.error.type, 'http_error');
    assert.equal(r.error.reason, 'rate_limited');
});

test('complete con 5xx → http_error reason=unknown con detail acotado', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 503, body: 'Service unavailable' }),
    });
    assert.equal(r.error.type, 'http_error');
    assert.equal(r.error.statusCode, 503);
    assert.equal(r.error.reason, 'unknown');
});

test('complete con 2xx pero body no JSON → invalid_response reason=schema_drift', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 200, body: '<html>oops</html>' }),
    });
    assert.equal(r.error.type, 'invalid_response');
    assert.equal(r.error.reason, 'schema_drift');
});

test('complete con 2xx pero sin choices[0].message.content → invalid_response (Gemini beta drift)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-2.0-flash',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            // Simula que Google rompió el shim y volvió al formato nativo.
            body: JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'sin choices' }] } }],
                usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
            }),
        }),
    });
    assert.equal(r.error.type, 'invalid_response');
    assert.equal(r.error.reason, 'schema_drift');
});

test('complete con body > 64KB → invalid_response reason=body_too_large', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    // Generamos 100KB de payload — supera MAX_BODY_BYTES = 64KB.
    const big = 'A'.repeat(100 * 1024);
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 200, body: big }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_response');
    assert.equal(r.error.reason, 'body_too_large');
});

// ─── Seguridad: no leak de credenciales ─────────────────────────────────────

test('complete NO expone la API key cruda en la respuesta (success path)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    const secretKey = 'csk_VERY_SECRET_DO_NOT_LEAK_1234567890';
    writeKeys(f, { cerebras_api_key: secretKey });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        }),
    });
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('VERY_SECRET'), false, 'la respuesta no debe filtrar la key');
});

test('complete NO expone la API key cruda en la respuesta (error path 401)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    const secretKey = 'csk_VERY_SECRET_DO_NOT_LEAK_1234567890';
    writeKeys(f, { cerebras_api_key: secretKey });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 401, body: '{"error":"Invalid"}' }),
    });
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('VERY_SECRET'), false, 'la respuesta no debe filtrar la key');
});

// ─── Anti-SSRF: URLs hardcoded HTTPS ────────────────────────────────────────

test('PROVIDER_COMPLETION_ENDPOINTS solo expone URLs HTTPS literales hardcoded (anti-SSRF)', () => {
    const endpoints = completion.PROVIDER_COMPLETION_ENDPOINTS;
    const providers = Object.keys(endpoints);
    assert.ok(providers.length > 0, 'al menos un provider configurado');
    for (const [provider, spec] of Object.entries(endpoints)) {
        assert.ok(spec.url.startsWith('https://'), `${provider} url debe ser HTTPS literal`);
        assert.equal(typeof spec.url, 'string', `${provider} url debe ser string literal`);
        assert.ok(!spec.url.includes('${'), `${provider} url no debe interpolar variables`);
        assert.ok(!spec.url.includes('{'), `${provider} url no debe tener placeholders`);
        assert.equal(spec.method, 'POST', `${provider} debe usar POST para completions`);
    }
});

test('PROVIDER_COMPLETION_ENDPOINTS está congelado (Object.freeze defensivo)', () => {
    assert.equal(Object.isFrozen(completion.PROVIDER_COMPLETION_ENDPOINTS), true);
});

test('PROVIDER_MODELS_ALLOWLIST está congelado', () => {
    assert.equal(Object.isFrozen(completion.PROVIDER_MODELS_ALLOWLIST), true);
});

// ─── Linter tests (CA seguridad — críticos) ─────────────────────────────────

const MODULE_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'multi-provider', 'completion-client.js'),
    'utf8'
);

test('LINTER: el módulo NO desactiva la validación TLS (rejectUnauthorized)', () => {
    // El test detecta si alguien introduce literalmente la opción que apaga
    // la validación del certificado del peer. Es un CA crítico de seguridad —
    // no levantar este test sin discutir con security.
    //
    // Tolera espacios/quotes alrededor del literal `false`.
    const re = new RegExp('reject' + 'Unauthorized\\s*:\\s*false');
    assert.equal(
        re.test(MODULE_SOURCE),
        false,
        'completion-client.js NO debe desactivar la validación TLS.'
    );
});

test('LINTER: el módulo NO toca NODE_TLS_REJECT_UNAUTHORIZED', () => {
    assert.equal(
        /NODE_TLS_REJECT_UNAUTHORIZED/.test(MODULE_SOURCE),
        false,
        'completion-client.js NO debe tocar NODE_TLS_REJECT_UNAUTHORIZED.'
    );
});

test('LINTER: el módulo NO lee process.env.*_API_KEY (debe usar secrets-rw)', () => {
    // Match: process.env.CUALQUIERCOSA_API_KEY (case-sensitive uppercase + underscore).
    const re = /process\.env\.[A-Z_]+_API_KEY/;
    assert.equal(
        re.test(MODULE_SOURCE),
        false,
        'completion-client.js NO debe leer API keys de process.env — debe usar secrets-rw.getRawKey({provider}).'
    );
});

test('LINTER: el módulo NO usa http:// (cleartext)', () => {
    // Tolera "https://" — solo bloqueamos http:// (no precedido de "s").
    const cleartext = /(?<!s)http:\/\//g;
    const matches = MODULE_SOURCE.match(cleartext);
    assert.equal(matches, null, 'completion-client.js NO debe contener URLs http:// cleartext');
});

// ─── Defensa adicional: header de auth correcto por provider ────────────────

test('Cerebras usa Authorization Bearer (no x-api-key, no query)', () => {
    const spec = completion.PROVIDER_COMPLETION_ENDPOINTS.cerebras;
    assert.equal(spec.authHeader, 'authorization');
    assert.equal(spec.authFormat, 'bearer');
    assert.ok(!spec.url.includes('?'), 'Cerebras URL no debe llevar query string');
});

test('Gemini-Google usa Authorization Bearer (shim OpenAI-compat, NO key en query)', () => {
    const spec = completion.PROVIDER_COMPLETION_ENDPOINTS['gemini-google'];
    assert.equal(spec.authHeader, 'authorization');
    assert.equal(spec.authFormat, 'bearer');
    assert.ok(!spec.url.includes('?key='), 'Gemini OpenAI-compat NO debe llevar key en query string');
    assert.ok(spec.url.includes('/v1beta/openai/chat/completions'),
        'Gemini debe usar el shim OpenAI-compat de v1beta, no /v1beta/models/X:generateContent');
});

test('NVIDIA NIM usa Authorization Bearer (no x-api-key, no query)', () => {
    const spec = completion.PROVIDER_COMPLETION_ENDPOINTS['nvidia-nim'];
    assert.equal(spec.authHeader, 'authorization');
    assert.equal(spec.authFormat, 'bearer');
    assert.ok(!spec.url.includes('?'), 'NVIDIA NIM URL no debe llevar query string');
    assert.ok(spec.url.endsWith('/v1/chat/completions'),
        'NVIDIA NIM debe usar /v1/chat/completions (OpenAI-compat completion endpoint)');
});

test('PROVIDER_MODELS_ALLOWLIST incluye los modelos que usa producción (snapshot agent-models.json)', () => {
    // Sanity check defensivo: los modelos en producción deben estar en la
    // allowlist. Si alguien cambia agent-models.json, este test pega antes
    // que el dashboard.
    assert.ok(completion.isAllowedModel('cerebras', 'llama-3.3-70b'),
        'cerebras/llama-3.3-70b en producción debe estar allowlisted');
    assert.ok(completion.isAllowedModel('gemini-google', 'gemini-2.0-flash'),
        'gemini-google/gemini-2.0-flash en producción debe estar allowlisted');
    assert.ok(completion.isAllowedModel('nvidia-nim', 'deepseek-ai/deepseek-v4-pro'),
        'nvidia-nim/deepseek-ai/deepseek-v4-pro en producción debe estar allowlisted');
});

// =============================================================================
// 2026-06-02 (Leo) — el timeout se eliminó. El cliente espera lo que tarde el
// provider; la resiliencia la da la cascada multi-provider del verifier.
// =============================================================================

test('CA-CLIENT-3: DEFAULT_TIMEOUT_MS = 0 (sin timeout, 2026-06-02)', () => {
    assert.equal(completion.DEFAULT_TIMEOUT_MS, 0);
});

test('CA-CLIENT-4: el cliente ya no exporta cap absoluto de timeout (2026-06-02)', () => {
    // El cap absoluto (180s, #3484) se eliminó junto con el timeout.
    assert.equal(completion.ABSOLUTE_MAX_TIMEOUT_MS, undefined);
});

test('CA-CLIENT-4: caller pidiendo timeout > 0 se respeta sin cap (2026-06-02)', async () => {
    // Estrategia: el fake http NO simula timeout, sino que responde rápido.
    // Validamos que el cliente NO tira aunque le pasemos 999_999 — ya no hay
    // cap absoluto, el valor se respeta tal cual (opt-in explícito del caller).
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        timeoutMs: 999_999, // se respeta sin cap (ya no hay ABSOLUTE_MAX)
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'pong' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'pong');
});

test('#3484: caller con timeoutMs negativo o inválido cae a DEFAULT_TIMEOUT_MS', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        prompt: 'ping',
        timeoutMs: -100,
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        }),
    });
    // No tira, no rompe — el cliente usa DEFAULT_TIMEOUT_MS (90s) internamente.
    assert.equal(r.ok, true);
});

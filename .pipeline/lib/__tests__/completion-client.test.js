// =============================================================================
// completion-client.test.js — Tests del cliente HTTP completion-aware (#3342).
//
// No hacemos requests reales: stubeamos `httpImpl` para verificar el
// comportamiento del cliente. Modelado sobre `multi-provider-live-ping.test.js`.
//
// Cobertura:
//   - Allowlist anti-SSRF (providers + modelos).
//   - Schema OpenAI-compat parseado correctamente (gemini-google, único HTTP).
//   - Errores tipados: timeout, 401, 429+quota vs rate, 5xx, schema drift,
//     body cap 64KB.
//   - Linter tests (CA seguridad): el módulo NO desactiva TLS y NO lee
//     API keys de variables de entorno.
//   - URLs hardcoded HTTPS, sin interpolación.
//   - La API key cruda NO se filtra en la respuesta serializada.
//
// Nota: el issue #3342 original listaba Groq como provider, pero #3368 lo
// removió del pipeline antes del desarrollo; cerebras y nvidia-nim se retiraron
// en #6563. El cliente cubre hoy un único provider HTTP: gemini-google (shim
// OpenAI-compat). Los casos genéricos usan gemini-google como fixture.
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

test('isAllowedProvider acepta solo gemini-google', () => {
    assert.equal(completion.isAllowedProvider('gemini-google'), true);
    // Groq fue removido del pipeline en #3368 — no debe estar acá.
    assert.equal(completion.isAllowedProvider('groq'), false, 'groq removido del pipeline (#3368)');
    // #6563 — cerebras y nvidia-nim retirados: NO deben reaparecer en la allowlist.
    assert.equal(completion.isAllowedProvider('cerebras'), false, 'cerebras retirado del pipeline (#6563)');
    assert.equal(completion.isAllowedProvider('nvidia-nim'), false, 'nvidia-nim retirado del pipeline (#6563)');
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
    const r = await completion.complete({ provider: 'gemini-google', model: 'gpt-4', prompt: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model');
});

test('complete devuelve invalid_model si model está vacío', async () => {
    const r = await completion.complete({ provider: 'gemini-google', model: '', prompt: 'hi' });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model');
});

test('complete devuelve invalid_response si falta prompt y messages', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'hi',
        secretsPath: f,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'no_key_configured');
});

// ─── Caso éxito por provider ────────────────────────────────────────────────

// #6563 — casos de éxito de cerebras y nvidia-nim retirados con los providers.

test('complete Gemini-Google éxito devuelve schema normalizado (shim OpenAI-compat)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'pong gemini' } }],
                usage: { prompt_tokens: 7, completion_tokens: 4 },
                model: 'gemini-3.8-flash-medium',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'pong gemini');
    assert.equal(r.inputTokens, 7);
    assert.equal(r.outputTokens, 4);
    assert.equal(r.provider, 'gemini-google');
    assert.equal(r.model, 'gemini-3.8-flash-medium');
    assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
});

test('complete con messages preformado (multi-turn) en lugar de prompt funciona', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
                model: 'gemini-3.8-flash-medium',
            }),
        }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'hola humano');
});

test('complete tolera usage faltante — devuelve 0 tokens en vez de fallar', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    // Generamos 100KB de payload — supera MAX_BODY_BYTES = 64KB.
    const big = 'A'.repeat(100 * 1024);
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    const secretKey = 'AIzaSy_VERY_SECRET_DO_NOT_LEAK_1234567890';
    writeKeys(f, { gemini_google_api_key: secretKey });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    const secretKey = 'AIzaSy_VERY_SECRET_DO_NOT_LEAK_1234567890';
    writeKeys(f, { gemini_google_api_key: secretKey });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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

// #6563 — casos de header de cerebras y nvidia-nim retirados con los providers.

test('Gemini-Google usa Authorization Bearer (shim OpenAI-compat, NO key en query)', () => {
    const spec = completion.PROVIDER_COMPLETION_ENDPOINTS['gemini-google'];
    assert.equal(spec.authHeader, 'authorization');
    assert.equal(spec.authFormat, 'bearer');
    assert.ok(!spec.url.includes('?key='), 'Gemini OpenAI-compat NO debe llevar key en query string');
    assert.ok(spec.url.includes('/v1beta/openai/chat/completions'),
        'Gemini debe usar el shim OpenAI-compat de v1beta, no /v1beta/models/X:generateContent');
});

test('PROVIDER_MODELS_ALLOWLIST incluye los modelos que usa producción (snapshot agent-models.json)', () => {
    // Sanity check defensivo: los modelos en producción deben estar en la
    // allowlist. Si alguien cambia agent-models.json, este test pega antes
    // que el dashboard.
    // #6563 — cerebras y nvidia-nim retirados: sus listas NO deben reaparecer.
    assert.ok(completion.isAllowedModel('gemini-google', 'gemini-3.8-flash-medium'),
        'gemini-google/gemini-3.8-flash-medium en producción debe estar allowlisted');
    assert.equal(completion.PROVIDER_MODELS_ALLOWLIST.cerebras, undefined,
        'cerebras retirado (#6563): sin allowlist de modelos');
    assert.equal(completion.PROVIDER_MODELS_ALLOWLIST['nvidia-nim'], undefined,
        'nvidia-nim retirado (#6563): sin allowlist de modelos');
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
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

// ─── MP-04 (#3803) · allowlist config-aware ─────────────────────────────────
// Un modelo declarado en agent-models.json pero ausente de la allowlist
// hardcoded ANTES fallaba con invalid_model y mataba un eslabón sano de la
// cascada (caso real histórico: cerebras=gpt-oss-120b, provider retirado en
// #6563). Ahora se acepta. Estos tests ejercitan la vía config-aware con
// gemini-google y un id ficticio (`gemini-9.9-flash-test`) que queda fuera de
// la lista hardcoded.

function writeAgentModels(pipelineDir, json) {
    fs.writeFileSync(path.join(pipelineDir, 'agent-models.json'), JSON.stringify(json));
}

test('MP-04 · modelo configurado en agent-models.json pero NO en allowlist hardcoded → aceptado', async () => {
    const pipelineDir = tmpDir();
    writeAgentModels(pipelineDir, {
        providers: { 'gemini-google': { model: 'gemini-9.9-flash-test' } },
        skills: {},
    });
    const f = path.join(pipelineDir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-9.9-flash-test', // NO está en PROVIDER_MODELS_ALLOWLIST
        prompt: 'ping',
        pipelineDir,
        secretsPath: f,
        httpImpl: fakeHttp({
            status: 200,
            body: JSON.stringify({ choices: [{ message: { content: 'pong oss' } }] }),
        }),
    });
    assert.equal(r.ok, true, 'el modelo configurado debe pasar la allowlist config-aware');
    assert.equal(r.content, 'pong oss');
});

test('MP-04 · modelo declarado como model_override de un fallback también se acepta', async () => {
    const pipelineDir = tmpDir();
    writeAgentModels(pipelineDir, {
        providers: { 'gemini-google': { model: 'gemini-3.8-flash-medium' } },
        skills: { qa: { provider: 'anthropic', fallbacks: [{ provider: 'gemini-google', model_override: 'gemini-9.9-flash-test' }] } },
    });
    const f = path.join(pipelineDir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-9.9-flash-test',
        prompt: 'ping',
        pipelineDir,
        secretsPath: f,
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }),
    });
    assert.equal(r.ok, true, 'model_override declarado por humano debe aceptarse');
});

test('MP-04 · modelo NI en allowlist NI configurado sigue siendo invalid_model (defensa intacta)', async () => {
    const pipelineDir = tmpDir();
    writeAgentModels(pipelineDir, { providers: { 'gemini-google': { model: 'gemini-3.8-flash-medium' } }, skills: {} });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'modelo-arbitrario-no-declarado',
        prompt: 'hi',
        pipelineDir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model', 'la defensa anti-modelo-arbitrario sigue activa');
});

// ─── MP-12 (#3803) · retry único ante schema_drift en 2xx ────────────────────

// fakeHttp con secuencia de respuestas: una por cada request (para ejercer el
// retry). La N-ésima request usa responses[N-1] (la última se repite si faltan).
function fakeHttpSequence(responses) {
    let call = 0;
    return {
        request(opts, cb) {
            const idx = Math.min(call, responses.length - 1);
            call += 1;
            const { status = 200, body = '' } = responses[idx] || {};
            const req = {
                on(ev, fn) { this[`_${ev}`] = fn; return this; },
                write() {},
                end() {
                    process.nextTick(() => {
                        const res = {
                            statusCode: status,
                            on(ev, fn) {
                                if (ev === 'data') fn(Buffer.from(body, 'utf8'));
                                if (ev === 'end') fn();
                            },
                        };
                        cb(res);
                    });
                },
                destroy() {},
            };
            return req;
        },
        _calls() { return call; },
    };
}

test('MP-12 · 2xx con schema_drift en el 1er intento → reintenta y devuelve éxito en el 2do', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const http = fakeHttpSequence([
        { status: 200, body: '<html>blip</html>' }, // malformado
        { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'recuperado' } }] }) },
    ]);
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: http,
    });
    assert.equal(r.ok, true, 'el retry debe recuperar el blip transitorio');
    assert.equal(r.content, 'recuperado');
    assert.equal(http._calls(), 2, 'debe haber reintentado exactamente una vez');
});

test('MP-12 · schema_drift persistente en ambos intentos → invalid_response (sin retry infinito)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const http = fakeHttpSequence([{ status: 200, body: '<html>roto</html>' }]);
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: http,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_response');
    assert.equal(r.error.reason, 'schema_drift');
    assert.equal(http._calls(), 2, 'tope de 2 intentos, no más');
});

test('MP-12 · error NO-2xx (5xx) NO consume retry — cascada inmediata', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const http = fakeHttpSequence([{ status: 503, body: 'down' }]);
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: http,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'http_error');
    assert.equal(http._calls(), 1, 'un 5xx no debe reintentar (solo schema_drift 2xx reintenta)');
});

// =============================================================================
// #4353 CA-5 (security A02) — el `detail` de un error de body pasa por el
// snippet REDACTADO del clasificador, no un `bodyText.slice` crudo. Un body de
// provider puede eco-ar contenido del request del usuario (p.ej. un email);
// verificamos que llega redactado y acotado a DETAIL_MAX_BYTES.
// =============================================================================
test('#4353 CA-5 — 5xx con email en el body → error.detail redactado (no eco crudo)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        // El upstream eco-a el mensaje del usuario, que traía un email (PII).
        httpImpl: fakeHttp({ status: 503, body: 'upstream error procesando pedido de leito@gmail.com, reintentá' }),
    });
    assert.equal(r.error.type, 'http_error');
    assert.equal(r.error.reason, 'unknown');
    assert.ok(typeof r.error.detail === 'string' && r.error.detail.length > 0, 'debe traer detail');
    // El email NO debe aparecer en claro: la ruta redactada lo enmascara.
    assert.ok(!/leito@gmail\.com/.test(r.error.detail), 'el email del usuario no debe filtrarse crudo');
    assert.match(r.error.detail, /le\*\*\*@gm\*\*\*/, 'debe verse el patrón redactado del clasificador');
});

test('#4353 CA-5 — detail acotado a DETAIL_MAX_BYTES (512) aunque el body sea enorme', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const hugeBody = 'x'.repeat(5000); // > 512 pero < MAX_BODY_BYTES (16KB, no truncated)
    const r = await completion.complete({
        provider: 'gemini-google',
        model: 'gemini-3.8-flash-medium',
        prompt: 'ping',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 503, body: hugeBody }),
    });
    assert.equal(r.error.type, 'http_error');
    assert.ok(r.error.detail.length <= 512, `detail debe estar acotado a 512, fue ${r.error.detail.length}`);
});

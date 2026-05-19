// =============================================================================
// multi-provider-live-ping.test.js — Tests del módulo live-ping (#3177 SSRF).
// No hacemos requests reales: stubeamos httpImpl para verificar comportamiento.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const livePing = require('../multi-provider/live-ping');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ping-')); }
function writeKeys(file, keys) { fs.writeFileSync(file, JSON.stringify(keys)); }

function fakeHttp({ status = 200, body = '' } = {}) {
    return {
        request(opts, cb) {
            const req = {
                _writes: [],
                on(ev, fn) { this[`_${ev}`] = fn; return this; },
                write(chunk) { this._writes.push(chunk); },
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
    };
}

test('isAllowedProvider acepta solo los providers conocidos', () => {
    assert.equal(livePing.isAllowedProvider('anthropic'), true);
    assert.equal(livePing.isAllowedProvider('openai'), true);
    assert.equal(livePing.isAllowedProvider('elevenlabs'), true);
    assert.equal(livePing.isAllowedProvider('attacker.com'), false);
    assert.equal(livePing.isAllowedProvider('file://etc/passwd'), false);
    assert.equal(livePing.isAllowedProvider(''), false);
});

test('ping devuelve unknown_provider para providers no allowlisted', async () => {
    const r = await livePing.ping({ provider: 'attacker.com' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_provider');
});

test('ping devuelve no_key_configured cuando falta la key', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    const r = await livePing.ping({ provider: 'openai', secretsPath: f });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_key_configured');
});

test('ping OpenAI con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
    assert.equal(r.provider, 'openai');
});

test('ping OpenAI con status 401 devuelve invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping OpenAI con status 429 devuelve quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 429 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping Anthropic con status 429 + cuerpo usage_limit devuelve quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { anthropic_api_key: 'sk-ant-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'anthropic',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"type":"usage_limit_error"}}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping Anthropic con status 429 + cuerpo plain devuelve rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { anthropic_api_key: 'sk-ant-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'anthropic',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"type":"rate_limit_exceeded"}}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rate_limited');
});

test('ping no expone la API key cruda en la respuesta', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    const secretKey = 'sk-test-VERY-SECRET-DO-NOT-LEAK-12345';
    writeKeys(f, { openai_api_key: secretKey });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('VERY-SECRET'), false, 'la respuesta no debe filtrar la key');
});

// ─── Free providers (#3260) ─────────────────────────────────────────────────

test('isAllowedProvider acepta los free providers vivos (#3260 + #3243 + #3353)', () => {
    // #3353 — groq removido; los 3 free providers vivos quedan acá.
    assert.equal(livePing.isAllowedProvider('groq'), false, 'groq debería estar removido tras #3353');
    assert.equal(livePing.isAllowedProvider('gemini-google'), true);
    assert.equal(livePing.isAllowedProvider('cerebras'), true);
    // #3243 — NVIDIA NIM
    assert.equal(livePing.isAllowedProvider('nvidia-nim'), true);
});

// Tests "ping Groq con ..." se eliminaron en #3353 — Groq descontinuado.

test('ping Gemini-Google con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await livePing.ping({ provider: 'gemini-google', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

test('ping Gemini-Google con 400 API_KEY_INVALID → invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 400, body: '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key."}}' }),
    });
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping Gemini-Google con 429 quota → quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    const r = await livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}' }),
    });
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping Cerebras con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'cerebras', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) });
    assert.equal(r.ok, true);
});

test('ping Cerebras con 401 → invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'cerebras', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    assert.equal(r.reason, 'invalid_credentials');
});

// ─── NVIDIA NIM (#3243) ──────────────────────────────────────────────────────

test('ping NVIDIA NIM con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'nvidia-nim', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
    assert.equal(r.provider, 'nvidia-nim');
});

test('ping NVIDIA NIM con 401 → invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'nvidia-nim', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping NVIDIA NIM con 403 → forbidden', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'nvidia-nim', secretsPath: f, httpImpl: fakeHttp({ status: 403 }) });
    assert.equal(r.reason, 'forbidden');
});

test('ping NVIDIA NIM con 429 + insufficient_quota → quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'nvidia-nim',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }),
    });
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping NVIDIA NIM con 429 plain → rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'nvidia-nim',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }),
    });
    assert.equal(r.reason, 'rate_limited');
});

test('NVIDIA NIM usa header Authorization Bearer (SR-2: nunca query string)', () => {
    const spec = livePing.PROVIDER_PING_ENDPOINTS['nvidia-nim'];
    assert.ok(spec.url.startsWith('https://integrate.api.nvidia.com/v1/models'),
        'NVIDIA NIM debe pingear /v1/models hardcoded (SR-1)');
    assert.ok(!spec.url.includes('?'), 'NVIDIA NIM URL no debe llevar query string');
    const headers = spec.headers('nvapi-TEST');
    assert.equal(headers['authorization'], 'Bearer nvapi-TEST',
        'NVIDIA NIM debe enviar la key en header Authorization Bearer');
    // No debería haber otros headers de auth alternativos.
    assert.ok(!('x-api-key' in headers), 'no debe haber x-api-key suelto');
    assert.ok(!('key' in headers), 'no debe haber "key" suelto');
});

test('NVIDIA NIM usa GET /v1/models (SR-3: nunca /v1/chat/completions)', () => {
    const spec = livePing.PROVIDER_PING_ENDPOINTS['nvidia-nim'];
    assert.equal(spec.method, 'GET', 'NVIDIA NIM ping debe ser GET');
    assert.ok(spec.url.endsWith('/v1/models'), 'NVIDIA NIM ping debe usar /v1/models (no completions)');
    assert.equal(spec.body(), null, 'NVIDIA NIM ping no debe enviar body');
});

test('PROVIDER_PING_ENDPOINTS solo expone URLs HTTPS literales hardcoded (anti-SSRF)', () => {
    for (const [provider, spec] of Object.entries(livePing.PROVIDER_PING_ENDPOINTS)) {
        assert.ok(spec.url.startsWith('https://'), `${provider} url debe ser HTTPS literal`);
        assert.equal(typeof spec.url, 'string', `${provider} url debe ser string literal`);
        // El URL no debe tener placeholders ni variables.
        assert.ok(!spec.url.includes('${'), `${provider} url no debe interpolar variables`);
        assert.ok(!spec.url.includes('{'), `${provider} url no debe tener placeholders`);
    }
});

test('Gemini-Google usa header x-goog-api-key, NUNCA query string (SR-2)', () => {
    const spec = livePing.PROVIDER_PING_ENDPOINTS['gemini-google'];
    assert.ok(!spec.url.includes('?key='), 'Gemini URL no debe llevar key en query');
    const headers = spec.headers('AIzaTEST');
    assert.ok(headers['x-goog-api-key'], 'Gemini debe usar header x-goog-api-key');
    assert.ok(!('key' in headers), 'no debe haber clave "key" suelta en headers');
});

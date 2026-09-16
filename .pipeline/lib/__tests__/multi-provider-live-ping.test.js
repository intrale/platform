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

// #6563 — Tras la baja de cerebras/nvidia-nim no queda en el plantel ningún
// provider que se pinguee por API key: anthropic, codex y gemini-google
// (Antigravity) son OAuth y `ping()` hace short-circuit por el probe del CLI.
// El camino HTTP (throttle facturable, clasificación de status, endpoints
// literales anti-SSRF) se conserva como infraestructura, así que para
// ejercitarlo estos tests re-declaran temporalmente a `gemini-google` (y a
// `anthropic` cuando hace falta un segundo provider) como `api_key` en la
// lista gestionada que consulta `ping()`. `getRawKey` sigue usando la spec
// real (paths canónico/legacy de cada provider). Se restaura al terminar.
const secretsRw = require('../multi-provider/secrets-rw');
const REAL_MANAGED_KEYS = secretsRw.MANAGED_KEYS;
function asApiKeyProviders(providers) {
    return Object.freeze(REAL_MANAGED_KEYS.map((k) => (providers.includes(k.provider)
        ? Object.freeze({ ...k, auth_mode: 'api_key', catalog_probe: undefined, cli_binary: undefined })
        : k)));
}
async function withHttpPingProviders(providers, fn) {
    secretsRw.MANAGED_KEYS = asApiKeyProviders(providers);
    try { return await fn(); } finally { secretsRw.MANAGED_KEYS = REAL_MANAGED_KEYS; }
}

// #3965 CA-4 — `ping()` ahora mantiene un cooldown/concurrencia server-side por
// proveedor en estado de módulo. Estos tests verifican la CLASIFICACIÓN del
// status code (no el throttle), y cada uno pingea el mismo set de proveedores en
// milisegundos: sin reset, el 2do ping de un proveedor caería en el cooldown y
// devolvería `rate_limited_local`. Reseteamos antes de cada test para aislar.
test.beforeEach(() => livePing._resetPingThrottle());

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
    assert.equal(livePing.isAllowedProvider('gemini-google'), true);
    assert.equal(livePing.isAllowedProvider('cerebras'), false, 'retirado en #6563');
    assert.equal(livePing.isAllowedProvider('attacker.com'), false);
    assert.equal(livePing.isAllowedProvider('file://etc/passwd'), false);
    assert.equal(livePing.isAllowedProvider(''), false);
});

test('ping devuelve unknown_provider para providers no allowlisted', async () => {
    const r = await livePing.ping({ provider: 'attacker.com' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_provider');
});

test('ping devuelve no_key_configured cuando falta la key (provider api_key)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    // #4402 — `openai` pasó a auth_mode:'oauth' (short-circuit CLI). #6563 — ya
    // no queda provider api_key en el plantel: se ejercita el gate con
    // `gemini-google` re-declarado como api_key (ver helper arriba).
    const r = await withHttpPingProviders(['gemini-google'], () =>
        livePing.ping({ provider: 'gemini-google', secretsPath: f }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_key_configured');
});

// #4402 — Los providers OAuth (anthropic MAX / codex) ya NO se pinean por API
// key: se validan por CLI. La clasificación HTTP legacy de anthropic/openai se
// verifica ahora directamente sobre el clasificador (`_classifyForLivePing`),
// que sigue siendo la fuente de esos reason_codes.
test('_classifyForLivePing OpenAI 200 → authenticated', () => {
    const r = livePing._classifyForLivePing('openai', 200, '');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

test('_classifyForLivePing OpenAI 401 → invalid_credentials', () => {
    const r = livePing._classifyForLivePing('openai', 401, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('_classifyForLivePing OpenAI 429 → quota_exhausted (override legacy)', () => {
    const r = livePing._classifyForLivePing('openai', 429, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('_classifyForLivePing Anthropic 429 + usage_limit → quota_exhausted', () => {
    const r = livePing._classifyForLivePing('anthropic', 429, '{"error":{"type":"usage_limit_error"}}');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('_classifyForLivePing Anthropic 429 + cuerpo plain → rate_limited', () => {
    const r = livePing._classifyForLivePing('anthropic', 429, '{"error":{"type":"rate_limit_exceeded"}}');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rate_limited');
});

test('ping no expone la API key cruda en la respuesta', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    const secretKey = 'csk-test-VERY-SECRET-DO-NOT-LEAK-12345';
    writeKeys(f, { cerebras_api_key: secretKey });
    const r = await livePing.ping({ provider: 'cerebras', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('VERY-SECRET'), false, 'la respuesta no debe filtrar la key');
});

// ─── #4402 CA-1 — false-negative de Anthropic OAuth cerrado en live-ping ──────

test('ping Anthropic OAuth con CLI presente → ok + cli_oauth_ok (NO no_key_configured)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {}); // sin API key: el pipeline usa OAuth Max, no la key
    const r = await livePing.ping({ provider: 'anthropic', secretsPath: f, cliProbe: () => true });
    assert.equal(r.ok, true, 'con OAuth Max activo el ping es verde');
    assert.equal(r.reason, 'cli_oauth_ok');
    assert.notEqual(r.reason, 'no_key_configured', 'fin del false-negative');
    assert.equal(r.provider, 'anthropic');
});

test('ping Anthropic OAuth con CLI ausente → cli_unavailable', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    const r = await livePing.ping({ provider: 'anthropic', secretsPath: f, cliProbe: () => false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
});

test('ping OpenAI/Codex OAuth con CLI presente → cli_oauth_ok', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, cliProbe: () => true });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'cli_oauth_ok');
});

test('RS-5.1/5.2 — el resultado OAuth NO contiene material de token/credencial', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    // Aunque hubiera una key configurada, el camino OAuth NO la lee ni la devuelve.
    writeKeys(f, { anthropic_api_key: 'sk-ant-SECRET-eyJ-bearer-DO-NOT-LEAK-000' });
    const r = await livePing.ping({ provider: 'anthropic', secretsPath: f, cliProbe: () => true });
    const serialized = JSON.stringify(r);
    // No debe filtrar la key/JWT/bearer real (los strings de status `cli_oauth`
    // son enum, no secretos).
    assert.ok(!serialized.includes('sk-ant-SECRET'), 'no debe filtrar la API key');
    assert.ok(!serialized.includes('eyJ'), 'no debe filtrar un JWT');
    assert.ok(!/bearer\s/i.test(serialized), 'no debe filtrar un header bearer');
});

// ─── Free providers (#3260) ─────────────────────────────────────────────────

test('isAllowedProvider acepta sólo el free provider vivo (#3260 + #3353 + #6563)', () => {
    // #3353 — groq removido; #6563 — cerebras y nvidia-nim retirados.
    assert.equal(livePing.isAllowedProvider('groq'), false, 'groq debería estar removido tras #3353');
    assert.equal(livePing.isAllowedProvider('gemini-google'), true);
    assert.equal(livePing.isAllowedProvider('cerebras'), false, 'cerebras retirado en #6563');
    assert.equal(livePing.isAllowedProvider('nvidia-nim'), false, 'nvidia-nim retirado en #6563');
});

// Tests "ping Groq con ..." se eliminaron en #3353 — Groq descontinuado.

test('ping Gemini-Google usa el probe CLI-OAuth y no una API key HTTP', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' });
    let httpCalls = 0;
    const r = await livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        cliProbe: () => false,
        httpImpl: () => { httpCalls++; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
    assert.equal(httpCalls, 0);
});

// ─── Camino HTTP por API key (clasificación de status) ───────────────────────
// #6563 — se ejercita con `gemini-google` re-declarado como api_key (helper).

const GEMINI_KEY = { gemini_google_api_key: 'AIzaSyTest_1234567890abcdef000' };

test('ping HTTP con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () =>
        livePing.ping({ provider: 'gemini-google', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) }));
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
    assert.equal(r.provider, 'gemini-google');
});

test('ping HTTP con 401 → invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () =>
        livePing.ping({ provider: 'gemini-google', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping HTTP con 403 → forbidden', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () =>
        livePing.ping({ provider: 'gemini-google', secretsPath: f, httpImpl: fakeHttp({ status: 403 }) }));
    assert.equal(r.reason, 'forbidden');
});

test('ping HTTP con 429 + insufficient_quota → quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () => livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }),
    }));
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping HTTP con 429 plain → rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () => livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }),
    }));
    assert.equal(r.reason, 'rate_limited');
});

test('#6563 — PROVIDER_PING_ENDPOINTS no conserva endpoints de providers retirados', () => {
    assert.equal('cerebras' in livePing.PROVIDER_PING_ENDPOINTS, false);
    assert.equal('nvidia-nim' in livePing.PROVIDER_PING_ENDPOINTS, false);
    assert.deepEqual(Object.keys(livePing.PROVIDER_PING_ENDPOINTS).sort(), ['anthropic', 'gemini-google', 'openai']);
});

test('Gemini usa GET de listado de modelos (SR-3: nunca /v1/chat/completions)', () => {
    const spec = livePing.PROVIDER_PING_ENDPOINTS['gemini-google'];
    assert.equal(spec.method, 'GET', 'el ping debe ser GET');
    assert.ok(!spec.url.includes('chat/completions'), 'el ping debe usar el listado (no completions)');
    assert.equal(spec.body(), null, 'el ping no debe enviar body');
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

// -----------------------------------------------------------------------------
// #5888 — No-regresión del ping SIN `expectModels`.
//
// El cruce de catálogo suma un parámetro opcional a `ping()`. El ping manual del
// dashboard (`api.js`, path FACTURABLE protegido por el throttle de #3965) NO lo
// pasa: su shape de retorno tiene que seguir siendo byte por byte el de HEAD, y
// no puede bajar un catálogo de hasta 1 MiB por proveedor (R-J).
// -----------------------------------------------------------------------------
test('#5888 R-J: ping sin expectModels devuelve exactamente el shape de HEAD', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, GEMINI_KEY);
    const r = await withHttpPingProviders(['gemini-google'], () => livePing.ping({
        provider: 'gemini-google',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 200, body: '{"models":[{"name":"models/gemini-3.8-flash-medium"}]}' }),
    }));
    assert.deepEqual(Object.keys(r).sort(), ['latency_ms', 'ok', 'provider', 'reason', 'statusCode']);
    assert.equal('catalog_check' in r, false);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

test('#5888: la URL de Gemini incorpora ?pageSize=1000 sin dejar de ser literal (cond. 8)', () => {
    const spec = livePing.PROVIDER_PING_ENDPOINTS['gemini-google'];
    assert.equal(spec.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    // Sigue sin nada derivado de config ni de env.
    assert.ok(!/process\.env/.test(String(spec.url)));
});

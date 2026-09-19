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

// #6861 — Provider HTTP FICTICIO para el camino por API key.
//
// Tras #6563 (baja de cerebras/nvidia-nim) y #6861 (retiro del shim HTTP de
// Google AI Studio) el plantel entero es CLI-OAuth: anthropic, codex y
// antigravity se prueban por el probe del CLI y `ping()` hace short-circuit
// antes de cualquier HTTP. El camino HTTP (clasificación de status, throttle
// facturable, endpoints literales anti-SSRF, cruce de catálogo) se conserva
// como infraestructura, así que para cubrirlo inyectamos un provider de
// prueba `fake-http` por el hook `_setPingEndpointsForTesting` (spec local con
// URL https literal en un TLD reservado, RFC 2606) y hacemos que `getRawKey`
// le lea la key del mismo archivo de secrets del test (forma canónica
// `providers['fake-http'].api_key`): el provider no tiene spec en
// MANAGED_KEYS, así que la lectura real daría `null` siempre. Ningún camino
// de runtime ve ni el spec ni la key; todo se restaura al salir del helper.
const secretsRw = require('../multi-provider/secrets-rw');
const FAKE_PROVIDER = 'fake-http';
const FAKE_KEY = 'fk-test-1234567890abcdef0000';
const FAKE_KEYS = { providers: { [FAKE_PROVIDER]: { api_key: FAKE_KEY } } };
const REAL_GET_RAW_KEY = secretsRw.getRawKey;

function fakeSpec(overrides = {}) {
    return {
        url: 'https://ping.fake-http.invalid/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ authorization: `Bearer ${key}` }),
        // Sin overrides por provider: la clasificación es la genérica del
        // clasificador universal (#3486).
        interpret: (status, bodyExcerpt) => livePing._classifyForLivePing(FAKE_PROVIDER, status, bodyExcerpt),
        ...overrides,
    };
}

function readFakeKey({ provider, secretsPath }) {
    try {
        const data = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        const entry = data && data.providers && data.providers[provider];
        return (entry && typeof entry.api_key === 'string' && entry.api_key) || null;
    } catch { return null; }
}

async function withFakeHttpProvider(fn, { spec } = {}) {
    livePing._setPingEndpointsForTesting({ [FAKE_PROVIDER]: fakeSpec(spec) });
    secretsRw.getRawKey = (args) => ((args && args.provider === FAKE_PROVIDER)
        ? readFakeKey(args)
        : REAL_GET_RAW_KEY(args));
    try { return await fn(); } finally {
        secretsRw.getRawKey = REAL_GET_RAW_KEY;
        livePing._resetPingEndpointsForTesting();
    }
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
    assert.equal(livePing.isAllowedProvider('antigravity'), true);
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
    // #4402 — `openai` pasó a auth_mode:'oauth' (short-circuit CLI). #6563 /
    // #6861 — ya no queda provider api_key en el plantel: se ejercita el gate
    // con el provider ficticio inyectado (ver helper arriba). Sin key en el
    // archivo el veredicto es `no_key_configured`, nunca `invalid_credentials`.
    const r = await withFakeHttpProvider(() =>
        livePing.ping({ provider: FAKE_PROVIDER, secretsPath: f }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_key_configured');
    assert.equal(r.provider, FAKE_PROVIDER);
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
    assert.equal(livePing.isAllowedProvider('antigravity'), true);
    assert.equal(livePing.isAllowedProvider('cerebras'), false, 'cerebras retirado en #6563');
    assert.equal(livePing.isAllowedProvider('nvidia-nim'), false, 'nvidia-nim retirado en #6563');
});

// Tests "ping Groq con ..." se eliminaron en #3353 — Groq descontinuado.

test('ping Antigravity usa el probe CLI-OAuth y no una API key HTTP (#6861: sin shim de AI Studio)', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    // Aunque el archivo traiga una key de Google (resto de la config vieja),
    // antigravity no la lee: no tiene endpoint HTTP ni key gestionada.
    writeKeys(f, { providers: { google: { api_key: 'AIzaSyTest_1234567890abcdef000' } } });
    let httpCalls = 0;
    const r = await livePing.ping({
        provider: 'antigravity',
        secretsPath: f,
        cliProbe: () => false,
        httpImpl: () => { httpCalls++; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
    assert.equal(r.provider, 'antigravity');
    assert.equal(httpCalls, 0);
});

// ─── Camino HTTP por API key (clasificación de status) ───────────────────────
// #6861 — se ejercita con el provider ficticio `fake-http` (helper arriba).

test('ping HTTP con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const r = await withFakeHttpProvider(() =>
        livePing.ping({ provider: FAKE_PROVIDER, secretsPath: f, httpImpl: fakeHttp({ status: 200 }) }));
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
    assert.equal(r.provider, FAKE_PROVIDER);
});

test('ping HTTP con 401 → invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const r = await withFakeHttpProvider(() =>
        livePing.ping({ provider: FAKE_PROVIDER, secretsPath: f, httpImpl: fakeHttp({ status: 401 }) }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping HTTP con 403 → forbidden', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const r = await withFakeHttpProvider(() =>
        livePing.ping({ provider: FAKE_PROVIDER, secretsPath: f, httpImpl: fakeHttp({ status: 403 }) }));
    assert.equal(r.reason, 'forbidden');
});

test('ping HTTP con 429 + insufficient_quota → quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER,
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }),
    }));
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping HTTP con 429 plain → rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER,
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }),
    }));
    assert.equal(r.reason, 'rate_limited');
});

test('el spec HTTP inyectado manda la key en header y la URL literal, sin query con la key', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, FAKE_KEYS);
    const seen = [];
    const http = {
        request(opts, cb) {
            seen.push(opts);
            return fakeHttp({ status: 200 }).request(opts, cb);
        },
    };
    await withFakeHttpProvider(() => livePing.ping({ provider: FAKE_PROVIDER, secretsPath: f, httpImpl: http }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].hostname, 'ping.fake-http.invalid');
    assert.equal(seen[0].path, '/v1/models');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(seen[0].path.includes(FAKE_KEY), false, 'la key nunca viaja en la URL');
});

test('#6563 / #6861 — PROVIDER_PING_ENDPOINTS no conserva endpoints de providers retirados ni el shim de AI Studio', () => {
    assert.equal('cerebras' in livePing.PROVIDER_PING_ENDPOINTS, false);
    assert.equal('nvidia-nim' in livePing.PROVIDER_PING_ENDPOINTS, false);
    // #6861 — antigravity es CLI-OAuth (`agy models`): NO tiene endpoint HTTP,
    // y el id viejo tampoco sobrevive.
    assert.equal('antigravity' in livePing.PROVIDER_PING_ENDPOINTS, false);
    assert.equal('gemini-google' in livePing.PROVIDER_PING_ENDPOINTS, false);
    assert.deepEqual(Object.keys(livePing.PROVIDER_PING_ENDPOINTS).sort(), ['anthropic', 'openai']);
});

test('#6861 — el hook de test de endpoints sólo acepta URLs https literales y se resetea', () => {
    for (const mala of ['http://evil', 'file:///etc/passwd', 'no-es-url', '']) {
        assert.throws(() => livePing._setPingEndpointsForTesting({ x: { url: mala } }), /https/);
    }
    // Un throw no deja la tabla a medias: sigue la de producción.
    assert.equal(livePing.isAllowedProvider('x'), false);
    livePing._setPingEndpointsForTesting({ [FAKE_PROVIDER]: fakeSpec() });
    try {
        assert.equal(livePing.isAllowedProvider(FAKE_PROVIDER), true);
        // Los OAuth siguen permitidos por MANAGED_KEYS, no por la tabla inyectada.
        assert.equal(livePing.isAllowedProvider('antigravity'), true);
    } finally {
        livePing._resetPingEndpointsForTesting();
    }
    assert.equal(livePing.isAllowedProvider(FAKE_PROVIDER), false, 'tras el reset el provider ficticio desaparece');
});

// #6861 — caso retirado con el shim HTTP de AI Studio: "Gemini usa GET de
// listado de modelos (SR-3)". Antigravity ya no se pinguea por HTTP.

test('PROVIDER_PING_ENDPOINTS solo expone URLs HTTPS literales hardcoded (anti-SSRF)', () => {
    for (const [provider, spec] of Object.entries(livePing.PROVIDER_PING_ENDPOINTS)) {
        assert.ok(spec.url.startsWith('https://'), `${provider} url debe ser HTTPS literal`);
        assert.equal(typeof spec.url, 'string', `${provider} url debe ser string literal`);
        // El URL no debe tener placeholders ni variables.
        assert.ok(!spec.url.includes('${'), `${provider} url no debe interpolar variables`);
        assert.ok(!spec.url.includes('{'), `${provider} url no debe tener placeholders`);
    }
});

// #6861 — caso retirado con el shim HTTP de AI Studio: "Gemini-Google usa
// header x-goog-api-key, NUNCA query string (SR-2)". La invariante genérica
// (key en header, nunca en la URL) se cubre con el spec inyectado más arriba.

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
    writeKeys(f, FAKE_KEYS);
    // El spec SABE extraer catálogo: sin `expectModels` igual no lo baja.
    const spec = { catalogExtract: (json) => (json.data || []).map((m) => m.id) };
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER,
        secretsPath: f,
        httpImpl: fakeHttp({ status: 200, body: '{"data":[{"id":"modelo-vivo"}]}' }),
    }), { spec });
    assert.deepEqual(Object.keys(r).sort(), ['latency_ms', 'ok', 'provider', 'reason', 'statusCode']);
    assert.equal('catalog_check' in r, false);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

// #6861 — caso retirado con el shim HTTP de AI Studio: "la URL de Gemini
// incorpora ?pageSize=1000 sin dejar de ser literal (cond. 8)". La cond. 8
// (URLs literales https, sin interpolación) sigue cubierta para la tabla de
// producción por 'PROVIDER_PING_ENDPOINTS solo expone URLs HTTPS literales'.

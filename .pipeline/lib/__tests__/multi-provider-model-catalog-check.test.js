// =============================================================================
// multi-provider-model-catalog-check.test.js — #5888
//
// Barrera que detecta un modelo configurado que ya no está en el catálogo vivo
// de su provider, ANTES de que mate agentes.
//
// Contexto de por qué existe: `deepseek-ai/deepseek-v4-pro` llegó a EOL el
// 2026-08-07 y nadie se enteró hasta que agentes sanos empezaron a morir con
// HTTP 410 y el pulpo los sintetizó como rechazos de código.
//
// CERO RED (CA-12): todo el HTTP va por un `httpImpl` inyectado y los catálogos
// salen de fixtures locales con la forma REAL de cada provider.
//
// #6563 — cerebras y nvidia-nim (los providers api_key que ejercían el cruce
// por HTTP) se retiraron del plantel; el único provider en alcance del cruce es
// antigravity. El modelo muerto es `gemini-2.5-flash` (id del Gemini CLI
// gratuito retirado, ausente del catálogo de Antigravity).
//
// #6861 — el shim HTTP de Google AI Studio se RETIRÓ: antigravity es CLI-OAuth
// con `catalog_probe: 'agy'` y su catálogo entra al cruce por el round-trip
// `agy models` (`probeCliProviderLive` → `cli_probe.models`, #6857/#7289), no
// por HTTP. Por eso este archivo tiene DOS carriles:
//   - Integración real (health-cron / runOnce / tickIfDue): antigravity con su
//     spec real, `cliProbe` + `catalogProbe` inyectados y el catálogo REAL del
//     CLI (`fixtures/agy-models-2026-09-16.tsv`) como fuente.
//   - Rama HTTP genérica de `ping()` / `_crossCheckCatalog` (descarga del
//     catálogo, cap de bytes, contención del body, fail-open): se conserva como
//     infraestructura sin consumidor vivo, así que se ejercita con un provider
//     FICTICIO `fake-http` inyectado por `_setPingEndpointsForTesting` (spec
//     local + `fixtures/catalog-antigravity.json` como catálogo de fixture) —
//     mismo patrón que multi-provider-live-ping.test.js.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const livePing = require('../multi-provider/live-ping');
const healthAlerts = require('../multi-provider/health-alerts');
const healthCron = require('../multi-provider/health-cron');
const secretsRw = require('../multi-provider/secrets-rw');
const agyCatalog = require('../multi-provider/agy-catalog');
const dispatch = require('../agent-launcher/dispatch-with-fallback');
const providersView = require('../../views/dashboard/providers');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
const rawFixture = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

// Catálogo del provider FICTICIO (rama HTTP): `{ models: [{ name: 'models/<id>' }] }`.
const CATALOG_FIXTURE = readFixture('catalog-antigravity.json');
// Catálogo REAL de Antigravity (rama `agy models`): ids del snapshot del CLI.
const AGY_IDS = agyCatalog.parseAgyModelsOutput(rawFixture('agy-models-2026-09-16.tsv')).map((m) => m.id);
const AGENT_MODELS = readFixture('agent-models-catalog-check.json');

const DEAD_MODEL = 'gemini-2.5-flash';
const LIVE_MODEL = 'gemini-3.8-flash-medium';

// -----------------------------------------------------------------------------
// #6861 — Provider HTTP FICTICIO para la rama HTTP del cruce (ver header).
// `SPEC_FAKE` es la spec que `ping()` usa por el hook de test; su
// `catalogExtract` entiende la forma del fixture local. `getRawKey` le lee la
// key del archivo canónico del test (`providers['fake-http'].api_key`): el
// provider no tiene spec en MANAGED_KEYS, así que la lectura real daría null.
// -----------------------------------------------------------------------------
const FAKE_PROVIDER = 'fake-http';
const FAKE_KEYS = { providers: { [FAKE_PROVIDER]: { api_key: 'fk-test-aaaaaaaaaaaaaaaaaaaa' } } };
const SPEC_FAKE = Object.freeze({
    url: 'https://ping.fake-http.invalid/v1/models',
    method: 'GET',
    body: () => null,
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    interpret: (status, bodyExcerpt) => livePing._classifyForLivePing(FAKE_PROVIDER, status, bodyExcerpt),
    catalogExtract: (json) => (Array.isArray(json && json.models) ? json.models : [])
        .map((m) => ((m && typeof m.name === 'string') ? m.name.replace(/^models\//, '') : null))
        .filter(Boolean),
});
const REAL_GET_RAW_KEY = secretsRw.getRawKey;
function readFakeKey({ provider, secretsPath }) {
    try {
        const data = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        const entry = data && data.providers && data.providers[provider];
        return (entry && typeof entry.api_key === 'string' && entry.api_key) || null;
    } catch { return null; }
}
async function withFakeHttpProvider(fn) {
    livePing._setPingEndpointsForTesting({ [FAKE_PROVIDER]: SPEC_FAKE });
    secretsRw.getRawKey = (args) => ((args && args.provider === FAKE_PROVIDER)
        ? readFakeKey(args)
        : REAL_GET_RAW_KEY(args));
    try { return await fn(); } finally {
        secretsRw.getRawKey = REAL_GET_RAW_KEY;
        livePing._resetPingEndpointsForTesting();
    }
}

// -----------------------------------------------------------------------------
// #6861 — Carril REAL: antigravity por `agy models`. `agyProbe(ids)` devuelve
// la forma que produce `agy-catalog-probe.probeAgyCatalog` con un catálogo
// poblado; `agyProbeSinCatalogo()` la de "instalado sin licencia / catálogo
// vacío". `hermetic(dir)` fija todo lo que `runOnce` resolvería por ambiente
// (plan probe, cuota, primario) para que el test no dependa del host.
// -----------------------------------------------------------------------------
const T0_ISO = '2026-08-13T13:00:00.000Z';
function agyProbe(ids) {
    return async () => ({
        ok: true, reason: 'cli_catalog_ok', detail: 'catalog_ok',
        models: ids.slice(), model_count: ids.length, latency_ms: 1500,
        checked_at: T0_ISO, cached: false, launcher_kind: 'native-exe', cli_version: '1.2.4',
    });
}
function agyProbeSinCatalogo() {
    return async () => ({
        ok: false, reason: 'cli_license_unavailable', detail: 'empty_catalog',
        models: [], model_count: 0, latency_ms: 900, checked_at: T0_ISO, cached: false,
    });
}
function hermetic(dir, catalogProbe) {
    return {
        stateDir: path.join(dir, 'state'),
        auditDir: path.join(dir, 'audit'),
        secretsPath: path.join(dir, 'config.json'),
        cliProbe: () => true,
        catalogProbe,
        planProbe: async () => ({ reason_code: 'plan_tier_unknown', checked_at: T0_ISO }),
        quotaAssessImpl: () => ({ adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null }),
        defaultProvider: 'anthropic',
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-catalog-')); }

// Resultado crudo de `doRequest` tal como lo recibe `crossCheckCatalog`.
function reqResult({ statusCode = 200, body = null, truncated = false } = {}) {
    return {
        statusCode,
        bodyExcerpt: '',
        catalogRaw: body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
        catalogTruncated: truncated,
    };
}

// -----------------------------------------------------------------------------
// Fake HTTP con streaming real: emite el body por chunks, respeta `destroy()`
// y emite `'close'` (NO `'end'`) cuando lo destruyen — que es exactamente lo
// que hace `http.IncomingMessage` y el motivo de R-F.
// -----------------------------------------------------------------------------
function fakeHttp({ status = 200, body = '', chunkSize = 0, error = null } = {}) {
    const calls = [];
    return {
        calls,
        request(opts, cb) {
            calls.push(opts);
            const req = new EventEmitter();
            req.write = () => {};
            req.destroy = (e) => { req.emit('error', e || new Error('destroyed')); };
            req.end = () => {
                process.nextTick(() => {
                    if (error) { req.emit('error', error); return; }
                    const res = new EventEmitter();
                    res.statusCode = status;
                    res.destroyed = false;
                    res.destroy = () => {
                        if (res.destroyed) return;
                        res.destroyed = true;
                        setImmediate(() => res.emit('close'));
                    };
                    const buf = Buffer.from(body, 'utf8');
                    const size = chunkSize > 0 ? chunkSize : Math.max(buf.length, 1);
                    let off = 0;
                    const pump = () => {
                        if (res.destroyed) return;
                        if (off >= buf.length) { res.emit('end'); return; }
                        const c = buf.subarray(off, off + size);
                        off += size;
                        res.emit('data', c);
                        setImmediate(pump);
                    };
                    cb(res);
                    setImmediate(pump);
                });
            };
            return req;
        },
    };
}

function secretsWith(dir, keys) {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(keys));
    return f;
}

test.beforeEach(() => livePing._resetPingThrottle());

// =============================================================================
// CA-1 — El cruce detecta el modelo muerto donde realmente mata: el fallback
// =============================================================================

test('CA-1: el modelo muerto se detecta aunque exista SÓLO como fallbacks[].model_override', () => {
    const byProvider = healthCron.configuredModelsByProvider(AGENT_MODELS);
    const gemini = byProvider.get('antigravity');
    assert.ok(gemini, 'antigravity debe tener modelos configurados');
    assert.ok(gemini.has(DEAD_MODEL), 'el modelo del fallback debe entrar al cruce');
    // Y en el fixture NO está en ningún otro lado: si el cruce sólo mirara
    // `providers[].model` este assert fallaría.
    assert.notEqual(AGENT_MODELS.providers['antigravity'].model, DEAD_MODEL);
    assert.equal(AGENT_MODELS.providers['antigravity'].alternative_models.includes(DEAD_MODEL), false);

    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE,
        result: reqResult({ body: CATALOG_FIXTURE }),
        expectModels: Array.from(gemini).sort(),
    });
    assert.equal(out.ok, true);
    const dead = out.models.filter((m) => !m.alive).map((m) => m.model_id);
    assert.deepEqual(dead, [DEAD_MODEL]);
});

test('CA-1: `configuredModelsByProvider` cubre las 4 fuentes, una por fuente', () => {
    const by = healthCron.configuredModelsByProvider(AGENT_MODELS);
    // fuente 1 — providers[].model
    assert.ok(by.get('antigravity').has(LIVE_MODEL));
    // fuente 2 — providers[].alternative_models[]
    assert.ok(by.get('antigravity').has('gemini-3.7-flash-medium'));
    // fuente 3 — skills[].model_override
    assert.ok(by.get('antigravity').has('gemini-3.1-pro-low'));
    // fuente 4 — skills[].fallbacks[].model_override
    assert.ok(by.get('antigravity').has(DEAD_MODEL));
});

test('CA-1: el cruce es por par (provider, model_id) — un id de Anthropic no se busca en el catálogo de Antigravity', () => {
    // `claude-opus-4-7` vive en Anthropic y NO está en el catálogo del fixture.
    // Si el cruce usara el id suelto contra un catálogo global, lo marcaría muerto.
    const by = healthCron.configuredModelsByProvider(AGENT_MODELS);
    assert.ok(by.get('anthropic').has('claude-opus-4-7'), 'el id existe en el config, bajo su provider');
    const enAntigravity = livePing._crossCheckCatalog({
        spec: SPEC_FAKE,
        result: reqResult({ body: CATALOG_FIXTURE }),
        expectModels: healthCron.expectModelsForPing(AGENT_MODELS).get('antigravity'),
    });
    assert.equal(enAntigravity.models.some((m) => m.model_id === 'claude-opus-4-7'), false,
        'un modelo de Anthropic no debe siquiera evaluarse contra el catálogo de Antigravity');
    assert.deepEqual(enAntigravity.models.filter((m) => !m.alive), [{ model_id: DEAD_MODEL, alive: false }],
        'sólo el par (antigravity, modelo muerto) sale como ausente');
});

test('CA-1: `expectModelsForPing` sólo cubre el provider en alcance y usa el mapeo de nombres', () => {
    const m = healthCron.expectModelsForPing(AGENT_MODELS);
    // #6563 — cerebras y nvidia-nim retirados: queda antigravity.
    assert.deepEqual(Array.from(m.keys()), ['antigravity']);
    assert.equal(m.has('anthropic'), false);
    assert.equal(m.has('openai'), false);
    assert.equal(m.has('openai-codex'), false);
});

// =============================================================================
// CA-2 — El catálogo se parsea con la forma REAL de cada provider
// =============================================================================

// #6861 — caso retirado con el shim HTTP de AI Studio: "CA-2/G-1: con el
// catálogo Gemini real (models[].name con prefijo), gemini-3.8-flash-medium NO
// se marca ausente". El extractor `models[].name` era del shim; la forma REAL
// de Antigravity es la salida TSV de `agy models`, cubierta en
// agy-catalog.test.js (parser) y acá en el carril real (CA-2 de abajo).

// #6861 — caso retirado con el shim HTTP de AI Studio: "CA-2: Gemini usa
// `models[].name` — el extractor es por provider y no acepta el shape
// OpenAI-compat". Sin providers HTTP no hay extractores por provider en runtime.

test('CA-2 (#6861): el catálogo REAL de Antigravity es el de `agy models` y entra al cruce por cli_probe, sin HTTP', async () => {
    // El fixture TSV es la salida cruda del CLI: los ids vivos del config están
    // y el muerto no. Ese es el catálogo que alimenta el cruce, no el de AI Studio.
    for (const vivo of ['gemini-3.8-flash-medium', 'gemini-3.7-flash-medium', 'gemini-3.1-pro-low']) {
        assert.ok(AGY_IDS.includes(vivo), `${vivo} está en agy models`);
    }
    assert.equal(AGY_IDS.includes(DEAD_MODEL), false, 'el id del Gemini CLI gratuito no existe en Antigravity');

    let httpCalls = 0;
    const results = await healthCron.pingAllProviders({
        providers: [secretsRw.MANAGED_KEYS.find((k) => k.provider === 'antigravity')],
        cliProbe: () => true,
        catalogProbe: agyProbe(AGY_IDS),
        httpImpl: { request() { httpCalls++; throw new Error('no debe haber HTTP'); } },
        planProbe: async () => ({ reason_code: 'plan_tier_unknown', checked_at: T0_ISO }),
        quotaAssessImpl: () => ({ adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null }),
        defaultProvider: 'anthropic',
        now: Date.parse(T0_ISO),
        checkCatalog: true,
        expectModelsByProvider: healthCron.expectModelsForPing(AGENT_MODELS),
    });
    const g = results.find((r) => r.provider === 'antigravity');
    assert.equal(httpCalls, 0, 'antigravity nunca pasa por el camino HTTP');
    assert.equal(g.reason_code, 'cli_catalog_ok');
    assert.equal(g.cli_probe.kind, 'agy');
    assert.equal(g.catalog_check.state, 'not_in_catalog');
    assert.deepEqual(g.catalog_check.models.filter((m) => !m.alive), [{ model_id: DEAD_MODEL, alive: false }]);
});

test('CA-2/G-2/R-H: `nextPageToken` no vacío ⇒ model_check_unavailable, jamás not_in_catalog', () => {
    const paginado = { ...CATALOG_FIXTURE, nextPageToken: 'CAESBk1PUkU=' };
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE,
        result: reqResult({ body: paginado }),
        expectModels: ['gemini-3.8-flash-medium'],
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'paginated');
    assert.deepEqual(out.models, []);
});

// #6861 — caso retirado con el shim HTTP de AI Studio: "la URL de Gemini lleva
// ?pageSize=1000 literal". Queda la parte genérica de la cond. 8:
test('cond. 8: las URLs de ping que quedan son literales https, y antigravity no tiene ninguna', () => {
    assert.equal('antigravity' in livePing.PROVIDER_PING_ENDPOINTS, false, '#6861: antigravity se prueba por `agy models`, no por HTTP');
    assert.equal('gemini-google' in livePing.PROVIDER_PING_ENDPOINTS, false, '#6861: el id viejo tampoco vuelve');
    assert.deepEqual(Object.keys(livePing.PROVIDER_PING_ENDPOINTS).sort(), ['anthropic', 'openai']);
    for (const [prov, spec] of Object.entries(livePing.PROVIDER_PING_ENDPOINTS)) {
        assert.equal(typeof spec.url, 'string', `${prov}: url literal`);
        assert.match(spec.url, /^https:\/\//, `${prov}: solo HTTPS`);
    }
});

// =============================================================================
// CA-3 — Matriz fail-open exhaustiva, UNA FILA POR CASO
// =============================================================================

test('CA-3 fila 1: 200 + catálogo completo + id presente ⇒ vigente, sin alerta', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE, result: reqResult({ body: CATALOG_FIXTURE }), expectModels: [LIVE_MODEL],
    });
    assert.equal(out.ok, true);
    assert.equal(out.reason_code, null);
    assert.deepEqual(out.models, [{ model_id: LIVE_MODEL, alive: true }]);
});

test('CA-3 fila 2: 200 + catálogo completo + id ausente ⇒ model_not_in_catalog', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE, result: reqResult({ body: CATALOG_FIXTURE }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, [{ model_id: DEAD_MODEL, alive: false }]);
    const built = healthCron.buildCatalogCheck(out, '2026-08-13T13:00:00.000Z');
    assert.equal(built.state, 'not_in_catalog');
    assert.equal(built.reason_code, 'model_not_in_catalog');
});

test('CA-3 fila 3: body no parseable ⇒ model_check_unavailable', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE, result: reqResult({ body: '<html><body>502 Bad Gateway</body></html>' }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'unparseable');
});

test('CA-3 fila 4: body truncado ⇒ model_check_unavailable', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE, result: reqResult({ body: CATALOG_FIXTURE, truncated: true }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'truncated');
});

for (const status of [401, 403, 429, 500]) {
    test(`CA-3 fila 5: HTTP ${status} ⇒ model_check_unavailable (nunca dead)`, () => {
        const out = livePing._crossCheckCatalog({
            spec: SPEC_FAKE, result: reqResult({ statusCode: status, body: CATALOG_FIXTURE }), expectModels: [DEAD_MODEL],
        });
        assert.equal(out.ok, false);
        assert.equal(out.reason_code, 'model_check_unavailable');
        assert.equal(out.detail, 'http_status');
        assert.deepEqual(out.models, []);
    });
}

test('CA-3 fila 6: timeout / error de red ⇒ model_check_unavailable, nunca dead', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER,
        secretsPath,
        httpImpl: fakeHttp({ error: Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }) }),
        expectModels: [DEAD_MODEL],
    }));
    assert.equal(r.reason, 'timeout');
    assert.equal(r.catalog_check.reason_code, 'model_check_unavailable');
    assert.equal(r.catalog_check.detail, 'request_failed');
    assert.deepEqual(r.catalog_check.models, []);
});

test('CA-3 fila 7: provider sin key configurada ⇒ model_check_unavailable (no "todo bien")', () => {
    // El ping corta antes del HTTP (`no_key_configured`), así que no hay
    // `catalog_check` en el resultado. El cron lo traduce a "no verificable".
    const built = healthCron.buildCatalogCheck(undefined, '2026-08-13T13:00:00.000Z');
    assert.equal(built.state, 'unavailable');
    assert.equal(built.reason_code, 'model_check_unavailable');
});

test('CA-3/R-G: catálogo vacío ⇒ model_check_unavailable, NO "todos los modelos muertos"', () => {
    // Un provider que cambia el shape de su respuesta devolvería `[]` y marcaría
    // TODOS los modelos como muertos: alerta masiva falsa que entrena al
    // operador a ignorar la barrera. Es también la defensa de la cond. 1.
    for (const body of [{ models: [] }, { object: 'list', data: [] }, {}]) {
        const out = livePing._crossCheckCatalog({
            spec: SPEC_FAKE, result: reqResult({ body }), expectModels: [DEAD_MODEL, LIVE_MODEL],
        });
        assert.equal(out.reason_code, 'model_check_unavailable');
        assert.equal(out.detail, 'empty_catalog');
        assert.deepEqual(out.models, []);
    }
});

test('CA-3: el extractor que lanza ⇒ model_check_unavailable, no propaga la excepción', () => {
    const specRoto = { catalogExtract: () => { throw new Error('shape cambiado'); } };
    const out = livePing._crossCheckCatalog({
        spec: specRoto, result: reqResult({ body: CATALOG_FIXTURE }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'extractor_error');
});

test('CA-3: NINGUNA ruta de la matriz produce not_in_catalog sin catálogo completo', () => {
    const rutas = [
        reqResult({ statusCode: 401, body: CATALOG_FIXTURE }),
        reqResult({ statusCode: 403, body: CATALOG_FIXTURE }),
        reqResult({ statusCode: 500, body: CATALOG_FIXTURE }),
        reqResult({ body: 'no-json' }),
        reqResult({ body: CATALOG_FIXTURE, truncated: true }),
        reqResult({ body: { models: [] } }),
        reqResult({ body: { ...CATALOG_FIXTURE, nextPageToken: 'x' } }),
        reqResult({ body: null }),
    ];
    for (const r of rutas) {
        const built = healthCron.buildCatalogCheck(
            livePing._crossCheckCatalog({ spec: SPEC_FAKE, result: r, expectModels: [DEAD_MODEL] }),
            '2026-08-13T13:00:00.000Z',
        );
        assert.notEqual(built.state, 'not_in_catalog');
        assert.equal(built.reason_code, 'model_check_unavailable');
    }
});

// =============================================================================
// CA-4 — Los reason codes sobreviven al sanitize y NO gatean el provider
// =============================================================================

test('CA-4/cond.3: sanitizeReasonCode NO colapsa los codes nuevos a `unknown`', () => {
    // Sin esto la alerta se emitiría igual y los tests pasarían aparentando
    // funcionar — `sanitizeReasonCode` colapsa en silencio, sin error ni log.
    assert.equal(healthAlerts.sanitizeReasonCode('model_not_in_catalog'), 'model_not_in_catalog');
    assert.equal(healthAlerts.sanitizeReasonCode('model_check_unavailable'), 'model_check_unavailable');
});

test('CA-4/R-C/S-E: pertenencia ASIMÉTRICA — ∈ ALLOWED_REASON_CODES y ∉ DURABLE_RED_REASONS', () => {
    for (const code of ['model_not_in_catalog', 'model_check_unavailable']) {
        assert.equal(healthAlerts.ALLOWED_REASON_CODES.has(code), true, `${code} debe sobrevivir al sanitize`);
        assert.equal(dispatch.DURABLE_RED_REASONS.has(code), false,
            `${code} NO puede ser rojo durable: sacaría al provider ENTERO de la cascada de fallback por un solo modelo caído`);
    }
});

// =============================================================================
// CA-5 / CA-16 — Un modelo muerto no pone rojo al provider
// =============================================================================

test('CA-5: un evento de modelo no cambia `state` ni `reason_code` del provider en el snapshot', async () => {
    const dir = tmpDir();
    secretsWith(dir, {});
    // #6861 — carril real: antigravity por `agy models` (catálogo del CLI, sin
    // el modelo del fallback).
    const result = await healthCron.runOnce({
        ...hermetic(dir, agyProbe(AGY_IDS)),
        checkCatalog: true,
        agentModelsConfig: AGENT_MODELS,
        now: Date.parse(T0_ISO),
    });
    const antigravity = result.snapshot.providers.find((p) => p.provider === 'antigravity');
    assert.equal(antigravity.state, 'green', 'Antigravity sigue sirviendo el resto de su catálogo');
    assert.equal(antigravity.reason_code, 'cli_catalog_ok', 'el eje de salud queda intacto');
    assert.equal(antigravity.catalog_check.state, 'not_in_catalog', 'el evento viaja por el eje de modelo');
    assert.equal(antigravity.catalog_check.reason_code, 'model_not_in_catalog');
});

// =============================================================================
// CA-6 / S-A — sanitizeModelId y la alerta degradada
// =============================================================================

test('CA-6/S-A: sanitizeModelId rechaza metacaracteres Markdown, HTML, mayúsculas y >64', () => {
    const malos = [
        'model`whoami`', 'model[x](http://evil)', 'a*b*c', 'model_id_con_guion_bajo',
        'Model-Mayus', '<script>alert(1)</script>', '', '-empieza-con-guion',
        'a'.repeat(65), 'modelo con espacios', 'model\nid', 'model;rm -rf /',
        null, undefined, 42, {},
    ];
    for (const m of malos) {
        assert.equal(healthAlerts.sanitizeModelId(m), null, `debe rechazar: ${String(m).slice(0, 40)}`);
    }
    // Los ids reales del config del plantel + uno con `/` de vendor (forma que
    // usaban los providers retirados en #6563 y que la regex sigue admitiendo).
    for (const m of ['claude-opus-4-7', 'gpt-5.5', 'gemini-3.8-flash-medium', 'gpt-5.4-mini',
        'gemini-3.1-pro-low', DEAD_MODEL, 'vendor/modelo-con-barra-0731']) {
        assert.equal(healthAlerts.sanitizeModelId(m), m, `debe aceptar: ${m}`);
    }
});

test('CA-6/S-A: con sanitizeModelId → null la alerta IGUAL se emite, sin el id crudo', () => {
    const dir = tmpDir();
    const crudo = 'evil`[click](http://evil)`';
    const decision = healthAlerts.decideModelEvent({
        provider: 'antigravity',
        modelId: crudo,
        providerState: 'green',
        now: Date.parse('2026-08-13T13:00:00.000Z'),
        dedupFile: path.join(dir, 'dedup.json'),
    });
    assert.equal(decision.shouldEmit, true, 'fail-closed no significa silencio');
    assert.equal(decision.payload.model_id, null);
    const texto = healthCron.formatAlertText(decision.payload);
    assert.equal(texto.includes(crudo), false, 'jamás el id crudo');
    assert.equal(texto.includes('evil'), false);
    assert.match(texto, /identificador no representable/);
    assert.match(texto, /^⚠️/);
});

test('CA-6/CA-17: el texto de la alerta afirma que el provider sigue sano y nombra la consecuencia', () => {
    const dir = tmpDir();
    const decision = healthAlerts.decideModelEvent({
        provider: 'antigravity',
        modelId: DEAD_MODEL,
        providerState: 'green',
        now: Date.parse('2026-08-13T13:00:00.000Z'),
        dedupFile: path.join(dir, 'dedup.json'),
    });
    const texto = healthCron.formatAlertText(decision.payload);
    assert.match(texto, /^⚠️ \*Modelo fuera de catálogo\*/, 'la severidad la fija el eje-modelo, no el estado del provider');
    assert.ok(texto.includes('🟢 SANO'), 'el estado del provider se conserva, subordinado');
    assert.ok(texto.includes(DEAD_MODEL));
    assert.ok(texto.includes('como primario o como fallback'), 'el fallback es el caso que el operador no deduce solo');
    assert.ok(texto.includes('van a fallar al despachar'), 'nombra la consecuencia, no sólo el hecho');
    // UX-5: NO puede leerse como el mensaje rutinario de salud.
    assert.equal(/🩺 \*Multi-Provider Health\*/.test(texto), false);
    assert.equal(/`antigravity` → `GREEN`/.test(texto), false);
});

test('CA-17/R-D: la key de dedup del evento de modelo no colisiona con la del eje de salud', () => {
    const dir = tmpDir();
    const dedupFile = path.join(dir, 'dedup.json');
    const t0 = Date.parse('2026-08-13T13:00:00.000Z');

    const d1 = healthAlerts.decideModelEvent({ provider: 'antigravity', modelId: DEAD_MODEL, providerState: 'green', now: t0, dedupFile });
    assert.equal(d1.shouldEmit, true);
    healthAlerts.recordModelEvent({ provider: 'antigravity', modelId: DEAD_MODEL, sent: true, now: t0, dedupFile });

    // Dentro de la ventana de 24h no se repite (condición persistente, 1/día).
    const d2 = healthAlerts.decideModelEvent({ provider: 'antigravity', modelId: DEAD_MODEL, providerState: 'green', now: t0 + 6 * 3600e3, dedupFile });
    assert.equal(d2.shouldEmit, false);
    assert.equal(d2.reasonNoEmit, 'dedup_window');

    // …pero la alerta de SALUD del mismo provider sigue libre de emitir.
    const salud = healthAlerts.decide({ provider: 'antigravity', state: 'red', reasonCode: 'invalid_credentials', now: t0 + 60e3, dedupFile });
    assert.equal(salud.shouldEmit, true, 'el evento de modelo no puede suprimir la alerta de salud');

    // Y pasadas 24h el recordatorio vuelve.
    const d3 = healthAlerts.decideModelEvent({ provider: 'antigravity', modelId: DEAD_MODEL, providerState: 'green', now: t0 + 25 * 3600e3, dedupFile });
    assert.equal(d3.shouldEmit, true);
});

test('CA-17/D-3: model_check_unavailable NO emite a Telegram', () => {
    const dir = tmpDir();
    const enviados = [];
    const snapshot = {
        ts: '2026-08-13T13:00:00.000Z',
        providers: [{
            provider: 'antigravity', state: 'green', reason_code: 'authenticated',
            catalog_check: { state: 'unavailable', checked_at: '2026-08-13T13:00:00.000Z', reason_code: 'model_check_unavailable', models: [] },
        }],
    };
    healthCron.emitAlerts({
        snapshot, prevSnapshot: null,
        telegramSender: (p) => { enviados.push(p); return true; },
        dedupFile: path.join(dir, 'dedup.json'),
        now: Date.parse('2026-08-13T13:00:00.000Z'),
    });
    assert.deepEqual(enviados, [], 'la ausencia de señal no es un evento: alertar por ella entrena a ignorar el canal');
});

// =============================================================================
// CA-7 / cond. 1 — Alerta, NUNCA auto-mutación
// =============================================================================

test('CA-7: el flujo completo con catálogo vacío no modifica ningún archivo de config', async () => {
    const dir = tmpDir();
    const configFile = path.join(dir, 'agent-models.json');
    fs.writeFileSync(configFile, JSON.stringify(AGENT_MODELS, null, 2));
    const hashAntes = crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');

    secretsWith(dir, {});
    // Catálogo vacío de `agy models`: el peor caso — sin fail-open marcaría TODO
    // muerto. (#6861: carril real, sin HTTP.)
    const result = await healthCron.runOnce({
        ...hermetic(dir, agyProbeSinCatalogo()),
        checkCatalog: true,
        agentModelsConfig: JSON.parse(fs.readFileSync(configFile, 'utf8')),
        now: Date.parse(T0_ISO),
    });
    const antigravity = result.snapshot.providers.find((p) => p.provider === 'antigravity');
    assert.equal(antigravity.catalog_check.state, 'unavailable', 'sin catálogo no hay veredicto, no "todo muerto"');
    assert.equal(antigravity.catalog_check.reason_code, 'model_check_unavailable');
    assert.deepEqual(antigravity.catalog_check.models, []);

    const hashDespues = crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
    assert.equal(hashDespues, hashAntes, 'un catálogo vacío no puede DoSear el pipeline mutando su config');
});

// =============================================================================
// CA-10 — Cadencia desacoplada del health-ping
// =============================================================================

test('CA-10: isCatalogCheckDue — nunca corrió ⇒ debido; dentro del TTL ⇒ no', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    const ttlMs = 6 * 3600e3;
    assert.equal(healthCron.isCatalogCheckDue({ stateFile, ttlMs }), true);

    const now = Date.parse('2026-08-13T13:00:00.000Z');
    fs.writeFileSync(stateFile, JSON.stringify({ last_catalog_check_at: now }));
    assert.equal(healthCron.isCatalogCheckDue({ stateFile, now: now + 5 * 60e3, ttlMs }), false, 'el tick de 5 min no re-descarga');
    assert.equal(healthCron.isCatalogCheckDue({ stateFile, now: now + 5 * 3600e3, ttlMs }), false);
    assert.equal(healthCron.isCatalogCheckDue({ stateFile, now: now + 6 * 3600e3, ttlMs }), true);
});

test('CA-10: el TTL de catálogo tiene piso de 6h — un config equivocado no puede bajarlo', () => {
    assert.equal(healthCron.CATALOG_CHECK_DEFAULT_HOURS, 6);
    assert.equal(healthCron.CATALOG_CHECK_MIN_HOURS, 6);
    // El health-ping sigue en 5 min, sin tocar.
    assert.equal(healthCron.DEFAULT_INTERVAL_MINUTES, 5);
});

test('CA-10: dos ticks dentro del TTL ⇒ UN solo cruce de catálogo (el round-trip del health no lo re-dispara)', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    secretsWith(dir, {});
    // #6861 — carril real: el catálogo llega con el round-trip `agy models` de
    // CADA tick del health (5 min), pero el CRUCE (#5888) sólo corre cuando
    // vence su TTL de 6h. Lo observable es `catalog_check.checked_at` en el
    // snapshot y `last_catalog_check_at` en el estado del cron.
    const probeTicks = [];
    const catalogProbe = async (o) => { probeTicks.push(o.nowMs); return agyProbe(AGY_IDS)(); };
    const base = {
        ...hermetic(dir, catalogProbe),
        agentModelsConfig: AGENT_MODELS,
        jitter: 0, catalogTtlMs: 6 * 3600e3,
        // #5174 / #5801 — `intervalMs` explícito para que el test sea HERMÉTICO.
        // Sin él, `tickIfDue` cae a `readTickIntervalMs()` sin `configPath`, el
        // resolver baja por la cadena hasta `PIPELINE_REPO_ROOT` y termina
        // VALIDANDO la configuración del repo AMBIENTE — no la de este checkout.
        // Este test es sobre el TTL del catálogo, no sobre la cadencia ni sobre
        // el schema del config del host: cualquier endurecimiento de schema en
        // otra rama lo hacía fallar por un motivo ajeno a lo que asevera.
        // 5 min = `multi_provider.health.interval_minutes` del config real, o sea
        // el mismo valor que venía resolviendo por ambiente: sin cambio de conducta.
        intervalMs: 5 * 60e3,
    };
    const t0 = Date.parse(T0_ISO);
    const stateFile = path.join(stateDir, 'multi-provider-health-state.json');
    const ccOf = (r) => r.snapshot.providers.find((p) => p.provider === 'antigravity').catalog_check;
    const lastCheck = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).last_catalog_check_at;

    const r1 = await healthCron.tickIfDue({ ...base, now: t0 });
    assert.equal(ccOf(r1).checked_at, new Date(t0).toISOString(), '1er tick: cruce');
    assert.equal(lastCheck(), t0);

    const r2 = await healthCron.tickIfDue({ ...base, now: t0 + 10 * 60e3 });   // 10 min después
    assert.equal(ccOf(r2).checked_at, new Date(t0).toISOString(), 'el 2do tick no vuelve a cruzar el catálogo');
    assert.equal(lastCheck(), t0, 'el TTL del cruce no se reseteó');

    // Fuera del TTL sí vuelve a cruzar.
    const r3 = await healthCron.tickIfDue({ ...base, now: t0 + 7 * 3600e3 });
    assert.equal(ccOf(r3).checked_at, new Date(t0 + 7 * 3600e3).toISOString());
    assert.equal(lastCheck(), t0 + 7 * 3600e3);

    // El health SÍ hizo su round-trip en los tres ticks: el catálogo viene
    // "gratis" con él; lo que se acota es el cruce, no la salud.
    assert.deepEqual(probeTicks, [t0, t0 + 10 * 60e3, t0 + 7 * 3600e3]);
});

test('CA-10/R-E: carry-over — el tick intermedio conserva el catalog_check previo', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    secretsWith(dir, {});
    // #6861 — carril real (ver CA-10 de arriba).
    const base = {
        ...hermetic(dir, agyProbe(AGY_IDS)),
        agentModelsConfig: AGENT_MODELS,
        jitter: 0, catalogTtlMs: 6 * 3600e3,
        // #5174 / #5801 — `intervalMs` explícito para que el test sea HERMÉTICO.
        // Sin él, `tickIfDue` cae a `readTickIntervalMs()` sin `configPath`, el
        // resolver baja por la cadena hasta `PIPELINE_REPO_ROOT` y termina
        // VALIDANDO la configuración del repo AMBIENTE — no la de este checkout.
        // Este test es sobre el TTL del catálogo, no sobre la cadencia ni sobre
        // el schema del config del host: cualquier endurecimiento de schema en
        // otra rama lo hacía fallar por un motivo ajeno a lo que asevera.
        // 5 min = `multi_provider.health.interval_minutes` del config real, o sea
        // el mismo valor que venía resolviendo por ambiente: sin cambio de conducta.
        intervalMs: 5 * 60e3,
    };
    const t0 = Date.parse(T0_ISO);
    const r1 = await healthCron.tickIfDue({ ...base, now: t0 });
    const cc1 = r1.snapshot.providers.find((p) => p.provider === 'antigravity').catalog_check;
    assert.equal(cc1.state, 'not_in_catalog');
    assert.deepEqual(cc1.models.filter((m) => !m.alive), [{ model_id: DEAD_MODEL, alive: false }]);

    const r2 = await healthCron.tickIfDue({ ...base, now: t0 + 10 * 60e3 });
    const cc2 = r2.snapshot.providers.find((p) => p.provider === 'antigravity').catalog_check;
    assert.deepEqual(cc2, cc1, 'sin carry-over la celda parpadearía a "nunca verificada" cada 5 min');
});

test('CA-10: el comentario obsoleto de la cadencia ya no dice 15min', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'multi-provider', 'live-ping.js'), 'utf8');
    assert.equal(/corren cada 15\s*min/.test(src), false, '#4402 bajó el default a 5 min');
});

// =============================================================================
// CA-11 — Contención de los datos que vienen del tercero
// =============================================================================

test('CA-11/R-A: el catálogo del tercero NO aparece en el retorno de ping(), ni en el snapshot, ni en la alerta', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    // Marcador que sólo existe en el body del tercero, en ningún id nuestro.
    const MARCADOR = 'MARCADOR_SOLO_DEL_TERCERO';
    const bodyRemoto = JSON.stringify({
        models: [...CATALOG_FIXTURE.models, { name: 'models/otro-modelo-remoto', description: MARCADOR }],
    });

    // Rama HTTP (provider ficticio): el body crudo muere dentro de `ping()`.
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER, secretsPath,
        httpImpl: fakeHttp({ status: 200, body: bodyRemoto }),
        expectModels: [DEAD_MODEL],
    }));
    const serializado = JSON.stringify(r);
    assert.equal(serializado.includes(MARCADOR), false, 'nada del body crudo sale del módulo');
    assert.equal(serializado.includes('otro-modelo-remoto'), false, 'ni siquiera los ids remotos que no son nuestros');
    assert.equal('catalogRaw' in r, false);
    assert.deepEqual(r.catalog_check.models, [{ model_id: DEAD_MODEL, alive: false }],
        'sólo `{model_id, alive}` con ids NUESTROS');

    // Carril real (#6861): el catálogo de `agy models` entra por `cli_probe`.
    // El eje de modelo (`catalog_check` + alerta) sigue llevando SÓLO ids
    // nuestros. `cli_probe.models` es otra cosa: evidencia saneada del
    // round-trip, expuesta a propósito al dashboard (#6857) — ids filtrados
    // por regex, nunca texto del CLI.
    const result = await healthCron.runOnce({
        ...hermetic(dir, agyProbe([...AGY_IDS, 'otro-modelo-remoto'])),
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        now: Date.parse(T0_ISO),
    });
    const antigravity = result.snapshot.providers.find((p) => p.provider === 'antigravity');
    const snapSer = JSON.stringify(result.snapshot);
    assert.equal(snapSer.includes(MARCADOR), false, 'ni en el snapshot');
    assert.equal(/catalogRaw|catalog_raw|bodyExcerpt|body_excerpt/i.test(snapSer), false);
    assert.deepEqual(antigravity.catalog_check.models.map((m) => m.model_id).sort(),
        healthCron.expectModelsForPing(AGENT_MODELS).get('antigravity'),
        'el eje de modelo del snapshot sólo lleva los ids configurados');
    assert.equal(JSON.stringify(antigravity.catalog_check).includes('otro-modelo-remoto'), false);
    for (const a of result.alerts) {
        assert.equal(JSON.stringify(a.payload).includes(MARCADOR), false, 'ni en el payload de alerta');
        assert.equal(JSON.stringify(a.payload).includes('otro-modelo-remoto'), false);
    }
});

test('CA-11/R-B: el fragmento del body no-JSON no viaja en `detail` ni en nada que salga', async () => {
    // `JSON.parse` embebe un fragmento del body en su mensaje:
    // `Unexpected token '<', "<html><ti"... is not valid JSON`.
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    const SECRETO = 'FRAGMENTO_QUE_NO_DEBE_SALIR';
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER, secretsPath,
        httpImpl: fakeHttp({ status: 200, body: `<html><title>${SECRETO}</title></html>` }),
        expectModels: [DEAD_MODEL],
    }));
    assert.equal(r.catalog_check.detail, 'unparseable');
    assert.equal(JSON.stringify(r).includes(SECRETO), false);
    assert.ok(livePing.CATALOG_UNAVAILABLE_DETAILS.includes(r.catalog_check.detail),
        '`detail` es un enum cerrado nuestro');
});

test('CA-11/S-B: un catálogo con clave `__proto__` no rompe la detección ni contamina Object.prototype', () => {
    const envenenado = {
        models: [
            { name: 'models/__proto__' },
            { name: 'models/constructor' },
            { name: `models/${LIVE_MODEL}` },
        ],
    };
    const out = livePing._crossCheckCatalog({
        spec: SPEC_FAKE, result: reqResult({ body: envenenado }), expectModels: [DEAD_MODEL, LIVE_MODEL],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, [
        { model_id: DEAD_MODEL, alive: false },
        { model_id: LIVE_MODEL, alive: true },
    ], 'con un objeto plano indexado por id, `__proto__` daría "vivo" a cualquier modelo para siempre');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test('CA-11/S-C/R-F: un stream que supera MAX_CATALOG_BYTES destruye el socket y la promesa RESUELVE', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    // Body > 1 MiB, en chunks de 256 KiB.
    const gigante = '{"models":[' + '{"name":"models/x"},'.repeat(80_000) + '{"name":"models/y"}]}';
    assert.ok(Buffer.byteLength(gigante) > livePing.MAX_CATALOG_BYTES);
    const t0 = Date.now();
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER, secretsPath,
        httpImpl: fakeHttp({ status: 200, body: gigante, chunkSize: 256 * 1024 }),
        expectModels: [DEAD_MODEL],
    }));
    // Si `res.destroy()` no emitiera `'close'` y no tuviéramos el handler, esto
    // colgaría hasta TIMEOUT_MS (8s) y degradaría todo el health-cron.
    assert.ok(Date.now() - t0 < livePing.TIMEOUT_MS, 'la promesa no puede colgar hasta el timeout');
    assert.equal(r.catalog_check.reason_code, 'model_check_unavailable');
    assert.equal(r.catalog_check.detail, 'truncated');
});

test('CA-11/D-5: el bodyExcerpt que sale del módulo sigue ≤512B (no creció respecto de HEAD)', async () => {
    assert.equal(livePing.MAX_BODY_EXCERPT === undefined, true, 'MAX_BODY_EXCERPT sigue sin exportarse');
    const src = fs.readFileSync(path.join(__dirname, '..', 'multi-provider', 'live-ping.js'), 'utf8');
    assert.match(src, /const MAX_BODY_EXCERPT = 512;/, 'el cap del excerpt de error NO se amplió');
    assert.equal(typeof livePing.doRequest, 'undefined', 'R-A: doRequest sigue sin exportarse');
});

test('CA-11: ningún model_id se concatena a una URL de ping', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    const http = fakeHttp({ status: 200, body: JSON.stringify(CATALOG_FIXTURE) });
    await withFakeHttpProvider(() =>
        livePing.ping({ provider: FAKE_PROVIDER, secretsPath, httpImpl: http, expectModels: [DEAD_MODEL] }));
    assert.equal(http.calls.length, 1);
    const { path: reqPath, hostname } = http.calls[0];
    assert.equal(reqPath, '/v1/models');
    assert.equal(hostname, 'ping.fake-http.invalid');
    assert.equal(reqPath.includes('gemini-2.5'), false);
});

// =============================================================================
// No-regresión del ping manual (R-J) — sin expectModels, shape idéntico a HEAD
// =============================================================================

test('R-J: el ping SIN expectModels no baja catálogo y devuelve el shape de HEAD', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER, secretsPath,
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify(CATALOG_FIXTURE) }),
    }));
    assert.deepEqual(Object.keys(r).sort(), ['latency_ms', 'ok', 'provider', 'reason', 'statusCode'].sort());
    assert.equal('catalog_check' in r, false, 'el ping manual del dashboard no puede bajar catálogo (path facturable)');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

test('R-J: expectModels vacío se comporta como ausente', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, FAKE_KEYS);
    const r = await withFakeHttpProvider(() => livePing.ping({
        provider: FAKE_PROVIDER, secretsPath,
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify(CATALOG_FIXTURE) }),
        expectModels: [],
    }));
    assert.equal('catalog_check' in r, false);
});

// =============================================================================
// CA-13 — El alcance queda escrito, no implícito
// =============================================================================

test('CA-13/D-1: alcance explícito y mapeo openai ↔ openai-codex', () => {
    // #6563 — cerebras y nvidia-nim retirados: el alcance queda en antigravity.
    assert.deepEqual(healthCron.CATALOG_CHECK_PROVIDERS.slice(), ['antigravity']);
    for (const fuera of ['anthropic', 'openai-codex', 'openai', 'cerebras', 'nvidia-nim', 'kimi-moonshot']) {
        assert.equal(healthCron.CATALOG_CHECK_PROVIDERS.includes(fuera), false, `${fuera} fuera de alcance`);
    }
    assert.equal(healthCron.PING_TO_CONFIG_PROVIDER.openai, 'openai-codex');
    // Los specs excluidos NO tienen extractor, y la razón está escrita en código.
    assert.equal(typeof livePing.PROVIDER_PING_ENDPOINTS.anthropic.catalogExtract, 'undefined');
    assert.equal(typeof livePing.PROVIDER_PING_ENDPOINTS.openai.catalogExtract, 'undefined');
    // Los retirados no tienen spec de ping: no pueden volver al cruce por accidente.
    for (const retirado of ['cerebras', 'nvidia-nim', 'kimi-moonshot', 'gemini-google']) {
        assert.equal(retirado in livePing.PROVIDER_PING_ENDPOINTS, false, `${retirado} retirado (#6563 / #6861)`);
    }
    // #6861 — el provider en alcance entra al cruce por `agy models`, no por
    // HTTP: es CLI-OAuth con `catalog_probe: 'agy'` y sin endpoint de ping.
    const spec = secretsRw.MANAGED_KEYS.find((k) => k.provider === 'antigravity');
    assert.equal(spec.auth_mode, 'oauth');
    assert.equal(spec.catalog_probe, 'agy');
    assert.equal(spec.cli_binary, 'agy');
    assert.equal('antigravity' in livePing.PROVIDER_PING_ENDPOINTS, false);
});

// =============================================================================
// CA-9 / CA-18 / CA-16 / CA-15 — Superficie visible al operador
// =============================================================================

test('CA-9/D-6: ALLOWED_REASON_CODES ⊆ keys(REASON_LABEL) — cierra la clase entera de UX-1', () => {
    const sinEtiqueta = [...healthAlerts.ALLOWED_REASON_CODES]
        .filter((c) => !Object.prototype.hasOwnProperty.call(providersView.REASON_LABEL, c));
    assert.deepEqual(sinEtiqueta, [],
        'un reason code sin etiqueta se muestra en inglés crudo al operador (precedente #4869)');
});

test('CA-9/D-6: el reason code nuevo tampoco cae al default silencioso de provider-pause-cause', () => {
    // TERCER consumidor de reason codes con copy propia (`REASON_TABLE`). Su
    // invariante existe por la misma razón que el de REASON_LABEL: un código sin
    // fila cae a "motivo desconocido" sin que nadie se entere. Lo dejamos
    // explícito acá para que la relación entre los tres sets quede escrita.
    const ppc = require('../provider-pause-cause');
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const code of ['model_not_in_catalog', 'model_check_unavailable']) {
        fs.writeFileSync(path.join(dir, 'multi-provider-health.json'), JSON.stringify({
            ts: '2026-08-13T13:00:00.000Z',
            providers: [{ provider: 'antigravity', label: 'Antigravity', state: 'red', reason_code: code }],
        }));
        const res = ppc.classifyPauseCause(['antigravity'], { stateDir: dir, now: Date.parse('2026-08-13T13:00:00.000Z') });
        assert.notEqual(res.providers[0].text, 'motivo desconocido', `${code} no puede caer al default`);
        assert.notEqual(res.providers[0].cause, 'auth',
            `${code} no es causa de auth: encabezaría el mensaje como si el proveedor estuviera inutilizable`);
    }
});

test('CA-18: ninguna etiqueta de REASON_LABEL contiene guion bajo', () => {
    const crudas = Object.entries(providersView.REASON_LABEL).filter(([, v]) => v.includes('_'));
    assert.deepEqual(crudas, [], 'un `_` en la etiqueta delata el fallback de reasonHuman, no una traducción');
});

test('CA-18: las 7 etiquetas coinciden LITERAL con la tabla acordada con ux', () => {
    const tabla = {
        rate_limited: 'rate limit (429)',
        unknown: 'causa desconocida',
        network_error: 'error de red',
        cli_binary_undeclared: 'binario CLI no declarado',
        cli_license_unavailable: 'CLI sin licencia activa',
        model_not_in_catalog: 'modelo fuera de catálogo',
        model_check_unavailable: 'vigencia no verificable',
        plan_quota_ok: 'cuota del plan verificada',
        plan_tier_unknown: 'cuota del plan sin verificar',
    };
    for (const [code, label] of Object.entries(tabla)) {
        assert.equal(providersView.REASON_LABEL[code], label, `etiqueta de ${code}`);
        assert.equal(providersView.reasonHuman(code), label);
    }
});

// Modelo mínimo de una fila, con los campos que consume el render.
function filaProv(over = {}) {
    return {
        key: 'antigravity', disabledKey: 'antigravity', name: 'Antigravity', accent: 'var(--provider-antigravity)',
        // #6861 — forma que produce la vista para antigravity: `billing: free`
        // en agent-models.json ⇒ badge FREE; CLI-OAuth sin key gestionada.
        tier: 'FREE', tierKind: 'free', tierIcon: '🟩', masked: null, fingerprint: null,
        keyStatus: 'absent', editable: false, reason: null, authMode: 'oauth', freeTierNotes: null,
        healthState: 'green', healthReason: 'authenticated', catalogCheck: null, quota: null,
        lastChecked: '2026-08-13T13:00:00.000Z', loadPct: 10, dispatches24h: 3, hasTraffic: true,
        models: [], disabled: false, ...over,
    };
}

const CC_FUERA = {
    state: 'not_in_catalog', checked_at: '2026-08-13T09:00:00.000Z',
    reason_code: 'model_not_in_catalog',
    models: [{ model_id: DEAD_MODEL, alive: false }, { model_id: LIVE_MODEL, alive: true }],
};

test('CA-16/UX-4: el eje de modelo vive en prov-col-models; prov-col-health queda limpio', () => {
    const html = providersView.renderProviderRow(filaProv({ catalogCheck: CC_FUERA }), Date.parse('2026-08-13T13:00:00.000Z'));
    const health = html.slice(html.indexOf('prov-col-health'), html.indexOf('prov-col-models'));
    for (const token of ['model_not_in_catalog', 'model_check_unavailable', 'modelo fuera de catálogo', 'vigencia no verificable', DEAD_MODEL]) {
        assert.equal(health.includes(token), false,
            `prov-col-health no puede contener "${token}": el operador lo leería como la causa de la salud del provider`);
    }
    const models = html.slice(html.indexOf('prov-col-models'));
    assert.ok(models.includes('modelo fuera de catálogo'));
    assert.ok(models.includes(DEAD_MODEL));
    // Y la salud sigue diciendo lo suyo, intacta.
    assert.ok(health.includes('autenticado'));
});

test('CA-8/CA-18/UX-4: los 4 estados de la celda de vigencia, con antigüedad relativa e ISO en title', () => {
    const now = Date.parse('2026-08-13T13:00:00.000Z');
    const v = (cc) => providersView.renderVigenciaLine(filaProv({ catalogCheck: cc }), now);

    const vigente = v({ state: 'verified', checked_at: '2026-08-13T09:00:00.000Z', reason_code: null, models: [{ model_id: LIVE_MODEL, alive: true }] });
    assert.ok(vigente.includes('verificado hace 4 h'), vigente);

    const fuera = v(CC_FUERA);
    assert.ok(fuera.includes('modelo fuera de catálogo · verificado hace 4 h'), fuera);
    assert.ok(fuera.includes('is-model-warn'), 'tratamiento de advertencia, no de caído');
    assert.ok(fuera.includes('prov-model-dead'), 'el id afectado va marcado, no como texto suelto');
    assert.equal(fuera.includes(LIVE_MODEL), false, 'sólo se marcan los ausentes');

    const nover = v({ state: 'unavailable', checked_at: '2026-08-13T01:00:00.000Z', reason_code: 'model_check_unavailable', models: [] });
    assert.ok(nover.includes('vigencia no verificable · último intento hace 12 h'), nover);
    assert.equal(nover.includes('is-model-ok'), false, 'nunca verde: no sabemos, no está bien');

    const nunca = v({ state: 'never', checked_at: null, reason_code: null, models: [] });
    assert.ok(nunca.includes('vigencia nunca verificada'), nunca);
    assert.equal(nunca.includes('hace'), false, '"no verificable hace —" no comunica nada');

    // ISO en el title (CA-18), no en el texto visible.
    assert.ok(/title="[^"]*13\/08\/2026[^"]*"/.test(fuera), fuera);
    // Provider fuera de alcance: la celda no inventa una vigencia que nadie verifica.
    assert.equal(providersView.renderVigenciaLine(filaProv({ catalogCheck: null }), now), '');
});

test('CA-8: `— sin catálogo —` pasa a `— sin catálogo local —` (es otro eje que la vigencia)', () => {
    const html = providersView.renderCatalogCell(filaProv({ models: [] }), Date.now());
    assert.ok(html.includes('— sin catálogo local —'));
});

test('CA-8: la antigüedad real llega hasta el HTML de la pantalla, no sólo al helper', () => {
    // Regresión encontrada por la evidencia visual: `providers.map(renderProviderRow)`
    // pasa el ÍNDICE del array como 2do argumento. Como el índice es un número
    // finito, `relativeTime` lo tomaba como el `now` de referencia y TODA la
    // columna decía "verificado ahora". Un panel que siempre dice "ahora" es
    // peor que uno mudo: el operador le cree.
    const now = Date.parse('2026-08-13T13:00:00.000Z');
    const model = {
        providers: [
            filaProv({ key: 'anthropic', name: 'Claude', catalogCheck: null }),
            filaProv({ catalogCheck: CC_FUERA }),
        ],
        meta: {
            total: 2, healthy: 2, degraded: [],
            modelsOutOfCatalog: [{ providerKey: 'antigravity', providerName: 'Antigravity', modelId: DEAD_MODEL }],
            absorber: { name: 'Claude', loadPct: 10 }, defaultProvider: 'anthropic',
            defaultChain: ['Claude'], agents: [], healthTs: null, dispatchTotal: 5,
        },
    };
    const html = providersView.bodyHtml(model, now);
    assert.ok(html.includes('verificado hace 4 h'), 'la antigüedad real debe llegar al HTML');
    assert.equal(html.includes('verificado ahora'), false);
});

test('CA-15/UX-3: providers verdes + 1 modelo fuera de catálogo ⇒ el banner NO dice TODO OK y sí nombra el par', () => {
    const meta = {
        total: 3, healthy: 3, degraded: [],
        modelsOutOfCatalog: [{ providerKey: 'antigravity', providerName: 'Antigravity', modelId: DEAD_MODEL }],
        absorber: { name: 'Claude', loadPct: 41 }, defaultProvider: 'anthropic',
        defaultChain: [], agents: [], healthTs: null, dispatchTotal: 120,
    };
    const html = providersView.renderMissionBanner(meta);
    assert.equal(html.includes('TODO OK'), false);
    assert.equal(html.includes('está sana'), false);
    assert.ok(html.includes('1 MODELO FUERA DE CATÁLOGO'));
    assert.ok(html.includes(DEAD_MODEL) && html.includes('Antigravity'), 'nombra el par (provider, model_id)');
    assert.ok(html.includes('como primario o como fallback'));
    assert.ok(html.includes('is-model-warn'), 'advertencia, no caído: no afirma que ningún provider esté abajo');
    assert.equal(html.includes('PROVEEDOR CAÍDO'), false);
    assert.equal(html.includes('PROVEEDORES CAÍDOS'), false);
    // CA-19 — la región describe ambos ejes.
    assert.ok(/role="region" aria-label="[^"]*modelos[^"]*"/.test(html), html.slice(0, 400));

    // Plural.
    meta.modelsOutOfCatalog.push({ providerKey: 'antigravity', providerName: 'Antigravity', modelId: 'gemini-2.0-flash' });
    assert.ok(providersView.renderMissionBanner(meta).includes('2 MODELOS FUERA DE CATÁLOGO'));
});

test('CA-15/CA-17: model_check_unavailable NO altera el banner', () => {
    const meta = {
        total: 3, healthy: 3, degraded: [], modelsOutOfCatalog: [],
        absorber: { name: 'Claude', loadPct: 41 }, defaultProvider: 'anthropic',
        defaultChain: [], agents: [], healthTs: null, dispatchTotal: 120,
    };
    const html = providersView.renderMissionBanner(meta);
    assert.ok(html.includes('TODO OK'), 'sin evidencia de modelo muerto, el banner no cambia');
    assert.equal(html.includes('is-model-warn'), false);
});

test('CA-15: con un provider degradado Y un modelo fuera de catálogo, ninguno de los dos ejes tapa al otro', () => {
    const meta = {
        total: 3, healthy: 2,
        degraded: [{ name: 'Codex', healthReason: 'invalid_credentials' }],
        modelsOutOfCatalog: [{ providerKey: 'antigravity', providerName: 'Antigravity', modelId: DEAD_MODEL }],
        absorber: { name: 'Claude', loadPct: 41 }, defaultProvider: 'anthropic',
        defaultChain: [], agents: [], healthTs: null, dispatchTotal: 120,
    };
    const html = providersView.renderMissionBanner(meta);
    assert.ok(html.includes('credencial inválida'), 'el eje de salud sigue visible');
    assert.ok(html.includes(DEAD_MODEL), 'el eje de modelo también');
    assert.equal(html.includes('TODO OK'), false);
});

// =============================================================================
// Integración end-to-end del flujo (sin red)
// =============================================================================

test('E2E: catálogo real de Antigravity (`agy models`) sin el modelo del fallback ⇒ snapshot + alerta con el par', async () => {
    const dir = tmpDir();
    secretsWith(dir, {});
    const enviados = [];
    // #6861 — carril real: el catálogo es la salida cruda del CLI del snapshot
    // 2026-09-16, sin HTTP y sin key de Google.
    const result = await healthCron.runOnce({
        ...hermetic(dir, agyProbe(AGY_IDS)),
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        telegramSender: (p) => { enviados.push(p); return true; },
        now: Date.parse(T0_ISO),
    });

    const antigravity = result.snapshot.providers.find((p) => p.provider === 'antigravity');
    assert.equal(antigravity.state, 'green');
    assert.equal(antigravity.reason_code, 'cli_catalog_ok');
    assert.equal(antigravity.auth_mode, 'oauth');
    assert.equal(antigravity.catalog_check.state, 'not_in_catalog');
    assert.deepEqual(antigravity.catalog_check.models.filter((m) => !m.alive), [{ model_id: DEAD_MODEL, alive: false }]);

    const alerta = enviados.find((p) => p.event === 'model_not_in_catalog');
    assert.ok(alerta, 'debe emitirse la alerta del eje de modelo');
    assert.equal(alerta.provider, 'antigravity');
    assert.equal(alerta.model_id, DEAD_MODEL);
    assert.equal(alerta.provider_state, 'green');
    assert.match(healthCron.formatAlertText(alerta), /^⚠️/);
});

test('E2E: los providers fuera de alcance no llevan catalog_check en el snapshot', async () => {
    const dir = tmpDir();
    secretsWith(dir, {});
    const result = await healthCron.runOnce({
        ...hermetic(dir, agyProbe(AGY_IDS)),
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        now: Date.parse(T0_ISO),
    });
    for (const p of result.snapshot.providers) {
        const enAlcance = healthCron.CATALOG_CHECK_PROVIDERS.includes(p.provider);
        assert.equal('catalog_check' in p, enAlcance, `${p.provider}: catalog_check sólo si está en alcance`);
    }
});

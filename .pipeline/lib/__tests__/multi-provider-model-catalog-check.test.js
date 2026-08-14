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
const dispatch = require('../agent-launcher/dispatch-with-fallback');
const providersView = require('../../views/dashboard/providers');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
const rawFixture = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

const CATALOG_NVIDIA = readFixture('catalog-nvidia.json');
const CATALOG_GEMINI = readFixture('catalog-gemini.json');
const CATALOG_CEREBRAS = readFixture('catalog-cerebras.json');
const AGENT_MODELS = readFixture('agent-models-catalog-check.json');

const DEAD_MODEL = 'deepseek-ai/deepseek-v4-pro';

const SPEC_NVIDIA = livePing.PROVIDER_PING_ENDPOINTS['nvidia-nim'];
const SPEC_GEMINI = livePing.PROVIDER_PING_ENDPOINTS['gemini-google'];
const SPEC_CEREBRAS = livePing.PROVIDER_PING_ENDPOINTS.cerebras;

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
    const nvidia = byProvider.get('nvidia-nim');
    assert.ok(nvidia, 'nvidia-nim debe tener modelos configurados');
    assert.ok(nvidia.has(DEAD_MODEL), 'el modelo del fallback debe entrar al cruce');
    // Y en el fixture NO está en ningún otro lado: si el cruce sólo mirara
    // `providers[].model` este assert fallaría.
    assert.notEqual(AGENT_MODELS.providers['nvidia-nim'].model, DEAD_MODEL);

    const out = livePing._crossCheckCatalog({
        spec: SPEC_NVIDIA,
        result: reqResult({ body: CATALOG_NVIDIA }),
        expectModels: Array.from(nvidia).sort(),
    });
    assert.equal(out.ok, true);
    const dead = out.models.filter((m) => !m.alive).map((m) => m.model_id);
    assert.deepEqual(dead, [DEAD_MODEL]);
});

test('CA-1: `configuredModelsByProvider` cubre las 4 fuentes, una por fuente', () => {
    const by = healthCron.configuredModelsByProvider(AGENT_MODELS);
    // fuente 1 — providers[].model
    assert.ok(by.get('cerebras').has('gpt-oss-120b'));
    // fuente 2 — providers[].alternative_models[]
    assert.ok(by.get('cerebras').has('zai-glm-4.7'));
    // fuente 3 — skills[].model_override
    assert.ok(by.get('gemini-google').has('gemini-2.5-pro'));
    // fuente 4 — skills[].fallbacks[].model_override
    assert.ok(by.get('nvidia-nim').has(DEAD_MODEL));
});

test('CA-1: el cruce es por par (provider, model_id) — un id de Cerebras no se busca en NVIDIA', () => {
    // `gpt-oss-120b` vive en Cerebras y NO está en el catálogo de NVIDIA. Si el
    // cruce usara el id suelto contra un catálogo global, lo marcaría muerto.
    const enNvidia = livePing._crossCheckCatalog({
        spec: SPEC_NVIDIA,
        result: reqResult({ body: CATALOG_NVIDIA }),
        expectModels: Array.from(healthCron.configuredModelsByProvider(AGENT_MODELS).get('nvidia-nim')),
    });
    assert.equal(enNvidia.models.some((m) => m.model_id === 'gpt-oss-120b'), false,
        'un modelo de Cerebras no debe siquiera evaluarse contra el catálogo de NVIDIA');

    const enCerebras = livePing._crossCheckCatalog({
        spec: SPEC_CEREBRAS,
        result: reqResult({ body: CATALOG_CEREBRAS }),
        expectModels: ['gpt-oss-120b'],
    });
    assert.deepEqual(enCerebras.models, [{ model_id: 'gpt-oss-120b', alive: true }]);
});

test('CA-1: `expectModelsForPing` sólo cubre los 3 providers en alcance y usa el mapeo de nombres', () => {
    const m = healthCron.expectModelsForPing(AGENT_MODELS);
    assert.deepEqual(Array.from(m.keys()).sort(), ['cerebras', 'gemini-google', 'nvidia-nim']);
    assert.equal(m.has('kimi-moonshot'), false, 'D-1: kimi-moonshot fuera de alcance');
    assert.equal(m.has('anthropic'), false);
    assert.equal(m.has('openai'), false);
});

// =============================================================================
// CA-2 — El catálogo se parsea con la forma REAL de cada provider
// =============================================================================

test('CA-2/G-1: con el catálogo Gemini real (models[].name con prefijo), gemini-3-flash-preview NO se marca ausente', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_GEMINI,
        result: reqResult({ body: CATALOG_GEMINI }),
        expectModels: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models.filter((m) => !m.alive), [],
        'sin normalizar el prefijo `models/`, TODO modelo vivo se reportaría muerto');
});

test('CA-2: NVIDIA y Cerebras usan `data[].id` plano; Gemini usa `models[].name`', () => {
    assert.deepEqual(SPEC_NVIDIA.catalogExtract(CATALOG_CEREBRAS), CATALOG_CEREBRAS.data.map((m) => m.id));
    assert.deepEqual(SPEC_GEMINI.catalogExtract(CATALOG_GEMINI),
        CATALOG_GEMINI.models.map((m) => m.name.replace(/^models\//, '')));
    // Cruzar extractores da vacío — por eso cada provider tiene el suyo.
    assert.deepEqual(SPEC_CEREBRAS.catalogExtract(CATALOG_GEMINI), []);
});

test('CA-2/G-2/R-H: `nextPageToken` no vacío ⇒ model_check_unavailable, jamás not_in_catalog', () => {
    const paginado = { ...CATALOG_GEMINI, nextPageToken: 'CAESBk1PUkU=' };
    const out = livePing._crossCheckCatalog({
        spec: SPEC_GEMINI,
        result: reqResult({ body: paginado }),
        expectModels: ['gemini-3-flash-preview'],
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'paginated');
    assert.deepEqual(out.models, []);
});

test('CA-2: la URL de Gemini lleva ?pageSize=1000 literal y sigue hardcodeada (cond. 8)', () => {
    assert.match(SPEC_GEMINI.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000$/);
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
        spec: SPEC_CEREBRAS, result: reqResult({ body: CATALOG_CEREBRAS }), expectModels: ['gpt-oss-120b'],
    });
    assert.equal(out.ok, true);
    assert.equal(out.reason_code, null);
    assert.deepEqual(out.models, [{ model_id: 'gpt-oss-120b', alive: true }]);
});

test('CA-3 fila 2: 200 + catálogo completo + id ausente ⇒ model_not_in_catalog', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_CEREBRAS, result: reqResult({ body: CATALOG_CEREBRAS }), expectModels: ['zai-glm-4.7'],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, [{ model_id: 'zai-glm-4.7', alive: false }]);
    const built = healthCron.buildCatalogCheck(out, '2026-08-13T13:00:00.000Z');
    assert.equal(built.state, 'not_in_catalog');
    assert.equal(built.reason_code, 'model_not_in_catalog');
});

test('CA-3 fila 3: body no parseable ⇒ model_check_unavailable', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_NVIDIA, result: reqResult({ body: '<html><body>502 Bad Gateway</body></html>' }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'unparseable');
});

test('CA-3 fila 4: body truncado ⇒ model_check_unavailable', () => {
    const out = livePing._crossCheckCatalog({
        spec: SPEC_NVIDIA, result: reqResult({ body: CATALOG_NVIDIA, truncated: true }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'truncated');
});

for (const status of [401, 403, 429, 500]) {
    test(`CA-3 fila 5: HTTP ${status} ⇒ model_check_unavailable (nunca dead)`, () => {
        const out = livePing._crossCheckCatalog({
            spec: SPEC_NVIDIA, result: reqResult({ statusCode: status, body: CATALOG_NVIDIA }), expectModels: [DEAD_MODEL],
        });
        assert.equal(out.ok, false);
        assert.equal(out.reason_code, 'model_check_unavailable');
        assert.equal(out.detail, 'http_status');
        assert.deepEqual(out.models, []);
    });
}

test('CA-3 fila 6: timeout / error de red ⇒ model_check_unavailable, nunca dead', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const r = await livePing.ping({
        provider: 'nvidia-nim',
        secretsPath,
        httpImpl: fakeHttp({ error: Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }) }),
        expectModels: [DEAD_MODEL],
    });
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
    for (const body of [{ data: [] }, { object: 'list' }, {}]) {
        const out = livePing._crossCheckCatalog({
            spec: SPEC_NVIDIA, result: reqResult({ body }), expectModels: [DEAD_MODEL, 'deepseek-ai/deepseek-r1'],
        });
        assert.equal(out.reason_code, 'model_check_unavailable');
        assert.equal(out.detail, 'empty_catalog');
        assert.deepEqual(out.models, []);
    }
});

test('CA-3: el extractor que lanza ⇒ model_check_unavailable, no propaga la excepción', () => {
    const specRoto = { catalogExtract: () => { throw new Error('shape cambiado'); } };
    const out = livePing._crossCheckCatalog({
        spec: specRoto, result: reqResult({ body: CATALOG_NVIDIA }), expectModels: [DEAD_MODEL],
    });
    assert.equal(out.reason_code, 'model_check_unavailable');
    assert.equal(out.detail, 'extractor_error');
});

test('CA-3: NINGUNA ruta de la matriz produce not_in_catalog sin catálogo completo', () => {
    const rutas = [
        reqResult({ statusCode: 401, body: CATALOG_NVIDIA }),
        reqResult({ statusCode: 403, body: CATALOG_NVIDIA }),
        reqResult({ statusCode: 500, body: CATALOG_NVIDIA }),
        reqResult({ body: 'no-json' }),
        reqResult({ body: CATALOG_NVIDIA, truncated: true }),
        reqResult({ body: { data: [] } }),
        reqResult({ body: { ...CATALOG_NVIDIA, nextPageToken: 'x' } }),
        reqResult({ body: null }),
    ];
    for (const r of rutas) {
        const built = healthCron.buildCatalogCheck(
            livePing._crossCheckCatalog({ spec: SPEC_NVIDIA, result: r, expectModels: [DEAD_MODEL] }),
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
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const result = await healthCron.runOnce({
        stateDir: path.join(dir, 'state'),
        auditDir: path.join(dir, 'audit'),
        secretsPath,
        checkCatalog: true,
        agentModelsConfig: AGENT_MODELS,
        pingImpl: async ({ provider, expectModels }) => ({
            ok: true,
            reason: 'authenticated',
            statusCode: 200,
            provider,
            catalog_check: livePing._crossCheckCatalog({
                spec: SPEC_NVIDIA, result: reqResult({ body: CATALOG_NVIDIA }), expectModels: expectModels || [],
            }),
        }),
        cliProbe: () => false,
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const nvidia = result.snapshot.providers.find((p) => p.provider === 'nvidia-nim');
    assert.equal(nvidia.state, 'green', 'NVIDIA sigue sirviendo el resto de su catálogo');
    assert.equal(nvidia.reason_code, 'authenticated', 'el eje de salud queda intacto');
    assert.equal(nvidia.catalog_check.state, 'not_in_catalog', 'el evento viaja por el eje de modelo');
    assert.equal(nvidia.catalog_check.reason_code, 'model_not_in_catalog');
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
    // Los 6 ids reales del config + el del vendor con `/` deben pasar.
    for (const m of ['claude-opus-4-7', 'gpt-5.5', 'gemini-3-flash-preview', 'gpt-oss-120b',
        'zai-glm-4.7', 'kimi-k2-6', DEAD_MODEL]) {
        assert.equal(healthAlerts.sanitizeModelId(m), m, `debe aceptar: ${m}`);
    }
});

test('CA-6/S-A: con sanitizeModelId → null la alerta IGUAL se emite, sin el id crudo', () => {
    const dir = tmpDir();
    const crudo = 'evil`[click](http://evil)`';
    const decision = healthAlerts.decideModelEvent({
        provider: 'nvidia-nim',
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
        provider: 'nvidia-nim',
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
    assert.equal(/`nvidia-nim` → `GREEN`/.test(texto), false);
});

test('CA-17/R-D: la key de dedup del evento de modelo no colisiona con la del eje de salud', () => {
    const dir = tmpDir();
    const dedupFile = path.join(dir, 'dedup.json');
    const t0 = Date.parse('2026-08-13T13:00:00.000Z');

    const d1 = healthAlerts.decideModelEvent({ provider: 'nvidia-nim', modelId: DEAD_MODEL, providerState: 'green', now: t0, dedupFile });
    assert.equal(d1.shouldEmit, true);
    healthAlerts.recordModelEvent({ provider: 'nvidia-nim', modelId: DEAD_MODEL, sent: true, now: t0, dedupFile });

    // Dentro de la ventana de 24h no se repite (condición persistente, 1/día).
    const d2 = healthAlerts.decideModelEvent({ provider: 'nvidia-nim', modelId: DEAD_MODEL, providerState: 'green', now: t0 + 6 * 3600e3, dedupFile });
    assert.equal(d2.shouldEmit, false);
    assert.equal(d2.reasonNoEmit, 'dedup_window');

    // …pero la alerta de SALUD del mismo provider sigue libre de emitir.
    const salud = healthAlerts.decide({ provider: 'nvidia-nim', state: 'red', reasonCode: 'invalid_credentials', now: t0 + 60e3, dedupFile });
    assert.equal(salud.shouldEmit, true, 'el evento de modelo no puede suprimir la alerta de salud');

    // Y pasadas 24h el recordatorio vuelve.
    const d3 = healthAlerts.decideModelEvent({ provider: 'nvidia-nim', modelId: DEAD_MODEL, providerState: 'green', now: t0 + 25 * 3600e3, dedupFile });
    assert.equal(d3.shouldEmit, true);
});

test('CA-17/D-3: model_check_unavailable NO emite a Telegram', () => {
    const dir = tmpDir();
    const enviados = [];
    const snapshot = {
        ts: '2026-08-13T13:00:00.000Z',
        providers: [{
            provider: 'nvidia-nim', state: 'green', reason_code: 'authenticated',
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

    const secretsPath = secretsWith(dir, {
        nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa',
        cerebras_api_key: 'csk_test_aaaaaaaaaaaaaaaaaaaa',
    });
    await healthCron.runOnce({
        stateDir: path.join(dir, 'state'),
        auditDir: path.join(dir, 'audit'),
        secretsPath,
        checkCatalog: true,
        agentModelsConfig: JSON.parse(fs.readFileSync(configFile, 'utf8')),
        // Catálogo vacío: el peor caso — sin fail-open marcaría TODO muerto.
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify({ object: 'list', data: [] }) }),
        cliProbe: () => false,
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });

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

test('CA-10: dos ticks dentro del TTL ⇒ UNA sola descarga de catálogo', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const conCatalogo = [];
    const pingImpl = async ({ provider, expectModels }) => {
        if (Array.isArray(expectModels) && expectModels.length) conCatalogo.push(provider);
        return { ok: true, reason: 'authenticated', statusCode: 200, provider };
    };
    const base = {
        stateDir, auditDir: path.join(dir, 'audit'), secretsPath,
        agentModelsConfig: AGENT_MODELS, pingImpl, cliProbe: () => false,
        telegramSender: () => true, dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true, jitter: 0, catalogTtlMs: 6 * 3600e3,
    };
    const t0 = Date.parse('2026-08-13T13:00:00.000Z');
    await healthCron.tickIfDue({ ...base, now: t0 });
    await healthCron.tickIfDue({ ...base, now: t0 + 10 * 60e3 });   // 10 min después
    assert.deepEqual(conCatalogo, ['nvidia-nim'], 'el 2do tick no vuelve a bajar el catálogo');

    // Fuera del TTL sí vuelve a descargar.
    await healthCron.tickIfDue({ ...base, now: t0 + 7 * 3600e3 });
    assert.deepEqual(conCatalogo, ['nvidia-nim', 'nvidia-nim']);
});

test('CA-10/R-E: carry-over — el tick intermedio conserva el catalog_check previo', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const pingImpl = async ({ provider, expectModels }) => ({
        ok: true, reason: 'authenticated', statusCode: 200, provider,
        ...(Array.isArray(expectModels) && expectModels.length
            ? {
                catalog_check: livePing._crossCheckCatalog({
                    spec: SPEC_NVIDIA, result: reqResult({ body: CATALOG_NVIDIA }), expectModels,
                }),
            }
            : {}),
    });
    const base = {
        stateDir, auditDir: path.join(dir, 'audit'), secretsPath,
        agentModelsConfig: AGENT_MODELS, pingImpl, cliProbe: () => false,
        telegramSender: () => true, dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true, jitter: 0, catalogTtlMs: 6 * 3600e3,
    };
    const t0 = Date.parse('2026-08-13T13:00:00.000Z');
    const r1 = await healthCron.tickIfDue({ ...base, now: t0 });
    const cc1 = r1.snapshot.providers.find((p) => p.provider === 'nvidia-nim').catalog_check;
    assert.equal(cc1.state, 'not_in_catalog');

    const r2 = await healthCron.tickIfDue({ ...base, now: t0 + 10 * 60e3 });
    const cc2 = r2.snapshot.providers.find((p) => p.provider === 'nvidia-nim').catalog_check;
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
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    // Marcador que sólo existe en el body del tercero, en ningún id nuestro.
    const MARCADOR = 'MARCADOR_SOLO_DEL_TERCERO';
    const bodyRemoto = JSON.stringify({
        object: 'list',
        data: [...CATALOG_NVIDIA.data, { id: 'vendor/otro-modelo', owned_by: MARCADOR }],
    });

    const r = await livePing.ping({
        provider: 'nvidia-nim', secretsPath,
        httpImpl: fakeHttp({ status: 200, body: bodyRemoto }),
        expectModels: [DEAD_MODEL],
    });
    const serializado = JSON.stringify(r);
    assert.equal(serializado.includes(MARCADOR), false, 'nada del body crudo sale del módulo');
    assert.equal(serializado.includes('vendor/otro-modelo'), false, 'ni siquiera los ids remotos que no son nuestros');
    assert.equal('catalogRaw' in r, false);
    assert.deepEqual(r.catalog_check.models, [{ model_id: DEAD_MODEL, alive: false }],
        'sólo `{model_id, alive}` con ids NUESTROS');

    const result = await healthCron.runOnce({
        stateDir: path.join(dir, 'state'), auditDir: path.join(dir, 'audit'), secretsPath,
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        httpImpl: fakeHttp({ status: 200, body: bodyRemoto }),
        cliProbe: () => false,
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'), skipAudit: true,
    });
    const snapSer = JSON.stringify(result.snapshot);
    assert.equal(snapSer.includes(MARCADOR), false, 'ni en el snapshot');
    assert.equal(/catalogRaw|catalog_raw|bodyExcerpt|body_excerpt/i.test(snapSer), false);
    for (const a of result.alerts) {
        assert.equal(JSON.stringify(a.payload).includes(MARCADOR), false, 'ni en el payload de alerta');
    }
});

test('CA-11/R-B: el fragmento del body no-JSON no viaja en `detail` ni en nada que salga', async () => {
    // `JSON.parse` embebe un fragmento del body en su mensaje:
    // `Unexpected token '<', "<html><ti"... is not valid JSON`.
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const SECRETO = 'FRAGMENTO_QUE_NO_DEBE_SALIR';
    const r = await livePing.ping({
        provider: 'nvidia-nim', secretsPath,
        httpImpl: fakeHttp({ status: 200, body: `<html><title>${SECRETO}</title></html>` }),
        expectModels: [DEAD_MODEL],
    });
    assert.equal(r.catalog_check.detail, 'unparseable');
    assert.equal(JSON.stringify(r).includes(SECRETO), false);
    assert.ok(livePing.CATALOG_UNAVAILABLE_DETAILS.includes(r.catalog_check.detail),
        '`detail` es un enum cerrado nuestro');
});

test('CA-11/S-B: un catálogo con clave `__proto__` no rompe la detección ni contamina Object.prototype', () => {
    const envenenado = {
        object: 'list',
        data: [
            { id: '__proto__' },
            { id: 'constructor' },
            { id: 'deepseek-ai/deepseek-r1' },
        ],
    };
    const out = livePing._crossCheckCatalog({
        spec: SPEC_NVIDIA, result: reqResult({ body: envenenado }), expectModels: [DEAD_MODEL, 'deepseek-ai/deepseek-r1'],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, [
        { model_id: DEAD_MODEL, alive: false },
        { model_id: 'deepseek-ai/deepseek-r1', alive: true },
    ], 'con un objeto plano indexado por id, `__proto__` daría "vivo" a cualquier modelo para siempre');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test('CA-11/S-C/R-F: un stream que supera MAX_CATALOG_BYTES destruye el socket y la promesa RESUELVE', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    // Body > 1 MiB, en chunks de 256 KiB.
    const gigante = '{"data":[' + '{"id":"x"},'.repeat(120_000) + '{"id":"y"}]}';
    assert.ok(Buffer.byteLength(gigante) > livePing.MAX_CATALOG_BYTES);
    const t0 = Date.now();
    const r = await livePing.ping({
        provider: 'nvidia-nim', secretsPath,
        httpImpl: fakeHttp({ status: 200, body: gigante, chunkSize: 256 * 1024 }),
        expectModels: [DEAD_MODEL],
    });
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
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const http = fakeHttp({ status: 200, body: JSON.stringify(CATALOG_NVIDIA) });
    await livePing.ping({ provider: 'nvidia-nim', secretsPath, httpImpl: http, expectModels: [DEAD_MODEL] });
    assert.equal(http.calls.length, 1);
    const { path: reqPath, hostname } = http.calls[0];
    assert.equal(reqPath, '/v1/models');
    assert.equal(hostname, 'integrate.api.nvidia.com');
    assert.equal(reqPath.includes('deepseek'), false);
});

// =============================================================================
// No-regresión del ping manual (R-J) — sin expectModels, shape idéntico a HEAD
// =============================================================================

test('R-J: el ping SIN expectModels no baja catálogo y devuelve el shape de HEAD', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const r = await livePing.ping({
        provider: 'nvidia-nim', secretsPath,
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify(CATALOG_NVIDIA) }),
    });
    assert.deepEqual(Object.keys(r).sort(), ['latency_ms', 'ok', 'provider', 'reason', 'statusCode'].sort());
    assert.equal('catalog_check' in r, false, 'el ping manual del dashboard no puede bajar catálogo (path facturable)');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
});

test('R-J: expectModels vacío se comporta como ausente', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { cerebras_api_key: 'csk_test_aaaaaaaaaaaaaaaaaaaa' });
    const r = await livePing.ping({
        provider: 'cerebras', secretsPath,
        httpImpl: fakeHttp({ status: 200, body: JSON.stringify(CATALOG_CEREBRAS) }),
        expectModels: [],
    });
    assert.equal('catalog_check' in r, false);
});

// =============================================================================
// CA-13 — El alcance queda escrito, no implícito
// =============================================================================

test('CA-13/D-1: alcance explícito y mapeo openai ↔ openai-codex', () => {
    assert.deepEqual(healthCron.CATALOG_CHECK_PROVIDERS.slice().sort(), ['cerebras', 'gemini-google', 'nvidia-nim']);
    for (const fuera of ['kimi-moonshot', 'anthropic', 'openai-codex', 'openai']) {
        assert.equal(healthCron.CATALOG_CHECK_PROVIDERS.includes(fuera), false, `${fuera} fuera de alcance`);
    }
    assert.equal(healthCron.PING_TO_CONFIG_PROVIDER.openai, 'openai-codex');
    // Los specs excluidos NO tienen extractor, y la razón está escrita en código.
    assert.equal(typeof livePing.PROVIDER_PING_ENDPOINTS.anthropic.catalogExtract, 'undefined');
    assert.equal(typeof livePing.PROVIDER_PING_ENDPOINTS.openai.catalogExtract, 'undefined');
    const src = fs.readFileSync(path.join(__dirname, '..', 'multi-provider', 'live-ping.js'), 'utf8');
    assert.ok(src.includes('kimi-moonshot') && src.includes('#5892'),
        'la exclusión de kimi-moonshot debe estar escrita con su referencia');
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
            providers: [{ provider: 'cerebras', label: 'Cerebras', state: 'red', reason_code: code }],
        }));
        const res = ppc.classifyPauseCause(['cerebras'], { stateDir: dir, now: Date.parse('2026-08-13T13:00:00.000Z') });
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
    };
    for (const [code, label] of Object.entries(tabla)) {
        assert.equal(providersView.REASON_LABEL[code], label, `etiqueta de ${code}`);
        assert.equal(providersView.reasonHuman(code), label);
    }
});

// Modelo mínimo de una fila, con los campos que consume el render.
function filaProv(over = {}) {
    return {
        key: 'nvidia-nim', disabledKey: 'nvidia-nim', name: 'NVIDIA NIM', accent: 'var(--provider-nvidia-nim)',
        tier: 'FREE', tierKind: 'free', tierIcon: '🟩', masked: 'nvapi-…aaaa', fingerprint: 'abc123',
        keyStatus: 'present', editable: true, reason: null, authMode: 'api_key', freeTierNotes: null,
        healthState: 'green', healthReason: 'authenticated', catalogCheck: null, quota: null,
        lastChecked: '2026-08-13T13:00:00.000Z', loadPct: 10, dispatches24h: 3, hasTraffic: true,
        models: [], disabled: false, ...over,
    };
}

const CC_FUERA = {
    state: 'not_in_catalog', checked_at: '2026-08-13T09:00:00.000Z',
    reason_code: 'model_not_in_catalog',
    models: [{ model_id: DEAD_MODEL, alive: false }, { model_id: 'deepseek-ai/deepseek-r1', alive: true }],
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

    const vigente = v({ state: 'verified', checked_at: '2026-08-13T09:00:00.000Z', reason_code: null, models: [{ model_id: 'deepseek-ai/deepseek-r1', alive: true }] });
    assert.ok(vigente.includes('verificado hace 4 h'), vigente);

    const fuera = v(CC_FUERA);
    assert.ok(fuera.includes('modelo fuera de catálogo · verificado hace 4 h'), fuera);
    assert.ok(fuera.includes('is-model-warn'), 'tratamiento de advertencia, no de caído');
    assert.ok(fuera.includes('prov-model-dead'), 'el id afectado va marcado, no como texto suelto');
    assert.equal(fuera.includes('deepseek-ai/deepseek-r1'), false, 'sólo se marcan los ausentes');

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
            modelsOutOfCatalog: [{ providerKey: 'nvidia-nim', providerName: 'NVIDIA NIM', modelId: DEAD_MODEL }],
            absorber: { name: 'Claude', loadPct: 10 }, defaultProvider: 'anthropic',
            defaultChain: ['Claude'], agents: [], healthTs: null, dispatchTotal: 5,
        },
    };
    const html = providersView.bodyHtml(model, now);
    assert.ok(html.includes('verificado hace 4 h'), 'la antigüedad real debe llegar al HTML');
    assert.equal(html.includes('verificado ahora'), false);
});

test('CA-15/UX-3: 5 providers verdes + 1 modelo fuera de catálogo ⇒ el banner NO dice TODO OK y sí nombra el par', () => {
    const meta = {
        total: 5, healthy: 5, degraded: [],
        modelsOutOfCatalog: [{ providerKey: 'nvidia-nim', providerName: 'NVIDIA NIM', modelId: DEAD_MODEL }],
        absorber: { name: 'Claude', loadPct: 41 }, defaultProvider: 'anthropic',
        defaultChain: [], agents: [], healthTs: null, dispatchTotal: 120,
    };
    const html = providersView.renderMissionBanner(meta);
    assert.equal(html.includes('TODO OK'), false);
    assert.equal(html.includes('está sana'), false);
    assert.ok(html.includes('1 MODELO FUERA DE CATÁLOGO'));
    assert.ok(html.includes(DEAD_MODEL) && html.includes('NVIDIA NIM'), 'nombra el par (provider, model_id)');
    assert.ok(html.includes('como primario o como fallback'));
    assert.ok(html.includes('is-model-warn'), 'advertencia, no caído: no afirma que ningún provider esté abajo');
    assert.equal(html.includes('PROVEEDOR CAÍDO'), false);
    assert.equal(html.includes('PROVEEDORES CAÍDOS'), false);
    // CA-19 — la región describe ambos ejes.
    assert.ok(/role="region" aria-label="[^"]*modelos[^"]*"/.test(html), html.slice(0, 400));

    // Plural.
    meta.modelsOutOfCatalog.push({ providerKey: 'cerebras', providerName: 'Cerebras', modelId: 'zai-glm-4.7' });
    assert.ok(providersView.renderMissionBanner(meta).includes('2 MODELOS FUERA DE CATÁLOGO'));
});

test('CA-15/CA-17: model_check_unavailable NO altera el banner', () => {
    const meta = {
        total: 5, healthy: 5, degraded: [], modelsOutOfCatalog: [],
        absorber: { name: 'Claude', loadPct: 41 }, defaultProvider: 'anthropic',
        defaultChain: [], agents: [], healthTs: null, dispatchTotal: 120,
    };
    const html = providersView.renderMissionBanner(meta);
    assert.ok(html.includes('TODO OK'), 'sin evidencia de modelo muerto, el banner no cambia');
    assert.equal(html.includes('is-model-warn'), false);
});

test('CA-15: con un provider degradado Y un modelo fuera de catálogo, ninguno de los dos ejes tapa al otro', () => {
    const meta = {
        total: 5, healthy: 4,
        degraded: [{ name: 'Cerebras', healthReason: 'invalid_credentials' }],
        modelsOutOfCatalog: [{ providerKey: 'nvidia-nim', providerName: 'NVIDIA NIM', modelId: DEAD_MODEL }],
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

test('E2E: catálogo real de NVIDIA sin el modelo del fallback ⇒ snapshot + alerta con el par', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const enviados = [];
    const result = await healthCron.runOnce({
        stateDir: path.join(dir, 'state'), auditDir: path.join(dir, 'audit'), secretsPath,
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        httpImpl: fakeHttp({ status: 200, body: rawFixture('catalog-nvidia.json') }),
        cliProbe: () => false,
        telegramSender: (p) => { enviados.push(p); return true; },
        dedupFile: path.join(dir, 'dedup.json'), skipAudit: true,
        now: Date.parse('2026-08-13T13:00:00.000Z'),
    });

    const nvidia = result.snapshot.providers.find((p) => p.provider === 'nvidia-nim');
    assert.equal(nvidia.state, 'green');
    assert.equal(nvidia.catalog_check.state, 'not_in_catalog');
    assert.deepEqual(nvidia.catalog_check.models.filter((m) => !m.alive), [{ model_id: DEAD_MODEL, alive: false }]);

    const alerta = enviados.find((p) => p.event === 'model_not_in_catalog');
    assert.ok(alerta, 'debe emitirse la alerta del eje de modelo');
    assert.equal(alerta.provider, 'nvidia-nim');
    assert.equal(alerta.model_id, DEAD_MODEL);
    assert.equal(alerta.provider_state, 'green');
    assert.match(healthCron.formatAlertText(alerta), /^⚠️/);
});

test('E2E: los providers fuera de alcance no llevan catalog_check en el snapshot', async () => {
    const dir = tmpDir();
    const secretsPath = secretsWith(dir, { nvidia_nim_api_key: 'nvapi-aaaaaaaaaaaaaaaaaaaaaa' });
    const result = await healthCron.runOnce({
        stateDir: path.join(dir, 'state'), auditDir: path.join(dir, 'audit'), secretsPath,
        checkCatalog: true, agentModelsConfig: AGENT_MODELS,
        httpImpl: fakeHttp({ status: 200, body: rawFixture('catalog-nvidia.json') }),
        cliProbe: () => false, telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'), skipAudit: true,
    });
    for (const p of result.snapshot.providers) {
        const enAlcance = healthCron.CATALOG_CHECK_PROVIDERS.includes(p.provider);
        assert.equal('catalog_check' in p, enAlcance, `${p.provider}: catalog_check sólo si está en alcance`);
    }
});

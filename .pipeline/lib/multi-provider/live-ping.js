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
// #4402 — fuente única de la lógica CLI-OAuth (compartida con health-cron.js).
const { probeCliProvider } = require('./cli-oauth-probe');

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
        // #5888 CA-13 — SIN `catalogExtract` por diseño. Los tres providers
        // excluidos del cruce de catálogo, con su razón escrita:
        //   - `anthropic`  : corre por CLI-OAuth (Claude Code MAX). `ping()`
        //     hace short-circuit por `probeCliProvider` y nunca llega acá, así
        //     que no hay body de catálogo que parsear.
        //   - `openai`     : idem (Codex CLI-OAuth). Su key de config es
        //     `openai-codex` (ver PING_TO_CONFIG_PROVIDER en health-cron.js).
        //   - `kimi-moonshot` (D-1, ref. #5892): NO tiene entrada acá ni en
        //     `MANAGED_KEYS`, así que `listManagedAndPingable()` jamás lo
        //     pingea. Incluirlo exige resolver antes la inconsistencia de
        //     config de #5892. Queda fuera POR DECISIÓN, no por accidente.
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
        // #5888 CA-13 — sin `catalogExtract` (ver bloque de exclusiones en el
        // spec de `anthropic`, arriba).
    },
    // ─── Free providers — red de salvataje del pipeline (#3260 SR-2 / SR-7).
    //
    // Reglas para sumar uno:
    //   - URL **literal hardcoded** (anti-SSRF). Prohibido leer de
    //     `agent-models.json`, env vars o body de request.
    //   - Endpoint de **listado de modelos** (no completion) — los pings del
    //     cron de CA-1 corren cada 5 min (#4402 cambió el default de 15 a 5;
    //     `health-cron.DEFAULT_INTERVAL_MINUTES = 5`, configurable por
    //     `config.yaml`) y la validación semanal de keys (CA-2).
    //     Un completion consume cuota, `/models` no.
    //   - #5888 — si el endpoint es de listado, el spec suma `catalogExtract`:
    //     recibe el JSON YA PARSEADO y devuelve `string[]` con los ids vivos.
    //     Se usa SOLO dentro de este módulo (`crossCheckCatalog`) — el catálogo
    //     del tercero nunca sale de acá (CA-11).
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
        // #5888 CA-2 — API OpenAI-compatible: `data[].id` plano (con prefijo de
        // vendor incluido en el propio id, ej. `deepseek-ai/deepseek-v4-pro`).
        catalogExtract: (json) => (Array.isArray(json && json.data) ? json.data : [])
            .map((m) => ((m && typeof m.id === 'string') ? m.id : null))
            .filter(Boolean),
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
        // #5888 G-2/R-H — `?pageSize=1000` va en la URL **literal** de este
        // módulo (el default de la API es 50 y truncaría el catálogo). Sigue
        // siendo hardcodeada: nada derivado de config ni de env (cond. 8).
        // `doRequest` manda `url.pathname + url.search`, así que la query viaja.
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'x-goog-api-key': key }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('gemini-google', status, bodyExcerpt),
        // #5888 CA-2/G-1 — Gemini devuelve `models[].name` con prefijo
        // `models/`. Sin normalizarlo, TODO modelo vivo se reportaría ausente.
        catalogExtract: (json) => (Array.isArray(json && json.models) ? json.models : [])
            .map((m) => ((m && typeof m.name === 'string') ? m.name.replace(/^models\//, '') : null))
            .filter(Boolean),
    },
    cerebras: {
        url: 'https://api.cerebras.ai/v1/models',
        method: 'GET',
        body: () => null,
        headers: (key) => ({ 'authorization': `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) =>
            classifyForLivePing('cerebras', status, bodyExcerpt),
        // #5888 CA-2 — OpenAI-compatible: `data[].id` plano, sin prefijo.
        catalogExtract: (json) => (Array.isArray(json && json.data) ? json.data : [])
            .map((m) => ((m && typeof m.id === 'string') ? m.id : null))
            .filter(Boolean),
    },
});

const TIMEOUT_MS = 8_000;
const MAX_BODY_EXCERPT = 512;
// #5888 cond. 5+7 / D-5 — `MAX_BODY_EXCERPT` NO se amplía: el excerpt de error
// que SALE del módulo sigue siendo de 512B. El catálogo se acumula en un
// SEGUNDO buffer, privado, que se consume y se descarta dentro de `ping()`.
// 1 MiB alcanza holgado para los catálogos de los 3 providers en alcance; al
// superarlo cortamos el stream (`res.destroy()`) y el cruce queda `unavailable`
// (nunca `not_in_catalog` sobre un catálogo incompleto).
const MAX_CATALOG_BYTES = 1 << 20; // 1 MiB

// -----------------------------------------------------------------------------
// #3965 CA-4 — Throttle server-side de la acción "probar proveedor ahora".
//
// Riesgo (OWASP A04 Insecure Design / A01 cost-abuse): el endpoint
// POST /api/multi-provider/ping/:provider dispara una llamada HTTP FACTURABLE
// al provider. El único control previo era client-side (mphState.pinging), que
// es evitable: el token CSRF se obtiene del GET público /csrf-token y un atacante
// puede martillar el POST en loop → N llamadas facturables.
//
// Defensa (server-side, en el único chokepoint que precede al HTTP):
//   1. Cooldown por proveedor: lastPingAt[provider]; si now - lastPingAt <
//      PING_MIN_INTERVAL_MS → 'rate_limited_local' SIN disparar HTTP saliente.
//   2. Concurrencia: 1 ping in-flight por proveedor; un 2do request mientras el
//      1ro está en vuelo → 'rate_limited_local' SIN HTTP saliente.
//
// El estado vive en memoria del proceso del dashboard (el ping es una acción
// interactiva efímera; no requiere persistencia FS). `_resetPingThrottle` y los
// params `nowMs` / `minIntervalMs` existen para tests deterministas.
// -----------------------------------------------------------------------------
const PING_MIN_INTERVAL_MS = 10_000;
const _lastPingAt = Object.create(null);
const _inFlight = Object.create(null);

function _resetPingThrottle() {
    for (const k of Object.keys(_lastPingAt)) delete _lastPingAt[k];
    for (const k of Object.keys(_inFlight)) delete _inFlight[k];
}

function isAllowedProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_PING_ENDPOINTS, provider);
}

// -----------------------------------------------------------------------------
// #5888 — Cruce de catálogo (CA-1/CA-2/CA-3). PRIVADA: el catálogo del tercero
// entra acá y sale convertido en `[{ model_id, alive }]` con NUESTROS ids.
//
// Fail-open exhaustivo (CA-3): cualquier resultado que no sea "catálogo completo
// leído" devuelve `model_check_unavailable`. JAMÁS `model_not_in_catalog` sobre
// un catálogo parcial, vacío o no parseable — un catálogo vacío marcaría TODOS
// los modelos como muertos y entrenaría al operador a ignorar la barrera (R-G).
//
// `detail` es un ENUM CERRADO NUESTRO. PROHIBIDO propagar `e.message`: el
// mensaje de `JSON.parse` embebe un fragmento del body del tercero (R-B) —
// `Unexpected token '<', "<html>..."`. Por eso el `catch` va SIN binding.
// -----------------------------------------------------------------------------
const CATALOG_UNAVAILABLE_DETAILS = Object.freeze([
    'http_status',      // la respuesta no fue 200
    'request_failed',   // timeout / error de red — no hubo respuesta
    'truncated',        // el body superó MAX_CATALOG_BYTES
    'unparseable',      // no es JSON
    'paginated',        // vino `nextPageToken`: el catálogo está incompleto
    'extractor_error',  // el provider cambió el shape y el extractor lanzó
    'empty_catalog',    // 0 ids: shape cambiado, no "todos muertos" (R-G)
]);

function catalogUnavailable(detail) {
    return { ok: false, reason_code: 'model_check_unavailable', detail, models: [] };
}

function crossCheckCatalog({ spec, result, expectModels }) {
    if (!result || result.statusCode !== 200) return catalogUnavailable('http_status');
    if (result.catalogTruncated || !result.catalogRaw) return catalogUnavailable('truncated');
    let json;
    try { json = JSON.parse(result.catalogRaw.toString('utf8')); }
    catch { return catalogUnavailable('unparseable'); }  // catch SIN binding, a propósito (R-B)
    if (json && typeof json.nextPageToken === 'string' && json.nextPageToken) {
        return catalogUnavailable('paginated');          // G-2: catálogo parcial ≠ muerte
    }
    let ids;
    try { ids = spec.catalogExtract(json); }
    catch { return catalogUnavailable('extractor_error'); }
    if (!Array.isArray(ids) || ids.length === 0) return catalogUnavailable('empty_catalog');
    // S-B: `Set` con igualdad exacta de string. NUNCA un objeto plano indexado
    // por id del tercero (`__proto__` silenciaría la barrera para siempre), y
    // nunca un `RegExp` construido con el id remoto.
    const alive = new Set(ids.filter((x) => typeof x === 'string'));
    return {
        ok: true,
        reason_code: null,
        detail: null,
        models: expectModels.map((id) => ({ model_id: id, alive: alive.has(id) })),
    };
}

async function ping({ provider, secretsPath, fsImpl, httpImpl, nowMs, minIntervalMs, cliProbe, expectModels } = {}) {
    if (!isAllowedProvider(provider)) {
        return { ok: false, reason: 'unknown_provider', provider };
    }
    // #4402 CA-1 — Providers CLI-OAuth (anthropic MAX / codex): el pipeline los
    // usa por la CLI con OAuth, NO por API key. Validamos la sesión OAuth vía la
    // presencia del binario (camino LOCAL: scan de PATH, sin HTTP, sin cuota) en
    // vez de exigir una API key. Esto cierra el false-negative histórico
    // (`no_key_configured` en verde real). Va ANTES del gate `getRawKey` y del
    // throttle facturable de #3965 (que sólo protege llamadas HTTP con costo).
    //
    // RS-5.1/5.2 — este camino NUNCA lee ni devuelve la key/token: usa la misma
    // fuente única (`probeCliProvider`) que health-cron, garantizando el mismo
    // `reason_code` (`cli_oauth_ok` / `cli_unavailable`) en ping manual y tick.
    const managedSpec = secretsRw.MANAGED_KEYS.find(k => k.provider === provider);
    if (managedSpec && managedSpec.auth_mode === 'oauth') {
        return { ...probeCliProvider(managedSpec, { fsImpl, cliProbe }), provider };
    }
    const key = secretsRw.getRawKey({ provider, secretsPath, fsImpl });
    if (!key) {
        return { ok: false, reason: 'no_key_configured', provider };
    }
    // #3965 CA-4 — gate de throttle ANTES de cualquier HTTP facturable.
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const interval = typeof minIntervalMs === 'number' ? minIntervalMs : PING_MIN_INTERVAL_MS;
    if (_inFlight[provider]) {
        // Ya hay un ping en vuelo para este provider: rechazar sin HTTP.
        return { ok: false, reason: 'rate_limited_local', provider, rate_limited: true };
    }
    const last = _lastPingAt[provider];
    if (typeof last === 'number' && now - last < interval) {
        // Dentro del cooldown: rechazar sin HTTP.
        return {
            ok: false,
            reason: 'rate_limited_local',
            provider,
            rate_limited: true,
            retry_after_ms: interval - (now - last),
        };
    }
    // Reservamos el slot ANTES del await: anchea el cooldown al inicio del
    // request y bloquea pings concurrentes mientras éste está en vuelo.
    _lastPingAt[provider] = now;
    _inFlight[provider] = true;
    const spec = PROVIDER_PING_ENDPOINTS[provider];
    // #5888 — el catálogo SÓLO se baja cuando el llamador pide el cruce y el
    // spec sabe extraerlo. Sin `expectModels` el comportamiento es idéntico a
    // HEAD (el ping manual del dashboard y `api.js` no bajan catálogo — R-J).
    const wantsCatalog = Array.isArray(expectModels)
        && expectModels.length > 0
        && typeof spec.catalogExtract === 'function';
    const startedAt = Date.now();
    let result;
    try {
        result = await doRequest(spec, key, httpImpl, { collectCatalog: wantsCatalog });
    } catch (e) {
        const failed = {
            ok: false,
            reason: e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT'
                ? 'timeout'
                : 'network_error',
            provider,
            latency_ms: Date.now() - startedAt,
        };
        // CA-3 — timeout / error de red ⇒ `model_check_unavailable`, nunca `dead`.
        if (wantsCatalog) failed.catalog_check = catalogUnavailable('request_failed');
        return failed;
    } finally {
        _inFlight[provider] = false;
    }
    const interpretation = spec.interpret(result.statusCode, result.bodyExcerpt || '');
    const out = {
        ...interpretation,
        provider,
        statusCode: result.statusCode,
        latency_ms: Date.now() - startedAt,
    };
    if (wantsCatalog) {
        // El buffer del catálogo se consume acá y queda fuera de scope: lo único
        // que sobrevive es `[{ model_id, alive }]` con ids NUESTROS (CA-11/R-A).
        out.catalog_check = crossCheckCatalog({ spec, result, expectModels });
    }
    return out;
}

// #5888 S-C/R-F — `doRequest` acumula DOS buffers independientes:
//   - `errChunks`: el excerpt de error que SALE del módulo. Sigue capado en
//     512B, ahora con recorte a nivel de CHUNK (antes el guard evaluaba
//     `received < MAX` ANTES de acumular, así que un chunk de 1MB entraba
//     entero al buffer) y con `res.destroy()` para dejar de drenar el socket.
//   - `catChunks`: el catálogo. Privado, sólo si `collectCatalog` y `200`
//     (nunca acumulamos bodies de error — S-D).
// `res.destroy()` NO emite `'end'` (R-F): sin el handler de `'close'` la
// promesa nunca resolvería y TODOS los pings colgarían hasta `TIMEOUT_MS`.
function doRequest(spec, key, httpImpl, { collectCatalog = false } = {}) {
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
            const errChunks = []; let errReceived = 0;
            const catChunks = []; let catReceived = 0; let catTruncated = false;
            const wantsCatalog = collectCatalog === true
                && typeof spec.catalogExtract === 'function'
                && res.statusCode === 200;
            const destroyRes = () => { if (typeof res.destroy === 'function') res.destroy(); };
            res.on('data', (c) => {
                if (errReceived < MAX_BODY_EXCERPT) {
                    const room = MAX_BODY_EXCERPT - errReceived;
                    errChunks.push(c.length > room ? c.subarray(0, room) : c);
                    errReceived += Math.min(c.length, room);
                }
                if (wantsCatalog && !catTruncated) {
                    const room = MAX_CATALOG_BYTES - catReceived;
                    if (c.length >= room) {
                        catChunks.push(c.subarray(0, room));
                        catTruncated = true;
                        destroyRes();
                    } else {
                        catChunks.push(c);
                        catReceived += c.length;
                    }
                } else if (!wantsCatalog && errReceived >= MAX_BODY_EXCERPT) {
                    destroyRes();
                }
            });
            const finish = () => resolve({
                statusCode: res.statusCode,
                bodyExcerpt: Buffer.concat(errChunks).toString('utf8').slice(0, MAX_BODY_EXCERPT),
                catalogRaw: (wantsCatalog && !catTruncated) ? Buffer.concat(catChunks) : null,
                catalogTruncated: catTruncated,
            });
            res.on('end', finish);
            // R-F: `res.destroy()` no emite `'end'`. El 2do `resolve` es no-op.
            res.on('close', finish);
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
    // #3965 CA-4 — throttle server-side del ping.
    PING_MIN_INTERVAL_MS,
    _resetPingThrottle,
    // Exportado para tests del refactor #3486.
    _classifyForLivePing: classifyForLivePing,
    // #5888 — cap del buffer privado de catálogo + la función del cruce. R-A:
    // `doRequest` SIGUE sin exportarse, así que `catalogRaw` no tiene forma de
    // salir del módulo.
    MAX_CATALOG_BYTES,
    CATALOG_UNAVAILABLE_DETAILS,
    _crossCheckCatalog: crossCheckCatalog,
};

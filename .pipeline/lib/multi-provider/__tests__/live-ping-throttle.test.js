// =============================================================================
// live-ping-throttle.test.js — #3965 CA-4
//
// Verifica el throttle server-side de la acción "probar proveedor ahora":
//   1. Cooldown por proveedor: 2 POST consecutivos al mismo provider dentro del
//      intervalo → el 2do recibe 'rate_limited_local' y NO dispara HTTP saliente
//      (se cuenta cuántas veces se invoca el httpImpl mockeado).
//   2. Concurrencia: 1 ping in-flight por proveedor.
//   3. Pasado el intervalo, el ping vuelve a permitirse.
//   4. El gate aísla por proveedor (no cruza providers).
//
// Defensa OWASP A04 (Insecure Design) / A01 (cost-abuse): el ping golpea un
// endpoint FACTURABLE; el control client-side es evitable martillando el POST.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const livePing = require('../live-ping');

// #6563 — Tras la baja de cerebras/nvidia-nim no queda en el plantel ningún
// provider que se pinguee por API key: anthropic, codex y gemini-google
// (Antigravity) son OAuth y `ping()` hace short-circuit por el probe del CLI.
// El camino HTTP (throttle facturable, clasificación de status, endpoints
// literales anti-SSRF) se conserva como infraestructura, así que para
// ejercitarlo estos tests re-declaran temporalmente a `gemini-google` (y a
// `anthropic` cuando hace falta un segundo provider) como `api_key` en la
// lista gestionada que consulta `ping()`. `getRawKey` sigue usando la spec
// real (paths canónico/legacy de cada provider). Se restaura al terminar.
const secretsRw = require('../secrets-rw');
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

// ---------------------------------------------------------------------------
// httpImpl mock: registra cada request y responde 200 OK sin tocar la red.
// El contador `calls` es la prueba dura de "NO hubo HTTP saliente".
// ---------------------------------------------------------------------------
function makeHttpMock() {
    const state = { calls: 0 };
    const httpImpl = {
        request(_opts, cb) {
            state.calls += 1;
            const res = {
                statusCode: 200,
                on(event, handler) {
                    if (event === 'data') { /* sin body */ }
                    if (event === 'end') { setImmediate(handler); }
                    return res;
                },
            };
            // Invocamos el callback de respuesta de forma asíncrona, como node:https.
            setImmediate(() => cb(res));
            const req = {
                on() { return req; },
                write() {},
                end() {},
                destroy() {},
            };
            return req;
        },
    };
    return { httpImpl, state };
}

// Escribe un secrets.json canónico temporal con una key real para el provider
// (path canónico `providers.<id>.api_key`; para gemini-google el id es
// `google`), de modo que getRawKey devuelva la key y el ping llegue al gate.
function writeSecrets(provider, value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ping-'));
    const p = path.join(dir, 'credentials.json');
    fs.writeFileSync(p, JSON.stringify({ providers: { [provider]: { api_key: value } } }));
    return p;
}

test('cooldown: 2 POST consecutivos dentro del intervalo → el 2do es rate_limited_local SIN HTTP saliente', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('google', 'AIza-test-realkey-1234567890');

    const first = await withHttpPingProviders(['gemini-google'], () => livePing.ping({
        provider: 'gemini-google', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000,
    }));
    assert.equal(first.ok, true, 'el 1er ping debe llegar al provider y resolver ok');
    assert.equal(state.calls, 1, 'el 1er ping dispara exactamente 1 HTTP saliente');

    const second = await withHttpPingProviders(['gemini-google'], () => livePing.ping({
        provider: 'gemini-google', secretsPath, httpImpl, nowMs: 2_000, minIntervalMs: 10_000,
    }));
    assert.equal(second.ok, false, 'el 2do ping dentro del cooldown debe fallar');
    assert.equal(second.reason, 'rate_limited_local', 'reason esperado del throttle local');
    assert.equal(state.calls, 1, 'CLAVE: el 2do ping NO dispara HTTP saliente (sigue en 1)');
    assert.ok(second.retry_after_ms > 0, 'expone retry_after_ms para el cliente');
});

test('concurrencia: un 2do ping mientras el 1ro está in-flight → rate_limited_local SIN HTTP', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('google', 'AIza-test-realkey-1234567890');

    // No await del primero: queda in-flight cuando lanzamos el segundo.
    const [p1, second] = await withHttpPingProviders(['gemini-google'], async () => {
        const first = livePing.ping({ provider: 'gemini-google', secretsPath, httpImpl, minIntervalMs: 10_000 });
        const sec = await livePing.ping({ provider: 'gemini-google', secretsPath, httpImpl, minIntervalMs: 10_000 });
        await first; // dejar resolver el primero antes de restaurar la lista gestionada
        return [first, sec];
    });

    assert.equal(second.ok, false);
    assert.equal(second.reason, 'rate_limited_local', 'el ping concurrente se rechaza local');
    assert.equal(state.calls, 1, 'solo el 1er ping (in-flight) disparó HTTP');

});

test('pasado el intervalo, el ping se vuelve a permitir', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('google', 'AIza-test-realkey-1234567890');

    const again = await withHttpPingProviders(['gemini-google'], async () => {
        await livePing.ping({ provider: 'gemini-google', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 });
        return livePing.ping({ provider: 'gemini-google', secretsPath, httpImpl, nowMs: 1_000 + 10_001, minIntervalMs: 10_000 });
    });

    assert.equal(again.ok, true, 'tras superar el intervalo el ping vuelve a pasar');
    assert.equal(state.calls, 2, 'ambos pings (separados por > intervalo) dispararon HTTP');
});

test('el cooldown aísla por proveedor (no cruza providers)', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('google', 'AIza-test-realkey-1234567890');
    // Mismo archivo de secrets con dos providers api_key (paths canónicos que
    // matchean sus ids). #4402 — `openai` pasó a OAuth (short-circuit CLI, sin
    // HTTP) y #6563 retiró los api_key puros, así que para probar el aislamiento
    // del cooldown HTTP re-declaramos como api_key a gemini-google + anthropic.
    fs.writeFileSync(secretsPath, JSON.stringify({
        providers: {
            google: { api_key: 'AIza-test-realkey-1234567890' },
            anthropic: { api_key: 'sk-ant-test-realkey-1234567890' }, // secret-scan:ignore (fixture de test, no es una key real)
        },
    }));

    const [a, b] = await withHttpPingProviders(['gemini-google', 'anthropic'], async () => [
        await livePing.ping({ provider: 'gemini-google', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 }),
        await livePing.ping({ provider: 'anthropic', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 }),
    ]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true, 'otro provider no queda afectado por el cooldown del primero');
    assert.equal(state.calls, 2, 'cada provider disparó su propio HTTP');
});

// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

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

// #6861 — Providers HTTP FICTICIOS para el camino facturable.
//
// Tras #6563 (baja de cerebras/nvidia-nim) y #6861 (retiro del shim HTTP de
// Google AI Studio) el plantel entero es CLI-OAuth y `ping()` hace
// short-circuit por el probe del CLI antes de cualquier HTTP. El throttle
// protege el camino HTTP por API key, que se conserva como infraestructura:
// para ejercitarlo inyectamos providers de prueba (`fake-http-a` /
// `fake-http-b`) por el hook `_setPingEndpointsForTesting` (URL https literal
// en TLD reservado, RFC 2606) y hacemos que `getRawKey` les lea la key del
// archivo canónico del test (`providers.<id>.api_key`): no tienen spec en
// MANAGED_KEYS, así que la lectura real daría `null`. Mismo patrón que
// lib/__tests__/multi-provider-live-ping.test.js. Se restaura al terminar.
const secretsRw = require('../secrets-rw');
const FAKE_A = 'fake-http-a';
const FAKE_B = 'fake-http-b';
const REAL_GET_RAW_KEY = secretsRw.getRawKey;

function fakeSpec(provider) {
    return {
        url: `https://ping.${provider}.invalid/v1/models`,
        method: 'GET',
        body: () => null,
        headers: (key) => ({ authorization: `Bearer ${key}` }),
        interpret: (status, bodyExcerpt) => livePing._classifyForLivePing(provider, status, bodyExcerpt),
    };
}

function readFakeKey({ provider, secretsPath }) {
    try {
        const data = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        const entry = data && data.providers && data.providers[provider];
        return (entry && typeof entry.api_key === 'string' && entry.api_key) || null;
    } catch { return null; }
}

async function withFakeHttpProviders(providers, fn) {
    const table = {};
    for (const p of providers) table[p] = fakeSpec(p);
    livePing._setPingEndpointsForTesting(table);
    secretsRw.getRawKey = (args) => ((args && providers.includes(args.provider))
        ? readFakeKey(args)
        : REAL_GET_RAW_KEY(args));
    try { return await fn(); } finally {
        secretsRw.getRawKey = REAL_GET_RAW_KEY;
        livePing._resetPingEndpointsForTesting();
    }
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

// Escribe un secrets.json canónico temporal con una key para el provider
// (path canónico `providers.<id>.api_key`), de modo que el ping llegue al gate.
function writeSecrets(provider, value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ping-'));
    const p = path.join(dir, 'credentials.json');
    fs.writeFileSync(p, JSON.stringify({ providers: { [provider]: { api_key: value } } }));
    return p;
}

test('cooldown: 2 POST consecutivos dentro del intervalo → el 2do es rate_limited_local SIN HTTP saliente', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets(FAKE_A, 'fk-test-realkey-1234567890');

    const first = await withFakeHttpProviders([FAKE_A], () => livePing.ping({
        provider: FAKE_A, secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000,
    }));
    assert.equal(first.ok, true, 'el 1er ping debe llegar al provider y resolver ok');
    assert.equal(first.provider, FAKE_A);
    assert.equal(state.calls, 1, 'el 1er ping dispara exactamente 1 HTTP saliente');

    const second = await withFakeHttpProviders([FAKE_A], () => livePing.ping({
        provider: FAKE_A, secretsPath, httpImpl, nowMs: 2_000, minIntervalMs: 10_000,
    }));
    assert.equal(second.ok, false, 'el 2do ping dentro del cooldown debe fallar');
    assert.equal(second.reason, 'rate_limited_local', 'reason esperado del throttle local');
    assert.equal(state.calls, 1, 'CLAVE: el 2do ping NO dispara HTTP saliente (sigue en 1)');
    assert.ok(second.retry_after_ms > 0, 'expone retry_after_ms para el cliente');
});

test('concurrencia: un 2do ping mientras el 1ro está in-flight → rate_limited_local SIN HTTP', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets(FAKE_A, 'fk-test-realkey-1234567890');

    // No await del primero: queda in-flight cuando lanzamos el segundo.
    const [p1, second] = await withFakeHttpProviders([FAKE_A], async () => {
        const first = livePing.ping({ provider: FAKE_A, secretsPath, httpImpl, minIntervalMs: 10_000 });
        const sec = await livePing.ping({ provider: FAKE_A, secretsPath, httpImpl, minIntervalMs: 10_000 });
        await first; // dejar resolver el primero antes de restaurar la tabla inyectada
        return [first, sec];
    });

    assert.equal(second.ok, false);
    assert.equal(second.reason, 'rate_limited_local', 'el ping concurrente se rechaza local');
    assert.equal(state.calls, 1, 'solo el 1er ping (in-flight) disparó HTTP');

});

test('pasado el intervalo, el ping se vuelve a permitir', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets(FAKE_A, 'fk-test-realkey-1234567890');

    const again = await withFakeHttpProviders([FAKE_A], async () => {
        await livePing.ping({ provider: FAKE_A, secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 });
        return livePing.ping({ provider: FAKE_A, secretsPath, httpImpl, nowMs: 1_000 + 10_001, minIntervalMs: 10_000 });
    });

    assert.equal(again.ok, true, 'tras superar el intervalo el ping vuelve a pasar');
    assert.equal(state.calls, 2, 'ambos pings (separados por > intervalo) dispararon HTTP');
});

test('el cooldown aísla por proveedor (no cruza providers)', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets(FAKE_A, 'fk-test-realkey-1234567890');
    // Mismo archivo de secrets con dos providers api_key (paths canónicos que
    // matchean sus ids). #4402 — `openai` pasó a OAuth (short-circuit CLI, sin
    // HTTP), #6563 retiró los api_key puros y #6861 el shim de AI Studio, así
    // que para probar el aislamiento del cooldown HTTP inyectamos DOS providers
    // ficticios.
    fs.writeFileSync(secretsPath, JSON.stringify({
        providers: {
            [FAKE_A]: { api_key: 'fk-test-realkey-1234567890' },
            [FAKE_B]: { api_key: 'fk-test-otherkey-1234567890' },
        },
    }));

    const [a, b] = await withFakeHttpProviders([FAKE_A, FAKE_B], async () => [
        await livePing.ping({ provider: FAKE_A, secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 }),
        await livePing.ping({ provider: FAKE_B, secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 }),
    ]);

    assert.equal(a.ok, true);
    assert.equal(a.provider, FAKE_A);
    assert.equal(b.ok, true, 'otro provider no queda afectado por el cooldown del primero');
    assert.equal(b.provider, FAKE_B);
    assert.equal(state.calls, 2, 'cada provider disparó su propio HTTP');
});

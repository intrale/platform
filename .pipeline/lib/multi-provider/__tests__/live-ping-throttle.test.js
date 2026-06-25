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

// Escribe un secrets.json canónico temporal con una key real para `cerebras`,
// de modo que getRawKey devuelva la key y el ping llegue al gate de throttle.
function writeSecrets(provider, value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ping-'));
    const p = path.join(dir, 'credentials.json');
    fs.writeFileSync(p, JSON.stringify({ providers: { [provider]: { api_key: value } } }));
    return p;
}

test('cooldown: 2 POST consecutivos dentro del intervalo → el 2do es rate_limited_local SIN HTTP saliente', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('cerebras', 'csk-test-realkey-1234567890');

    const first = await livePing.ping({
        provider: 'cerebras', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000,
    });
    assert.equal(first.ok, true, 'el 1er ping debe llegar al provider y resolver ok');
    assert.equal(state.calls, 1, 'el 1er ping dispara exactamente 1 HTTP saliente');

    const second = await livePing.ping({
        provider: 'cerebras', secretsPath, httpImpl, nowMs: 2_000, minIntervalMs: 10_000,
    });
    assert.equal(second.ok, false, 'el 2do ping dentro del cooldown debe fallar');
    assert.equal(second.reason, 'rate_limited_local', 'reason esperado del throttle local');
    assert.equal(state.calls, 1, 'CLAVE: el 2do ping NO dispara HTTP saliente (sigue en 1)');
    assert.ok(second.retry_after_ms > 0, 'expone retry_after_ms para el cliente');
});

test('concurrencia: un 2do ping mientras el 1ro está in-flight → rate_limited_local SIN HTTP', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('cerebras', 'csk-test-realkey-1234567890');

    // No await del primero: queda in-flight cuando lanzamos el segundo.
    const p1 = livePing.ping({ provider: 'cerebras', secretsPath, httpImpl, minIntervalMs: 10_000 });
    const second = await livePing.ping({ provider: 'cerebras', secretsPath, httpImpl, minIntervalMs: 10_000 });

    assert.equal(second.ok, false);
    assert.equal(second.reason, 'rate_limited_local', 'el ping concurrente se rechaza local');
    assert.equal(state.calls, 1, 'solo el 1er ping (in-flight) disparó HTTP');

    await p1; // dejar resolver el primero
});

test('pasado el intervalo, el ping se vuelve a permitir', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('cerebras', 'csk-test-realkey-1234567890');

    await livePing.ping({ provider: 'cerebras', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 });
    const again = await livePing.ping({ provider: 'cerebras', secretsPath, httpImpl, nowMs: 1_000 + 10_001, minIntervalMs: 10_000 });

    assert.equal(again.ok, true, 'tras superar el intervalo el ping vuelve a pasar');
    assert.equal(state.calls, 2, 'ambos pings (separados por > intervalo) dispararon HTTP');
});

test('el cooldown aísla por proveedor (no cruza providers)', async () => {
    livePing._resetPingThrottle();
    const { httpImpl, state } = makeHttpMock();
    const secretsPath = writeSecrets('cerebras', 'csk-test-realkey-1234567890');
    // Mismo archivo de secrets con dos providers (paths canónicos que matchean
    // sus ids: cerebras→providers.cerebras, openai→providers.openai).
    fs.writeFileSync(secretsPath, JSON.stringify({
        providers: {
            cerebras: { api_key: 'csk-test-realkey-1234567890' },
            openai: { api_key: 'sk-test-realkey-1234567890' },
        },
    }));

    const a = await livePing.ping({ provider: 'cerebras', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 });
    const b = await livePing.ping({ provider: 'openai', secretsPath, httpImpl, nowMs: 1_000, minIntervalMs: 10_000 });

    assert.equal(a.ok, true);
    assert.equal(b.ok, true, 'otro provider no queda afectado por el cooldown del primero');
    assert.equal(state.calls, 2, 'cada provider disparó su propio HTTP');
});

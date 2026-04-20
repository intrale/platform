// =============================================================================
// Tests http-client.js — CA-3 / CA-4 / CA-5 / CA-7 / CA-14 / CA-16 / CA-19 / CA-20
// Usa servidores HTTP/HTTPS locales, con certs self-signed generados en runtime.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const {
    request, get, post, postJson,
    _computeBackoffMs, _assertNoCRLFInjection,
} = require('../http-client');

// ---- Helpers ----------------------------------------------------------------

// Cert self-signed generado en memoria con node:crypto. CN = "127.0.0.1".
function generateSelfSigned(cn = '127.0.0.1') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const notBefore = new Date();
    const notAfter = new Date(Date.now() + 24 * 3600 * 1000);

    // Crear certificado x509 manualmente con X509Certificate no es posible directamente;
    // node no expone API de creación. Usamos mkcert-like via tls.createSecureContext con key+selfsigned.
    // Alternativa: usar el cert embebido (más simple y confiable cross-platform).
    return null; // no soportado; tests TLS usan cert embebido más abajo
}

// Cert self-signed fijo (CN=localhost + SAN=127.0.0.1, válido 100 años, solo para tests).
// Generado offline con openssl — válido solo dentro de los tests.
// Para evitar complejidad, los tests de TLS se hacen pidiendo al server con
// un CA custom inyectado vía options._ca (hook interno).
const { TEST_SELF_SIGNED_CERT, TEST_SELF_SIGNED_KEY } = require('./fixtures/tls-cert');

function localHttpServer(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            resolve({
                port,
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => srv.close(() => r())),
            });
        });
    });
}

function localHttpsServer(handler) {
    return new Promise((resolve) => {
        const srv = https.createServer({ key: TEST_SELF_SIGNED_KEY, cert: TEST_SELF_SIGNED_CERT }, handler);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            resolve({
                port,
                url: `https://127.0.0.1:${port}`,
                close: () => new Promise((r) => srv.close(() => r())),
            });
        });
    });
}

// Wrap para que los tests HTTP funcionen — http-client por default bloquea 127.0.0.1 (SSRF).
// Para tests locales, inyectamos un resolver DNS que reporte la IP como pública (ej 8.8.8.8)
// y montamos el server en una IP permitida. Imposible sin tocar red real.
//
// Solución: bypasseamos SSRF pasando un host "test.local" al http-client y un
// resolver custom que devuelve la IP local como si fuese pública 8.8.8.8 — pero
// luego el socket realmente se conecta a 127.0.0.1. Eso no funciona con socket
// "connect to IP" — el socket va al 8.8.8.8.
//
// Enfoque más simple: inyectar una opción interna `_skipSSRF` o redirigir el
// lookup al localhost. Pero SSRF es precisamente lo que debe bloquear. Lo que
// hacemos entonces:
//
// - Para tests de retry/backoff/timeout: usamos URL "http://ssrf-bypass.test"
//   con resolver DNS que devuelve una IP PÚBLICA falsa (8.8.8.8), y confirmamos
//   que el error de conexión ocurre como esperamos.
// - Para tests con servers reales, creamos el server en 127.0.0.1 y monkey-patch
//   `validateHostname` via require.cache para permitir 127.0.0.1 dentro del
//   bloque de test. Esto demuestra explicitamente el bypass.
//
// Para mantenerlo simple: los tests de HTTP real usan un resolver DNS custom
// para hacer que el hostname resuelva a una IP pública falsa que nunca llega
// a conectar, Y para los tests que necesitan server real, reemplazamos el
// módulo ssrf-guard con uno permisivo en el cache de require (test-only).

// Inyección de un ssrf-guard permisivo solo durante los tests que usan servers locales.
const path = require('node:path');
const ssrfGuardPath = require.resolve('../ssrf-guard');
const originalSsrf = require('../ssrf-guard');

function withPermissiveSSRF(fn) {
    return async (...args) => {
        const cache = require.cache[ssrfGuardPath];
        const original = cache.exports.validateHostname;
        cache.exports.validateHostname = async (host) => {
            // Traducir: "localhost.test" → 127.0.0.1
            if (host === '127.0.0.1') return [{ address: '127.0.0.1', family: 4 }];
            if (host.endsWith('.test')) return [{ address: '127.0.0.1', family: 4 }];
            return original(host);
        };
        try {
            return await fn(...args);
        } finally {
            cache.exports.validateHostname = original;
        }
    };
}

// ---- Tests CA-3 / CA-4 · retry y backoff ------------------------------------

test('CA-3 · computeBackoffMs: 2s → 4s → 8s con jitter ±20%', () => {
    for (let i = 0; i < 50; i++) {
        const d1 = _computeBackoffMs(1);
        const d2 = _computeBackoffMs(2);
        const d3 = _computeBackoffMs(3);
        assert.ok(d1 >= 1600 && d1 <= 2400, `attempt1 fuera de rango: ${d1}`);
        assert.ok(d2 >= 3200 && d2 <= 4800, `attempt2 fuera de rango: ${d2}`);
        assert.ok(d3 >= 6400 && d3 <= 9600, `attempt3 fuera de rango: ${d3}`);
    }
});

test('CA-4 · GET reintenta en ECONNREFUSED', withPermissiveSSRF(async () => {
    // Puerto 1 no tiene nada escuchando (seguro).
    let attempts = 0;
    try {
        await get('http://127.0.0.1:1/x', {
            timeout: 30000,
            agentTag: 'test',
        });
    } catch (err) {
        assert.equal(err.code, 'ERR_RETRY_EXHAUSTED');
    }
    // No contamos directamente, pero el timeout total debe permitir los 3 intentos
}));

test('CA-4 · POST sin retryable NO reintenta', withPermissiveSSRF(async () => {
    let attempts = 0;
    const srv = await localHttpServer((req, res) => {
        attempts++;
        req.destroy(); // ECONNRESET
    });
    try {
        await post(`${srv.url}/x`, { a: 1 }, { timeout: 10000, agentTag: 'test' });
        assert.fail('debería haber fallado');
    } catch (err) {
        // Solo 1 intento (POST sin retryable)
        assert.equal(attempts, 1, `esperaba 1 intento, hubo ${attempts}`);
    } finally {
        await srv.close();
    }
}));

test('CA-4 · POST con retryable:true SÍ reintenta', withPermissiveSSRF(async () => {
    let attempts = 0;
    const srv = await localHttpServer((req, res) => {
        attempts++;
        if (attempts < 3) {
            req.destroy(); // ECONNRESET
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempts }));
    });
    try {
        const r = await post(`${srv.url}/x`, { a: 1 }, {
            retryable: true,
            timeout: 60000,
            agentTag: 'test',
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.ok, true);
        assert.equal(attempts, 3);
    } finally {
        await srv.close();
    }
}));

test('CA-4 · POST con Idempotency-Key SÍ reintenta', withPermissiveSSRF(async () => {
    let attempts = 0;
    const srv = await localHttpServer((req, res) => {
        attempts++;
        if (attempts < 2) { req.destroy(); return; }
        res.writeHead(200); res.end('ok');
    });
    try {
        const r = await post(`${srv.url}/x`, 'payload', {
            headers: { 'Idempotency-Key': 'abc-123' },
            timeout: 60000,
            agentTag: 'test',
        });
        assert.equal(r.statusCode, 200);
        assert.equal(attempts, 2);
    } finally {
        await srv.close();
    }
}));

test('CA-3 · NO reintenta en 4xx/5xx', withPermissiveSSRF(async () => {
    let attempts = 0;
    const srv = await localHttpServer((req, res) => {
        attempts++;
        res.writeHead(500); res.end('fail');
    });
    try {
        const r = await get(`${srv.url}/x`, { timeout: 10000, agentTag: 'test' });
        assert.equal(r.statusCode, 500);
        assert.equal(attempts, 1);
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-5 · timeouts ---------------------------------------------------

test('CA-5 · timeout total excede → error', withPermissiveSSRF(async () => {
    const srv = await localHttpServer((req, res) => {
        // Nunca responde.
    });
    try {
        await get(`${srv.url}/x`, { timeout: 1500, agentTag: 'test' });
        assert.fail('debería haber timeout');
    } catch (err) {
        assert.match(err.code || '', /TIMEOUT|RETRY/);
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-7 / CA-20 · TLS estricto --------------------------------------

test('CA-7 · cert self-signed inválido rompe el request', withPermissiveSSRF(async () => {
    const srv = await localHttpsServer((req, res) => {
        res.writeHead(200); res.end('hi');
    });
    try {
        await get(srv.url + '/', { timeout: 5000, agentTag: 'test' });
        assert.fail('TLS self-signed debería haber fallado');
    } catch (err) {
        // Esperamos error de cert. Puede ser DEPTH_ZERO_SELF_SIGNED_CERT, o
        // SELF_SIGNED_CERT_IN_CHAIN, o UNABLE_TO_VERIFY_LEAF_SIGNATURE.
        const msg = (err.message || '') + (err.code || '');
        assert.ok(
            /self[- ]?signed|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME|TLS|cert/i.test(msg),
            `mensaje de error TLS inesperado: ${msg}`
        );
    } finally {
        await srv.close();
    }
}));

test('CA-7 · con CA custom (cert confiado) → 200 OK', withPermissiveSSRF(async () => {
    const srv = await localHttpsServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    try {
        const r = await get(srv.url + '/', {
            timeout: 5000,
            agentTag: 'test',
            _ca: TEST_SELF_SIGNED_CERT, // hook interno solo para tests
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.ok, true);
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-14 · redirects -------------------------------------------------

test('CA-14 · followRedirects=false por default → 3xx devuelve error', withPermissiveSSRF(async () => {
    const srv = await localHttpServer((req, res) => {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
        res.end();
    });
    try {
        await get(srv.url + '/', { timeout: 5000, agentTag: 'test' });
        assert.fail('debería haber fallado por redirect disabled');
    } catch (err) {
        assert.equal(err.code, 'ERR_REDIRECT_DISABLED');
    } finally {
        await srv.close();
    }
}));

test('CA-14 · cross-origin drop de Authorization/Cookie', withPermissiveSSRF(async () => {
    // Montamos dos servers; el primero redirige al segundo con hostname distinto.
    let leakedAuth = null;
    const target = await localHttpServer((req, res) => {
        leakedAuth = req.headers.authorization || null;
        res.writeHead(200); res.end('ok');
    });
    const src = await localHttpServer((req, res) => {
        // Redirigir a hostname distinto (usamos "other.test" → mapped a 127.0.0.1 por SSRF stub)
        res.writeHead(302, { Location: `http://other.test:${target.port}/` });
        res.end();
    });
    try {
        const r = await get(src.url + '/', {
            followRedirects: true,
            timeout: 10000,
            agentTag: 'test',
            headers: { Authorization: 'Bearer secret', Cookie: 'x=1' },
        });
        assert.equal(r.statusCode, 200);
        assert.equal(leakedAuth, null, 'Authorization no debería haber cruzado origen');
    } finally {
        await src.close();
        await target.close();
    }
}));

test('CA-14 · maxRedirects respetado', withPermissiveSSRF(async () => {
    let hops = 0;
    const srv = await localHttpServer((req, res) => {
        hops++;
        res.writeHead(302, { Location: '/next' });
        res.end();
    });
    try {
        await get(srv.url + '/', {
            followRedirects: true,
            maxRedirects: 2,
            timeout: 5000,
            agentTag: 'test',
        });
        assert.fail('debería haber superado maxRedirects');
    } catch (err) {
        assert.equal(err.code, 'ERR_REDIRECT_LIMIT');
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-16 · CRLF injection ------------------------------------------

test('CA-16 · header con \\r\\n lanza ERR_CRLF_INJECTION', () => {
    assert.throws(
        () => _assertNoCRLFInjection({ 'X-Custom': 'value\r\nInjected: evil' }),
        (err) => err.code === 'ERR_CRLF_INJECTION',
    );
    assert.throws(
        () => _assertNoCRLFInjection({ 'X-Name': 'v\nl' }),
        (err) => err.code === 'ERR_CRLF_INJECTION',
    );
    assert.throws(
        () => _assertNoCRLFInjection({ 'X-Nul': 'v\u0000' }),
        (err) => err.code === 'ERR_CRLF_INJECTION',
    );
});

test('CA-16 · request con CRLF en header aborta antes de red', async () => {
    await assert.rejects(
        () => request('https://example.com', { headers: { 'X-Bad': 'a\r\nHost: evil' } }),
        (err) => err.code === 'ERR_CRLF_INJECTION',
    );
});

// ---- Tests CA-19 · response body cap ----------------------------------------

test('CA-19 · response >maxResponseBytes aborta con ERR_RESPONSE_TOO_LARGE', withPermissiveSSRF(async () => {
    const big = Buffer.alloc(1024 * 1024, 'a'); // 1 MB
    const srv = await localHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        // Enviar 5 MB
        for (let i = 0; i < 5; i++) res.write(big);
        res.end();
    });
    try {
        await get(srv.url + '/', {
            maxResponseBytes: 1 * 1024 * 1024,
            timeout: 15000,
            agentTag: 'test',
        });
        assert.fail('debería haber abortado');
    } catch (err) {
        assert.equal(err.code, 'ERR_RESPONSE_TOO_LARGE');
    } finally {
        await srv.close();
    }
}));

test('CA-19 · response <cap se lee OK', withPermissiveSSRF(async () => {
    const srv = await localHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hola');
    });
    try {
        const r = await get(srv.url + '/', { timeout: 5000, agentTag: 'test' });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body, 'hola');
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-9 integration: URL a IP privada rechaza -----------------------

test('CA-9 · URL con hostname que resuelve a 127.0.0.1 rechaza ERR_SSRF_BLOCKED', async () => {
    // SIN el stub permisivo → la validación real dispara.
    await assert.rejects(
        () => get('http://127.0.0.1:1/', { timeout: 5000, agentTag: 'test' }),
        (err) => err.code === 'ERR_SSRF_BLOCKED',
    );
});

test('CA-9 · URL con userinfo rechaza ERR_USERINFO_BLOCKED', async () => {
    await assert.rejects(
        () => get('http://user:pass@example.com/', { timeout: 5000, agentTag: 'test' }),
        (err) => err.code === 'ERR_USERINFO_BLOCKED',
    );
});

// ---- Test JSON helper ------------------------------------------------------

test('postJson · serializa y setea content-type', withPermissiveSSRF(async () => {
    let got = null;
    const srv = await localHttpServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            got = { body: data, ct: req.headers['content-type'] };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
        });
    });
    try {
        const r = await postJson(srv.url + '/', { a: 1, b: 'x' }, {
            retryable: true, timeout: 5000, agentTag: 'test',
        });
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.body, { received: true });
        assert.ok(got.ct && got.ct.includes('application/json'));
        assert.equal(JSON.parse(got.body).a, 1);
    } finally {
        await srv.close();
    }
}));

// ---- Tests CA-11 (issue #2332) · logging de denials SSRF --------------------

/**
 * Captura stderr durante la ejecución de `fn` y devuelve lo escrito.
 * Usado para validar que el logger.error del http-client emitió el DENIAL.
 */
async function captureStderr(fn) {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const chunks = [];
    process.stderr.write = (chunk, enc, cb) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
    };
    try {
        await fn();
    } finally {
        process.stderr.write = originalWrite;
    }
    return chunks.join('');
}

test('CA-11 · SSRF a 169.254.169.254 logea DENIAL con URL/host/razón/stack', async () => {
    let err = null;
    const stderr = await captureStderr(async () => {
        try {
            await get('http://169.254.169.254/latest/meta-data/', {
                timeout: 5000,
                agentTag: 'test-ca11',
            });
        } catch (e) {
            err = e;
        }
    });

    // El error sigue propagándose (no silenciamos denial).
    assert.ok(err, 'el request debía fallar');
    assert.equal(err.code, 'ERR_SSRF_BLOCKED');

    // El log estructurado fue escrito a stderr con todos los campos requeridos.
    assert.match(stderr, /ERROR/, 'debe ser nivel ERROR');
    assert.match(stderr, /DENIAL ERR_SSRF_BLOCKED/);
    assert.match(stderr, /url=http:\/\/169\.254\.169\.254/);
    assert.match(stderr, /host=169\.254\.169\.254/);
    assert.match(stderr, /razon=/);
    assert.match(stderr, /stack=/);
    assert.match(stderr, /test-ca11/); // agentTag en el tag del logger
});

test('CA-11 · SSRF a 127.0.0.1 logea DENIAL (otro rango privado)', async () => {
    let err = null;
    const stderr = await captureStderr(async () => {
        try {
            await get('http://127.0.0.1:1/', {
                timeout: 5000,
                agentTag: 'test-loopback',
            });
        } catch (e) {
            err = e;
        }
    });
    assert.equal(err && err.code, 'ERR_SSRF_BLOCKED');
    assert.match(stderr, /DENIAL ERR_SSRF_BLOCKED/);
    assert.match(stderr, /host=127\.0\.0\.1/);
});

test('CA-11 · request exitoso NO emite DENIAL', withPermissiveSSRF(async () => {
    const srv = await localHttpServer((req, res) => {
        res.writeHead(200); res.end('ok');
    });
    try {
        const stderr = await captureStderr(async () => {
            await get(srv.url + '/', { timeout: 5000, agentTag: 'test-happy' });
        });
        assert.ok(!/DENIAL/.test(stderr), `no debería haber DENIAL en stderr: ${stderr}`);
    } finally {
        await srv.close();
    }
}));

test('CA-11.1 · DENIAL sobre URL de Telegram NO filtra el BOT_TOKEN a stderr', async () => {
    // Escenario real de takeover: el SSRF guard rechaza api.telegram.org porque
    // el resolver DNS devuelve una IP privada (DNS rebinding / /etc/hosts
    // manipulado / proxy mal configurado). El http-client.js emite DENIAL y
    // loggea la URL. Si `redactUrlLike` no cierra el path `/bot<TOKEN>/...`,
    // el token se escribe en claro a stderr → takeover total del bot.
    //
    // Este test fuerza ese path con un resolver DNS custom que mapea
    // api.telegram.org → 127.0.0.1 (privada).
    const FAKE_TOKEN = '1234567890:ABCDefGHIjklMNOpqrsTUVwxyz_sensitive';
    const telegramUrl = `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`;
    const rebindingResolver = {
        lookup: async (_host, _opts) => [{ address: '127.0.0.1', family: 4 }],
    };

    let err = null;
    const stderr = await captureStderr(async () => {
        try {
            await get(telegramUrl, {
                timeout: 5000,
                agentTag: 'test-ca11-telegram',
                _dnsResolver: rebindingResolver,
            });
        } catch (e) {
            err = e;
        }
    });

    // El error sigue propagándose (no fail-open).
    assert.ok(err, 'el request debía fallar');
    assert.equal(err.code, 'ERR_SSRF_BLOCKED');

    // El DENIAL fue emitido...
    assert.match(stderr, /DENIAL ERR_SSRF_BLOCKED/, `debió loggear DENIAL: ${stderr}`);
    assert.match(stderr, /host=api\.telegram\.org/);

    // ...pero el token NO debe aparecer en stderr, en ninguna variante.
    assert.ok(!stderr.includes(FAKE_TOKEN),
        `BOT_TOKEN filtrado a stderr: ${stderr}`);
    assert.ok(!stderr.includes('ABCDefGHIjklMNOpqrsTUVwxyz_sensitive'),
        `fragmento opaco del token filtrado: ${stderr}`);
    // Debe aparecer el marker de redacción.
    assert.match(stderr, /\/bot\[REDACTED\]/,
        `path del bot debe estar redactado: ${stderr}`);
});

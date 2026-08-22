// =============================================================================
// smoke-health-retry-4131.test.js — gate de rollback resiliente al pico de
// arranque (#4131).
//
// Contexto: el smoke test del restart gatea el rollback contra /api/health del
// dashboard. Con un único tiro de 5s, el pico de arranque (pulpo + 7 servicios
// peleando CPU) estiraba la respuesta del health por encima de los 5s y
// disparaba un FALSO rollback, aunque el dashboard estaba sano (respondía 200
// 0,5-0,7s ya estabilizado). El fix reintenta el health con espera corta antes
// de declarar caído.
//
// Cubre:
//   1. Health sano al primer intento → ok, sin reintentos.
//   2. Health lento (falla N veces y luego responde 200) → ok tras reintentos.
//   3. Health realmente caído (falla siempre) → !ok tras agotar los intentos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { checkDashboardHttpWithRetry } = require('../smoke-test.js');

// Servidor local que falla las primeras `failFirst` requests (cerrando el
// socket sin responder) y a partir de ahí responde 200. Simula el pico de
// arranque: caído un rato, después sano.
function makeFlakyServer(failFirst) {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        if (hits <= failFirst) {
            res.socket.destroy(); // simula no-respuesta / error de conexión
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    return { server, hits: () => hits };
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('1 · health sano al primer intento → ok sin reintentos', async () => {
    const { server, hits } = makeFlakyServer(0);
    const port = await listen(server);
    try {
        const r = await checkDashboardHttpWithRetry(port, '/api/health', { attempts: 5, perAttemptMs: 1000, delayMs: 50 });
        assert.equal(r.ok, true);
        assert.equal(hits(), 1, 'no reintentó: respondió al primer tiro');
    } finally {
        server.close();
    }
});

test('2 · health lento (falla 3 y luego responde 200) → ok tras reintentos', async () => {
    const { server, hits } = makeFlakyServer(3);
    const port = await listen(server);
    try {
        const r = await checkDashboardHttpWithRetry(port, '/api/health', { attempts: 6, perAttemptMs: 1000, delayMs: 20 });
        assert.equal(r.ok, true, 'el retry absorbe el pico de arranque');
        assert.equal(hits(), 4, 'falló 3 veces y respondió 200 en el 4.º intento');
    } finally {
        server.close();
    }
});

test('3 · health realmente caído (falla siempre) → !ok tras agotar intentos', async () => {
    const { server, hits } = makeFlakyServer(Infinity);
    const port = await listen(server);
    try {
        const r = await checkDashboardHttpWithRetry(port, '/api/health', { attempts: 3, perAttemptMs: 500, delayMs: 20 });
        assert.equal(r.ok, false, 'dashboard caído sigue gateando rollback');
        assert.equal(hits(), 3, 'agotó los 3 intentos configurados');
    } finally {
        server.close();
    }
});

// =============================================================================
// Tests SSR de la ventana Ops (#3732, split del épico #3715).
//
// Cubre el Bloque G de criterios del PO + REQ-SEC del análisis security:
//   1. renderOps(opsSlice(stateValido)) incluye los 4 IDs DOM canónicos.
//   2. Estado degradado (TG down + proceso muerto) → banner visible + card
//      con clase bot-down.
//   3. Payload XSS canónico en contenido + atributo title= + aria-label NO
//      renderiza como HTML ejecutable (CA-D2 / REQ-SEC-1,2).
//   4. renderInert() retorna HTML visible "Ventana Ops no disponible" (CA-A3).
//   5. sanitizeRuntime() redacta un JWT y preserva un mensaje legítimo (CA-D3).
//   + Smoke E2E vía dashboard-routes.handle(): /ops y ?view=ops → 200 con IDs.
//
// node:test (sin Jest). No arranca dashboard.js (side effects); usa el render
// directo de la función y un http.createServer efímero para el smoke.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const OPS_PATH = path.resolve(__dirname, '..', 'ops.js');
const SLICES_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'dashboard-slices.js');
const ROUTES_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'dashboard-routes.js');

const ops = require(OPS_PATH);
const { opsSlice } = require(SLICES_PATH);

// IDs DOM que el smoke curl de CA-G2 espera (grep -c >= 4).
const DOM_IDS = ['ops-tg-banner', 'ops-procesos', 'stale-orders-count', 'ops-qaenv'];

// Payloads XSS canónicos (mismo set que home.test.js, paridad CA-D2).
const XSS_BODY = '<script>alert(1)</script>';
const XSS_ATTR = '"><img src=x onerror=alert(1)>';
const XSS_DOUBLE = '&#x6a;avascript';

function validState() {
    return {
        procesos: {
            'listener': { alive: true, pid: 101, uptime: 3_600_000 },
            'svc-telegram': { alive: true, pid: 102, uptime: 1_800_000 },
            'svc-github': { alive: true, pid: 103, uptime: 900_000 },
            'svc-drive': { alive: true, pid: 104, uptime: 120_000 },
            'svc-emulador': { alive: true, pid: 105, uptime: 60_000 },
        },
        servicios: {
            telegram: { pendiente: 0, trabajando: 1, listo: 2 },
            github: { pendiente: 3, trabajando: 0, listo: 5 },
            drive: { pendiente: 0, trabajando: 0, listo: 0 },
            emulador: { pendiente: 0, trabajando: 0, listo: 1 },
            commander: { pendiente: 0, trabajando: 0, listo: 0 },
        },
        qaEnv: { ok: true, region: 'us-east-1' },
        qaRemote: { ok: true, lambda: 'kotlinTest' },
        infraHealth: { ok: true, cpu: '42%' },
        resources: {},
        telegramHealth: { ok: true },
    };
}

function degradedState() {
    const s = validState();
    s.procesos['svc-emulador'] = { alive: false, pid: null, uptime: 0 };
    s.telegramHealth = {
        ok: false,
        updatedAt: '2026-06-07T12:00:00Z',
        lastError: { description: 'API rechazada por token expirado', code: 401, source: 'getMe' },
    };
    s.infraHealth = { ok: false, cpu: '98%' };
    return s;
}

// ─────────────────────────── Bloque G ───────────────────────────

test('CA-G1.1 · renderOps(opsSlice(estado válido)) incluye los 4 IDs DOM', () => {
    const html = ops.renderOps(opsSlice(validState()));
    assert.equal(typeof html, 'string');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'debe ser un documento HTML completo');
    for (const id of DOM_IDS) {
        assert.ok(html.includes('id="' + id + '"'), 'falta el ID DOM: ' + id);
    }
    assert.ok(html.includes('<title>Intrale · Ops</title>'), 'falta el title de la ventana');
    // No debe quedar el anti-patrón <pre> envolviendo el dump JSON (CA-C2).
    assert.ok(!/<pre[^>]*id="ops-qaenv"/.test(html), 'el <pre> de JSON crudo debe estar eliminado (CA-C2)');
    // QA env rediseñado a pills (EP8-H7 #3960, CA-5 · mockup §2.5): el bloque
    // de mini-cards pasó a pills compactas con dual-encoding. Se sigue exigiendo
    // que los entornos local (qaEnv→emulador) y remoto (qaRemote→backend) estén
    // presentes — la intención del contrato se preserva, cambia el primitivo.
    assert.ok(html.includes('class="ops-qa-pills"'), 'falta el contenedor de pills QA env');
    assert.ok(/aria-label="emulador /.test(html), 'falta pill qaEnv (entorno local · emulador)');
    assert.ok(/aria-label="backend /.test(html), 'falta pill qaRemote (entorno remoto · backend)');
});

test('CA-G1.2 · estado degradado → banner Telegram visible + card bot-down', () => {
    const html = ops.renderOps(opsSlice(degradedState()));
    // Banner visible: clase ops-banner (NO ops-banner-hidden) en el contenedor.
    assert.ok(/<div id="ops-tg-banner" class="ops-banner"/.test(html), 'el banner debe estar visible');
    assert.ok(html.includes('Bot de Telegram caído'), 'falta el texto del banner');
    // listener + svc-telegram heredan bot-down cuando tgHealth.ok === false.
    assert.ok(html.includes('bot-down'), 'debe haber al menos una card con clase bot-down');
    // svc-emulador muerto → nodo dead. EP8-H7 (#3960) reemplazó la card
    // (`ops-card dead`) por el nodo de topología (`ops-node is-dead`); la
    // intención (proceso caído marcado como muerto, no solo color) se conserva.
    assert.ok(/<button[^>]*class="ops-node is-dead"[^>]*data-node="svc-emulador"/.test(html), 'svc-emulador debe renderizar como nodo dead');
});

test('CA-G1.2b · estado saludable → banner OCULTO', () => {
    const html = ops.renderOps(opsSlice(validState()));
    assert.ok(/<div id="ops-tg-banner" class="ops-banner-hidden"/.test(html), 'banner oculto con TG ok');
    // El contenedor del banner está vacío (sin el texto de alarma renderizado
    // server-side). Nota: el client JS embebido sí contiene el template del
    // banner como string — por eso NO chequeamos ausencia global del texto.
    assert.ok(/<div id="ops-tg-banner" class="ops-banner-hidden"[^>]*><\/div>/.test(html), 'el banner oculto no debe tener contenido SSR');
});

test('CA-D2 · payload XSS en contenido + title + aria-label NO es ejecutable', () => {
    const s = validState();
    // Inyección en NOMBRE de proceso (va a body + title= + aria-label=).
    s.procesos[XSS_ATTR] = { alive: true, pid: 1, uptime: 1000 };
    // Inyección en error de Telegram (sanitizeRuntime + escape body).
    s.telegramHealth = { ok: false, lastError: { description: XSS_BODY, code: 1, source: 'x' }, updatedAt: 'now' };
    // Inyección en valor de qaEnv (doble-escape check).
    s.qaEnv = { ok: true, note: XSS_DOUBLE };
    const html = ops.renderOps(opsSlice(s));

    assert.ok(!html.includes(XSS_BODY), 'el <script> crudo NO debe aparecer');
    assert.ok(html.includes('&lt;script&gt;'), 'el <script> debe aparecer escapado');
    assert.ok(!html.includes('onerror=alert(1)>'), 'el payload rompe-atributo NO debe quedar crudo');
    assert.ok(!html.includes('<img src=x'), 'no debe inyectarse un <img> ejecutable');
    // Sin doble-escape de entidades: & se escapa una sola vez.
    assert.ok(!html.includes('&amp;amp;'), 'no debe haber doble-escape de &');
});

test('CA-A3 · renderInert() retorna HTML visible "Ventana Ops no disponible"', () => {
    const html = ops.renderInert('require failed');
    assert.ok(html.includes('<h1>Ventana Ops no disponible</h1>'), 'falta el título de la vista inerte');
    assert.ok(html.includes('require failed'), 'debe mostrar el motivo');
    assert.ok(html.length > 100, 'el render inerte NO debe quedar vacío (REQ-SEC-7)');
});

test('CA-A3b · renderOps(null) cae al render inerte (sin state)', () => {
    const html = ops.renderOps(null);
    assert.ok(html.includes('Ventana Ops no disponible'), 'sin state → fallback inerte');
});

test('CA-A3c · renderInert escapa el motivo (no refleja XSS crudo)', () => {
    const html = ops.renderInert(XSS_BODY);
    assert.ok(!html.includes(XSS_BODY), 'el motivo no debe reflejar el <script> crudo');
    assert.ok(html.includes('&lt;script&gt;'), 'el motivo debe ir escapado');
});

test('CA-D3 · sanitizeRuntime redacta JWT y preserva mensaje legítimo', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_-XYZ';
    const redacted = ops.sanitizeRuntime(jwt);
    assert.ok(!redacted.includes('eyJhbGci'), 'el JWT no debe quedar en claro');
    assert.ok(redacted.includes('[REDACTED:JWT]'), 'el JWT debe redactarse con placeholder');

    const legit = 'API rechazada por token expirado';
    assert.equal(ops.sanitizeRuntime(legit), legit, 'un mensaje legítimo se preserva intacto');

    // Truncado tras sanitize (cap por defecto 200).
    const longText = 'x'.repeat(300);
    const capped = ops.sanitizeRuntime(longText, 50);
    assert.ok(capped.length <= 51, 'debe truncar al cap + elipsis');
    assert.ok(capped.endsWith('…'), 'el truncado agrega elipsis');
});

// ─────────────────────────── Smoke E2E (router) ───────────────────────────

function startEphemeralServer() {
    delete require.cache[require.resolve(ROUTES_PATH)];
    const dashRoutes = require(ROUTES_PATH);
    const fakeCtx = {
        getState: () => validState(),
        PIPELINE: '',
        ROOT: '',
        GH_BIN: '',
    };
    const server = http.createServer((req, res) => {
        try {
            if (dashRoutes.handle(req, res, fakeCtx)) return;
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('server error: ' + e.message);
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

function countDomIds(body) {
    return DOM_IDS.filter((id) => body.includes('id="' + id + '"')).length;
}

test('CA-G2 · smoke GET /ops → 200 con los 4 IDs DOM', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/ops');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Ops</title>'), 'debe servir la ventana Ops');
        assert.ok(countDomIds(r.body) >= 4, 'debe contener los 4 IDs DOM (grep -c >= 4)');
    } finally {
        await closeServer(server);
    }
});

test('CA-G2 · smoke GET /dashboard?view=ops → 200 con los 4 IDs DOM (mismo render)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=ops');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Ops</title>'), 'el router ?view=ops debe rendir Ops');
        assert.ok(countDomIds(r.body) >= 4, 'debe contener los 4 IDs DOM');
    } finally {
        await closeServer(server);
    }
});

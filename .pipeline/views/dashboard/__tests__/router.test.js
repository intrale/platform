// =============================================================================
// Smoke E2E del router cliente `?view=<slug>` (#3723, CA-G2 del épico #3715).
//
// Levanta un `http.createServer` efímero (port 0) montando `dashboard-routes.handle()`
// con el renderer REAL de `home.js` (sin stubs) y verifica:
//
//   - `/dashboard?view=home` devuelve 200 + body con `<title>Intrale · Operación</title>`.
//   - `/dashboard?view=foo` (slug desconocido) cae al fallback `home` con
//     `<title>Intrale · Operación</title>` y la bandera SSR `unknownViewRequested`
//     inyectada en `window.__VIEW_BOOT__` (CA-U5).
//   - `/dashboard/partial?view=home` desde loopback devuelve 200 con el HTML
//     del home + headers CA-S5 (Cache-Control no-store, X-Content-Type-Options
//     nosniff, Referrer-Policy no-referrer).
//   - `/dashboard/partial?view=NOPE` devuelve 400 + body `'bad request'` SIN
//     reflejar el slug (CA-S1 + CA-S4).
//
// NO arranca `dashboard.js` completo (es un módulo de 576KB con side effects:
// pollers, sessions, locks). El handler de routes es la unidad real bajo prueba
// y refleja exactamente la integración usada por el server de producción.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROUTES_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'dashboard-routes.js');

function startEphemeralServer() {
    // Cargar el módulo fresh — sin require.cache hits ni stubs (smoke real).
    delete require.cache[require.resolve(ROUTES_PATH)];
    const dashRoutes = require(ROUTES_PATH);

    const fakeCtx = {
        getState: () => ({}),
        PIPELINE: '',
        ROOT: '',
        GH_BIN: '',
    };

    const server = http.createServer((req, res) => {
        try {
            if (dashRoutes.handle(req, res, fakeCtx)) return;
            // Fallback genérico para que cualquier path no manejado devuelva 404
            // (espejo del catch-all legacy de dashboard.js).
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('server error: ' + e.message);
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        // host '127.0.0.1' explícito: el endpoint /dashboard/partial valida loopback.
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
}

function get(port, urlPath, extraHeaders) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method: 'GET',
            headers: extraHeaders || {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

test('smoke E2E: GET /dashboard?view=home → 200 con <title> del home (CA-G2)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=home');
        assert.equal(r.statusCode, 200);
        assert.ok(
            r.body.includes('<title>Intrale · Operación</title>'),
            'el body SSR debe incluir el title del home — confirma que NO cayó al catch-all legacy'
        );
        // CA-T1 + boot config inyectado por el router.
        assert.ok(r.body.includes('__VIEW_BOOT__'), 'falta config boot del router cliente');
        assert.ok(r.body.includes('"currentView":"home"'), 'currentView debe ser "home" en boot');
        assert.ok(r.body.includes('"unknownViewRequested":false'), 'sin slug desconocido la bandera es false');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard?view=xunknownslugx99 → fallback a home + bandera unknownViewRequested=true (CA-T1+CA-U5)', async () => {
    // Slug sintético improbable de aparecer naturalmente en el body del home
    // (que contiene texto en español como "Desconocido" como label de estado).
    const fakeSlug = 'xunknownslugx99';
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=' + fakeSlug);
        assert.equal(r.statusCode, 200, 'CA-T1: NUNCA 400 en SSR — siempre fallback');
        assert.ok(r.body.includes('<title>Intrale · Operación</title>'));
        assert.ok(r.body.includes('"unknownViewRequested":true'), 'CA-U5: bandera SSR para banner cliente');
        assert.ok(r.body.includes('"currentView":"home"'), 'currentView debe ser "home" en fallback (no el slug pedido)');
        // CA-S4: el slug pedido NUNCA debe aparecer en el body.
        assert.equal(r.body.includes(fakeSlug), false, 'CA-S4: slug NUNCA reflejado en el body');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard/partial?view=home desde loopback → 200 con headers CA-S5', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard/partial?view=home');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Operación</title>'));
        // CA-S5 — headers fijos del endpoint partial.
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(r.headers['cache-control'], 'no-store, no-cache, must-revalidate');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.headers['referrer-policy'], 'no-referrer');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard/partial?view=NOPE → 400 sin reflejar slug (CA-S1+CA-S4)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard/partial?view=NOPE');
        assert.equal(r.statusCode, 400);
        assert.equal(r.body, 'bad request');
        assert.equal(r.body.includes('NOPE'), false, 'CA-S4: slug NUNCA reflejado');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard/partial?view=<script> → 400 sin XSS reflejado (CA-S4)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard/partial?view=' + encodeURIComponent('<script>alert(1)</script>'));
        assert.equal(r.statusCode, 400);
        assert.equal(r.body, 'bad request');
        assert.equal(r.body.includes('<script>'), false);
        assert.equal(r.body.includes('alert'), false);
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard/partial con Sec-Fetch-Site: cross-site → 403 (CA-S3)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard/partial?view=home', { 'Sec-Fetch-Site': 'cross-site' });
        assert.equal(r.statusCode, 403);
        assert.equal(r.body, 'forbidden');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard?view=ops → 200 con <title> de Ops (#3732, CA-G2)', async () => {
    // #3732 — la ventana Ops fue la primera extracción registrada en VIEW_SLUGS.
    // Verifica que el slug nuevo no rompe el router y que renderiza la vista
    // (fakeCtx.getState devuelve {} → opsSlice tolera estado vacío sin tirar).
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=ops');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Ops</title>'), 'el router ?view=ops debe rendir la ventana Ops');
        assert.ok(r.body.includes('id="ops-procesos"'), 'debe contener un ID DOM canónico de Ops');
        assert.ok(r.body.includes('id="ops-qaenv"'), 'debe contener la sección QA env rediseñada');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard?view=kpis → 200 con <title> de KPIs (#3733, CA-29/CA-G2)', async () => {
    // #3733 — segunda ventana extraída registrada en VIEW_SLUGS. Verifica que
    // el slug nuevo no rompe el router y que renderiza la vista con state vacío
    // (los slices toleran ctx mínimo sin tirar → render completo, no inerte).
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=kpis');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · KPIs</title>'), 'el router ?view=kpis debe rendir la ventana KPIs');
        assert.ok(r.body.includes('class="kpis-row"'), 'debe contener la fila de KPIs (CA-30)');
        assert.ok(r.body.includes('href="/metrics"'), 'debe contener el CTA a /metrics (CA-9)');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /kpis (legacy) converge con la ventana KPIs V3 (#3733, CA-A2)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/kpis');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · KPIs</title>'), '/kpis legacy debe rendir la misma ventana KPIs');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard?view=costos → 200 con <title> de Costos (#3735, CA-1.2/CA-G2)', async () => {
    // #3735 — slug `costos` registrado en VIEW_SLUGS. Verifica que el deep-link
    // del router cliente resuelve la ventana Costos sin romper el router.
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=costos');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Costos</title>'), 'el router ?view=costos debe rendir la ventana Costos');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /costos (legacy) converge con la ventana Costos V3 (#3735, CA-A2)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/costos');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Costos</title>'), '/costos legacy debe rendir la misma ventana Costos');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /dashboard?view=issues → 200 con <title> de Issues (#3730, CA-G2)', async () => {
    // #3730 — slug `issues` registrado en VIEW_SLUGS (vista operacional cards).
    // Verifica que el deep-link del router resuelve la ventana Issues con state
    // vacío (SSR del chrome; el cliente hidrata vía /api/dash/pipeline).
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=issues');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Issues</title>'), 'el router ?view=issues debe rendir la ventana Issues');
        assert.ok(r.body.includes('id="issues-grid"'), 'debe contener el grid de cards (CA-G2)');
        assert.ok(r.body.includes('<dialog id="issues-dialog"'), 'debe contener el drilldown <dialog> (CA-UX-7)');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET /issues (legacy) converge con la ventana Issues V3 (#3730, CA-A2)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/issues');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('id="issues-grid"'), '/issues legacy debe rendir el grid de la ventana Issues');
    } finally {
        await closeServer(server);
    }
});

test('smoke E2E: GET / (legacy raíz) sigue rindiendo home (no-regresión)', async () => {
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Operación</title>'));
    } finally {
        await closeServer(server);
    }
});

// =============================================================================
// Tests del router cliente `?view=<slug>` + endpoint `/dashboard/partial`
// introducidos por #3723 (split de #3715).
//
// Cubre los criterios firmados por architect + security + guru + ux + po:
//   CA-S1 — allowlist cerrada + regex defensiva del slug.
//   CA-S2 — loopback gate (defense-in-depth).
//   CA-S3 — `Sec-Fetch-Site` (sólo si está presente).
//   CA-S4 — body genérico en 400, slug NUNCA reflejado.
//   CA-S5 — headers del partial endpoint.
//   CA-S6 — log estructurado de rechazos.
//   CA-T1 — `/dashboard?view=<desconocido>` → fallback a `home` sin 400 en SSR.
//   CA-U5 — bandera `unknownViewRequested` propagada al renderer del fallback.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
    delete require.cache[require.resolve('../dashboard-routes')];
    return require('../dashboard-routes');
}

// Reemplaza el módulo `home` por un stub que devuelve un marker reconocible
// para no acoplar los tests al HTML real (que cambia seguido). El stub captura
// las opts recibidas para verificar CA-T1 + CA-U5 (currentView, unknownViewRequested).
function withFakeHome(fakeImpl, fn) {
    const homePath = require.resolve('../../views/dashboard/home');
    const original = require.cache[homePath];
    require.cache[homePath] = {
        id: homePath,
        filename: homePath,
        loaded: true,
        exports: fakeImpl,
    };
    try {
        return fn();
    } finally {
        if (original) require.cache[homePath] = original;
        else delete require.cache[homePath];
    }
}

// Fake response chainable que captura status, headers y body.
function fakeRes() {
    const res = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
    };
    return res;
}

// Fake request con socket + headers controlados.
function fakeReq(opts) {
    const o = opts || {};
    return {
        method: o.method || 'GET',
        url: o.url || '/dashboard',
        socket: { remoteAddress: o.remoteAddress || '127.0.0.1' },
        headers: o.headers || {},
    };
}

const fakeCtx = { getState: () => ({}), PIPELINE: '', ROOT: '', GH_BIN: '' };

// -----------------------------------------------------------------------------
// CA-T1 — SSR `/dashboard?view=<slug>` con fallback a home.
// -----------------------------------------------------------------------------

test('GET /dashboard?view=home → 200 con marker del home', () => {
    const captured = { opts: null };
    withFakeHome({
        renderHomeHTML(opts) { captured.opts = opts; return '<<HOME-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/dashboard?view=home' });
        const res = fakeRes();
        const handled = handle(req, res, fakeCtx);
        assert.equal(handled, true);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.includes('<<HOME-MARKER>>'));
        assert.equal(captured.opts.currentView, 'home');
        assert.equal(captured.opts.unknownViewRequested, false);
    });
});

test('GET /dashboard?view=desconocido → 200 con fallback a home + unknownViewRequested=true', () => {
    const captured = { opts: null };
    withFakeHome({
        renderHomeHTML(opts) { captured.opts = opts; return '<<HOME-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/dashboard?view=desconocido' });
        const res = fakeRes();
        const handled = handle(req, res, fakeCtx);
        assert.equal(handled, true);
        assert.equal(res.statusCode, 200, 'CA-T1: SSR NUNCA devuelve 400, siempre fallback');
        assert.ok(res.body.includes('<<HOME-MARKER>>'));
        assert.equal(captured.opts.currentView, 'home');
        assert.equal(captured.opts.unknownViewRequested, true, 'CA-U5: bandera propagada al renderer');
    });
});

test('GET /dashboard sin query → fallback a home con unknownViewRequested=false', () => {
    const captured = { opts: null };
    withFakeHome({
        renderHomeHTML(opts) { captured.opts = opts; return '<<HOME-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/dashboard' });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(captured.opts.currentView, 'home');
        assert.equal(captured.opts.unknownViewRequested, false, 'sin query no es "desconocido"');
    });
});

test('GET /dashboard?view=home → Content-Type text/html; charset=utf-8', () => {
    withFakeHome({
        renderHomeHTML() { return '<<HOME-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/dashboard?view=home' });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
    });
});

// -----------------------------------------------------------------------------
// #3731 — Ventana Matriz: smoke de routing por slug nuevo + path legacy (CA-G2).
// El slug `matriz` pertenece a la allowlist VIEW_SLUGS y resuelve al módulo
// extraído views/dashboard/matriz.js (no al monolito satellites.js).
// -----------------------------------------------------------------------------

test('GET /dashboard?view=matriz → 200 con la ventana Matriz extraída (CA-G2)', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/dashboard?view=matriz' });
    const res = fakeRes();
    const handled = handle(req, res, fakeCtx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('id="matriz-table"'), 'falta el contenedor de la grilla Matriz');
    assert.ok(res.body.includes('<title>Intrale · Matriz</title>'), 'falta el título de la ventana');
    assert.ok(res.body.includes('mtx-legend'), 'falta la leyenda del heat-map (CA-C3)');
});

test('GET /matriz (path legacy) → 200 con la ventana Matriz extraída (CA-A2)', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/matriz' });
    const res = fakeRes();
    const handled = handle(req, res, fakeCtx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('id="matriz-table"'), 'legacy /matriz debe servir la misma ventana');
});

// -----------------------------------------------------------------------------
// CA-S2 — loopback gate del partial endpoint.
// -----------------------------------------------------------------------------

test('GET /dashboard/partial desde loopback 127.0.0.1 → 200 con marker', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.includes('<<PARTIAL-MARKER>>'));
    });
});

test('GET /dashboard/partial desde IPv6 ::1 → 200 (loopback válido)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '::1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200, 'IPv6 loopback debe ser aceptado');
    });
});

test('GET /dashboard/partial desde ::ffff:127.0.0.1 → 200 (IPv6-mapped IPv4)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '::ffff:127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200);
    });
});

test('GET /dashboard/partial desde IP externa → 403 (CA-S2)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '192.168.1.10',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body, 'forbidden');
        // CA-S4: body NO refleja el slug (genérico).
        assert.equal(res.body.includes('home'), false);
    });
});

// -----------------------------------------------------------------------------
// CA-S3 — `Sec-Fetch-Site`.
// -----------------------------------------------------------------------------

test('GET /dashboard/partial con Sec-Fetch-Site: cross-site → 403 (CA-S3)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '127.0.0.1',
            headers: { 'sec-fetch-site': 'cross-site' },
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body, 'forbidden');
    });
});

test('GET /dashboard/partial SIN header Sec-Fetch-Site desde loopback → 200 (CA-S3 documentado)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '127.0.0.1',
            // headers vacíos — sin Sec-Fetch-Site (reload directo / curl / browsers viejos)
            headers: {},
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200, 'ausencia se acepta — la barrera dura es CA-S2');
    });
});

test('GET /dashboard/partial con Sec-Fetch-Site: same-origin → 200', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '127.0.0.1',
            headers: { 'sec-fetch-site': 'same-origin' },
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200);
    });
});

// -----------------------------------------------------------------------------
// CA-S1 — allowlist + regex del slug.
// -----------------------------------------------------------------------------

test('GET /dashboard/partial?view=NOPE → 400 (CA-S1)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=NOPE',
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body, 'bad request');
        // CA-S4: el slug `NOPE` NUNCA se refleja en el body.
        assert.equal(res.body.includes('NOPE'), false);
        assert.equal(res.body.includes('nope'), false);
    });
});

test('GET /dashboard/partial?view=<script>alert(1)</script> → 400 sin reflejar script (CA-S1+CA-S4)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=' + encodeURIComponent('<script>alert(1)</script>'),
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.includes('<script>'), false, 'CA-S4: NUNCA reflejar payloads del slug');
        assert.equal(res.body.includes('alert'), false);
    });
});

test('GET /dashboard/partial?view=../etc/passwd → 400 (CA-S1 regex fallback)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=' + encodeURIComponent('../etc/passwd'),
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body, 'bad request');
    });
});

test('GET /dashboard/partial?view=  (vacío) → 400', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=',
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 400);
    });
});

// -----------------------------------------------------------------------------
// CA-S5 — headers del partial endpoint.
// -----------------------------------------------------------------------------

test('GET /dashboard/partial?view=home (200) emite headers CA-S5 completos', () => {
    withFakeHome({
        renderHomeHTML() { return '<<PARTIAL-MARKER>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({
            url: '/dashboard/partial?view=home',
            remoteAddress: '127.0.0.1',
        });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.equal(res.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    });
});

// -----------------------------------------------------------------------------
// VIEW_SLUGS export — fuente única para el navbar (#3726).
// -----------------------------------------------------------------------------

test('VIEW_SLUGS está exportado y es congelado', () => {
    withFakeHome({
        renderHomeHTML() { return ''; },
    }, () => {
        const mod = fresh();
        assert.ok(mod.VIEW_SLUGS, 'VIEW_SLUGS debe estar exportado');
        assert.ok(Object.isFrozen(mod.VIEW_SLUGS), 'VIEW_SLUGS debe ser Object.freeze');
        assert.ok(mod.VIEW_SLUGS.home, 'home debe ser slug válido');
        assert.equal(typeof mod.VIEW_SLUGS.home.render, 'function');
        assert.equal(typeof mod.VIEW_SLUGS.home.title, 'string');
    });
});

test('VIEW_SLUG_REGEX rechaza slugs malformados', () => {
    const mod = fresh();
    const r = mod.VIEW_SLUG_REGEX;
    assert.ok(r.test('home'));
    assert.ok(r.test('multi-provider'));
    assert.ok(r.test('a'));
    assert.ok(r.test('view-1-2-3'));
    assert.equal(r.test(''), false);
    assert.equal(r.test('HOME'), false, 'mayúsculas no permitidas');
    assert.equal(r.test('1home'), false, 'no puede arrancar con dígito');
    assert.equal(r.test('-home'), false, 'no puede arrancar con guión');
    assert.equal(r.test('home/foo'), false);
    assert.equal(r.test('../etc'), false);
    assert.equal(r.test('home<script>'), false);
    assert.equal(r.test('a'.repeat(32)), false, 'máximo 31 chars (1 + 30)');
});

// -----------------------------------------------------------------------------
// CA-S6 — log estructurado de rechazos (sanity check).
// -----------------------------------------------------------------------------

test('Rechazos del partial loggean evento estructurado (CA-S6)', () => {
    const originalWarn = console.warn;
    const captured = [];
    console.warn = function() { captured.push(Array.from(arguments).join(' ')); };
    try {
        withFakeHome({
            renderHomeHTML() { return ''; },
        }, () => {
            const { handle } = fresh();
            // non-loopback
            handle(fakeReq({ url: '/dashboard/partial?view=home', remoteAddress: '10.0.0.1' }), fakeRes(), fakeCtx);
            // unknown slug
            handle(fakeReq({ url: '/dashboard/partial?view=NOPE', remoteAddress: '127.0.0.1' }), fakeRes(), fakeCtx);
        });
    } finally {
        console.warn = originalWarn;
    }
    assert.ok(captured.length >= 2, 'debe loggear al menos los dos rechazos');
    const nonLoop = captured.find(line => line.includes('non_loopback'));
    const badSlug = captured.find(line => line.includes('unknown_slug'));
    assert.ok(nonLoop, 'falta log estructurado de non_loopback');
    assert.ok(badSlug, 'falta log estructurado de unknown_slug');
    // El log debe ser JSON parseable y NO contener el slug crudo (sólo length).
    const parsed = JSON.parse(badSlug);
    assert.equal(parsed.event, 'partial_rejected');
    assert.equal(parsed.reason, 'unknown_slug');
    assert.equal(typeof parsed.slugLen, 'number');
    assert.equal(parsed.slug, undefined, 'el slug crudo NO debe estar en el log (anti log-injection)');
});

// -----------------------------------------------------------------------------
// Verificación de no-regresión: `/` y `/v3` siguen mapeando al home original.
// -----------------------------------------------------------------------------

test('GET / sigue rindiendo home (no se rompió con la introducción de /dashboard)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<LEGACY-ROOT-HOME>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/' });
        const res = fakeRes();
        const handled = handle(req, res, fakeCtx);
        assert.equal(handled, true);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.includes('<<LEGACY-ROOT-HOME>>'));
    });
});

test('GET /v3 sigue rindiendo home (alias retrocompat)', () => {
    withFakeHome({
        renderHomeHTML() { return '<<V3-HOME>>'; },
    }, () => {
        const { handle } = fresh();
        const req = fakeReq({ url: '/v3' });
        const res = fakeRes();
        handle(req, res, fakeCtx);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.includes('<<V3-HOME>>'));
    });
});

// -----------------------------------------------------------------------------
// Helpers exportados — sanity check.
// -----------------------------------------------------------------------------

test('isLoopbackReq acepta 127.0.0.1, ::1, ::ffff:127.0.0.1 y rechaza el resto', () => {
    const { _internal } = fresh();
    const { isLoopbackReq } = _internal;
    assert.equal(isLoopbackReq({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.equal(isLoopbackReq({ socket: { remoteAddress: '::1' } }), true);
    assert.equal(isLoopbackReq({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.equal(isLoopbackReq({ socket: { remoteAddress: '10.0.0.1' } }), false);
    assert.equal(isLoopbackReq({ socket: { remoteAddress: '' } }), false);
    assert.equal(isLoopbackReq({}), false);
});

test('isSameOriginFetch: ausencia se acepta, cross-site se rechaza', () => {
    const { _internal } = fresh();
    const { isSameOriginFetch } = _internal;
    assert.equal(isSameOriginFetch({ headers: {} }), true, 'ausencia → permitir (CA-S3 documentado)');
    assert.equal(isSameOriginFetch({ headers: { 'sec-fetch-site': 'same-origin' } }), true);
    assert.equal(isSameOriginFetch({ headers: { 'sec-fetch-site': 'cross-site' } }), false);
    assert.equal(isSameOriginFetch({ headers: { 'sec-fetch-site': 'cross-origin' } }), false);
    assert.equal(isSameOriginFetch({ headers: { 'sec-fetch-site': 'same-site' } }), false);
    assert.equal(isSameOriginFetch({}), true, 'sin headers → permitir');
});

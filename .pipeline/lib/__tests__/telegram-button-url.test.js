// =============================================================================
// telegram-button-url.test.js — Guard de botones `url` de Telegram (issue #5923)
//
// El guard es la única barrera entre "el saliente se entrega" y "el saliente
// muere en servicios/telegram/fallido/ llevándose la alerta al operador", y
// además decide si una capability HMAC viaja o no dentro de una URL. Por eso
// los negativos se testean vector por vector, incluidos los 6 IPv6 entre
// corchetes que `net.isIP` NO barre si no se desenvuelven antes.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const btn = require('../telegram-button-url');

// ─── isPublicButtonUrl · negativos ───────────────────────────────────────────

test('#5923 rechaza los 6 vectores IPv6 entre corchetes (bypass D1/R-SEC-4)', () => {
    const vectores = [
        'https://[::1]',
        'https://[0:0:0:0:0:0:0:1]',
        'https://[::ffff:127.0.0.1]',
        'https://[fd00::1]',
        'https://[fe80::1]',
        'https://[64:ff9b::7f00:1]',
    ];
    for (const v of vectores) {
        assert.equal(btn.isPublicButtonUrl(v), false, `${v} debe rechazarse`);
    }
});

test('#5923 rechaza literales IPv4, incluidas las formas no canónicas', () => {
    const vectores = [
        'https://127.0.0.1',
        'https://127.1',            // new URL() la normaliza a 127.0.0.1
        'https://2130706433',       // idem, forma entera
        'https://0.0.0.0',
        'https://169.254.169.254',  // metadata de cloud
        'https://10.0.0.1',
        'https://172.16.0.1',
        'https://192.168.1.1',
        'https://100.64.0.1',       // CGNAT
        'https://8.8.8.8',          // pública, pero literal IP igual → fuera
    ];
    for (const v of vectores) {
        assert.equal(btn.isPublicButtonUrl(v), false, `${v} debe rechazarse`);
    }
});

test('#5923 rechaza nombres DNS que resuelven a loopback o red interna', () => {
    const vectores = [
        'https://localhost',
        'https://localhost:3200',
        'https://algo.localhost',
        'https://algo.local',
        'https://algo.internal',
        'https://algo.home.arpa',
        'https://localtest.me',
        'https://app.localtest.me',
        'https://127.0.0.1.nip.io',
        'https://127.0.0.1.sslip.io',
        'https://app.traefik.me',
    ];
    for (const v of vectores) {
        assert.equal(btn.isPublicButtonUrl(v), false, `${v} debe rechazarse`);
    }
});

test('#5923 rechaza todo esquema que no sea https (incluido http público)', () => {
    // Una capability en claro sobre HTTP es interceptable: `http://` se rechaza
    // exactamente igual que loopback, aunque el host sea público.
    assert.equal(btn.isPublicButtonUrl('http://dashboard.intrale.com'), false);
    assert.equal(btn.isPublicButtonUrl('http://localhost:3200'), false);
    assert.equal(btn.isPublicButtonUrl('tg://resolve?domain=x'), false);
    assert.equal(btn.isPublicButtonUrl('javascript:alert(1)'), false);
    assert.equal(btn.isPublicButtonUrl('data:text/html,<b>x</b>'), false);
    assert.equal(btn.isPublicButtonUrl('ftp://dashboard.intrale.com'), false);
    assert.equal(btn.isPublicButtonUrl('file:///etc/passwd'), false);
});

test('#5923 rechaza credenciales embebidas y entradas no parseables', () => {
    assert.equal(btn.isPublicButtonUrl('https://user:pass@dashboard.intrale.com'), false);
    assert.equal(btn.isPublicButtonUrl('https://user@dashboard.intrale.com'), false);
    assert.equal(btn.isPublicButtonUrl(''), false);
    assert.equal(btn.isPublicButtonUrl(null), false);
    assert.equal(btn.isPublicButtonUrl(undefined), false);
    assert.equal(btn.isPublicButtonUrl('no-es-url'), false);
    assert.equal(btn.isPublicButtonUrl(1234), false);
    assert.equal(btn.isPublicButtonUrl({}), false);
});

// ─── isPublicButtonUrl · positivos ───────────────────────────────────────────

test('#5923 acepta hosts DNS públicos sobre https', () => {
    assert.equal(btn.isPublicButtonUrl('https://dashboard.intrale.com'), true);
    assert.equal(btn.isPublicButtonUrl('https://dashboard.intrale.com/?action=x&issue=1'), true);
    assert.equal(btn.isPublicButtonUrl('https://github.com/intrale/platform/issues/5923'), true);
    // "local" como parte del nombre, no como sufijo de label, no debe matchear.
    assert.equal(btn.isPublicButtonUrl('https://mylocalhost.com'), true);
    assert.equal(btn.isPublicButtonUrl('https://locale.intrale.com'), true);
});

// ─── buildActionKeyboard · degradación ───────────────────────────────────────

const ROWS = [
    [
        { action: 'unblock', text: '✅ Aprobar (unblock)', issue: 5923 },
        { action: 'mas-contexto', text: '💬 Pedir contexto', issue: 5923 },
    ],
    [
        { action: 'devolver-definicion', text: '↩️ Devolver a definición', issue: 5923 },
    ],
];

const TOKEN = 'v1.SUPERSECRETO.sig';
const BASE = 'http://localhost:3200';
const buildUrlConToken = (action, issue) => `${BASE}/?action=${action}&issue=${issue}&token=${TOKEN}`;

test('#5923 URL no pública ⇒ markup 100% callback_data, sin ningún campo url', () => {
    const r = btn.buildActionKeyboard(ROWS, {
        dashboardUrl: BASE, callbackPrefix: 'hb', buildUrl: buildUrlConToken, hostAllowlist: [],
    });
    assert.equal(r.degraded, true);
    const buttons = r.markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    for (const b of buttons) {
        assert.equal(b.url, undefined, 'ningún botón puede tener campo url');
        assert.ok(typeof b.callback_data === 'string' && b.callback_data.length > 0);
    }
    assert.deepEqual(buttons.map(b => b.callback_data), [
        'hb:unblock:5923', 'hb:mas-contexto:5923', 'hb:devolver-definicion:5923',
    ]);
});

test('#5923 el token y la base URL NO aparecen en callback_data ni en degradedText (R1.3)', () => {
    const r = btn.buildActionKeyboard(ROWS, {
        dashboardUrl: BASE, callbackPrefix: 'hb', buildUrl: buildUrlConToken, hostAllowlist: [],
    });
    const blob = JSON.stringify(r.markup) + '\n' + r.degradedText;
    assert.ok(!blob.includes(TOKEN), 'el token HMAC no puede filtrarse');
    assert.ok(!blob.includes('SUPERSECRETO'), 'ni el material del token');
    assert.ok(!blob.includes('localhost'), 'la base URL no puede filtrarse');
    assert.ok(!blob.includes('token='), 'ni el parámetro token');
    assert.ok(!blob.includes('3200'), 'ni el puerto del dashboard');
    // degradedText lleva SÓLO los nombres de las acciones.
    assert.equal(r.degradedText, '✅ Aprobar (unblock) · 💬 Pedir contexto · ↩️ Devolver a definición');
});

test('#5923 degradar NO invoca buildUrl (⇒ actionToken.sign no se llama, CA-7)', () => {
    let llamadas = 0;
    btn.buildActionKeyboard(ROWS, {
        dashboardUrl: BASE,
        callbackPrefix: 'hb',
        hostAllowlist: [],
        buildUrl: (a, i) => { llamadas++; return buildUrlConToken(a, i); },
    });
    assert.equal(llamadas, 0, 'firmar una capability que no se va a usar es superficie muerta');
});

test('#5923 todo callback_data emitido entra en el límite de 64 bytes (CA-6)', () => {
    const r = btn.buildActionKeyboard(ROWS, { callbackPrefix: 'hb', hostAllowlist: [] });
    for (const b of r.markup.inline_keyboard.flat()) {
        assert.ok(
            Buffer.byteLength(b.callback_data, 'utf8') <= btn.CALLBACK_DATA_MAX_BYTES,
            `${b.callback_data} debe entrar en 64 bytes`,
        );
    }
    // Peor caso real del namespace `hb:` con confirmación y issue de 6 dígitos.
    assert.ok(btn.fitsCallbackData('hb:c:devolver-definicion:999999'));
});

test('#5923 un callback_data que se pasa de 64 bytes se cae, no rompe el envío', () => {
    const gigante = 'a'.repeat(70);
    const r = btn.buildActionKeyboard(
        [[{ action: gigante, text: 'gigante', issue: 1 }, { action: 'unblock', text: 'ok', issue: 1 }]],
        { callbackPrefix: 'hb', hostAllowlist: [] },
    );
    const buttons = r.markup.inline_keyboard.flat();
    assert.equal(buttons.length, 1, 'sólo sobrevive el que entra en el límite');
    assert.equal(buttons[0].callback_data, 'hb:unblock:1');
});

test('#5923 acción sin issue emite callback_data de 2 segmentos', () => {
    const r = btn.buildActionKeyboard(
        [[{ action: 'keep-original', text: '🎯 Seguir sin las dependencias' }]],
        { callbackPrefix: 'pp', hostAllowlist: [] },
    );
    assert.equal(r.markup.inline_keyboard[0][0].callback_data, 'pp:keep-original');
});

// #6118 — El teclado de la alerta de dependencias faltantes: tres filas de un
// botón, sin el de alcance global, y todo dentro del límite de la Bot API.
// El `callback_data` es lo que limita el diseño: las dependencias NO entran en
// 64 bytes, por eso el tap sólo lleva el issue y el servidor deriva el resto.
test('#6118 el teclado de la alerta emite 3 filas de 1 botón y entra en 64 bytes', () => {
    const copy = require('../partial-pause-deps-copy');
    const issue = 6033;
    const labels = copy.buildButtonLabels({ issue, deps: [6032, 6031, 6030], muteTtlMs: 24 * 3600 * 1000 });
    const r = btn.buildActionKeyboard([
        [{ action: 'include-deps-for-issue', text: labels['include-deps-for-issue'], issue }],
        [{ action: 'keep-original',          text: labels['keep-original'],          issue }],
        [{ action: 'mute-alert',             text: labels['mute-alert'],             issue }],
    ], { callbackPrefix: 'pp', hostAllowlist: [] });

    const rows = r.markup.inline_keyboard;
    assert.equal(rows.length, 3, 'una fila por botón (UX-D-3)');
    for (const row of rows) assert.equal(row.length, 1);
    assert.deepEqual(rows.flat().map(b => b.callback_data), [
        'pp:include-deps-for-issue:6033',
        'pp:keep-original:6033',
        'pp:mute-alert:6033',
    ]);
    for (const b of rows.flat()) {
        assert.ok(btn.fitsCallbackData(b.callback_data), `${b.callback_data} tiene que entrar en el límite`);
    }
    // Peor caso realista de longitud: un issue de 7 dígitos.
    assert.ok(btn.fitsCallbackData(btn.buildCallbackData('pp', 'include-deps-for-issue', 9999999)));
});

// ─── buildActionKeyboard · camino feliz (sin regresión) ──────────────────────

test('#5923 https público Y en DASHBOARD_PUBLIC_HOSTS ⇒ se mantiene el botón url (CA-2)', () => {
    const r = btn.buildActionKeyboard(ROWS, {
        dashboardUrl: 'https://dashboard.intrale.com',
        callbackPrefix: 'hb',
        hostAllowlist: ['dashboard.intrale.com'],
        buildUrl: (a, i) => `https://dashboard.intrale.com/?action=${a}&issue=${i}&token=${TOKEN}`,
    });
    assert.equal(r.degraded, false);
    const buttons = r.markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    for (const b of buttons) {
        assert.equal(b.callback_data, undefined);
        assert.match(b.url, /^https:\/\/dashboard\.intrale\.com\/\?action=/);
    }
});

test('#5923 https público pero FUERA del allowlist de hosts ⇒ degrada (R-SEC-5/CA-5)', () => {
    // `https://evil.com` pasa el guard de publicidad, pero no recibe el token.
    let llamadas = 0;
    const r = btn.buildActionKeyboard(ROWS, {
        dashboardUrl: 'https://evil.com',
        callbackPrefix: 'hb',
        hostAllowlist: ['dashboard.intrale.com'],
        buildUrl: (a, i) => { llamadas++; return `https://evil.com/?token=${TOKEN}`; },
    });
    assert.equal(r.degraded, true);
    assert.equal(llamadas, 0, 'evil.com no recibe la capability');
    assert.ok(!JSON.stringify(r.markup).includes(TOKEN));
});

test('#5923 el allowlist de hosts es vacío por default ⇒ degrada aunque la URL sea pública', () => {
    const previo = process.env.DASHBOARD_PUBLIC_HOSTS;
    delete process.env.DASHBOARD_PUBLIC_HOSTS;
    try {
        const r = btn.buildActionKeyboard(ROWS, {
            dashboardUrl: 'https://dashboard.intrale.com',
            callbackPrefix: 'hb',
            buildUrl: buildUrlConToken,
        });
        assert.equal(r.degraded, true, 'default vacío ⇒ degrada (fail-closed)');
    } finally {
        if (previo === undefined) delete process.env.DASHBOARD_PUBLIC_HOSTS;
        else process.env.DASHBOARD_PUBLIC_HOSTS = previo;
    }
});

test('#5923 DASHBOARD_PUBLIC_HOSTS se lee del env como CSV', () => {
    const previo = process.env.DASHBOARD_PUBLIC_HOSTS;
    process.env.DASHBOARD_PUBLIC_HOSTS = ' otro.com , dashboard.intrale.com ';
    try {
        const r = btn.buildActionKeyboard(ROWS, {
            dashboardUrl: 'https://dashboard.intrale.com',
            callbackPrefix: 'hb',
            buildUrl: (a, i) => `https://dashboard.intrale.com/?action=${a}&issue=${i}`,
        });
        assert.equal(r.degraded, false);
    } finally {
        if (previo === undefined) delete process.env.DASHBOARD_PUBLIC_HOSTS;
        else process.env.DASHBOARD_PUBLIC_HOSTS = previo;
    }
});

test('#5923 si el modo url no produce ningún botón, degrada en vez de quedarse sin acciones', () => {
    const r = btn.buildActionKeyboard(ROWS, {
        dashboardUrl: 'https://dashboard.intrale.com',
        callbackPrefix: 'hb',
        hostAllowlist: ['dashboard.intrale.com'],
        buildUrl: () => { throw new Error('sin secreto para firmar'); },
    });
    assert.equal(r.degraded, true);
    assert.equal(r.markup.inline_keyboard.flat().length, 3);
});

// ─── Contrato de degradación total ───────────────────────────────────────────

test('#5923 sin material para botones ⇒ markup undefined (CA-UX-7, el resumen se manda igual)', () => {
    assert.equal(btn.buildActionKeyboard([], { callbackPrefix: 'hb' }).markup, undefined);
    assert.equal(btn.buildActionKeyboard(null, { callbackPrefix: 'hb' }).markup, undefined);
    assert.equal(btn.buildActionKeyboard([[]], { callbackPrefix: 'hb' }).markup, undefined);
    assert.equal(btn.buildActionKeyboard([[{ action: '', text: '' }]], { callbackPrefix: 'hb' }).markup, undefined);
});

// ─── parseCallbackData ───────────────────────────────────────────────────────

test('#5923 parseCallbackData es el inverso exacto de buildCallbackData', () => {
    assert.deepEqual(btn.parseCallbackData('hb:unblock:5923', 'hb'), { action: 'unblock', issue: '5923' });
    assert.deepEqual(btn.parseCallbackData('pp:cancel-partial-pause', 'pp'), { action: 'cancel-partial-pause', issue: null });
    assert.equal(btn.parseCallbackData('pp:include-deps:1', 'hb'), null, 'namespace ajeno → null');
    assert.equal(btn.parseCallbackData('hb:', 'hb'), null, 'sin acción → null');
    assert.equal(btn.parseCallbackData('', 'hb'), null);
    assert.equal(btn.parseCallbackData(null, 'hb'), null);
});

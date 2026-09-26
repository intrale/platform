// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de la política de seguridad del render HTML→PDF (CA-7 / #3929).
// No lanzan puppeteer: validan la función pura `isRequestAllowed`.

const test = require('node:test');
const assert = require('node:assert');

const { isRequestAllowed } = require('./report-to-pdf-telegram');

const MAIN = 'file:///c/tmp/reporte.html';

test('permite la navegación al documento principal', () => {
    assert.strictEqual(isRequestAllowed({ url: MAIN, isNavigation: true, mainUrl: MAIN }), true);
});

test('bloquea file:// adicional (LFI)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'file:///etc/passwd', isNavigation: false, mainUrl: MAIN }),
        false,
    );
});

test('bloquea una navegación file:// que no sea el documento principal', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'file:///etc/shadow', isNavigation: true, mainUrl: MAIN }),
        false,
    );
});

test('bloquea http/https (SSRF / exfiltración)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'http://169.254.169.254/latest/meta-data/', isNavigation: false, mainUrl: MAIN }),
        false,
    );
    assert.strictEqual(
        isRequestAllowed({ url: 'https://evil.example/exfil?d=secret', isNavigation: false, mainUrl: MAIN }),
        false,
    );
});

test('bloquea ftp y websockets', () => {
    assert.strictEqual(isRequestAllowed({ url: 'ftp://host/x', isNavigation: false, mainUrl: MAIN }), false);
    assert.strictEqual(isRequestAllowed({ url: 'ws://host/x', isNavigation: false, mainUrl: MAIN }), false);
    assert.strictEqual(isRequestAllowed({ url: 'wss://host/x', isNavigation: false, mainUrl: MAIN }), false);
});

test('permite data: y about:blank (inocuos)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'data:image/png;base64,AAAA', isNavigation: false, mainUrl: MAIN }),
        true,
    );
    assert.strictEqual(isRequestAllowed({ url: 'about:blank', isNavigation: false, mainUrl: MAIN }), true);
});

test('es case-insensitive en el esquema', () => {
    assert.strictEqual(isRequestAllowed({ url: 'HTTP://evil/x', isNavigation: false, mainUrl: MAIN }), false);
    assert.strictEqual(isRequestAllowed({ url: 'FILE:///etc/passwd', isNavigation: false, mainUrl: MAIN }), false);
});

test('rechaza url no-string', () => {
    assert.strictEqual(isRequestAllowed({ url: null, isNavigation: true, mainUrl: MAIN }), false);
});

// #7633 (A1) — no regresión: generatePdf delega en el render strict extraído,
// con la misma ruta de salida y el mismo título de siempre.
test('generatePdf delega en renderPdfStrict con outPath .pdf y título "Intrale Platform — <nombre>"', async () => {
    const { generatePdf } = require('./report-to-pdf-telegram');
    const calls = [];
    const render = async (htmlPath, opts) => { calls.push({ htmlPath, opts }); return opts.outPath; };
    const out = await generatePdf('/c/docs/qa/reporte-x.html', { render });
    assert.strictEqual(out, '/c/docs/qa/reporte-x.pdf');
    assert.deepStrictEqual(calls, [{
        htmlPath: '/c/docs/qa/reporte-x.html',
        opts: { outPath: '/c/docs/qa/reporte-x.pdf', title: 'Intrale Platform — reporte-x' },
    }]);
});

test('el script de reportes ya no arma su propio puppeteer (usa pdf-render-strict)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'report-to-pdf-telegram.js'), 'utf8');
    assert.ok(src.includes("'pdf-render-strict'"));
    assert.ok(!src.includes('puppeteer.launch'));
    assert.ok(!src.includes('setJavaScriptEnabled'));
});

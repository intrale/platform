'use strict';

// Tests de la política de sandbox del render HTML→PDF (CA-7 / #3929).
// No lanzan puppeteer: validan la función pura `isRequestAllowed` y el handler
// `makeRequestHandler` (que decide continue()/abort()).

const test = require('node:test');
const assert = require('node:assert');

const {
    isRequestAllowed,
    makeRequestHandler,
    TRUSTED_CDN_PREFIXES,
} = require('./render-sandbox');

const MAIN = 'file:///c/tmp/reporte.html';

// --- modo 'strict' (entregables / contenido no confiable) ---

test('strict: permite la navegación al documento principal', () => {
    assert.strictEqual(
        isRequestAllowed({ url: MAIN, isNavigation: true, mainUrl: MAIN, mode: 'strict' }),
        true,
    );
});

test('strict: el default (sin mode) es estricto', () => {
    assert.strictEqual(isRequestAllowed({ url: MAIN, isNavigation: true, mainUrl: MAIN }), true);
    assert.strictEqual(
        isRequestAllowed({ url: 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', isNavigation: false, mainUrl: MAIN }),
        false,
    );
});

test('strict: bloquea file:// adicional (LFI)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'file:///etc/passwd', isNavigation: false, mainUrl: MAIN, mode: 'strict' }),
        false,
    );
});

test('strict: bloquea una navegación file:// que no sea el documento principal', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'file:///etc/shadow', isNavigation: true, mainUrl: MAIN, mode: 'strict' }),
        false,
    );
});

test('strict: bloquea http/https (SSRF / exfiltración), incluida la CDN de Mermaid', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'http://169.254.169.254/latest/meta-data/', isNavigation: false, mainUrl: MAIN, mode: 'strict' }),
        false,
    );
    assert.strictEqual(
        isRequestAllowed({ url: 'https://evil.example/exfil?d=secret', isNavigation: false, mainUrl: MAIN, mode: 'strict' }),
        false,
    );
    assert.strictEqual(
        isRequestAllowed({ url: 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', isNavigation: false, mainUrl: MAIN, mode: 'strict' }),
        false,
    );
});

test('strict: bloquea ftp y websockets', () => {
    assert.strictEqual(isRequestAllowed({ url: 'ftp://host/x', isNavigation: false, mainUrl: MAIN, mode: 'strict' }), false);
    assert.strictEqual(isRequestAllowed({ url: 'ws://host/x', isNavigation: false, mainUrl: MAIN, mode: 'strict' }), false);
    assert.strictEqual(isRequestAllowed({ url: 'wss://host/x', isNavigation: false, mainUrl: MAIN, mode: 'strict' }), false);
});

test('strict: permite data: y about:blank (inocuos)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'data:image/png;base64,AAAA', isNavigation: false, mainUrl: MAIN, mode: 'strict' }),
        true,
    );
    assert.strictEqual(isRequestAllowed({ url: 'about:blank', isNavigation: false, mainUrl: MAIN, mode: 'strict' }), true);
});

test('es case-insensitive en el esquema', () => {
    assert.strictEqual(isRequestAllowed({ url: 'HTTP://evil/x', isNavigation: false, mainUrl: MAIN }), false);
    assert.strictEqual(isRequestAllowed({ url: 'FILE:///etc/passwd', isNavigation: false, mainUrl: MAIN }), false);
});

test('rechaza url no-string', () => {
    assert.strictEqual(isRequestAllowed({ url: null, isNavigation: true, mainUrl: MAIN }), false);
});

// --- modo 'report' (reportes legacy autorados, con Mermaid) ---

test('report: permite la navegación al documento principal', () => {
    assert.strictEqual(
        isRequestAllowed({ url: MAIN, isNavigation: true, mainUrl: MAIN, mode: 'report' }),
        true,
    );
});

test('report: permite SOLO la CDN de Mermaid (jsdelivr)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        true,
    );
    assert.strictEqual(
        isRequestAllowed({ url: 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        true,
    );
});

test('report: igual bloquea LFI (file:// extra)', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'file:///etc/passwd', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        false,
    );
});

test('report: igual bloquea SSRF a red interna y CDNs no confiables', () => {
    assert.strictEqual(
        isRequestAllowed({ url: 'http://169.254.169.254/latest/meta-data/', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        false,
    );
    assert.strictEqual(
        isRequestAllowed({ url: 'https://evil.example/x.js', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        false,
    );
    // jsdelivr por http (no https) NO se permite.
    assert.strictEqual(
        isRequestAllowed({ url: 'http://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        false,
    );
    // Otro path de jsdelivr que no sea mermaid NO se permite.
    assert.strictEqual(
        isRequestAllowed({ url: 'https://cdn.jsdelivr.net/npm/evil-pkg/dist/x.js', isNavigation: false, mainUrl: MAIN, mode: 'report' }),
        false,
    );
});

// --- makeRequestHandler: prueba el render EFECTIVO (continue/abort) ---

function fakeRequest(url, { isNavigation = false } = {}) {
    const calls = { continued: false, aborted: false };
    return {
        url: () => url,
        isNavigationRequest: () => isNavigation,
        continue: () => { calls.continued = true; },
        abort: () => { calls.aborted = true; },
        _calls: calls,
    };
}

test('handler strict: ABORTA file:// extra y red, CONTINÚA el documento principal', () => {
    const handler = makeRequestHandler(MAIN, 'strict');

    const nav = fakeRequest(MAIN, { isNavigation: true });
    handler(nav);
    assert.strictEqual(nav._calls.continued, true);
    assert.strictEqual(nav._calls.aborted, false);

    const lfi = fakeRequest('file:///c/Users/Administrator/.claude/secrets/credentials.json');
    handler(lfi);
    assert.strictEqual(lfi._calls.aborted, true);
    assert.strictEqual(lfi._calls.continued, false);

    const ssrf = fakeRequest('http://169.254.169.254/latest/meta-data/');
    handler(ssrf);
    assert.strictEqual(ssrf._calls.aborted, true);

    const cdn = fakeRequest('https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js');
    handler(cdn);
    assert.strictEqual(cdn._calls.aborted, true, 'en strict ni siquiera la CDN se permite');
});

test('handler report: ABORTA file:// extra y red interna, CONTINÚA Mermaid CDN', () => {
    const handler = makeRequestHandler(MAIN, 'report');

    const lfi = fakeRequest('file:///etc/passwd');
    handler(lfi);
    assert.strictEqual(lfi._calls.aborted, true);

    const ssrf = fakeRequest('http://internal.service/admin');
    handler(ssrf);
    assert.strictEqual(ssrf._calls.aborted, true);

    const cdn = fakeRequest('https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js');
    handler(cdn);
    assert.strictEqual(cdn._calls.continued, true);
    assert.strictEqual(cdn._calls.aborted, false);
});

test('TRUSTED_CDN_PREFIXES está acotado a Mermaid', () => {
    assert.ok(Array.isArray(TRUSTED_CDN_PREFIXES));
    assert.ok(TRUSTED_CDN_PREFIXES.every((p) => p.startsWith('https://') && p.includes('mermaid')));
});

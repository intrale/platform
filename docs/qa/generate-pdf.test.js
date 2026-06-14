'use strict';

// CA-7 (#3929) — prueba que el PATH EJECUTADO del render HTML→PDF tiene el
// sandbox cableado (no dead-code). No lanza puppeteer: valida el handler real
// exportado por generate-pdf.js y verifica el wiring a nivel de fuente.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const generatePdf = require('./generate-pdf');

const MAIN = 'file:///c/tmp/reporte.html';

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

test('generate-pdf.js exporta el wiring del sandbox', () => {
    assert.strictEqual(typeof generatePdf.generate, 'function');
    assert.strictEqual(typeof generatePdf.makeRequestHandler, 'function');
    assert.strictEqual(typeof generatePdf.isRequestAllowed, 'function');
});

test('el handler efectivo (modo report) aborta file:// extra y red interna', () => {
    const handler = generatePdf.makeRequestHandler(MAIN, 'report');

    const lfi = fakeRequest('file:///c/Users/Administrator/.claude/secrets/credentials.json');
    handler(lfi);
    assert.strictEqual(lfi._calls.aborted, true, 'LFI debe abortarse');

    const ssrf = fakeRequest('http://169.254.169.254/latest/meta-data/');
    handler(ssrf);
    assert.strictEqual(ssrf._calls.aborted, true, 'SSRF debe abortarse');

    const nav = fakeRequest(MAIN, { isNavigation: true });
    handler(nav);
    assert.strictEqual(nav._calls.continued, true, 'el documento principal debe continuar');

    const cdn = fakeRequest('https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js');
    handler(cdn);
    assert.strictEqual(cdn._calls.continued, true, 'Mermaid CDN debe continuar en reportes legacy');
});

test('generate-pdf.js cablea setRequestInterception + makeRequestHandler (anti dead-code)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'generate-pdf.js'), 'utf8');
    assert.match(src, /setRequestInterception\(true\)/, 'debe activar la interceptación de requests');
    assert.match(src, /page\.on\(\s*['"]request['"]\s*,\s*makeRequestHandler\(/, 'debe enganchar el handler real');
});

test('report-to-pdf-telegram.js ya no delega en generate-pdf.js (path endurecido siempre)', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'scripts', 'report-to-pdf-telegram.js'),
        'utf8',
    );
    assert.doesNotMatch(src, /execSync\(\s*`?node[^)]*generate-pdf\.js/, 'no debe delegar el render a generate-pdf.js');
    assert.match(src, /makeRequestHandler\(mainUrl,\s*['"]strict['"]\)/, 'debe usar el handler strict');
    assert.match(src, /setJavaScriptEnabled\(false\)/, 'debe deshabilitar JS en el flujo de entregables');
});

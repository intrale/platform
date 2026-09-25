'use strict';
// #7633 (A1 · SE4) — render PDF strict extraído, con puppeteer falso.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../pdf-render-strict');

function fakePuppeteer({ gotoThrows = false } = {}) {
    const rec = { launch: [], js: [], interception: [], handlers: [], goto: [], pdf: [], closed: 0 };
    const page = {
        setJavaScriptEnabled: async (v) => { rec.js.push(v); },
        setRequestInterception: async (v) => { rec.interception.push(v); },
        on: (ev, h) => { if (ev === 'request') rec.handlers.push(h); },
        goto: async (url, o) => { rec.goto.push({ url, o }); if (gotoThrows) throw new Error('boom'); },
        pdf: async (o) => { rec.pdf.push(o); },
    };
    const browser = { newPage: async () => page, close: async () => { rec.closed++; } };
    return { rec, impl: { launch: async (o) => { rec.launch.push(o); return browser; } } };
}

function fakeRequest(url, isNav) {
    const r = { url: () => url, isNavigationRequest: () => isNav, result: null };
    r.continue = () => { r.result = 'continue'; };
    r.abort = () => { r.result = 'abort'; };
    return r;
}

test('deshabilita JS, intercepta requests y lanza sin --no-sandbox', async () => {
    const { rec, impl } = fakePuppeteer();
    const out = await R.renderPdfStrict('C:\\tmp\\x.html', { puppeteerImpl: impl, title: 't' });
    assert.strictEqual(out, 'C:\\tmp\\x.pdf');
    assert.deepStrictEqual(rec.js, [false]);
    assert.deepStrictEqual(rec.interception, [true]);
    assert.deepStrictEqual(rec.launch, [{ headless: 'new' }]);
    assert.ok(!JSON.stringify(rec.launch).includes('no-sandbox'));
    assert.strictEqual(rec.goto[0].url, 'file:///C:/tmp/x.html');
    assert.strictEqual(rec.closed, 1);
});

test('el handler es el strict: aborta red y file:// extra, deja pasar el documento', async () => {
    const { rec, impl } = fakePuppeteer();
    await R.renderPdfStrict('/tmp/x.html', { puppeteerImpl: impl, outPath: '/tmp/y.pdf' });
    const h = rec.handlers[0];
    const main = fakeRequest('file:///tmp/x.html', true);
    const net = fakeRequest('https://cdn.jsdelivr.net/npm/mermaid/x.js', false);
    const lfi = fakeRequest('file:///etc/passwd', false);
    [main, net, lfi].forEach((r) => h(r));
    assert.deepStrictEqual([main.result, net.result, lfi.result], ['continue', 'abort', 'abort']);
    assert.strictEqual(rec.pdf[0].path, '/tmp/y.pdf');
});

test('el título se escapa dentro del headerTemplate', async () => {
    const { rec, impl } = fakePuppeteer();
    await R.renderPdfStrict('/tmp/x.html', { puppeteerImpl: impl, title: '<script>alert(1)</script>"><img src=x onerror=alert(1)>' });
    const header = rec.pdf[0].headerTemplate;
    assert.ok(!/<script|<img/i.test(header));
    assert.ok(header.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img'));
    assert.ok(!/<script|<img/i.test(rec.pdf[0].footerTemplate));
});

test('la firma no acepta opciones para ablandar la política', async () => {
    const { rec, impl } = fakePuppeteer();
    await R.renderPdfStrict('/tmp/x.html', {
        puppeteerImpl: impl,
        javascript: true,
        javaScriptEnabled: true,
        mode: 'report',
        args: ['--no-sandbox'],
        launchOptions: { args: ['--no-sandbox'] },
    });
    assert.deepStrictEqual(rec.js, [false]);
    assert.deepStrictEqual(rec.launch, [{ headless: 'new' }]);
    const net = fakeRequest('https://cdn.jsdelivr.net/npm/mermaid/x.js', false);
    rec.handlers[0](net);
    assert.strictEqual(net.result, 'abort');
    assert.ok(Object.isFrozen(R.LAUNCH_OPTIONS));
});

test('cierra el browser aunque falle la navegación', async () => {
    const { rec, impl } = fakePuppeteer({ gotoThrows: true });
    await assert.rejects(R.renderPdfStrict('/tmp/x.html', { puppeteerImpl: impl }), /boom/);
    assert.strictEqual(rec.closed, 1);
});

test('htmlPath obligatorio', async () => {
    await assert.rejects(R.renderPdfStrict('', {}), /htmlPath requerido/);
});

test('render real con el puppeteer del repo (si está instalado)', async (t) => {
    if (!R.isPuppeteerAvailable()) {
        t.skip('puppeteer no instalado en docs/qa/node_modules');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-strict-7633-'));
    try {
        const html = path.join(dir, 'x.html');
        fs.writeFileSync(html, '<!DOCTYPE html><html><body><p>hola</p><script>document.body.innerHTML="JS"</script></body></html>');
        const pdf = await R.renderPdfStrict(html, { title: 'prueba <b>' });
        assert.ok(fs.statSync(pdf).size > 500);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

'use strict';

// Ensayo local: driver caído, sink y cola reales, sin entregar mensajes al operador.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const output = path.join(root, 'docs/pipeline/evidence/5113-retry');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-evidence-5113-'));

(async () => {
    let browser;
    try {
        fs.mkdirSync(output, { recursive: true });
        process.env.PIPELINE_DIR_OVERRIDE = runtime;
        process.env.PIPELINE_OPSTATE_DURABLE = '1';
        require(path.join(root, '.pipeline/lib/config-resolver')).resolve = () => ({
            operational_state: { durable: true }, kernel: { cutover_window: true },
        });
        const backend = require(path.join(root, '.pipeline/lib/operational-state-backend'));
        backend._setDriverForTests({
            driver: { getItem() { throw new Error('ECONNRESET'); } },
            spec: { tableName: 'intrale-kernel-coordination' },
            projectId: 'intrale-platform', instanceId: 'fakeInstance', atomicUpdate: true,
        });
        const result = backend.readKeyWithVersion('partial-pause');
        const queue = path.join(runtime, 'servicios/telegram/pendiente');
        const files = fs.readdirSync(queue).filter((name) => name.endsWith('.json'));
        const payload = JSON.parse(fs.readFileSync(path.join(queue, files[0]), 'utf8'));
        const report = { degraded: result.degraded, queued: files.length,
            paused: JSON.parse(fs.readFileSync(path.join(runtime, '.paused'), 'utf8')),
            text: payload.text, delivery: 'Cola aislada; sin entrega a Telegram.' };
        fs.writeFileSync(path.join(output, 'probe.json'), JSON.stringify(report, null, 2));
        const escape = require(path.join(root, '.pipeline/lib/escape-html')).escapeHtmlText;
        const text = payload.text.replace(/\\/g, '');
        fs.writeFileSync(path.join(output, 'preview.html'), '<!doctype html><meta charset="utf-8">'
            + '<h1>Ensayo aislado #5113: alerta de estado operativo</h1>'
            + '<p>Vista del texto encolado; no es una captura del cliente Telegram.</p>'
            + '<pre>' + escape(text) + '</pre><h2>Resultado observado</h2><pre>'
            + escape(JSON.stringify({ degraded: report.degraded, queued: report.queued,
                paused: report.paused, delivery: report.delivery }, null, 2)) + '</pre>');
        const puppeteer = require(path.join(root, 'docs/qa/node_modules/puppeteer'));
        browser = await puppeteer.launch({ headless: true,
            executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(require('node:url').pathToFileURL(path.join(output, 'preview.html')).href);
        await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (browser) await browser.close();
        fs.rmSync(runtime, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });

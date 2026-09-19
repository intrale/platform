'use strict';

// Evidencia aislada: HTTP + SSR reales, snapshot sintético y sender capturado.
// No escribe estado ni manda mensajes al pipeline de producción.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const probe = require('../lib/multi-provider/agy-plan-probe');
const cron = require('../lib/multi-provider/health-cron');
const secrets = require('../lib/multi-provider/secrets-rw');
const out = path.resolve(__dirname, '../evidence/6564');

async function main() {
    fs.mkdirSync(out, { recursive: true });
    const root = process.env.PIPELINE_REPO_ROOT || path.resolve(__dirname, '../..');
    const externalRequire = createRequire(path.join(root, '.pipeline/package.json'));
    const puppeteer = externalRequire('puppeteer');
    const view = require('../views/dashboard/providers');
    const originalRead = fs.readFileSync, originalKeys = secrets.listKeys;
    const now = Date.now();
    const groups = probe.GROUPS.map(g => ({ name: g.name, buckets: g.ids.map((id, i) => ({
        id, window: i ? '5h' : 'weekly', remaining_fraction: i ? 1 : 0.9935, reset_time: '2026-09-23T16:14:00.000Z',
    })) }));
    const base = { provider: 'antigravity', state: 'green', reason_code: 'cli_catalog_ok',
        last_checked_at: new Date(now).toISOString(), auth_mode: 'oauth', cli_probe: { model_count: 14 } };
    let row;
    const scenarios = [
        ['con-cuota', { ...base, plan_check: { reason_code: 'plan_quota_ok', checked_at: new Date(now - 720000).toISOString(), groups } }, 'PLAN CON CUOTA · 99% SEMANAL'],
        ['sin-verificar', { ...base, plan_check: { reason_code: 'plan_tier_unknown', checked_at: new Date(now).toISOString(), consecutive_count: 2 } }, 'PLAN · SIN VERIFICAR'],
        ['sin-sesion', { ...base, state: 'red', reason_code: 'cli_license_unavailable', plan_check: { reason_code: 'cli_license_unavailable', checked_at: new Date(now).toISOString() } }, 'PLAN · NO VERIFICABLE'],
    ];
    fs.readFileSync = function(file, ...args) {
        if (String(file).replace(/\\/g, '/').endsWith('/state/multi-provider-health.json')) {
            return JSON.stringify({ ts: new Date(now).toISOString(), providers: [row], green_count: row.state === 'green' ? 1 : 0, red_count: row.state === 'red' ? 1 : 0 });
        }
        return originalRead.call(fs, file, ...args);
    };
    secrets.listKeys = () => [];
    const server = http.createServer((req, res) => {
        if (req.url !== '/providers') { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(view.renderProviders());
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 1000 });
        await page.setJavaScriptEnabled(false);
        row = scenarios[0][1];
        await page.goto(`http://127.0.0.1:${server.address().port}/providers`);
        for (const [id, value, expected] of scenarios) {
            row = value;
            await page.reload();
            const el = await page.$('[data-provider="antigravity"]');
            assert.ok((await el.evaluate(e => e.textContent)).includes(expected));
            await el.scrollIntoView();
            await el.screenshot({ path: path.join(out, `${id}.png`) });
            await page.screenshot({ path: path.join(out, `${id}-page.png`) });
            const boxes = await el.evaluate(e => {
                const plan = e.querySelector('.prov-id-txt [title]').getBoundingClientRect();
                const key = e.querySelector('.prov-col-key').getBoundingClientRect();
                return { planRight: plan.right, keyLeft: key.left };
            });
            assert.ok(boxes.planRight <= boxes.keyLeft, 'badge sin superposición con credencial');
            const title = await el.$eval('.prov-id-txt [title]', e => e.title);
            fs.writeFileSync(path.join(out, `${id}-tooltip.txt`), title + '\n');
        }
        const dedupFile = path.join(out, 'synthetic-dedup.json');
        try { fs.unlinkSync(dedupFile); } catch { /* primera corrida */ }
        const captured = [];
        const telegramSender = p => { captured.push(cron.formatAlertText(p)); return true; };
        row = scenarios[1][1];
        row.plan_check.consecutive_count = 1;
        cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now, telegramSender });
        assert.equal(captured.length, 0);
        row.plan_check.consecutive_count = 2;
        cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now: now + 300000, telegramSender });
        assert.equal(captured.length, 1);
        cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now: now + 600000, telegramSender });
        assert.equal(captured.length, 1);
        fs.writeFileSync(path.join(out, 'telegram-sintetico.txt'), captured[0] + '\n');
        console.log('E2E HTTP/SSR: 3 estados OK. Telegram capturado: tick 1=0, tick 2=1, tick 3=0. Sin envíos reales.');
    } finally {
        if (browser) await browser.close();
        server.close();
        fs.readFileSync = originalRead; secrets.listKeys = originalKeys;
    }
}
main().catch(err => { console.error(err); process.exitCode = 1; });

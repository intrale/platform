// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Render del mockup HTML → PNG (flujo UX documentado en docs/pipeline/ux-visual-flow.md:
// HTML/CSS + Puppeteer). Uso: NODE_PATH=$(npm root -g) node render-mockup.js
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
    const dir = __dirname;
    const b = await puppeteer.launch({ headless: true });
    const p = await b.newPage();
    await p.setViewport({ width: 1084, height: 900, deviceScaleFactor: 2 });
    await p.goto(pathToFileURL(path.join(dir, 'panel-esperado-cuota.html')).href, { waitUntil: 'load' });
    await p.screenshot({ path: path.join(dir, 'panel-esperado-cuota.png'), fullPage: true });
    const m = await p.evaluate(() => {
        const r = document.querySelector('.mz-sysquota').getBoundingClientRect();
        const clipped = [...document.querySelectorAll('.mz-qv,.mz-ql2,.mz-qm-h-note,.mz-qm-prov,.mz-qm-cell,.mz-qr')]
            .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim().slice(0, 40));
        return { panelW: r.width, panelH: r.height, clipped };
    });
    console.log(JSON.stringify(m));
    await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });

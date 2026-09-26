// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Captura de la fila de KPI con las dos tarjetas (E6-a / UX-2) — rebote 2 de #5691.
'use strict';
const puppeteer = require('puppeteer');
const OUT = process.argv[2];
const URL = process.argv[3] || 'http://127.0.0.1:3692/legacy';
(async () => {
  const b = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await b.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport({ width: 1440, height: 6000 });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));
    const info = await page.evaluate(() => {
      const t = document.querySelector('.kpi-triage-backlog');
      const nh = document.querySelector('.kpi-needs-human');
      const cs = getComputedStyle(t);
      const val = t.querySelector('.kpi-value');
      const ic = t.querySelector('.kpi-icon-svg');
      const use = ic && ic.querySelector('use');
      const ib = ic.getBoundingClientRect();
      const rt = t.getBoundingClientRect(), rn = nh.getBoundingClientRect();
      return {
        label: t.querySelector('.kpi-label').textContent.trim(),
        valor: val.textContent.trim(),
        valorColor: getComputedStyle(val).color,
        trend: t.querySelector('.kpi-trend').textContent.trim(),
        accent: cs.getPropertyValue('--kpi-accent').trim(),
        animation: cs.animationName,
        borderLeft: cs.borderLeftColor,
        icono: { href: use && use.getAttribute('href'), w: ib.width, h: ib.height, visible: ib.width > 0 && ib.height > 0 },
        pegadaARoja: Math.abs(rt.top - rn.top) < 2 && rt.left > rn.right && (rt.left - rn.right) < 20,
        onclick: t.getAttribute('onclick'),
        recoCount: document.querySelector('.reco-count').textContent.trim(),
        bannerTrunc: (document.querySelector('.reco-banner-truncado .reco-banner-tit') || {}).textContent,
        nhAnimation: getComputedStyle(nh).animationName,
        nhAccent: getComputedStyle(nh).getPropertyValue('--kpi-accent').trim(),
      };
    });
    const parent = await page.$('.kpis.kpis-7');
    await parent.screenshot({ path: `${OUT}/render-kpi-row-dos-tarjetas.png` });
    const t = await page.$('.kpi-triage-backlog'); const nh = await page.$('.kpi-needs-human');
    const tb = await t.boundingBox(); const nb = await nh.boundingBox();
    await page.screenshot({ path: `${OUT}/render-kpi-par-zoom.png`, clip: { x: nb.x - 6, y: nb.y - 6, width: (tb.x + tb.width) - nb.x + 12, height: tb.height + 12 } });
    // Click real: la reco-section se abre y queda en viewport; el panel de incidentes no cambia.
    const before = await page.evaluate(() => ({ recoOpen: document.getElementById('reco-section').open, nhCollapsed: (document.getElementById('bloqueados-humano') || { classList: { contains: () => null } }).classList.contains('nh-collapsed') }));
    await page.evaluate(() => { document.getElementById('reco-section').open = false; });
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await new Promise(r => setTimeout(r, 800));
    const after = await page.evaluate(() => ({ recoOpen: document.getElementById('reco-section').open, nhCollapsed: (document.getElementById('bloqueados-humano') || { classList: { contains: () => null } }).classList.contains('nh-collapsed'), recoTop: document.getElementById('reco-section').getBoundingClientRect().top }));
    const reco = await page.$('#reco-section');
    await page.evaluate(() => { const r = document.getElementById('reco-section'); const b = r.querySelector('.collapse-body'); if (b) b.style.maxHeight = '360px'; if (b) b.style.overflow = 'hidden'; }); await reco.screenshot({ path: `${OUT}/render-click-triaje-abre-reco.png` });
    console.log(JSON.stringify({ info, before, after, pageerrors: errors }, null, 2));
  } finally { await b.close(); }
})().catch(e => { console.error(e); process.exit(1); });

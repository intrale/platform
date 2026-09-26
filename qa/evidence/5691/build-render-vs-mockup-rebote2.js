// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Side-by-side render real vs mockup 48 (superficie A) — rebote 2 de #5691 (E6-a / UX-2).
'use strict';
const fs = require('fs');
const puppeteer = require('puppeteer');
const E = process.argv[2];
const MOCKUP = process.argv[3];
const HEAD = process.argv[4] || 'HEAD';
const launch = () => puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
(async () => {
  // 1) Mockup: recorte de la superficie A "DESPUÉS DE #5678" (dos tarjetas + anotación).
  let b = await launch();
  try {
    const page = await b.newPage();
    await page.setViewport({ width: 1440, height: 2260 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#0d1117">${fs.readFileSync(MOCKUP, 'utf8')}</body></html>`, { waitUntil: 'load' });
    await page.screenshot({ path: `${E}/mockup-48-superficie-A.png`, clip: { x: 30, y: 330, width: 1380, height: 135 } });
  } finally { await b.close(); }
  // 2) Composición.
  const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(`${E}/${f}`).toString('base64');
  const cap = (t, c) => `<div style="font-size:12px;color:${c || '#8b949e'};margin:10px 0 6px">${t}</div>`;
  const html = `<!doctype html><html><body style="margin:0;background:#0d1117;color:#e6edf3;font-family:Segoe UI,Arial,sans-serif">
<div style="padding:14px 18px;font-size:15px;font-weight:700">#5691 · rebote 2 · E6-a / UX-2 — fila de KPI con las dos tarjetas: render real (HEAD ${HEAD}, /legacy desde el worktree) vs mockup 48 superficie A — ${new Date().toISOString().slice(0, 10)}</div>
<div style="padding:0 18px 18px">
  ${cap('MOCKUP · 48-needs-human-vs-triage-backlog.svg · superficie A "DESPUÉS DE #5678": [NECESITAN HUMANO · bloquean la ola activa] + [TRIAJE DE BACKLOG · no frenan ninguna ola] — "Dos KPI, dos urgencias, dos destinos de click"')}
  <img src="${b64('mockup-48-superficie-A.png')}" style="width:100%;border:1px solid #30363d">
  ${cap('RENDER · fila de KPI completa (7 tarjetas): la de TRIAJE DE BACKLOG va pegada a NECESITAN HUMANO; valor 2222 = totalAbiertas en runtime (el badge de la reco-section sigue en 200 = items.length truncado); tokens --purple, sin pulso, sin #B60205', '#3fb950')}
  <img src="${b64('render-kpi-row-dos-tarjetas.png')}" style="width:100%;border:1px solid #3fb950">
  ${cap('RENDER · zoom del par: rojo (⚠, 2, "click para colapsar/expandir") vs violeta (ícono ic-triage-backlog bandeja + "Triaje de backlog", 2222, "no frenan ninguna ola")', '#3fb950')}
  <img src="${b64('render-kpi-par-zoom.png')}" style="width:40%;border:1px solid #3fb950">
  ${cap('RENDER · click real sobre la tarjeta violeta: abre la reco-section (details.open=true) y la trae al tope del viewport; el panel de incidentes no cambia — "ningún click lleva al otro lado"', '#3fb950')}
  <img src="${b64('render-click-triaje-abre-reco.png')}" style="width:100%;border:1px solid #3fb950">
</div></body></html>`;
  b = await launch();
  try {
    const page = await b.newPage();
    await page.setViewport({ width: 1600, height: 1200 });
    await page.setContent(html, { waitUntil: 'networkidle2' });
    await page.screenshot({ path: `${E}/screenshot-render-vs-mockup-kpi-row.png`, fullPage: true });
  } finally { await b.close(); }
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });

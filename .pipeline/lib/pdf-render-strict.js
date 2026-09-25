// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// pdf-render-strict.js — Render HTML→PDF endurecido, reutilizable (#7633 · A1 · SE4).
//
// Extraído de `scripts/report-to-pdf-telegram.js` (`generatePdf`, CA-7 de #3929)
// para que el export de autoría pueda generar su PDF SIN pasar por el script de
// reportes (que escribe en `docs/qa/` y manda a Telegram).
//
// Política fija en el código, NO configurable por quien llama:
//   - JavaScript deshabilitado (`setJavaScriptEnabled(false)`).
//   - Interceptación de requests con `makeRequestHandler(mainUrl, 'strict')`:
//     sólo la navegación al documento principal; se aborta todo `file://`
//     adicional (LFI) y toda la red (SSRF), sin allowlist de CDN.
//   - `puppeteer.launch` con opciones fijas: sin `--no-sandbox` ni args extra.
//   - El título se escapa ACÁ ADENTRO antes de interpolarse en `headerTemplate`
//     (que también es HTML): no se confía en que lo escape el caller.
//
// La firma sólo acepta `outPath`, `title` y `puppeteerImpl` (este último, para
// tests). Cualquier otra opción (JS, modo, args) se ignora a propósito.
// =============================================================================

const path = require('path');
const { makeRequestHandler } = require('./render-sandbox');
const { escapeHtmlAttr } = require('./escape-html');

const LAUNCH_OPTIONS = Object.freeze({ headless: 'new' });
const FOOTER_TEMPLATE = '<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-bottom:5mm;">Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></div>';

function loadPuppeteer() {
    return require(path.join(__dirname, '..', '..', 'docs', 'qa', 'node_modules', 'puppeteer'));
}

/** true si el puppeteer del repo (`docs/qa/node_modules`) está instalado. */
function isPuppeteerAvailable() {
    try { loadPuppeteer(); return true; } catch { return false; }
}

function headerTemplate(title) {
    return `<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-top:5mm;">${escapeHtmlAttr(title)}</div>`;
}

/**
 * @param {string} htmlPath — archivo HTML local a renderizar.
 * @param {{outPath?: string, title?: string, puppeteerImpl?: object}} [opts]
 * @returns {Promise<string>} ruta del PDF generado.
 */
async function renderPdfStrict(htmlPath, { outPath, title = '', puppeteerImpl } = {}) {
    if (typeof htmlPath !== 'string' || !htmlPath) throw new Error('renderPdfStrict: htmlPath requerido');
    const pdfPath = outPath || htmlPath.replace(/\.html?$/i, '') + '.pdf';
    const puppeteer = puppeteerImpl || loadPuppeteer();
    const browser = await puppeteer.launch({ ...LAUNCH_OPTIONS });
    try {
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        const mainUrl = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/^\/+/, '');
        await page.setRequestInterception(true);
        page.on('request', makeRequestHandler(mainUrl, 'strict'));
        await page.goto(mainUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
            displayHeaderFooter: true,
            headerTemplate: headerTemplate(title),
            footerTemplate: FOOTER_TEMPLATE,
        });
    } finally {
        await browser.close();
    }
    return pdfPath;
}

module.exports = { renderPdfStrict, isPuppeteerAvailable, headerTemplate, LAUNCH_OPTIONS, FOOTER_TEMPLATE };

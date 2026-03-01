#!/usr/bin/env node
// Uso: node generate-pdf.js <nombre-reporte>
// Ejemplo: node generate-pdf.js reporte-login-flujos-y-casos
// Genera el PDF a partir del HTML con el mismo nombre base.

const puppeteer = require('puppeteer');
const path = require('path');

const reportName = process.argv[2];
if (!reportName) {
  console.error('Uso: node generate-pdf.js <nombre-reporte-sin-extension>');
  console.error('Ejemplo: node generate-pdf.js reporte-login-flujos-y-casos');
  process.exit(1);
}

const htmlFile = reportName.endsWith('.html') ? reportName : reportName + '.html';
const pdfFile = htmlFile.replace(/\.html$/, '.pdf');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  const htmlPath = path.resolve(__dirname, htmlFile);
  console.log('Cargando:', htmlPath);
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), {
    waitUntil: 'networkidle0',
    timeout: 60000
  });

  // Esperar a que Mermaid renderice todos los diagramas (si hay)
  const hasMermaid = await page.evaluate(() => document.querySelectorAll('.mermaid').length > 0);
  if (hasMermaid) {
    console.log('Esperando renderizado de Mermaid...');
    await page.waitForFunction(() => {
      const mermaidDivs = document.querySelectorAll('.mermaid');
      return mermaidDivs.length > 0 && Array.from(mermaidDivs).every(d => d.querySelector('svg'));
    }, { timeout: 30000 });
    // Extra wait para estabilizar SVGs
    await new Promise(r => setTimeout(r, 2000));
  }

  const pdfPath = path.resolve(__dirname, pdfFile);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-top:5mm;">Intrale Platform — ${reportName} — v2.0</div>`,
    footerTemplate: '<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-bottom:5mm;">Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></div>'
  });

  console.log('PDF generado:', pdfPath);
  await browser.close();
})();

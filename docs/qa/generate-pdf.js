#!/usr/bin/env node
// Uso: node generate-pdf.js <nombre-reporte>
// Ejemplo: node generate-pdf.js reporte-login-flujos-y-casos
// Genera el PDF a partir del HTML con el mismo nombre base.
//
// CA-7 (#3929) — endurecimiento del render HTML→PDF. Este script renderiza
// reportes legacy autorados por el equipo (con diagramas Mermaid, que necesitan
// JavaScript), así que NO deshabilita JS. Pero SÍ aplica el sandbox de red para
// cerrar LFI/SSRF: interceptación de requests con la política compartida en
// .pipeline/lib/render-sandbox.js en modo 'report':
//   - bloquea todo `file://` adicional (LFI),
//   - bloquea toda la red (SSRF) EXCEPTO la CDN de Mermaid (jsdelivr).
// El contenido derivado de LLM / input del issue NO pasa por acá: ese flujo usa
// scripts/report-to-pdf-telegram.js en modo 'strict' (JS off + sin red).

const path = require('path');
const { makeRequestHandler } = require(
  path.join(__dirname, '..', '..', '.pipeline', 'lib', 'render-sandbox')
);

async function generate(reportName) {
  const puppeteer = require('puppeteer');

  const htmlFile = reportName.endsWith('.html') ? reportName : reportName + '.html';
  const pdfFile = htmlFile.replace(/\.html$/, '.pdf');

  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();

    const htmlPath = path.resolve(__dirname, htmlFile);
    const mainUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
    console.log('Cargando:', htmlPath);

    // CA-7 — sandbox de red. JS queda habilitado (Mermaid lo necesita), pero
    // se aborta todo file:// extra y toda la red salvo la CDN de Mermaid.
    await page.setRequestInterception(true);
    page.on('request', makeRequestHandler(mainUrl, 'report'));

    await page.goto(mainUrl, {
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
    return pdfPath;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const reportName = process.argv[2];
  if (!reportName) {
    console.error('Uso: node generate-pdf.js <nombre-reporte-sin-extension>');
    console.error('Ejemplo: node generate-pdf.js reporte-login-flujos-y-casos');
    process.exit(1);
  }
  generate(reportName).catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

// Reexporta la política para tests y para garantizar que el wiring de CA-7 no
// quede como dead-code (#3929).
const { isRequestAllowed } = require(
  path.join(__dirname, '..', '..', '.pipeline', 'lib', 'render-sandbox')
);
module.exports = { generate, isRequestAllowed, makeRequestHandler };

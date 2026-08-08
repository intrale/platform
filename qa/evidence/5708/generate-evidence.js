'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(ROOT, 'docs/qa/node_modules/puppeteer'));
const { renderHtml } = require(path.join(ROOT, '.pipeline/rejection-report'));

const evidenceDir = __dirname;
const mockupPath = path.join(ROOT, '.pipeline/assets/mockups/5708/preview-48.png');
const dataUri = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

const baseData = visualComparison => ({
  issue: 5708,
  skill: 'qa',
  fase: 'verificacion',
  elapsed: 60,
  motivo: 'Validacion visual del inventario completo',
  timestamp: '2026-08-08',
  isoDate: '2026-08-08T00:00:00Z',
  issueCtx: { title: 'QA visual: inventario completo y cobertura declarada' },
  rejectHistory: [],
  logTail: '',
  readableLog: '',
  depIssues: { linkedDeps: [] },
  autoCreatedDeps: [],
  preflight: { ok: true, line: 'renderer local sin red' },
  evidence: { video: null, frames: 2, logPath: null, videoBytes: 0, logBytes: 0 },
  primaryCause: {
    summary: 'Comparacion visual requerida por CA-1 y CA-9',
    detail: 'Render end-to-end del inventario contra el mockup 48.',
    priority: 'high',
  },
  inconclusive: false,
  sessionCtx: { provider: 'openai', model: 'gpt-5', cliVersion: 'pipeline-v2' },
  visualComparison,
});

const comparison = deliverySrc => ({
  issue: 5708,
  rev: 1,
  mockup: { src: dataUri(mockupPath), baseline: 'mockup-48' },
  delivery: { src: deliverySrc },
  coverage: {
    secciones_declaradas: ['A', 'B', 'C', 'D'],
    verificadas: ['A', 'B', 'C', 'D'],
    no_verificadas: [],
  },
  diffs: [
    { section: 'A', title: 'Cobertura visual declarada', description: 'La entrega renderiza las cuatro secciones con etiqueta textual VERIFICADA.', impact: 'alto', regression: false },
    { section: 'B', title: 'Inventario agrupado por seccion', description: 'La entrega agrupa cada hallazgo y conserva el orden de impacto descendente.', impact: 'alto', regression: false },
    { section: 'C', title: 'Regresion distinguible sin depender del color', description: 'El inventario incluye una etiqueta textual REGRESION junto al impacto.', impact: 'medio', regression: true },
    { section: 'D', title: 'Truncado declarado', description: 'La banda informa N de M y el tope de render del PDF.', impact: 'bajo', regression: false },
  ],
  suggestedAction: { skill: 'pipeline-dev', text: 'Validar el render real contra el mockup versionado 48.' },
});

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
  await page.setJavaScriptEnabled(false);

  const provisional = comparison(dataUri(mockupPath));
  await page.setContent(renderHtml(baseData(provisional)), { waitUntil: 'load' });
  const deliveryPath = path.join(evidenceDir, 'delivery-render.png');
  await page.screenshot({ path: deliveryPath, fullPage: true });

  const visualComparison = comparison(dataUri(deliveryPath));
  fs.writeFileSync(path.join(evidenceDir, 'visual-comparison.json'), JSON.stringify(visualComparison, null, 2));

  const finalHtml = renderHtml(baseData(visualComparison));
  await page.setContent(finalHtml, { waitUntil: 'load' });
  const pdfPath = path.join(evidenceDir, 'rejection-5708-qa.pdf');
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
  const pdfRenderPath = path.join(evidenceDir, 'pdf-render.png');
  await page.screenshot({ path: pdfRenderPath, fullPage: true });

  const mockupUri = dataUri(mockupPath);
  const pdfRenderUri = dataUri(pdfRenderPath);
  await page.setViewport({ width: 2520, height: 2450, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111827;color:#fff;font:24px Arial}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px}.panel{background:#fff;color:#111;padding:12px}.panel h1{font-size:24px;margin:0 0 12px}.panel img{display:block;width:100%;height:auto}</style><div class="grid"><div class="panel"><h1>Mockup 48 esperado</h1><img src="${mockupUri}"></div><div class="panel"><h1>Render del PDF generado</h1><img src="${pdfRenderUri}"></div></div>`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(evidenceDir, 'screenshot-pdf-vs-mockup.png'), fullPage: true });
  await browser.close();
  fs.rmSync(deliveryPath, { force: true });
  fs.rmSync(pdfRenderPath, { force: true });
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

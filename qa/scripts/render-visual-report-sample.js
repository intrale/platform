'use strict';

// =============================================================================
// #5708 — Harness end-to-end del bloque visual del rejection report.
//
// Genera un PDF real a partir de un contrato `visual-comparison.json` válido,
// para poder verificar a ojo (y en QA) que el inventario, la cobertura y las
// bandas degradadas se renderizan como manda el mockup, en vez de confiar en
// asserts sobre HTML en memoria.
//
// Por qué vive acá y no en `qa/evidence/<issue>/`:
//   - CA-12 · CA-15 · SEC-9: `qa/evidence/<issue>/` es la RUTA VIVA que el
//     pipeline lee por convención. Un fixture de demo ahí adentro arma un
//     rejection report falso para todo rechazo futuro de ese issue.
//   - Su antecesor (`qa/evidence/5708/generate-evidence.js`) escribía el
//     contrato con las capturas embebidas en base64, que es exactamente el
//     patrón que SEC-8 prohíbe en un repo público.
//
// Salidas: directorio temporal del SO (nunca `qa/evidence/`). El path se
// imprime al terminar.
//
// Uso: node qa/scripts/render-visual-report-sample.js [--state rejected|approved|stale|oversize]
//      [--out-dir qa/evidence/5708]
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'docs/qa/node_modules/puppeteer'));
const { renderHtml } = require(path.join(ROOT, '.pipeline/rejection-report'));

const mockupPath = path.join(ROOT, '.pipeline/assets/mockups/5708/preview-50.png');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const requestedOutDir = argValue('--out-dir');
const outDir = requestedOutDir
  ? path.resolve(ROOT, requestedOutDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'visual-report-5708-'));
fs.mkdirSync(outDir, { recursive: true });

const stateArg = (() => {
  return argValue('--state') || 'rejected';
})();

const baseData = extra => ({
  issue: 5708,
  skill: 'qa',
  fase: 'verificacion',
  elapsed: 60,
  motivo: 'Validacion visual del inventario completo',
  timestamp: '2026-08-10',
  isoDate: '2026-08-10T00:00:00Z',
  issueCtx: { title: 'QA visual: inventario completo y cobertura declarada' },
  rejectHistory: [],
  logTail: '',
  readableLog: '',
  depIssues: { linkedDeps: [] },
  autoCreatedDeps: [],
  preflight: { ok: true, line: 'renderer local sin red' },
  evidence: { video: null, frames: 2, logPath: null, videoBytes: 0, logBytes: 0 },
  primaryCause: null,
  inconclusive: false,
  sessionCtx: { provider: 'anthropic', model: 'opus-4.7', cliVersion: 'pipeline-v3' },
  visualComparison: null,
  visualSkip: null,
  ...extra,
});

// Contrato revisión 2: `verdict` + `rev` obligatorios, imágenes POR REFERENCIA.
// Los `src` son paths relativos al directorio del issue; `safeImageSrc` los
// resuelve contra `qa/evidence/<issue>/` y los confina ahí.
//
// OJO: este harness pasa el contrato directo a `renderHtml`, sin cruzar
// `loadVisualComparison`. Por eso el `regression: true` de abajo es un literal
// de demo para ver el badge — en el camino real ese campo lo DERIVA
// `visual-coverage-store` contra la pasada previa y se ignora lo que declare el
// contrato (ver `.pipeline/tests/visual-coverage-store.test.js`).
const contract = {
  issue: 5708,
  rev: 3,
  verdict: 'rejected',
  mockup: { src: 'mockup-50.png', baseline: 'mockup-50' },
  delivery: { src: 'render-rev3.png' },
  coverage: {
    secciones_declaradas: ['A', 'B', 'C', 'D'],
    verificadas: ['A', 'B', 'C'],
    no_verificadas: [{ section: 'D', motivo: 'estado no alcanzable sin datos de negocio' }],
  },
  diffs: [
    { section: 'A', title: 'A3 nunca se pinta en rojo', description: 'token --danger-fg esperado; la entrega usa --text-muted', impact: 'alto', regression: true },
    { section: 'A', title: 'Falta la duracion del rebote', description: 'el chip de duracion no aparece en la cabecera', impact: 'medio', regression: false },
    { section: 'B', title: 'Inventario sin agrupar', description: 'los hallazgos salen planos, no agrupados por seccion', impact: 'alto', regression: false },
    { section: 'C', title: 'Backoff no declarado', description: 'la banda no informa el proximo reintento', impact: 'bajo', regression: false },
  ],
  suggestedAction: { skill: 'pipeline-dev', text: 'Re-implementar el inventario respetando el mockup 50.' },
};

const STATES = {
  rejected: () => baseData({ visualComparison: contract }),
  approved: () => baseData({
    primaryCause: { summary: 'tests del modulo users fallan: 3 rojos en DoLoginTest', detail: '', priority: 'high' },
    visualSkip: { reason: 'verdict-approved', detail: '4 de 4 secciones verificadas', coverage: contract.coverage },
  }),
  stale: () => baseData({
    primaryCause: { summary: 'secreto hardcodeado en ClientLoginService.kt', detail: '', priority: 'high' },
    visualSkip: { reason: 'stale-rev', detail: 'rev 1 vs actual 3' },
  }),
  oversize: () => baseData({
    visualSkip: { reason: 'oversize', detail: 'size 1258291 B > MAX_VISUAL_JSON_BYTES 1048576' },
  }),
};

async function main() {
  const build = STATES[stateArg];
  if (!build) {
    console.error(`estado desconocido: ${stateArg} (validos: ${Object.keys(STATES).join(', ')})`);
    process.exitCode = 1;
    return;
  }
  // Materializar referencias reales evita que el PDF pruebe solamente el
  // placeholder de "imagen no disponible", que fue la causa del rebote.
  fs.copyFileSync(mockupPath, path.join(outDir, contract.mockup.src));
  fs.copyFileSync(mockupPath, path.join(outDir, contract.delivery.src));
  fs.writeFileSync(path.join(outDir, 'visual-comparison.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
  await page.setJavaScriptEnabled(false);

  let html = renderHtml(build());
  fs.writeFileSync(path.join(outDir, `rejection-5708-${stateArg}.html`), html, 'utf8');
  await page.setContent(html, { waitUntil: 'load' });
  const pdfPath = path.join(outDir, `rejection-5708-${stateArg}.pdf`);
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
  const deliveryPath = path.join(outDir, contract.delivery.src);
  await page.screenshot({ path: deliveryPath, fullPage: true });

  // Segunda pasada: el PDF definitivo consume la captura real de la primera.
  html = renderHtml(build());
  fs.writeFileSync(path.join(outDir, `rejection-5708-${stateArg}.html`), html, 'utf8');
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });

  // Cuando QA pide una salida explícita, publicar también en el path que usa
  // el rejection-report real. El archivo sigue ignorado y nunca entra a main.
  if (requestedOutDir) {
    const reportLogDir = path.join(ROOT, '.pipeline', 'logs');
    fs.mkdirSync(reportLogDir, { recursive: true });
    fs.copyFileSync(pdfPath, path.join(reportLogDir, 'rejection-5708-qa.pdf'));
  }

  const mockupUri = `data:image/png;base64,${fs.readFileSync(path.join(outDir, contract.mockup.src)).toString('base64')}`;
  const deliveryUri = `data:image/png;base64,${fs.readFileSync(deliveryPath).toString('base64')}`;
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#eef1f5;font:700 18px Arial}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:white;padding:14px;border-radius:10px}.card img{width:100%;height:auto;display:block}.label{margin-bottom:10px}</style><div class="grid"><div class="card"><div class="label">Mockup 50</div><img src="${mockupUri}"></div><div class="card"><div class="label">PDF renderizado</div><img src="${deliveryUri}"></div></div>`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(outDir, 'screenshot-pdf-vs-mockup.png'), fullPage: true });
  await browser.close();
  console.log(`estado ${stateArg} → ${outDir}`);
  console.log(`  mockup de referencia: ${path.relative(ROOT, mockupPath)}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

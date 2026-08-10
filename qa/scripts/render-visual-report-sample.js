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
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'docs/qa/node_modules/puppeteer'));
const { renderHtml } = require(path.join(ROOT, '.pipeline/rejection-report'));

const mockupPath = path.join(ROOT, '.pipeline/assets/mockups/5708/preview-48.png');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-report-5708-'));

const stateArg = (() => {
  const i = process.argv.indexOf('--state');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'rejected';
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
  mockup: { src: 'mockup-v1.png', baseline: 'mockup-48' },
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
  suggestedAction: { skill: 'pipeline-dev', text: 'Re-implementar el inventario respetando el mockup 48.' },
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
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
  await page.setJavaScriptEnabled(false);

  const html = renderHtml(build());
  fs.writeFileSync(path.join(outDir, `rejection-5708-${stateArg}.html`), html, 'utf8');
  await page.setContent(html, { waitUntil: 'load' });
  const pdfPath = path.join(outDir, `rejection-5708-${stateArg}.pdf`);
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
  await page.screenshot({ path: path.join(outDir, `rejection-5708-${stateArg}.png`), fullPage: true });
  await browser.close();
  console.log(`estado ${stateArg} → ${outDir}`);
  console.log(`  mockup de referencia: ${path.relative(ROOT, mockupPath)}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

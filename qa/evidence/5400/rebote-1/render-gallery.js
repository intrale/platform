const fs = require('fs');
const path = require('path');
const puppeteer = require('C:/Workspaces/Intrale/platform/.pipeline/node_modules/puppeteer');
const { renderDispatchCauseBanner } = require('../../../../.pipeline/lib/dispatch-cause-render');

const root = path.resolve(__dirname, '../../../..');
const tokens = fs.readFileSync(path.join(root, '.pipeline/assets/design-tokens.css'), 'utf8');
const sprite = fs.readFileSync(path.join(root, '.pipeline/assets/icons/sprite.svg'), 'utf8');
const base = {
  active: true,
  lastDispatchTs: Date.now() - 93 * 60_000,
  lastDispatchRelTime: 'hace 1 h 33 min',
  lastDispatchClock: '00:51',
  lastDispatchIssue: '5399',
  lastDispatchSkill: 'pipeline-dev',
  lastDispatchFase: 'dev',
  watchdogEnabled: true,
  watchdogDegraded: false,
  watchdogAction: 'skip',
  watchdogDecisionReason: 'no-enabled-work',
  watchdogElegibles: 0,
  elegiblesEsperando: 0,
  avisoUmbralMin: 30,
};
const states = [
  ['ACTIVO · cola legítimamente vacía', { ...base, healthySilence: true }],
  ['ACTIVO · detención sostenida', { ...base, healthySilence: false, watchdogAction: 'alert', watchdogDecisionReason: 'stale-declared-cause:human-halt', watchdogCauseKind: 'human-halt', watchdogElegibles: 7, elegiblesEsperando: 7, autoriaDeclarada: 'operador', autoriaDesdeClock: '00:54', avisosEmitidos: 1, avisoUltimoClock: '02:24', avisoProximoClock: '02:54' }],
  ['WATCHDOG OFF', { ...base, healthySilence: false, watchdogEnabled: false, watchdogDegraded: true, watchdogReason: 'apagado', watchdogAction: null, watchdogDecisionReason: null, watchdogElegibles: null, elegiblesEsperando: null }],
  ['WATCHDOG DEGRADADO', { ...base, healthySilence: false, watchdogDegraded: true, watchdogReason: 'sin latido', watchdogAction: null, watchdogDecisionReason: null, watchdogElegibles: null, elegiblesEsperando: null }],
];

async function main() {
  const rows = states.map(([label, state]) => `<section><h2>${label}</h2>${renderDispatchCauseBanner(state)}</section>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}</style><style>body{margin:0;padding:28px;background:var(--surface-0,#0d1117);color:var(--text-primary,#f0f6fc);font-family:Inter,system-ui,sans-serif}main{width:1180px;margin:auto}h1{font-size:24px;margin:0 0 20px}h2{font-size:13px;letter-spacing:.08em;color:var(--text-secondary,#8b949e);margin:18px 0 6px}section{margin-bottom:16px}</style></head><body>${sprite}<main><h1>Render real · dispatch stall watchdog · #5400</h1>${rows}</main></body></html>`;
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(__dirname, 'render-estados-reales.png'), fullPage: true });
    console.log(states.map(([label, state]) => `${label}: ${renderDispatchCauseBanner(state).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n'));

    const mockupPath = path.join(root, '.pipeline/assets/mockups/47-dispatch-stall-watchdog.svg');
    const mockupSvg = fs.readFileSync(mockupPath, 'utf8');
    const realPng = fs.readFileSync(path.join(__dirname, 'render-estados-reales.png')).toString('base64');
    const comparison = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}</style><style>body{margin:0;padding:24px;background:var(--surface-0,#0d1117);color:var(--text-primary,#f0f6fc);font-family:Inter,system-ui,sans-serif}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{background:var(--surface-1,#161b22);border:1px solid var(--border-subtle,#30363d);border-radius:10px;padding:14px}.panel h2{font-size:16px;margin:0 0 10px}.panel img,.panel svg{width:100%;height:auto;display:block}</style></head><body><div class="grid"><div class="panel"><h2>Render real · código de dashboard</h2><img src="data:image/png;base64,${realPng}"></div><div class="panel"><h2>Mockup versionado · 47</h2>${mockupSvg}</div></div></body></html>`;
    await page.setViewport({ width: 2400, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(comparison, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(__dirname, 'comparacion-render-real-vs-mockup.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

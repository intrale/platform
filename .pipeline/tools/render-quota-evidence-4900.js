'use strict';

// =============================================================================
// render-quota-evidence-4900.js — Evidencia visual REAL de la cuota Codex (#4900)
//
// Genera un render de navegador del estado de cuota Codex derivando el CSS y el
// script cliente DIRECTAMENTE de `views/dashboard/home.js` (fuente única), y lo
// captura con Chrome headless.
//
// Por qué existe (rebote QA visual del PO — escape #4531):
//   El harness anterior (`qa/evidence/4900/render-harness.html`) hardcodeaba una
//   copia del CSS SIN la regla `:not(.mz-qm-fresh)` y armaba la celda fresca con
//   `mz-qm-cell mz-qm-event ok` SIN la clase `mz-qm-fresh`. Es decir, reproducía
//   el DEFECTO (barra oculta + chip azul) en vez del fix. Esa copia hardcodeada
//   es exactamente el punto ciego que el PO señaló.
//
//   Este generador NO copia nada: importa `home.homeStyles()` (CSS real),
//   `home.renderClientScript()` (define `_mzHydrateWinCell`/`_mzThresholdClass`
//   reales) y `home._mzWinCell()` (markup real de la celda). El estado fresco se
//   hidrata llamando a la MISMA función `_mzHydrateWinCell` que corre en el
//   dashboard en producción. Cualquier regresión del fix se refleja 1:1 en el
//   PNG capturado — imposible que el harness "mienta".
//
// Uso:
//   node .pipeline/tools/render-quota-evidence-4900.js            # HTML + PNG
//   node .pipeline/tools/render-quota-evidence-4900.js --no-shot  # sólo HTML
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const home = require('../views/dashboard/home');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'qa', 'evidence', '4900');
const HARNESS_HTML = path.join(OUT_DIR, 'render-real-fresh.html');
const HARNESS_PNG = path.join(OUT_DIR, 'render-real-fresh.png');
const MOCKUP_SVG = path.resolve(
    __dirname, '..', 'assets', 'mockups', '4900', 'codex-quota-states.svg');
const COMPARE_HTML = path.join(OUT_DIR, 'compare-render-vs-mockup.html');
const COMPARE_PNG = path.join(OUT_DIR, 'compare-render-vs-mockup.png');

// Escenarios del mockup (codex-quota-states.svg) + límites pedidos por el PO.
// Cada uno se hidrata con la MISMA función real `_mzHydrateWinCell`.
// key/slot dan un cid único `mz-qm-<key>-short`; el resto del shape imita el
// bucket que produce el backend (mode:'event' = proveedor Codex por eventos).
//
// POLARIDAD (#4900): `b.pct` del slice es CONSUMO; la celda pinta DISPONIBLE
// (= 100 - consumo). Por eso los escenarios se alimentan con el consumo que
// produce el disponible del mockup: 28→72, 65→35, 88→12, 0→100, 100→0.
// `avail` documenta el valor esperado en pantalla y lo consume la suite.
const SCENARIOS = [
    { id: 'c72', cap: 'FRESCO · 72% disponible (ok/verde)', expect: 'barra verde + 72% (consumo 28%)', avail: 72, b: { win: '5H', mode: 'event', eventState: 'ok', pct: 28 } },
    { id: 'c35', cap: 'FRESCO · 35% disponible (warn/ámbar)', expect: 'barra ámbar + 35% (consumo 65%)', avail: 35, b: { win: '7D', mode: 'event', eventState: 'ok', pct: 65 } },
    { id: 'c12', cap: 'FRESCO · 12% disponible (bad/rojo)', expect: 'barra roja + 12% (consumo 88%)', avail: 12, b: { win: '5H', mode: 'event', eventState: 'ok', pct: 88 } },
    { id: 'c100', cap: 'LÍMITE · 100% disponible (ok)', expect: 'barra llena verde + 100% (consumo 0%)', avail: 100, b: { win: '5H', mode: 'event', eventState: 'ok', pct: 0 } },
    { id: 'c0', cap: 'LÍMITE · 0% disponible (bad, AGOTADA)', expect: 'track visible + 0% rojo (consumo 100%)', avail: 0, b: { win: '5H', mode: 'event', eventState: 'ok', pct: 100 } },
    { id: 'cnd', cap: 'SIN DATO · nodata', expect: 'sin barra + "sin dato"', avail: null, b: { win: '5H', mode: 'event', eventState: 'nodata' } },
    { id: 'cex', cap: 'TOPE ACTIVO · exhausted', expect: 'sin barra + "tope activo"', avail: null, b: { win: '5H', mode: 'event', eventState: 'exhausted' } },
];

// Construye el HTML del harness usando EXCLUSIVAMENTE código real de home.js.
// Exportada para el test de anti-regresión (garantiza cero drift).
function buildHarnessHtml() {
    const realCss = home.homeStyles();
    const clientScript = home.renderClientScript();
    const cells = SCENARIOS.map((s) => `
      <div class="scn">
        <div class="cap">${s.cap}</div>
        <div class="exp">esperado: ${s.expect}</div>
        <div class="mz-qm-row">${home._mzWinCell(s.id, 'short', s.b.win)}</div>
      </div>`).join('');

    // La hidratación corre EN LA PÁGINA con la función real `_mzHydrateWinCell`
    // (declaración hoisted → disponible aunque algún ticker top-level del script
    // cliente falle bajo file://). Serializamos los escenarios como JSON.
    const scnJson = JSON.stringify(SCENARIOS.map((s) => ({ id: s.id, b: s.b })));

    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>#4900 — Render real cuota Codex (fuente: home.js HEAD)</title>
<style>${realCss}</style>
<style>
/* Estilos SÓLO del harness (no tocan .mz-qm-*). */
:root { color-scheme: dark; }
body { background:#0d1117; color:#e6edf3; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; margin:0; padding:28px 32px; }
h1 { font-size:20px; font-weight:750; margin:0 0 4px; }
.sub { color:#8a93a6; font-size:13px; margin:0 0 22px; }
.grid { display:grid; grid-template-columns:repeat(2,minmax(320px,1fr)); gap:14px; max-width:920px; }
.scn { background:linear-gradient(180deg,#11151e,#141925); border:1px solid #30363d; border-radius:12px; padding:14px 16px; }
.cap { font-size:11px; font-weight:800; letter-spacing:.6px; color:#8a93a6; text-transform:uppercase; }
.exp { font-size:10px; color:#6e7681; margin:2px 0 10px; }
.scn .mz-qm-row { background:transparent; border:0; padding:0; grid-template-columns:1fr; }
.scn .mz-qm-row > * { border-top:0; }
#harness-err { color:#f85149; font-family:Consolas,monospace; font-size:12px; }
</style></head><body>
<h1>#4900 · Estado de cuota Codex — render real del código en HEAD</h1>
<p class="sub">CSS y lógica de hidratación importados de <code>views/dashboard/home.js</code> (sin copias). Cada celda se hidrata con <code>_mzHydrateWinCell</code>, la misma función del dashboard en producción.</p>
<div class="grid">${cells}</div>
<pre id="harness-err"></pre>
<script>${clientScript}</script>
<script>
try {
  var SCN = ${scnJson};
  if (typeof _mzHydrateWinCell !== 'function') throw new Error('_mzHydrateWinCell no definido');
  SCN.forEach(function(s){ _mzHydrateWinCell(s.id, 'short', s.b); });
  document.documentElement.setAttribute('data-hydrated','1');
} catch (e) {
  document.getElementById('harness-err').textContent = 'HARNESS ERROR: ' + (e && e.message);
}
</script>
</body></html>`;
}

function buildCompareHtml(renderPngPath) {
    const svg = fs.readFileSync(MOCKUP_SVG, 'utf8');
    const svgB64 = Buffer.from(svg, 'utf8').toString('base64');
    // Embebemos el render como data URI (no path relativo) para evitar carreras
    // de flush/lectura del archivo cuando Chrome captura el comparativo.
    const renderB64 = fs.readFileSync(renderPngPath).toString('base64');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
body { background:#0d1117; color:#e6edf3; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; margin:0; padding:24px; }
h1 { font-size:18px; margin:0 0 16px; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start; }
.col h2 { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:#8a93a6; margin:0 0 8px; }
img { width:100%; border:1px solid #30363d; border-radius:10px; background:#0d1117; display:block; }
</style></head><body>
<h1>#4900 · Comparación lado a lado — Render real (HEAD) vs Mockup UX</h1>
<div class="cols">
  <div class="col"><h2>Render real (Chrome headless, código en HEAD)</h2><img src="data:image/png;base64,${renderB64}" alt="render real"></div>
  <div class="col"><h2>Mockup UX (codex-quota-states.svg)</h2><img src="data:image/svg+xml;base64,${svgB64}" alt="mockup"></div>
</div>
</body></html>`;
}

function findChrome() {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    return candidates.find((c) => fs.existsSync(c)) || null;
}

// Sleep sincrónico sin dependencias (Chrome headless a veces cierra el proceso
// antes de que el PNG termine de bajar a disco).
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Espera a que el PNG exista y tenga contenido. Devuelve true/false; NO lanza.
function waitForFile(p, timeoutMs) {
    const deadline = timeoutMs / 100;
    for (let i = 0; i <= deadline; i++) {
        try {
            if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
        } catch { /* archivo a medio escribir: reintenta */ }
        sleepSync(100);
    }
    return false;
}

function screenshot(chrome, htmlPath, pngPath, size) {
    execFileSync(chrome, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--virtual-time-budget=1500',
        '--window-size=' + size,
        '--screenshot=' + pngPath,
        htmlPath,
    ], { stdio: 'ignore' });
}

function main() {
    const noShot = process.argv.includes('--no-shot');
    fs.mkdirSync(OUT_DIR, { recursive: true });

    fs.writeFileSync(HARNESS_HTML, buildHarnessHtml(), 'utf8');
    console.log('[4900] harness HTML  -> ' + HARNESS_HTML);

    if (noShot) return;

    const chrome = findChrome();
    if (!chrome) {
        console.error('[4900] Chrome/Edge no encontrado; sólo se generó el HTML.');
        process.exit(2);
    }

    try { fs.rmSync(HARNESS_PNG, { force: true }); } catch { /* no existía */ }
    screenshot(chrome, HARNESS_HTML, HARNESS_PNG, '960,640');
    if (!waitForFile(HARNESS_PNG, 10000)) {
        console.error('[4900] Chrome no produjo el render PNG.');
        process.exit(3);
    }
    console.log('[4900] render PNG     -> ' + HARNESS_PNG);

    fs.writeFileSync(COMPARE_HTML, buildCompareHtml(HARNESS_PNG), 'utf8');
    try { fs.rmSync(COMPARE_PNG, { force: true }); } catch { /* no existía */ }
    screenshot(chrome, COMPARE_HTML, COMPARE_PNG, '1300,860');
    if (!waitForFile(COMPARE_PNG, 10000)) {
        console.error('[4900] Chrome no produjo el PNG comparativo.');
        process.exit(4);
    }
    console.log('[4900] compare PNG    -> ' + COMPARE_PNG);
}

if (require.main === module) main();

module.exports = { buildHarnessHtml, buildCompareHtml, SCENARIOS };

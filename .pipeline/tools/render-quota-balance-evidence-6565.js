// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// render-quota-balance-evidence-6565.js — Evidencia visual REAL del panel de
// saldo y ritmo de cuota por proveedor (#6565).
//
// Genera un render de navegador del panel "🔌 CUOTA POR PROVEEDOR" derivando el
// CSS, el markup SSR y el script cliente DIRECTAMENTE de
// `views/dashboard/home.js` (fuente única, misma disciplina que #4900), lo
// hidrata con la MISMA función `_mzHydrateBalanceRow` / `renderQuotaBalanceMatrix`
// que corre en el dashboard, y lo captura con Chrome/Edge headless.
//
// Por qué fixtures: con el ledger recién creado los 3 proveedores salen
// `sin_datos` durante la primera hora (guru §4.2). Los otros 5 estados del enum
// ESTADOS sólo se ven forzando el payload del slice. Cada fixture respeta el
// shape de `balanceForProvider()` (quota-balance.js) — la vista no recalcula
// nada, así que un payload sintético rinde exactamente igual que uno real.
//
// Bloques del render (espejo del mockup `assets/mockups/6565/panel-esperado-cuota.html`):
//   ① panel completo con los 3 proveedores reales (se_agota_antes · sin_proyeccion · excedido)
//   ② catálogo de los 6 estados (una fila por estado, mismas celdas)
//   ③ fail-closed: slice con ok:false (UX-7)
//   ④ panel con las lecturas MÁS LARGAS observadas en el home vivo (saldo proyectado
//      de 3 y 4 dígitos: "−152 %", "−1.841 %") — el escenario del rebote QA rev-2.
//
// Ancho real (rebote QA rev-2): el harness rinde el panel al MISMO ancho que el
// home vivo — el `.kiosk-frame` mide 1080 px fijos y `.kiosk-body` tiene 22 px de
// padding lateral, así que el panel ocupa 1036 px y la matriz ≈ 743 px, sin
// importar el viewport (1440/1600/1920 dan lo mismo). Antes el body medía 1384 px
// (matriz ≈ 993 px) y el recorte de la línea 2 no se veía. El ancho se DERIVA del
// CSS real (`harnessBodyWidth()`), no se hardcodea.
//
// Clip guard: la página mide, tras hidratar, cada pieza de la matriz (chip,
// lectura, celdas) contra su caja y contra el borde de `.mz-sysquota`
// (overflow:hidden) y publica el resultado en `<pre id="harness-clip">`. Con
// puppeteer disponible el tool lo lee, lo persiste en `clip-guard.json` y sale
// con código 5 si algo quedó recortado (UX-11: "nada recortado · no se oculta").
//
// Uso:
//   node .pipeline/tools/render-quota-balance-evidence-6565.js            # HTML + PNG + clip guard
//   node .pipeline/tools/render-quota-balance-evidence-6565.js --no-shot  # sólo HTML
//   (puppeteer global: NODE_PATH=$(npm root -g) node .pipeline/tools/render-quota-balance-evidence-6565.js)
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const home = require('../views/dashboard/home');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'qa', 'evidence', '6565');
const HARNESS_HTML = path.join(OUT_DIR, 'render-real-quota-balance.html');
const HARNESS_PNG = path.join(OUT_DIR, 'render-real-quota-balance.png');
const MOCKUP_PNG = path.resolve(__dirname, '..', 'assets', 'mockups', '6565', 'panel-esperado-cuota.png');
const COMPARE_HTML = path.join(OUT_DIR, 'compare-render-vs-mockup.html');
const COMPARE_PNG = path.join(OUT_DIR, 'compare-render-vs-mockup.png');
const CLIP_JSON = path.join(OUT_DIR, 'clip-guard.json');
const EXIT_CLIPPED = 5;

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-21T15:26:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Fixture con el shape EXACTO de balanceForProvider() (quota-balance.js).
function fx(over) {
    return Object.assign({
        provider: 'x', plan: 'Max', periodo: 'semanal', unidad: 'porcentaje', techo: 100,
        reposicion: 'dom 21:00', rolling: false,
        periodo_inicio_at: iso(NOW - 20 * HOUR), cierre_periodo_at: iso(NOW + 149 * HOUR),
        cierre_en_ms: 149 * HOUR, cierre_fuente: 'config',
        consumo: 0, consumo_pct: 0, saldo_pts: 100, excedente_pts: 0, balance_pts: 100,
        ritmo_pts_por_hora: null, agota_at: null, agota_en_ms: null, al_cierre_pts: null,
        estado: 'sin_datos', confidence: 'missing', muestra_at: null, muestras: 0,
        ventana_movil_min: 60, min_muestras: 3, ultimo_reset: null, fuente: null,
    }, over);
}

// Los 6 estados del enum ESTADOS (UX §4 — un estado = un render).
const STATE_FIXTURES = {
    alcanza: fx({ consumo: 41, consumo_pct: 41, saldo_pts: 59, balance_pts: 59, ritmo_pts_por_hora: 0.38,
        agota_at: iso(NOW + 155 * HOUR), agota_en_ms: 155 * HOUR, cierre_en_ms: 57 * HOUR, cierre_periodo_at: iso(NOW + 57 * HOUR),
        al_cierre_pts: 37, estado: 'alcanza', confidence: 'fresh', muestra_at: iso(NOW - 2 * 60000), muestras: 4 }),
    se_agota_antes: fx({ consumo: 23, consumo_pct: 23, saldo_pts: 77, balance_pts: 77, ritmo_pts_por_hora: 0.62,
        agota_at: iso(NOW + 124 * HOUR), agota_en_ms: 124 * HOUR, cierre_en_ms: 149 * HOUR,
        al_cierre_pts: -16, estado: 'se_agota_antes', confidence: 'fresh', muestra_at: iso(NOW - 2 * 60000), muestras: 4 }),
    excedido: fx({ periodo: 'diario', reposicion: 'rolling', rolling: true, consumo: 112, consumo_pct: 112, saldo_pts: 0,
        excedente_pts: 12, balance_pts: -12, ritmo_pts_por_hora: 1.8, agota_at: null, agota_en_ms: null,
        cierre_en_ms: 3 * HOUR + 20 * 60000, cierre_periodo_at: iso(NOW + 3 * HOUR + 20 * 60000), al_cierre_pts: -18,
        estado: 'excedido', confidence: 'fresh', muestra_at: iso(NOW - 3 * 60000), muestras: 5 }),
    sin_datos: fx({ periodo: 'diario', cierre_en_ms: 18 * HOUR, cierre_periodo_at: iso(NOW + 18 * HOUR) }),
    desactualizado: fx({ consumo: 56, consumo_pct: 56, saldo_pts: 44, balance_pts: 44, estado: 'desactualizado',
        confidence: 'stale', muestra_at: iso(NOW - 47 * 60000), muestras: 2, cierre_en_ms: 74 * HOUR, cierre_periodo_at: iso(NOW + 74 * HOUR) }),
    sin_proyeccion: fx({ consumo: 0, saldo_pts: 100, estado: 'sin_proyeccion', confidence: 'fresh',
        muestra_at: iso(NOW - 2 * 60000), muestras: 1, cierre_en_ms: 7 * 24 * HOUR, cierre_periodo_at: iso(NOW + 7 * 24 * HOUR),
        ultimo_reset: { at: iso(NOW - 12 * 60000), motivo: 'reposicion' } }),
};

// ① Panel real: los 3 proveedores de MZ_PROVIDER_META con los escenarios del mockup.
const PANEL_BALANCE = {
    ok: true, motivo: null, computed_at: iso(NOW), horas: 24,
    balance: {
        schema: 1, computed_at: iso(NOW), ventana_movil_min: 60, min_muestras: 3,
        providers: {
            'anthropic': Object.assign({}, STATE_FIXTURES.se_agota_antes, { provider: 'anthropic' }),
            'openai-codex': Object.assign({}, STATE_FIXTURES.sin_proyeccion, { provider: 'openai-codex', plan: 'Pro', reposicion: 'rolling', rolling: true }),
            'antigravity': Object.assign({}, STATE_FIXTURES.excedido, { provider: 'antigravity', plan: 'Licencia' }),
        },
    },
    series: null,
};
// Ventana corta (fuente /api/dash/quota, intacta): mismos valores que el mockup.
const PANEL_SHORT = {
    'anthropic': { win: '5H', mode: 'gauge', pct: 83, available: 17, resetAt: iso(NOW + 21 * 60000) },
    'openai-codex': { win: 'ROLL', mode: 'event', eventState: 'nodata' },
    'antigravity': { win: 'MIN', mode: 'gauge', pct: null, available: null },
};
// ④ Lecturas largas del home vivo (rebote QA rev-2): con estado se_agota_antes y
// saldo proyectado de 3 dígitos (−152 % = 1,5 %/h sostenidos sobre techo 100)
// la línea 2 superaba los ≈ 400 px de su celda y .mz-sysquota{overflow:hidden}
// dejaba "cierra en 5d 1" en vez de "cierra en 5d 13h". El 2.º proveedor lleva
// el peor caso medido por QA (−1.841 %, ritmo 14,32 %/h).
const LONG_CLOSE_MS = (5 * 24 + 13) * HOUR + 30 * 60000;
const PANEL_REALISTA = {
    ok: true, motivo: null, computed_at: iso(NOW), horas: 24,
    balance: {
        schema: 1, computed_at: iso(NOW), ventana_movil_min: 60, min_muestras: 3,
        providers: {
            'anthropic': fx({ provider: 'anthropic', consumo: 28, consumo_pct: 28, saldo_pts: 72, balance_pts: 72, ritmo_pts_por_hora: 1.5,
                agota_at: iso(NOW + 48 * HOUR), agota_en_ms: 48 * HOUR,
                cierre_en_ms: LONG_CLOSE_MS, cierre_periodo_at: iso(NOW + LONG_CLOSE_MS),
                al_cierre_pts: -152, estado: 'se_agota_antes', confidence: 'fresh', muestra_at: iso(NOW - 2 * 60000), muestras: 5 }),
            'openai-codex': fx({ provider: 'openai-codex', plan: 'Pro', consumo: 28, consumo_pct: 28, saldo_pts: 72, balance_pts: 72, ritmo_pts_por_hora: 14.32,
                agota_at: iso(NOW + 5 * HOUR + 60000), agota_en_ms: 5 * HOUR + 60000,
                cierre_en_ms: LONG_CLOSE_MS, cierre_periodo_at: iso(NOW + LONG_CLOSE_MS),
                al_cierre_pts: -1841, estado: 'se_agota_antes', confidence: 'fresh', muestra_at: iso(NOW - 2 * 60000), muestras: 5 }),
            'antigravity': Object.assign({}, STATE_FIXTURES.excedido, { provider: 'antigravity', plan: 'Licencia' }),
        },
    },
    series: null,
};
const FAIL_CLOSED = { ok: false, motivo: 'config inválida: QuotaCeilingError', computed_at: iso(NOW), horas: 24, balance: { providers: {} }, series: null };

const CATALOG_RULES = {
    alcanza: 'proyección ≥ cierre del período (o ritmo 0) → verde; la marca de cierre cae dentro del saldo',
    se_agota_antes: 'proyección < cierre → ámbar; la marca supera el techo; chip con cuánto antes y el faltante',
    excedido: 'consumo > techo → rojo; barra llena + tramo rayado del excedente; saldo 0 y excedente explícito',
    sin_datos: 'sin muestras del período → saldo completo en gris (no verde); nunca error',
    desactualizado: 'última muestra stale (> 30 min) → ámbar con antigüedad; sin ritmo ni proyección',
    sin_proyeccion: 'muestra fresca pero < 3 muestras → saldo con su color normal; ritmo "en cálculo"',
};

// Ancho útil del home vivo, derivado del CSS real: `.kiosk-frame{width}` menos el
// padding lateral de `.kiosk-body`. Si el CSS cambia de forma y no se puede
// leer, cae a 1036 px (1080 − 2×22), el valor vigente al cerrar #6565.
const HARNESS_BODY_WIDTH_FALLBACK = 1036;
function harnessBodyWidth(css) {
    const src = typeof css === 'string' ? css : home.homeStyles();
    const frame = /\.kiosk-frame\s*\{[^}]*?width:\s*(\d+(?:\.\d+)?)px/.exec(src);
    const body = /\.kiosk-body\s*\{[^}]*?padding:\s*[\d.]+px\s+(\d+(?:\.\d+)?)px/.exec(src);
    if (!frame || !body) return HARNESS_BODY_WIDTH_FALLBACK;
    const w = Math.round(Number(frame[1]) - 2 * Number(body[1]));
    return Number.isFinite(w) && w > 0 ? w : HARNESS_BODY_WIDTH_FALLBACK;
}

// Script que corre DENTRO de la página tras hidratar: mide cada pieza de la
// matriz contra su propia caja (scrollWidth > clientWidth) y contra el borde
// derecho del panel (.mz-sysquota, overflow:hidden). Publica JSON en
// #harness-clip y data-clipped en <html>. Sin dependencias del harness.
const CLIP_GUARD_SCRIPT = String.raw`
  (function(){
    var SEL = '.mz-qv,.mz-ql2,.mz-ql2-rd,.mz-qm-h-note,.mz-qm-prov,.mz-qm-cell,.mz-qb,.mz-qr';
    var out = { body_width: document.body.clientWidth, panels: [], clipped: [] };
    document.querySelectorAll('.mz-sysquota').forEach(function(panel){
      var pr = panel.getBoundingClientRect();
      var mx = panel.querySelector('.mz-sq-matrix');
      var wrap = (panel.parentElement && panel.parentElement.id) || '';
      out.panels.push({ wrap: wrap, panel_w: Math.round(pr.width), matrix_w: mx ? mx.clientWidth : null });
      panel.querySelectorAll(SEL).forEach(function(el){
        var r = el.getBoundingClientRect();
        var overSelf = Math.max(0, el.scrollWidth - el.clientWidth);
        var overPanel = Math.max(0, Math.round(r.right - pr.right));
        if (overSelf > 1 || overPanel > 0) {
          out.clipped.push({ wrap: wrap, id: el.id || null, cls: String(el.className), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
            scroll_w: el.scrollWidth, client_w: el.clientWidth, over_self_px: overSelf, over_panel_px: overPanel });
        }
      });
    });
    var pre = document.getElementById('harness-clip');
    if (pre) pre.textContent = JSON.stringify(out);
    document.documentElement.setAttribute('data-clipped', String(out.clipped.length));
  })();`;

// Construye el HTML del harness usando EXCLUSIVAMENTE código real de home.js.
// Exportada para el test de anti-regresión (cero drift).
function buildHarnessHtml() {
    const realCss = home.homeStyles();
    const bodyWidth = harnessBodyWidth(realCss);
    const clientScript = home.renderClientScript();
    const panel = home.renderSystemQuotaPanel({ semaforo: { level: 'warn', label: 'DEGRADADO' } });
    const catalog = Object.keys(STATE_FIXTURES).map((estado) => `
      <div class="scn">
        <div class="cap"><code>${estado}</code></div>
        <div class="exp">${CATALOG_RULES[estado]}</div>
        <div class="mz-qm-row cat-row">${home._mzBalanceCells('cat-' + estado, home.MZ_PROVIDER_WINDOWS.anthropic.long)}</div>
      </div>`).join('');
    const failPanel = home.renderSystemQuotaPanel({ semaforo: { level: 'ok', label: 'SALUDABLE' } })
        .replace(/id="([a-z0-9-]+)"/g, (m, id) => 'id="fc-' + id + '"');
    const longPanel = home.renderSystemQuotaPanel({ semaforo: { level: 'warn', label: 'DEGRADADO' } })
        .replace(/id="([a-z0-9-]+)"/g, (m, id) => 'id="lg-' + id + '"');
    const fixtures = JSON.stringify({ panel: PANEL_BALANCE, short: PANEL_SHORT, catalog: STATE_FIXTURES, fail: FAIL_CLOSED, long: PANEL_REALISTA, now: NOW });

    return `<!doctype html><html lang="es" data-theme="dark"><head><meta charset="utf-8">
<title>#6565 — Render real panel de saldo y ritmo (fuente: home.js HEAD)</title>
<style>${realCss}</style>
<style>
/* Estilos SÓLO del harness (no tocan .mz-*). */
:root { color-scheme: dark; }
/* Ancho = contenido útil del home vivo (kiosk-frame 1080 px − 2×22 px de padding), derivado del CSS real. */
body { background:#0d1117; color:#e6edf3; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; margin:0; padding:24px 28px; width:${bodyWidth}px; }
h1 { font-size:16px; font-weight:750; margin:0 0 4px; }
h2 { font-size:11px; font-weight:800; letter-spacing:.8px; color:#8b949e; text-transform:uppercase; margin:26px 0 8px; }
.sub { color:#6e7681; font-size:10.5px; margin:0 0 12px; line-height:1.45; }
.grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
.scn { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:10px 14px; }
.cap { font-size:10.5px; font-weight:700; color:#e6edf3; }
.cap code { font-family:ui-monospace,Consolas,monospace; background:rgba(255,255,255,.06); padding:1px 6px; border-radius:4px; }
.exp { font-size:9.5px; color:#8b949e; margin:2px 0 6px; line-height:1.4; }
.scn .cat-row { grid-template-columns:1.35fr 1.2fr; border-top:0; padding:0; }
.scn .cat-row .mz-qb { grid-column:1; } .scn .cat-row .mz-qr { grid-column:2; } .scn .cat-row .mz-ql2 { grid-column:1 / span 2; }
#harness-err { color:#f85149; font-family:Consolas,monospace; font-size:12px; white-space:pre-wrap; }
#harness-clip { display:none; }
</style></head><body>
<h1>#6565 · Panel de saldo y ritmo de cuota por proveedor — render real del código en HEAD</h1>
<p class="sub">CSS, markup SSR y lógica de hidratación importados de <code>views/dashboard/home.js</code> (sin copias). Las celdas del período se hidratan con <code>renderQuotaBalanceMatrix</code> / <code>_mzHydrateBalanceRow</code>, las mismas funciones del dashboard en producción, con fixtures que respetan el shape de <code>balanceForProvider()</code>.</p>
<h2>① Panel completo — 3 proveedores (se_agota_antes · sin_proyeccion · excedido)</h2>
<div id="panel-real">${panel}</div>
<h2>② Catálogo de los 6 estados (un estado = un render)</h2>
<div class="grid">${catalog}</div>
<h2>③ Fail-closed — slice con ok:false (UX-7)</h2>
<div id="panel-fail">${failPanel}</div>
<h2>④ Ancho real (matriz ≈ 743 px) — lecturas largas del home vivo: −152 % · −1.841 % (rebote QA rev-2)</h2>
<p class="sub">La línea 2 (chip de veredicto + "techo · consumido · ↻ cierra en") envuelve cuando no entra en su celda: nada queda recortado por <code>.mz-sysquota{overflow:hidden}</code> (UX-11).</p>
<div id="panel-long">${longPanel}</div>
<pre id="harness-err"></pre>
<pre id="harness-clip"></pre>
<script>${clientScript}</script>
<script>
try {
  var FX = ${fixtures};
  if (typeof renderQuotaBalanceMatrix !== 'function') throw new Error('renderQuotaBalanceMatrix no definido');
  if (typeof _mzHydrateBalanceRow !== 'function') throw new Error('_mzHydrateBalanceRow no definido');
  if (typeof _mzHydrateWinCell !== 'function') throw new Error('_mzHydrateWinCell no definido');
  // ① panel real: ventana corta (quota) + período (quota-balance), ambas fuentes reales.
  Object.keys(FX.short).forEach(function(k){ _mzHydrateWinCell(k, 'short', FX.short[k]); });
  renderQuotaBalanceMatrix(FX.panel, FX.now, FX.now);
  // ② catálogo: una fila por estado, hidratada por la misma función.
  Object.keys(FX.catalog).forEach(function(estado){ _mzHydrateBalanceRow('cat-' + estado, FX.catalog[estado], 0, FX.now); });
  // ③ fail-closed: se hidrata el segundo panel (ids con prefijo fc-) redirigiendo getElementById.
  var realGet = document.getElementById.bind(document);
  document.getElementById = function(id){ return realGet('fc-' + id) || null; };
  try { renderQuotaBalanceMatrix(FX.fail, FX.now, FX.now); } finally { document.getElementById = realGet; }
  // ④ lecturas largas: tercer panel (ids con prefijo lg-), misma función real.
  document.getElementById = function(id){ return realGet('lg-' + id) || null; };
  try {
    Object.keys(FX.short).forEach(function(k){ _mzHydrateWinCell(k, 'short', FX.short[k]); });
    renderQuotaBalanceMatrix(FX.long, FX.now, FX.now);
  } finally { document.getElementById = realGet; }
  document.documentElement.setAttribute('data-hydrated','1');
  ${CLIP_GUARD_SCRIPT}
} catch (e) {
  document.getElementById('harness-err').textContent = 'HARNESS ERROR: ' + (e && (e.stack || e.message));
}
</script>
</body></html>`;
}

function buildCompareHtml(renderPngPath) {
    const renderB64 = fs.readFileSync(renderPngPath).toString('base64');
    const mockB64 = fs.readFileSync(MOCKUP_PNG).toString('base64');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
body { background:#0d1117; color:#e6edf3; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; margin:0; padding:24px; }
h1 { font-size:18px; margin:0 0 16px; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start; }
.col h2 { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:#8b949e; margin:0 0 8px; }
img { width:100%; border:1px solid #30363d; border-radius:10px; background:#0d1117; display:block; }
</style></head><body>
<h1>#6565 · Comparación lado a lado — Render real (HEAD) vs Mockup UX</h1>
<div class="cols">
  <div class="col"><h2>Render real (Chrome headless, código en HEAD)</h2><img src="data:image/png;base64,${renderB64}" alt="render real"></div>
  <div class="col"><h2>Mockup UX (panel-esperado-cuota.png)</h2><img src="data:image/png;base64,${mockB64}" alt="mockup"></div>
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

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
        '--force-color-profile=srgb', '--force-device-scale-factor=2',
        '--virtual-time-budget=2500',
        '--window-size=' + size,
        '--screenshot=' + pngPath,
        htmlPath,
    ], { stdio: 'ignore' });
}

// puppeteer no es dependencia del pipeline: se busca local y luego en el root
// global de npm (misma convención que assets/mockups/6565/render-mockup.js).
function tryRequirePuppeteer() {
    try { return require('puppeteer'); } catch { /* no local */ }
    try {
        const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
        return require(path.join(root, 'puppeteer'));
    } catch { return null; }
}

// Lee #harness-clip del harness ya escrito. Devuelve el JSON o null si no hay
// puppeteer (el caller lo reporta como "clip guard no ejecutado", no como OK).
async function measureClipping(chrome, htmlPath, viewportWidth) {
    const puppeteer = tryRequirePuppeteer();
    if (!puppeteer) return null;
    const browser = await puppeteer.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: viewportWidth, height: 1500 });
        await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load' });
        await page.waitForSelector('html[data-clipped]', { timeout: 10000 });
        const raw = await page.$eval('#harness-clip', (el) => el.textContent);
        return JSON.parse(raw);
    } finally {
        await browser.close();
    }
}

async function main() {
    const noShot = process.argv.includes('--no-shot');
    fs.mkdirSync(OUT_DIR, { recursive: true });

    fs.writeFileSync(HARNESS_HTML, buildHarnessHtml(), 'utf8');
    console.log('[6565] harness HTML  -> ' + HARNESS_HTML);
    if (noShot) return;

    const chrome = findChrome();
    if (!chrome) {
        console.error('[6565] Chrome/Edge no encontrado; sólo se generó el HTML.');
        process.exit(2);
    }
    try { fs.rmSync(HARNESS_PNG, { force: true }); } catch { /* no existía */ }
    screenshot(chrome, HARNESS_HTML, HARNESS_PNG, '1440,1500');
    if (!waitForFile(HARNESS_PNG, 15000)) {
        console.error('[6565] Chrome no produjo el render PNG.');
        process.exit(3);
    }
    console.log('[6565] render PNG     -> ' + HARNESS_PNG);

    if (fs.existsSync(MOCKUP_PNG)) {
        fs.writeFileSync(COMPARE_HTML, buildCompareHtml(HARNESS_PNG), 'utf8');
        try { fs.rmSync(COMPARE_PNG, { force: true }); } catch { /* no existía */ }
        screenshot(chrome, COMPARE_HTML, COMPARE_PNG, '2200,1700');
        if (!waitForFile(COMPARE_PNG, 15000)) {
            console.error('[6565] Chrome no produjo el PNG comparativo.');
            process.exit(4);
        }
        console.log('[6565] compare PNG    -> ' + COMPARE_PNG);
    }

    // Clip guard (rebote QA rev-2): el PNG solo no alcanza — hay que MEDIR.
    let clip = null;
    try {
        clip = await measureClipping(chrome, HARNESS_HTML, 1440);
    } catch (e) {
        console.error('[6565] clip guard falló: ' + ((e && e.message) || e));
    }
    if (!clip) {
        console.error('[6565] clip guard NO ejecutado (puppeteer no disponible: NODE_PATH=$(npm root -g)). El render no certifica UX-11.');
        return;
    }
    fs.writeFileSync(CLIP_JSON, JSON.stringify(clip, null, 2), 'utf8');
    console.log('[6565] clip guard     -> ' + CLIP_JSON + ' · body ' + clip.body_width + ' px · matriz ' + (clip.panels[0] && clip.panels[0].matrix_w) + ' px · recortados: ' + clip.clipped.length);
    if (clip.clipped.length) {
        for (const c of clip.clipped) console.error('[6565]   RECORTADO ' + (c.wrap || '?') + ' ' + (c.id || c.cls) + ' +' + c.over_self_px + 'px/celda +' + c.over_panel_px + 'px/panel · "' + c.text + '"');
        process.exit(EXIT_CLIPPED);
    }
}

if (require.main === module) main().catch((e) => { console.error('[6565] ' + ((e && e.stack) || e)); process.exit(1); });

module.exports = { buildHarnessHtml, buildCompareHtml, harnessBodyWidth, measureClipping, CLIP_GUARD_SCRIPT, STATE_FIXTURES, PANEL_BALANCE, PANEL_REALISTA, PANEL_SHORT, FAIL_CLOSED, NOW, EXIT_CLIPPED };

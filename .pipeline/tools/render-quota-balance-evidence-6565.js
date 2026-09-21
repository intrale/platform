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
//
// Uso:
//   node .pipeline/tools/render-quota-balance-evidence-6565.js            # HTML + PNG
//   node .pipeline/tools/render-quota-balance-evidence-6565.js --no-shot  # sólo HTML
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
const FAIL_CLOSED = { ok: false, motivo: 'config inválida: QuotaCeilingError', computed_at: iso(NOW), horas: 24, balance: { providers: {} }, series: null };

const CATALOG_RULES = {
    alcanza: 'proyección ≥ cierre del período (o ritmo 0) → verde; la marca de cierre cae dentro del saldo',
    se_agota_antes: 'proyección < cierre → ámbar; la marca supera el techo; chip con cuánto antes y el faltante',
    excedido: 'consumo > techo → rojo; barra llena + tramo rayado del excedente; saldo 0 y excedente explícito',
    sin_datos: 'sin muestras del período → saldo completo en gris (no verde); nunca error',
    desactualizado: 'última muestra stale (> 30 min) → ámbar con antigüedad; sin ritmo ni proyección',
    sin_proyeccion: 'muestra fresca pero < 3 muestras → saldo con su color normal; ritmo "en cálculo"',
};

// Construye el HTML del harness usando EXCLUSIVAMENTE código real de home.js.
// Exportada para el test de anti-regresión (cero drift).
function buildHarnessHtml() {
    const realCss = home.homeStyles();
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
    const fixtures = JSON.stringify({ panel: PANEL_BALANCE, short: PANEL_SHORT, catalog: STATE_FIXTURES, fail: FAIL_CLOSED, now: NOW });

    return `<!doctype html><html lang="es" data-theme="dark"><head><meta charset="utf-8">
<title>#6565 — Render real panel de saldo y ritmo (fuente: home.js HEAD)</title>
<style>${realCss}</style>
<style>
/* Estilos SÓLO del harness (no tocan .mz-*). */
:root { color-scheme: dark; }
body { background:#0d1117; color:#e6edf3; font-family:-apple-system,'Segoe UI',system-ui,sans-serif; margin:0; padding:24px 28px; width:1384px; }
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
</style></head><body>
<h1>#6565 · Panel de saldo y ritmo de cuota por proveedor — render real del código en HEAD</h1>
<p class="sub">CSS, markup SSR y lógica de hidratación importados de <code>views/dashboard/home.js</code> (sin copias). Las celdas del período se hidratan con <code>renderQuotaBalanceMatrix</code> / <code>_mzHydrateBalanceRow</code>, las mismas funciones del dashboard en producción, con fixtures que respetan el shape de <code>balanceForProvider()</code>.</p>
<h2>① Panel completo — 3 proveedores (se_agota_antes · sin_proyeccion · excedido)</h2>
<div id="panel-real">${panel}</div>
<h2>② Catálogo de los 6 estados (un estado = un render)</h2>
<div class="grid">${catalog}</div>
<h2>③ Fail-closed — slice con ok:false (UX-7)</h2>
<div id="panel-fail">${failPanel}</div>
<pre id="harness-err"></pre>
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
  document.documentElement.setAttribute('data-hydrated','1');
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

function main() {
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
}

if (require.main === module) main();

module.exports = { buildHarnessHtml, buildCompareHtml, STATE_FIXTURES, PANEL_BALANCE, PANEL_SHORT, FAIL_CLOSED, NOW };

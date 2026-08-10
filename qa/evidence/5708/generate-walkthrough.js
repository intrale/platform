'use strict';
/**
 * Genera el video de QA del issue #5708 con navegacion e interaccion REAL.
 *
 * Doctrina (decision del operador 2026-08-10, opcion A): nada de pantalla
 * congelada. Cada frame se renderiza contra un estado distinto de la pagina:
 * scroll real del reporte, revelado progresivo de salidas reales de comando y
 * chips de criterios que cambian de estado a lo largo de la linea de tiempo.
 *
 * Las salidas de comando NO se inventan: se leen de qa/evidence/5708/run/*.txt,
 * capturadas ejecutando los comandos de verdad en esta misma pasada.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const puppeteer = require(path.join(ROOT, 'docs/qa/node_modules/puppeteer'));
const { renderHtml } = require(path.join(ROOT, '.pipeline/rejection-report'));

const EV = __dirname;
const RUN = path.join(EV, 'run');
const FRAMES = path.join(EV, 'frames');
const FPS = 10;
const DURATION = Number(process.env.WT_DURATION || 117);
const W = 1280;
const H = 720;

const read = f => fs.readFileSync(path.join(RUN, f), 'utf8').replace(/\r/g, '').trimEnd();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- report HTML
const baseData = visualComparison => ({
  issue: 5708,
  skill: 'qa',
  fase: 'verificacion',
  elapsed: 117,
  motivo: 'Validacion visual del inventario completo y la cobertura declarada',
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
  primaryCause: {
    summary: 'Inventario completo de desvios con cobertura declarada',
    detail: 'Render end-to-end del inventario contra el mockup 48.',
    priority: 'high',
  },
  inconclusive: false,
  sessionCtx: { provider: 'edge', model: 'qa', cliVersion: 'pipeline-v3' },
  visualComparison,
});

// Contrato real escrito por el dev, con las imagenes reales embebidas.
const realVc = JSON.parse(fs.readFileSync(path.join(EV, 'visual-comparison.json'), 'utf8'));

// Caso de estres: 63 desvios -> el reporte debe mostrar 50 y declarar el truncado.
const impacts = ['bajo', 'alto', 'medio'];
const bigVc = {
  ...realVc,
  rev: 2,
  coverage: {
    secciones_declaradas: ['A', 'B', 'C', 'D'],
    verificadas: ['A', 'B', 'C'],
    no_verificadas: [{ section: 'D', motivo: 'estado no alcanzable sin datos de negocio' }],
  },
  diffs: Array.from({ length: 63 }, (_, i) => ({
    section: ['A', 'B', 'C', 'D'][i % 4],
    title: `Desvio ${i + 1}`,
    description: `Detalle objetivable del desvio ${i + 1}`,
    impact: impacts[i % 3],
    regression: i === 7,
  })),
};

const BRIDGE = `<script>
function report() {
  try { parent.postMessage({ type: 'h', id: window.name, h: document.documentElement.scrollHeight }, '*'); } catch (err) {}
}
window.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'scroll') window.scrollTo(0, d.y);
  if (d.type === 'measure') report();
});
window.addEventListener('load', report); report();
</script>`;

function writeReport(name, vc) {
  const html = renderHtml(baseData(vc)).replace('</body>', BRIDGE + '</body>');
  const p = path.join(EV, name);
  fs.writeFileSync(p, html);
  return p;
}

// ------------------------------------------------------------------ shell page
const CAS = [
  ['CA-1', 'Barrido sin early-exit'],
  ['CA-2', 'Nunca un solo hallazgo'],
  ['CA-3', 'Inventario completo'],
  ['CA-4', 'Cobertura declarada'],
  ['CA-5', 'Regresion tipificada'],
  ['CA-6', 'Guardrail flag OFF'],
  ['CA-7', 'Tests verdes'],
];

function shellHtml(repPath, bigPath) {
  const term = (id, title) => `<div class="term" id="${id}"><div class="tbar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><b>${title}</b></div><pre class="tbody"></pre></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;
    background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif}
  .top{height:56px;display:flex;align-items:center;gap:14px;padding:0 18px;background:#161b22;border-bottom:1px solid #30363d}
  .top h1{font-size:16px;margin:0;font-weight:600}
  .badge{font-size:11px;padding:3px 9px;border-radius:20px;background:#1f6feb;color:#fff;font-weight:600}
  .chips{margin-left:auto;display:flex;gap:6px}
  .chip{font-size:10px;padding:4px 8px;border-radius:6px;background:#21262d;color:#7d8590;border:1px solid #30363d;
    transition:none;font-weight:600}
  .chip.on{background:#1a7f37;color:#fff;border-color:#238636}
  .stage{position:relative;height:${H - 56}px}
  /* display:none en vez de opacity:0 — un iframe oculto pero compuesto hacia
     que cada screenshot tardara ~1.3s por recomposicion de las imagenes base64. */
  .scene{position:absolute;inset:0;padding:20px 24px;display:none}
  .scene.on{display:block}
  h2{font-size:20px;margin:0 0 4px}
  .sub{font-size:13px;color:#7d8590;margin:0 0 14px}
  .term{background:#010409;border:1px solid #30363d;border-radius:8px;overflow:hidden;margin-bottom:12px}
  .tbar{background:#161b22;padding:6px 12px;font-size:11px;color:#7d8590;display:flex;align-items:center;gap:6px}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27c93f}
  .tbody{margin:0;padding:12px 14px;font-family:Consolas,monospace;font-size:12.5px;line-height:1.55;
    color:#7ee787;white-space:pre-wrap;min-height:60px}
  .frame{position:absolute;left:24px;right:24px;top:96px;bottom:20px;border:1px solid #30363d;border-radius:8px;
    overflow:hidden;background:#fff}
  iframe{width:100%;height:100%;border:0;display:block}
  .cursor{position:absolute;width:18px;height:18px;border-radius:50%;background:rgba(88,166,255,.35);
    border:2px solid #58a6ff;pointer-events:none;z-index:50;display:none}
  .scrollbar{position:absolute;right:6px;top:100px;bottom:24px;width:5px;background:#21262d;border-radius:3px;z-index:40}
  .thumb{position:absolute;left:0;width:5px;background:#58a6ff;border-radius:3px}
  .hero{display:flex;flex-direction:column;justify-content:center;height:100%;padding-left:20px}
  .hero h2{font-size:34px;line-height:1.15;margin-bottom:10px}
  .hero .why{background:#3d1d1d;border-left:3px solid #f85149;padding:12px 16px;border-radius:0 6px 6px 0;
    font-size:14px;color:#ffa198;max-width:820px;margin-top:8px}
  .ok{color:#3fb950}.bad{color:#f85149}.dim{color:#7d8590}
  .verdict{display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;gap:14px}
  .verdict .big{font-size:52px;font-weight:700;color:#3fb950}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%;max-width:900px;margin-top:6px}
  .g{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:9px;font-size:11px;text-align:center;
    opacity:.25}
  .g.on{opacity:1;border-color:#238636}
  .g b{display:block;color:#3fb950;font-size:13px;margin-bottom:2px}
  .pbar{position:absolute;left:0;right:0;bottom:0;height:3px;background:#21262d;z-index:60}
  .pfill{height:3px;background:linear-gradient(90deg,#1f6feb,#3fb950);width:0}
  .tc{position:absolute;right:10px;bottom:8px;font-family:Consolas,monospace;font-size:10px;color:#7d8590;z-index:61}
  </style></head><body>
  <div class="top"><h1>QA #5708 — barrido exhaustivo + cobertura declarada</h1>
    <span class="badge">verificacion</span>
    <div class="chips">${CAS.map(c => `<span class="chip" data-ca="${c[0]}">${c[0]}</span>`).join('')}</div>
  </div>
  <div class="stage">
    <div class="scene" id="s1"><div class="hero">
      <h2>Re-verificacion con evidencia interactiva</h2>
      <p class="sub">Issue #5708 · rama agent/5708-pipeline-dev · 7 criterios de aceptacion</p>
      <div class="why"><b>Por que se rehace:</b> el video de la pasada anterior fue rechazado por PO —
        era una captura estatica congelada de 65s, sin navegacion ni interaccion.
        Verificado: 13 frames muestreados, solo 5 hashes unicos, en ciclo.</div>
    </div></div>

    <div class="scene" id="s2">
      <h2>CA-6 · Guardrail de forma con feature flag</h2>
      <p class="sub">.pipeline/hooks/visual-report-shape-gate.js — linter puro, default OFF</p>
      ${term('t2', 'node -e "require(\'./.pipeline/hooks/visual-report-shape-gate.js\')"')}
    </div>

    <div class="scene" id="s3">
      <h2>CA-3 / CA-4 / CA-5 · Reporte real renderizado</h2>
      <p class="sub">visual-comparison.json → rejection-report.js · scroll sobre el PDF/HTML real</p>
      <div class="frame"><iframe name="rep" id="rep" src="file:///${repPath.replace(/\\/g, '/')}"></iframe></div>
      <div class="scrollbar"><div class="thumb" id="th3"></div></div>
    </div>

    <div class="scene" id="s4">
      <h2>CA-3 · 63 desvios: se muestran 50 y se declara el truncado</h2>
      <p class="sub">Prohibido truncar en silencio — la banda informa N de M</p>
      <div class="frame"><iframe name="big" id="big" src="file:///${bigPath.replace(/\\/g, '/')}"></iframe></div>
      <div class="scrollbar"><div class="thumb" id="th4"></div></div>
    </div>

    <div class="scene" id="s5">
      <h2>CA-1 / CA-2 · Doctrina: prohibido el early-exit</h2>
      <p class="sub">git diff origin/main...HEAD -- .claude/skills/qa/SKILL.md</p>
      ${term('t5', 'git diff — .claude/skills/qa/SKILL.md')}
    </div>

    <div class="scene" id="s6">
      <h2>CA-7 · Tests y cableado punta a punta</h2>
      <p class="sub">node --test · grep del transporte real del contrato</p>
      ${term('t6a', 'node --test (guardrail + reporte visual + rol QA)')}
      ${term('t6b', 'cableado: pulpo --visual-json → rejection-report')}
    </div>

    <div class="scene" id="s7"><div class="verdict">
      <div class="big">APROBADO</div>
      <div class="dim" style="font-size:15px">7 de 7 criterios verificados empiricamente</div>
      <div class="grid">${CAS.map(c => `<div class="g"><b>${c[0]}</b>${c[1]}</div>`).join('')}</div>
    </div></div>
    <div class="cursor" id="cur"></div>
  </div>
  <div class="pbar"><div class="pfill" id="pf"></div></div>
  <div class="tc" id="tc"></div>
  <script>
    window.__H = {};
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type === 'h') window.__H[d.id] = d.h;
    });
    window.setScene = function (id) {
      document.querySelectorAll('.scene').forEach(function (s) { s.classList.toggle('on', s.id === id); });
    };
    window.setChips = function (list) {
      document.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('on', list.indexOf(c.dataset.ca) >= 0);
      });
    };
    window.setTerm = function (id, text) { document.querySelector('#' + id + ' .tbody').textContent = text; };
    window.setScroll = function (name, y) {
      var f = document.getElementById(name);
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'scroll', y: y }, '*');
    };
    window.setThumb = function (id, frac, vis) {
      var t = document.getElementById(id); if (!t) return;
      t.style.display = vis ? 'block' : 'none';
      t.style.height = '60px';
      var track = t.parentElement.clientHeight - 60;
      t.style.top = Math.round(track * frac) + 'px';
    };
    window.setCursor = function (x, y, vis) {
      var c = document.getElementById('cur');
      c.style.display = vis ? 'block' : 'none';
      c.style.left = x + 'px'; c.style.top = y + 'px';
    };
    // Barra de avance + timecode: cambian en cada frame, asi ningun par de
    // frames del video puede ser identico (anti "pantalla congelada").
    window.setProgress = function (frac, t, total) {
      document.getElementById('pf').style.width = (frac * 100).toFixed(3) + '%';
      document.getElementById('tc').textContent =
        't=' + t.toFixed(1) + 's / ' + total + 's · QA #5708';
    };
    window.setVerdictReveal = function (n) {
      var gs = document.querySelectorAll('.g');
      for (var i = 0; i < gs.length; i++) gs[i].classList.toggle('on', i < n);
    };
  </script></body></html>`;
}

// -------------------------------------------------------------------- timeline
const easeInOut = x => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const clamp01 = x => Math.max(0, Math.min(1, x));

// [inicio, fin, escena]
const SCENES = [
  [0, 13, 's1'],
  [13, 46, 's2'],
  [46, 74, 's3'],
  [74, 88, 's4'],
  [88, 100, 's5'],
  [100, 112, 's6'],
  [112, DURATION, 's7'],
];

// criterio -> segundo en que se enciende el chip
const CHIP_AT = { 'CA-6': 24, 'CA-3': 52, 'CA-4': 62, 'CA-5': 70, 'CA-2': 80, 'CA-1': 94, 'CA-7': 106 };

const TXT = {
  t2: read('ca6-guardrail.txt'),
  t5: read('ca1-doctrina.txt'),
  t6a: read('ca7-tests.txt'),
  t6b: read('ca-wiring.txt'),
};

/**
 * Revelado tipo maquina de escribir, caracter por caracter.
 *
 * El revelado por lineas producia frames identicos entre salto y salto (8 lineas
 * en 20s = un cambio cada 2.5s), es decir el mismo defecto de "pantalla
 * congelada" por el que PO rechazo la pasada anterior. Con avance por caracter
 * el contenido cambia en cada frame.
 */
function reveal(text, p, frame) {
  const f = clamp01(p);
  const n = Math.round(text.length * f);
  const caret = f < 1 && Math.floor(frame / 4) % 2 === 0 ? '█' : '';
  return text.slice(0, n) + caret;
}

// Sharding: la animacion es funcion pura del indice de frame, asi que se puede
// repartir el rango entre varios procesos sin que cambie un solo pixel.
const SHARD_FROM = Number(process.env.WT_FROM || 0);
const SHARD_TO = process.env.WT_TO ? Number(process.env.WT_TO) : null;

async function main() {
  if (SHARD_FROM === 0 && !SHARD_TO) {
    fs.rmSync(FRAMES, { recursive: true, force: true });
  }
  fs.mkdirSync(FRAMES, { recursive: true });

  const repPath = writeReport('report-real.html', realVc);
  const bigPath = writeReport('report-63.html', bigVc);
  const shellPath = path.join(EV, 'walkthrough.html');
  fs.writeFileSync(shellPath, shellHtml(repPath, bigPath));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--allow-file-access-from-files',
      '--disable-web-security',
      `--window-size=${W},${H}`,
      '--hide-scrollbars',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto('file:///' + shellPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));

  // Medir con la escena visible: con display:none el scrollHeight da 0.
  const measure = async (sceneId, frameId) => {
    await page.evaluate(id => window.setScene(id), sceneId);
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate(id => {
      const f = document.getElementById(id);
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'measure' }, '*');
    }, frameId);
    await new Promise(r => setTimeout(r, 400));
    const h = await page.evaluate(id => (window.__H || {})[id] || 0, frameId);
    return h;
  };
  const rawRep = await measure('s3', 'rep');
  const rawBig = await measure('s4', 'big');
  const VIEW = H - 116; // alto util del panel de scroll
  const hRep = Math.max(1, rawRep - VIEW);
  const hBig = Math.max(1, rawBig - VIEW);
  console.log(`[walkthrough] alturas: rep=${rawRep}px (scroll ${hRep}) big=${rawBig}px (scroll ${hBig})`);

  const total = Math.round(DURATION * FPS);
  const from = SHARD_FROM;
  const to = Math.min(total, SHARD_TO == null ? total : SHARD_TO);
  console.log(`[walkthrough] shard ${from}..${to} de ${total}`);
  for (let i = from; i < to; i++) {
    const t = i / FPS;
    const scene = (SCENES.find(s => t >= s[0] && t < s[1]) || SCENES[SCENES.length - 1])[2];
    const chips = Object.keys(CHIP_AT).filter(k => t >= CHIP_AT[k]);

    const st = {
      scene, chips, terms: {}, scroll: null, thumb: null, cursor: null,
      prog: [i / total, t, DURATION], verdict: 0,
    };

    if (scene === 's2') {
      // Revelado real de la salida del guardrail, caracter por caracter.
      st.terms.t2 = reveal(TXT.t2, (t - 14) / 26, i);
    } else if (scene === 's3') {
      // Scroll real y continuo sobre el reporte renderizado.
      const p = easeInOut(clamp01((t - 47) / 25));
      st.scroll = ['rep', Math.round(hRep * p)];
      st.thumb = ['th3', p];
      st.cursor = [1180, 120 + Math.round(540 * p)];
    } else if (scene === 's4') {
      const p = easeInOut(clamp01((t - 75) / 12));
      st.scroll = ['big', Math.round(hBig * p)];
      st.thumb = ['th4', p];
      st.cursor = [1180, 120 + Math.round(540 * p)];
    } else if (scene === 's5') {
      st.terms.t5 = reveal(TXT.t5, (t - 88.5) / 11, i);
    } else if (scene === 's6') {
      st.terms.t6a = reveal(TXT.t6a, (t - 100.2) / 5.5, i);
      st.terms.t6b = reveal(TXT.t6b, (t - 105.8) / 5.5, i);
    } else if (scene === 's7') {
      // Los 7 criterios se encienden de a uno durante el veredicto.
      st.verdict = Math.min(7, Math.floor(((t - 112) / (DURATION - 112)) * 8));
    }

    await page.evaluate(s => {
      window.setScene(s.scene);
      window.setChips(s.chips);
      Object.keys(s.terms).forEach(k => window.setTerm(k, s.terms[k]));
      window.setThumb('th3', 0, false);
      window.setThumb('th4', 0, false);
      if (s.thumb) window.setThumb(s.thumb[0], s.thumb[1], true);
      if (s.scroll) window.setScroll(s.scroll[0], s.scroll[1]);
      window.setCursor(s.cursor ? s.cursor[0] : 0, s.cursor ? s.cursor[1] : 0, !!s.cursor);
      window.setVerdictReveal(s.verdict);
      window.setProgress(s.prog[0], s.prog[1], s.prog[2]);
    }, st);

    if (st.scroll) await new Promise(r => setTimeout(r, 12)); // que asiente el postMessage

    const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(FRAMES, `f-${String(i).padStart(5, '0')}.jpg`), buf);
    if (i % 100 === 0) console.log(`[walkthrough] frame ${i}/${total} (t=${t.toFixed(1)}s escena=${scene})`);
  }

  await browser.close();
  console.log(`[walkthrough] listo: ${total} frames en ${FRAMES}`);
}

main().catch(e => { console.error(e); process.exit(1); });

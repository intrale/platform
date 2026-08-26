'use strict';
// QA #6459 pasada 5 — slides HTML del video narrado. Datos REALES de esta pasada.
const fs = require('fs');
const path = require('path');
const D = __dirname;
const HEAD = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:720px;background:#0d1117;color:#e6edf3;font:15px/1.55 system-ui;padding:44px 56px;box-sizing:border-box;overflow:hidden">`;
const T = (t, s) => `<div style="font:700 30px/1.3 system-ui;margin-bottom:6px">${t}</div><div style="color:#8b949e;font-size:16px;margin-bottom:24px">${s}</div>`;
const MONO = 'ui-monospace,Consolas,monospace';
const BOX = 'background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px 22px';

const filas = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:15px">` + rows.map(([id, q, d]) => `<tr>
<td style="padding:5px 14px 5px 0;color:#3FB950;font-weight:700;white-space:nowrap">✓ ${id}</td>
<td style="padding:5px 18px 5px 0">${q}</td>
<td style="padding:5px 0;color:#8b949e;font-size:13.5px">${d}</td></tr>`).join('') + `</table>`;

const slides = {
  s00: HEAD + T('QA #6459 · pasada 5 — turnos huérfanos del Commander',
    'Modo <b>structural</b> con preflight visual bloqueante · HEAD <code>a34be276d</code> · PR #6538') + `
<div style="font:14px/1.9 ${MONO};${BOX}">
$ git log --oneline -1<br><span style="color:#3FB950">a34be276d fix(pipeline): el barrido emite el evento terminal en LOS DOS desenlaces (#6459)</span><br>
$ git diff --stat origin/main...HEAD | tail -1<br><span style="color:#8b949e">18 files changed, 2714 insertions(+), 25 deletions(-)</span>
</div>
<div style="margin-top:22px;font-size:16px;color:#8b949e">Pasada nueva sobre un HEAD nuevo: el commit responde al <b style="color:#FF6B8A">rechazo de <code>aprobacion</code> (rev-1)</b> —
el barrido emitía el evento terminal sólo para los huérfanos, así que un turno con entrega confirmada no cerraba nunca su ciclo.<br>
El diff toca <code>.pipeline/dashboard.js</code> y el issue referencia el mockup versionado <code>mockups/6440/02-dashboard-badge-huerfano.svg</code>
⇒ <b style="color:#FF6B8A">structural no significa "sin render"</b>. Todo lo que sigue se ejecutó y se observó en <b>esta</b> pasada.</div>`,

  s01: HEAD + T('Suites obligatorias + probe propio punta a punta', 'runner <code>node --test</code> · probe con filesystem real, appender real y <code>commanderOutboundStatus</code> real') + `
<div style="font:13.5px/1.8 ${MONO};${BOX};margin-bottom:16px">
$ node --test orphan-sweep · request-classify · result-badge · commander-inflight-fallback · file-lock<br>
<span style="color:#8b949e">ℹ tests</span> <b>159</b> &nbsp; <span style="color:#3FB950">ℹ pass <b>159</b></span> &nbsp; <span style="color:#F85149">ℹ fail <b>0</b></span>
</div>
<div style="font:13.5px/1.75 ${MONO};${BOX}">
$ node .scratch/qa6459/probe.js &nbsp;<span style="color:#8b949e">(7 turnos sembrados en sandbox)</span><br>
outboundStatus REAL: corr-ok =&gt; <b style="color:#3FB950">enviado</b> | corr-fallido =&gt; <b style="color:#F85149">fallido</b><br>
resumen&nbsp;&nbsp;&nbsp;= {"evaluados":6,"huerfanos":2,"sanos":2,"no_evaluables":1,"no_verificables":1}<br>
emitidos&nbsp;&nbsp;= <b>3</b> | con entrega (success:true): <b style="color:#3FB950">1</b> | sin entrega: <b style="color:#FF6B8A">2</b><br>
barrido 2 =&gt; 0 eventos &nbsp;·&nbsp; barrido 3 =&gt; 0 eventos &nbsp;<span style="color:#8b949e">(idempotencia)</span>
</div>`,

  s02: HEAD + T('CA-1 a CA-8 — verificados empíricamente en esta pasada', 'cada línea salió de un comando ejecutado, no de leer el código') +
    filas([
      ['CA-1', 'Turno que cerró sin entrega ⇒ <code>huerfano</code>', 'clasificador real: <code>deliveryUnconfirmed:true</code> ⇒ <code>"huerfano"</code>; enum con 5º valor'],
      ['CA-2', 'Sin entrega ⇒ <code>error_code: delivered=false</code>', '2 entradas reales <code>delivery_failed</code> + <code>success:false</code> en el audit'],
      ['CA-3', '<b>Con entrega ⇒ evento EXITOSO</b> (era el rechazo)', '1 entrada <code>delivery_observed</code> + <code>success:true</code>, por el camino real del barrido'],
      ['CA-4', 'Nada se reescribe: hash-chain verifica', '<code>verifyChain</code> ok con 3, con la entrada legacy (4) y con una nueva encima (5)'],
      ['CA-5', 'Boot actual nunca se evalúa', 'el turno del boot vivo ⇒ <code>no_evaluable / boot_actual</code>, sin evento'],
      ['CA-6', 'Early-return con <code>resultado</code> no es huérfano', '⇒ <code>sano / cerro_solo</code>, y el barrido no emite: lo cerró su <code>finally</code>'],
      ['CA-7', 'El veredicto sale de <code>commanderOutboundStatus</code>', 'la etapa <code>envío</code> sólo aporta el <code>correlation_id</code>; <code>directo</code> ⇒ no verificable'],
      ['CA-8', 'Ventana 48 h decidida por el nombre', 'de 7 turnos se abrieron 6: el de 72 h <b>nunca se abrió</b> (lector espiado)'],
    ]),

  s05: HEAD + T('CA-10 a CA-15 y cierre', '') +
    filas([
      ['CA-10', 'Turnos sanos ⇒ cero marcas de huérfano', 'sustrato mezclado: los sanos quedaron sanos, 0 marcas'],
      ['CA-11', 'Un huérfano ⇒ exactamente 1 evento terminal', '3 barridos seguidos ⇒ 3 / 0 / 0 eventos; 1 entrada por <code>commander_req_id</code>'],
      ['CA-12', 'Barrido gateado por ticks (~5 min)', '<code>orphanSweepGate</code> real: 9→0, 10→1, 25→2, 100→10, 137→13 disparos'],
      ['CA-13', 'Badge comparado contra el mockup acordado', 'muestreo de píxeles: texto <code>#FF6B8A</code> y borde <code>#B8254A</code> idénticos'],
      ['CA-14', 'Un barrido que falla deja rastro', '<code>readdirSync</code> que tira ⇒ <code>ok:false</code> + causa logueada, tick vivo'],
      ['CA-15', 'Ramas de decisión enumeradas', '<code>B-01</code>…<code>B-14</code> documentadas, cada una con su test homónimo'],
    ]) + `
<div style="margin-top:22px;border:1px solid #238636;background:rgba(63,185,80,0.10);border-radius:10px;padding:18px 22px">
<div style="font:700 24px/1.3 system-ui;color:#3FB950">Veredicto: APROBADO — 15 / 15 criterios cumplen, 0 defectos</div>
<div style="margin-top:8px;color:#8b949e;font-size:15px">El bloqueante de <code>aprobacion</code> rev-1 (CA-3) está <b>corregido y verificado</b> en esta pasada.<br>
Contrato visual: 6 secciones declaradas · 6 verificadas · 0 no verificadas · <code>diffs: []</code>.</div>
</div>`,
};

for (const [k, v] of Object.entries(slides)) fs.writeFileSync(path.join(D, 'slide-' + k + '.html'), v, 'utf8');
console.log('slides:', Object.keys(slides).join(' '));

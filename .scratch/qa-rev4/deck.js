'use strict';
// QA rev4 #6459 — genera las slides HTML del video narrado.
const fs = require('fs');
const path = require('path');
const D = __dirname;

const HEAD = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:720px;background:#0d1117;color:#e6edf3;font:15px/1.55 system-ui;padding:44px 56px;box-sizing:border-box;overflow:hidden">`;
const T = (t, s) => `<div style="font:700 30px/1.3 system-ui;margin-bottom:6px">${t}</div><div style="color:#8b949e;font-size:16px;margin-bottom:26px">${s}</div>`;
const MONO = 'ui-monospace,Consolas,monospace';

const slides = {
  's00': HEAD + T('QA #6459 · rev4 — turnos huérfanos del Commander',
    'Modo <b>structural</b> con preflight visual bloqueante · HEAD <code>ae3c20e31</code> · PR #6538') + `
<div style="font:14px/1.9 ${MONO};background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px 24px">
$ git log --oneline -1<br><span style="color:#3FB950">ae3c20e31 fix(pipeline): cerrar el dual-hold del file-lock que perdia writes en silencio (#6459)</span><br>
$ git merge-base --is-ancestor origin/main HEAD &amp;&amp; echo SI<br><span style="color:#3FB950">SI</span>
</div>
<div style="margin-top:24px;font-size:16px;color:#8b949e">Pasada 4. El diff toca <code>.pipeline/dashboard.js</code> y el issue referencia el mockup versionado
<code>.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg</code> ⇒ <b style="color:#FF6B8A">structural no significa "sin render"</b>.<br>
Todo lo que sigue se ejecutó y se observó en <b>esta</b> pasada. No se cita nada de pasadas anteriores.</div>`,

  's01': HEAD + T('Suites obligatorias — ejecutadas en esta pasada', 'runner <code>node --test</code>') + `
<div style="font:14px/1.85 ${MONO};background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px 24px">
$ node --test .pipeline/lib/commander/__tests__/orphan-sweep.test.js \\<br>
&nbsp;&nbsp;&nbsp;&nbsp;.pipeline/lib/commander/__tests__/request-classify.test.js \\<br>
&nbsp;&nbsp;&nbsp;&nbsp;.pipeline/lib/commander/__tests__/result-badge.test.js \\<br>
&nbsp;&nbsp;&nbsp;&nbsp;.pipeline/lib/__tests__/commander-inflight-fallback.test.js \\<br>
&nbsp;&nbsp;&nbsp;&nbsp;.pipeline/lib/__tests__/file-lock.test.js<br><br>
<span style="color:#8b949e">ℹ tests</span> <b>154</b> &nbsp; <span style="color:#3FB950">ℹ pass <b>154</b></span> &nbsp; <span style="color:#F85149">ℹ fail <b>0</b></span> &nbsp; <span style="color:#8b949e">ℹ duration_ms 2464.2</span>
</div>
<div style="margin-top:22px;font-size:16px;color:#8b949e">Incluye <code>file-lock.test.js</code>, que llega con el commit nuevo <code>ae3c20e31</code> y no existía cuando se verificó <code>decab5637</code>.</div>`,

  's02': HEAD + T('CA-1 a CA-8 — verificados sobre el código y los tests de esta pasada', '') + `
<table style="width:100%;border-collapse:collapse;font-size:15px">
${[
  ['CA-1', 'Turno sin entrega confirmada ⇒ <code>huerfano</code>', '<code>deliveryUnconfirmed ⇒ huerfano</code> + enum <code>RESULTADOS</code> con 5º valor'],
  ['CA-2', 'Sin entrega ⇒ <code>error_code: delivered=false</code>', 'distinguible de <code>empty_output</code> — test homónimo sobre el audit real'],
  ['CA-3', 'Con entrega ⇒ cierre exitoso', 'sin regresión respecto de #4309'],
  ['CA-4', 'Nada se reescribe: hash-chain verifica', '<code>success</code>/<code>error_code</code> aditivos al final; entradas viejas siguen verificando'],
  ['CA-5', 'Boot actual nunca se evalúa', 'guarda de vida por <code>boot_id</code> ⇒ <code>NO_EVALUABLE</code> sin abrir el archivo'],
  ['CA-6', 'Early-return con <code>resultado</code> no es huérfano', 'el barrido nunca toca un turno que ya asentó <code>resultado</code>'],
  ['CA-7', 'El veredicto sale de <code>commanderOutboundStatus</code>', 'la etapa <code>envío</code> sólo aporta el <code>correlation_id</code>'],
  ['CA-8', 'Ventana 48 h decidida por el nombre', '<code>epochms</code> del filename ANTES de abrir nada'],
].map(([id, q, d]) => `<tr>
<td style="padding:5px 14px 5px 0;color:#3FB950;font-weight:700;white-space:nowrap">✓ ${id}</td>
<td style="padding:5px 18px 5px 0">${q}</td>
<td style="padding:5px 0;color:#8b949e;font-size:13.5px">${d}</td></tr>`).join('')}
</table>`,

  's05': HEAD + T('CA-14 · CA-15 y cierre', '') + `
<table style="width:100%;border-collapse:collapse;font-size:15px;margin-bottom:26px">
${[
  ['CA-10', 'Turnos sanos ⇒ cero marcas', 'integración con 4 turnos mezclados ⇒ 1 sola detección'],
  ['CA-11', 'Un huérfano ⇒ exactamente 1 evento terminal', 'N ≥ 3 barridos ⇒ 1 entrada por <code>commander_req_id</code>'],
  ['CA-12', 'Barrido gateado por ticks', '<code>ORPHAN_SWEEP_EVERY_TICKS = 10</code> — no corre en cada iteración'],
  ['CA-14', 'Un barrido que falla deja rastro', 'nunca degrada al mismo estado que "todo sano"; el tick sigue vivo'],
  ['CA-15', 'Ramas de decisión enumeradas', '<code>B-01</code>…<code>B-14</code>, cada una con su test homónimo'],
].map(([id, q, d]) => `<tr>
<td style="padding:5px 14px 5px 0;color:#3FB950;font-weight:700;white-space:nowrap">✓ ${id}</td>
<td style="padding:5px 18px 5px 0">${q}</td>
<td style="padding:5px 0;color:#8b949e;font-size:13.5px">${d}</td></tr>`).join('')}
</table>
<div style="border:1px solid #238636;background:rgba(63,185,80,0.10);border-radius:10px;padding:20px 24px">
<div style="font:700 24px/1.3 system-ui;color:#3FB950">Veredicto: APROBADO — 15 / 15 criterios cumplen, 0 defectos</div>
<div style="margin-top:10px;color:#8b949e;font-size:15px">Contrato visual: 6 secciones declaradas · 6 verificadas · 0 no verificadas · <code>diffs: []</code>.<br>
Consumidor real ejecutado: <code>visual-coverage-recorder.recordApprovedCoverage</code> ⇒ <code>written: true</code> → <code>visual-coverage-rev0.json</code>.</div>
</div>`,
};

for (const [k, v] of Object.entries(slides)) {
  fs.writeFileSync(path.join(D, `s-${k}.html`), v, 'utf8');
}
console.log('slides:', Object.keys(slides).join(' '));

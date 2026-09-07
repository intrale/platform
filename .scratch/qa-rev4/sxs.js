'use strict';
// QA rev4 #6459 — recortes + página de comparación lado a lado (render vs mockup).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const D = __dirname;
const FF = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg.exe';

function crop(src, out, c) {
  const r = spawnSync(FF, ['-y', '-v', 'error', '-i', path.join(D, src), '-vf', `crop=${c}`, path.join(D, out)]);
  if (r.status !== 0) throw new Error(src + ' -> ' + r.stderr.toString().slice(0, 300));
  console.log(out, fs.statSync(path.join(D, out)).size, 'bytes  (crop=' + c + ')');
}
// fila completa de "Logs recientes" del render real (6 filas, 5 badges + 1 sin badge)
crop('render-rev4.png', 'crop-render-rows.png', '700:260:60:120');
// zoom del badge huérfano del render real
crop('render-rev4.png', 'crop-render-badge.png', '160:52:400:168');
// zoom del badge error del render real (para contraste: NO es el mismo rojo)
crop('render-rev4.png', 'crop-render-error.png', '160:52:400:256');
// set de badges a tamaño real del mockup acordado
crop('mockup-rev4.png', 'crop-mockup-rows.png', '470:60:1290:245');
// zoom del badge huérfano del mockup (versión ampliada)
crop('mockup-rev4.png', 'crop-mockup-badge.png', '240:70:970:220');

const html = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 system-ui;padding:24px 28px">
<div style="font:700 20px/1.4 system-ui;margin-bottom:4px">QA #6459 · rev4 — badge <code>huerfano</code>: render real vs mockup acordado</div>
<div style="color:#8b949e;margin-bottom:20px">Izquierda: dashboard REAL servido por <code>.pipeline/dashboard.js</code> @ <code>ae3c20e31</code> en <code>/legacy</code>.
Derecha: <code>.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg</code> (baseline versionada, UX).</div>
<table style="border-collapse:collapse;width:100%">
<tr>
  <td style="width:50%;vertical-align:top;padding:0 14px 0 0">
    <div style="font-weight:700;color:#3FB950;margin-bottom:8px">RENDER REAL — /legacy · Actividad Commander</div>
    <img src="crop-render-rows.png" style="width:100%;border:1px solid #30363d;border-radius:8px">
    <div style="margin:16px 0 8px;font-weight:700;color:#8b949e">zoom · badge <code>huerfano</code></div>
    <img src="crop-render-badge.png" style="border:1px solid #30363d;border-radius:8px">
    <div style="margin:14px 0 8px;font-weight:700;color:#8b949e">zoom · badge <code>error</code> (fila contigua, otro rojo)</div>
    <img src="crop-render-error.png" style="border:1px solid #30363d;border-radius:8px">
  </td>
  <td style="width:50%;vertical-align:top;padding:0 0 0 14px;border-left:1px solid #30363d">
    <div style="font-weight:700;color:#FF6B8A;margin-bottom:8px">MOCKUP ACORDADO — set a tamaño real</div>
    <img src="crop-mockup-rows.png" style="width:100%;border:1px solid #30363d;border-radius:8px">
    <div style="margin:16px 0 8px;font-weight:700;color:#8b949e">zoom · badge <code>huerfano</code> (ampliado en el mockup)</div>
    <img src="crop-mockup-badge.png" style="border:1px solid #30363d;border-radius:8px">
  </td>
</tr>
</table>
<div style="margin-top:22px;border-top:1px solid #30363d;padding-top:14px">
<div style="font-weight:700;margin-bottom:8px">Muestreo de color (ffmpeg · rawvideo rgb24, no estimación)</div>
<table style="border-collapse:collapse;font:13px/1.6 ui-monospace,monospace">
<tr style="color:#8b949e"><th align="left" style="padding-right:26px">zona</th><th align="left" style="padding-right:26px">texto</th><th align="left" style="padding-right:26px">borde</th><th align="left">fondo compuesto</th></tr>
<tr><td style="padding-right:26px">render huérfano</td><td style="color:#FF6B8A">#FF6B8A</td><td style="color:#B8254A">#B8254A</td><td>#331F29 (sobre surface-0 #0D1117)</td></tr>
<tr><td style="padding-right:26px">mockup huérfano</td><td style="color:#FF6B8A">#FF6B8A</td><td style="color:#B8254A">#B8254A</td><td>#3B2732 (sobre surface-1 #161B22)</td></tr>
<tr><td style="padding-right:26px">render error</td><td style="color:#F85149">#F85149</td><td style="color:#8B1A14">#8B1A14</td><td>#2E191D — <b>otro rojo</b>, no el rosa</td></tr>
</table>
<div style="color:#8b949e;margin-top:10px">Texto y borde coinciden <b>exactamente</b> con los tokens del mockup. El fondo difiere sólo porque
<code>rgba(255,107,138,0.16)</code> compone contra superficies distintas: 0,16·255+0,84·13 = 51,7 → <code>0x33</code> en el render (surface-0)
y 0,16·255+0,84·22 = 59,3 → <code>0x3B</code> en el mockup (surface-1). El propio mockup declara <code>#341F29</code> como fondo compuesto real.</div>
</div>
</body>`;
fs.writeFileSync(path.join(D, 'sxs.html'), html, 'utf8');
console.log('sxs.html listo');

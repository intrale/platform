const fs = require('fs');
const path = require('path');
const EV = 'qa/evidence/5220';
const raw = fs.readFileSync(path.join(EV, 'render-real-pass3.txt'), 'utf8');
// El header con EXIT/DURACION lo escribimos nosotros; el output real empieza tras el marcador
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Colorea SOLO por prefijo de linea, sin alterar ningun caracter del texto real.
function colorize(text) {
  return text.split('\n').map((ln) => {
    const e = esc(ln);
    if (/^🔴/.test(ln)) return `<span class="banner">${e}</span>`;
    if (/^🔐/.test(ln)) return `<span class="head">${e}</span>`;
    if (/^👻/.test(ln)) return `<span class="gb">${e}</span>`;
    if (/● ROTAR/.test(ln)) return `<span class="rotar">${e}</span>`;
    if (/● REVISAR/.test(ln)) return `<span class="revisar">${e}</span>`;
    if (/● PURGAR/.test(ln)) return `<span class="purgar">${e}</span>`;
    if (/^\*Secretos/.test(ln)) return `<span class="sect">${e}</span>`;
    if (/^\s{2}\S/.test(ln) && /Acción:/.test(ln)) return `<span class="accion">${e}</span>`;
    if (/^\s{6}/.test(ln)) return `<span class="pathln">${e}</span>`;
    return e;
  }).join('\n');
}

const CSS = `
 body{margin:0;background:#0d1117;font-family:'Cascadia Mono','Consolas','DejaVu Sans Mono',monospace;}
 .term{background:#0d1117;padding:0 0 24px 0;}
 .bar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 18px;color:#8b949e;font-size:15px;display:flex;gap:10px;align-items:center}
 .dot{width:12px;height:12px;border-radius:50%;display:inline-block}
 .r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
 pre{margin:0;padding:18px 22px;color:#c9d1d9;font-size:15.5px;line-height:1.5;white-space:pre;}
 .head{color:#58a6ff;font-weight:700}
 .banner{color:#ff7b72;font-weight:700}
 .gb{color:#d2a8ff;font-weight:700}
 .sect{color:#e3b341;font-weight:700}
 .accion{color:#8b949e;font-style:italic}
 .rotar{color:#ff7b72;font-weight:700}
 .revisar{color:#e3b341;font-weight:700}
 .purgar{color:#58a6ff;font-weight:700}
 .pathln{color:#6e7681}
 .cmd{color:#7ee787}
`;

function page(title, body, extra='') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${extra}</style></head><body>${body}</body></html>`;
}

function term(inner, cmd) {
  return `<div class="term"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  &nbsp;RENDER REAL — ejecutado en esta pasada de QA · HEAD bc7abe970 · pasada 3</div>
  <pre><span class="cmd">$ ${esc(cmd)}</span>\n\n${inner}</pre></div>`;
}

// 1) Render completo
fs.writeFileSync(path.join(EV,'render-full-p3.html'),
  page('full', term(colorize(raw), 'node .pipeline/ghostbusters.js --secrets --dry-run')));

// 2) Render "above the fold": encabezado + historial completo + corte + purgables + cola
const lines = raw.split('\n');
const idxNoVer = lines.findIndex(l => /^\*Secretos filtrados · no verificables/.test(l));
const idxPurg  = lines.findIndex(l => /^\*Secretos filtrados · purgables/.test(l));
const top = lines.slice(0, idxNoVer);                       // header + historial completo
const noVerHead = lines.slice(idxNoVer, idxNoVer + 6);      // titulo + accion + 1er patron
const purg = lines.slice(idxPurg);                          // purgables + cola
const folded = [
  ...top,
  ...noVerHead,
  '      … (recorte de esta captura para que entre en pantalla — el reporte NO trunca:',
  '          las 419 rutas no-verificables se listan completas en render-full.png)',
  '',
  ...purg,
].join('\n');
fs.writeFileSync(path.join(EV,'render-fold-p3.html'),
  page('fold', term(colorize(folded), 'node .pipeline/ghostbusters.js --secrets --dry-run')));

console.log('OK html generado');
console.log('lineas totales', lines.length, '| idxNoVer', idxNoVer, '| idxPurg', idxPurg);

'use strict';
const fs = require('fs');
const path = require('path');
const slides = require('./slides');
const OUT = __dirname;

const CSS = `
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--pk:#FF6B8A}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:720px;background:var(--bg);color:var(--tx);
  font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;display:flex;flex-direction:column}
header{padding:28px 44px 18px;border-bottom:1px solid var(--bd)}
h1{font-size:29px;font-weight:650;letter-spacing:-0.3px;line-height:1.25}
h1 .ca{color:var(--pk)}
.sub{margin-top:8px;font-size:16px;color:var(--dim)}
main{flex:1;padding:26px 44px;display:flex;flex-direction:column;justify-content:center;gap:14px}
.row{display:flex;gap:16px;align-items:flex-start;background:var(--sf);border:1px solid var(--bd);
  border-radius:10px;padding:14px 18px}
.k{flex:0 0 168px;font-size:14px;font-weight:700;color:var(--ac);text-transform:uppercase;letter-spacing:1px;padding-top:2px}
.v{flex:1;font-size:17px;line-height:1.45;font-family:'Cascadia Mono','Consolas',monospace;word-break:break-word}
.row.okrow{border-color:#1f6f3f}
.row.okrow .k{color:var(--gn)}
.imgwrap{flex:1;display:flex;align-items:center;justify-content:center}
.imgwrap img{max-width:100%;max-height:520px;border:1px solid var(--bd);border-radius:10px}
footer{padding:12px 44px 18px;font-size:13px;color:var(--dim);
  display:flex;justify-content:space-between;border-top:1px solid var(--bd)}
`;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const files = [];
slides.forEach((s, i) => {
  let body;
  if (s.img) {
    body = `<div class="imgwrap"><img src="${s.img}"></div>`;
  } else {
    body = s.filas.map(([k, v]) => {
      const ok = /^observado$/i.test(k);
      return `<div class="row${ok ? ' okrow' : ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
    }).join('\n');
  }
  const tituloHtml = esc(s.titulo).replace(/^(CA-\d+)/, '<span class="ca">$1</span>');
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>${CSS}</style></head><body>
<header><h1>${tituloHtml}</h1><div class="sub">${esc(s.sub)}</div></header>
<main>${body}</main>
<footer><span>QA · Intrale · issue #6459 · PR #6538 @ decab5637</span><span>${i + 1} / ${slides.length}</span></footer>
</body></html>`;
  const f = path.join(OUT, `slide-${s.id}.html`);
  fs.writeFileSync(f, html);
  files.push(f);
});

// Side-by-side render vs mockup (para CA-13)
const sxs = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>
body{width:1280px;height:600px;margin:0;background:#0d1117;color:#e6edf3;
  font-family:'Segoe UI',system-ui,sans-serif;padding:14px;box-sizing:border-box;
  display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto auto 1fr auto;gap:8px 16px}
.lbl{font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.l-r{color:#3fb950}.l-m{color:#FF6B8A}
.zoom{border:2px solid #30363d;border-radius:10px;background:#0b0f14;display:flex;
  align-items:center;justify-content:center;padding:6px;height:132px}
.zoom img{max-height:118px;max-width:100%;object-fit:contain}
.box{border:2px solid #30363d;border-radius:10px;overflow:hidden;background:#0b0f14;
  display:flex;align-items:center;justify-content:center;min-height:0}
.box img{width:100%;object-fit:contain}
.note{font-size:13px;color:#8b949e;font-family:'Cascadia Mono',Consolas,monospace}
</style></head><body>
<div class="lbl l-r">Render real · dashboard.js (esta pasada)</div>
<div class="lbl l-m">Mockup acordado · mockups/6440/02-dashboard-badge-huerfano.svg</div>
<div class="zoom"><img src="crop-render-badge.png"></div>
<div class="zoom"><img src="crop-mockup-badge.png"></div>
<div class="box"><img src="render.png"></div>
<div class="box"><img src="mockup.png"></div>
<div class="note">texto #FF6B8A · borde #B8254A · error, al lado: #F85149</div>
<div class="note">--result-huerfano #FF6B8A · --result-huerfano-dim #B8254A</div>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'sxs.html'), sxs);
console.log('slides:', files.length, '+ sxs.html');

'use strict';
const fs=require('fs'),path=require('path'),OUT=__dirname;
const CSS=`
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--pk:#FF6B8A}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:720px;background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;display:flex;flex-direction:column}
header{padding:26px 44px 16px;border-bottom:1px solid var(--bd)}
h1{font-size:30px;font-weight:650;letter-spacing:-0.3px;line-height:1.25}
h1 .ca{color:var(--pk)}
.sub{margin-top:8px;font-size:16px;color:var(--dim)}
main{flex:1;padding:22px 44px;display:flex;flex-direction:column;justify-content:center;gap:12px}
.row{display:flex;gap:16px;align-items:flex-start;background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:12px 18px}
.k{flex:0 0 150px;font-size:13px;font-weight:700;color:var(--ac);text-transform:uppercase;letter-spacing:1px;padding-top:3px}
.v{flex:1;font-size:16px;line-height:1.45;font-family:'Cascadia Mono','Consolas',monospace;word-break:break-word}
.row.ok{border-color:#1f6f3f}.row.ok .k{color:var(--gn)}
.imgwrap{flex:1;display:flex;align-items:center;justify-content:center}
.imgwrap img{max-width:100%;max-height:470px;border:1px solid var(--bd);border-radius:10px}
footer{padding:10px 44px 16px;font-size:13px;color:var(--dim);display:flex;justify-content:space-between;border-top:1px solid var(--bd)}
.sxs{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto auto 1fr auto;gap:8px 16px;min-height:0}
.lbl{font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.l-r{color:#3fb950}.l-m{color:#FF6B8A}
.zoom{border:2px solid #30363d;border-radius:10px;background:#0b0f14;display:flex;align-items:center;justify-content:center;padding:6px;height:120px}
.zoom img{max-height:106px;max-width:100%;object-fit:contain}
.box{border:2px solid #30363d;border-radius:10px;overflow:hidden;background:#0b0f14;display:flex;align-items:center;justify-content:center;min-height:0}
.box img{width:100%;object-fit:contain}
.note{font-size:13px;color:#8b949e;font-family:'Cascadia Mono',Consolas,monospace}
`;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const S=[
 {id:'00',t:'QA #6459 · Detección de turnos huérfanos del Commander',sub:'PR #6538 @ decab5637 · modo structural con preflight visual · rebote de infraestructura (watchdog)',f:[
  ['Rebote','motivo_rechazo = "[qa] Timeout de watchdog: excedió 45 minutos sin terminar" ⇒ NO es un defecto del código'],
  ['HEAD','git merge-base --is-ancestor origin/main HEAD ⇒ HEAD contiene origin/main (e44b77c81)'],
  ['Alcance','CA-1..CA-15 verificados de nuevo en ESTA pasada']]},
 {id:'01',t:'Suite de tests · ejecutada en esta pasada',sub:'node --test sobre las 4 suites que exige el issue',f:[
  ['Comando','node --test orphan-sweep.test.js request-classify.test.js result-badge.test.js commander-inflight-fallback.test.js'],
  ['Observado','tests 130 | pass 130 | fail 0 | duration_ms 2336.78']]},
 {id:'02',t:'CA-1 a CA-4 · marca, evento terminal y append-only',sub:'Evidencia: suites orphan-sweep + request-classify + commander-inflight-fallback',f:[
  ['CA-1 cumple','B-10: transcripción sin resultado, sin saliente, boot viejo ⇒ HUERFANO. Enum RESULTADOS suma el 5º valor.'],
  ['CA-2 cumple','entrega NO confirmada ⇒ fallback_delivery_resolved fallido con error_code "delivered=false" ≠ empty_output'],
  ['CA-3 cumple','entrega confirmada ⇒ éxito, sin regresión de #4309; sin campos nuevos el desenlace queda null, nunca false'],
  ['CA-4 cumple','evento NUEVO sin tocar el anterior; audit-log.appendChained sigue verificando']]},
 {id:'03',t:'CA-5 a CA-8 · guardas, fuente de verdad y ventana',sub:'Evidencia: suite orphan-sweep (33 tests) + wiring real en pulpo.js',f:[
  ['CA-5 cumple','B-06/B-06b: boot_id == PULPO_BOOT_ID ⇒ NO_EVALUABLE. Guarda por boot_id, no por reloj.'],
  ['CA-6 cumple','B-09: early-return CON resultado y SIN envío ⇒ SANO, cero eventos'],
  ['CA-7 cumple','T-SEC0/B-13/B-14: el veredicto sale de commanderOutboundStatus; la etapa envío sólo aporta correlation_id'],
  ['CA-8 cumple','T-CA8: el archivo fuera de la ventana de 48 h NO se abre; la decisión sale del epochms del nombre']]},
 {id:'04',t:'CA-9 · el badge se ve RENDERIZANDO el dashboard',sub:'Captura tomada en esta pasada · CSS real + design-tokens reales + funciones extraídas verbatim de dashboard.js',img:'render.png'},
 {id:'05',t:'CA-13 · render real vs mockup acordado (BLOQUEANTE)',sxs:1,sub:''},
 {id:'06',t:'CA-10 a CA-15 · cierre',sub:'Sin defectos. 15 de 15 criterios cumplen.',f:[
  ['CA-10 cumple','integración: sano + huérfano + fuera de ventana + en vuelo ⇒ exactamente 1 detección'],
  ['CA-11 cumple','T-CA11: N barridos sobre el mismo sustrato ⇒ 1 sola entrada por commander_req_id'],
  ['CA-12 cumple','ORPHAN_SWEEP_EVERY_TICKS = 10 gateado en el loop + boot hook una sola vez; T-CA12 ⇒ ⌊M/10⌋'],
  ['CA-14 cumple','T-CA14/b/c: excepción, logDir ausente e historial ilegible dejan rastro con la causa y no propagan'],
  ['CA-15 cumple','ramas B-01..B-14 enumeradas en orphan-sweep.js, cada una con su test homónimo']]},
];
const files=[];
S.forEach((s,i)=>{
 let body;
 if(s.img) body=`<div class="imgwrap"><img src="${s.img}"></div>`;
 else if(s.sxs) body=`<div class="sxs">
<div class="lbl l-r">Render real · dashboard.js (esta pasada)</div>
<div class="lbl l-m">Mockup acordado · mockups/6440/02-dashboard-badge-huerfano.svg</div>
<div class="zoom"><img src="crop-render-badge.png"></div>
<div class="zoom"><img src="crop-mockup-badge.png"></div>
<div class="box"><img src="render.png"></div>
<div class="box"><img src="mockup.png"></div>
<div class="note">muestreo ffmpeg: texto #FF6B8A · borde #B8254A · fondo #3B2732</div>
<div class="note">SVG del mockup: #FF6B8A x9 · #B8254A x4 &nbsp;|&nbsp; badge error: #8B1A14</div></div>`;
 else body=s.f.map(([k,v])=>`<div class="row${/cumple|observado/i.test(k)?' ok':''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('\n');
 const th=esc(s.t).replace(/^(CA-\d+)/,'<span class="ca">$1</span>');
 const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>${CSS}</style></head><body>
<header><h1>${th}</h1><div class="sub">${esc(s.sub)}</div></header><main>${body}</main>
<footer><span>QA · Intrale · issue #6459 · PR #6538 @ decab5637 · rev 3</span><span>${i+1} / ${S.length}</span></footer></body></html>`;
 const f=path.join(OUT,`s-${s.id}.html`);fs.writeFileSync(f,html);files.push(`s-${s.id}`);
});
fs.writeFileSync(path.join(OUT,'slides.json'),JSON.stringify(files));
console.log('slides:',files.join(' '));

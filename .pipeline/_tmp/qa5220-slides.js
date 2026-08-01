const fs=require('fs'),path=require('path');
const EV='C:/Workspaces/Intrale/platform.agent-5220-pipeline-dev/qa/evidence/5220';
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const CSS=`body{margin:0;background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;width:1920px;height:1080px;overflow:hidden}
.h{padding:26px 44px 10px}.h1{font-size:36px;font-weight:700;color:#58a6ff;margin:0}
.h2{font-size:19px;color:#8b949e;margin:6px 0 0}
pre{margin:0 44px;padding:20px 24px;background:#010409;border:1px solid #30363d;border-radius:10px;
    font-family:'Cascadia Mono','Consolas',monospace;font-size:19px;line-height:1.5;color:#c9d1d9;white-space:pre-wrap}
.ok{color:#7ee787;font-weight:700}.bad{color:#ff7b72;font-weight:700}.wrn{color:#e3b341;font-weight:700}.dim{color:#6e7681}
.badge{display:inline-block;padding:5px 15px;border-radius:20px;font-size:17px;font-weight:700;margin-left:12px}
.bok{background:#238636;color:#fff}.bbad{background:#da3633;color:#fff}
.foot{position:absolute;bottom:26px;left:44px;right:44px;color:#6e7681;font-size:17px;
      border-top:1px solid #21262d;padding-top:12px}`;
const color=t=>esc(t)
  .replace(/(CUMPLE|OK\b|-&gt; CA-[0-9.]+ CUMPLE|pass 72|fail 0|52 \/ 52|13 \/ 13|= 0\b|SUBCADENAS_8_FILTRADAS=0|TOTAL_SUBCADENAS_FILTRADAS = 0)/g,'<span class="ok">$1</span>')
  .replace(/(FAIL 1|FALLA|AssertionError|x purgeFindings)/g,'<span class="bad">$1</span>')
  .replace(/(PENDIENTE|EXIT[^\n]*= 4|exit 4)/g,'<span class="wrn">$1</span>')
  .replace(/^(\$ #[^\n]*)$/gm,'<span class="dim">$1</span>');
const page=(t,s,body,foot)=>`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="h"><p class="h1">${t}</p><p class="h2">${s}</p></div>${body}<div class="foot">${foot}</div></body></html>`;
const term=f=>`<pre>${color(fs.readFileSync(path.join(EV,f),'utf8').trim())}</pre>`;

const slides=[
 ['s1-portada.html', page('QA · issue #5220 — verificación pasada 3 <span class="badge bok">APROBADO</span>',
   'Barrer y purgar secretos filtrados en copias .claude/ de worktrees abandonados · PR #5277 · HEAD bc7abe970 · modo structural + gate visual',
   `<pre><span class="dim">Por qué hay una pasada 3</span>
  La pasada 2 aprobó sobre <b>7bfa4e3e1</b>. Después la fase <b>aprobacion</b> rebotó:
  la review rev-1 encontró <span class="bad">2 defectos bloqueantes</span>.
  El dev los corrigió en <b>bc7abe970</b>. Ese es el HEAD que se verifica acá.

  <span class="bad">BLOQUEANTE 1</span>  purgeFindings iteraba por hallazgo pero unlink borra el ARCHIVO entero.
                13 archivos x 4 credenciales -> el 1er hallazgo borraba, los otros 3 daban ENOENT.
                Reporte: "0/13 eliminados" tras una purga que limpió el 100%. exit 2 en vez de 0.

  <span class="bad">BLOQUEANTE 2</span>  el test de CA-3 era tautológico: armaba el hallazgo a mano con los campos
                ya sabidos seguros. El valor sintético nunca entraba a fmtReport.
                No podía fallar para NINGUNA implementación.

  <span class="dim">Nada se recicló de la pasada anterior: se volvió a ejecutar todo sobre el HEAD nuevo.</span></pre>`,
   'QA Intrale · Nacho (edge/es-AR) · 2026-08-01')],
 ['s2-bloq1.html', page('BLOQUEANTE 1 — purga por archivo <span class="badge bok">CORREGIDO</span>',
   'Reproducción sobre el disco real con fsImpl inyectado. Ningún archivo real se borró.',
   term('ev-bloqueante1.txt'),
   'antes: 13/52 removed=true · 39 skipped ENOENT · exit 2 (PURGABLE_PENDING) — ahora: 52/52 · 0 skipped · exit 0 (CLEAN)')],
 ['s3-mutacion.html', page('BLOQUEANTE 2 — el test ya no es complaciente <span class="badge bok">CORREGIDO</span>',
   'No alcanza con leer el test nuevo: se rompe el invariante a propósito en 3 puntos y se exige que la suite falle.',
   term('ev-mutacion.txt'),
   'las 3 mutaciones matan un test · árbol restaurado byte a byte · 72/72 en verde')],
 ['s4-ca3.html', page('CA-3 — ningún valor de credencial en la salida <span class="badge bok">CUMPLE</span>',
   'Verificado contra las 6 credenciales REALES en disco (incluidas las 2 generaciones de cada una de Google), no contra sintéticas.',
   term('ev-ca3.txt'),
   'se buscó CADA subcadena de 8+ chars de cada valor en las 459 líneas del reporte · 0 filtraciones · los hash8 sí aparecen: identificar sin revelar')],
 ['s5-ca2b.html', page('CA-2.b — un worktree nuevo no recibe credenciales <span class="badge bok">CUMPLE</span>',
   'Se ejercita el bloque real de copia, no se inspecciona el código.',
   term('ev-ca2b.txt'),
   'allowlist deny-by-default · cli-branch.js:87 (cpSync filter) + dev-functions.sh:107-131 (espejo del criterio)')],
 ['s7-veredicto.html', page('Veredicto <span class="badge bok">APROBADO</span> — pero la exposición NO queda cerrada',
   'Se aprueba la HERRAMIENTA de detección. La remediación real vive en #5322.',
   `<pre>  <span class="ok">CUMPLE</span>   CA-1  tres categorías con conteo separado — 13 ROTAR / 419 REVISAR / 52 PURGAR
  <span class="ok">CUMPLE</span>   CA-2  allowlist deny-by-default · worktree nuevo barrido: 0 credenciales
  <span class="ok">CUMPLE</span>   CA-3  0 subcadenas de 8 chars filtradas sobre 6 credenciales reales
  <span class="ok">CUMPLE</span>   CA-4  git status antes/después del barrido: sin diferencias
  <span class="ok">CUMPLE</span>   CA-5  419 no-verificables como categoría propia · exit 4, nunca 0
  <span class="ok">CUMPLE</span>   CA-6  0 ocurrencias de "Sistema sano" con 484 hallazgos
  <span class="bad">FALLA</span>    CA-7  <span class="wrn">rotación PENDIENTE · nada purgado · secret-rotations.json no existe</span>
  <span class="ok">CUMPLE</span>   CA-8  1445 ms (techo 5 s) · detrás del flag --secrets
  <span class="ok">CUMPLE</span>   CA-9  purga por archivo · isForbiddenTarget · 0 removeWorktree / 0 rmSync
  <span class="ok">CUMPLE</span>   CA-10 72/72 tests · las 5 cadenas con forma de secreto del diff son sintéticas y viven en __tests__/
  <span class="ok">CUMPLE</span>   UX-1..UX-7 + gate visual: <b>13/13 reglas del mockup 46 · 0 divergencias bloqueantes</b>

  <span class="wrn">CA-7 se aprueba en falla por descope explícito del PO.</span> Los 52 purgables y los 13 por
  historial <b>siguen en disco</b>; el token sha8 760e3f4b sigue vivo. El código reporta ese
  estado con honestidad (exit 4). El PR usa <b>Refs</b>, no Closes: el merge no cierra el issue.</pre>`,
   'La exposición de credenciales NO está cerrada · remediación: #5322 · cosmético: #5327 · UX-3 Telegram: #5328')],
];
for(const [f,h] of slides) fs.writeFileSync(path.join(EV,f),h);
console.log('slides HTML generadas:', slides.length);

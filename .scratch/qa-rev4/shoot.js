'use strict';
// QA rev4 #6459 — prepara la captura del HTML SERVIDO por el dashboard real.
// NO toca markup ni CSS: sólo appendea un <script> que abre los <details>
// (equivale a que el operador haga clic en la sección "Actividad Commander")
// y recorta el viewport a la tarjeta de "Logs recientes".
const fs = require('fs');
const path = require('path');
const D = __dirname;
const src = fs.readFileSync(path.join(D, 'real-dash-legacy.html'), 'utf8');

const INJECT = `
<script id="qa-rev4-open-details">
document.addEventListener('DOMContentLoaded', function () {
  // 1) abrir TODOS los <details> = clic del operador. No modifica nada más.
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });
  // 2) aislar la tarjeta de "Logs recientes" para que la captura sea legible.
  var box = document.querySelector('.commander-reqlogs');
  if (box) {
    var clone = box.cloneNode(true);
    var host = document.createElement('div');
    host.id = 'qa-rev4-shot';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:28px 32px;overflow:auto;background:var(--bg,#0d1117)';
    var h = document.createElement('div');
    h.style.cssText = 'font:600 15px/1.5 system-ui;color:var(--fg,#e6edf3);margin-bottom:14px';
    h.textContent = 'Dashboard real (/legacy) · Actividad Commander · Logs recientes — QA #6459 rev4';
    host.appendChild(h); host.appendChild(clone);
    document.body.appendChild(host);
  }
});
</script>
`;
const out = src + INJECT;
fs.writeFileSync(path.join(D, 'shot.html'), out, 'utf8');
console.log('shot.html = real-dash-legacy.html + ' + INJECT.length + ' bytes de <script> (solo abre <details> y clona la tarjeta)');
console.log('prefijo identico:', out.startsWith(src));
console.log('bytes originales:', src.length, '| bytes shot:', out.length);

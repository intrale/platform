'use strict';
// QA rev4 #6459 — appendea el mismo <script> de apertura de <details> a cualquier
// HTML servido. NO toca markup ni CSS del badge.
const fs = require('fs');
const path = require('path');
const [inFile, outFile, titulo] = process.argv.slice(2);
const src = fs.readFileSync(inFile, 'utf8');
const INJECT = `
<script id="qa-rev4-open-details">
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });
  var box = document.querySelector('.commander-reqlogs');
  if (box) {
    var clone = box.cloneNode(true);
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:28px 32px;overflow:auto;background:var(--bg,#0d1117)';
    var h = document.createElement('div');
    h.style.cssText = 'font:600 15px/1.5 system-ui;color:var(--fg,#e6edf3);margin-bottom:14px';
    h.textContent = ${JSON.stringify(titulo || 'QA #6459')};
    host.appendChild(h); host.appendChild(clone);
    document.body.appendChild(host);
  }
});
</script>
`;
fs.writeFileSync(outFile, src + INJECT, 'utf8');
console.log(path.basename(outFile), '=', src.length, '+', INJECT.length, 'bytes de <script>; prefijo intacto:', (src + INJECT).startsWith(src));

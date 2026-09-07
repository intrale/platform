'use strict';
// QA rev5 #6459 · UX-2 — hace INACCESIBLE design-tokens.css para el proceso del
// dashboard, sin tocar el repo. Ejercita la rama real de `loadDesignTokens()`
// que degrada a cadena vacía (dashboard.js:176-179).
const fs = require('fs');
const orig = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/assets/design-tokens.css')) {
    const e = new Error("ENOENT: no such file or directory, open '" + p + "'");
    e.code = 'ENOENT';
    throw e;
  }
  return orig.call(this, p, ...rest);
};
console.log('[qa-rev5] design-tokens.css bloqueado para este proceso (UX-2)');

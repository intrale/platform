// Helper de edición EOL-safe: normaliza a LF, aplica reemplazos exactos y
// restaura el EOL original. Uso interno del agente, no se commitea.
'use strict';
const fs = require('fs');

function patch(file, pairs) {
  const orig = fs.readFileSync(file, 'utf8');
  const crlf = orig.includes('\r\n');
  let s = crlf ? orig.replace(/\r\n/g, '\n') : orig;
  for (const [from, to] of pairs) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`${file}: el ancla aparece ${n} veces (esperaba 1):\n---\n${from.slice(0, 200)}\n---`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log(`OK ${file} (${pairs.length} reemplazo(s), EOL=${crlf ? 'CRLF' : 'LF'})`);
}

module.exports = { patch };

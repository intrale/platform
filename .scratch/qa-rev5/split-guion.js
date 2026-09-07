'use strict';
// El camino edge de textToSpeechEdge trunca a 5000 chars (multimedia.js:730).
// El guion tiene mas: lo parto en dos por limite de PARRAFO y genero dos mp3
// que despues concateno, para que la narracion NO quede cortada.
const fs = require('fs');
const path = require('path');
const EV = path.resolve(__dirname, '..', '..', 'qa', 'evidence', '6459');
const txt = fs.readFileSync(path.join(EV, 'qa-6459-guion.txt'), 'utf8');
const parrafos = txt.split(/\n\s*\n/).filter(p => p.trim());
let a = [], b = [], acc = 0;
const objetivo = Math.ceil(txt.length / 2);
for (const p of parrafos) {
  if (acc < objetivo && acc + p.length <= 4600) { a.push(p); acc += p.length + 2; }
  else b.push(p);
}
const p1 = a.join('\n\n') + '\n';
const p2 = b.join('\n\n') + '\n';
fs.writeFileSync(path.join(__dirname, 'guion-p1.txt'), p1, 'utf8');
fs.writeFileSync(path.join(__dirname, 'guion-p2.txt'), p2, 'utf8');
console.log('total chars =', txt.length, '| p1 =', p1.length, '| p2 =', p2.length);
console.log('ambos < 5000:', p1.length < 5000 && p2.length < 5000);
console.log('p1+p2 cubre el guion entero:', (p1.trim() + '\n\n' + p2.trim()).replace(/\s+/g, ' ') === txt.trim().replace(/\s+/g, ' '));

'use strict';
// CA-12 — el gateo por ticks, con la funcion REAL extraida de pulpo.js.
// CA-1  — camino rapido in-process del clasificador REAL.
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, '.pipeline/pulpo.js'), 'utf8');

const ini = src.indexOf('function orphanSweepGate(');
const fin = src.indexOf('\n}', ini) + 2;
const fnSrc = src.slice(ini, fin);
console.log('--- orphanSweepGate REAL (pulpo.js) ---');
console.log(fnSrc);
const gate = new Function('const ORPHAN_SWEEP_EVERY_TICKS=' + (src.match(/const ORPHAN_SWEEP_EVERY_TICKS\s*=\s*(\d+)/) || [])[1] + ';' + fnSrc + '; return orphanSweepGate;')();
console.log('ORPHAN_SWEEP_EVERY_TICKS declarado =', (src.match(/const ORPHAN_SWEEP_EVERY_TICKS\s*=\s*(\d+)/) || [])[1]);

for (const M of [9, 10, 25, 100, 137]) {
  let t = 0, disparos = 0;
  for (let i = 0; i < M; i++) { const r = gate(t); t = r.tick; if (r.due) disparos += 1; }
  console.log('M=' + M + ' ticks => disparos=' + disparos + ' | floor(M/10)=' + Math.floor(M / 10) + ' | ' + (disparos === Math.floor(M / 10) ? 'OK' : 'MISMATCH'));
}

// Punto de wiring: ¿el tick del mainLoop pasa por el gate?
const wiring = src.split('\n').map((l, i) => ({ n: i + 1, l }))
  .filter(x => /orphanSweepGate|ejecutarBarridoHuerfanos|reconcileTelegramReceipts\(\)/.test(x.l));
console.log('\n--- puntos de wiring en pulpo.js ---');
wiring.forEach(x => console.log(x.n + ': ' + x.l.trim()));

console.log('\n--- CA-1: clasificador REAL con deliveryUnconfirmed ---');
const classify = require(path.join(ROOT, '.pipeline/lib/commander/request-classify.js'));
console.log('RESULTADOS =', JSON.stringify(classify.RESULTADOS));
const casos = [
  ['respuesta producida + saliente NO registrado', { deliveryUnconfirmed: true }],
  ['ademas fallo el turno (error gana)', { deliveryUnconfirmed: true, hadError: true }],
  ['turno normal sin el flag (back-compat)', {}],
  ['turno ok con entrega', { deliveryUnconfirmed: false }],
];
for (const [nombre, args] of casos) {
  const r = classify.classifyCommanderResult(Object.assign({ provider: 'anthropic' }, args));
  console.log(' ' + nombre + ' => resultado=' + JSON.stringify(r.resultado));
}

console.log('\n--- badge REAL ---');
const badge = require(path.join(ROOT, '.pipeline/lib/commander/result-badge.js'));
console.log(badge.renderResultBadge ? badge.renderResultBadge({ resultado: 'huerfano' }) : JSON.stringify(Object.keys(badge)));

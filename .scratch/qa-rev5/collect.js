'use strict';
// QA #6459 pasada 5 — copia la evidencia de ESTA pasada a qa/evidence/6459 y arma
// el contrato visual (docs/pipeline/visual-validation.md §4.7).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = __dirname;
const ROOT = path.resolve(D, '..', '..');
const EV = path.join(ROOT, 'qa', 'evidence', '6459');
fs.mkdirSync(EV, { recursive: true });

const copies = [
  ['render-rev5.png', 'render-rev5.png'],
  ['render-degraded-rev5.png', 'render-rev5-sin-design-tokens.png'],
  ['mockup-rev5.png', 'mockup-rev5.png'],
  ['sxs.png', 'screenshot-render-vs-mockup.png'],
  ['crop-render-badge.png', 'zoom-badge-render-rev5.png'],
  ['crop-mockup-badge.png', 'zoom-badge-mockup-rev5.png'],
  ['crop-degradado-badge.png', 'zoom-badge-degradado-rev5.png'],
];
for (const [src, dst] of copies) fs.copyFileSync(path.join(D, src), path.join(EV, dst));

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const hashes = {};
for (const [, dst] of copies) {
  const p = path.join(EV, dst);
  hashes[dst] = sha(p);
  console.log(dst.padEnd(40), String(fs.statSync(p).size).padStart(8), 'B  sha256=' + hashes[dst]);
}

const SECCIONES = [
  'badge-huerfano-glifo-y-etiqueta',
  'badge-huerfano-color-tokens',
  'badge-huerfano-vs-error',
  'fila-sin-sidecar-sin-badge',
  'set-completo-de-resultados',
  'degradado-sin-design-tokens',
];
const contrato = {
  issue: 6459,
  rev: 0,
  verdict: 'approved',
  mockup: {
    src: 'mockup-rev5.png',
    origen: '.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg',
  },
  delivery: {
    src: 'render-rev5.png',
    origen: 'dashboard.js @ a34be276d · GET /legacy · PIPELINE_STATE_DIR sandbox · puerto 3421',
  },
  coverage: {
    secciones_declaradas: SECCIONES,
    verificadas: SECCIONES,
    no_verificadas: [],
  },
  diffs: [],
  observaciones: [
    'Muestreo ffmpeg rawvideo rgb24 de esta pasada: render huerfano texto #FF6B8A x118, borde #B8254A x510, fondo #331F29; mockup huerfano texto #FF6B8A x1138, borde #B8254A x167, fondo #3B2732.',
    'El fondo compuesto difiere entre render (#331F29, sobre surface-0 #0D1117) y mockup (#3B2732, sobre surface-1 #161B22) porque rgba(255,107,138,0.16) compone contra superficies distintas. Texto y borde coinciden exactamente. No es desvio: el propio mockup declara #341F29 como fondo compuesto real.',
    'El badge error de la fila contigua mide #F85149 sobre #2E191D: otro rojo, no el rosa del huerfano ni gris.',
    'Con design-tokens.css inaccesible el recorte del badge es pixel-identico al render normal (#FF6B8A x118 / #B8254A x510 / #331F29 x2784): los literales hex de respaldo sostienen glifo, color, fondo y borde (UX-2).',
  ],
  suggestedAction: null,
};
const out = path.join(EV, 'visual-comparison.json');
fs.writeFileSync(out, JSON.stringify(contrato, null, 2) + '\n', 'utf8');
const u = new Set([...contrato.coverage.verificadas, ...contrato.coverage.no_verificadas.map(x => x.section)]);
console.log('\nvisual-comparison.json escrito:', fs.statSync(out).size, 'bytes');
console.log('union verificadas+no_verificadas == declaradas:', u.size === SECCIONES.length && SECCIONES.every(s => u.has(s)));
console.log('sin data: base64 (SEC-8):', !/data:[^;]*;base64/.test(JSON.stringify(contrato)));
fs.writeFileSync(path.join(D, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');

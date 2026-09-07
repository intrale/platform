'use strict';
// QA rev4 #6459 — copia la evidencia de ESTA pasada a qa/evidence/6459 y arma
// el contrato visual (docs/pipeline/visual-validation.md §4.7).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = __dirname;
const ROOT = path.resolve(D, '..', '..');
const EV = path.join(ROOT, 'qa', 'evidence', '6459');
fs.mkdirSync(EV, { recursive: true });

const copies = [
  ['render-rev4.png', 'render-rev4.png'],
  ['render-degraded-rev4.png', 'render-rev4-sin-design-tokens.png'],
  ['mockup-rev4.png', 'mockup-rev4.png'],
  ['sxs.png', 'screenshot-render-vs-mockup.png'],
  ['crop-render-badge.png', 'zoom-badge-render-rev4.png'],
  ['crop-mockup-badge.png', 'zoom-badge-mockup-rev4.png'],
];
for (const [src, dst] of copies) {
  fs.copyFileSync(path.join(D, src), path.join(EV, dst));
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const [, dst] of copies) {
  const p = path.join(EV, dst);
  console.log(dst.padEnd(38), String(fs.statSync(p).size).padStart(8), 'B  sha256=' + sha(p).slice(0, 16));
}

// --- contrato visual (§4.7) --------------------------------------------------
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
  rev: 4,
  verdict: 'approved',
  mockup: {
    src: 'mockup-rev4.png',
    origen: '.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg',
  },
  delivery: {
    src: 'render-rev4.png',
    origen: 'dashboard.js @ ae3c20e31 · GET /legacy · PIPELINE_STATE_DIR sandbox · puerto 3413',
  },
  coverage: {
    secciones_declaradas: SECCIONES,
    verificadas: SECCIONES,
    no_verificadas: [],
  },
  diffs: [],
  observaciones: [
    'El fondo compuesto difiere entre render (#331F29, sobre surface-0 #0D1117) y mockup (#3B2732, sobre surface-1 #161B22) porque rgba(255,107,138,0.16) compone contra superficies distintas. Texto (#FF6B8A) y borde (#B8254A) coinciden exactamente. No es desvio: el propio mockup declara #341F29 como fondo compuesto real.',
  ],
  suggestedAction: null,
};
const out = path.join(EV, 'visual-comparison.json');
fs.writeFileSync(out, JSON.stringify(contrato, null, 2) + '\n', 'utf8');
const u = new Set([...contrato.coverage.verificadas, ...contrato.coverage.no_verificadas.map(x => x.section)]);
console.log('\nvisual-comparison.json escrito:', fs.statSync(out).size, 'bytes');
console.log('union verificadas+no_verificadas == declaradas:', u.size === SECCIONES.length && SECCIONES.every(s => u.has(s)));
console.log('sin data: base64 (SEC-8):', !/data:[^;]*;base64/.test(JSON.stringify(contrato)));

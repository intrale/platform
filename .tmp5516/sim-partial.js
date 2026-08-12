const M = require('../.pipeline/lib/split-orphan-reconciler.js');
const mkIssue = (n, title, parentLabels = []) => ({
  number: n, title, state: 'open', user: { login: 'leitolarreta' },
  author_association: 'OWNER', labels: parentLabels.map((name) => ({ name })),
});
const corpus = [ mkIssue(5440, '[Split de #5340] Algo que hacer') ];

console.log('=== CICLO N: ola tiene el padre 5340, NO el hijo 5440 ===');
const cN = M.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111] });
console.log('orphans:', JSON.stringify(cN.orphans));
console.log('  -> paso 3/4 escribe #5440 en la OLA');
console.log('  -> paso 5 setPartialPause FALLA -> allowlist SIN 5440');
console.log('  -> WARN dice: "se reintenta el ciclo siguiente"');

console.log('\n=== CICLO N+1: ola YA tiene 5440, allowlist sigue sin el ===');
const cN1 = M.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111, 5440] });
console.log('orphans:', JSON.stringify(cN1.orphans));
console.log('  -> longitud:', cN1.orphans.length);
if (cN1.orphans.length === 0) {
  console.log('  *** CONFIRMADO: findSplitOrphans devuelve [] ***');
  console.log('  *** wire-up hace early return "no_orphans" ANTES del paso 5 ***');
  console.log('  *** LA ALLOWLIST NUNCA SE REINTENTA -> el WARN miente ***');
} else {
  console.log('  *** REFUTADO: todavia hay orphans, la brecha se reintentaria ***');
}
console.log('\nESTADO PERSISTENTE: ola=[5340,1111,5440]  allowlist=[5340,1111]');
console.log('  -> divergencia REDUCTIVA permanente');

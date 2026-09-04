const M = require('../.pipeline/lib/split-orphan-reconciler.js');
const mk = (n, title, labels = []) => ({
  number: n, title, state: 'open', user: { login: 'leitolarreta' },
  author_association: 'OWNER', labels: labels.map((name) => ({ name })),
});
const corpus = [ mk(5440, '[Split de #5340] Algo que hacer') ];

console.log('=== CICLO N: descubrimiento ===');
const cN = M.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111] });
console.log('orphans:', JSON.stringify(cN.orphans));
console.log('  paso 3 OK -> ola=[5340,1111,5440]');
console.log('  paso 5 FALLA -> allowlist=[5340,1111]');

console.log('\n=== CICLO N+1 (CON EL FIX SO-9): la ola ya lo tiene ===');
const orph = M.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111, 5440] });
console.log('findSplitOrphans.orphans:', JSON.stringify(orph.orphans), '(sigue vacio, correcto)');
const gap = M.splitChildrenMissingFromAllowlist({
  issues: corpus, waveIssues: [5340, 1111, 5440], allowlistIssues: [5340, 1111],
});
console.log('splitChildrenMissingFromAllowlist.missing:', JSON.stringify(gap.missing));
if (gap.missing.includes(5440)) {
  console.log('  *** BRECHA DETECTADA -> el paso 5 escribe allowlist=[1111,5340,5440] ***');
} else { console.log('  *** FALLO: la brecha no se detecta ***'); }

console.log('\n=== CICLO N+2: todo en sync -> idempotente ===');
const g2 = M.splitChildrenMissingFromAllowlist({
  issues: corpus, waveIssues: [5340, 1111, 5440], allowlistIssues: [5340, 1111, 5440],
});
console.log('missing:', JSON.stringify(g2.missing), g2.missing.length === 0 ? '-> SIN escrituras ni notificacion' : '-> FALLO');

console.log('\n=== SO-8 sigue vigente en la convergencia (needs-human en la ola) ===');
const blocked = [ mk(5426, '[Split de #5339] Frenado', ['needs-human']) ];
const g3 = M.splitChildrenMissingFromAllowlist({
  issues: blocked, waveIssues: [5339, 5426], allowlistIssues: [5339],
});
console.log('missing:', JSON.stringify(g3.missing), '| rejectedByLabel:', JSON.stringify(g3.rejectedByLabel));
console.log(g3.missing.length === 0 ? '  -> NO se habilita para dispatch (gate #2653 respetado)' : '  -> FALLO');

console.log('\n=== SO-7: autor no confiable en la ola no entra a la allowlist ===');
const untrusted = [{ number: 6001, title: '[Split de #5340] Ajeno', state: 'open',
  user: { login: 'randomguy' }, author_association: 'NONE', labels: [] }];
const g4 = M.splitChildrenMissingFromAllowlist({
  issues: untrusted, waveIssues: [5340, 6001], allowlistIssues: [5340],
});
console.log('missing:', JSON.stringify(g4.missing), g4.missing.length === 0 ? '-> default-deny OK' : '-> FALLO');

console.log('\n=== no-hijo-de-split en la ola NO se toca (alcance acotado) ===');
const normal = [ mk(7001, 'Un issue normal sin titulo de split') ];
const g5 = M.splitChildrenMissingFromAllowlist({
  issues: normal, waveIssues: [5340, 7001], allowlistIssues: [5340],
});
console.log('missing:', JSON.stringify(g5.missing), g5.missing.length === 0 ? '-> OK, no se invade el realign general' : '-> FALLO');

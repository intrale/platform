const rt = require('../.pipeline/lib/repo-target');
const RE = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SUF = 'is%3Aissue+is%3Aopen+in%3Atitle+split';
function q(primary) {
  let repo = 'intrale/platform';
  if (typeof primary === 'string' && RE.test(primary.trim())) repo = primary.trim();
  return `repo%3A${repo.replace('/', '%2F')}+${SUF}`;
}
console.log('primary real:', JSON.stringify(rt.getPrimaryRepo()));
console.log('query real  :', q(rt.getPrimaryRepo()));
console.log('vieja hardc.: repo%3Aintrale%2Fplatform+is%3Aissue+is%3Aopen+in%3Atitle+split');
console.log('IDENTICAS   :', q(rt.getPrimaryRepo()) === 'repo%3Aintrale%2Fplatform+is%3Aissue+is%3Aopen+in%3Atitle+split');
console.log('\n-- entradas hostiles caen al fallback (sin inyectar nada) --');
for (const bad of ['a/b&x=1', 'a/b+is:private', '../../etc', 'a b/c', '"; rm -rf /', null, undefined, 42, 'sinbarra', 'a/b/c']) {
  console.log(String(bad).padEnd(18), '->', q(bad));
}

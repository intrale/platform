// #5864 SEC-2 — tests del guard de procedencia de PRs (lib/pr-provenance.js).
// Vector: repo PÚBLICO + rama predecible `agent/<issue>-<skill>` ⇒ un tercero
// forkea, crea esa rama en su fork y abre un PR contra `main`. Si ese PR cobra
// el `qa:passed` del issue, pasa el gate de QA del merge.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { checkPrProvenance, expectedHeadOwner, PR_PROVENANCE_FIELDS } = require('../lib/pr-provenance');

const BRANCH = 'agent/5864-pipeline-dev';
const legit = (over = {}) => ({
  number: 5900, headRefName: BRANCH, isCrossRepository: false,
  headRepositoryOwner: { login: 'intrale' }, ...over,
});

test('el PR legítimo del mismo repo y la rama esperada pasa', () => {
  assert.deepEqual(checkPrProvenance(legit(), { branch: BRANCH }), { ok: true });
});

test('el owner se compara sin distinguir mayúsculas', () => {
  const r = checkPrProvenance(legit({ headRepositoryOwner: { login: 'Intrale' } }), { branch: BRANCH });
  assert.equal(r.ok, true);
});

test('un PR de fork se rechaza aunque la rama coincida exactamente', () => {
  const r = checkPrProvenance(
    legit({ isCrossRepository: true, headRepositoryOwner: { login: 'atacante' } }),
    { branch: BRANCH },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pr_de_fork');
});

test('un head de otro owner se rechaza aun con isCrossRepository en false', () => {
  const r = checkPrProvenance(legit({ headRepositoryOwner: { login: 'atacante' } }), { branch: BRANCH });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pr_de_fork');
});

// Fail-closed: la AUSENCIA de dato nunca habilita la escritura.
for (const [caso, pr] of Object.entries({
  'objeto nulo': null,
  'objeto vacío': {},
  'sin isCrossRepository': legit({ isCrossRepository: undefined }),
  'isCrossRepository como string': legit({ isCrossRepository: 'false' }),
  'sin headRepositoryOwner': legit({ headRepositoryOwner: undefined }),
  'owner sin login': legit({ headRepositoryOwner: {} }),
  'sin headRefName': legit({ headRefName: undefined }),
})) {
  test(`fail-closed: ${caso} no habilita la escritura`, () => {
    const r = checkPrProvenance(pr, { branch: BRANCH });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'procedencia_desconocida', `reason inesperado: ${r.reason}`);
  });
}

test('un PR del mismo repo pero de otra rama no es el PR de este issue', () => {
  const r = checkPrProvenance(legit({ headRefName: 'agent/5864-otro-skill' }), { branch: BRANCH });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pr_rama_distinta');
});

test('sin branch declarado sólo se valida el repositorio', () => {
  assert.equal(checkPrProvenance(legit({ headRefName: 'cualquiera' }), {}).ok, true);
});

test('el owner esperado sale de `owner/repo` y default a intrale', () => {
  assert.equal(expectedHeadOwner('intrale/platform'), 'intrale');
  assert.equal(expectedHeadOwner('Otro/Repo'), 'otro');
  assert.equal(expectedHeadOwner(undefined), 'intrale');
  assert.equal(expectedHeadOwner(''), 'intrale');
});

test('los campos pedidos a gh incluyen todo lo que el guard necesita', () => {
  for (const f of ['headRefName', 'isCrossRepository', 'headRepositoryOwner', 'labels', 'number']) {
    assert.ok(PR_PROVENANCE_FIELDS.includes(f), `falta ${f}`);
  }
});

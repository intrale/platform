const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROLES_DIR = path.resolve(__dirname, '..', '..', 'roles');
const qaRole = fs.readFileSync(path.join(ROLES_DIR, 'qa.md'), 'utf8');

test('QA estructural exige evidencia auditable y descriptor canonico en Drive', () => {
  assert.match(qaRole, /qa-<issue>-structural\.md/);
  assert.match(qaRole, /servicios\/drive\/pendiente\/qa-<issue>-structural-<ts>-NN\.json/);
  assert.match(qaRole, /"mode": "structural"/);
  assert.match(qaRole, /"source": "qa-structural"/);
});

// #6145 — el rechazo de aprobación se produjo porque el rol instruía escribir el
// descriptor con un path RELATIVO: el agente corre con CWD = worktree, así que
// el JSON caía en una cola que el servicio Drive nunca lee. El contrato ahora
// obliga a pasar por el encolador, que ancla el destino en PIPELINE_REPO_ROOT.
test('el rol manda encolar por el CLI anclado y no por escritura directa relativa', () => {
  assert.match(qaRole, /scripts\/qa-evidence-enqueue\.js/);
  assert.match(qaRole, /PIPELINE_REPO_ROOT/);

  // Ninguna instrucción puede volver a redirigir un descriptor a un path
  // relativo: eso es exactamente lo que lo vara en el worktree.
  const redireccionRelativa = />\s*\.pipeline\/servicios\/drive\/pendiente\//;
  assert.doesNotMatch(
    qaRole,
    redireccionRelativa,
    'el rol no debe instruir escribir el descriptor a un path relativo',
  );
});

test('el rol exige verdict, passed, total y head en el descriptor', () => {
  for (const campo of ['verdict', 'passed', 'total', 'head']) {
    assert.match(
      qaRole,
      new RegExp(`--${campo}\\b|\`${campo}\``),
      `el rol debe exigir el campo ${campo} en el descriptor`,
    );
  }
});

test('el CLI y el modulo de encolado existen y exponen el contrato que el rol promete', () => {
  const cli = path.resolve(__dirname, '..', '..', 'scripts', 'qa-evidence-enqueue.js');
  assert.ok(fs.existsSync(cli), `falta el CLI ${cli} que el rol qa.md manda ejecutar`);

  const lib = require('../qa-evidence-enqueue');
  assert.equal(typeof lib.enqueueStructuralEvidence, 'function');
  assert.equal(typeof lib.rescueStrandedDescriptors, 'function');
  assert.equal(lib.REQUIRED_MODE, 'structural');
  assert.equal(lib.REQUIRED_SOURCE, 'qa-structural');
});

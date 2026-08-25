/**
 * Test estructural del workflow .github/workflows/pr-checks.yml (#6362).
 *
 * Contexto: el diff original de este issue elimino el bloque
 * `permissions: { contents: write }` del job `e2e-qa` sin reemplazarlo. Como el
 * default del repositorio esta en `write` sobre todos los scopes (y con
 * aprobacion de PRs habilitada), borrar el bloque NO baja el privilegio: lo
 * sube. `e2e-qa` compila y ejecuta codigo del PR (./gradlew, plugins Gradle,
 * dependencias transitivas), asi que ese privilegio heredado es un vector de
 * Poisoned Pipeline Execution (OWASP A01 / CICD-SEC-4).
 *
 * Estos tests parsean el YAML (NO hacen match de texto) para que la mitigacion
 * no se vuelva a perder en silencio ante un refactor del workflow.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'pr-checks.yml');

function cargarWorkflow() {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const doc = yaml.load(raw);
  assert.ok(doc && typeof doc === 'object', 'pr-checks.yml no parsea como objeto YAML');
  return doc;
}

/**
 * Normaliza el valor de `permissions` de GitHub Actions a un mapa scope->nivel.
 * Acepta las tres formas validas: mapa, el string 'read-all' y el string
 * 'write-all'. Devuelve null si no hay bloque declarado.
 */
function normalizarPermissions(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === 'string') {
    if (valor === 'read-all') return { __all__: 'read' };
    if (valor === 'write-all') return { __all__: 'write' };
    return { __all__: valor };
  }
  if (typeof valor === 'object') return valor;
  return null;
}

/** Devuelve los pares [scope, nivel] que otorgan escritura. */
function scopesConEscritura(permisos) {
  return Object.entries(permisos).filter(([, nivel]) => String(nivel).trim() === 'write');
}

// Documento parseado una sola vez, usado por la cobertura preexistente.
const workflow = cargarWorkflow();

// -- Cobertura preexistente del workflow (puerto, disparo de e2e-qa, evidencia) --
test('e2e-qa inicia users en un puerto no privilegiado y usa la misma URL', () => {
  const steps = workflow.jobs['e2e-qa'].steps;
  const startBackend = steps.find((step) => step.name === 'Start backend');
  const runQa = steps.find((step) => step.name === 'Run E2E QA tests');

  assert.ok(startBackend, 'falta el step Start backend');
  assert.ok(runQa, 'falta el step Run E2E QA tests');

  const port = Number(startBackend.env.PORT);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, `puerto E2E invalido: ${port}`);
  assert.match(startBackend.run, new RegExp(`http://localhost:${port}/intrale/signin`));
  assert.equal(runQa.env.QA_BASE_URL, `http://localhost:${port}`);
});

test('e2e-qa se dispara solo por los cambios detectados, sin bypass por label', () => {
  const condition = workflow.jobs['e2e-qa'].if;

  // El gate de QA no se puede desactivar declarando un label en el propio PR:
  // qa:skipped es una decision de proceso, no un interruptor del workflow (#6362).
  assert.doesNotMatch(condition, /qa:skipped/);
  assert.doesNotMatch(condition, /github\.event\.pull_request\.labels/);

  assert.match(condition, /needs\.detect-changes\.outputs\.backend == 'true'/);
  assert.match(condition, /needs\.detect-changes\.outputs\.users == 'true'/);
  assert.match(condition, /needs\.detect-changes\.outputs\.shared == 'true'/);
});

test('e2e-qa publica evidencia como artefacto sin escribir en la rama del PR', () => {
  const job = workflow.jobs['e2e-qa'];
  const collect = job.steps.find((step) => step.name === 'Collect QA evidence');
  const upload = job.steps.find((step) => step.name === 'Upload collected QA evidence');
  const commands = job.steps.map((step) => step.run || '').join('\n');

  assert.ok(collect, 'falta recolectar la evidencia');
  assert.equal(collect.run, 'bash qa/scripts/collect-evidence.sh');
  assert.ok(upload, 'falta publicar la evidencia como artefacto');
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  assert.equal(upload.with.path, 'qa/evidence/');
  assert.doesNotMatch(commands, /git\s+(?:add|commit|push)\b/);
  // e2e-qa no debe declarar escritura propia. Que herede del bloque raiz esta
  // bien SOLO porque ese bloque es 'contents: read' (validado mas abajo, #6362).
  assert.deepEqual(scopesConEscritura(normalizarPermissions(job.permissions) || {}), []);
});

// -- Privilegio minimo del workflow (#6362) ------------------------------
test('pr-checks.yml declara un bloque permissions a nivel raiz', () => {
  const wf = cargarWorkflow();
  const permisos = normalizarPermissions(wf.permissions);
  assert.ok(
    permisos !== null,
    'pr-checks.yml no declara `permissions` a nivel raiz: los jobs heredan el default ' +
      'del repositorio (write en todos los scopes). Declarar `permissions: { contents: read }`.'
  );
});

test('ningun scope del workflow raiz queda en write', () => {
  const wf = cargarWorkflow();
  const permisos = normalizarPermissions(wf.permissions) || {};
  const conEscritura = scopesConEscritura(permisos);
  assert.deepStrictEqual(
    conEscritura,
    [],
    `permissions raiz otorga write en: ${conEscritura.map(([s]) => s).join(', ')}. ` +
      'Ningun job de pr-checks.yml usa GITHUB_TOKEN, no corresponde ningun scope en write.'
  );
});

test('el workflow raiz otorga contents: read', () => {
  const wf = cargarWorkflow();
  const permisos = normalizarPermissions(wf.permissions) || {};
  const nivel = permisos.contents !== undefined ? permisos.contents : permisos.__all__;
  assert.strictEqual(
    String(nivel),
    'read',
    '`contents` debe estar en read: es lo que necesitan los actions/checkout@v4.'
  );
});

test('el workflow raiz otorga pull-requests: read para dorny/paths-filter', () => {
  const wf = cargarWorkflow();
  const permisos = normalizarPermissions(wf.permissions) || {};

  // Declarar cualquier scope pone TODOS los no declarados en `none`. El job
  // `detect-changes` usa dorny/paths-filter@v3, que en eventos pull_request
  // lista los archivos modificados via REST API y hace setFailed ante un 403.
  // Como los 8 jobs dependen de detect-changes, dejar `pull-requests` sin
  // declarar voltea el workflow entero: el gate que protege main deja de correr.
  const nivel =
    permisos['pull-requests'] !== undefined ? permisos['pull-requests'] : permisos.__all__;
  assert.strictEqual(
    String(nivel),
    'read',
    '`pull-requests` debe estar en read: dorny/paths-filter@v3 lo exige en ' +
      'eventos pull_request y todos los jobs dependen de detect-changes.'
  );
});

test('detect-changes sigue usando dorny/paths-filter sin base explicito', () => {
  const wf = cargarWorkflow();
  const job = (wf.jobs || {})['detect-changes'];
  assert.ok(job, 'el job `detect-changes` ya no existe: revisar este test');

  const filtro = (job.steps || []).find(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('dorny/paths-filter@')
  );
  // Si el dia de manana se reemplaza la action o se pasa `base` + `token: ''`
  // (modo git, sin API), el scope `pull-requests: read` deja de ser necesario y
  // este test avisa que hay que revisar el bloque `permissions`.
  assert.ok(
    filtro,
    'detect-changes ya no usa dorny/paths-filter: revisar si sigue haciendo ' +
      'falta `pull-requests: read` en el bloque permissions raiz.'
  );
  assert.equal(
    (filtro.with || {}).token,
    undefined,
    'si se fuerza `token` vacio, paths-filter pasa a modo git y `pull-requests: read` sobra.'
  );
});

test('ningun job de pr-checks.yml escala permisos a write', () => {
  const wf = cargarWorkflow();
  const jobs = wf.jobs || {};
  assert.ok(Object.keys(jobs).length > 0, 'pr-checks.yml no declara jobs');

  const infractores = [];
  for (const [nombreJob, job] of Object.entries(jobs)) {
    const permisos = normalizarPermissions(job && job.permissions);
    if (permisos === null) continue; // hereda el bloque raiz, que ya esta validado
    for (const [scope] of scopesConEscritura(permisos)) {
      infractores.push(`${nombreJob}.${scope}`);
    }
  }

  assert.deepStrictEqual(
    infractores,
    [],
    `Jobs que escalan a write: ${infractores.join(', ')}. ` +
      'Un job que compila/ejecuta codigo del PR con token de escritura es Poisoned ' +
      'Pipeline Execution (CICD-SEC-4).'
  );
});

test('el job e2e-qa no recupera privilegios de escritura', () => {
  const wf = cargarWorkflow();
  const e2e = (wf.jobs || {})['e2e-qa'];
  assert.ok(e2e, 'el job `e2e-qa` ya no existe en pr-checks.yml: revisar este test');

  const permisos = normalizarPermissions(e2e.permissions);
  if (permisos === null) return; // hereda raiz (contents: read), que es lo esperado

  assert.deepStrictEqual(
    scopesConEscritura(permisos),
    [],
    'e2e-qa compila y ejecuta codigo arbitrario del PR (./gradlew, plugins, ' +
      'dependencias transitivas). No puede tener ningun scope en write.'
  );
});

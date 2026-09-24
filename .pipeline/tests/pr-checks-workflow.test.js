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

test('e2e-qa conserva el disparo ampliado de #6579 tras la resolucion del conflicto', () => {
  // El merge de main sobre esta rama choco justo en este `if:` (#6362). El
  // criterio de resolucion fue: gana la version de main, que es la mas amplia.
  // Sin `!cancelled()` el job se saltea cuando detect-changes queda skipped
  // (schedule / workflow_dispatch), que es el caso que #6579 vino a cubrir, y
  // un `skipped` se leeria como aprobado. Este test impide que un futuro
  // re-merge lo vuelva a angostar en silencio.
  const workflowOn = workflow.on || workflow[true];
  assert.ok(workflowOn.schedule, 'pr-checks.yml perdio el trigger schedule de #6579');
  assert.ok('workflow_dispatch' in workflowOn, 'pr-checks.yml perdio el trigger workflow_dispatch de #6579');

  const condition = workflow.jobs['e2e-qa'].if;
  assert.match(condition, /!cancelled\(\)/);
  assert.match(condition, /github\.event_name == 'schedule'/);
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
});

test('e2e-qa publica evidencia como artefacto sin escribir en la rama del PR', () => {
  const job = workflow.jobs['e2e-qa'];
  const collect = job.steps.find((step) => step.name === 'Collect QA evidence');
  const upload = job.steps.find((step) => step.name === 'Upload collected QA evidence');
  const commands = job.steps.map((step) => step.run || '').join('\n');

  assert.ok(collect, 'falta recolectar la evidencia');
  assert.equal(collect.run, 'bash qa/scripts/collect-evidence.sh');
  assert.ok(upload, 'falta publicar la evidencia como artefacto');
  // #6362: la accion se pinnea por SHA de 40 chars, no por tag mutable. Un tag
  // (@v4) puede ser re-apuntado en silencio por el owner de la accion, que es el
  // vector de los compromisos de trivy-action y kics-github-action. Semgrep
  // (github-actions-mutable-action-tag) bloquea el merge si esto se afloja.
  assert.match(
    upload.uses,
    /^actions\/upload-artifact@[0-9a-f]{40}$/,
    `el step de evidencia debe pinnear upload-artifact por SHA completo, no por tag mutable; encontrado: ${upload.uses}`
  );
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

// -- Gate de licencias de terceros (#7592) --------------------------------
test('check-licenses alimenta pr-status, que es el unico check requerido', () => {
  const wf = cargarWorkflow();
  const job = wf.jobs['check-licenses'];
  assert.ok(job, 'falta el job check-licenses');
  assert.ok(wf.jobs['pr-status'].needs.includes('check-licenses'), 'check-licenses no esta en pr-status.needs: no bloquearia nada');
  const verify = wf.jobs['pr-status'].steps.find((s) => s.name === 'Verify all checks passed');
  assert.match(verify.run, /classify "check-licenses"\s+"\$\{\{ needs\.check-licenses\.result \}\}"/);
});

test('check-licenses es bloqueante: sin continue-on-error ni en el job ni en sus steps', () => {
  const job = cargarWorkflow().jobs['check-licenses'];
  assert.equal(job['continue-on-error'], undefined);
  for (const step of job.steps) assert.equal(step['continue-on-error'], undefined, `step "${step.name}" con continue-on-error`);
});

test('check-licenses corre por cambios de dependencias y en el schedule diario', () => {
  const wf = cargarWorkflow();
  const cond = wf.jobs['check-licenses'].if;
  assert.match(cond, /!cancelled\(\)/);
  assert.match(cond, /github\.event_name == 'schedule'/);
  assert.match(cond, /needs\.detect-changes\.outputs\.deps == 'true'/);
  assert.ok(wf.jobs['detect-changes'].outputs.deps, 'detect-changes no expone el output deps');
  const filtro = wf.jobs['detect-changes'].steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter@'));
  const deps = yaml.load(filtro.with.filters).deps;
  for (const p of ['**/*.gradle.kts', 'gradle/libs.versions.toml', '**/package-lock.json', 'config/licenses/**', 'NOTICE', 'scripts/licenses/**']) {
    assert.ok(deps.includes(p), `el filtro deps no incluye ${p}`);
  }
});

test('check-licenses: actions pineadas por SHA, checkout sin credenciales y sin secrets', () => {
  const job = cargarWorkflow().jobs['check-licenses'];
  const usos = job.steps.filter((s) => s.uses);
  assert.ok(usos.length >= 4, 'se esperaban checkout, setup-java, setup-gradle y setup-node');
  for (const s of usos) assert.match(s.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${s.uses} no esta pineada por SHA de 40 hex`);
  const checkout = usos.find((s) => s.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 0);
  const raw = JSON.stringify(job);
  assert.doesNotMatch(raw, /secrets\./, 'check-licenses no puede usar secrets');
  assert.deepEqual(scopesConEscritura(normalizarPermissions(job.permissions) || {}), []);
});

test('el workflow no se dispara por labels: un evento de label no puede pisar un pr-status rojo', () => {
  const wf = cargarWorkflow();
  const workflowOn = wf.on || wf[true];
  assert.ok(!('pull_request_target' in workflowOn), 'pull_request_target corre codigo del PR con privilegios');
  const types = (workflowOn.pull_request && workflowOn.pull_request.types) || [];
  assert.ok(!types.includes('labeled') && !types.includes('unlabeled'),
    'con labeled, los jobs que se saltean por evento dejarian un pr-status verde sobre el mismo SHA');
});

test('el indice no tiene gitlinks huerfanos: rompen el checkout de check-licenses', () => {
  // actions/checkout con persist-credentials: false corre 'git submodule foreach'
  // al quitar la auth; un gitlink (modo 160000) sin entrada en .gitmodules aborta
  // con 'No url found for submodule path' (exit 128) y el job nunca arranca.
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..', '..');
  const salida = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const gitlinks = salida.split('\n').filter((l) => l.startsWith('160000 ')).map((l) => l.split('\t')[1]);
  const gitmodulesPath = path.join(root, '.gitmodules');
  const gitmodules = fs.existsSync(gitmodulesPath) ? fs.readFileSync(gitmodulesPath, 'utf8') : '';
  const huerfanos = gitlinks.filter((p) => !gitmodules.includes(`path = ${p}`));
  assert.deepStrictEqual(huerfanos, [], `gitlinks sin .gitmodules: ${huerfanos.join(', ')}`);
});

// -- Autoria del PR: trailer (#7632) --------------------------------------
const AUDIT_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'authorship-main-audit.yml');

function cargarAuditoria() {
  const doc = yaml.load(fs.readFileSync(AUDIT_PATH, 'utf8'));
  assert.ok(doc && typeof doc === 'object', 'authorship-main-audit.yml no parsea como objeto YAML');
  return doc;
}

function checkouts(job) {
  return (job.steps || []).filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
}

test('authorship-trailer: nombre visible, solo PRs agent/* y via pull_request', () => {
  const job = cargarWorkflow().jobs['authorship-trailer'];
  assert.ok(job, 'falta el job authorship-trailer');
  assert.strictEqual(job.name, 'Autoría del PR (trailer)');
  assert.strictEqual(job.if, "github.event_name == 'pull_request' && startsWith(github.head_ref, 'agent/')");
});

// CA-9.13
test('authorship-trailer: checkout de base_ref sin credenciales, sin head del PR ni npm install', () => {
  const job = cargarWorkflow().jobs['authorship-trailer'];
  const cos = checkouts(job);
  assert.strictEqual(cos.length, 1, 'un unico checkout: el de la base');
  assert.strictEqual(cos[0].with.ref, '${{ github.base_ref }}');
  assert.strictEqual(cos[0].with['persist-credentials'], false);
  assert.match(cos[0].uses, /^actions\/checkout@[0-9a-f]{40}$/);
  const raw = JSON.stringify(job);
  assert.doesNotMatch(raw, /pull_request\.head|head\.sha/, 'no puede hacer checkout del head del PR');
  const runs = job.steps.map((s) => s.run || '').join('\n');
  assert.doesNotMatch(runs, /\bnpm\b|\byarn\b|\bnpx\b/);
  assert.doesNotMatch(runs, /set\s+-x/);
  assert.match(runs, /node \.pipeline\/lib\/authorship\/cli\.js verify --pr "\$PR_NUMBER" --config \.pipeline\/config\.yaml/);
  assert.match(runs, /test -f|\[ ! -f \.pipeline\/lib\/authorship\/cli\.js \]/, 'falta el guard de bootstrap (base sin verificador)');
});

test('authorship-trailer: base sin cli.js → notice y exit 0 (script de bootstrap real)', { skip: process.platform === 'win32' && !process.env.SHELL }, () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const job = cargarWorkflow().jobs['authorship-trailer'];
  const step = job.steps.find((s) => s.run);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authorship-boot-'));
  try {
    const out = execFileSync('bash', ['-c', step.run], { cwd: tmp, encoding: 'utf8', env: { ...process.env, PR_NUMBER: '1' } });
    assert.match(out, /::notice title=Autoría del PR::El verificador no está disponible en la rama base; se omite\./);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// CA-9.14
test('authorship-trailer: permisos exactamente contents/pull-requests/issues en read', () => {
  const job = cargarWorkflow().jobs['authorship-trailer'];
  assert.deepStrictEqual(normalizarPermissions(job.permissions), {
    contents: 'read', 'pull-requests': 'read', issues: 'read',
  });
});

test('authorship-main-audit: push a main, solo contents: read, ningun write', () => {
  const wf = cargarAuditoria();
  const on = wf.on || wf[true];
  assert.deepStrictEqual(Object.keys(on), ['push']);
  assert.deepStrictEqual(on.push.branches, ['main']);
  assert.deepStrictEqual(normalizarPermissions(wf.permissions), { contents: 'read' });
  for (const [nombre, job] of Object.entries(wf.jobs)) {
    const permisos = normalizarPermissions(job.permissions) || {};
    assert.deepStrictEqual(scopesConEscritura(permisos), [], `${nombre} escala a write`);
    assert.deepStrictEqual(permisos, { contents: 'read' });
    for (const co of checkouts(job)) {
      assert.strictEqual(co.with['persist-credentials'], false);
      assert.match(co.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    }
    const runs = job.steps.map((s) => s.run || '').join('\n');
    assert.match(runs, /verify --commit "\$sha" --informative/);
    assert.doesNotMatch(runs, /\bnpm\b/);
  }
});

// CA-9.15 — acotado al job nuevo y a la auditoria: pr-status ya interpola
// needs.*.result en run: desde antes y queda fuera de alcance.
test('ningun run: del job authorship-trailer ni de authorship-main-audit.yml contiene ${{', () => {
  const infractores = [];
  const revisar = (origen, job) => {
    for (const s of job.steps || []) {
      if (typeof s.run === 'string' && s.run.includes('${{')) infractores.push(`${origen}/${s.name}`);
    }
  };
  revisar('pr-checks/authorship-trailer', cargarWorkflow().jobs['authorship-trailer']);
  for (const [nombre, job] of Object.entries(cargarAuditoria().jobs)) revisar(`authorship-main-audit/${nombre}`, job);
  assert.deepStrictEqual(infractores, []);
});

test('authorship-trailer: los datos del PR entran solo por env:', () => {
  const step = cargarWorkflow().jobs['authorship-trailer'].steps.find((s) => s.run);
  assert.deepStrictEqual(Object.keys(step.env).sort(), ['BASE_REF', 'GH_REPO', 'GH_TOKEN', 'HEAD_REF', 'PR_NUMBER']);
  assert.strictEqual(step.env.GH_TOKEN, '${{ github.token }}');
});

// CA-9.16
test('authorship-trailer esta en needs y en el classify de pr-status (por env, no interpolado)', () => {
  const wf = cargarWorkflow();
  assert.ok(wf.jobs['pr-status'].needs.includes('authorship-trailer'));
  const verify = wf.jobs['pr-status'].steps.find((s) => s.name === 'Verify all checks passed');
  assert.match(verify.run, /classify "authorship-trailer" "\$AUTHORSHIP_RESULT"/);
  assert.strictEqual(verify.env.AUTHORSHIP_RESULT, '${{ needs.authorship-trailer.result }}');
});

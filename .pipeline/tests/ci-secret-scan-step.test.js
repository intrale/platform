'use strict';

// #5244 CA-9 — el job `secret-scan` de security-sast.yml tiene que bloquear a un
// PR hostil que neutraliza el scanner en su propio diff. El test no reimplementa
// la lógica del step: extrae el bloque `run:` del yml y lo ejecuta tal cual, así
// no puede divergir de lo que realmente corre en GitHub Actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'security-sast.yml');
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW, 'utf8');

// Insumos de confianza que el job toma del árbol base.
const BASE_TREE_FILES = [
  '.pipeline/lib/precommit-secret-scan.js',
  '.pipeline/lib/secret-allowlist.js',
  '.pipeline/lib/secret-scan-lint.js',
  // El scanner deriva su inventario de paths sensibles de este modulo (#5551):
  // sin el, el arbol base no puede ejecutarlo y el escenario probaria otra cosa.
  '.pipeline/lib/sensitive-paths.js',
  '.pipeline/sanitizer.js',
  '.claude/hooks/telegram-sanitizer.js',
];

// Token sintético, partido para que el propio scanner no lo cace en este archivo.
const SYNTHETIC_TOKEN = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
// La clave también se arma en runtime: escrita literal, la dupla clave/valor con
// nombre de credencial la lee el sanitizer como config y este archivo dispararía
// su propio gate.
const SECRET_FIELD = ['to', 'ken'].join('');
const fixtureConSecreto = () => JSON.stringify({ [SECRET_FIELD]: SYNTHETIC_TOKEN });
const NEUTRALIZED_SCANNER = '#!/usr/bin/env node\n// PR hostil: el gate ya no mira nada.\nprocess.exit(0);\n';
const LEGACY_SCANNER = '#!/usr/bin/env node\n// Scanner previo a #5244: ignora los flags y sale 0.\nprocess.exit(0);\n';

const toPosix = (value) => value.replace(/\\/g, '/');

function resolveShell() {
  const candidates = [
    'sh', 'bash',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/sh.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ];
  for (const shell of candidates) {
    const probe = spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return shell;
  }
  throw new Error('no se encontró un shell POSIX para ejecutar el step del workflow');
}

// Extrae el escalar de bloque `run: |` del step pedido, ya des-indentado.
function extractRunBlock(stepName) {
  const lines = WORKFLOW_TEXT.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `no se encontró el step "${stepName}" en security-sast.yml`);
  let index = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
  assert.ok(index > start, `el step "${stepName}" no declara un bloque run: |`);
  const indent = lines[index].match(/^ */)[0].length + 2;
  const body = [];
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function writeFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function copyFromRepo(root, relative) {
  writeFile(root, relative, fs.readFileSync(path.join(REPO, relative)));
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-secret-scan-'));
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'pipeline@example.invalid']);
  git(directory, ['config', 'user.name', 'Pipeline Test']);
  return directory;
}

// Fragmento mínimo de workflow que declara el job: es el discriminante que usa
// el step para saber si el gate server-side ya está vigente en un árbol dado.
// Se escribe reducido a propósito — copiar el yml real metería SHAs de 40 chars
// en el diff del fixture y el escenario probaría otra cosa.
const WORKFLOW_CON_GATE = 'name: Security SAST\njobs:\n  secret-scan:\n    name: Secret scan (blocking)\n';
const WORKFLOW_SIN_GATE = 'name: Security SAST\njobs:\n  semgrep:\n    name: Semgrep\n';

// Ejecuta el step real del workflow con el entorno que provee GitHub Actions.
// `deciderTrusted` default '1' = la vía normal (merge commit efímero); los casos
// degradados lo pasan explícito para que el bloqueo se atribuya a esa causa.
function runWorkflowStep({ workspace, baseSha, headSha, deciderTrusted = '1' }) {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-step-')), 'step.sh');
  fs.writeFileSync(script, `${extractRunBlock('Secret scan del diff')}\n`);
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
  const result = spawnSync(resolveShell(), ['-e', toPosix(script)], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: toPosix(workspace),
      GITHUB_SHA: headSha,
      RUNNER_TEMP: toPosix(runnerTemp),
      BASE_SHA: baseSha,
      DECIDER_TRUSTED: deciderTrusted,
    },
  });
  return { ...result, salida: `${result.stdout || ''}${result.stderr || ''}` };
}

test('el step no depende de expresiones de Actions: es shell puro y ejecutable', () => {
  const block = extractRunBlock('Secret scan del diff');
  assert.ok(block.includes('node "$SCANNER"'), 'el step debe invocar el scanner resuelto en $SCANNER');
  assert.doesNotMatch(
    block,
    /\$\{\{/,
    'las expresiones ${{ }} deben ir en env: — si no, el step deja de ser verificable',
  );
});

test('CA-9: el scanner por defecto sale del árbol base y el head es sólo bootstrap', () => {
  const block = extractRunBlock('Secret scan del diff');
  const defaultAssignment = block.indexOf('SCANNER="$BASE_SCANNER"');
  const headAssignment = block.indexOf('SCANNER="$GITHUB_WORKSPACE/.pipeline/lib/precommit-secret-scan.js"');
  assert.ok(defaultAssignment >= 0, 'el scanner del árbol base debe ser el default');
  assert.ok(headAssignment > defaultAssignment, 'el scanner del head sólo puede aparecer como fallback');
  assert.match(block, /--capabilities/, 'sin probe de capacidades, un scanner viejo del base pasa por bueno');
  assert.match(block, /secret-scan-protocol=range-v1/);
  assert.match(block, /::warning::secret-scan bootstrap/, 'el bootstrap debe quedar declarado en el log');

  // #5244 rev-8 — el fail-closed de paths de control tiene que estar ANTES de
  // habilitar el scanner del head; si no, el bloqueo llega tarde.
  const failClosed = block.indexOf('CONTROL_HITS');
  assert.ok(failClosed >= 0, 'el bootstrap debe evaluar los paths de control');
  assert.ok(failClosed < headAssignment, 'el fail-closed debe evaluarse antes de tomar el scanner del head');
  for (const control of [
    '\\.pipeline/lib/\\[\\^/\\]\\*secret',
    '\\.pipeline/sanitizer\\\\\\.js',
    '\\.pipeline/secret-scan-allowlist\\\\\\.json',
    '\\.husky/pre-commit',
    '\\.github/workflows/security-sast\\\\\\.yml',
  ]) {
    assert.match(block, new RegExp(control), `falta el path de control ${control} en el fail-closed`);
  }
  assert.match(block, /exit 1/, 'el fail-closed tiene que cortar el step');

  // #5244 rev-9 — el fail-closed no puede ser incondicional: sin camino de alta
  // se bloquea a sí mismo (el PR que instala el gate toca paths de control por
  // definición). El discriminante es el JOB en el workflow base, no la mera
  // existencia del archivo scanner: .pipeline/lib/precommit-secret-scan.js ya
  // existe en main desde antes de este issue, así que `! -f "$BASE_SCANNER"`
  // nunca distinguiría el alta de la degradación.
  assert.match(block, /BASE_HAS_GATE/, 'sin discriminante de alta el gate queda en deadlock de bootstrap');
  assert.match(
    block,
    /grep -qE '\^ {2}secret-scan:\[\[:space:\]\]\*\$' "\$BASE_WORKFLOW"/,
    'el discriminante tiene que mirar el job en el workflow del árbol base',
  );
  assert.match(block, /BASE_HAS_GATE=1/, 'fail-closed sobre la lectura: sin `.base` legible se asume gate vigente');
  assert.match(block, /"\$DECIDER_TRUSTED" = "1"/, 'el alta exige un árbol base que el autor del PR no controle');
  assert.match(block, /"\$HEAD_HAS_GATE" = "1"/, 'el alta exige que el head instale el job de verdad');
  assert.match(
    block,
    /case "\$HEAD_CAPS" in \*secret-scan-protocol=range-v1\*\) ALTA=1/,
    'el alta exige que el scanner del head exponga el protocolo: un stub no la consigue',
  );
  assert.match(block, /::warning::secret-scan ALTA DEL CONTROL/, 'el alta tiene que quedar auditable en el log');

  // #5244 rev-8 — el árbol que decide sale del tip REAL de la base, no de la
  // merge-base declarada del PR (que el autor controla y deja en bootstrap).
  assert.match(
    WORKFLOW_TEXT,
    /ref: \$\{\{ steps\.base\.outputs\.decider \}\}/,
    'el checkout de `.base` debe usar el tip real de la rama base',
  );
  assert.doesNotMatch(
    WORKFLOW_TEXT,
    /ref: \$\{\{ steps\.base\.outputs\.sha \}\}/,
    'outputs.sha es la merge-base del PR: usarla como árbol que decide reabre el bypass de CA-9',
  );
  assert.match(block, /--sanitizer="\$BASE_TREE\/\.pipeline\/sanitizer\.js"/);
  assert.match(block, /BASE_ALLOWLIST="\$BASE_TREE\/\.pipeline\/secret-scan-allowlist\.json"/);
  assert.match(
    block,
    /printf '\{"paths":\[\],"globs":\[\]\}/,
    'la política bootstrap no puede exceptuar ningún path: sería un agujero permanente',
  );
  assert.match(WORKFLOW_TEXT, /secret-scan:\n(?:.*\n)*?\s+continue-on-error: false/);
});

test('CA-9: un PR que neutraliza el scanner en su propio diff queda BLOQUEADO', () => {
  const workspace = initRepo();
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base con el gate instalado']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);

  // El árbol base que checkoutea el workflow en `.base` (fuera del índice git).
  for (const relative of BASE_TREE_FILES) copyFromRepo(path.join(workspace, '.base'), relative);
  copyFromRepo(path.join(workspace, '.base'), '.pipeline/secret-scan-allowlist.json');

  // El PR hostil: apaga el scanner y mete el secreto en el mismo commit.
  writeFile(workspace, '.pipeline/lib/precommit-secret-scan.js', NEUTRALIZED_SCANNER);
  writeFile(workspace, '.claude/hooks/hostil-5244.json', fixtureConSecreto());
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'PR hostil: neutraliza el gate y agrega un secreto']);
  const headSha = git(workspace, ['rev-parse', 'HEAD']);

  // Control de que el escenario es el real: con el scanner del head, exit 0.
  const bypass = spawnSync(process.execPath, [
    path.join(workspace, '.pipeline', 'lib', 'precommit-secret-scan.js'),
    '--mode=range', `--base=${baseSha}`, `--head=${headSha}`, `--cwd=${toPosix(workspace)}`,
  ], { encoding: 'utf8' });
  assert.equal(bypass.status, 0, 'el scanner neutralizado del head debería pasar en verde');

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.equal(step.status, 1, `el step debía bloquear el PR hostil:\n${step.salida}`);
  assert.match(step.salida, /hostil-5244\.json/);
  assert.match(step.salida, /BLOQUEADO/);
  assert.match(step.salida, /\[REDACTED:GITHUB_TOKEN\]/);
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN), 'el valor crudo no puede filtrarse al log');
  assert.doesNotMatch(step.salida, /::warning::secret-scan bootstrap/, 'con base compatible no hay bootstrap');
});

// El árbol que el workflow checkoutea en `.base` cuando la base es anterior a
// este control: el scanner existe pero ignora los flags y sale 0 (sin protocolo).
// `conGate` decide si esa base ya declara el job `secret-scan`, que es lo que
// distingue "control vigente que se está degradando" de "control todavía sin dar
// de alta" (#5244 rev-9).
function baseTreeLegacy(workspace, { conGate = false } = {}) {
  const baseTree = path.join(workspace, '.base');
  writeFile(baseTree, '.pipeline/lib/precommit-secret-scan.js', LEGACY_SCANNER);
  copyFromRepo(baseTree, '.pipeline/sanitizer.js');
  copyFromRepo(baseTree, '.claude/hooks/telegram-sanitizer.js');
  writeFile(
    baseTree,
    '.github/workflows/security-sast.yml',
    conGate ? WORKFLOW_CON_GATE : WORKFLOW_SIN_GATE,
  );
  return baseTree;
}

// El PR que da de alta el control: instala scanner + módulos + allowlist y
// agrega el job al workflow. Es, por definición, un diff sobre paths de control.
function commitDeAlta(workspace, extras = {}) {
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  writeFile(workspace, '.github/workflows/security-sast.yml', WORKFLOW_CON_GATE);
  for (const [relative, content] of Object.entries(extras)) writeFile(workspace, relative, content);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'da de alta el control de secretos']);
  return git(workspace, ['rev-parse', 'HEAD']);
}

// ── #5244 rev-9 · el ALTA del control ───────────────────────────────────────
// rev-8 bloqueaba TODO bootstrap sobre paths de control y con eso se cerraba
// sobre el único PR que necesita la ventana: instalar el gate ES tocar paths de
// control, así que el PR se bloqueaba a sí mismo y el control no podía llegar
// nunca a la base. La suite quedaba verde porque codificaba ese bloqueo como
// invariante y ningún caso cubría el alta. Estos tests cubren el alta.

test('ALTA: base sin el job secret-scan y diff limpio ⇒ VERDE, declarado en el log', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previa al control']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace, { conGate: false });

  const headSha = commitDeAlta(workspace);

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.equal(step.status, 0, `el PR que da de alta el control debía poder mergear:\n${step.salida}`);
  assert.match(step.salida, /::warning::secret-scan ALTA DEL CONTROL/, 'el alta no puede ser silenciosa');
  assert.match(step.salida, /\.pipeline\/lib\/precommit-secret-scan\.js/, 'los paths de control quedan enumerados');
  assert.doesNotMatch(step.salida, /BLOQUEADO/);
});

test('ALTA: la ventana no afloja el gate — el secreto del propio diff sigue bloqueando', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previa al control']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace, { conGate: false });

  const headSha = commitDeAlta(workspace, { '.claude/hooks/bootstrap-5244.json': fixtureConSecreto() });

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.match(step.salida, /::warning::secret-scan ALTA DEL CONTROL/);
  assert.equal(step.status, 1, `el alta corre el scanner real y tiene que cazar el secreto:\n${step.salida}`);
  assert.match(step.salida, /bootstrap-5244\.json/);
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

test('DEGRADACIÓN: la base YA declara el job ⇒ FAIL-CLOSED, sin alta', () => {
  const workspace = initRepo();
  writeFile(workspace, '.github/workflows/security-sast.yml', WORKFLOW_CON_GATE);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base con el gate ya vigente']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  // El gate está vigente en la base pero su scanner no expone el protocolo:
  // este PR estaría bajando un control que ya existe.
  baseTreeLegacy(workspace, { conGate: true });

  const headSha = commitDeAlta(workspace, { '.claude/hooks/bootstrap-5244.json': fixtureConSecreto() });

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.equal(step.status, 1, `bajar un control vigente debía bloquear:\n${step.salida}`);
  assert.match(step.salida, /::error::secret-scan BLOQUEADO \(bootstrap sobre paths de control\)/);
  assert.match(step.salida, /base_gate=1/, 'el diagnóstico tiene que decir por qué no hubo alta');
  assert.doesNotMatch(step.salida, /ALTA DEL CONTROL/);
  assert.doesNotMatch(step.salida, /::warning::secret-scan bootstrap/);
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

test('DEGRADACIÓN: decider_trusted=0 ⇒ FAIL-CLOSED aunque la base no tenga el job', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previa al control']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace, { conGate: false });

  const headSha = commitDeAlta(workspace, { '.claude/hooks/bootstrap-5244.json': fixtureConSecreto() });

  // El árbol que decide degradó a la merge-base declarada del PR: "la base no
  // tiene el gate" ya no es un hecho verificable, lo elige el autor al ramificar.
  const step = runWorkflowStep({ workspace, baseSha, headSha, deciderTrusted: '0' });
  assert.equal(step.status, 1, `con decider degradado no puede haber alta:\n${step.salida}`);
  assert.match(step.salida, /decider_trusted=0/);
  assert.doesNotMatch(step.salida, /ALTA DEL CONTROL/);
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

test('DEGRADACIÓN: DECIDER_TRUSTED ausente ⇒ FAIL-CLOSED (nunca fail-open por env vacía)', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previa al control']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace, { conGate: false });
  const headSha = commitDeAlta(workspace);

  const step = runWorkflowStep({ workspace, baseSha, headSha, deciderTrusted: '' });
  assert.equal(step.status, 1, `sin la señal el step no puede conceder el alta:\n${step.salida}`);
  assert.match(step.salida, /decider_trusted= /, 'el diagnóstico muestra la señal vacía');
});

test('bootstrap + diff que toca el control SIN declarar el job en el head: FAIL-CLOSED', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previo al gate']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace, { conGate: false });

  // Toca los módulos de control pero NO da de alta el job: no es un alta, es un
  // diff sobre el control sin árbol confiable que lo juzgue.
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  writeFile(workspace, '.claude/hooks/bootstrap-5244.json', fixtureConSecreto());
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'toca el control sin instalar el job']);
  const headSha = git(workspace, ['rev-parse', 'HEAD']);

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.equal(step.status, 1, `el bootstrap sobre paths de control debía bloquear:\n${step.salida}`);
  assert.match(step.salida, /::error::secret-scan BLOQUEADO \(bootstrap sobre paths de control\)/);
  assert.match(step.salida, /head_gate=0/);
  assert.match(step.salida, /\.pipeline\/lib\/precommit-secret-scan\.js/, 'el path de control debe quedar nombrado');
  assert.doesNotMatch(
    step.salida,
    /::warning::secret-scan bootstrap/,
    'no puede llegar a habilitar el scanner del head: el bloqueo es previo',
  );
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

// #5244 rev-8 — el cruce que faltaba y por el que pasó el bypass: la rama de
// bootstrap (base sin protocolo) alcanzada CON el scanner del head neutralizado.
// Antes cada mitad estaba cubierta por separado y la combinación salía en verde.
test('CA-9: bootstrap alcanzable + scanner del head HOSTIL queda BLOQUEADO', () => {
  const workspace = initRepo();
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base de la rama del PR']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);

  // El árbol que decide es anterior a este control => rama de bootstrap.
  baseTreeLegacy(workspace, { conGate: false });

  // El PR hostil: apaga el scanner y mete el secreto en el mismo commit. Declara
  // el job para disfrazarse de alta (#5244 rev-9): lo único que lo delata es que
  // su scanner no expone secret-scan-protocol=range-v1.
  writeFile(workspace, '.pipeline/lib/precommit-secret-scan.js', NEUTRALIZED_SCANNER);
  writeFile(workspace, '.github/workflows/security-sast.yml', WORKFLOW_CON_GATE);
  writeFile(workspace, '.claude/hooks/hostil-bootstrap-5244.json', fixtureConSecreto());
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'PR hostil sobre base sin protocolo']);
  const headSha = git(workspace, ['rev-parse', 'HEAD']);

  // Control de que el escenario es el real: el scanner del head sale 0.
  const bypass = spawnSync(process.execPath, [
    path.join(workspace, '.pipeline', 'lib', 'precommit-secret-scan.js'),
    '--mode=range', `--base=${baseSha}`, `--head=${headSha}`, `--cwd=${toPosix(workspace)}`,
  ], { encoding: 'utf8' });
  assert.equal(bypass.status, 0, 'el scanner neutralizado del head debería pasar en verde');

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.equal(step.status, 1, `el cruce bootstrap + head hostil debía bloquear:\n${step.salida}`);
  assert.match(step.salida, /::error::secret-scan BLOQUEADO \(bootstrap sobre paths de control\)/);
  assert.match(step.salida, /\.pipeline\/lib\/precommit-secret-scan\.js/);
  // El escenario está armado como un alta (base sin job, head con job): lo único
  // que lo delata es que el scanner neutralizado no expone el protocolo.
  assert.match(step.salida, /base_gate=0 head_gate=1 head_caps=''/, 'el bloqueo tiene que atribuirse a las capacidades');
  assert.doesNotMatch(step.salida, /ALTA DEL CONTROL/, 'un scanner neutralizado no puede disfrazarse de alta');
  assert.doesNotMatch(
    step.salida,
    /::warning::secret-scan bootstrap/,
    'el scanner neutralizado no puede llegar a ejecutarse',
  );
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

test('bootstrap benigno: sin paths de control corre el head, lo declara y bloquea el secreto', () => {
  const workspace = initRepo();
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base de la rama del PR']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);
  baseTreeLegacy(workspace);

  // El diff NO toca el control: sólo agrega un archivo con un secreto.
  writeFile(workspace, '.claude/hooks/bootstrap-5244.json', fixtureConSecreto());
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'agrega un secreto sin tocar el control']);
  const headSha = git(workspace, ['rev-parse', 'HEAD']);

  const step = runWorkflowStep({ workspace, baseSha, headSha });
  assert.match(step.salida, /::warning::secret-scan bootstrap/, 'el fallback tiene que quedar visible');
  assert.equal(step.status, 1, `el bootstrap debía bloquear el secreto:\n${step.salida}`);
  assert.match(step.salida, /bootstrap-5244\.json/);
  assert.doesNotMatch(step.salida, new RegExp(SYNTHETIC_TOKEN));
});

test('el probe de capacidades distingue al scanner nuevo del viejo', () => {
  const { CAPABILITIES_LINE } = require('../lib/precommit-secret-scan');
  const actual = spawnSync(process.execPath, [
    path.join(REPO, '.pipeline', 'lib', 'precommit-secret-scan.js'), '--capabilities',
  ], { encoding: 'utf8' });
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.trim(), CAPABILITIES_LINE);
  assert.equal(CAPABILITIES_LINE, 'secret-scan-protocol=range-v1');

  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-scanner-'));
  const legacyScanner = path.join(legacy, 'precommit-secret-scan.js');
  fs.writeFileSync(legacyScanner, LEGACY_SCANNER);
  const probe = spawnSync(process.execPath, [legacyScanner, '--capabilities'], { encoding: 'utf8' });
  assert.doesNotMatch(probe.stdout || '', /secret-scan-protocol/);
});

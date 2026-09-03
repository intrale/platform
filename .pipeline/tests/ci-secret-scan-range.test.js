'use strict';

// #5244 rev-5 — el gate bloqueante tiene que juzgar SÓLO lo que el PR agrega.
// El rechazo de `po` sobre el PR #5280: el rango `pull_request.base.sha..GITHUB_SHA`
// arrastraba `main` entero, porque en eventos `pull_request` GITHUB_SHA es el merge
// commit efímero (refs/pull/N/merge) e incorpora la base ACTUAL. Resultado: 3
// hallazgos del commit ajeno fb03a6b8e (#5304) frenando un PR que no los introdujo.
//
// Igual que ci-secret-scan-step.test.js, este test NO reimplementa la lógica:
// extrae los bloques `run:` del yml y los ejecuta tal cual, sobre un repo git que
// reproduce la topología real (base → PR benigno · base → commit ajeno con secreto
// → merge commit efímero).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'security-sast.yml');
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW, 'utf8');

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

// Tokens sintéticos armados en runtime: escritos literales, el propio gate
// bloquearía este archivo.
const TOKEN_AJENO = ['gh', 'p_', 'zyxwvutsrqponmlkjihgfe', 'ABCDEFGHIJKLMNOPQR'].join('');
const TOKEN_PROPIO = ['gh', 'p_', 'abcdefghijklmnopqrstuv', 'ZYXWVUTSRQPONMLKJIHG'].join('');
const SECRET_FIELD = ['to', 'ken'].join('');
const fixture = (valor) => `${JSON.stringify({ [SECRET_FIELD]: valor })}\n`;

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

function runStep(stepName, { workspace, env }) {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-step-')), 'step.sh');
  fs.writeFileSync(script, `${extractRunBlock(stepName)}\n`);
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
  const result = spawnSync(resolveShell(), ['-e', toPosix(script)], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: toPosix(workspace),
      RUNNER_TEMP: toPosix(runnerTemp),
      ...env,
    },
  });
  return { ...result, salida: `${result.stdout || ''}${result.stderr || ''}` };
}

function resolverRango({ workspace, ...env }) {
  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-output-')), 'out.txt');
  fs.writeFileSync(outputFile, '');
  const step = runStep('Resolver rango del diff', {
    workspace,
    env: { GITHUB_OUTPUT: toPosix(outputFile), ...env },
  });
  const outputs = {};
  for (const line of fs.readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { ...step, outputs };
}

function escanear({ workspace, baseSha, headSha }) {
  return runStep('Secret scan del diff', {
    workspace,
    env: { GITHUB_SHA: headSha, BASE_SHA: baseSha },
  });
}

// Topología real del incidente:
//   A ── C (main avanza con un commit AJENO que trae un secreto)
//    \     \
//     B ────M   (M = refs/pull/N/merge: parent1 = C, parent2 = B)
//   B = head del PR, benigno.
function repoConMainAdelantado({ secretoEnElPr = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-secret-range-'));
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.email', 'pipeline@example.invalid']);
  git(workspace, ['config', 'user.name', 'Pipeline Test']);

  // A — base declarada del PR, con el gate ya instalado.
  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'A: base del PR']);
  const A = git(workspace, ['rev-parse', 'HEAD']);

  // B — el PR. Benigno salvo que el escenario pida lo contrario.
  git(workspace, ['checkout', '-q', '-b', 'pr']);
  writeFile(workspace, 'docs/cambio-del-pr.md', 'cambio benigno del PR\n');
  if (secretoEnElPr) writeFile(workspace, '.claude/hooks/propio-5244.json', fixture(TOKEN_PROPIO));
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'B: head del PR']);
  const B = git(workspace, ['rev-parse', 'HEAD']);

  // C — commit AJENO que entra a main después de abrirse el PR, con secreto.
  git(workspace, ['checkout', '-q', 'main']);
  writeFile(workspace, '.claude/hooks/ajeno-5244.json', fixture(TOKEN_AJENO));
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'C: commit ajeno ya mergeado a main']);
  const C = git(workspace, ['rev-parse', 'HEAD']);

  // M — merge commit efímero que GitHub materializa en refs/pull/N/merge.
  git(workspace, ['checkout', '-q', '-b', 'merge-ref', C]);
  git(workspace, ['merge', '--no-ff', '-m', 'M: merge efímero del PR', 'pr']);
  const M = git(workspace, ['rev-parse', 'HEAD']);
  git(workspace, ['update-ref', 'refs/remotes/origin/main', C]);

  // Árbol base que el workflow checkoutea en `.base` (untracked, fuera del índice).
  const baseTree = path.join(workspace, '.base');
  for (const relative of BASE_TREE_FILES) copyFromRepo(baseTree, relative);
  copyFromRepo(baseTree, '.pipeline/secret-scan-allowlist.json');

  return { workspace, A, B, C, M };
}

const envPr = ({ A, B, M, baseRef = 'main' }) => ({
  EVENT_NAME: 'pull_request',
  GITHUB_SHA: M,
  PR_BASE_SHA: A,
  PR_BASE_REF: baseRef,
  PR_HEAD_SHA: B,
  PUSH_BEFORE: '',
});

test('el step de rango es shell puro: las expresiones de Actions van en env:', () => {
  const block = extractRunBlock('Resolver rango del diff');
  assert.doesNotMatch(block, /\$\{\{/, 'con ${{ }} adentro el step deja de ser verificable');
  assert.match(block, /git merge-base/, 'sin merge-base el rango arrastra el avance de main');
  assert.match(
    WORKFLOW_TEXT,
    /BASE_SHA: \$\{\{ steps\.base\.outputs\.diff_base \}\}/,
    'el scan tiene que consumir el rango acotado, no la base declarada del PR',
  );
  assert.match(
    WORKFLOW_TEXT,
    /ref: \$\{\{ steps\.base\.outputs\.decider \}\}/,
    'la cadena de confianza D-3 apunta al tip REAL de la rama base, no a la merge-base del PR',
  );
});

test('el rango se acota al tip real de la base, no a la base declarada del PR', () => {
  const { workspace, A, B, C, M } = repoConMainAdelantado();
  const paso = resolverRango({ workspace, ...envPr({ A, B, M }) });
  assert.equal(paso.status, 0, paso.salida);
  assert.equal(paso.outputs.diff_base, C, `diff_base debía ser el tip de main (${C}):\n${paso.salida}`);
  assert.notEqual(paso.outputs.diff_base, A, 'usar la base declarada es justo el bug de rev-4');
  assert.equal(paso.outputs.sha, A, 'la base declarada del PR queda registrada, pero ya no gobierna el árbol');
  assert.equal(paso.outputs.decider, C, 'el árbol que decide es el tip REAL de main');
  assert.equal(paso.outputs.decider, paso.outputs.diff_base, 'en la vía normal decider == diff_base');
});

// #5244 rev-8 — el bypass de CA-9: `sha` es la merge-base del PR, así que un PR
// que no mergea main deja el árbol que decide en una época anterior al control y
// cae en bootstrap. Verificado contra la API: PR 5278 base.sha=ecb552459fb8 ≠
// tip de main c0200429504b.
test('el árbol que decide es el tip de main aunque el PR no haya mergeado main', () => {
  const { workspace, A, B, C, M } = repoConMainAdelantado();
  const paso = resolverRango({ workspace, ...envPr({ A, B, M }) });
  assert.equal(paso.status, 0, paso.salida);
  assert.notEqual(paso.outputs.decider, A, 'la merge-base del PR no puede gobernar el árbol que decide');
  assert.equal(paso.outputs.decider, C, 'decider tiene que seguir al tip de main');
  assert.equal(
    paso.outputs.decider,
    git(workspace, ['rev-parse', 'refs/remotes/origin/main']),
    'decider == origin/main: no lo mueve el autor del PR',
  );
});

// La vía de fallback (sin merge commit efímero) es donde `diff_base` degrada al
// punto de fork. `decider` NO degrada: sigue siendo el tip de la rama base, así
// que la rama de bootstrap tampoco se puede reabrir por acá.
test('sin merge commit efímero el rango degrada al fork pero el árbol que decide no', () => {
  const { workspace, A, B, C } = repoConMainAdelantado();
  const paso = resolverRango({ workspace, ...envPr({ A, B, M: B }) });
  assert.equal(paso.status, 0, paso.salida);
  assert.equal(paso.outputs.diff_base, A, 'el rango se acota al punto de fork');
  assert.equal(paso.outputs.decider, C, 'el árbol que decide sigue siendo el tip de main');
  assert.notEqual(paso.outputs.decider, paso.outputs.diff_base);
});

test('regresión #5280: el PR benigno NO hereda los hallazgos del commit ajeno', () => {
  const { workspace, A, B, C, M } = repoConMainAdelantado();

  // Control: el escenario es real. Con el rango viejo (base declarada) el gate
  // bloquea por el secreto de C, que el PR no introdujo.
  const conRangoViejo = escanear({ workspace, baseSha: A, headSha: M });
  assert.equal(conRangoViejo.status, 1, `el rango viejo debía bloquear:\n${conRangoViejo.salida}`);
  assert.match(conRangoViejo.salida, /ajeno-5244\.json/);

  // Con el rango resuelto por el step, el mismo PR sale limpio.
  const { outputs } = resolverRango({ workspace, ...envPr({ A, B, M }) });
  const conRangoNuevo = escanear({ workspace, baseSha: outputs.diff_base, headSha: M });
  assert.equal(conRangoNuevo.status, 0, `el PR benigno debía salir en verde:\n${conRangoNuevo.salida}`);
  assert.doesNotMatch(conRangoNuevo.salida, /ajeno-5244\.json/, 'el hallazgo ajeno no puede aparecer');
  assert.doesNotMatch(conRangoNuevo.salida, /BLOQUEADO/);
  assert.doesNotMatch(conRangoNuevo.salida, new RegExp(TOKEN_AJENO));
});

test('acotar el rango no afloja el gate: el secreto propio del PR sigue bloqueando', () => {
  const { workspace, A, B, M } = repoConMainAdelantado({ secretoEnElPr: true });
  const { outputs } = resolverRango({ workspace, ...envPr({ A, B, M }) });
  const scan = escanear({ workspace, baseSha: outputs.diff_base, headSha: M });
  assert.equal(scan.status, 1, `el secreto propio del PR debía bloquear:\n${scan.salida}`);
  assert.match(scan.salida, /propio-5244\.json/);
  assert.match(scan.salida, /BLOQUEADO/);
  assert.doesNotMatch(scan.salida, new RegExp(TOKEN_PROPIO), 'el valor crudo no puede filtrarse al log');
});

test('sin merge commit efímero cae a origin/<base ref>, nunca al padre del head', () => {
  const { workspace, A, B, C } = repoConMainAdelantado();
  // GITHUB_SHA == head del PR: `^1` sería A y el rango se achicaría al commit
  // anterior de la propia rama. El step tiene que ignorar esa vía.
  const paso = resolverRango({ workspace, ...envPr({ A, B, M: B }) });
  assert.equal(paso.status, 0, paso.salida);
  assert.equal(paso.outputs.diff_base, git(workspace, ['merge-base', C, B]));
  assert.equal(paso.outputs.diff_base, A, 'merge-base(main, head) es el punto de fork');
});

test('sin ancestro común el rango degrada a la base declarada y lo declara', () => {
  const { workspace, A, B, M } = repoConMainAdelantado();
  // Historia huérfana: no comparte ancestro con el merge commit.
  git(workspace, ['checkout', '-q', '--orphan', 'huerfana']);
  git(workspace, ['rm', '-rq', '--cached', '.']);
  writeFile(workspace, 'huerfana.md', 'sin ancestro comun\n');
  git(workspace, ['add', 'huerfana.md']);
  git(workspace, ['commit', '-m', 'huerfana']);
  const huerfana = git(workspace, ['rev-parse', 'HEAD']);
  git(workspace, ['update-ref', 'refs/remotes/origin/main', huerfana]);

  const paso = resolverRango({
    workspace,
    ...envPr({ A, B, M }),
    PR_HEAD_SHA: M, // fuerza la vía origin/<base ref>
  });
  assert.equal(paso.status, 0, paso.salida);
  assert.equal(paso.outputs.diff_base, A, 'fail-closed: escanea de más, nunca de menos');
  assert.match(paso.salida, /::warning::secret-scan: sin merge-base/, 'no puede degradar en silencio');
});

test('en push el rango sigue siendo before..sha', () => {
  const { workspace, C, M } = repoConMainAdelantado();
  const paso = resolverRango({
    workspace,
    EVENT_NAME: 'push',
    GITHUB_SHA: M,
    PUSH_BEFORE: C,
    PR_BASE_SHA: '',
    PR_BASE_REF: '',
    PR_HEAD_SHA: '',
  });
  assert.equal(paso.status, 0, paso.salida);
  assert.equal(paso.outputs.diff_base, C);
  assert.equal(paso.outputs.sha, C);
  assert.equal(paso.outputs.decider, C, 'en push el árbol que decide es el commit previo');

  const primerPush = resolverRango({
    workspace,
    EVENT_NAME: 'push',
    GITHUB_SHA: M,
    PUSH_BEFORE: '0000000000000000000000000000000000000000',
    PR_BASE_SHA: '',
    PR_BASE_REF: '',
    PR_HEAD_SHA: '',
  });
  assert.equal(primerPush.status, 0, primerPush.salida);
  assert.equal(primerPush.outputs.diff_base, git(workspace, ['rev-parse', 'merge-ref~1']));
});

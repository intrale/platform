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

// Ejecuta el step real del workflow con el entorno que provee GitHub Actions.
function runWorkflowStep({ workspace, baseSha, headSha }) {
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
  assert.match(block, /--sanitizer="\$BASE_TREE\/\.pipeline\/sanitizer\.js"/);
  assert.match(block, /BASE_ALLOWLIST="\$BASE_TREE\/\.pipeline\/secret-scan-allowlist\.json"/);
  assert.match(
    block,
    /printf '\{"paths":\["\.pipeline\/tests\/precommit-secret-scan-content\.test\.js"\],"globs":\[\]\}/,
    'la política bootstrap debe seguir siendo un path exacto, sin globs',
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

test('bootstrap: base sin protocolo cae al scanner del head, lo declara y bloquea igual', () => {
  const workspace = initRepo();
  writeFile(workspace, 'README.md', 'base\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base previo al gate']);
  const baseSha = git(workspace, ['rev-parse', 'HEAD']);

  // El base trae el scanner viejo: existe, pero ignora los flags y sale 0.
  const baseTree = path.join(workspace, '.base');
  writeFile(baseTree, '.pipeline/lib/precommit-secret-scan.js', LEGACY_SCANNER);
  copyFromRepo(baseTree, '.pipeline/sanitizer.js');
  copyFromRepo(baseTree, '.claude/hooks/telegram-sanitizer.js');

  for (const relative of BASE_TREE_FILES) copyFromRepo(workspace, relative);
  copyFromRepo(workspace, '.pipeline/secret-scan-allowlist.json');
  writeFile(workspace, '.claude/hooks/bootstrap-5244.json', fixtureConSecreto());
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'instala el gate y agrega un secreto']);
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

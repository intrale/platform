'use strict';

// #5244 rev-4 — el gate no puede apagarse con un atributo de `.gitattributes`.
//
// El rechazo de `verificacion` reprodujo el agujero con el binario real del PR:
// `git` decide "esto es binario" leyendo el atributo `diff` del ÁRBOL DE TRABAJO,
// y en CI el diff se calcula sobre el checkout del HEAD — o sea, el mismo commit
// que trae el secreto. Una línea `* -diff` agregada a un archivo que YA existe en
// la raíz dejaba el scanner en exit 0 con stdout y stderr en 0 bytes, en los DOS
// modos, indistinguible de un PR limpio. `.gitattributes` no está cubierto por
// CODEOWNERS, así que tampoco lo frenaba una review humana.
//
// Estos tests corren contra repos git REALES (no diffs sintéticos): la suite
// anterior sólo tenía un diff a mano que asserteaba el SALTEO, o sea que fijaba
// el bypass como comportamiento esperado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseNumstat, run } = require('../lib/precommit-secret-scan');
const { isControlPath } = require('../lib/secret-allowlist');

const SCANNER = path.join(__dirname, '..', 'lib', 'precommit-secret-scan.js');
const EMPTY_ALLOWLIST = path.join(__dirname, '..', 'secret-scan-allowlist.json');

// Se arma en runtime: escrito literal, este archivo dispararía su propio gate.
const AWS_KEY = ['AKIA', '3XQ7', 'RZLM4KPWDVBN'].join('');
const GITHUB_PAT = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
const SECRET_JSON = () => `${JSON.stringify({ aws_access_key_id: AWS_KEY })}\n`;

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function write(directory, relative, contenido) {
  const destino = path.join(directory, relative);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, contenido);
}

// Repo con un commit base limpio; devuelve el sha para `--mode=range`.
function repoConBase(prefijo) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.email', 'pipeline@example.invalid');
  git(directory, 'config', 'user.name', 'Pipeline Test');
  write(directory, 'README.md', 'base\n');
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'base');
  return { directory, base: git(directory, 'rev-parse', 'HEAD').trim() };
}

function scan(directory, args) {
  return spawnSync(process.execPath, [
    SCANNER, `--cwd=${directory}`, `--allowlist=${EMPTY_ALLOWLIST}`, ...args,
  ], { encoding: 'utf8' });
}

function scanRange(directory, base, format = 'text') {
  return scan(directory, ['--mode=range', `--base=${base}`, '--head=HEAD', `--format=${format}`]);
}

function scanStaged(directory, format = 'text') {
  return scan(directory, ['--mode=staged', `--format=${format}`]);
}

// PNG real: firma + chunk IHDR. Tiene NUL, así que es binario de verdad.
function pngReal() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
    Buffer.alloc(64, 0x00),
  ]);
}

// ── El bypass de rev-3, cerrado ─────────────────────────────────────────────

const ATAQUES = [
  { nombre: 'D1 glob por extensión: "*.json -diff"', atributos: '*.json -diff\n', archivo: '.claude/hooks/prod.json', contenido: SECRET_JSON },
  { nombre: 'D1b glob total: "* -diff"', atributos: '* -diff\n', archivo: '.claude/hooks/prod.json', contenido: SECRET_JSON },
  { nombre: 'E1 atributo "binary" sobre .env', atributos: '.env binary\n', archivo: '.env', contenido: () => `AWS_ACCESS_KEY_ID=${AWS_KEY}\n` },
  { nombre: 'E2 "*.kt -diff" con un PAT de GitHub', atributos: '*.kt -diff\n', archivo: 'src/Secreto.kt', contenido: () => `val token = "${GITHUB_PAT}"\n` },
  { nombre: 'E3 ".husky/** -diff" sobre un path de control', atributos: '.husky/** -diff\n', archivo: '.husky/pre-commit', contenido: () => `#!/bin/sh\nexport AWS_ACCESS_KEY_ID=${AWS_KEY}\n` },
];

for (const ataque of ATAQUES) {
  test(`${ataque.nombre}: el atributo no apaga el gate en modo range`, () => {
    const { directory, base } = repoConBase('secret-scan-gitattr-');
    write(directory, '.gitattributes', ataque.atributos);
    write(directory, ataque.archivo, ataque.contenido());
    git(directory, 'add', '-A');
    git(directory, 'commit', '-qm', 'PR hostil con atributo -diff');

    const resultado = scanRange(directory, base);
    assert.equal(resultado.status, 1, `pasó en verde: ${JSON.stringify(resultado.stderr)}`);
    assert.match(resultado.stderr, new RegExp(ataque.archivo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(resultado.stderr, /BLOQUEADO/);
    assert.doesNotMatch(resultado.stderr, new RegExp(AWS_KEY), 'el valor crudo no se imprime');
    assert.doesNotMatch(resultado.stderr, new RegExp(GITHUB_PAT));
  });
}

test('F1 el mismo ataque tampoco pasa por el pre-commit (modo staged)', () => {
  const { directory } = repoConBase('secret-scan-gitattr-staged-');
  write(directory, '.gitattributes', '* -diff\n');
  write(directory, '.claude/hooks/prod.json', SECRET_JSON());
  git(directory, 'add', '-A');

  const resultado = scanStaged(directory);
  assert.equal(resultado.status, 1, `pasó en verde: ${JSON.stringify(resultado.stderr)}`);
  assert.match(resultado.stderr, /prod\.json/);
  assert.match(resultado.stderr, /BLOQUEADO/);
});

test('E4 un .gitattributes de subdirectorio tampoco alcanza', () => {
  const { directory, base } = repoConBase('secret-scan-gitattr-nested-');
  write(directory, '.claude/hooks/.gitattributes', '* -diff\n');
  write(directory, '.claude/hooks/prod.json', SECRET_JSON());
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'atributo en subdirectorio');

  const resultado = scanRange(directory, base);
  assert.equal(resultado.status, 1, `pasó en verde: ${JSON.stringify(resultado.stderr)}`);
  assert.match(resultado.stderr, /prod\.json/);
});

test('E5 en formato github el bloqueo llega como ::error al log de Actions', () => {
  const { directory, base } = repoConBase('secret-scan-gitattr-gh-');
  write(directory, '.gitattributes', '* -diff\n');
  write(directory, '.claude/hooks/prod.json', SECRET_JSON());
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'PR hostil');

  const resultado = scanRange(directory, base, 'github');
  assert.equal(resultado.status, 1, resultado.stderr);
  assert.match(resultado.stderr, /::error file=\.claude\/hooks\/prod\.json,line=1::/);
  assert.match(resultado.stderr, /AWS_ACCESS_KEY/);
});

test('un rename con espacios y atributo -diff se relee por el path destino', () => {
  const { directory, base } = repoConBase('secret-scan-gitattr-rename-');
  const relleno = 'contenido estable para que git detecte el rename\n'.repeat(6);
  write(directory, 'viejo con espacio.txt', relleno);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'archivo previo');
  const conRename = git(directory, 'rev-parse', 'HEAD').trim();

  write(directory, '.gitattributes', '* -diff\n');
  fs.rmSync(path.join(directory, 'viejo con espacio.txt'));
  write(directory, 'nuevo nombre.txt', `${relleno}aws_access_key_id=${AWS_KEY}\n`);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'rename + secreto');

  for (const desde of [base, conRename]) {
    const resultado = scanRange(directory, desde);
    assert.equal(resultado.status, 1, `pasó en verde: ${JSON.stringify(resultado.stderr)}`);
    assert.match(resultado.stderr, /nuevo nombre\.txt/);
  }
});

// ── El binario legítimo no se traba, pero tampoco pasa en silencio ───────────

test('un PNG real no bloquea y queda ANUNCIADO en text y en github', () => {
  const { directory, base } = repoConBase('secret-scan-png-');
  fs.writeFileSync(path.join(directory, 'logo.png'), pngReal());
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'agrega un binario legitimo');

  const texto = scanRange(directory, base, 'text');
  assert.equal(texto.status, 0, `un binario legítimo no puede trabar el PR: ${texto.stderr}`);
  assert.match(texto.stderr, /logo\.png/, 'el salteo tiene que anunciarse');
  assert.match(texto.stderr, /no escaneado/);

  const github = scanRange(directory, base, 'github');
  assert.equal(github.status, 0, github.stderr);
  assert.match(github.stderr, /::warning file=logo\.png,line=1::/);
});

test('un PNG con un secreto en texto plano adentro sigue salteado pero anunciado', () => {
  // El NUL manda: es un binario de verdad. Lo que no puede pasar es el silencio.
  const { directory, base } = repoConBase('secret-scan-png-secreto-');
  fs.writeFileSync(
    path.join(directory, 'con-metadata.png'),
    Buffer.concat([pngReal(), Buffer.from(`aws_access_key_id=${AWS_KEY}\n`)]),
  );
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'binario con metadata');

  const resultado = scanRange(directory, base, 'text');
  assert.equal(resultado.status, 0);
  assert.match(resultado.stderr, /con-metadata\.png — .*no escaneado/);
});

test('CA-UX-4: sin binarios el happy path sigue en 0 bytes', () => {
  const { directory, base } = repoConBase('secret-scan-gitattr-limpio-');
  write(directory, '.gitattributes', '*.sh text eol=lf\n');
  write(directory, '.claude/hooks/limpio.json', '{"nivel":"info"}\n');
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'cambio limpio con .gitattributes benigno');

  for (const format of ['text', 'github']) {
    const resultado = scanRange(directory, base, format);
    assert.equal(resultado.status, 0, resultado.stderr);
    assert.equal(resultado.stdout, '', `stdout debería ser 0 bytes en ${format}`);
    assert.equal(resultado.stderr, '', `stderr debería ser 0 bytes en ${format}`);
  }
});

// ── Piezas del fix ──────────────────────────────────────────────────────────

test('parseNumstat separa binarios, conteos y renames sin ambigüedad de paths', () => {
  const output = [
    '-\t-\t.claude/hooks/prod.json\0',
    '3\t0\tsrc/con espacio.txt\0',
    '-\t-\t\0viejo con espacio.txt\0nuevo nombre.txt\0',
  ].join('');
  assert.deepEqual(parseNumstat(output), [
    { path: '.claude/hooks/prod.json', binary: true, added: 0 },
    { path: 'src/con espacio.txt', binary: false, added: 3 },
    { path: 'nuevo nombre.txt', binary: true, added: 0 },
  ]);
  assert.throws(() => parseNumstat('basura\0'), /registro inesperado/);
});

test('un path con líneas agregadas y sin hunks bloquea en vez de pasar en verde', () => {
  const resultado = run(
    { allowlist: EMPTY_ALLOWLIST, format: 'text' },
    {
      collectAddedHunks: () => [{
        path: 'src/opaco.bin',
        startLine: 1,
        error: 'git declara 4 linea(s) agregada(s) y el diff no produjo hunks: no escaneable (fail-closed)',
      }],
    },
  );
  assert.equal(resultado.exitCode, 1);
  assert.match(resultado.output, /no escaneable \(fail-closed\)/);
});

test('run expone los binarios salteados como dato, no sólo como texto', () => {
  const resultado = run(
    { allowlist: EMPTY_ALLOWLIST, format: 'text' },
    { collectAddedHunks: () => [{ path: 'logo.png', skippedBinary: true, bytes: 80 }] },
  );
  assert.equal(resultado.exitCode, 0);
  assert.deepEqual(resultado.skippedBinaries, [{ path: 'logo.png', skippedBinary: true, bytes: 80 }]);
  assert.match(resultado.warnings, /logo\.png/);
});

test('.gitattributes es path de control, en la raíz y en subdirectorios', () => {
  assert.equal(isControlPath('.gitattributes'), true);
  assert.equal(isControlPath('.claude/hooks/.gitattributes'), true);
  assert.equal(isControlPath('docs/.gitattributes'), true);
  assert.equal(isControlPath('docs/gitattributes'), false);
});

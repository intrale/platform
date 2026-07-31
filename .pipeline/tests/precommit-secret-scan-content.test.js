'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  collectAddedHunks, findingFor, parseHunks, run,
} = require('../lib/precommit-secret-scan');
const { IGNORE_MARKER } = require('../lib/secret-scan-lint');
const { CONTROL_PATHS } = require('../lib/secret-allowlist');

const EMPTY_ALLOWLIST = path.join(
  __dirname, '..', 'secret-scan-allowlist.json',
);

// Token y clave se arman en runtime: escritos literales, este archivo
// dispararía su propio gate y necesitaría una excepción permanente en la
// allowlist (#5244 — un path escribible y nunca escaneado es un agujero).
const SYNTHETIC_TOKEN = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
const SECRET_FIELD = ['to', 'ken'].join('');
const fixtureConSecreto = () => JSON.stringify({ [SECRET_FIELD]: SYNTHETIC_TOKEN });

function fakeFinding(text, sanitizer) {
  return findingFor({ path: '.claude/hooks/config.json', startLine: 1, text }, sanitizer);
}

function sandboxRepo(prefijo) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  execFileSync('git', ['init'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'pipeline@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Pipeline Test'], { cwd: directory });
  fs.mkdirSync(path.join(directory, '.claude', 'hooks'), { recursive: true });
  return directory;
}

function stageFile(directory, relative, contenido) {
  fs.writeFileSync(path.join(directory, relative), contenido);
  execFileSync('git', ['add', '-A'], { cwd: directory });
}

function scanStaged(directory) {
  return run({ cwd: directory, allowlist: EMPTY_ALLOWLIST, format: 'text' });
}

// #5244 rev-4 — este test asserteaba el SALTEO del camino binario como
// comportamiento esperado, con un diff sintético: fijaba el bypass en vez de
// detectarlo. `parseHunks` sigue sin emitir un hunk desde el marcador `Binary
// files` (ese marcador no trae el path en forma parseable sin ambigüedad), pero
// eso YA NO es la decisión final: `collectAddedHunks` releé el blob de cada path
// que git declara binario y decide por contenido. La cobertura del camino
// completo, con repos git reales, está en
// precommit-secret-scan-gitattributes.test.js.
test('parseHunks agrupa por hunk; el path binario lo resuelve collectAddedHunks', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt',
    '@@ -0,0 +4,2 @@', '+primera', '+segunda',
    'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');
  assert.deepEqual(parseHunks(diff), [{
    path: 'a.txt', startLine: 4, text: 'primera\nsegunda',
  }]);
});

test('un archivo declarado binario por .gitattributes llega igual al escaneo', () => {
  const directory = sandboxRepo('secret-scan-attr-collect-');
  fs.writeFileSync(path.join(directory, '.gitattributes'), '* -diff\n');
  stageFile(directory, '.claude/hooks/config.json', fixtureConSecreto());
  const hunks = collectAddedHunks({ cwd: directory });
  const resuelto = hunks.find((hunk) => hunk.path === '.claude/hooks/config.json');
  assert.ok(resuelto, 'el path binario no puede desaparecer del set a escanear');
  assert.equal(resuelto.fromBinary, true, 'se resolvió releyendo el blob, no del diff');
  assert.match(resuelto.text, new RegExp(SYNTHETIC_TOKEN));
  assert.equal(scanStaged(directory).exitCode, 1);
});

test('findingFor usa delta de redacciones y no comparación de strings', () => {
  const crlf = 'línea uno\r\nlínea dos\r\n';
  assert.equal(fakeFinding(crlf, (text) => text.replace(/\r\n/g, '\n')), null);
  assert.deepEqual(
    fakeFinding('dato', () => '[REDACTED:API_KEY]'),
    {
      path: '.claude/hooks/config.json',
      line: 1,
      redactions: { '[REDACTED:API_KEY]': 1 },
    },
  );
  assert.equal(
    fakeFinding('[REDACTED:API_KEY]', (text) => text),
    null,
    'un placeholder preexistente no cuenta como hallazgo nuevo',
  );
});

test('findingFor bloquea excepciones y marcadores del sanitizer', () => {
  assert.match(fakeFinding('dato', () => { throw new Error('boom'); }).error, /boom/);
  assert.equal(
    fakeFinding('dato', () => '[SANITIZER_ERROR: fallo]').error,
    'SANITIZER_ERROR',
  );
  assert.equal(
    fakeFinding('const marker = "[SANITIZER_ERROR:";', (text) => text),
    null,
    'mencionar el contrato en código no debe bloquear al propio scanner',
  );
});

test('run bloquea por contenido en cualquier path y respeta allowlist', () => {
  const options = { allowlist: EMPTY_ALLOWLIST, format: 'text' };
  const blocked = run(options, {
    collectAddedHunks: () => [{
      path: '.claude/hooks/inesperado.json', startLine: 7, text: 'valor',
    }],
    sanitize: () => '[REDACTED:API_KEY]',
  });
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.output, /^\.claude\/hooks\/inesperado\.json:7/m);
  assert.match(blocked.output, /BLOQUEADO/);
});

test('collectAddedHunks propaga errores de git y no falla abierto', () => {
  assert.throws(
    () => collectAddedHunks({ cwd: path.join(os.tmpdir(), 'no-es-un-repo') }),
  );
});

test('scanner real bloquea un secreto staged sin depender del path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-repo-'));
  execFileSync('git', ['init'], { cwd: directory });
  const nested = path.join(directory, '.claude', 'hooks');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'config.json'), fixtureConSecreto());
  execFileSync('git', ['add', '.'], { cwd: directory });
  const hunks = collectAddedHunks({ cwd: directory });
  assert.equal(hunks[0].path, '.claude/hooks/config.json');
  const result = run(
    { cwd: directory, allowlist: EMPTY_ALLOWLIST, format: 'text' },
  );
  assert.equal(result.exitCode, 1);
});

test('CI bootstrap sin excepciones: el fixture pasa por benigno, no por allowlist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-range-'));
  execFileSync('git', ['init'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'pipeline@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Pipeline Test'], { cwd: directory });
  fs.mkdirSync(path.join(directory, '.pipeline', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.pipeline', 'lib', 'precommit-secret-scan.js'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
  );
  fs.writeFileSync(path.join(directory, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-m', 'base con scanner antiguo'], { cwd: directory });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  // #5244 — la política bootstrap NO exceptúa ningún path: este fixture arma
  // sus tokens en runtime, así que pasa por benigno. Una excepción permanente
  // sobre un path escribible y fuera de CODEOWNERS sería un agujero abierto.
  const bootstrapAllowlist = path.join(directory, 'bootstrap-allowlist.json');
  fs.writeFileSync(bootstrapAllowlist, JSON.stringify({ paths: [], globs: [] }));
  const fixtureDir = path.join(directory, '.pipeline', 'tests');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'precommit-secret-scan-content.test.js'),
    fs.readFileSync(__filename),
  );
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-m', 'agrega fixture benigno'], { cwd: directory });

  const scanner = path.join(__dirname, '..', 'lib', 'precommit-secret-scan.js');
  const benign = spawnSync(process.execPath, [
    scanner, '--mode=range', `--base=${base}`, '--head=HEAD', `--cwd=${directory}`,
    `--allowlist=${bootstrapAllowlist}`, '--format=github',
  ], { encoding: 'utf8' });
  assert.equal(benign.status, 0, benign.stderr);

  const nested = path.join(directory, '.claude', 'hooks');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'audit-5244.json'), fixtureConSecreto());
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-m', 'agrega secreto sintetico'], { cwd: directory });

  const result = spawnSync(process.execPath, [
    scanner, '--mode=range', `--base=${base}`, '--head=HEAD', `--cwd=${directory}`,
    `--allowlist=${bootstrapAllowlist}`, '--format=github',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /audit-5244\.json/);
  assert.match(result.stderr, /BLOQUEADO/);
  assert.match(result.stderr, /\[REDACTED:GITHUB_TOKEN\]/);
  // El cableado del job (scanner del base, probe de capacidades, política
  // bootstrap) se verifica ejecutando el step real en ci-secret-scan-step.test.js.
});

// ── #5244 rev-1 — el contenido no puede hacerse pasar por encabezado ─────────
// El escáner clasificaba por prefijo de texto: una línea agregada cuyo
// contenido empieza con "++ " se emite como "+++ ..." y se leía como
// encabezado de archivo, descartando el hunk y todo lo que venía después.

test('parseHunks consume el cuerpo por conteo del @@, no por prefijo de texto', () => {
  const diff = [
    'diff --git a/trampa.txt b/trampa.txt', '--- /dev/null', '+++ b/trampa.txt',
    '@@ -0,0 +1,3 @@',
    // Contenido "++ b/decoy": git le antepone el "+" de agregado y en el diff
    // sale "+++ b/decoy", idéntico a un encabezado de archivo.
    '+++ b/decoy',
    '++tambien-contenido',
    '+secreto',
    'diff --git a/otro.txt b/otro.txt', '--- /dev/null', '+++ b/otro.txt',
    '@@ -0,0 +1 @@', '+segundo archivo',
  ].join('\n');
  assert.deepEqual(parseHunks(diff), [
    { path: 'trampa.txt', startLine: 1, text: '++ b/decoy\n+tambien-contenido\nsecreto' },
    { path: 'otro.txt', startLine: 1, text: 'segundo archivo' },
  ]);
});

test('parseHunks respeta borradas, contexto y el marcador de fin sin newline', () => {
  const diff = [
    '+++ b/mixto.txt', '@@ -1,2 +1,2 @@',
    '-vieja', '-@@ -9,9 +9,9 @@', '+nueva', '+@@ -9,9 +9,9 @@',
    '\\ No newline at end of file',
    '+++ b/siguiente.txt', '@@ -0,0 +1 @@', '+ultima',
  ].join('\n');
  assert.deepEqual(parseHunks(diff), [
    { path: 'mixto.txt', startLine: 1, text: 'nueva\n@@ -9,9 +9,9 @@' },
    { path: 'siguiente.txt', startLine: 1, text: 'ultima' },
  ]);
});

test('parseHunks falla cerrado si el cuerpo del hunk no cierra el conteo', () => {
  const diff = ['+++ b/a.txt', '@@ -0,0 +1,2 @@', '+una', 'basura sin prefijo'].join('\n');
  assert.throws(() => parseHunks(diff), /cuerpo de hunk inesperado/);
});

test('findingFor BLOQUEA un hunk con NUL en vez de descartarlo', () => {
  const finding = findingFor(
    { path: '.claude/hooks/tardio.txt', startLine: 1, text: `x\0${SYNTHETIC_TOKEN}` },
    (text) => text,
  );
  assert.match(finding.error, /NUL/, 'un hunk no escaneable tiene que bloquear');
  assert.equal(
    parseHunks(['+++ b/a.txt', '@@ -0,0 +1 @@', '+con\0nul'].join('\n')).length,
    1,
    'el hunk con NUL debe llegar al escaneo, no descartarse en el parser',
  );
});

test('bypass a: contenido "++ b/decoy" no oculta el secreto del resto del hunk', () => {
  const directory = sandboxRepo('secret-scan-bypass-a-');
  stageFile(
    directory, '.claude/hooks/bypass-a.txt',
    `++ b/decoy\n${JSON.stringify({ [SECRET_FIELD]: SYNTHETIC_TOKEN })}\n`,
  );
  const result = scanStaged(directory);
  assert.equal(result.exitCode, 1, 'el secreto quedó sin escanear detrás de la línea trampa');
  assert.match(result.output, /bypass-a\.txt/);
  assert.match(result.output, /\[REDACTED:GITHUB_TOKEN\]/);
  assert.doesNotMatch(result.output, new RegExp(SYNTHETIC_TOKEN));
});

test('bypass b: un secreto en una línea que arranca con "++" se escanea igual', () => {
  const directory = sandboxRepo('secret-scan-bypass-b-');
  stageFile(directory, '.claude/hooks/bypass-b.txt', `++${SYNTHETIC_TOKEN}\n`);
  const result = scanStaged(directory);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /bypass-b\.txt/);
  assert.match(result.output, /\[REDACTED:GITHUB_TOKEN\]/);
});

test('bypass c: un NUL después del umbral de binario de git no salva al hunk', () => {
  const directory = sandboxRepo('secret-scan-bypass-c-');
  // git decide binario mirando los primeros ~8000 bytes: con el NUL más allá,
  // el archivo se difea como texto y el hunk llega al escáner.
  const contenido = Buffer.concat([
    Buffer.alloc(9000, 0x78), Buffer.from('\n'),
    Buffer.from([0]), Buffer.from('\n'),
    Buffer.from(`${SECRET_FIELD}=${SYNTHETIC_TOKEN}\n`),
  ]);
  stageFile(directory, '.claude/hooks/bypass-c.txt', contenido);
  const numstat = execFileSync(
    'git', ['diff', '--cached', '--numstat', '.claude/hooks/bypass-c.txt'],
    { cwd: directory, encoding: 'utf8' },
  );
  assert.doesNotMatch(numstat, /^-\t-/, 'el escenario exige que git lo difee como texto');
  const result = scanStaged(directory);
  assert.equal(result.exitCode, 1, 'un hunk no escaneable no puede pasar en verde');
  assert.match(result.output, /bypass-c\.txt/);
});

test('CA-9: la trampa del parser tampoco pasa por el modo range de CI', () => {
  const directory = sandboxRepo('secret-scan-bypass-range-');
  stageFile(directory, 'README.md', 'base\n');
  execFileSync('git', ['commit', '-m', 'base'], { cwd: directory });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  stageFile(
    directory, '.claude/hooks/pr-hostil.json',
    `++ b/decoy\n${JSON.stringify({ [SECRET_FIELD]: SYNTHETIC_TOKEN })}\n`,
  );
  execFileSync('git', ['commit', '-m', 'PR hostil con linea trampa'], { cwd: directory });

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'lib', 'precommit-secret-scan.js'),
    '--mode=range', `--base=${base}`, '--head=HEAD', `--cwd=${directory}`,
    `--allowlist=${EMPTY_ALLOWLIST}`, '--format=github',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pr-hostil\.json/);
  assert.match(result.stderr, /\[REDACTED:GITHUB_TOKEN\]/);
});

// ── #5244 rev-3 · el escape NO puede ser un bypass silencioso ────────────────
//
// El rechazo de `verificacion` reprodujo el agujero con el scanner real: un PR
// hostil agregaba `{"aws":"AKIA…","_c":"<marca>"}` y el job bloqueante de CI
// terminaba en exit 0 con stdout y stderr en 0 bytes, indistinguible de un PR
// limpio. `CODEOWNERS` no cubre `.pipeline/` ni `.claude/hooks/`, así que "la
// marca la ve el reviewer" no alcanzaba. La marca sigue funcionando (CA-8d),
// pero ahora se ANUNCIA.

function scanRange(directory, base, format) {
  return spawnSync(process.execPath, [
    path.join(__dirname, '..', 'lib', 'precommit-secret-scan.js'),
    '--mode=range', `--base=${base}`, '--head=HEAD', `--cwd=${directory}`,
    `--allowlist=${EMPTY_ALLOWLIST}`, `--format=${format}`,
  ], { encoding: 'utf8' });
}

function repoConBase(prefijo) {
  const directory = sandboxRepo(prefijo);
  stageFile(directory, 'README.md', 'base\n');
  execFileSync('git', ['commit', '-m', 'base'], { cwd: directory });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  return { directory, base };
}

test('una línea suprimida con la marca se anuncia en text y en github', () => {
  const { directory, base } = repoConBase('secret-scan-supresion-');
  // En JSON la marca entra como VALOR válido: no hace falta sintaxis de comentario.
  stageFile(
    directory, '.claude/hooks/prod.json',
    `${JSON.stringify({ [SECRET_FIELD]: SYNTHETIC_TOKEN, _c: IGNORE_MARKER })}\n`,
  );
  execFileSync('git', ['commit', '-m', 'PR con supresion'], { cwd: directory });

  const texto = scanRange(directory, base, 'text');
  assert.equal(texto.status, 0, 'la marca sigue siendo un escape válido (CA-8d)');
  assert.match(texto.stderr, /prod\.json:1/, 'la supresión se anuncia con path:linea');
  assert.match(texto.stderr, new RegExp(IGNORE_MARKER));
  assert.doesNotMatch(texto.stderr, new RegExp(SYNTHETIC_TOKEN), 'el valor crudo no se imprime');

  const github = scanRange(directory, base, 'github');
  assert.equal(github.status, 0);
  assert.match(
    github.stderr, /::warning file=\.claude\/hooks\/prod\.json,line=1::/,
    'queda anotado en el log de Actions aunque nadie mire el diff',
  );
});

test('la marca NO se honra sobre un path de control', () => {
  const { directory, base } = repoConBase('secret-scan-control-');
  // Explícito, no `CONTROL_PATHS[0]`: el índice cambia cada vez que se suma un
  // archivo de control (rev-4 agregó `.gitattributes`) y el test dejaba de
  // ejercitar lo que dice su nombre sin que nadie se enterara.
  const control = '.pipeline/lib/precommit-secret-scan.js';
  assert.ok(CONTROL_PATHS.includes(control));
  fs.mkdirSync(path.join(directory, path.dirname(control)), { recursive: true });
  stageFile(directory, control, `const fixture = "${SYNTHETIC_TOKEN}"; // ${IGNORE_MARKER}\n`);
  execFileSync('git', ['commit', '-m', 'apagar el gate desde adentro'], { cwd: directory });

  const resultado = scanRange(directory, base, 'github');
  assert.equal(resultado.status, 1, 'el gate no se apaga a sí mismo');
  assert.match(resultado.stderr, /::error file=/, 'el secreto se reporta igual');
  assert.match(resultado.stderr, /IGNORADA en path de control/);
});

test('sin supresiones el happy path no emite un solo byte (CA-UX-4)', () => {
  const { directory, base } = repoConBase('secret-scan-limpio-');
  stageFile(directory, '.claude/hooks/limpio.json', '{"nivel":"info"}\n');
  execFileSync('git', ['commit', '-m', 'cambio limpio'], { cwd: directory });

  for (const format of ['text', 'github']) {
    const resultado = scanRange(directory, base, format);
    assert.equal(resultado.status, 0);
    assert.equal(resultado.stdout, '', `stdout debería ser 0 bytes en ${format}`);
    assert.equal(resultado.stderr, '', `stderr debería ser 0 bytes en ${format}`);
  }
});

test('run expone las supresiones como dato, no sólo como texto', () => {
  const conMarca = `linea limpia\nconst k = "${SYNTHETIC_TOKEN}"; // ${IGNORE_MARKER}`;
  const resultado = run(
    { allowlist: EMPTY_ALLOWLIST, format: 'text' },
    { collectAddedHunks: () => [{ path: 'src/fixtures.js', startLine: 40, text: conMarca }] },
  );
  assert.equal(resultado.exitCode, 0);
  assert.deepEqual(
    resultado.suppressions, [{ path: 'src/fixtures.js', line: 41, honored: true }],
    'el número de línea se reporta en numeración del archivo nuevo, no del hunk',
  );
});

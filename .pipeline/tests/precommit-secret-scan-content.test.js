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

const EMPTY_ALLOWLIST = path.join(
  __dirname, '..', 'secret-scan-allowlist.json',
);

function fakeFinding(text, sanitizer) {
  return findingFor({ path: '.claude/hooks/config.json', startLine: 1, text }, sanitizer);
}

test('parseHunks agrupa líneas agregadas por hunk y omite binarios', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt',
    '@@ -0,0 +4,2 @@', '+primera', '+segunda',
    'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');
  assert.deepEqual(parseHunks(diff), [{
    path: 'a.txt', startLine: 4, text: 'primera\nsegunda',
  }]);
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
  const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
  fs.writeFileSync(path.join(nested, 'config.json'), JSON.stringify({ token }));
  execFileSync('git', ['add', '.'], { cwd: directory });
  const hunks = collectAddedHunks({ cwd: directory });
  assert.equal(hunks[0].path, '.claude/hooks/config.json');
  const result = run(
    { cwd: directory, allowlist: EMPTY_ALLOWLIST, format: 'text' },
  );
  assert.equal(result.exitCode, 1);
});

test('CI bootstrap permite el fixture benigno y bloquea un secreto fuera de él', () => {
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

  const bootstrapAllowlist = path.join(directory, 'bootstrap-allowlist.json');
  fs.writeFileSync(bootstrapAllowlist, JSON.stringify({
    paths: ['.pipeline/tests/precommit-secret-scan-content.test.js'],
    globs: [],
  }));
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
  const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
  fs.writeFileSync(path.join(nested, 'audit-5244.json'), JSON.stringify({ token }));
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

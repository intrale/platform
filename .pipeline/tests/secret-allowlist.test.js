'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONTROL_PATHS, globToRe, isAllowlisted, isControlPath, loadAllowlist, whichAllowlistEntry,
} = require('../lib/secret-allowlist');

function fakeAllowlist(data, raw = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-allowlist-'));
  const file = path.join(directory, 'allowlist.json');
  fs.writeFileSync(file, raw ? data : JSON.stringify(data));
  return file;
}

test('globToRe distingue asterisco simple, doble, espacios y signo pregunta literal', () => {
  assert.ok(globToRe('docs/**/*.txt').test('docs/a/b.txt'));
  assert.equal(globToRe('docs/*.txt').test('docs/a/b.txt'), false);
  assert.ok(globToRe('docs/con espacio.txt').test('docs/con espacio.txt'));
  assert.ok(globToRe('docs/file?.txt').test('docs/file?.txt'));
  assert.equal(globToRe('docs/file?.txt').test('docs/file1.txt'), false);
});

test('loadAllowlist falla si el archivo falta o no contiene JSON válido', () => {
  assert.throws(() => loadAllowlist('archivo-inexistente.json', { strict: true }));
  assert.throws(() => loadAllowlist(fakeAllowlist('{', true), { strict: true }));
});

test('modo estricto rechaza globs amplios y paths de control', () => {
  assert.throws(
    () => loadAllowlist(fakeAllowlist({ paths: [], globs: ['**'] }), { strict: true }),
    /sobre-amplio/,
  );
  for (const controlPath of CONTROL_PATHS) {
    assert.throws(
      () => loadAllowlist(
        fakeAllowlist({ paths: [controlPath], globs: [] }),
        { strict: true },
      ),
      /path de control/,
    );
  }
  assert.throws(
    () => loadAllowlist(
      fakeAllowlist({ paths: [], globs: ['.pipeline/**'] }),
      { strict: true },
    ),
    /path de control/,
  );
});

test('allowlist conserva booleano y expone la entrada que produjo el match', () => {
  const allowlist = loadAllowlist(fakeAllowlist({
    paths: ['fixtures/exacto.txt'],
    globs: ['fixtures/**/*.fixture'],
  }), { strict: true });
  assert.equal(isAllowlisted('fixtures/exacto.txt', allowlist), true);
  assert.equal(isAllowlisted('fixtures/a/demo.fixture', allowlist), true);
  assert.equal(isAllowlisted('src/app.js', allowlist), false);
  assert.equal(whichAllowlistEntry('fixtures/exacto.txt', allowlist), 'path:fixtures/exacto.txt');
  assert.equal(
    whichAllowlistEntry('fixtures/a/demo.fixture', allowlist),
    'glob:fixtures/**/*.fixture',
  );
});

// #5244 rev-9 — `isControlPath` y el strict de `loadAllowlist` tienen que
// compartir UNA definición de "path de control". Antes el strict comparaba sólo
// contra la lista literal y un `.gitattributes` anidado pasaba la validación.
test('strict rechaza un .gitattributes anidado como path, igual que isControlPath', () => {
  const file = fakeAllowlist({ paths: ['app/.gitattributes'], globs: [] });
  assert.equal(isControlPath('app/.gitattributes'), true, 'la definición amplia ya lo consideraba control');
  assert.throws(
    () => loadAllowlist(file, { strict: true }),
    /path de control "app\/\.gitattributes" no permitido/,
    'las dos definiciones tienen que coincidir',
  );
});

test('strict rechaza un glob que alcanza un .gitattributes anidado', () => {
  const file = fakeAllowlist({ paths: [], globs: ['**/.gitattributes'] });
  assert.throws(() => loadAllowlist(file, { strict: true }), /alcanza un path de control/);
});

test('strict sigue aceptando un path benigno que sólo se parece a uno de control', () => {
  const file = fakeAllowlist({ paths: ['docs/gitattributes.md'], globs: ['docs/*.md'] });
  const allow = loadAllowlist(file, { strict: true });
  assert.equal(isAllowlisted('docs/gitattributes.md', allow), true);
});

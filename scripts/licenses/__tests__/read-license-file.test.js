// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests de la lectura acotada de LICENSE (#7592 · SR-6 · CA-7 caso 8).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MAX_BYTES, readLicenseFile, extractCopyright } = require('../read-license-file');
const { cleanupAll, track } = require('./_fixture-repo');

test.after(cleanupAll);

function sandbox() {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'licfile-7592-')));
  const pkg = path.join(root, 'node_modules', 'pkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(root, 'secreto.txt'), 'Copyright (c) NO DEBERÍA LEERSE\n');
  fs.writeFileSync(path.join(pkg, 'LICENSE'), 'MIT License\n\nCopyright (c) 2020 Ana Pérez\n\nPermission is hereby granted...\n');
  return { root, pkg };
}

test('lee el LICENSE del propio paquete y extrae el copyright', () => {
  const { pkg } = sandbox();
  assert.match(readLicenseFile(pkg, 'LICENSE'), /Permission is hereby granted/);
  assert.equal(extractCopyright(pkg), 'Copyright (c) 2020 Ana Pérez');
});

test('caso 8: un licenseFile con ../../ no se lee', () => {
  const { pkg } = sandbox();
  assert.equal(readLicenseFile(pkg, '../../secreto.txt'), null);
  assert.equal(readLicenseFile(pkg, '..\\..\\secreto.txt'), null);
  assert.equal(readLicenseFile(pkg, path.join(pkg, '..', '..', 'secreto.txt')), null, 'paths absolutos tampoco');
});

test('caso 8: un symlink que apunta afuera del paquete no se lee (fs simulado)', () => {
  const pkgDir = path.resolve('/virtual/node_modules/pkg');
  const fakeFs = {
    realpathSync: (p) => (p === pkgDir ? pkgDir : path.resolve('/virtual/secreto.txt')),
    lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false, size: 10 }),
    readFileSync: () => { throw new Error('no debería leerse'); },
  };
  assert.equal(readLicenseFile(pkgDir, 'LICENSE', { fs: fakeFs }), null);
});

test('caso 8: un archivo regular cuyo realpath sale del paquete no se lee (fs simulado)', () => {
  const pkgDir = path.resolve('/virtual/node_modules/pkg');
  const fakeFs = {
    realpathSync: (p) => (p === pkgDir ? pkgDir : path.resolve('/virtual/secreto.txt')),
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, size: 10 }),
    readFileSync: () => { throw new Error('no debería leerse'); },
  };
  assert.equal(readLicenseFile(pkgDir, 'LICENSE', { fs: fakeFs }), null);
});

test('caso 8: un symlink real hacia afuera no se lee', (t) => {
  const { root, pkg } = sandbox();
  const link = path.join(pkg, 'LICENSE-LINK');
  try {
    fs.symlinkSync(path.join(root, 'secreto.txt'), link, 'file');
  } catch (e) {
    // Windows sin privilegio de symlink: el caso queda cubierto por los dos
    // tests con fs simulado de arriba.
    t.diagnostic(`symlink no disponible en este host (${e.code}); cubierto por fs simulado`);
    return;
  }
  assert.equal(readLicenseFile(pkg, 'LICENSE-LINK'), null);
  assert.equal(extractCopyright(pkg), 'Copyright (c) 2020 Ana Pérez', 'el copyright sale sólo del LICENSE real');
});

test('caso 8: un archivo mayor a 256 KB no se lee', () => {
  const { pkg } = sandbox();
  fs.writeFileSync(path.join(pkg, 'LICENSE.big'), 'Copyright x\n' + 'a'.repeat(MAX_BYTES + 1));
  assert.equal(readLicenseFile(pkg, 'LICENSE.big'), null);
});

test('un directorio con nombre de licencia no se lee', () => {
  const { pkg } = sandbox();
  fs.mkdirSync(path.join(pkg, 'LICENSES'));
  assert.equal(readLicenseFile(pkg, 'LICENSES'), null);
});

test('el copyright extraído sale saneado y acotado a 3 líneas', () => {
  const { pkg } = sandbox();
  fs.writeFileSync(path.join(pkg, 'NOTICE'), [
    'Copyright 2001 A \u001b[31mrojo\u001b[0m',
    'Copyright 2002 B',
    'Copyright 2003 C',
    'Copyright 2004 D',
  ].join('\n'));
  const c = extractCopyright(pkg);
  assert.ok(!c.includes('\u001b'));
  assert.equal(c.split(' / ').length, 3);
});

test('sin archivos de licencia devuelve null', () => {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'licfile-7592-')));
  assert.equal(extractCopyright(root), null);
  assert.equal(extractCopyright(path.join(root, 'no-existe')), null);
});

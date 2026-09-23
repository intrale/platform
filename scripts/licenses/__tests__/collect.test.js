// Tests de los colectores Gradle y npm (#7592 · CA-1 · SR-7).
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { collectNpm } = require('../collect-npm');
const { collectGradle, resolveLicenses } = require('../collect-gradle');
const { buildAliasIndex } = require('../spdx');
const { renderInventoryJson, renderNotice, renderReport } = require('../render');
const { artifact, basePolicy, cleanupAll, lockfile, makeRepo, writeJson } = require('./_fixture-repo');

test.after(cleanupAll);

const aliasIndex = buildAliasIndex(basePolicy().aliases);

test('npm: excluye el paquete raíz, private: true y links de workspace', () => {
  const root = makeRepo({
    npm: {
      publico: { license: 'MIT' },
      interno: { license: 'UNLICENSED', private: true },
      enlazado: { link: true, resolved: 'packages/enlazado' },
    },
  });
  const { entries } = collectNpm({ rootDir: root, lockfiles: [{ path: 'package-lock.json' }], aliasIndex });
  assert.deepEqual(entries.map((e) => e.coordinate), ['publico']);
});

test('npm: devDependencies son build/test y el lockfile puede fijar el alcance', () => {
  const root = makeRepo({ npm: { prod: { license: 'MIT' }, devdep: { license: 'MIT', dev: true } } });
  const porFlag = collectNpm({ rootDir: root, lockfiles: [{ path: 'package-lock.json' }], aliasIndex }).entries;
  assert.equal(porFlag.find((e) => e.coordinate === 'prod').scope, 'distribuido');
  assert.equal(porFlag.find((e) => e.coordinate === 'devdep').scope, 'build/test');
  const fijado = collectNpm({ rootDir: root, lockfiles: [{ path: 'package-lock.json', alcance: 'build/test' }], aliasIndex }).entries;
  assert.ok(fijado.every((e) => e.scope === 'build/test'));
});

test('npm: la salida no contiene resolved, integrity ni credenciales (SR-7)', () => {
  const root = makeRepo({ npm: { pkg: { license: 'MIT', resolved: 'https://u:p@r.example/pkg.tgz?_authToken=abc' } } }); // secret-scan:ignore (fixture falso)
  const policy = basePolicy();
  const { entries } = collectNpm({ rootDir: root, lockfiles: [{ path: 'package-lock.json' }], aliasIndex });
  for (const out of [
    JSON.stringify(entries),
    renderInventoryJson(entries),
    renderNotice(entries, policy, {}),
    renderReport(entries, policy),
  ]) {
    assert.ok(!out.includes('resolved'), 'no debe copiar resolved');
    assert.ok(!out.includes('integrity') && !out.includes('sha512'), 'no debe copiar integrity');
    assert.ok(!out.includes('_authToken') && !out.includes('u:p@'), 'no debe filtrar credenciales');
  }
  assert.equal(entries[0].url, 'https://www.npmjs.com/package/pkg');
});

test('npm: un lockfile faltante o de versión vieja hace fallar al colector', () => {
  const root = makeRepo();
  assert.throws(() => collectNpm({ rootDir: root, lockfiles: [{ path: 'no-existe/package-lock.json' }], aliasIndex }), /no se pudo leer/);
  writeJson(root, 'viejo/package-lock.json', { lockfileVersion: 1, dependencies: {} });
  assert.throws(() => collectNpm({ rootDir: root, lockfiles: [{ path: 'viejo/package-lock.json' }], aliasIndex }), /lockfileVersion 2 o 3/);
});

test('npm: la misma versión en dos lockfiles se deduplica y gana distribuido', () => {
  const root = makeRepo({ npm: { comun: { license: 'MIT', dev: true } } });
  writeJson(root, 'otro/package-lock.json', lockfile({ comun: { license: 'MIT' } }));
  const { entries } = collectNpm({ rootDir: root, lockfiles: [{ path: 'package-lock.json' }, { path: 'otro/package-lock.json' }], aliasIndex });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, 'distribuido');
  assert.deepEqual(entries[0].origins, ['otro/package-lock.json', 'package-lock.json']);
});

test('gradle: falta el artifacts.json de un módulo esperado ⇒ error con el comando a correr', () => {
  const root = makeRepo({ gradle: { lib: [artifact('a', 'b', '1', 'MIT')], tool: null } });
  assert.throws(
    () => collectGradle({ rootDir: root, modules: basePolicy().gradle.modulos, aliasIndex }),
    /faltan los artifacts\.json de licensee en: :tool\. Ejecutá: \.\/gradlew licensesInventory/
  );
});

test('gradle: un artifacts.json corrupto hace fallar al colector', () => {
  const root = makeRepo();
  require('node:fs').writeFileSync(require('node:path').join(root, 'lib/build/reports/licensee/jvm/artifacts.json'), '{no json');
  assert.throws(() => collectGradle({ rootDir: root, modules: basePolicy().gradle.modulos, aliasIndex }), /ilegible/);
});

test('gradle: licencias no mapeadas por licensee se resuelven con alias por URL o nombre', () => {
  const r = resolveLicenses({ unknownLicenses: [{ name: 'Apache License, Version 2.0', url: 'https://aws.amazon.com/apache2.0' }] }, aliasIndex);
  assert.equal(r.expression, 'Apache-2.0');
  const porNombre = resolveLicenses({ unknownLicenses: [{ name: 'Apache License, Version 2.0', url: 'https://otra.example/lic' }] }, aliasIndex);
  assert.equal(porNombre.expression, 'Apache-2.0');
});

test('gradle: varias licencias en el POM se leen como OR (licenciamiento dual)', () => {
  const r = resolveLicenses({ spdxLicenses: [{ identifier: 'EPL-1.0' }, { identifier: 'LGPL-2.1-only' }] }, aliasIndex);
  assert.equal(r.expression, 'EPL-1.0 OR LGPL-2.1-only');
});

test('gradle: sin licencias en el POM o sin ningún mapeo ⇒ desconocida', () => {
  assert.equal(resolveLicenses({}, aliasIndex).expression, null);
  assert.match(resolveLicenses({}, aliasIndex).unknownReason, /sin licencia declarada/);
  const r = resolveLicenses({ unknownLicenses: [{ name: 'Custom EULA', url: 'https://x.example/eula' }] }, aliasIndex);
  assert.equal(r.expression, null);
  assert.deepEqual(r.unmapped, ['Custom EULA <https://x.example/eula>']);
});

test('gradle: el alcance sale del módulo y distribuido gana al deduplicar', () => {
  const shared = artifact('org.jetbrains.kotlin', 'kotlin-stdlib', '2.2.21', 'Apache-2.0');
  const root = makeRepo({
    gradle: { lib: [shared], tool: [shared, artifact('org.junit', 'junit', '5', 'EPL-2.0')] },
  });
  const { entries } = collectGradle({ rootDir: root, modules: basePolicy().gradle.modulos, aliasIndex });
  const byCoord = Object.fromEntries(entries.map((e) => [e.coordinate, e]));
  assert.equal(byCoord['org.jetbrains.kotlin:kotlin-stdlib'].scope, 'distribuido');
  assert.deepEqual(byCoord['org.jetbrains.kotlin:kotlin-stdlib'].origins, [':lib', ':tool']);
  assert.equal(byCoord['org.junit:junit'].scope, 'build/test');
});

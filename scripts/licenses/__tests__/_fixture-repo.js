// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Helper de tests (#7592): arma un "repo" mínimo en un dir temporal con la
// política, los artifacts.json de licensee y los lockfiles npm. Cada dir se
// borra con cleanupAll() (registrado en `after` por cada suite) para no repetir
// la fuga de fixtures en %TEMP% de #7210.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];

function basePolicy(overrides = {}) {
  return {
    version: 1,
    gradle: {
      modulos: [
        { path: ':lib', dir: 'lib', alcance: 'distribuido' },
        { path: ':tool', dir: 'tool', alcance: 'build/test' },
      ],
    },
    npm: {
      lockfiles: [{ path: 'package-lock.json' }],
      excluidos: [{ path: 'fixtures/x/package-lock.json', motivo: 'fixture de test' }],
    },
    allowed: [
      { id: 'MIT', obligacion: 'atribución en NOTICE' },
      { id: 'Apache-2.0', obligacion: 'atribución en NOTICE' },
      { id: 'BSD-3-Clause', obligacion: 'atribución en NOTICE' },
    ],
    allowed_with_obligation: [
      { id: 'LGPL-2.1-only', obligacion: 'publicar cambios a la librería', motivo: 'copyleft débil' },
    ],
    denied: [
      { regla: 'gpl', prefijos: ['GPL-'], motivo: 'copyleft fuerte: obliga a abrir código propio' },
      { regla: 'agpl', prefijos: ['AGPL-'], motivo: 'copyleft de red' },
    ],
    with_exceptions: [],
    aliases: { 'Apache License, Version 2.0': 'Apache-2.0', 'https://aws.amazon.com/apache2.0': 'Apache-2.0' },
    out_of_scope: [{ item: 'SDKs de plataforma', motivo: 'los provee la plataforma' }],
    exceptions: [],
    ...overrides,
  };
}

function artifact(group, name, version, spdx, extra = {}) {
  return {
    groupId: group,
    artifactId: name,
    version,
    name,
    spdxLicenses: spdx ? [].concat(spdx).map((id) => ({ identifier: id, name: id, url: `https://spdx.org/licenses/${id}` })) : [],
    scm: { url: `https://github.com/${group}/${name}` },
    ...extra,
  };
}

function lockfile(packages) {
  const out = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } };
  for (const [name, p] of Object.entries(packages)) {
    out.packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: `https://user:s3cret@registry.example.com/${name}/-/${name}-1.0.0.tgz`, // secret-scan:ignore (fixture falso)
      integrity: 'sha512-AAAA',
      ...p,
    };
  }
  return out;
}

function writeJson(root, rel, data) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
}

/**
 * @param {object} [spec]
 * @param {object} [spec.policy]
 * @param {Record<string, object[]|null>} [spec.gradle]  dir de módulo → artifacts (null = sin reporte)
 * @param {object} [spec.npm]  paquetes del lockfile raíz
 */
function makeRepo(spec = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-7592-'));
  created.push(root);
  writeJson(root, 'config/licenses/policy.json', spec.policy || basePolicy());
  const gradle = spec.gradle || {
    lib: [artifact('org.example', 'core', '1.0.0', 'Apache-2.0')],
    tool: [artifact('org.junit', 'junit', '5.0.0', 'MIT')],
  };
  for (const [dir, arts] of Object.entries(gradle)) {
    if (arts === null) continue;
    writeJson(root, `${dir}/build/reports/licensee/jvm/artifacts.json`, arts);
  }
  const npm = spec.npm || { 'left-pad': { license: 'MIT' }, husky: { license: 'MIT', dev: true } };
  writeJson(root, 'package-lock.json', lockfile(npm));
  return root;
}

function cleanupAll() {
  while (created.length) {
    const dir = created.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function track(dir) {
  created.push(dir);
  return dir;
}

/** Captura stdout/stderr de cli.run. */
function captureIo() {
  const lines = { out: [], err: [] };
  return {
    lines,
    stdout: (s) => lines.out.push(s),
    stderr: (s) => lines.err.push(s),
    text: () => [...lines.out, ...lines.err].join('\n'),
  };
}

module.exports = { artifact, basePolicy, captureIo, cleanupAll, lockfile, makeRepo, track, writeJson };

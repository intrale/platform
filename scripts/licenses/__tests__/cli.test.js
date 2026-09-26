// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests del CLI generate/check (#7592 · CA-1 · CA-2 · CA-3 · CA-7 casos 9 y 10).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { run, FILES } = require('../cli');
const { APPROVAL_LABEL } = require('../exceptions-diff');
const { artifact, basePolicy, captureIo, cleanupAll, lockfile, makeRepo, writeJson } = require('./_fixture-repo');

test.after(cleanupAll);

const NOW = new Date('2026-09-23T12:00:00Z');
const noGit = () => { throw new Error('git no disponible en el test'); };

async function generate(root) {
  const io = captureIo();
  const code = await run(['generate', '--root', root], io);
  assert.equal(code, 0, io.text());
}

async function check(root, deps = {}) {
  const io = captureIo();
  const code = await run(['check', '--root', root], { env: {}, now: NOW, execGit: noGit, ...io, ...deps });
  return { code, text: io.text(), io };
}

function readAll(root) {
  return Object.fromEntries([FILES.notice, FILES.report, FILES.inventory, FILES.copyrights]
    .map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
}

test('generate + check en verde sobre un repo sano', async () => {
  const root = makeRepo();
  await generate(root);
  const r = await check(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Gate de licencias: 0 prohibidas .* — 4 dependencias revisadas \(gradle 2 · npm 2\)/);
});

test('determinismo: dos corridas de generate producen bytes idénticos', async () => {
  const root = makeRepo();
  await generate(root);
  const first = readAll(root);
  await generate(root);
  assert.deepEqual(readAll(root), first);
  for (const content of Object.values(first)) {
    assert.ok(!content.includes(root), 'no puede haber paths absolutos locales');
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(content), 'no puede haber timestamps');
  }
});

test('el NOTICE separa lo distribuido de las herramientas de build/test', async () => {
  const root = makeRepo();
  await generate(root);
  const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');
  assert.match(notice, /org\.example:core 1\.0\.0\n {2}Licencia: Apache-2\.0\n {2}Copyright: .*\n {2}Proyecto: https:\/\/github\.com\/org\.example\/core/);
  assert.ok(!notice.includes('org.junit:junit'), 'el tooling de test no va al NOTICE');
  assert.match(notice, /Herramientas de build\/test \(no distribuidas\)/);
  const report = fs.readFileSync(path.join(root, FILES.report), 'utf8');
  assert.match(report, /## Distribuido con el producto[\s\S]*org\.example:core[\s\S]*## Herramientas de build\/test \(no distribuidas\)[\s\S]*org\.junit:junit/);
  assert.match(report, /## Fuera de alcance[\s\S]*fixtures\/x\/package-lock\.json \| fixture de test/);
  assert.match(report, /\| SDKs de plataforma \| los provee la plataforma \|/);
});

test('caso 10: NOTICE desactualizado ⇒ el drift check falla con el comando para regenerar', async () => {
  const root = makeRepo();
  await generate(root);
  writeJson(root, 'package-lock.json', lockfile({ 'left-pad': { license: 'MIT' }, nueva: { license: 'ISC' } }));
  const policy = basePolicy();
  policy.allowed.push({ id: 'ISC' });
  writeJson(root, 'config/licenses/policy.json', policy);
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /DRIFT: NOTICE \/ reporte de licencias — el NOTICE no coincide con las dependencias actuales/);
  assert.match(r.text, /\+ nueva@1\.0\.0/);
  assert.match(r.text, /→ Ejecutá: npm run licenses:generate/);
});

test('el drift ignora diferencias de fin de línea (checkout con CRLF en Windows)', async () => {
  const root = makeRepo();
  await generate(root);
  const notice = path.join(root, 'NOTICE');
  fs.writeFileSync(notice, fs.readFileSync(notice, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal((await check(root)).code, 0);
});

test('caso 9: un colector que falla (artifacts.json faltante) ⇒ exit ≠ 0', async () => {
  const root = makeRepo({ gradle: { lib: [artifact('a', 'b', '1', 'MIT')], tool: null } });
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /INVENTARIO: colector Gradle: faltan los artifacts\.json de licensee en: :tool/);
});

test('caso 9: inventario vacío o un ecosistema en cero ⇒ exit ≠ 0', async () => {
  const vacio = makeRepo({ gradle: { lib: [], tool: [] }, npm: {} });
  const r1 = await check(vacio);
  assert.equal(r1.code, 1);
  assert.match(r1.text, /el inventario salió vacío/);

  const sinNpm = makeRepo({ npm: {} });
  const r2 = await check(sinNpm);
  assert.equal(r2.code, 1);
  assert.match(r2.text, /el ecosistema npm tiene 0 dependencias/);
});

test('caso 9: una política ilegible ⇒ exit ≠ 0', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'config/licenses/policy.json'), '{ roto');
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /INVENTARIO: config\/licenses\/policy\.json no es JSON válido/);
});

test('caso 2 end-to-end: una dependencia GPL en el inventario hace fallar check', async () => {
  const root = makeRepo({
    gradle: { lib: [artifact('org.evil', 'gpl-core', '3.1.0', 'GPL-3.0-only')], tool: [artifact('org.junit', 'junit', '5', 'MIT')] },
  });
  await generate(root);
  const r = await check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /LICENCIA PROHIBIDA: org\.evil:gpl-core@3\.1\.0 — GPL-3\.0-only — regla denied\[gpl\] — copyleft fuerte/);
  assert.match(r.text, /1 prohibidas/);
});

test('una excepción nueva sin el label humano falla en check; con el label pasa', async () => {
  const exc = {
    paquete: 'org.evil:gpl-core@3.1.0',
    licencia: 'GPL-3.0-only',
    justificacion: 'Herramienta interna evaluada por legal',
    aprobado_por: 'leitolarreta',
    revisar_antes: '2027-01-31',
  };
  const root = makeRepo({
    policy: basePolicy({ exceptions: [exc] }),
    gradle: { lib: [artifact('org.evil', 'gpl-core', '3.1.0', 'GPL-3.0-only')], tool: [artifact('org.junit', 'junit', '5', 'MIT')] },
  });
  await generate(root);
  const execGit = (args) => {
    if (args[0] === 'rev-parse') return 'sha';
    if (args[0] === 'show' && args[1].endsWith(':config/licenses/policy.json')) return JSON.stringify(basePolicy());
    throw new Error('no existe en la base');
  };
  const env = { GITHUB_BASE_REF: 'main' };

  const sinLabel = await check(root, { env, execGit, fetchLabels: async () => ['area:infra'] });
  assert.equal(sinLabel.code, 1);
  assert.match(sinLabel.text, /EXCEPCIÓN SIN APROBAR: org\.evil:gpl-core@3\.1\.0/);

  const conLabel = await check(root, { env, execGit, fetchLabels: async () => [APPROVAL_LABEL] });
  assert.equal(conLabel.code, 0, conLabel.text);

  const programada = await check(root, { env: {}, execGit: noGit });
  assert.equal(programada.code, 0, 'sin rama base (schedule) no se exige el label');
});

test('copyright: generate con y sin node_modules da la misma salida (caché versionado)', async () => {
  const root = makeRepo({ npm: { lib: { license: 'MIT' } } });
  const pkgDir = path.join(root, 'node_modules', 'lib');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'LICENSE'), 'MIT\nCopyright (c) 2021 Autora Ejemplo\n');
  await generate(root);
  const conModules = readAll(root);
  assert.match(conModules.NOTICE, /lib 1\.0\.0\n {2}Licencia: MIT\n {2}Copyright: Copyright \(c\) 2021 Autora Ejemplo/);

  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  await generate(root);
  assert.deepEqual(readAll(root), conModules, 'sin node_modules se usa el caché: misma salida');
  assert.equal((await check(root)).code, 0, 'check no depende de node_modules');
});

test('copyright ausente sale determinista como "no declarado"', async () => {
  const root = makeRepo({ npm: { lib: { license: 'MIT' } } });
  await generate(root);
  assert.match(fs.readFileSync(path.join(root, 'NOTICE'), 'utf8'), /lib 1\.0\.0\n {2}Licencia: MIT\n {2}Copyright: no declarado en los metadatos del paquete/);
});

test('Step Summary: veredicto primero, cambios respecto de la base y excepciones vigentes', async () => {
  const root = makeRepo();
  await generate(root);
  const baseInventory = JSON.parse(fs.readFileSync(path.join(root, FILES.inventory), 'utf8')).slice(1);
  const execGit = (args) => {
    if (args[0] === 'rev-parse') return 'sha';
    if (args[1].endsWith(FILES.inventory)) return JSON.stringify(baseInventory);
    return JSON.stringify(basePolicy());
  };
  const summary = path.join(root, 'summary.md');
  const r = await check(root, { env: { GITHUB_BASE_REF: 'main', GITHUB_STEP_SUMMARY: summary }, execGit });
  assert.equal(r.code, 0, r.text);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /^## ✅ Gate de licencias en verde — 4 dependencias revisadas/);
  assert.match(text, /### Cambios respecto de la base[\s\S]*\| nueva \|/);
  assert.match(text, /### Excepciones vigentes/);
});

test('comando desconocido ⇒ exit 2 con el uso', async () => {
  const io = captureIo();
  assert.equal(await run(['otra-cosa'], io), 2);
  assert.match(io.text(), /Uso: node scripts\/licenses\/cli\.js <generate\|check>/);
});

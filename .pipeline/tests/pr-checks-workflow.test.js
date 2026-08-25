const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github', 'workflows', 'pr-checks.yml'), 'utf8')
);

test('e2e-qa inicia users en un puerto no privilegiado y usa la misma URL', () => {
  const steps = workflow.jobs['e2e-qa'].steps;
  const startBackend = steps.find((step) => step.name === 'Start backend');
  const runQa = steps.find((step) => step.name === 'Run E2E QA tests');

  assert.ok(startBackend, 'falta el step Start backend');
  assert.ok(runQa, 'falta el step Run E2E QA tests');

  const port = Number(startBackend.env.PORT);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, `puerto E2E invalido: ${port}`);
  assert.match(startBackend.run, new RegExp(`http://localhost:${port}/intrale/signin`));
  assert.equal(runQa.env.QA_BASE_URL, `http://localhost:${port}`);
});

test('e2e-qa se omite formalmente cuando el PR declara qa:skipped', () => {
  const condition = workflow.jobs['e2e-qa'].if;

  assert.match(condition, /!contains\(github\.event\.pull_request\.labels\.\*\.name, 'qa:skipped'\)/);
  assert.match(condition, /needs\.detect-changes\.outputs\.backend == 'true'/);
  assert.match(condition, /needs\.detect-changes\.outputs\.users == 'true'/);
  assert.match(condition, /needs\.detect-changes\.outputs\.shared == 'true'/);
});

test('e2e-qa publica evidencia como artefacto sin escribir en la rama del PR', () => {
  const job = workflow.jobs['e2e-qa'];
  const collect = job.steps.find((step) => step.name === 'Collect QA evidence');
  const upload = job.steps.find((step) => step.name === 'Upload collected QA evidence');
  const commands = job.steps.map((step) => step.run || '').join('\n');

  assert.ok(collect, 'falta recolectar la evidencia');
  assert.equal(collect.run, 'bash qa/scripts/collect-evidence.sh');
  assert.ok(upload, 'falta publicar la evidencia como artefacto');
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  assert.equal(upload.with.path, 'qa/evidence/');
  assert.doesNotMatch(commands, /git\s+(?:add|commit|push)\b/);
  assert.equal(job.permissions, undefined, 'e2e-qa no debe pedir contents: write');
});

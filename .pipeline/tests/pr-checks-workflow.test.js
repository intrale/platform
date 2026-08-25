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

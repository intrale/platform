const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const qaRole = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'roles', 'qa.md'),
  'utf8',
);

test('QA estructural exige evidencia auditable y descriptor canonico en Drive', () => {
  assert.match(qaRole, /qa-<issue>-structural\.md/);
  assert.match(qaRole, /servicios\/drive\/pendiente\/qa-<issue>-structural\.json/);
  assert.match(qaRole, /"mode": "structural"/);
  assert.match(qaRole, /"source": "qa-structural"/);
});

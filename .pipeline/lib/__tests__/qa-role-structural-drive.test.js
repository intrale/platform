const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el rol QA documenta el job Drive canónico para evidencia estructural', () => {
  const role = fs.readFileSync(path.resolve(__dirname, '../../roles/qa.md'), 'utf8');

  assert.match(role, /qa-<issue>-structural\.json/);
  assert.match(role, /\.pipeline\/desarrollo\/verificacion\/procesado\/<issue>\.qa/);
  assert.match(role, /"mode": "structural"/);
  assert.match(role, /"source": "qa-structural"/);
  assert.match(role, /"criteriosVerificados": \["CA-1"/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rolePath = path.join(__dirname, '..', 'roles', 'qa.md');

test('QA estructural exige encolar su reporte con el schema canónico de Drive', () => {
  const role = fs.readFileSync(rolePath, 'utf8');
  const structuralSection = role.match(/## QA Estructural[\s\S]*?\r?\n---\r?\n/);

  assert.ok(structuralSection, 'debe existir la sección QA Estructural');
  assert.match(structuralSection[0], /servicios\/drive\/pendiente\/qa-<issue>-structural\.json/);
  assert.match(structuralSection[0], /"mode": "structural"/);
  assert.match(structuralSection[0], /"source": "qa-structural"/);
  assert.match(structuralSection[0], /antes de emitir\s+`resultado: aprobado`/);
});

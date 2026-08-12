'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const role = fs.readFileSync(path.resolve(__dirname, '..', 'roles', 'qa.md'), 'utf8');

test('#5708 · QA structural con mockup versionado exige evidencia visual real', () => {
  assert.match(role, /structural` significa \*\*sin emulador\*\*, no "sin render"/);
  assert.match(role, /qa\/evidence\/<issue>\/visual-comparison\.json/);
  assert.match(role, /\.pipeline\/logs\/rejection-<issue>-qa\.pdf/);
  assert.match(role, /screenshot-pdf-vs-mockup\.png/);
  assert.match(role, /hashes SHA-256/);
});

test('#5708 · la verificación visual no se satisface con unit tests o renderHtml aislado', () => {
  assert.match(role, /no\s+alcanza con invocar `renderHtml\(\)`/);
  assert.match(role, /No se debe pedir otro `QA_MODE`/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const delivery = require('../delivery');

test('updateMarker serializa el hint como flow mapping YAML', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-hint-')), 'marker');
  fs.writeFileSync(file, 'issue: 6432\n');
  delivery.updateMarker(file, { precondicion_merge_checks: { pr: 6500, head_sha: 'a'.repeat(40) } });
  assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')).precondicion_merge_checks, { pr: 6500, head_sha: 'a'.repeat(40) });
});

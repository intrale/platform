'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = fs.readFileSync(
  path.join(__dirname, '..', '..', '.husky', 'pre-commit'),
  'utf8',
);

test('pre-commit invoca secret-scan antes y fuera del gate agent-models', () => {
  const scan = HOOK.indexOf('node .pipeline/lib/precommit-secret-scan.js');
  const validationGate = HOOK.indexOf('if [ "$RUN_VALIDATE" = "1" ]');
  assert.ok(scan >= 0, 'falta invocación del secret-scan');
  assert.ok(validationGate >= 0, 'falta gate de agent-models');
  assert.ok(scan < validationGate, 'secret-scan debe ejecutarse antes del gate');
});

test('pre-commit no termina temprano cuando RUN_VALIDATE vale cero', () => {
  assert.doesNotMatch(
    HOOK,
    /if \[ "\$RUN_VALIDATE" = "0" \]; then\s+exit 0\s+fi/,
  );
});

test('pre-commit preserva fail-closed del secret-scan', () => {
  assert.match(HOOK, /SCAN_EXIT=\$\?/);
  assert.match(HOOK, /if \[ "\$SCAN_EXIT" != "0" \]; then[\s\S]*exit "\$SCAN_EXIT"/);
});

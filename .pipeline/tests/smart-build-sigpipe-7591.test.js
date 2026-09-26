// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// #7591 — smart-build.sh abortaba con exit 141 (SIGPIPE) cuando el diff contra
// main superaba el buffer del pipe: `set -o pipefail` + `echo "$changed" | head`.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'smart-build.sh');

test('smart-build.sh no pipea $changed a head/wc (evita SIGPIPE con pipefail)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/set -euo pipefail/.test(src), 'el script sigue con pipefail');
  assert.ok(!/echo\s+"\$changed"\s*\|/.test(src), 'no debe existir `echo "$changed" | ...`');
});

test('el patrón herestring lista un diff enorme sin morir por SIGPIPE', () => {
  const probe = [
    'set -euo pipefail',
    'changed=$(seq 1 50000 | sed "s|^|some/long/path/file-|")',
    'head -n 20 <<< "$changed" > /dev/null',
    'total=$(wc -l <<< "$changed")',
    'echo "$total"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
  if (r.error) return; // sin bash disponible: no aplica
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '50000');
});

// Guardia estática (#7592 · D1): el label `licencias:excepcion-aprobada` lo
// aplica SÓLO un humano. Ningún código ejecutable del pipeline, de los hooks ni
// de los skills puede aplicarlo. La mera mención (docs, handoffs, este gate) no
// cuenta: se busca la ACCIÓN de aplicar el label.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { APPROVAL_LABEL } = require('../exceptions-diff');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ROOTS = ['.pipeline', path.join('.claude', 'skills'), path.join('.claude', 'hooks')];
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'handoff', 'assets', 'audit']);
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.sh', '.ps1', '.py', '.md']);
const MAX_FILE = 2 * 1024 * 1024;

// Acción de aplicar un label en la misma línea que el nombre del label.
const APPLY_RE = new RegExp(
  String.raw`(--add-label|addLabels?|add_labels?|labels\s*[:=]|/labels\b|label\s+add)[^\n]{0,160}`
    + APPROVAL_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '|'
    + APPROVAL_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + String.raw`[^\n]{0,160}(--add-label|addLabels?|add_labels?)`,
  'i'
);

function* walk(dir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.isSymbolicLink()) continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name) || it.name.startsWith('tmp') || it.name.startsWith('_tmp')) continue;
      yield* walk(p);
    } else if (it.isFile() && CODE_EXT.has(path.extname(it.name))) {
      yield p;
    }
  }
}

test('el detector reconoce la acción de aplicar el label', () => {
  assert.ok(APPLY_RE.test(`gh pr edit 12 --add-label ${APPROVAL_LABEL}`));
  assert.ok(APPLY_RE.test(`await octokit.issues.addLabels({ labels: ['${APPROVAL_LABEL}'] })`));
  assert.ok(!APPLY_RE.test(`El label ${APPROVAL_LABEL} lo aplica sólo un humano.`));
});

test('ningún código del pipeline, hooks ni skills aplica licencias:excepcion-aprobada', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(REPO, root))) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes(APPROVAL_LABEL)) continue;
      if (APPLY_RE.test(text)) offenders.push(path.relative(REPO, file));
    }
  }
  assert.deepEqual(offenders, [], `aplican el label humano de excepciones de licencias: ${offenders.join(', ')}`);
});

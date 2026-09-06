'use strict';

// =============================================================================
// intake-gh-list-limit-7013.test.js — el tope de listado del intake no puede
// volver a quedar por debajo del backlog admisible (#7013).
//
// GitHub aplica `--limit` server-side y devuelve los issues MAS NUEVOS primero;
// el filtro de ola corre despues, en JS. Con un tope chico, los issues de ola
// mas viejos que el corte no entran NUNCA al pipeline. Estos tests fijan la
// constante como fuente unica y verifican que la usan los DOS call sites (el
// dry-run y el intake real), para que nadie parchee uno solo.
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1'; // permitir require sin arrancar el pulpo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pulpo = require('../../pulpo.js');

test('INTAKE_GH_LIST_LIMIT queda holgadamente por encima del backlog admisible', () => {
  assert.equal(typeof pulpo.INTAKE_GH_LIST_LIMIT, 'number');
  assert.ok(
    pulpo.INTAKE_GH_LIST_LIMIT >= 500,
    `el tope del intake no puede bajar de 500 (actual: ${pulpo.INTAKE_GH_LIST_LIMIT})`,
  );
});

test('discoverWorkDryRun pide el listado con el tope de la constante', () => {
  const calls = [];
  pulpo.discoverWorkDryRun(
    { intake: { definicion: { label: 'needs-definition' } } },
    {
      exec: (cmd) => { calls.push(cmd); return '[]'; },
      getIntakeRepos: () => ['intrale/platform'],
      isRepoAllowed: () => true,
    },
  );
  assert.ok(calls.length > 0, 'el dry-run debe consultar al menos un pase');
  for (const cmd of calls) {
    assert.ok(cmd.includes(`--limit ${pulpo.INTAKE_GH_LIST_LIMIT} `), `call site sin el tope de la constante: ${cmd}`);
  }
});

test('ningun call site del intake quedo con el tope hardcodeado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  const hardcoded = src
    .split('\n')
    .filter((l) => /issue list .*--limit \d+ --search/.test(l));
  assert.deepEqual(
    hardcoded,
    [],
    `los listados del intake deben usar INTAKE_GH_LIST_LIMIT, no un numero literal:\n${hardcoded.join('\n')}`,
  );
});

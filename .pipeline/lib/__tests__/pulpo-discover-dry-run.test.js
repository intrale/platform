'use strict';

// =============================================================================
// pulpo-discover-dry-run.test.js — descubrimiento side-effect-free (P2 · #4687)
//
// Verifica el paso 4 del bootstrap expuesto en el Pulpo: `discoverWorkDryRun`
// LISTA el trabajo del tablero SIN ejecutar (requisito de seguridad #10). Reusa
// la allowlist fail-closed de repo-target (no consulta repos no allowlisted).
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1'; // permitir require sin arrancar el pulpo.

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('../../pulpo.js');

const config = { intake: { desarrollo: { label: 'Ready' }, definicion: { label: 'needs-definition' } } };

test('discoverWorkDryRun LISTA issues sin efectos de lado', () => {
  const calls = [];
  const res = pulpo.discoverWorkDryRun(config, {
    exec: (cmd) => { calls.push(cmd); return JSON.stringify([{ number: 4687, title: 'P2 descriptor' }]); },
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.equal(res.sideEffects, false);
  assert.equal(res.discovered.length, 2); // 1 issue × 2 pipelines (Ready + needs-definition)
  assert.ok(res.discovered.every((w) => w.number === 4687));
  // sólo comandos de LECTURA (gh issue list), jamás mutaciones.
  assert.ok(calls.every((c) => c.includes('issue list')));
});

test('discoverWorkDryRun es fail-closed: no consulta repos no allowlisted', () => {
  let execCalled = false;
  const res = pulpo.discoverWorkDryRun(config, {
    exec: () => { execCalled = true; return '[]'; },
    getIntakeRepos: () => ['evil/repo'],
    isRepoAllowed: () => false,
  });
  assert.equal(execCalled, false, 'no debe ejecutar gh contra un repo no allowlisted');
  assert.deepEqual(res.skippedRepos, ['evil/repo', 'evil/repo']);
  assert.equal(res.discovered.length, 0);
});

test('discoverWorkDryRun tolera repos caídos (exec lanza) sin tumbar el descubrimiento', () => {
  const res = pulpo.discoverWorkDryRun(config, {
    exec: () => { throw new Error('gh timeout'); },
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.equal(res.discovered.length, 0);
  assert.equal(res.sideEffects, false);
});

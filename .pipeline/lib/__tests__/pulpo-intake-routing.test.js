'use strict';

// =============================================================================
// pulpo-intake-routing.test.js — Ruteo del intake por instancia (P4 · #4763)
//
// CA-5 (no-regresión single-product): sin router multi-instancia, `resolveIntakeRepo`
// rutea EXACTAMENTE como el path vigente (repo-target.getRepoForIssue → repo de
// origen propagado o primary). Con router multi-instancia activo, delega en el
// multiplexor fail-closed y descarta (null) lo que cae fuera de allowlist.
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1'; // permitir require sin arrancar el pulpo.

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('../../pulpo.js');
const repoTarget = require('../repo-target');

test('CA-5 · sin router multi-instancia: resolveIntakeRepo == getRepoForIssue (single-product)', () => {
  pulpo.setMultiInstanceRouter(null);
  assert.equal(pulpo.getMultiInstanceRouter(), null);
  // issue sin repo de origen → primary global (comportamiento vigente).
  const issue = { number: 1, title: 'x' };
  assert.equal(pulpo.resolveIntakeRepo(issue), repoTarget.getPrimaryRepo());
});

test('CA-5 · router ignora descriptores mal formados (sin .get) → sigue en single-product', () => {
  pulpo.setMultiInstanceRouter({ descriptors: {} }); // sin get() válido
  assert.equal(pulpo.getMultiInstanceRouter(), null, 'router inválido no se activa');
  assert.equal(pulpo.resolveIntakeRepo({ number: 2 }), repoTarget.getPrimaryRepo());
});

test('router multi-instancia activo: issue con projectId+repo en allowlist → repo de la instancia', () => {
  const descriptors = new Map();
  descriptors.set('product-a', {
    projectId: 'product-a',
    descriptor: { repositories: [{ id: 'a', url: 'acme-org/product-a', role: 'primary' }] },
  });
  const discards = [];
  pulpo.setMultiInstanceRouter({ descriptors, audit: (info) => discards.push(info) });

  assert.equal(
    pulpo.resolveIntakeRepo({ number: 3, projectId: 'product-a', origin_repo: 'acme-org/product-a' }),
    'acme-org/product-a',
  );
  // fuera de allowlist ⇒ null (descartado + auditado), NUNCA primary.
  assert.equal(pulpo.resolveIntakeRepo({ number: 4, projectId: 'product-a', origin_repo: 'evil/repo' }), null);
  // projectId inseguro ⇒ null.
  assert.equal(pulpo.resolveIntakeRepo({ number: 5, projectId: '../evil' }), null);
  assert.ok(discards.some((d) => d.reason === 'repo fuera de allowlist'));
  assert.ok(discards.some((d) => d.reason === 'projectId inseguro'));

  pulpo.setMultiInstanceRouter(null); // restaurar estado single-product para otros tests.
});

test('router activo pero issue SIN projectId → cae al ruteo global (compat intake single-product)', () => {
  const descriptors = new Map();
  descriptors.set('product-a', { projectId: 'product-a', descriptor: { repositories: [{ id: 'a', url: 'acme-org/product-a', role: 'primary' }] } });
  pulpo.setMultiInstanceRouter({ descriptors });
  // Sin projectId, el intake vigente (issues de un solo producto) sigue funcionando.
  assert.equal(pulpo.resolveIntakeRepo({ number: 6 }), repoTarget.getPrimaryRepo());
  pulpo.setMultiInstanceRouter(null);
});

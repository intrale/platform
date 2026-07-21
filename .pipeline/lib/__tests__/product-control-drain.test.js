'use strict';

// =============================================================================
// product-control-drain.test.js — Drainer kernel-side de onboarding (#4800).
//
// Cobertura → criterios de aceptación / seguridad:
//   - CA-1  : create ⇒ crea repo, completa URL limpia, registra en full.
//   - CA-4  : idempotencia (no re-crea) + 422 name already exists sin estado a medias.
//   - CA-SEC-1 : `gh` SIEMPRE por array de args (verificación estática anti-shell).
//   - CA-SEC-2 : org fuera de allowlist ⇒ rechazo sin invocar gh.
//   - CA-SEC-3 : default private; public sólo con elección explícita.
//   - CA-SEC-4 : token nunca en descriptor/args; URL persistida es la forma limpia.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drainLib = require('../product-control-drain');

function validDescriptor(repo, overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: 'acme-store', name: 'ACME Store' },
    repositories: [repo],
    board: { ref: 'https://github.com/orgs/acme/projects/1', admissionLabels: ['Ready'], routing: [{ label: 'area:backend', capability: 'backend' }] },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

function onboardRequest(repo, overrides) {
  return { type: 'product_onboard_request', projectId: 'acme-store', descriptor: validDescriptor(repo, overrides) };
}

// Fake gh: registra cada invocación; `viewExists` decide si `repo view` "encuentra".
function makeFakeGh({ viewExists = false, createThrows = null } = {}) {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args]);
    assert.equal(bin, 'gh');
    assert.ok(Array.isArray(args), 'gh debe invocarse con array de args (anti-injection)');
    if (args[1] === 'view') {
      if (viewExists) return '';
      const e = new Error('not found'); throw e;
    }
    if (args[1] === 'create') {
      if (createThrows) throw new Error(createThrows);
      return '';
    }
    return '';
  };
  return { calls, exec };
}

// -----------------------------------------------------------------------------
// CA-1 — create crea el repo, completa la URL limpia y registra en full
// -----------------------------------------------------------------------------

test('CA-1: provenance:create crea el repo y completa la URL limpia en el registro', () => {
  const gh = makeFakeGh({ viewExists: false });
  let registered = null;
  const drain = drainLib.createProductControlDrain({
    execFileSync: gh.exec,
    runBootstrap: (a) => { registered = a; return { ok: true, stage: 'registered' }; },
    allowedOrgs: ['intrale'],
  });
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale', visibility: 'private' } }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.created, true);
  assert.equal(res.url, 'https://github.com/intrale/store');
  // La URL persistida es la forma limpia (sin token embebido · CA-SEC-4).
  assert.equal(registered.descriptor.repositories[0].url, 'https://github.com/intrale/store');
  assert.equal(registered.descriptor.repositories[0].provenance, 'existing');
  assert.equal(registered.registerMeta.repoOrigin, 'created');
});

test('CA-SEC-1: gh se invoca SIEMPRE con array de args (nunca string/shell)', () => {
  const gh = makeFakeGh({ viewExists: false });
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } }));
  assert.ok(gh.calls.length >= 2);
  assert.deepEqual(gh.calls.find((c) => c[2] === 'create'), ['gh', 'repo', 'create', 'intrale/store', '--private']);
});

test('CA-SEC-3: visibilidad default private; public sólo con elección explícita', () => {
  const ghPriv = makeFakeGh({ viewExists: false });
  const dPriv = drainLib.createProductControlDrain({ execFileSync: ghPriv.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  // sin visibility ⇒ private
  dPriv.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } }));
  assert.ok(ghPriv.calls.some((c) => c.includes('--private')));
  assert.ok(!ghPriv.calls.some((c) => c.includes('--public')));

  const ghPub = makeFakeGh({ viewExists: false });
  const dPub = drainLib.createProductControlDrain({ execFileSync: ghPub.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  dPub.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale', visibility: 'public' } }));
  assert.ok(ghPub.calls.some((c) => c.includes('--public')));
});

// -----------------------------------------------------------------------------
// CA-SEC-2 — org fuera de la allowlist ⇒ rechazo sin invocar gh
// -----------------------------------------------------------------------------

test('CA-SEC-2: org fuera de la allowlist se rechaza SIN invocar gh (A01)', () => {
  const gh = makeFakeGh({ viewExists: false });
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'evilcorp' } }));
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'create-spec');
  assert.equal(gh.calls.length, 0, 'no debe invocar gh con org fuera de allowlist');
});

test('CA-SEC-1: create.name con metacaracteres de shell es rechazado antes de invocar gh', () => {
  const gh = makeFakeGh({ viewExists: false });
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  // Este descriptor no pasa validateDescriptor (create.name inválido) ⇒ stage validation.
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'foo;rm -rf /', org: 'intrale' } }));
  assert.equal(res.ok, false);
  assert.equal(gh.calls.length, 0);
});

// -----------------------------------------------------------------------------
// CA-4 — idempotencia y estado consistente ante fallo
// -----------------------------------------------------------------------------

test('CA-4: repo ya existente ⇒ NO se re-crea (idempotencia)', () => {
  const gh = makeFakeGh({ viewExists: true });
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => ({ ok: true }), allowedOrgs: ['intrale'] });
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } }));
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.ok(!gh.calls.some((c) => c[2] === 'create'), 'no debe llamar create si el repo ya existe');
});

test('CA-4: 422 name already exists durante create se maneja idempotente (sin estado a medias)', () => {
  const gh = makeFakeGh({ viewExists: false, createThrows: 'GraphQL: Name already exists on this account (HTTP 422)' });
  let registered = false;
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => { registered = true; return { ok: true }; }, allowedOrgs: ['intrale'] });
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } }));
  assert.equal(res.ok, true);
  assert.equal(registered, true, 'debe registrar el producto (URL completada), no dejarlo a medias');
});

test('CA-4: fallo de creación (permiso) NO registra el producto (no queda a medias)', () => {
  const gh = makeFakeGh({ viewExists: false, createThrows: 'HTTP 403: Resource not accessible' });
  let registered = false;
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: () => { registered = true; return { ok: true }; }, allowedOrgs: ['intrale'] });
  const res = drain.processOnboard(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } }));
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'create-repo');
  assert.equal(registered, false, 'no debe registrar si la creación falló');
});

// -----------------------------------------------------------------------------
// provenance:existing — no toca gh; inyecta el probe real (repo-probe) explícitamente
// -----------------------------------------------------------------------------

test('existing: no invoca gh y registra vía runBootstrap full (inyecta probe real CA-2)', () => {
  const gh = makeFakeGh({ viewExists: true });
  let bootArg = null;
  const drain = drainLib.createProductControlDrain({ execFileSync: gh.exec, runBootstrap: (a) => { bootArg = a; return { ok: true }; } });
  const res = drain.processOnboard(onboardRequest({ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }));
  assert.equal(res.ok, true);
  assert.equal(res.repoOrigin, 'existing');
  assert.equal(gh.calls.length, 0, 'existing no crea repos');
  assert.equal(bootArg.mode, 'full');
  // Inyecta el probe REAL explícitamente (least-privilege) para verificar alcance (CA-2).
  assert.equal(typeof bootArg.deps.probeAccess, 'function', 'existing inyecta el probe real (CA-2)');
});

// -----------------------------------------------------------------------------
// drainOnce — lee/mueve archivos de la cola con fs real (tmp)
// -----------------------------------------------------------------------------

test('drainOnce procesa la cola, mueve el pedido a procesado y deja sidecar de resultado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
  const queueDir = path.join(tmp, 'pendiente');
  const doneDir = path.join(tmp, 'procesado');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'onboard-acme-1.json'), JSON.stringify(onboardRequest({ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale' } })), 'utf8');

  const gh = makeFakeGh({ viewExists: false });
  let ts = 1700000000000;
  const drain = drainLib.createProductControlDrain({
    execFileSync: gh.exec,
    runBootstrap: () => ({ ok: true, stage: 'registered' }),
    allowedOrgs: ['intrale'],
    queueDir, doneDir,
    now: () => ts++,
  });
  const summary = drain.drainOnce();
  assert.equal(summary.processed, 1);
  assert.equal(summary.results[0].ok, true);
  // La cola quedó vacía; el pedido se movió a procesado con su sidecar.
  assert.equal(fs.readdirSync(queueDir).length, 0);
  const done = fs.readdirSync(doneDir);
  assert.ok(done.some((n) => n.endsWith('.json') && !n.endsWith('.result.json')));
  assert.ok(done.some((n) => n.endsWith('.result.json')));
});

test('drainOnce sobre cola inexistente ⇒ 0 procesados (defensivo, no lanza)', () => {
  const drain = drainLib.createProductControlDrain({ queueDir: path.join(os.tmpdir(), 'no', 'existe', 'q'), execFileSync: () => '' });
  const summary = drain.drainOnce();
  assert.equal(summary.processed, 0);
});

test('drainOnce ignora pedidos que no son onboard (no los mueve)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-'));
  const queueDir = path.join(tmp, 'pendiente');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'start-acme-1.json'), JSON.stringify({ type: 'product_control_request', action: 'start' }), 'utf8');
  const drain = drainLib.createProductControlDrain({ queueDir, doneDir: path.join(tmp, 'done'), execFileSync: () => '' });
  const summary = drain.drainOnce();
  assert.equal(summary.results[0].stage, 'skip');
  assert.equal(fs.readdirSync(queueDir).length, 1, 'el start/pause queda para el kernel de instancias');
});

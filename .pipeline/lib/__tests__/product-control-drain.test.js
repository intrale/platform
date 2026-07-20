'use strict';

// =============================================================================
// product-control-drain.test.js — Drainer kernel-side del onboarding (#4800)
//
// Cobertura del "trabajo central": creacion de repo idempotente por array de args
// (anti command-injection), default private, sin token en descriptor/logs, manejo
// de "name already exists", validacion de acceso real (CA-2) y transaccion de la
// cola (procesado/ vs error/, nunca "a medias").
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const drain = require('../product-control-drain');

function createDescriptor(overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: 'acme-store', name: 'ACME Store' },
    repositories: [{ id: 'main', role: 'primary', defaultBaseRef: 'main', provenance: 'create', create: { name: 'store', org: 'intrale', visibility: 'private' } }],
    board: { ref: 'https://github.com/orgs/acme/projects/1', admissionLabels: ['Ready'], routing: [{ label: 'area:backend', capability: 'backend' }] },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

function onboardRecord(descriptor) {
  return { type: 'product_onboard_request', projectId: descriptor.identity.projectId, descriptor };
}

// Fake gh con array de args. `existing` es el set de repos "org/name" ya creados.
function makeFakeGh(existing = new Set(), opts = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'repo' && args[1] === 'view') {
      if (existing.has(args[2])) return Buffer.from('{"name":"ok"}');
      const e = new Error('gh: Not Found'); e.stderr = 'GraphQL: Could not resolve to a Repository'; throw e;
    }
    if (args[0] === 'repo' && args[1] === 'create') {
      if (opts.createThrowsAlreadyExists) { const e = new Error('failed'); e.stderr = 'GraphQL: Name already exists on this account'; throw e; }
      if (opts.createThrowsPerm) { const e = new Error('failed'); e.stderr = 'HTTP 403: Resource not accessible'; throw e; }
      existing.add(args[2]);
      return Buffer.from('');
    }
    if (args[0] === 'repo' && args[1] === 'edit') return Buffer.from('');
    return Buffer.from('');
  };
  fn.calls = calls;
  return fn;
}

// -----------------------------------------------------------------------------
// createRepo — fail-closed + idempotencia + default private
// -----------------------------------------------------------------------------

test('#4800: createRepo invoca gh por array de args, con --private por default', () => {
  const gh = makeFakeGh();
  const res = drain.createRepo({ name: 'store', org: 'intrale' }, { execFile: gh });
  assert.equal(res.created, true);
  assert.equal(res.visibility, 'private');
  assert.equal(res.url, 'https://github.com/intrale/store');
  const createCall = gh.calls.find((c) => c.args[1] === 'create');
  assert.deepEqual(createCall.args, ['repo', 'create', 'intrale/store', '--private', '--disable-issues=false']);
});

test('#4800: createRepo usa --public solo con eleccion explicita', () => {
  const gh = makeFakeGh();
  drain.createRepo({ name: 'store', org: 'intrale', visibility: 'public' }, { execFile: gh });
  const createCall = gh.calls.find((c) => c.args[1] === 'create');
  assert.ok(createCall.args.includes('--public'));
  assert.ok(!createCall.args.includes('--private'));
});

test('#4800: createRepo es idempotente — no crea si el repo ya existe', () => {
  const gh = makeFakeGh(new Set(['intrale/store']));
  const res = drain.createRepo({ name: 'store', org: 'intrale' }, { execFile: gh });
  assert.equal(res.existed, true);
  assert.equal(res.created, false);
  assert.equal(gh.calls.some((c) => c.args[1] === 'create'), false, 'no debe invocar create si ya existe');
});

test('#4800: createRepo trata name already exists como exito idempotente', () => {
  const gh = makeFakeGh(new Set(), { createThrowsAlreadyExists: true });
  const res = drain.createRepo({ name: 'store', org: 'intrale' }, { execFile: gh });
  assert.equal(res.existed, true);
});

test('#4800: createRepo rechaza nombre invalido ANTES de invocar gh (A03 fail-closed)', () => {
  const gh = makeFakeGh();
  assert.throws(() => drain.createRepo({ name: 'foo;rm -rf /', org: 'intrale' }, { execFile: gh }), /nombre de repo/);
  assert.equal(gh.calls.length, 0, 'no debe tocar gh con un nombre invalido');
});

test('#4800: createRepo rechaza org fuera de la allowlist (A01)', () => {
  const gh = makeFakeGh();
  assert.throws(() => drain.createRepo({ name: 'store', org: 'evil' }, { execFile: gh }), /allowlist/);
  assert.equal(gh.calls.length, 0);
});

test('#4800: createRepo propaga fallo real de permiso (no deja estado a medias)', () => {
  const gh = makeFakeGh(new Set(), { createThrowsPerm: true });
  assert.throws(() => drain.createRepo({ name: 'store', org: 'intrale' }, { execFile: gh }), /gh repo create/);
});

// -----------------------------------------------------------------------------
// processOnboardRequest — crea, resuelve descriptor y registra en mode:full
// -----------------------------------------------------------------------------

test('#4800: processOnboardRequest crea el repo y completa la URL limpia sin intervencion (CA-1)', () => {
  const gh = makeFakeGh();
  let registered = null;
  const res = drain.processOnboardRequest(onboardRecord(createDescriptor()), {
    execFile: gh,
    registerProduct: (entry) => { registered = entry; return { status: 'onboarding' }; },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.created[0].url, 'https://github.com/intrale/store');
  assert.equal(res.created[0].created, true);
  const repo = res.resolvedDescriptor.repositories[0];
  assert.equal(repo.provenance, 'existing');
  assert.equal(repo.url, 'https://github.com/intrale/store');
  assert.equal(repo.create, undefined);
  assert.equal(registered.projectId, 'acme-store');
});

test('#4800: el descriptor resuelto NO contiene tokens ni secretos', () => {
  const gh = makeFakeGh();
  const res = drain.processOnboardRequest(onboardRecord(createDescriptor()), {
    execFile: gh, registerProduct: () => ({ status: 'onboarding' }),
  });
  const serialized = JSON.stringify(res.resolvedDescriptor);
  assert.equal(/gh[opsu]_[A-Za-z0-9]{20,}/.test(serialized), false);
  assert.equal(/github_pat_/.test(serialized), false);
});

test('#4800: CA-2 — provenance:existing con repo inaccesible es rechazado en mode:full', () => {
  const desc = createDescriptor({
    repositories: [{ id: 'main', role: 'primary', provenance: 'existing', url: 'https://github.com/intrale/nope' }],
  });
  const res = drain.processOnboardRequest(onboardRecord(desc), {
    execFile: () => { const e = new Error('nf'); e.stderr = 'Not Found'; throw e; },
    registerProduct: () => ({ status: 'onboarding' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'access');
});

test('#4800: processOnboardRequest rechaza un descriptor invalido sin tocar gh', () => {
  const gh = makeFakeGh();
  const bad = createDescriptor({ repositories: [{ id: 'main', provenance: 'create', create: { name: 'x', org: 'evil' } }] });
  const res = drain.processOnboardRequest(onboardRecord(bad), { execFile: gh, registerProduct: () => ({}) });
  assert.equal(res.ok, false);
  assert.equal(gh.calls.some((c) => c.args[1] === 'create'), false);
});

test('#4800: redactGhOutput redacta tokens del output antes de loguear', () => {
  const red = drain.redactGhOutput('remote: https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/x');
  assert.equal(/ghp_[A-Z]/.test(red), false);
  assert.ok(red.includes('[REDACTED'));
});

// -----------------------------------------------------------------------------
// drainOnboardQueue — transaccion de cola (procesado/ vs error/)
// -----------------------------------------------------------------------------

test('#4800: drainOnboardQueue mueve OK a procesado/ y fallidos a error/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-'));
  const queueDir = path.join(tmp, 'pendiente');
  const doneDir = path.join(tmp, 'procesado');
  const errorDir = path.join(tmp, 'error');
  fs.mkdirSync(queueDir, { recursive: true });

  fs.writeFileSync(path.join(queueDir, 'onboard-ok.json'), JSON.stringify(onboardRecord(createDescriptor())));
  const badDesc = createDescriptor({ identity: { projectId: 'x', name: 'X' }, repositories: [{ id: 'main', provenance: 'existing' }] });
  fs.writeFileSync(path.join(queueDir, 'onboard-bad.json'), JSON.stringify(onboardRecord(badDesc)));

  const gh = makeFakeGh();
  const res = drain.drainOnboardQueue({
    queueDir, doneDir, errorDir, execFile: gh,
    registerProduct: () => ({ status: 'onboarding' }),
  });

  assert.equal(res.ok, 1);
  assert.equal(res.failed, 1);
  assert.ok(fs.existsSync(path.join(doneDir, 'onboard-ok.json')));
  assert.ok(fs.existsSync(path.join(errorDir, 'onboard-bad.json')));
  assert.ok(fs.existsSync(path.join(errorDir, 'onboard-bad.reason.json')));
  assert.equal(fs.existsSync(path.join(queueDir, 'onboard-ok.json')), false, 'el OK ya no debe estar en la cola');
});

test('#4800: drainOnboardQueue ignora pedidos que no son onboard (los deja para su consumidor)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-'));
  const queueDir = path.join(tmp, 'pendiente');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'start-x.json'), JSON.stringify({ type: 'product_control_request', action: 'start', projectId: 'intrale' }));
  const res = drain.drainOnboardQueue({ queueDir, doneDir: path.join(tmp, 'd'), errorDir: path.join(tmp, 'e') });
  assert.equal(res.ok, 0);
  assert.equal(res.failed, 0);
  assert.ok(fs.existsSync(path.join(queueDir, 'start-x.json')), 'el pedido de control no se toca');
});

test('#4800: drainOnboardQueue sobre cola inexistente da 0 procesados (sin throw)', () => {
  const res = drain.drainOnboardQueue({ queueDir: path.join(os.tmpdir(), 'no-existe-' + process.pid), doneDir: '/x', errorDir: '/y' });
  assert.equal(res.processed, 0);
});

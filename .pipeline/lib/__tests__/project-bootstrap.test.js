'use strict';

// =============================================================================
// project-bootstrap.test.js — Bootstrap de proyecto (Ola Puente P2 · #4687)
//
// Cobertura → grupo D del PO + requisitos de seguridad #4, #5, #10:
//   - CA-D1 : registro queda status:onboarding (inactivo) hasta OK humano.
//   - CA-D2 : dry-run verdaderamente side-effect-free (sin escrituras/worktrees).
//   - CA-D3 : SSRF — url con IP interna/loopback/host fuera de allowlist rechazada.
//   - CA-D4 : signers vacío ⇒ gate bloquea (fail-closed).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const b = require('../project-bootstrap');

function validDescriptor(overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: 'acme-store', name: 'ACME Store' },
    repositories: [{ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/acme/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// assertUrlAllowed — SSRF guard (CA-D3)
// -----------------------------------------------------------------------------

test('CA-D3: assertUrlAllowed acepta github.com https', () => {
  assert.equal(b.assertUrlAllowed('https://github.com/acme/store').allowed, true);
  assert.equal(b.assertUrlAllowed('https://api.github.com/repos/acme/store').allowed, true);
});

for (const badUrl of [
  'https://127.0.0.1/x',
  'https://localhost/x',
  'https://10.0.0.5/x',
  'https://192.168.1.1/x',
  'https://169.254.169.254/latest/meta-data',
  'https://172.16.5.4/x',
  'http://github.com/acme/store',       // no https
  'https://evil.example.com/x',         // host fuera de allowlist
  'https://[::1]/x',                    // ipv6 loopback
  'https://user:pass@github.com/acme/store', // SEC-6: credenciales embebidas
  'https://user@github.com/acme/store',      // SEC-6: username embebido
  'https://:token@github.com/acme/store',    // SEC-6: password/token embebido
  'not-a-url',
]) {
  test(`CA-D3: assertUrlAllowed RECHAZA ${badUrl}`, () => {
    const r = b.assertUrlAllowed(badUrl);
    assert.equal(r.allowed, false, `${badUrl} debe ser rechazada: ${JSON.stringify(r)}`);
  });
}

// SEC-6 — credenciales embebidas en URL (user:pass@host) prohibidas: secretos
// solo por referencia (SEC-4), nunca crudos en la cola/logs.
test('SEC-6: assertUrlAllowed rechaza user:pass@ aunque el host esté allowlisted', () => {
  const r = b.assertUrlAllowed('https://user:pass@github.com/acme/store');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /credenciales embebidas|SEC-6/i);
});

test('SEC-6: verifyAccess rechaza repo con token embebido en la URL', () => {
  const desc = validDescriptor({ repositories: [{ id: 'main', url: 'https://x-access-token:ghp_secret@github.com/acme/store' }] });
  const res = b.verifyAccess(desc);
  assert.equal(res.ok, false);
});

test('CA-D3: verifyAccess rechaza cuando un repo apunta a IP interna', () => {
  const desc = validDescriptor({ repositories: [{ id: 'main', url: 'https://169.254.169.254/x' }] });
  const res = b.verifyAccess(desc);
  assert.equal(res.ok, false);
});

test('CA-D3: bootstrap full rechaza descriptor con board.ref a loopback (stage=access)', () => {
  const desc = validDescriptor({ board: { ref: 'https://127.0.0.1/x', admissionLabels: ['Ready'], routing: [] } });
  const res = b.runBootstrap({ descriptor: desc, mode: 'full' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'access');
});

// -----------------------------------------------------------------------------
// CA-D2 — dry-run side-effect-free
// -----------------------------------------------------------------------------

test('CA-D2: dry-run NO registra el producto ni escribe en disco', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const registryPath = path.join(tmp, 'registry.json');
  let registerCalled = false;
  const res = b.runBootstrap({
    descriptor: validDescriptor(),
    mode: 'dry-run',
    deps: { registryPath, registerProduct: () => { registerCalled = true; } },
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'dry-run');
  assert.equal(res.sideEffects, false);
  assert.equal(registerCalled, false, 'dry-run NUNCA debe registrar');
  assert.equal(fs.existsSync(registryPath), false, 'dry-run NUNCA debe escribir el registry');
});

test('CA-D2: dry-run contra descriptor HOSTIL sigue siendo side-effect-free', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const registryPath = path.join(tmp, 'registry.json');
  // Descriptor con discoverWork que intentaría escribir: el default no lo invoca
  // salvo que se inyecte, y aún así el registro nunca ocurre en dry-run.
  const res = b.runBootstrap({
    descriptor: validDescriptor(),
    mode: 'dry-run',
    deps: {
      registryPath,
      discoverWork: () => [{ number: 1, title: 'x' }], // side-effect-free por contrato
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun.discovered.length, 1);
  assert.equal(fs.existsSync(registryPath), false);
});

test('CA-D2: dry-run expone ruteo resuelto contra la allowlist (skills validados)', () => {
  const desc = validDescriptor({
    board: { ref: 'https://github.com/orgs/acme/projects/1', admissionLabels: ['Ready'], routing: [{ label: 'area:backend', capability: 'backend' }] },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
  });
  const res = b.runBootstrap({ descriptor: desc, mode: 'dry-run' });
  assert.equal(res.ok, true);
  const r = res.dryRun.resolvedRouting.find((x) => x.label === 'area:backend');
  assert.deepEqual(r.skills, ['backend-dev']);
});

test('#4851: dry-run expone providers y politica de PR efectivos', () => {
  const desc = validDescriptor({
    pullRequests: { policy: 'direct-to-main' },
    providers: { order: ['nvidia-nim', 'cerebras', 'gemini-google', 'openai-codex', 'anthropic'] },
  });
  const res = b.runBootstrap({ descriptor: desc, mode: 'dry-run' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.dryRun.providerOrder, ['nvidia-nim', 'cerebras', 'gemini-google', 'openai-codex', 'anthropic']);
  assert.equal(res.dryRun.pullRequestPolicy, 'direct-to-main');
  assert.match(res.human, /nvidia-nim/);
  assert.match(res.human, /direct-to-main/);
});

test('#4851: dry-run deriva defaults seguros cuando providers/politica faltan', () => {
  const res = b.runBootstrap({ descriptor: validDescriptor(), mode: 'dry-run' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.dryRun.providerOrder, ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']);
  assert.equal(res.dryRun.pullRequestPolicy, 'required');
});

// -----------------------------------------------------------------------------
// CA-D1 — modo full registra onboarding (inactivo) hasta OK humano
// -----------------------------------------------------------------------------

test('CA-D1: modo full registra status:onboarding (inactivo)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const registryPath = path.join(tmp, 'registry.json');
  // Probe inyectado (determinístico, sin red): en full mode el default probea con `gh`.
  const res = b.runBootstrap({ descriptor: validDescriptor(), mode: 'full', deps: { registryPath, probeAccess: () => true } });
  assert.equal(res.ok, true);
  assert.equal(res.stage, 'registered');
  assert.equal(res.status, 'onboarding');
  assert.ok(fs.existsSync(registryPath));
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(reg.products['acme-store'].status, 'onboarding');
});

test('CA-D1: el render humano deja explícito el estado ONBOARDING pendiente de aprobación', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  const res = b.runBootstrap({ descriptor: validDescriptor(), mode: 'full', deps: { registryPath: path.join(tmp, 'r.json'), probeAccess: () => true } });
  assert.match(res.human, /ONBOARDING/);
  assert.match(res.human, /aprobación humana/i);
});

// -----------------------------------------------------------------------------
// CA-D4 — signers vacío ⇒ gate bloquea (fail-closed)
// -----------------------------------------------------------------------------

test('CA-D4: descriptor con signers vacío bloquea el bootstrap', () => {
  // signers vacío falla el schema (minItems) → stage validation:schema.
  const res = b.runBootstrap({ descriptor: validDescriptor({ authority: { signers: [], gates: {} } }), mode: 'full' });
  assert.equal(res.ok, false);
  assert.match(res.stage, /validation:schema|signature-gate/);
});

// -----------------------------------------------------------------------------
// Validación fail-closed integrada
// -----------------------------------------------------------------------------

test('bootstrap rechaza descriptor inválido antes de verificar acceso', () => {
  const res = b.runBootstrap({ descriptor: { schemaVersion: '1.0' }, mode: 'full' });
  assert.equal(res.ok, false);
  assert.match(res.stage, /^validation:/);
});

test('bootstrap desde path inexistente ⇒ error como dato', () => {
  const res = b.runBootstrap({ descriptorPath: '/no/existe.json', mode: 'dry-run' });
  assert.equal(res.ok, false);
});

// -----------------------------------------------------------------------------
// #4800 · CA-2 — probeAccess real: alcance verificado en modo existente
// -----------------------------------------------------------------------------

test('CA-2: verifyAccess con probeAccess real — repo accesible ⇒ reachable=true', () => {
  const desc = validDescriptor();
  const res = b.verifyAccess(desc, { probeAccess: () => true });
  assert.equal(res.ok, true);
  assert.equal(res.targets.find((t) => t.kind === 'repo').reachable, true);
});

test('CA-2: verifyAccess con probeAccess real — repo inaccesible ⇒ rechazo', () => {
  const desc = validDescriptor();
  const res = b.verifyAccess(desc, { probeAccess: (t) => (t.kind === 'repo' ? false : null) });
  assert.equal(res.ok, false);
  assert.equal(res.targets.find((t) => t.kind === 'repo').reachable, false);
});

test('CA-2: probe que devuelve null (board / no probeable) se trata como no-probado (accesible)', () => {
  const desc = validDescriptor();
  const res = b.verifyAccess(desc, { probeAccess: () => null });
  assert.equal(res.ok, true);
  assert.equal(res.targets.find((t) => t.kind === 'repo').reachable, null);
});

test('CA-2: bootstrap full con URL inaccesible (probe false) rechaza en stage=access', () => {
  const res = b.runBootstrap({ descriptor: validDescriptor(), mode: 'full', deps: { probeAccess: () => false } });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'access');
});

test('CA-2: modo create NO prueba URL (repo aún no existe) — verifyAccess sólo mira el board', () => {
  const desc = validDescriptor({
    repositories: [{ id: 'main', role: 'primary', provenance: 'create', create: { name: 'store', org: 'intrale', visibility: 'private' } }],
  });
  let probedRepo = false;
  const res = b.verifyAccess(desc, { probeAccess: (t) => { if (t.kind === 'repo') probedRepo = true; return null; } });
  assert.equal(probedRepo, false, 'el repo a crear NO debe probarse');
  assert.equal(res.ok, true);
  // Sólo queda el board como target (el repo create se saltea).
  assert.equal(res.targets.filter((t) => t.kind === 'repo').length, 0);
});

test('defaultProbeAccess parsea owner/repo y sólo prueba repos (board ⇒ null)', () => {
  // board target ⇒ null (no se prueba acá).
  assert.equal(b.defaultProbeAccess({ kind: 'board', url: 'https://github.com/orgs/acme/projects/1' }), null);
  // repo accesible ⇒ true con execFileSync inyectado que no lanza.
  const okProbe = b.defaultProbeAccess({ kind: 'repo', url: 'https://github.com/acme/store' }, { execFileSync: (bin, args) => { assert.deepEqual(args.slice(0, 3), ['repo', 'view', 'acme/store']); return ''; } });
  assert.equal(okProbe, true);
  // repo inaccesible ⇒ false (gh lanza).
  const failProbe = b.defaultProbeAccess({ kind: 'repo', url: 'https://github.com/acme/nope' }, { execFileSync: () => { throw new Error('not found'); } });
  assert.equal(failProbe, false);
});

test('parseOwnerRepo extrae slug de URL github y rechaza formas inválidas', () => {
  assert.equal(b.parseOwnerRepo('https://github.com/acme/store'), 'acme/store');
  assert.equal(b.parseOwnerRepo('https://github.com/acme/store.git'), 'acme/store');
  assert.equal(b.parseOwnerRepo('https://github.com/acme'), null);
  assert.equal(b.parseOwnerRepo('not-a-url'), null);
});

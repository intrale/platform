'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKernelSupervisor } = require('../kernel-supervisor');
const { buildParameterPath, createInMemoryVaultDriver } = require('../secret-vault');
const { _resetVaultCache } = require('../credentials');
const { validateDescriptor } = require('../project-descriptor');

const PREFIX = '/test6033';
const HOST = 'fake-host';

function createSupervisor(onAlert = () => {}) {
  return createKernelSupervisor({
    catalogStore: { listProducts: async () => [{ productId: 'acme', projectId: 'acme', status: 'active' }] },
    storeFactory: () => ({ getDescriptor: async () => null }),
    hydrate: false,
    onAlert,
  });
}

function vaultConfig() {
  return {
    enabled: true, prefix: PREFIX, projectId: 'kernel', hostId: HOST,
    cache_ttl_seconds: 300, required_scopes: [], shared_secrets: [], max_cached_tenants: 8,
  };
}

function driverWith(entries) {
  const parameters = Object.create(null);
  for (const [scope, value, tier = 'host'] of entries) {
    parameters[buildParameterPath({ prefix: PREFIX, projectId: 'acme', hostId: HOST, scope, tier })] = value;
  }
  return createInMemoryVaultDriver({ parameters });
}

function opts(driver) {
  return { vaultConfig: vaultConfig(), vaultDriver: driver, logger: () => {} };
}

test('#6033 agrega credentials[] y des-mapea scopes del vault al contrato', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance('acme');
  ctx.descriptor = { credentials: [
    { ref: 'fake-a', scopes: ['github'], shared: ['github'] },
    { ref: 'fake-b', scopes: ['providers:anthropic'] },
  ] };
  const driver = driverWith([
    ['github', { token: 'FAKE-GITHUB' }, 'shared'],
    ['providers__anthropic', { apiKey: 'FAKE-ANTHROPIC' }],
  ]);

  const result = supervisor.resolveInstanceSecrets('acme', opts(driver));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(ctx.secrets).sort(), ['github', 'providers:anthropic']);
  assert.deepEqual(ctx.secrets['providers:anthropic'], { apiKey: 'FAKE-ANTHROPIC' });
  assert.equal(ctx.secrets['providers__anthropic'], undefined);
  assert.deepEqual(result.meta.scopes.sort(), ['github', 'providers:anthropic']);
  assert.ok(!JSON.stringify(result.meta).includes('__'));
  assert.ok(!JSON.stringify(result.meta).includes('FAKE-'));
});

test('#6033 des-mapea missing y error antes de alertar en fail-closed', async () => {
  _resetVaultCache();
  const alerts = [];
  const supervisor = createSupervisor((alert) => alerts.push(alert));
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance('acme');
  ctx.descriptor = { credentials: [{ ref: 'fake', scopes: ['providers:anthropic'] }] };

  const result = supervisor.resolveInstanceSecrets('acme', opts(driverWith([])));

  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.missing, ['providers:anthropic'], JSON.stringify(result));
  assert.match(result.error, /providers:anthropic/);
  assert.ok(!JSON.stringify({ result, alerts }).includes('providers__anthropic'));
  assert.equal(ctx.secrets, null);
});

test('#6033 inherit deja traza y no altera el conjunto efectivo', async () => {
  async function resolver(credentials, logs) {
    _resetVaultCache();
    const supervisor = createSupervisor();
    await supervisor.bootProducts();
    const ctx = supervisor.getInstance('acme');
    ctx.descriptor = { credentials };
    const result = supervisor.resolveInstanceSecrets('acme', {
      ...opts(driverWith([
        ['github', { token: 'FAKE-GITHUB' }],
        ['providers__anthropic', { apiKey: 'FAKE-INHERITED' }],
      ])),
      logger: (line) => logs.push(line),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return Object.keys(ctx.secrets).sort();
  }

  const logsSinInherit = [];
  const logsConInherit = [];
  const sinInherit = await resolver(
    [{ ref: 'fake', scopes: ['github'] }],
    logsSinInherit,
  );
  const conInherit = await resolver(
    [{ ref: 'fake', scopes: ['github'], inherit: ['providers:anthropic'] }],
    logsConInherit,
  );

  assert.deepEqual(conInherit, sinInherit, 'inherit no cambia el conjunto efectivo');
  assert.deepEqual(conInherit, ['github']);
  assert.equal(logsSinInherit.some((line) => line.includes('inherit se ignora')), false);
  assert.ok(logsConInherit.some((line) => (
    line.includes('credentials[].inherit se ignora')
    && line.includes('providers:anthropic')
  )), JSON.stringify(logsConInherit));
});

test('#6033 no materializa claves extra del driver', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance('acme');
  ctx.descriptor = { credentials: [{ ref: 'fake', scopes: ['github'] }] };
  const driver = driverWith([
    ['github', { token: 'FAKE-GITHUB' }],
    ['providers__anthropic', { apiKey: 'FAKE-EXTRA' }],
  ]);

  const result = supervisor.resolveInstanceSecrets('acme', opts(driver));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(ctx.secrets), ['github']);
  assert.equal(ctx.secrets['providers:anthropic'], undefined);
});

test('#6033 mantiene __proto__ visible en metadata fail-closed sin contaminar prototipos', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance('acme');

  const result = supervisor.resolveInstanceSecrets('acme', {
    scopes: ['__proto__'],
    ...opts(driverWith([['__proto__', { token: 'FAKE-PROTO' }]])),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(result.meta.missing, ['__proto__']);
  assert.match(result.meta.error, /__proto__/);
  assert.equal(ctx.secrets, null);
  assert.equal(Object.prototype.polluted, undefined);
});

test('#6033 el schema rechaza path como campo extra de credentials[]', () => {
  const descriptor = {
    schemaVersion: '1.1',
    identity: { projectId: 'fake-tenant', name: 'FAKE Tenant' },
    repositories: [{ id: 'main', url: 'https://github.com/fake-org/fake-repo', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/fake-org/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:pipeline', capability: 'pipeline' }],
    },
    providers: { order: ['anthropic'] },
    pullRequests: { policy: 'required' },
    credentials: [{
      ref: '~/.claude/secrets/credentials.json#FAKE-ns',
      scopes: ['github'],
      path: '../../otro/host',
    }],
    capabilities: [{ interface: 'pipeline', skills: ['pipeline-dev'] }],
    authority: { signers: ['FAKE-signer'], gates: { gate2: 'enforce' } },
  };

  const result = validateDescriptor(descriptor);

  assert.equal(result.valid, false);
  assert.equal(result.stage, 'schema');
  assert.ok(result.errors.some((error) => (
    error.keyword === 'additionalProperties'
    && error.path === '/credentials/0'
    && error.detail.includes('path')
  )), JSON.stringify(result.errors));
});

test('#6033 conserva identidad para opts.scopes de los tests legacy', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance('acme');
  ctx.descriptor = { credentials: [{ ref: 'fake', scopes: ['providers:anthropic'] }] };

  const result = supervisor.resolveInstanceSecrets('acme', {
    scopes: ['githubToken'],
    ...opts(driverWith([['githubToken', { token: 'FAKE-LEGACY' }]])),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual({ ...ctx.secrets }, { githubToken: { token: 'FAKE-LEGACY' } });
});

'use strict';

// =============================================================================
// kernel-supervisor-routing.test.js — Multiplexor de ruteo product-aware
// (Ola Puente P4 · #4763 · split 2/3 de #4689)
//
// Mapea los criterios de aceptación (PO) del issue #4763, con las fixtures de
// repos dummy A/B (descriptores sinteticos, inertes):
//   CA-1  Ruteo positivo: evento en allowlist → instancia correcta (A→A, B→B).
//   CA-2  Fail-closed por projectId inseguro (A03 adversarial): traversal /
//         separadores / control chars → null ANTES de tocar path/clave + audita.
//   CA-3  Fail-closed por repo/proyecto fuera de allowlist (REQ-SEC-MUX-1): sin
//         fallback-a-primary; descarta + audita.
//   CA-4  Auditoria no opcional (A09): todo descarte deja registro.
//   CA-5  No-regresion single-product: cubierta ademas en pulpo (fallback a
//         getPrimaryRepo). Aqui: descriptors vacio → fail-closed (no primary global).
//   CA-6  Reuso, no reimplementacion (isSafeId + repo-target) — verificado por el
//         diff (no reescribe repo-target.js ni project-descriptor.js).
//
// Los ids/repos con control chars se construyen en runtime (String.fromCharCode)
// para mantener el fuente ASCII-safe.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveInstanceForEvent,
  deriveRepoConfig,
  extractRepoSlug,
  createKernelSupervisor,
} = require('../kernel-supervisor');

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

// -----------------------------------------------------------------------------
// Fixtures A/B (descriptores dummy inertes)
// -----------------------------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const DESCRIPTOR_A = loadFixture('routing-product-a.descriptor.json');
const DESCRIPTOR_B = loadFixture('routing-product-b.descriptor.json');

// Catalogo projectId → instancia. La instancia sólo necesita exponer su descriptor;
// el multiplexor deriva la allowlist repo-target por instancia (adaptador).
function buildCatalog() {
  const map = new Map();
  map.set(DESCRIPTOR_A.identity.projectId, { projectId: DESCRIPTOR_A.identity.projectId, descriptor: DESCRIPTOR_A });
  map.set(DESCRIPTOR_B.identity.projectId, { projectId: DESCRIPTOR_B.identity.projectId, descriptor: DESCRIPTOR_B });
  return map;
}

// Envuelve un catalogo con un espia sobre `.get` para probar que un id inseguro se
// rechaza ANTES de tocar el catalogo (primer punto donde el id derivaria path/clave).
function spyCatalog(map) {
  const lookups = [];
  return {
    lookups,
    descriptors: {
      get: (k) => { lookups.push(k); return map.get(k); },
    },
  };
}

// Sink de auditoria que colecciona descartes (interfaz `{ discard }` de la receta).
function auditCollector() {
  const entries = [];
  return {
    entries,
    audit: { discard: (event, reason, meta) => entries.push({ event, reason, meta: meta || {} }) },
  };
}

// -----------------------------------------------------------------------------
// CA-1 · Ruteo positivo (evento en allowlist → instancia correcta)
// -----------------------------------------------------------------------------

test('CA-1 · evento de A en allowlist resuelve a la instancia A (sin cruce)', () => {
  const descriptors = buildCatalog();
  const { entries, audit } = auditCollector();
  const res = resolveInstanceForEvent(
    { projectId: 'product-a', number: 1, origin_repo: 'acme-org/product-a' },
    { descriptors, audit },
  );
  assert.ok(res, 'resuelve');
  assert.equal(res.projectId, 'product-a');
  assert.equal(res.instance.descriptor.identity.projectId, 'product-a');
  assert.equal(res.repo, 'acme-org/product-a');
  assert.equal(entries.length, 0, 'ruteo positivo no audita descarte');
});

test('CA-1 · evento de B resuelve a la instancia B', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent(
    { projectId: 'product-b', number: 2, origin_repo: 'globex-org/product-b' },
    { descriptors },
  );
  assert.ok(res);
  assert.equal(res.instance.descriptor.identity.projectId, 'product-b');
  assert.equal(res.repo, 'globex-org/product-b');
});

test('CA-1 · repo secundario allowlisted de A rutea a A (no sólo el primario)', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent(
    { projectId: 'product-a', origin_repo: 'acme-org/product-a-infra' },
    { descriptors },
  );
  assert.ok(res);
  assert.equal(res.repo, 'acme-org/product-a-infra');
});

test('CA-1 · casing distinto del repo se normaliza (allowlist case-insensitive)', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent(
    { projectId: 'product-a', origin_repo: 'ACME-ORG/Product-A' },
    { descriptors },
  );
  assert.ok(res);
  assert.equal(res.repo, 'acme-org/product-a');
});

test('CA-1 · evento sin repo cae al primary DE LA INSTANCIA (mismo tenant, no cross-tenant)', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent({ projectId: 'product-b' }, { descriptors });
  assert.ok(res);
  assert.equal(res.repo, 'globex-org/product-b', 'primary de B, nunca de A');
});

// -----------------------------------------------------------------------------
// CA-2 · A03 adversarial · projectId inseguro → null ANTES de tocar path/clave
// -----------------------------------------------------------------------------

const UNSAFE_PROJECT_IDS = [
  ['path traversal', '../otro'],
  ['traversal profundo', '../../etc/passwd'],
  ['separador /', 'product/a'],
  ['separador backslash', 'product\\a'],
  ['NUL control char', `product${NUL}a`],
  ['newline control char', `product${LF}a`],
  ['tab control char', `product${TAB}a`],
  ['string vacio', ''],
  ['mayusculas fuera de patron', 'ProductA'],
];

for (const [label, badId] of UNSAFE_PROJECT_IDS) {
  test(`CA-2/A03 · projectId inseguro (${label}) → null + audita, sin tocar el catalogo`, () => {
    const spy = spyCatalog(buildCatalog());
    const { entries, audit } = auditCollector();
    const res = resolveInstanceForEvent(
      { projectId: badId, origin_repo: 'acme-org/product-a' },
      { descriptors: spy.descriptors, audit },
    );
    assert.equal(res, null, 'rechazado fail-closed');
    // REQ-SEC-MUX-2: isSafeId corre ANTES de la busqueda en catalogo (primer punto
    // donde el id derivaria un path/clave). El catalogo NO se consulta.
    assert.deepEqual(spy.lookups, [], 'no se consultó el catalogo con el id inseguro');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, 'projectId inseguro');
  });
}

test('CA-2/A03 · projectId no-string (null/objeto/numero) → null + audita', () => {
  const descriptors = buildCatalog();
  for (const bad of [null, undefined, 42, {}, ['product-a']]) {
    const { entries, audit } = auditCollector();
    const res = resolveInstanceForEvent({ projectId: bad, origin_repo: 'acme-org/product-a' }, { descriptors, audit });
    assert.equal(res, null);
    assert.equal(entries[0].reason, 'projectId inseguro');
  }
});

test('CA-2/A03 · control chars del id ofensivo se neutralizan en el log de auditoria', () => {
  const descriptors = buildCatalog();
  const { entries, audit } = auditCollector();
  resolveInstanceForEvent({ projectId: `evil${LF}id${NUL}` }, { descriptors, audit });
  const logged = entries[0].meta.projectId;
  assert.ok(!/[\u0000-\u001f\u007f]/.test(logged), 'sin control chars crudos en el registro');
});

// -----------------------------------------------------------------------------
// CA-3 · Fail-closed por repo/proyecto fuera de allowlist (sin fallback-a-primary)
// -----------------------------------------------------------------------------

test('CA-3 · projectId fuera de catalogo → descarta + audita (sin instancia implicita)', () => {
  const descriptors = buildCatalog();
  const { entries, audit } = auditCollector();
  const res = resolveInstanceForEvent({ projectId: 'product-c', origin_repo: 'acme-org/product-a' }, { descriptors, audit });
  assert.equal(res, null);
  assert.equal(entries[0].reason, 'projectId fuera de catálogo');
});

test('CA-3 · repo valido pero fuera de la allowlist de la instancia → descarta, NUNCA cae a primary', () => {
  const descriptors = buildCatalog();
  const { entries, audit } = auditCollector();
  const res = resolveInstanceForEvent({ projectId: 'product-a', origin_repo: 'evil/repo' }, { descriptors, audit });
  // REQ-SEC-MUX-1: fuera de allowlist ⇒ descartado, no ⇒ primary de A.
  assert.equal(res, null, 'descartado (no reencaminado a acme-org/product-a)');
  assert.equal(entries[0].reason, 'repo fuera de allowlist');
});

test('CA-3 · repo de OTRA instancia (cross-tenant) contra projectId A → descarta', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent({ projectId: 'product-a', origin_repo: 'globex-org/product-b' }, { descriptors });
  assert.equal(res, null, 'el repo de B no rutea bajo el tenant A');
});

test('CA-3 · repo con control chars / metacaracteres → descarta (isRepoAllowed default-deny)', () => {
  const descriptors = buildCatalog();
  const badRepos = [
    `acme-org/product-a${NUL}`,
    'acme-org/pro duct',
    'acme-org/product-a; rm -rf',
    'notaslug',
  ];
  for (const badRepo of badRepos) {
    const res = resolveInstanceForEvent({ projectId: 'product-a', origin_repo: badRepo }, { descriptors });
    assert.equal(res, null, `repo ofensivo rechazado: ${JSON.stringify(badRepo)}`);
  }
});

test('CA-3 · instancia sin repos allowlisted → fail-closed (no FALLBACK_PRIMARY global)', () => {
  const descriptors = new Map();
  descriptors.set('empty', { projectId: 'empty', descriptor: { repositories: [] } });
  const { entries, audit } = auditCollector();
  const res = resolveInstanceForEvent({ projectId: 'empty', origin_repo: 'intrale/platform' }, { descriptors, audit });
  assert.equal(res, null);
  assert.equal(entries[0].reason, 'instancia sin repos allowlisted');
});

// -----------------------------------------------------------------------------
// CA-4 · Auditoria no opcional (A09) + robustez del sink
// -----------------------------------------------------------------------------

test('CA-4 · el sink de auditoria acepta forma funcion (info) además de { discard }', () => {
  const descriptors = buildCatalog();
  const infos = [];
  const res = resolveInstanceForEvent(
    { projectId: '../evil' },
    { descriptors, audit: (info) => infos.push(info) },
  );
  assert.equal(res, null);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].reason, 'projectId inseguro');
  assert.ok('event' in infos[0], 'el info funcional trae el evento');
});

test('CA-4 · sin sink de auditoria no crashea (no-op) pero igual descarta', () => {
  const descriptors = buildCatalog();
  const res = resolveInstanceForEvent({ projectId: '../evil' }, { descriptors });
  assert.equal(res, null);
});

test('CA-4 · evento invalido (no objeto) → null + audita', () => {
  const { entries, audit } = auditCollector();
  assert.equal(resolveInstanceForEvent(null, { descriptors: buildCatalog(), audit }), null);
  assert.equal(entries[0].reason, 'evento inválido');
});

// -----------------------------------------------------------------------------
// CA-5 · descriptors vacio/ausente → fail-closed (no primary global)
// -----------------------------------------------------------------------------

test('CA-5 · descriptors ausente → descarta fail-closed (el fallback single-product vive en pulpo)', () => {
  const { entries, audit } = auditCollector();
  const res = resolveInstanceForEvent({ projectId: 'product-a', origin_repo: 'acme-org/product-a' }, { audit });
  assert.equal(res, null);
  assert.equal(entries[0].reason, 'projectId fuera de catálogo');
});

// -----------------------------------------------------------------------------
// Integracion: supervisor.resolveEvent con instancias vivas (hydrate)
// -----------------------------------------------------------------------------

test('supervisor.resolveEvent rutea usando el descriptor hidratado de la instancia + audita por onAlert', async () => {
  const alerts = [];
  const storeFactory = (opts) => ({
    contextProjectId: opts.contextProjectId,
    getDescriptor: async (pid) => (pid === 'product-a' ? { body: DESCRIPTOR_A } : null),
  });
  const supervisor = createKernelSupervisor({
    catalogStore: { listProducts: async () => [{ productId: 'product-a', projectId: 'product-a', status: 'active' }] },
    storeFactory,
    onAlert: (a) => alerts.push(a),
    hydrate: true,
  });
  await supervisor.bootProducts();

  const ok = supervisor.resolveEvent({ projectId: 'product-a', origin_repo: 'acme-org/product-a' });
  assert.ok(ok);
  assert.equal(ok.repo, 'acme-org/product-a');

  const bad = supervisor.resolveEvent({ projectId: 'product-a', origin_repo: 'evil/repo' });
  assert.equal(bad, null);
  assert.ok(alerts.some((a) => a.stage === 'route-discard'), 'A09: descarte auditado por onAlert');
});

// -----------------------------------------------------------------------------
// Adaptadores puros: extractRepoSlug / deriveRepoConfig
// -----------------------------------------------------------------------------

test('extractRepoSlug acepta slug directo, URL https y ssh; rechaza formas invalidas', () => {
  assert.equal(extractRepoSlug('acme-org/product-a'), 'acme-org/product-a');
  assert.equal(extractRepoSlug('https://github.com/Acme-Org/Product-A'), 'acme-org/product-a');
  assert.equal(extractRepoSlug('https://github.com/acme-org/product-a.git'), 'acme-org/product-a');
  assert.equal(extractRepoSlug('git@github.com:acme-org/product-a.git'), 'acme-org/product-a');
  assert.equal(extractRepoSlug(''), null);
  assert.equal(extractRepoSlug(null), null);
  assert.equal(extractRepoSlug('no-slash'), null);
});

test('deriveRepoConfig arma el config repo-target (primary por role, allowlist, base ref)', () => {
  const cfg = deriveRepoConfig(DESCRIPTOR_A);
  assert.equal(cfg.repos.primary, 'acme-org/product-a');
  assert.deepEqual(cfg.repos.allowlist, ['acme-org/product-a', 'acme-org/product-a-infra']);
  assert.equal(cfg.repos.default_base_ref, 'main');
});

test('deriveRepoConfig sin role primary usa el primer repo valido como primary', () => {
  const cfg = deriveRepoConfig({ repositories: [{ id: 'x', url: 'org/uno' }, { id: 'y', url: 'org/dos' }] });
  assert.equal(cfg.repos.primary, 'org/uno');
});

test('deriveRepoConfig descarta urls invalidas (no rompe la derivacion)', () => {
  const cfg = deriveRepoConfig({ repositories: [{ id: 'a', url: 'no-slash' }, { id: 'b', url: 'org/ok' }] });
  assert.deepEqual(cfg.repos.allowlist, ['org/ok']);
});

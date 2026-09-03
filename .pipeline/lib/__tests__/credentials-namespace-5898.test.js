'use strict';

// =============================================================================
// credentials-namespace-5898.test.js — Blindaje del lookup de refs del store
// (#5898 · split de #5219 · parte de #5215 · épico #5107)
//
// Cubre los criterios de aceptación cerrados en la fase `criterios`:
//
//   - CA-1   : un projectId NO puede resolver un bloque global del store.
//   - CA-1.b : sin fallback top-level cuando el store tiene `namespaces`;
//              retrocompat sólo para stores SIN `namespaces`, y aun ahí
//              sujeto a la deny-list.
//   - CA-2   : el control vive DENTRO de resolveScopedRefs — el camino de
//              `product-seed` (que pasa la ref verbatim) queda cubierto.
//   - CA-3   : la deny-list es una constante única exportada y no se
//              desincroniza de las claves reales del store.
//   - CA-4   : el path de la ref queda anclado al store canónico, con la
//              polaridad correcta (dentro del store Y fuera del repo).
//   - CA-5   : sin prototype pollution y sin funciones nativas como secretos.
//   - CA-6   : todo fail-closed trae `error` poblado y `code` distinguible.
//   - CA-6.b : el `error` llega al onAlert de kernel-supervisor (UX-1).
//   - CA-7   : ningún assert compara valores de credencial; fixtures `FAKE-*`.
//
// Complementa —no duplica— credentials-scoped-refs.test.js,
// credentials-isolation.test.js y product-seed.test.js.
//
// CA-7: los fixtures usan valores sintéticos con prefijo `FAKE-`. Ningún test
// imprime ni compara un valor de credencial: sólo nombres de scope, presencia
// y forma.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cred = require('../credentials');
const seed = require('../product-seed');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Ref anclada derivada del export del módulo (R-7: no un literal escrito a
// mano, para que la comparación de paths no dependa del case en win32).
const REF_ANCLADA = `~/${path.relative(os.homedir(), cred.CANONICAL_PATH).replace(/\\/g, '/')}`;

// -----------------------------------------------------------------------------
// Fixtures sintéticos (CA-7)
// -----------------------------------------------------------------------------

// Store con la MISMA forma que el real: bloques globales top-level. El bloque
// global está PRESENTE a propósito — si no, CA-1 pasaría por la razón
// equivocada (el namespace simplemente no existiría).
const STORE_CON_BLOQUES_GLOBALES = {
  _note: 'fixture sintético',
  _version: 1,
  telegram: { bot_token: 'FAKE-telegram-bot-token' },
  providers: { openai: 'FAKE-openai', anthropic: 'FAKE-anthropic', google: 'FAKE-google' },
  multimedia: { api_key: 'FAKE-multimedia' },
  aws: { access_key_id: 'FAKE-akid', secret_access_key: 'FAKE-sak' },
  google_drive: { client_id: 'FAKE-drive-client' },
  aws_vault_bootstrap: { role_arn: 'FAKE-role-arn' },
  namespaces: {
    'mi-producto': { api_key: 'FAKE-mi-producto-api-key', github: 'FAKE-mi-producto-gh' },
  },
};

// Store legacy: SIN clave `namespaces` (la forma del store real hoy).
const STORE_SIN_NAMESPACES = {
  _note: 'fixture sintético legacy',
  telegram: { bot_token: 'FAKE-telegram-bot-token' },
  providers: { openai: 'FAKE-openai' },
  'tenant-legacy': { api_key: 'FAKE-tenant-legacy-api-key' },
};

// Scopes que son own-properties de Object.prototype — nunca pueden salir como
// secretos (evidencia D2).
const SCOPES_DE_PROTOTYPE = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'];

// -----------------------------------------------------------------------------
// CA-1 · Un projectId no puede resolver un bloque global del store
// -----------------------------------------------------------------------------

test('CA-1 · ningún bloque global del store resuelve como namespace de tenant', () => {
  assert.ok(Array.isArray(cred.RESERVED_STORE_NAMESPACES), 'RESERVED_STORE_NAMESPACES exportada');
  assert.ok(cred.RESERVED_STORE_NAMESPACES.length > 0, 'la deny-list no está vacía');

  for (const ns of cred.RESERVED_STORE_NAMESPACES) {
    const res = cred.resolveScopedRefs(`${REF_ANCLADA}#${ns}`, ['openai', 'bot_token', 'api_key', 'access_key_id'], {
      data: STORE_CON_BLOQUES_GLOBALES,
    });
    assert.equal(res.ok, false, `${ns}: fail-closed`);
    assert.equal(res.code, 'namespace_reservado', `${ns}: code de denegación por bloque global`);
    assert.deepEqual(res.scopes, {}, `${ns}: cero scopes del bloque global`);
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.includes(ns), `${ns}: el error nombra el namespace rechazado`);
    // CA-7 — el rechazo no ecoa ningún valor del bloque global.
    assert.ok(!JSON.stringify(res).includes('FAKE-'), `${ns}: el fallo no filtra valores`);
  }
});

test('CA-1 · la denegación aplica aunque el bloque global esté bajo `namespaces`', () => {
  // Defensa en profundidad: si alguien registrara `namespaces.providers`, el
  // control es por nombre, no por ubicación.
  const store = {
    namespaces: { providers: { openai: 'FAKE-openai-bajo-namespaces' } },
  };
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#providers`, ['openai'], { data: store });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'namespace_reservado');
  assert.deepEqual(res.scopes, {});
});

test('CA-1 · un namespace de tenant legítimo SÍ resuelve sus scopes declarados', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key', 'github'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, true, 'el tenant honesto no se degrada');
  assert.deepEqual(Object.keys(res.scopes).sort(), ['api_key', 'github']);
});

test('CA-1 · un namespace de tenant inexistente sigue fallando con error explícito', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#no-existe`, ['api_key'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'namespace_inexistente');
  assert.equal(typeof res.error, 'string');
  assert.ok(res.error.length > 0);
});

// -----------------------------------------------------------------------------
// CA-1.b · El fallback top-level se apaga solo cuando el store migre
// -----------------------------------------------------------------------------

test('CA-1.b · store CON `namespaces`: no hay fallback a la clave top-level', () => {
  // `tenant-solo-top-level` existe SÓLO en la raíz. Con `namespaces` presente,
  // no debe resolverse por ningún camino.
  const store = {
    'tenant-solo-top-level': { api_key: 'FAKE-no-debe-resolver' },
    namespaces: { 'mi-producto': { api_key: 'FAKE-mi-producto' } },
  };
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#tenant-solo-top-level`, ['api_key'], { data: store });
  assert.equal(res.ok, false, 'sin fallback top-level cuando el store tiene namespaces');
  assert.equal(res.code, 'namespace_inexistente');
  assert.deepEqual(res.scopes, {});
  assert.ok(!JSON.stringify(res).includes('FAKE-'), 'el fallo no filtra valores');
});

test('CA-1.b · store SIN `namespaces`: retrocompat top-level, pero sujeta a la deny-list', () => {
  // Retrocompat: un tenant legacy en la raíz sigue resolviendo…
  const okLegacy = cred.resolveScopedRefs(`${REF_ANCLADA}#tenant-legacy`, ['api_key'], {
    data: STORE_SIN_NAMESPACES,
  });
  assert.equal(okLegacy.ok, true, 'retrocompat viva mientras el store no migre (#5217)');
  assert.deepEqual(Object.keys(okLegacy.scopes), ['api_key']);

  // …pero los bloques globales NO, ni siquiera por el camino de retrocompat.
  for (const ns of ['telegram', 'providers']) {
    const res = cred.resolveScopedRefs(`${REF_ANCLADA}#${ns}`, ['bot_token', 'openai'], {
      data: STORE_SIN_NAMESPACES,
    });
    assert.equal(res.ok, false, `${ns}: la deny-list también cubre la retrocompat`);
    assert.equal(res.code, 'namespace_reservado');
    assert.deepEqual(res.scopes, {});
  }
});

// -----------------------------------------------------------------------------
// CA-2 · El control vive en el resolver, no en el call-site
// -----------------------------------------------------------------------------

test('CA-2 · product-seed con credentialRef a #providers no resuelve (resolver real, sin stub)', async () => {
  const driver = seed.createInMemoryGitHubDriver();
  const products = new Map();
  const store = {
    async putProduct(p) { products.set(p.productId, { ...p }); return { ok: true, sk: p.productId }; },
  };

  const descriptor = {
    productId: 'prod-atacante',
    owner: 'intrale',
    repo: 'prod-atacante',
    slug: 'prod-atacante',
    name: 'Prod Atacante',
    stack: 'kotlin-compose',
    labels: [{ name: 'area:backend', color: 'ededed', description: 'Backend' }],
    projectV2: {
      id: 'PVT_kwProjectId',
      // La ref viaja verbatim desde el descriptor (product-seed.js:701).
      credentialRef: `${REF_ANCLADA}#providers`,
      // Scope que el bloque global `providers` SÍ tiene: es la forma exacta del
      // vector D4. Con un scope inexistente el test pasaría por la razón
      // equivocada (faltaría el scope, no se denegaría el namespace).
      scopes: ['openai'],
    },
  };

  // deps SIN override de resolveScopedRefs ⇒ se usa el resolver REAL.
  const res = await seed.seedProduct(descriptor, { driver, store });

  const link = res.artifacts.find((a) => a.type === 'project_v2');
  assert.ok(link, 'hay artefacto de project_v2');
  assert.notEqual(link.status, 'linked', 'el bloque global NO se resuelve por el camino de product-seed');
  assert.equal(products.get('prod-atacante') && products.get('prod-atacante').status !== seed.PRODUCT_STATUS.OPERATIVO, true,
    'producto no queda operativo con una ref denegada');
});

test('CA-2 · el rechazo ocurre dentro del resolver, sin validación extra del call-site', () => {
  // Mismo input que pasa product-seed, contra el resolver directamente.
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#providers`, ['project'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'namespace_reservado');
});

test('CA-2 · el opt-in de primera parte NO viaja en un descriptor: product-seed con #google_drive sigue denegado', () => {
  // `product-seed.js:701` pasa `pv.credentialRef` VERBATIM y no pasa `opts`
  // nunca. Ese es justamente el motivo por el que el opt-in de #5898 es un
  // argumento de call-site y no un campo de la ref: un descriptor hostil puede
  // elegir el namespace, pero no puede declararse "primera parte".
  //
  // Se usa `google_drive` a propósito: es el bloque global que SÍ tiene un
  // consumidor legítimo (#5217 · qa-video-share). Si mañana alguien lo saca de
  // la deny-list para "arreglar" a Drive, este test se pone rojo y el vector D4
  // queda a la vista antes de mergear.
  // `client_id` es un scope que el bloque `google_drive` del fixture SÍ tiene:
  // con uno inexistente el test pasaría por la razón equivocada (faltaría el
  // scope, no se denegaría el namespace).
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#google_drive`, ['client_id'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false, 'sin flag explícito, el camino es el de tenant');
  assert.equal(res.code, 'namespace_reservado');
  assert.deepEqual(res.scopes, {});
  assert.ok(res.error.includes('google_drive'), 'el error nombra el namespace denegado');
  assert.ok(!JSON.stringify(res).includes('FAKE-'), 'el rechazo no filtra valores del bloque global');
});

test('CA-2 · el consumidor de primera parte (#5217) SÍ resuelve su propio bloque global', () => {
  // La contracara: la deny-list protege del tenant impostor, no tapia al dueño.
  // Sin este camino, #5217 se queda sin credenciales de Drive y no hay red
  // debajo (`hydrate:false`, y el legacy no tiene las claves).
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#google_drive`, ['client_id'], {
    data: STORE_CON_BLOQUES_GLOBALES,
    systemNamespace: true,
  });
  assert.equal(res.ok, true, 'el dueño del bloque global lo resuelve con el opt-in explícito');
  assert.deepEqual(Object.keys(res.scopes), ['client_id']);
});

// -----------------------------------------------------------------------------
// CA-3 · Constante única, sin desincronización con el store real
// -----------------------------------------------------------------------------

test('CA-3 · la deny-list cubre las claves top-level reales del store', (t) => {
  if (!fs.existsSync(cred.CANONICAL_PATH)) {
    t.skip('store no presente en este host');
    return;
  }
  // CA-7 — se leen SÓLO nombres de clave, nunca valores.
  let claves;
  try {
    claves = Object.keys(JSON.parse(fs.readFileSync(cred.CANONICAL_PATH, 'utf8')));
  } catch (e) {
    t.skip('store ilegible en este host');
    return;
  }
  const bloquesGlobales = claves.filter((k) => k !== '_note' && k !== '_version' && k !== 'namespaces');
  const faltantes = bloquesGlobales.filter((k) => !cred.RESERVED_STORE_NAMESPACES.includes(k));
  assert.deepEqual(faltantes, [], `bloques globales del store fuera de la deny-list: ${faltantes.join(', ')}`);
});

test('CA-3 · la deny-list es una constante congelada y única', () => {
  assert.ok(Object.isFrozen(cred.RESERVED_STORE_NAMESPACES), 'la lista es inmutable');
  const copia = [...cred.RESERVED_STORE_NAMESPACES];
  assert.deepEqual([...new Set(copia)], copia, 'sin duplicados');
});

// -----------------------------------------------------------------------------
// CA-4 · Anclaje de path al store canónico (polaridad: dentro del store Y
//        fuera del repo)
// -----------------------------------------------------------------------------

// Forma POSIX y sin letra de unidad del repo, para que parseSecretRef la acepte
// (su regex no admite `\` ni `:`); path.resolve la vuelve a anclar a la unidad
// del cwd, que es la del repo.
const REPO_ROOT_POSIX = REPO_ROOT.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

const PATHS_RECHAZADOS = [
  ['traversal desde el store', '~/.claude/secrets/../../evil.json'],
  ['ruta absoluta fuera del store', '/tmp/evil-credentials.json'],
  ['home fuera del store', '~/x.json'],
  ['dentro del árbol del repo', `${REPO_ROOT_POSIX}/.pipeline/config.yaml`],
];

for (const [caso, p] of PATHS_RECHAZADOS) {
  test(`CA-4 · path rechazado fail-closed: ${caso}`, () => {
    const res = cred.resolveScopedRefs(`${p}#mi-producto`, ['api_key'], {
      data: STORE_CON_BLOQUES_GLOBALES,
    });
    assert.equal(res.ok, false, `${caso}: fail-closed`);
    assert.equal(res.code, 'path_fuera_del_store', `${caso}: code de path`);
    assert.deepEqual(res.scopes, {});
    assert.equal(typeof res.error, 'string');
    // El error nombra el path LÓGICO (el de la ref), no el resuelto — el
    // resuelto expone el home del host.
    assert.ok(res.error.includes(p), `${caso}: el error nombra el path lógico rechazado`);
    assert.ok(!res.error.includes(os.homedir()), `${caso}: el error no expone el home del host`);
  });
}

test('CA-4 · el path se rechaza SIN abrir el archivo', () => {
  const original = fs.readFileSync;
  let lecturas = 0;
  fs.readFileSync = function spy(...args) { lecturas += 1; return original.apply(this, args); };
  try {
    // Sin `opts.data`: si el ancla no cortara antes, se intentaría leer disco.
    const res = cred.resolveScopedRefs('~/.claude/secrets/../../evil.json#mi-producto', ['api_key']);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'path_fuera_del_store', 'rechaza por path, no por store ilegible');
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(lecturas, 0, 'no se abrió ningún archivo antes de rechazar el path');
});

test('CA-4 · el store legítimo (fuera del repo) SIGUE resolviendo — polaridad correcta (R-2)', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, true, 'el store canónico vive FUERA del repo y debe seguir resolviendo');
  assert.deepEqual(Object.keys(res.scopes), ['api_key']);
});

// -----------------------------------------------------------------------------
// CA-5 · Sin prototype pollution ni funciones nativas como secretos
// -----------------------------------------------------------------------------

for (const ns of ['__proto__', 'constructor', 'prototype']) {
  test(`CA-5 · namespace "${ns}" se rechaza con error explícito`, () => {
    const res = cred.resolveScopedRefs(`${REF_ANCLADA}#${ns}`, SCOPES_DE_PROTOTYPE, {
      data: STORE_CON_BLOQUES_GLOBALES,
    });
    assert.equal(res.ok, false, `${ns}: fail-closed`);
    assert.equal(res.code, 'namespace_invalido', `${ns}: code de clave interna de JS`);
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.includes(ns), `${ns}: el error nombra el namespace rechazado`);
    assert.deepEqual(res.scopes, {}, `${ns}: sin scopes`);
  });
}

test('CA-5 · ningún scope devuelto puede ser una función nativa del prototipo', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, SCOPES_DE_PROTOTYPE, {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false, 'scopes que sólo existen en Object.prototype no se entregan');
  assert.deepEqual(res.scopes, {});
  assert.ok(
    Object.values(res.scopes).every((v) => typeof v !== 'function'),
    'ningún valor devuelto es typeof function',
  );
  assert.deepEqual(res.missing.sort(), [...SCOPES_DE_PROTOTYPE].sort());
});

test('CA-5 · el lookup no hereda del prototipo aunque el namespace exista', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key', 'toString'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false, 'toString falta ⇒ fail-closed');
  assert.deepEqual(res.missing, ['toString']);
  assert.deepEqual(Object.keys(res.scopes), ['api_key']);
  assert.ok(Object.values(res.scopes).every((v) => typeof v !== 'function'));
});

test('CA-5 · la forma pública de `scopes` sigue siendo un objeto literal (R-4)', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  // `assert.deepEqual` es strict y compara prototipos: si `scopes` saliera con
  // Object.create(null) crudo, este assert (y el de credentials-scoped-refs)
  // se pondrían rojos.
  assert.deepEqual(Object.getPrototypeOf(res.scopes), Object.prototype);
  const vacio = cred.resolveScopedRefs(`${REF_ANCLADA}#no-existe`, ['api_key'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.deepEqual(vacio.scopes, {});
});

// -----------------------------------------------------------------------------
// CA-6 · Todo fail-closed es accionable y distinguible
// -----------------------------------------------------------------------------

const CASOS_FAIL_CLOSED = [
  ['ref_invalida', () => cred.resolveScopedRefs('AKIAIOSFODNN7EXAMPLE', ['aws'], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['scopes_requeridos', () => cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, [], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['namespace_invalido', () => cred.resolveScopedRefs(`${REF_ANCLADA}#__proto__`, ['api_key'], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['namespace_reservado', () => cred.resolveScopedRefs(`${REF_ANCLADA}#providers`, ['openai'], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['path_fuera_del_store', () => cred.resolveScopedRefs('~/x.json#mi-producto', ['api_key'], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['namespace_inexistente', () => cred.resolveScopedRefs(`${REF_ANCLADA}#no-existe`, ['api_key'], { data: STORE_CON_BLOQUES_GLOBALES })],
  ['scope_faltante', () => cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key', 'falta'], { data: STORE_CON_BLOQUES_GLOBALES })],
];

test('CA-6 · todo retorno con ok:false trae `error` string no vacío (nunca undefined)', () => {
  for (const [code, run] of CASOS_FAIL_CLOSED) {
    const res = run();
    assert.equal(res.ok, false, `${code}: ok:false`);
    assert.equal(typeof res.error, 'string', `${code}: error es string, no undefined`);
    assert.ok(res.error.trim().length > 0, `${code}: error no vacío`);
    assert.notEqual(res.error, 'scopes faltantes', `${code}: sin texto terminal genérico`);
  }
});

test('CA-6 · los códigos de fallo son distinguibles entre sí', () => {
  const observados = CASOS_FAIL_CLOSED.map(([code, run]) => {
    const res = run();
    assert.equal(res.code, code, `el caso ${code} reporta su propio code`);
    return res.code;
  });
  assert.equal(new Set(observados).size, observados.length, 'todos los codes son distintos');
});

test('CA-6 · la rama de `missing` no vacío nombra el namespace y los scopes faltantes', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key', 'falta', 'otro'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'scope_faltante');
  assert.deepEqual(res.missing.sort(), ['falta', 'otro']);
  assert.ok(res.error.includes('mi-producto'), 'nombra el namespace afectado');
  assert.ok(res.error.includes('falta') && res.error.includes('otro'), 'nombra los scopes faltantes');
});

test('CA-6 · el mensaje de namespace reservado enumera la deny-list desde la constante', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#providers`, ['openai'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  for (const ns of cred.RESERVED_STORE_NAMESPACES) {
    assert.ok(res.error.includes(ns), `el error enumera el reservado "${ns}"`);
  }
});

test('CA-6 · redactScoped propaga `code` y `error` sin ecoar valores (CA-7)', () => {
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#providers`, ['openai'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  const red = cred.redactScoped(res);
  assert.equal(red.code, 'namespace_reservado');
  assert.equal(red.error, res.error);
  assert.deepEqual(red.scopes, []);
  assert.ok(!JSON.stringify(red).includes('FAKE-'), 'la forma redactada no incluye valores');
});

// -----------------------------------------------------------------------------
// CA-6.b (UX-1) · El error accionable llega a la superficie que lee el humano
// -----------------------------------------------------------------------------

const { createKernelSupervisor } = require('../kernel-supervisor');

function supervisorConAlertas(catalogo, alertas) {
  return createKernelSupervisor({
    catalogStore: { listProducts: async () => catalogo.slice() },
    storeFactory: (opts) => ({ contextProjectId: opts.contextProjectId, getDescriptor: async () => null }),
    onAlert: (a) => alertas.push(a),
    hydrate: false,
  });
}

// #5899 — este seam del kernel dejó de consumir `resolveScopedRefs`: ahora
// resuelve contra el VAULT (REQ-SEC-1), así que `namespace_reservado` y
// `path_fuera_del_store` ya no pueden originarse acá. Esos dos rechazos siguen
// cubiertos ARRIBA, directamente sobre `resolveScopedRefs`, que es donde vive
// el blindaje de #5898 y donde sigue entrando su otro consumidor
// (`product-seed.js`). Lo que estos dos casos pinnean —y sigue siendo el
// invariante de UX-1 de CA-6.b— es que el `detail` de `onAlert` ES el error del
// resolver, verbatim, y nunca una reconstrucción a partir de `missing`.

test('CA-6.b · onAlert de `secrets` emite el error del resolver verbatim (gate del vault cerrado)', async () => {
  const alertas = [];
  // #6032 · CA-15 — el id del fixture era `providers`, que desde este corte es
  // un projectId RESERVADO (colisiona con el scope homónimo en el path del
  // vault) y el supervisor lo rechaza en el boot. Se renombra a un id sintético:
  // lo que este caso pinnea es el `detail` verbatim del resolver, no el id.
  const supervisor = supervisorConAlertas(
    [{ productId: 'fake-providers', projectId: 'fake-providers', name: 'FAKE Providers', status: 'active' }],
    alertas,
  );
  await supervisor.bootProducts();

  // Sin `vaultConfig` inyectada se lee la real: `vault.enabled: false` ⇒
  // fail-closed, JAMÁS fallback al archivo de credenciales (CA-17 de #5899).
  const r = supervisor.resolveInstanceSecrets('fake-providers', {
    scopes: ['openai'],
    logger: () => {},
  });
  assert.equal(r.ok, false);

  const alerta = alertas.find((a) => a.stage === 'secrets');
  assert.ok(alerta, 'se emitió la alerta de secrets');
  const detail = alerta.errors[0].detail;
  assert.equal(detail, r.error, 'el detail ES el error del resolver, no una reconstrucción');
  assert.ok(!detail.includes('missing: —'), 'el operador nunca lee "missing: —" como texto terminal');
  assert.ok(detail.includes('providers'), 'el detail nombra el producto que quedó sin credenciales');
  assert.ok(detail.includes('vault.enabled'), 'el detail nombra la palanca que hay que tocar');
});

test('CA-6.b · onAlert de `secrets` emite el error del resolver verbatim (scope ausente en el vault)', async () => {
  const alertas = [];
  const supervisor = supervisorConAlertas(
    [{ productId: 'acme', projectId: 'acme', name: 'ACME', status: 'active' }],
    alertas,
  );
  await supervisor.bootProducts();

  const { createInMemoryVaultDriver } = require('../secret-vault');
  const r = supervisor.resolveInstanceSecrets('acme', {
    scopes: ['api_key'],
    vaultConfig: {
      enabled: true, prefix: '/test5898', projectId: 'kernel', hostId: 'hostDePrueba',
      cache_ttl_seconds: 300, required_scopes: [], shared_secrets: [],
    },
    vaultDriver: createInMemoryVaultDriver({ parameters: {} }),   // vault vacío
    logger: () => {},
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.error, 'scopes faltantes', 'el retorno no degrada a texto terminal');

  const alerta = alertas.find((a) => a.stage === 'secrets');
  assert.ok(alerta, 'se emitió la alerta de secrets');
  const detail = alerta.errors[0].detail;
  assert.equal(detail, r.error, 'el detail ES el error del resolver');
  assert.ok(!detail.includes('missing: —'), 'sin "missing: —" como texto terminal');
  assert.ok(detail.includes('api_key'), 'el detail nombra el scope que falta');
});

// -----------------------------------------------------------------------------
// CA-7 · Ningún valor de credencial se ecoa
// -----------------------------------------------------------------------------

// Nota de alcance: el retorno CRUDO de resolveScopedRefs contiene los secretos
// resueltos por diseño (es lo que se inyecta como env por proceso; ver el
// encabezado de credentials.js). Las superficies que CA-7 protege son las que
// se loguean: el mensaje de error y la forma redactada.
test('CA-7 · ningún mensaje de error de este camino incluye valores de credencial', () => {
  for (const [code, run] of CASOS_FAIL_CLOSED) {
    const res = run();
    assert.ok(!res.error.includes('FAKE-'), `${code}: el error no ecoa valores`);
    // Tampoco longitudes ni fragmentos del valor.
    for (const valor of ['FAKE-openai', 'FAKE-mi-producto-api-key', 'FAKE-telegram-bot-token']) {
      assert.ok(!res.error.includes(valor.slice(5)), `${code}: el error no ecoa fragmentos del valor`);
    }
  }
});

test('CA-7 · redactScoped nunca ecoa valores, ni con scopes parcialmente resueltos', () => {
  // Caso más exigente: `scope_faltante` devuelve scopes parciales en el objeto
  // crudo — la forma redactada debe seguir siendo sólo nombres.
  const res = cred.resolveScopedRefs(`${REF_ANCLADA}#mi-producto`, ['api_key', 'falta'], {
    data: STORE_CON_BLOQUES_GLOBALES,
  });
  assert.equal(res.code, 'scope_faltante');
  assert.equal(res.scopes.api_key, 'FAKE-mi-producto-api-key', 'el crudo sí resuelve lo que existe');

  const red = cred.redactScoped(res);
  assert.ok(!JSON.stringify(red).includes('FAKE-'), 'la forma redactada no incluye ningún valor');
  assert.deepEqual(red.scopes, ['api_key'], 'sólo nombres de scope');
  assert.equal(red.code, 'scope_faltante');
});

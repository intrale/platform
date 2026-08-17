'use strict';

// =============================================================================
// credentials-ref-ancla-5900.test.js — #6031 (parte de #5900)
//
// `credentials[].ref` queda anclada al store canónico en la validación del
// descriptor, REUSANDO `refPathAnclado` (dueño: `credentials.js`, #5898).
//
// Cobertura → criterios de aceptación del PO:
//   - CA-1  : `refPathAnclado` y `STORE_DIR_LOGICO` exportados; `parseSecretRef` intacto.
//   - CA-2  : el ancla se importa, nunca se reimplementa (ni acá ni en el schema).
//   - CA-3  : los 4 vectores maliciosos ⇒ valid:false + stage:'path' + keyword:'pathTraversal';
//             la ref canónica sigue válida.
//   - CA-4  : ref no parseable ⇒ hit (fail-closed), probado contra `collectPathTraversalHits`.
//   - CA-5  : `credentials` ausente ⇒ 0 hits; `credentials` no-array ⇒ hit.
//   - CA-6  : cero `fs` durante `collectPathTraversalHits` (sin TOCTOU, sin oráculo de existencia).
//   - CA-7  : el `detail` no filtra el home del host ni el path resuelto.
//   - CA-10 : el descriptor de producción del kernel sigue válido (blindaje de la decisión R-1).
//   - CA-13 : el `detail` es accionable, estático, uno por entrada y sin jerga (UX-1..UX-4).
//
// FUERA DE ALCANCE (#6077): que el namespace de la ref coincida con
// `identity.projectId`. Este archivo NO lo testea, y CA-10 es justamente el
// gate que detecta si se coló.
//
// Datos sintéticos `FAKE-*`. El test no crea ni lee nada en `~/.claude/secrets/`
// ni depende de que ese directorio exista: el camino bajo prueba es cálculo puro
// de paths.
// =============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const d = require('../project-descriptor');
const c = require('../credentials');

const REF_CANONICA = '~/.claude/secrets/credentials.json#intrale';

// Los 4 vectores del issue. Todos pasan el `pattern` del schema (por eso el
// schema no alcanza) y todos tienen que morir en el paso `path`.
const VECTORES_MALICIOSOS = [
  ['evil home', '~/otro/lugar/evil.json#intrale'],
  ['traversal relativo', '../../evil.json#intrale'],
  ['absoluto /tmp', '/tmp/evil.json#intrale'],
  ['traversal desde el store', '~/.claude/secrets/../../evil.json#intrale'],
];

// -----------------------------------------------------------------------------
// Helper: descriptor 1.0 válido mínimo, con datos sintéticos.
// -----------------------------------------------------------------------------
function fakeDescriptor(overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: 'fake-project', name: 'FAKE-Project' },
    repositories: [{ id: 'main', url: 'https://github.com/fake-org/FAKE-repo', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/fake-org/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    credentials: [{ ref: REF_CANONICA, scopes: ['github'] }],
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['FAKE-signer'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

function conRefs(...refs) {
  return fakeDescriptor({ credentials: refs.map((ref) => ({ ref, scopes: ['github'] })) });
}

// -----------------------------------------------------------------------------
// CA-1 — los dos símbolos quedan exportados, `parseSecretRef` sin duplicar
// -----------------------------------------------------------------------------

test('CA-1: credentials.js exporta refPathAnclado y STORE_DIR_LOGICO', () => {
  assert.equal(typeof c.refPathAnclado, 'function');
  assert.equal(c.STORE_DIR_LOGICO, '~/.claude/secrets/');
  // Ya estaba exportado desde antes: no se agrega de nuevo, se reusa.
  assert.equal(typeof c.parseSecretRef, 'function');
});

// -----------------------------------------------------------------------------
// CA-2 — punto único de verdad: se importa, no se reimplementa
// -----------------------------------------------------------------------------

test('CA-2: project-descriptor.js importa el ancla y no la define', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'project-descriptor.js'), 'utf8');
  assert.ok(/require\('\.\/credentials'\)/.test(src), 'debe requerir ./credentials');
  assert.ok(src.includes('refPathAnclado'), 'debe usar refPathAnclado');
  assert.ok(
    !/function\s+refPathAnclado/.test(src),
    'refPathAnclado NO puede estar definida acá: una segunda copia del control se desincroniza',
  );
});

test('CA-2: el schema no intenta anclar la ref con una regex propia', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'contracts', 'project.schema.json'), 'utf8'));
  assert.equal(
    schema.properties.credentials.items.properties.ref.pattern,
    '^~?[A-Za-z0-9._/-]+#[A-Za-z0-9._:-]+$',
    'el pattern del schema queda exactamente como está: el ancla vive en credentials.js',
  );
});

// -----------------------------------------------------------------------------
// CA-3 — la matriz de vectores se rechaza en el paso correcto
// -----------------------------------------------------------------------------

for (const [nombre, ref] of VECTORES_MALICIOSOS) {
  test(`CA-3: vector "${nombre}" se rechaza en el paso path`, () => {
    const res = d.validateDescriptor(conRefs(ref));
    // Los tres campos JUNTOS son el criterio: `valid:false` a secas también lo
    // devuelve el paso `schema`, y taparía un fix inexistente.
    assert.equal(res.valid, false, 'el vector no puede pasar la validación');
    assert.equal(res.stage, 'path', 'tiene que morir en el paso de sanitización de paths');
    assert.ok(
      res.errors.some((e) => e.keyword === 'pathTraversal' && e.path === 'credentials[0].ref'),
      `se esperaba un hit pathTraversal en credentials[0].ref, hubo: ${JSON.stringify(res.errors)}`,
    );
  });
}

test('CA-3: la ref canónica del store sigue siendo válida', () => {
  const res = d.validateDescriptor(conRefs(REF_CANONICA));
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test('CA-3: un subdirectorio del store también es legítimo', () => {
  const res = d.validateDescriptor(conRefs('~/.claude/secrets/sub/otro.json#intrale'));
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

// -----------------------------------------------------------------------------
// CA-4 — fail-closed ante ref no parseable
//
// Se prueba UNITARIAMENTE contra `collectPathTraversalHits`: vía
// `validateDescriptor` el `pattern` del schema corta antes (paso 3) y el guard
// nunca se ejercitaría.
// -----------------------------------------------------------------------------

for (const refRota of ['sin-numeral', '', null, undefined, 42, { ref: 'objeto' }, ['array']]) {
  test(`CA-4: ref no parseable (${JSON.stringify(refRota)}) cuenta como hit, nunca se saltea`, () => {
    const hits = d.collectPathTraversalHits(fakeDescriptor({ credentials: [{ ref: refRota, scopes: ['github'] }] }));
    assert.equal(hits.length, 1, `se esperaba 1 hit, hubo: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].path, 'credentials[0].ref');
  });
}

test('CA-4: una entrada sin la propiedad ref cuenta como hit', () => {
  const hits = d.collectPathTraversalHits(fakeDescriptor({ credentials: [{ scopes: ['github'] }, null] }));
  assert.equal(hits.length, 2, JSON.stringify(hits));
});

// -----------------------------------------------------------------------------
// CA-5 — ausencia ≠ fail-open
// -----------------------------------------------------------------------------

test('CA-5: credentials ausente ⇒ 0 hits (el bloque es opcional en el schema)', () => {
  const sinCreds = fakeDescriptor();
  delete sinCreds.credentials;
  assert.deepEqual(d.collectPathTraversalHits(sinCreds), []);
  assert.equal(d.validateDescriptor(sinCreds).valid, true);
});

for (const forma of [{}, { ref: REF_CANONICA }, 'una-string', 7]) {
  test(`CA-5: credentials con forma inesperada (${JSON.stringify(forma)}) ⇒ hit`, () => {
    const hits = d.collectPathTraversalHits(fakeDescriptor({ credentials: forma }));
    assert.equal(hits.length, 1, `un "|| []" se lo tragaría en silencio: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].path, 'credentials');
  });
}

test('CA-5: credentials como array vacío ⇒ 0 hits', () => {
  assert.deepEqual(d.collectPathTraversalHits(fakeDescriptor({ credentials: [] })), []);
});

// -----------------------------------------------------------------------------
// CA-6 — cero `fs` en el camino
//
// El espía se instala DESPUÉS del `require`: `project-descriptor.js` lee el
// schema en carga de módulo (`fs.readFileSync` del `project.schema.json`), y esa
// lectura no es parte de la ventana bajo medición.
// -----------------------------------------------------------------------------

test('CA-6: collectPathTraversalHits no toca el filesystem', (t) => {
  const espias = ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'realpathSync', 'openSync', 'accessSync']
    .map((fn) => [fn, mock.method(fs, fn, () => { throw new Error(`fs.${fn} no debe invocarse durante la validación de paths`); })]);
  t.after(() => mock.restoreAll());

  const hits = d.collectPathTraversalHits(conRefs(REF_CANONICA, '../../evil.json#intrale'));

  for (const [fn, espia] of espias) {
    assert.equal(espia.mock.callCount(), 0, `fs.${fn} fue invocada durante collectPathTraversalHits`);
  }
  assert.equal(hits.length, 1, 'el rechazo ocurre igual, sin abrir el archivo del store');
});

// -----------------------------------------------------------------------------
// CA-7 · CA-13 — el mensaje al operador: sin fugas, accionable, estático
// -----------------------------------------------------------------------------

function detallesDe(descriptor) {
  return d.collectPathTraversalHits(descriptor).map((h) => h.detail);
}

test('CA-7: ningún detail filtra el home del host ni el path resuelto', () => {
  const refs = VECTORES_MALICIOSOS.map(([, ref]) => ref);
  const detalles = detallesDe(conRefs(...refs)).concat(detallesDe(fakeDescriptor({ credentials: {} })));
  assert.ok(detalles.length > 0, 'el caso de prueba tiene que producir hits');

  const home = os.homedir();
  for (const det of detalles) {
    assert.ok(!det.includes(home), `el detail filtra el homedir del host: ${det}`);
    assert.ok(!det.includes(path.sep === '\\' ? 'C:\\' : '/home/'), `el detail parece contener un path resuelto: ${det}`);
    // Tampoco hace eco del valor crudo que mandó el descriptor.
    for (const ref of refs) assert.ok(!det.includes(ref), `el detail hace eco de la ref cruda: ${det}`);
  }
});

test('CA-7: el detail es estático — no varía con el valor rechazado', () => {
  const [a] = detallesDe(conRefs('/tmp/evil.json#intrale'));
  const [b] = detallesDe(conRefs('~/otro/lugar/otra-cosa.json#fake'));
  assert.equal(a, b);
});

test('CA-13 · UX-1/UX-2: el detail nombra el destino esperado vía STORE_DIR_LOGICO', () => {
  const [det] = detallesDe(conRefs('/tmp/evil.json#intrale'));
  assert.ok(det.includes(c.STORE_DIR_LOGICO), `el detail tiene que decir a dónde va el archivo: ${det}`);
  // Accionable, no sólo diagnóstico: le dice al operador qué hacer.
  assert.ok(/corregí|Mové/i.test(det), `el detail tiene que indicar la corrección concreta: ${det}`);
});

test('CA-13 · UX-3: un hit por entrada inválida, con su índice', () => {
  const hits = d.collectPathTraversalHits(conRefs('/tmp/evil.json#intrale', REF_CANONICA, '../../evil.json#intrale'));
  assert.deepEqual(hits.map((h) => h.path), ['credentials[0].ref', 'credentials[2].ref']);
});

test('CA-13 · UX-4: el copy del operador no tiene jerga técnica', () => {
  const detalles = detallesDe(conRefs('/tmp/evil.json#intrale')).concat(detallesDe(fakeDescriptor({ credentials: {} })));
  for (const det of detalles) {
    for (const jerga of ['path traversal', 'CWE', 'fail-closed', 'ancla', 'traversal']) {
      assert.ok(!det.toLowerCase().includes(jerga.toLowerCase()), `jerga "${jerga}" en el copy: ${det}`);
    }
  }
});

// -----------------------------------------------------------------------------
// CA-10 — blindaje de la decisión R-1: el descriptor de producción sigue válido
// -----------------------------------------------------------------------------

test('CA-10: el descriptor de producción del kernel sigue válido', () => {
  const prod = path.resolve(__dirname, '..', '..', 'descriptors', 'intrale-platform.json');
  const res = d.loadDescriptor(prod);
  assert.equal(res.valid, true, `si esto es false se coló el binding de namespace (#6077): ${JSON.stringify(res.errors)}`);
  assert.equal(res.stage, null);
});

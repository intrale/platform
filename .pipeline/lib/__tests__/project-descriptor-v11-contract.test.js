'use strict';

// =============================================================================
// project-descriptor-v11-contract.test.js — Contrato del descriptor 1.1 (#6032)
//
// Cubre CA-1..CA-18 del corte: migración `1.0 → 1.1`, `inherit`/`shared`, las
// cuatro violaciones de política nuevas y la no-divergencia schema ↔ constante.
//
// Datos sintéticos `FAKE-*`. Ningún test imprime valores de credenciales: se
// afirman NOMBRES de scope, claves, índices y booleanos.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const d = require('../project-descriptor');
const m = require('../project-descriptor-migrations');
const scopes = require('../secret-scopes');
const bootstrap = require('../project-bootstrap');

const DESCRIPTOR_REAL = path.resolve(__dirname, '..', '..', 'descriptors', 'intrale-platform.json');
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'contracts', 'project.schema.json');

// Enum del vocabulario `1.0`. Es un HECHO HISTÓRICO congelado (lo que decía
// `project.schema.json:157` antes de este corte), no un derivado: por eso se
// escribe literal. Si se derivara del código nuevo, el test de mapeo total
// (CA-3) se volvería tautológico — pasaría por construcción.
const ENUM_1_0 = Object.freeze(['github', 'aws', 'gradle-android', 'telegram-hooks', 'providers']);

// Descriptor sintético mínimo, ya en `1.1`.
function desc11(overrides = {}) {
  return {
    schemaVersion: '1.1',
    identity: { projectId: 'fake-tenant', name: 'FAKE Tenant' },
    repositories: [{ id: 'main', url: 'https://github.com/fake-org/fake-repo', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/fake-org/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    providers: { order: ['anthropic'] },
    pullRequests: { policy: 'required' },
    credentials: [{ ref: '~/.claude/secrets/credentials.json#FAKE-ns', scopes: ['github'] }],
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['FAKE-signer'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

// El `ref` del fixture, para el control de fuga de CA-13.
const FAKE_REF = '~/.claude/secrets/credentials.json#FAKE-ns';

// -----------------------------------------------------------------------------
// Bloque A — Migración 1.0 → 1.1
// -----------------------------------------------------------------------------

test('CA-1: el descriptor REAL migra y valida sin editarse', () => {
  const bytesAntes = fs.readFileSync(DESCRIPTOR_REAL);
  const res = d.loadDescriptor(DESCRIPTOR_REAL);

  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.equal(res.descriptor.schemaVersion, '1.1');

  // El archivo NO se tocó: sigue declarando 1.0 en disco.
  const bytesDespues = fs.readFileSync(DESCRIPTOR_REAL);
  assert.ok(bytesAntes.equals(bytesDespues), 'loadDescriptor no puede escribir el descriptor');
  assert.equal(JSON.parse(bytesDespues.toString('utf8')).schemaVersion, '1.0');
});

test('CA-2: los scopes resultantes se afirman VALOR POR VALOR', () => {
  const res = d.loadDescriptor(DESCRIPTOR_REAL);
  const resultantes = res.descriptor.credentials[0].scopes;

  assert.deepEqual(resultantes, [
    'aws', 'github',
    'providers:anthropic', 'providers:cerebras', 'providers:google',
    'providers:moonshot', 'providers:nvidia', 'providers:openai',
  ]);

  // Aserciones NEGATIVAS explícitas (D-1 · SEC-7): el descarte no se traduce.
  assert.equal(resultantes.includes('telegram-hooks'), false, 'telegram-hooks no puede sobrevivir');
  assert.equal(resultantes.includes('telegram'), false, 'telegram-hooks NO se traduce a telegram');

  // `providers` se expande desde PROVIDER_VENDORS (almacenamiento), nunca desde
  // LIVE_PROVIDER_IDS (runtime): `moonshot` es la prueba — no está en runtime.
  assert.equal(resultantes.includes('providers:moonshot'), true);
  assert.equal(d.LIVE_PROVIDER_IDS.includes('moonshot'), false);
});

test('CA-3: mapeo TOTAL del enum 1.0 con exactamente TRES destinos', () => {
  for (const legacy of ENUM_1_0) {
    const enA = Object.prototype.hasOwnProperty.call(m.LEGACY_SCOPE_MAP, legacy);
    const enB = Object.prototype.hasOwnProperty.call(m.LEGACY_EJE_B_SCOPES, legacy);
    // Cada valor cae en UNO Y SÓLO UNO de los destinos (a) o (b).
    assert.equal(enA !== enB, true, `${legacy} debe caer en exactamente un destino (a xor b)`);

    const res = m.migrateScopes([legacy]);
    assert.equal(res.ok, true, `${legacy} no puede fallar: está en el enum 1.0`);
    if (enB) {
      assert.deepEqual(res.scopes, [], `${legacy} es destino (b): conjunto vacío`);
      assert.deepEqual(res.droppedScopes, [legacy], `${legacy} es destino (b): CON registro`);
    } else {
      assert.ok(res.scopes.length > 0, `${legacy} es destino (a): traduce/expande`);
      assert.deepEqual(res.droppedScopes, []);
    }
  }

  // Destino (c) — fallo duro, con el scope NOMBRADO en el mensaje.
  const malo = m.migrateScopes(['FAKE-inexistente']);
  assert.equal(malo.ok, false);
  assert.equal(malo.code, 'unknown_scope');
  assert.equal(malo.scope, 'FAKE-inexistente');
  assert.match(malo.error, /FAKE-inexistente/);
});

test('CA-3: el destino (a) NO se deriva de providers.order (dato en banda · SEC-7)', () => {
  // Un descriptor que declara UN solo provider de runtime igual expande TODOS
  // los vendors de almacenamiento: la expansión no mira el descriptor.
  const res = m.migrateDescriptor({
    schemaVersion: '1.0',
    providers: { order: ['anthropic'] },
    credentials: [{ ref: FAKE_REF, scopes: ['providers'] }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.descriptor.credentials[0].scopes,
    scopes.PROVIDER_VENDORS.map((v) => `providers:${v}`).sort(),
  );
});

test('CA-4: LEGACY_EJE_B_SCOPES es lista cerrada y cada miembro está justificado', () => {
  const miembros = Object.keys(m.LEGACY_EJE_B_SCOPES);
  assert.ok(miembros.length > 0);

  for (const miembro of miembros) {
    // (i) pertenece al enum 1.0.
    assert.ok(ENUM_1_0.includes(miembro), `${miembro} no pertenece al enum 1.0`);
    // (ii) es inerte en el eje A: no es un scope del vocabulario de credenciales.
    assert.equal(
      scopes.DESCRIPTOR_SCOPE_ENUM.includes(miembro), false,
      `${miembro} no puede ser un scope del eje A`,
    );
    // Justificación presente y sustantiva: si alguien agrega un miembro sin
    // explicar por qué cumple las tres condiciones, este test rompe.
    const just = m.LEGACY_EJE_B_SCOPES[miembro];
    assert.equal(typeof just, 'string', `${miembro} sin justificación`);
    assert.ok(just.length >= 80, `la justificación de ${miembro} es demasiado corta para justificar nada`);
    // (iii) nombra el canal/destino real que esta migración no toca.
    assert.match(just, /destino real/i, `la justificación de ${miembro} debe nombrar su destino real`);
  }
});

test('CA-5: el descarte NO es silencioso — viaja en droppedScopes y lo ve el operador', () => {
  const res = d.loadDescriptor(DESCRIPTOR_REAL);
  assert.deepEqual(res.droppedScopes, ['telegram-hooks']);

  // Y llega al render humano del arranque, no sólo al objeto.
  const human = bootstrap.renderHuman({
    ok: true,
    stage: 'dry-run',
    projectId: 'fake-tenant',
    dryRun: {
      droppedScopes: ['telegram-hooks'],
      admissionLabels: ['Ready'],
      providerOrder: ['anthropic'],
      pullRequestPolicy: 'required',
      resolvedRouting: [],
      signers: ['FAKE-signer'],
      gates: { gate0: 'enforce', gate2: 'enforce', visual: 'enforce' },
    },
  });
  assert.match(human, /scopes descartados en la migracion: telegram-hooks/);
  // La segunda mitad del mensaje: qué NO se perdió.
  assert.match(human, /no se traduce/i);
});

test('CA-6: 1.0 migra y 0.9 se rechaza — códigos y mensajes DISTINTOS, sin undefined', () => {
  const viejaConRuta = m.migrateDescriptor({ schemaVersion: '1.0' });
  const viejaSinRuta = m.migrateDescriptor({ schemaVersion: '0.9' });

  assert.equal(viejaConRuta.ok, true);
  assert.equal(viejaConRuta.to, '1.1');

  assert.equal(viejaSinRuta.ok, false);
  assert.equal(viejaSinRuta.code, 'unknown_version');

  // Éste es el defecto histórico: ambas daban `downgrade_rejected`.
  assert.notEqual(viejaSinRuta.code, viejaConRuta.code);
  assert.equal(typeof viejaSinRuta.error, 'string');
  assert.ok(viejaSinRuta.error.length > 0);
  assert.equal(viejaSinRuta.error.includes('undefined'), false);
});

test('CA-7: el gate anti-downgrade NO se debilita', () => {
  // (1) más nueva que el kernel.
  assert.equal(m.migrateDescriptor({ schemaVersion: '2.0' }).code, 'unsupported_newer');
  assert.equal(m.migrateDescriptor({ schemaVersion: '1.2' }).code, 'unsupported_newer');
  // (2) desconocida.
  assert.equal(m.migrateDescriptor({ schemaVersion: '0.1' }).code, 'unknown_version');
  // (3) toda versión vieja SIN step registrado se rechaza: no existe un camino
  //     "si no la entiendo, arranco igual".
  for (const v of ['0.9', '0.5', '1']) {
    assert.equal(m.migrateDescriptor({ schemaVersion: v }).ok, false, `${v} debe rechazarse`);
  }
  // (4) el bypass real: declarar una versión vieja para saltear campos nuevos
  //     obligatorios. El descriptor migrado se valida igual contra el schema.
  const sinAuthority = { schemaVersion: '1.0', identity: { projectId: 'fake-tenant', name: 'FAKE' } };
  const res = d.validateDescriptor(sinAuthority);
  assert.equal(res.valid, false);
  assert.equal(res.stage, 'schema');
});

test('CA-8: el step preserva `ref`, no inventa campos y no propaga excepciones', () => {
  const entrada = {
    schemaVersion: '1.0',
    credentials: [{ ref: FAKE_REF, scopes: ['github', 'telegram-hooks'] }],
  };
  const res = m.migrateDescriptor(entrada);
  assert.equal(res.ok, true);

  const item = res.descriptor.credentials[0];
  assert.equal(item.ref, FAKE_REF, 'ref DEBE preservarse');
  // No inventa campos: sólo `ref` y `scopes` (no sintetiza inherit/shared).
  assert.deepEqual(Object.keys(item).sort(), ['ref', 'scopes']);

  // Pureza: la entrada no se mutó.
  assert.equal(entrada.schemaVersion, '1.0');
  assert.deepEqual(entrada.credentials[0].scopes, ['github', 'telegram-hooks']);

  // Si el step falla, el resultado es `{ok:false}` — NO una excepción.
  let lanzo = false;
  let out;
  try {
    out = m.migrateDescriptor({ schemaVersion: '1.0', credentials: [{ ref: FAKE_REF, scopes: ['FAKE-roto'] }] });
  } catch { lanzo = true; }
  assert.equal(lanzo, false, 'migrateDescriptor no puede lanzar');
  assert.equal(out.ok, false);
  assert.ok(out.error && !out.error.includes('undefined'));
});

// -----------------------------------------------------------------------------
// Bloque B — Integridad y checksum
// -----------------------------------------------------------------------------

test('CA-9: el checksum se verifica contra los bytes AUTORADOS, no contra el derivado', () => {
  // Descriptor 1.0 CON checksum válido sobre sí mismo (lo que el operador firma).
  const base = desc11({ schemaVersion: '1.0', credentials: [{ ref: FAKE_REF, scopes: ['github', 'telegram-hooks'] }] });
  const checksum = d.computeChecksum(base);
  const conIntegridad = { ...base, integrity: { algorithm: 'sha256', checksum } };

  const res = d.validateDescriptor(conIntegridad, { expectedChecksum: checksum });
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.equal(res.descriptor.schemaVersion, '1.1');

  // El checksum del MIGRADO es necesariamente distinto: si se verificara contra
  // él, ningún descriptor firmado podría migrar jamás.
  assert.notEqual(d.computeChecksum(res.descriptor), checksum);

  // Y sigue siendo fail-closed ante un checksum que no corresponde.
  const malo = d.validateDescriptor(conIntegridad, { expectedChecksum: 'f'.repeat(64) });
  assert.equal(malo.valid, false);
  assert.equal(malo.stage, 'integrity');
});

test('CA-9: round-trip real — descriptor 1.0 firmado en disco carga y migra', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-desc-'));
  const p = path.join(dir, 'fake-tenant.json');
  try {
    const base = desc11({ schemaVersion: '1.0', credentials: [{ ref: FAKE_REF, scopes: ['github', 'telegram-hooks'] }] });
    const checksum = d.computeChecksum(base);
    fs.writeFileSync(p, JSON.stringify({ ...base, integrity: { algorithm: 'sha256', checksum } }, null, 2));

    const res = d.loadDescriptor(p);
    assert.equal(res.valid, true, JSON.stringify(res.errors));
    assert.equal(res.descriptor.schemaVersion, '1.1');
    assert.deepEqual(res.droppedScopes, ['telegram-hooks']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Bloque C — Política (stage: 'policy')
// -----------------------------------------------------------------------------

// Una fila por caso (CA-10): { nombre, credentials, keyword esperado }.
const CASOS_POLITICA = [
  {
    nombre: 'inherit con scope no heredable',
    keyword: 'inheritNotInheritable',
    credentials: [{ ref: FAKE_REF, scopes: ['aws'], inherit: ['aws'] }],
  },
  {
    nombre: 'scope duplicado entre entradas',
    keyword: 'duplicateScope',
    credentials: [
      { ref: FAKE_REF, scopes: ['github'] },
      { ref: '~/.claude/secrets/credentials.json#FAKE-otro', scopes: ['github'] },
    ],
  },
  {
    nombre: 'shared no es subconjunto de scopes',
    keyword: 'sharedNotSubset',
    credentials: [{ ref: FAKE_REF, scopes: ['github'], shared: ['telegram'] }],
  },
  {
    nombre: 'inherit x shared',
    keyword: 'inheritedNotShareable',
    credentials: [{ ref: FAKE_REF, scopes: ['telegram'], inherit: ['telegram'], shared: ['telegram'] }],
  },
];

for (const caso of CASOS_POLITICA) {
  test(`CA-10: ${caso.nombre} ⇒ violación de política con keyword propio`, () => {
    const res = d.validateDescriptor(desc11({ credentials: caso.credentials }));
    assert.equal(res.valid, false, 'debe rechazarse');
    assert.equal(res.stage, 'policy');
    const hit = res.errors.find((e) => e.keyword === caso.keyword);
    assert.ok(hit, `falta el hit ${caso.keyword}; llegaron: ${res.errors.map((e) => e.keyword).join(', ')}`);
    // Ningún `error: undefined`: el render humano lee `detail`.
    assert.equal(typeof hit.detail, 'string');
    assert.ok(hit.detail.length > 0);
    assert.equal(hit.detail.includes('undefined'), false);
  });
}

test('CA-10: los cuatro mensajes son DISTINGUIBLES entre sí', () => {
  const detalles = CASOS_POLITICA.map((caso) => {
    const hits = d.collectCredentialPolicyViolations(desc11({ credentials: caso.credentials }));
    const hit = hits.find((h) => h.keyword === caso.keyword);
    assert.ok(hit, `falta ${caso.keyword}`);
    return hit.detail;
  });
  assert.equal(new Set(detalles).size, 4, 'los cuatro detail deben ser distintos');
  assert.equal(new Set(CASOS_POLITICA.map((c) => c.keyword)).size, 4, 'los cuatro keyword deben ser distintos');
});

test('CA-10.2: el duplicado nombra AMBOS índices (SEC-6)', () => {
  const hits = d.collectCredentialPolicyViolations(desc11({
    credentials: [
      { ref: FAKE_REF, scopes: ['github'] },
      { ref: '~/.claude/secrets/credentials.json#FAKE-otro', scopes: ['github'] },
    ],
  }));
  const hit = hits.find((h) => h.keyword === 'duplicateScope');
  assert.match(hit.detail, /credentials\[0\]/);
  assert.match(hit.detail, /credentials\[1\]/);
  assert.match(hit.detail, /github/);
});

test('CA-11: la heredabilidad se LEE de secret-scopes.js, no se copia', () => {
  // La partición cubre el vocabulario y no se solapa (contrato de la parte 1).
  const union = [...scopes.NON_INHERITABLE_SCOPES, ...scopes.INHERITABLE_SCOPES].sort();
  assert.deepEqual(union, [...scopes.SECRET_SCOPES].sort());

  // Todo scope NO heredable es rechazado en `inherit`, sin excepción y sin
  // deny-list local: se recorre la lista del módulo hoja.
  for (const scope of scopes.NON_INHERITABLE_SCOPES) {
    const hits = d.collectCredentialPolicyViolations(desc11({
      credentials: [{ ref: FAKE_REF, scopes: [scope], inherit: [scope] }],
    }));
    assert.ok(
      hits.some((h) => h.keyword === 'inheritNotInheritable' && h.detail.includes(scope)),
      `${scope} debe rechazarse en inherit`,
    );
  }

  // Y todo scope heredable pasa (la regla no es "rechazar todo").
  for (const scope of scopes.INHERITABLE_SCOPES) {
    if (scope === 'providers') continue; // raíz sin vendor: no está en el enum del descriptor.
    const hits = d.collectCredentialPolicyViolations(desc11({
      credentials: [{ ref: FAKE_REF, scopes: [scope], inherit: [scope] }],
    }));
    assert.equal(
      hits.some((h) => h.keyword === 'inheritNotInheritable'), false,
      `${scope} es heredable y no debe rechazarse`,
    );
  }
});

test('CA-11: la raíz decide — providers:<vendor> hereda, aws no', () => {
  const heredable = d.collectCredentialPolicyViolations(desc11({
    credentials: [{ ref: FAKE_REF, scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
  }));
  assert.equal(heredable.length, 0);
});

test('CA-12: shared ausente / null / [] / malformado ⇒ tier host (conjunto vacío)', () => {
  for (const shared of [undefined, null, [], 'no-soy-lista', 42, {}]) {
    const credential = { ref: FAKE_REF, scopes: ['github'] };
    if (shared !== undefined) credential.shared = shared;
    const hits = d.collectCredentialPolicyViolations(desc11({ credentials: [credential] }));
    // Nunca se sintetiza contenido: una forma inesperada colapsa a vacío y por
    // lo tanto no puede generar hits de shared.
    assert.equal(
      hits.some((h) => h.keyword === 'sharedNotSubset' || h.keyword === 'inheritedNotShareable'), false,
      `shared=${JSON.stringify(shared)} debe colapsar a vacío`,
    );
  }
});

test('CA-12: ningún paso de migración sintetiza un shared no vacío', () => {
  const res = m.migrateDescriptor({
    schemaVersion: '1.0',
    credentials: [{ ref: FAKE_REF, scopes: ['github', 'aws', 'providers', 'telegram-hooks'] }],
  });
  assert.equal(res.ok, true);
  for (const item of res.descriptor.credentials) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'shared'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'inherit'), false);
  }
});

test('CA-13: los detail nombran scope + índice y NUNCA filtran el ref (SEC-9)', () => {
  for (const caso of CASOS_POLITICA) {
    const hits = d.collectCredentialPolicyViolations(desc11({ credentials: caso.credentials }));
    const hit = hits.find((h) => h.keyword === caso.keyword);
    // Ruta lógica con índice.
    assert.match(hit.path, /^credentials\[\d+\]\.(scopes|inherit|shared)$/);
    assert.match(hit.detail, /credentials\[\d+\]/);
    // Ningún fragmento del ref ni del path del vault.
    assert.equal(hit.detail.includes(FAKE_REF), false, `${caso.keyword} filtra el ref`);
    assert.equal(hit.detail.includes('.claude'), false, `${caso.keyword} filtra path del store`);
    assert.equal(hit.detail.includes('FAKE-ns'), false, `${caso.keyword} filtra el namespace`);
  }
});

test('UX-G1: los hits nuevos se RENDERIZAN sin undefined (el defecto vive en el render)', () => {
  for (const caso of CASOS_POLITICA) {
    const res = d.validateDescriptor(desc11({ credentials: caso.credentials }));
    const human = bootstrap.renderHuman({ ok: false, stage: res.stage, errors: res.errors });
    assert.equal(human.includes('undefined'), false, `${caso.keyword} renderiza undefined`);
    for (const linea of human.split('\n')) {
      assert.equal(linea.trimEnd().endsWith(':'), false, `línea sin detalle: ${linea}`);
    }
  }
});

// -----------------------------------------------------------------------------
// Bloque D — Schema y reservas
// -----------------------------------------------------------------------------

const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const itemCred = schemaJson.properties.credentials.items;

test('CA-14: no-divergencia BIDIRECCIONAL schema ↔ DESCRIPTOR_SCOPE_ENUM', () => {
  const delSchema = itemCred.properties.scopes.items.enum;
  const laConstante = scopes.DESCRIPTOR_SCOPE_ENUM;

  // Ida: todo valor del schema está en la constante.
  for (const v of delSchema) assert.ok(laConstante.includes(v), `${v} está en el schema pero no en la constante`);
  // Vuelta: todo valor de la constante está en el schema.
  for (const v of laConstante) assert.ok(delSchema.includes(v), `${v} está en la constante pero no en el schema`);
  // Y son el mismo conjunto, sin duplicados.
  assert.deepEqual([...delSchema].sort(), [...laConstante].sort());
  assert.equal(new Set(delSchema).size, delSchema.length);
});

test('CA-14: inherit y shared tienen la MISMA forma que scopes', () => {
  for (const prop of ['inherit', 'shared']) {
    const p = itemCred.properties[prop];
    assert.ok(p, `falta la propiedad ${prop}`);
    assert.equal(p.type, 'array');
    assert.equal(p.uniqueItems, true);
    assert.deepEqual([...p.items.enum].sort(), [...scopes.DESCRIPTOR_SCOPE_ENUM].sort());
  }
});

test('CA-14: `ref`, `required` y `additionalProperties` NO se tocan', () => {
  assert.deepEqual(itemCred.required, ['ref', 'scopes']);
  assert.equal(itemCred.additionalProperties, false);
  assert.ok(itemCred.properties.ref, 'ref se CONSERVA');
  // El ancla de `ref` es semántica y vive en #6031 — el pattern no se endurece acá.
  assert.equal(itemCred.properties.ref.pattern, '^~?[A-Za-z0-9._/-]+#[A-Za-z0-9._:-]+$');
});

test('CA-14: schemaVersion valida el descriptor POST-migración', () => {
  assert.equal(schemaJson.properties.schemaVersion.pattern, '^1\\.1$');
  assert.equal(m.CURRENT_SCHEMA_VERSION, '1.1');
});

test('CA-14: `shared` está declarado, así que no aparece "de la nada"', () => {
  // Con additionalProperties:false, una propiedad no declarada se rechaza.
  const res = d.validateDescriptor(desc11({
    credentials: [{ ref: FAKE_REF, scopes: ['github'], FAKEnoDeclarado: ['github'] }],
  }));
  assert.equal(res.valid, false);
  assert.equal(res.stage, 'schema');
  assert.ok(res.errors.some((e) => e.keyword === 'additionalProperties'));

  // Y una entrada con shared/inherit BIEN formados pasa el schema.
  const ok = d.validateDescriptor(desc11({
    credentials: [{ ref: FAKE_REF, scopes: ['telegram', 'github'], inherit: ['telegram'], shared: ['github'] }],
  }));
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test('CA-15: RESERVED_PROJECT_IDS se construye por UNIÓN con SECRET_SCOPES', () => {
  // No-divergencia: si el vocabulario crece y la reserva no, esto rompe.
  for (const scope of scopes.SECRET_SCOPES) {
    assert.equal(d.isReservedProjectId(scope), true, `el scope ${scope} debe estar reservado como projectId`);
  }
  for (const clave of ['namespaces', 'constructor', 'prototype', 'toString', '__proto__']) {
    assert.equal(d.isReservedProjectId(clave), true, `${clave} debe estar reservado`);
  }
  // Los reservados históricos siguen.
  assert.equal(d.isReservedProjectId('intrale-platform'), true);
  assert.equal(d.isReservedProjectId('kernel-control-plane'), true);
  // Y un id normal NO queda reservado por accidente.
  assert.equal(d.isReservedProjectId('fake-tenant'), false);
});

test('CA-16: config.yaml — sólo comentario; las claves quedan intactas', () => {
  const yaml = require('js-yaml');
  const cfg = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', '..', 'config.yaml'), 'utf8'));
  assert.equal(cfg.vault.enabled, false);
  assert.equal(cfg.vault.projectId, 'intrale');
  assert.equal(cfg.vault.hostId, '');
  assert.equal(cfg.vault.prefix, '/intrale');

  // El comentario deja explícito que un descriptor no redefine la raíz (SEC-10).
  const crudo = fs.readFileSync(path.resolve(__dirname, '..', '..', 'config.yaml'), 'utf8');
  const bloque = crudo.slice(crudo.indexOf('\nvault:'), crudo.indexOf('cache_ttl_seconds'));
  assert.match(bloque, /DEFAULT DEL KERNEL/);
  assert.match(bloque, /no puede redefinir la ra[ií]z|NO puede redefinir/i);
});

// -----------------------------------------------------------------------------
// Bloque F — Persistencia (CA-18)
// -----------------------------------------------------------------------------

test('CA-18: transitionStatus NO persiste la migración ni el descarte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-desc-'));
  const p = path.join(dir, 'fake-tenant.json');
  try {
    // Descriptor REAL-like: 1.0 en disco, con telegram-hooks y status onboarding.
    const enDisco = desc11({
      schemaVersion: '1.0',
      status: 'onboarding',
      credentials: [{ ref: FAKE_REF, scopes: ['github', 'telegram-hooks'] }],
    });
    fs.writeFileSync(p, JSON.stringify(enDisco, null, 2));

    // Precondición: en memoria el descriptor SÍ diverge del de disco.
    const cargado = d.loadDescriptor(p);
    assert.equal(cargado.descriptor.schemaVersion, '1.1');
    assert.equal(cargado.onDisk.schemaVersion, '1.0');

    const res = d.transitionStatus({ descriptorPath: p, from: 'onboarding', to: 'active' });
    assert.equal(res.ok, true, JSON.stringify(res));

    const despues = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Lo único que cambió es `status`.
    assert.equal(despues.status, 'active');
    // La migración NO se persistió.
    assert.equal(despues.schemaVersion, '1.0', 'la migración no puede persistirse');
    assert.ok(
      despues.credentials[0].scopes.includes('telegram-hooks'),
      'el descarte no puede persistirse por la puerta de atrás',
    );
    assert.equal(despues.credentials[0].ref, FAKE_REF);

    // El checksum sigue verificando contra los bytes autorados: recarga OK.
    const recarga = d.loadDescriptor(p);
    assert.equal(recarga.valid, true, JSON.stringify(recarga.errors));
    assert.equal(recarga.onDisk.schemaVersion, '1.0');
    assert.equal(recarga.descriptor.schemaVersion, '1.1');
    assert.deepEqual(recarga.droppedScopes, ['telegram-hooks']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-18: sin los bytes de disco, la escritura se ABORTA (fail-closed)', () => {
  const ops = [];
  const spyFs = {
    writeFileSync(fp) { ops.push(String(fp)); },
    renameSync() { ops.push('rename'); },
    unlinkSync() {},
  };
  // Loader que NO expone `onDisk` — no se puede probar qué hay en disco.
  const res = d.transitionStatus(
    { descriptorPath: '/tmp/fake/x.json', from: 'onboarding', to: 'active' },
    {
      fsImpl: spyFs,
      loadDescriptorImpl: () => ({ valid: true, descriptor: desc11({ status: 'onboarding' }) }),
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'write');
  assert.deepEqual(ops, [], 'no puede escribirse NADA sin conocer el estado de disco');
});

// -----------------------------------------------------------------------------
// Bloque E — Sin regresión
// -----------------------------------------------------------------------------

test('CA-17: el descriptor real sigue derivando lo mismo para el kernel', () => {
  const res = d.loadDescriptor(DESCRIPTOR_REAL);
  assert.equal(res.valid, true);
  assert.deepEqual(d.deriveAdmissionLabels(res.descriptor), ['needs-definition', 'Ready']);
  assert.equal(d.derivePullRequestPolicy(res.descriptor), 'required');
  assert.deepEqual(d.deriveProviderOrder(res.descriptor), d.LIVE_PROVIDER_IDS);
  assert.equal(res.descriptor.identity.projectId, 'intrale-platform');
});

'use strict';

// Tests del kernel-resolver (cutover de wiring · Ola 9.1 · #4664).
// Verifican que el wiring del arranque apunta al kernel migrado bajo consumo
// habilitado y cae al motor local en coexistencia, sin cambiar comportamiento
// por default y sin require() de paths arbitrarios.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const resolver = require('../lib/kernel-resolver');

const PIPELINE_DIR = path.resolve(__dirname, '..');

// Utilidad: correr un caso con una var de entorno seteada y restaurarla.
function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('por default (coexistencia) resuelve pulpo al motor local de .pipeline/', () => {
  withEnv('PIPELINE_CONSUME_KERNEL', undefined, () => {
    const r = resolver.resolveEntry('pulpo');
    assert.strictEqual(r.source, 'local');
    assert.strictEqual(r.path, path.join(PIPELINE_DIR, 'pulpo.js'));
    assert.ok(fs.existsSync(r.path), 'el motor local debe existir (comportamiento idéntico)');
  });
});

test('por default resuelve dashboard al motor local de .pipeline/', () => {
  withEnv('PIPELINE_CONSUME_KERNEL', undefined, () => {
    const r = resolver.resolveEntry('dashboard');
    assert.strictEqual(r.source, 'local');
    assert.strictEqual(r.path, path.join(PIPELINE_DIR, 'dashboard.js'));
    assert.ok(fs.existsSync(r.path));
  });
});

test('rechaza entrypoints fuera de la allowlist (no require de path arbitrario)', () => {
  assert.throws(() => resolver.resolveEntry('../../etc/passwd'), /Entrypoint de kernel desconocido/);
  assert.throws(() => resolver.resolveEntry('servicio-telegram'), /Entrypoint de kernel desconocido/);
});

test('isConsumeEnabled respeta el override por variable de entorno', () => {
  withEnv('PIPELINE_CONSUME_KERNEL', '1', () => {
    assert.strictEqual(resolver.isConsumeEnabled(), true);
  });
  withEnv('PIPELINE_CONSUME_KERNEL', '0', () => {
    // 0 no habilita; el manifiesto del producto declara consume:false.
    assert.strictEqual(resolver.isConsumeEnabled(), false);
  });
});

test('el manifiesto del producto declara consume:false (coexistencia 9.1)', () => {
  const manifest = resolver.readManifest();
  assert.ok(manifest, 'pipeline.config.json debe existir y parsear');
  assert.strictEqual(manifest.kernel.consume, false);
  assert.strictEqual(manifest.kernel.package, resolver.KERNEL_PACKAGE);
  // #5065 — bump 0.1.0 -> 0.2.0 al incorporar los bloques del contrato del
  // adaptador (repo/branch/qaLabels/commands/workspace/pr). Sigue siendo major 0,
  // así que SUPPORTED_CONTRACT_MAJOR no cambia.
  assert.strictEqual(manifest.contractVersion, '0.2.0');
});

test('assertKernelCompatible acepta el major soportado y rechaza uno incompatible', () => {
  assert.strictEqual(
    resolver.assertKernelCompatible({ json: { version: '0.1.0' } }),
    '0.1.0'
  );
  assert.throws(
    () => resolver.assertKernelCompatible({ json: { version: '1.0.0' } }),
    /contractVersion incompatible/
  );
});

test('con consumo habilitado y kernel ausente, falla closed (no degrada en silencio)', () => {
  withEnv('PIPELINE_CONSUME_KERNEL', '1', () => {
    // El paquete no está instalado en este entorno de test.
    if (resolver.isKernelInstalled()) return; // salta si por algún motivo está
    assert.throws(() => resolver.resolveEntry('pulpo'), /no está instalado/);
  });
});

// ── Supply-chain: pin exacto + firma verificada (CA-C2/CA-C3 · #4695) ──────────

// Manifiesto de firma bien formado (mismo shape que pipeline.config.json.kernel).
function manifestConSignature(version, overrides = {}) {
  return {
    kernel: {
      package: resolver.KERNEL_PACKAGE,
      version,
      signature: {
        mechanism: 'sigstore-cosign-oidc',
        tagPattern: 'v{version}',
        certificateIdentityRegexp: '^https://github\\.com/Intrale/kernel/.*$',
        certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
        ...overrides,
      },
    },
  };
}
const pkgFake = { json: { version: '0.1.0' } };
const verifyOk = () => true;
const verifyFail = () => false;

// (a) Rechazo de bump sin firma verificada → fail-closed accionable.
test('(a) rechaza el bump si la firma del release no verifica (fail-closed)', () => {
  const manifest = manifestConSignature('0.1.0');
  assert.throws(
    () => resolver.assertReleaseSignature(pkgFake, manifest, verifyFail),
    /la firma del release no verifica/
  );
});

test('(a) rechaza el bump si el verificador lanza excepción (fail-closed ante error)', () => {
  const manifest = manifestConSignature('0.1.0');
  const verifyThrows = () => { throw new Error('cosign no está instalado'); };
  assert.throws(
    () => resolver.assertReleaseSignature(pkgFake, manifest, verifyThrows),
    /la firma del release no verifica/
  );
});

test('(a) rechaza el bump si falta la configuración de firma (identidad/emisor)', () => {
  const sinSig = { kernel: { package: resolver.KERNEL_PACKAGE, version: '0.1.0' } };
  assert.throws(
    () => resolver.assertReleaseSignature(pkgFake, sinSig, verifyOk),
    /falta la configuración de firma/
  );
});

// (b) Rechazo de rango semver → sólo versión exacta aceptada.
test('(b) rechaza rangos semver y comodines; sólo acepta versión exacta', () => {
  for (const rango of ['^1.2.3', '~1.2.3', '1.x', '1.2', 'latest', '1.2.3-beta', '']) {
    assert.throws(
      () => resolver.assertReleaseSignature(pkgFake, manifestConSignature(rango), verifyOk),
      /no es un pin exacto/,
      `debería rechazar "${rango}"`
    );
  }
});

// (c) Fail-closed con paquete habilitado pero ausente/incompatible.
test('(c) con consumo habilitado y kernel incompatible (major distinto), falla closed', () => {
  assert.throws(
    () => resolver.assertKernelCompatible({ json: { version: '1.0.0' } }),
    /contractVersion incompatible/
  );
});

// (d) Happy-path: versión exacta + firma verificada → devuelve la versión.
test('(d) happy-path: versión exacta + firma verificada devuelve la versión', () => {
  const manifest = manifestConSignature('1.4.2');
  assert.strictEqual(
    resolver.assertReleaseSignature(pkgFake, manifest, verifyOk),
    '1.4.2'
  );
});

// A03: el tag a verificar sale SIEMPRE del manifiesto (version + tagPattern),
// nunca de datos en banda. Verifica el mapeo version→tag.
test('resolveKernelTag mapea version→tag desde el manifiesto (invariante A03)', () => {
  assert.strictEqual(resolver.resolveKernelTag(manifestConSignature('1.4.2')), 'v1.4.2');
  assert.strictEqual(
    resolver.resolveKernelTag(manifestConSignature('2.0.0', { tagPattern: 'release-{version}' })),
    'release-2.0.0'
  );
});

// El manifiesto real del producto declara el bloque de firma cosign OIDC (CA-C2).
test('pipeline.config.json declara la firma cosign OIDC y pin exacto (CA-C2/CA-C3)', () => {
  const manifest = resolver.readManifest();
  assert.strictEqual(manifest.kernel.signature.mechanism, 'sigstore-cosign-oidc');
  assert.strictEqual(manifest.kernel.signature.certificateOidcIssuer, 'https://token.actions.githubusercontent.com');
  assert.match(manifest.kernel.version, resolver.EXACT_SEMVER);
  // consume:false permanece intacto (coexistencia; freeze del motor local es 9.5).
  assert.strictEqual(manifest.kernel.consume, false);
});

// El verificador real es fail-closed sin material de firma (blob/sig/cert).
test('verifyTagSignatureCosign devuelve false sin material de firma (fail-closed)', () => {
  const sig = { certificateIdentityRegexp: 'x', certificateOidcIssuer: 'y' };
  assert.strictEqual(resolver.verifyTagSignatureCosign('v1.4.2', sig), false);
});

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
  assert.strictEqual(manifest.contractVersion, '0.1.0');
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

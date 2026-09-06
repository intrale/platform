'use strict';

// =============================================================================
// kernel-drill-seed.test.js — Sonda positiva del ensayo de rollback (#5209).
//
// Qué protege, en una línea cada uno:
//   - La sonda que escribe el CLI es ACEPTADA por el store real (schema, patrones
//     del envelope, append-only). Si no lo fuera, el ensayo dejaría en la tabla de
//     no-repudio un ítem corrupto que NADIE puede borrar.
//   - `--apply` sin `--i-understand-append-only` NO escribe, y lo dice con causa.
//   - El CLI no reimplementa el cableado del driver: lo importa de
//     `kernel-reconcile.js`. Un cableado propio podría sembrar en un lugar que la
//     reconciliación después no lee → `conjunto_vacio` con la tabla llena.
//   - El export de la reconciliación LEVANTA la sonda (extremo a extremo, con el
//     driver in-memory): sembrar y no poder exportar es el falso negativo.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createInMemoryDynamoDriver } = require('../provisioner-infra');
const { createKernelStore } = require('../kernel-store');
const { exportAppendOnly } = require('../kernel-append-only-reconcile');

const seed = require('../../kernel-drill-seed');

const CTX = 'acme-store';
const SEED_PATH = path.resolve(__dirname, '..', '..', 'kernel-drill-seed.js');

function storeInMemory() {
  return createKernelStore({
    driver: createInMemoryDynamoDriver(),
    contextProjectId: CTX,
    config: { kernel: { tableName: 'kernel-store-local' } },
  });
}

// -----------------------------------------------------------------------------
// La sonda es un ítem VÁLIDO para el store real
// -----------------------------------------------------------------------------

test('la firma de la sonda tiene checksum SHA-256 y es determinística dado (projectId, at, note)', () => {
  const a = seed.buildProbe({ projectId: CTX, at: '2026-09-06T00:00:00.000Z', note: null });
  const b = seed.buildProbe({ projectId: CTX, at: '2026-09-06T00:00:00.000Z', note: null });
  assert.match(a.signature.checksum, /^[a-f0-9]{64}$/, 'el schema exige exactamente 64 hex');
  assert.equal(a.signature.checksum, b.signature.checksum, 'mismo input ⇒ mismo checksum: el ítem es verificable a posteriori');

  const c = seed.buildProbe({ projectId: CTX, at: '2026-09-06T00:00:01.000Z', note: null });
  assert.notEqual(a.signature.checksum, c.signature.checksum, 'otro instante ⇒ otro checksum');
});

test('el store REAL acepta la firma y el audit de la sonda (no un ítem corrupto que no se puede borrar)', async () => {
  const store = storeInMemory();
  const probe = seed.buildProbe({ projectId: CTX, at: new Date().toISOString(), note: 'ensayo' });

  const sig = await store.putSignature(probe.signature);
  assert.equal(sig.ok, true);
  assert.match(sig.sk, /^signature#/);

  const aud = await store.appendAuditEntry(probe.audit);
  assert.equal(aud.ok, true);
  assert.match(aud.sk, /^audit#/);
});

test('la sonda sembrada la LEVANTA el export de la reconciliación (extremo a extremo)', async () => {
  const store = storeInMemory();
  const probe = seed.buildProbe({ projectId: CTX, at: new Date().toISOString(), note: null });
  await store.putSignature(probe.signature);
  await store.appendAuditEntry(probe.audit);

  const exp = await exportAppendOnly(store, { pageSize: 10 });
  assert.equal(exp.ok, true, `el export debe cerrar OK: ${exp.error || ''}`);
  assert.equal(exp.counts.signature, 1, 'la firma sembrada tiene que aparecer');
  assert.equal(exp.counts.audit, 1, 'el audit sembrado tiene que aparecer');
  assert.equal(exp.counts.total, 2, 'conjunto NO vacío: es la razón de ser de la sonda');
});

test('el audit de la sonda no dispara el guard de prompt-injection del store', async () => {
  const store = storeInMemory();
  const probe = seed.buildProbe({ projectId: CTX, at: new Date().toISOString(), note: null });
  await assert.doesNotReject(() => store.appendAuditEntry(probe.audit));
});

// -----------------------------------------------------------------------------
// Guard de irreversibilidad
// -----------------------------------------------------------------------------

test('parseArgs no da por entendida la irreversibilidad salvo con el flag exacto', () => {
  assert.equal(seed.parseArgs(['--apply']).understood, false);
  assert.equal(seed.parseArgs(['--apply', '--i-understand']).understood, false, 'un prefijo no alcanza');
  assert.equal(seed.parseArgs(['--apply', '--i-understand-append-only']).understood, true);
  assert.equal(seed.parseArgs([]).apply, false, 'el default es dry-run');
});

test('`--apply` sin `--i-understand-append-only` no escribe y explica por qué', () => {
  const run = spawnSync(process.execPath, [SEED_PATH, '--apply'], { encoding: 'utf8', timeout: 30_000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.notEqual(run.status, 0, 'debe salir distinto de 0');
  assert.match(out, /--i-understand-append-only/, 'nombra el flag que falta');
  assert.match(out, /Qué pasó:/, 'causa');
  assert.match(out, /Qué hacer ahora:/, 'acción siguiente');
  assert.match(out, /La trampa:/, 'la trampa');
  assert.match(out, /DeleteItem/, 'dice POR QUÉ es irreversible, no sólo que lo es');
});

test('el guard corta ANTES de construir el store (no toca AWS para negarse)', () => {
  // Sin credenciales ni perfil válido: si el CLI construyera el driver antes de
  // evaluar el guard, el mensaje sería un error de credenciales y el operador
  // nunca leería la advertencia de irreversibilidad.
  const run = spawnSync(process.execPath, [SEED_PATH, '--apply', '--profile', 'perfil-que-no-existe'], {
    encoding: 'utf8', timeout: 30_000,
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /--i-understand-append-only/, 'gana el guard, no el error de credenciales');
});

// -----------------------------------------------------------------------------
// Acople deliberado con la reconciliación
// -----------------------------------------------------------------------------

test('el seeder REUSA el cableado de kernel-reconcile.js en vez de armar su propio driver', () => {
  const src = fs.readFileSync(SEED_PATH, 'utf8');
  assert.match(src, /require\('\.\/kernel-reconcile'\)/, 'debe importar el cableado, no reimplementarlo');
  assert.equal(
    src.includes('createAwsCliDynamoDriver'),
    false,
    'un driver propio podría sembrar donde la reconciliación no lee: `conjunto_vacio` con la tabla llena',
  );
  assert.equal(
    src.includes("require('./lib/kernel-store')"),
    false,
    'el store lo construye `buildStore` de kernel-reconcile.js — una sola gramática de cableado',
  );
});

test('kernel-reconcile.js exporta buildStore con el projectId resuelto', () => {
  const recon = require('../../kernel-reconcile');
  assert.equal(typeof recon.buildStore, 'function', 'sin este export el seeder no compila');
});

// -----------------------------------------------------------------------------
// Higiene del texto que ve el operador
// -----------------------------------------------------------------------------

test('el dry-run muestra el ítem completo y deja claro que no escribió nada', () => {
  const probe = seed.buildProbe({ projectId: CTX, at: '2026-09-06T00:00:00.000Z', note: null });
  const out = seed.renderDryRun(probe, CTX);
  assert.match(out, /dry-run/i);
  assert.match(out, new RegExp(seed.SIGNER));
  assert.match(out, new RegExp(seed.AUDIT_ACTION.replace(/\./g, '\\.')));
  assert.match(out, /Nada se escribió/);
  assert.match(out, /--apply --i-understand-append-only/, 'dice cómo escribir de verdad');
});

test('la sonda es auto-descriptiva: quien la encuentre en la tabla sabe qué es', () => {
  const probe = seed.buildProbe({ projectId: CTX, at: '2026-09-06T00:00:00.000Z', note: null });
  assert.match(probe.signature.target, /5209/, 'la firma nombra el issue del ensayo');
  assert.match(probe.audit.detail, /ensayo de rollback/i);
  assert.match(probe.audit.action, /drill/, 'el action distingue la sonda de una firma de producción');
});

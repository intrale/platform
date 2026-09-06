'use strict';

// =============================================================================
// kernel-append-only-reconcile.test.js — Reconciliación DynamoDB → filesystem
// de `signature#`/`audit#` (#5209, split de #5126).
//
// Cobertura mapeada a los criterios de aceptación:
//   CA-1  firma y audit generados en la ventana durable quedan reconciliados
//         ANTES de apagar el flag.
//   CA-2  conteos y hashes demuestran que ningún dato quedó sólo en DynamoDB.
//   CA-3  el pipeline reinicia y completa una fase desde filesystem.
//   CA-4  el tiempo real de recuperación (R8) queda registrado.
//   CA-5  fallas parciales: export vacío/incompleto, manifiesto alterado,
//         conflicto de id, import interrumpido, traversal/symlink, permisos.
//
// El invariante que atraviesa todo el archivo: NINGÚN camino de error puede
// terminar con `kernel.durable` apagado.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKernelStore } = require('../kernel-store');
const { sha256Canonical } = require('../kernel-store-migrate');
const R = require('../kernel-append-only-reconcile');

const CTX = 'acme-store';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-5209-'));
}

/** Store durable con reloj determinístico y una sonda no vacía por default. */
async function storeConDatos({ signatures = 2, audits = 2, ctx = CTX } = {}) {
  let t = 1700000000000;
  const store = createKernelStore({ contextProjectId: ctx, now: () => (t += 1) });
  for (let i = 0; i < signatures; i += 1) {
    await store.putSignature({ signer: 'leitolarreta', target: `pr-${i}`, checksum: 'a'.repeat(64) });
  }
  for (let i = 0; i < audits; i += 1) {
    await store.appendAuditEntry({ action: 'gate2.sign', actor: 'leitolarreta', detail: `firma ${i}` });
  }
  return store;
}

/** Argumentos base de una reconciliación con la ventana ya congelada. */
function args(store, root, extra = {}) {
  return Object.assign({
    store,
    reconcileDir: path.join(root, 'kernel-reconcile'),
    allowedRoot: root,
    frozen: true,
    now: 1700000000000,
  }, extra);
}

function leerJsonl(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** Callbacks operativos del ensayo, con un flag `durable` observable. */
function drillOps() {
  const estado = { durable: true, reinicios: 0, fases: 0, r8: null };
  return {
    estado,
    disableDurable: async () => { estado.durable = false; return { ok: true }; },
    restart: async () => { estado.reinicios += 1; return { ok: true }; },
    // La fase sólo puede completarse desde filesystem: si el flag sigue en true,
    // no estaríamos probando el rollback.
    completePhase: async () => ({ ok: estado.durable === false }),
    recordR8: async ({ r8Ms }) => { estado.r8 = r8Ms; },
  };
}

// =============================================================================
// CA-1 / CA-2 — Reconciliación no vacía, manifiesto y paridad
// =============================================================================

test('CA-1: la reconciliación exporta firmas y audit reales y los reintegra al filesystem', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 3, audits: 2 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.state, 'compare');
  assert.deepEqual(res.counts, { total: 5, signature: 3, audit: 2 });

  const sigs = leerJsonl(res.reconcileDir, 'signatures.jsonl');
  const auds = leerJsonl(res.reconcileDir, 'audit.jsonl');
  assert.equal(sigs.length, 3);
  assert.equal(auds.length, 2);
  // El conjunto reintegrado NO puede estar vacío: es la sonda positiva del ensayo.
  assert.ok(sigs.every((r) => r.type === 'signature' && r.id && r.hash));
});

test('CA-2: el manifiesto declara conteos y hashes que cierran contra lo escrito', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 4, audits: 3 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.ok, true, res.error);

  const manifest = JSON.parse(fs.readFileSync(path.join(res.reconcileDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.signature, 4);
  assert.equal(manifest.counts.audit, 3);
  assert.equal(manifest.counts.total, 7);
  assert.equal(manifest.entries.length, 7);
  assert.equal(manifest.projectId, CTX);

  // El manifiesto valida contra los registros releídos del disco.
  const releidos = R.readFilesystemRecords(res.reconcileDir);
  assert.equal(releidos.ok, true);
  assert.deepEqual(R.validateReconcileManifest(manifest, releidos.records), { ok: true });
});

test('CA-2: ningún registro de DynamoDB queda únicamente en DynamoDB (paridad por id y hash)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 5, audits: 4 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.ok, true, res.error);

  const enDynamo = await R.exportAppendOnly(store);
  const enDisco = R.readFilesystemRecords(res.reconcileDir);
  const paridad = R.compareParity(enDynamo.records, enDisco.records);

  assert.equal(paridad.ok, true);
  assert.deepEqual(paridad.faltantes, []);
  assert.deepEqual(paridad.hashDistinto, []);
  assert.deepEqual(paridad.expectedCounts, paridad.actualCounts);
});

test('la paginación no pierde registros: 25 firmas con páginas de 2 se exportan enteras', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 25, audits: 11 });

  const res = await R.reconcileDurableToFilesystem(args(store, root, { pageSize: 2 }));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.counts.signature, 25);
  assert.equal(res.counts.audit, 11);
});

// =============================================================================
// Idempotencia y conflictos
// =============================================================================

test('idempotencia: correr la reconciliación dos veces no duplica ni un registro', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 3, audits: 2 });

  const uno = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(uno.ok, true, uno.error);
  assert.equal(uno.added.length, 5);

  const dos = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(dos.ok, true, dos.error);
  assert.equal(dos.added.length, 0, 'un reintento no debe agregar nada');
  assert.equal(dos.idempotent.length, 5);
  assert.deepEqual(dos.counts, uno.counts);
});

test('duplicado idéntico (mismo id, mismo hash) se acepta como idempotente', () => {
  const rec = R.toRecord('signature', {
    SK: 'signature#abc', projectId: CTX, body: { signer: 'leitolarreta', target: 'pr-1', checksum: 'x' },
  });
  const merge = R.mergeRecords([rec], [Object.assign({}, rec)]);

  assert.equal(merge.ok, true);
  assert.equal(merge.records.length, 1);
  assert.equal(merge.idempotent.length, 1);
  assert.equal(merge.added.length, 0);
});

test('conflicto: mismo id con contenido distinto aborta y NO sobreescribe el append-only', () => {
  const local = R.toRecord('signature', {
    SK: 'signature#abc', projectId: CTX, body: { signer: 'leitolarreta', target: 'pr-1', checksum: 'x' },
  });
  const durable = R.toRecord('signature', {
    SK: 'signature#abc', projectId: CTX, body: { signer: 'otro', target: 'pr-1', checksum: 'x' },
  });

  const merge = R.mergeRecords([local], [durable]);

  assert.equal(merge.ok, false);
  assert.equal(merge.code, 'conflicto_id');
  assert.match(merge.detail, /NUNCA se sobreescribe/);
});

test('conflicto en el flujo completo: aborta en validate y deja el filesystem intacto', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });

  const uno = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(uno.ok, true, uno.error);
  const antes = fs.readFileSync(path.join(uno.reconcileDir, 'signatures.jsonl'), 'utf8');

  // Alteramos el contenido de una firma local recalculando su hash: mismo id,
  // otro contenido. Es el caso "alguien editó el JSONL a mano".
  const file = path.join(uno.reconcileDir, 'signatures.jsonl');
  const lineas = antes.trim().split('\n');
  const rec = JSON.parse(lineas[0]);
  rec.body.target = 'pr-TAMPERED';
  rec.hash = sha256Canonical({ type: rec.type, id: rec.id, projectId: rec.projectId, body: rec.body });
  lineas[0] = JSON.stringify(rec);
  fs.writeFileSync(file, `${lineas.join('\n')}\n`);
  const despuesDelTamper = fs.readFileSync(file, 'utf8');

  const dos = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(dos.ok, false);
  assert.equal(dos.code, 'conflicto_id');
  assert.equal(dos.durableSigueSiendoFuente, true);
  assert.equal(fs.readFileSync(file, 'utf8'), despuesDelTamper, 'el abort no debe tocar el filesystem');
});

test('lo que sólo existe en filesystem se conserva: reconciliar nunca borra un registro local', () => {
  const local = R.toRecord('audit', { SK: 'audit#solo-local', projectId: CTX, body: { action: 'x', actor: 'y', at: '1' } });
  const durable = R.toRecord('audit', { SK: 'audit#nuevo', projectId: CTX, body: { action: 'z', actor: 'y', at: '2' } });

  const merge = R.mergeRecords([local], [durable]);

  assert.equal(merge.ok, true);
  assert.equal(merge.records.length, 2);
  assert.deepEqual(merge.onlyLocal.map((r) => r.id), ['solo-local']);
});

// =============================================================================
// CA-5 — Falsos verdes: conjunto vacío y export incompleto
// =============================================================================

test('conjunto vacío aborta: un rollback sin datos no es evidencia de nada', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createKernelStore({ contextProjectId: 'vacio-store', now: () => 1 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'conjunto_vacio');
  assert.equal(res.state, 'validate');
  assert.equal(res.durableSigueSiendoFuente, true);
  assert.ok(!fs.existsSync(path.join(root, 'kernel-reconcile', 'signatures.jsonl')));
});

test('sonda incompleta: sólo firmas y ningún audit también aborta', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 0 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'sonda_incompleta');
  assert.match(res.error, /audit/);
});

test('export incompleto: un store que no expone el listado paginado aborta fail-closed', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeSinListado = { contextProjectId: CTX, appendAuditEntry: async () => ({ ok: true }) };

  const res = await R.reconcileDurableToFilesystem(args(storeSinListado, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'store_sin_listado');
  assert.equal(res.durableSigueSiendoFuente, true);
});

test('export incompleto: si el listado de audit falla, no se promueve nada', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = await storeConDatos({ signatures: 3, audits: 3 });
  const store = Object.assign({}, base, {
    listAuditEntries: async () => { throw new Error('throttling en la página 2'); },
  });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'export_fallido');
  assert.ok(!fs.existsSync(path.join(root, 'kernel-reconcile', 'signatures.jsonl')),
    'un export parcial no puede dejar medio conjunto promovido');
});

test('SK sin gramática válida aborta en vez de inventar una identidad', async () => {
  const store = {
    contextProjectId: CTX,
    listSignatures: async () => [{ SK: 'signature#', projectId: CTX, body: {} }],
    listAuditEntries: async () => [],
  };
  const res = await R.exportAppendOnly(store);

  assert.equal(res.ok, false);
  assert.equal(res.code, 'sk_invalido');
});

// =============================================================================
// CA-5 — Integridad: manifiesto y hashes alterados
// =============================================================================

test('manifiesto alterado: cambiar un conteo invalida el manifestHash', () => {
  const recs = [R.toRecord('signature', { SK: 'signature#a', projectId: CTX, body: { signer: 's' } })];
  const manifest = R.buildReconcileManifest(recs, { createdAt: 1, projectId: CTX });

  assert.deepEqual(R.validateReconcileManifest(manifest, recs), { ok: true });

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.counts.signature = 99;
  const v = R.validateReconcileManifest(tampered, recs);

  assert.equal(v.ok, false);
  assert.equal(v.code, 'manifest_alterado');
});

test('manifiesto alterado: recalcular el hash pero mentir en el conteo se detecta igual', () => {
  const recs = [
    R.toRecord('signature', { SK: 'signature#a', projectId: CTX, body: { signer: 's' } }),
    R.toRecord('audit', { SK: 'audit#b', projectId: CTX, body: { action: 'x' } }),
  ];
  const manifest = R.buildReconcileManifest(recs, { createdAt: 1, projectId: CTX });

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.counts.audit = 5;
  delete tampered.manifestHash;
  tampered.manifestHash = sha256Canonical(tampered);

  const v = R.validateReconcileManifest(tampered, recs);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'conteo_divergente');
});

test('hash alterado en el JSONL promovido se detecta al releer', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 1 });
  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.ok, true, res.error);

  const file = path.join(res.reconcileDir, 'signatures.jsonl');
  const lineas = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lineas[0]);
  rec.body.target = 'otra-cosa'; // hash queda viejo → no corresponde al contenido
  lineas[0] = JSON.stringify(rec);
  fs.writeFileSync(file, `${lineas.join('\n')}\n`);

  const releido = R.readFilesystemRecords(res.reconcileDir);
  assert.equal(releido.ok, false);
  assert.equal(releido.code, 'hash_divergente');
});

test('línea corrupta en el JSONL aborta la lectura (no se saltea en silencio)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.ok, true, res.error);

  fs.appendFileSync(path.join(res.reconcileDir, 'audit.jsonl'), '{ esto no es json\n');

  const releido = R.readFilesystemRecords(res.reconcileDir);
  assert.equal(releido.ok, false);
  assert.equal(releido.code, 'linea_corrupta');
});

// =============================================================================
// CA-5 — Import interrumpido y promoción atómica
// =============================================================================

test('import interrumpido: si la promoción falla, el destino conserva la generación anterior', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });

  const uno = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(uno.ok, true, uno.error);
  const contenidoPrevio = leerJsonl(uno.reconcileDir, 'signatures.jsonl');

  // Simulamos la interrupción: el staging tiene los archivos pero falta el
  // manifiesto, así que el rename del último archivo falla a mitad.
  const staging = path.join(uno.reconcileDir, R.STAGING_DIR_NAME);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'signatures.jsonl'), '');
  fs.writeFileSync(path.join(staging, 'audit.jsonl'), '');
  // manifest.json ausente a propósito → promoción interrumpida.

  const res = R.promoteReconcileArtifacts(staging, uno.reconcileDir);

  assert.equal(res.ok, false);
  assert.equal(res.code, 'promocion_fallida');
  assert.deepEqual(leerJsonl(uno.reconcileDir, 'signatures.jsonl'), contenidoPrevio,
    'el destino tiene que volver a la generación anterior, no quedar mezclado');
});

test('staging sucio de un intento previo no contamina la promoción', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });
  const dir = path.join(root, 'kernel-reconcile');
  const staging = path.join(dir, R.STAGING_DIR_NAME);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'signatures.jsonl'), '{"basura":true}\n');

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.counts.signature, 2, 'la basura del staging previo no puede sobrevivir');
  assert.ok(!fs.existsSync(staging), 'el staging se limpia tras promover');
});

// =============================================================================
// CA-5 — Path traversal, symlink y permisos
// =============================================================================

test('path traversal: un reconcileDir fuera de la raíz permitida aborta antes de escribir', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos();

  const res = await R.reconcileDurableToFilesystem({
    store,
    reconcileDir: path.join(root, '..', 'fuera-de-la-raiz'),
    allowedRoot: root,
    frozen: true,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'staging_fuera_de_raiz');
  assert.ok(!fs.existsSync(path.join(root, '..', 'fuera-de-la-raiz')));
});

test('symlink: un destino que es symlink se rechaza (no se escribe a través de él)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos();

  const afuera = path.join(root, 'afuera');
  fs.mkdirSync(afuera, { recursive: true });
  const link = path.join(root, 'kernel-reconcile');
  try {
    fs.symlinkSync(afuera, link, 'junction');
  } catch (e) {
    t.skip(`el entorno no permite crear symlinks: ${e.code}`);
    return;
  }

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'destino_symlink');
});

test('permisos: los artefactos promovidos no quedan world-readable (POSIX)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('los modos POSIX no aplican en Windows');
    return;
  }
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.ok, true, res.error);

  const modoDir = fs.statSync(res.reconcileDir).mode & 0o777;
  const modoFile = fs.statSync(path.join(res.reconcileDir, 'signatures.jsonl')).mode & 0o777;
  assert.equal(modoDir & 0o077, 0, `el directorio no puede ser accesible a otros (${modoDir.toString(8)})`);
  assert.equal(modoFile & 0o077, 0, `el archivo no puede ser legible por otros (${modoFile.toString(8)})`);
});

// =============================================================================
// CA-5 — Freeze, redacción y audit de aborto
// =============================================================================

test('sin freeze de la ventana no se exporta nada', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos();

  const res = await R.reconcileDurableToFilesystem(args(store, root, { frozen: false }));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'ventana_no_congelada');
  assert.equal(res.state, 'freeze');
});

test('el aborto emite un audit redactado en el store durable', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const auditsAntes = (await store.listAuditEntries()).length;

  const res = await R.reconcileDurableToFilesystem(args(store, root, { frozen: false }));
  assert.equal(res.ok, false);
  assert.equal(res.abortAudit.emitted, true);

  const auditsDespues = await store.listAuditEntries();
  assert.equal(auditsDespues.length, auditsAntes + 1);
  const ultimo = auditsDespues[auditsDespues.length - 1];
  assert.equal(ultimo.body.action, 'kernel.reconcile.abort');
  assert.match(ultimo.body.detail, /ventana_no_congelada/);
});

test('el reporte al operador no filtra secretos', () => {
  const salida = R.renderReconcileReport({
    ok: false, state: 'export', code: 'export_fallido',
    // secret-scan:ignore — key de EJEMPLO de la doc pública de AWS: está acá
    // justamente para verificar que `redactSecrets` la tapa.
    error: 'falló con AKIAIOSFODNN7EXAMPLE y token=super-secreto', // secret-scan:ignore
  });

  assert.ok(!salida.includes('AKIAIOSFODNN7EXAMPLE')); // secret-scan:ignore
  assert.ok(!salida.includes('super-secreto'));
  assert.match(salida, /\[REDACTED\]/);
  assert.match(salida, /NO se apagó/);
});

// =============================================================================
// CA-3 / CA-4 — Ensayo completo del rollback
// =============================================================================

test('CA-3/CA-4: el ensayo completo apaga durable, reinicia, completa una fase y registra R8', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 3, audits: 2 });
  const ops = drillOps();
  let reloj = 0;

  const res = await R.runDurableRollbackDrill(Object.assign(args(store, root), ops, {
    clock: () => (reloj += 2000),
  }));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.state, 'record-R8');
  assert.equal(res.drill, true);
  assert.equal(ops.estado.durable, false, 'el flag tiene que quedar apagado');
  assert.equal(ops.estado.reinicios, 1);
  assert.equal(res.r8Ms, 2000);
  assert.equal(ops.estado.r8, 2000, 'R8 debe quedar registrado');
  assert.deepEqual(res.completados, ['disable-durable', 'restart', 'complete-phase', 'record-R8']);
});

test('el orden es sagrado: durable no se apaga si la paridad no cerró', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createKernelStore({ contextProjectId: 'vacio-drill', now: () => 1 });
  const ops = drillOps();

  const res = await R.runDurableRollbackDrill(Object.assign(args(store, root), ops));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'conjunto_vacio');
  assert.equal(res.drill, false);
  assert.equal(ops.estado.durable, true, 'ninguna falla previa puede apagar el flag');
  assert.equal(ops.estado.reinicios, 0);
  assert.equal(ops.estado.r8, null);
});

test('si la fase no completa desde filesystem, el ensayo falla y lo deja asentado', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });
  const ops = drillOps();

  const res = await R.runDurableRollbackDrill(Object.assign(args(store, root), ops, {
    completePhase: async () => ({ ok: false, error: 'la fase no arrancó sin DynamoDB' }),
  }));

  assert.equal(res.ok, false);
  assert.equal(res.state, 'complete-phase');
  assert.equal(res.code, 'paso_fallido');
  assert.deepEqual(res.completados, ['disable-durable', 'restart']);
  assert.equal(res.abortAudit.emitted, true);
});

test('un paso operativo no provisto invalida el ensayo (no se da por bueno lo que no se ejecutó)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });

  const res = await R.runDurableRollbackDrill(Object.assign(args(store, root), {
    disableDurable: async () => ({ ok: true }),
    // restart y completePhase ausentes a propósito
  }));

  assert.equal(res.ok, false);
  assert.equal(res.state, 'restart');
  assert.equal(res.code, 'paso_no_provisto');
});

test('R8 que no se pudo registrar invalida el ensayo (una métrica no escrita no ocurrió)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });
  const ops = drillOps();

  const res = await R.runDurableRollbackDrill(Object.assign(args(store, root), ops, {
    recordR8: async () => { throw new Error('disco lleno'); },
  }));

  assert.equal(res.ok, false);
  assert.equal(res.state, 'record-R8');
  assert.equal(res.code, 'r8_no_registrado');
});

// =============================================================================
// Contrato del módulo
// =============================================================================

test('la máquina declara sus transiciones en el orden del runbook', () => {
  assert.deepEqual(R.RECONCILE_STATES, [
    'precheck', 'freeze', 'export', 'validate', 'stage',
    'atomic-promote', 'reread-filesystem', 'compare',
  ]);
  assert.deepEqual(R.DRILL_STATES.slice(-4), [
    'disable-durable', 'restart', 'complete-phase', 'record-R8',
  ]);
});

test('el módulo no contiene ninguna operación destructiva sobre DynamoDB', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'kernel-append-only-reconcile.js'), 'utf8');
  assert.ok(!/deleteItem/.test(src), 'la reconciliación jamás borra de la tabla de no-repudio');
  assert.ok(!/putSignature|putItem/.test(src), 'la reconciliación es sólo lectura sobre el append-only');
});

test('la API de reconciliación se puede alcanzar desde kernel-store-migrate (punto de entrada del cutover)', () => {
  const migrate = require('../kernel-store-migrate');
  assert.equal(typeof migrate.reconcileDurableToFilesystem, 'function');
  assert.equal(typeof migrate.runDurableRollbackDrill, 'function');
  assert.equal(migrate.reconcileDurableToFilesystem, R.reconcileDurableToFilesystem);
});

// =============================================================================
// rev-2 · Transiciones de aborto del estado `compare` (y las que quedaban sin
// ejercitar). Motivo del rebote de `aprobacion`: el issue exige 100% de las
// transiciones de aborto de la máquina, y `compare` —el ÚLTIMO gate antes de
// habilitar el apagado de `kernel.durable`— no tenía ninguna. Se verificó por
// mutación: con `compareParity` devolviendo `ok: true` constante, la suite
// entera seguía en verde. Los tests de abajo matan ese mutante.
// =============================================================================

/**
 * Sabotea el destino JUSTO después de la promoción atómica y antes del reread.
 *
 * Es el único punto donde el filesystem puede divergir de lo reconciliado sin
 * que la máquina lo note antes: engancharse al `rename` del manifiesto (el
 * último de la promoción) reproduce exactamente esa ventana.
 */
function sabotajePostPromocion(saboteador) {
  const realRename = fs.renameSync;
  let disparado = false;
  fs.renameSync = function (from, to) {
    realRename(from, to);
    if (!disparado && path.basename(String(to)) === R.MANIFEST_FILE) {
      disparado = true;
      saboteador(path.dirname(String(to)));
    }
  };
  return () => { fs.renameSync = realRename; };
}

/** Reemplaza temporalmente una función de `fs` (para provocar fallas de disco). */
function conFsRoto(nombre, impl) {
  const real = fs[nombre];
  fs[nombre] = impl(real);
  return () => { fs[nombre] = real; };
}

/**
 * Borra del disco los registros que matchean `filtro` y REGENERA el manifiesto
 * para que quede coherente con lo que quedó. Sin regenerarlo, la máquina
 * abortaría antes, en `reread-filesystem`, y nunca llegaría a `compare`.
 */
function borrarDelDiscoYRegenerarManifest(dir, filtro) {
  for (const type of R.RECONCILE_TYPES) {
    const f = path.join(dir, R.FILE_BY_TYPE[type]);
    if (!fs.existsSync(f)) continue;
    const quedan = fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.trim() !== '')
      .filter((l) => !filtro(JSON.parse(l)));
    fs.writeFileSync(f, quedan.length ? `${quedan.join('\n')}\n` : '', 'utf8');
  }
  const releido = R.readFilesystemRecords(dir);
  assert.equal(releido.ok, true, 'el saboteador dejó el JSONL ilegible');
  const manifest = R.buildReconcileManifest(releido.records, {
    createdAt: 1700000000000,
    projectId: CTX,
  });
  fs.writeFileSync(path.join(dir, R.MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Deja en filesystem un registro que NO existe en DynamoDB (caso `onlyLocal`). */
function sembrarRegistroSoloLocal(dir, id = 'solo-local-1') {
  fs.mkdirSync(dir, { recursive: true });
  const rec = R.toRecord('audit', {
    SK: `audit#${id}`,
    projectId: CTX,
    body: { action: 'gate2.sign', actor: 'leitolarreta', detail: 'firmado antes del cutover' },
  });
  const linea = JSON.stringify({
    type: rec.type, id: rec.id, sk: rec.sk, projectId: rec.projectId, body: rec.body, hash: rec.hash,
  });
  fs.writeFileSync(path.join(dir, R.FILE_BY_TYPE.audit), `${linea}\n`, 'utf8');
  return rec;
}

// ---- `compareParity` como predicado (el mutante muere acá) -------------------

test('compareParity: un registro que falta en filesystem NO da paridad', () => {
  const a = { type: 'signature', id: '1', hash: 'h1' };
  const b = { type: 'audit', id: '2', hash: 'h2' };
  const r = R.compareParity([a, b], [a]);
  assert.equal(r.ok, false, 'faltar un registro tiene que romper la paridad');
  assert.deepEqual(r.faltantes, ['audit#2']);
  assert.deepEqual(r.sobrantes, []);
  assert.ok(r.conteoDistinto.includes('audit') && r.conteoDistinto.includes('total'));
});

test('compareParity: un registro de más en filesystem tampoco da paridad', () => {
  const a = { type: 'signature', id: '1', hash: 'h1' };
  const extra = { type: 'signature', id: '9', hash: 'h9' };
  const r = R.compareParity([a], [a, extra]);
  assert.equal(r.ok, false, 'un sobrante es divergencia: nadie inventa registros');
  assert.deepEqual(r.sobrantes, ['signature#9']);
});

test('compareParity: mismo id con hash distinto NO da paridad (mismo conteo, otro contenido)', () => {
  const r = R.compareParity(
    [{ type: 'signature', id: '1', hash: 'h1' }],
    [{ type: 'signature', id: '1', hash: 'OTRO' }],
  );
  assert.equal(r.ok, false, 'el conteo puede cerrar y el contenido estar alterado igual');
  assert.deepEqual(r.hashDistinto, ['signature#1']);
  assert.deepEqual(r.conteoDistinto, [], 'el conteo cierra: por eso hace falta comparar hashes');
});

// ---- las dos ramas de aborto de `compare`, con datos ------------------------

test('compare: con paridad y cobertura exactas, habilita (y devuelve la evidencia)', () => {
  const s = { type: 'signature', id: '1', hash: 'h1' };
  const a = { type: 'audit', id: '2', hash: 'h2' };
  const r = R.evaluateCompareStage({ exported: [s, a], merged: [s, a], reread: [s, a] });
  assert.equal(r.ok, true);
  assert.equal(r.parity.ok, true);
  assert.equal(r.coverage.ok, true);
});

test('compare aborta con `cobertura_incompleta` si algo quedó sólo en DynamoDB', () => {
  const s = { type: 'signature', id: '1', hash: 'h1' };
  const a = { type: 'audit', id: '2', hash: 'h2' };
  const r = R.evaluateCompareStage({ exported: [s, a], merged: [s, a], reread: [s] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cobertura_incompleta');
  assert.deepEqual(r.extra.noCubiertos, ['audit#2']);
  assert.match(r.message, /únicamente en DynamoDB/);
});

test('compare aborta con `cobertura_incompleta` si el contenido llegó alterado', () => {
  const s = { type: 'signature', id: '1', hash: 'h1' };
  const r = R.evaluateCompareStage({
    exported: [s],
    merged: [s],
    reread: [{ type: 'signature', id: '1', hash: 'ALTERADO' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cobertura_incompleta', 'un hash distinto es "no quedó íntegro", no un faltante');
  assert.deepEqual(r.extra.noCubiertos, ['signature#1']);
});

test('compare aborta con `paridad_fallida` si se perdió un registro que sólo estaba en filesystem', () => {
  const s = { type: 'signature', id: '1', hash: 'h1' };
  const local = { type: 'audit', id: 'solo-local', hash: 'hL' };
  const r = R.evaluateCompareStage({ exported: [s], merged: [s, local], reread: [s] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'paridad_fallida', 'la cobertura cierra, pero reconciliar borró un registro local');
  assert.deepEqual(r.extra.parity.faltantes, ['audit#solo-local']);
  assert.match(r.message, /NO se apaga `kernel\.durable`/);
});

test('compare aborta con `paridad_fallida` ante un registro que nadie escribió', () => {
  const s = { type: 'signature', id: '1', hash: 'h1' };
  const intruso = { type: 'signature', id: 'intruso', hash: 'hX' };
  const r = R.evaluateCompareStage({ exported: [s], merged: [s], reread: [s, intruso] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'paridad_fallida');
  assert.deepEqual(r.extra.parity.sobrantes, ['signature#intruso']);
});

// ---- las mismas dos ramas, atravesando la máquina completa ------------------

test('la máquina aborta en `compare` con `cobertura_incompleta` si el disco pierde un registro de DynamoDB', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 2 });

  // Se borra del disco una firma que SÍ vino de DynamoDB, con manifiesto
  // regenerado: el destino queda internamente consistente y mentiroso.
  const restaurar = sabotajePostPromocion((dir) => {
    borrarDelDiscoYRegenerarManifest(dir, (rec) => rec.type === 'signature');
  });
  let res;
  try {
    res = await R.reconcileDurableToFilesystem(args(store, root));
  } finally {
    restaurar();
  }

  assert.equal(res.ok, false);
  assert.equal(res.state, 'compare');
  assert.equal(res.code, 'cobertura_incompleta');
  assert.equal(res.durableSigueSiendoFuente, true);
  assert.equal(res.abortAudit.emitted, true, 'el aborto de compare también se audita');
});

test('la máquina aborta en `compare` con `paridad_fallida` si reconciliar perdió un registro local', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const dir = path.join(root, 'kernel-reconcile');
  const local = sembrarRegistroSoloLocal(dir);

  // Sólo se borra el registro que NO estaba en DynamoDB: la cobertura cierra y
  // el único defecto es la pérdida de un dato local. Ese es `paridad_fallida`.
  const restaurar = sabotajePostPromocion((d) => {
    borrarDelDiscoYRegenerarManifest(d, (rec) => rec.id === local.id);
  });
  let res;
  try {
    res = await R.reconcileDurableToFilesystem(args(store, root));
  } finally {
    restaurar();
  }

  assert.equal(res.ok, false);
  assert.equal(res.state, 'compare');
  assert.equal(res.code, 'paridad_fallida');
  assert.deepEqual(res.parity.faltantes, [`audit#${local.id}`]);
  assert.equal(res.durableSigueSiendoFuente, true);
});

test('un aborto en `compare` NO apaga durable ni reinicia nada en el ensayo completo', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 1 });
  const ops = drillOps();

  const restaurar = sabotajePostPromocion((dir) => {
    borrarDelDiscoYRegenerarManifest(dir, (rec) => rec.type === 'signature');
  });
  let res;
  try {
    res = await R.runDurableRollbackDrill(Object.assign(args(store, root), ops));
  } finally {
    restaurar();
  }

  assert.equal(res.ok, false);
  assert.equal(res.state, 'compare');
  assert.equal(res.code, 'cobertura_incompleta');
  assert.equal(res.drill, false);
  assert.equal(ops.estado.durable, true, 'el flag NUNCA se apaga en un camino de error');
  assert.equal(ops.estado.reinicios, 0);
  assert.equal(res.r8Ms, null, 'no hay R8 de un ensayo que no llegó a completarse');
});

test('el manifiesto promovido que desaparece aborta en `reread-filesystem`, no en `compare`', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });

  const restaurar = sabotajePostPromocion((dir) => {
    fs.rmSync(path.join(dir, R.MANIFEST_FILE), { force: true });
  });
  let res;
  try {
    res = await R.reconcileDurableToFilesystem(args(store, root));
  } finally {
    restaurar();
  }

  assert.equal(res.ok, false);
  assert.equal(res.state, 'reread-filesystem');
  assert.equal(res.code, 'manifest_ilegible');
  assert.equal(res.durableSigueSiendoFuente, true);
});

// ---- transiciones de `precheck`, `validate` y `stage` sin cobertura ---------

test('sin store no hay de dónde exportar: aborta en `precheck`', async () => {
  const res = await R.reconcileDurableToFilesystem({ reconcileDir: 'x', frozen: true });
  assert.equal(res.state, 'precheck');
  assert.equal(res.code, 'store_ausente');
});

test('sin `reconcileDir` no hay destino: aborta en `precheck`', async (t) => {
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const res = await R.reconcileDurableToFilesystem({ store, frozen: true, reconcileDir: '   ' });
  assert.equal(res.state, 'precheck');
  assert.equal(res.code, 'reconcile_dir_ausente');
  t.diagnostic('precheck corta antes de tocar AWS y antes de escribir un byte');
});

test('un JSONL ilegible aborta la reconciliación (no se reconcilia a ciegas)', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const dir = path.join(root, 'kernel-reconcile');
  // El "archivo" de firmas es en realidad un directorio: leerlo falla con EISDIR.
  fs.mkdirSync(path.join(dir, R.FILE_BY_TYPE.signature), { recursive: true });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'lectura_fallida');
  assert.equal(res.durableSigueSiendoFuente, true);
});

test('una línea con el `type` que no corresponde al archivo aborta como inconsistente', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });
  const dir = path.join(root, 'kernel-reconcile');
  fs.mkdirSync(dir, { recursive: true });
  // Una firma guardada dentro del archivo de audit: JSON válido, semántica rota.
  fs.writeFileSync(
    path.join(dir, R.FILE_BY_TYPE.audit),
    `${JSON.stringify({ type: 'signature', id: 'x', sk: 'signature#x', projectId: CTX, body: null, hash: 'h' })}\n`,
    'utf8',
  );

  const directo = R.readFilesystemRecords(dir);
  assert.equal(directo.ok, false);
  assert.equal(directo.code, 'linea_invalida');

  const res = await R.reconcileDurableToFilesystem(args(store, root));
  assert.equal(res.code, 'linea_invalida');
  assert.equal(res.durableSigueSiendoFuente, true);
});

test('si no se puede crear el directorio de reconciliación, aborta antes de stagear', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });

  const restaurar = conFsRoto('mkdirSync', () => () => {
    const e = new Error('permission denied');
    e.code = 'EACCES';
    throw e;
  });
  let res;
  try {
    res = await R.reconcileDurableToFilesystem(args(store, root));
  } finally {
    restaurar();
  }

  assert.equal(res.state, 'stage');
  assert.equal(res.code, 'reconcile_dir_mkdir_fallido');
  assert.equal(res.durableSigueSiendoFuente, true);
});

test('un staging que no se puede preparar aborta sin tocar el destino', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // El padre del staging es un ARCHIVO: no hay directorio posible debajo.
  const archivo = path.join(root, 'no-soy-un-directorio');
  fs.writeFileSync(archivo, 'x', 'utf8');

  const res = R.stageReconcileArtifacts([], R.buildReconcileManifest([], {}), path.join(archivo, '.staging'));

  assert.equal(res.ok, false);
  assert.equal(res.state, 'stage');
  assert.equal(res.code, 'staging_mkdir_fallido');
});

test('un staging que no se puede escribir se limpia solo y no promueve nada', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 1, audits: 1 });

  // Falla de escritura en el staging (disco lleno / permisos): el destino ni se toca.
  const restaurar = conFsRoto('openSync', (real) => (file, ...rest) => {
    if (String(file).includes(R.STAGING_DIR_NAME)) {
      const e = new Error('no space left on device');
      e.code = 'ENOSPC';
      throw e;
    }
    return real(file, ...rest);
  });
  let res;
  try {
    res = await R.reconcileDurableToFilesystem(args(store, root));
  } finally {
    restaurar();
  }

  assert.equal(res.state, 'stage');
  assert.equal(res.code, 'staging_write_fallido');
  assert.equal(res.durableSigueSiendoFuente, true);
  assert.equal(
    fs.existsSync(path.join(root, 'kernel-reconcile', R.MANIFEST_FILE)), false,
    'no se promovió ningún artefacto',
  );
});

// ---- guardián: ninguna transición de aborto puede volver a quedar sin test ---

test('TODA transición de aborto declarada por el módulo tiene al menos un test que la nombra', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'kernel-append-only-reconcile.js'), 'utf8');
  const suite = fs.readFileSync(__filename, 'utf8');
  const declarados = new Set();
  const re = /(?:fail|abort)\('[a-z-]+',\s*'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) declarados.add(m[1]);
  // `evaluateCompareStage` devuelve sus códigos como dato, no vía fail()/abort().
  for (const c of ['cobertura_incompleta', 'paridad_fallida']) declarados.add(c);

  const sinCobertura = [...declarados].filter((code) => !suite.includes(`'${code}'`));
  assert.deepEqual(
    sinCobertura, [],
    'estas transiciones de aborto no se ejercitan en ningún test: una rama de aborto ' +
    'sin test es una rama que nadie probó que exista',
  );
});

// =============================================================================
// Coherencia con lo que el operador va a leer (runbook y config versionado)
// =============================================================================

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RUNBOOK = path.join(REPO_ROOT, 'docs', 'pipeline', 'runbook-cutover-durable.md');

/** Sección del runbook por su encabezado exacto, hasta el próximo del mismo nivel. */
function seccionRunbook(encabezado) {
  const doc = fs.readFileSync(RUNBOOK, 'utf8');
  const desde = doc.indexOf(encabezado);
  assert.notEqual(desde, -1, `el runbook perdió la sección ${encabezado}`);
  const resto = doc.slice(desde + encabezado.length);
  const nivel = `\n${encabezado.split(' ')[0]} `;
  const hasta = resto.indexOf(nivel);
  return hasta === -1 ? resto : resto.slice(0, hasta);
}

test('el remedio de `conjunto_vacio` manda a la herramienta que resuelve el aborto', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 0, audits: 0 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.code, 'conjunto_vacio');
  // La sonda que siembra firma + audit es `kernel-drill-seed.js` (§2.1). La de
  // §8.4 (`kernel-cutover-probe.js`, #5208) da de alta un producto y deja este
  // aborto igual: mandar ahí al operador es hacerle perder la corrida.
  assert.match(res.error, /kernel-drill-seed\.js/);
  assert.match(res.error, /§2\.1/);
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, '.pipeline', 'kernel-drill-seed.js')),
    'el remedio cita una herramienta que no existe en el repo',
  );
  assert.ok(
    !/sonda positiva \(§8\.4/.test(res.error),
    'el remedio no puede derivar a la sonda de producto del cutover',
  );
});

test('el remedio de `sonda_incompleta` también apunta al seeder del ensayo', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await storeConDatos({ signatures: 2, audits: 0 });

  const res = await R.reconcileDurableToFilesystem(args(store, root));

  assert.equal(res.code, 'sonda_incompleta');
  assert.match(res.error, /kernel-drill-seed\.js/);
  assert.match(res.error, /§2\.1/);
});

test('§2.1 del runbook documenta el seeder y §8.4 no lo confunde con la sonda de producto', () => {
  const s21 = seccionRunbook('### 2.1 · El comando');
  assert.match(s21, /kernel-drill-seed\.js/, '§2.1 tiene que documentar cómo se siembra la sonda del ensayo');
  const s84 = seccionRunbook('### 8.4 · Sonda positiva — la evidencia que sí prueba algo');
  assert.ok(
    !/kernel-drill-seed/.test(s84),
    '§8.4 es la sonda de alta de producto (#5208); si empieza a hablar del seeder, ' +
    'los mensajes de aborto vuelven a mandar al operador al lugar equivocado',
  );
});

test('la tabla de códigos de aborto del runbook cubre los que el módulo emite en `compare`', () => {
  const s23 = seccionRunbook('### 2.3 · Abort, reintento y staging');
  for (const code of ['cobertura_incompleta', 'paridad_fallida']) {
    assert.ok(s23.includes(code), `el runbook no documenta el código de aborto \`${code}\``);
  }
});

test('el runbook no afirma un estado de `kernel.durable` distinto al versionado', () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8');
  const bloque = config.slice(config.search(/^kernel:$/m));
  const m = /^\s{2}durable:\s*(true|false)\b/m.exec(bloque);
  assert.ok(m, 'no se pudo leer `kernel.durable` de .pipeline/config.yaml');
  const versionado = m[1];

  const s8 = seccionRunbook('## 8 · Ejecución del cutover — procedimiento y evidencia (#5208)');
  assert.match(
    s8,
    new RegExp('valor versionado HOY es `durable: ' + versionado + '`'),
    'la sección 8 del runbook describe el estado del switch y el config dice otra cosa: ' +
    'el operador que la lee como "estado actual" queda desinformado',
  );
});

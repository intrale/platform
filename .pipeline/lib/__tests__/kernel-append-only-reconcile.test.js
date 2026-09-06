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

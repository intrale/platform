// =============================================================================
// Tests verifiable-predicate-store.js — sidecar del predicado verificable (#6611)
//
// Cubre: consume one-shot, TTL vencido, IO roto (fail-open sin lanzar),
// permisos 0o600, validación de forma y coacción del `issue` antes del path.
//
// Sin red. FS real en tmp aislado.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../verifiable-predicate-store');

// Mismo motivo que en auto-recheck-counter.test.js: un path derivado de
// `process.pid` + contador es determinista, y con PIDs reciclados dos corridas
// distintas comparten estado. `mkdtempSync` + limpieza en `after`.
const tmpDirs = [];
function tmpPipelineDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-6611-'));
  tmpDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const PREDICADO = {
  kind: 'pr_merge_blocked',
  pr: 6593,
  head_ref: 'agent/6145-turno-huerfano',
  observed: { httpStatus: 405, mergeStateStatus: 'BLOCKED', gate: 'branch-protection-other' },
};

test('#6611 store - record persiste y peek devuelve el predicado', () => {
  const dir = tmpPipelineDir();
  assert.equal(store.record({ pipelineDir: dir, issue: 6145, predicate: PREDICADO }), true);

  const got = store.peek({ pipelineDir: dir, issue: 6145 });
  assert.equal(got.kind, 'pr_merge_blocked');
  assert.equal(got.pr, 6593);
  assert.equal(got.head_ref, 'agent/6145-turno-huerfano');
  assert.equal(got.observed.httpStatus, 405);
});

test('#6611 store - consume es one-shot: la segunda lectura da null', () => {
  const dir = tmpPipelineDir();
  store.record({ pipelineDir: dir, issue: 6145, predicate: PREDICADO });

  const primera = store.consume({ pipelineDir: dir, issue: 6145 });
  assert.equal(primera.pr, 6593, 'la primera consume devuelve el predicado');

  const segunda = store.consume({ pipelineDir: dir, issue: 6145 });
  assert.equal(segunda, null, 'la segunda ya no encuentra nada');

  // El archivo efectivamente se borró.
  assert.equal(fs.existsSync(store.stateFile(dir, 6145)), false);
});

test('#6611 store - TTL vencido devuelve null y drena el archivo', () => {
  const dir = tmpPipelineDir();
  const t0 = 1_700_000_000_000;
  store.record({ pipelineDir: dir, issue: 6145, predicate: PREDICADO, ttlMs: 1000, now: t0 });

  // Justo antes de vencer: vivo.
  assert.notEqual(store.peek({ pipelineDir: dir, issue: 6145, now: t0 + 999 }), null);
  // Vencido: null.
  assert.equal(store.peek({ pipelineDir: dir, issue: 6145, now: t0 + 1001 }), null);

  // Consume vencido devuelve null pero igual limpia el sidecar (drenado).
  assert.equal(store.consume({ pipelineDir: dir, issue: 6145, now: t0 + 5000 }), null);
  assert.equal(fs.existsSync(store.stateFile(dir, 6145)), false);
});

test('#6611 store - sidecar sin ttl_expires_at valido se considera vencido', () => {
  const dir = tmpPipelineDir();
  const file = store.stateFile(dir, 6145);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ issue: 6145, predicate: PREDICADO }));
  // Sin caducidad declarada no se honra: no acumular sidecars inmortales.
  assert.equal(store.peek({ pipelineDir: dir, issue: 6145 }), null);
});

test('#6611 store - IO roto / JSON corrupto devuelve null sin lanzar (fail-open)', () => {
  const dir = tmpPipelineDir();
  const file = store.stateFile(dir, 6145);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'esto no es json {{{');

  assert.doesNotThrow(() => store.peek({ pipelineDir: dir, issue: 6145 }));
  assert.equal(store.peek({ pipelineDir: dir, issue: 6145 }), null);
  assert.equal(store.consume({ pipelineDir: dir, issue: 6145 }), null);

  // fsImpl que explota en cada operación: tampoco lanza.
  const fsRoto = {
    existsSync() { throw new Error('EIO'); },
    readFileSync() { throw new Error('EIO'); },
    mkdirSync() { throw new Error('EIO'); },
    openSync() { throw new Error('EIO'); },
    unlinkSync() { throw new Error('EIO'); },
  };
  assert.doesNotThrow(() => store.peek({ pipelineDir: dir, issue: 1, fsImpl: fsRoto }));
  assert.equal(store.record({ pipelineDir: dir, issue: 1, predicate: PREDICADO, fsImpl: fsRoto }), false);
  assert.equal(store.consume({ pipelineDir: dir, issue: 1, fsImpl: fsRoto }), null);
});

test('#6611 store - el sidecar se crea con permisos 0o600', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
  const dir = tmpPipelineDir();
  store.record({ pipelineDir: dir, issue: 6145, predicate: PREDICADO });
  const mode = fs.statSync(store.stateFile(dir, 6145)).mode & 0o777;
  assert.equal(mode, 0o600, 'sólo el owner puede leerlo/escribirlo');
});

test('#6611 store - predicado deforme no se persiste', () => {
  const dir = tmpPipelineDir();
  const deformes = [
    null, undefined, 'x', 42, [],
    { kind: 'otro', pr: 1, head_ref: 'agent/1-x' },
    { kind: 'pr_merge_blocked', pr: '00042', head_ref: 'agent/1-x' },
    { kind: 'pr_merge_blocked', pr: 12.5, head_ref: 'agent/1-x' },
    { kind: 'pr_merge_blocked', pr: -1, head_ref: 'agent/1-x' },
    { kind: 'pr_merge_blocked', pr: 1, head_ref: '' },
    { kind: 'pr_merge_blocked', pr: 1 },
  ];
  for (const predicate of deformes) {
    assert.equal(
      store.record({ pipelineDir: dir, issue: 6145, predicate }),
      false,
      JSON.stringify(predicate) + ' no debe persistirse',
    );
  }
  assert.equal(store.peek({ pipelineDir: dir, issue: 6145 }), null);
});

test('#6611 store - issue no-entero-positivo nunca toca el filesystem', () => {
  const dir = tmpPipelineDir();
  // El issue se interpola en un nombre de archivo: un `../` seria escritura
  // fuera del directorio de estado.
  for (const issue of ['../../etc/passwd', '6145/../../x', -1, 0, 1.5, 'abc', null, undefined, {}]) {
    assert.equal(store.record({ pipelineDir: dir, issue, predicate: PREDICADO }), false);
    assert.equal(store.peek({ pipelineDir: dir, issue }), null);
    assert.equal(store.consume({ pipelineDir: dir, issue }), null);
    assert.equal(store.stateFile(dir, issue), null);
  }
  // Nada se creó fuera de lugar.
  assert.equal(fs.existsSync(path.join(dir, 'state', 'verifiable-predicates')), false);
});

test('#6611 store - record es idempotente: pisa el anterior y refresca el TTL', () => {
  const dir = tmpPipelineDir();
  const t0 = 1_700_000_000_000;
  store.record({ pipelineDir: dir, issue: 6145, predicate: PREDICADO, ttlMs: 1000, now: t0 });
  store.record({
    pipelineDir: dir, issue: 6145,
    predicate: { ...PREDICADO, pr: 7000 }, ttlMs: 1000, now: t0 + 900,
  });
  const got = store.peek({ pipelineDir: dir, issue: 6145, now: t0 + 1500 });
  assert.equal(got.pr, 7000, 'quedó el último registrado');
  assert.notEqual(got, null, 'y el TTL se refrescó desde el segundo record');
});

test('#6611 store - sin pipelineDir no hace nada', () => {
  assert.equal(store.record({ issue: 1, predicate: PREDICADO }), false);
  assert.equal(store.peek({ issue: 1 }), null);
  assert.equal(store.consume({ issue: 1 }), null);
});

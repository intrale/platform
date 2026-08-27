// =============================================================================
// Tests auto-recheck-counter.js — techo de auto-destrabes (#6611, CA-8)
//
// Cubre: 3 ciclos destrabe → re-bloqueo ⇒ escala; el contador SOBREVIVE al
// borrado del `.reason.json` y al renombre del marker (que es justo por lo que
// no puede vivir ahí); TTL; fail-closed en lectura rota.
//
// Sin red. FS real en tmp aislado.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const counter = require('../auto-recheck-counter');

let seq = 0;
function tmpPipelineDir() {
  const d = path.join(os.tmpdir(), 'arc-6611-' + process.pid + '-' + (seq++));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const KIND = 'pr_merge_blocked';

test('#6611 counter - ausencia de archivo cuenta 0 (nunca se auto-destrabo)', () => {
  const dir = tmpPipelineDir();
  assert.equal(counter.count({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 }), 0);
  assert.equal(counter.ceilingReached({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 }), false);
});

test('#6611 CA-8 - al tercer ciclo destrabe/re-bloqueo deja de auto-destrabarse', () => {
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };

  // Ciclo 1 y 2: todavía por debajo del techo.
  counter.increment(args);
  assert.equal(counter.count(args), 1);
  assert.equal(counter.ceilingReached(args), false, 'tras 1 destrabe sigue habilitado');

  counter.increment(args);
  assert.equal(counter.count(args), 2);
  assert.equal(counter.ceilingReached(args), false, 'tras 2 destrabes sigue habilitado');

  // Ciclo 3: techo alcanzado ⇒ escala como bloqueo duro.
  counter.increment(args);
  assert.equal(counter.count(args), 3);
  assert.equal(counter.ceilingReached(args), true, 'al 3er destrabe deja de auto-destrabarse');
});

test('#6611 - "misma causa" es issue+kind+pr: otro PR arranca su propio contador', () => {
  const dir = tmpPipelineDir();
  counter.increment({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 });
  counter.increment({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 });
  counter.increment({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 });

  // Mismo issue, PR distinto: causa nueva.
  assert.equal(counter.count({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 9999 }), 0);
  // Issue distinto, mismo PR: causa nueva.
  assert.equal(counter.count({ pipelineDir: dir, issue: 7777, kind: KIND, pr: 6593 }), 0);
  // La causa original sigue en 3.
  assert.equal(counter.count({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 }), 3);
});

test('#6611 - el contador SOBREVIVE al borrado del .reason.json y al renombre del marker', () => {
  // Es la razón exacta por la que el contador NO puede vivir en el marker:
  // `unblockIssue` borra el `.reason.json` y renombra el marker en CADA
  // destrabe — o sea, justo en el evento que hay que contar.
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };

  // Simulamos el ciclo real: marker + reason viven en la cola de bloqueados.
  const fase = path.join(dir, 'desarrollo', 'entrega', 'bloqueado-humano');
  fs.mkdirSync(fase, { recursive: true });
  const marker = path.join(fase, '6145.delivery');
  const reason = marker + '.reason.json';
  fs.writeFileSync(marker, '');
  fs.writeFileSync(reason, JSON.stringify({ precondition: { type: 'verifiable' } }));

  counter.increment(args);
  assert.equal(counter.count(args), 1);

  // Lo que hace unblockIssue: borra el reason y renombra el marker a pendiente/.
  const pendiente = path.join(dir, 'desarrollo', 'entrega', 'pendiente');
  fs.mkdirSync(pendiente, { recursive: true });
  fs.renameSync(marker, path.join(pendiente, '6145.delivery'));
  fs.unlinkSync(reason);

  assert.equal(fs.existsSync(reason), false, 'el reason se borró, como en producción');
  assert.equal(counter.count(args), 1, 'el contador sigue en pie');

  // Y sigue acumulando a través de los ciclos siguientes.
  counter.increment(args);
  counter.increment(args);
  assert.equal(counter.ceilingReached(args), true);
});

test('#6611 - TTL: las marcas viejas dejan de contar', () => {
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };
  const t0 = 1_700_000_000_000;
  const DIA = 24 * 60 * 60 * 1000;

  counter.increment({ ...args, now: t0 });
  counter.increment({ ...args, now: t0 + DIA });
  counter.increment({ ...args, now: t0 + 2 * DIA });
  assert.equal(counter.count({ ...args, now: t0 + 2 * DIA }), 3, 'las 3 dentro del TTL');

  // A los 8 días de la primera, sólo sobreviven las dos posteriores.
  assert.equal(counter.count({ ...args, now: t0 + 7 * DIA + 1 }), 2);
  // A los 10 días, ya ninguna: un re-bloqueo así de tarde es causa nueva.
  assert.equal(counter.count({ ...args, now: t0 + 10 * DIA }), 0);
  assert.equal(counter.ceilingReached({ ...args, now: t0 + 10 * DIA }), false);
});

test('#6611 - lectura rota devuelve Infinity (fail-closed: no habilita destrabes)', () => {
  const dir = tmpPipelineDir();
  const fsRoto = {
    existsSync() { return true; },
    readFileSync() { throw new Error('EIO'); },
  };
  const n = counter.count({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593, fsImpl: fsRoto });
  assert.equal(n, Infinity, 'no poder leer el contador NO puede habilitar otro destrabe');
  assert.equal(
    counter.ceilingReached({ pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593, fsImpl: fsRoto }),
    true,
  );
});

test('#6611 - argumentos faltantes cuentan Infinity (fail-closed)', () => {
  const dir = tmpPipelineDir();
  assert.equal(counter.count({ issue: 1, kind: KIND, pr: 1 }), Infinity, 'sin pipelineDir');
  assert.equal(counter.count({ pipelineDir: dir, kind: KIND, pr: 1 }), Infinity, 'sin issue');
  assert.equal(counter.count({ pipelineDir: dir, issue: 1, pr: 1 }), Infinity, 'sin kind');
  assert.equal(counter.count({ pipelineDir: dir, issue: 1, kind: KIND }), Infinity, 'sin pr');
});

test('#6611 - una linea corrupta se saltea sin descartar el resto del archivo', () => {
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };
  counter.increment(args);
  counter.increment(args);

  // Inyectamos basura en el medio del JSONL.
  const file = counter.stateFile(dir);
  fs.appendFileSync(file, 'esto no es json\n');
  counter.increment(args);

  assert.equal(counter.count(args), 3, 'las 3 marcas válidas siguen contando');
});

test('#6611 - increment con IO roto no lanza (fail-open, no rompe el destrabe)', () => {
  const dir = tmpPipelineDir();
  const fsRoto = {
    mkdirSync() { throw new Error('EIO'); },
    appendFileSync() { throw new Error('EIO'); },
  };
  assert.doesNotThrow(() => counter.increment({
    pipelineDir: dir, issue: 1, kind: KIND, pr: 1, fsImpl: fsRoto,
  }));
  assert.equal(counter.increment({ pipelineDir: dir, issue: 1, kind: KIND, pr: 1, fsImpl: fsRoto }), false);
});

test('#6611 - el techo es configurable (max), default 3', () => {
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };
  counter.increment(args);
  assert.equal(counter.ceilingReached({ ...args, max: 1 }), true, 'techo 1 se alcanza al primer destrabe');
  assert.equal(counter.ceilingReached({ ...args, max: 5 }), false, 'techo 5 todavía no');
  assert.equal(counter.DEFAULT_MAX_AUTO_RELEASES, 3);
});

test('#6611 UX-6 - la escalada por techo se registra una sola vez y no infla el contador', () => {
  const dir = tmpPipelineDir();
  const args = { pipelineDir: dir, issue: 6145, kind: KIND, pr: 6593 };
  counter.increment(args);
  counter.increment(args);
  counter.increment(args);
  assert.equal(counter.markCeilingNotified(args), true, 'primer tick emite');
  assert.equal(counter.markCeilingNotified(args), false, 'ticks siguientes quedan deduplicados');
  assert.equal(counter.count(args), 3, 'la marca de escalada no cuenta como destrabe');
});

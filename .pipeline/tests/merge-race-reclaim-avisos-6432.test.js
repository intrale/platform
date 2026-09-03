'use strict';

// #6432 — CA-23 y CA-24: los DOS desenlaces del barrido de rescate avisan, y
// sólo ellos avisan.
//
// Origen: rebote de `ux` (fase `aprobacion`, 2026-08-25). La degradación a
// `human_judgment` ocurría EN SILENCIO — ni aviso accionable, ni Telegram. El
// operador quedaba con un `needs-human` sin saber qué pasó ni cómo salir.
//
// ESTOS TESTS NO SON VACUOS, a propósito: cada uno falla si se saca CUALQUIERA
// de las dos piezas (el aviso accionable O la notificación). El test de
// degradación afirma, por separado, que hubo exactamente 1 Telegram, que hubo
// exactamente 1 comentario encolado, y que ambos traen los SEIS campos de CA-23.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.PULPO_NO_AUTOSTART = '1';

const { reapMergeChecksRaceBlocks } = require('../pulpo');
const ledgerStoreReal = require('../lib/merge-race-reclaim-ledger');
const notice = require('../lib/merge-race-reclaim-notice');

const SHA = 'a'.repeat(40);
const ISSUE = 6432;
const PR = 6500;

/** Ledger real (misma semántica de producción) sobre un archivo temporal. */
function tempLedgerStore(dir) {
  const file = path.join(dir, 'ledger.json');
  const jsonl = path.join(dir, 'audit.jsonl');
  return {
    file, jsonl,
    readLedger: () => ledgerStoreReal.readLedger(file),
    getEntry: (issue) => ledgerStoreReal.getEntry(issue, file),
    recordAttempt: (o) => ledgerStoreReal.recordAttempt({ ...o, file }),
    recordOutcome: (o) => ledgerStoreReal.recordOutcome({ ...o, file }),
    markDegraded: (o) => ledgerStoreReal.markDegraded({ ...o, file }),
    appendAudit: (e) => ledgerStoreReal.appendAudit(e, jsonl),
  };
}

/** Hijo falso de `--reclaim`: emite su última línea JSON y sale con `code`. */
function fakeSpawn(outcome, code) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify(outcome) + '\n');
      child.emit('exit', code);
    });
    return child;
  };
}

function markerFor(dir) {
  // Marker real en disco: la degradación reescribe su `.reason.json`.
  const markerPath = path.join(dir, `${ISSUE}.delivery`);
  fs.writeFileSync(markerPath, 'issue: 6432\n');
  fs.writeFileSync(`${markerPath}.reason.json`, JSON.stringify({
    issue: ISSUE, skill: 'delivery', precondition: { type: 'merge_checks_race', pr: PR, head_sha: SHA },
  }, null, 2));
  return { issue: ISSUE, marker_path: markerPath, precondition: { type: 'merge_checks_race', pr: PR, head_sha: SHA } };
}

const PR_JSON = JSON.stringify({
  number: PR, url: `https://github.com/intrale/platform/pull/${PR}`,
  labels: [{ name: 'qa:passed' }], headRefName: `agent/${ISSUE}-rescate`,
  isCrossRepository: false, headRepositoryOwner: { login: 'intrale' },
  state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: SHA,
});

/** Corre N ticks del barrido con el desenlace de hijo que le toca a cada uno. */
async function correrTicks({ dir, maxAttempts, resultadosPorTick }) {
  const store = tempLedgerStore(dir);
  const marker = markerFor(dir);
  const telegrams = [];
  const ordenes = [];
  const config = { brazo: { reclaim_merge_race: { enabled: true, kill_switch: false, max_attempts: maxAttempts, child_timeout_ms: 5000 } } };

  for (const r of resultadosPorTick) {
    await reapMergeChecksRaceBlocks({
      config,
      ghCall: async () => ({ stdout: PR_JSON }),
      spawnImpl: r ? fakeSpawn(r.salida, r.code) : (() => { throw new Error('no debería lanzar hijo en este tick'); }),
      notify: (msg) => telegrams.push(msg),
      listMarkers: () => {
        // El marker refleja lo que quedó en disco: si se degradó, ya no es
        // `merge_checks_race` y el barrido no lo vuelve a mirar.
        const meta = JSON.parse(fs.readFileSync(`${marker.marker_path}.reason.json`, 'utf8'));
        return [{ ...marker, precondition: meta.precondition }];
      },
      ledgerStore: store,
      unblock: () => ({ ok: true }),
      enqueueOrder: (file, payload) => ordenes.push(payload),
    });
  }
  const reason = JSON.parse(fs.readFileSync(`${marker.marker_path}.reason.json`, 'utf8'));
  return { telegrams, ordenes, store, reason };
}

// Los SEIS campos que CA-23 exige en el aviso de degradación. Sacar cualquiera
// del copy hace fallar este test — es lo que lo vuelve no vacuo.
function assertSeisCamposDeCA23(texto, { attempts, maxAttempts, gate, reason }) {
  assert.match(texto, new RegExp(`#${ISSUE}\\b`), 'falta el issue');
  assert.match(texto, new RegExp(`#${PR}\\b`), 'falta el PR');
  assert.match(texto, new RegExp(`${attempts}/${maxAttempts}`), 'falta el contador de intentos agotados N/N');
  assert.match(texto, new RegExp(gate), 'falta el gate del último intento');
  assert.match(texto, new RegExp(reason), 'falta el reason del último intento');
  assert.match(texto, new RegExp(`/unblock ${ISSUE}\\b`), 'falta la acción concreta /unblock <issue>');
}

test('CA-23: el aviso de degradación trae los seis campos y dice qué hacer', () => {
  const n = notice.buildDegradationNotice({ issue: ISSUE, pr: PR, attempts: 3, maxAttempts: 3, gate: 'codeowners', reason: 'review requerida ausente' });
  for (const texto of [n.telegram, n.comment, n.log]) {
    assertSeisCamposDeCA23(texto, { attempts: 3, maxAttempts: 3, gate: 'codeowners', reason: 'review requerida ausente' });
  }
});

test('CA-23: sin gate/reason del hijo el aviso NO miente ni se rompe — dice "desconocido"', () => {
  const n = notice.buildDegradationNotice({ issue: ISSUE, pr: PR, attempts: 2, maxAttempts: 2 });
  assertSeisCamposDeCA23(n.telegram, { attempts: 2, maxAttempts: 2, gate: 'desconocido', reason: 'desconocido' });
});

test('CA-32: el aviso nunca vuelca un objeto crudo del PR', () => {
  const n = notice.buildDegradationNotice({ issue: ISSUE, pr: PR, attempts: 1, maxAttempts: 1, gate: { allowed_actors: ['leito'] }, reason: 'x\ny' });
  assert.doesNotMatch(n.telegram + n.comment, /allowed_actors|\[object Object\]/);
  assert.doesNotMatch(n.telegram, /\n\s*y\b/); // el reason multilínea se aplanó
});

test('CA-25: el aviso de confirmación sólo lo produce el camino que ya vio el merge', () => {
  const n = notice.buildConfirmationNotice({ issue: ISSUE, pr: PR, sha: SHA });
  assert.match(n.comment, /mismos gates|No fue un merge directo/);
  assert.match(n.telegram, new RegExp(`#${ISSUE}\\b`));
});

test('CA-23 + CA-24: falla → falla → degrada emite EXACTAMENTE 1 Telegram y 1 aviso accionable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-aviso-'));
  const fallo = { salida: { status: 'blocked', gate: 'codeowners', reason: 'falta review de un owner' }, code: 1 };
  const { telegrams, ordenes, store, reason } = await correrTicks({
    dir, maxAttempts: 2,
    // tick1 falla, tick2 falla (agota el tope), tick3 ya no lanza hijo: degrada.
    resultadosPorTick: [fallo, fallo, null],
  });

  // CA-24 — exactamente un Telegram en toda la historia: el desenlace. Los dos
  // intentos intermedios fallidos NO notificaron.
  assert.equal(telegrams.length, 1, 'CA-24: debe salir exactamente 1 Telegram (el desenlace)');
  // CA-23 — y ese Telegram es el aviso accionable con los seis campos.
  assertSeisCamposDeCA23(telegrams[0], { attempts: 2, maxAttempts: 2, gate: 'codeowners', reason: 'falta review de un owner' });

  // CA-23 — el aviso también queda en el hilo del issue, con los seis campos.
  const comentarios = ordenes.filter((o) => o.action === 'comment');
  assert.equal(comentarios.length, 1, 'CA-23: debe encolarse exactamente 1 comentario de degradación');
  assertSeisCamposDeCA23(comentarios[0].body, { attempts: 2, maxAttempts: 2, gate: 'codeowners', reason: 'falta review de un owner' });

  // El desenlace es hacia el humano, nunca hacia el automático.
  assert.deepEqual(reason.precondition, { type: 'human_judgment' });
  assert.equal(store.getEntry(ISSUE).degraded, true);
  // La traza completa (los dos intentos + la degradación) sí está en el .jsonl.
  const jsonl = fs.readFileSync(store.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(jsonl.filter((e) => e.event === 'attempt_failed').length, 2);
  assert.equal(jsonl.filter((e) => e.event === 'degraded').length, 1);
});

test('CA-24: falla → falla → mergea produce EXACTAMENTE 1 sendTelegram', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-ok-'));
  const fallo = { salida: { status: 'transient', gate: 'checks', reason: 'checks todavía corriendo' }, code: 1 };
  const exito = { salida: { status: 'merged', sha: SHA }, code: 0 };
  const { telegrams, ordenes } = await correrTicks({
    dir, maxAttempts: 5, resultadosPorTick: [fallo, fallo, exito],
  });

  assert.equal(telegrams.length, 1, 'CA-24: falla → falla → mergea debe producir exactamente 1 sendTelegram');
  assert.match(telegrams[0], /rescat/i);
  assert.match(telegrams[0], new RegExp(`#${PR}\\b`));
  // CA-22 — el merge confirmado también deja su explicación en el hilo, y el
  // `needs-human` se retira con la orden autorizada.
  assert.equal(ordenes.filter((o) => o.action === 'comment').length, 1);
  const remove = ordenes.find((o) => o.action === 'remove-label');
  assert.ok(remove && remove.guardrail_authorized === true && remove.authorized_by);
});

test('CA-23: el ledger conserva gate y reason del último intento a través de la degradación', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-ledger-'));
  const file = path.join(dir, 'ledger.json');
  ledgerStoreReal.recordAttempt({ issue: ISSUE, pr: PR, head_sha: SHA, file });
  ledgerStoreReal.recordOutcome({ issue: ISSUE, pr: PR, head_sha: SHA, status: 'blocked', gate: 'codeowners', reason: 'falta review', file });
  ledgerStoreReal.recordAttempt({ issue: ISSUE, pr: PR, head_sha: SHA, file });
  // El segundo intento todavía no reportó: el desenlace anterior sobrevive y es
  // con lo que se redacta el aviso si el tope se agota acá.
  assert.equal(ledgerStoreReal.getEntry(ISSUE, file).last_gate, 'codeowners');
  ledgerStoreReal.markDegraded({ issue: ISSUE, pr: PR, head_sha: SHA, file });
  const entry = ledgerStoreReal.getEntry(ISSUE, file);
  assert.equal(entry.degraded, true);
  assert.equal(entry.attempts, 2);
  assert.equal(entry.last_gate, 'codeowners', 'markDegraded no puede borrar el insumo del aviso de CA-23');
  assert.equal(entry.last_reason, 'falta review');
});

test('CA-23: un head_sha nuevo no arrastra el desenlace del PR viejo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-head-'));
  const file = path.join(dir, 'ledger.json');
  ledgerStoreReal.recordAttempt({ issue: ISSUE, pr: PR, head_sha: SHA, file });
  ledgerStoreReal.recordOutcome({ issue: ISSUE, pr: PR, head_sha: SHA, status: 'blocked', gate: 'codeowners', reason: 'falta review', file });
  ledgerStoreReal.recordAttempt({ issue: ISSUE, pr: PR, head_sha: 'b'.repeat(40), file });
  const entry = ledgerStoreReal.getEntry(ISSUE, file);
  assert.equal(entry.attempts, 1);
  assert.equal(entry.last_gate, null);
  // Y un outcome de un par que ya no es el vigente no puede pisar el ledger.
  assert.equal(ledgerStoreReal.recordOutcome({ issue: ISSUE, pr: PR, head_sha: SHA, status: 'merged', file }), null);
});

test('CA-19: con el kill-switch puesto el barrido no avisa ni lista markers', async () => {
  let listado = false;
  const telegrams = [];
  for (const cfg of [{ enabled: false, kill_switch: false }, { enabled: true, kill_switch: true }, undefined]) {
    await reapMergeChecksRaceBlocks({
      config: { brazo: { reclaim_merge_race: cfg } },
      listMarkers: () => { listado = true; return []; },
      notify: (m) => telegrams.push(m),
      ghCall: async () => { throw new Error('no debería llamar a gh'); },
      spawnImpl: () => { throw new Error('no debería lanzar hijo'); },
    });
  }
  assert.equal(listado, false);
  assert.equal(telegrams.length, 0);
});

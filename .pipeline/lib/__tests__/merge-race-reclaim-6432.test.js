'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const humanBlock = require('../human-block');
const core = require('../brazo-desbloqueo-core');
const ledgerStore = require('../merge-race-reclaim-ledger');

const SHA = 'a'.repeat(40);
function marker(overrides = {}) { return { issue: 6432, precondition: { type: 'merge_checks_race', pr: 6500, head_sha: SHA }, ...overrides }; }
function pr(overrides = {}) { return { number: 6500, url: 'https://github.com/intrale/platform/pull/6500', labels: [{ name: 'qa:passed' }], headRefName: 'agent/6432-rescate', isCrossRepository: false, headRepositoryOwner: { login: 'intrale' }, state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: SHA, ...overrides }; }

test('normalizePrecondition acepta sólo PR canónico y SHA completo', () => {
  assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: 6500, head_sha: SHA.toUpperCase() }), { type: 'merge_checks_race', pr: 6500, head_sha: SHA });
  for (const value of ['6500', '06500', 0, -1, 1.5]) assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: value, head_sha: SHA }), { type: 'human_judgment' });
  for (const value of ['a'.repeat(7), 'a'.repeat(41), 'z'.repeat(40), null]) assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: 6500, head_sha: value }), { type: 'human_judgment' });
});

test('dependency tiene precedencia sobre merge_checks_race', () => {
  assert.deepEqual(humanBlock.classifyPrecondition([{ depende_de: [12], precondicion_merge_checks: { pr: 6500, head_sha: SHA } }], [], { issue: 6432 }), { type: 'dependency', depends_on: [12] });
});

test('selector reclama únicamente PR propio, pinneado, mergeable y con qa:passed', () => {
  const result = core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: pr() }, ledger: {} });
  assert.deepEqual(result.toReclaim, [marker()]);
  const denied = [
    pr({ headRefOid: 'b'.repeat(40) }), pr({ isCrossRepository: true }), pr({ headRepositoryOwner: { login: 'otro' } }),
    pr({ headRefName: 'agent/64321-rescate' }), pr({ labels: [{ name: 'qa:skipped' }] }), pr({ state: 'CLOSED' }), pr({ mergeStateStatus: 'BLOCKED' }),
  ];
  for (const state of denied) assert.equal(core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: state }, ledger: {} }).toReclaim.length, 0);
});

test('selector ignora otros tipos y degrada al agotar intentos', () => {
  const other = [{ issue: 1, precondition: { type: 'human_judgment' } }, { issue: 2, precondition: { type: 'dependency', depends_on: [3] } }];
  const untouched = core.selectMergeRaceBlocksToReclaim({ markers: other, prStates: {}, ledger: {} });
  assert.deepEqual(untouched, { toReclaim: [], toDegrade: [], skipped: [] });
  const exhausted = core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: pr() }, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts: 3 } }, maxAttempts: 3 });
  assert.deepEqual(exhausted.toDegrade, [marker()]);
});

test('ledger persiste intentos por issue y degradación pegajosa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-'));
  const file = path.join(dir, 'ledger.json');
  ledgerStore.recordAttempt({ issue: 6432, pr: 6500, head_sha: SHA, file });
  ledgerStore.recordAttempt({ issue: 6432, pr: 6500, head_sha: SHA, file });
  ledgerStore.markDegraded({ issue: 6432, pr: 6500, head_sha: SHA, file });
  const entry = ledgerStore.getEntry(6432, file);
  assert.equal(entry.attempts, 2); assert.equal(entry.degraded, true);
});

// ===========================================================================
// #6432 CA-26 — El recordatorio calla SÓLO al bloqueo que el pipeline está
// reclamando solo. Todo lo demás sigue subiendo la escalera de 2h/6h/24h.
//
// El rechazo de `security`/`review` fue exactamente por acá: el filtro
// anterior descartaba TODA la clase `merge_checks_race` sin mirar el ledger, y
// un marker degradado, con intentos agotados o directamente no reclamable se
// pudría en `needs-human` sin un solo aviso posterior al inicial.
// ===========================================================================

const reminder = require('../human-block-reminder');

const BLOQUEO_AT = '2026-08-01T00:00:00Z';
// 3h de bloqueo: ya pasó el 1er escalón (2h) y todavía no llega al techo de
// silencio (6h). Sin filtro, este bloqueo SIEMPRE tiene recordatorio vencido.
const AHORA = new Date('2026-08-01T03:00:00Z');

function bloqueo(overrides = {}) {
  return {
    issue: 6432, skill: 'delivery', phase: 'entrega', blocked_at: BLOQUEO_AT,
    precondition: { type: 'merge_checks_race', pr: 6500, head_sha: SHA },
    ...overrides,
  };
}
function evaluar(blocked, reclaim, now = AHORA) {
  return reminder.evaluateReminders({ now, blocked: [].concat(blocked), state: { issues: {} }, reclaim });
}
const recordado = (r) => r.due.map((d) => d.issue);

test('CA-26: con el barrido encendido e intentos disponibles NO se recuerda', () => {
  // Sin entrada en el ledger: nunca se intentó, los 3 intentos están enteros.
  assert.deepEqual(recordado(evaluar(bloqueo(), { enabled: true, ledger: {}, maxAttempts: 3 })), []);
  // Con intentos gastados pero disponibles (1 de 3) tampoco: sigue en vuelo.
  assert.deepEqual(recordado(evaluar(bloqueo(), {
    enabled: true, maxAttempts: 3, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts: 1 } },
  })), []);
});

test('CA-26: intentos AGOTADOS ⇒ vuelve a recordar', () => {
  for (const attempts of [3, 4]) {
    const r = evaluar(bloqueo(), { enabled: true, maxAttempts: 3, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts } } });
    assert.deepEqual(recordado(r), [6432], `con ${attempts}/3 intentos el bloqueo ya es del humano`);
    assert.equal(r.due[0].reminder_number, 1, 'entra por la escalera normal (1er aviso a las 2h), sin trato especial');
  }
});

test('CA-26: marker ya DEGRADADO ⇒ recuerda como cualquier bloqueo humano', () => {
  const ledger = { 6432: { pr: 6500, head_sha: SHA, attempts: 1, degraded: true } };
  assert.deepEqual(recordado(evaluar(bloqueo(), { enabled: true, maxAttempts: 3, ledger })), [6432]);
});

test('CA-26: con el barrido APAGADO no hay quién reclame ⇒ recuerda', () => {
  // Es el escenario que reportó `security`: el marker se acuña
  // `merge_checks_race` aunque el kill-switch esté en `false`.
  for (const reclaim of [null, undefined, { enabled: false, ledger: {} }, { enabled: true, ledger: null }]) {
    assert.deepEqual(recordado(evaluar(bloqueo(), reclaim)), [6432], JSON.stringify(reclaim));
  }
});

test('CA-26: el silencio tiene TECHO — un rescate trabado no calla para siempre', () => {
  // El selector puede mandar el marker a `skipped` (head movido, `qa:passed`
  // perdido) para siempre: `attempts` nunca sube y nunca llega a `toDegrade`.
  // Pasado el techo el bloqueo vuelve a ser del humano.
  const reclaim = { enabled: true, maxAttempts: 3, ledger: {} };
  const diezDias = new Date('2026-08-11T00:00:00Z');
  assert.deepEqual(recordado(evaluar(bloqueo(), reclaim, diezDias)), [6432]);
  assert.equal(reminder.MERGE_RACE_MAX_SILENCE_HOURS, 6);
});

test('CA-26: precondición degenerada o par (pr, head_sha) ajeno', () => {
  const reclaim = { enabled: true, maxAttempts: 3, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts: 3 } } };
  // `pr` o `head_sha` inválidos: el selector nunca lo va a elegir ⇒ recuerda.
  for (const pc of [{ type: 'merge_checks_race', pr: '6500', head_sha: SHA },
    { type: 'merge_checks_race', pr: 6500, head_sha: 'a'.repeat(7) }]) {
    assert.deepEqual(recordado(evaluar(bloqueo({ precondition: pc }), reclaim)), [6432]);
  }
  // Entrada del ledger de OTRO par: el contador arranca de cero sobre el par
  // nuevo (mismo criterio que el selector) ⇒ hay intentos ⇒ no recuerda.
  const otroPar = { enabled: true, maxAttempts: 3, ledger: { 6432: { pr: 6499, head_sha: 'b'.repeat(40), attempts: 3 } } };
  assert.deepEqual(recordado(evaluar(bloqueo(), otroPar)), []);
});

test('CA-26 (no-regresión): human_judgment y dependency recuerdan siempre', () => {
  const otros = [
    bloqueo({ issue: 7001, precondition: { type: 'human_judgment' } }),
    bloqueo({ issue: 7002, precondition: { type: 'dependency', depends_on: [1] } }),
    bloqueo({ issue: 7003, precondition: undefined }),
  ];
  const reclaim = { enabled: true, maxAttempts: 3, ledger: {} };
  assert.deepEqual(recordado(evaluar(otros, reclaim)).sort(), [7001, 7002, 7003]);
});

test('CA-26: runReminderTick consulta el ledger inyectado y falla hacia el humano', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reminder-6432-'));
  const enviados = [];
  const tick = (reclaim) => reminder.runReminderTick({
    pipelineDir: dir,
    stateFile: path.join(dir, `state-${enviados.length}.json`),
    listBlocked: () => [bloqueo()],
    sendTelegram: (texto) => enviados.push(texto),
    now: AHORA,
  ...(reclaim === undefined ? {} : { reclaim }),
  });

  // En vuelo ⇒ ni un mensaje.
  assert.equal(tick(() => ({ enabled: true, maxAttempts: 3, ledger: {} })).sent, false);
  assert.equal(enviados.length, 0);
  // Agotado ⇒ mensaje.
  assert.equal(tick(() => ({ enabled: true, maxAttempts: 3, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts: 3 } } })).sent, true);
  assert.equal(enviados.length, 1);
  // El proveedor del contexto explota ⇒ se recuerda igual (fail-open).
  assert.equal(tick(() => { throw new Error('ledger ilegible'); }).sent, true);
  assert.equal(enviados.length, 2);
  // Sin `reclaim` inyectado ⇒ se recuerda igual.
  assert.equal(tick(undefined).sent, true);
  assert.equal(enviados.length, 3);
});

test('CA-26: el pulpo le pasa el ledger real al recordatorio', () => {
  // Sin este cableado el filtro es código muerto y el recordatorio vuelve a
  // callar (o a mentir) por su cuenta. Se audita el código, no el comentario.
  const pulpo = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tick = pulpo.slice(pulpo.indexOf('humanBlockReminder.runReminderTick('));
  const bloque = tick.slice(0, tick.indexOf('});'));
  assert.match(bloque, /reclaim:/, 'runReminderTick tiene que recibir el contexto del rescate');
  assert.match(bloque, /mergeRaceLedger\.readLedger\(\)/, 'y el ledger tiene que ser el real');
  assert.match(bloque, /kill_switch/, 'con el barrido apagado no se calla ningún bloqueo');
});

// =============================================================================
// invalidacion-labels-cache-5863.test.js — Residual del re-bloqueo fantasma
// (#5863). NO confundir con `rebloqueo-fantasma-needs-human.test.js` (#5856),
// que cubre el gate en vivo y NO se toca acá (CA-R6).
//
// Contexto: #5856 sacó al gate `needs-human` de la caché (revalidación en vivo
// tri-estado + fail-closed). Lo que quedó abierto es todo lo demás:
//
//   - la caché nunca se invalidaba cuando el propio pipeline mutaba labels;
//   - las mutaciones aplicadas por `servicio-github.js` (otro proceso) eran
//     invisibles para el Pulpo hasta que vencía el TTL de 10 minutos;
//   - cuando la revalidación confirmaba `AUSENTE`, el marker viejo de
//     `bloqueado-humano/` quedaba huérfano y el dashboard seguía mostrando
//     frenado un issue ya despachado;
//   - `getIssueInfo()` interpolaba el identificador en un string de shell.
//
// Criterios de aceptación cubiertos:
//   CA-R1: invalidación por issue y total, sobre la clave canónica.
//   CA-R2: toda mutación de labels del pipeline invalida el issue afectado.
//   CA-R3: confirmación cross-proceso vía marker append-only + drenaje.
//   CA-R4: estado visible reconciliado, sin doble movimiento del work-file.
//   CA-R5: ejecución sin shell, identificador validado como numérico.
//   CA-R7: la invalidación no agrega lecturas en vivo (el drenaje no llama `gh`).
//
// Riesgos cubiertos: R1 (doble movimiento), R2 (invalidar con nro de PR),
// R6 (`applyGateLabelAction` cortocircuita el switch), R7 (marker sin rotación).
//
// Diseño: sin red y sin tocar el estado real del pipeline. Los tests de cola
// apuntan `PIPELINE_STATE_DIR` a un temp dir ANTES de requerir
// `servicio-github.js`; los de pulpo usan helpers inyectables.
//
// Ejecución: `node --test .pipeline/tests/invalidacion-labels-cache-5863.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Aislamiento del estado antes de cargar los módulos bajo test ------------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe5863-'));
process.env.PIPELINE_STATE_DIR = TMP_ROOT;
process.env.PULPO_NO_AUTOSTART = '1';

const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));
const svcGithub = require(path.join(__dirname, '..', 'servicio-github.js'));

const {
  invalidateIssueLabels,
  invalidateAllIssueLabels,
  enqueueLabelOrder,
  _drainLabelsAppliedMarker,
  _reconcileHumanBlockMarker,
  _fetchIssueInfoOrThrow,
  getIssueInfo,
  _setIssueInfoForTest,
  _peekIssueInfoForTest,
  _clearIssueRoutingCachesForTest,
  _resetLabelsAppliedOffsetForTest,
} = pulpo;

const { logLabelApplied, applyGateLabelAction, LABELS_APPLIED_LOG } = svcGithub;

/** Directorio temporal único por caso, para no cruzar estado entre tests. */
function tmpDir(tag) {
  const d = path.join(TMP_ROOT, `${tag}-${Math.floor(process.hrtime()[1] / 7)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Captura de logs inyectable: `[brazo, msg]` por línea. */
function captureLog() {
  const lines = [];
  return { lines, fn: (brazo, msg) => lines.push(`${brazo}|${msg}`) };
}

function resetCache() {
  _clearIssueRoutingCachesForTest();
}

// =============================================================================
// CA-R1 — invalidación explícita, sobre la clave canónica
// =============================================================================

test('CA-R1: invalidateIssueLabels borra la entrada sembrada con clave numérica', () => {
  resetCache();
  _setIssueInfoForTest(5863, { labels: ['needs-human'], state: 'OPEN' });
  assert.ok(_peekIssueInfoForTest(5863), 'precondición: la entrada existe');

  // El punto del helper: invalidar pasando el identificador como STRING debe
  // borrar la entrada sembrada como NUMBER. Sin `issueCacheKey`, esto es el
  // NO-OP silencioso de guru-R1.
  assert.equal(invalidateIssueLabels('5863'), true);
  assert.equal(_peekIssueInfoForTest(5863), undefined);
  assert.equal(_peekIssueInfoForTest('5863'), undefined);
});

test('CA-R1: invalidateIssueLabels borra la entrada sembrada con clave string', () => {
  resetCache();
  _setIssueInfoForTest('5863', { labels: ['Ready'], state: 'OPEN' });
  assert.ok(_peekIssueInfoForTest('5863'));

  assert.equal(invalidateIssueLabels(5863), true);
  assert.equal(_peekIssueInfoForTest('5863'), undefined);
});

test('CA-R1: invalidateIssueLabels sobre un issue sin entrada devuelve false', () => {
  resetCache();
  assert.equal(invalidateIssueLabels(999999), false);
});

test('CA-R1: invalidateAllIssueLabels vacía el Map y devuelve la cantidad borrada', () => {
  resetCache();
  _setIssueInfoForTest(1, { labels: ['a'], state: 'OPEN' });
  _setIssueInfoForTest(2, { labels: ['b'], state: 'OPEN' });
  _setIssueInfoForTest(3, { labels: ['c'], state: 'OPEN' });

  assert.equal(invalidateAllIssueLabels(), 3);
  assert.equal(_peekIssueInfoForTest(1), undefined);
  assert.equal(_peekIssueInfoForTest(2), undefined);
  assert.equal(_peekIssueInfoForTest(3), undefined);
  assert.equal(invalidateAllIssueLabels(), 0, 'segunda pasada: nada que borrar');
});

// =============================================================================
// CA-R2 — toda mutación de labels del pipeline invalida
// =============================================================================

test('CA-R2: enqueueLabelOrder escribe la orden Y deja la entrada invalidada (label)', () => {
  resetCache();
  const queueDir = tmpDir('q-label');
  _setIssueInfoForTest(5863, { labels: ['Ready'], state: 'OPEN' });

  const orderFile = enqueueLabelOrder({
    issue: 5863, label: 'needs-human', tag: 'test-apply', queueDir,
  });

  const written = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  assert.deepEqual(written, { action: 'label', issue: 5863, label: 'needs-human' });
  assert.equal(_peekIssueInfoForTest(5863), undefined, 'la caché quedó invalidada');
});

test('CA-R2: enqueueLabelOrder invalida también en remove-label', () => {
  resetCache();
  const queueDir = tmpDir('q-remove');
  _setIssueInfoForTest(5863, { labels: ['needs-human'], state: 'OPEN' });

  const orderFile = enqueueLabelOrder({
    issue: '5863', label: 'needs-human', action: 'remove-label', tag: 'test-rm', queueDir,
  });

  const written = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  assert.equal(written.action, 'remove-label');
  assert.equal(written.issue, 5863, 'el issue se serializa numérico');
  assert.equal(_peekIssueInfoForTest(5863), undefined);
});

test('CA-R2: enqueueLabelOrder propaga los campos extra a la orden', () => {
  resetCache();
  const queueDir = tmpDir('q-extra');
  const orderFile = enqueueLabelOrder({
    issue: 5863,
    label: 'qa:pending',
    tag: 'test-extra',
    queueDir,
    extra: { marker_path: 'X', marker_mtime: 123 },
  });
  const written = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  assert.equal(written.marker_path, 'X');
  assert.equal(written.marker_mtime, 123);
});

test('R2: enqueueLabelOrder con target:"pr" NO invalida (el número es de un PR)', () => {
  resetCache();
  const queueDir = tmpDir('q-pr');
  // 6055 es un PR. Si el helper invalidara, borraría la caché del ISSUE 6055,
  // que es otro objeto distinto — corromper por homonimia.
  _setIssueInfoForTest(6055, { labels: ['Ready'], state: 'OPEN' });

  enqueueLabelOrder({
    issue: 6055, label: 'qa:passed', tag: 'test-pr', queueDir, extra: { target: 'pr' },
  });

  const cached = _peekIssueInfoForTest(6055);
  assert.ok(cached, 'la entrada del issue homónimo sigue intacta');
  assert.deepEqual(cached.labels, ['Ready']);
});

// =============================================================================
// CA-R3 / R6 — marker append-only escrito por servicio-github.js
// =============================================================================

test('CA-R3: logLabelApplied usa append — dos llamadas dejan dos líneas y la primera sobrevive', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }

  assert.equal(logLabelApplied({ issue: 111, label: 'needs-human', action: 'label' }), true);
  assert.equal(logLabelApplied({ issue: 222, label: 'Ready', action: 'label' }), true);

  const lines = fs.readFileSync(LABELS_APPLIED_LOG, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'append, no writeFileSync');
  assert.equal(JSON.parse(lines[0]).issue, 111, 'la primera línea sobrevivió');
  assert.equal(JSON.parse(lines[1]).issue, 222);
});

test('CA-R3: logLabelApplied NO registra órdenes descartadas ni de PR', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }

  assert.equal(logLabelApplied({ issue: 333, label: 'x', discarded: 'stale-mtime' }), false);
  assert.equal(logLabelApplied({ issue: 6055, label: 'qa:passed', target: 'pr' }), false);
  assert.equal(logLabelApplied({ issue: 'no-numerico', label: 'x' }), false);

  assert.equal(fs.existsSync(LABELS_APPLIED_LOG), false, 'no se creó el marker');
});

/**
 * Cliente `gh` falso, JS puro: registra las ediciones y nunca sale a la red.
 * `getIssueLabels` es obligatorio para el camino de reconciliación.
 */
function fakeGhClient(currentLabels = []) {
  const edited = [];
  return {
    edited,
    editIssue: (issue, opts) => { edited.push({ issue, ...opts }); },
    editPullRequest: (issue, opts) => { edited.push({ pr: issue, ...opts }); },
    getIssueLabels: () => currentLabels.slice(),
    getPrLabels: () => currentLabels.slice(),
    listLabels: () => [{ name: 'qa:passed' }, { name: 'qa:failed' }, { name: 'qa:pending' }],
  };
}

test('R6: orden de gate por el camino de RECONCILIACIÓN deja línea en el marker', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }

  // `applyGateLabelAction` devuelve `true` y el `switch` del worker hace `break`
  // ANTES del final del `case`: si el marker se escribiera sólo al final del
  // `case`, los labels de gate se escaparían sin dejar rastro para el Pulpo.
  const gh = fakeGhClient(['qa:pending']);
  const applied = applyGateLabelAction({ action: 'label', issue: 4572, label: 'qa:passed' }, gh);

  assert.equal(applied, true, 'el gate cortocircuitó el switch');
  assert.ok(gh.edited.length > 0, 'se aplicó al menos un label');
  assert.ok(fs.existsSync(LABELS_APPLIED_LOG), 'el marker se escribió igual');
  const issues = fs.readFileSync(LABELS_APPLIED_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l).issue);
  assert.ok(issues.includes(4572));
});

test('R6: orden de gate por el camino gate_reconciler (early-return) deja línea en el marker', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }

  // Ramal aún más fácil de olvidar: retorna ANTES del bucle de reconciliación.
  // Es el camino de las órdenes que encola el gate 0 del Pulpo, o sea el de
  // mayor volumen del pipeline.
  const gh = fakeGhClient();
  const applied = applyGateLabelAction(
    { action: 'label', issue: 4573, label: 'qa:passed', gate_reconciler: true },
    gh,
  );

  assert.equal(applied, true);
  const lines = fs.readFileSync(LABELS_APPLIED_LOG, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).issue, 4573);
  assert.equal(JSON.parse(lines[0]).action, 'label');
});

test('R6/R2: orden de gate sobre un PR NO deja línea en el marker', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }

  // El número es de un PR: invalidar `issueLabelsCache` con él corrompería la
  // entrada del issue homónimo. El filtro vive del lado del servicio también.
  const gh = fakeGhClient();
  applyGateLabelAction(
    { action: 'label', issue: 6055, label: 'qa:passed', target: 'pr', gate_reconciler: true },
    gh,
  );

  assert.equal(fs.existsSync(LABELS_APPLIED_LOG), false, 'ninguna línea para un PR');
});

test('CA-R3: el ciclo completo cierra — servicio aplica, Pulpo drena e invalida', () => {
  try { fs.unlinkSync(LABELS_APPLIED_LOG); } catch { /* no existía */ }
  resetCache();
  _resetLabelsAppliedOffsetForTest();

  // Escenario del incidente del 12/08, pero al revés: la mutación la aplica el
  // OTRO proceso y el Pulpo tiene que enterarse sin esperar el TTL de 10 min.
  _setIssueInfoForTest(5863, { labels: ['needs-human'], state: 'OPEN' });

  const gh = fakeGhClient();
  applyGateLabelAction(
    { action: 'remove-label', issue: 5863, label: 'qa:pending', gate_reconciler: true },
    gh,
  );

  assert.ok(_peekIssueInfoForTest(5863), 'antes del drenaje el Pulpo sigue viendo lo viejo');
  assert.equal(_drainLabelsAppliedMarker(LABELS_APPLIED_LOG), 1);
  assert.equal(_peekIssueInfoForTest(5863), undefined, 'el Pulpo se enteró vía marker');
});

// =============================================================================
// CA-R3 / CA-R7 / R7 — drenaje del marker
// =============================================================================

/** Escribe líneas en un marker de test (append), devolviendo su path. */
function writeMarker(dir, entries, { append = true } = {}) {
  const p = path.join(dir, 'labels-applied.jsonl');
  const body = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  if (append) fs.appendFileSync(p, body); else fs.writeFileSync(p, body);
  return p;
}

test('CA-R3: el drenaje invalida sólo las líneas nuevas; la segunda corrida devuelve 0', () => {
  resetCache();
  _resetLabelsAppliedOffsetForTest();
  const dir = tmpDir('drain-inc');
  const marker = writeMarker(dir, [
    { ts: 'x', issue: 701, label: 'needs-human', action: 'remove-label' },
    { ts: 'x', issue: 702, label: 'Ready', action: 'label' },
  ]);

  _setIssueInfoForTest(701, { labels: ['needs-human'], state: 'OPEN' });
  _setIssueInfoForTest(702, { labels: [], state: 'OPEN' });

  assert.equal(_drainLabelsAppliedMarker(marker), 2);
  assert.equal(_peekIssueInfoForTest(701), undefined);
  assert.equal(_peekIssueInfoForTest(702), undefined);

  // Sin escrituras nuevas no se relee nada: el offset ya está al final.
  _setIssueInfoForTest(701, { labels: ['Ready'], state: 'OPEN' });
  assert.equal(_drainLabelsAppliedMarker(marker), 0, 'no reprocesa líneas viejas');
  assert.ok(_peekIssueInfoForTest(701), 'la entrada re-sembrada no se tocó');

  // Una línea nueva sí se procesa, y sólo esa.
  writeMarker(dir, [{ ts: 'x', issue: 701, label: 'x', action: 'label' }]);
  assert.equal(_drainLabelsAppliedMarker(marker), 1);
  assert.equal(_peekIssueInfoForTest(701), undefined);
});

test('R7: el drenaje tolera línea corrupta y truncado del archivo', () => {
  resetCache();
  _resetLabelsAppliedOffsetForTest();
  const dir = tmpDir('drain-robust');
  const marker = path.join(dir, 'labels-applied.jsonl');

  fs.appendFileSync(marker, '{"issue":801}\n{ esto no es json\n\n{"issue":802}\n');
  _setIssueInfoForTest(801, { labels: [], state: 'OPEN' });
  _setIssueInfoForTest(802, { labels: [], state: 'OPEN' });

  assert.equal(_drainLabelsAppliedMarker(marker), 2, 'la línea corrupta no aborta el drenaje');
  assert.equal(_peekIssueInfoForTest(801), undefined);
  assert.equal(_peekIssueInfoForTest(802), undefined);

  // Truncado/rotación: el archivo encoge por debajo del offset acumulado. Si el
  // drenaje no lo detectara, leería desde un offset inválido y perdería todo.
  fs.writeFileSync(marker, '{"issue":803}\n');
  _setIssueInfoForTest(803, { labels: [], state: 'OPEN' });
  assert.equal(_drainLabelsAppliedMarker(marker), 1, 'reseteó el offset tras el truncado');
  assert.equal(_peekIssueInfoForTest(803), undefined);
});

test('CA-R3: el drenaje de un marker inexistente no lanza y devuelve 0', () => {
  _resetLabelsAppliedOffsetForTest();
  const marker = path.join(tmpDir('drain-missing'), 'no-existe.jsonl');
  assert.equal(_drainLabelsAppliedMarker(marker), 0);
});

test('CA-R7: el drenaje NO invoca gh (cero lecturas en vivo)', () => {
  resetCache();
  _resetLabelsAppliedOffsetForTest();
  const dir = tmpDir('drain-noapi');
  const marker = writeMarker(dir, [{ ts: 'x', issue: 901, label: 'Ready', action: 'label' }]);
  _setIssueInfoForTest(901, { labels: [], state: 'OPEN' });

  // Doble que hace fallar el test si algo del drenaje sale a la red. El drenaje
  // sólo debe borrar entradas del Map; el refetch lo paga la próxima consulta.
  const cp = require('child_process');
  const origExecSync = cp.execSync;
  const origExecFileSync = cp.execFileSync;
  let ghCalls = 0;
  cp.execSync = () => { ghCalls++; throw new Error('gh no debe invocarse en el drenaje'); };
  cp.execFileSync = () => { ghCalls++; throw new Error('gh no debe invocarse en el drenaje'); };
  try {
    assert.equal(_drainLabelsAppliedMarker(marker), 1);
  } finally {
    cp.execSync = origExecSync;
    cp.execFileSync = origExecFileSync;
  }
  assert.equal(ghCalls, 0, 'el drenaje no llamó a gh');
});

// =============================================================================
// CA-R5 / R4 — ejecución segura de getIssueInfo
// =============================================================================

test('CA-R5: el fetch crudo rechaza identificadores no numéricos ANTES de ejecutar nada', () => {
  for (const malicioso of ['12; rm -rf /', '--repo otro/repo', '5863 && echo PWNED', '', null, undefined]) {
    assert.throws(
      () => _fetchIssueInfoOrThrow(malicioso),
      /identificador de issue no numérico/,
      `debería rechazar: ${String(malicioso)}`,
    );
  }
});

test('CA-R5 / R4: getIssueInfo con identificador no numérico no ejecuta shell y degrada sin lanzar', () => {
  resetCache();
  const cp = require('child_process');
  const origExecSync = cp.execSync;
  const origExecFileSync = cp.execFileSync;
  let spawned = 0;
  cp.execSync = () => { spawned++; return '{}'; };
  cp.execFileSync = () => { spawned++; return '{}'; };

  let info;
  try {
    // R4 — este lector tiene decenas de callers no-gate que asumen que NUNCA
    // lanza. La validación endurece la INVOCACIÓN, no el contrato de errores.
    info = getIssueInfo('12; rm -rf /');
  } finally {
    cp.execSync = origExecSync;
    cp.execFileSync = origExecFileSync;
  }

  assert.deepEqual(info.labels, [], 'objeto degradado, no excepción');
  assert.equal(info.state, 'UNKNOWN');
  assert.equal(spawned, 0, 'no se lanzó ningún proceso con el identificador sucio');
});

test('CA-R5: getIssueInfo sigue sirviendo desde la caché sin salir a la red', () => {
  resetCache();
  _setIssueInfoForTest(5863, { labels: ['Ready', 'area:pipeline'], state: 'OPEN' });
  const info = getIssueInfo(5863);
  assert.deepEqual(info.labels, ['Ready', 'area:pipeline']);
  assert.equal(info.state, 'OPEN');
});

// =============================================================================
// CA-R4 / R1 — reconciliación del estado visible
// =============================================================================

/**
 * Fake de `human-block` que hace las operaciones de FS reales sobre un temp dir,
 * replicando la semántica de la lib:
 *   - `dismissBlockedIssue` BORRA marker + `.reason.json`, sin mover nada;
 *   - `unblockIssue` RENOMBRA el marker a `pendiente/<issue>.<skill>`.
 * Tener las dos permite afirmar que el código elige la correcta (R1).
 */
function fakeHumanBlock(baseDir, issue, skill) {
  const blockedDir = path.join(baseDir, 'bloqueado-humano');
  const pendienteDir = path.join(baseDir, 'pendiente');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendienteDir, { recursive: true });

  const markerFile = path.join(blockedDir, `${issue}.${skill}`);
  const reasonFile = markerFile + '.reason.json';
  const workFile = path.join(pendienteDir, `${issue}.${skill}`);

  const calls = { dismiss: [], unblock: [] };
  return {
    markerFile, reasonFile, workFile, pendienteDir, calls,
    findBlockedMarker: () => (fs.existsSync(markerFile)
      ? { pipeline: 'desarrollo', phase: 'dev', skill, file: markerFile }
      : null),
    dismissBlockedIssue: (opts) => {
      calls.dismiss.push(opts);
      try { fs.unlinkSync(markerFile); } catch {}
      try { fs.unlinkSync(reasonFile); } catch {}
      return { ok: true };
    },
    unblockIssue: (opts) => {
      calls.unblock.push(opts);
      fs.renameSync(markerFile, workFile); // el movimiento que R1 prohíbe
      return { ok: true };
    },
  };
}

test('CA-R4/R1: marker huérfano → se borra marker + .reason.json y pendiente/ queda con UN work-file', () => {
  const base = tmpDir('recon-ok');
  const hb = fakeHumanBlock(base, 5863, 'pipeline-dev');

  // Estado previo: el issue quedó marcado en bloqueado-humano/ en un barrido
  // anterior, y AHORA el intake ya generó un work-file fresco en pendiente/ que
  // el barrido está evaluando en este mismo momento.
  fs.writeFileSync(hb.markerFile, '');
  fs.writeFileSync(hb.reasonFile, JSON.stringify({ issue: 5863, reason: 'viejo' }));
  fs.writeFileSync(hb.workFile, 'issue: 5863\n');

  const logs = captureLog();
  const reconciled = _reconcileHumanBlockMarker(5863, hb.workFile, {
    findBlockedMarker: hb.findBlockedMarker,
    dismissBlockedIssue: hb.dismissBlockedIssue,
    logFn: logs.fn,
  });

  assert.equal(reconciled, true);
  assert.equal(fs.existsSync(hb.markerFile), false, 'marker borrado');
  assert.equal(fs.existsSync(hb.reasonFile), false, '.reason.json borrado');

  // R1 — la invariante que rompía `unblockIssue()`: el work-file activo sigue
  // siendo UNO solo. Un renameSync del marker habría creado un segundo archivo
  // con el mismo nombre (o pisado el activo) y el issue se despacharía dos veces.
  const enPendiente = fs.readdirSync(hb.pendienteDir).filter(f => f.startsWith('5863.'));
  assert.deepEqual(enPendiente, ['5863.pipeline-dev'], 'un solo work-file en pendiente/');
  assert.equal(fs.readFileSync(hb.workFile, 'utf8'), 'issue: 5863\n', 'no fue pisado');

  assert.equal(hb.calls.unblock.length, 0, 'NO se usó unblockIssue (R1)');
  assert.equal(hb.calls.dismiss.length, 1);
});

test('CA-R4: la trazabilidad del destrabe registra github:label-removed', () => {
  const base = tmpDir('recon-trace');
  const hb = fakeHumanBlock(base, 5863, 'pipeline-dev');
  fs.writeFileSync(hb.markerFile, '');
  fs.writeFileSync(hb.reasonFile, '{}');
  fs.writeFileSync(hb.workFile, '');

  _reconcileHumanBlockMarker(5863, hb.workFile, {
    findBlockedMarker: hb.findBlockedMarker,
    dismissBlockedIssue: hb.dismissBlockedIssue,
    logFn: () => {},
  });

  const [opts] = hb.calls.dismiss;
  assert.equal(opts.unlocker, 'github:label-removed',
    'distinguible de commander:telegram y del auto-destrabe por deps');
  assert.equal(opts.issue, 5863);
  assert.match(opts.reason, /#5863/, 'el motivo cita el issue del fix');
  assert.match(opts.reason, /removido en GitHub/);
});

test('CA-R4: sin marker previo no falla ni loguea error', () => {
  const logs = captureLog();
  const reconciled = _reconcileHumanBlockMarker(5863, '/tmp/whatever/5863.pipeline-dev', {
    findBlockedMarker: () => null,
    dismissBlockedIssue: () => { throw new Error('no debería invocarse'); },
    logFn: logs.fn,
  });

  assert.equal(reconciled, false);
  assert.deepEqual(logs.lines, [], 'silencio: no hay nada que reconciliar');
});

test('CA-R4/R1: si el marker encontrado ES el work-file activo, no se toca nada', () => {
  const base = tmpDir('recon-same');
  const hb = fakeHumanBlock(base, 5863, 'pipeline-dev');
  fs.writeFileSync(hb.markerFile, 'contenido vivo');

  // Caso degenerado: `findBlockedMarker` devuelve el mismísimo archivo que el
  // barrido está evaluando. Borrarlo destruiría trabajo en curso.
  const reconciled = _reconcileHumanBlockMarker(5863, hb.markerFile, {
    findBlockedMarker: hb.findBlockedMarker,
    dismissBlockedIssue: hb.dismissBlockedIssue,
    logFn: () => {},
  });

  assert.equal(reconciled, false);
  assert.equal(hb.calls.dismiss.length, 0, 'no se invocó el destrabe');
  assert.equal(fs.readFileSync(hb.markerFile, 'utf8'), 'contenido vivo');
});

test('CA-R4: un fallo del destrabe se traga y loguea — no puede frenar el despacho', () => {
  const logs = captureLog();
  const reconciled = _reconcileHumanBlockMarker(5863, '/tmp/x/5863.pipeline-dev', {
    findBlockedMarker: () => ({ file: '/tmp/otro/5863.pipeline-dev', skill: 'pipeline-dev' }),
    dismissBlockedIssue: () => { throw new Error('EBUSY'); },
    logFn: logs.fn,
  });

  assert.equal(reconciled, false, 'degrada, no propaga');
  assert.equal(logs.lines.length, 1);
  assert.match(logs.lines[0], /no se pudo reconciliar/);
  assert.match(logs.lines[0], /EBUSY/);
});

// =============================================================================
// CA-R6 — el residual no reabre el gate de #5856
// =============================================================================

test('CA-R6: los tres desenlaces del gate needs-human siguen intactos', () => {
  const noop = { invalidateCache: () => {}, logFn: () => {} };

  assert.equal(
    pulpo._verifyHumanBlockLive('5863', { ...noop, readLiveLabels: () => ['needs-human'] }).estado,
    'PRESENTE',
  );
  assert.equal(
    pulpo._verifyHumanBlockLive('5863', { ...noop, readLiveLabels: () => ['Ready'] }).estado,
    'AUSENTE',
  );
  assert.equal(
    pulpo._verifyHumanBlockLive('5863', { ...noop, readLiveLabels: () => { throw new Error('gh caído'); } }).estado,
    'NO_VERIFICABLE',
  );

  // Fail-closed: sólo AUSENTE libera.
  assert.equal(pulpo._shouldReblockForHuman('5863', { ...noop, readLiveLabels: () => { throw new Error('x'); } }), true);
  assert.equal(pulpo._shouldReblockForHuman('5863', { ...noop, readLiveLabels: () => ['Ready'] }), false);
});

test('CA-R6: el default de invalidateCache del gate sigue borrando de la caché real', () => {
  resetCache();
  _setIssueInfoForTest(5863, { labels: ['needs-human'], state: 'OPEN' });

  // Sin `invalidateCache` inyectado: el default es `invalidateIssueLabels(issue)`.
  // Si el renombre mecánico hubiera roto la clave canónica, la entrada quedaría.
  pulpo._verifyHumanBlockLive('5863', {
    readLiveLabels: () => ['Ready'],
    logFn: () => {},
  });

  assert.equal(_peekIssueInfoForTest(5863), undefined, 'el default invalidó de verdad');
});

test('CA-R6: _readLiveLabelsOrThrow sigue propagando el error (sostén del fail-closed)', () => {
  assert.throws(
    () => pulpo._readLiveLabelsOrThrow('5863 & echo PWNED'),
    /identificador de issue no numérico/,
    'no agregar catch: el gate depende de que este helper lance',
  );
});

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

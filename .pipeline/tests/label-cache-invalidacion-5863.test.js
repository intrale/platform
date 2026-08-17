// =============================================================================
// label-cache-invalidacion-5863.test.js — Residual de #5863.
//
// #5856 cerró el GATE (`needs-human` revalida en vivo antes de re-bloquear).
// Esta suite cubre lo que quedó abierto: la caché de labels del Pulpo
// (`LABELS_CACHE_TTL_MS` = 10 min) nunca se invalidaba cuando el propio pipeline
// mutaba labels, y el Pulpo no se enteraba de las mutaciones que aplica
// `servicio-github.js` en OTRO proceso. Mientras esa foto vieja siguiera viva,
// el barrido decidía con un mundo que ya no existía.
//
// Criterios de aceptación cubiertos:
//   CA-R1: invalidación por issue y total, sobre la clave canónica.
//   CA-R2: encolar una orden de label/remove-label invalida el issue afectado.
//   CA-R3: la aplicación efectiva en el otro proceso viaja por un marker
//          append-only que el Pulpo drena por offset (y que soporta rotación,
//          líneas parciales y líneas corruptas).
//   CA-R5: `getIssueInfo()` no interpola el identificador en un shell.
//   CA-R7: la invalidación no agrega lecturas a GitHub.
//
// CA-R4 (reconciliación del marker de `bloqueado-humano/`) y CA-R6 (no regresión
// del gate de #5856) se verifican en `rebloqueo-fantasma-needs-human.test.js` y
// en la inspección de wiring de más abajo, que no requiere levantar el barrido.
//
// Ejecución: `node --test .pipeline/tests/label-cache-invalidacion-5863.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));
const labelMutationLog = require(path.join(__dirname, '..', 'lib', 'label-mutation-log.js'));

const {
  invalidateIssueLabels,
  invalidateAllIssueLabels,
  encolarOrdenGithub,
  _setIssueInfoForTest,
  _peekIssueInfoForTest,
  _clearIssueRoutingCachesForTest,
} = pulpo;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// CA-R1 — invalidación explícita
// -----------------------------------------------------------------------------

test('CA-R1 la invalidación por issue borra la entrada, con clave numérica o string', () => {
  _clearIssueRoutingCachesForTest();

  // Sembrada con NÚMERO, invalidada con STRING: el bug original de #5856 CA-5
  // era exactamente esta asimetría, que volvía la invalidación un no-op mudo.
  _setIssueInfoForTest(5863, { labels: ['needs-human'], state: 'OPEN' });
  assert.ok(_peekIssueInfoForTest(5863), 'precondición: la entrada existe');

  assert.equal(invalidateIssueLabels('5863'), true, 'debe reportar que borró algo');
  assert.equal(_peekIssueInfoForTest(5863), undefined, 'la entrada ya no está');

  // Sembrada con STRING, invalidada con NÚMERO: simetría inversa.
  _setIssueInfoForTest('5863', { labels: ['Ready'], state: 'OPEN' });
  assert.equal(invalidateIssueLabels(5863), true);
  assert.equal(_peekIssueInfoForTest('5863'), undefined);
});

test('CA-R1 invalidar un issue ausente es un no-op que no lanza', () => {
  _clearIssueRoutingCachesForTest();
  assert.equal(invalidateIssueLabels(999999), false);
  assert.equal(invalidateIssueLabels(null), false);
  assert.equal(invalidateIssueLabels(undefined), false);
});

test('CA-R1 la invalidación total limpia todas las entradas y reporta cuántas', () => {
  _clearIssueRoutingCachesForTest();
  _setIssueInfoForTest(1, { labels: ['a'], state: 'OPEN' });
  _setIssueInfoForTest(2, { labels: ['b'], state: 'OPEN' });
  _setIssueInfoForTest(3, { labels: ['c'], state: 'OPEN' });

  assert.equal(invalidateAllIssueLabels(), 3);
  assert.equal(_peekIssueInfoForTest(1), undefined);
  assert.equal(_peekIssueInfoForTest(2), undefined);
  assert.equal(_peekIssueInfoForTest(3), undefined);
  assert.equal(invalidateAllIssueLabels(), 0, 'idempotente sobre caché vacía');
});

// -----------------------------------------------------------------------------
// CA-R2 — el encolado invalida
// -----------------------------------------------------------------------------

test('CA-R2 encolar `label` escribe la orden E invalida el issue', () => {
  _clearIssueRoutingCachesForTest();
  const dir = tmpDir('enc-label-');
  try {
    _setIssueInfoForTest(4242, { labels: [], state: 'OPEN' });
    const file = path.join(dir, 'orden.json');

    encolarOrdenGithub(file, { action: 'label', issue: 4242, label: 'needs-human' });

    const escrito = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(escrito, { action: 'label', issue: 4242, label: 'needs-human' },
      'la orden debe llegar íntegra a la cola');
    assert.equal(_peekIssueInfoForTest(4242), undefined,
      'la caché del issue mutado no puede sobrevivir al encolado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R2 encolar `remove-label` también invalida', () => {
  _clearIssueRoutingCachesForTest();
  const dir = tmpDir('enc-rm-');
  try {
    _setIssueInfoForTest(4243, { labels: ['needs-definition'], state: 'OPEN' });
    encolarOrdenGithub(path.join(dir, 'o.json'),
      { action: 'remove-label', issue: 4243, label: 'needs-definition' });
    assert.equal(_peekIssueInfoForTest(4243), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R2 una orden que NO muta labels deja la caché intacta', () => {
  _clearIssueRoutingCachesForTest();
  const dir = tmpDir('enc-comment-');
  try {
    _setIssueInfoForTest(4244, { labels: ['Ready'], state: 'OPEN' });
    encolarOrdenGithub(path.join(dir, 'o.json'),
      { action: 'comment', issue: 4244, body: 'hola' });
    assert.ok(_peekIssueInfoForTest(4244),
      'un comentario no cambia labels: invalidar sería costo de API gratuito (CA-R7)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R2 una orden dirigida a un PR no invalida la caché de issues', () => {
  _clearIssueRoutingCachesForTest();
  const dir = tmpDir('enc-pr-');
  try {
    // El número de un PR y el de un issue viven en el mismo espacio de nombres
    // en GitHub. Invalidar por número al mutar un PR borraría la entrada de un
    // issue distinto que casualmente comparte número.
    _setIssueInfoForTest(6046, { labels: ['Ready'], state: 'OPEN' });
    encolarOrdenGithub(path.join(dir, 'o.json'),
      { action: 'label', issue: 6046, target: 'pr', label: 'qa:passed' });
    assert.ok(_peekIssueInfoForTest(6046));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R2 todas las órdenes de label del pulpo pasan por el helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
  // Un `writeFileSync` con un payload de label es, por construcción, un encolado
  // que se saltea la invalidación. Este assert es el que impide que la próxima
  // ruta de bloqueo reintroduzca el bug por copy-paste del patrón viejo.
  const crudos = src.match(/fs\.writeFileSync\([^;]*?action:\s*'(?:label|remove-label)'/gs) || [];
  assert.deepEqual(crudos, [],
    `hay ${crudos.length} encolado(s) de label con writeFileSync crudo — usar encolarOrdenGithub()`);
});

// -----------------------------------------------------------------------------
// CA-R3 — marker append-only cross-proceso
// -----------------------------------------------------------------------------

test('CA-R3 registrar y drenar devuelve los issues mutados una sola vez', () => {
  const dir = tmpDir('mut-log-');
  try {
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 100, label: 'needs-human', action: 'label' });
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 101, label: 'needs-human', action: 'remove-label' });

    const primera = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(primera.issues, [100, 101]);

    const segunda = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(segunda.issues, [], 'el cursor no puede reentregar lo ya drenado');

    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 102, label: 'Ready', action: 'label' });
    const tercera = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(tercera.issues, [102], 'sólo el tramo nuevo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 el registro es append-only (no pisa lo previo)', () => {
  const dir = tmpDir('mut-append-');
  try {
    for (let i = 1; i <= 5; i++) {
      labelMutationLog.recordApplied({ pipelineDir: dir, issue: i, label: 'x', action: 'label' });
    }
    const raw = fs.readFileSync(labelMutationLog.logPath(dir), 'utf8');
    const lineas = raw.split('\n').filter(Boolean);
    assert.equal(lineas.length, 5, 'las 5 mutaciones deben coexistir en el archivo');
    assert.deepEqual(lineas.map(l => JSON.parse(l).issue), [1, 2, 3, 4, 5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 una línea parcial (escritor concurrente) se deja para el próximo drenado', () => {
  const dir = tmpDir('mut-parcial-');
  try {
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 200, label: 'x', action: 'label' });
    // Simular un append a medio camino: sin el '\n' final.
    fs.appendFileSync(labelMutationLog.logPath(dir), '{"issue":201,"action":"lab');

    const primera = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(primera.issues, [200], 'la línea incompleta no se consume');

    // El escritor termina su línea.
    fs.appendFileSync(labelMutationLog.logPath(dir), 'el","target":"issue"}\n');
    const segunda = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(segunda.issues, [201], 'ahora sí, completa');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 una línea corrupta se saltea sin frenar el drenado', () => {
  const dir = tmpDir('mut-corrupta-');
  try {
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 300, label: 'x', action: 'label' });
    fs.appendFileSync(labelMutationLog.logPath(dir), 'esto no es json\n');
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 301, label: 'x', action: 'label' });

    const r = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(r.issues, [300, 301],
      'una línea ilegible no puede costar las mutaciones que vienen después');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 tras una rotación el cursor reinicia en vez de quedar mudo', () => {
  const dir = tmpDir('mut-rot-');
  try {
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 400, label: 'x', action: 'label' });
    labelMutationLog.drainNewIssues({ pipelineDir: dir }); // cursor avanzado

    // Rotación: el archivo activo pasa a ser uno nuevo y más chico que el cursor.
    fs.renameSync(labelMutationLog.logPath(dir), labelMutationLog.logPath(dir) + '.1');
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 401, label: 'x', action: 'label' });

    const r = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.equal(r.rotated, true, 'debe reconocer la rotación');
    assert.deepEqual(r.issues, [401],
      'sin el reinicio del cursor, las mutaciones post-rotación quedarían invisibles para siempre');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 las mutaciones sobre PRs no se propagan a la caché de issues', () => {
  const dir = tmpDir('mut-pr-');
  try {
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 500, label: 'qa:passed', action: 'label', target: 'pr' });
    labelMutationLog.recordApplied({ pipelineDir: dir, issue: 501, label: 'Ready', action: 'label' });
    const r = labelMutationLog.drainNewIssues({ pipelineDir: dir });
    assert.deepEqual(r.issues, [501]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 entradas inválidas no se registran y el drenado sin archivo no lanza', () => {
  const dir = tmpDir('mut-inval-');
  try {
    assert.equal(labelMutationLog.drainNewIssues({ pipelineDir: dir }).issues.length, 0);
    assert.equal(labelMutationLog.recordApplied({ pipelineDir: dir, issue: 'abc', action: 'label' }), false);
    assert.equal(labelMutationLog.recordApplied({ pipelineDir: dir, issue: -1, action: 'label' }), false);
    assert.equal(labelMutationLog.recordApplied({ issue: 1, action: 'label' }), false, 'sin pipelineDir');
    assert.equal(fs.existsSync(labelMutationLog.logPath(dir)), false, 'nada inválido llegó al marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-R3 `servicio-github.js` registra sólo después de aplicar de verdad', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'servicio-github.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/label-mutation-log'\)/,
    'el servicio debe cargar el marker');

  // Una orden descartada por stale o bloqueada por gate rompe el switch ANTES de
  // llegar al editor. El registro tiene que quedar después del editor, nunca
  // antes: el marker describe GitHub, no las intenciones de la cola.
  const aplicaAdd = src.indexOf("ghClient.editIssue(data.issue, { addLabel: data.label })");
  const registraAdd = src.indexOf('recordLabelMutation(data.issue, data.label, \'label\'', aplicaAdd);
  assert.ok(aplicaAdd > 0 && registraAdd > aplicaAdd,
    'el registro del add-label va después de aplicarlo');

  const aplicaRm = src.indexOf("ghClient.editIssue(data.issue, { removeLabel: data.label })");
  const registraRm = src.indexOf('recordLabelMutation(data.issue, data.label, \'remove-label\'', aplicaRm);
  assert.ok(aplicaRm > 0 && registraRm > aplicaRm,
    'el registro del remove-label va después de aplicarlo');
});

test('CA-R3 el barrido de lanzamiento drena el marker antes de evaluar los gates', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
  const impl = src.indexOf('function brazoLanzamientoImpl(');
  const drena = src.indexOf('labelMutationLog.drainNewIssues(', impl);
  const gateHuman = src.indexOf("issueLbls.includes('needs-human')", impl);
  const gateDeps = src.indexOf("issueLbls.includes('blocked:dependencies')", impl);

  assert.ok(drena > impl, 'el brazo debe drenar el marker');
  assert.ok(drena < gateDeps && drena < gateHuman,
    'drenar DESPUÉS de los gates no sirve de nada: deciden con la caché vieja');
});

// -----------------------------------------------------------------------------
// CA-R4 — reconciliación del estado visible
// -----------------------------------------------------------------------------

test('CA-R4 la rama AUSENTE reconcilia el marker por la ruta de destrabe existente', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
  const ausente = src.indexOf("label needs-human ya removido en GitHub");
  assert.ok(ausente > 0, 'debe conservar la rama AUSENTE de #5856');

  const finAusente = src.indexOf('const noVerificable =', ausente);
  assert.ok(finAusente > ausente, 'debe ubicar el final de la rama AUSENTE');
  const bloque = src.slice(ausente, finAusente);
  assert.match(bloque, /humanBlock\.findBlockedMarker\(/,
    'debe buscar el marker previo antes de decidir qué hacer con él');
  assert.match(bloque, /humanBlock\.unblockIssue\(/,
    'debe reusar la ruta de destrabe existente, no reimplementarla');
  assert.match(bloque, /unlocker: 'github:label-removed'/,
    'CA-R4 pide trazabilidad de que el destrabe vino de GitHub');
  assert.match(bloque, /reason\.json/,
    'el `.reason.json` huérfano también se limpia');
});

// -----------------------------------------------------------------------------
// CA-R5 — ejecución segura
// -----------------------------------------------------------------------------

test('CA-R5 getIssueInfo no interpola el identificador en un shell', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
  const desde = src.indexOf('function getIssueInfo(');
  const hasta = src.indexOf('function getIssueLabels(', desde);
  const cuerpo = src.slice(desde, hasta);

  assert.ok(desde > 0 && hasta > desde, 'precondición: se ubicó el cuerpo de getIssueInfo');
  assert.doesNotMatch(cuerpo, /execSync\(/,
    'execSync con template string le da a un work-file corrupto ejecución de comandos');
  assert.match(cuerpo, /execFileSync\(/, 'debe invocar gh por argv');
  assert.match(cuerpo, /\/\^\\d\+\$\//, 'debe canonizar el identificador a numérico');
});

test('CA-R5 un identificador no numérico devuelve UNKNOWN sin tocar la red', () => {
  _clearIssueRoutingCachesForTest();
  // `UNKNOWN` (y no `OPEN`) es lo que mantiene fail-closed a los gates que
  // consultan el estado: un identificador ilegible no es un issue abierto.
  const info = pulpo.getIssueInfo('5863 & echo PWNED');
  assert.deepEqual(info.labels, []);
  assert.equal(info.state, 'UNKNOWN');
});

// -----------------------------------------------------------------------------
// CA-R7 — sin costo extra de API
// -----------------------------------------------------------------------------

test('CA-R7 invalidar no dispara lecturas a GitHub', () => {
  _clearIssueRoutingCachesForTest();
  const dir = tmpDir('enc-cost-');
  const originalGh = process.env.GH_BIN_OVERRIDE;
  try {
    _setIssueInfoForTest(7777, { labels: ['x'], state: 'OPEN' });
    // Si la invalidación intentara refrescar, necesitaría `gh`. Apuntamos el
    // binario a algo inexistente: cualquier intento de lectura explotaría.
    process.env.GH_BIN_OVERRIDE = path.join(dir, 'no-existe-gh.exe');

    encolarOrdenGithub(path.join(dir, 'o.json'), { action: 'label', issue: 7777, label: 'y' });
    invalidateIssueLabels(7777);
    invalidateAllIssueLabels();

    assert.equal(_peekIssueInfoForTest(7777), undefined,
      'la invalidación sólo BORRA del Map: el próximo `gh` lo paga quien lo necesite');
  } finally {
    if (originalGh === undefined) delete process.env.GH_BIN_OVERRIDE;
    else process.env.GH_BIN_OVERRIDE = originalGh;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

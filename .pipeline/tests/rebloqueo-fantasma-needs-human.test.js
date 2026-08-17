// =============================================================================
// rebloqueo-fantasma-needs-human.test.js — Re-bloqueo fantasma de `needs-human`
// (#5856).
//
// Contexto: el gate `needs-human` del barrido de lanzamiento actuaba sobre
// `issueLbls`, que sale de una caché con TTL de 10 minutos. Todo destrabe humano
// hecho dentro de esa ventana se revertía solo: el marker volvía a
// `bloqueado-humano/` con un `.reason.json` que afirmaba un label que GitHub ya
// no tenía. La rama `blocked:dependencies` ya revalidaba en vivo desde #4023;
// esta suite cubre la simetría faltante y el fail-closed REAL.
//
// Criterios de aceptación cubiertos:
//   CA-1: caché con el label + GitHub sin el label → NO re-bloquear.
//   CA-2: label vigente en GitHub → re-bloquear igual que hoy (sin regresión).
//   CA-3: lectura en vivo fallida → fail-closed, y el DEFAULT de producción
//         (sin mocks) también falla cerrado. El patrón previo pasaba el test
//         con un mock que lanzaba mientras el default nunca lanzaba.
//   CA-4: el lector en vivo canoniza el identificador y usa argv (anti-inyección).
//   CA-5: la invalidación de caché es efectiva con clave numérica y string.
//   CA-6: los tres desenlaces producen mensajes de log distintos con el #issue.
//   CA-7: ningún mensaje afirma "ya removido en GitHub" sin lectura exitosa.
//
// Diseño: los helpers son inyectables; los casos con mock no tocan red ni
// filesystem. Los dos casos que ejercitan el DEFAULT sí invocan `gh` contra un
// issue inexistente — es justamente lo que hay que probar (CA-3).
//
// Ejecución: `node --test .pipeline/tests/rebloqueo-fantasma-needs-human.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));

const {
  _verifyHumanBlockLive,
  _shouldReblockForHuman,
  _readLiveLabelsOrThrow,
  _shouldReblockForDependencies,
  _setIssueInfoForTest,
  _peekIssueInfoForTest,
  _clearIssueRoutingCachesForTest,
  HUMAN_BLOCK_LABELS,
} = pulpo;

/** Captura de logs inyectable: `[brazo, msg]` por línea. */
function captureLog() {
  const lines = [];
  return { lines, fn: (brazo, msg) => lines.push(`${brazo}|${msg}`) };
}

/** Deps por defecto para los casos con mock: nunca tocan la caché real. */
function deps(overrides = {}) {
  return {
    invalidateCache: () => {},
    readLiveLabels: () => [],
    logFn: () => {},
    ...overrides,
  };
}

// =============================================================================
// CA-1 — destrabe humano respetado
// =============================================================================

test('CA-1: label needs-human en la caché pero removido en GitHub → NO re-bloquear', () => {
  const r = _verifyHumanBlockLive('5708', deps({ readLiveLabels: () => ['Ready', 'qa:passed'] }));
  assert.equal(r.estado, 'AUSENTE');
  assert.equal(r.error, null);
  assert.equal(_shouldReblockForHuman('5708', deps({ readLiveLabels: () => ['Ready'] })), false);
});

test('CA-1: la caché del issue se invalida ANTES de releer en vivo', () => {
  const orden = [];
  _verifyHumanBlockLive('5708', deps({
    invalidateCache: () => orden.push('invalidate'),
    readLiveLabels: () => { orden.push('read'); return []; },
  }));
  assert.deepEqual(orden, ['invalidate', 'read']);
});

test('CA-1: si la invalidación de caché lanza, el flujo sigue (best-effort) y decide por la lectura en vivo', () => {
  const r = _verifyHumanBlockLive('5708', deps({
    invalidateCache: () => { throw new Error('map corrupto'); },
    readLiveLabels: () => [],
  }));
  assert.equal(r.estado, 'AUSENTE');
});

// =============================================================================
// CA-2 — sin regresión del gate cuando el bloqueo es real
// =============================================================================

test('CA-2: label needs-human vigente en GitHub → re-bloquear', () => {
  const r = _verifyHumanBlockLive('5400', deps({ readLiveLabels: () => ['needs-human', 'Ready'] }));
  assert.equal(r.estado, 'PRESENTE');
  assert.equal(r.error, null);
  assert.equal(_shouldReblockForHuman('5400', deps({ readLiveLabels: () => ['needs-human'] })), true);
});

test('CA-2: la variante con dos puntos `needs:human` también se detecta en vivo', () => {
  const r = _verifyHumanBlockLive('5400', deps({ readLiveLabels: () => ['needs:human'] }));
  assert.equal(r.estado, 'PRESENTE');
});

test('CA-2: HUMAN_BLOCK_LABELS cubre exactamente las dos variantes que evalúa el gate', () => {
  assert.deepEqual([...HUMAN_BLOCK_LABELS], ['needs-human', 'needs:human']);
});

// =============================================================================
// CA-3 — fail-closed real, no sólo en el mock
// =============================================================================

test('CA-3: la relectura en vivo lanza → fail-closed (se mantiene el bloqueo)', () => {
  const r = _verifyHumanBlockLive('5723', deps({
    readLiveLabels: () => { throw new Error('gh down'); },
  }));
  assert.equal(r.estado, 'NO_VERIFICABLE');
  assert.match(r.error, /gh down/);
  assert.equal(_shouldReblockForHuman('5723', deps({
    readLiveLabels: () => { throw new Error('gh down'); },
  })), true);
});

test('CA-3: una respuesta que no es array NO se interpreta como destrabe (fail-closed)', () => {
  // Colapsar "respuesta ilegible" en "el label no está" es el defecto que este
  // issue corrige: no hubo lectura exitosa, así que no se puede afirmar nada.
  for (const basura of [null, undefined, 'needs-human', { labels: [] }, 42]) {
    const r = _verifyHumanBlockLive('5723', deps({ readLiveLabels: () => basura }));
    assert.equal(r.estado, 'NO_VERIFICABLE', `payload ${JSON.stringify(basura)} debería ser no verificable`);
  }
});

test('CA-3: el DEFAULT de _shouldReblockForHuman es fail-closed con gh incapaz de resolver el issue', () => {
  // Sin inyectar `readLiveLabels`: ejercita el camino que corre en producción.
  // Con el patrón previo (`getIssueLabels`, que atrapa todo y devuelve []) esto
  // daba `false` — fail-OPEN — con la suite igualmente en verde.
  assert.equal(_shouldReblockForHuman(99999999), true);
});

test('CA-3: el DEFAULT de _shouldReblockForDependencies también es fail-closed (regresión de #4023)', () => {
  assert.equal(_shouldReblockForDependencies(99999999), true);
});

// =============================================================================
// CA-4 — lector en vivo sin inyección de comandos
// =============================================================================

test('CA-4: _readLiveLabelsOrThrow rechaza identificadores no numéricos antes de invocar gh', () => {
  const payloads = [
    '5856 & echo PWNED',
    '5856 && echo PWNED',
    '5856 | echo PWNED',
    '5856; rm -rf /',
    '../../etc/passwd',
    '',
    null,
    undefined,
  ];
  for (const p of payloads) {
    assert.throws(
      () => _readLiveLabelsOrThrow(p),
      /identificador de issue no numérico/,
      `payload ${JSON.stringify(p)} debería rechazarse`,
    );
  }
});

test('CA-4: un identificador no numérico se traduce a fail-closed en el gate', () => {
  const log = captureLog();
  const r = _verifyHumanBlockLive('5856 & echo PWNED', {
    invalidateCache: () => {},
    logFn: log.fn,
  });
  assert.equal(r.estado, 'NO_VERIFICABLE');
  assert.match(r.error, /no numérico/);
});

// =============================================================================
// CA-5 — clave de caché normalizada en ambos extremos
// =============================================================================

// Matriz clave-de-siembra × clave-de-invocación: el bug original era que
// sembrar con `number` e invalidar con `String(...)` no borraba nada, dejando
// la protección de #4023 como un NO-OP silencioso.
for (const claveSiembra of [5856, '5856']) {
  for (const claveInvocacion of [5856, '5856']) {
    const etiqueta = `siembra ${typeof claveSiembra} / invocación ${typeof claveInvocacion}`;

    test(`CA-5: la invalidación por defecto borra la entrada y fuerza relectura (${etiqueta})`, () => {
      _clearIssueRoutingCachesForTest();
      _setIssueInfoForTest(claveSiembra, { labels: ['needs-human'], state: 'OPEN' });
      assert.ok(_peekIssueInfoForTest(claveSiembra), 'precondición: la entrada quedó sembrada');

      let leyoEnVivo = false;
      // Sin inyectar `invalidateCache`: se ejercita el default real del helper.
      const r = _verifyHumanBlockLive(claveInvocacion, {
        readLiveLabels: () => { leyoEnVivo = true; return []; },
        logFn: () => {},
      });

      assert.equal(leyoEnVivo, true, 'debió releer en vivo');
      assert.equal(r.estado, 'AUSENTE');
      assert.equal(
        _peekIssueInfoForTest(claveSiembra), undefined,
        'la entrada stale debió borrarse de la caché',
      );
      _clearIssueRoutingCachesForTest();
    });
  }
}

test('CA-5: clave numérica y clave string apuntan a la MISMA entrada (sin duplicados)', () => {
  _clearIssueRoutingCachesForTest();
  _setIssueInfoForTest(5856, { labels: ['needs-human'], state: 'OPEN' });
  _setIssueInfoForTest('5856', { labels: ['Ready'], state: 'OPEN' });
  // Si las claves no estuvieran normalizadas habría dos entradas distintas y
  // la lectura por number seguiría viendo el label viejo.
  assert.deepEqual(_peekIssueInfoForTest(5856).labels, ['Ready']);
  assert.deepEqual(_peekIssueInfoForTest('5856').labels, ['Ready']);
  _clearIssueRoutingCachesForTest();
});

test('CA-5: _shouldReblockForDependencies invalida con clave canónica (numérica y string)', () => {
  for (const clave of [4023, '4023']) {
    _clearIssueRoutingCachesForTest();
    _setIssueInfoForTest(clave, { labels: ['blocked:dependencies'], state: 'OPEN' });
    let leyoEnVivo = false;
    // Sin inyectar `invalidateCache`: usa el default real.
    const should = _shouldReblockForDependencies(clave, {
      readLiveLabels: () => { leyoEnVivo = true; return []; },
      logFn: () => {},
    });
    assert.equal(leyoEnVivo, true, `clave ${typeof clave}: debió releer en vivo`);
    assert.equal(should, false, `clave ${typeof clave}: label removido en vivo → no re-bloquear`);
  }
  _clearIssueRoutingCachesForTest();
});

// =============================================================================
// CA-6 / CA-7 — tres desenlaces, tres mensajes, ninguno afirma lo no verificado
// =============================================================================

test('CA-6: el fail-closed loguea el issue y el motivo, distinguible del destrabe', () => {
  const log = captureLog();
  _verifyHumanBlockLive('5723', deps({
    readLiveLabels: () => { throw new Error('gh wedged'); },
    logFn: log.fn,
  }));
  assert.equal(log.lines.length, 1);
  const linea = log.lines[0];
  assert.match(linea, /^lanzamiento\|/);
  assert.match(linea, /#5723/);
  assert.match(linea, /no se pudo verificar el label needs-human/);
  assert.match(linea, /fail-closed/);
  assert.match(linea, /#5856/);
});

test('CA-7: el mensaje de fail-closed NUNCA afirma que el label fue removido', () => {
  const log = captureLog();
  _verifyHumanBlockLive('5723', deps({
    readLiveLabels: () => { throw new Error('sin red'); },
    logFn: log.fn,
  }));
  assert.doesNotMatch(log.lines[0], /ya removido/);
  assert.doesNotMatch(log.lines[0], /NO re-bloquear/);
});

test('CA-6: los desenlaces verificados (PRESENTE/AUSENTE) no emiten el log de no-verificable', () => {
  for (const labels of [['needs-human'], ['Ready']]) {
    const log = captureLog();
    _verifyHumanBlockLive('5400', deps({ readLiveLabels: () => labels, logFn: log.fn }));
    assert.equal(log.lines.length, 0, `labels ${JSON.stringify(labels)}: no debe loguear fail-closed`);
  }
});

test('CA-6: los tres desenlaces son mutuamente distinguibles por el campo `estado`', () => {
  const estados = [
    _verifyHumanBlockLive('1', deps({ readLiveLabels: () => ['needs-human'] })).estado,
    _verifyHumanBlockLive('2', deps({ readLiveLabels: () => [] })).estado,
    _verifyHumanBlockLive('3', deps({ readLiveLabels: () => { throw new Error('x'); } })).estado,
  ];
  assert.deepEqual(estados, ['PRESENTE', 'AUSENTE', 'NO_VERIFICABLE']);
  assert.equal(new Set(estados).size, 3);
});

test('CA-6: un logFn que lanza no rompe el gate (logging best-effort)', () => {
  // El pipeline no puede morir por un fallo de logging.
  const r = _verifyHumanBlockLive('5723', deps({
    readLiveLabels: () => { throw new Error('gh down'); },
    logFn: () => { throw new Error('log roto'); },
  }));
  assert.equal(r.estado, 'NO_VERIFICABLE');
});

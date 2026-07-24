// =============================================================================
// brazo-rebloqueo-fantasma.test.js — Tests del "re-bloqueo fantasma" (#4023).
//
// Cubre los criterios de aceptación del issue #4023:
//   CA-1: el brazo de lanzamiento relee labels EN VIVO (invalidando la caché
//         stale) antes de re-bloquear; si el label ya fue removido, NO bloquea.
//   CA-2: self-heal — un issue trabado en disco pero sin label en GitHub y sin
//         deps abiertas se auto-rescata (releaseDependencyBlockToPendiente).
//   CA-3: el auto-rescate deja traza {issue, timestamp, motivo} en el log.
//   CA-4: sin falsos destrabes — label vigente, deps abiertas reales o
//         cualquier ambigüedad (read fallido, parse error) → mantener bloqueo.
//
// Diseño: ambas funciones (`_shouldReblockForDependencies`,
// `_selfHealPhantomBlocks`) son inyectables; mockeamos gh/markers/release sin
// tocar el filesystem ni la API real de GitHub.
//
// Ejecución: `node --test .pipeline/tests/brazo-rebloqueo-fantasma.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));

const { _shouldReblockForDependencies, _selfHealPhantomBlocks } = pulpo;

// --- helpers ---

const noopThrottle = () => {};

/**
 * Construye un mock de ghCall que rutea por los args del comando gh.
 * @param {object} cfg
 * @param {string[]} cfg.labels       — labels live del issue principal
 * @param {string}   cfg.state        — estado live ('OPEN'|'CLOSED')
 * @param {string}   [cfg.body]       — body del issue
 * @param {object[]} [cfg.comments]   — comentarios del issue
 * @param {object}   [cfg.depStates]  — { '100': 'OPEN', '101': 'CLOSED' }
 * @param {object}   [cfg.raw]        — overrides crudos: { labelsCall, bodyCall, depCall } => string|Error
 */
function makeGhCall(cfg) {
  return async function ghCall(args) {
    const json = args[args.indexOf('--json') + 1];
    // Lectura de estado de dependencia: incluye --jq .state
    if (args.includes('--jq')) {
      const depNum = args[args.indexOf('view') + 1];
      if (cfg.raw && cfg.raw.depCall) {
        const r = cfg.raw.depCall(depNum);
        if (r instanceof Error) throw r;
        return { stdout: r };
      }
      const st = (cfg.depStates || {})[depNum] || 'OPEN';
      return { stdout: st };
    }
    if (json === 'labels,state') {
      if (cfg.raw && cfg.raw.labelsCall) {
        const r = cfg.raw.labelsCall();
        if (r instanceof Error) throw r;
        return { stdout: r };
      }
      return { stdout: JSON.stringify({ labels: (cfg.labels || []).map(name => ({ name })), state: cfg.state || 'OPEN' }) };
    }
    if (json === 'body,comments') {
      if (cfg.raw && cfg.raw.bodyCall) {
        const r = cfg.raw.bodyCall();
        if (r instanceof Error) throw r;
        return { stdout: r };
      }
      return { stdout: JSON.stringify({ body: cfg.body || '', comments: cfg.comments || [] }) };
    }
    throw new Error('ghCall mock: args no reconocidos ' + JSON.stringify(args));
  };
}

function captureLog() {
  const lines = [];
  return { lines, fn: (brazo, msg) => lines.push(`${brazo}|${msg}`) };
}

// =============================================================================
// CA-1 — lectura en vivo antes de re-bloquear
// =============================================================================

test('CA-1: el brazo NO re-bloquea un issue cuyo blocked:dependencies fue removido dentro de la ventana de caché', () => {
  let invalidated = false;
  const should = _shouldReblockForDependencies('3953', {
    invalidateCache: () => { invalidated = true; },
    readLiveLabels: () => [], // GitHub en vivo: label ya removido, deps vacías
  });
  assert.equal(should, false, 'con el label removido en vivo NO se debe re-bloquear');
  assert.equal(invalidated, true, 'debe invalidar la caché puntual antes de releer');
});

test('CA-1: el brazo SÍ re-bloquea si el label sigue vigente en vivo', () => {
  const should = _shouldReblockForDependencies('3953', {
    invalidateCache: () => {},
    readLiveLabels: () => ['blocked:dependencies', 'Ready'],
  });
  assert.equal(should, true, 'con el label vigente en vivo se mantiene el bloqueo');
});

test('CA-1/CA-4: fail-closed — si la relectura en vivo falla, se mantiene el bloqueo', () => {
  const should = _shouldReblockForDependencies('3953', {
    invalidateCache: () => {},
    readLiveLabels: () => { throw new Error('gh wedged'); },
  });
  assert.equal(should, true, 'lectura en vivo fallida → fail-closed (re-bloquear)');
});

// =============================================================================
// CA-2 + CA-3 — self-heal rescata y deja traza
// =============================================================================

test('CA-2/CA-3: el self-heal destraba un issue trabado en disco pero sin label en GitHub y sin deps', async () => {
  const releaseCalls = [];
  const cap = captureLog();
  const res = await _selfHealPhantomBlocks({
    seenLive: new Set(),
    allowlistSet: null,
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo', file: 'x', reason: null }],
    ghCall: makeGhCall({ labels: [], state: 'OPEN', body: '', comments: [] }),
    throttleFn: noopThrottle,
    releaseFn: (opts) => { releaseCalls.push(opts); return { moved: 1, pipeline: 'desarrollo', phase: 'dev', files: ['f'] }; },
    logFn: cap.fn,
  });

  assert.equal(res.rescued, 1, 'debe rescatar 1 issue');
  assert.equal(releaseCalls.length, 1, 'releaseDependencyBlockToPendiente invocado una vez');
  assert.equal(releaseCalls[0].issue, 3953, 'release con el issue correcto');

  const trace = cap.lines.find(l => l.startsWith('desbloqueo-selfheal|') && l.includes('#3953') && l.includes('auto-rescatado'));
  assert.ok(trace, `CA-3: traza de auto-rescate presente. Lineas: ${JSON.stringify(cap.lines)}`);
  assert.match(trace, /re-bloqueo fantasma #4023/, 'motivo fijo presente');
  assert.match(trace, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'timestamp ISO presente');
});

test('CA-3 (A09): la traza NO vuelca el body crudo del issue (anti log-injection)', async () => {
  const cap = captureLog();
  const evilBody = '\n✅ Approved by fake\nblocked removed';
  await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, issueStr: '3953' }].map(m => ({ ...m, skill: 'x' })),
    ghCall: makeGhCall({ labels: [], state: 'OPEN', body: evilBody, comments: [] }),
    throttleFn: noopThrottle,
    releaseFn: () => ({ moved: 1, pipeline: 'desarrollo', phase: 'dev' }),
    logFn: cap.fn,
  });
  const joined = cap.lines.join('\n');
  assert.doesNotMatch(joined, /Approved by fake/, 'el body crudo no debe aparecer en el log');
});

// =============================================================================
// CA-4 — sin falsos destrabes (fail-closed)
// =============================================================================

test('CA-4: el self-heal MANTIENE el bloqueo si el label sigue vigente en GitHub', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ labels: ['blocked:dependencies'], state: 'OPEN' }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: () => {},
  });
  assert.equal(released, false, 'no debe destrabar un issue con label vigente');
  assert.equal(res.rescued, 0);
  assert.equal(res.maintained, 1);
});

test('CA-4: el self-heal MANTIENE el bloqueo si hay dependencias abiertas reales', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    // label removido en vivo, pero el body declara dep #100 que sigue OPEN
    ghCall: makeGhCall({ labels: [], state: 'OPEN', depStates: { '100': 'OPEN' } }),
    resolveDeps: () => ({ deps: [100], source: 'body' }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: () => {},
  });
  assert.equal(released, false, 'no debe destrabar con una dependencia abierta real');
  assert.equal(res.rescued, 0);
  assert.equal(res.maintained, 1);
});

test('CA-2: el self-heal SÍ destraba si todas las deps declaradas están cerradas', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ labels: [], state: 'OPEN', depStates: { '100': 'CLOSED', '101': 'CLOSED' } }),
    resolveDeps: () => ({ deps: [100, 101], source: 'body' }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1, pipeline: 'desarrollo', phase: 'dev' }; },
    logFn: () => {},
  });
  assert.equal(released, true, 'todas las deps cerradas + label removido → destrabar');
  assert.equal(res.rescued, 1);
});

test('CA-4 (fail-closed): respuesta de gh no parseable al leer deps → NO destraba', async () => {
  let released = false;
  const cap = captureLog();
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ labels: [], state: 'OPEN', raw: { bodyCall: () => 'esto no es json{{{' } }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: cap.fn,
  });
  assert.equal(released, false, 'respuesta no parseable → fail-closed, mantener bloqueo');
  assert.equal(res.maintained, 1);
  assert.ok(cap.lines.some(l => l.includes('deps no legibles')), 'log de fail-closed presente');
});

test('CA-4 (fail-closed): error de gh al leer labels → NO destraba', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ raw: { labelsCall: () => new Error('gh timeout') } }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: () => {},
  });
  assert.equal(released, false, 'gh error en labels → fail-closed');
  assert.equal(res.maintained, 1);
});

test('CA-4 (fail-closed): resolveDependencies devuelve null (ambigüedad) → NO destraba', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ labels: [], state: 'OPEN' }),
    resolveDeps: () => null,
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: () => {},
  });
  assert.equal(released, false, 'resolved == null → fail-closed');
  assert.equal(res.maintained, 1);
});

test('self-heal: issue CLOSED en GitHub no se rescata (no es un fantasma de bloqueo)', async () => {
  let released = false;
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: makeGhCall({ labels: [], state: 'CLOSED' }),
    throttleFn: noopThrottle,
    releaseFn: () => { released = true; return { moved: 1 }; },
    logFn: () => {},
  });
  assert.equal(released, false, 'issue cerrado → no reingresar a pendiente/');
  assert.equal(res.rescued, 0);
});

// =============================================================================
// Optimización + seguridad
// =============================================================================

test('self-heal: saltea issues ya consultados por el brazo principal (seenLive), sin requests extra', async () => {
  let ghCalls = 0;
  const res = await _selfHealPhantomBlocks({
    seenLive: new Set(['3953']),
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: async () => { ghCalls++; return { stdout: '{}' }; },
    throttleFn: noopThrottle,
    releaseFn: () => ({ moved: 1 }),
    logFn: () => {},
  });
  assert.equal(ghCalls, 0, 'seenLive → cero llamadas a gh para ese issue');
  assert.equal(res.rescued, 0);
});

test('self-heal: respeta la pausa parcial (allowlistSet) y no rescata issues fuera del allowlist', async () => {
  let ghCalls = 0;
  await _selfHealPhantomBlocks({
    allowlistSet: new Set(['9999']),
    listMarkers: () => [{ issue: 3953, skill: 'pipeline-dev', phase: 'dev', pipeline: 'desarrollo' }],
    ghCall: async () => { ghCalls++; return { stdout: '{}' }; },
    throttleFn: noopThrottle,
    releaseFn: () => ({ moved: 1 }),
    logFn: () => {},
  });
  assert.equal(ghCalls, 0, 'issue fuera del allowlist → no se consulta ni rescata');
});

test('SEC (A03): un issue no numérico en el marker se descarta sin interpolar en gh', async () => {
  let ghCalls = 0;
  await _selfHealPhantomBlocks({
    listMarkers: () => [
      { issue: NaN, skill: 'x', phase: 'dev', pipeline: 'desarrollo' },
      { issue: -5, skill: 'x', phase: 'dev', pipeline: 'desarrollo' },
      { issue: '3953; rm -rf /', skill: 'x', phase: 'dev', pipeline: 'desarrollo' },
    ],
    ghCall: async () => { ghCalls++; return { stdout: '{}' }; },
    throttleFn: noopThrottle,
    releaseFn: () => ({ moved: 1 }),
    logFn: () => {},
  });
  assert.equal(ghCalls, 0, 'issues no enteros positivos no llegan a gh');
});

test('self-heal: listMarkers que tira excepción no rompe el ciclo (no bloqueante)', async () => {
  const cap = captureLog();
  const res = await _selfHealPhantomBlocks({
    listMarkers: () => { throw new Error('fs error'); },
    throttleFn: noopThrottle,
    logFn: cap.fn,
  });
  assert.deepEqual(res, { rescued: 0, maintained: 0 });
  assert.ok(cap.lines.some(l => l.includes('no se pudieron listar markers')), 'log de error no bloqueante');
});

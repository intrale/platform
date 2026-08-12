// =============================================================================
// wave-annex-readonly-5835.test.js — `readOnly` de handleWaveStatus (#5835).
//
// El riesgo que cubre: `handleWaveStatus` NO es un render puro — desde #4039
// hace `wave-progress.appendSnapshot`, que escribe un punto en la serie
// temporal que alimenta el ETA. Cada LECTURA del operador es un punto válido de
// esa serie, pero una PREGUNTA ANALÍTICA que sólo menciona la ola no lo es:
// preguntar no es avanzar. Si el anexo de CA-3 usara el camino normal, cada
// pregunta sesgaría el ETA que lee el operador — la misma degradación
// silenciosa que costó #4566.
//
// Los colaboradores se inyectan por `require.cache` porque `handleWaveStatus`
// los resuelve lazy adentro de la función. `node --test` corre cada archivo en
// su propio proceso, así que la inyección no contamina otras suites.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-annex-readonly-5835.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LIB = path.resolve(__dirname, '..');

function injectModule(name, exports) {
    const filename = path.join(LIB, `${name}.js`);
    require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

// Registro de escrituras sobre la serie temporal de progreso.
const appendedSnapshots = [];

injectModule('wave-resolver', {
    resolveActiveWave: () => ({ source: 'waves.json', number: 12, issues: [5835] }),
    resolveBlockDependencies: () => ({}),
});
injectModule('wave-state', { getCachedWaveState: () => ({ issueTitles: {}, issueMatrix: {} }) });
injectModule('wave-snapshot', {
    buildWaveSnapshot: () => ({ totalPct: 42, generatedAt: 1000, etaAvailable: false }),
});
injectModule('wave-renderer', {
    renderWaveSnapshotMessages: () => ['CUADRO DEL HANDLER'],
    renderAudioText: () => 'La ola doce va al cuarenta y dos por ciento.',
});
injectModule('waves', {
    getActiveWave: () => ({ number: 12 }),
    invalidateCache: () => {},
    loadWaves: () => ({}),
});
injectModule('wave-progress', {
    appendSnapshot: (args) => { appendedSnapshots.push(args); },
});
injectModule('eta-wave', { calculateWaveVelocityETA: async () => null });

const commanderDet = require(path.join(LIB, 'commander-deterministic.js'));
const { handleWaveStatus } = commanderDet._waveInternal;

test('readOnly: el render del anexo NO agrega un punto a la serie de progreso', async () => {
    appendedSnapshots.length = 0;
    const res = await handleWaveStatus({ pipelineRoot: '/tmp/pipeline', audio: false, readOnly: true });
    assert.equal(appendedSnapshots.length, 0, 'preguntar no es avanzar: no debe escribir la serie');
    // Y aun así devuelve el cuadro completo: el anexo no pierde información.
    assert.ok(res.reply.includes('CUADRO DEL HANDLER'));
});

test('sin readOnly: la lectura explícita del operador SÍ registra el snapshot (#4039 intacto)', async () => {
    appendedSnapshots.length = 0;
    await handleWaveStatus({ pipelineRoot: '/tmp/pipeline', audio: false });
    assert.equal(appendedSnapshots.length, 1, 'el camino normal de /wave no cambió');
    assert.equal(appendedSnapshots[0].waveKey, 12);
    assert.equal(appendedSnapshots[0].avancePct, 42);
});

test('readOnly: no se genera audioText cuando el anexo pide audio:false', async () => {
    const res = await handleWaveStatus({ pipelineRoot: '/tmp/pipeline', audio: false, readOnly: true });
    assert.equal(res.audioText, null);
});

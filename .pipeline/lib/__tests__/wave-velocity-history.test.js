// =============================================================================
// wave-velocity-history.test.js — #4532
//
// Cobertura del store histórico de velocidad cross-ola: sólo registra muestras
// positivas (robusto a rebotes / `/wave add`), promedia las últimas K muestras
// entre olas y poda por retención/cota. Es la base de que una ola nueva herede
// una estimación previa en vez de mostrar "—".
//
// node --test .pipeline/lib/__tests__/wave-velocity-history.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hist = require('../wave-velocity-history');

function freshRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvh-'));
    hist._internal._resetCounter();
    return dir;
}

test('recordSample sólo persiste muestras positivas y finitas', () => {
    const root = freshRoot();
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 0.5, now: 1000 }), true);
    // Negativas / cero / NaN / infinito se descartan (robusto a rebotes).
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: -0.3, now: 2000 }), false);
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 0, now: 3000 }), false);
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: NaN, now: 4000 }), false);
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: Infinity, now: 5000 }), false);
    // waveKey inválido se descarta.
    assert.equal(hist.recordSample({ pipelineRoot: root, waveKey: 0, velocityPctPerMin: 0.5, now: 6000 }), false);

    const samples = hist.readSamples({ pipelineRoot: root });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].velocityPctPerMin, 0.5);
});

test('getHistoricalVelocity promedia las últimas muestras positivas; null si no hay', () => {
    const root = freshRoot();
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root }), null); // vacío → null

    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 1.0, now: 1000 });
    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 3.0, now: 2000 });
    // Promedio de las dos muestras = 2.0.
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root }), 2.0);
});

test('getHistoricalVelocity puede excluir la ola actual (estimación de olas previas)', () => {
    const root = freshRoot();
    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 2.0, now: 1000 });
    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 2.0, now: 2000 });
    hist.recordSample({ pipelineRoot: root, waveKey: 2, velocityPctPerMin: 9.0, now: 3000 });
    // Excluyendo la ola 2, sólo quedan las muestras de la ola 1 (promedio 2.0).
    assert.equal(hist.getHistoricalVelocity({ pipelineRoot: root, excludeWaveKey: 2 }), 2.0);
});

test('readSamples tolera líneas corruptas y descarta no-positivas persistidas', () => {
    const root = freshRoot();
    const file = hist._internal.storePath(root);
    fs.writeFileSync(file, [
        '{"ts":1000,"waveKey":1,"velocityPctPerMin":1.5}',
        'no-es-json',
        '{"ts":2000,"waveKey":1,"velocityPctPerMin":-2}',   // negativa → descartada
        '{"ts":3000,"waveKey":2,"velocityPctPerMin":2.5}',
        '',
    ].join('\n'));
    const samples = hist.readSamples({ pipelineRoot: root });
    assert.equal(samples.length, 2);
    assert.deepEqual(samples.map((s) => s.velocityPctPerMin), [1.5, 2.5]);
});

test('pruneStore respeta retención temporal', () => {
    const root = freshRoot();
    const now = 1000 * hist.RETENTION_MS; // base grande
    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 1.0, now: now - hist.RETENTION_MS - 1 }); // vieja
    hist.recordSample({ pipelineRoot: root, waveKey: 1, velocityPctPerMin: 2.0, now: now - 1000 }); // reciente
    const res = hist.pruneStore({ pipelineRoot: root, now });
    assert.equal(res.kept, 1);
    const samples = hist.readSamples({ pipelineRoot: root });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].velocityPctPerMin, 2.0);
});

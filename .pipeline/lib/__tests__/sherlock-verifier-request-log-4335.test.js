// =============================================================================
// Tests `sherlock-verifier.verify` — sink de log de corrida opcional (#4335)
//
// Cubre:
//   - Con `requestLog` inyectado, `verify()` emite las etapas `provider` y
//     `verdict` al sink (derivadas del resultado, SEC-3: sólo strings/nums/bools).
//   - Sin el param, back-compat: comportamiento idéntico, sin emisión, mismo
//     verdict devuelto.
//   - Un fallo del sink (throw en `.stage`) NO altera el verdict devuelto.
//
// Se usa el camino `sherlock_enabled:false` (verdict 'skipped') para no depender
// de providers reales: alcanza para verificar que el wrapper emite y es
// back-compat.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const verifier = require('../sherlock-verifier');

const disabledLoader = () => ({ sherlock_enabled: false });

test('con requestLog: verify() emite etapas provider y verdict al sink', async () => {
    const stages = [];
    const requestLog = { stage: (name, meta) => stages.push({ name, meta }) };

    const verdict = await verifier.verify({
        analysis: 'x',
        originalRequest: 'y',
        commanderProvider: 'claude',
        configLoader: disabledLoader,
        requestLog,
    });

    assert.equal(verdict.verdict, 'skipped');
    const names = stages.map(s => s.name);
    assert.ok(names.includes('provider'), 'emite etapa provider');
    assert.ok(names.includes('verdict'), 'emite etapa verdict');

    const verdictStage = stages.find(s => s.name === 'verdict');
    assert.equal(verdictStage.meta.veredicto, 'skipped');
    assert.equal(verdictStage.meta.inconsistencias, 0);
    // SEC-3: los valores son escalares, nunca objetos de config
    for (const s of stages) {
        for (const v of Object.values(s.meta)) {
            assert.ok(['string', 'number', 'boolean'].includes(typeof v), `meta escalar: ${typeof v}`);
        }
    }
});

test('sin requestLog: back-compat, mismo verdict, sin throw', async () => {
    const verdict = await verifier.verify({
        analysis: 'x',
        originalRequest: 'y',
        commanderProvider: 'claude',
        configLoader: disabledLoader,
    });
    assert.equal(verdict.verdict, 'skipped');
});

test('un fallo del sink NO altera el verdict devuelto', async () => {
    const requestLog = { stage: () => { throw new Error('sink roto'); } };
    const verdict = await verifier.verify({
        analysis: 'x',
        originalRequest: 'y',
        commanderProvider: 'claude',
        configLoader: disabledLoader,
        requestLog,
    });
    assert.equal(verdict.verdict, 'skipped');
});

'use strict';
// =============================================================================
// #6745 rev-2 — ANTI-SPOOF DE PROCEDENCIA: el agente no puede auto-eximirse del
// circuit breaker de código escribiendo `rebote_categoria` en su propio YAML.
//
// El anti-spoof de #5641 estaba INVERTIDO: borraba la señal confiable
// (`veredicto_sintetizado_por`) y nunca se la pasaba a `classifyRebote`
// (`grep -n veredictoSintetizadoPorPulpo .pipeline/pulpo.js` daba 0 hits),
// mientras confiaba CRUDO en `rebote_categoria` — que es el campo que rutea,
// porque `esReboteDeInfra` se calcula sobre `veredicto.category`.
//
// Este archivo cubre las dos mitades del cierre:
//   1. el strip (función pura, testeable de verdad);
//   2. el cableado en `pulpo.js` (guard de source, mismo patrón que
//      `credential-death-wiring-6238.test.js` / `effective-model-post-exit-wiring.test.js`).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { stripProcedenciaAgente, CATEGORIAS_SOLO_PULPO } = require('../lib/rebote-classifier');

const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');

// -----------------------------------------------------------------------------
// 1. El strip
// -----------------------------------------------------------------------------

test('strip — borra rebote_categoria cuando el agente declara una categoría solo-Pulpo', () => {
    for (const categoria of CATEGORIAS_SOLO_PULPO) {
        const data = { resultado: 'rechazado', motivo: 'CA-1 incumplido', rebote_categoria: categoria };
        const r = stripProcedenciaAgente(data);
        assert.equal(r.falsificada, true, `${categoria} debe detectarse como falsificada`);
        assert.ok(r.campos.includes('rebote_categoria'));
        assert.equal(data.rebote_categoria, undefined, 'el campo debe quedar borrado');
        // El veredicto de contenido del agente se respeta: sólo cae la procedencia.
        assert.equal(data.resultado, 'rechazado');
        assert.equal(data.motivo, 'CA-1 incumplido');
    }
});

test('strip — la detección es case/space-insensitive como el resto de las categorías', () => {
    const data = { resultado: 'rechazado', rebote_categoria: '  INFRA_AGENT_CRASH ' };
    assert.equal(stripProcedenciaAgente(data).falsificada, true);
    assert.equal(data.rebote_categoria, undefined);
});

test('strip — dependency_block NO se toca: es un hint legítimo del agente (#3229)', () => {
    const data = { resultado: 'rechazado', rebote_categoria: 'dependency_block', depende_de: [123] };
    const r = stripProcedenciaAgente(data);
    assert.equal(r.falsificada, false);
    assert.equal(data.rebote_categoria, 'dependency_block');
    assert.deepEqual(data.depende_de, [123]);
});

test('strip — sigue borrando los dos campos originales de #5641', () => {
    const data = { resultado: 'rechazado', veredicto_sintetizado_por: 'pulpo', agente_exit_code: 1 };
    const r = stripProcedenciaAgente(data);
    assert.equal(r.falsificada, true);
    assert.deepEqual(r.campos.sort(), ['agente_exit_code', 'veredicto_sintetizado_por']);
    assert.equal(data.veredicto_sintetizado_por, undefined);
    assert.equal(data.agente_exit_code, undefined);
});

test('strip — un YAML limpio no se marca como falsificado', () => {
    const data = { resultado: 'aprobado', branch: 'agent/6745-pipeline-dev' };
    const r = stripProcedenciaAgente(data);
    assert.equal(r.falsificada, false);
    assert.deepEqual(r.campos, []);
    assert.deepEqual(data, { resultado: 'aprobado', branch: 'agent/6745-pipeline-dev' });
});

test('strip — es idempotente y defensivo ante entradas basura', () => {
    const data = { resultado: 'rechazado', rebote_categoria: 'infra_no_apk' };
    assert.equal(stripProcedenciaAgente(data).falsificada, true);
    assert.equal(stripProcedenciaAgente(data).falsificada, false, 'segunda pasada: ya no hay nada que borrar');
    for (const basura of [null, undefined, 'texto', 42]) {
        assert.deepEqual(stripProcedenciaAgente(basura), { falsificada: false, campos: [] });
    }
});

test('strip — CATEGORIAS_SOLO_PULPO es inmutable (no se puede ampliar en caliente)', () => {
    assert.ok(Object.isFrozen(CATEGORIAS_SOLO_PULPO));
});

// -----------------------------------------------------------------------------
// 2. El cableado en pulpo.js
// -----------------------------------------------------------------------------

test('wiring — pulpo.js usa el strip compartido en el handler de salida del agente', () => {
    assert.match(
        PULPO_SRC,
        /reboteClassifier\.stripProcedenciaAgente\(data\)/,
        'el anti-spoof debe consumir la función compartida, no una copia inline',
    );
    // El strip va ANTES del `if (!data.resultado)` (CA-2 de #5641): si el agente
    // dejó su propio `resultado`, la rama no entra y los campos sobrevivirían.
    const iStrip = PULPO_SRC.indexOf('reboteClassifier.stripProcedenciaAgente(data)');
    const iIf = PULPO_SRC.indexOf('if (!data.resultado) {', iStrip - 4000 > 0 ? iStrip - 4000 : 0);
    assert.ok(iStrip > 0 && iIf > iStrip, 'el strip debe ejecutarse antes de sintetizar el resultado');
});

test('wiring — pulpo.js cablea veredictoSintetizadoPorPulpo al decisor único', () => {
    // Antes de esta rev el grep daba 0 hits: la señal confiable se borraba y
    // nunca llegaba al classifier, que terminaba confiando crudo en el campo
    // que escribe el agente rechazado.
    assert.match(
        PULPO_SRC,
        /veredictoSintetizadoPorPulpo:\s*m\.veredicto_sintetizado_por === 'pulpo'/,
        'classifyRebote debe recibir la procedencia real del veredicto',
    );
    assert.match(
        PULPO_SRC,
        /veredicto_sintetizado_por:\s*r\.veredicto_sintetizado_por \|\| null/,
        'el motivo clasificado debe propagar la procedencia desde el YAML leído',
    );
});

test('wiring — no quedó una copia inline de la lista de categorías solo-Pulpo', () => {
    assert.ok(
        !/const CATEGORIAS_SOLO_PULPO\s*=/.test(PULPO_SRC),
        'la lista vive en lib/rebote-classifier.js como fuente única',
    );
});

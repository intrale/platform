'use strict';
// =============================================================================
// rebote-classifier.test.js — #5641 CA-7.
//
// La caída del proceso del agente (`Agente terminó con código N`, motivo que
// escribe el propio Pulpo) caía al fallback `code` y consumía rebotes del
// circuit breaker de CÓDIGO que deberían ir al contador de infra.
//
// Se reconoce por HINT ESTRUCTURADO, nunca por el texto del `motivo`: ese campo
// lo escribe el agente. Matchearlo por substring sería un vector de escalada
// (SEC-1) y además agregaría superficie ReDoS. Cero patrones de texto nuevos.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyRebote } = require('./rebote-classifier');

const MOTIVO_CRASH = 'Agente terminó con código 1';

test('CA-7 hint rebote_categoria: infra_agent_crash → infra sin penalizar circuit breaker', () => {
    const r = classifyRebote({ motivo: MOTIVO_CRASH, rebote_categoria: 'infra_agent_crash' });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
    assert.match(r.reason_summary, /Caída del proceso del agente/);
});

test('CA-7 flag de procedencia veredictoSintetizadoPorPulpo → infra', () => {
    const r = classifyRebote({ motivo: MOTIVO_CRASH, veredictoSintetizadoPorPulpo: true });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
});

test('CA-7 el hint es case/space-insensitive como el resto de las categorías', () => {
    const r = classifyRebote({ motivo: '', rebote_categoria: '  INFRA_AGENT_CRASH ' });
    assert.equal(r.category, 'infra');
});

test('CA-7 el hint gana sobre el fallback code', () => {
    // Sin hint, el mismo motivo cae a `code` y SÍ penaliza — ese es el bug.
    const sinHint = classifyRebote({ motivo: MOTIVO_CRASH });
    assert.equal(sinHint.category, 'code');
    assert.equal(sinHint.counts_against_circuit_breaker, true);

    const conHint = classifyRebote({ motivo: MOTIVO_CRASH, veredictoSintetizadoPorPulpo: true });
    assert.equal(conHint.category, 'infra');
});

test('CA-7 el hint gana sobre la heurística de human_block', () => {
    // Un motivo que dispararía `human_block` por regex sigue siendo infra si el
    // veredicto lo sintetizó el Pulpo: el agente nunca llegó a pedir nada.
    const r = classifyRebote({
        motivo: 'requiere merge manual por CODEOWNERS',
        veredictoSintetizadoPorPulpo: true,
    });
    assert.equal(r.category, 'infra');
});

test('SEC-1 el TEXTO del motivo no alcanza: sin hint sigue siendo code', () => {
    // Vector de ataque: un agente que cita el literal en un rechazo de contenido
    // no puede auto-eximirse del circuit breaker.
    for (const motivo of [
        MOTIVO_CRASH,
        '[po] Agente terminó con código 1',
        'CA-1 no se cumple: secret hardcodeado. El log dice: Agente terminó con código 1',
    ]) {
        const r = classifyRebote({ motivo });
        assert.equal(r.category, 'code', `no debe auto-clasificarse por texto: ${motivo}`);
        assert.equal(r.counts_against_circuit_breaker, true);
    }
});

test('anti-ReDoS: no se agregaron patrones de texto para la caída del agente', () => {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'rebote-classifier.js'), 'utf8');
    assert.ok(!/Agente termin/.test(src),
        'el clasificador NO debe contener el literal del motivo (se discrimina por campo)');
});

test('no-regresión: dependency_block y human_block explícitos siguen ganando', () => {
    assert.equal(classifyRebote({ motivo: 'x', rebote_categoria: 'dependency_block' }).category, 'dependency_block');
    assert.equal(classifyRebote({ motivo: 'x', rebote_categoria: 'human_block' }).category, 'human_block');
});

test('no-regresión: infra_no_apk sigue clasificando infra', () => {
    const r = classifyRebote({ motivo: 'x', rebote_categoria: 'infra_no_apk' });
    assert.equal(r.category, 'infra');
    assert.equal(r.counts_against_circuit_breaker, false);
});

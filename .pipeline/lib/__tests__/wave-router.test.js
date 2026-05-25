// =============================================================================
// wave-router.test.js — Tests del routing de `/wave` y NLP "cómo va la ola" (#3262).
//
// CA-1: comando `/wave` (o intención "estado de la ola") devuelve snapshot.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-router.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const commanderDet = require('../commander-deterministic');

test('CA-1: /wave clasifica como determinístico → command=wave', () => {
    const r = commanderDet.classify('/wave');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: /wave --audio clasifica como determinístico con args="--audio"', () => {
    const r = commanderDet.classify('/wave --audio');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
    assert.equal(r.args, '--audio');
});

test('CA-1: intención "cómo va la ola" se mapea a wave', () => {
    const r = commanderDet.classify('cómo va la ola?');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: intención "cómo viene la ola" se mapea a wave', () => {
    const r = commanderDet.classify('cómo viene la ola hoy');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: intención "estado de la ola" se mapea a wave (no a snapshot)', () => {
    const r = commanderDet.classify('estado de la ola');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: "snapshot" aún se mapea a snapshot (no rompemos retrocompatibilidad)', () => {
    const r = commanderDet.classify('snapshot');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'snapshot');
});

test('validateArgs: wave sin args es válido', () => {
    const v = commanderDet.validateArgs('wave', '');
    assert.equal(v.ok, true);
});

test('validateArgs: wave --audio es válido', () => {
    const v = commanderDet.validateArgs('wave', '--audio');
    assert.equal(v.ok, true);
});

test('validateArgs: wave con flag desconocido es inválido', () => {
    const v = commanderDet.validateArgs('wave', '--video');
    assert.equal(v.ok, false);
    // #3493 — H5 expandió usage a subcomandos: `wave [status [--audio] | next | add <num> #issue | promote]`.
    // El regex anterior `/wave \[--audio\]/` correspondía a la sintaxis pre-H5 (#3262, solo snapshot).
    assert.match(v.usage, /wave \[status \[--audio\] \| next \| add/);
});

test('validateArgs: wave con args arbitrarios es inválido (defensa de injection)', () => {
    const v = commanderDet.validateArgs('wave', '`rm -rf /`');
    assert.equal(v.ok, false);
});

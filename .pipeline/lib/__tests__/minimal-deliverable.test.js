'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMinimalDeliverableMd, NOTAS_AUSENTES } = require('../minimal-deliverable');

const TS = '2026-07-07T12:00:00.000Z';

test('caso: nota vacía → incluye issue, fase, skill, resultado, marcador de notas y timestamp', () => {
    const md = buildMinimalDeliverableMd({
        issue: 4523,
        fase: 'desarrollo/dev',
        skill: 'pipeline-dev',
        resultado: 'aprobado',
        notas: '',
        timestamp: TS,
    });
    assert.match(md, /#4523/);
    assert.match(md, /desarrollo\/dev/);
    assert.match(md, /pipeline-dev/);
    assert.match(md, /aprobado/);
    assert.match(md, new RegExp(TS.replace(/[.]/g, '\\.')));
    // Marcador explícito de notas ausentes (CA-2).
    assert.match(md, /\(sin notas\)/);
    assert.strictEqual(md.includes(NOTAS_AUSENTES), true);
});

test('caso: nota sólo whitespace también cae al marcador (sin notas)', () => {
    const md = buildMinimalDeliverableMd({
        issue: 4523, resultado: 'aprobado', notas: '   \n\t  ', timestamp: TS,
    });
    assert.match(md, /\(sin notas\)/);
});

test('caso: nota trivial (<80 chars) → materializa igual con la nota embebida', () => {
    const nota = 'ok, aprobado';
    const md = buildMinimalDeliverableMd({
        issue: 4523, resultado: 'aprobado', notas: nota, timestamp: TS,
    });
    assert.match(md, /ok, aprobado/);
    // La nota trivial no debe caer al marcador de ausencia.
    assert.strictEqual(md.includes(NOTAS_AUSENTES), false);
});

test('caso: contenido no-nulo garantizado aun sin ningún parámetro (contrato writeDeliverable)', () => {
    const md = buildMinimalDeliverableMd();
    assert.strictEqual(typeof md, 'string');
    assert.ok(md.trim().length > 0, 'nunca devuelve string vacío');
    // Defaults poblados.
    assert.match(md, /desarrollo\/dev/);
    assert.match(md, /pipeline-dev/);
    assert.match(md, /\(sin notas\)/);
});

test('caso: defaults de fase/skill/resultado cuando llegan vacíos', () => {
    const md = buildMinimalDeliverableMd({ issue: 1, fase: '  ', skill: '', resultado: '  ', timestamp: TS });
    assert.match(md, /desarrollo\/dev/);
    assert.match(md, /pipeline-dev/);
    assert.match(md, /\(sin resultado\)/);
});

test('caso: fase/skill/resultado custom se respetan', () => {
    const md = buildMinimalDeliverableMd({
        issue: 99, fase: 'desarrollo/build', skill: 'backend-dev', resultado: 'rechazado',
        notas: 'algo', timestamp: TS,
    });
    assert.match(md, /desarrollo\/build/);
    assert.match(md, /backend-dev/);
    assert.match(md, /rechazado/);
});

test('caso: sin timestamp inyectado usa un ISO válido', () => {
    const md = buildMinimalDeliverableMd({ issue: 5, resultado: 'aprobado' });
    assert.match(md, /\*\*Cierre:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

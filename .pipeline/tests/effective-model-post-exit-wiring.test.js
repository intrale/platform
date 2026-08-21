'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');

test('CA-1 cablea la captura del modelo en el flujo post-exit normal', () => {
    const exitStart = source.indexOf("child.on('exit', (code) => {");
    const nextExit = source.indexOf("child.on('exit', (code) => {", exitStart + 1);
    const exitBody = source.slice(exitStart, nextExit === -1 ? source.length : nextExit);
    const watchdogStart = source.indexOf('const watchdog = setTimeout(() => {');
    const watchdogEnd = source.indexOf("child.on('exit', (code) => {", watchdogStart);
    const watchdogBody = source.slice(watchdogStart, watchdogEnd);

    assert.notEqual(exitStart, -1, 'debe existir el exit handler de agentes');
    assert.match(exitBody, /extractEffectiveModel\s*\(/);
    assert.match(exitBody, /recordEffectiveModel\s*\(/);
    assert.doesNotMatch(watchdogBody, /recordEffectiveModel\s*\(/,
        'la persistencia no puede depender de que dispare el watchdog');
});

test('session:end consume la observación declarada dentro del mismo callback post-exit', () => {
    const capture = source.indexOf('let effectiveObservation = { model: null');
    const sessionEnd = source.indexOf('trace.emitSessionEnd(traceHandle', capture);
    const callbackEnd = source.indexOf('}, 500);', capture);

    assert.ok(capture !== -1 && sessionEnd !== -1 && callbackEnd !== -1);
    assert.ok(capture < sessionEnd && sessionEnd < callbackEnd,
        'captura y session:end deben compartir el callback y el alcance léxico');
    assert.match(source.slice(sessionEnd, callbackEnd), /model_effective:\s*effectiveObservation\.model/);
    assert.match(source.slice(sessionEnd, callbackEnd), /model_effective_source:\s*effectiveObservation\.source/);
});

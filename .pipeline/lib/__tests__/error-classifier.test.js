// Tests de lib/error-classifier.js (#3941, EP5-H4)
// node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const yaml = require('js-yaml');

const { classify, TRANSIENT_CODES, CORRUPTION_NAMES } = require('../error-classifier');
const { ConfigSchemaViolation } = require('../config-schema');

test('errores de infra transitoria (ENOENT) → transient', () => {
    const e = new Error('no existe');
    e.code = 'ENOENT';
    assert.strictEqual(classify(e), 'transient');
});

test('errores de red (ETIMEDOUT/ECONNRESET/ENETUNREACH/EAI_AGAIN) → transient', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED']) {
        const e = new Error('red');
        e.code = code;
        assert.strictEqual(classify(e), 'transient', `${code} debe ser transient`);
    }
});

test('todos los TRANSIENT_CODES declarados clasifican como transient', () => {
    for (const code of TRANSIENT_CODES) {
        const e = new Error('x');
        e.code = code;
        assert.strictEqual(classify(e), 'transient', `${code}`);
    }
});

test('YAMLException (parse-error de YAML existente) → corruption', () => {
    let caught = null;
    try { yaml.load('a: b: c'); } catch (e) { caught = e; }
    assert.ok(caught, 'debe haber tirado YAMLException');
    assert.strictEqual(caught.name, 'YAMLException');
    assert.strictEqual(classify(caught), 'corruption');
});

test('ConfigSchemaViolation → corruption', () => {
    const e = new ConfigSchemaViolation('schema', []);
    assert.strictEqual(classify(e), 'corruption');
});

test('WorkFileCorruptionError (por name) → corruption', () => {
    const e = new Error('work-file corrupto');
    e.name = 'WorkFileCorruptionError';
    assert.strictEqual(classify(e), 'corruption');
});

test('todos los CORRUPTION_NAMES declarados clasifican como corruption', () => {
    for (const name of CORRUPTION_NAMES) {
        const e = new Error('x');
        e.name = name;
        assert.strictEqual(classify(e), 'corruption', name);
    }
});

test('error desconocido → unknown (fail-safe: continuar+loguear)', () => {
    assert.strictEqual(classify(new Error('vaya a saber')), 'unknown');
    const typeErr = new TypeError('algo');
    assert.strictEqual(classify(typeErr), 'unknown');
});

test('null / undefined / string suelto / número → unknown (fail-safe)', () => {
    assert.strictEqual(classify(null), 'unknown');
    assert.strictEqual(classify(undefined), 'unknown');
    assert.strictEqual(classify('ENOENT'), 'unknown'); // string suelto, no objeto
    assert.strictEqual(classify(42), 'unknown');
});

test('el código de infra transitorio tiene prioridad sobre el name', () => {
    // Un error con code transitorio NO debe terminar como corruption aunque
    // por casualidad arrastre un name conocido.
    const e = new Error('mixto');
    e.code = 'ETIMEDOUT';
    e.name = 'YAMLException';
    assert.strictEqual(classify(e), 'transient');
});

test('clasificador es puro: misma entrada, misma salida, sin mutar el error', () => {
    const e = new Error('x');
    e.code = 'ENOENT';
    const snapshot = { code: e.code, name: e.name, message: e.message };
    assert.strictEqual(classify(e), 'transient');
    assert.strictEqual(classify(e), 'transient');
    assert.deepStrictEqual({ code: e.code, name: e.name, message: e.message }, snapshot);
});

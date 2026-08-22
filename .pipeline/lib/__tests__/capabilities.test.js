// =============================================================================
// capabilities.test.js — Tests para el catálogo canónico (#3082 CA-5).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../capabilities');

test('KNOWN_CAPABILITIES contiene exactamente las capabilities canónicas del catálogo (CA-S1)', () => {
    const expected = [
        'file_read',
        'file_write_repo',
        'file_write_outside_repo',
        'bash',
        'bash_elevated',
        'network_out',
        'network_in',
        'child_spawn',
        'long_running_watcher',
        'tool_use_gated',
    ];
    for (const cap of expected) {
        assert.ok(capabilities.KNOWN_CAPABILITIES.has(cap), `Falta capability '${cap}' en el catálogo`);
    }
    assert.equal(capabilities.KNOWN_CAPABILITIES.size, expected.length, 'El catálogo tiene capabilities no esperadas');
});

test('KNOWN_CAPABILITIES es frozen — intentar agregar tira TypeError', () => {
    assert.throws(() => {
        capabilities.KNOWN_CAPABILITIES.add('arbitrary_new_cap');
    });
});

test('CAPABILITY_CATALOG es frozen', () => {
    assert.throws(() => {
        capabilities.CAPABILITY_CATALOG.fake_capability = 'foo';
    });
});

test('isKnownCapability acepta capabilities reales y rechaza desconocidas', () => {
    assert.equal(capabilities.isKnownCapability('file_read'), true);
    assert.equal(capabilities.isKnownCapability('bash'), true);
    assert.equal(capabilities.isKnownCapability('not_a_real_capability'), false);
    assert.equal(capabilities.isKnownCapability(''), false);
    assert.equal(capabilities.isKnownCapability(null), false);
    assert.equal(capabilities.isKnownCapability(undefined), false);
    assert.equal(capabilities.isKnownCapability(42), false);
});

test('describeCapability devuelve la descripción humana o null', () => {
    const desc = capabilities.describeCapability('file_read');
    assert.equal(typeof desc, 'string');
    assert.ok(desc.length > 0);
    assert.equal(capabilities.describeCapability('not_a_real_one'), null);
});

test('validateRequiredCapabilities acepta sólo capabilities conocidas (CA-9)', () => {
    const ok = capabilities.validateRequiredCapabilities(['file_read', 'bash']);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.unknown, []);

    const bad = capabilities.validateRequiredCapabilities(['file_read', 'fake_one', 'another_fake']);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.unknown.sort(), ['another_fake', 'fake_one']);
});

test('validateRequiredCapabilities rechaza inputs no-array', () => {
    const r = capabilities.validateRequiredCapabilities('not-an-array');
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
});

test('todas las capabilities del catálogo tienen descripción no-vacía', () => {
    for (const cap of capabilities.KNOWN_CAPABILITIES) {
        const desc = capabilities.describeCapability(cap);
        assert.ok(desc && desc.length > 10, `capability '${cap}' no tiene descripción adecuada`);
    }
});

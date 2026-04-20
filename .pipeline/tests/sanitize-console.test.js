// =============================================================================
// sanitize-console.test.js — Tests del patch de console.* (#2334 / CA6)
//
// Estrategia: testeamos `sanitizeArg` directamente (unitario) + un test de
// integración que spawnea un proceso hijo, `install()` acá, captura stdout
// por pipe y verifica que el secreto no llega al stream.
// =============================================================================
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const modPath = path.join(__dirname, '..', 'lib', 'sanitize-console.js');
const { __forTestsOnly__ } = require(modPath);
const { sanitizeArg } = __forTestsOnly__;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  ✓ ${t.name}`);
        } catch (e) {
            failed++;
            console.log(`  ✗ ${t.name}`);
            console.log(`     ${e && e.stack || e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) process.exit(1);
}

const FAKE_AWS_AK = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz';

// =============================================================================
// Unit: sanitizeArg
// =============================================================================

test('sanitizeArg: string con JWT → [REDACTED:JWT]', () => {
    const out = sanitizeArg(`fallo: ${FAKE_JWT}`);
    assert.ok(!out.includes(FAKE_JWT));
    assert.ok(out.includes('[REDACTED:JWT]'));
});

test('sanitizeArg: Error preserva name, redacta message + stack', () => {
    const e = new Error(`auth fail ${FAKE_AWS_AK}`);
    e.name = 'AuthError';
    const out = sanitizeArg(e);
    assert.ok(out instanceof Error);
    assert.strictEqual(out.name, 'AuthError');
    assert.ok(!out.message.includes(FAKE_AWS_AK));
    assert.ok(out.message.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

test('sanitizeArg: objeto con secreto → objeto con placeholder', () => {
    const out = sanitizeArg({ token: FAKE_JWT, ok: true, issue: 123 });
    const asText = JSON.stringify(out);
    assert.ok(!asText.includes(FAKE_JWT), `leak: ${asText}`);
});

test('sanitizeArg: primitivos no-string pass-through', () => {
    assert.strictEqual(sanitizeArg(42), 42);
    assert.strictEqual(sanitizeArg(true), true);
    assert.strictEqual(sanitizeArg(null), null);
    assert.strictEqual(sanitizeArg(undefined), undefined);
});

// =============================================================================
// Integration: spawn sub-process that installs() + console.log → verify pipe
// =============================================================================

test('install: sub-proceso con console.log no escribe JWT a stdout', () => {
    // Sub-proceso que hace: install() + console.log de secreto. Capturamos
    // stdout como string.
    const script = `
        require(${JSON.stringify(modPath)}).install();
        console.log('fallo:', ${JSON.stringify(FAKE_JWT)});
        console.error('err:', ${JSON.stringify('key=' + FAKE_AWS_AK)});
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(!res.stdout.includes(FAKE_JWT), `stdout leak: ${res.stdout}`);
    assert.ok(!res.stderr.includes(FAKE_AWS_AK), `stderr leak: ${res.stderr}`);
    assert.ok(res.stdout.includes('[REDACTED:JWT]'), res.stdout);
    assert.ok(res.stderr.includes('[REDACTED:AWS_ACCESS_KEY]'), res.stderr);
});

runAll();

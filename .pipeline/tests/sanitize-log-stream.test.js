// =============================================================================
// sanitize-log-stream.test.js — Tests del writer de logs sanitizado (#2334)
// =============================================================================
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogFileWriter } = require(path.join(__dirname, '..', 'lib', 'sanitize-log-stream.js'));

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

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanlog-'));
    return { dir, file: path.join(dir, 'agent.log') };
}

const FAKE_AWS_AK = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =============================================================================
// Casos
// =============================================================================

test('writer: sanitiza un AKIA line-buffered', async () => {
    const { file } = tmpFile();
    const { writable, close } = createLogFileWriter(file);
    writable.write(`línea 1 con key=${FAKE_AWS_AK}\n`);
    writable.write('línea 2 sin secreto\n');
    await close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes(FAKE_AWS_AK), `leak en disco: ${content}`);
    assert.ok(content.includes('[REDACTED:AWS_ACCESS_KEY]'), content);
    assert.ok(content.includes('línea 2 sin secreto'));
});

test('writer: maneja JWT que cae en el corte de un chunk', async () => {
    const { file } = tmpFile();
    const { writable, close } = createLogFileWriter(file);
    // Escribimos el JWT partido en 2 chunks para forzar que caiga en el corte.
    const half = Math.floor(FAKE_JWT.length / 2);
    writable.write(`prefijo: ${FAKE_JWT.slice(0, half)}`);
    writable.write(`${FAKE_JWT.slice(half)} sufijo\n`);
    await close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes(FAKE_JWT), `JWT leak: ${content}`);
    assert.ok(content.includes('[REDACTED:JWT]'));
});

test('writer: múltiples fuentes (stdout + stderr) compartiendo writer', async () => {
    const { file } = tmpFile();
    const { writable, close } = createLogFileWriter(file);
    // Simulamos dos streams escribiendo concurrentemente al mismo writable.
    writable.write(`stdout: secret=${FAKE_AWS_AK}\n`);
    writable.write(`stderr: error sin secreto\n`);
    await close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes(FAKE_AWS_AK));
    assert.ok(content.includes('[REDACTED:AWS_ACCESS_KEY]'));
    assert.ok(content.includes('stderr:'));
});

test('writer: crea el directorio si no existe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanlog-nested-'));
    const file = path.join(dir, 'subdir', 'nested', 'agent.log');
    const { writable, close } = createLogFileWriter(file);
    writable.write(`línea ok\n`);
    await close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('línea ok'));
});

test('writer: append preserva contenido previo', async () => {
    const { file } = tmpFile();
    fs.writeFileSync(file, '--- preámbulo controlado ---\n');
    const { writable, close } = createLogFileWriter(file);
    writable.write(`nuevo secreto ${FAKE_AWS_AK}\n`);
    await close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('--- preámbulo controlado ---'));
    assert.ok(!content.includes(FAKE_AWS_AK));
    assert.ok(content.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

// ─── Run ────────────────────────────────────────────────────────────────────
runAll();

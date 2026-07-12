// Tests del escáner de secretos fail-closed del commit 1 del repo del kernel
// (issue #4662 · Ola 9.1). Cubre CA-2: verde sin secretos, bloqueo ante token
// inyectado (red fail-closed) y bloqueo ante archivo ilegible ("no pudo correr" ≠ verde).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanStaging, assertClean } = require('../kernel-bootstrap/scan-staging');
const { scaffold } = require('../kernel-bootstrap/bootstrap-kernel');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-scan-'));
}

test('staging limpio del kernel sale VERDE (cero hallazgos)', () => {
    const dir = tmpDir();
    const staged = scaffold(path.join(dir, 'kernel'));
    const report = scanStaging(staged);
    assert.equal(report.clean, true, 'un staging sin secretos debe salir verde');
    assert.equal(report.hits.length, 0);
    assert.equal(report.scanned.length, staged.length);
});

test('README con acentos en español (NFC) no genera falso positivo', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'README.md');
    fs.writeFileSync(f, '# Migración del núcleo\nEstá vacío por diseño, sin lógica todavía.\n', 'utf8');
    const report = scanStaging([f]);
    assert.equal(report.clean, true, 'texto acentuado sin secretos no debe bloquear');
});

test('token inyectado en un archivo staged BLOQUEA (red fail-closed)', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'leak.txt');
    // Token de prueba con forma de AWS Access Key — NO es un secreto real.
    fs.writeFileSync(f, 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n', 'utf8');
    const report = scanStaging([f]);
    assert.equal(report.clean, false, 'un token con patrón conocido debe bloquear');
    assert.equal(report.hits.length, 1);
    assert.match(report.hits[0].reason, /patrón de secreto/);
});

test('JWT inyectado BLOQUEA', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'jwt.txt');
    const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' +
        'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    fs.writeFileSync(f, `authorization: Bearer ${jwt}\n`, 'utf8');
    const report = scanStaging([f]);
    assert.equal(report.clean, false, 'un JWT debe bloquear');
});

test('assertClean TIRA cuando hay hallazgos (precondición del commit 1)', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'leak.txt');
    fs.writeFileSync(f, 'AKIAIOSFODNN7EXAMPLE\n', 'utf8');
    assert.throws(() => assertClean([f]), /BLOQUEADO/);
});

test('archivo ilegible BLOQUEA — "no pudo correr" no equivale a verde', () => {
    const dir = tmpDir();
    const inexistente = path.join(dir, 'no-existe.txt');
    const report = scanStaging([inexistente]);
    assert.equal(report.clean, false, 'un archivo que el escáner no puede leer debe bloquear');
    assert.match(report.hits[0].reason, /no legible/);
});

test('scaffold rechaza destino no vacío (kernel nace sin historia heredada)', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'kernel');
    scaffold(dest);
    assert.throws(() => scaffold(dest), /no está vacío/);
});

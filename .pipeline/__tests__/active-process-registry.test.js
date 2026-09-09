// Tests del registro de corridas en vuelo (incidente 2026-09-08).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ActiveProcessRegistry } = require('../lib/active-process-registry');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-'));
    return path.join(dir, 'state', 'active-processes.json');
}

test('se comporta como un Map para los call-sites existentes', () => {
    const reg = new ActiveProcessRegistry({ file: tmpFile() });
    reg.set('ux:5801', { pid: 111, startTime: 1 });
    assert.equal(reg.has('ux:5801'), true);
    assert.equal(reg.get('ux:5801').pid, 111);
    assert.equal([...reg.values()].length, 1);
    for (const [key, info] of reg) {
        assert.equal(key, 'ux:5801');
        assert.equal(info.pid, 111);
    }
    assert.equal(reg.delete('ux:5801'), true);
    assert.equal(reg.size, 0);
});

test('persiste en disco y rehidrata las corridas cuyo PID sigue vivo', () => {
    const file = tmpFile();
    const vivos = new Set([111]);

    const primero = new ActiveProcessRegistry({ file, isProcessAlive: (pid) => vivos.has(pid) });
    primero.set('ux:5801', { pid: 111, startTime: 1, trabajandoPath: '/x/5801.ux', pipeline: 'desarrollo', fase: 'validacion' });
    primero.set('po:6239', { pid: 222, startTime: 2 });

    // Simula el reinicio del Pulpo: proceso nuevo, memoria vacía, mismo disco.
    const segundo = new ActiveProcessRegistry({ file, isProcessAlive: (pid) => vivos.has(pid) });
    assert.equal(segundo.size, 0, 'antes de rehidratar arranca vacío');

    const r = segundo.rehidratar();
    assert.equal(r.rehidratadas, 1);
    assert.equal(r.descartadas, 1, 'el PID 222 ya no vive: no vuelve');
    assert.equal(segundo.has('ux:5801'), true);
    assert.equal(segundo.get('ux:5801').fase, 'validacion');
    assert.equal(segundo.has('po:6239'), false);
});

test('no persiste el handle del watchdog', () => {
    const file = tmpFile();
    const reg = new ActiveProcessRegistry({ file });
    const watchdog = setTimeout(() => {}, 100000);
    watchdog.unref();
    reg.set('ux:1', { pid: 5, startTime: 1, watchdog });

    const enDisco = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal('watchdog' in enDisco.corridas['ux:1'], false);
    assert.equal(enDisco.corridas['ux:1'].pid, 5);
    clearTimeout(watchdog);
});

test('un archivo corrupto degrada a registro vacío, no tumba el arranque', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ esto no es json', 'utf8');

    const reg = new ActiveProcessRegistry({ file, isProcessAlive: () => true });
    const r = reg.rehidratar();
    assert.equal(r.rehidratadas, 0);
    assert.ok(r.error, 'reporta el error para que quede en el log');
    assert.equal(reg.size, 0);
});

test('sin archivo previo la rehidratación es un no-op silencioso', () => {
    const reg = new ActiveProcessRegistry({ file: tmpFile(), isProcessAlive: () => true });
    const r = reg.rehidratar();
    assert.deepEqual(r, { rehidratadas: 0, descartadas: 0, error: null });
});

test('descarta entradas sin pid utilizable', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        version: 1,
        corridas: { 'ux:9': { startTime: 1 }, 'po:8': { pid: 'no-numero' } },
    }), 'utf8');

    const reg = new ActiveProcessRegistry({ file, isProcessAlive: () => true });
    const r = reg.rehidratar();
    assert.equal(r.rehidratadas, 0);
    assert.equal(r.descartadas, 2);
});

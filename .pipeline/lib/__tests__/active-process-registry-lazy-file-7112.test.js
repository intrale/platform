// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// #7112 rebote rev-3 (leve, SEC-13) — `ActiveProcessRegistry` acepta `file`
// como FUNCIÓN resuelta por llamada.
//
// Defecto que cubre: `pulpo.js` construía el registro al `require` con
// `file: path.join(PIPELINE(), 'state', 'active-processes.json')`, así que
// `PIPELINE()` se evaluaba UNA vez y el path quedaba capturado toda la vida del
// proceso (en tests, apuntaba al dir del runner aunque el test seteara el
// override después). Peor: si en ese instante el dir de escritura estaba
// bloqueado, el `require` de pulpo.js moría y el archivo de test entero pasaba
// como un único test verde sin ejecutar ninguno (falso verde observado en
// `merge-race-precondicion-e2e-6432.test.js`).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ActiveProcessRegistry } = require('../active-process-registry');

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'apr-lazy-7112-'));
}

test('file como función: se resuelve en cada persistencia, no al construir', () => {
    const dirA = tmp();
    const dirB = tmp();
    let actual = dirA;
    const reg = new ActiveProcessRegistry({
        file: () => path.join(actual, 'state', 'active-processes.json'),
        isProcessAlive: () => true,
    });
    reg.set('build:1', { pid: process.pid, startTime: 1 });
    assert.ok(fs.existsSync(path.join(dirA, 'state', 'active-processes.json')), 'persistió en el dir vigente al set');
    assert.ok(!fs.existsSync(path.join(dirB, 'state', 'active-processes.json')));

    // Cambia el destino DESPUÉS de construir: la siguiente mutación va al nuevo.
    actual = dirB;
    reg.set('tester:2', { pid: process.pid, startTime: 2 });
    assert.ok(fs.existsSync(path.join(dirB, 'state', 'active-processes.json')), 'la resolución es por llamada');
    const enB = JSON.parse(fs.readFileSync(path.join(dirB, 'state', 'active-processes.json'), 'utf8'));
    assert.deepEqual(Object.keys(enB.corridas).sort(), ['build:1', 'tester:2']);
});

test('file como función que LANZA (dir bloqueado): el registro no persiste, no rompe y rehidrata confiable:false', () => {
    const logs = [];
    const reg = new ActiveProcessRegistry({
        file: () => { throw new Error('PIPELINE_ESCRITURA_BLOQUEADA simulado'); },
        isProcessAlive: () => true,
        onLog: (m) => logs.push(m),
    });
    assert.doesNotThrow(() => reg.set('build:1', { pid: process.pid, startTime: 1 }));
    assert.equal(reg.get('build:1').pid, process.pid, 'el Map en memoria sigue funcionando');
    const r = reg.rehidratar();
    assert.deepEqual(r, { rehidratadas: 0, descartadas: 0, error: null, confiable: false });
    assert.ok(logs.some((m) => /sin archivo resoluble/.test(m)), 'avisa por el log del Pulpo');
});

test('file como string (contrato previo) sigue funcionando igual', () => {
    const dir = tmp();
    const file = path.join(dir, 'active-processes.json');
    const reg = new ActiveProcessRegistry({ file, isProcessAlive: () => true });
    reg.set('build:1', { pid: process.pid, startTime: 1 });
    assert.ok(fs.existsSync(file));
    const otro = new ActiveProcessRegistry({ file, isProcessAlive: () => true });
    assert.equal(otro.rehidratar().rehidratadas, 1);
    assert.equal(otro.get('build:1').pid, process.pid);
});

test('canario SEC-13: pulpo.js construye el registro con `file` como función sobre PIPELINE()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const i = src.indexOf('new ActiveProcessRegistry({');
    assert.ok(i > 0, 'pulpo.js construye ActiveProcessRegistry');
    const bloque = src.slice(i, i + 400);
    assert.match(bloque, /file:\s*\(\)\s*=>\s*path\.join\(PIPELINE\(\),\s*'state',\s*'active-processes\.json'\)/);
    assert.doesNotMatch(bloque, /file:\s*path\.join\(PIPELINE\(\)/, 'PIPELINE() no se evalúa al require');
});

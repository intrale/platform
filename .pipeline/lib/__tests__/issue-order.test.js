// Tests para .pipeline/lib/issue-order.js — orden manual del Issue Tracker
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../issue-order');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-order-'));
    return path.join(dir, 'order.json');
}

test('load sin archivo devuelve estado vacío', () => {
    const f = tmpFile();
    const s = lib.load(f);
    assert.equal(s.version, lib.CURRENT_VERSION);
    assert.deepEqual(s.order, []);
});

test('save y load son round-trip', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['1952', '2510', '2521'] };
    lib.save(s, f);
    const loaded = lib.load(f);
    assert.deepEqual(loaded.order, ['1952', '2510', '2521']);
});

test('load coerce a strings cuando el JSON guardó números', () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ version: 1, order: [1952, 2510] }));
    const s = lib.load(f);
    assert.deepEqual(s.order, ['1952', '2510']);
});

test('load tolera JSON inválido y devuelve vacío', () => {
    const f = tmpFile();
    fs.writeFileSync(f, '{invalid json');
    const s = lib.load(f);
    assert.deepEqual(s.order, []);
});

test('orderOf devuelve el index o null', () => {
    const s = { version: 1, order: ['1', '2', '3'] };
    assert.equal(lib.orderOf(s, '1'), 0);
    assert.equal(lib.orderOf(s, '3'), 2);
    assert.equal(lib.orderOf(s, 1), 0); // coerce
    assert.equal(lib.orderOf(s, '99'), null);
});

test('moveUp swap con el de arriba y persiste', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd'] };
    const r = lib.moveUp(s, 'c', f);
    assert.equal(r.ok, true);
    assert.equal(r.from, 2);
    assert.equal(r.to, 1);
    assert.deepEqual(s.order, ['a', 'c', 'b', 'd']);
    assert.deepEqual(lib.load(f).order, ['a', 'c', 'b', 'd']);
});

test('moveUp en el tope no hace nada', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    const r = lib.moveUp(s, 'a', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already-top');
    assert.deepEqual(s.order, ['a', 'b', 'c']);
});

test('moveUp de issue inexistente devuelve not-found', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.moveUp(s, 'zzz', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
});

test('moveDown swap con el de abajo y persiste', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd'] };
    const r = lib.moveDown(s, 'b', f);
    assert.equal(r.ok, true);
    assert.equal(r.from, 1);
    assert.equal(r.to, 2);
    assert.deepEqual(s.order, ['a', 'c', 'b', 'd']);
    assert.deepEqual(lib.load(f).order, ['a', 'c', 'b', 'd']);
});

test('moveDown en el fondo no hace nada', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    const r = lib.moveDown(s, 'c', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already-bottom');
});

test('setOrder reemplaza la lista respetando el orden recibido', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd'] };
    lib.setOrder(s, ['c', 'a', 'b', 'd'], f);
    assert.deepEqual(s.order, ['c', 'a', 'b', 'd']);
    assert.deepEqual(lib.load(f).order, ['c', 'a', 'b', 'd']);
});

test('setOrder preserva al final issues no incluidos en newOrder', () => {
    const s = { version: 1, order: ['a', 'b', 'c', 'd'] };
    lib.setOrder(s, ['c', 'a'], tmpFile());
    // c y a primero, luego b y d en orden original
    assert.deepEqual(s.order, ['c', 'a', 'b', 'd']);
});

test('insertNew agrega al tope (position 0)', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b'] };
    lib.insertNew(s, 'c', f);
    assert.deepEqual(s.order, ['c', 'a', 'b']);
    assert.equal(lib.orderOf(s, 'c'), 0);
});

test('insertNew de issue ya existente no duplica', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.insertNew(s, 'a', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already-exists');
    assert.deepEqual(s.order, ['a', 'b']);
});

test('removeIssue saca el issue y compacta', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c'] };
    lib.removeIssue(s, 'b', f);
    assert.deepEqual(s.order, ['a', 'c']);
    assert.deepEqual(lib.load(f).order, ['a', 'c']);
});

test('removeIssue idempotente: issue inexistente devuelve not-found sin romper', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.removeIssue(s, 'zzz', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
    assert.deepEqual(s.order, ['a', 'b']);
});

test('syncWith inserta issues nuevos al tope (en orden de aparición)', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['x', 'y'] };
    const r = lib.syncWith(s, ['x', 'y', 'a', 'b'], f);
    assert.equal(r.ok, true);
    assert.deepEqual(r.added, ['a', 'b']);
    // Los nuevos al tope, en el orden recibido
    assert.deepEqual(s.order, ['a', 'b', 'x', 'y']);
});

test('syncWith no duplica issues que ya existen', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    const r = lib.syncWith(s, ['a', 'b', 'c'], tmpFile());
    assert.deepEqual(r.added, []);
    assert.deepEqual(s.order, ['a', 'b', 'c']);
});

test('syncWith preserva issues huérfanos (en state pero no en current)', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    lib.syncWith(s, ['a'], tmpFile());
    // c y b no están en current pero NO se borran (podrían reabrirse)
    assert.deepEqual(s.order, ['a', 'b', 'c']);
});

test('syncWith mezcla nuevos al tope y huérfanos preservados al final', () => {
    const s = { version: 1, order: ['x', 'y'] };
    lib.syncWith(s, ['z', 'x'], tmpFile());
    // z es nuevo (al tope), x preserva su posición, y queda al final
    assert.deepEqual(s.order, ['z', 'x', 'y']);
});

test('flujo completo: insert nuevo → moveDown → setOrder via drag', () => {
    const f = tmpFile();
    const s = lib.load(f);
    lib.insertNew(s, '100', f);
    lib.insertNew(s, '101', f);
    lib.insertNew(s, '102', f);
    // tope: 102, 101, 100
    assert.deepEqual(s.order, ['102', '101', '100']);
    lib.moveDown(s, '102', f);
    assert.deepEqual(s.order, ['101', '102', '100']);
    // Drag: usuario arrastra 100 al tope
    lib.setOrder(s, ['100', '101', '102'], f);
    assert.deepEqual(s.order, ['100', '101', '102']);
    // Persistido
    assert.deepEqual(lib.load(f).order, ['100', '101', '102']);
});

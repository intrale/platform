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

test('swap intercambia posiciones de dos issues no adyacentes', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd', 'e'] };
    const r = lib.swap(s, 'a', 'd', f);
    assert.equal(r.ok, true);
    assert.equal(r.from, 0);
    assert.equal(r.to, 3);
    assert.deepEqual(s.order, ['d', 'b', 'c', 'a', 'e']);
    assert.deepEqual(lib.load(f).order, ['d', 'b', 'c', 'a', 'e']);
});

test('swap funciona con issues adyacentes (equiv a moveUp/moveDown)', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    lib.swap(s, 'a', 'b', tmpFile());
    assert.deepEqual(s.order, ['b', 'a', 'c']);
});

test('swap retorna error si alguno de los issues no existe', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.swap(s, 'a', 'zzz', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
    assert.deepEqual(s.order, ['a', 'b']);
});

test('swap con el mismo issue retorna error same-issue', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.swap(s, 'a', 'a', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'same-issue');
});

test('moveBefore inserta el issue justo antes del anchor sin swappear', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd', 'e'] };
    // Mover 'd' antes de 'b'
    const r = lib.moveBefore(s, 'd', 'b', f);
    assert.equal(r.ok, true);
    // Resultado esperado: a, d, b, c, e (b/c mantuvieron orden relativo)
    assert.deepEqual(s.order, ['a', 'd', 'b', 'c', 'e']);
});

test('moveBefore funciona para llevar al tope de un bloque (anchor=primero)', () => {
    const s = { version: 1, order: ['a', 'b', 'c', 'd', 'e'] };
    // Tope: mover 'd' antes de 'a'
    lib.moveBefore(s, 'd', 'a', tmpFile());
    assert.deepEqual(s.order, ['d', 'a', 'b', 'c', 'e']);
});

test('moveBefore con anchor inexistente restaura el array original', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    const r = lib.moveBefore(s, 'a', 'zzz', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'anchor-not-found');
    assert.deepEqual(s.order, ['a', 'b', 'c']);
});

test('moveBefore con issue inexistente devuelve not-found', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.moveBefore(s, 'zzz', 'a', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
});

test('moveBefore con mismo issue y anchor devuelve same-issue', () => {
    const s = { version: 1, order: ['a', 'b'] };
    const r = lib.moveBefore(s, 'a', 'a', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'same-issue');
});

test('moveAfter inserta el issue justo después del anchor sin swappear', () => {
    const f = tmpFile();
    const s = { version: 1, order: ['a', 'b', 'c', 'd', 'e'] };
    // Mover 'b' después de 'd'
    const r = lib.moveAfter(s, 'b', 'd', f);
    assert.equal(r.ok, true);
    // Resultado: a, c, d, b, e (c mantuvo posición relativa, b al fondo del bloque)
    assert.deepEqual(s.order, ['a', 'c', 'd', 'b', 'e']);
});

test('moveAfter funciona para llevar al fondo de un bloque (anchor=último)', () => {
    const s = { version: 1, order: ['a', 'b', 'c', 'd', 'e'] };
    // Fondo: mover 'b' después de 'e'
    lib.moveAfter(s, 'b', 'e', tmpFile());
    assert.deepEqual(s.order, ['a', 'c', 'd', 'e', 'b']);
});

test('moveAfter con anchor inexistente restaura el array original', () => {
    const s = { version: 1, order: ['a', 'b', 'c'] };
    const r = lib.moveAfter(s, 'a', 'zzz', tmpFile());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'anchor-not-found');
    assert.deepEqual(s.order, ['a', 'b', 'c']);
});

test('moveBefore preserva orden relativo del resto del array', () => {
    const s = { version: 1, order: ['x', 'a', 'y', 'b', 'z', 'c'] };
    // Mover 'c' antes de 'a' — el orden relativo entre x, y, b, z se preserva
    lib.moveBefore(s, 'c', 'a', tmpFile());
    assert.deepEqual(s.order, ['x', 'c', 'a', 'y', 'b', 'z']);
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

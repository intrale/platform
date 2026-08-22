'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeCell, toCsv } = require('../issue-csv');

test('SEC-3: celda que empieza con = se prefija con comilla simple', () => {
    assert.strictEqual(sanitizeCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
});

test('SEC-3: celdas que empiezan con + - @ tab CR se neutralizan', () => {
    assert.strictEqual(sanitizeCell('+1'), "'+1");
    assert.strictEqual(sanitizeCell('-1'), "'-1");
    assert.strictEqual(sanitizeCell('@cmd'), "'@cmd");
    assert.strictEqual(sanitizeCell('\tfoo'), "'\tfoo");
    // \r dispara TAMBIÉN el quoting RFC 4180 (es char de control de fin de línea),
    // por eso queda neutralizado Y envuelto en comillas.
    assert.strictEqual(sanitizeCell('\rfoo'), '"\'\rfoo"');
});

test('RFC 4180: comillas dobles se escapan duplicándolas y se envuelve', () => {
    assert.strictEqual(sanitizeCell('di "hola"'), '"di ""hola"""');
});

test('RFC 4180: campos con coma / newline se envuelven en comillas', () => {
    assert.strictEqual(sanitizeCell('a,b'), '"a,b"');
    assert.strictEqual(sanitizeCell('linea1\nlinea2'), '"linea1\nlinea2"');
});

test('celda simple no se altera', () => {
    assert.strictEqual(sanitizeCell('hola mundo'), 'hola mundo');
    assert.strictEqual(sanitizeCell(123), '123');
    assert.strictEqual(sanitizeCell(null), '');
    assert.strictEqual(sanitizeCell(undefined), '');
});

test('combinación formula + coma: neutraliza Y envuelve', () => {
    // empieza con '=' (neutralizar) y además tiene coma (quotear)
    assert.strictEqual(sanitizeCell('=A1,B1'), '"\'=A1,B1"');
});

test('toCsv emite header + filas con CRLF y respeta orden de columnas', () => {
    const rows = [
        { id: 1, title: 'uno', risk: 'bajo' },
        { id: 2, title: 'dos, con coma', risk: 'alto' },
    ];
    const cols = [
        { key: 'id', label: '#' },
        { key: 'title', label: 'Título' },
        { key: 'risk', label: 'Riesgo' },
    ];
    const csv = toCsv(rows, cols);
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[0], '#,Título,Riesgo');
    assert.strictEqual(lines[1], '1,uno,bajo');
    assert.strictEqual(lines[2], '2,"dos, con coma",alto');
});

test('toCsv acepta columnas como array de strings', () => {
    const csv = toCsv([{ a: '1', b: '2' }], ['a', 'b']);
    assert.strictEqual(csv, 'a,b\r\n1,2');
});

test('toCsv: celda faltante → vacía', () => {
    const csv = toCsv([{ a: '1' }], ['a', 'b']);
    assert.strictEqual(csv, 'a,b\r\n1,');
});

test('toCsv: título malicioso con fórmula queda neutralizado en el output', () => {
    const csv = toCsv([{ title: '=cmd|calc' }], [{ key: 'title', label: 'Título' }]);
    assert.ok(csv.includes("'=cmd|calc"), 'el output debe contener la celda neutralizada');
});

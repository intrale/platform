// Tests de .pipeline/lib/wizards/allowlist/preview-diff.js (#3742).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const previewDiff = require('../preview-diff');

test('previewDiff calcula added y removed ordenados', () => {
    const d = previewDiff([1, 2, 3], [2, 3, 4, 5]);
    assert.deepEqual(d.added, [4, 5]);
    assert.deepEqual(d.removed, [1]);
});

test('previewDiff sin cambios devuelve listas vacías', () => {
    const d = previewDiff([10, 20], [20, 10]);
    assert.deepEqual(d, { added: [], removed: [] });
});

test('normalizeList dedup, ordena y descarta no-enteros-positivos', () => {
    assert.deepEqual(previewDiff.normalizeList([3, '1', 1, -2, 0, 'x', 2.5, 5]), [1, 3, 5]);
    assert.deepEqual(previewDiff.normalizeList(null), []);
});

test('equals compara diffs por valor (orden-independiente)', () => {
    assert.equal(previewDiff.equals({ added: [2, 1], removed: [] }, { added: [1, 2], removed: [] }), true);
    assert.equal(previewDiff.equals({ added: [1], removed: [] }, { added: [1, 2], removed: [] }), false);
    assert.equal(previewDiff.equals(null, { added: [], removed: [] }), false);
});

test('equalsList compara snapshots de allowlist por valor', () => {
    assert.equal(previewDiff.equalsList([1, 2, 3], [3, 2, 1]), true);
    assert.equal(previewDiff.equalsList([1, 2], [1, 2, 3]), false);
    assert.equal(previewDiff.equalsList([], undefined), true);
});

test('renderPreviewHtml escapa payload XSS en el motivo (CA-10)', () => {
    const html = previewDiff.renderPreviewHtml(
        { added: [200], removed: [] },
        { motivo: '<img src=x onerror=alert(1)>' },
    );
    assert.ok(!html.includes('<img src=x'), 'el <img> crudo NO debe aparecer');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'el motivo debe aparecer escapado');
    assert.ok(html.includes('+ #200'), 'el diff added debe renderizarse');
});

test('renderPreviewHtml escapa también los issue_id (defensa en profundidad)', () => {
    const html = previewDiff.renderPreviewHtml({ added: [1], removed: [2] });
    assert.ok(html.includes('+ #1'));
    assert.ok(html.includes('- #2'));
});

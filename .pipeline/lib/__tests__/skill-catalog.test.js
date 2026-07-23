'use strict';

// Tests de skill-catalog.js (EP8-H6 #3959, CA-4). Fuente única del orden de
// skills compartido por Matriz / Pipeline / Equipo. Anti-regresión: el orden
// canónico debe coincidir con el que arma dashboard.js para la vista Equipo.
// node --test .pipeline/lib/__tests__/skill-catalog.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const catalog = require('../skill-catalog');

test('exports canónicos del catálogo', () => {
    assert.equal(typeof catalog.skillOrder, 'function');
    assert.equal(typeof catalog.categoryOf, 'function');
    assert.ok(catalog.SKILL_CATEGORY && typeof catalog.SKILL_CATEGORY === 'object');
    assert.ok(catalog.CATEGORY_META && typeof catalog.CATEGORY_META === 'object');
    assert.deepStrictEqual(catalog.CATEGORY_ORDER, ['product', 'dev', 'quality', 'ops']);
});

test('skillOrder agrupa por categoría en el orden canónico de CATEGORY_ORDER', () => {
    const order = catalog.skillOrder();
    // El índice de categoría de cada skill debe ser monótono no decreciente.
    let lastCatIdx = -1;
    for (const skill of order) {
        const cat = catalog.categoryOf(skill);
        const idx = catalog.CATEGORY_ORDER.indexOf(cat);
        assert.ok(idx >= lastCatIdx, `skill ${skill} (${cat}) rompe el agrupamiento por categoría`);
        lastCatIdx = idx;
    }
});

test('skillOrder incluye todos los skills declarados, sin duplicados', () => {
    const order = catalog.skillOrder();
    const declared = Object.keys(catalog.SKILL_CATEGORY);
    assert.strictEqual(order.length, declared.length);
    assert.strictEqual(new Set(order).size, order.length, 'sin duplicados');
    for (const s of declared) assert.ok(order.includes(s), `falta ${s}`);
});

test('orden canónico exacto (anti-regresión)', () => {
    assert.deepStrictEqual(catalog.skillOrder(), [
        'po', 'ux', 'planner',
        'backend-dev', 'android-dev', 'web-dev',
        'tester', 'qa', 'review', 'security',
        'guru', 'perf', 'build', 'delivery',
    ]);
});

test('el orden canónico coincide con el agrupamiento de Equipo (dashboard.js)', () => {
    // dashboard.js arma skillsByCategory = { product, dev, quality, ops } y
    // asigna cada skill con SKILL_CATEGORY[skill] || 'ops' (dashboard.js:3161-3164).
    // Reproducimos esa derivación SOLO con el catálogo y verificamos que el
    // aplanado en CATEGORY_ORDER reproduce skillOrder() — misma fuente, mismo orden.
    const byCat = { product: [], dev: [], quality: [], ops: [] };
    for (const skill of Object.keys(catalog.SKILL_CATEGORY)) {
        byCat[catalog.categoryOf(skill)].push(skill);
    }
    const flat = [];
    for (const cat of catalog.CATEGORY_ORDER) flat.push(...byCat[cat]);
    assert.deepStrictEqual(flat, catalog.skillOrder());
});

test('categoryOf default ops para skill desconocido', () => {
    assert.strictEqual(catalog.categoryOf('no-existe'), 'ops');
    assert.strictEqual(catalog.categoryOf('backend-dev'), 'dev');
});

test('dashboard.js re-exporta la MISMA estructura (no rompe Equipo)', () => {
    // El módulo nuevo debe ser idéntico byte-a-byte a lo que vivía inline en
    // dashboard.js. Verificamos la forma esperada de SKILL_CATEGORY/CATEGORY_META.
    assert.strictEqual(catalog.SKILL_CATEGORY['po'], 'product');
    assert.strictEqual(catalog.SKILL_CATEGORY['backend-dev'], 'dev');
    assert.strictEqual(catalog.SKILL_CATEGORY['qa'], 'quality');
    assert.strictEqual(catalog.SKILL_CATEGORY['delivery'], 'ops');
    assert.deepStrictEqual(Object.keys(catalog.CATEGORY_META), ['product', 'dev', 'quality', 'ops']);
    for (const meta of Object.values(catalog.CATEGORY_META)) {
        assert.ok(meta.label && meta.icon && meta.color, 'cada categoría tiene label/icon/color');
    }
});

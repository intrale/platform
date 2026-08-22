// =============================================================================
// budget-config.test.js — #3962 EP8-H9 CA-4.
//
// Persistencia del presupuesto mensual: read/write atómico, tolerancia a
// ENOENT/corrupción, actor fijo server-side, rechazo de valores inválidos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const budgetConfig = require('../budget-config');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-cfg-'));
    return path.join(dir, 'budget-config.json');
}

test('readBudget devuelve default ante ENOENT', () => {
    const file = tmpFile();
    const b = budgetConfig.readBudget({ path: file });
    assert.equal(b.source, 'default');
    assert.equal(b.monthly_usd, budgetConfig.DEFAULT_MONTHLY_USD);
});

test('writeBudget persiste y readBudget lo lee de vuelta (round-trip)', () => {
    const file = tmpFile();
    budgetConfig.writeBudget(321, { path: file });
    const b = budgetConfig.readBudget({ path: file });
    assert.equal(b.monthly_usd, 321);
    assert.equal(b.source, 'persisted');
    assert.equal(b.actor, 'operador-local');
});

test('writeBudget usa actor fijo aunque se intente overridear sin opts', () => {
    const file = tmpFile();
    budgetConfig.writeBudget(150, { path: file });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.actor, 'operador-local');
    assert.ok(raw.updated_at, 'graba updated_at');
});

test('writeBudget escribe atómicamente (no deja .tmp)', () => {
    const file = tmpFile();
    budgetConfig.writeBudget(100, { path: file });
    assert.ok(!fs.existsSync(file + '.tmp'), 'no debe quedar archivo .tmp');
});

test('writeBudget rechaza valores inválidos', () => {
    const file = tmpFile();
    for (const bad of [0, -1, NaN, Infinity, budgetConfig.BUDGET_MAX + 1]) {
        assert.throws(() => budgetConfig.writeBudget(bad, { path: file }), /invalid_budget_value/);
    }
});

test('readBudget cae a default ante JSON corrupto', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ corrupt', 'utf8');
    const b = budgetConfig.readBudget({ path: file });
    assert.equal(b.source, 'default');
});

test('readBudget cae a default si el valor persistido está fuera de rango', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ monthly_usd: -99 }), 'utf8');
    const b = budgetConfig.readBudget({ path: file });
    assert.equal(b.source, 'default');
});
